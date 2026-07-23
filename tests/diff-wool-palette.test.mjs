import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { B, BLOCKS, TILE, WOOL_BLOCKS, isFlammable, isWoolBlock, tileFor, woolBlockForColor, woolColorForBlock } from './src/world/Blocks.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ANY_WOOL, ingredientMatches, matchRecipe } from './src/world/Recipes.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-wool-palette-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  B, BLOCKS, TILE, WOOL_BLOCKS, isFlammable, isWoolBlock, tileFor,
  woolBlockForColor, woolColorForBlock, ITEMS, I, ANY_WOOL, ingredientMatches, matchRecipe
} = mod.exports

const COLORS = [
  B.WOOL, B.WOOL_ORANGE, B.WOOL_MAGENTA, B.WOOL_LIGHT_BLUE,
  B.WOOL_YELLOW, B.WOOL_LIME, B.WOOL_PINK, B.WOOL_GRAY,
  B.WOOL_LIGHT_GRAY, B.WOOL_CYAN, B.WOOL_PURPLE, B.WOOL_BLUE,
  B.WOOL_BROWN, B.WOOL_GREEN, B.WOOL_RED, B.WOOL_BLACK
]

test('all sixteen wool colors have stable metadata-free ids and round-trip helpers', () => {
  assert.equal(B.WOOL, 65, 'the persisted white-wool id must remain unchanged')
  assert.deepEqual(COLORS.slice(1), Array.from({ length: 15 }, (_, index) => 101 + index))
  assert.deepEqual(WOOL_BLOCKS, COLORS)
  assert.equal(BLOCKS.length, 117)

  COLORS.forEach((id, color) => {
    assert.equal(woolBlockForColor(color), id)
    assert.equal(woolColorForBlock(id), color)
    assert.equal(isWoolBlock(id), true)
  })
  assert.equal(woolColorForBlock(B.STONE), null)
  assert.equal(isWoolBlock(B.STONE), false)
  assert.throws(() => woolBlockForColor(-1), RangeError)
  assert.throws(() => woolBlockForColor(16), RangeError)
  assert.throws(() => woolBlockForColor(1.5), RangeError)
})

test('colored wool definitions retain classic cloth behavior and distinct atlas tiles', () => {
  const tiles = COLORS.map(id => tileFor(id, 0))
  assert.deepEqual(tiles, [TILE.WOOL, ...Array.from({ length: 15 }, (_, index) => 105 + index)])
  assert.equal(new Set(tiles).size, 16)

  for (const id of COLORS) {
    const definition = BLOCKS[id]
    assert.equal(definition.hardness, 0.8)
    assert.equal(definition.sound, 'cloth')
    assert.equal(definition.solid, true)
    assert.equal(definition.opaque, true)
    assert.equal(definition.dropItem, id)
    assert.equal(definition.hasItem, true)
    assert.equal(isFlammable(id), true)
    assert.equal(ITEMS[id].placeBlock, id)
  }

  assert.deepEqual(
    COLORS.slice(1).map(id => BLOCKS[id].name),
    ['Orange Wool', 'Magenta Wool', 'Light Blue Wool', 'Yellow Wool', 'Lime Wool',
      'Pink Wool', 'Gray Wool', 'Light Gray Wool', 'Cyan Wool', 'Purple Wool',
      'Blue Wool', 'Brown Wool', 'Green Wool', 'Red Wool', 'Black Wool']
  )
})

test('the atlas uses the fifteen original BlockCloth cells in metadata order', () => {
  const atlas = readFileSync(new URL('../src/gfx/Atlas.ts', import.meta.url), 'utf8')
  const expected = [
    ['2, 13', 'orange'], ['2, 12', 'magenta'], ['2, 11', 'light blue'],
    ['2, 10', 'yellow'], ['2, 9', 'lime'], ['2, 8', 'pink'], ['2, 7', 'gray'],
    ['1, 14', 'light gray'], ['1, 13', 'cyan'], ['1, 12', 'purple'],
    ['1, 11', 'blue'], ['1, 10', 'brown'], ['1, 9', 'green'],
    ['1, 8', 'red'], ['1, 7', 'black']
  ]
  for (const [coordinate, color] of expected) {
    assert.match(atlas, new RegExp(`\\[${coordinate}\\],?\\s*// ${color} wool`))
  }
})

test('generic wool recipes accept mixed colors while string still crafts white wool', () => {
  for (const id of COLORS) assert.equal(ingredientMatches(ANY_WOOL, id), true)
  assert.equal(ingredientMatches(ANY_WOOL, B.PLANKS), false)

  const stack = id => ({ id, count: 1 })
  assert.deepEqual(matchRecipe([
    stack(B.WOOL_RED), stack(B.WOOL_BLUE), stack(B.WOOL_BLACK),
    stack(B.PLANKS), stack(B.PLANKS), stack(B.PLANKS),
    null, null, null
  ], 3), { id: I.BED, count: 1 })

  assert.deepEqual(matchRecipe([
    stack(I.STRING), stack(I.STRING),
    stack(I.STRING), stack(I.STRING)
  ], 2), { id: B.WOOL, count: 1 })
})
