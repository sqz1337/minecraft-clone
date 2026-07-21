import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildSync } from 'esbuild'
import * as THREE from 'three'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager } from './src/entities/EntityManager.ts'",
      "export { ProjectileManager } from './src/entities/ProjectileManager.ts'",
      "export { Interaction } from './src/player/Interaction.ts'",
      "export { World } from './src/world/World.ts'",
      "export { B, SOLID, isDoorBlock } from './src/world/Blocks.ts'",
      "export { matchRecipe } from './src/world/Recipes.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-hostiles-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const { EntityManager, ProjectileManager, Interaction, World, B, SOLID, isDoorBlock, matchRecipe, BIOME } = mod.exports

function voxelWorld() {
  const blocks = new Map()
  let blockLight = 0
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    blocks,
    setLight(value) { blockLight = value },
    setBlock(x, y, z, id) { blocks.set(key(x, y, z), id) },
    getBlock(x, y, z) { return blocks.get(key(x, y, z)) ?? (Math.floor(y) <= 0 ? B.GRASS : B.AIR) },
    isSolid(x, y, z) { return !!SOLID[this.getBlock(x, y, z)] },
    isWater() { return false },
    topSolidY() { return 0 },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return blockLight },
    getSkyLight() { return 0 },
    getBlockLight() { return blockLight },
    isSlimeChunk() { return false }
  }
}

function context(player, extra = {}) {
  return {
    player,
    worldSpawn: { x: 10_000, y: 1, z: 10_000 },
    playerTargetable: true,
    heldItem: null,
    skyDarkness: 15,
    ...extra
  }
}

function managerFor(world = voxelWorld(), hooks = {}) {
  const manager = new EntityManager(world, undefined, hooks)
  manager.spawnTimer = Number.POSITIVE_INFINITY
  return manager
}

function withRandom(value, action) {
  const original = Math.random
  Math.random = () => value
  try { return action() } finally { Math.random = original }
}

test('wooden doors are paired, directional, togglable, breakable and craftable', () => {
  const blocks = new Map([['0,0,0', B.STONE]])
  const facings = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const world = Object.create(World.prototype)
  Object.assign(world, {
    doorPairMutationDepth: 0,
    onAutomaticBlockBreak: () => {},
    getBlock(x, y, z) { return blocks.get(key(x, y, z)) ?? B.AIR },
    getBlockFacing(x, y, z) { return facings.get(key(x, y, z)) ?? 4 },
    setBlock(x, y, z, id, facing) {
      blocks.set(key(x, y, z), id)
      if (facing !== undefined) facings.set(key(x, y, z), facing)
    },
    batchBlocks(action) { action() }
  })

  assert.equal(world.placeDoor(0, 1, 0, 0), true)
  assert.equal(world.doorState(0, 1, 0), 'closed')
  assert.equal(world.doorState(0, 2, 0), 'closed')
  assert.equal(SOLID[world.getBlock(0, 1, 0)], true)
  assert.equal(world.setDoorOpen(0, 2, 0, true), true)
  assert.equal(world.doorState(0, 1, 0), 'open')
  assert.equal(SOLID[world.getBlock(0, 1, 0)], false)
  assert.equal(world.breakDoor(0, 2, 0), true)
  assert.equal(world.getBlock(0, 1, 0), B.AIR)
  assert.equal(world.getBlock(0, 2, 0), B.AIR)
  assert.equal(isDoorBlock(B.WOOD_DOOR_LOWER), true)

  const grid = Array(9).fill(null)
  for (const index of [0, 1, 3, 4, 6, 7]) grid[index] = { id: B.PLANKS, count: 1 }
  assert.deepEqual(matchRecipe(grid, 3), { id: B.WOOD_DOOR_LOWER, count: 1 })
})

test('zombies acquire visible villagers when no valid player exists', () => {
  const manager = managerFor()
  const zombie = manager.spawn('zombie', 0.5, 1, 0.5)
  const villager = manager.spawn('villager', 8.5, 1, 0.5, { persistent: true })
  for (let tick = 0; tick < 20; tick++) {
    manager.update(0.05, context({ x: 50, y: 1, z: 50 }, { playerTargetable: false }))
  }
  assert.equal(manager.snapshotById(zombie.id).targetId, villager.id)
})

test('zombies hold at a closed-door waypoint for 240 ticks before breaking both halves', () => {
  const world = voxelWorld()
  let closed = false
  let breaks = 0
  world.doorState = (x, y, z) => closed && Math.floor(x) === 0 && (Math.floor(y) === 1 || Math.floor(y) === 2) && Math.floor(z) === 0
    ? 'closed' : null
  const baseGetBlock = world.getBlock.bind(world)
  world.getBlock = (x, y, z) => world.doorState(x, y, z) ? B.WOOD_DOOR_LOWER : baseGetBlock(x, y, z)
  world.breakDoor = () => { closed = false; breaks++; return true }
  const manager = managerFor(world)
  const zombie = manager.spawn('zombie', -0.5, 1, 0.5)
  const state = manager.entities.get(zombie.id)
  closed = true
  state.navPath = [{ x: 0, y: 1, z: 0, terrain: 'door' }]
  state.navIndex = 0
  state.navRequested = { x: 0, y: 1, z: 0, terrain: 'ground' }
  state.navGoal = { x: 0, y: 1, z: 0, terrain: 'ground' }

  for (let tick = 0; tick < 239; tick++) manager.navigate(state, 0.5, 1, 0.5, 2, 0.05, 'break')
  assert.equal(breaks, 0)
  manager.navigate(state, 0.5, 1, 0.5, 2, 0.05, 'break')
  assert.equal(breaks, 1)
  assert.equal(closed, false)
})

test('skeletons stop after 20 visible ticks and fire at an exact 60-tick cadence', () => {
  const shots = []
  const manager = managerFor(voxelWorld(), { shootProjectile: (...args) => shots.push(args) })
  const skeleton = manager.spawn('skeleton', 8.5, 1, 0.5)
  const player = { x: 0.5, y: 1, z: 0.5 }

  manager.update(0.05, context(player))
  assert.equal(shots.length, 1)
  for (let tick = 0; tick < 59; tick++) manager.update(0.05, context(player))
  assert.equal(shots.length, 1)
  assert.ok(manager.entities.get(skeleton.id).targetVisibleTicks >= 20)
  manager.update(0.05, context(player))
  assert.equal(shots.length, 2)
})

test('spiders use local effective light, leap at medium range and climb only on wall collision', () => {
  const world = voxelWorld()
  world.setLight(8)
  const manager = managerFor(world)
  const spider = manager.spawn('spider', 0.5, 1, 0.5)
  const player = { x: 4.5, y: 1, z: 0.5 }
  withRandom(0.5, () => {
    for (let tick = 0; tick < 20; tick++) manager.update(0.05, context(player, { skyDarkness: 0 }))
  })
  assert.equal(manager.snapshotById(spider.id).targetId, null)

  world.setLight(7)
  withRandom(0.5, () => {
    for (let tick = 0; tick < 20 && !manager.snapshotById(spider.id).targetId; tick++) {
      manager.update(0.05, context(player, { skyDarkness: 0 }))
    }
  })
  assert.equal(manager.snapshotById(spider.id).targetId, 'player')

  const state = manager.entities.get(spider.id)
  state.x = 0.5
  state.y = 1
  state.z = 0.5
  state.vx = state.vy = state.vz = 0
  state.onGround = true
  withRandom(0, () => manager.update(0.05, context(player, { skyDarkness: 15 })))
  assert.ok(state.vy > 0 || state.y > 1, 'medium-range leap applied an upward impulse')

  const climbingWorld = voxelWorld()
  const climbing = managerFor(climbingWorld)
  const climber = climbing.spawn('spider', 0.3, 1, 0.5)
  climbingWorld.setBlock(1, 1, 0, B.STONE)
  climbingWorld.setBlock(1, 2, 0, B.STONE)
  const climbingState = climbing.entities.get(climber.id)
  climbingState.onGround = true
  climbingState.vx = 5
  climbing.physics(climbingState, 0.05)
  assert.equal(climbingState.horizontalCollision, true)
  assert.ok(climbingState.y > 1, 'actual horizontal collision produces climb motion')
})

test('slimes wait, hop more often near targets, and damage by logical size', () => {
  const wandering = managerFor()
  const medium = wandering.spawn('slime', 0.5, 1, 0.5, { sizeScale: 1 })
  const state = wandering.entities.get(medium.id)
  state.onGround = true
  state.slimeJumpDelayTicks = 1
  withRandom(0.5, () => wandering.update(0.05, context({ x: 20, y: 1, z: 0.5 }, { playerTargetable: false })))
  assert.ok(state.y > 1)
  assert.equal(state.slimeJumpDelayTicks, 20)

  const near = managerFor()
  const nearSlime = near.spawn('slime', 0.5, 1, 0.5, { sizeScale: 1 })
  near.entities.get(nearSlime.id).onGround = true
  near.entities.get(nearSlime.id).slimeJumpDelayTicks = 1
  withRandom(0.5, () => near.update(0.05, context({ x: 5, y: 1, z: 0.5 })))
  assert.equal(near.entities.get(nearSlime.id).slimeJumpDelayTicks, 6)

  for (const [scale, expected] of [[0.5, 0], [1, 2], [2, 4]]) {
    const hits = []
    const attacker = managerFor(voxelWorld(), { damagePlayer: amount => { hits.push(amount); return true } })
    attacker.spawn('slime', 0.5, 1, 0.5, { sizeScale: scale })
    attacker.update(0.05, context({ x: 0.8, y: 1, z: 0.5 }))
    assert.deepEqual(hits, expected ? [expected] : [])
  }
})

test('large slimes split through the complete 4 -> 2 -> 1 size chain', () => {
  const manager = managerFor()
  const large = manager.spawn('slime', 0.5, 1, 0.5, { sizeScale: 2 })
  manager.damage(large.id, 100, 0.5, 0.5, 0)
  withRandom(0.5, () => {
    for (let tick = 0; tick < 15; tick++) {
      manager.update(0.05, context({ x: 50, y: 1, z: 0.5 }, { playerTargetable: false }))
    }
  })
  const medium = manager.snapshots.filter(entity => entity.kind === 'slime')
  assert.ok(medium.length >= 2 && medium.length <= 4)
  assert.ok(medium.every(entity => entity.sizeScale === 1 && entity.maxHealth === 4))

  manager.damage(medium[0].id, 100, medium[0].x, medium[0].z, 0)
  withRandom(0.5, () => {
    for (let tick = 0; tick < 15; tick++) {
      manager.update(0.05, context({ x: 50, y: 1, z: 0.5 }, { playerTargetable: false }))
    }
  })
  assert.ok(manager.snapshots.some(entity => entity.kind === 'slime' && entity.sizeScale === 0.5 && entity.maxHealth === 1))
})

test('endermen acquire at 64-block range, evade projectiles, and carry nearby 3D blocks without persistence', () => {
  const world = voxelWorld()
  const manager = managerFor(world)
  const enderman = manager.spawn('enderman', 0.5, 1, -40)
  const player = { x: 0.5, y: 1, z: 0.5 }
  const dy = (1 + 2.9 * 0.85) - (1 + 1.8 * 0.85)
  const dz = -40.5
  const length = Math.hypot(dy, dz)
  const look = { x: 0, y: dy / length, z: dz / length }
  for (let tick = 0; tick < 5; tick++) manager.update(0.05, context(player, { look }))
  assert.equal(manager.snapshotById(enderman.id).targetId, 'player')

  withRandom(0.5, () => {
    assert.equal(manager.damageProjectile(enderman.id, 9, player.x, player.z), false)
  })
  assert.equal(manager.snapshotById(enderman.id).health, 40)

  const carrierWorld = voxelWorld()
  const carrier = managerFor(carrierWorld)
  const carrierMob = carrier.spawn('enderman', 0.5, 1, 0.5)
  carrierWorld.setBlock(0, 1, 0, B.DIRT)
  const rolls = [0, 0.5, 0.5, 0.5]
  const original = Math.random
  Math.random = () => rolls.shift() ?? 0.5
  try { carrier.updateEndermanBlock(carrier.entities.get(carrierMob.id)) } finally { Math.random = original }
  const snapshot = carrier.snapshotById(carrierMob.id)
  assert.equal(snapshot.carriedBlock, B.DIRT)
  assert.equal(snapshot.persistent, false)
  assert.equal(carrierWorld.getBlock(0, 1, 0), B.AIR)
})

test('enderman environment uses directed delay, daylight/rain state and 64 projectile attempts', () => {
  const world = voxelWorld()
  const manager = managerFor(world)
  const enderman = manager.spawn('enderman', 0.5, 1, -40)
  const player = { x: 0.5, y: 1, z: 0.5 }
  const dy = (1 + 2.9 * 0.85) - (1 + 1.8 * 0.85)
  const dz = -40.5
  const length = Math.hypot(dy, dz)
  const look = { x: 0, y: dy / length, z: dz / length }
  withRandom(0.5, () => {
    for (let tick = 0; tick < 40; tick++) manager.update(0.05, context(player, { look }))
  })
  assert.ok(manager.snapshotById(enderman.id).z > -30, 'directed teleport moved toward the distant visible target')

  world.getSkyLight = () => 15
  withRandom(0, () => manager.update(0.05, context(player, { look: undefined, skyDarkness: 0 })))
  assert.equal(manager.snapshotById(enderman.id).targetId, null, 'daylight clears player anger before teleporting')

  const rainWorld = voxelWorld()
  rainWorld.getSkyLight = () => 15
  const rainy = managerFor(rainWorld)
  const wet = rainy.spawn('enderman', 0.5, 1, 0.5)
  withRandom(0.5, () => {
    for (let tick = 0; tick < 10; tick++) {
      rainy.update(0.05, context({ x: 20, y: 1, z: 0.5 }, {
        playerTargetable: false, raining: true, skyDarkness: 15
      }))
    }
  })
  assert.equal(rainy.snapshotById(wet.id).health, 39)

  let attempts = 0
  rainy.tryTeleport = (_entity, count) => { attempts = count; return false }
  assert.equal(rainy.damageProjectile(wet.id, 5, 0, 0), false)
  assert.equal(attempts, 64)
  assert.equal(rainy.snapshotById(wet.id).health, 39)
})

test('integrated zombie AI keeps breaking a closed door beyond its 60-tick sight memory', () => {
  const world = voxelWorld()
  let closed = false
  let breaks = 0
  world.doorState = (x, y, z) => closed && Math.floor(x) === 0 &&
    (Math.floor(y) === 1 || Math.floor(y) === 2) && Math.floor(z) === 0 ? 'closed' : null
  const baseGetBlock = world.getBlock.bind(world)
  world.getBlock = (x, y, z) => world.doorState(x, y, z)
    ? (Math.floor(y) === 1 ? B.WOOD_DOOR_LOWER : B.WOOD_DOOR_UPPER)
    : baseGetBlock(x, y, z)
  world.breakDoor = () => { closed = false; breaks++; return true }

  const manager = managerFor(world)
  const zombie = manager.spawn('zombie', -0.5, 1, 0.5)
  const player = { x: 2.5, y: 1, z: 0.5 }
  withRandom(0.5, () => manager.update(0.05, context(player)))
  assert.equal(manager.snapshotById(zombie.id).targetId, 'player')

  closed = true
  withRandom(0.5, () => {
    for (let tick = 0; tick < 239; tick++) manager.update(0.05, context(player))
  })
  assert.equal(breaks, 0, 'door is not broken before 240 uninterrupted work ticks')
  withRandom(0.5, () => manager.update(0.05, context(player)))
  assert.equal(breaks, 1, 'zombie finishes the door task after target sight memory expires')
})

test('switching a skeleton target resets accumulated line-of-sight ticks', () => {
  const manager = managerFor()
  const skeleton = manager.spawn('skeleton', 0.5, 1, 0.5)
  const zombie = manager.spawn('zombie', 4.5, 1, 0.5)
  const state = manager.entities.get(skeleton.id)
  state.targetId = 'player'
  state.targetVisibleTicks = 27

  assert.equal(manager.damage(skeleton.id, 1, zombie.x, zombie.z, 0, 0, zombie.id), true)
  assert.equal(state.targetId, zombie.id)
  assert.equal(state.targetVisibleTicks, 0)
})

test('daylight clears an enderman revenge target as well as player anger', () => {
  const world = voxelWorld()
  world.getSkyLight = () => 15
  const manager = managerFor(world)
  const enderman = manager.spawn('enderman', 0.5, 1, 0.5)
  const skeleton = manager.spawn('skeleton', 4.5, 1, 0.5)
  const state = manager.entities.get(enderman.id)

  withRandom(0.5, () => {
    manager.damage(enderman.id, 1, skeleton.x, skeleton.z, 0, 0, skeleton.id)
  })
  assert.equal(state.targetId, skeleton.id)
  assert.equal(state.revengeTargetId, skeleton.id)

  withRandom(0, () => manager.update(0.05, context({ x: 20, y: 1, z: 20 }, {
    playerTargetable: false,
    skyDarkness: 0
  })))
  assert.equal(state.targetId, null)
  assert.equal(state.revengeTargetId, null)
})

test('abandoning navigation discards partial door-breaking progress', () => {
  const manager = managerFor()
  const zombie = manager.spawn('zombie', 0.5, 1, 0.5)
  const state = manager.entities.get(zombie.id)
  state.navPath = [{ x: 3, y: 1, z: 0, terrain: 'door' }]
  state.navIndex = 0
  state.doorBreakTicks = 137
  state.doorBreakX = 3
  state.doorBreakY = 1
  state.doorBreakZ = 0

  manager.clearNavigation(state)
  assert.equal(state.doorBreakTicks, 0)
  assert.deepEqual([state.doorBreakX, state.doorBreakY, state.doorBreakZ], [0, 0, 0])
})

test('a rejected Flame projectile does not ignite an enderman', () => {
  let damageCalls = 0
  let igniteCalls = 0
  const entities = {
    raycast: () => ({ entity: { id: 'enderman-1' }, distance: 0.01 }),
    damageProjectile: () => { damageCalls++; return false },
    ignite: () => { igniteCalls++ }
  }
  const projectiles = new ProjectileManager({ isSolid: () => false }, entities)
  projectiles.shoot(
    new THREE.Vector3(0, 1.8, 0), new THREE.Vector3(1, 0, 0), 4, 5, 'player',
    { fireSeconds: 5 }
  )
  projectiles.update(0.05, { x: 20, y: 1, z: 20 })

  assert.equal(damageCalls, 1)
  assert.equal(igniteCalls, 0)
  assert.equal(projectiles.snapshots.length, 0)
})

test('an upper-cell player collision cannot turn a door item into an orphan lower half', () => {
  const blocks = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  let doorPlacements = 0
  const world = {
    raycast: () => ({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, id: B.STONE, dist: 1 }),
    getBlock(x, y, z) { return blocks.get(key(x, y, z)) ?? (Math.floor(y) <= 0 ? B.STONE : B.AIR) },
    setBlock(x, y, z, id) { blocks.set(key(x, y, z), id) },
    placeDoor() { doorPlacements++; return true }
  }
  const inventory = {
    slots: [{ id: B.WOOD_DOOR_LOWER, count: 1 }],
    remove(_slot, count) { this.slots[0].count -= count },
    notify() {}
  }
  const player = {
    pos: { x: 2.5, y: 1, z: 0.5 },
    crouching: false,
    intersectsBlock: (_x, y) => y === 2,
    addExhaustion() {}
  }
  const interaction = Object.assign(Object.create(Interaction.prototype), {
    selected: 0,
    page: 0,
    world,
    player,
    camera: {
      position: new THREE.Vector3(0.5, 1.8, 2.5),
      getWorldDirection(out) { return out.set(0, 0, -1) }
    },
    mode: 'survival',
    inventory,
    entities: { raycast: () => null },
    audio: { placeBlock() {} },
    particles: {},
    rayDir: new THREE.Vector3(),
    rayOrigin: new THREE.Vector3(),
    selectionMesh: { visible: false, position: new THREE.Vector3() },
    crackMesh: { visible: false },
    target: null,
    breaking: false,
    breakProgress: 0,
    breakKey: '',
    attackingEntity: false,
    attackCooldown: 0,
    chargingBow: false,
    placing: true,
    placeCooldown: 0,
    eatProgress: 0,
    handSwing: 0,
    hand: null
  })

  interaction.update(0.05)
  assert.equal(doorPlacements, 0)
  assert.equal(world.getBlock(0, 1, 0), B.AIR)
  assert.equal(inventory.slots[0].count, 1)
})

test('Game forwards rain, but never snow, as enderman-wetting weather', () => {
  const source = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8')
  const rainingLines = source.split('\n').filter(line => line.includes('raining:'))
  assert.equal(rainingLines.length, 1)
  assert.match(rainingLines[0], /weather\.out\.rain\s*>\s*0\.25/)
  assert.doesNotMatch(rainingLines[0], /weather\.out\.snow/)
})
