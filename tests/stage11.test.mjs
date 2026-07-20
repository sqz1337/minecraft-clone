import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { WorldGen, BIOME } from './src/world/WorldGen.ts'",
      "export { Chunk } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { matchRecipe } from './src/world/Recipes.ts'",
      "export { rollLoot } from './src/world/Loot.ts'",
      "export { EntityManager, hostileSpawnAllowed } from './src/entities/EntityManager.ts'",
      "export { VILLAGER_PROFESSIONS } from './src/entities/EntityTypes.ts'",
      "export { VILLAGER_TRADES } from './src/entities/Trades.ts'",
      "export { WorldSaveStore } from './src/core/WorldSave.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'stage11-test-entry.ts', loader: 'ts'
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
  WorldGen, BIOME, Chunk, B, I, ITEMS, matchRecipe, rollLoot,
  EntityManager, hostileSpawnAllowed, VILLAGER_PROFESSIONS, VILLAGER_TRADES, WorldSaveStore
} = bundledModule.exports

function flatWorld(biome = BIOME.PLAINS) {
  return {
    getBlock(_x, y) { return Math.floor(y) <= 0 ? B.GRASS : B.AIR },
    isSolid(_x, y) { return Math.floor(y) <= 0 },
    isWater() { return false },
    topSolidY() { return 0 },
    biomeAt() { return biome },
    getLightLevel() { return 15 }
  }
}

test('every villager profession offers valid, affordable-by-stack trades', () => {
  assert.equal(ITEMS[I.EMERALD].name, 'Emerald')
  for (const profession of VILLAGER_PROFESSIONS) {
    const trades = VILLAGER_TRADES[profession]
    assert.ok(trades.length >= 2 && trades.length <= 3, `${profession} trade count`)
    for (const trade of trades) {
      for (const part of [trade.cost, trade.result]) {
        const item = ITEMS[part.id]
        assert.ok(item, `${profession}: unknown item id ${part.id}`)
        assert.ok(part.count >= 1 && part.count <= item.stackSize * 2, `${profession}: bad count for ${item.name}`)
      }
    }
    // every profession touches the emerald economy on both sides or at least one
    assert.ok(trades.some(trade => trade.cost.id === I.EMERALD || trade.result.id === I.EMERALD))
  }
})

test('stage 11 registers navigation, beds and structure blocks with recipes', () => {
  assert.equal(ITEMS[I.COMPASS].name, 'Compass')
  assert.equal(ITEMS[I.CLOCK].name, 'Clock')
  assert.equal(ITEMS[I.MAP].name, 'Map')
  assert.equal(ITEMS[I.BED].stackSize, 1)
  assert.equal(ITEMS[B.SPAWNER].placeBlock, B.SPAWNER)
  assert.equal(ITEMS[B.END_PORTAL_FRAME].placeBlock, B.END_PORTAL_FRAME)
  const stack = id => ({ id, count: 1 })
  assert.deepEqual(matchRecipe([
    stack(B.WOOL), stack(B.WOOL), stack(B.WOOL),
    stack(B.PLANKS), stack(B.PLANKS), stack(B.PLANKS),
    null, null, null
  ], 3), { id: I.BED, count: 1 })
})

test('strongholds, their chests and portal frames are deterministic and stamped', () => {
  const first = new WorldGen('stage-11-structures')
  const second = new WorldGen('stage-11-structures')
  assert.deepEqual(first.nearestStronghold(0, 0), second.nearestStronghold(0, 0))
  assert.equal(first.strongholds().length, 3)
  const plan = first.strongholds()[0]
  assert.equal(plan.framePositions.length, 12)
  assert.ok(plan.chests.length >= 4)

  const frame = plan.framePositions[0]
  const chunk = new Chunk(Math.floor(frame.x / 16), Math.floor(frame.z / 16))
  first.fillChunk(chunk)
  assert.equal(chunk.get((frame.x % 16 + 16) % 16, frame.y, (frame.z % 16 + 16) % 16), B.END_PORTAL_FRAME)

  const chest = plan.chests[0]
  const listed = first.structureChestsIn(Math.floor(chest.x / 16), Math.floor(chest.z / 16))
  assert.ok(listed.some(candidate => candidate.x === chest.x && candidate.y === chest.y && candidate.z === chest.z))
})

test('structure loot is stable by seed and location', () => {
  const a = rollLoot('dungeon', 12, 20, -7, 12345)
  const b = rollLoot('dungeon', 12, 20, -7, 12345)
  const c = rollLoot('dungeon', 13, 20, -7, 12345)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
  assert.ok(a.length >= 3 && a.every(stack => stack.slot >= 0 && stack.slot < 27 && ITEMS[stack.id]))
})

test('villagers and mushroom-island livestock are persistent mob types', () => {
  const manager = new EntityManager(flatWorld())
  const villager = manager.spawn('villager', 0.5, 1, 0.5, {
    persistent: true, profession: 'librarian', homeX: 0.5, homeZ: 0.5
  })
  const mooshroom = manager.spawn('mooshroom', 2.5, 1, 0.5)
  assert.equal(villager.profession, 'librarian')
  assert.equal(mooshroom.kind, 'mooshroom')
  const restored = new EntityManager(flatWorld())
  restored.restore(manager.serialize())
  assert.equal(restored.snapshots.find(entity => entity.kind === 'villager').profession, 'librarian')
  assert.deepEqual(VILLAGER_PROFESSIONS, ['farmer', 'librarian', 'blacksmith', 'butcher', 'priest'])
  assert.equal(hostileSpawnAllowed(0, 32, 0, BIOME.MUSHROOM), false)
})

test('bed respawn and one-shot structure state survive version-1 saves', () => {
  const memory = new Map()
  globalThis.localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value)
  }
  const store = new WorldSaveStore('stage-11-save')
  assert.equal(store.save({
    player: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flying: false, noclip: false,
      hotbarPage: 0, selectedSlot: 0, health: 20, hunger: 20, saturation: 5, air: 10,
      exhaustion: 0, experience: 0, respawnX: 8, respawnY: 65, respawnZ: -3 },
    gameMode: 'survival', inventory: Array(36).fill(null), armor: Array(4).fill(null), drops: [], containers: [],
    timeOfDay: 0.25, weather: { kind: 'clear', nextChange: 10, lightningTimer: 10, out: {} },
    blockEdits: {}, blockFacings: {}, scheduledTicks: [], entities: [],
    structureChests: ['1,20,3'], villageChunks: ['2,-4']
  }), true)
  const loaded = store.load()
  assert.deepEqual([loaded.player.respawnX, loaded.player.respawnY, loaded.player.respawnZ], [8, 65, -3])
  assert.deepEqual(loaded.structureChests, ['1,20,3'])
  assert.deepEqual(loaded.villageChunks, ['2,-4'])
})
