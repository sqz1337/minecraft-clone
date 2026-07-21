import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { buildSync } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'

const bundle = buildSync({
  stdin: {
    contents: [
      "export * from './src/player/Combat.ts'",
      "export { Equipment } from './src/player/Equipment.ts'",
      "export { EntityManager, HOSTILE_DEFINITIONS, HOSTILE_MOB_CAP, hostileSpawnAllowed } from './src/entities/EntityManager.ts'",
      "export { ProjectileManager } from './src/entities/ProjectileManager.ts'",
      "export { HOSTILE_KINDS } from './src/entities/EntityTypes.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS, durabilityForItem } from './src/world/Items.ts'",
      "export { matchRecipe } from './src/world/Recipes.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'",
      "export { WorldSaveStore } from './src/core/WorldSave.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'stage8-test-entry.ts', loader: 'ts'
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
  meleeDamage, damageAfterArmor, bowPower, bowDamage, bowPullSprite, bowVelocity, explosionDamage,
  Equipment, EntityManager, HOSTILE_DEFINITIONS, HOSTILE_MOB_CAP, hostileSpawnAllowed, ProjectileManager,
  HOSTILE_KINDS, I, ITEMS, durabilityForItem, matchRecipe, B, BIOME, WorldSaveStore
} = bundledModule.exports

function flatWorld() {
  const edits = new Map()
  return {
    edits,
    getBlock(x, y, z) { return edits.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? (Math.floor(y) === 0 ? B.GRASS : B.AIR) },
    setBlock(x, y, z, id) { edits.set(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`, id) },
    isSolid(x, y, z) { return this.getBlock(x, y, z) !== B.AIR },
    isWater() { return false }, topSolidY() { return 0 }, biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return 0 }, getSkyLight() { return 15 }, getBlockLight() { return 0 }
  }
}

test('stage 8 registers combat drops, bows and four complete armor tiers', () => {
  assert.deepEqual(HOSTILE_KINDS, [
    'zombie', 'skeleton', 'spider', 'creeper', 'slime', 'enderman', 'silverfish'
  ])
  assert.equal(ITEMS[I.BOW].ranged, 'bow')
  assert.equal(durabilityForItem(I.BOW), 384)
  assert.equal(ITEMS[I.DIAMOND_CHESTPLATE].armor.points, 8)
  assert.equal(ITEMS[I.IRON_BOOTS].armor.slot, 'feet')
  assert.ok(HOSTILE_DEFINITIONS.creeper.drops.some(drop => drop.id === I.GUNPOWDER))
  assert.ok(HOSTILE_DEFINITIONS.enderman.drops.some(drop => drop.id === I.ENDER_PEARL))

  const arrowGrid = Array(9).fill(null)
  arrowGrid[0] = { id: I.FLINT, count: 1 }
  arrowGrid[3] = { id: I.STICK, count: 1 }
  arrowGrid[6] = { id: I.FEATHER, count: 1 }
  assert.deepEqual(matchRecipe(arrowGrid, 3), { id: I.ARROW, count: 4 })
})

test('melee criticals, armor, bow charge and explosion falloff are deterministic', () => {
  assert.equal(meleeDamage(I.DIAMOND_SWORD, false), 7)
  assert.equal(meleeDamage(I.DIAMOND_SWORD, true), 10)
  assert.equal(damageAfterArmor(10, 0), 10)
  assert.equal(damageAfterArmor(10, 20), 2)
  assert.equal(bowPower(0), 0)
  assert.equal(bowPower(1), 1)
  assert.ok(bowVelocity(1) > bowVelocity(0.2))
  assert.equal(bowDamage(1), 9)
  assert.deepEqual(bowPullSprite(null), [5, 1])
  assert.deepEqual(bowPullSprite(0), [6, 1])
  assert.deepEqual(bowPullSprite(0.4), [7, 1])
  assert.deepEqual(bowPullSprite(1), [8, 1])
  assert.ok(explosionDamage(0, 4) > explosionDamage(3, 4))
  // vanilla range is 2×power blocks
  assert.ok(explosionDamage(6, 4) > 0)
  assert.equal(explosionDamage(8, 4), 0)
})

test('hostile spawn rules enforce real light, distance, biome and mob cap', () => {
  assert.equal(hostileSpawnAllowed(7, 28, 0, BIOME.PLAINS), true)
  assert.equal(hostileSpawnAllowed(8, 28, 0, BIOME.PLAINS), false)
  assert.equal(hostileSpawnAllowed(7, 12, 0, BIOME.PLAINS), false)
  assert.equal(hostileSpawnAllowed(7, 28, 0, BIOME.OCEAN), true)
  assert.equal(hostileSpawnAllowed(7, 28, 0, BIOME.MUSHROOM), false)
  assert.equal(hostileSpawnAllowed(7, 28, HOSTILE_MOB_CAP, BIOME.FOREST), false)
})

test('equipment enforces slots, totals armor and breaks worn pieces', () => {
  const equipment = new Equipment()
  equipment.restore([
    { id: I.DIAMOND_HELMET, count: 1 }, { id: I.DIAMOND_CHESTPLATE, count: 1 },
    { id: I.DIAMOND_LEGGINGS, count: 1 }, { id: I.DIAMOND_BOOTS, count: 1 }
  ])
  assert.equal(equipment.armorPoints, 20)
  assert.equal(equipment.accepts(0, { id: I.DIAMOND_BOOTS, count: 1 }), false)
  equipment.slots[0].damage = ITEMS[I.DIAMOND_HELMET].armor.durability - 1
  equipment.damageAll()
  assert.equal(equipment.slots[0], null)
  assert.equal(equipment.armorPoints, 17)
})

test('hostiles share caps, melee/ranged AI, sunlight and creeper explosions', () => {
  const world = flatWorld()
  const hits = [], shots = [], explosions = []
  const manager = new EntityManager(world, undefined, {
    damagePlayer: (amount, x, z, knockback) => { hits.push({ amount, x, z, knockback }); return true },
    shootProjectile: (...args) => shots.push(args), explosion: (...args) => explosions.push(args)
  })
  manager.spawn('zombie', 0.8, 1, 0)
  manager.update(0.05, { player: { x: 0, y: 1, z: 0 }, heldItem: null, skyDarkness: 15 })
  assert.equal(hits[0].amount, 3)

  manager.spawn('skeleton', 8, 1, 0)
  manager.update(0.05, { player: { x: 0, y: 1, z: 0 }, heldItem: null, skyDarkness: 15 })
  assert.ok(shots.length > 0)

  const sunZombie = manager.spawn('zombie', 20, 1, 0)
  for (let i = 0; i < 21; i++) manager.update(0.05, { player: { x: 40, y: 1, z: 0 }, heldItem: null, skyDarkness: 0 })
  assert.ok(manager.snapshots.find(entity => entity.id === sunZombie.id).health < 20)

  manager.spawn('creeper', 1.8, 1, 2)
  for (let i = 0; i < 34; i++) manager.update(0.05, { player: { x: 0, y: 1, z: 2 }, heldItem: null, skyDarkness: 15 })
  assert.ok(explosions.length > 0)

  const capped = new EntityManager(flatWorld())
  for (let i = 0; i < HOSTILE_MOB_CAP; i++) assert.ok(capped.spawn('zombie', i, 1, 0))
  assert.equal(capped.spawn('skeleton', 0, 1, 0), null)
})

test('shared projectile path hits entities and sticks in blocks', () => {
  const world = flatWorld()
  const manager = new EntityManager(world)
  const zombie = manager.spawn('zombie', 0, 1, -3)
  const projectiles = new ProjectileManager(world, manager)
  projectiles.shoot(new THREE.Vector3(0, 1.8, 0), new THREE.Vector3(0, 0, -1), 18, 5, 'player')
  for (let i = 0; i < 10 && projectiles.snapshots.length; i++) projectiles.update(0.05, { x: 20, y: 1, z: 20 })
  assert.equal(manager.snapshots.find(entity => entity.id === zombie.id).health, 15)

  world.setBlock(0, 1, -2, B.STONE)
  projectiles.shoot(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, -1), 12, 3, 'mob')
  for (let i = 0; i < 10; i++) projectiles.update(0.05, { x: 20, y: 1, z: 20 })
  assert.ok(projectiles.snapshots.some(projectile => projectile.stuck))
})

test('save validation round-trips armor and hostile state', () => {
  const storage = new Map()
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  const store = new WorldSaveStore('stage-8-save-test')
  const entity = { id: 'creeper-a', kind: 'creeper', x: 3, y: 64, z: 4, vx: 0, vy: 0, vz: 0, yaw: 1,
    health: 20, age: 0, breedCooldown: 0, eggTimer: 0, attackCooldown: 0, fuse: 0.7, angryTime: 0 }
  const enderman = { id: 'enderman-a', kind: 'enderman', x: 6, y: 64, z: 4, vx: 0, vy: 0, vz: 0, yaw: 0,
    health: 40, age: 0, breedCooldown: 0, eggTimer: 0, carriedBlock: B.DIRT }
  assert.equal(store.save({
    player: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flying: false, noclip: false, hotbarPage: 0,
      selectedSlot: 0, health: 20, hunger: 20, saturation: 5, air: 10, exhaustion: 0 },
    gameMode: 'survival', inventory: Array(36).fill(null),
    armor: [{ id: I.IRON_HELMET, count: 1, damage: 2 }, null, null, null],
    drops: [], containers: [], timeOfDay: 0.5,
    weather: { kind: 'clear', nextChange: 10, lightningTimer: 10, out: {} },
    blockEdits: {}, blockFacings: {}, scheduledTicks: [], entities: [entity, enderman]
  }), true)
  const loaded = store.load()
  assert.equal(loaded.armor[0].id, I.IRON_HELMET)
  assert.equal(loaded.entities[0].kind, 'creeper')
  assert.equal(loaded.entities[0].fuse, 0.7)
  assert.equal(loaded.entities[1].health, 40)
  assert.equal(loaded.entities[1].carriedBlock, B.DIRT)
})

test('hostile renderer uses bundled classic mob textures', () => {
  const source = readFileSync(new URL('../src/entities/EntityRenderer.ts', import.meta.url), 'utf8')
  for (const texture of ['zombie.png', 'skeleton.png', 'spider.png', 'creeper.png', 'slime.png', 'enderman.png']) {
    assert.ok(existsSync(new URL(`../public/assets/minecraft/mob/${texture}`, import.meta.url)), `missing ${texture}`)
    assert.ok(source.includes(texture))
  }
})
