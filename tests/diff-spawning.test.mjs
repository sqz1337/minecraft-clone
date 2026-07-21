import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export * from './src/entities/EntityManager.ts'",
      "export { World } from './src/world/World.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-spawning-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  EntityManager,
  ELIGIBLE_CHUNK_RADIUS,
  ELIGIBLE_CHUNK_COUNT,
  SPAWNABLE_CHUNK_COUNT,
  HOSTILE_MOB_CAP,
  PASSIVE_MOB_CAP,
  eligibleChunksAround,
  scaledMobCap,
  spawnEntriesForBiome,
  pickWeightedSpawnEntry,
  BIOME,
  B
} = mod.exports
const { World } = mod.exports

function voxelWorld(initialBiome = BIOME.PLAINS) {
  const blocks = new Map()
  let biome = initialBiome
  let light = 0
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    blocks,
    setBiome(value) { biome = value },
    setLight(value) { light = value },
    setBlock(x, y, z, id) { blocks.set(key(x, y, z), id) },
    getBlock(x, y, z) { return blocks.get(key(x, y, z)) ?? (Math.floor(y) <= 0 ? B.GRASS : B.AIR) },
    isSolid(x, y, z) {
      const id = this.getBlock(x, y, z)
      return id !== B.AIR && id !== B.WATER && id !== B.LAVA
    },
    isWater(x, y, z) { return this.getBlock(x, y, z) === B.WATER },
    topSolidY() { return 0 },
    biomeAt() { return biome },
    getLightLevel() { return light },
    getSkyLight() { return light },
    getBlockLight() { return light },
    isSlimeChunk() { return false }
  }
}

function disableNaturalSpawns(manager) {
  manager.spawnTimer = Number.POSITIVE_INFINITY
}

function update(manager, player, extra = {}) {
  manager.update(0.05, {
    player,
    worldSpawn: { x: 10_000, y: 1, z: 10_000 },
    playerTargetable: false,
    heldItem: null,
    skyDarkness: 15,
    ...extra
  })
}

function withRandom(value, action) {
  const original = Math.random
  Math.random = () => value
  try {
    return action()
  } finally {
    Math.random = original
  }
}

test('eligible chunks expose the vanilla 17x17 cap set and exclude its border from spawning', () => {
  assert.equal(ELIGIBLE_CHUNK_RADIUS, 8)
  assert.equal(ELIGIBLE_CHUNK_COUNT, 17 * 17)
  assert.equal(SPAWNABLE_CHUNK_COUNT, 15 * 15)
  assert.equal(HOSTILE_MOB_CAP, Math.floor(70 * ELIGIBLE_CHUNK_COUNT / 256))
  assert.equal(PASSIVE_MOB_CAP, Math.floor(15 * ELIGIBLE_CHUNK_COUNT / 256))

  const center = { cx: 2, cz: -2 }
  const chunks = eligibleChunksAround(32.25, -16.25)
  assert.equal(chunks.length, ELIGIBLE_CHUNK_COUNT)
  assert.equal(new Set(chunks.map(({ cx, cz }) => `${cx},${cz}`)).size, ELIGIBLE_CHUNK_COUNT)

  const spawnable = chunks.filter(chunk => !chunk.border)
  assert.equal(spawnable.length, SPAWNABLE_CHUNK_COUNT)
  assert.ok(chunks.every(chunk => {
    const edge = Math.max(Math.abs(chunk.cx - center.cx), Math.abs(chunk.cz - center.cz))
    return chunk.border === (edge === ELIGIBLE_CHUNK_RADIUS)
  }))
  assert.deepEqual(
    [...new Set(spawnable.map(chunk => chunk.cx - center.cx))].sort((a, b) => a - b),
    Array.from({ length: 15 }, (_, index) => index - 7)
  )
  assert.deepEqual(
    [...new Set(spawnable.map(chunk => chunk.cz - center.cz))].sort((a, b) => a - b),
    Array.from({ length: 15 }, (_, index) => index - 7)
  )
})

test('category caps scale by eligible chunks using the classic 256-chunk denominator', () => {
  assert.equal(scaledMobCap(70, 0), 0)
  assert.equal(scaledMobCap(70, 256), 70)
  assert.equal(scaledMobCap(70, ELIGIBLE_CHUNK_COUNT), HOSTILE_MOB_CAP)
  assert.equal(scaledMobCap(15, ELIGIBLE_CHUNK_COUNT), PASSIVE_MOB_CAP)
})

test('weighted selection uses half-open cumulative ranges', () => {
  const entries = [
    { kind: 'zombie', weight: 1, minPack: 1, maxPack: 4 },
    { kind: 'skeleton', weight: 3, minPack: 1, maxPack: 4 }
  ]
  assert.deepEqual(pickWeightedSpawnEntry(entries, 0), entries[0])
  assert.deepEqual(pickWeightedSpawnEntry(entries, 0.249999), entries[0])
  assert.deepEqual(pickWeightedSpawnEntry(entries, 0.25), entries[1])
  assert.deepEqual(pickWeightedSpawnEntry(entries, 0.999999), entries[1])
  assert.equal(pickWeightedSpawnEntry([], 0.5), null)
})

test('biome spawn entries are weighted, keep ocean monsters and specialize jungle and mushroom animals', () => {
  const plainsHostiles = spawnEntriesForBiome('hostile', BIOME.PLAINS)
  const oceanHostiles = spawnEntriesForBiome('hostile', BIOME.OCEAN)
  assert.ok(plainsHostiles.length > 0)
  assert.deepEqual(oceanHostiles, plainsHostiles)
  assert.deepEqual(spawnEntriesForBiome('hostile', BIOME.MUSHROOM), [])
  assert.ok(plainsHostiles.every(entry => entry.weight > 0 && entry.minPack >= 1 && entry.maxPack >= entry.minPack))
  assert.ok(plainsHostiles.some(entry => entry.kind === 'slime'), 'slimes retain their vanilla weight before chunk validation')

  assert.deepEqual(spawnEntriesForBiome('passive', BIOME.PLAINS), [
    { kind: 'sheep', weight: 12, minPack: 4, maxPack: 4 },
    { kind: 'pig', weight: 10, minPack: 4, maxPack: 4 },
    { kind: 'chicken', weight: 10, minPack: 4, maxPack: 4 },
    { kind: 'cow', weight: 8, minPack: 4, maxPack: 4 }
  ])
  assert.ok(spawnEntriesForBiome('passive', BIOME.JUNGLE).some(entry => entry.kind === 'chicken'))
  assert.deepEqual(spawnEntriesForBiome('passive', BIOME.MUSHROOM), [
    { kind: 'mooshroom', weight: 8, minPack: 4, maxPack: 8 }
  ])
})

test('natural candidates stay 24 blocks from both the player and world spawn while ocean hostiles remain legal', () => {
  const world = voxelWorld(BIOME.OCEAN)
  const manager = new EntityManager(world)
  const candidate = { x: 0.5, y: 1, z: 0.5 }
  const natural = {
    source: 'natural',
    player: { x: 24.5, y: 1, z: 0.5 },
    worldSpawn: { x: -23.5, y: 1, z: 0.5 },
    darkness: 15
  }

  assert.equal(manager.canSpawnEntity('zombie', candidate.x, candidate.y, candidate.z, natural), true)
  assert.equal(manager.canSpawnEntity('zombie', candidate.x, candidate.y, candidate.z, {
    ...natural, player: { x: 24.49, y: 1, z: 0.5 }
  }), false, 'player distance is checked in 3D')
  assert.equal(manager.canSpawnEntity('zombie', candidate.x, candidate.y, candidate.z, {
    ...natural, worldSpawn: { x: -23.49, y: 1, z: 0.5 }
  }), false, 'world-spawn distance is checked independently')

  world.setBiome(BIOME.MUSHROOM)
  assert.equal(manager.canSpawnEntity('zombie', candidate.x, candidate.y, candidate.z, natural), false)
})

test('slime scales 0.5, 1 and 2 map to vanilla small, medium and large health', () => {
  const manager = new EntityManager(voxelWorld())
  disableNaturalSpawns(manager)
  const small = manager.spawn('slime', 0.5, 1, 0.5, { sizeScale: 0.5 })
  const medium = manager.spawn('slime', 5.5, 1, 0.5, { sizeScale: 1 })
  const large = manager.spawn('slime', 12.5, 1, 0.5, { sizeScale: 2 })

  assert.ok(small && medium && large)
  assert.deepEqual(
    [small, medium, large].map(slime => ({ sizeScale: slime.sizeScale, health: slime.health, maxHealth: slime.maxHealth })),
    [
      { sizeScale: 0.5, health: 1, maxHealth: 1 },
      { sizeScale: 1, health: 4, maxHealth: 4 },
      { sizeScale: 2, health: 16, maxHealth: 16 }
    ]
  )
})

test('hostile despawn uses 3D 128-block distance while persistent and passive mobs survive', () => {
  const threshold = new EntityManager(voxelWorld())
  disableNaturalSpawns(threshold)
  const near = threshold.spawn('zombie', 0.5, 1, 0.5)
  update(threshold, { x: 0.5, y: 129, z: 0.5 })
  assert.ok(threshold.snapshotById(near.id), 'exactly 128 blocks survives')

  const far = new EntityManager(voxelWorld())
  disableNaturalSpawns(far)
  const removed = far.spawn('zombie', 0.5, 1, 0.5)
  update(far, { x: 0.5, y: 129.01, z: 0.5 })
  assert.equal(far.snapshotById(removed.id), null, 'more than 128 blocks despawns immediately')

  const protectedMobs = new EntityManager(voxelWorld())
  disableNaturalSpawns(protectedMobs)
  const persistent = protectedMobs.spawn('zombie', 0.5, 1, 0.5, { persistent: true })
  const passive = protectedMobs.spawn('cow', 5.5, 1, 0.5)
  update(protectedMobs, { x: 0.5, y: 200, z: 0.5 })
  assert.ok(protectedMobs.snapshotById(persistent.id))
  assert.ok(protectedMobs.snapshotById(passive.id))
})

test('nearby players and damage reset hostile despawn age before the random far-despawn check', () => {
  const nearby = new EntityManager(voxelWorld())
  disableNaturalSpawns(nearby)
  const first = nearby.spawn('zombie', 0.5, 1, 0.5)
  nearby.entities.get(first.id).despawnAgeTicks = 601
  withRandom(0, () => update(nearby, { x: 31.5, y: 1, z: 0.5 }))
  withRandom(0, () => update(nearby, { x: 40.5, y: 1, z: 0.5 }))
  assert.ok(nearby.snapshotById(first.id), 'the near tick reset age, so the next far tick cannot despawn')

  nearby.entities.get(first.id).despawnAgeTicks = 601
  withRandom(0, () => update(nearby, { x: 40.5, y: 1, z: 0.5 }))
  assert.equal(nearby.snapshotById(first.id), null, 'an old hostile beyond 32 blocks can randomly despawn')

  const damaged = new EntityManager(voxelWorld())
  disableNaturalSpawns(damaged)
  const second = damaged.spawn('zombie', 0.5, 1, 0.5)
  damaged.entities.get(second.id).despawnAgeTicks = 601
  assert.equal(damaged.damage(second.id, 1, 0.5, 0.5, 0), true)
  withRandom(0, () => update(damaged, { x: 40.5, y: 1, z: 0.5 }))
  assert.ok(damaged.snapshotById(second.id), 'taking damage reset despawn age')
})

test('the runtime eligible-chunk pass fills but never exceeds its scaled hostile cap', () => {
  const world = voxelWorld(BIOME.PLAINS)
  world.topSolidY = () => 1
  world.getBlock = (_x, y) => Math.floor(y) <= 1 ? B.GRASS : B.AIR
  const manager = new EntityManager(world)
  const original = Math.random
  Math.random = () => 0
  try {
    manager.tryNaturalSpawn({
      player: { x: 0.5, y: 1, z: 0.5 },
      worldSpawn: { x: 10_000, y: 1, z: 10_000 },
      playerTargetable: false, heldItem: null, skyDarkness: 15
    })
  } finally {
    Math.random = original
  }
  assert.equal(manager.hostileCount, HOSTILE_MOB_CAP)
  assert.equal(manager.spawn('zombie', 3_000.5, 2, 0.5), null)
  assert.ok(manager.spawn('zombie', 3_000.5, 2, 0.5, { bypassMobCap: true }))
})

test('low render distance still queues the complete radius-8 mob simulation area', () => {
  const world = Object.create(World.prototype)
  Object.assign(world, {
    renderDistance: 4,
    genQueue: [], meshQueue: [], chunks: new Map(), cacheKey: Number.NaN
  })
  world.ensureChunk = (cx, cz) => {
    const key = cx * 0x100000000 + cz
    let chunk = world.chunks.get(key)
    if (!chunk) {
      chunk = { cx, cz, state: 0 }
      world.chunks.set(key, chunk)
    }
    return chunk
  }
  world.disposeChunkMeshes = () => {}
  world.rebuildQueues(0, 0)

  assert.equal(world.genQueue.length, ELIGIBLE_CHUNK_COUNT)
  assert.equal(world.meshQueue.length, 9 * 9)
  assert.ok(world.genQueue.some(chunk => chunk.cx === 8 && chunk.cz === 8))
  assert.ok(world.genQueue.every(chunk => Math.abs(chunk.cx) <= 8 && Math.abs(chunk.cz) <= 8))
})

test('hostile persistence and despawn age survive EntityManager serialization', () => {
  const source = new EntityManager(voxelWorld())
  disableNaturalSpawns(source)
  const id = source.spawn('zombie', 0.5, 1, 0.5, { persistent: true }).id
  source.entities.get(id).despawnAgeTicks = 417
  const saved = source.serialize()
  assert.equal(saved[0].persistent, true)
  assert.equal(saved[0].despawnAgeTicks, 417)

  const restored = new EntityManager(voxelWorld())
  restored.restore(saved)
  assert.equal(restored.snapshotById(id).persistent, true)
  assert.equal(restored.snapshotById(id).despawnAgeTicks, 417)
})
