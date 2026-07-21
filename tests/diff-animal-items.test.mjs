import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { rollLoot } from './src/world/Loot.ts'",
      "export { vanillaHeldModelName } from './src/gfx/VanillaHeldItems.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-animal-items-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { I, ITEMS, rollLoot, vanillaHeldModelName } = bundledModule.exports

test('classic animal-support items keep their canonical ids and items.png cells', () => {
  const expected = [
    ['SADDLE', 329, [8, 6], 1],
    ['SNOWBALL', 332, [14, 0], 16],
    ['MILK_BUCKET', 335, [13, 4], 1],
    ['RAW_FISH', 349, [9, 5], 64],
    ['INK_SAC', 403, [14, 4], 64]
  ]
  for (const [key, id, sprite, stackSize] of expected) {
    assert.equal(I[key], id)
    assert.deepEqual(ITEMS[id].sprite, sprite)
    assert.equal(ITEMS[id].stackSize, stackSize)
  }
})

test('raw fish has the classic food values and unsupported held models stay on sprite rendering', () => {
  assert.deepEqual(ITEMS[I.RAW_FISH].food, {
    hunger: 2, saturation: 0.1, useSeconds: 1.6, returnsItem: null
  })
  for (const id of [I.SADDLE, I.SNOWBALL, I.MILK_BUCKET, I.RAW_FISH, I.INK_SAC]) {
    assert.equal(vanillaHeldModelName(ITEMS[id]), null)
  }
})

test('classic dungeon loot can roll a single saddle', () => {
  let saddle = null
  for (let seed = 0; seed < 512 && !saddle; seed++) {
    saddle = rollLoot('dungeon', 12, 24, -7, seed).find(stack => stack.id === I.SADDLE) ?? null
  }
  assert.ok(saddle, 'expected at least one deterministic dungeon roll to contain a saddle')
  assert.equal(saddle.count, 1)
})
