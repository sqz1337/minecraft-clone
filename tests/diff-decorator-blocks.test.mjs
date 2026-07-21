import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { B, BLOCKS, CROSS, OPAQUE, ORE, RENDER_SHAPE, SOLID, TILE, blockCollisionBox, canSupportVine, isFlammable, isLeafBlock, isLogBlock, tileFor } from './src/world/Blocks.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { fuelSecondsFor, matchRecipe, smeltResultFor, smeltXpFor } from './src/world/Recipes.ts'",
      "export { additiveFortuneDropCount, fortuneDropCount } from './src/player/Enchantments.ts'",
      "export { Chunk, ChunkState } from './src/world/Chunk.ts'",
      "export { buildChunkGeoms } from './src/world/Mesher.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-decorator-blocks-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['three'],
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  B, BLOCKS, CROSS, OPAQUE, ORE, RENDER_SHAPE, SOLID, TILE,
  blockCollisionBox, canSupportVine, isFlammable, isLeafBlock, isLogBlock, tileFor,
  I, ITEMS, fuelSecondsFor, matchRecipe, smeltResultFor, smeltXpFor,
  additiveFortuneDropCount, fortuneDropCount, Chunk, ChunkState, buildChunkGeoms
} = mod.exports

test('decorator blocks append stable contiguous ids without renumbering monster eggs', () => {
  assert.deepEqual([
    B.INFESTED_STONE, B.INFESTED_COBBLESTONE, B.INFESTED_STONE_BRICK,
    B.REDSTONE_ORE, B.LAPIS_ORE, B.CLAY, B.DEAD_BUSH, B.CACTUS,
    B.WATER_LILY, B.VINE, B.BIRCH_LOG, B.BIRCH_LEAVES, B.SAPLING_BIRCH
  ], [88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100])
  assert.equal(BLOCKS.length, 116)
})

test('new block definitions carry classic mining, drops and render classifications', () => {
  assert.deepEqual({
    drop: BLOCKS[B.REDSTONE_ORE].dropItem,
    count: BLOCKS[B.REDSTONE_ORE].dropCount,
    xp: BLOCKS[B.REDSTONE_ORE].experience,
    level: BLOCKS[B.REDSTONE_ORE].miningLevel
  }, { drop: I.REDSTONE, count: [4, 5], xp: [0, 0], level: 2 })
  assert.equal(BLOCKS[B.REDSTONE_ORE].fortuneAffected, true)
  assert.equal(BLOCKS[B.REDSTONE_ORE].fortuneMode, 'additive')
  assert.equal(ORE[B.REDSTONE_ORE], true)

  assert.deepEqual({
    drop: BLOCKS[B.LAPIS_ORE].dropItem,
    count: BLOCKS[B.LAPIS_ORE].dropCount,
    xp: BLOCKS[B.LAPIS_ORE].experience,
    level: BLOCKS[B.LAPIS_ORE].miningLevel
  }, { drop: I.LAPIS, count: [4, 8], xp: [0, 0], level: 1 })
  assert.equal(BLOCKS[B.LAPIS_ORE].fortuneAffected, true)
  assert.equal(BLOCKS[B.LAPIS_ORE].fortuneMode, 'multiplier')
  assert.equal(ORE[B.LAPIS_ORE], true)

  assert.equal(BLOCKS[B.CLAY].dropItem, I.CLAY_BALL)
  assert.deepEqual(BLOCKS[B.CLAY].dropCount, [4, 4])
  assert.equal(BLOCKS[B.CLAY].tool, 'shovel')
  assert.equal(BLOCKS[B.DEAD_BUSH].dropItem, null)
  assert.equal(BLOCKS[B.VINE].dropItem, null)

  assert.deepEqual([
    RENDER_SHAPE[B.DEAD_BUSH], RENDER_SHAPE[B.CACTUS],
    RENDER_SHAPE[B.WATER_LILY], RENDER_SHAPE[B.VINE]
  ], ['cross', 'cactus', 'lily', 'vine'])
  assert.equal(SOLID[B.CACTUS], true)
  assert.equal(OPAQUE[B.CACTUS], false)
  assert.equal(CROSS[B.WATER_LILY], true)
  assert.equal(CROSS[B.VINE], true)
})

test('redstone, clay and metadata-free lapis items use stable ids and classic sprites', () => {
  assert.equal(I.REDSTONE, 331)
  assert.equal(I.BRICK, 336)
  assert.equal(I.CLAY_BALL, 337)
  assert.equal(I.LAPIS, 402)
  assert.deepEqual(ITEMS[I.REDSTONE].sprite, [8, 3])
  assert.deepEqual(ITEMS[I.BRICK].sprite, [6, 1])
  assert.deepEqual(ITEMS[I.CLAY_BALL].sprite, [9, 3])
  assert.deepEqual(ITEMS[I.LAPIS].sprite, [14, 8])
  assert.equal(ITEMS[I.BONE_MEAL].id, 351, 'bone meal keeps the existing metadata-free 351 slot')
})

test('terrain tiles preserve all documented classic source coordinates', () => {
  assert.equal(tileFor(B.REDSTONE_ORE, 0), TILE.REDSTONE_ORE)
  assert.equal(tileFor(B.LAPIS_ORE, 0), TILE.LAPIS_ORE)
  assert.deepEqual(BLOCKS[B.CACTUS].tiles, {
    side: TILE.CACTUS_SIDE, top: TILE.CACTUS_TOP, bottom: TILE.CACTUS_BOTTOM
  })
  assert.equal(tileFor(B.BIRCH_LOG, 0), TILE.BIRCH_LOG_SIDE)
  assert.equal(tileFor(B.BIRCH_LOG, 2), TILE.LOG_TOP)
  assert.equal(tileFor(B.BIRCH_LEAVES, 0), TILE.LEAVES)

  const atlas = readFileSync(new URL('../src/gfx/Atlas.ts', import.meta.url), 'utf8')
  for (const [coord, comment] of [
    ['3, 3', 'redstone ore'], ['0, 10', 'lapis lazuli ore'], ['8, 4', 'clay'],
    ['7, 3', 'dead bush'], ['6, 4', 'cactus side'], ['5, 4', 'cactus top'],
    ['7, 4', 'cactus bottom'], ['12, 4', 'lily pad'], ['15, 8', 'vines'],
    ['5, 7', 'birch log side'], ['15, 4', 'birch sapling']
  ]) assert.match(atlas, new RegExp(`\\[${coord}\\],?\\s*// ${comment}`))
})

test('birch wood participates in leaf, log and fire compatibility views', () => {
  assert.equal(isLogBlock(B.BIRCH_LOG), true)
  assert.equal(isLeafBlock(B.BIRCH_LEAVES), true)
  assert.equal(isFlammable(B.BIRCH_LOG), true)
  assert.equal(isFlammable(B.BIRCH_LEAVES), true)
  assert.equal(isFlammable(B.VINE), true)
  assert.equal(BLOCKS[B.SAPLING_BIRCH].cross, true)
  assert.deepEqual(matchRecipe([{ id: B.BIRCH_LOG, count: 1 }, null, null, null], 2), {
    id: B.PLANKS, count: 4
  })
  assert.equal(fuelSecondsFor(B.BIRCH_LOG), 15)
  assert.deepEqual(matchRecipe(Array(4).fill({ id: I.CLAY_BALL, count: 1 }), 2), {
    id: B.CLAY, count: 1
  })
  assert.deepEqual(smeltResultFor(I.CLAY_BALL), { id: I.BRICK, count: 1 })
  assert.equal(smeltXpFor(I.CLAY_BALL), 0.3)
  assert.deepEqual(matchRecipe(Array(4).fill({ id: I.BRICK, count: 1 }), 2), {
    id: B.BRICKS, count: 1
  })
})

test('special collision, support and Fortune rules use their classic bounded forms', () => {
  assert.deepEqual(blockCollisionBox(B.CACTUS), {
    minX: 1 / 16, minY: 0, minZ: 1 / 16, maxX: 15 / 16, maxY: 1, maxZ: 15 / 16
  })
  assert.deepEqual(blockCollisionBox(B.WATER_LILY), {
    minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1 / 64, maxZ: 1
  })
  assert.equal(canSupportVine(B.STONE), true)
  assert.equal(canSupportVine(B.GLASS), false)
  assert.equal(canSupportVine(B.CACTUS), false)
  assert.equal(canSupportVine(B.WOOD_DOOR_LOWER), false)
  assert.equal(additiveFortuneDropCount(5, 3, () => 0), 5)
  assert.equal(additiveFortuneDropCount(5, 3, () => 0.999999), 8)
  assert.equal(fortuneDropCount(5, 3, () => 0.999999), 20)
})

test('compass and clock consume the restored redstone item instead of the old flint placeholder', () => {
  const compassGrid = [
    null, { id: I.IRON_INGOT, count: 1 }, null,
    { id: I.IRON_INGOT, count: 1 }, { id: I.REDSTONE, count: 1 }, { id: I.IRON_INGOT, count: 1 },
    null, { id: I.IRON_INGOT, count: 1 }, null
  ]
  const clockGrid = [
    null, { id: I.GOLD_INGOT, count: 1 }, null,
    { id: I.GOLD_INGOT, count: 1 }, { id: I.REDSTONE, count: 1 }, { id: I.GOLD_INGOT, count: 1 },
    null, { id: I.GOLD_INGOT, count: 1 }, null
  ]
  assert.deepEqual(matchRecipe(compassGrid, 3), { id: I.COMPASS, count: 1 })
  assert.deepEqual(matchRecipe(clockGrid, 3), { id: I.CLOCK, count: 1 })
  compassGrid[4] = { id: I.FLINT, count: 1 }
  assert.equal(matchRecipe(compassGrid, 3), null)
})

function geometryFor(id, support = null) {
  const chunk = new Chunk(0, 0)
  chunk.state = ChunkState.GENERATED
  chunk.colBiome.fill(2)
  chunk.skyLight.fill(15)
  chunk.set(8, 64, 8, id)
  if (support) chunk.set(8 + support[0], 64 + (support[1] ?? 0), 8 + support[2], B.STONE)
  const world = {
    gen: { seedNum: 12345 },
    getChunk(cx, cz) { return cx === 0 && cz === 0 ? chunk : null },
    facingsForChunk() { return undefined }
  }
  const atlas = { uvRect: () => [0, 0, 1, 1] }
  return buildChunkGeoms(world, chunk, atlas, 1, false)
}

function positions(geometry) {
  return geometry.getAttribute('position')
}

test('mesher emits inset cactus, thin lily and a single attached vine face', () => {
  const cactus = positions(geometryFor(B.CACTUS).foliage)
  assert.equal(cactus.count, 24)
  const cactusXs = Array.from({ length: cactus.count }, (_, i) => cactus.getX(i))
  assert.equal(Math.min(...cactusXs), 8 + 1 / 16)
  assert.equal(Math.max(...cactusXs), 9 - 1 / 16)

  const lily = positions(geometryFor(B.WATER_LILY).foliage)
  assert.equal(lily.count, 4)
  assert.deepEqual([...new Set(Array.from({ length: lily.count }, (_, i) => lily.getY(i)))], [64 + 1 / 64])

  const vine = positions(geometryFor(B.VINE, [1, 0, 0]).foliage)
  assert.equal(vine.count, 4)
  assert.ok(Array.from({ length: vine.count }, (_, i) => vine.getX(i)).every(x => x > 8.9 && x < 9))

  assert.equal(positions(geometryFor(B.DEAD_BUSH).foliage).count, 8)
  assert.equal(positions(geometryFor(B.BIRCH_LEAVES).foliage).count, 24)
})
