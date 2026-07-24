import * as THREE from 'three'
import { Sky } from './Sky'
import { U } from './Uniforms'
import { clamp, lerp, smoothstep } from '../util/math'

export interface WeatherOut {
  cloudCover: number
  cloudDark: number
  lightMul: number
  fogMul: number
  rain: number
  snow: number
  wind: number
  wetness: number
}

const C = {
  dayZenith: new THREE.Color(0x2a63c8),
  dayHorizon: new THREE.Color(0xaccbe8),
  duskZenith: new THREE.Color(0x33406e),
  duskHorizon: new THREE.Color(0xff8b47),
  nightZenith: new THREE.Color(0x0c1c38),
  nightHorizon: new THREE.Color(0x243b5c),
  sunWarm: new THREE.Color(0xff7b2d),
  sunNoon: new THREE.Color(0xfff3e0),
  moon: new THREE.Color(0xaab9df),
  hemiSkyDay: new THREE.Color(0xbcd8ff),
  hemiSkyNight: new THREE.Color(0x385276),
  hemiGround: new THREE.Color(0x54483a),
  overcast: new THREE.Color(0x9aa4ad),
  underwater: new THREE.Color(0x0a3550),
  silentHillSky: new THREE.Color(0xaec3d2),
  silentHillFog: new THREE.Color(0xb8c7cf)
}

const tmpA = new THREE.Color()
const tmpB = new THREE.Color()

function desaturate(c: THREE.Color, amount: number): void {
  const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11
  c.lerp(tmpB.setRGB(l, l, l), amount)
}

/** The cosine-smoothed celestial curve used by Minecraft 1.2.5. */
export function vanillaCelestialPhase(clockTime: number): number {
  const phase = ((clockTime - 0.25) % 1 + 1) % 1
  const cosine = 1 - (Math.cos(phase * Math.PI) + 1) / 2
  return phase + (cosine - phase) / 3
}

/**
 * Hides the square chunk boundary while preserving nearby silhouettes.
 * High viewpoints need a little more haze because they expose much more of
 * the finite rendered square than a player standing near sea level.
 */
export function horizonFogDensity(viewDist: number, playerY: number): number {
  const base = 1.58 / Math.max(64, viewDist)
  const highView = smoothstep(78, 118, playerY)
  return base * (1 + highView * 0.28)
}

export function horizonHazeOpacity(playerY: number): number {
  return smoothstep(74, 98, playerY)
}

/** Day/night cycle, sun + moon light, fog, and sky — modulated by weather. */
export class Environment {
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  ambient: THREE.AmbientLight
  sky: Sky
  fog: THREE.FogExp2
  horizonHaze: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>

  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset */
  timeOfDay = 0.32
  /** Classic Minecraft: 24,000 ticks at 20 TPS = 20 real minutes. */
  dayLengthSec = 1200
  timeScale = 1
  private weather: WeatherOut = {
    cloudCover: 0.3, cloudDark: 0, lightMul: 1, fogMul: 1, rain: 0, snow: 0, wind: 1, wetness: 0
  }
  private sunDir = new THREE.Vector3()
  private silentHill = false

  constructor(scene: THREE.Scene, shadowMapSize: number, viewDist: number) {
    this.sun = new THREE.DirectionalLight(0xffffff, 3)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    const ext = 90
    this.sun.shadow.camera.left = -ext
    this.sun.shadow.camera.right = ext
    this.sun.shadow.camera.top = ext
    this.sun.shadow.camera.bottom = -ext
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 640
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.6
    // Voxel skylight and corner AO are already baked into terrain vertex
    // colors. A fully opaque realtime shadow multiplies that darkness again,
    // crushing obsidian and shaded logs almost to black.
    this.sun.shadow.intensity = 0.68
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.hemi = new THREE.HemisphereLight(C.hemiSkyDay, C.hemiGround, 0.9)
    scene.add(this.hemi)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.08)
    scene.add(this.ambient)

    this.sky = new Sky()
    scene.add(this.sky.group)

    this.fog = new THREE.FogExp2(0xaccbe8, this.baseFogDensity(viewDist))
    scene.fog = this.fog

    // At mountain height the square edge of the finite chunk mesh becomes
    // visible below the horizon. A sea-level atmospheric floor continues low
    // terrain into the fog without generating hundreds of distant chunks.
    const hazeGeometry = new THREE.CircleGeometry(1500, 96)
    hazeGeometry.rotateX(-Math.PI / 2)
    const hazeMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: U.uHorizon,
        uOpacity: { value: 0 },
        uFadeStart: { value: viewDist * 0.55 },
        uFadeEnd: { value: viewDist * 0.9 }
      },
      vertexShader: /* glsl */`
        varying float vHazeDistance;
        void main() {
          vHazeDistance = length(position.xz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying float vHazeDistance;
        uniform vec3 uColor;
        uniform float uOpacity, uFadeStart, uFadeEnd;
        void main() {
          float alpha = smoothstep(uFadeStart, uFadeEnd, vHazeDistance) * uOpacity;
          if (alpha < 0.002) discard;
          gl_FragColor = vec4(uColor, alpha);
        }
      `
    })
    this.horizonHaze = new THREE.Mesh(hazeGeometry, hazeMaterial)
    this.horizonHaze.position.y = 62.72
    // Draw after water and other transparent terrain so both loaded lowlands
    // and the empty area beyond them receive one continuous veil.
    this.horizonHaze.renderOrder = 10
    this.horizonHaze.frustumCulled = false
    scene.add(this.horizonHaze)
  }

  private baseFogDensity(viewDist: number): number {
    return horizonFogDensity(viewDist, 64)
  }

  setViewDistance(viewDist: number): void {
    this.fog.density = this.baseFogDensity(viewDist)
  }

  setWeather(w: WeatherOut): void { this.weather = w }

  /** Keeps the horizon swallowed by pale fog regardless of time and weather. */
  setSilentHill(enabled: boolean): void { this.silentHill = enabled }

  /** Toggling castShadow is enough: three recompiles affected programs itself. */
  setShadowsEnabled(enabled: boolean): void {
    this.sun.castShadow = enabled
    if (!enabled && this.sun.shadow.map) {
      this.sun.shadow.map.dispose()
      this.sun.shadow.map = null
    }
  }

  setShadowMapSize(px: number): void {
    this.sun.shadow.mapSize.set(px, px)
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose()
      this.sun.shadow.map = null
    }
  }

  skipTime(amount = 0.1): void {
    this.timeOfDay = (this.timeOfDay + amount) % 1
  }

  timeString(): string {
    const mins = Math.floor(this.timeOfDay * 24 * 60)
    const h = Math.floor(mins / 60), m = mins % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  isNight(): boolean { return U.uNight.value > 0.5 }

  update(dt: number, camera: THREE.Camera, playerPos: THREE.Vector3, underwater: boolean, viewDist: number): void {
    this.timeOfDay = (this.timeOfDay + dt * this.timeScale / this.dayLengthSec) % 1
    const w = this.weather

    const ang = 2 * Math.PI * vanillaCelestialPhase(this.timeOfDay)
    this.sunDir.set(Math.cos(ang) * 0.9, Math.sin(ang), 0.38).normalize()
    const sunY = this.sunDir.y

    const dayF = smoothstep(-0.04, 0.2, sunY)
    const duskF = Math.exp(-Math.pow((sunY - 0.03) / 0.14, 2))
    const nightF = 1 - smoothstep(-0.16, -0.03, sunY)
    U.uNight.value = nightF
    U.uSunDir.value.copy(this.sunDir)

    const overcast = clamp(w.cloudDark * 0.9 + (w.cloudCover - 0.35) * 0.55, 0, 1)

    // sky colors
    tmpA.copy(C.nightZenith).lerp(C.dayZenith, dayF)
    tmpA.lerp(C.duskZenith, duskF * 0.55)
    desaturate(tmpA, overcast * 0.55)
    U.uZenith.value.copy(tmpA)

    tmpA.copy(C.nightHorizon).lerp(C.dayHorizon, dayF)
    tmpA.lerp(C.duskHorizon, duskF * 0.8)
    desaturate(tmpA, overcast * 0.6)
    tmpA.lerp(C.overcast, overcast * 0.45 * dayF)
    U.uHorizon.value.copy(tmpA)
    if (this.silentHill) {
      U.uZenith.value.lerp(C.silentHillSky, 0.76)
      U.uHorizon.value.lerp(C.silentHillFog, 0.92)
    }

    // sun light
    tmpA.copy(C.sunWarm).lerp(C.sunNoon, smoothstep(0, 0.5, sunY))
    U.uSunColor.value.copy(tmpA)

    const lightMul = w.lightMul
    if (sunY > -0.06) {
      this.sun.color.copy(tmpA)
      this.sun.intensity = 3.3 * dayF * lightMul + 0.12
      this.sun.position.copy(playerPos).addScaledVector(this.sunDir, 300)
    } else {
      // moonlight
      this.sun.color.copy(C.moon)
      this.sun.intensity = 0.82 * nightF * lightMul
      this.sun.position.copy(playerPos).addScaledVector(this.sunDir, -300)
    }
    // snap the shadow target to a coarse grid to avoid shimmer
    this.sun.target.position.set(
      Math.round(playerPos.x / 4) * 4, Math.round(playerPos.y / 4) * 4, Math.round(playerPos.z / 4) * 4
    )

    this.hemi.color.copy(C.hemiSkyNight).lerp(C.hemiSkyDay, dayF)
    // Terrain already carries propagated sky/block light in its vertex
    // colours. Keep global fill deliberately weak so it cannot illuminate
    // sealed caves through stone.
    this.hemi.intensity = (0.22 + 0.18 * dayF) * (1 - overcast * 0.24)
    this.ambient.intensity = 0.1 - 0.04 * dayF + U.uFlash.value * 1.15

    // fog
    const baseDensity = horizonFogDensity(viewDist, playerPos.y)
    if (underwater) {
      this.fog.color.copy(C.underwater).multiplyScalar(0.35 + dayF * 0.65)
      this.fog.density = 0.095
    } else if (this.silentHill) {
      this.fog.color.copy(C.silentHillFog)
      // Exp2 density 0.032 leaves nearby blocks crisp while silhouettes fade
      // heavily around 30 blocks and disappear into the horizon by about 50.
      this.fog.density = 0.032
    } else {
      this.fog.color.copy(U.uHorizon.value)
      this.fog.density = baseDensity * w.fogMul
    }
    U.uFogColor.value.copy(this.fog.color)
    U.uFogDensity.value = this.fog.density

    const hazeOpacity = horizonHazeOpacity(playerPos.y)
    this.horizonHaze.visible = !underwater && !this.silentHill && hazeOpacity > 0.001
    this.horizonHaze.material.uniforms.uOpacity.value = hazeOpacity
    this.horizonHaze.material.uniforms.uFadeStart.value = viewDist * 0.55
    this.horizonHaze.material.uniforms.uFadeEnd.value = viewDist * 0.9
    this.horizonHaze.position.x = Math.round(playerPos.x / 16) * 16
    this.horizonHaze.position.z = Math.round(playerPos.z / 16) * 16

    // clouds + wind + lightning decay
    U.uCloudCover.value = w.cloudCover
    U.uCloudDark.value = w.cloudDark
    U.uWind.value = w.wind
    U.uFlash.value = Math.max(0, U.uFlash.value - dt * 3.2)

    const camPos = (camera as THREE.PerspectiveCamera).position
    U.uCamPos.value.copy(camPos)
    this.sky.update(camPos)
  }
}
