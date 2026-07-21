import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager } from './src/entities/EntityManager.ts'",
      "export { WorldGen } from './src/world/WorldGen.ts'",
      "export { World } from './src/world/World.ts'",
      "export { Chunk } from './src/world/Chunk.ts'",
      "export { B, SOLID } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-villagers-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const { EntityManager, WorldGen, World, Chunk, B, SOLID } = mod.exports

const blockKey = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

/** In-memory voxel storage using the production World's paired-door methods. */
function voxelWorld() {
  const blocks = new Map()
  const facings = new Map()
  const world = Object.create(World.prototype)
  Object.assign(world, {
    blocks,
    facings,
    doorPairMutationDepth: 0,
    getBlock(x, y, z) {
      const key = blockKey(x, y, z)
      return blocks.has(key) ? blocks.get(key) : Math.floor(y) === 0 ? B.GRASS : B.AIR
    },
    getBlockFacing(x, y, z) { return facings.get(blockKey(x, y, z)) ?? 4 },
    setBlock(x, y, z, id, facing) {
      const key = blockKey(x, y, z)
      blocks.set(key, id)
      if (facing !== undefined) facings.set(key, facing)
    },
    batchBlocks(action) { action() },
    topSolidY(x, z) {
      for (let y = 127; y >= 0; y--) if (this.isSolid(x, y, z)) return y
      return -1
    },
    biomeAt() { return 2 }, // plains
    getLightLevel() { return 15 },
    getSkyLight() { return 0 },
    getBlockLight() { return 0 },
    onAutomaticBlockBreak() {}
  })
  return world
}

function villageDoor(key, x, z, facing = 0, y = 1) {
  const dx = facing === 0 ? 1 : facing === 1 ? -1 : 0
  const dz = facing === 4 ? 1 : facing === 5 ? -1 : 0
  return {
    key, x, y, z, facing,
    inside: { x: x - dx, y, z: z - dz },
    outside: { x: x + dx, y, z: z + dz }
  }
}

function village(id, doors, centerX = 0, centerZ = 0, radius = 16) {
  return { id, centerX, centerY: 1, centerZ, radius, doors }
}

function installDoor(world, door) {
  world.setBlock(door.x, door.y, door.z, B.AIR)
  world.setBlock(door.x, door.y + 1, door.z, B.AIR)
  assert.equal(world.placeDoor(door.x, door.y, door.z, door.facing), true)
}

function context(extra = {}) {
  return {
    player: { x: 48.5, y: 1, z: 48.5 },
    playerTargetable: false,
    heldItem: null,
    skyDarkness: 15,
    timeOfDay: 0.5,
    raining: false,
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

function corridorWorld(door) {
  const world = voxelWorld()
  for (let z = -32; z <= 32; z++) {
    if (z === door.z) continue
    world.setBlock(door.x, 1, z, B.STONE)
    world.setBlock(door.x, 2, z, B.STONE)
  }
  installDoor(world, door)
  return world
}

test('WorldGen village metadata pairs each house door with a supported home spawn', () => {
  const generator = new WorldGen('diff-villager-metadata')
  let plan = null
  for (let rx = -10; rx <= 10 && !plan; rx++) {
    for (let rz = -10; rz <= 10 && !plan; rz++) plan = generator.villageIn(rx, rz)
  }
  assert.ok(plan, 'expected at least one deterministic village in the searched regions')

  const infos = generator.villageFeaturesIn(Math.floor(plan.centerX / 16), Math.floor(plan.centerZ / 16))
  const info = infos.find(candidate => candidate.id === plan.id)
  assert.ok(info)
  assert.ok(info.doors.length >= 1)
  assert.equal(new Set(info.doors.map(door => door.key)).size, info.doors.length)

  for (const door of info.doors) {
    assert.equal(door.inside.y, door.y)
    assert.equal(door.outside.y, door.y)
    assert.equal(door.inside.x + door.outside.x, door.x * 2)
    assert.equal(door.inside.z + door.outside.z, door.z * 2)
    assert.equal(Math.abs(door.inside.x - door.x) + Math.abs(door.inside.z - door.z), 1)
    assert.equal(Math.abs(door.outside.x - door.x) + Math.abs(door.outside.z - door.z), 1)
    const homes = generator.villagerSpawnsIn(
      Math.floor(door.inside.x / 16), Math.floor(door.inside.z / 16)
    )
    const home = homes.find(spot => spot.homeDoorKey === door.key &&
      spot.x === door.inside.x && spot.z === door.inside.z)
    assert.ok(home, `missing inside home spawn for ${door.key}`)
    assert.equal(home.y, door.y, 'villager feet and the lower door half must share floor+1')
    const chunk = new Chunk(Math.floor(home.x / 16), Math.floor(home.z / 16))
    generator.fillChunk(chunk)
    const localX = (home.x % 16 + 16) % 16
    const localZ = (home.z % 16 + 16) % 16
    assert.equal(!!SOLID[chunk.get(localX, home.y - 1, localZ)], true,
      `home spawn ${door.key} must have a solid floor directly below its feet`)
  }
})

test('EntityManager deduplicates repeated village and overlapping door metadata', () => {
  const manager = new EntityManager(voxelWorld())
  const door = villageDoor('alpha:door', 0, 0)
  manager.registerVillage(village('alpha', [door]))
  manager.registerVillage(village('alpha', [door]))
  manager.registerVillage(village('alpha', [{ ...door, key: 'chunk-alias' }]))
  assert.equal(manager.registeredVillageCount, 1)
})

for (const [label, shelterContext] of [
  ['night', context({ timeOfDay: 0.9 })],
  ['rain', context({ timeOfDay: 0.5, raining: true })]
]) {
  test(`${label} resident opens the paired door, crosses inside, closes it and stays`, () => {
    const door = villageDoor(`${label}:door`, 0, 0)
    const world = corridorWorld(door)
    const manager = new EntityManager(world)
    manager.registerVillage(village(label, [door]))
    const resident = withRandom(0.5, () => manager.spawn('villager', 3.5, 1, 0.5, {
      persistent: true, villageId: label, homeDoorKey: door.key,
      homeX: -0.5, homeY: 1.01, homeZ: 0.5
    }))
    assert.ok(resident)
    let opened = false
    withRandom(0.5, () => {
      for (let i = 0; i < 180; i++) {
        manager.update(0.05, shelterContext)
        opened ||= world.doorState(door.x, door.y, door.z) === 'open'
      }
    })
    const inside = manager.snapshotById(resident.id)
    assert.equal(opened, true, `${label} resident never opened the door`)
    assert.ok(inside.x < 0.45, `${label} resident did not cross inside: x=${inside.x}`)
    assert.equal(inside.villagerActivity, 'indoors')
    assert.equal(world.doorState(door.x, door.y, door.z), 'closed')
  })
}

test('a daytime resident leaves through its home door and closes it behind itself', () => {
  const door = villageDoor('day:door', 0, 0)
  const world = corridorWorld(door)
  const manager = new EntityManager(world)
  manager.registerVillage(village('day', [door]))
  const resident = withRandom(0.5, () => manager.spawn('villager', -0.5, 1, 0.5, {
    persistent: true, villageId: 'day', homeDoorKey: door.key,
    homeX: -0.5, homeY: 1.01, homeZ: 0.5
  }))
  let opened = false
  let leaving = false
  withRandom(0.5, () => {
    for (let i = 0; i < 180; i++) {
      manager.update(0.05, context({ timeOfDay: 0.5 }))
      const snapshot = manager.snapshotById(resident.id)
      opened ||= world.doorState(door.x, door.y, door.z) === 'open'
      leaving ||= snapshot.villagerActivity === 'leave'
    }
  })
  const outside = manager.snapshotById(resident.id)
  assert.equal(opened, true)
  assert.equal(leaving, true)
  assert.ok(outside.x > 0.55, `resident did not cross outside: x=${outside.x}`)
  assert.equal(world.doorState(door.x, door.y, door.z), 'closed')
})

test('a visible zombie within eight blocks preempts the schedule and increases separation', () => {
  const world = voxelWorld()
  const manager = new EntityManager(world)
  const villager = withRandom(0.5, () => manager.spawn('villager', 0.5, 1, 0.5, { persistent: true }))
  const zombie = withRandom(0.5, () => manager.spawn('zombie', 4.5, 1, 0.5, { persistent: true }))
  const initialDistance = Math.abs(zombie.x - villager.x)
  const updateContext = context({
    player: { x: 4.5, y: 1, z: 0.5 },
    playerTargetable: true,
    timeOfDay: 0.5
  })
  withRandom(0.5, () => tick(manager, 20, updateContext))
  const escaped = manager.snapshotById(villager.id)
  const threat = manager.snapshotById(zombie.id)
  assert.equal(escaped.villagerActivity, 'avoid')
  assert.ok(Math.hypot(escaped.x - threat.x, escaped.z - threat.z) > initialDistance + 0.5)
})

test('a far resident returns toward the village through bounded intermediate paths', () => {
  const world = voxelWorld()
  const manager = new EntityManager(world)
  manager.registerVillage(village('return', [], 0, 0, 8))
  const resident = withRandom(0.5, () => manager.spawn('villager', 40.5, 1, 0.5, {
    persistent: true, villageId: 'return', homeX: 0.5, homeY: 1.01, homeZ: 0.5
  }))
  const beforePlans = manager.navigationPlanCount
  let sawReturn = false
  withRandom(0.5, () => {
    for (let i = 0; i < 420; i++) {
      manager.update(0.05, context({ timeOfDay: 0.5 }))
      sawReturn ||= manager.snapshotById(resident.id).villagerActivity === 'return'
    }
  })
  const returning = manager.snapshotById(resident.id)
  assert.equal(sawReturn, true)
  assert.ok(returning.x <= 8.5, `far resident did not return inside village radius: x=${returning.x}`)
  assert.ok(manager.navigationPlanCount > beforePlans)
})

test('a destroyed home door falls back to another valid door in the same village', () => {
  const first = villageDoor('fallback:first', 0, 0)
  const second = villageDoor('fallback:second', 6, 0)
  const world = voxelWorld()
  installDoor(world, first)
  installDoor(world, second)
  assert.equal(world.breakDoor(first.x, first.y, first.z), true)
  const manager = new EntityManager(world)
  manager.registerVillage(village('fallback', [first, second], 3, 0, 16))
  const resident = withRandom(0.5, () => manager.spawn('villager', 1.5, 1, 3.5, {
    persistent: true, villageId: 'fallback', homeDoorKey: first.key,
    homeX: -0.5, homeY: 1.01, homeZ: 0.5
  }))
  withRandom(0.5, () => manager.update(0.05, context({ timeOfDay: 0.9 })))
  const reassigned = manager.snapshotById(resident.id)
  assert.equal(reassigned.homeDoorKey, second.key)
  assert.deepEqual([reassigned.homeX, reassigned.homeY, reassigned.homeZ], [5.5, 1.01, 0.5])
})

test('villager village id, 3D home and door key survive serialize/restore', () => {
  const world = voxelWorld()
  const manager = new EntityManager(world)
  const villager = withRandom(0.5, () => manager.spawn('villager', 2.5, 1, 2.5, {
    persistent: true, id: 'saved-resident', profession: 'librarian',
    homeX: 7.5, homeY: 4.01, homeZ: -3.5,
    villageId: 'save-village', homeDoorKey: 'save-village:7,4,-4'
  }))
  const saved = manager.serialize()
  assert.deepEqual(
    [saved[0].villageId, saved[0].homeX, saved[0].homeY, saved[0].homeZ, saved[0].homeDoorKey],
    ['save-village', 7.5, 4.01, -3.5, 'save-village:7,4,-4']
  )
  const restored = new EntityManager(world)
  restored.restore(saved)
  const snapshot = restored.snapshotById(villager.id)
  assert.deepEqual(
    [snapshot.villageId, snapshot.homeX, snapshot.homeY, snapshot.homeZ, snapshot.homeDoorKey],
    ['save-village', 7.5, 4.01, -3.5, 'save-village:7,4,-4']
  )
})

test('door-derived capacity permits one child only after 300 mutual mating ticks', () => {
  const world = voxelWorld()
  const doors = []
  for (let i = 0; i < 9; i++) {
    const door = villageDoor(`family:${i}`, -20, i - 4)
    doors.push(door)
    installDoor(world, door)
  }
  const manager = new EntityManager(world)
  manager.registerVillage(village('family', doors, 0, 0, 30))
  const first = withRandom(0.5, () => manager.spawn('villager', 0.5, 1, 0.5, {
    persistent: true, villageId: 'family'
  }))
  const second = withRandom(0.5, () => manager.spawn('villager', 3, 1, 0.5, {
    persistent: true, villageId: 'family'
  }))
  assert.ok(first && second)
  const daytime = context({ timeOfDay: 0.5 })
  withRandom(0.5, () => tick(manager, 299, daytime))
  assert.equal(manager.count, 2, 'village mating must not complete before 300 mutual ticks')
  withRandom(0.5, () => {
    for (let i = 0; i < 4 && manager.count === 2; i++) manager.update(0.05, daytime)
  })
  assert.equal(manager.count, 3)
  assert.equal(manager.snapshots.filter(entity => entity.kind === 'villager' && entity.age < 0).length, 1)
})
