import { B, OPAQUE, SOLID, isWater, canSupportVine } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { hash2, mulberry32 } from '../util/math'

type Random = () => number

/**
 * Read-only terrain view immediately before biome population.  Implementations
 * must not consult loaded chunks: a decorator plan has to be reproducible when
 * the destination is generated alone, in reverse order, or after its neighbours.
 */
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

/** Realmcraft biome ids, duplicated here to keep WorldGen -> decorator acyclic. */
export const DECORATOR_BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, MOUNTAIN: 5,
  SNOW: 6, RIVER: 7, TAIGA: 8, SWAMP: 9, JUNGLE: 10, MUSHROOM: 11
} as const

const BASE_PROFILE: DecoratorProfile = Object.freeze({
  trees: 0, flowers: 2, grass: 1, deadBushes: 0, mushrooms: 0,
  reeds: 0, cacti: 0, clay: 1, sand: 3, gravel: 1, lilies: 0,
  bigMushrooms: 0, vines: 0
})

function profile(overrides: Partial<DecoratorProfile> = {}): DecoratorProfile {
  return Object.freeze({ ...BASE_PROFILE, ...overrides })
}

/** 1.2-era attempt profiles. Negative sentinels are intentional. */
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

/** Exact effective branch weights of the classic biome selectors. */
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

const DEFAULT_TREE_WEIGHTS: readonly WeightedTreeKind[] = Object.freeze([
  { kind: 'small_oak', weight: 9 }, { kind: 'big_oak', weight: 1 }
])

export function treeWeightsForBiome(biome: number): readonly WeightedTreeKind[] {
  return TREE_WEIGHTS[biome] ?? DEFAULT_TREE_WEIGHTS
}

/** One-roll selector; the tables above preserve the effective vanilla weights. */
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
/** Starts are offset +8..+23 and every implemented generator is bounded to radius seven. */
export const DECORATOR_SOURCE_OFFSETS = Object.freeze([-1, 0] as const)

const DECORATOR_SALT = 0xdec04a7e
const CARDINALS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)

function nextInt(random: Random, bound: number): number {
  return Math.floor(random() * Math.max(1, Math.floor(bound)))
}

function sourceKey(cx: number, cz: number): string { return `${cx},${cz}` }

function clampY(y: number): number { return Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(y))) }

function topSolidOrLiquidY(sampler: BiomeDecoratorSampler, x: number, z: number): number {
  if (sampler.topSolidOrLiquidY) return clampY(sampler.topSolidOrLiquidY(x, z))
  // surfaceY is an excellent lower bound and avoids a 128-cell scan in normal worlds.
  let y = clampY(sampler.surfaceY(x, z) + 2)
  while (y + 1 < WORLD_HEIGHT && sampler.blockAt(x, y + 1, z) !== B.AIR) y++
  while (y > 0 && sampler.blockAt(x, y, z) === B.AIR) y--
  return y
}

function isLeaf(id: number): boolean {
  return id === B.LEAVES || id === B.PINELEAVES || id === B.JUNGLE_LEAVES || id === B.BIRCH_LEAVES
}

function isSmallPlant(id: number): boolean {
  return id === B.TALLGRASS || id === B.FERN || id === B.FLOWER_Y || id === B.FLOWER_R ||
    id === B.MUSHROOM_BROWN || id === B.MUSHROOM_RED || id === B.DEAD_BUSH || id === B.VINE
}

function treeReplaceable(id: number): boolean {
  return id === B.AIR || isLeaf(id) || isSmallPlant(id) ||
    id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE || id === B.SAPLING_BIRCH
}
function groundForTree(id: number): boolean { return id === B.GRASS || id === B.DIRT || id === B.MYCELIUM }
function groundForPlant(id: number): boolean { return id === B.GRASS || id === B.DIRT || id === B.MYCELIUM }

function placementReplaceable(current: number, placement: DecorationPlacement): boolean {
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

function intersectsChunk(bounds: DecorationBounds, cx: number, cz: number): boolean {
  const minX = cx * CHUNK_SIZE, minZ = cz * CHUNK_SIZE
  return bounds.maxX >= minX && bounds.minX < minX + CHUNK_SIZE &&
    bounds.maxZ >= minZ && bounds.minZ < minZ + CHUNK_SIZE &&
    bounds.maxY >= 0 && bounds.minY < WORLD_HEIGHT
}

function linePoints(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): [number, number, number][] {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), 1)
  const result: [number, number, number][] = []
  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    result.push([Math.floor(x0 + dx * t + 0.5), Math.floor(y0 + dy * t + 0.5), Math.floor(z0 + dz * t + 0.5)])
  }
  return result
}

/** Plan-local overlay gives later attempts the blocks placed by earlier attempts. */
class PlanningWorld {
  private readonly overlay = new Map<string, number>()

  constructor(readonly sampler: BiomeDecoratorSampler) {}

  blockAt(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    return this.overlay.get(`${x},${y},${z}`) ?? this.sampler.blockAt(x, y, z)
  }

  commit(placements: readonly DecorationPlacement[]): void {
    for (const placement of placements) this.overlay.set(
      `${placement.x},${placement.y},${placement.z}`, placement.block
    )
  }
}

class FeatureBuilder {
  private readonly cells = new Map<string, DecorationPlacement>()

  constructor(readonly world: PlanningWorld) {}

  blockAt(x: number, y: number, z: number): number {
    return this.cells.get(`${x},${y},${z}`)?.block ?? this.world.blockAt(x, y, z)
  }

  set(x: number, y: number, z: number, block: number, mode: PlacementMode): boolean {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    if (y < 0 || y >= WORLD_HEIGHT) return false
    const placement: DecorationPlacement = { x, y, z, block, mode }
    const current = this.blockAt(x, y, z)
    if (!placementReplaceable(current, placement) && current !== block) return false
    this.cells.set(`${x},${y},${z}`, placement)
    return true
  }

  remove(x: number, y: number, z: number): void {
    this.cells.delete(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`)
  }

  values(): DecorationPlacement[] { return [...this.cells.values()] }
}

function clearForTree(builder: FeatureBuilder, x: number, y: number, z: number, radius: number): boolean {
  if (y < 0 || y >= WORLD_HEIGHT) return false
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (!treeReplaceable(builder.blockAt(x + dx, y, z + dz))) return false
  }
  return true
}

function addLeafDisk(
  builder: FeatureBuilder,
  x: number, y: number, z: number,
  radius: number, block: number, random: Random,
  irregular = true
): void {
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const corner = Math.abs(dx) === radius && Math.abs(dz) === radius
    if (irregular && corner && radius > 0 && random() < 0.5) continue
    builder.set(x + dx, y, z + dz, block, 'leaf')
  }
}

function addConiferDisk(
  builder: FeatureBuilder,
  x: number, y: number, z: number,
  radius: number
): void {
  // Both taiga generators clip every extreme corner instead of randomizing it.
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (radius > 0 && Math.abs(dx) === radius && Math.abs(dz) === radius) continue
    builder.set(x + dx, y, z + dz, B.PINELEAVES, 'leaf')
  }
}

function hangVine(builder: FeatureBuilder, x: number, y: number, z: number, length: number): void {
  for (let dy = 0; dy < length; dy++) {
    if (!builder.set(x, y - dy, z, B.VINE, 'vine')) break
  }
}

function smallTree(
  world: PlanningWorld,
  random: Random,
  x: number,
  baseY: number,
  z: number,
  kind: 'small_oak' | 'birch' | 'jungle_small'
): DecorationPlacement[] {
  const height = kind === 'birch' ? 5 + nextInt(random, 3)
    : kind === 'jungle_small' ? 4 + nextInt(random, 7) + nextInt(random, 3)
      : 4 + nextInt(random, 3)
  if (baseY < 1 || baseY + height + 1 >= WORLD_HEIGHT) return []
  const builder = new FeatureBuilder(world)
  if (!groundForTree(builder.blockAt(x, baseY - 1, z))) return []

  for (let y = baseY; y <= baseY + height + 1; y++) {
    const radius = y === baseY ? 0 : y >= baseY + height - 1 ? 2 : 1
    if (!clearForTree(builder, x, y, z, radius)) return []
  }

  const log = kind === 'birch' ? B.BIRCH_LOG : kind === 'jungle_small' ? B.JUNGLE_LOG : B.LOG
  const leaves = kind === 'birch' ? B.BIRCH_LEAVES : kind === 'jungle_small' ? B.JUNGLE_LEAVES : B.LEAVES
  builder.set(x, baseY - 1, z, B.DIRT, 'ground')

  for (let y = baseY + height - 3; y <= baseY + height; y++) {
    const relative = y - (baseY + height)
    const radius = 1 - Math.trunc(relative / 2)
    addLeafDisk(builder, x, y, z, radius, leaves, random)
  }
  for (let dy = 0; dy < height; dy++) builder.set(x, baseY + dy, z, log, 'trunk')

  if (kind === 'jungle_small') {
    for (let dy = 1; dy < height - 1; dy++) {
      const y = baseY + dy
      if (random() < 2 / 3) builder.set(x - 1, y, z, B.VINE, 'vine')
      if (random() < 2 / 3) builder.set(x + 1, y, z, B.VINE, 'vine')
      if (random() < 2 / 3) builder.set(x, y, z - 1, B.VINE, 'vine')
      if (random() < 2 / 3) builder.set(x, y, z + 1, B.VINE, 'vine')
    }
    const canopy = builder.values().filter(placement => placement.block === B.JUNGLE_LEAVES)
    for (const leaf of canopy) {
      if (random() < 0.25 && builder.blockAt(leaf.x - 1, leaf.y, leaf.z) === B.AIR) hangVine(builder, leaf.x - 1, leaf.y, leaf.z, 5)
      if (random() < 0.25 && builder.blockAt(leaf.x + 1, leaf.y, leaf.z) === B.AIR) hangVine(builder, leaf.x + 1, leaf.y, leaf.z, 5)
      if (random() < 0.25 && builder.blockAt(leaf.x, leaf.y, leaf.z - 1) === B.AIR) hangVine(builder, leaf.x, leaf.y, leaf.z - 1, 5)
      if (random() < 0.25 && builder.blockAt(leaf.x, leaf.y, leaf.z + 1) === B.AIR) hangVine(builder, leaf.x, leaf.y, leaf.z + 1, 5)
    }
  }
  return builder.values()
}

/** Classic large-oak leaf nodes, branch lines and shortened main trunk. */
function bigOak(
  world: PlanningWorld,
  random: Random,
  x: number,
  baseY: number,
  z: number
): DecorationPlacement[] {
  const height = 5 + nextInt(random, 12)
  if (baseY < 1 || baseY + height + 4 >= WORLD_HEIGHT) return []
  const builder = new FeatureBuilder(world)
  if (!groundForTree(builder.blockAt(x, baseY - 1, z))) return []
  for (let y = baseY; y <= baseY + height; y++) {
    const radius = y < baseY + height - 4 ? 0 : 2
    if (!clearForTree(builder, x, y, z, radius)) return []
  }

  interface LeafNode { x: number; y: number; z: number; branchY: number }
  const nodes: LeafNode[] = [{ x, y: baseY + height - 4, z, branchY: baseY + Math.floor(height * 0.618) }]
  const lowestNode = Math.floor(height * 0.3)
  for (let relativeY = height - 5; relativeY >= lowestNode; relativeY--) {
    const normalized = relativeY / height - 0.5
    const shape = normalized === 0 ? height * 0.5
      : normalized >= -0.5 && normalized <= 0.5
        ? Math.sqrt(Math.max(0, height * height * 0.25 - (height * normalized) ** 2))
        : 0
    const radius = Math.min(4, shape * 0.5)
    const count = Math.max(1, Math.floor(1.382 + (height / 13) ** 2))
    for (let index = 0; index < count; index++) {
      const distance = radius * (random() + 0.328)
      const angle = random() * Math.PI * 2
      const nodeX = Math.floor(x + distance * Math.sin(angle) + 0.5)
      const nodeZ = Math.floor(z + distance * Math.cos(angle) + 0.5)
      const nodeY = baseY + relativeY
      let clear = true
      for (let dy = 0; dy <= 4 && clear; dy++) {
        if (!clearForTree(builder, nodeX, nodeY + dy, nodeZ, dy < 2 ? 2 : 1)) clear = false
      }
      if (!clear) continue
      const horizontal = Math.hypot(nodeX - x, nodeZ - z)
      const branchY = Math.max(baseY, Math.min(
        baseY + Math.floor(height * 0.618),
        Math.floor(nodeY - horizontal * 0.381)
      ))
      nodes.push({ x: nodeX, y: nodeY, z: nodeZ, branchY })
    }
  }

  builder.set(x, baseY - 1, z, B.DIRT, 'ground')
  for (const node of nodes) {
    addLeafDisk(builder, node.x, node.y, node.z, 2, B.LEAVES, random)
    addLeafDisk(builder, node.x, node.y + 1, node.z, 2, B.LEAVES, random)
    addLeafDisk(builder, node.x, node.y + 2, node.z, 1, B.LEAVES, random)
    addLeafDisk(builder, node.x, node.y + 3, node.z, 0, B.LEAVES, random, false)
    if (node.branchY < node.y) {
      for (const [bx, by, bz] of linePoints(x, node.branchY, z, node.x, node.y, node.z)) {
        builder.set(bx, by, bz, B.LOG, 'trunk')
      }
    }
  }
  const trunkHeight = Math.max(1, Math.floor(height * 0.618))
  for (let dy = 0; dy <= trunkHeight; dy++) builder.set(x, baseY + dy, z, B.LOG, 'trunk')
  return builder.values()
}

function taigaTree(
  world: PlanningWorld,
  random: Random,
  x: number,
  baseY: number,
  z: number,
  kind: 'taiga_1' | 'taiga_2'
): DecorationPlacement[] {
  const height = kind === 'taiga_1' ? 7 + nextInt(random, 5) : 6 + nextInt(random, 4)
  const bare = kind === 'taiga_1' ? height - nextInt(random, 2) - 3 : 1 + nextInt(random, 2)
  const crownHeight = kind === 'taiga_1' ? height - bare : height - bare
  const maxRadius = kind === 'taiga_1' ? 1 + nextInt(random, crownHeight + 1) : 2 + nextInt(random, 2)
  if (baseY < 1 || baseY + height + 1 >= WORLD_HEIGHT) return []
  const builder = new FeatureBuilder(world)
  if (!groundForTree(builder.blockAt(x, baseY - 1, z))) return []
  for (let y = baseY; y <= baseY + height + 1; y++) {
    const radius = y < baseY + bare ? 0 : maxRadius
    if (!clearForTree(builder, x, y, z, radius)) return []
  }
  builder.set(x, baseY - 1, z, B.DIRT, 'ground')

  if (kind === 'taiga_1') {
    let radius = 0
    for (let y = baseY + height; y >= baseY + bare; y--) {
      addConiferDisk(builder, x, y, z, radius)
      if (radius >= 1 && y === baseY + bare + 1) radius--
      else if (radius < maxRadius) radius++
    }
  } else {
    let radius = nextInt(random, 2)
    let previous = 1
    let reset = 0
    for (let y = baseY + height; y >= baseY + bare; y--) {
      addConiferDisk(builder, x, y, z, radius)
      if (radius >= previous) {
        radius = reset
        reset = 1
        previous = Math.min(maxRadius, previous + 1)
      } else radius++
    }
  }
  const trunkShortening = nextInt(random, 3)
  for (let dy = 0; dy < height - trunkShortening; dy++) builder.set(x, baseY + dy, z, B.PINELOG, 'trunk')
  return builder.values()
}

function swampTree(
  world: PlanningWorld,
  random: Random,
  x: number,
  requestedY: number,
  z: number
): DecorationPlacement[] {
  const height = 5 + nextInt(random, 4)
  let baseY = requestedY
  while (baseY > 1 && isWater(world.blockAt(x, baseY - 1, z))) baseY--
  if (baseY + height + 2 >= WORLD_HEIGHT) return []
  const builder = new FeatureBuilder(world)
  if (!groundForTree(builder.blockAt(x, baseY - 1, z))) return []
  for (let y = baseY; y <= baseY + height + 1; y++) {
    const radius = y === baseY ? 0 : y >= baseY + height - 3 ? 3 : 1
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      const id = builder.blockAt(x + dx, y, z + dz)
      if (!treeReplaceable(id) && !isWater(id)) return []
    }
  }
  builder.set(x, baseY - 1, z, B.DIRT, 'ground')
  for (let y = baseY + height - 3; y <= baseY + height; y++) {
    const radius = 2 - Math.trunc((y - (baseY + height)) / 2)
    addLeafDisk(builder, x, y, z, radius, B.LEAVES, random)
  }
  for (let dy = 0; dy < height; dy++) builder.set(x, baseY + dy, z, B.LOG, 'trunk')

  // Swamp leaves grow independently hanging vines on each outer face.
  const leaves = builder.values().filter(placement => placement.block === B.LEAVES)
  for (const leaf of leaves) {
    if (random() < 0.25 && builder.blockAt(leaf.x - 1, leaf.y, leaf.z) === B.AIR) hangVine(builder, leaf.x - 1, leaf.y, leaf.z, 5)
    if (random() < 0.25 && builder.blockAt(leaf.x + 1, leaf.y, leaf.z) === B.AIR) hangVine(builder, leaf.x + 1, leaf.y, leaf.z, 5)
    if (random() < 0.25 && builder.blockAt(leaf.x, leaf.y, leaf.z - 1) === B.AIR) hangVine(builder, leaf.x, leaf.y, leaf.z - 1, 5)
    if (random() < 0.25 && builder.blockAt(leaf.x, leaf.y, leaf.z + 1) === B.AIR) hangVine(builder, leaf.x, leaf.y, leaf.z + 1, 5)
  }
  return builder.values()
}

function jungleShrub(
  world: PlanningWorld,
  random: Random,
  x: number,
  baseY: number,
  z: number
): DecorationPlacement[] {
  while (baseY > 1 && (world.blockAt(x, baseY - 1, z) === B.AIR || isLeaf(world.blockAt(x, baseY - 1, z)))) baseY--
  const builder = new FeatureBuilder(world)
  if (!groundForTree(builder.blockAt(x, baseY - 1, z))) return []
  builder.set(x, baseY, z, B.JUNGLE_LOG, 'trunk')
  for (let y = baseY + 2; y >= baseY; y--) {
    const radius = 2 - (y - baseY)
    addLeafDisk(builder, x, y, z, radius, B.JUNGLE_LEAVES, random)
  }
  return builder.values()
}

function jungleHuge(
  world: PlanningWorld,
  random: Random,
  x: number,
  baseY: number,
  z: number
): DecorationPlacement[] {
  const height = 10 + nextInt(random, 20) + nextInt(random, 3)
  if (baseY < 1 || baseY + height + 2 >= WORLD_HEIGHT) return []
  const builder = new FeatureBuilder(world)
  for (let dx = 0; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) {
    if (!groundForTree(builder.blockAt(x + dx, baseY - 1, z + dz))) return []
  }
  for (let y = baseY; y <= baseY + height + 2; y++) {
    const radius = y < baseY + height - 3 ? 1 : 3
    if (!clearForTree(builder, x, y, z, radius)) return []
  }
  for (let dx = 0; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) {
    builder.set(x + dx, baseY - 1, z + dz, B.DIRT, 'ground')
  }

  const top = baseY + height
  addLeafDisk(builder, x, top, z, 2, B.JUNGLE_LEAVES, random)
  addLeafDisk(builder, x, top + 1, z, 1, B.JUNGLE_LEAVES, random)
  addLeafDisk(builder, x, top - 1, z, 3, B.JUNGLE_LEAVES, random)

  let branchY = top - 2 - nextInt(random, 4)
  while (branchY > baseY + Math.floor(height * 0.45)) {
    const angle = random() * Math.PI * 2
    const length = 4 + random() * 2
    const endX = Math.floor(x + Math.cos(angle) * length + 0.5)
    const endZ = Math.floor(z + Math.sin(angle) * length + 0.5)
    const endY = branchY + nextInt(random, 3) - 1
    for (const [bx, by, bz] of linePoints(x, branchY, z, endX, endY, endZ)) {
      builder.set(bx, by, bz, B.JUNGLE_LOG, 'trunk')
    }
    addLeafDisk(builder, endX, endY, endZ, 2, B.JUNGLE_LEAVES, random)
    addLeafDisk(builder, endX, endY + 1, endZ, 1, B.JUNGLE_LEAVES, random)
    branchY -= 2 + nextInt(random, 4)
  }

  for (let dy = 0; dy < height; dy++) {
    const y = baseY + dy
    for (let dx = 0; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) {
      builder.set(x + dx, y, z + dz, B.JUNGLE_LOG, 'trunk')
    }
    if (dy > 0) {
      if (random() < 2 / 3) builder.set(x - 1, y, z, B.VINE, 'vine')
      if (random() < 2 / 3) builder.set(x + 2, y, z + 1, B.VINE, 'vine')
      if (random() < 2 / 3) builder.set(x + 1, y, z - 1, B.VINE, 'vine')
      if (random() < 2 / 3) builder.set(x, y, z + 2, B.VINE, 'vine')
    }
  }
  return builder.values()
}

function generateTree(
  world: PlanningWorld,
  random: Random,
  kind: TreeGeneratorKind,
  x: number,
  baseY: number,
  z: number
): DecorationPlacement[] {
  if (kind === 'small_oak' || kind === 'birch' || kind === 'jungle_small') {
    return smallTree(world, random, x, baseY, z, kind)
  }
  if (kind === 'big_oak') return bigOak(world, random, x, baseY, z)
  if (kind === 'taiga_1' || kind === 'taiga_2') return taigaTree(world, random, x, baseY, z, kind)
  if (kind === 'swamp') return swampTree(world, random, x, baseY, z)
  if (kind === 'jungle_shrub') return jungleShrub(world, random, x, baseY, z)
  return jungleHuge(world, random, x, baseY, z)
}

function hugeMushroom(
  world: PlanningWorld,
  random: Random,
  x: number,
  baseY: number,
  z: number,
  variant: 'red' | 'brown'
): DecorationPlacement[] {
  const height = 4 + nextInt(random, 3)
  if (baseY < 1 || baseY + height + 1 >= WORLD_HEIGHT) return []
  const builder = new FeatureBuilder(world)
  if (!groundForTree(builder.blockAt(x, baseY - 1, z))) return []
  const radius = variant === 'brown' ? 3 : 2
  for (let y = baseY; y <= baseY + height + 1; y++) {
    const clearance = y < baseY + height - 2 ? 0 : radius
    if (!clearForTree(builder, x, y, z, clearance)) return []
  }
  builder.set(x, baseY - 1, z, B.DIRT, 'ground')
  const cap = variant === 'red' ? B.MUSHROOM_CAP_RED : B.MUSHROOM_CAP_BROWN
  if (variant === 'brown') {
    addLeafDisk(builder, x, baseY + height, z, 3, cap, random, false)
    // Flat 7x7 cap with the four extreme corners clipped.
    for (const dx of [-3, 3]) for (const dz of [-3, 3]) {
      builder.remove(x + dx, baseY + height, z + dz)
    }
  } else {
    // Three hollow, clipped 5x5 skirt rings and a solid 3x3 crown.
    for (let layer = -3; layer < 0; layer++) for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue
        builder.set(x + dx, baseY + height + layer, z + dz, cap, 'leaf')
      }
    }
    addLeafDisk(builder, x, baseY + height, z, 1, cap, random, false)
  }
  for (let dy = 0; dy < height; dy++) builder.set(x, baseY + dy, z, B.MUSHROOM_STEM, 'trunk')
  return builder.values()
}

function terrainDisk(
  world: PlanningWorld,
  random: Random,
  sampler: BiomeDecoratorSampler,
  x: number,
  z: number,
  block: number,
  maxRadius: number
): DecorationPlacement[] {
  const y = topSolidOrLiquidY(sampler, x, z)
  if (!isWater(world.blockAt(x, y, z))) return []
  const radius = 2 + nextInt(random, Math.max(1, maxRadius - 1))
  const builder = new FeatureBuilder(world)
  const verticalRadius = block === B.CLAY ? 1 : 2
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > radius * radius) continue
    for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
      const targetY = y + dy
      const current = builder.blockAt(x + dx, targetY, z + dz)
      const accepts = block === B.CLAY ? current === B.DIRT : current === B.DIRT || current === B.GRASS
      if (accepts) builder.set(x + dx, targetY, z + dz, block, 'terrain_patch')
    }
  }
  return builder.values()
}

function flowerPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number,
  flower: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  for (let attempt = 0; attempt < 64; attempt++) {
    const px = x + nextInt(random, 8) - nextInt(random, 8)
    const py = y + nextInt(random, 4) - nextInt(random, 4)
    const pz = z + nextInt(random, 8) - nextInt(random, 8)
    if (py <= 0 || py >= WORLD_HEIGHT || builder.blockAt(px, py, pz) !== B.AIR) continue
    if (builder.blockAt(px, py - 1, pz) === B.GRASS) builder.set(px, py, pz, flower, 'plant')
  }
  return builder.values()
}

function grassPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number,
  grass: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  while (y > 0 && (builder.blockAt(x, y, z) === B.AIR || isLeaf(builder.blockAt(x, y, z)))) y--
  for (let attempt = 0; attempt < 128; attempt++) {
    const px = x + nextInt(random, 8) - nextInt(random, 8)
    const py = y + nextInt(random, 4) - nextInt(random, 4) + 1
    const pz = z + nextInt(random, 8) - nextInt(random, 8)
    if (py <= 0 || py >= WORLD_HEIGHT || builder.blockAt(px, py, pz) !== B.AIR) continue
    if (builder.blockAt(px, py - 1, pz) === B.GRASS) builder.set(px, py, pz, grass, 'plant')
  }
  return builder.values()
}

function deadBushPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  while (y > 0 && (builder.blockAt(x, y, z) === B.AIR || isLeaf(builder.blockAt(x, y, z)))) y--
  for (let attempt = 0; attempt < 4; attempt++) {
    const px = x + nextInt(random, 8) - nextInt(random, 8)
    const py = y + nextInt(random, 4) - nextInt(random, 4) + 1
    const pz = z + nextInt(random, 8) - nextInt(random, 8)
    if (py <= 0 || py >= WORLD_HEIGHT || builder.blockAt(px, py, pz) !== B.AIR) continue
    if (builder.blockAt(px, py - 1, pz) === B.SAND) builder.set(px, py, pz, B.DEAD_BUSH, 'plant')
  }
  return builder.values()
}

function mushroomPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number,
  mushroom: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  for (let attempt = 0; attempt < 64; attempt++) {
    const px = x + nextInt(random, 8) - nextInt(random, 8)
    const py = y + nextInt(random, 4) - nextInt(random, 4)
    const pz = z + nextInt(random, 8) - nextInt(random, 8)
    if (py <= 0 || py >= WORLD_HEIGHT || builder.blockAt(px, py, pz) !== B.AIR) continue
    const below = builder.blockAt(px, py - 1, pz)
    let canStay = below === B.MYCELIUM
    if (!canStay && SOLID[below]) {
      // Approximate BlockMushroom's light < 13 rule without loaded-chunk light:
      // caves are below the raw top; foliage/solid overhead shades surface cells.
      canStay = py <= topSolidOrLiquidY(world.sampler, px, pz)
      for (let sy = py + 1; !canStay && sy < Math.min(WORLD_HEIGHT, py + 13); sy++) {
        const overhead = builder.blockAt(px, sy, pz)
        if (isLeaf(overhead) || OPAQUE[overhead]) canStay = true
      }
    }
    if (canStay) builder.set(px, py, pz, mushroom, 'plant')
  }
  return builder.values()
}

function hasAdjacentWater(builder: FeatureBuilder, x: number, y: number, z: number): boolean {
  return CARDINALS.some(([dx, dz]) => isWater(builder.blockAt(x + dx, y, z + dz)))
}

function reedPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  for (let attempt = 0; attempt < 20; attempt++) {
    const px = x + nextInt(random, 4) - nextInt(random, 4)
    const pz = z + nextInt(random, 4) - nextInt(random, 4)
    if (y <= 0 || y >= WORLD_HEIGHT || builder.blockAt(px, y, pz) !== B.AIR) continue
    const ground = builder.blockAt(px, y - 1, pz)
    if (ground !== B.GRASS && ground !== B.DIRT && ground !== B.SAND) continue
    if (!hasAdjacentWater(builder, px, y - 1, pz)) continue
    const height = 2 + nextInt(random, nextInt(random, 3) + 1)
    for (let dy = 0; dy < height; dy++) {
      if (!builder.set(px, y + dy, pz, B.SUGARCANE, 'plant')) break
    }
  }
  return builder.values()
}

function cactusCanStay(builder: FeatureBuilder, x: number, y: number, z: number): boolean {
  if (builder.blockAt(x, y, z) !== B.AIR) return false
  return CARDINALS.every(([dx, dz]) => builder.blockAt(x + dx, y, z + dz) === B.AIR)
}

function cactusPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  for (let attempt = 0; attempt < 10; attempt++) {
    const px = x + nextInt(random, 8) - nextInt(random, 8)
    const py = y + nextInt(random, 4) - nextInt(random, 4)
    const pz = z + nextInt(random, 8) - nextInt(random, 8)
    if (py <= 0 || py >= WORLD_HEIGHT || builder.blockAt(px, py - 1, pz) !== B.SAND) continue
    const height = 1 + nextInt(random, nextInt(random, 3) + 1)
    for (let dy = 0; dy < height; dy++) {
      if (!cactusCanStay(builder, px, py + dy, pz)) break
      builder.set(px, py + dy, pz, B.CACTUS, 'plant')
    }
  }
  return builder.values()
}

function waterLilyPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  for (let attempt = 0; attempt < 10; attempt++) {
    const px = x + nextInt(random, 8) - nextInt(random, 8)
    let py = y + nextInt(random, 4) - nextInt(random, 4)
    const pz = z + nextInt(random, 8) - nextInt(random, 8)
    py = Math.min(WORLD_HEIGHT - 1, py)
    if (builder.blockAt(px, py, pz) === B.AIR && builder.blockAt(px, py - 1, pz) === B.WATER) {
      builder.set(px, py, pz, B.WATER_LILY, 'plant')
    }
  }
  return builder.values()
}

function pumpkinPatch(
  world: PlanningWorld,
  random: Random,
  x: number,
  y: number,
  z: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  for (let attempt = 0; attempt < 64; attempt++) {
    const px = x + nextInt(random, 8) - nextInt(random, 8)
    const py = y + nextInt(random, 4) - nextInt(random, 4)
    const pz = z + nextInt(random, 8) - nextInt(random, 8)
    if (py > 0 && py < WORLD_HEIGHT && builder.blockAt(px, py, pz) === B.AIR &&
      builder.blockAt(px, py - 1, pz) === B.GRASS) {
      builder.set(px, py, pz, B.PUMPKIN, 'plant')
    }
  }
  return builder.values()
}

function vineColumn(
  world: PlanningWorld,
  random: Random,
  startX: number,
  startZ: number
): DecorationPlacement[] {
  const builder = new FeatureBuilder(world)
  let x = startX, z = startZ
  for (let y = 64; y < WORLD_HEIGHT; y++) {
    if (builder.blockAt(x, y, z) === B.AIR) {
      for (const [dx, dz] of CARDINALS) {
        const support = builder.blockAt(x + dx, y, z + dz)
        if (!canSupportVine(support)) continue
        builder.set(x, y, z, B.VINE, 'vine')
        break
      }
    } else {
      // WorldGenVines resets around the original column; it is not cumulative.
      x = startX + nextInt(random, 4) - nextInt(random, 4)
      z = startZ + nextInt(random, 4) - nextInt(random, 4)
    }
  }
  return builder.values()
}

function boundsFor(placements: readonly DecorationPlacement[]): DecorationBounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const placement of placements) {
    minX = Math.min(minX, placement.x); maxX = Math.max(maxX, placement.x)
    minY = Math.min(minY, placement.y); maxY = Math.max(maxY, placement.y)
    minZ = Math.min(minZ, placement.z); maxZ = Math.max(maxZ, placement.z)
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

function profileForBiome(biome: number): DecoratorProfile {
  return DECORATOR_PROFILES[biome] ?? BASE_PROFILE
}

/**
 * Public single-tree planner shared by world population and future sapling
 * growth. It applies the same clearance, soil and full species generator rules.
 */
export function planTree(
  kind: TreeGeneratorKind,
  seed: number,
  x: number,
  baseY: number,
  z: number,
  sampler: BiomeDecoratorSampler
): DecorationFeature | null {
  const world = new PlanningWorld(sampler)
  const placements = generateTree(world, mulberry32(seed), kind, x, baseY, z)
  if (placements.length === 0) return null
  return Object.freeze({
    id: `tree:${x},${baseY},${z}:${kind}`,
    sourceCx: Math.floor(x / CHUNK_SIZE), sourceCz: Math.floor(z / CHUNK_SIZE),
    sequence: 0, kind: 'tree', variant: kind,
    placements: Object.freeze(placements), bounds: Object.freeze(boundsFor(placements))
  })
}

/** Public huge-mushroom generator, kept separate for biome and bonemeal reuse. */
export function planHugeMushroom(
  variant: 'red' | 'brown',
  seed: number,
  x: number,
  baseY: number,
  z: number,
  sampler: BiomeDecoratorSampler
): DecorationFeature | null {
  const world = new PlanningWorld(sampler)
  const placements = hugeMushroom(world, mulberry32(seed), x, baseY, z, variant)
  if (placements.length === 0) return null
  return Object.freeze({
    id: `huge-mushroom:${x},${baseY},${z}:${variant}`,
    sourceCx: Math.floor(x / CHUNK_SIZE), sourceCz: Math.floor(z / CHUNK_SIZE),
    sequence: 0, kind: 'huge_mushroom', variant,
    placements: Object.freeze(placements), bounds: Object.freeze(boundsFor(placements))
  })
}

function buildPlan(
  seed: number,
  sourceCx: number,
  sourceCz: number,
  sampler: BiomeDecoratorSampler
): BiomeDecorationPlan {
  const random = mulberry32(hash2(sourceCx, sourceCz, seed ^ DECORATOR_SALT))
  const originX = sourceCx * CHUNK_SIZE
  const originZ = sourceCz * CHUNK_SIZE
  // ChunkProviderGenerate selected the population biome at origin + 16.
  const biome = sampler.biomeAt(originX + CHUNK_SIZE, originZ + CHUNK_SIZE)
  const selectedProfile = profileForBiome(biome)
  const world = new PlanningWorld(sampler)
  const features: DecorationFeature[] = []
  let sequence = 0

  const anchor = (): [number, number] => [
    originX + 8 + nextInt(random, CHUNK_SIZE),
    originZ + 8 + nextInt(random, CHUNK_SIZE)
  ]
  const record = (
    kind: DecorationFeatureKind,
    variant: DecorationFeature['variant'],
    generate: () => DecorationPlacement[]
  ): void => {
    const featureSequence = sequence++
    const placements = generate()
    if (placements.length === 0) return
    const feature: DecorationFeature = Object.freeze({
      id: `decor:${sourceCx},${sourceCz}:${featureSequence}:${kind}`,
      sourceCx, sourceCz, sequence: featureSequence, kind, variant,
      placements: Object.freeze(placements), bounds: Object.freeze(boundsFor(placements))
    })
    features.push(feature)
    world.commit(placements)
  }

  // BiomeDecorator order matters: later plants see the earlier terrain disks and trees.
  for (let attempt = 0; attempt < Math.max(0, selectedProfile.sand); attempt++) {
    const [x, z] = anchor()
    record('sand_patch', undefined, () => terrainDisk(world, random, sampler, x, z, B.SAND, 6))
  }
  for (let attempt = 0; attempt < Math.max(0, selectedProfile.clay); attempt++) {
    const [x, z] = anchor()
    record('clay_patch', undefined, () => terrainDisk(world, random, sampler, x, z, B.CLAY, 3))
  }
  for (let attempt = 0; attempt < Math.max(0, selectedProfile.gravel); attempt++) {
    const [x, z] = anchor()
    record('gravel_patch', undefined, () => terrainDisk(world, random, sampler, x, z, B.GRAVEL, 5))
  }

  const treeBonus = random() < 0.1 ? 1 : 0
  const treeAttempts = Math.max(0, selectedProfile.trees + treeBonus)
  for (let attempt = 0; attempt < treeAttempts; attempt++) {
    const [x, z] = anchor()
    const kind = selectTreeGenerator(biome, random())
    const y = topSolidOrLiquidY(sampler, x, z) + 1
    record('tree', kind, () => generateTree(world, random, kind, x, y, z))
  }

  for (let attempt = 0; attempt < Math.max(0, selectedProfile.bigMushrooms); attempt++) {
    const [x, z] = anchor()
    const variant = random() < 0.5 ? 'brown' : 'red'
    const y = topSolidOrLiquidY(sampler, x, z) + 1
    record('huge_mushroom', variant, () => hugeMushroom(world, random, x, y, z, variant))
  }

  for (let attempt = 0; attempt < Math.max(0, selectedProfile.flowers); attempt++) {
    const [x, z] = anchor()
    const y = nextInt(random, WORLD_HEIGHT)
    record('flower_patch', undefined, () => flowerPatch(world, random, x, y, z, B.FLOWER_Y))
    if (random() < 0.25) {
      const [redX, redZ] = anchor(); const redY = nextInt(random, WORLD_HEIGHT)
      record('flower_patch', undefined, () => flowerPatch(world, random, redX, redY, redZ, B.FLOWER_R))
    }
  }
  for (let attempt = 0; attempt < Math.max(0, selectedProfile.grass); attempt++) {
    const [x, z] = anchor()
    const y = nextInt(random, WORLD_HEIGHT)
    const grass = biome === DECORATOR_BIOME.JUNGLE && random() < 0.25 ? B.FERN : B.TALLGRASS
    record('grass_patch', undefined, () => grassPatch(world, random, x, y, z, grass))
  }
  for (let attempt = 0; attempt < Math.max(0, selectedProfile.deadBushes); attempt++) {
    const [x, z] = anchor()
    const y = nextInt(random, WORLD_HEIGHT)
    record('dead_bush_patch', undefined, () => deadBushPatch(world, random, x, y, z))
  }
  for (let attempt = 0; attempt < Math.max(0, selectedProfile.lilies); attempt++) {
    const [x, z] = anchor()
    let y = nextInt(random, WORLD_HEIGHT)
    while (y > 0 && world.blockAt(x, y - 1, z) === B.AIR) y--
    record('water_lily_patch', undefined, () => waterLilyPatch(world, random, x, y, z))
  }

  for (let attempt = 0; attempt < Math.max(0, selectedProfile.mushrooms); attempt++) {
    if (random() < 0.25) {
      const [x, z] = anchor(); const y = topSolidOrLiquidY(sampler, x, z) + 1
      record('mushroom_patch', 'brown', () => mushroomPatch(world, random, x, y, z, B.MUSHROOM_BROWN))
    }
    if (random() < 0.125) {
      const [x, z] = anchor(); const y = nextInt(random, WORLD_HEIGHT)
      record('mushroom_patch', 'red', () => mushroomPatch(world, random, x, y, z, B.MUSHROOM_RED))
    }
  }
  // The two independent extra mushroom rolls occur in every biome.
  if (random() < 0.25) {
    const [x, z] = anchor(); const y = nextInt(random, WORLD_HEIGHT)
    record('mushroom_patch', 'brown', () => mushroomPatch(world, random, x, y, z, B.MUSHROOM_BROWN))
  }
  if (random() < 0.125) {
    const [x, z] = anchor(); const y = nextInt(random, WORLD_HEIGHT)
    record('mushroom_patch', 'red', () => mushroomPatch(world, random, x, y, z, B.MUSHROOM_RED))
  }

  // Vanilla owns a separate unconditional ten-attempt loop after biome reeds.
  const reedAttempts = Math.max(0, selectedProfile.reeds) + 10
  for (let attempt = 0; attempt < reedAttempts; attempt++) {
    const [x, z] = anchor(); const y = nextInt(random, WORLD_HEIGHT)
    record('reed_patch', undefined, () => reedPatch(world, random, x, y, z))
  }

  const pumpkinAttempts = random() < 1 / 32 ? 1 : 0
  if (pumpkinAttempts) {
    const [x, z] = anchor(); const y = nextInt(random, WORLD_HEIGHT)
    record('pumpkin_patch', undefined, () => pumpkinPatch(world, random, x, y, z))
  }

  for (let attempt = 0; attempt < Math.max(0, selectedProfile.cacti); attempt++) {
    const [x, z] = anchor(); const y = nextInt(random, WORLD_HEIGHT)
    record('cactus_patch', undefined, () => cactusPatch(world, random, x, y, z))
  }
  for (let attempt = 0; attempt < Math.max(0, selectedProfile.vines); attempt++) {
    const [x, z] = anchor()
    record('vine_column', undefined, () => vineColumn(world, random, x, z))
  }

  const attempts: DecoratorAttemptCounts = Object.freeze({
    sand: Math.max(0, selectedProfile.sand),
    clay: Math.max(0, selectedProfile.clay),
    gravel: Math.max(0, selectedProfile.gravel),
    trees: treeAttempts,
    bigMushrooms: Math.max(0, selectedProfile.bigMushrooms),
    flowers: Math.max(0, selectedProfile.flowers),
    grass: Math.max(0, selectedProfile.grass),
    deadBushes: Math.max(0, selectedProfile.deadBushes),
    lilies: Math.max(0, selectedProfile.lilies),
    mushroomRolls: Math.max(0, selectedProfile.mushrooms),
    reeds: reedAttempts,
    pumpkins: pumpkinAttempts,
    cacti: Math.max(0, selectedProfile.cacti),
    vines: Math.max(0, selectedProfile.vines)
  })
  return Object.freeze({
    sourceCx, sourceCz, biome, profile: selectedProfile, attempts,
    features: Object.freeze(features)
  })
}

/**
 * Deterministic source-plan -> destination-clipped biome population.  A start
 * at source +8..+23 and the seven-block feature halo can touch only its source
 * chunk and the positive neighbour on each axis, hence destination offsets -1,0.
 */
export class BiomeDecorator {
  readonly seed: number
  private planCaches = new WeakMap<BiomeDecoratorSampler, Map<string, BiomeDecorationPlan>>()

  constructor(seed: number) { this.seed = seed | 0 }

  planForSource(
    sourceCx: number,
    sourceCz: number,
    sampler: BiomeDecoratorSampler
  ): BiomeDecorationPlan {
    let cache = this.planCaches.get(sampler)
    if (!cache) {
      cache = new Map()
      this.planCaches.set(sampler, cache)
    }
    const key = sourceKey(sourceCx, sourceCz)
    const cached = cache.get(key)
    if (cached) return cached
    const plan = buildPlan(this.seed, sourceCx, sourceCz, sampler)
    if (cache.size >= DECORATOR_PLAN_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, plan)
    return plan
  }

  plansForChunk(cx: number, cz: number, sampler: BiomeDecoratorSampler): BiomeDecorationPlan[] {
    const result: BiomeDecorationPlan[] = []
    for (const dx of DECORATOR_SOURCE_OFFSETS) for (const dz of DECORATOR_SOURCE_OFFSETS) {
      const plan = this.planForSource(cx + dx, cz + dz, sampler)
      if (plan.features.some(feature => intersectsChunk(feature.bounds, cx, cz))) result.push(plan)
    }
    return result.sort((a, b) => a.sourceCx - b.sourceCx || a.sourceCz - b.sourceCz)
  }

  /** Diagnostic seam for a single accepted feature. */
  stampFeatureInto(chunk: Chunk, feature: DecorationFeature): number {
    if (!intersectsChunk(feature.bounds, chunk.cx, chunk.cz)) return 0
    const bx = chunk.cx * CHUNK_SIZE, bz = chunk.cz * CHUNK_SIZE
    let changed = 0
    for (const placement of feature.placements) {
      const lx = placement.x - bx, lz = placement.z - bz
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE ||
        placement.y < 0 || placement.y >= WORLD_HEIGHT) continue
      const index = Chunk.index(lx, placement.y, lz)
      const current = chunk.blocks[index]
      if (current === placement.block || !placementReplaceable(current, placement)) continue
      chunk.blocks[index] = placement.block
      changed++
    }
    return changed
  }

  decorateChunk(chunk: Chunk, sampler: BiomeDecoratorSampler): DecoratorStampStats {
    const stats: DecoratorStampStats = {
      plansTested: 0, featuresTested: 0, featuresStamped: 0, blocksChanged: 0
    }
    for (const plan of this.plansForChunk(chunk.cx, chunk.cz, sampler)) {
      stats.plansTested++
      for (const feature of plan.features) {
        if (!intersectsChunk(feature.bounds, chunk.cx, chunk.cz)) continue
        stats.featuresTested++
        const changed = this.stampFeatureInto(chunk, feature)
        if (changed > 0) stats.featuresStamped++
        stats.blocksChanged += changed
      }
    }
    return stats
  }

  cacheStatsFor(sampler: BiomeDecoratorSampler): DecoratorCacheStats {
    return { plans: this.planCaches.get(sampler)?.size ?? 0 }
  }

  clearCaches(): void { this.planCaches = new WeakMap() }
}
