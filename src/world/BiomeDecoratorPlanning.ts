import { B, OPAQUE, SOLID, isWater, canSupportVine } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { hash2, mulberry32 } from '../util/math'
import { Random, BiomeDecoratorSampler, TreeGeneratorKind, DecorationFeatureKind, PlacementMode, DecorationPlacement, DecorationBounds, DecorationFeature, DecoratorAttemptCounts, DecoratorProfile, BiomeDecorationPlan, DecoratorStampStats, DecoratorCacheStats, DECORATOR_BIOME, BASE_PROFILE, profile, DECORATOR_PROFILES, WeightedTreeKind, TREE_WEIGHTS, DEFAULT_TREE_WEIGHTS, treeWeightsForBiome, selectTreeGenerator, DECORATOR_PLAN_CACHE_LIMIT, DECORATOR_SOURCE_OFFSETS, DECORATOR_SALT, CARDINALS, nextInt, sourceKey, clampY, topSolidOrLiquidY, isLeaf, isSmallPlant, treeReplaceable, groundForTree, groundForPlant, placementReplaceable, intersectsChunk, linePoints } from './BiomeDecoratorShared'
import { PlanningWorld, FeatureBuilder, clearForTree, addLeafDisk, addConiferDisk, hangVine, smallTree, bigOak, taigaTree, swampTree, jungleShrub, jungleHuge, generateTree, hugeMushroom } from './BiomeDecoratorTrees'
import { terrainDisk, flowerPatch, grassPatch, deadBushPatch, mushroomPatch, hasAdjacentWater, reedPatch, cactusCanStay, cactusPatch, waterLilyPatch, pumpkinPatch, vineColumn, boundsFor } from './BiomeDecoratorFlora'

export function profileForBiome(biome: number): DecoratorProfile {
  return DECORATOR_PROFILES[biome] ?? BASE_PROFILE
}
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
export function buildPlan(
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
