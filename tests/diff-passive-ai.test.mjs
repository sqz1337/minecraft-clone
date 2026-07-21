import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager } from './src/entities/EntityManager.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { B, SOLID } from './src/world/Blocks.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-passive-ai-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const { EntityManager, I, B, SOLID, BIOME } = mod.exports

function voxelWorld() {
  const blocks = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    blocks,
    setBlock(x, y, z, id) { blocks.set(key(x, y, z), id) },
    getBlock(x, y, z) {
      const position = key(x, y, z)
      return blocks.has(position) ? blocks.get(position) : Math.floor(y) <= 0 ? B.GRASS : B.AIR
    },
    isSolid(x, y, z) { return !!SOLID[this.getBlock(x, y, z)] },
    isWater(x, y, z) { return this.getBlock(x, y, z) === B.WATER },
    topSolidY(x, z) {
      for (let y = 127; y >= 0; y--) if (this.isSolid(x, y, z)) return y
      return -1
    },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return 15 },
    getSkyLight() { return 15 },
    getBlockLight() { return 0 }
  }
}

function context(player, extra = {}) {
  return {
    player,
    playerTargetable: false,
    heldItem: null,
    skyDarkness: 0,
    ...extra
  }
}

function tick(manager, count, updateContext) {
  for (let i = 0; i < count; i++) manager.update(0.05, updateContext)
}

function withRandom(value, action) {
  const original = Math.random
  Math.random = () => value
  try { return action() } finally { Math.random = original }
}

function withRandomValues(values, action, fallback = 0.5) {
  const original = Math.random
  let index = 0
  Math.random = () => values[index++] ?? fallback
  try { return action() } finally { Math.random = original }
}

test('swimming outranks panic, mating and temptation for passive animals', () => {
  const world = voxelWorld()
  world.setBlock(0, 1, 0, B.WATER)
  const manager = new EntityManager(world)
  const cow = withRandom(0.5, () => manager.spawn('cow', 0.5, 1, 0.5, {
    bypassPositionValidation: true
  }))
  assert.ok(cow)
  assert.equal(manager.feed(cow.id, I.WHEAT), true)
  assert.equal(manager.damage(cow.id, 1, 3.5, 0.5, 0), true)

  const tempted = context({ x: 4.5, y: 1, z: 0.5 }, {
    heldItem: I.WHEAT,
    look: { x: -1, y: 0, z: 0 }
  })
  // Physics discovers water after the first AI pass; the next pass must run swim.
  withRandom(0.5, () => tick(manager, 2, tempted))
  const snapshot = manager.snapshotById(cow.id)
  assert.equal(snapshot.inWater, true)
  assert.equal(snapshot.activeTask, 'swim')
  assert.ok(snapshot.vy > 0, 'swimming task should add upward motion')
})

test('panic remembers the damage source instead of fleeing the current player', () => {
  const manager = new EntityManager(voxelWorld())
  const cow = withRandom(0.5, () => manager.spawn('cow', 0.5, 1, 0.5))
  assert.ok(cow)
  // Damage comes from the east, while the player subsequently stands west.
  assert.equal(manager.damage(cow.id, 1, 3.5, 0.5, 0), true)
  const startX = manager.snapshotById(cow.id).x
  withRandom(0.5, () => tick(manager, 12, context({ x: -8.5, y: 1, z: 0.5 })))
  const fleeing = manager.snapshotById(cow.id)
  assert.equal(fleeing.activeTask, 'panic')
  assert.ok(fleeing.x < startX - 0.1,
    `cow should flee west from the east-side hit source, moved from ${startX} to ${fleeing.x}`)
})

test('temptation requires line of sight and a reachable path', () => {
  const player = { x: 6.5, y: 1, z: 0.5 }

  const blockedWorld = voxelWorld()
  for (let z = -32; z <= 32; z++) {
    blockedWorld.setBlock(2, 1, z, B.STONE)
    blockedWorld.setBlock(2, 2, z, B.STONE)
  }
  const blockedManager = new EntityManager(blockedWorld)
  const blockedCow = withRandom(0.5, () => blockedManager.spawn('cow', 0.5, 1, 0.5))
  withRandom(0.5, () => tick(blockedManager, 4, context(player, { heldItem: I.WHEAT })))
  assert.notEqual(blockedManager.snapshotById(blockedCow.id).activeTask, 'tempt',
    'a cow must not be tempted through an opaque wall')

  const trenchWorld = voxelWorld()
  for (let x = 1; x <= 4; x++) {
    for (let z = -32; z <= 32; z++) trenchWorld.setBlock(x, 0, z, B.AIR)
  }
  const trenchManager = new EntityManager(trenchWorld)
  const strandedCow = withRandom(0.5, () => trenchManager.spawn('cow', 0.5, 1, 0.5))
  withRandom(0.5, () => tick(trenchManager, 4, context(player, { heldItem: I.WHEAT })))
  assert.notEqual(trenchManager.snapshotById(strandedCow.id).activeTask, 'tempt',
    'visible food must not start temptation when navigation cannot reach it')

  const openManager = new EntityManager(voxelWorld())
  const openCow = withRandom(0.5, () => openManager.spawn('cow', 0.5, 1, 0.5))
  withRandom(0.5, () => tick(openManager, 4, context(player, { heldItem: I.WHEAT })))
  assert.equal(openManager.snapshotById(openCow.id).activeTask, 'tempt')
})

test('abrupt player movement cancels temptation and starts a cooldown', () => {
  const manager = new EntityManager(voxelWorld())
  const cow = withRandom(0.5, () => manager.spawn('cow', 0.5, 1, 0.5))
  const initial = context({ x: 4.5, y: 1, z: 0.5 }, {
    heldItem: I.WHEAT,
    look: { x: -1, y: 0, z: 0 }
  })
  withRandom(0.5, () => tick(manager, 3, initial))
  assert.equal(manager.snapshotById(cow.id).activeTask, 'tempt')

  const jerked = context({ x: 5.5, y: 1, z: 0.5 }, {
    heldItem: I.WHEAT,
    look: { x: 0, y: 0, z: 1 }
  })
  withRandom(0.5, () => manager.update(0.05, jerked))
  assert.notEqual(manager.snapshotById(cow.id).activeTask, 'tempt')
  withRandom(0.5, () => tick(manager, 20, jerked))
  assert.notEqual(manager.snapshotById(cow.id).activeTask, 'tempt',
    'temptation should not restart immediately after an abrupt move/look change')
})

test('a baby follows a nearby adult of the same species', () => {
  const manager = new EntityManager(voxelWorld())
  const baby = withRandom(0.5, () => manager.spawn('pig', 0.5, 1, 0.5, { baby: true }))
  const adult = withRandom(0.5, () => manager.spawn('pig', 8.5, 1, 0.5))
  assert.ok(baby && adult)
  const before = Math.abs(adult.x - baby.x)
  withRandom(0.5, () => tick(manager, 20, context({ x: -40, y: 1, z: -40 })))
  const babyAfter = manager.snapshotById(baby.id)
  const adultAfter = manager.snapshotById(adult.id)
  assert.equal(babyAfter.activeTask, 'follow_parent')
  assert.ok(Math.abs(adultAfter.x - babyAfter.x) < before - 0.5,
    'the baby should close distance to its parent candidate')
})

test('watch-player and idle-look remain distinct observable tasks', () => {
  const manager = new EntityManager(voxelWorld())
  const cow = withRandom(0.5, () => manager.spawn('cow', 0.5, 1, 0.5))
  // Skip the 1/80 wander roll, then accept the 1/40 watch-player roll.
  withRandomValues([0.5, 0, 0.5], () => manager.update(0.05,
    context({ x: 4.5, y: 1, z: 0.5 })))
  assert.equal(manager.snapshotById(cow.id).activeTask, 'watch')

  withRandom(0.5, () => manager.update(0.05, context({ x: 30, y: 1, z: 30 })))
  assert.equal(manager.snapshotById(cow.id).activeTask, 'idle')
})

test('fed adults require mutual roughly 60-tick courtship before breeding', () => {
  const manager = new EntityManager(voxelWorld())
  const first = withRandom(0.5, () => manager.spawn('cow', 0.5, 1, 0.5))
  const second = withRandom(0.5, () => manager.spawn('cow', 3.5, 1, 0.5))
  assert.ok(first && second)
  assert.equal(manager.feed(first.id, I.WHEAT), true)
  assert.equal(manager.feed(second.id, I.WHEAT), true)
  const away = context({ x: 30, y: 1, z: 30 })

  withRandom(0.5, () => tick(manager, 59, away))
  assert.equal(manager.count, 2, 'breeding must not happen before courtship completes')
  assert.ok(manager.snapshots.every(entity => entity.activeTask === 'mate'))

  withRandom(0.5, () => {
    for (let i = 0; i < 6 && manager.count === 2; i++) manager.update(0.05, away)
  })
  assert.equal(manager.count, 3, 'a mutually courting pair should produce one baby near tick 60')
  assert.equal(manager.snapshots.filter(entity => entity.age < 0).length, 1)
  assert.equal(manager.snapshots.filter(entity => entity.breedCooldown > 0).length, 2)
})

test('unsheared sheep eat grass and eating accelerates baby growth', () => {
  const adultWorld = voxelWorld()
  const adultManager = new EntityManager(adultWorld)
  const adult = withRandom(0, () => adultManager.spawn('sheep', 0.5, 1, 0.5))
  let adultTicks = 0
  let sawAdultEatTask = false
  withRandom(0, () => {
    while (adultTicks < 100 && adultWorld.getBlock(0, 0, 0) === B.GRASS) {
      adultManager.update(0.05, context({ x: 30, y: 1, z: 30 }))
      adultTicks++
      sawAdultEatTask ||= adultManager.snapshotById(adult.id).activeTask === 'eat_grass'
    }
  })
  assert.equal(sawAdultEatTask, true)
  assert.equal(adultWorld.getBlock(0, 0, 0), B.DIRT,
    'an unsheared adult sheep should still consume grass')

  const babyWorld = voxelWorld()
  const babyManager = new EntityManager(babyWorld)
  const baby = withRandom(0, () => babyManager.spawn('sheep', 0.5, 1, 0.5, { baby: true }))
  let babyTicks = 0
  withRandom(0, () => {
    while (babyTicks < 100 && babyWorld.getBlock(0, 0, 0) === B.GRASS) {
      babyManager.update(0.05, context({ x: 30, y: 1, z: 30 }))
      babyTicks++
    }
  })
  assert.equal(babyWorld.getBlock(0, 0, 0), B.DIRT)
  const ordinaryAge = -1200 + babyTicks * 0.05
  assert.ok(babyManager.snapshotById(baby.id).age >= ordinaryAge + 2.9,
    'grass eating should remove about three extra seconds from baby growth time')
})

test('chickens flutter safely and lay eggs on the restored 5-10 minute timer', () => {
  const fallingManager = new EntityManager(voxelWorld())
  const falling = withRandom(0.5, () => fallingManager.spawn('chicken', 0.5, 18, 0.5, {
    bypassPositionValidation: true
  }))
  let minimumVy = 0
  withRandom(0.5, () => {
    for (let i = 0; i < 220 && !fallingManager.snapshotById(falling.id).onGround; i++) {
      fallingManager.update(0.05, context({ x: 0.5, y: 1, z: 0.5 }))
      minimumVy = Math.min(minimumVy, fallingManager.snapshotById(falling.id).vy)
    }
  })
  const landed = fallingManager.snapshotById(falling.id)
  assert.equal(landed.onGround, true, `chicken did not land: y=${landed.y}, vy=${landed.vy}`)
  assert.ok(minimumVy >= -3.001, `chicken fall speed exceeded flutter clamp: ${minimumVy}`)
  assert.equal(landed.health, landed.maxHealth, 'a fluttering chicken must not take fall damage')

  const source = new EntityManager(voxelWorld())
  const chicken = withRandom(0.5, () => source.spawn('chicken', 0.5, 1, 0.5))
  assert.ok(chicken.eggTimer >= 300 && chicken.eggTimer <= 600)
  const saved = source.serialize().map(entity => ({ ...entity, eggTimer: 1 }))
  const drops = []
  const laying = new EntityManager(voxelWorld(), undefined, {
    drop: (id, x, y, z, count) => drops.push({ id, x, y, z, count })
  })
  withRandom(0.25, () => laying.restore(saved))
  withRandom(0.25, () => tick(laying, 20, context({ x: 0.5, y: 1, z: 0.5 })))
  assert.deepEqual(drops.map(drop => [drop.id, drop.count]), [[I.EGG, 1]])
  assert.equal(laying.snapshotById(chicken.id).eggTimer, 375)
})
