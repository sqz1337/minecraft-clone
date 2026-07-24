import * as THREE from 'three'
import type { Atlas } from './Atlas'
import { U } from './Uniforms'

const WIND_VERTEX = /* glsl */`
  {
    float ph = position.x * 1.7 + position.z * 1.3 + position.y * 0.6;
    float sway = aSway * uWindStrength;
    transformed.x += (sin(uWindTime * 1.9 + ph) + 0.5 * sin(uWindTime * 3.7 + ph * 1.7)) * 0.05 * sway;
    transformed.z += cos(uWindTime * 1.6 + ph * 0.8) * 0.045 * sway;
  }
`

export class Materials {
  solid: THREE.MeshLambertMaterial
  foliage: THREE.MeshLambertMaterial
  glass: THREE.MeshLambertMaterial
  emissive: THREE.MeshBasicMaterial
  furnaceFire: THREE.MeshBasicMaterial
  chest: THREE.MeshLambertMaterial
  largeChest: THREE.MeshLambertMaterial
  xrayOre: THREE.MeshBasicMaterial
  water: THREE.MeshLambertMaterial

  constructor(atlas: Atlas) {
    // Lambert everywhere: AO, sky/block light and tinting are already baked
    // into vertex colors by the mesher, so per-pixel PBR buys nothing here.
    this.solid = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      // Beds and doors live in the solid mesh but their classic terrain.png
      // tiles contain real cutout pixels (not black geometry).
      alphaTest: 0.42
    })
    this.injectBlockLight(this.solid)

    this.foliage = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      alphaTest: 0.42,
      side: THREE.DoubleSide
    })
    this.injectWind(this.foliage)
    this.injectBlockLight(this.foliage)

    this.glass = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.58,
      alphaTest: 0.08,
      depthWrite: false,
      side: THREE.DoubleSide
    })

    this.emissive = new THREE.MeshBasicMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
      toneMapped: false
    })

    this.furnaceFire = new THREE.MeshBasicMaterial({
      map: atlas.colorTex,
      vertexColors: true
    })
    this.furnaceFire.onBeforeCompile = (shader) => {
      shader.uniforms.uFurnaceTime = U.uTime
      shader.fragmentShader = 'uniform float uFurnaceTime;\n' + shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float furnaceFireMask = smoothstep(0.08, 0.42, diffuseColor.r - diffuseColor.b)
          * smoothstep(0.18, 0.7, diffuseColor.r);
        float furnaceFlicker = 0.88
          + 0.1 * sin(uFurnaceTime * 9.0)
          + 0.06 * sin(uFurnaceTime * 17.0 + 1.7);
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          diffuseColor.rgb * furnaceFlicker + vec3(0.12, 0.035, 0.0),
          furnaceFireMask
        );`
      )
    }
    this.furnaceFire.customProgramCacheKey = () => 'furnace-fire-v1'

    this.chest = new THREE.MeshLambertMaterial({ map: atlas.chestTex })
    this.largeChest = new THREE.MeshLambertMaterial({ map: atlas.largeChestTex })

    this.xrayOre = new THREE.MeshBasicMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false
    })

    // Classic vanilla-style water: the semi-transparent blue still-water tile
    // from terrain.png, lit and fogged through the same built-in pipeline as the
    // terrain (so it matches sun/night/fog exactly). A gentle vertex wave on the
    // surface keeps it alive; the texture itself carries the animated look.
    this.water = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      transparent: false,
      opacity: 1,
      color: 0x668eaa,
      depthWrite: true,
      side: THREE.DoubleSide
    })
    this.injectBlockLight(this.glass)
    this.injectWaterWave(this.water)
  }

  setWaterViewedFromUnderwater(underwater: boolean): void {
    const opacity = underwater ? 0.92 : 1
    if (this.water.transparent === underwater && this.water.opacity === opacity) return
    this.water.transparent = underwater
    this.water.opacity = opacity
    this.water.needsUpdate = true
  }

  /** Undulates the water surface (aTop vertices) in world space, seamless across chunks. */
  private injectWaterWave(mat: THREE.Material): void {
    mat.onBeforeCompile = (shader: {
      uniforms: Record<string, unknown>
      vertexShader: string
      fragmentShader: string
    }) => {
      shader.uniforms.uWaterTime = U.uTime
      shader.vertexShader =
        'attribute float aTop;\nattribute float aWaterDepth;\nuniform float uWaterTime;\nvarying float vWaterDepth;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vWaterDepth = aWaterDepth;
          if (aTop > 0.5) {
            vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
            transformed.y += sin(wp.x * 0.9 + uWaterTime * 1.3) * 0.045
                           + sin(wp.z * 1.24 + uWaterTime * 1.7) * 0.04
                           + sin((wp.x + wp.z) * 0.5 + uWaterTime * 0.8) * 0.035;
          }
        `)
      shader.fragmentShader =
        'varying float vWaterDepth;\n' +
        shader.fragmentShader.replace('#include <map_fragment>', /* glsl */`
          #include <map_fragment>
          float waterTransmission = exp(-max(0.0, vWaterDepth) * 0.11);
          diffuseColor.rgb *= mix(0.38, 1.0, waterTransmission);
          diffuseColor.a *= mix(1.0, 0.90, waterTransmission);
        `)
    }
    mat.customProgramCacheKey = () => 'water-wave-depth-v3'
  }

  setXray(enabled: boolean): void {
    this.solid.transparent = enabled
    this.solid.opacity = enabled ? 0.1 : 1
    this.solid.depthWrite = !enabled
    this.solid.needsUpdate = true
  }

  private injectWind(mat: THREE.Material): void {
    mat.onBeforeCompile = (shader: { uniforms: Record<string, unknown>, vertexShader: string }) => {
      shader.uniforms.uWindTime = U.uTime
      shader.uniforms.uWindStrength = U.uWind
      shader.vertexShader =
        'attribute float aSway;\nuniform float uWindTime;\nuniform float uWindStrength;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_VERTEX)
    }
    mat.customProgramCacheKey = () => 'wind-' + mat.type
  }

  /**
   * The sun/moon lights shade skylight, while propagated block light stays
   * equally bright at noon and midnight. This floor is the classic lightmap's
   * independent block-light channel.
   */
  private injectBlockLight(mat: THREE.Material): void {
    const previous = mat.onBeforeCompile
    const previousKey = mat.customProgramCacheKey
    mat.onBeforeCompile = (shader, renderer) => {
      previous.call(mat, shader, renderer)
      shader.vertexShader =
        'attribute vec3 aBlockLight;\nvarying vec3 vBlockLight;\n' +
        shader.vertexShader.replace(
          '#include <color_vertex>',
          '#include <color_vertex>\nvBlockLight = aBlockLight;'
        )
      shader.fragmentShader =
        'varying vec3 vBlockLight;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          'outgoingLight = max(outgoingLight, diffuseColor.rgb * vBlockLight);\n#include <opaque_fragment>'
        )
    }
    mat.customProgramCacheKey = () => `${previousKey.call(mat)}-block-light-v1`
  }
}
