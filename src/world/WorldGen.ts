import { SimplexNoise, fbm2, ridged2 } from '../util/Noise'
import { xmur3, hash01, hash2, clamp, lerp, smoothstep } from '../util/math'
import { B } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'

export const SEA_LEVEL = 40

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, MOUNTAIN: 5, SNOW: 6, RIVER: 7
} as const

export const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Mountains', 'Snowfields', 'River']

/** Grass/foliage tint per biome (multiplies the pale grass texture). */
export const GRASS_TINT: [number, number, number][] = [
  [0.55, 0.72, 0.45], // ocean (unused)
  [0.66, 0.74, 0.44], // beach
  [0.62, 0.80, 0.38], // plains — warm green
  [0.40, 0.66, 0.28], // forest — deep green
  [0.72, 0.72, 0.40], // desert — dry
  [0.52, 0.66, 0.40], // mountain
  [0.58, 0.70, 0.52], // snow
  [0.55, 0.75, 0.42]  // river banks
]

export interface ColumnInfo {
  height: number
  biome: number
  treeDensity: number
}

interface TreeDef {
  x: number; z: number
  baseY: number
  height: number
  pine: boolean
}

export class WorldGen {
  readonly seedNum: number
  readonly seedStr: string
  private continent: SimplexNoise
  private hills: SimplexNoise
  private ridge: SimplexNoise
  private mask: SimplexNoise
  private temp: SimplexNoise
  private moist: SimplexNoise
  private river: SimplexNoise
  private detail: SimplexNoise
  private cave1: SimplexNoise
  private cave2: SimplexNoise
  private colCache = new Map<number, ColumnInfo>()

  constructor(seedStr: string) {
    this.seedStr = seedStr
    const s = xmur3(seedStr)
    this.seedNum = s
    this.continent = new SimplexNoise(s ^ 0x1000)
    this.hills = new SimplexNoise(s ^ 0x2000)
    this.ridge = new SimplexNoise(s ^ 0x3000)
    this.mask = new SimplexNoise(s ^ 0x4000)
    this.temp = new SimplexNoise(s ^ 0x5000)
    this.moist = new SimplexNoise(s ^ 0x6000)
    this.river = new SimplexNoise(s ^ 0x7000)
    this.detail = new SimplexNoise(s ^ 0x8000)
    this.cave1 = new SimplexNoise(s ^ 0x9000)
    this.cave2 = new SimplexNoise(s ^ 0xa000)
  }

  columnInfo(x: number, z: number): ColumnInfo {
    const key = (x + 16384) * 40000 + (z + 16384)
    const cached = this.colCache.get(key)
    if (cached) return cached

    // broad landmass shape: negative = ocean basins
    const c = fbm2(this.continent, x * 0.0014, z * 0.0014, 4)
    let h = SEA_LEVEL + 4 + c * 26

    // rolling hills
    h += fbm2(this.hills, x * 0.006, z * 0.006, 4) * 9

    // ridged mountain ranges, gated by a slow mask so they form distinct regions
    const mRaw = fbm2(this.mask, x * 0.0011 + 100, z * 0.0011 - 50, 3)
    const mMask = smoothstep(0.04, 0.42, mRaw)
    const ridge = ridged2(this.ridge, x * 0.0032, z * 0.0032, 4)
    h += ridge * ridge * mMask * 68

    // fine detail
    h += this.detail.noise2(x * 0.03, z * 0.03) * 2

    // rivers carve lowlands down to just below sea level
    const rN = Math.abs(fbm2(this.river, x * 0.0011 + 500, z * 0.0011 + 500, 3))
    const riverStrength = smoothstep(0.052, 0.012, rN) * smoothstep(66, 52, h)
    let isRiver = false
    if (riverStrength > 0.01) {
      const carved = lerp(h, Math.min(h, SEA_LEVEL - 2.5 - riverStrength * 2), riverStrength)
      if (carved < h) {
        h = carved
        if (h < SEA_LEVEL + 1 && riverStrength > 0.55) isRiver = true
      }
    }

    const height = clamp(Math.round(h), 3, WORLD_HEIGHT - 10)

    // climate
    const t = fbm2(this.temp, x * 0.0007 - 300, z * 0.0007 + 200, 3) - (height - SEA_LEVEL) * 0.006
    const m = fbm2(this.moist, x * 0.0009 + 800, z * 0.0009 - 400, 3)

    let biome: number
    if (height < SEA_LEVEL - 1) biome = BIOME.OCEAN
    else if (isRiver) biome = BIOME.RIVER
    else if (height >= 84 || t < -0.42) biome = BIOME.SNOW
    else if (height >= 68) biome = BIOME.MOUNTAIN
    else if (height <= SEA_LEVEL + 2) biome = BIOME.BEACH
    else if (t > 0.4 && m < -0.05) biome = BIOME.DESERT
    else if (m > 0.08) biome = BIOME.FOREST
    else biome = BIOME.PLAINS

    let treeDensity = 0
    if (biome === BIOME.FOREST) treeDensity = 0.026
    else if (biome === BIOME.PLAINS) treeDensity = 0.0035
    else if (biome === BIOME.SNOW && height < 100) treeDensity = 0.012
    else if (biome === BIOME.MOUNTAIN && height < 80) treeDensity = 0.006

    const info: ColumnInfo = { height, biome, treeDensity }
    if (this.colCache.size > 60000) this.colCache.clear()
    this.colCache.set(key, info)
    return info
  }

  heightAt(x: number, z: number): number { return this.columnInfo(x, z).height }
  biomeAt(x: number, z: number): number { return this.columnInfo(x, z).biome }

  /** Deterministic tree lookup for any column (or null). */
  treeAt(x: number, z: number): TreeDef | null {
    const r = hash01(x, z, this.seedNum ^ 0xa53a53)
    const info = this.columnInfo(x, z)
    if (info.treeDensity <= 0 || r >= info.treeDensity) return null
    if (info.height <= SEA_LEVEL) return null
    if (info.biome === BIOME.BEACH || info.biome === BIOME.DESERT || info.biome === BIOME.RIVER) return null
    const h2 = hash2(x, z, this.seedNum ^ 0x77aa)
    const pine = info.biome === BIOME.SNOW || info.biome === BIOME.MOUNTAIN
    const height = pine ? 6 + (h2 % 4) : 4 + (h2 % 3)
    return { x, z, baseY: info.height + 1, height, pine }
  }

  fillChunk(chunk: Chunk): void {
    const bx = chunk.cx * CHUNK_SIZE
    const bz = chunk.cz * CHUNK_SIZE
    const blocks = chunk.blocks
    const seed = this.seedNum

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = bx + lx, wz = bz + lz
        const info = this.columnInfo(wx, wz)
        const h = info.height
        const biome = info.biome
        const col = ((lx << 4) | lz) << 7
        chunk.colBiome[(lx << 4) | lz] = biome
        chunk.colHeight[(lx << 4) | lz] = h

        // choose surface materials
        let top: number = B.GRASS
        let under: number = B.DIRT
        let underDepth = 3
        if (biome === BIOME.OCEAN) {
          top = h > SEA_LEVEL - 7 ? B.SAND : (hash01(wx, wz, seed ^ 0x99) > 0.5 ? B.GRAVEL : B.SAND)
          under = top
        } else if (biome === BIOME.BEACH || biome === BIOME.DESERT || biome === BIOME.RIVER) {
          top = B.SAND; under = B.SAND; underDepth = 4
        } else if (biome === BIOME.SNOW) {
          top = B.SNOW; under = B.DIRT
        } else if (biome === BIOME.MOUNTAIN) {
          top = h > 74 ? B.STONE : B.GRASS
          under = h > 74 ? B.STONE : B.DIRT
        }
        // gravel patches on grass near water
        if (top === B.GRASS && h <= SEA_LEVEL + 1 && hash01(wx, wz, seed ^ 0x1234) > 0.8) {
          top = B.GRAVEL
        }

        const bedrockH = 1 + (hash2(wx, wz, seed ^ 0x5555) % 2)
        for (let y = 0; y <= h; y++) {
          let id: number
          if (y <= bedrockH) id = B.BEDROCK
          else if (y === h) id = top
          else if (y >= h - underDepth) id = under
          else id = B.STONE
          blocks[col | y] = id
        }

        // water fill
        if (h < SEA_LEVEL) {
          for (let y = h + 1; y <= SEA_LEVEL; y++) blocks[col | y] = B.WATER
        }

        // caves — twin ridged 3D noise makes winding tunnels; skip under water bodies
        if (h >= SEA_LEVEL + 2) {
          const yTop = Math.min(h - 7, 90)
          for (let y = 5; y <= yTop; y++) {
            const n1 = Math.abs(this.cave1.noise3(wx * 0.017, y * 0.024, wz * 0.017))
            if (n1 > 0.1) continue
            const n2 = Math.abs(this.cave2.noise3(wx * 0.017, y * 0.024, wz * 0.017))
            if (n2 < 0.1) blocks[col | y] = B.AIR
          }
        }

        // surface decorations
        if (top === B.GRASS && h + 1 < WORLD_HEIGHT && blocks[col | h] === B.GRASS) {
          const r = hash01(wx, wz, seed ^ 0xdead)
          const dense = biome === BIOME.FOREST ? 0.16 : biome === BIOME.PLAINS ? 0.11 : 0.04
          if (r < dense) blocks[col | (h + 1)] = B.TALLGRASS
          else if (r < dense + 0.014 && (biome === BIOME.PLAINS || biome === BIOME.FOREST)) {
            blocks[col | (h + 1)] = r < dense + 0.007 ? B.FLOWER_Y : B.FLOWER_R
          }
        }
      }
    }

    // stamp trees whose canopy may reach into this chunk
    for (let tx = bx - 3; tx < bx + CHUNK_SIZE + 3; tx++) {
      for (let tz = bz - 3; tz < bz + CHUNK_SIZE + 3; tz++) {
        const tree = this.treeAt(tx, tz)
        if (tree) this.stampTree(chunk, tree)
      }
    }

    chunk.state = 1
  }

  private setInChunk(chunk: Chunk, wx: number, y: number, wz: number, id: number, replaceSolid = false): void {
    const lx = wx - chunk.cx * CHUNK_SIZE
    const lz = wz - chunk.cz * CHUNK_SIZE
    if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return
    const i = (((lx << 4) | lz) << 7) | y
    const cur = chunk.blocks[i]
    if (!replaceSolid && cur !== B.AIR && cur !== B.TALLGRASS && cur !== B.FLOWER_Y && cur !== B.FLOWER_R) return
    chunk.blocks[i] = id
  }

  private stampTree(chunk: Chunk, tree: TreeDef): void {
    const { x, z, baseY, height, pine } = tree
    const leafId = pine ? B.PINELEAVES : B.LEAVES
    const logId = pine ? B.PINELOG : B.LOG
    const topY = baseY + height

    if (pine) {
      // conical spruce
      let radius = 2
      for (let y = topY; y >= baseY + 1; y--) {
        const layer = topY - y
        const r = layer === 0 ? 0 : Math.min(radius, 1 + Math.floor(layer / 2))
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > r + (layer % 2 === 0 ? 0 : 1)) continue
          if (dx === 0 && dz === 0 && y < topY) continue
          this.setInChunk(chunk, x + dx, y, z + dz, leafId)
        }
      }
      this.setInChunk(chunk, x, topY + 1, z, leafId)
    } else {
      // oak blob canopy
      for (let dy = -2; dy <= 1; dy++) {
        const y = topY + dy
        const r = dy <= -1 ? 2 : 1
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r && hash01(x + dx * 7, z + dz * 13 + y, this.seedNum ^ 0x33) > 0.4) continue
          this.setInChunk(chunk, x + dx, y, z + dz, leafId)
        }
      }
    }
    // trunk overwrites leaves
    for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, logId, true)
    // dirt under trunk in case it sits on decoration/grass edge
  }

  /** Find a scenic spawn: elevated grass with water visible nearby. */
  findSpawn(): { x: number, z: number, yaw: number } {
    let best: { x: number, z: number, yaw: number, score: number } | null = null
    for (let i = 0; i < 260; i++) {
      const x = Math.round((hash01(i, 17, this.seedNum ^ 0xf00d) - 0.5) * 900)
      const z = Math.round((hash01(i, 71, this.seedNum ^ 0xbeef) - 0.5) * 900)
      const info = this.columnInfo(x, z)
      if (info.height < SEA_LEVEL + 6 || info.height > 88) continue
      if (info.biome === BIOME.DESERT || info.biome === BIOME.OCEAN || info.biome === BIOME.RIVER) continue
      // don't spawn inside a tree canopy
      let treeTooClose = false
      for (let dx = -2; dx <= 2 && !treeTooClose; dx++) {
        for (let dz = -2; dz <= 2 && !treeTooClose; dz++) {
          if (this.treeAt(x + dx, z + dz)) treeTooClose = true
        }
      }
      if (treeTooClose) continue
      // look for water and lower ground in 8 directions
      let bestDir = -1, bestDirScore = -1
      for (let d = 0; d < 8; d++) {
        const ang = d * Math.PI / 4
        let waterBonus = 0, dropBonus = 0, treeBonus = 0
        for (let step = 2; step <= 7; step++) {
          const sx = Math.round(x + Math.cos(ang) * step * 14)
          const sz = Math.round(z + Math.sin(ang) * step * 14)
          const si = this.columnInfo(sx, sz)
          if (si.height < SEA_LEVEL) waterBonus += 4
          if (si.height < info.height - 6) dropBonus += 1.5
          if (si.treeDensity > 0.01) treeBonus += 1
        }
        const ds = waterBonus + dropBonus + treeBonus
        if (ds > bestDirScore) { bestDirScore = ds; bestDir = d }
      }
      const score = bestDirScore
        + Math.min(info.height - SEA_LEVEL, 26) * 0.25
        + (info.biome === BIOME.FOREST || info.biome === BIOME.PLAINS ? 3 : 0)
        + (info.biome === BIOME.SNOW ? -3 : 0)
      if (!best || score > best.score) {
        // yaw=0 faces -Z, forward = (-sin yaw, 0, -cos yaw); aim it along (cos ang, 0, sin ang)
        const ang = bestDir * Math.PI / 4
        const yaw = Math.atan2(-Math.cos(ang), -Math.sin(ang))
        best = { x, z, yaw, score }
      }
    }
    if (!best) return { x: 8, z: 8, yaw: 0 }
    return { x: best.x, z: best.z, yaw: best.yaw }
  }
}
