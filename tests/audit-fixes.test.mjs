import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { existsSync } from 'node:fs'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { EntityManager, PASSIVE_DEFINITIONS } from './src/entities/EntityManager.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS } from './src/world/Items.ts'",
      "export { matchRecipe } from './src/world/Recipes.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { WorldGen, BIOME } from './src/world/WorldGen.ts'",
      "export { Chunk } from './src/world/Chunk.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'audit-fixes-test-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { EntityManager, PASSIVE_DEFINITIONS, I, ITEMS, matchRecipe, B, WorldGen, BIOME, Chunk } = bundledModule.exports

function flatWorld() {
  return {
    getBlock(_x, y) { return Math.floor(y) === 0 ? B.GRASS : B.AIR },
    setBlock() {},
    isSolid(_x, y) { return Math.floor(y) <= 0 },
    isWater() { return false },
    topSolidY() { return 0 },
    biomeAt() { return BIOME.PLAINS },
    getLightLevel() { return 15 }
  }
}

test('shears craft correctly and sheep shearing survives serialization', () => {
  const grid = [null, { id: I.IRON_INGOT, count: 1 }, { id: I.IRON_INGOT, count: 1 }, null]
  assert.deepEqual(matchRecipe(grid, 2), { id: I.SHEARS, count: 1 })

  const manager = new EntityManager(flatWorld())
  const sheep = manager.spawn('sheep', 0, 1, 0)
  const wool = manager.shear(sheep.id)
  assert.ok(wool >= 1 && wool <= 3)
  assert.equal(manager.shear(sheep.id), 0)
  assert.equal(manager.snapshots[0].sheared, true)

  const saved = manager.serialize()
  const restored = new EntityManager(flatWorld())
  restored.restore(saved)
  assert.equal(restored.snapshots[0].sheared, true)
  // wool now regrows by eating grass; the timer is only the next eat attempt delay
  assert.ok(saved[0].woolTimer > 0)
})

test('animal behavior, classic drops and food side effects match the corrected rules', () => {
  const manager = new EntityManager(flatWorld())
  const cow = manager.spawn('cow', 0, 1, 0)
  assert.equal(manager.feed(cow.id, I.WHEAT), true)
  assert.equal(manager.snapshots[0].loveTime, 30)
  assert.deepEqual(PASSIVE_DEFINITIONS.pig.drops[0], { id: I.RAW_PORKCHOP, min: 0, max: 2 })
  assert.deepEqual(ITEMS[I.RAW_CHICKEN].food.effect, { kind: 'hunger', chance: 0.3, seconds: 30 })
  assert.deepEqual(ITEMS[I.ROTTEN_FLESH].food.effect, { kind: 'hunger', chance: 0.8, seconds: 30 })
  assert.deepEqual(ITEMS[I.SPIDER_EYE].food.effect, { kind: 'poison', chance: 1, seconds: 5 })
})

test('the original sound bank includes hostile, interaction and ambient samples', () => {
  for (const asset of [
    'mob/zombie/say1.ogg', 'mob/skeleton/say1.ogg', 'mob/spider/say1.ogg',
    'mob/creeper/say1.ogg', 'mob/slime/say1.ogg', 'mob/enderman/idle1.ogg',
    'mob/enderman/portal.ogg', 'mob/wolf/bark1.ogg', 'mob/cat/meow1.ogg',
    'mob/irongolem/hit1.ogg', 'mob/irongolem/throw.ogg',
    'random/bow.ogg', 'random/eat1.ogg', 'random/burp.ogg', 'random/fuse.ogg', 'random/chestopen.ogg',
    'random/door_open.ogg', 'random/door_close.ogg',
    'random/orb.ogg', 'random/explode1.ogg', 'music/calm1.ogg'
  ]) {
    assert.ok(existsSync(new URL(`../public/assets/minecraft/sound/${asset}`, import.meta.url)), `missing sound ${asset}`)
  }
  for (const track of ['music1.mp3', 'music2.mp3', 'music3.mp3', 'music4.mp3']) {
    assert.ok(
      existsSync(new URL(`../public/assets/realmcraft/music/silent-hill/${track}`, import.meta.url)),
      `missing Silent Hill music ${track}`
    )
  }
})

test('v4 terrain produces broad mixed-height regions without isolated needle peaks', () => {
  let ocean = 0
  let sampled = 0
  let needles = 0
  let localSamples = 0
  for (const seed of ['audit-a', 'audit-b', 'audit-c', 'audit-d']) {
    const gen = new WorldGen(seed)
    for (let x = -40; x <= 40; x += 4) for (let z = -40; z <= 40; z += 4) {
      ocean += gen.biomeAt(x, z) === BIOME.OCEAN ? 1 : 0
      sampled++
      const center = gen.heightAt(x, z)
      const highestNeighbor = Math.max(
        gen.heightAt(x - 4, z), gen.heightAt(x + 4, z),
        gen.heightAt(x, z - 4), gen.heightAt(x, z + 4)
      )
      if (center - highestNeighbor > 12) needles++
      localSamples++
    }
  }
  assert.ok(ocean / sampled < 0.9, `ocean ratio ${ocean / sampled}`)
  assert.ok(needles / localSamples < 0.001, `needle ratio ${needles / localSamples}`)
})

test('Java-compatible cave systems occasionally connect to the surface', () => {
  const gen = new WorldGen('cave-entrance-audit')
  let entrances = 0
  for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) {
    const chunk = new Chunk(cx, cz)
    gen.densityTerrain.copyInto(chunk)
    gen.carvers.carveChunk(chunk, gen)
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz
      const info = gen.columnInfo(wx, wz)
      if (info.height < 42 || chunk.get(lx, info.height, lz) !== B.AIR) continue
      if (chunk.get(lx, info.height - 1, lz) === B.AIR && chunk.get(lx, info.height - 2, lz) === B.AIR) entrances++
    }
  }
  assert.ok(entrances > 0, 'expected at least one connected surface cave entrance')
})
