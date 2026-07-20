import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { World } from './src/world/World.ts'",
      "export { Chunk, ChunkState } from './src/world/Chunk.ts'",
      "export { B, isWater, isLava, isFluid, fluidLevel, fluidBlock } from './src/world/Blocks.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS, durabilityForItem } from './src/world/Items.ts'",
      "export { matchRecipe } from './src/world/Recipes.ts'",
      "export { EntityManager } from './src/entities/EntityManager.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'stage9-test-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const {
  World, Chunk, ChunkState, B, I, ITEMS, durabilityForItem, matchRecipe,
  isWater, isLava, isFluid, fluidLevel, fluidBlock, EntityManager
} = bundledModule.exports

function makeWorld() {
  const world = Object.create(World.prototype)
  const chunk = new Chunk(0, 0)
  chunk.state = ChunkState.GENERATED
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.set(x, 4, z, B.STONE)
  Object.assign(world, {
    gen: { seedNum: 7, biomeAt: () => 2 }, chunks: new Map([[0, chunk]]),
    blockEdits: new Map(), blockFacings: new Map(), editsDirty: false,
    scheduledTicks: [], simulationTick: 0, simulationAccumulator: 0,
    renderDistance: 4, grassDensity: 1, mutationBatchDepth: 0,
    dirtyChunkKeys: new Set(), onAutomaticBlockBreak: () => {}, onTntExplode: () => {}, onTntPrimed: () => {}
  })
  world.remeshChunk = () => {}
  return { world, chunk }
}

function tick(world, count) {
  for (let i = 0; i < count; i++) world.tickSimulation(0.051, 8, 8)
}

test('stage 9 registers liquid levels, utility items and crafting recipes', () => {
  assert.equal(isWater(B.WATER_7), true)
  assert.equal(isLava(B.LAVA_4), true)
  assert.equal(isFluid(B.STONE), false)
  assert.equal(fluidLevel(B.WATER), 0)
  assert.equal(fluidLevel(B.WATER_7), 7)
  assert.equal(fluidLevel(B.LAVA_7), 7)
  assert.equal(fluidBlock('water', 3), B.WATER_3)
  assert.equal(ITEMS[I.BUCKET].stackSize, 16)
  // full buckets never stack, like vanilla
  assert.equal(ITEMS[I.WATER_BUCKET].stackSize, 1)
  assert.equal(ITEMS[I.LAVA_BUCKET].stackSize, 1)
  assert.equal(durabilityForItem(I.FLINT_AND_STEEL), 65)

  const bucket = Array(9).fill(null)
  bucket[0] = { id: I.IRON_INGOT, count: 1 }
  bucket[2] = { id: I.IRON_INGOT, count: 1 }
  bucket[4] = { id: I.IRON_INGOT, count: 1 }
  assert.deepEqual(matchRecipe(bucket, 3), { id: I.BUCKET, count: 1 })

  const tnt = Array(9).fill(null)
  ;[I.GUNPOWDER, B.SAND, I.GUNPOWDER, B.SAND, I.GUNPOWDER, B.SAND, I.GUNPOWDER, B.SAND, I.GUNPOWDER]
    .forEach((id, index) => { tnt[index] = { id, count: 1 } })
  assert.deepEqual(matchRecipe(tnt, 3), { id: B.TNT, count: 1 })
})

test('water and lava spread downward and sideways through bounded scheduled ticks', () => {
  const { world } = makeWorld()
  world.setBlock(8, 8, 8, B.WATER)
  tick(world, 7)
  assert.equal(world.getBlock(8, 7, 8), B.WATER_1)
  assert.equal(world.getBlock(9, 8, 8), B.WATER_1)
  world.setBlock(8, 8, 8, B.AIR)
  tick(world, 70)
  assert.equal(world.getBlock(9, 8, 8), B.AIR)

  const lava = makeWorld().world
  lava.setBlock(8, 8, 8, B.LAVA)
  tick(lava, 32)
  assert.equal(lava.getBlock(8, 7, 8), B.LAVA_1)
  assert.equal(lava.getBlock(9, 8, 8), B.LAVA_1)
  assert.ok(lava.serializeScheduledTicks().length <= 8192 * 5)
})

test('two adjacent water sources create a renewable source over a solid block', () => {
  const { world } = makeWorld()
  world.setBlock(7, 5, 8, B.WATER)
  world.setBlock(9, 5, 8, B.WATER)
  world.setBlock(8, 5, 8, B.WATER_1)
  tick(world, 7)
  assert.equal(world.getBlock(8, 5, 8), B.WATER)
})

test('overworld lava updates slowly and stops after three horizontal blocks', () => {
  const { world } = makeWorld()
  world.setBlock(8, 5, 8, B.LAVA)
  tick(world, 190)
  assert.equal(isLava(world.getBlock(11, 5, 8)), true)
  assert.equal(world.getBlock(12, 5, 8), B.AIR)
})

test('liquid contact produces obsidian, stone and cobblestone', () => {
  const source = makeWorld().world
  source.setBlock(7, 7, 7, B.LAVA)
  source.setBlock(8, 7, 7, B.WATER)
  tick(source, 6)
  assert.equal(source.getBlock(7, 7, 7), B.OBSIDIAN)

  const stone = makeWorld().world
  stone.setBlock(7, 7, 7, B.LAVA_1)
  stone.setBlock(8, 7, 7, B.WATER)
  tick(stone, 6)
  assert.equal(stone.getBlock(7, 7, 7), B.STONE)

  const cobble = makeWorld().world
  cobble.setBlock(7, 7, 7, B.LAVA_1)
  cobble.setBlock(8, 7, 7, B.WATER_1)
  tick(cobble, 6)
  assert.equal(cobble.getBlock(7, 7, 7), B.COBBLESTONE)
})

test('fire and primed TNT use persistent scheduled state and dynamic block light', () => {
  const { world } = makeWorld()
  world.setBlock(8, 6, 8, B.PLANKS)
  assert.equal(world.ignite(8, 7, 8), true)
  assert.equal(world.getBlock(8, 7, 8), B.FIRE)
  assert.equal(world.getBlockLight(8, 7, 8), 15)

  let blasts = 0
  world.setBlock(10, 6, 8, B.TNT)
  world.onTntExplode = (_x, _y, _z, radius) => { blasts++; assert.equal(radius, 4) }
  assert.equal(world.primeTnt(10, 6, 8, 6), true)
  assert.equal(world.getBlock(10, 6, 8), B.PRIMED_TNT)
  assert.ok(world.serializeScheduledTicks().some((value, index) => index % 5 === 4 && value === 4))
  tick(world, 7)
  assert.equal(world.getBlock(10, 6, 8), B.AIR)
  assert.equal(blasts, 1)
})

test('the shared explosion engine primes TNT, damages entities and emits physical block drops', () => {
  const { world } = makeWorld()
  const dropped = []
  const manager = new EntityManager(world, undefined, {
    blockExploded: (x, y, z, id) => dropped.push({ x, y, z, id })
  })
  const cow = manager.spawn('cow', 8.5, 5, 8.5)
  world.setBlock(8, 6, 8, B.TNT)
  world.setBlock(9, 6, 8, B.STONE)
  manager.explode(8.5, 6.5, 8.5, 4)
  // chained TNT may scatter into a free neighboring cell, so search the vicinity
  let primed = false
  for (let x = 7; x <= 9 && !primed; x++) for (let y = 6; y <= 7 && !primed; y++) for (let z = 7; z <= 9 && !primed; z++) {
    if (world.getBlock(x, y, z) === B.PRIMED_TNT) primed = true
  }
  assert.ok(primed)
  const survivor = manager.snapshots.find(entity => entity.id === cow.id)
  assert.ok(!survivor || survivor.health < cow.health)
  assert.ok(dropped.some(drop => drop.id === B.STONE))
})
