import * as THREE from 'three'
import { B, OPAQUE, CROSS, tileFor } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { GRASS_TINT } from './WorldGen'
import { hash301, hash01 } from '../util/math'
import type { World } from './World'
import type { Atlas } from '../gfx/Atlas'

export interface ChunkGeoms {
  solid: THREE.BufferGeometry | null
  foliage: THREE.BufferGeometry | null
  water: THREE.BufferGeometry | null
}

interface FaceDef {
  n: [number, number, number]
  c: [number, number, number][]   // 4 corners a,b,c,d
  uv: [number, number][]
}

// faces: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z — corners wound CCW outward
const FACES: FaceDef[] = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 1], [1, 1, 0]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 0], [1, 1, 1]], uv: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { n: [0, -1, 0], c: [[0, 0, 1], [0, 0, 0], [1, 0, 1], [1, 0, 0]], uv: [[0, 1], [0, 0], [1, 1], [1, 0]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] }
]

const AO_CURVE = [0.42, 0.62, 0.8, 1.0]
const WATER_SURFACE = 0.875

class GeomBuilder {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  col: number[] = []
  sway: number[] = []
  idx: number[] = []
  vcount = 0

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r: number, g: number, b: number, sw: number): void {
    this.pos.push(x, y, z)
    this.nrm.push(nx, ny, nz)
    this.uv.push(u, v)
    this.col.push(r, g, b)
    this.sway.push(sw)
    this.vcount++
  }

  quad(flip: boolean): void {
    const a = this.vcount - 4, b = a + 1, c = a + 2, d = a + 3
    if (flip) this.idx.push(a, b, d, a, d, c)
    else this.idx.push(a, b, c, c, b, d)
  }

  build(withSway: boolean): THREE.BufferGeometry | null {
    if (this.vcount === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    if (withSway) g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}

class WaterBuilder {
  pos: number[] = []
  nrm: number[] = []
  top: number[] = []
  idx: number[] = []
  vcount = 0

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, isTop: number): void {
    this.pos.push(x, y, z)
    this.nrm.push(nx, ny, nz)
    this.top.push(isTop)
    this.vcount++
  }

  quad(): void {
    const a = this.vcount - 4
    this.idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
  }

  build(): THREE.BufferGeometry | null {
    if (this.vcount === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(this.top, 1))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}

export function buildChunkGeoms(world: World, chunk: Chunk, atlas: Atlas, grassDensity: number): ChunkGeoms {
  const bx = chunk.cx * CHUNK_SIZE
  const bz = chunk.cz * CHUNK_SIZE
  const seed = world.gen.seedNum

  // cache the 3x3 chunk neighborhood for fast block sampling
  const hood: (Uint8Array | null)[] = []
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = world.getChunk(chunk.cx + dx, chunk.cz + dz)
      hood.push(c && c.state >= 1 ? c.blocks : null)
    }
  }

  const sample = (wx: number, wy: number, wz: number): number => {
    if (wy < 0) return B.BEDROCK
    if (wy >= WORLD_HEIGHT) return B.AIR
    const lx = wx - bx, lz = wz - bz
    const ncx = lx < 0 ? -1 : lx >= CHUNK_SIZE ? 1 : 0
    const ncz = lz < 0 ? -1 : lz >= CHUNK_SIZE ? 1 : 0
    const arr = hood[(ncz + 1) * 3 + (ncx + 1)]
    if (!arr) return B.AIR
    const ax = lx - ncx * CHUNK_SIZE, az = lz - ncz * CHUNK_SIZE
    return arr[(((ax << 4) | az) << 7) | wy]
  }

  const solidForAO = (wx: number, wy: number, wz: number): boolean => OPAQUE[sample(wx, wy, wz)]

  const solid = new GeomBuilder()
  const foliage = new GeomBuilder()
  const water = new WaterBuilder()
  const blocks = chunk.blocks

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const colIdx = (lx << 4) | lz
      const colBase = colIdx << 7
      const biome = chunk.colBiome[colIdx]
      const tint = GRASS_TINT[biome] ?? GRASS_TINT[2]
      const wx = bx + lx, wz = bz + lz

      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const id = blocks[colBase | y]
        if (id === B.AIR) continue

        if (id === B.WATER) {
          const above = sample(wx, y + 1, wz)
          const surface = above !== B.WATER
          const topH = surface ? WATER_SURFACE : 1
          if (surface && !OPAQUE[above]) {
            // top face
            water.vertex(wx, y + topH, wz, 0, 1, 0, 1)
            water.vertex(wx, y + topH, wz + 1, 0, 1, 0, 1)
            water.vertex(wx + 1, y + topH, wz, 0, 1, 0, 1)
            water.vertex(wx + 1, y + topH, wz + 1, 0, 1, 0, 1)
            water.quad()
          }
          // side + bottom faces against air
          for (let f = 0; f < 6; f++) {
            if (f === 2) continue
            const fd = FACES[f]
            const nb = sample(wx + fd.n[0], y + fd.n[1], wz + fd.n[2])
            if (nb === B.WATER || OPAQUE[nb] || (nb !== B.AIR && !CROSS[nb])) continue
            for (let ci = 0; ci < 4; ci++) {
              const cc = fd.c[ci]
              water.vertex(wx + cc[0], y + cc[1] * topH, wz + cc[2], fd.n[0], fd.n[1], fd.n[2], 0)
            }
            water.quad()
          }
          continue
        }

        if (CROSS[id]) {
          // decoration density thinning for low quality
          if (id === B.TALLGRASS && hash01(wx, wz, seed ^ 0xfeed) > grassDensity) continue
          const tile = tileFor(id, 0)
          const [u0, v0, u1, v1] = atlas.uvRect(tile)
          const jx = (hash01(wx, wz, seed ^ 0x71) - 0.5) * 0.3
          const jz = (hash01(wx, wz, seed ^ 0x72) - 0.5) * 0.3
          const useTint = id === B.TALLGRASS
          const r = useTint ? tint[0] * 1.35 : 1
          const g = useTint ? tint[1] * 1.35 : 1
          const bcol = useTint ? tint[2] * 1.35 : 1
          const x0 = wx + 0.14 + jx, x1 = wx + 0.86 + jx
          const z0 = wz + 0.14 + jz, z1 = wz + 0.86 + jz
          const quads: [number, number, number, number][] = [
            [x0, z0, x1, z1],
            [x0, z1, x1, z0]
          ]
          for (const [qx0, qz0, qx1, qz1] of quads) {
            foliage.vertex(qx0, y, qz0, 0, 1, 0, u0, v0, r * 0.85, g * 0.85, bcol * 0.85, 0)
            foliage.vertex(qx1, y, qz1, 0, 1, 0, u1, v0, r * 0.85, g * 0.85, bcol * 0.85, 0)
            foliage.vertex(qx0, y + 1, qz0, 0, 1, 0, u0, v1, r, g, bcol, 1)
            foliage.vertex(qx1, y + 1, qz1, 0, 1, 0, u1, v1, r, g, bcol, 1)
            foliage.quad(false)
          }
          continue
        }

        const isLeaf = id === B.LEAVES || id === B.PINELEAVES
        const target = isLeaf ? foliage : solid
        // subtle per-block value variation breaks up flat regions
        const vary = 0.92 + hash301(wx, y, wz, seed ^ 0xc0de) * 0.14

        for (let f = 0; f < 6; f++) {
          const fd = FACES[f]
          const nb = sample(wx + fd.n[0], y + fd.n[1], wz + fd.n[2])
          if (OPAQUE[nb]) continue
          if (isLeaf && nb === id) continue

          const tile = tileFor(id, f)
          const [u0, v0, u1, v1] = atlas.uvRect(tile)

          let tr = vary, tg = vary, tb = vary
          if (id === B.GRASS && f === 2) {
            tr *= tint[0]; tg *= tint[1]; tb *= tint[2]
          } else if (isLeaf) {
            const lv = 0.85 + hash301(wx >> 2, y >> 2, wz >> 2, seed ^ 0x1eaf) * 0.3
            tr *= lv; tg *= lv; tb *= lv * 0.95
          }

          // ambient occlusion per corner
          const ao: number[] = []
          const [nx, ny, nz] = fd.n
          for (let ci = 0; ci < 4; ci++) {
            const cc = fd.c[ci]
            // tangent offsets: for each non-normal axis, -1 if corner coord is 0 else +1
            const ox = nx !== 0 ? 0 : (cc[0] === 0 ? -1 : 1)
            const oy = ny !== 0 ? 0 : (cc[1] === 0 ? -1 : 1)
            const oz = nz !== 0 ? 0 : (cc[2] === 0 ? -1 : 1)
            const px = wx + nx, py = y + ny, pz = wz + nz
            let s1: boolean, s2: boolean, co: boolean
            if (nx !== 0) {
              s1 = solidForAO(px, py + oy, pz)
              s2 = solidForAO(px, py, pz + oz)
              co = solidForAO(px, py + oy, pz + oz)
            } else if (ny !== 0) {
              s1 = solidForAO(px + ox, py, pz)
              s2 = solidForAO(px, py, pz + oz)
              co = solidForAO(px + ox, py, pz + oz)
            } else {
              s1 = solidForAO(px + ox, py, pz)
              s2 = solidForAO(px, py + oy, pz)
              co = solidForAO(px + ox, py + oy, pz)
            }
            ao.push(s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (co ? 1 : 0)))
          }

          const uvs = fd.uv
          for (let ci = 0; ci < 4; ci++) {
            const cc = fd.c[ci]
            const shade = AO_CURVE[ao[ci]]
            target.vertex(
              wx + cc[0], y + cc[1], wz + cc[2],
              nx, ny, nz,
              uvs[ci][0] === 0 ? u0 : u1,
              uvs[ci][1] === 0 ? v0 : v1,
              tr * shade, tg * shade, tb * shade,
              isLeaf ? 0.4 : 0
            )
          }
          // flip the quad diagonal for smoother AO interpolation
          target.quad(ao[0] + ao[3] > ao[1] + ao[2])
        }
      }
    }
  }

  return {
    solid: solid.build(false),
    foliage: foliage.build(true),
    water: water.build()
  }
}
