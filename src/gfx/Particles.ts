import * as THREE from 'three'
import { clamp } from '../util/math'

function makeSpriteTex(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 32): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  draw(ctx, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const rainTex = () => makeSpriteTex((ctx, s) => {
  const g = ctx.createLinearGradient(s / 2, 0, s / 2, s)
  g.addColorStop(0, 'rgba(190,210,240,0)')
  g.addColorStop(0.45, 'rgba(190,210,240,0.85)')
  g.addColorStop(1, 'rgba(190,210,240,0)')
  ctx.fillStyle = g
  ctx.fillRect(s / 2 - 1.2, 0, 2.4, s)
})

const softTex = (r: number, g: number, b: number) => makeSpriteTex((ctx, s) => {
  const gr = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  gr.addColorStop(0, `rgba(${r},${g},${b},1)`)
  gr.addColorStop(0.6, `rgba(${r},${g},${b},0.55)`)
  gr.addColorStop(1, `rgba(${r},${g},${b},0)`)
  ctx.fillStyle = gr
  ctx.fillRect(0, 0, s, s)
})

const chipTex = () => makeSpriteTex((ctx, s) => {
  ctx.fillStyle = 'rgba(255,255,255,1)'
  ctx.fillRect(s * 0.2, s * 0.2, s * 0.6, s * 0.6)
})

class PointCloud {
  points: THREE.Points
  geo: THREE.BufferGeometry
  pos: Float32Array
  vel: Float32Array
  life: Float32Array | null
  mat: THREE.PointsMaterial
  count: number

  constructor(count: number, mat: THREE.PointsMaterial, withLife = false, withColor = false) {
    this.count = count
    this.geo = new THREE.BufferGeometry()
    this.pos = new Float32Array(count * 3)
    this.vel = new Float32Array(count * 3)
    this.life = withLife ? new Float32Array(count) : null
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    if (withColor) {
      this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    }
    this.mat = mat
    this.points = new THREE.Points(this.geo, mat)
    this.points.frustumCulled = false
  }

  markDirty(): void {
    this.geo.getAttribute('position').needsUpdate = true
  }
}

export class Particles {
  private rain: PointCloud
  private snow: PointCloud
  private debris: PointCloud
  private fireflies: PointCloud
  private bubbles: PointCloud
  private debrisNext = 0
  private mult: number

  constructor(scene: THREE.Scene, mult: number) {
    this.mult = mult

    this.rain = new PointCloud(Math.floor(1500 * mult), new THREE.PointsMaterial({
      map: rainTex(), size: 0.85, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true
    }))
    scene.add(this.rain.points)

    this.snow = new PointCloud(Math.floor(900 * mult), new THREE.PointsMaterial({
      map: softTex(245, 248, 255), size: 0.16, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true
    }))
    scene.add(this.snow.points)

    this.debris = new PointCloud(256, new THREE.PointsMaterial({
      map: chipTex(), size: 0.12, transparent: true, vertexColors: true,
      depthWrite: false, sizeAttenuation: true, alphaTest: 0.1
    }), true, true)
    scene.add(this.debris.points)
    // park unused debris far below the world
    for (let i = 0; i < this.debris.count; i++) this.debris.pos[i * 3 + 1] = -500
    this.debris.markDirty()

    this.fireflies = new PointCloud(Math.floor(48 * mult) + 8, new THREE.PointsMaterial({
      map: softTex(190, 255, 110), size: 0.14, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }))
    scene.add(this.fireflies.points)

    this.bubbles = new PointCloud(60, new THREE.PointsMaterial({
      map: softTex(200, 230, 255), size: 0.07, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true
    }))
    scene.add(this.bubbles.points)

    this.seedAround(this.rain, 20, 24)
    this.seedAround(this.snow, 20, 24)
    this.seedAround(this.fireflies, 22, 8)
    this.seedAround(this.bubbles, 4, 4)
  }

  private seedAround(pc: PointCloud, radius: number, height: number): void {
    for (let i = 0; i < pc.count; i++) {
      pc.pos[i * 3] = (Math.random() - 0.5) * radius * 2
      pc.pos[i * 3 + 1] = Math.random() * height - height / 2
      pc.pos[i * 3 + 2] = (Math.random() - 0.5) * radius * 2
      pc.vel[i * 3] = Math.random() - 0.5
      pc.vel[i * 3 + 1] = Math.random()
      pc.vel[i * 3 + 2] = Math.random() - 0.5
    }
    pc.markDirty()
  }

  /** Spawn a burst of block chips. */
  burst(x: number, y: number, z: number, color: [number, number, number], n = 14): void {
    const colAttr = this.debris.geo.getAttribute('color') as THREE.BufferAttribute
    for (let i = 0; i < n; i++) {
      const idx = this.debrisNext
      this.debrisNext = (this.debrisNext + 1) % this.debris.count
      this.debris.pos[idx * 3] = x + (Math.random() - 0.5) * 0.6
      this.debris.pos[idx * 3 + 1] = y + (Math.random() - 0.5) * 0.6
      this.debris.pos[idx * 3 + 2] = z + (Math.random() - 0.5) * 0.6
      this.debris.vel[idx * 3] = (Math.random() - 0.5) * 3.4
      this.debris.vel[idx * 3 + 1] = Math.random() * 3.6 + 1
      this.debris.vel[idx * 3 + 2] = (Math.random() - 0.5) * 3.4
      this.debris.life![idx] = 0.7 + Math.random() * 0.5
      const shade = 0.75 + Math.random() * 0.4
      colAttr.setXYZ(idx, color[0] * shade, color[1] * shade, color[2] * shade)
    }
    colAttr.needsUpdate = true
    this.debris.markDirty()
  }

  splash(x: number, y: number, z: number): void {
    this.burst(x, y, z, [0.75, 0.87, 0.97], 18)
  }

  update(dt: number, cam: THREE.Vector3, rain: number, snow: number, night: number, underwater: boolean, wind: number): void {
    // rain
    this.rain.mat.opacity = clamp(rain, 0, 1) * 0.75
    if (rain > 0.01) {
      const p = this.rain.pos
      for (let i = 0; i < this.rain.count; i++) {
        p[i * 3] += wind * 1.6 * dt
        p[i * 3 + 1] -= (30 + (i % 7)) * dt
        if (p[i * 3 + 1] < cam.y - 8) {
          p[i * 3] = cam.x + (Math.random() - 0.5) * 42
          p[i * 3 + 1] = cam.y + 12 + Math.random() * 10
          p[i * 3 + 2] = cam.z + (Math.random() - 0.5) * 42
        }
      }
      this.rain.markDirty()
    }

    // snow
    this.snow.mat.opacity = clamp(snow, 0, 1) * 0.9
    if (snow > 0.01) {
      const p = this.snow.pos, v = this.snow.vel
      for (let i = 0; i < this.snow.count; i++) {
        p[i * 3] += (Math.sin(i + p[i * 3 + 1] * 0.5) * 0.5 + wind * 0.7) * dt
        p[i * 3 + 1] -= (1.6 + v[i * 3 + 1]) * dt
        p[i * 3 + 2] += Math.cos(i * 1.7 + p[i * 3 + 1] * 0.4) * 0.4 * dt
        if (p[i * 3 + 1] < cam.y - 6) {
          p[i * 3] = cam.x + (Math.random() - 0.5) * 38
          p[i * 3 + 1] = cam.y + 10 + Math.random() * 8
          p[i * 3 + 2] = cam.z + (Math.random() - 0.5) * 38
        }
      }
      this.snow.markDirty()
    }

    // debris
    {
      const p = this.debris.pos, v = this.debris.vel, life = this.debris.life!
      let any = false
      for (let i = 0; i < this.debris.count; i++) {
        if (life[i] <= 0) continue
        any = true
        life[i] -= dt
        v[i * 3 + 1] -= 12 * dt
        p[i * 3] += v[i * 3] * dt
        p[i * 3 + 1] += v[i * 3 + 1] * dt
        p[i * 3 + 2] += v[i * 3 + 2] * dt
        if (life[i] <= 0) p[i * 3 + 1] = -500
      }
      if (any) this.debris.markDirty()
    }

    // fireflies — calm clear nights only
    const ffTarget = night * (1 - rain) * (1 - snow) * 0.9
    this.fireflies.mat.opacity += (ffTarget - this.fireflies.mat.opacity) * clamp(dt * 2, 0, 1)
    if (this.fireflies.mat.opacity > 0.02) {
      const p = this.fireflies.pos
      const t = performance.now() / 1000
      for (let i = 0; i < this.fireflies.count; i++) {
        p[i * 3] += Math.sin(t * 0.7 + i * 2.3) * 0.35 * dt
        p[i * 3 + 1] += Math.cos(t * 0.9 + i * 1.1) * 0.22 * dt
        p[i * 3 + 2] += Math.cos(t * 0.6 + i * 3.1) * 0.35 * dt
        const dx = p[i * 3] - cam.x, dy = p[i * 3 + 1] - cam.y, dz = p[i * 3 + 2] - cam.z
        if (dx * dx + dy * dy + dz * dz > 30 * 30) {
          p[i * 3] = cam.x + (Math.random() - 0.5) * 36
          p[i * 3 + 1] = cam.y + (Math.random() - 0.4) * 6
          p[i * 3 + 2] = cam.z + (Math.random() - 0.5) * 36
        }
      }
      this.fireflies.markDirty()
    }

    // bubbles while underwater
    this.bubbles.mat.opacity = underwater ? 0.55 : 0
    if (underwater) {
      const p = this.bubbles.pos
      for (let i = 0; i < this.bubbles.count; i++) {
        p[i * 3 + 1] += (0.5 + (i % 5) * 0.12) * dt
        const dx = p[i * 3] - cam.x, dy = p[i * 3 + 1] - cam.y, dz = p[i * 3 + 2] - cam.z
        if (dx * dx + dy * dy + dz * dz > 36 || dy > 3) {
          p[i * 3] = cam.x + (Math.random() - 0.5) * 6
          p[i * 3 + 1] = cam.y - 2 - Math.random() * 2
          p[i * 3 + 2] = cam.z + (Math.random() - 0.5) * 6
        }
      }
      this.bubbles.markDirty()
    }
  }
}
