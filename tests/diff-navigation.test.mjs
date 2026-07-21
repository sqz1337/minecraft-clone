import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export * from './src/entities/Pathfinder.ts'",
      "export { EntityManager } from './src/entities/EntityManager.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-navigation-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)
const { findPath, EntityManager, I, BIOME, B } = mod.exports

const profile = (overrides = {}) => ({
  width: 0.6, height: 1.8, maxStep: 1, maxFall: 3,
  canSwim: true, canOpenDoors: false, waterCost: 2, maxVisited: 768, maxDistance: 32,
  ...overrides
})

function grid({ floor = true } = {}) {
  const blocks = new Map()
  const doors = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  return {
    blocks, doors,
    set(x, y, z, id) { blocks.set(key(x, y, z), id) },
    getBlock(x, y, z) { return blocks.get(key(x, y, z)) ?? (floor && y === 0 ? B.STONE : B.AIR) },
    isSolid(x, y, z) {
      const id = this.getBlock(x, y, z)
      return id !== B.AIR && id !== B.WATER
    },
    isWater(x, y, z) { return this.getBlock(x, y, z) === B.WATER },
    doorState(x, y, z) { return doors.get(key(x, y, z)) ?? null }
  }
}

const node = (x, y, z) => ({ x, y, z, terrain: 'ground' })

test('A* walks around a wall instead of steering into it', () => {
  const world = grid()
  for (let z = -1; z <= 1; z++) for (let y = 1; y <= 2; y++) world.set(3, y, z, B.STONE)
  const path = findPath(world, node(0, 1, 0), node(6, 1, 0), profile())
  assert.ok(path)
  assert.ok(path.some(part => Math.abs(part.z) >= 2))
  assert.deepEqual(path.at(-1), node(6, 1, 0))
})

test('footprint and headroom match each species dimensions', () => {
  const corridor = grid()
  for (let x = -1; x <= 5; x++) for (let y = 1; y <= 3; y++) {
    corridor.set(x, y, -1, B.STONE)
    corridor.set(x, y, 1, B.STONE)
  }
  assert.ok(findPath(corridor, node(0, 1, 0), node(4, 1, 0), profile({ width: 0.55, height: 0.95 })))
  assert.equal(findPath(corridor, node(0, 1, 0), node(4, 1, 0), profile({ width: 1.35, height: 0.9 })), null)

  const wideCorridor = grid()
  for (let x = -1; x <= 5; x++) for (let y = 1; y <= 2; y++) {
    wideCorridor.set(x, y, -1, B.STONE)
    wideCorridor.set(x, y, 2, B.STONE)
  }
  assert.ok(findPath(wideCorridor, node(0, 1, 0), node(4, 1, 0), profile({ width: 1.35, height: 0.9 })))

  const ceiling = grid()
  for (let x = 0; x <= 3; x++) ceiling.set(x, 3, 0, B.STONE)
  assert.ok(findPath(ceiling, node(0, 1, 0), node(3, 1, 0), profile({ height: 1.8 })))
  assert.equal(findPath(ceiling, node(0, 1, 0), node(3, 1, 0), profile({ height: 2.9 })), null)
})

test('step and fall transitions respect configured limits', () => {
  const step = grid({ floor: false })
  step.set(0, 0, 0, B.STONE)
  step.set(1, 0, 0, B.STONE)
  step.set(1, 1, 0, B.STONE)
  const stepped = findPath(step, node(0, 1, 0), node(1, 2, 0), profile({ maxDistance: 2 }))
  assert.ok(stepped)
  assert.equal(stepped.at(-1).y, 2)

  const cliff = grid({ floor: false })
  cliff.set(0, 4, 0, B.STONE)
  cliff.set(1, 1, 0, B.STONE)
  assert.ok(findPath(cliff, node(0, 5, 0), node(1, 2, 0), profile({ maxDistance: 2 })))
  cliff.set(1, 1, 0, B.AIR)
  cliff.set(1, 0, 0, B.STONE)
  assert.equal(findPath(cliff, node(0, 5, 0), node(1, 1, 0), profile({ maxDistance: 2 })), null)

  cliff.set(1, 1, 0, B.STONE)
  cliff.set(1, 3, 0, B.STONE)
  assert.equal(findPath(cliff, node(0, 5, 0), node(1, 2, 0), profile({ maxDistance: 2 })), null,
    'fall may not tunnel through an intermediate solid')
})

test('water, lava and closed doors are profile-aware nodes', () => {
  const water = grid({ floor: false })
  water.set(0, 0, 0, B.STONE)
  water.set(1, 1, 0, B.WATER)
  water.set(2, 0, 0, B.STONE)
  const swimming = findPath(water, node(0, 1, 0), node(2, 1, 0), profile({ canSwim: true }))
  assert.ok(swimming?.some(part => part.terrain === 'water'))
  assert.equal(findPath(water, node(0, 1, 0), node(2, 1, 0), profile({ canSwim: false })), null)
  water.set(1, 1, 0, B.LAVA)
  assert.equal(findPath(water, node(0, 1, 0), node(2, 1, 0), profile({ canSwim: true })), null)

  const door = grid()
  for (let x = 0; x <= 2; x++) for (let y = 1; y <= 2; y++) {
    door.set(x, y, -1, B.STONE)
    door.set(x, y, 1, B.STONE)
  }
  for (const y of [1, 2]) {
    door.set(1, y, 0, B.STONE)
    door.doors.set(`1,${y},0`, 'closed')
  }
  const throughDoor = findPath(door, node(0, 1, 0), node(1, 1, 0), profile({ canOpenDoors: true }))
  assert.ok(throughDoor?.some(part => part.terrain === 'door'))
  assert.equal(findPath(door, node(0, 1, 0), node(1, 1, 0), profile({ canOpenDoors: false })), null)
  for (const y of [1, 2]) door.doors.set(`1,${y},0`, 'open')
  const throughOpenDoor = findPath(door, node(0, 1, 0), node(1, 1, 0), profile({ canOpenDoors: false }))
  assert.ok(throughOpenDoor?.some(part => part.terrain === 'door'), 'open doors remain graph edges for close-behind AI')
})

test('EntityManager follows A* around obstacles and throttles moving-goal replans', () => {
  const world = grid()
  world.topSolidY = () => 0
  world.biomeAt = () => BIOME.PLAINS
  world.getLightLevel = () => 15
  // A short unsupported trench blocks walking while leaving eye-level LOS clear,
  // so the passive temptation task is allowed to acquire and must detour via A*.
  for (let z = -1; z <= 1; z++) world.set(2, 0, z, B.AIR)
  const manager = new EntityManager(world)
  manager.spawnTimer = Number.POSITIVE_INFINITY
  const cow = manager.spawn('cow', 0.5, 1, 0.5)
  for (let tick = 0; tick < 160; tick++) {
    manager.update(0.05, {
      player: { x: 5.5, y: 1, z: 0.5 + Math.min(1.5, tick * 0.01) },
      heldItem: I.WHEAT
    })
  }
  const moved = manager.snapshotById(cow.id)
  assert.ok(moved.x > 2.5, `cow did not navigate around wall: ${moved.x},${moved.z}`)
  assert.ok(Math.abs(moved.z) > 1 || moved.x > 4, 'path never detoured around the wall')
  assert.ok(manager.navigationPlanCount < 20, `replanned too often: ${manager.navigationPlanCount}`)
})
