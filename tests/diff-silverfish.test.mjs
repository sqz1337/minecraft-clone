import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager, HOSTILE_DEFINITIONS, spawnEntriesForBiome } from './src/entities/EntityManager.ts'",
      "export { EntityRenderer } from './src/entities/EntityRenderer.ts'",
      "export { TextureLoader as TestTextureLoader, Texture as TestTexture, Scene as TestScene, Mesh as TestMesh, Box3 as TestBox3, Vector3 as TestVector3 } from 'three'",
      "export { HOSTILE_KINDS, MOB_KINDS } from './src/entities/EntityTypes.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { BIOME } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-silverfish-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['three'],
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  EntityManager, EntityRenderer, HOSTILE_DEFINITIONS, spawnEntriesForBiome,
  HOSTILE_KINDS, MOB_KINDS, B, BIOME,
  TestTextureLoader, TestTexture, TestScene, TestMesh, TestBox3, TestVector3
} = mod.exports

function flatWorld() {
  let blockLight = 0
  return {
    setBlockLight(value) { blockLight = value },
    getBlock(_x, y) { return Math.floor(y) <= 0 ? B.STONE : B.AIR },
    isSolid(_x, y) { return Math.floor(y) <= 0 },
    isWater() { return false },
    topSolidY() { return 0 },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return blockLight },
    getSkyLight() { return 0 },
    getBlockLight() { return blockLight }
  }
}

const context = player => ({
  player, playerTargetable: true, heldItem: null, skyDarkness: 15,
  worldSpawn: { x: -100, y: 1, z: -100 }
})

test('silverfish is a complete hostile definition with classic small melee dimensions', () => {
  assert.ok(HOSTILE_KINDS.includes('silverfish'))
  assert.ok(MOB_KINDS.includes('silverfish'))
  assert.deepEqual(HOSTILE_DEFINITIONS.silverfish, {
    kind: 'silverfish', category: 'hostile', maxHealth: 8,
    width: 0.4, height: 0.3, speed: 3.2,
    temptingItem: null, attackDamage: 1, followRange: 16, drops: []
  })
})

test('silverfish is spawner-only: natural tables reject it while a dark spawner volume accepts it', () => {
  for (const biome of Object.values(BIOME)) {
    assert.equal(spawnEntriesForBiome('hostile', biome).some(entry => entry.kind === 'silverfish'), false)
  }
  const world = flatWorld()
  const manager = new EntityManager(world)
  const natural = {
    source: 'natural', player: { x: 30.5, y: 1, z: 0.5 },
    worldSpawn: { x: -30.5, y: 1, z: 0.5 }, darkness: 15
  }
  assert.equal(manager.canSpawnEntity('silverfish', 0.5, 1, 0.5, natural), false)
  assert.equal(manager.canSpawnEntity('silverfish', 0.5, 1, 0.5, {
    source: 'spawner', darkness: 15
  }), true)
  world.setBlockLight(8)
  assert.equal(manager.canSpawnEntity('silverfish', 0.5, 1, 0.5, {
    source: 'spawner', darkness: 15
  }), false)
})

test('silverfish uses hostile targeting/melee and survives entity serialization', () => {
  const hits = []
  const world = flatWorld()
  const manager = new EntityManager(world, undefined, {
    damagePlayer: amount => { hits.push(amount); return true }
  })
  manager.spawnTimer = Number.POSITIVE_INFINITY
  const fish = manager.spawn('silverfish', 0.5, 1, 0.5, { persistent: true })
  assert.ok(fish)
  manager.update(0.05, context({ x: 1.35, y: 1, z: 0.5 }))
  assert.deepEqual(hits, [1])
  assert.equal(manager.snapshotById(fish.id).targetId, 'player')

  const saved = manager.serialize()
  assert.equal(saved[0].kind, 'silverfish')
  const restored = new EntityManager(world)
  restored.restore(saved)
  assert.equal(restored.snapshotById(fish.id).kind, 'silverfish')
  assert.equal(restored.snapshotById(fish.id).maxHealth, 8)
})

test('silverfish renderer uses seven animated segments and three classic dorsal plates', () => {
  assert.ok(existsSync(new URL('../public/assets/minecraft/mob/silverfish.png', import.meta.url)))
  const source = readFileSync(new URL('../src/entities/EntityRenderer.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('silverfish.png'))

  const originalLoad = TestTextureLoader.prototype.load
  TestTextureLoader.prototype.load = () => new TestTexture()
  try {
    const renderer = new EntityRenderer(new TestScene())
    const view = renderer.build('silverfish')
    assert.equal(view.segments.length, 7)
    let meshCount = 0
    view.group.traverse(child => { if (child instanceof TestMesh) meshCount++ })
    assert.equal(meshCount, 10)
    const size = new TestBox3().setFromObject(view.group).getSize(new TestVector3())
    assert.ok(size.y <= 0.8, `silverfish model must stay low, got ${size.y}`)
    assert.ok(size.z >= 0.8, `segmented body must read head-to-tail, got ${size.z}`)
    renderer.dispose()
  } finally {
    TestTextureLoader.prototype.load = originalLoad
  }
})

test('skeleton renderer keeps the full rib cage and attaches its bow to the aimed right arm', () => {
  const originalLoad = TestTextureLoader.prototype.load
  TestTextureLoader.prototype.load = () => new TestTexture()
  try {
    const renderer = new EntityRenderer(new TestScene())
    renderer.sync([{
      id: 'skeleton-render-test', kind: 'skeleton',
      x: 0, y: 0, z: 0, previousX: 0, previousY: 0, previousZ: 0,
      vx: 0, vy: 0, vz: 0, yaw: 0, previousYaw: 0,
      age: 0, sizeScale: 1, active: true, hurtTime: 0, deathTime: 0,
      headYaw: 0, headPitch: 0, carriedBlock: null, sheared: false, saddled: false
    }], 1, 0)
    const view = renderer.views.get('skeleton-render-test')
    const body = view.group.children[0]
    assert.equal(body.geometry.parameters.width, 0.5)
    assert.equal(body.geometry.parameters.depth, 0.25)

    const meshCount = object => {
      let count = 0
      object.traverse(child => { if (child instanceof TestMesh) count++ })
      return count
    }
    assert.equal(meshCount(view.arms[0]), 2, 'right arm includes arm mesh and bow')
    assert.equal(meshCount(view.arms[1]), 1, 'left drawing arm does not carry a duplicate bow')
    assert.equal(view.arms[0].rotation.y, -0.1)
    assert.equal(view.arms[1].rotation.y, 0.5)
    assert.equal(renderer.materials.get('skeleton').transparent, true)
    renderer.dispose()
  } finally {
    TestTextureLoader.prototype.load = originalLoad
  }
})
