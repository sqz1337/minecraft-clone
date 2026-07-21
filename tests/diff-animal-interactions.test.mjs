import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { buildSync } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager } from './src/entities/EntityManager.ts'",
      "export { Interaction } from './src/player/Interaction.ts'",
      "export { Inventory } from './src/player/Inventory.ts'",
      "export { Player } from './src/player/Player.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { B, SOLID } from './src/world/Blocks.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-animal-interactions-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { EntityManager, Interaction, Inventory, Player, I, B, SOLID, ITEMS, BIOME } = bundledModule.exports

function flatWorld() {
  return {
    getBlock(_x, y) { return Math.floor(y) <= 0 ? B.GRASS : B.AIR },
    isSolid(x, y, z) { return !!SOLID[this.getBlock(x, y, z)] },
    isWater() { return false },
    topSolidY() { return 0 },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return 15 },
    getSkyLight() { return 15 },
    getBlockLight() { return 0 }
  }
}

function context(player) {
  return { player, playerTargetable: false, heldItem: null, skyDarkness: 0 }
}

function withRandom(value, action) {
  const original = Math.random
  Math.random = () => value
  try { return action() } finally { Math.random = original }
}

function interactionHarness(manager) {
  const inventory = new Inventory()
  const drops = []
  const ridePoses = []
  const interaction = Object.assign(Object.create(Interaction.prototype), {
    selected: 0,
    mode: 'survival',
    inventory,
    entities: manager,
    drops: { spawn: (id, x, y, z, count) => drops.push({ id, x, y, z, count }) },
    player: { syncRidingPose: pose => ridePoses.push(pose) },
    audio: { breakBlock() {}, toolBreak() {} },
    handSwing: 0,
    placing: true,
    placeCooldown: 0
  })
  return { interaction, inventory, drops, ridePoses }
}

test('pig saddle is consumed, saved, restored and riding remains autonomous', () => {
  const world = flatWorld()
  const manager = new EntityManager(world)
  const pig = withRandom(0.5, () => manager.spawn('pig', 0.5, 1.01, 0.5))
  assert.ok(pig)

  const { interaction, inventory, ridePoses } = interactionHarness(manager)
  inventory.restore([{ id: I.SADDLE, count: 1 }])
  assert.equal(interaction.useEntityInteraction(pig.id), true)
  assert.equal(inventory.slots[0], null)
  assert.equal(manager.snapshotById(pig.id).saddled, true)

  const saved = manager.serialize()
  assert.equal(saved[0].saddled, true)
  const restored = new EntityManager(world)
  restored.restore(saved)
  assert.equal(restored.snapshotById(pig.id).saddled, true)

  assert.equal(interaction.useEntityInteraction(pig.id), true)
  assert.equal(manager.riderPose.id, pig.id)
  assert.equal(ridePoses.at(-1).id, pig.id)

  const startX = manager.snapshotById(pig.id).x
  manager.damage(pig.id, 1, 3.5, 0.5, 0)
  withRandom(0.5, () => {
    for (let tick = 0; tick < 12; tick++) {
      const pose = manager.riderPose
      manager.update(0.05, context({ x: pose.x, y: pose.y, z: pose.z }))
    }
  })
  assert.ok(manager.snapshotById(pig.id).x < startX - 0.1, 'ridden pig should keep its panic/wander navigation')
  assert.equal(manager.riderPose.x, manager.snapshotById(pig.id).x)

  assert.equal(interaction.useEntityInteraction(pig.id), true)
  assert.equal(manager.riderPose, null)
  assert.equal(ridePoses.at(-1), null)
})

test('cow and mooshroom container interactions replace exactly one held container', () => {
  assert.equal(ITEMS[I.SADDLE].stackSize, 1)
  assert.equal(ITEMS[I.MILK_BUCKET].stackSize, 1)
  const manager = new EntityManager(flatWorld())
  const cow = manager.spawn('cow', 0.5, 1.01, 0.5)
  const mooshroom = manager.spawn('mooshroom', 4.5, 1.01, 0.5)
  assert.ok(cow && mooshroom)
  const { interaction, inventory } = interactionHarness(manager)

  inventory.restore([{ id: I.BUCKET, count: 2 }])
  assert.equal(interaction.useEntityInteraction(cow.id), true)
  assert.equal(inventory.slots[0].id, I.BUCKET)
  assert.equal(inventory.slots[0].count, 1)
  assert.ok(inventory.slots.some(stack => stack?.id === I.MILK_BUCKET && stack.count === 1))

  inventory.restore([{ id: I.BOWL, count: 2 }])
  assert.equal(interaction.useEntityInteraction(mooshroom.id), true)
  assert.equal(inventory.slots[0].id, I.BOWL)
  assert.equal(inventory.slots[0].count, 1)
  assert.ok(inventory.slots.some(stack => stack?.id === I.MUSHROOM_STEW && stack.count === 1))
})

test('mooshroom shears into cow and returns exactly five red mushrooms', () => {
  const manager = new EntityManager(flatWorld())
  const mooshroom = manager.spawn('mooshroom', 0.5, 1.01, 0.5)
  assert.ok(mooshroom)
  const { interaction, inventory, drops } = interactionHarness(manager)
  inventory.restore([{ id: I.SHEARS, count: 1 }])

  assert.equal(interaction.useEntityInteraction(mooshroom.id), true)
  assert.equal(manager.snapshotById(mooshroom.id).kind, 'cow')
  assert.deepEqual(drops.map(({ id, count }) => ({ id, count })), [{ id: B.MUSHROOM_RED, count: 5 }])
  assert.equal(inventory.slots[0].damage, 1)
  assert.equal(manager.interact(mooshroom.id, I.SHEARS), null)
})

test('typed shear result preserves sheep behavior and prevents double shearing', () => {
  const manager = new EntityManager(flatWorld())
  const sheep = manager.spawn('sheep', 0.5, 1.01, 0.5)
  assert.ok(sheep)
  const result = withRandom(0, () => manager.interact(sheep.id, I.SHEARS))
  assert.deepEqual(result, {
    type: 'shear', drops: [{ id: B.WOOL, count: 1 }], damageTool: true
  })
  assert.equal(manager.snapshotById(sheep.id).sheared, true)
  assert.equal(manager.interact(sheep.id, I.SHEARS), null)
})

test('milk clears implemented status effects and riding pins the player to the pig pose', () => {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100)
  const audio = new Proxy({}, { get: () => () => {} })
  const player = new Player(camera, flatWorld(), audio, 'survival')
  player.teleport(0.5, 1.01, 0.5)
  player.applyFoodEffect('poison', 5)
  player.applyFoodEffect('hunger', 30)
  player.clearEffects()
  for (let tick = 0; tick < 30; tick++) player.update(0.05)
  assert.equal(player.health, 20)
  assert.equal(player.exhaustion, 0)

  player.syncRidingPose({ id: 'pig', x: 7, y: 2, z: -3, yaw: 0, height: 0.9 })
  assert.equal(player.ridingEntityId, 'pig')
  player.update(0.05)
  assert.deepEqual(player.pos.toArray(), [7, 2 + 0.9 * 0.72, -3])
  player.syncRidingPose(null)
  assert.equal(player.ridingEntityId, null)
})

test('renderer has a saddle layer and rebuilds a transformed entity view by kind', () => {
  const source = readFileSync(new URL('../src/entities/EntityRenderer.ts', import.meta.url), 'utf8')
  assert.ok(existsSync(new URL('../public/assets/minecraft/mob/saddle.png', import.meta.url)))
  assert.ok(source.includes("'saddle.png'"))
  assert.ok(source.includes('saddle.visible = entity.saddled'))
  assert.ok(source.includes('view.kind !== entity.kind'))
})
