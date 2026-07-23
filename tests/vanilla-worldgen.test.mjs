import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { JavaRandom, javaStringHash, parseJavaWorldSeed } from './src/world/JavaRandom.ts'",
      "export { BiomeMap } from './src/world/BiomeMap.ts'",
      "export { DensityTerrain, DENSITY_SEA_LEVEL } from './src/world/DensityTerrain.ts'",
      "export { Chunk } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { VanillaLakes } from './src/world/VanillaLakes.ts'",
      "export { WorldGen, CURRENT_WORLD_GEN_VERSION } from './src/world/WorldGen.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'vanilla-worldgen-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  mod, mod.exports
)
const {
  JavaRandom, javaStringHash, parseJavaWorldSeed, BiomeMap,
  DensityTerrain, DENSITY_SEA_LEVEL, Chunk, B, VanillaLakes, WorldGen, CURRENT_WORLD_GEN_VERSION
} = mod.exports

function referenceBits(seed, widths) {
  const multiplier = 0x5deece66dn
  const mask = (1n << 48n) - 1n
  let state = (seed ^ multiplier) & mask
  return widths.map(bits => {
    state = (state * multiplier + 0xbn) & mask
    return Number(state >> BigInt(48 - bits))
  })
}

test('JavaRandom matches the 48-bit java.util.Random recurrence exactly', () => {
  const widths = Array.from({ length: 2000 }, (_, index) => [1, 5, 16, 24, 31, 32][index % 6])
  for (const seed of [0n, 1n, -1n, 0x7fffffffffffffffn, -0x8000000000000000n, 123456789012345n]) {
    const expected = referenceBits(seed, widths)
    const random = new JavaRandom(seed)
    assert.deepEqual(widths.map(bits => random.next(bits)), expected)
  }
})

test('world seed parsing follows Long.parseLong and Java String.hashCode', () => {
  assert.equal(parseJavaWorldSeed('123456789012345'), 123456789012345n)
  assert.equal(parseJavaWorldSeed('-9223372036854775808'), -9223372036854775808n)
  assert.equal(javaStringHash('abc'), 96354)
  assert.equal(parseJavaWorldSeed('abc'), 96354n)
  assert.equal(parseJavaWorldSeed(' 123 '), BigInt(javaStringHash(' 123 ')))
  assert.equal(parseJavaWorldSeed('9223372036854775808'), BigInt(javaStringHash('9223372036854775808')))
})

test('the exact GenLayer graph is region-query and query-order stable', () => {
  const forward = new BiomeMap(123456789n)
  const region = forward.blockBiomes(-48, 37, 96, 80)
  const reverse = new BiomeMap(123456789n)
  const samples = []
  for (let z = 79; z >= 0; z--) for (let x = 95; x >= 0; x--) {
    samples.push(reverse.sample(-48 + x, 37 + z).vanillaBiome)
  }
  samples.reverse()
  assert.deepEqual(Int32Array.from(samples), region)
  assert.ok(new Set(region).size >= 3)
})

test('base terrain uses Y=63 as sea level but fills water only through Y=62', () => {
  const terrain = new DensityTerrain(0n)
  let wet = null
  for (let cz = -16; cz <= 16 && !wet; cz++) for (let cx = -16; cx <= 16; cx++) {
    const chunk = new Chunk(cx, cz)
    terrain.copyInto(chunk)
    for (let lx = 0; lx < 16 && !wet; lx++) for (let lz = 0; lz < 16; lz++) {
      if (chunk.get(lx, DENSITY_SEA_LEVEL - 1, lz) === B.WATER) {
        wet = { chunk, lx, lz }
        break
      }
    }
  }
  assert.ok(wet)
  assert.equal(wet.chunk.get(wet.lx, DENSITY_SEA_LEVEL - 1, wet.lz), B.WATER)
  assert.notEqual(wet.chunk.get(wet.lx, DENSITY_SEA_LEVEL, wet.lz), B.WATER)
})

test('population lakes use the Java mask and replay across destination chunks', () => {
  const sampler = {
    blockAt(_x, y) {
      if (y < 0 || y >= 128) return B.AIR
      if (y === 0) return B.BEDROCK
      return y <= 60 ? B.STONE : B.AIR
    },
    biomeAt() { return 2 }
  }
  const lakes = new VanillaLakes(123456789n)
  let found = null
  for (let cz = -6; cz <= 6 && !found; cz++) for (let cx = -6; cx <= 6; cx++) {
    const chunk = new Chunk(cx, cz)
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      for (let y = 0; y <= 60; y++) chunk.set(lx, y, lz, y === 0 ? B.BEDROCK : B.STONE)
    }
    if (lakes.stampChunk(chunk, sampler) > 0 &&
      chunk.blocks.some(block => block === B.WATER || block === B.LAVA)) found = chunk
  }
  assert.ok(found)
  assert.ok(found.blocks.some(block => block === B.WATER || block === B.LAVA))
  assert.equal(found.blocks.some((block, index) => (index & 127) === 0 && block !== B.BEDROCK), false)
})

test('old generator arguments are deliberately upgraded to v4', () => {
  assert.equal(CURRENT_WORLD_GEN_VERSION, 4)
  for (const version of [1, 2, 3, 4]) {
    const generator = new WorldGen('12345', version)
    assert.equal(generator.generatorVersion, 4)
    assert.equal(generator.seedLong, 12345n)
  }
})
