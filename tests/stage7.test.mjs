import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { buildSync } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager, PASSIVE_MOB_CAP, PASSIVE_DEFINITIONS } from './src/entities/EntityManager.ts'",
      "export { PASSIVE_KINDS } from './src/entities/EntityTypes.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { smeltResultFor } from './src/world/Recipes.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'",
      "export { WorldSaveStore } from './src/core/WorldSave.ts'"
    ].join(';'),
    resolveDir: process.cwd(),
    sourcefile: 'stage7-test-entry.ts',
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
  EntityManager, PASSIVE_MOB_CAP, PASSIVE_DEFINITIONS, PASSIVE_KINDS,
  I, ITEMS, smeltResultFor, B, BIOME, WorldSaveStore
} = bundledModule.exports

function flatWorld() {
  return {
    getBlock(x, y) { return Math.floor(y) === 0 ? B.GRASS : B.AIR },
    isSolid(_x, y) { return Math.floor(y) <= 0 },
    isWater() { return false },
    topSolidY() { return 0 },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return 15 }
  }
}

test('stage 7 registry provides animal products and cooked food', () => {
  assert.deepEqual(PASSIVE_KINDS, ['pig', 'cow', 'sheep', 'chicken'])
  assert.equal(PASSIVE_DEFINITIONS.cow.temptingItem, I.WHEAT)
  assert.equal(PASSIVE_DEFINITIONS.chicken.temptingItem, I.SEEDS)
  assert.equal(ITEMS[I.STEAK].food.hunger, 8)
  assert.deepEqual(smeltResultFor(I.RAW_PORKCHOP), { id: I.COOKED_PORKCHOP, count: 1 })
  assert.deepEqual(smeltResultFor(I.RAW_MUTTON), { id: I.COOKED_MUTTON, count: 1 })
})

test('animal renderer uses the bundled classic Minecraft mob skins', () => {
  const source = readFileSync(new URL('../src/entities/EntityRenderer.ts', import.meta.url), 'utf8')
  for (const texture of ['pig.png', 'cow.png', 'sheep.png', 'sheep_fur.png', 'chicken.png']) {
    assert.ok(existsSync(new URL(`../public/assets/minecraft/mob/${texture}`, import.meta.url)), `missing mob texture ${texture}`)
  }
  assert.ok(source.includes('assets/minecraft/mob/'))
  assert.ok(source.includes('`${kind}.png`'))
  assert.ok(source.includes("'sheep_fur.png'"))
  assert.equal(source.includes('const bodyTint'), false)
  assert.ok(source.includes('MOVE_SMOOTH_SECONDS'))
  assert.ok(source.includes('lerpVectors'))
})

test('audio uses original Minecraft samples without synthesized fallbacks', () => {
  const source = readFileSync(new URL('../src/audio/Audio.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('createOscillator'), false)
  assert.equal(source.includes('noiseBuf'), false)
  assert.equal(source.includes('private burst'), false)
  for (const asset of [
    'mob/pig/say1.ogg', 'mob/pig/death.ogg', 'mob/pig/step1.ogg',
    'mob/cow/say1.ogg', 'mob/cow/hurt1.ogg', 'mob/cow/step1.ogg',
    'mob/sheep/say1.ogg', 'mob/sheep/step1.ogg',
    'mob/chicken/say1.ogg', 'mob/chicken/hurt1.ogg', 'mob/chicken/step1.ogg',
    'mob/chicken/plop.ogg', 'random/break.ogg'
  ]) {
    assert.ok(existsSync(new URL(`../public/assets/minecraft/sound/${asset}`, import.meta.url)), `missing sound ${asset}`)
  }
})

test('spatial lookup returns nearby entities and enforces the passive cap', () => {
  const manager = new EntityManager(flatWorld())
  const cow = manager.spawn('cow', 1, 1, 1)
  manager.spawn('pig', 40, 1, 40)
  assert.ok(cow)
  assert.deepEqual(manager.queryRadius(0, 1, 0, 4).map(entity => entity.id), [cow.id])
  for (let i = manager.count; i < PASSIVE_MOB_CAP; i++) manager.spawn('sheep', i, 1, 0)
  assert.equal(manager.count, PASSIVE_MOB_CAP)
  assert.equal(manager.spawn('chicken', 0, 1, 0), null)
})

test('ray hit, health, knockback, death and guaranteed drops share one entity path', () => {
  const drops = []
  const manager = new EntityManager(flatWorld(), undefined, {
    drop: (id, x, y, z, count) => drops.push({ id, x, y, z, count })
  })
  const chicken = manager.spawn('chicken', 0, 1, -2)
  const hit = manager.raycast(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, -1), 5)
  assert.equal(hit.entity.id, chicken.id)
  assert.ok(hit.distance < 3)
  assert.equal(manager.damage(chicken.id, 5, 0, 0), true)
  assert.equal(manager.count, 1)
  assert.equal(manager.snapshots[0].health, 0)
  assert.ok(manager.snapshots[0].hurtTime > 0)
  assert.ok(manager.snapshots[0].deathTime > 0)
  assert.equal(drops.length, 0)
  for (let i = 0; i < 15; i++) manager.update(0.05, { player: { x: 0, y: 1, z: 0 }, heldItem: null })
  assert.equal(manager.count, 0)
  assert.ok(drops.some(drop => drop.id === I.RAW_CHICKEN && drop.count === 1))
})

test('moving passive entities emit original step sound events', () => {
  const sounds = []
  const manager = new EntityManager(flatWorld(), undefined, {
    sound: (kind, event) => sounds.push(`${kind}:${event}`)
  })
  manager.spawn('cow', 0, 1, 0)
  for (let i = 0; i < 12; i++) {
    manager.update(0.05, { player: { x: 4, y: 1, z: 0 }, heldItem: I.WHEAT })
  }
  assert.ok(sounds.includes('cow:step'))
})

test('crowded animals share a short step-sound gate instead of stacking every sample', () => {
  const sounds = []
  const manager = new EntityManager(flatWorld(), undefined, {
    sound: (kind, event) => sounds.push(`${kind}:${event}`)
  })
  for (let i = 0; i < 12; i++) manager.spawn('cow', (i % 4) * 0.8, 1, Math.floor(i / 4) * 0.8)
  for (let i = 0; i < 40; i++) {
    manager.update(0.05, { player: { x: 5, y: 1, z: 1 }, heldItem: I.WHEAT })
  }
  const steps = sounds.filter(sound => sound.endsWith(':step'))
  assert.ok(steps.length > 0)
  assert.ok(steps.length <= 20, `too many overlapping step sounds: ${steps.length}`)
})

test('feeding two adults creates one persistent growing baby', () => {
  const manager = new EntityManager(flatWorld())
  const first = manager.spawn('cow', 0, 1, 0)
  const second = manager.spawn('cow', 6, 1, 0)
  assert.equal(manager.feed(first.id, I.WHEAT), true)
  assert.equal(manager.feed(second.id, I.WHEAT), true)
  for (let i = 0; i < 20 && manager.count === 2; i++) {
    manager.update(0.05, { player: { x: 3, y: 1, z: 0 }, heldItem: null })
  }
  assert.equal(manager.count, 3)
  const family = manager.snapshots
  assert.equal(family.filter(entity => entity.age < 0).length, 1)
  assert.equal(family.filter(entity => entity.breedCooldown > 0).length, 2)
})

test('entities escape embedded blocks and step over a full one-block obstacle', () => {
  const obstacleWorld = {
    getBlock(x, y, z) {
      if (Math.floor(y) === 0) return B.GRASS
      return Math.floor(x) === 1 && Math.floor(y) === 1 && Math.floor(z) === 0 ? B.STONE : B.AIR
    },
    isSolid(x, y, z) {
      return Math.floor(y) <= 0 ||
        (Math.floor(x) === 1 && Math.floor(y) === 1 && Math.floor(z) === 0)
    },
    isWater() { return false },
    topSolidY(x, z) { return Math.floor(x) === 1 && Math.floor(z) === 0 ? 1 : 0 },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return 15 }
  }

  const embeddedManager = new EntityManager(obstacleWorld)
  embeddedManager.spawn('cow', 1.5, 1, 0.5)
  embeddedManager.update(0.05, { player: { x: 3, y: 1, z: 0.5 }, heldItem: I.WHEAT })
  assert.ok(embeddedManager.snapshots[0].y >= 2, 'embedded cow was not lifted out of terrain')

  const stepManager = new EntityManager(obstacleWorld)
  stepManager.spawn('cow', 0.25, 1, 0.5)
  for (let i = 0; i < 30; i++) {
    stepManager.update(0.05, { player: { x: 3.5, y: 1, z: 0.5 }, heldItem: I.WHEAT })
  }
  assert.ok(stepManager.snapshots[0].x > 1.5, 'cow did not cross a one-block step')
})

test('serialization preserves stable ids, age and cooldown with validation', () => {
  const manager = new EntityManager(flatWorld())
  const sheep = manager.spawn('sheep', 3, 1, 4, { baby: true, persistent: true, id: 'stable-sheep' })
  const saved = manager.serialize()
  const restored = new EntityManager(flatWorld())
  restored.restore([...saved, { ...saved[0], id: 'invalid', kind: 'dragon' }])
  assert.equal(restored.count, 1)
  assert.equal(restored.snapshots[0].id, 'stable-sheep')
  assert.equal(restored.snapshots[0].kind, sheep.kind)
  assert.ok(restored.snapshots[0].age < 0)
})

test('world save round-trip keeps entity state and rejects duplicate ids', () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  }
  const entity = {
    id: 'cow-a', kind: 'cow', x: 3, y: 64, z: 4,
    vx: 0, vy: 0, vz: 0, yaw: 1, health: 8, age: 0,
    breedCooldown: 12, eggTimer: 0
  }
  const store = new WorldSaveStore('stage-7-save-test')
  assert.equal(store.save({
    player: {
      x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flying: false, noclip: false,
      hotbarPage: 0, selectedSlot: 0, health: 20, hunger: 20, saturation: 5,
      air: 10, exhaustion: 0
    },
    gameMode: 'survival', inventory: Array(36).fill(null), drops: [], containers: [],
    timeOfDay: 0.5, weather: { kind: 'clear', nextChange: 10, lightningTimer: 10, out: {} },
    blockEdits: {}, blockFacings: {}, scheduledTicks: [], entities: [entity, entity]
  }), true)
  const loaded = store.load()
  assert.equal(loaded.entities.length, 1)
  assert.deepEqual(loaded.entities[0], entity)
})
