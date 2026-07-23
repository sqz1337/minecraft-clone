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
import { SEA_LEVEL, LEGACY_SEA_LEVEL, CURRENT_WORLD_GEN_VERSION, WorldGenVersion, JAVA_RANDOM_MULTIPLIER, JAVA_RANDOM_ADDEND, JAVA_RANDOM_MASK, SLIME_CHUNK_SALT, javaRandomNextInt10, isSlimeChunkForSeed, ColumnInfo, TreeKind, TreeDef, OreDef, ORE_DEFS } from './WorldGenShared'
import type { WorldGen } from './WorldGen'

type WorldGenConstructor = { prototype: WorldGen }

export function installWorldGenTerrain(WorldGenClass: WorldGenConstructor): void {
  const prototype = WorldGenClass.prototype
  prototype.columnInfo = function(this: WorldGen, x: number, z: number): ColumnInfo {
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
  prototype.heightAt = function(this: WorldGen, x: number, z: number): number { return this.columnInfo(x, z).height }
  prototype.surfaceY = function(this: WorldGen, x: number, z: number): number { return this.heightAt(x, z) }
  prototype.biomeAt = function(this: WorldGen, x: number, z: number): number { return this.columnInfo(x, z).biome }
  prototype.isSlimeChunk = function(this: WorldGen, cx: number, cz: number): boolean { return isSlimeChunkForSeed(this.seedNum, cx, cz) }
  prototype.baseBlockAt = function(this: WorldGen, x: number, y: number, z: number): number {
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
  prototype.structureBlockAt = function(this: WorldGen, x: number, y: number, z: number): number {
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
  prototype.structureSolidAt = function(this: WorldGen, x: number, y: number, z: number): boolean {
    return !!SOLID[this.structureBlockAt(x, y, z)]
  }
  prototype.blockAt = function(this: WorldGen, x: number, y: number, z: number): number { return this.structureBlockAt(x, y, z) }
  prototype.treeDensityForBiome = function(this: WorldGen, biome: number, height: number): number {
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
  prototype.surfaceMaterials = function(this: WorldGen, x: number, z: number, info: ColumnInfo): { top: number; under: number; underDepth: number } {
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
  prototype.treeAt = function(this: WorldGen, x: number, z: number): TreeDef | null {
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
}
