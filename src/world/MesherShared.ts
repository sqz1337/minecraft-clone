import * as THREE from 'three'
import {
  B, SOLID, OPAQUE, CROSS, ORE, RENDER_SHAPE, TILE, tileFor, isWater, isLava, isLeafBlock, isBedBlock,
  isDoorBlock, doorCollisionBox, fluidLevel, canSupportVine, type HorizontalFace
} from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { GRASS_TINT } from './WorldGen'
import { hash301, hash01 } from '../util/math'
import type { World } from './World'
import type { Atlas } from '../gfx/Atlas'

export interface ChunkGeoms {
  solid: THREE.BufferGeometry | null
  foliage: THREE.BufferGeometry | null
  water: THREE.BufferGeometry | null
  glass: THREE.BufferGeometry | null
  emissive: THREE.BufferGeometry | null
  furnaceFire: THREE.BufferGeometry | null
  chest: THREE.BufferGeometry | null
  largeChest: THREE.BufferGeometry | null
  xray: THREE.BufferGeometry | null
}
export interface FaceDef {
  n: [number, number, number]
  c: [number, number, number][]   // 4 corners a,b,c,d
  uv: [number, number][]
}
export const FACES: FaceDef[] = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 1], [1, 1, 0]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 0], [1, 1, 1]], uv: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { n: [0, -1, 0], c: [[0, 0, 1], [0, 0, 0], [1, 0, 1], [1, 0, 0]], uv: [[0, 1], [0, 0], [1, 1], [1, 0]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] }
]
export const AO_CURVE = [0.42, 0.62, 0.8, 1.0]
export const WATER_SURFACE = 0.875
export class GeomBuilder {
  private capacity: number
  private pos: Float32Array
  private nrm: Float32Array
  private uv: Float32Array
  private col: Float32Array
  private sway: Float32Array
  private idx: Uint32Array
  vcount = 0
  private icount = 0

  constructor(capacity = 4096) {
    this.capacity = capacity
    this.pos = new Float32Array(capacity * 3)
    this.nrm = new Float32Array(capacity * 3)
    this.uv = new Float32Array(capacity * 2)
    this.col = new Float32Array(capacity * 3)
    this.sway = new Float32Array(capacity)
    this.idx = new Uint32Array((capacity * 3) >> 1)
  }

  reset(): void {
    this.vcount = 0
    this.icount = 0
  }

  private grow(): void {
    this.capacity *= 2
    const grown = (prev: Float32Array, stride: number): Float32Array => {
      const next = new Float32Array(this.capacity * stride)
      next.set(prev)
      return next
    }
    this.pos = grown(this.pos, 3)
    this.nrm = grown(this.nrm, 3)
    this.uv = grown(this.uv, 2)
    this.col = grown(this.col, 3)
    this.sway = grown(this.sway, 1)
    const idx = new Uint32Array((this.capacity * 3) >> 1)
    idx.set(this.idx)
    this.idx = idx
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r: number, g: number, b: number, sw: number): void {
    if (this.vcount >= this.capacity) this.grow()
    const v3 = this.vcount * 3, v2 = this.vcount * 2
    this.pos[v3] = x; this.pos[v3 + 1] = y; this.pos[v3 + 2] = z
    this.nrm[v3] = nx; this.nrm[v3 + 1] = ny; this.nrm[v3 + 2] = nz
    this.uv[v2] = u; this.uv[v2 + 1] = v
    this.col[v3] = r; this.col[v3 + 1] = g; this.col[v3 + 2] = b
    this.sway[this.vcount] = sw
    this.vcount++
  }

  quad(flip: boolean): void {
    const a = this.vcount - 4, b = a + 1, c = a + 2, d = a + 3
    const idx = this.idx, i = this.icount
    if (flip) {
      idx[i] = a; idx[i + 1] = b; idx[i + 2] = d
      idx[i + 3] = a; idx[i + 4] = d; idx[i + 5] = c
    } else {
      idx[i] = a; idx[i + 1] = b; idx[i + 2] = c
      idx[i + 3] = c; idx[i + 4] = b; idx[i + 5] = d
    }
    this.icount += 6
  }

  build(withSway: boolean): THREE.BufferGeometry | null {
    if (this.vcount === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.vcount * 3), 3))
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.vcount * 3), 3))
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.vcount * 2), 2))
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.vcount * 3), 3))
    if (withSway) g.setAttribute('aSway', new THREE.BufferAttribute(this.sway.slice(0, this.vcount), 1))
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.icount), 1))
    g.computeBoundingSphere()
    return g
  }
}
export class WaterBuilder {
  private capacity: number
  private pos: Float32Array
  private nrm: Float32Array
  private uv: Float32Array
  private top: Float32Array
  private idx: Uint32Array
  vcount = 0
  private icount = 0

  constructor(capacity = 2048) {
    this.capacity = capacity
    this.pos = new Float32Array(capacity * 3)
    this.nrm = new Float32Array(capacity * 3)
    this.uv = new Float32Array(capacity * 2)
    this.top = new Float32Array(capacity)
    this.idx = new Uint32Array((capacity * 3) >> 1)
  }

  reset(): void {
    this.vcount = 0
    this.icount = 0
  }

  private grow(): void {
    this.capacity *= 2
    const pos = new Float32Array(this.capacity * 3); pos.set(this.pos); this.pos = pos
    const nrm = new Float32Array(this.capacity * 3); nrm.set(this.nrm); this.nrm = nrm
    const uv = new Float32Array(this.capacity * 2); uv.set(this.uv); this.uv = uv
    const top = new Float32Array(this.capacity); top.set(this.top); this.top = top
    const idx = new Uint32Array((this.capacity * 3) >> 1); idx.set(this.idx); this.idx = idx
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, isTop: number): void {
    if (this.vcount >= this.capacity) this.grow()
    const v3 = this.vcount * 3, v2 = this.vcount * 2
    this.pos[v3] = x; this.pos[v3 + 1] = y; this.pos[v3 + 2] = z
    this.nrm[v3] = nx; this.nrm[v3 + 1] = ny; this.nrm[v3 + 2] = nz
    this.uv[v2] = u; this.uv[v2 + 1] = v
    this.top[this.vcount] = isTop
    this.vcount++
  }

  quad(): void {
    const a = this.vcount - 4
    const idx = this.idx, i = this.icount
    idx[i] = a; idx[i + 1] = a + 1; idx[i + 2] = a + 2
    idx[i + 3] = a + 2; idx[i + 4] = a + 1; idx[i + 5] = a + 3
    this.icount += 6
  }

  build(): THREE.BufferGeometry | null {
    if (this.vcount === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.vcount * 3), 3))
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.vcount * 3), 3))
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.vcount * 2), 2))
    g.setAttribute('aTop', new THREE.BufferAttribute(this.top.slice(0, this.vcount), 1))
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.icount), 1))
    g.computeBoundingSphere()
    return g
  }
}
export const solidBuilder = new GeomBuilder(8192)
export const foliageBuilder = new GeomBuilder(4096)
export const glassBuilder = new GeomBuilder(512)
export const emissiveBuilder = new GeomBuilder(512)
export const furnaceFireBuilder = new GeomBuilder(64)
export const xrayBuilder = new GeomBuilder(512)
export const waterBuilder = new WaterBuilder(2048)
