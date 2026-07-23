import { B, OPAQUE, SOLID, isWater, canSupportVine } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { hash2, mulberry32 } from '../util/math'

export type Random = () => number
export interface BiomeDecoratorSampler {
  blockAt(x: number, y: number, z: number): number
  surfaceY(x: number, z: number): number
  biomeAt(x: number, z: number): number
  /** Optional fast equivalent of World.getTopSolidOrLiquidBlock. */
  topSolidOrLiquidY?(x: number, z: number): number
}
export type TreeGeneratorKind =
  | 'small_oak' | 'big_oak' | 'birch'
  | 'taiga_1' | 'taiga_2' | 'swamp'
  | 'jungle_shrub' | 'jungle_small' | 'jungle_huge'
export type DecorationFeatureKind =
  | 'sand_patch' | 'gravel_patch' | 'clay_patch'
  | 'tree' | 'huge_mushroom'
  | 'flower_patch' | 'grass_patch' | 'dead_bush_patch'
  | 'mushroom_patch' | 'reed_patch' | 'cactus_patch'
  | 'water_lily_patch' | 'pumpkin_patch' | 'vine_column'
export type PlacementMode =
  | 'always' | 'terrain_patch' | 'ground' | 'trunk' | 'leaf' | 'plant' | 'vine'
export interface DecorationPlacement {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly block: number
  readonly mode: PlacementMode
}
export interface DecorationBounds {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}
export interface DecorationFeature {
  readonly id: string
  readonly sourceCx: number
  readonly sourceCz: number
  readonly sequence: number
  readonly kind: DecorationFeatureKind
  readonly variant?: TreeGeneratorKind | 'red' | 'brown'
  readonly placements: readonly DecorationPlacement[]
  readonly bounds: DecorationBounds
}
export interface DecoratorAttemptCounts {
  readonly sand: number
  readonly clay: number
  readonly gravel: number
  readonly trees: number
  readonly bigMushrooms: number
  readonly flowers: number
  readonly grass: number
  readonly deadBushes: number
  readonly lilies: number
  readonly mushroomRolls: number
  readonly reeds: number
  readonly pumpkins: number
  readonly cacti: number
  readonly vines: number
}
export interface DecoratorProfile {
  /** Values below zero deliberately suppress the vanilla bonus attempt. */
  readonly trees: number
  readonly flowers: number
  readonly grass: number
  readonly deadBushes: number
  readonly mushrooms: number
  /** BiomeDecorator adds ten to this value before iterating. */
  readonly reeds: number
  readonly cacti: number
  readonly clay: number
  readonly sand: number
  readonly gravel: number
  readonly lilies: number
  readonly bigMushrooms: number
  /** Jungle's post-super.decorate vine pass. */
  readonly vines: number
}
export interface BiomeDecorationPlan {
  readonly sourceCx: number
  readonly sourceCz: number
  readonly biome: number
  readonly profile: DecoratorProfile
  readonly attempts: DecoratorAttemptCounts
  readonly features: readonly DecorationFeature[]
}
export interface DecoratorStampStats {
  plansTested: number
  featuresTested: number
  featuresStamped: number
  blocksChanged: number
}
export interface DecoratorCacheStats { plans: number }
export const DECORATOR_BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, MOUNTAIN: 5,
  SNOW: 6, RIVER: 7, TAIGA: 8, SWAMP: 9, JUNGLE: 10, MUSHROOM: 11
} as const
export const BASE_PROFILE: DecoratorProfile = Object.freeze({
  trees: 0, flowers: 2, grass: 1, deadBushes: 0, mushrooms: 0,
  reeds: 0, cacti: 0, clay: 1, sand: 3, gravel: 1, lilies: 0,
  bigMushrooms: 0, vines: 0
})
export function profile(overrides: Partial<DecoratorProfile> = {}): DecoratorProfile {
  return Object.freeze({ ...BASE_PROFILE, ...overrides })
}
export const DECORATOR_PROFILES: Readonly<Record<number, DecoratorProfile>> = Object.freeze({
  [DECORATOR_BIOME.OCEAN]: profile(),
  [DECORATOR_BIOME.BEACH]: profile({ trees: -999 }),
  [DECORATOR_BIOME.PLAINS]: profile({ trees: -999, flowers: 4, grass: 10 }),
  [DECORATOR_BIOME.FOREST]: profile({ trees: 10, grass: 2 }),
  [DECORATOR_BIOME.DESERT]: profile({ trees: -999, deadBushes: 2, reeds: 50, cacti: 10 }),
  [DECORATOR_BIOME.MOUNTAIN]: profile(),
  [DECORATOR_BIOME.SNOW]: profile(),
  [DECORATOR_BIOME.RIVER]: profile(),
  [DECORATOR_BIOME.TAIGA]: profile({ trees: 10, grass: 1 }),
  [DECORATOR_BIOME.SWAMP]: profile({
    trees: 2, flowers: -999, deadBushes: 1, mushrooms: 8,
    reeds: 10, clay: 1, lilies: 4
  }),
  [DECORATOR_BIOME.JUNGLE]: profile({ trees: 50, flowers: 4, grass: 25, vines: 50 }),
  [DECORATOR_BIOME.MUSHROOM]: profile({
    trees: -100, flowers: -100, grass: -100, mushrooms: 1, bigMushrooms: 1
  })
})
export interface WeightedTreeKind { readonly kind: TreeGeneratorKind; readonly weight: number }
export const TREE_WEIGHTS: Readonly<Record<number, readonly WeightedTreeKind[]>> = Object.freeze({
  [DECORATOR_BIOME.FOREST]: Object.freeze([
    { kind: 'small_oak', weight: 72 }, { kind: 'birch', weight: 20 }, { kind: 'big_oak', weight: 8 }
  ]),
  [DECORATOR_BIOME.TAIGA]: Object.freeze([
    { kind: 'taiga_1', weight: 1 }, { kind: 'taiga_2', weight: 2 }
  ]),
  [DECORATOR_BIOME.SWAMP]: Object.freeze([{ kind: 'swamp', weight: 1 }]),
  [DECORATOR_BIOME.JUNGLE]: Object.freeze([
    { kind: 'big_oak', weight: 10 }, { kind: 'jungle_shrub', weight: 45 },
    { kind: 'jungle_huge', weight: 15 }, { kind: 'jungle_small', weight: 30 }
  ])
} satisfies Record<number, readonly WeightedTreeKind[]>)
export const DEFAULT_TREE_WEIGHTS: readonly WeightedTreeKind[] = Object.freeze([
  { kind: 'small_oak', weight: 9 }, { kind: 'big_oak', weight: 1 }
])
export function treeWeightsForBiome(biome: number): readonly WeightedTreeKind[] {
  return TREE_WEIGHTS[biome] ?? DEFAULT_TREE_WEIGHTS
}
export function selectTreeGenerator(biome: number, roll: number): TreeGeneratorKind {
  const table = treeWeightsForBiome(biome)
  const total = table.reduce((sum, entry) => sum + entry.weight, 0)
  let cursor = Math.max(0, Math.min(0.999999999999, roll)) * total
  for (const entry of table) {
    if (cursor < entry.weight) return entry.kind
    cursor -= entry.weight
  }
  return table[table.length - 1].kind
}
export const DECORATOR_PLAN_CACHE_LIMIT = 64
export const DECORATOR_SOURCE_OFFSETS = Object.freeze([-1, 0] as const)
export const DECORATOR_SALT = 0xdec04a7e
export const CARDINALS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
export function nextInt(random: Random, bound: number): number {
  return Math.floor(random() * Math.max(1, Math.floor(bound)))
}
export function sourceKey(cx: number, cz: number): string { return `${cx},${cz}` }
export function clampY(y: number): number { return Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(y))) }
export function topSolidOrLiquidY(sampler: BiomeDecoratorSampler, x: number, z: number): number {
  if (sampler.topSolidOrLiquidY) return clampY(sampler.topSolidOrLiquidY(x, z))
  // surfaceY is an excellent lower bound and avoids a 128-cell scan in normal worlds.
  let y = clampY(sampler.surfaceY(x, z) + 2)
  while (y + 1 < WORLD_HEIGHT && sampler.blockAt(x, y + 1, z) !== B.AIR) y++
  while (y > 0 && sampler.blockAt(x, y, z) === B.AIR) y--
  return y
}
export function isLeaf(id: number): boolean {
  return id === B.LEAVES || id === B.PINELEAVES || id === B.JUNGLE_LEAVES || id === B.BIRCH_LEAVES
}
export function isSmallPlant(id: number): boolean {
  return id === B.TALLGRASS || id === B.FERN || id === B.FLOWER_Y || id === B.FLOWER_R ||
    id === B.MUSHROOM_BROWN || id === B.MUSHROOM_RED || id === B.DEAD_BUSH || id === B.VINE
}
export function treeReplaceable(id: number): boolean {
  return id === B.AIR || isLeaf(id) || isSmallPlant(id) ||
    id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE || id === B.SAPLING_BIRCH
}
export function groundForTree(id: number): boolean { return id === B.GRASS || id === B.DIRT || id === B.MYCELIUM }
export function groundForPlant(id: number): boolean { return id === B.GRASS || id === B.DIRT || id === B.MYCELIUM }
export function placementReplaceable(current: number, placement: DecorationPlacement): boolean {
  if (placement.mode === 'always') return current !== B.BEDROCK
  if (placement.mode === 'terrain_patch') {
    if (placement.block === B.CLAY) return current === B.DIRT
    return current === B.DIRT || current === B.GRASS
  }
  if (placement.mode === 'ground') return groundForTree(current) || current === B.SAND
  if (placement.mode === 'trunk') return treeReplaceable(current) || isWater(current)
  if (placement.mode === 'leaf') return treeReplaceable(current) || isWater(current)
  if (placement.mode === 'plant' || placement.mode === 'vine') return current === B.AIR
  return false
}
export function intersectsChunk(bounds: DecorationBounds, cx: number, cz: number): boolean {
  const minX = cx * CHUNK_SIZE, minZ = cz * CHUNK_SIZE
  return bounds.maxX >= minX && bounds.minX < minX + CHUNK_SIZE &&
    bounds.maxZ >= minZ && bounds.minZ < minZ + CHUNK_SIZE &&
    bounds.maxY >= 0 && bounds.minY < WORLD_HEIGHT
}
export function linePoints(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): [number, number, number][] {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), 1)
  const result: [number, number, number][] = []
  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    result.push([Math.floor(x0 + dx * t + 0.5), Math.floor(y0 + dy * t + 0.5), Math.floor(z0 + dz * t + 0.5)])
  }
  return result
}
