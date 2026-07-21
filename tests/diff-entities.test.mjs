import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager } from './src/entities/EntityManager.ts'",
      "export { Equipment } from './src/player/Equipment.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-entities-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { EntityManager, Equipment, I, B, BIOME } = bundledModule.exports

function voxelWorld() {
  const blocks = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    blocks,
    setBlock(x, y, z, id) { blocks.set(key(x, y, z), id) },
    getBlock(x, y, z) { return blocks.get(key(x, y, z)) ?? (Math.floor(y) <= 0 ? B.GRASS : B.AIR) },
    isSolid(x, y, z) {
      const id = this.getBlock(x, y, z)
      return id !== B.AIR && id !== B.WATER
    },
    isWater(x, y, z) { return this.getBlock(x, y, z) === B.WATER },
    topSolidY() { return 0 },
    biomeAt() { return BIOME.OCEAN },
    getLightLevel() { return 0 },
    getSkyLight() { return 0 },
    getBlockLight() { return 0 }
  }
}

function context(player, extra = {}) {
  return { player, playerTargetable: true, heldItem: null, skyDarkness: 15, ...extra }
}

function disableNaturalSpawns(manager) {
  manager.spawnTimer = Number.POSITIVE_INFINITY
}

test('hostiles acquire only targetable players in range and line of sight', () => {
  const world = voxelWorld()
  const manager = new EntityManager(world)
  disableNaturalSpawns(manager)
  const zombie = manager.spawn('zombie', 0.5, 1, 0.5)

  manager.update(0.05, context({ x: 4.5, y: 1, z: 0.5 }, { playerTargetable: false }))
  assert.equal(manager.snapshotById(zombie.id).targetId, null)

  for (let z = -20; z <= 20; z++) for (let y = 1; y <= 3; y++) world.setBlock(2, y, z, B.STONE)
  for (let i = 0; i < 20; i++) manager.update(0.05, context({ x: 4.5, y: 1, z: 0.5 }))
  assert.equal(manager.snapshotById(zombie.id).targetId, null)

  for (let z = -20; z <= 20; z++) for (let y = 1; y <= 3; y++) world.setBlock(2, y, z, B.AIR)
  for (let i = 0; i < 20 && !manager.snapshotById(zombie.id).targetId; i++) {
    manager.update(0.05, context({ x: 4.5, y: 1, z: 0.5 }))
  }
  assert.equal(manager.snapshotById(zombie.id).targetId, 'player')
})

test('target memory follows the last visible position and expires after about 60 unseen ticks', () => {
  const world = voxelWorld()
  const manager = new EntityManager(world)
  disableNaturalSpawns(manager)
  const zombie = manager.spawn('zombie', 0.5, 1, 0.5)
  manager.update(0.05, context({ x: 4.5, y: 1, z: 0.5 }))
  assert.equal(manager.snapshotById(zombie.id).targetId, 'player')

  for (let z = -20; z <= 20; z++) for (let y = 1; y <= 3; y++) world.setBlock(2, y, z, B.STONE)
  // Moving far away behind cover must not leak the hidden live distance into continuation.
  const hiddenPlayer = { x: 100.5, y: 1, z: 0.5 }
  for (let i = 0; i < 60; i++) manager.update(0.05, context(hiddenPlayer))
  const remembered = manager.snapshotById(zombie.id)
  assert.equal(remembered.targetId, 'player')
  assert.deepEqual(remembered.lastSeenPosition, { x: 4.5, y: 1, z: 0.5 })

  manager.update(0.05, context(hiddenPlayer))
  assert.equal(manager.snapshotById(zombie.id).targetId, null)
})

test('enderman stare needs five visible checks and a pumpkin blocks it', () => {
  const world = voxelWorld()
  const manager = new EntityManager(world)
  disableNaturalSpawns(manager)
  const enderman = manager.spawn('enderman', 0.5, 1, -6)
  const player = { x: 0.5, y: 1, z: 0.5 }
  const dy = (1 + 2.9 * 0.85) - (1 + 1.8 * 0.85)
  const dz = -6.5
  const length = Math.hypot(dy, dz)
  const look = { x: 0, y: dy / length, z: dz / length }

  for (let i = 0; i < 4; i++) manager.update(0.05, context(player, { look }))
  assert.equal(manager.snapshotById(enderman.id).targetId, null)
  manager.update(0.05, context(player, { look }))
  assert.equal(manager.snapshotById(enderman.id).targetId, 'player')

  const masked = new EntityManager(voxelWorld())
  disableNaturalSpawns(masked)
  const calm = masked.spawn('enderman', 0.5, 1, -6)
  for (let i = 0; i < 10; i++) masked.update(0.05, context(player, { look, headItem: B.PUMPKIN }))
  assert.equal(masked.snapshotById(calm.id).targetId, null)

  const untargetable = new EntityManager(voxelWorld())
  disableNaturalSpawns(untargetable)
  const ignored = untargetable.spawn('enderman', 0.5, 1, -6)
  for (let i = 0; i < 5; i++) {
    untargetable.update(0.05, context(player, { look, playerTargetable: false }))
  }
  for (let i = 0; i < 20; i++) {
    untargetable.update(0.05, context(player, { look: { x: 0, y: 0, z: 1 } }))
  }
  assert.equal(untargetable.snapshotById(ignored.id).targetId, null)
})

test('pumpkins are wearable in the head slot and survive equipment restore', () => {
  const equipment = new Equipment()
  assert.equal(equipment.accepts(0, { id: B.PUMPKIN, count: 1 }), true)
  assert.equal(equipment.accepts(1, { id: B.PUMPKIN, count: 1 }), false)
  equipment.restore([{ id: B.PUMPKIN, count: 1 }, null, null, null])
  assert.equal(equipment.slots[0].id, B.PUMPKIN)
  assert.equal(equipment.armorPoints, 0)
})

test('shared spawn validation checks complete width, height, floor, fluids and entity overlap', () => {
  const world = voxelWorld()
  const manager = new EntityManager(world)
  disableNaturalSpawns(manager)

  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5), true)
  world.setBlock(0, 1, 0, B.WATER)
  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5), false, 'fluid in body volume')
  world.setBlock(0, 1, 0, B.AIR)

  world.setBlock(0, 3, 0, B.STONE)
  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5), true, 'short mob fits below ceiling')
  assert.equal(manager.canSpawnEntity('enderman', 0.5, 1, 0.5), false, 'enderman needs third block of headroom')
  world.setBlock(0, 3, 0, B.AIR)

  world.setBlock(-1, 1, 0, B.STONE)
  assert.equal(manager.canSpawnEntity('spider', 0.5, 1, 0.5), false, 'wide spider intersects side block')
  world.setBlock(-1, 1, 0, B.AIR)

  world.setBlock(0, 0, 0, B.AIR)
  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5), false, 'solid floor is required')
  world.setBlock(0, 0, 0, B.GRASS)

  const first = manager.spawn('zombie', 0.5, 1, 0.5)
  assert.ok(first)
  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5), false, 'living AABB overlap')
  assert.equal(manager.spawn('zombie', 0.5, 1, 0.5), null)
})

test('restore rejects entities whose saved AABB is embedded in terrain', () => {
  const world = voxelWorld()
  const source = new EntityManager(world)
  const cow = source.spawn('cow', 4.5, 1, 0.5)
  const [saved] = source.serialize()
  world.setBlock(0, 1, 0, B.STONE)

  const restored = new EntityManager(world)
  restored.restore([{ ...saved, id: cow.id, x: 0.5, y: 1, z: 0.5 }])
  assert.equal(restored.count, 0)
})

test('validated slime splitting finds supported child volumes', () => {
  const manager = new EntityManager(voxelWorld())
  disableNaturalSpawns(manager)
  const slime = manager.spawn('slime', 0.5, 1, 0.5)
  manager.damage(slime.id, 100, 0.5, 0.5)
  for (let i = 0; i < 15; i++) manager.update(0.05, context({ x: 50, y: 1, z: 0.5 }))
  const children = manager.snapshots.filter(entity => entity.kind === 'slime')
  assert.ok(children.length >= 2 && children.length <= 4)
  assert.ok(children.every(child => child.sizeScale === 0.5))
})

test('failed breeding keeps love state and cooldown until a baby can spawn safely', () => {
  const world = voxelWorld()
  world.setBlock(-1, 0, 0, B.AIR)
  world.setBlock(0, 0, 0, B.AIR)
  const manager = new EntityManager(world)
  disableNaturalSpawns(manager)
  const first = manager.spawn('cow', -2, 1, 0.5)
  const second = manager.spawn('cow', 2, 1, 0.5)
  manager.feed(first.id, I.WHEAT)
  manager.feed(second.id, I.WHEAT)
  manager.update(0.05, context({ x: 20, y: 1, z: 20 }))

  assert.equal(manager.count, 2)
  assert.ok(manager.snapshots.every(entity => entity.loveTime > 0 && entity.breedCooldown === 0))
})

test('natural and spawner candidates apply their own light, biome and surface rules', () => {
  const world = voxelWorld()
  let blockLight = 0
  let biome = BIOME.PLAINS
  world.biomeAt = () => biome
  world.getLightLevel = () => 15
  world.getBlockLight = () => blockLight
  const manager = new EntityManager(world)
  const natural = {
    source: 'natural', player: { x: 30.5, y: 1, z: 0.5 },
    worldSpawn: { x: -30.5, y: 1, z: 0.5 }, darkness: 15
  }

  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5, natural), true)
  blockLight = 8
  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5, natural), false)
  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5, { source: 'spawner', darkness: 15 }), false)
  blockLight = 0
  biome = BIOME.OCEAN
  assert.equal(manager.canSpawnEntity('zombie', 0.5, 1, 0.5, natural), true)
  biome = BIOME.PLAINS
  assert.equal(manager.canSpawnEntity('cow', 0.5, 1, 0.5, natural), true)
  biome = BIOME.MUSHROOM
  assert.equal(manager.canSpawnEntity('cow', 0.5, 1, 0.5, natural), false)
})
