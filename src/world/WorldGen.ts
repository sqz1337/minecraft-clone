import { SimplexNoise, fbm2, ridged2 } from '../util/Noise'
import { xmur3, hash01, hash2, mulberry32, clamp, lerp, smoothstep } from '../util/math'
import { B, SOLID } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { MapCarvers, type CarverBaseSampler } from './MapCarvers'
import { BiomeDecorator } from './BiomeDecorator'
import { OreGenerator } from './OreGenerator'
import { DensityTerrain, DENSITY_SEA_LEVEL } from './DensityTerrain'
import { BIOME, BIOME_NAMES, GRASS_TINT } from './Biomes'
import {
  StructureIndex,
  type DungeonPlan,
  type MineshaftPlan,
  type StrongholdPlan,
  type StructureChest,
  type StructurePlan,
  type StructureSpawner,
  type VillageInfo,
  type VillagePlan,
  type VillagerSpot
} from './structures/StructureIndex'
import { VILLAGE_SPACING } from './structures/Generators'

export type {
  StructureMob,
  StructureChest,
  StructureSpawner,
  VillageDoorSpot,
  VillageInfo,
  VillagerSpot
} from './structures/Types'

/** Sea level of current (v3+) worlds. Historical generators keep Y=40 internally. */
export const SEA_LEVEL = DENSITY_SEA_LEVEL
const LEGACY_SEA_LEVEL = 40
export const CURRENT_WORLD_GEN_VERSION = 3
export type WorldGenVersion = 1 | 2 | 3

export { BIOME, BIOME_NAMES, GRASS_TINT } from './Biomes'

const JAVA_RANDOM_MULTIPLIER = 0x5deece66dn
const JAVA_RANDOM_ADDEND = 0xbn
const JAVA_RANDOM_MASK = (1n << 48n) - 1n
const SLIME_CHUNK_SALT = 0x3ad8025fn

/** Java Random.nextInt(10), including the (extremely rare) rejection branch. */
function javaRandomNextInt10(seed: bigint): number {
  let state = (seed ^ JAVA_RANDOM_MULTIPLIER) & JAVA_RANDOM_MASK
  for (;;) {
    state = (state * JAVA_RANDOM_MULTIPLIER + JAVA_RANDOM_ADDEND) & JAVA_RANDOM_MASK
    const bits = Number(state >> 17n)
    const value = bits % 10
    // Java evaluates this addition as a signed 32-bit int.
    if (bits - value + 9 <= 0x7fffffff) return value
  }
}

/** Minecraft 1.2.x slime-chunk predicate, adapted to Realmcraft's 32-bit seed. */
export function isSlimeChunkForSeed(seedNum: number, cx: number, cz: number): boolean {
  const x = cx | 0, z = cz | 0
  const mixed = BigInt(seedNum >>> 0) +
    BigInt(Math.imul(Math.imul(x, x), 0x4c1906)) +
    BigInt(Math.imul(x, 0x5ac0db)) +
    BigInt(Math.imul(z, z)) * 0x4307a7n +
    BigInt(Math.imul(z, 0x5f24f))
  return javaRandomNextInt10(mixed ^ SLIME_CHUNK_SALT) === 0
}

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
export class WorldGen implements CarverBaseSampler {
  readonly seedNum: number
  readonly seedStr: string
  readonly generatorVersion: WorldGenVersion
  readonly seaLevel: number
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
  private carvers: MapCarvers
  private oreGenerator: OreGenerator
  private biomeDecorator: BiomeDecorator
  private densityTerrain: DensityTerrain
  private structureIndex: StructureIndex
  private structureTerrainCache = new Map<string, Uint8Array>()
  private colCache = new Map<string, ColumnInfo>()

  constructor(seedStr: string, generatorVersion: WorldGenVersion = CURRENT_WORLD_GEN_VERSION) {
    this.seedStr = seedStr
    this.generatorVersion = generatorVersion
    this.seaLevel = generatorVersion >= 3 ? SEA_LEVEL : LEGACY_SEA_LEVEL
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
    this.carvers = new MapCarvers(s)
    this.oreGenerator = new OreGenerator(s)
    this.biomeDecorator = new BiomeDecorator(s)
    this.densityTerrain = new DensityTerrain(s)
    this.structureIndex = new StructureIndex(s, this)
  }

  columnInfo(x: number, z: number): ColumnInfo {
    if (this.generatorVersion >= 3) {
      const info = this.densityTerrain.columnInfo(x, z)
      return { height: info.height, biome: info.biome, treeDensity: this.treeDensityForBiome(info.biome, info.height) }
    }
    // A packed numeric key collided at (x,z) and (x+1,z-40000), making distant
    // generation depend on access order. World-coordinate strings are exact.
    const key = `${x},${z}`
    const cached = this.colCache.get(key)
    if (cached) return cached

    // Broad landmass shape. A higher base and gentler continental amplitude
    // keep oceans as distinct regions instead of covering most seeds.
    const c = fbm2(this.continent, x * 0.0014, z * 0.0014, 4)
    let h = this.seaLevel + 9 + c * 19

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
      h = Math.max(h, lerp(this.seaLevel - 6, this.seaLevel + 7, lift))
      mushroomField = true
    }

    // rivers carve lowlands down to just below sea level
    const rN = Math.abs(fbm2(this.river, x * 0.0011 + 500, z * 0.0011 + 500, 3))
    const riverStrength = smoothstep(0.036, 0.009, rN) * smoothstep(68, 52, h)
    let isRiver = false
    if (riverStrength > 0.01 && !mushroomField) {
      const carved = lerp(h, Math.min(h, this.seaLevel - 2.5 - riverStrength * 2), riverStrength)
      if (carved < h) {
        h = carved
        if (h < this.seaLevel + 1 && riverStrength > 0.55) isRiver = true
      }
    }

    let height = clamp(Math.round(h), 3, WORLD_HEIGHT - 10)

    // climate
    const t = fbm2(this.temp, x * 0.0007 - 300, z * 0.0007 + 200, 3) - (height - this.seaLevel) * 0.006
    const m = fbm2(this.moist, x * 0.0009 + 800, z * 0.0009 - 400, 3)

    let biome: number
    if (mushroomField && height >= this.seaLevel - 1) biome = BIOME.MUSHROOM
    else if (height < this.seaLevel - 1) biome = BIOME.OCEAN
    else if (isRiver) biome = BIOME.RIVER
    else if (height >= 84 || t < -0.42) biome = BIOME.SNOW
    else if (height >= 68) biome = BIOME.MOUNTAIN
    else if (t > 0.26 && m > 0.24 && height <= this.seaLevel + 6) biome = BIOME.SWAMP
    else if (height <= this.seaLevel + 1) biome = BIOME.BEACH
    else if (t > 0.4 && m < -0.05) biome = BIOME.DESERT
    else if (t > 0.3 && m > 0.18) biome = BIOME.JUNGLE
    else if (t < -0.18) biome = BIOME.TAIGA
    else if (m > 0.08) biome = BIOME.FOREST
    else biome = BIOME.PLAINS

    // stagnant swamp pools sink chosen flat columns just under the water line
    if (biome === BIOME.SWAMP && height <= this.seaLevel + 1) {
      const pool = this.special.noise2(x * 0.045 - 40, z * 0.045 + 60)
      if (pool > 0.3) height = Math.min(height, this.seaLevel - 1)
    }

    const treeDensity = this.treeDensityForBiome(biome, height)

    const info: ColumnInfo = { height, biome, treeDensity }
    if (this.colCache.size > 60000) this.colCache.clear()
    this.colCache.set(key, info)
    return info
  }

  heightAt(x: number, z: number): number { return this.columnInfo(x, z).height }
  surfaceY(x: number, z: number): number { return this.heightAt(x, z) }
  biomeAt(x: number, z: number): number { return this.columnInfo(x, z).biome }
  isSlimeChunk(cx: number, cz: number): boolean { return isSlimeChunkForSeed(this.seedNum, cx, cz) }

  /** Exact terrain cell before map carvers, population and structures. */
  baseBlockAt(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    if (this.generatorVersion >= 3) return this.densityTerrain.blockAt(x, y, z)
    const info = this.columnInfo(x, z)
    const h = info.height
    if (y > h) return h < this.seaLevel && y <= this.seaLevel ? B.WATER : B.AIR
    const bedrockH = 1 + (hash2(x, z, this.seedNum ^ 0x5555) % 2)
    if (y <= bedrockH) return B.BEDROCK
    const { top, under, underDepth } = this.surfaceMaterials(x, z, info)
    if (y === h) return top
    if (y >= h - underDepth) return under
    return B.STONE
  }

  /**
   * Deterministic terrain snapshot used by structure validation. It contains
   * base terrain plus caves/ravines/lakes, but never decorators or structures.
   */
  structureBlockAt(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const cacheKey = `${cx},${cz}`
    let blocks = this.structureTerrainCache.get(cacheKey)
    if (!blocks) {
      const raw = new Chunk(cx, cz)
      const bx = cx * CHUNK_SIZE, bz = cz * CHUNK_SIZE
      for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = bx + lx, wz = bz + lz
        const column = ((lx << 4) | lz) << 7
        for (let sy = 0; sy < WORLD_HEIGHT; sy++) raw.blocks[column | sy] = this.baseBlockAt(wx, sy, wz)
      }
      this.carvers.carveChunk(raw, this)
      blocks = raw.blocks
      if (this.structureTerrainCache.size >= 192) {
        const oldest = this.structureTerrainCache.keys().next().value as string | undefined
        if (oldest !== undefined) this.structureTerrainCache.delete(oldest)
      }
      this.structureTerrainCache.set(cacheKey, blocks)
    }
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    return blocks[(((lx << 4) | lz) << 7) | y]
  }

  structureSolidAt(x: number, y: number, z: number): boolean {
    return !!SOLID[this.structureBlockAt(x, y, z)]
  }

  /** Read-only post-carver terrain supplied to deterministic decorator plans. */
  blockAt(x: number, y: number, z: number): number { return this.structureBlockAt(x, y, z) }

  private treeDensityForBiome(biome: number, height: number): number {
    if (biome === BIOME.FOREST) return 0.026
    if (biome === BIOME.PLAINS) return 0.0035
    if (biome === BIOME.SNOW && height < 100) return 0.012
    if (biome === BIOME.MOUNTAIN && height < 100) return 0.006
    if (biome === BIOME.TAIGA) return 0.03
    if (biome === BIOME.SWAMP) return 0.012
    if (biome === BIOME.JUNGLE) return 0.05
    if (biome === BIOME.MUSHROOM) return 0.007
    return 0
  }

  private surfaceMaterials(
    x: number,
    z: number,
    info: ColumnInfo
  ): { top: number; under: number; underDepth: number } {
    const { height: h, biome } = info
    let top: number = B.GRASS
    let under: number = B.DIRT
    let underDepth = 3
    if (biome === BIOME.OCEAN) {
      top = h >= this.seaLevel - 3
        ? B.SAND
        : (hash01(x, z, this.seedNum ^ 0x99) > 0.35 ? B.GRAVEL : B.STONE)
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
      top = h < this.seaLevel ? B.DIRT : B.MYCELIUM
      under = B.DIRT
    } else if (biome === BIOME.SWAMP) {
      top = h < this.seaLevel ? B.DIRT : B.GRASS
      under = B.DIRT
    }
    if (top === B.GRASS && biome !== BIOME.SWAMP && h <= this.seaLevel + 1 &&
      hash01(x, z, this.seedNum ^ 0x1234) > 0.8) top = B.GRAVEL
    return { top, under, underDepth }
  }

  /** Deterministic tree (or huge mushroom) lookup for any column, or null. */
  treeAt(x: number, z: number): TreeDef | null {
    const r = hash01(x, z, this.seedNum ^ 0xa53a53)
    const info = this.columnInfo(x, z)
    if (info.treeDensity <= 0 || r >= info.treeDensity) return null
    if (info.height <= this.seaLevel) return null
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

    if (this.generatorVersion >= 3) {
      this.densityTerrain.copyInto(chunk)
    } else for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = bx + lx, wz = bz + lz
        const info = this.columnInfo(wx, wz)
        const h = info.height
        const biome = info.biome
        const col = ((lx << 4) | lz) << 7
        chunk.colBiome[(lx << 4) | lz] = biome
        chunk.colHeight[(lx << 4) | lz] = h

        const { top, under, underDepth } = this.surfaceMaterials(wx, wz, info)

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
        if (h < this.seaLevel) {
          for (let y = h + 1; y <= this.seaLevel; y++) blocks[col | y] = B.WATER
        }

        // Generator v1 is retained for historical sparse-edit saves. New worlds
        // replay recursive cross-chunk plans after all base columns exist.
        if (this.generatorVersion === 1 && h >= this.seaLevel + 2) {
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

        if (this.generatorVersion === 1) {
          this.decorateLegacyColumn(chunk, lx, lz, top, h, biome, true)
        }
      }
    }

    if (this.generatorVersion >= 2) {
      this.carvers.carveChunk(chunk, this)
      if (this.generatorVersion === 2) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const wx = bx + lx, wz = bz + lz
          const info = this.columnInfo(wx, wz)
          const { top } = this.surfaceMaterials(wx, wz, info)
          this.decorateLegacyColumn(chunk, lx, lz, top, info.height, info.biome, false)
        }
      }
    }

    if (this.generatorVersion >= 3) {
      // Classic population order: minable ellipsoids precede biome vegetation.
      this.oreGenerator.stampChunk(chunk)
      this.biomeDecorator.decorateChunk(chunk, this)
    } else {
      // Frozen v1/v2 population baseline for sparse-edit saves.
      this.stampOres(chunk)
      for (let tx = bx - 3; tx < bx + CHUNK_SIZE + 3; tx++) {
        for (let tz = bz - 3; tz < bz + CHUNK_SIZE + 3; tz++) {
          const tree = this.treeAt(tx, tz)
          if (tree) this.stampTree(chunk, tree)
        }
      }
    }

    // structures carve last so their interiors stay clear of terrain and trees
    this.stampStructures(chunk)

    chunk.state = 1
  }

  /**
   * Legacy per-column decorator retained until the v2 biome decorator pass is
   * installed. Running it after map carving keeps plants out of lake/cave air.
   */
  private decorateLegacyColumn(
    chunk: Chunk,
    lx: number,
    lz: number,
    top: number,
    h: number,
    biome: number,
    fillDeepCaveAir: boolean
  ): void {
    const wx = chunk.cx * CHUNK_SIZE + lx
    const wz = chunk.cz * CHUNK_SIZE + lz
    const col = ((lx << 4) | lz) << 7
    const blocks = chunk.blocks
    const seed = this.seedNum

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

    if (top === B.MYCELIUM && h + 1 < WORLD_HEIGHT && blocks[col | h] === B.MYCELIUM) {
      const r = hash01(wx, wz, seed ^ 0x517005)
      if (r < 0.045) blocks[col | (h + 1)] = r < 0.022 ? B.MUSHROOM_RED : B.MUSHROOM_BROWN
    }

    if ((top === B.GRASS || top === B.SAND) && h === this.seaLevel && blocks[col | (h + 1)] === B.AIR) {
      const wetBank = this.columnInfo(wx + 1, wz).height < this.seaLevel ||
        this.columnInfo(wx - 1, wz).height < this.seaLevel ||
        this.columnInfo(wx, wz + 1).height < this.seaLevel ||
        this.columnInfo(wx, wz - 1).height < this.seaLevel
      const caneChance = biome === BIOME.SWAMP ? 0.16 : 0.08
      if (wetBank && hash01(wx, wz, seed ^ 0x5ca1e) < caneChance) {
        const height = 1 + hash2(wx, wz, seed ^ 0xc4ae) % 3
        for (let dy = 1; dy <= height && h + dy < WORLD_HEIGHT; dy++) blocks[col | (h + dy)] = B.SUGARCANE
      }
    }

    if (h >= this.seaLevel + 2) {
      for (let y = 6; y < h - 7; y++) {
        if (blocks[col | y] !== B.AIR || blocks[col | (y - 1)] === B.AIR || blocks[col | (y - 1)] === B.WATER) continue
        if (hash2(wx ^ Math.imul(y, 131), wz, seed ^ 0x6d757368) % 3072 === 0) {
          blocks[col | y] = hash2(wx, wz ^ y, seed) & 1 ? B.MUSHROOM_BROWN : B.MUSHROOM_RED
        }
      }
    }

    if (fillDeepCaveAir) {
      for (let y = 3; y <= 10; y++) if (blocks[col | y] === B.AIR) blocks[col | y] = B.LAVA
    }
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
  /* Structures: deterministic starts/components owned by one lazy index.    */
  /* ----------------------------------------------------------------------- */

  private stampStructures(chunk: Chunk): void { this.structureIndex.stampChunk(chunk) }

  dungeonIn(cx: number, cz: number): DungeonPlan | null { return this.structureIndex.dungeonIn(cx, cz) }

  dungeonsIn(cx: number, cz: number): readonly DungeonPlan[] { return this.structureIndex.dungeonsIn(cx, cz) }

  mineshaftIn(cx: number, cz: number): MineshaftPlan | null { return this.structureIndex.mineshaftIn(cx, cz) }

  strongholds(): StrongholdPlan[] { return this.structureIndex.strongholds() }

  villageIn(regionX: number, regionZ: number): VillagePlan | null {
    return this.structureIndex.villageIn(regionX, regionZ)
  }

  villageCandidate(regionX: number, regionZ: number): { cx: number; cz: number } {
    return this.structureIndex.villageCandidate(regionX, regionZ)
  }

  /** All structure starts/components whose inclusive boxes meet a destination chunk. */
  structurePlansIn(cx: number, cz: number): readonly StructurePlan[] {
    return this.structureIndex.plansForChunk(cx, cz)
  }

  structureChestsIn(cx: number, cz: number): StructureChest[] {
    return this.structureIndex.structureChestsIn(cx, cz)
  }

  structureSpawnersNear(x: number, z: number, radius: number): StructureSpawner[] {
    return this.structureIndex.structureSpawnersNear(x, z, radius)
  }

  villagerSpawnsIn(cx: number, cz: number): VillagerSpot[] {
    return this.structureIndex.villagerSpawnsIn(cx, cz)
  }

  villageFeaturesIn(cx: number, cz: number): VillageInfo[] {
    return this.structureIndex.villageFeaturesIn(cx, cz)
  }

  nearestStronghold(x: number, z: number): { x: number; z: number } | null {
    return this.structureIndex.nearestStronghold(x, z)
  }
  /** Find a scenic spawn: elevated grass with water visible nearby. */
  findSpawn(): { x: number, z: number, yaw: number } {
    let best: { x: number, z: number, yaw: number, score: number } | null = null
    for (let i = 0; i < 260; i++) {
      const x = Math.round((hash01(i, 17, this.seedNum ^ 0xf00d) - 0.5) * 900)
      const z = Math.round((hash01(i, 71, this.seedNum ^ 0xbeef) - 0.5) * 900)
      const info = this.columnInfo(x, z)
      if (info.height < this.seaLevel + 6 || info.height > this.seaLevel + 48) continue
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
          if (si.height < this.seaLevel) waterBonus += 4
          if (si.height < info.height - 6) dropBonus += 1.5
          if (si.treeDensity > 0.01) treeBonus += 1
        }
        const ds = waterBonus + dropBonus + treeBonus
        if (ds > bestDirScore) { bestDirScore = ds; bestDir = d }
      }
      // a nearby village makes the friendliest possible start
      const vx = Math.floor(Math.floor(x / CHUNK_SIZE) / VILLAGE_SPACING)
      const vz = Math.floor(Math.floor(z / CHUNK_SIZE) / VILLAGE_SPACING)
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
        + Math.min(info.height - this.seaLevel, 26) * 0.25
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
