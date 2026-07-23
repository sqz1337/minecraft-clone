import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { MapCarvers, CARVER_SOURCE_RADIUS, DEEP_LAVA_TOP, MAX_CAVE_PRIMITIVES_PER_SOURCE, MAX_RAVINE_PRIMITIVES_PER_SOURCE, PLAN_CACHE_LIMIT } from './src/world/MapCarvers.ts'",
      "export { WorldGen, CURRENT_WORLD_GEN_VERSION } from './src/world/WorldGen.ts'",
      "export { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-worldgen-carvers-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  MapCarvers, CARVER_SOURCE_RADIUS, DEEP_LAVA_TOP,
  MAX_CAVE_PRIMITIVES_PER_SOURCE, MAX_RAVINE_PRIMITIVES_PER_SOURCE, PLAN_CACHE_LIMIT,
  WorldGen, CURRENT_WORLD_GEN_VERSION, Chunk, CHUNK_SIZE, WORLD_HEIGHT, B
} = mod.exports

function stoneSampler({ surface = WORLD_HEIGHT - 2, waterAt = () => false } = {}) {
  return {
    baseBlockAt(x, y, z) {
      if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
      if (waterAt(Math.floor(x), Math.floor(y), Math.floor(z))) return B.WATER
      if (y <= 1) return B.BEDROCK
      if (y < surface) return B.STONE
      if (y === surface) return B.GRASS
      return B.AIR
    },
    surfaceY() { return surface },
    biomeAt() { return 2 }
  }
}

function baseChunk(cx, cz, sampler) {
  const chunk = new Chunk(cx, cz)
  const bx = cx * CHUNK_SIZE, bz = cz * CHUNK_SIZE
  for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    chunk.colHeight[(lx << 4) | lz] = sampler.surfaceY(bx + lx, bz + lz)
    chunk.colBiome[(lx << 4) | lz] = sampler.biomeAt(bx + lx, bz + lz)
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      chunk.set(lx, y, lz, sampler.baseBlockAt(bx + lx, y, bz + lz))
    }
  }
  return chunk
}

function carved(id) { return id === B.AIR || id === B.LAVA }

function crossingPrimitive(plan) {
  for (const primitive of plan.primitives) {
    if (primitive.y < 5 || primitive.y > WORLD_HEIGHT - 5) continue
    const minCx = Math.floor((primitive.x - primitive.rx) / CHUNK_SIZE)
    const maxCx = Math.floor((primitive.x + primitive.rx) / CHUNK_SIZE)
    if (minCx < maxCx) return { axis: 'x', boundary: (minCx + 1) * CHUNK_SIZE, primitive }
    const minCz = Math.floor((primitive.z - primitive.rz) / CHUNK_SIZE)
    const maxCz = Math.floor((primitive.z + primitive.rz) / CHUNK_SIZE)
    if (minCz < maxCz) return { axis: 'z', boundary: (minCz + 1) * CHUNK_SIZE, primitive }
  }
  return null
}

function assertCarvePlanCrosses(plan, carvers, sampler) {
  const crossing = crossingPrimitive(plan)
  assert.ok(crossing, `${plan.kind} plan needs a border-crossing primitive`)
  let first, second
  if (crossing.axis === 'x') {
    const rightCx = Math.floor(crossing.boundary / CHUNK_SIZE)
    const cz = Math.floor(crossing.primitive.z / CHUNK_SIZE)
    first = baseChunk(rightCx - 1, cz, sampler)
    second = baseChunk(rightCx, cz, sampler)
  } else {
    const topCz = Math.floor(crossing.boundary / CHUNK_SIZE)
    const cx = Math.floor(crossing.primitive.x / CHUNK_SIZE)
    first = baseChunk(cx, topCz - 1, sampler)
    second = baseChunk(cx, topCz, sampler)
  }
  const firstStats = carvers.stampCarvePlanInto(first, plan, sampler)
  const secondStats = carvers.stampCarvePlanInto(second, plan, sampler)
  assert.ok(firstStats.blocksChanged > 0 && secondStats.blocksChanged > 0)

  let joined = 0
  for (let lateral = 0; lateral < CHUNK_SIZE; lateral++) for (let y = 2; y < WORLD_HEIGHT - 1; y++) {
    const a = crossing.axis === 'x' ? first.get(15, y, lateral) : first.get(lateral, y, 15)
    const b = crossing.axis === 'x' ? second.get(0, y, lateral) : second.get(lateral, y, 0)
    if (carved(a) && carved(b)) joined++
  }
  assert.ok(joined > 0, `${plan.kind} must remain connected across the destination seam`)
}

function findPlan(carvers, kind, predicate) {
  for (let radius = 0; radius <= 48; radius++) {
    for (let cx = -radius; cx <= radius; cx++) for (let cz = -radius; cz <= radius; cz++) {
      if (Math.max(Math.abs(cx), Math.abs(cz)) !== radius) continue
      const plan = kind === 'cave' ? carvers.cavePlanFor(cx, cz) : carvers.ravinePlanFor(cx, cz)
      if (plan && predicate(plan)) return plan
    }
  }
  return null
}

function lakeFluidCrossing(plan) {
  const index = (x, y, z) => ((x * 16 + z) * 8 + y)
  for (let x = 0; x < 15; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 4; y++) {
    if (!plan.mask[index(x, y, z)] || !plan.mask[index(x + 1, y, z)]) continue
    const wx = plan.originX + x
    if (Math.floor(wx / 16) !== Math.floor((wx + 1) / 16)) {
      return { axis: 'x', x: wx, y: plan.originY + y, z: plan.originZ + z }
    }
  }
  for (let x = 0; x < 16; x++) for (let z = 0; z < 15; z++) for (let y = 0; y < 4; y++) {
    if (!plan.mask[index(x, y, z)] || !plan.mask[index(x, y, z + 1)]) continue
    const wz = plan.originZ + z
    if (Math.floor(wz / 16) !== Math.floor((wz + 1) / 16)) {
      return { axis: 'z', x: plan.originX + x, y: plan.originY + y, z: wz }
    }
  }
  return null
}

test('source plans and full destination stamps are deterministic and load-order independent', () => {
  const sampler = stoneSampler()
  const first = new MapCarvers(0x12345678)
  const second = new MapCarvers(0x12345678)
  const cave = findPlan(first, 'cave', plan => plan.branchCount >= 3)
  assert.ok(cave)
  assert.deepEqual(second.cavePlanFor(cave.sourceCx, cave.sourceCz), cave)

  const a0 = baseChunk(-1, 0, sampler), a1 = baseChunk(0, 0, sampler)
  const a0Stats = first.carveChunk(a0, sampler)
  const a1Stats = first.carveChunk(a1, sampler)
  const b0 = baseChunk(-1, 0, sampler), b1 = baseChunk(0, 0, sampler)
  const b1Stats = second.carveChunk(b1, sampler)
  const b0Stats = second.carveChunk(b0, sampler)

  assert.deepEqual(a0.blocks, b0.blocks)
  assert.deepEqual(a1.blocks, b1.blocks)
  assert.deepEqual(a0Stats, b0Stats)
  assert.deepEqual(a1Stats, b1Stats)
  assert.ok(a0Stats.blocksChanged + a1Stats.blocksChanged > 0)
  assert.equal(CARVER_SOURCE_RADIUS, 8)
})

test('recursive cave plans expose rooms, child branches and seamless cross-chunk tunnels', () => {
  const sampler = stoneSampler()
  const carvers = new MapCarvers(0x51a7c0de)
  const plan = findPlan(carvers, 'cave', candidate =>
    candidate.branchCount >= 3 && candidate.primitives.some(primitive => primitive.kind === 'room') && crossingPrimitive(candidate)
  )
  assert.ok(plan)
  const branchIds = new Set(plan.primitives.filter(primitive => primitive.branchId >= 0).map(primitive => primitive.branchId))
  const childPrimitives = plan.primitives.filter(primitive => primitive.parentBranchId !== null)
  assert.ok(branchIds.size >= 3)
  assert.ok(childPrimitives.length > 0)
  assert.ok(plan.primitives.some(primitive => primitive.kind === 'room'))
  assert.ok(plan.primitives.length <= MAX_CAVE_PRIMITIVES_PER_SOURCE)
  assertCarvePlanCrosses(plan, carvers, sampler)
})

test('ravines are long, vertically stretched and replay seamlessly across chunks', () => {
  const sampler = stoneSampler()
  const carvers = new MapCarvers(0x7a91b33f)
  const plan = findPlan(carvers, 'ravine', candidate => {
    const span = Math.max(candidate.bounds.maxX - candidate.bounds.minX, candidate.bounds.maxZ - candidate.bounds.minZ)
    return span > 45 && crossingPrimitive(candidate)
  })
  assert.ok(plan)
  assert.ok(plan.primitives.length >= 84)
  assert.ok(plan.primitives.length <= MAX_RAVINE_PRIMITIVES_PER_SOURCE)
  assert.ok(plan.primitives.every(primitive => primitive.kind === 'ravine'))
  assert.ok(plan.primitives.some(primitive => primitive.ry / primitive.rx > 2))
  assertCarvePlanCrosses(plan, carvers, sampler)
})

test('water and lava lakes use deterministic masks and can span a chunk border atomically', () => {
  const sampler = stoneSampler()
  const carvers = new MapCarvers(0x1a2b3c4d)
  let waterPlan = null
  let lavaPlan = null
  let crossingPlan = null
  let crossing = null
  for (let radius = 0; radius <= 40 && (!waterPlan || !lavaPlan || !crossingPlan); radius++) {
    for (let cx = -radius; cx <= radius; cx++) for (let cz = -radius; cz <= radius; cz++) {
      if (Math.max(Math.abs(cx), Math.abs(cz)) !== radius) continue
      for (const plan of carvers.lakePlansFor(cx, cz, sampler)) {
        if (plan.kind === 'water' && !waterPlan) waterPlan = plan
        if (plan.kind === 'lava' && !lavaPlan) lavaPlan = plan
        const candidateCrossing = lakeFluidCrossing(plan)
        if (candidateCrossing && !crossingPlan) {
          crossingPlan = plan
          crossing = candidateCrossing
        }
      }
    }
  }
  assert.ok(waterPlan && lavaPlan && crossingPlan && crossing)
  assert.deepEqual(new MapCarvers(0x1a2b3c4d).lakePlansFor(
    crossingPlan.sourceCx, crossingPlan.sourceCz, sampler
  ), carvers.lakePlansFor(crossingPlan.sourceCx, crossingPlan.sourceCz, sampler))

  let first, second
  if (crossing.axis === 'x') {
    const rightCx = Math.floor((crossing.x + 1) / 16)
    const cz = Math.floor(crossing.z / 16)
    first = baseChunk(rightCx - 1, cz, sampler)
    second = baseChunk(rightCx, cz, sampler)
  } else {
    const topCz = Math.floor((crossing.z + 1) / 16)
    const cx = Math.floor(crossing.x / 16)
    first = baseChunk(cx, topCz - 1, sampler)
    second = baseChunk(cx, topCz, sampler)
  }
  assert.ok(carvers.stampLakePlanInto(first, crossingPlan) > 0)
  assert.ok(carvers.stampLakePlanInto(second, crossingPlan) > 0)
  const firstId = crossing.axis === 'x'
    ? first.get(15, crossing.y, crossing.z - first.cz * 16)
    : first.get(crossing.x - first.cx * 16, crossing.y, 15)
  const secondId = crossing.axis === 'x'
    ? second.get(0, crossing.y, crossing.z - second.cz * 16)
    : second.get(crossing.x - second.cx * 16, crossing.y, 0)
  assert.equal(firstId, crossingPlan.liquid)
  assert.equal(secondId, crossingPlan.liquid)
  assert.equal(waterPlan.liquid, B.WATER)
  assert.equal(lavaPlan.liquid, B.LAVA)
})

test('local water veto preserves a wet halo while accepted deep cuts become lava', () => {
  const carvers = new MapCarvers(7)
  const primitive = {
    kind: 'tunnel', x: 8.5, y: 20.5, z: 8.5,
    rx: 2.5, ry: 2, rz: 2.5, branchId: 0, parentBranchId: null
  }
  const plan = {
    kind: 'cave', sourceCx: 0, sourceCz: 0, branchCount: 1,
    primitives: [primitive],
    bounds: { minX: 6, minY: 18.5, minZ: 6, maxX: 11, maxY: 22.5, maxZ: 11 }
  }
  const dry = stoneSampler()
  const dryChunk = baseChunk(0, 0, dry)
  assert.ok(carvers.stampCarvePlanInto(dryChunk, plan, dry).blocksChanged > 0)
  assert.equal(dryChunk.get(8, 20, 8), B.AIR)

  const wet = stoneSampler({ waterAt: (x, y, z) => x === 11 && y === 20 && z === 8 })
  const wetChunk = baseChunk(0, 0, wet)
  const wetStats = carvers.stampCarvePlanInto(wetChunk, plan, wet)
  assert.equal(wetStats.blocksChanged, 0)
  assert.equal(wetChunk.get(8, 20, 8), B.STONE)
  assert.equal(wetChunk.get(11, 20, 8), B.WATER)

  const depthPlan = {
    kind: 'cave', sourceCx: 0, sourceCz: 0, branchCount: 2,
    primitives: [
      { ...primitive, y: DEEP_LAVA_TOP - 1, branchId: 0 },
      { ...primitive, y: DEEP_LAVA_TOP + 10, branchId: 1 }
    ],
    bounds: { minX: 6, minY: 5, minZ: 6, maxX: 11, maxY: 23, maxZ: 11 }
  }
  const depthChunk = baseChunk(0, 0, dry)
  carvers.stampCarvePlanInto(depthChunk, depthPlan, dry)
  assert.equal(depthChunk.get(8, DEEP_LAVA_TOP - 1, 8), B.LAVA)
  assert.equal(depthChunk.get(8, DEEP_LAVA_TOP + 10, 8), B.AIR)
})

test('carvers replace natural terrain but preserve bedrock and fluids', () => {
  const sampler = stoneSampler()
  const carvers = new MapCarvers(17)
  const primitive = {
    kind: 'room', x: 8.5, y: 20.5, z: 8.5,
    rx: 2, ry: 2, rz: 2, branchId: 0, parentBranchId: null
  }
  const plan = {
    kind: 'cave', sourceCx: 0, sourceCz: 0, branchCount: 1,
    primitives: [primitive],
    bounds: { minX: 6.5, minY: 18.5, minZ: 6.5, maxX: 10.5, maxY: 22.5, maxZ: 10.5 }
  }
  for (const id of [B.STONE, B.DIRT, B.GRASS, B.MYCELIUM, B.SNOW, B.SAND, B.GRAVEL, B.SANDSTONE]) {
    const chunk = baseChunk(0, 0, sampler)
    chunk.set(8, 20, 8, id)
    carvers.stampCarvePlanInto(chunk, plan, sampler)
    assert.equal(chunk.get(8, 20, 8), B.AIR, `natural block ${id} was not carved`)
  }
  for (const id of [B.BEDROCK, B.WATER, B.LAVA]) {
    const chunk = baseChunk(0, 0, sampler)
    chunk.set(8, 20, 8, id)
    carvers.stampCarvePlanInto(chunk, plan, sampler)
    assert.equal(chunk.get(8, 20, 8), id, `protected block ${id} was carved`)
  }
})

test('plan caches and recursive geometry stay within explicit hard bounds', () => {
  const sampler = stoneSampler()
  const carvers = new MapCarvers(0x600dbeef)
  for (let index = 0; index < PLAN_CACHE_LIMIT + 32; index++) {
    const cave = carvers.cavePlanFor(index, -index)
    const ravine = carvers.ravinePlanFor(index, -index)
    if (cave) assert.ok(cave.primitives.length <= MAX_CAVE_PRIMITIVES_PER_SOURCE)
    if (ravine) assert.ok(ravine.primitives.length <= MAX_RAVINE_PRIMITIVES_PER_SOURCE)
    carvers.lakePlansFor(index, -index, sampler)
  }
  const stats = carvers.cacheStatsFor(sampler)
  assert.deepEqual(stats, {
    cavePlans: PLAN_CACHE_LIMIT,
    ravinePlans: PLAN_CACHE_LIMIT,
    lakePlans: PLAN_CACHE_LIMIT
  })
})

test('WorldGen v4 integrates map carvers without chunk load-order seams', () => {
  const forward = new WorldGen('integrated-carvers', 2)
  const reverse = new WorldGen('integrated-carvers', 2)
  const leftForward = new Chunk(-1, 0), rightForward = new Chunk(0, 0)
  const leftReverse = new Chunk(-1, 0), rightReverse = new Chunk(0, 0)

  forward.fillChunk(leftForward)
  forward.fillChunk(rightForward)
  reverse.fillChunk(rightReverse)
  reverse.fillChunk(leftReverse)

  assert.deepEqual(leftForward.blocks, leftReverse.blocks)
  assert.deepEqual(rightForward.blocks, rightReverse.blocks)
  assert.deepEqual(leftForward.colHeight, leftReverse.colHeight)
  assert.deepEqual(rightForward.colBiome, rightReverse.colBiome)
})

test('all saves select the v4 Java-compatible population baseline', () => {
  assert.equal(CURRENT_WORLD_GEN_VERSION, 4)
  assert.equal(new WorldGen('version-default').generatorVersion, 4)
  assert.equal(new WorldGen('version-default', 1).generatorVersion, 4)
  assert.equal(new WorldGen('version-default', 2).generatorVersion, 4)
  assert.equal(new WorldGen('version-default', 3).generatorVersion, 4)

  const upgraded = new WorldGen('versioned-carvers', 1)
  const current = new WorldGen('versioned-carvers', 4)
  const upgradedChunk = new Chunk(0, 0)
  const currentChunk = new Chunk(0, 0)
  upgraded.fillChunk(upgradedChunk)
  current.fillChunk(currentChunk)
  assert.deepEqual(upgradedChunk.blocks, currentChunk.blocks)
})
