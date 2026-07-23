import { B, OPAQUE, SOLID, isWater, canSupportVine } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { hash2, mulberry32 } from '../util/math'
import { Random, BiomeDecoratorSampler, TreeGeneratorKind, DecorationFeatureKind, PlacementMode, DecorationPlacement, DecorationBounds, DecorationFeature, DecoratorAttemptCounts, DecoratorProfile, BiomeDecorationPlan, DecoratorStampStats, DecoratorCacheStats, DECORATOR_BIOME, BASE_PROFILE, profile, DECORATOR_PROFILES, WeightedTreeKind, TREE_WEIGHTS, DEFAULT_TREE_WEIGHTS, treeWeightsForBiome, selectTreeGenerator, DECORATOR_PLAN_CACHE_LIMIT, DECORATOR_SOURCE_OFFSETS, DECORATOR_SALT, CARDINALS, nextInt, sourceKey, clampY, topSolidOrLiquidY, isLeaf, isSmallPlant, treeReplaceable, groundForTree, groundForPlant, placementReplaceable, intersectsChunk, linePoints } from './BiomeDecoratorShared'

export class PlanningWorld {
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
export class FeatureBuilder {
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
export function clearForTree(builder: FeatureBuilder, x: number, y: number, z: number, radius: number): boolean {
  if (y < 0 || y >= WORLD_HEIGHT) return false
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (!treeReplaceable(builder.blockAt(x + dx, y, z + dz))) return false
  }
  return true
}
export function addLeafDisk(
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
export function addConiferDisk(
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
export function hangVine(builder: FeatureBuilder, x: number, y: number, z: number, length: number): void {
  for (let dy = 0; dy < length; dy++) {
    if (!builder.set(x, y - dy, z, B.VINE, 'vine')) break
  }
}
export function smallTree(
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
export function bigOak(
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
export function taigaTree(
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
export function swampTree(
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
export function jungleShrub(
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
export function jungleHuge(
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
export function generateTree(
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
export function hugeMushroom(
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
