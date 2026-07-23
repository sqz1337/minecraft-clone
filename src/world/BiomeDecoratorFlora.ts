import { B, OPAQUE, SOLID, isWater, canSupportVine } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { hash2, mulberry32 } from '../util/math'
import { Random, BiomeDecoratorSampler, TreeGeneratorKind, DecorationFeatureKind, PlacementMode, DecorationPlacement, DecorationBounds, DecorationFeature, DecoratorAttemptCounts, DecoratorProfile, BiomeDecorationPlan, DecoratorStampStats, DecoratorCacheStats, DECORATOR_BIOME, BASE_PROFILE, profile, DECORATOR_PROFILES, WeightedTreeKind, TREE_WEIGHTS, DEFAULT_TREE_WEIGHTS, treeWeightsForBiome, selectTreeGenerator, DECORATOR_PLAN_CACHE_LIMIT, DECORATOR_SOURCE_OFFSETS, DECORATOR_SALT, CARDINALS, nextInt, sourceKey, clampY, topSolidOrLiquidY, isLeaf, isSmallPlant, treeReplaceable, groundForTree, groundForPlant, placementReplaceable, intersectsChunk, linePoints } from './BiomeDecoratorShared'
import { PlanningWorld, FeatureBuilder, clearForTree, addLeafDisk, addConiferDisk, hangVine, smallTree, bigOak, taigaTree, swampTree, jungleShrub, jungleHuge, generateTree, hugeMushroom } from './BiomeDecoratorTrees'

export function terrainDisk(
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
export function flowerPatch(
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
export function grassPatch(
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
export function deadBushPatch(
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
export function mushroomPatch(
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
export function hasAdjacentWater(builder: FeatureBuilder, x: number, y: number, z: number): boolean {
  return CARDINALS.some(([dx, dz]) => isWater(builder.blockAt(x + dx, y, z + dz)))
}
export function reedPatch(
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
export function cactusCanStay(builder: FeatureBuilder, x: number, y: number, z: number): boolean {
  if (builder.blockAt(x, y, z) !== B.AIR) return false
  return CARDINALS.every(([dx, dz]) => builder.blockAt(x + dx, y, z + dz) === B.AIR)
}
export function cactusPatch(
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
export function waterLilyPatch(
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
export function pumpkinPatch(
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
export function vineColumn(
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
export function boundsFor(placements: readonly DecorationPlacement[]): DecorationBounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const placement of placements) {
    minX = Math.min(minX, placement.x); maxX = Math.max(maxX, placement.x)
    minY = Math.min(minY, placement.y); maxY = Math.max(maxY, placement.y)
    minZ = Math.min(minZ, placement.z); maxZ = Math.max(maxZ, placement.z)
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}
