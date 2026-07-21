import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { waterCellHeight } from './src/player/Player.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'render-regressions-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { waterCellHeight, B } = bundledModule.exports

test('only the top water cell has a lowered surface', () => {
  assert.equal(waterCellHeight(B.WATER, B.WATER), 1)
  assert.equal(waterCellHeight(B.WATER, B.AIR), 0.875)
  assert.equal(waterCellHeight(B.WATER_4, B.WATER), 1)
  assert.equal(waterCellHeight(B.AIR, B.WATER), 0)
})
