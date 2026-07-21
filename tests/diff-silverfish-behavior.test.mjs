import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager, SILVERFISH_HELP_DELAY_TICKS, SILVERFISH_HELP_HORIZONTAL_RADIUS, SILVERFISH_HELP_VERTICAL_RADIUS } from './src/entities/EntityManager.ts'",
      "export { B, BLOCKS, SOLID, TILE, infestedBlockFor, isInfestedBlock, isSilverfishInfestable, tileFor } from './src/world/Blocks.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-silverfish-behavior-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['three'],
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  EntityManager, SILVERFISH_HELP_DELAY_TICKS,
  SILVERFISH_HELP_HORIZONTAL_RADIUS, SILVERFISH_HELP_VERTICAL_RADIUS,
  B, BLOCKS, SOLID, TILE, infestedBlockFor, isInfestedBlock, isSilverfishInfestable, tileFor, BIOME
} = mod.exports

function voxelWorld() {
  const blocks = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    blocks,
    setBlock(x, y, z, id) { blocks.set(key(x, y, z), id) },
    batchBlocks(action) { action() },
    getBlock(x, y, z) {
      return blocks.get(key(x, y, z)) ?? (Math.floor(y) <= 0 ? B.STONE : B.AIR)
    },
    isSolid(x, y, z) { return !!SOLID[this.getBlock(x, y, z)] },
    isWater() { return false },
    topSolidY() { return 0 },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return 0 },
    getSkyLight() { return 0 },
    getBlockLight() { return 0 }
  }
}

function idleContext() {
  return {
    player: { x: 50, y: 1, z: 50 }, playerTargetable: false,
    worldSpawn: { x: 10_000, y: 1, z: 10_000 }, heldItem: null, skyDarkness: 15
  }
}

function managerFor(world = voxelWorld()) {
  const manager = new EntityManager(world)
  manager.spawnTimer = Number.POSITIVE_INFINITY
  return manager
}

test('all classic monster eggs append stable ids, mimic their hosts and have no item or normal drop', () => {
  assert.equal(B.INFESTED_STONE, 88)
  assert.equal(B.INFESTED_COBBLESTONE, 89)
  assert.equal(B.INFESTED_STONE_BRICK, 90)
  for (const [host, infested, tile] of [
    [B.STONE, B.INFESTED_STONE, TILE.STONE],
    [B.COBBLESTONE, B.INFESTED_COBBLESTONE, TILE.COBBLESTONE],
    [B.STONE_BRICK, B.INFESTED_STONE_BRICK, TILE.STONE_BRICK]
  ]) {
    const definition = BLOCKS[infested]
    assert.equal(definition.tiles, tile)
    assert.equal(tileFor(infested, 0), tileFor(host, 0))
    assert.equal(definition.dropItem, null)
    assert.equal(definition.hasItem, false)
    assert.equal(infestedBlockFor(host), infested)
    assert.equal(isSilverfishInfestable(host), true)
    assert.equal(isInfestedBlock(infested), true)
  }
  assert.equal(infestedBlockFor(B.DIRT), null)
  assert.equal(isInfestedBlock(B.STONE), false)
})

test('the Game block-break hook releases infested stone through EntityManager', () => {
  const source = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8')
  assert.match(source, /isInfestedBlock\(id\)/)
  assert.match(source, /releaseSilverfishFromBlock\(x, y, z\)/)
})

test('block emergence uses the complete spawn-volume contract', () => {
  const safeWorld = voxelWorld()
  const safe = managerFor(safeWorld)
  const emerged = safe.releaseSilverfishFromBlock(2, 1, -3)
  assert.ok(emerged)
  assert.equal(emerged.kind, 'silverfish')
  assert.deepEqual([emerged.x, emerged.y, emerged.z], [2.5, 1.01, -2.5])

  const unsupportedWorld = voxelWorld()
  unsupportedWorld.setBlock(2, 0, -3, B.AIR)
  assert.equal(managerFor(unsupportedWorld).releaseSilverfishFromBlock(2, 1, -3), null)

  const obstructedWorld = voxelWorld()
  obstructedWorld.setBlock(2, 1, -3, B.STONE)
  assert.equal(managerFor(obstructedWorld).releaseSilverfishFromBlock(2, 1, -3), null)
})

test('an idle grounded silverfish deterministically hides in adjacent compatible stone', () => {
  const world = voxelWorld()
  // Keep the floor supportive but incompatible, leaving one unambiguous hiding target.
  world.setBlock(0, 0, 0, B.PLANKS)
  world.setBlock(1, 1, 0, B.STONE)
  const manager = managerFor(world)
  const fish = manager.spawn('silverfish', 0.5, 1, 0.5, { persistent: true })
  assert.ok(fish)
  const state = manager.entities.get(fish.id)
  state.onGround = true
  state.silverfishHideAtTick = 1

  manager.update(0.05, idleContext())

  assert.equal(manager.snapshotById(fish.id), null)
  assert.equal(world.getBlock(1, 1, 0), B.INFESTED_STONE)
})

test('damage wakes only safely spawnable nearby eggs after the exact bounded delay', () => {
  assert.equal(SILVERFISH_HELP_DELAY_TICKS, 20)
  assert.equal(SILVERFISH_HELP_HORIZONTAL_RADIUS, 10)
  assert.equal(SILVERFISH_HELP_VERTICAL_RADIUS, 5)
  const world = voxelWorld()
  world.setBlock(2, 1, 0, B.INFESTED_COBBLESTONE)
  world.setBlock(4, 0, 0, B.AIR)
  world.setBlock(4, 1, 0, B.INFESTED_STONE_BRICK)
  world.setBlock(20, 1, 0, B.INFESTED_STONE)
  const manager = managerFor(world)
  const caller = manager.spawn('silverfish', 0.5, 1, 0.5, { persistent: true })
  assert.ok(caller)
  assert.equal(manager.damage(caller.id, 1, 0.5, 0.5, 0), true)

  for (let tick = 0; tick < SILVERFISH_HELP_DELAY_TICKS - 1; tick++) {
    manager.update(0.05, idleContext())
  }
  assert.equal(world.getBlock(2, 1, 0), B.INFESTED_COBBLESTONE)
  assert.equal(manager.snapshots.filter(entity => entity.kind === 'silverfish').length, 1)

  manager.update(0.05, idleContext())
  assert.equal(world.getBlock(2, 1, 0), B.AIR)
  assert.equal(manager.snapshots.filter(entity => entity.kind === 'silverfish').length, 2)
  assert.equal(world.getBlock(4, 1, 0), B.INFESTED_STONE_BRICK, 'unsafe egg is restored with its variant')
  assert.equal(world.getBlock(20, 1, 0), B.INFESTED_STONE, 'search never escapes its bounded radius')
})
