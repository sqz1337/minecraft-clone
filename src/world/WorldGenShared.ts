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
export const SEA_LEVEL = DENSITY_SEA_LEVEL
export const LEGACY_SEA_LEVEL = 40
export const CURRENT_WORLD_GEN_VERSION = 4
export type WorldGenVersion = 1 | 2 | 3 | 4
export { BIOME, BIOME_NAMES, GRASS_TINT } from './Biomes'
export const JAVA_RANDOM_MULTIPLIER = 0x5deece66dn
export const JAVA_RANDOM_ADDEND = 0xbn
export const JAVA_RANDOM_MASK = (1n << 48n) - 1n
export const SLIME_CHUNK_SALT = 0x3ad8025fn
export function javaRandomNextInt10(seed: bigint): number {
  let state = (seed ^ JAVA_RANDOM_MULTIPLIER) & JAVA_RANDOM_MASK
  for (;;) {
    state = (state * JAVA_RANDOM_MULTIPLIER + JAVA_RANDOM_ADDEND) & JAVA_RANDOM_MASK
    const bits = Number(state >> 17n)
    const value = bits % 10
    // Java evaluates this addition as a signed 32-bit int.
    if (bits - value + 9 <= 0x7fffffff) return value
  }
}
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
export interface TreeDef {
  x: number; z: number
  baseY: number
  height: number
  kind: TreeKind
}
export interface OreDef {
  id: number
  minY: number
  maxY: number
  veinsPerChunk: number
  minSize: number
  maxSize: number
  radiusScale: number
  salt: number
}
export const ORE_DEFS: OreDef[] = [
  { id: B.COAL_ORE, minY: 5, maxY: 96, veinsPerChunk: 10, minSize: 8, maxSize: 16, radiusScale: 1, salt: 0x1c01 },
  { id: B.IRON_ORE, minY: 5, maxY: 64, veinsPerChunk: 8, minSize: 5, maxSize: 10, radiusScale: 1, salt: 0x1a02 },
  { id: B.GOLD_ORE, minY: 5, maxY: 32, veinsPerChunk: 2, minSize: 4, maxSize: 7, radiusScale: 0.8, salt: 0x601d },
  { id: B.DIAMOND_ORE, minY: 5, maxY: 18, veinsPerChunk: 1, minSize: 3, maxSize: 6, radiusScale: 0.75, salt: 0xd1a0 }
]
