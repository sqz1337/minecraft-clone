import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const bundle = buildSync({
  stdin: {
    contents: "export { createExtrudedItemGeometry, setExtrudedItemUv } from './src/gfx/HeldItemGeometry.ts'; export { vanillaHeldModelName } from './src/gfx/VanillaHeldItems.ts'; export { ITEMS } from './src/world/Items.ts'",
    resolveDir: process.cwd(), sourcefile: 'held-item-test-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { createExtrudedItemGeometry, setExtrudedItemUv, vanillaHeldModelName, ITEMS } = bundledModule.exports

test('held sprite geometry has front, back and 16 pixel edge strips', () => {
  const geometry = createExtrudedItemGeometry(0.32)
  const positions = geometry.getAttribute('position')
  assert.equal(positions.count, (2 + 16 * 4) * 4)
  assert.equal(geometry.getIndex().count, (2 + 16 * 4) * 6)

  const zs = Array.from({ length: positions.count }, (_, i) => positions.getZ(i))
  assert.ok(Math.max(...zs) > 0)
  assert.ok(Math.min(...zs) < 0)
  assert.equal(Number((Math.max(...zs) - Math.min(...zs)).toFixed(4)), 0.02)
})

test('animated item atlas cells remap every face without rebuilding geometry', () => {
  const geometry = createExtrudedItemGeometry(0.32)
  const source = geometry.getAttribute('spriteUv')
  const uv = geometry.getAttribute('uv')
  setExtrudedItemUv(geometry, [0.25, 0.5, 0.3125, 0.5625])

  for (let i = 0; i < uv.count; i++) {
    assert.equal(uv.getX(i), 0.25 + source.getX(i) * 0.0625)
    assert.equal(uv.getY(i), 0.5 + source.getY(i) * 0.0625)
  }
})

test('project item keys resolve to official vanilla held-item model names', () => {
  const byKey = Object.fromEntries(ITEMS.filter(Boolean).map(item => [item.key, item]))
  assert.equal(vanillaHeldModelName(byKey.diamond_axe), 'diamond_axe')
  assert.equal(vanillaHeldModelName(byKey.wood_sword), 'wooden_sword')
  assert.equal(vanillaHeldModelName(byKey.gold_pickaxe), 'golden_pickaxe')
  assert.equal(vanillaHeldModelName(byKey.raw_beef), 'beef')
  assert.equal(vanillaHeldModelName(byKey.leather_head), 'leather_helmet')
  assert.equal(vanillaHeldModelName(byKey.bed), null)
})

test('every mapped held item has its extracted vanilla JSON and layer0 PNG', () => {
  const itemRoot = join(process.cwd(), 'public', 'assets', 'minecraft')
  const names = ITEMS.filter(item => item?.sprite).map(vanillaHeldModelName).filter(Boolean)
  names.push('bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2')
  for (const name of new Set(names)) {
    const modelPath = join(itemRoot, 'models', 'item', `${name}.json`)
    assert.ok(existsSync(modelPath), `missing model ${name}`)
    const model = JSON.parse(readFileSync(modelPath, 'utf8'))
    const texture = model.textures?.layer0?.replace(/^minecraft:item\//, '').replace(/^item\//, '')
    assert.ok(texture, `missing layer0 in ${name}`)
    assert.ok(existsSync(join(itemRoot, 'textures', 'item', `${texture}.png`)), `missing texture ${texture}`)
  }
})
