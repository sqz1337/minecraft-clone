import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { World } from './src/world/World.ts'",
      "export { Chunk, ChunkState } from './src/world/Chunk.ts'",
      "export { B, isWheat, wheatAge } from './src/world/Blocks.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { matchRecipe } from './src/world/Recipes.ts'",
      "export { Player } from './src/player/Player.ts'",
      "export { WorldSaveStore } from './src/core/WorldSave.ts'",
      "export { WorldGen, SEA_LEVEL } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(),
    sourcefile: 'stage6-test-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule,
  bundledModule.exports
)

const {
  World, Chunk, ChunkState, B, I, ITEMS, isWheat, wheatAge, matchRecipe,
  Player, WorldSaveStore, WorldGen, SEA_LEVEL
} = bundledModule.exports

function makeWorld() {
  const world = Object.create(World.prototype)
  const chunk = new Chunk(0, 0)
  chunk.state = ChunkState.GENERATED
  Object.assign(world, {
    gen: { seedNum: 1 },
    chunks: new Map([[0, chunk]]),
    blockEdits: new Map(),
    blockFacings: new Map(),
    editsDirty: false,
    scheduledTicks: [],
    simulationTick: 0,
    simulationAccumulator: 0,
    renderDistance: 4,
    grassDensity: 1,
    onAutomaticBlockBreak: () => {}
  })
  world.remeshChunk = () => {}
  return { world, chunk }
}

test('stage 6 item registry and bread recipe', () => {
  assert.equal(ITEMS[I.BREAD].food.hunger, 5)
  assert.equal(ITEMS[I.MUSHROOM_STEW].food.returnsItem, I.BOWL)
  const grid = Array(9).fill(null)
  grid[0] = { id: I.WHEAT, count: 1 }
  grid[1] = { id: I.WHEAT, count: 1 }
  grid[2] = { id: I.WHEAT, count: 1 }
  assert.deepEqual(matchRecipe(grid, 3), { id: I.BREAD, count: 1 })
  assert.equal(isWheat(B.WHEAT_4), true)
  assert.equal(wheatAge(B.WHEAT_4), 4)
})

test('farmland hydrates and bone meal advances persistent crop age', () => {
  const { world } = makeWorld()
  world.setBlock(5, 9, 5, B.DIRT)
  world.setBlock(6, 9, 5, B.WATER)
  world.setBlock(5, 9, 5, B.FARMLAND_DRY)
  world.randomTickBlock(5, 9, 5, B.FARMLAND_DRY)
  assert.equal(world.getBlock(5, 9, 5), B.FARMLAND_WET)
  world.setBlock(5, 10, 5, B.WHEAT_0)
  assert.equal(world.fertilize(5, 10, 5), true)
  assert.ok(wheatAge(world.getBlock(5, 10, 5)) >= 2)
  assert.equal(world.serializeBlockEdits()['0,0'].includes(world.getBlock(5, 10, 5)), true)
})

test('neighbor ticks remove unsupported crops and scheduled growth survives saving', () => {
  const { world } = makeWorld()
  world.setBlock(4, 9, 4, B.FARMLAND_WET)
  world.setBlock(4, 10, 4, B.WHEAT_0)
  world.setBlock(4, 9, 4, B.DIRT)
  world.tickSimulation(0.1, 4, 4)
  assert.equal(world.getBlock(4, 10, 4), B.AIR)

  world.setBlock(2, 9, 2, B.DIRT)
  world.setBlock(2, 10, 2, B.SAPLING_OAK)
  const serialized = world.serializeScheduledTicks()
  assert.ok(serialized.some((value, index) => index % 5 === 4 && value === 1))
})

test('skylight and torch light use the shared 0..15 voxel query', () => {
  const { world } = makeWorld()
  world.setBlock(8, 10, 8, B.TORCH)
  assert.equal(world.getSkyLight(8, 11, 8), 15)
  assert.equal(world.getBlockLight(8, 10, 8), 14)
  assert.equal(world.getBlockLight(9, 10, 8), 13)
  assert.equal(world.getLightLevel(9, 10, 8), 15)
})

test('fixed normal food balance restores hunger and saturation', () => {
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100)
  const player = new Player(camera, { getBlock: () => B.AIR }, { hurt: () => {} }, 'survival')
  player.restoreSurvival(10, 10, 0, 10, 0)
  assert.equal(player.eat(5, 0.6), true)
  assert.equal(player.hunger, 15)
  assert.equal(player.saturation, 6)
  player.hunger = 0
  player.health = 2
  player.updateSurvival(4.1, player.pos.x, player.pos.z)
  assert.equal(player.health, 1)
  player.updateSurvival(20, player.pos.x, player.pos.z)
  assert.equal(player.health, 1)
})

test('save round-trip keeps saturation and mandatory block ticks', () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  }
  const store = new WorldSaveStore('stage-6-save-test')
  assert.equal(store.save({
    player: {
      x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flying: false, noclip: false,
      hotbarPage: 0, selectedSlot: 0, health: 20, hunger: 12, saturation: 4,
      air: 10, exhaustion: 0
    },
    gameMode: 'survival',
    inventory: Array(36).fill(null),
    drops: [], containers: [], timeOfDay: 0.5,
    weather: { kind: 'clear', nextChange: 10, lightningTimer: 10, out: {} },
    blockEdits: {}, blockFacings: {}, scheduledTicks: [2, 65, 2, 400, 1]
  }), true)
  const restored = store.load()
  assert.equal(restored.player.saturation, 4)
  assert.deepEqual(restored.scheduledTicks, [2, 65, 2, 400, 1])
})

test('naturally generated sugar cane always has real water beside its support', () => {
  const gen = new WorldGen('stage-6-cane-regression')
  let caneBases = 0
  for (let cx = -4; cx <= 4; cx++) {
    for (let cz = -4; cz <= 4; cz++) {
      const chunk = new Chunk(cx, cz)
      gen.fillChunk(chunk)
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const wx = cx * 16 + lx, wz = cz * 16 + lz
          for (let y = 1; y < 128; y++) {
            if (chunk.get(lx, y, lz) !== B.SUGARCANE || chunk.get(lx, y - 1, lz) === B.SUGARCANE) continue
            caneBases++
            const supportY = y - 1
            assert.equal(supportY, SEA_LEVEL)
            const waterBeside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
              const neighborHeight = gen.columnInfo(wx + dx, wz + dz).height
              return neighborHeight < supportY && supportY <= SEA_LEVEL
            })
            assert.equal(waterBeside, true, `invalid cane base at ${wx},${supportY},${wz}`)
          }
        }
      }
    }
  }
  assert.ok(caneBases > 0)
})
