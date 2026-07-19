import { SimplexNoise, fbm2, ridged2 } from '../util/Noise'
import { xmur3, hash01, hash2, mulberry32, clamp, lerp, smoothstep } from '../util/math'
import { B } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'

export const SEA_LEVEL = 40

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, MOUNTAIN: 5, SNOW: 6, RIVER: 7,
  TAIGA: 8, SWAMP: 9, JUNGLE: 10, MUSHROOM: 11
} as const

export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Mountains', 'Snowfields', 'River',
  'Taiga', 'Swamp', 'Jungle', 'Mushroom Island'
]

/** Grass/foliage tint per biome (multiplies the pale grass texture). */
export const GRASS_TINT: [number, number, number][] = [
  [0.55, 0.72, 0.45], // ocean (unused)
  [0.66, 0.74, 0.44], // beach
  [0.62, 0.80, 0.38], // plains — warm green
  [0.40, 0.66, 0.28], // forest — deep green
  [0.72, 0.72, 0.40], // desert — dry
  [0.52, 0.66, 0.40], // mountain
  [0.58, 0.70, 0.52], // snow
  [0.55, 0.75, 0.42], // river banks
  [0.45, 0.63, 0.42], // taiga — cold blue-green
  [0.42, 0.55, 0.30], // swamp — murky olive
  [0.30, 0.72, 0.20], // jungle — vivid
  [0.58, 0.62, 0.58]  // mushroom island — washed out
]

export interface ColumnInfo {
  height: number
  biome: number
  treeDensity: number
}

export type TreeKind = 'oak' | 'pine' | 'jungle' | 'swamp' | 'mushroom_red' | 'mushroom_brown'

interface TreeDef {
  x: number; z: number
  baseY: number
  height: number
  kind: TreeKind
}

interface OreDef {
  id: number
  minY: number
  maxY: number
  veinsPerChunk: number
  minSize: number
  maxSize: number
  radiusScale: number
  salt: number
}

const ORE_DEFS: OreDef[] = [
  { id: B.COAL_ORE, minY: 5, maxY: 96, veinsPerChunk: 10, minSize: 8, maxSize: 16, radiusScale: 1, salt: 0x1c01 },
  { id: B.IRON_ORE, minY: 5, maxY: 64, veinsPerChunk: 8, minSize: 5, maxSize: 10, radiusScale: 1, salt: 0x1a02 },
  { id: B.GOLD_ORE, minY: 5, maxY: 32, veinsPerChunk: 2, minSize: 4, maxSize: 7, radiusScale: 0.8, salt: 0x601d },
  { id: B.DIAMOND_ORE, minY: 5, maxY: 18, veinsPerChunk: 1, minSize: 3, maxSize: 6, radiusScale: 0.75, salt: 0xd1a0 }
]

/* ------------------------------------------------------------------------- */
/* Deterministic structure metadata                                          */
/* ------------------------------------------------------------------------- */

export type StructureMob = 'zombie' | 'skeleton' | 'spider'

export interface StructureChest {
  x: number; y: number; z: number
  loot: 'dungeon' | 'mineshaft' | 'stronghold_storage' | 'stronghold_library' | 'village_house'
}

export interface StructureSpawner { x: number; y: number; z: number; mob: StructureMob }

export interface VillagerSpot { x: number; y: number; z: number }

interface DungeonPlan {
  x0: number; z0: number; w: number; d: number
  /** Interior floor level; air spans floorY..floorY+2. */
  floorY: number
  mob: StructureMob
  spawner: StructureSpawner
  chests: StructureChest[]
}

interface MineSegment {
  x0: number; x1: number; z0: number; z1: number
  y: number
  axis: 'x' | 'z'
  rails: boolean
}

interface MineshaftPlan {
  segments: MineSegment[]
  chests: StructureChest[]
}

interface StrongholdRoom {
  x0: number; z0: number; x1: number; z1: number
  y: number
  height: number
}

interface StrongholdPlan {
  rooms: StrongholdRoom[]
  /** Extra interior boxes carved to connect rooms (doorways). */
  openings: StrongholdRoom[]
  bookshelves: { x: number; y: number; z: number }[]
  framePositions: { x: number; y: number; z: number }[]
  spawner: StructureSpawner
  chests: StructureChest[]
  bounds: { x0: number; z0: number; x1: number; z1: number }
}

interface VillageBuilding {
  kind: 'well' | 'house' | 'farm' | 'large_house'
  cx: number; cz: number
  groundY: number
  /** Door side: 0 +X, 1 -X, 4 +Z, 5 -Z (toward the well). */
  facing: 0 | 1 | 4 | 5
}

interface VillagePlan {
  centerX: number; centerZ: number
  desert: boolean
  buildings: VillageBuilding[]
  chests: StructureChest[]
  villagers: VillagerSpot[]
  bounds: { x0: number; z0: number; x1: number; z1: number }
}

const MINE_REGION = 8   // chunks per mineshaft region
const VILLAGE_REGION = 16

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
  private special: SimplexNoise
  private colCache = new Map<number, ColumnInfo>()
  private dungeonCache = new Map<string, DungeonPlan | null>()
  private mineshaftCache = new Map<string, MineshaftPlan | null>()
  private villageCache = new Map<string, VillagePlan | null>()
  private strongholdCache: StrongholdPlan[] | null = null

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
    this.special = new SimplexNoise(s ^ 0xb000)
  }

  columnInfo(x: number, z: number): ColumnInfo {
    const key = (x + 16384) * 40000 + (z + 16384)
    const cached = this.colCache.get(key)
    if (cached) return cached

    // Broad landmass shape. A higher base and gentler continental amplitude
    // keep oceans as distinct regions instead of covering most seeds.
    const c = fbm2(this.continent, x * 0.0014, z * 0.0014, 4)
    let h = SEA_LEVEL + 9 + c * 19

    // rolling hills
    h += fbm2(this.hills, x * 0.005, z * 0.005, 4) * 7

    // ridged mountain ranges, gated by a slow mask so they form distinct regions
    const mRaw = fbm2(this.mask, x * 0.0011 + 100, z * 0.0011 - 50, 3)
    const mMask = smoothstep(0.18, 0.52, mRaw)
    const ridge = ridged2(this.ridge, x * 0.0024, z * 0.0024, 4)
    // Lower, broader ridges avoid one-column needles while preserving ranges.
    h += ridge * ridge * mMask * 42

    // fine detail
    h += this.detail.noise2(x * 0.024, z * 0.024)

    // Mushroom islands rise from deep-ocean regions on their own slow noise.
    const mushV = fbm2(this.special, x * 0.0016 + 900, z * 0.0016 - 700, 3)
    let mushroomField = false
    if (c < -0.22 && mushV > 0.52) {
      const lift = smoothstep(0.52, 0.8, mushV)
      h = Math.max(h, lerp(SEA_LEVEL - 6, SEA_LEVEL + 7, lift))
      mushroomField = true
    }

    // rivers carve lowlands down to just below sea level
    const rN = Math.abs(fbm2(this.river, x * 0.0011 + 500, z * 0.0011 + 500, 3))
    const riverStrength = smoothstep(0.036, 0.009, rN) * smoothstep(68, 52, h)
    let isRiver = false
    if (riverStrength > 0.01 && !mushroomField) {
      const carved = lerp(h, Math.min(h, SEA_LEVEL - 2.5 - riverStrength * 2), riverStrength)
      if (carved < h) {
        h = carved
        if (h < SEA_LEVEL + 1 && riverStrength > 0.55) isRiver = true
      }
    }

    let height = clamp(Math.round(h), 3, WORLD_HEIGHT - 10)

    // climate
    const t = fbm2(this.temp, x * 0.0007 - 300, z * 0.0007 + 200, 3) - (height - SEA_LEVEL) * 0.006
    const m = fbm2(this.moist, x * 0.0009 + 800, z * 0.0009 - 400, 3)

    let biome: number
    if (mushroomField && height >= SEA_LEVEL - 1) biome = BIOME.MUSHROOM
    else if (height < SEA_LEVEL - 1) biome = BIOME.OCEAN
    else if (isRiver) biome = BIOME.RIVER
    else if (height >= 84 || t < -0.42) biome = BIOME.SNOW
    else if (height >= 68) biome = BIOME.MOUNTAIN
    else if (t > 0.26 && m > 0.24 && height <= SEA_LEVEL + 6) biome = BIOME.SWAMP
    else if (height <= SEA_LEVEL + 1) biome = BIOME.BEACH
    else if (t > 0.4 && m < -0.05) biome = BIOME.DESERT
    else if (t > 0.3 && m > 0.18) biome = BIOME.JUNGLE
    else if (t < -0.18) biome = BIOME.TAIGA
    else if (m > 0.08) biome = BIOME.FOREST
    else biome = BIOME.PLAINS

    // stagnant swamp pools sink chosen flat columns just under the water line
    if (biome === BIOME.SWAMP && height <= SEA_LEVEL + 1) {
      const pool = this.special.noise2(x * 0.045 - 40, z * 0.045 + 60)
      if (pool > 0.3) height = Math.min(height, SEA_LEVEL - 1)
    }

    let treeDensity = 0
    if (biome === BIOME.FOREST) treeDensity = 0.026
    else if (biome === BIOME.PLAINS) treeDensity = 0.0035
    else if (biome === BIOME.SNOW && height < 100) treeDensity = 0.012
    else if (biome === BIOME.MOUNTAIN && height < 80) treeDensity = 0.006
    else if (biome === BIOME.TAIGA) treeDensity = 0.03
    else if (biome === BIOME.SWAMP) treeDensity = 0.012
    else if (biome === BIOME.JUNGLE) treeDensity = 0.05
    else if (biome === BIOME.MUSHROOM) treeDensity = 0.007

    const info: ColumnInfo = { height, biome, treeDensity }
    if (this.colCache.size > 60000) this.colCache.clear()
    this.colCache.set(key, info)
    return info
  }

  heightAt(x: number, z: number): number { return this.columnInfo(x, z).height }
  biomeAt(x: number, z: number): number { return this.columnInfo(x, z).biome }

  /** Deterministic tree (or huge mushroom) lookup for any column, or null. */
  treeAt(x: number, z: number): TreeDef | null {
    const r = hash01(x, z, this.seedNum ^ 0xa53a53)
    const info = this.columnInfo(x, z)
    if (info.treeDensity <= 0 || r >= info.treeDensity) return null
    if (info.height <= SEA_LEVEL) return null
    if (info.biome === BIOME.BEACH || info.biome === BIOME.DESERT || info.biome === BIOME.RIVER) return null
    const h2 = hash2(x, z, this.seedNum ^ 0x77aa)
    let kind: TreeKind
    let height: number
    if (info.biome === BIOME.MUSHROOM) {
      kind = (h2 & 1) === 0 ? 'mushroom_red' : 'mushroom_brown'
      height = 4 + h2 % 3
    } else if (info.biome === BIOME.SNOW || info.biome === BIOME.MOUNTAIN || info.biome === BIOME.TAIGA) {
      kind = 'pine'
      height = 6 + h2 % 4
    } else if (info.biome === BIOME.JUNGLE) {
      kind = 'jungle'
      height = 8 + h2 % 5
    } else if (info.biome === BIOME.SWAMP) {
      kind = 'swamp'
      height = 4 + h2 % 2
    } else {
      kind = 'oak'
      height = 4 + h2 % 3
    }
    return { x, z, baseY: info.height + 1, height, kind }
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
          top = h >= SEA_LEVEL - 3 ? B.SAND : (hash01(wx, wz, seed ^ 0x99) > 0.35 ? B.GRAVEL : B.STONE)
          under = top
        } else if (biome === BIOME.BEACH || biome === BIOME.DESERT) {
          top = B.SAND; under = B.SAND; underDepth = 4
        } else if (biome === BIOME.RIVER) {
          top = B.GRAVEL; under = B.DIRT; underDepth = 3
        } else if (biome === BIOME.SNOW) {
          top = B.SNOW; under = B.DIRT
        } else if (biome === BIOME.MOUNTAIN) {
          top = h > 74 ? B.STONE : B.GRASS
          under = h > 74 ? B.STONE : B.DIRT
        } else if (biome === BIOME.MUSHROOM) {
          top = h < SEA_LEVEL ? B.DIRT : B.MYCELIUM
          under = B.DIRT
        } else if (biome === BIOME.SWAMP) {
          top = h < SEA_LEVEL ? B.DIRT : B.GRASS
          under = B.DIRT
        }
        // gravel patches on grass near water
        if (top === B.GRASS && biome !== BIOME.SWAMP && h <= SEA_LEVEL + 1 && hash01(wx, wz, seed ^ 0x1234) > 0.8) {
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
          // Most tunnels stay underground; rare matching surface samples extend
          // the same noise-carved tunnel outside as a natural cave entrance.
          const surfaceCave1 = Math.abs(this.cave1.noise3(wx * 0.017, h * 0.024, wz * 0.017))
          const surfaceCave2 = Math.abs(this.cave2.noise3(wx * 0.017, h * 0.024, wz * 0.017))
          const opensToSurface = surfaceCave1 < 0.065 && surfaceCave2 < 0.065
          const yTop = Math.min(opensToSurface ? h : h - 7, 90)
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
          const dense = biome === BIOME.JUNGLE ? 0.24
            : biome === BIOME.FOREST ? 0.16
            : biome === BIOME.SWAMP ? 0.14
            : biome === BIOME.PLAINS ? 0.11
            : biome === BIOME.TAIGA ? 0.08
            : 0.04
          if (r < dense) {
            const fernish = (biome === BIOME.JUNGLE || biome === BIOME.TAIGA) && r < dense * 0.5
            blocks[col | (h + 1)] = fernish ? B.FERN : B.TALLGRASS
          } else if (r < dense + 0.014 && (biome === BIOME.PLAINS || biome === BIOME.FOREST)) {
            blocks[col | (h + 1)] = r < dense + 0.007 ? B.FLOWER_Y : B.FLOWER_R
          } else if (r < dense + 0.02 && biome === BIOME.SWAMP) {
            blocks[col | (h + 1)] = r < dense + 0.01 ? B.MUSHROOM_BROWN : B.MUSHROOM_RED
          }
        }

        // small mushrooms scattered over mycelium
        if (top === B.MYCELIUM && h + 1 < WORLD_HEIGHT && blocks[col | h] === B.MYCELIUM) {
          const r = hash01(wx, wz, seed ^ 0x517005)
          if (r < 0.045) blocks[col | (h + 1)] = r < 0.022 ? B.MUSHROOM_RED : B.MUSHROOM_BROWN
        }

        // Renewable stage-6 resources: reeds on wet banks and rare mushrooms
        // on cave floors. Placement is deterministic for a given world seed.
        if ((top === B.GRASS || top === B.SAND) && h === SEA_LEVEL &&
          blocks[col | (h + 1)] === B.AIR) {
          // Water is filled only through SEA_LEVEL. A mere height drop next to
          // a Y=SEA_LEVEL+1 bank therefore is not water at the cane support
          // level and used to produce cane that broke on its first random tick.
          const wetBank = this.columnInfo(wx + 1, wz).height < SEA_LEVEL ||
            this.columnInfo(wx - 1, wz).height < SEA_LEVEL ||
            this.columnInfo(wx, wz + 1).height < SEA_LEVEL ||
            this.columnInfo(wx, wz - 1).height < SEA_LEVEL
          const caneChance = biome === BIOME.SWAMP ? 0.16 : 0.08
          if (wetBank && hash01(wx, wz, seed ^ 0x5ca1e) < caneChance) {
            const height = 1 + hash2(wx, wz, seed ^ 0xc4ae) % 3
            for (let dy = 1; dy <= height && h + dy < WORLD_HEIGHT; dy++) blocks[col | (h + dy)] = B.SUGARCANE
          }
        }

        if (h >= SEA_LEVEL + 2) {
          for (let y = 6; y < h - 7; y++) {
            if (blocks[col | y] !== B.AIR || blocks[col | (y - 1)] === B.AIR || blocks[col | (y - 1)] === B.WATER) continue
            if (hash2(wx ^ Math.imul(y, 131), wz, seed ^ 0x6d757368) % 3072 === 0) {
              blocks[col | y] = hash2(wx, wz ^ y, seed) & 1 ? B.MUSHROOM_BROWN : B.MUSHROOM_RED
            }
          }
        }

        // Classic deep lava ocean inside caves. Every generated cell is a
        // collectable source; exposed edges begin flowing after a neighbor edit.
        for (let y = 3; y <= 10; y++) {
          if (blocks[col | y] === B.AIR) blocks[col | y] = B.LAVA
        }
      }
    }

    // Deterministic ore veins are stamped after caves so exposed cave walls reveal them.
    this.stampOres(chunk)

    // stamp trees whose canopy may reach into this chunk
    for (let tx = bx - 3; tx < bx + CHUNK_SIZE + 3; tx++) {
      for (let tz = bz - 3; tz < bz + CHUNK_SIZE + 3; tz++) {
        const tree = this.treeAt(tx, tz)
        if (tree) this.stampTree(chunk, tree)
      }
    }

    // structures carve last so their interiors stay clear of terrain and trees
    this.stampStructures(chunk)

    chunk.state = 1
  }

  private stampOres(chunk: Chunk): void {
    // Include neighboring source chunks so veins continue cleanly across chunk borders.
    for (const ore of ORE_DEFS) {
      for (let sourceCx = chunk.cx - 1; sourceCx <= chunk.cx + 1; sourceCx++) {
        for (let sourceCz = chunk.cz - 1; sourceCz <= chunk.cz + 1; sourceCz++) {
          for (let vein = 0; vein < ore.veinsPerChunk; vein++) {
            const veinSeed = hash2(
              sourceCx,
              sourceCz,
              this.seedNum ^ ore.salt ^ Math.imul(vein + 1, 0x9e3779b1)
            )
            const random = mulberry32(veinSeed)
            let x = sourceCx * CHUNK_SIZE + random() * CHUNK_SIZE
            let y = ore.minY + random() * (ore.maxY - ore.minY + 1)
            let z = sourceCz * CHUNK_SIZE + random() * CHUNK_SIZE
            const size = ore.minSize + Math.floor(random() * (ore.maxSize - ore.minSize + 1))

            for (let step = 0; step < size; step++) {
              const radius = (0.62 + random() * 0.68) * ore.radiusScale
              this.stampOreSphere(chunk, ore.id, x, y, z, radius, ore.minY, ore.maxY)
              x += (random() - 0.5) * 1.7
              y = clamp(y + (random() - 0.5) * 1.15, ore.minY, ore.maxY)
              z += (random() - 0.5) * 1.7
            }
          }
        }
      }
    }
  }

  private stampOreSphere(
    chunk: Chunk,
    oreId: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    oreMinY: number,
    oreMaxY: number
  ): void {
    const bx = chunk.cx * CHUNK_SIZE
    const bz = chunk.cz * CHUNK_SIZE
    const minX = Math.max(bx, Math.floor(centerX - radius))
    const maxX = Math.min(bx + CHUNK_SIZE - 1, Math.floor(centerX + radius))
    const minZ = Math.max(bz, Math.floor(centerZ - radius))
    const maxZ = Math.min(bz + CHUNK_SIZE - 1, Math.floor(centerZ + radius))
    const minY = Math.max(oreMinY, Math.floor(centerY - radius))
    const maxY = Math.min(oreMaxY, Math.floor(centerY + radius))
    if (minX > maxX || minZ > maxZ) return

    const radiusSq = radius * radius
    for (let wx = minX; wx <= maxX; wx++) {
      for (let wz = minZ; wz <= maxZ; wz++) {
        for (let y = minY; y <= maxY; y++) {
          const dx = wx + 0.5 - centerX
          const dy = y + 0.5 - centerY
          const dz = wz + 0.5 - centerZ
          if (dx * dx + dy * dy + dz * dz > radiusSq) continue
          const index = Chunk.index(wx - bx, y, wz - bz)
          if (chunk.blocks[index] === B.STONE) chunk.blocks[index] = oreId
        }
      }
    }
  }

  private setInChunk(chunk: Chunk, wx: number, y: number, wz: number, id: number, replaceSolid = false): void {
    const lx = wx - chunk.cx * CHUNK_SIZE
    const lz = wz - chunk.cz * CHUNK_SIZE
    if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return
    const i = (((lx << 4) | lz) << 7) | y
    const cur = chunk.blocks[i]
    if (!replaceSolid && cur !== B.AIR && cur !== B.TALLGRASS && cur !== B.FERN &&
      cur !== B.FLOWER_Y && cur !== B.FLOWER_R) return
    chunk.blocks[i] = id
  }

  private stampTree(chunk: Chunk, tree: TreeDef): void {
    const { x, z, baseY, height, kind } = tree
    const topY = baseY + height

    if (kind === 'pine') {
      const leafId = B.PINELEAVES
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
      for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.PINELOG, true)
      return
    }

    if (kind === 'mushroom_red' || kind === 'mushroom_brown') {
      const capId = kind === 'mushroom_red' ? B.MUSHROOM_CAP_RED : B.MUSHROOM_CAP_BROWN
      const stemTop = baseY + height - 1
      if (kind === 'mushroom_red') {
        // hollow dome: 5x5 skirt ring two layers tall plus a 3x3 top plate
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue
            if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue
            this.setInChunk(chunk, x + dx, stemTop + dy, z + dz, capId)
          }
        }
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          this.setInChunk(chunk, x + dx, stemTop + 1, z + dz, capId)
        }
      } else {
        // flat 7x7 plate with clipped corners
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          if (Math.abs(dx) === 3 && Math.abs(dz) === 3) continue
          this.setInChunk(chunk, x + dx, stemTop + 1, z + dz, capId)
        }
      }
      for (let y = baseY; y <= stemTop; y++) this.setInChunk(chunk, x, y, z, B.MUSHROOM_STEM, true)
      return
    }

    if (kind === 'jungle') {
      const leafId = B.JUNGLE_LEAVES
      // broad two-layer canopy with a small crown
      for (let dy = -1; dy <= 0; dy++) {
        const r = 3
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r) continue
          if (Math.abs(dx) + Math.abs(dz) > r + 1 && hash01(x + dx * 5, z + dz * 11 + dy, this.seedNum ^ 0x77) > 0.5) continue
          this.setInChunk(chunk, x + dx, topY + dy, z + dz, leafId)
        }
      }
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        this.setInChunk(chunk, x + dx, topY + 1, z + dz, leafId)
      }
      for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.JUNGLE_LOG, true)
      return
    }

    if (kind === 'swamp') {
      const leafId = B.LEAVES
      // wide, flat canopy hanging near the water
      for (let dy = -1; dy <= 0; dy++) {
        const r = 3
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r) continue
          if (dy === -1 && Math.abs(dx) < 2 && Math.abs(dz) < 2) continue
          this.setInChunk(chunk, x + dx, topY + dy, z + dz, leafId)
        }
      }
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue
        this.setInChunk(chunk, x + dx, topY + 1, z + dz, leafId)
      }
      for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.LOG, true)
      return
    }

    // oak blob canopy
    for (let dy = -2; dy <= 1; dy++) {
      const y = topY + dy
      const r = dy <= -1 ? 2 : 1
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && hash01(x + dx * 7, z + dz * 13 + y, this.seedNum ^ 0x33) > 0.4) continue
        this.setInChunk(chunk, x + dx, y, z + dz, B.LEAVES)
      }
    }
    for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.LOG, true)
  }

  /* ----------------------------------------------------------------------- */
  /* Structures                                                              */
  /* ----------------------------------------------------------------------- */

  /** Unconditional bounds-checked write used by structure stamping. */
  private put(chunk: Chunk, wx: number, y: number, wz: number, id: number): void {
    const lx = wx - chunk.cx * CHUNK_SIZE
    const lz = wz - chunk.cz * CHUNK_SIZE
    if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 1 || y >= WORLD_HEIGHT) return
    chunk.blocks[(((lx << 4) | lz) << 7) | y] = id
  }

  private getInChunk(chunk: Chunk, wx: number, y: number, wz: number): number {
    const lx = wx - chunk.cx * CHUNK_SIZE
    const lz = wz - chunk.cz * CHUNK_SIZE
    if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR
    return chunk.blocks[(((lx << 4) | lz) << 7) | y]
  }

  private stampStructures(chunk: Chunk): void {
    for (let cx = chunk.cx - 1; cx <= chunk.cx + 1; cx++) {
      for (let cz = chunk.cz - 1; cz <= chunk.cz + 1; cz++) {
        const dungeon = this.dungeonIn(cx, cz)
        if (dungeon) this.stampDungeon(chunk, dungeon)
      }
    }
    const rx = Math.floor(chunk.cx / MINE_REGION), rz = Math.floor(chunk.cz / MINE_REGION)
    for (let mx = rx - 1; mx <= rx + 1; mx++) {
      for (let mz = rz - 1; mz <= rz + 1; mz++) {
        const mine = this.mineshaftIn(mx, mz)
        if (mine) this.stampMineshaft(chunk, mine)
      }
    }
    const bx = chunk.cx * CHUNK_SIZE, bz = chunk.cz * CHUNK_SIZE
    for (const hold of this.strongholds()) {
      if (hold.bounds.x1 < bx - 1 || hold.bounds.x0 > bx + CHUNK_SIZE ||
        hold.bounds.z1 < bz - 1 || hold.bounds.z0 > bz + CHUNK_SIZE) continue
      this.stampStronghold(chunk, hold)
    }
    const vx = Math.floor(chunk.cx / VILLAGE_REGION), vz = Math.floor(chunk.cz / VILLAGE_REGION)
    for (let ax = vx - 1; ax <= vx + 1; ax++) {
      for (let az = vz - 1; az <= vz + 1; az++) {
        const village = this.villageIn(ax, az)
        if (village) this.stampVillage(chunk, village)
      }
    }
  }

  /* --- dungeons --- */

  dungeonIn(cx: number, cz: number): DungeonPlan | null {
    const key = cx + ',' + cz
    const cached = this.dungeonCache.get(key)
    if (cached !== undefined) return cached
    const plan = this.computeDungeon(cx, cz)
    if (this.dungeonCache.size > 4096) this.dungeonCache.clear()
    this.dungeonCache.set(key, plan)
    return plan
  }

  private computeDungeon(cx: number, cz: number): DungeonPlan | null {
    const roll = hash2(cx, cz, this.seedNum ^ 0xd06e07)
    if (roll % 100 >= 7) return null
    const rand = mulberry32(roll ^ 0x9e3779b1)
    const w = rand() < 0.5 ? 7 : 9
    const d = rand() < 0.5 ? 7 : 9
    const x0 = cx * CHUNK_SIZE + 1 + Math.floor(rand() * (CHUNK_SIZE - w - 2))
    const z0 = cz * CHUNK_SIZE + 1 + Math.floor(rand() * (CHUNK_SIZE - d - 2))
    const centerX = x0 + (w >> 1), centerZ = z0 + (d >> 1)
    const surface = this.columnInfo(centerX, centerZ).height
    const maxFloor = Math.min(38, surface - 10)
    if (maxFloor < 12) return null
    const floorY = 12 + Math.floor(rand() * (maxFloor - 12 + 1))
    const mobRoll = rand()
    const mob: StructureMob = mobRoll < 0.5 ? 'zombie' : mobRoll < 0.75 ? 'skeleton' : 'spider'
    const chests: StructureChest[] = []
    const chestCount = 1 + (rand() < 0.35 ? 1 : 0)
    for (let i = 0; i < chestCount; i++) {
      // floor cells hugging a wall, away from the spawner
      const side = Math.floor(rand() * 4)
      const alongW = side < 2
      const t = 1 + Math.floor(rand() * ((alongW ? w : d) - 2))
      const x = alongW ? x0 + t : side === 2 ? x0 + 1 : x0 + w - 2
      const z = alongW ? (side === 0 ? z0 + 1 : z0 + d - 2) : z0 + t
      if (x === centerX && z === centerZ) continue
      chests.push({ x, y: floorY, z, loot: 'dungeon' })
    }
    return {
      x0, z0, w, d, floorY, mob,
      spawner: { x: centerX, y: floorY, z: centerZ, mob },
      chests
    }
  }

  private stampDungeon(chunk: Chunk, plan: DungeonPlan): void {
    const { x0, z0, w, d, floorY } = plan
    const seed = this.seedNum
    for (let x = x0; x < x0 + w; x++) {
      for (let z = z0; z < z0 + d; z++) {
        const wall = x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + d - 1
        const mossy = hash2(x, z, seed ^ 0x9055) % 4 !== 0
        this.put(chunk, x, floorY - 1, z, mossy ? B.MOSSY_COBBLESTONE : B.COBBLESTONE)
        for (let y = floorY; y <= floorY + 2; y++) {
          if (wall) {
            const existing = this.getInChunk(chunk, x, y, z)
            // keep cave openings so dungeons connect to the tunnels that found them
            if (existing !== B.AIR) this.put(chunk, x, y, z, hash2(x ^ y, z, seed ^ 0xd41) % 4 === 0 ? B.MOSSY_COBBLESTONE : B.COBBLESTONE)
          } else {
            this.put(chunk, x, y, z, B.AIR)
          }
        }
        this.put(chunk, x, floorY + 3, z, B.COBBLESTONE)
      }
    }
    this.put(chunk, plan.spawner.x, plan.spawner.y, plan.spawner.z, B.SPAWNER)
    for (const chest of plan.chests) this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
  }

  /* --- mineshafts --- */

  mineshaftIn(rx: number, rz: number): MineshaftPlan | null {
    const key = rx + ',' + rz
    const cached = this.mineshaftCache.get(key)
    if (cached !== undefined) return cached
    const plan = this.computeMineshaft(rx, rz)
    if (this.mineshaftCache.size > 512) this.mineshaftCache.clear()
    this.mineshaftCache.set(key, plan)
    return plan
  }

  private computeMineshaft(rx: number, rz: number): MineshaftPlan | null {
    const roll = hash2(rx, rz, this.seedNum ^ 0x315e5e)
    if (roll % 100 >= 32) return null
    const rand = mulberry32(roll ^ 0x51ce)
    const base = MINE_REGION * CHUNK_SIZE
    const segments: MineSegment[] = []
    const chests: StructureChest[] = []
    let endpoints: { x: number; z: number; y: number; lastAxis: 'x' | 'z' | null }[] = [{
      x: rx * base + 24 + Math.floor(rand() * (base - 48)),
      z: rz * base + 24 + Math.floor(rand() * (base - 48)),
      y: 16 + Math.floor(rand() * 12),
      lastAxis: null
    }]
    const segmentCount = 8 + Math.floor(rand() * 7)
    for (let i = 0; i < segmentCount && endpoints.length > 0; i++) {
      const from = endpoints[Math.floor(rand() * endpoints.length)]
      const axis: 'x' | 'z' = from.lastAxis === 'x' ? 'z' : from.lastAxis === 'z' ? 'x' : (rand() < 0.5 ? 'x' : 'z')
      const dir = rand() < 0.5 ? 1 : -1
      const length = 12 + Math.floor(rand() * 20)
      const y = clamp(from.y + (Math.floor(rand() * 5) - 2), 12, 34)
      const x1 = axis === 'x' ? from.x + dir * length : from.x
      const z1 = axis === 'z' ? from.z + dir * length : from.z
      segments.push({
        x0: Math.min(from.x, x1), x1: Math.max(from.x, x1),
        z0: Math.min(from.z, z1), z1: Math.max(from.z, z1),
        y, axis, rails: rand() < 0.6
      })
      if (rand() < 0.22) {
        const t = rand()
        chests.push({
          x: axis === 'x' ? Math.round(lerp(from.x, x1, t)) : from.x + (rand() < 0.5 ? 1 : -1),
          y,
          z: axis === 'z' ? Math.round(lerp(from.z, z1, t)) : from.z + (rand() < 0.5 ? 1 : -1),
          loot: 'mineshaft'
        })
      }
      const next = { x: x1, z: z1, y, lastAxis: axis }
      if (rand() < 0.68) endpoints = [next]
      else endpoints.push(next)
    }
    return { segments, chests }
  }

  private stampMineshaft(chunk: Chunk, plan: MineshaftPlan): void {
    const bx = chunk.cx * CHUNK_SIZE, bz = chunk.cz * CHUNK_SIZE
    const seed = this.seedNum
    for (const seg of plan.segments) {
      const half = 1
      const minX = Math.max(bx, seg.x0 - (seg.axis === 'z' ? half : 0))
      const maxX = Math.min(bx + CHUNK_SIZE - 1, seg.x1 + (seg.axis === 'z' ? half : 0))
      const minZ = Math.max(bz, seg.z0 - (seg.axis === 'x' ? half : 0))
      const maxZ = Math.min(bz + CHUNK_SIZE - 1, seg.z1 + (seg.axis === 'x' ? half : 0))
      if (minX > maxX || minZ > maxZ) continue
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const along = seg.axis === 'x' ? x : z
          const offset = seg.axis === 'x' ? z - (seg.z0) : x - (seg.x0)
          // interior air
          for (let y = seg.y; y <= seg.y + 2; y++) this.put(chunk, x, y, z, B.AIR)
          // patchy plank floor over holes and stone
          const floorId = this.getInChunk(chunk, x, seg.y - 1, z)
          if (floorId === B.AIR || hash2(x, z, seed ^ 0xf10a) % 3 === 0) {
            this.put(chunk, x, seg.y - 1, z, B.PLANKS)
          }
          // support frames every 4 blocks: side posts plus a beam overhead
          if (along % 4 === 0) {
            if (offset === -1 || offset === 1) {
              this.put(chunk, x, seg.y, z, B.PLANKS)
              this.put(chunk, x, seg.y + 1, z, B.PLANKS)
            }
            this.put(chunk, x, seg.y + 2, z, B.PLANKS)
          }
          // rails along the center line
          if (seg.rails && offset === 0 && along % 4 !== 0 && hash2(x, z, seed ^ 0x8a11) % 5 !== 0) {
            this.put(chunk, x, seg.y, z, B.RAIL)
          }
        }
      }
    }
    for (const chest of plan.chests) {
      const lx = chest.x - bx, lz = chest.z - bz
      if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE) continue
      this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
      const below = this.getInChunk(chunk, chest.x, chest.y - 1, chest.z)
      if (below === B.AIR) this.put(chunk, chest.x, chest.y - 1, chest.z, B.PLANKS)
    }
  }

  /* --- strongholds --- */

  strongholds(): StrongholdPlan[] {
    if (this.strongholdCache) return this.strongholdCache
    const plans: StrongholdPlan[] = []
    const baseAngle = (this.seedNum % 628) / 100
    for (let i = 0; i < 3; i++) {
      const rand = mulberry32(this.seedNum ^ Math.imul(i + 1, 0x9e3779b1))
      const angle = baseAngle + i * (Math.PI * 2 / 3) + (rand() - 0.5) * 0.6
      const dist = 560 + rand() * 480
      const ox = Math.round(Math.cos(angle) * dist)
      const oz = Math.round(Math.sin(angle) * dist)
      plans.push(this.computeStronghold(ox, oz, rand))
    }
    this.strongholdCache = plans
    return plans
  }

  private computeStronghold(ox: number, oz: number, rand: () => number): StrongholdPlan {
    const y = 18
    const rooms: StrongholdRoom[] = []
    const openings: StrongholdRoom[] = []
    const bookshelves: { x: number; y: number; z: number }[] = []
    const chests: StructureChest[] = []

    // central corridor running +X
    const corridor: StrongholdRoom = { x0: ox, z0: oz - 1, x1: ox + 34, z1: oz + 1, y, height: 4 }
    rooms.push(corridor)

    // storage room, -Z side
    const storage: StrongholdRoom = { x0: ox + 4, z0: oz - 9, x1: ox + 10, z1: oz - 2, y, height: 4 }
    rooms.push(storage)
    openings.push({ x0: ox + 6, z0: oz - 2, x1: ox + 7, z1: oz - 1, y, height: 3 })
    chests.push({ x: ox + 5, y, z: oz - 8, loot: 'stronghold_storage' })
    chests.push({ x: ox + 9, y, z: oz - 8, loot: 'stronghold_storage' })

    // library, +Z side
    const library: StrongholdRoom = { x0: ox + 12, z0: oz + 2, x1: ox + 22, z1: oz + 10, y, height: 5 }
    rooms.push(library)
    openings.push({ x0: ox + 16, z0: oz + 1, x1: ox + 17, z1: oz + 2, y, height: 3 })
    for (let x = ox + 13; x <= ox + 21; x += 2) {
      for (let z = oz + 4; z <= oz + 9; z++) {
        if (z === oz + 6 || z === oz + 7) continue
        for (let dy = 0; dy < 3; dy++) bookshelves.push({ x, y: y + dy, z })
      }
    }
    chests.push({ x: ox + 13, y, z: oz + 3, loot: 'stronghold_library' })
    chests.push({ x: ox + 21, y, z: oz + 3, loot: 'stronghold_library' })

    // portal room at the corridor's far end
    const portal: StrongholdRoom = { x0: ox + 24, z0: oz - 5, x1: ox + 34, z1: oz + 5, y, height: 6 }
    rooms.push(portal)
    const frameX = ox + 29, frameZ = oz
    const framePositions: { x: number; y: number; z: number }[] = []
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2
        if (!edge || (Math.abs(dx) === 2 && Math.abs(dz) === 2)) continue
        framePositions.push({ x: frameX + dx, y: y + 1, z: frameZ + dz })
      }
    }
    const spawner: StructureSpawner = { x: ox + 25, y, z: oz, mob: 'zombie' }

    const bounds = { x0: ox - 1, z0: oz - 10, x1: ox + 35, z1: oz + 11 }
    return { rooms, openings, bookshelves, framePositions, spawner, chests, bounds }
  }

  private strongholdWall(x: number, y: number, z: number): number {
    const roll = hash2(x ^ Math.imul(y, 977), z, this.seedNum ^ 0x570e) % 20
    if (roll < 3) return B.STONE_BRICK_MOSSY
    if (roll < 6) return B.STONE_BRICK_CRACKED
    return B.STONE_BRICK
  }

  private stampStronghold(chunk: Chunk, plan: StrongholdPlan): void {
    for (const room of plan.rooms) {
      for (let x = room.x0; x <= room.x1; x++) {
        for (let z = room.z0; z <= room.z1; z++) {
          const wall = x === room.x0 || x === room.x1 || z === room.z0 || z === room.z1
          this.put(chunk, x, room.y - 1, z, this.strongholdWall(x, room.y - 1, z))
          for (let y = room.y; y < room.y + room.height - 1; y++) {
            this.put(chunk, x, y, z, wall ? this.strongholdWall(x, y, z) : B.AIR)
          }
          this.put(chunk, x, room.y + room.height - 1, z, this.strongholdWall(x, room.y + room.height - 1, z))
        }
      }
    }
    for (const gap of plan.openings) {
      for (let x = gap.x0; x <= gap.x1; x++) {
        for (let z = gap.z0; z <= gap.z1; z++) {
          for (let y = gap.y; y < gap.y + gap.height; y++) this.put(chunk, x, y, z, B.AIR)
        }
      }
    }
    for (const shelf of plan.bookshelves) this.put(chunk, shelf.x, shelf.y, shelf.z, B.BOOKSHELF)
    for (const frame of plan.framePositions) this.put(chunk, frame.x, frame.y, frame.z, B.END_PORTAL_FRAME)
    this.put(chunk, plan.spawner.x, plan.spawner.y, plan.spawner.z, B.SPAWNER)
    for (const chest of plan.chests) this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
    // a torch by each doorway keeps the entry readable
    for (const gap of plan.openings) this.put(chunk, gap.x0, gap.y + 2, gap.z0, B.TORCH)
  }

  /* --- villages --- */

  villageIn(rx: number, rz: number): VillagePlan | null {
    const key = rx + ',' + rz
    const cached = this.villageCache.get(key)
    if (cached !== undefined) return cached
    const plan = this.computeVillage(rx, rz)
    if (this.villageCache.size > 256) this.villageCache.clear()
    this.villageCache.set(key, plan)
    return plan
  }

  private computeVillage(rx: number, rz: number): VillagePlan | null {
    const roll = hash2(rx, rz, this.seedNum ^ 0x71a63)
    if (roll % 100 >= 24) return null
    return this.computeVillageAt(rx, rz, mulberry32(roll ^ 0x7a11))
  }

  private computeVillageAt(rx: number, rz: number, rand: () => number): VillagePlan | null {
    const base = VILLAGE_REGION * CHUNK_SIZE
    const centerX = rx * base + 64 + Math.floor(rand() * (base - 128))
    const centerZ = rz * base + 64 + Math.floor(rand() * (base - 128))
    const info = this.columnInfo(centerX, centerZ)
    if (info.biome !== BIOME.PLAINS && info.biome !== BIOME.DESERT) return null
    if (info.height < SEA_LEVEL + 2 || info.height > SEA_LEVEL + 24) return null
    const desert = info.biome === BIOME.DESERT

    const buildings: VillageBuilding[] = [{
      kind: 'well', cx: centerX, cz: centerZ, groundY: info.height, facing: 4
    }]
    const chests: StructureChest[] = []
    const villagers: VillagerSpot[] = []
    const kinds: VillageBuilding['kind'][] = ['house', 'large_house', 'farm', 'house', 'farm', 'house', 'house']
    const count = 4 + Math.floor(rand() * 3)
    let placed = 0
    const dirOrder = [0, 2, 4, 6, 1, 3, 5, 7]
    for (const d of dirOrder) {
      if (placed >= count) break
      const angle = d * Math.PI / 4 + (rand() - 0.5) * 0.4
      const dist = 11 + rand() * 12
      const bxc = Math.round(centerX + Math.cos(angle) * dist)
      const bzc = Math.round(centerZ + Math.sin(angle) * dist)
      const ground = this.columnInfo(bxc, bzc)
      if (Math.abs(ground.height - info.height) > 6) continue
      if (ground.biome === BIOME.OCEAN || ground.biome === BIOME.RIVER || ground.height <= SEA_LEVEL) continue
      const kind = kinds[placed % kinds.length]
      // door faces back toward the well
      const dx = centerX - bxc, dz = centerZ - bzc
      const facing: 0 | 1 | 4 | 5 = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 0 : 1) : (dz > 0 ? 4 : 5)
      buildings.push({ kind, cx: bxc, cz: bzc, groundY: ground.height, facing })
      if (kind === 'large_house' || (kind === 'house' && placed === 0)) {
        chests.push({ x: bxc + 1, y: ground.height + 1, z: bzc + 1, loot: 'village_house' })
      }
      if (kind !== 'farm') {
        villagers.push({ x: bxc, y: ground.height + 2, z: bzc })
      }
      placed++
    }
    if (placed < 3) return null
    villagers.push({ x: centerX + 2, y: info.height + 2, z: centerZ })

    const bounds = {
      x0: centerX - 30, z0: centerZ - 30, x1: centerX + 30, z1: centerZ + 30
    }
    return { centerX, centerZ, desert, buildings, chests, villagers, bounds }
  }

  private stampVillage(chunk: Chunk, plan: VillagePlan): void {
    for (const building of plan.buildings) {
      if (building.kind === 'well') this.stampWell(chunk, plan, building)
      else if (building.kind === 'farm') this.stampFarm(chunk, plan, building)
      else this.stampHouse(chunk, plan, building)
    }
    for (const chest of plan.chests) {
      const lx = chest.x - chunk.cx * CHUNK_SIZE, lz = chest.z - chunk.cz * CHUNK_SIZE
      if (lx >= 0 && lz >= 0 && lx < CHUNK_SIZE && lz < CHUNK_SIZE) {
        this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
      }
    }
  }

  private stampWell(chunk: Chunk, plan: VillagePlan, well: VillageBuilding): void {
    const { cx, cz, groundY } = well
    const wallId = plan.desert ? B.SANDSTONE : B.COBBLESTONE
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (let z = cz - 2; z <= cz + 2; z++) {
        const edge = Math.abs(x - cx) === 2 || Math.abs(z - cz) === 2
        // clear above the well
        for (let y = groundY + 1; y <= groundY + 4; y++) this.put(chunk, x, y, z, B.AIR)
        if (edge) {
          this.put(chunk, x, groundY, z, wallId)
          this.put(chunk, x, groundY + 1, z, wallId)
        } else {
          // water column down a few blocks
          this.put(chunk, x, groundY, z, B.WATER)
          this.put(chunk, x, groundY - 1, z, B.WATER)
          this.put(chunk, x, groundY - 2, z, wallId)
        }
      }
    }
    // corner posts and a slab roof over the well
    for (const [dx, dz] of [[-2, -2], [-2, 2], [2, -2], [2, 2]] as const) {
      this.put(chunk, cx + dx, groundY + 2, cz + dz, wallId)
      this.put(chunk, cx + dx, groundY + 3, cz + dz, wallId)
    }
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (let z = cz - 2; z <= cz + 2; z++) this.put(chunk, x, groundY + 4, z, wallId)
    }
  }

  private stampHouse(chunk: Chunk, plan: VillagePlan, house: VillageBuilding): void {
    const large = house.kind === 'large_house'
    const halfW = large ? 3 : 2
    const halfD = large ? 2 : 2
    const height = 4
    const { cx, cz, groundY, facing } = house
    const wallId = plan.desert ? B.SANDSTONE : B.PLANKS
    const cornerId = plan.desert ? B.SANDSTONE : B.LOG
    const floorId = plan.desert ? B.SANDSTONE : B.COBBLESTONE
    const roofId = plan.desert ? B.SANDSTONE : B.PLANKS
    const x0 = cx - halfW, x1 = cx + halfW, z0 = cz - halfD, z1 = cz + halfD
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        // foundation down to the terrain plus a floor
        for (let y = groundY - 2; y <= groundY; y++) {
          if (this.getInChunk(chunk, x, y, z) === B.AIR) this.put(chunk, x, y, z, floorId)
        }
        this.put(chunk, x, groundY, z, floorId)
        const corner = (x === x0 || x === x1) && (z === z0 || z === z1)
        const wall = x === x0 || x === x1 || z === z0 || z === z1
        for (let y = groundY + 1; y <= groundY + height - 1; y++) {
          this.put(chunk, x, y, z, corner ? cornerId : wall ? wallId : B.AIR)
        }
        this.put(chunk, x, groundY + height, z, roofId)
        // clear a little sky above the roof so trees/terrain don't cap the house
        for (let y = groundY + height + 1; y <= groundY + height + 2; y++) {
          this.put(chunk, x, y, z, B.AIR)
        }
      }
    }
    // door opening in the facing wall
    const doorX = facing === 0 ? x1 : facing === 1 ? x0 : cx
    const doorZ = facing === 4 ? z1 : facing === 5 ? z0 : cz
    this.put(chunk, doorX, groundY + 1, doorZ, B.AIR)
    this.put(chunk, doorX, groundY + 2, doorZ, B.AIR)
    // window holes with glass on the two side walls
    if (facing === 0 || facing === 1) {
      this.put(chunk, cx, groundY + 2, z0, B.GLASS)
      this.put(chunk, cx, groundY + 2, z1, B.GLASS)
    } else {
      this.put(chunk, x0, groundY + 2, cz, B.GLASS)
      this.put(chunk, x1, groundY + 2, cz, B.GLASS)
    }
    // torch inside on the back wall
    const backX = facing === 0 ? x0 + 1 : facing === 1 ? x1 - 1 : cx
    const backZ = facing === 4 ? z0 + 1 : facing === 5 ? z1 - 1 : cz
    this.put(chunk, backX, groundY + 2, backZ, B.TORCH)
  }

  private stampFarm(chunk: Chunk, plan: VillagePlan, farm: VillageBuilding): void {
    const { cx, cz, groundY } = farm
    const borderId = B.LOG
    for (let x = cx - 3; x <= cx + 3; x++) {
      for (let z = cz - 2; z <= cz + 2; z++) {
        for (let y = groundY + 1; y <= groundY + 3; y++) this.put(chunk, x, y, z, B.AIR)
        const edge = Math.abs(x - cx) === 3 || Math.abs(z - cz) === 2
        if (edge) {
          this.put(chunk, x, groundY, z, borderId)
        } else if (x === cx) {
          this.put(chunk, x, groundY, z, B.WATER)
        } else {
          this.put(chunk, x, groundY, z, B.FARMLAND_WET)
          const stage = hash2(x, z, this.seedNum ^ 0xfa53) % 8
          this.put(chunk, x, groundY + 1, z, B.WHEAT_0 + stage)
        }
      }
    }
  }

  /* --- structure queries for gameplay glue --- */

  /** All structure chests whose position lies inside the given chunk. */
  structureChestsIn(cx: number, cz: number): StructureChest[] {
    const bx = cx * CHUNK_SIZE, bz = cz * CHUNK_SIZE
    const inside = (p: { x: number; z: number }) =>
      p.x >= bx && p.x < bx + CHUNK_SIZE && p.z >= bz && p.z < bz + CHUNK_SIZE
    const out: StructureChest[] = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const dungeon = this.dungeonIn(cx + dx, cz + dz)
        if (dungeon) for (const chest of dungeon.chests) if (inside(chest)) out.push(chest)
      }
    }
    const rx = Math.floor(cx / MINE_REGION), rz = Math.floor(cz / MINE_REGION)
    for (let mx = rx - 1; mx <= rx + 1; mx++) {
      for (let mz = rz - 1; mz <= rz + 1; mz++) {
        const mine = this.mineshaftIn(mx, mz)
        if (mine) for (const chest of mine.chests) if (inside(chest)) out.push(chest)
      }
    }
    for (const hold of this.strongholds()) {
      for (const chest of hold.chests) if (inside(chest)) out.push(chest)
    }
    const vx = Math.floor(cx / VILLAGE_REGION), vz = Math.floor(cz / VILLAGE_REGION)
    for (let ax = vx - 1; ax <= vx + 1; ax++) {
      for (let az = vz - 1; az <= vz + 1; az++) {
        const village = this.villageIn(ax, az)
        if (village) for (const chest of village.chests) if (inside(chest)) out.push(chest)
      }
    }
    return out
  }

  /** Structure spawners within a radius of a world position. */
  structureSpawnersNear(x: number, z: number, radius: number): StructureSpawner[] {
    const out: StructureSpawner[] = []
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const chunkR = Math.ceil(radius / CHUNK_SIZE) + 1
    for (let dx = -chunkR; dx <= chunkR; dx++) {
      for (let dz = -chunkR; dz <= chunkR; dz++) {
        const dungeon = this.dungeonIn(cx + dx, cz + dz)
        if (dungeon && Math.hypot(dungeon.spawner.x - x, dungeon.spawner.z - z) <= radius) {
          out.push(dungeon.spawner)
        }
      }
    }
    for (const hold of this.strongholds()) {
      if (Math.hypot(hold.spawner.x - x, hold.spawner.z - z) <= radius) out.push(hold.spawner)
    }
    return out
  }

  /** Villager spawn points inside a chunk (used once per fresh world chunk). */
  villagerSpawnsIn(cx: number, cz: number): VillagerSpot[] {
    const bx = cx * CHUNK_SIZE, bz = cz * CHUNK_SIZE
    const out: VillagerSpot[] = []
    const vx = Math.floor(cx / VILLAGE_REGION), vz = Math.floor(cz / VILLAGE_REGION)
    for (let ax = vx - 1; ax <= vx + 1; ax++) {
      for (let az = vz - 1; az <= vz + 1; az++) {
        const village = this.villageIn(ax, az)
        if (!village) continue
        for (const spot of village.villagers) {
          if (spot.x >= bx && spot.x < bx + CHUNK_SIZE && spot.z >= bz && spot.z < bz + CHUNK_SIZE) out.push(spot)
        }
      }
    }
    return out
  }

  /** Nearest stronghold center, for the future Eye of Ender and debugging. */
  nearestStronghold(x: number, z: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null
    let bestDist = Infinity
    for (const hold of this.strongholds()) {
      const hx = (hold.bounds.x0 + hold.bounds.x1) / 2
      const hz = (hold.bounds.z0 + hold.bounds.z1) / 2
      const d = Math.hypot(hx - x, hz - z)
      if (d < bestDist) { bestDist = d; best = { x: Math.round(hx), z: Math.round(hz) } }
    }
    return best
  }

  /** Find a scenic spawn: elevated grass with water visible nearby. */
  findSpawn(): { x: number, z: number, yaw: number } {
    let best: { x: number, z: number, yaw: number, score: number } | null = null
    for (let i = 0; i < 260; i++) {
      const x = Math.round((hash01(i, 17, this.seedNum ^ 0xf00d) - 0.5) * 900)
      const z = Math.round((hash01(i, 71, this.seedNum ^ 0xbeef) - 0.5) * 900)
      const info = this.columnInfo(x, z)
      if (info.height < SEA_LEVEL + 6 || info.height > 88) continue
      if (info.biome === BIOME.DESERT || info.biome === BIOME.OCEAN || info.biome === BIOME.RIVER ||
        info.biome === BIOME.SWAMP || info.biome === BIOME.MUSHROOM) continue
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
      // a nearby village makes the friendliest possible start
      const vx = Math.floor(Math.floor(x / CHUNK_SIZE) / VILLAGE_REGION)
      const vz = Math.floor(Math.floor(z / CHUNK_SIZE) / VILLAGE_REGION)
      let villageBonus = 0
      for (let ax = vx - 1; ax <= vx + 1 && villageBonus === 0; ax++) {
        for (let az = vz - 1; az <= vz + 1; az++) {
          const village = this.villageIn(ax, az)
          if (village && Math.hypot(village.centerX - x, village.centerZ - z) < 160) {
            villageBonus = 6
            break
          }
        }
      }
      const score = bestDirScore
        + villageBonus
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
