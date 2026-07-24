import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { chargedMeleeDamage, ATTACK_COOLDOWN } from './src/player/Combat.ts'",
      "export { vanillaBiomeInfo } from './src/world/VanillaBiomes.ts'",
      "export { VANILLA_BIOME } from './src/world/JavaGenLayer.ts'",
      "export { B, torchSelectionBox } from './src/world/Blocks.ts'",
      "export { addTorchModel, addChestModel, TexturedBoxBuilder } from './src/world/MesherModels.ts'",
      "export { GeomBuilder, classicLightBrightness, classicBlockLightColor } from './src/world/MesherShared.ts'",
      "export { facingOppositeLook } from './src/player/InteractionItems.ts'",
      "export { migrateLegacyChestFacings } from './src/world/WorldBlocks.ts'",
      "export { World } from './src/world/World.ts'",
      "export { Chunk, ChunkState } from './src/world/Chunk.ts'",
      "export { Materials } from './src/gfx/Materials.ts'"
    ].join(';'),
    resolveDir: process.cwd(),
    sourcefile: 'gameplay-polish-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" },
  logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule,
  bundledModule.exports
)

const {
  chargedMeleeDamage, ATTACK_COOLDOWN, vanillaBiomeInfo, VANILLA_BIOME,
  B, torchSelectionBox, addTorchModel, addChestModel, TexturedBoxBuilder, GeomBuilder,
  classicLightBrightness, classicBlockLightColor, facingOppositeLook,
  migrateLegacyChestFacings, World, Chunk, ChunkState, Materials
} = bundledModule.exports

test('modern sword recovery has weak spam and a full 1.6-speed charge', () => {
  assert.equal(ATTACK_COOLDOWN, 0.625)
  assert.equal(chargedMeleeDamage(10, 0), 2)
  assert.equal(chargedMeleeDamage(10, 0.5), 4)
  assert.equal(chargedMeleeDamage(10, 1), 10)
})

test('ocean and frozen-ocean surface replacements use sand', () => {
  for (const biome of [VANILLA_BIOME.OCEAN, VANILLA_BIOME.FROZEN_OCEAN]) {
    assert.equal(vanillaBiomeInfo(biome).top, B.SAND)
    assert.equal(vanillaBiomeInfo(biome).filler, B.SAND)
  }
})

test('water is opaque from land and only enables blending underwater', () => {
  const materials = new Materials({ colorTex: null, chestTex: null, largeChestTex: null })
  assert.equal(materials.water.transparent, false)
  assert.equal(materials.water.opacity, 1)
  materials.setWaterViewedFromUnderwater(true)
  assert.equal(materials.water.transparent, true)
  assert.equal(materials.water.opacity, 0.92)
  materials.setWaterViewedFromUnderwater(false)
  assert.equal(materials.water.transparent, false)
  assert.equal(materials.water.opacity, 1)
  for (const material of [
    materials.solid, materials.foliage, materials.glass, materials.emissive,
    materials.furnaceFire, materials.chest, materials.largeChest, materials.xrayOre,
    materials.water
  ]) material.dispose()
})

test('torch geometry uses classic full-tile cutouts, a cropped cap and a wall lean', () => {
  const atlas = { uvRect: () => [0, 0, 1, 1] }
  const bounds = facing => {
    const builder = new GeomBuilder()
    addTorchModel(builder, atlas, 0, 0, 0, facing, 14)
    const geometry = builder.build(false)
    const positions = geometry.getAttribute('position')
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    for (let i = 0; i < positions.count; i++) {
      box.minX = Math.min(box.minX, positions.getX(i))
      box.maxX = Math.max(box.maxX, positions.getX(i))
      box.minY = Math.min(box.minY, positions.getY(i))
      box.maxY = Math.max(box.maxY, positions.getY(i))
    }
    const result = {
      ...box,
      vertices: positions.count,
      triangles: geometry.getIndex().count / 3
    }
    geometry.dispose()
    return result
  }
  const floor = bounds(undefined)
  const eastWall = bounds(0)
  assert.equal(floor.vertices, 20)
  assert.equal(floor.triangles, 10)
  assert.equal(floor.maxX - floor.minX, 1)
  assert.ok(eastWall.maxX - eastWall.minX > 1.3)
  assert.ok(eastWall.maxY > floor.maxY)
})

test('torch selection bounds follow its real floor and wall-mounted shape', () => {
  assert.deepEqual(torchSelectionBox(undefined), {
    minX: 0.4, minY: 0, minZ: 0.4,
    maxX: 0.6, maxY: 0.6, maxZ: 0.6
  })
  assert.deepEqual(torchSelectionBox(0), {
    minX: 0, minY: 0.2, minZ: 0.35,
    maxX: 0.3, maxY: 0.8, maxZ: 0.65
  })
  assert.deepEqual(torchSelectionBox(5), {
    minX: 0.35, minY: 0.2, minZ: 0.7,
    maxX: 0.65, maxY: 0.8, maxZ: 1
  })
})

test('chest placement facing follows all four view directions', () => {
  assert.equal(facingOppositeLook(0, -1), 4)
  assert.equal(facingOppositeLook(-1, 0), 0)
  assert.equal(facingOppositeLook(0, 1), 5)
  assert.equal(facingOppositeLook(1, 0), 1)
  assert.equal(facingOppositeLook(-1, 0, 'z'), 4)
  assert.equal(facingOppositeLook(0, -1, 'x'), 0)
})

test('old edited chests without metadata migrate in place toward the saved player', () => {
  const index = (x, y, z) => (((x << 4) | z) << 7) | y
  const single = index(2, 64, 2)
  const doubleLeft = index(4, 64, 8)
  const doubleRight = index(5, 64, 8)
  const preserved = index(10, 64, 2)
  const edits = new Map([['0,0', new Map([
    [single, B.CHEST],
    [doubleLeft, B.CHEST],
    [doubleRight, B.CHEST],
    [preserved, B.CHEST]
  ])]])
  const facings = new Map([['0,0', new Map([[preserved, 1]])]])
  assert.equal(migrateLegacyChestFacings(edits, facings, 10.5, 2.5), 3)
  assert.equal(facings.get('0,0').get(single), 0)
  assert.equal(facings.get('0,0').get(doubleLeft), 5)
  assert.equal(facings.get('0,0').get(doubleRight), 5)
  assert.equal(facings.get('0,0').get(preserved), 1)
})

test('World.setBlock stores and serializes every explicit chest facing', () => {
  const world = Object.create(World.prototype)
  const chunk = new Chunk(0, 0)
  chunk.state = ChunkState.GENERATED
  world.chunks = new Map([[World.ck(0, 0), chunk]])
  world.cacheKey = NaN
  world.cacheChunk = undefined
  world.blockEdits = new Map()
  world.blockFacings = new Map()
  world.scheduledTicks = []
  world.scheduledTickIndex = new Map()
  world.simulationTick = 0
  world.dirtyChunkKeys = new Set()
  world.mutationBatchDepth = 0
  world.doorPairMutationDepth = 0
  world.onAutomaticBlockBreak = () => {}
  world.notifyBlockAndNeighbors = () => {}
  world.scheduleAdjacentDynamicTicks = () => {}
  world.refreshChangedBlock = () => {}
  world.settleFallingColumn = () => {}
  world.scheduleBlockTick = () => {}

  world.setBlock(3, 64, 3, B.CHEST, 0)
  world.setBlock(6, 64, 6, B.CHEST, 4)
  assert.equal(world.getBlockFacing(3, 64, 3), 0)
  assert.equal(world.getBlockFacing(6, 64, 6), 4)
  const serialized = world.serializeBlockFacings()['0,0']
  assert.deepEqual(serialized, [
    Chunk.index(3, 64, 3), 0,
    Chunk.index(6, 64, 6), 4
  ])
})

test('chest front geometry rotates to every stored facing', () => {
  const expectedNormals = new Map([
    [4, [0, 0, 1]],
    [5, [0, 0, -1]],
    [0, [1, 0, 0]],
    [1, [-1, 0, 0]]
  ])
  for (const [facing, expected] of expectedNormals) {
    const builder = new TexturedBoxBuilder()
    addChestModel(builder, 0, 0, 0, facing, false)
    const geometry = builder.build()
    const normals = geometry.getAttribute('normal')
    assert.deepEqual(
      [normals.getX(16), normals.getY(16), normals.getZ(16)].map(value => value || 0),
      expected
    )
    geometry.dispose()
  }
})

test('classic block-light channel is warm, nonlinear and independent of daylight', () => {
  assert.equal(classicLightBrightness(0), 0)
  assert.equal(classicLightBrightness(15), 1)
  assert.ok(classicLightBrightness(10) < 10 / 15)
  const medium = classicBlockLightColor(8)
  const torch = classicBlockLightColor(14)
  assert.ok(medium[0] > medium[1] && medium[1] > medium[2])
  assert.ok(torch.every(channel => channel > 0.97))
  assert.equal(torch[0], torch[1])
  assert.equal(torch[1], torch[2])
})

test('HUD attack sprites and classic chest-close sound are present', () => {
  const pngDimensions = path => {
    const bytes = readFileSync(path)
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  assert.deepEqual(
    pngDimensions('public/assets/minecraft/gui/crosshair_attack_indicator_background.png'),
    [16, 4]
  )
  assert.deepEqual(
    pngDimensions('public/assets/minecraft/gui/crosshair_attack_indicator_progress.png'),
    [16, 4]
  )
  assert.deepEqual(
    pngDimensions('public/assets/minecraft/gui/crosshair_attack_indicator_full.png'),
    [16, 16]
  )
  const closeSound = 'public/assets/minecraft/sound/random/chestclosed.ogg'
  assert.equal(existsSync(closeSound), true)
  assert.ok(statSync(closeSound).size > 1000)
})

test('sword right-click blocking is completely removed', () => {
  const hand = readFileSync('src/player/InteractionHand.ts', 'utf8')
  const interaction = readFileSync('src/player/Interaction.ts', 'utf8')
  const movement = readFileSync('src/player/PlayerMovement.ts', 'utf8')
  const lifecycle = readFileSync('src/core/GameLifecycle.ts', 'utf8')
  for (const source of [hand, interaction, movement, lifecycle]) {
    assert.doesNotMatch(source, /blockingSword|player\.blocking|this\.blocking|blocksAttackFrom/)
  }
  assert.doesNotMatch(hand, /hand\.rotation\.set\(-2\.01, 0\.38/)
})

test('chest lid animates on a rear local hinge without corrupting world facing', () => {
  const lighting = readFileSync('src/world/WorldLighting.ts', 'utf8')
  assert.match(lighting, /const pivot = new THREE\.Group\(\)/)
  assert.match(lighting, /pivot\.position\.z = -7 \/ 16/)
  assert.match(lighting, /pivot\.rotation\.x = -angle/)
  assert.match(lighting, /model\.pivot\.rotation\.x = -model\.angle/)
  assert.doesNotMatch(lighting, /group\.rotation\.x = -angle/)
  // The pair-only facing fixup must not run for single chests: `pair?.[0] !== 0`
  // is true when pair is undefined, which pinned every lone chest to facing 0.
  assert.doesNotMatch(lighting, /pair\?\.\[[01]\] !== 0/)
})

test('UI preserves Shift and exposes RMB crafting drag and corrected bubbles', () => {
  const game = readFileSync('src/core/Game.ts', 'utf8')
  const screens = readFileSync('src/ui/UIScreens.ts', 'utf8')
  const css = readFileSync('src/style.css', 'utf8')
  assert.match(game, /containerSlotClick\(index, button, shift\)/)
  assert.match(screens, /makeClickableSlot\(stack, index, this\.onCraftSlotClick, true\)/)
  assert.match(screens, /craftRightDragVisited/)
  assert.match(css, /\.status-icon\.air\.empty\s*\{\s*background-position:\s*-25px -18px/)
  assert.match(css, /\.status-icon\.air\.full\s*\{\s*background-position:\s*-16px -18px/)
  assert.doesNotMatch(css, /status-saturation/)
  assert.doesNotMatch(css, /attack-indicator\.full/)
  assert.match(css, /top:\s*calc\(50% \+ 24px\)/)
})
