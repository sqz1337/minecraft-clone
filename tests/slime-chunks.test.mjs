import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { WorldGen, isSlimeChunkForSeed } from './src/world/WorldGen.ts'",
      "export { World } from './src/world/World.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'slime-chunks-test-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { WorldGen, World, isSlimeChunkForSeed } = bundledModule.exports

test('slime chunks match fixed Java-Random vectors for the current seed hash', () => {
  const gen = new WorldGen('slime-test')
  assert.equal(gen.seedNum, 157748150)

  const expected = new Set([
    '-1,-4', '-5,-3', '1,-2', '1,-1', '-1,0', '5,0',
    '-5,1', '5,1', '-4,2', '3,3', '4,5'
  ])
  const actual = new Set()
  for (let cz = -5; cz <= 5; cz++) {
    for (let cx = -5; cx <= 5; cx++) {
      if (gen.isSlimeChunk(cx, cz)) actual.add(`${cx},${cz}`)
    }
  }
  assert.deepEqual(actual, expected)
})

test('seed predicate handles signed chunk overflow and World delegates unchanged', () => {
  const gen = new WorldGen('slime-test')
  const vectors = [
    [-1, -4, true], [3, 3, true], [50000, -70000, false],
    [50028, -69972, true], [0x7fffffff, -0x80000000, true]
  ]
  for (const [cx, cz, expected] of vectors) {
    assert.equal(isSlimeChunkForSeed(gen.seedNum, cx, cz), expected)
    assert.equal(gen.isSlimeChunk(cx, cz), expected)
    assert.equal(World.prototype.isSlimeChunk.call({ gen }, cx, cz), expected)
  }
  assert.equal(isSlimeChunkForSeed(gen.seedNum, 0, 0), false)
})
