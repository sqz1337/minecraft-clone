import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { WorldGen, CURRENT_WORLD_GEN_VERSION, SEA_LEVEL } from './src/world/WorldGen.ts'",
      "export { Chunk } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-worldgen-decorators-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  mod, mod.exports
)
const { WorldGen, CURRENT_WORLD_GEN_VERSION, SEA_LEVEL, Chunk, B } = mod.exports

function count(chunk, id) {
  let result = 0
  for (const block of chunk.blocks) if (block === id) result++
  return result
}

test('v3 integrates exact ores and decorator blocks while the frozen v2 baseline does not', () => {
  assert.equal(CURRENT_WORLD_GEN_VERSION, 3)
  const oldGenerator = new WorldGen('stage14-9', 2)
  const newGenerator = new WorldGen('stage14-9', 3)
  assert.equal(SEA_LEVEL, 63)
  assert.equal(oldGenerator.seaLevel, 40)
  assert.equal(newGenerator.seaLevel, 63)
  const oldChunk = new Chunk(0, 0), newChunk = new Chunk(0, 0)
  oldGenerator.fillChunk(oldChunk)
  newGenerator.fillChunk(newChunk)

  for (const id of [B.REDSTONE_ORE, B.LAPIS_ORE, B.CLAY, B.DEAD_BUSH, B.CACTUS,
    B.WATER_LILY, B.VINE, B.BIRCH_LOG, B.BIRCH_LEAVES]) {
    assert.equal(count(oldChunk, id), 0, `v2 unexpectedly generated block ${id}`)
  }
  let birch = 0, clay = count(newChunk, B.CLAY)
  let redstone = count(newChunk, B.REDSTONE_ORE), lapis = count(newChunk, B.LAPIS_ORE)
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    if (cx === 0 && cz === 0) continue
    const chunk = new Chunk(cx, cz)
    newGenerator.fillChunk(chunk)
    birch += count(chunk, B.BIRCH_LOG) + count(chunk, B.BIRCH_LEAVES)
    clay += count(chunk, B.CLAY)
    redstone += count(chunk, B.REDSTONE_ORE)
    lapis += count(chunk, B.LAPIS_ORE)
  }
  assert.ok(redstone > 0)
  assert.ok(lapis > 0)
  assert.ok(clay > 0, 'underwater decorator attempts must reach a clay patch')
  assert.ok(birch > 0, 'the weighted forest selector must reach the full birch generator')
})

test('the complete v3 population pipeline is independent of neighbouring chunk order', () => {
  const forward = new WorldGen('stage14-order', 3)
  const reverse = new WorldGen('stage14-order', 3)
  const forwardLeft = new Chunk(-1, -1), forwardRight = new Chunk(0, -1)
  const reverseLeft = new Chunk(-1, -1), reverseRight = new Chunk(0, -1)
  forward.fillChunk(forwardLeft)
  forward.fillChunk(forwardRight)
  reverse.fillChunk(reverseRight)
  reverse.fillChunk(reverseLeft)
  assert.deepEqual(forwardLeft.blocks, reverseLeft.blocks)
  assert.deepEqual(forwardRight.blocks, reverseRight.blocks)
  assert.deepEqual(forwardLeft.colBiome, reverseLeft.colBiome)
  assert.deepEqual(forwardRight.colHeight, reverseRight.colHeight)
})
