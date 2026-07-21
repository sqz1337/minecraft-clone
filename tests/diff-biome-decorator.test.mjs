import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { BiomeDecorator, DECORATOR_BIOME, DECORATOR_PROFILES, DECORATOR_PLAN_CACHE_LIMIT, DECORATOR_SOURCE_OFFSETS, TREE_WEIGHTS, selectTreeGenerator, planTree, planHugeMushroom } from './src/world/BiomeDecorator.ts'",
      "export { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-biome-decorator-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  BiomeDecorator, DECORATOR_BIOME, DECORATOR_PROFILES, DECORATOR_PLAN_CACHE_LIMIT,
  DECORATOR_SOURCE_OFFSETS, TREE_WEIGHTS, selectTreeGenerator, planTree, planHugeMushroom,
  Chunk, CHUNK_SIZE, WORLD_HEIGHT, B
} = mod.exports

function flatSampler(biome = DECORATOR_BIOME.FOREST, surface = 63, surfaceBlock = B.GRASS) {
  return {
    blockAt(_x, y) {
      if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
      if (y === 0) return B.BEDROCK
      if (y < surface) return B.DIRT
      if (y === surface) return surfaceBlock
      return B.AIR
    },
    surfaceY() { return surface },
    topSolidOrLiquidY() { return surface },
    biomeAt() { return biome }
  }
}

function baseChunk(cx, cz, sampler) {
  const chunk = new Chunk(cx, cz)
  const bx = cx * CHUNK_SIZE, bz = cz * CHUNK_SIZE
  for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let y = 0; y < WORLD_HEIGHT; y++) chunk.set(lx, y, lz, sampler.blockAt(bx + lx, y, bz + lz))
  }
  return chunk
}

function blockPlacements(plan, block) { return plan.placements.filter(placement => placement.block === block) }

test('classic biome profiles retain exact configured attempt counts and sentinels', () => {
  assert.deepEqual({ ...DECORATOR_PROFILES[DECORATOR_BIOME.FOREST] }, {
    trees: 10, flowers: 2, grass: 2, deadBushes: 0, mushrooms: 0,
    reeds: 0, cacti: 0, clay: 1, sand: 3, gravel: 1, lilies: 0,
    bigMushrooms: 0, vines: 0
  })
  assert.deepEqual({ ...DECORATOR_PROFILES[DECORATOR_BIOME.SWAMP] }, {
    trees: 2, flowers: -999, grass: 1, deadBushes: 1, mushrooms: 8,
    reeds: 10, cacti: 0, clay: 1, sand: 3, gravel: 1, lilies: 4,
    bigMushrooms: 0, vines: 0
  })
  assert.deepEqual({ ...DECORATOR_PROFILES[DECORATOR_BIOME.JUNGLE] }, {
    trees: 50, flowers: 4, grass: 25, deadBushes: 0, mushrooms: 0,
    reeds: 0, cacti: 0, clay: 1, sand: 3, gravel: 1, lilies: 0,
    bigMushrooms: 0, vines: 50
  })
  assert.equal(DECORATOR_PROFILES[DECORATOR_BIOME.PLAINS].trees, -999)
  assert.equal(DECORATOR_PROFILES[DECORATOR_BIOME.DESERT].reeds, 50)
  assert.equal(DECORATOR_PROFILES[DECORATOR_BIOME.DESERT].cacti, 10)
  assert.equal(DECORATOR_PROFILES[DECORATOR_BIOME.MUSHROOM].bigMushrooms, 1)
  for (const biome of [DECORATOR_BIOME.OCEAN, DECORATOR_BIOME.MOUNTAIN,
    DECORATOR_BIOME.SNOW, DECORATOR_BIOME.RIVER]) {
    assert.deepEqual(DECORATOR_PROFILES[biome], DECORATOR_PROFILES[DECORATOR_BIOME.OCEAN])
  }
  assert.equal(DECORATOR_PROFILES[DECORATOR_BIOME.BEACH].trees, -999)
  assert.equal(DECORATOR_PROFILES[DECORATOR_BIOME.BEACH].reeds, 0)
  assert.deepEqual([...DECORATOR_SOURCE_OFFSETS], [-1, 0])
})

test('effective weighted tree selectors match forest, taiga and jungle branches', () => {
  assert.deepEqual(TREE_WEIGHTS[DECORATOR_BIOME.FOREST].map(entry => entry.weight), [72, 20, 8])
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.FOREST, 0.719), 'small_oak')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.FOREST, 0.72), 'birch')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.FOREST, 0.92), 'big_oak')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.TAIGA, 0.32), 'taiga_1')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.TAIGA, 0.34), 'taiga_2')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.JUNGLE, 0.09), 'big_oak')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.JUNGLE, 0.10), 'jungle_shrub')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.JUNGLE, 0.55), 'jungle_huge')
  assert.equal(selectTreeGenerator(DECORATOR_BIOME.JUNGLE, 0.70), 'jungle_small')
})

test('all full tree generators expose their species geometry and bounded extents', () => {
  const sampler = flatSampler()
  const kinds = [
    'small_oak', 'big_oak', 'birch', 'taiga_1', 'taiga_2',
    'swamp', 'jungle_shrub', 'jungle_small', 'jungle_huge'
  ]
  const plans = new Map(kinds.map(kind => [kind, planTree(kind, 0, 32, 64, 32, sampler)]))
  for (const [kind, plan] of plans) {
    assert.ok(plan, kind)
    assert.equal(plan.variant, kind)
    assert.ok(plan.placements.length > 0)
    assert.ok(plan.bounds.minX >= 24 && plan.bounds.maxX <= 40, `${kind} X halo`)
    assert.ok(plan.bounds.minZ >= 24 && plan.bounds.maxZ <= 40, `${kind} Z halo`)
    assert.ok(plan.bounds.minY >= 63 && plan.bounds.maxY < WORLD_HEIGHT, `${kind} Y bounds`)
  }

  assert.ok(blockPlacements(plans.get('small_oak'), B.LOG).length >= 4)
  const bigLogs = blockPlacements(plans.get('big_oak'), B.LOG)
  assert.ok(bigLogs.some(block => block.x !== 32 || block.z !== 32), 'large oak owns real branches')
  assert.ok(blockPlacements(plans.get('birch'), B.BIRCH_LOG).length >= 5)
  assert.ok(blockPlacements(plans.get('birch'), B.BIRCH_LEAVES).length > 0)
  assert.ok(blockPlacements(plans.get('taiga_1'), B.PINELEAVES).length > 0)
  assert.ok(blockPlacements(plans.get('taiga_2'), B.PINELEAVES).length > 0)
  assert.notDeepEqual(plans.get('taiga_1').placements, plans.get('taiga_2').placements)
  assert.ok(blockPlacements(plans.get('swamp'), B.VINE).length > 0)
  assert.ok(blockPlacements(plans.get('jungle_shrub'), B.JUNGLE_LOG).length === 1)
  assert.ok(blockPlacements(plans.get('jungle_small'), B.VINE).length > 0)

  const huge = plans.get('jungle_huge')
  const hugeLogs = blockPlacements(huge, B.JUNGLE_LOG)
  for (const [x, z] of [[32, 32], [33, 32], [32, 33], [33, 33]]) {
    assert.ok(hugeLogs.some(block => block.x === x && block.y === 64 && block.z === z), `2x2 ${x},${z}`)
  }
  assert.ok(hugeLogs.some(block => block.x < 32 || block.x > 33 || block.z < 32 || block.z > 33), 'huge jungle branches')
  assert.ok(blockPlacements(huge, B.VINE).length > 0)
})

test('birch sapling is replaceable by the shared full birch growth planner', () => {
  const base = flatSampler()
  const sampler = {
    ...base,
    blockAt(x, y, z) {
      if (x === 32 && y === 64 && z === 32) return B.SAPLING_BIRCH
      return base.blockAt(x, y, z)
    }
  }
  const plan = planTree('birch', 0x51a9, 32, 64, 32, sampler)
  assert.ok(plan)
  assert.ok(plan.placements.some(p => p.x === 32 && p.y === 64 && p.z === 32 && p.block === B.BIRCH_LOG))
  assert.ok(plan.placements.some(p => p.block === B.BIRCH_LEAVES))
})

test('source plans expose exact dynamic attempt totals and deterministic accepted features', () => {
  const swamp = flatSampler(DECORATOR_BIOME.SWAMP)
  const firstDecorator = new BiomeDecorator(0x12345678)
  const secondDecorator = new BiomeDecorator(0x12345678)
  const first = firstDecorator.planForSource(-3, 7, swamp)
  const second = secondDecorator.planForSource(-3, 7, swamp)
  assert.deepEqual(first, second)
  assert.strictEqual(firstDecorator.planForSource(-3, 7, swamp), first)
  assert.ok(first.attempts.trees === 2 || first.attempts.trees === 3)
  assert.deepEqual({
    flowers: first.attempts.flowers, grass: first.attempts.grass,
    deadBushes: first.attempts.deadBushes, mushroomRolls: first.attempts.mushroomRolls,
    reeds: first.attempts.reeds, lilies: first.attempts.lilies
  }, { flowers: 0, grass: 1, deadBushes: 1, mushroomRolls: 8, reeds: 20, lilies: 4 })
  for (const feature of first.features) {
    assert.ok(feature.placements.length > 0)
    assert.ok(feature.placements.every(p => p.x >= feature.bounds.minX && p.x <= feature.bounds.maxX))
    assert.ok(feature.placements.every(p => p.y >= feature.bounds.minY && p.y <= feature.bounds.maxY))
    assert.ok(feature.placements.every(p => p.z >= feature.bounds.minZ && p.z <= feature.bounds.maxZ))
  }
  assert.deepEqual(first.features.map(feature => feature.sequence),
    [...first.features].map(feature => feature.sequence).sort((a, b) => a - b))
})

test('underwater disks keep classic sand/gravel and dirt-to-clay replacement rules', () => {
  const sampler = {
    blockAt(_x, y) {
      if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
      if (y === 0) return B.BEDROCK
      if (y <= 61) return B.DIRT
      if (y === 62) return B.WATER
      return B.AIR
    },
    surfaceY() { return 61 },
    topSolidOrLiquidY() { return 62 },
    biomeAt() { return DECORATOR_BIOME.SWAMP }
  }
  const decorator = new BiomeDecorator(123)
  let clay = null
  for (let cx = 0; cx < 16 && !clay; cx++) {
    clay = decorator.planForSource(cx, 0, sampler).features.find(feature => feature.kind === 'clay_patch') ?? null
  }
  assert.ok(clay)
  assert.ok(clay.placements.every(p => p.block === B.CLAY))
  assert.ok(clay.placements.every(p => sampler.blockAt(p.x, p.y, p.z) === B.DIRT))
  assert.ok(clay.placements.every(p => p.y >= 61 && p.y <= 63), 'clay uses a one-block vertical radius')
})

test('mushroom biome suppresses normal flora while generating a full huge mushroom', () => {
  const sampler = flatSampler(DECORATOR_BIOME.MUSHROOM, 63, B.MYCELIUM)
  const plan = new BiomeDecorator(0x4d555348).planForSource(0, 0, sampler)
  assert.equal(plan.attempts.trees, 0)
  assert.equal(plan.attempts.flowers, 0)
  assert.equal(plan.attempts.grass, 0)
  assert.equal(plan.attempts.bigMushrooms, 1)
  const mushroom = plan.features.find(feature => feature.kind === 'huge_mushroom')
  assert.ok(mushroom)
  assert.ok(mushroom.placements.some(p => p.block === B.MUSHROOM_STEM))
  assert.ok(mushroom.placements.some(p => p.block === B.MUSHROOM_CAP_RED || p.block === B.MUSHROOM_CAP_BROWN))
  assert.ok(mushroom.bounds.maxY - mushroom.bounds.minY >= 4)
})

test('brown and red huge-mushroom caps preserve their distinct classic silhouettes', () => {
  const sampler = flatSampler(DECORATOR_BIOME.MUSHROOM, 63, B.MYCELIUM)
  const brown = planHugeMushroom('brown', 0, 32, 64, 32, sampler)
  const red = planHugeMushroom('red', 0, 32, 64, 32, sampler)
  assert.ok(brown && red)

  const brownTop = brown.bounds.maxY
  const brownCap = brown.placements.filter(p => p.block === B.MUSHROOM_CAP_BROWN && p.y === brownTop)
  assert.equal(brownCap.length, 45, '7x7 brown plate minus four corners')
  for (const [dx, dz] of [[-3, -3], [-3, 3], [3, -3], [3, 3]]) {
    assert.equal(brownCap.some(p => p.x === 32 + dx && p.z === 32 + dz), false)
  }

  const redTop = red.bounds.maxY
  const crown = red.placements.filter(p => p.block === B.MUSHROOM_CAP_RED && p.y === redTop)
  assert.equal(crown.length, 9, 'solid 3x3 red crown')
  for (let layer = redTop - 3; layer < redTop; layer++) {
    const ring = red.placements.filter(p => p.block === B.MUSHROOM_CAP_RED && p.y === layer)
    assert.equal(ring.length, 12, `clipped hollow 5x5 ring at ${layer}`)
    assert.equal(ring.some(p => p.x === 32 && p.z === 32), false)
  }
})

test('a border tree is destination-clipped without losing either side of its canopy', () => {
  const sampler = flatSampler()
  const feature = planTree('small_oak', 77, 15, 64, 8, sampler)
  assert.ok(feature.bounds.minX <= 15 && feature.bounds.maxX >= 16)
  const left = baseChunk(0, 0, sampler)
  const right = baseChunk(1, 0, sampler)
  const decorator = new BiomeDecorator(77)
  const leftChanged = decorator.stampFeatureInto(left, feature)
  const rightChanged = decorator.stampFeatureInto(right, feature)
  assert.ok(leftChanged > 0)
  assert.ok(rightChanged > 0)
  assert.ok(left.get(15, 64, 8) === B.LOG)
  assert.ok([...feature.placements].some(p => p.x === 16 && right.get(0, p.y, p.z) === p.block))
})

test('destination replay is independent of neighbouring chunk generation order', () => {
  const sampler = flatSampler(DECORATOR_BIOME.FOREST)
  const forwardDecorator = new BiomeDecorator(0x0ddc0ffe)
  const reverseDecorator = new BiomeDecorator(0x0ddc0ffe)
  const forwardLeft = baseChunk(0, 0, sampler), forwardRight = baseChunk(1, 0, sampler)
  const reverseLeft = baseChunk(0, 0, sampler), reverseRight = baseChunk(1, 0, sampler)
  forwardDecorator.decorateChunk(forwardLeft, sampler)
  forwardDecorator.decorateChunk(forwardRight, sampler)
  reverseDecorator.decorateChunk(reverseRight, sampler)
  reverseDecorator.decorateChunk(reverseLeft, sampler)
  assert.deepEqual(forwardLeft.blocks, reverseLeft.blocks)
  assert.deepEqual(forwardRight.blocks, reverseRight.blocks)
  let borderChanges = 0
  for (let z = 0; z < CHUNK_SIZE; z++) for (let y = 0; y < WORLD_HEIGHT; y++) {
    if (forwardLeft.get(15, y, z) !== sampler.blockAt(15, y, z)) borderChanges++
    if (forwardRight.get(0, y, z) !== sampler.blockAt(16, y, z)) borderChanges++
  }
  assert.ok(borderChanges > 0, 'accepted features reach the shared border')
})

test('per-sampler plan caches remain bounded', () => {
  const sampler = flatSampler(DECORATOR_BIOME.PLAINS)
  const decorator = new BiomeDecorator(99)
  for (let cx = 0; cx < DECORATOR_PLAN_CACHE_LIMIT + 12; cx++) decorator.planForSource(cx, -2, sampler)
  assert.equal(decorator.cacheStatsFor(sampler).plans, DECORATOR_PLAN_CACHE_LIMIT)
  decorator.clearCaches()
  assert.equal(decorator.cacheStatsFor(sampler).plans, 0)
})
