import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { DensityTerrain, DENSITY_SEA_LEVEL, DENSITY_HORIZONTAL_STEP, DENSITY_VERTICAL_STEP, DENSITY_LATTICE_HEIGHT, DENSITY_LATTICE_CACHE_LIMIT, DENSITY_COLUMN_CACHE_LIMIT } from './src/world/DensityTerrain.ts'",
      "export { BIOME } from './src/world/Biomes.ts'",
      "export { Chunk, WORLD_HEIGHT } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-base-terrain-unit-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  DensityTerrain, DENSITY_SEA_LEVEL, DENSITY_HORIZONTAL_STEP, DENSITY_VERTICAL_STEP,
  DENSITY_LATTICE_HEIGHT, DENSITY_LATTICE_CACHE_LIMIT, DENSITY_COLUMN_CACHE_LIMIT,
  BIOME, Chunk, WORLD_HEIGHT, B
} = mod.exports

function constantBiome(biome, hill = false) {
  return {
    sample() { return { biome, hill } },
    biomeAt() { return biome }
  }
}

test('density uses a 4x8x4 lattice and interpolates continuously across negative cells', () => {
  assert.equal(DENSITY_SEA_LEVEL, 63)
  assert.equal(DENSITY_HORIZONTAL_STEP, 4)
  assert.equal(DENSITY_VERTICAL_STEP, 8)
  assert.equal(DENSITY_LATTICE_HEIGHT, 17)
  const terrain = new DensityTerrain(0x51a2, constantBiome(BIOME.PLAINS))

  const x0 = terrain.sampleDensity(-8, 48, 12)
  const x1 = terrain.sampleDensity(-7, 48, 12)
  const x2 = terrain.sampleDensity(-6, 48, 12)
  const x3 = terrain.sampleDensity(-5, 48, 12)
  const x4 = terrain.sampleDensity(-4, 48, 12)
  assert.ok(Math.abs(x1 - (x0 * 0.75 + x4 * 0.25)) < 1e-6)
  assert.ok(Math.abs(x2 - (x0 * 0.5 + x4 * 0.5)) < 1e-6)
  assert.ok(Math.abs(x3 - (x0 * 0.25 + x4 * 0.75)) < 1e-6)

  const y0 = terrain.sampleDensity(-8, 48, 12)
  const y2 = terrain.sampleDensity(-8, 50, 12)
  const y4 = terrain.sampleDensity(-8, 52, 12)
  const y8 = terrain.sampleDensity(-8, 56, 12)
  assert.ok(Math.abs(y2 - (y0 * 0.75 + y8 * 0.25)) < 1e-6)
  assert.ok(Math.abs(y4 - (y0 * 0.5 + y8 * 0.5)) < 1e-6)
})

test('the density profile blends a hard biome edge across a complete 5x5 neighbourhood', () => {
  const splitSource = {
    sample(x) { return { biome: x < 0 ? BIOME.OCEAN : BIOME.MOUNTAIN, hill: false } },
    biomeAt(x) { return x < 0 ? BIOME.OCEAN : BIOME.MOUNTAIN }
  }
  const terrain = new DensityTerrain(0x5b1e, splitSource)
  const roots = [-16, -12, -8, -4, 0, 4, 8, 12, 16]
    .map(x => terrain.smoothedProfileAt(x, 0).rootHeight)
  assert.equal(roots[0], -1)
  assert.equal(roots[1], -1)
  assert.equal(roots.at(-1), 1)
  assert.equal(roots.at(-2), 1)
  for (let index = 1; index < roots.length; index++) {
    assert.ok(roots[index] >= roots[index - 1], `${roots}`)
  }
  assert.ok(roots.slice(2, 6).every(root => root > -1 && root < 1), `${roots}`)
})

test('baseBlockAt-style samples exactly match copied chunks regardless of generation order', () => {
  const forward = new DensityTerrain(0xdec0)
  const reverse = new DensityTerrain(0xdec0)
  const leftForward = new Chunk(-2, 1), rightForward = new Chunk(-1, 1)
  const leftReverse = new Chunk(-2, 1), rightReverse = new Chunk(-1, 1)
  forward.copyInto(leftForward)
  forward.copyInto(rightForward)
  reverse.copyInto(rightReverse)
  reverse.copyInto(leftReverse)
  assert.deepEqual(leftForward.blocks, leftReverse.blocks)
  assert.deepEqual(rightForward.blocks, rightReverse.blocks)
  assert.deepEqual(leftForward.colHeight, leftReverse.colHeight)
  assert.deepEqual(rightForward.colBiome, rightReverse.colBiome)

  const bx = leftForward.cx * 16, bz = leftForward.cz * 16
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    const info = forward.columnInfo(bx + lx, bz + lz)
    const columnIndex = (lx << 4) | lz
    assert.equal(leftForward.colHeight[columnIndex], info.height)
    assert.equal(leftForward.colBiome[columnIndex], info.biome)
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      assert.equal(leftForward.get(lx, y, lz), forward.blockAt(bx + lx, y, bz + lz))
    }
  }

  const original = forward.blockAt(bx, 20, bz)
  leftForward.set(0, 20, 0, original === B.AIR ? B.STONE : B.AIR)
  assert.equal(forward.blockAt(bx, 20, bz), original, 'a destination chunk must not alias cached base columns')
})

test('sea fill, noise-variable desert surfaces and sandstone follow the 1.2-shaped pass', () => {
  const ocean = new DensityTerrain(0x124, constantBiome(BIOME.OCEAN))
  let wetColumn = null
  for (let x = -32; x <= 32 && !wetColumn; x++) for (let z = -32; z <= 32; z++) {
    const info = ocean.columnInfo(x, z)
    if (info.height < DENSITY_SEA_LEVEL) { wetColumn = { x, z, info }; break }
  }
  assert.ok(wetColumn)
  assert.equal(ocean.blockAt(wetColumn.x, DENSITY_SEA_LEVEL, wetColumn.z), B.WATER)
  assert.notEqual(ocean.blockAt(wetColumn.x, wetColumn.info.height, wetColumn.z), B.WATER)

  const desert = new DensityTerrain(0x124, constantBiome(BIOME.DESERT))
  const depths = new Set()
  let sandstoneColumns = 0
  for (let x = -48; x < 48; x++) {
    const info = desert.columnInfo(x, 7)
    depths.add(info.surfaceDepth)
    assert.equal(desert.blockAt(x, info.height, 7), B.SAND)
    for (let depth = 1; depth <= info.surfaceDepth; depth++) {
      assert.equal(desert.blockAt(x, info.height - depth, 7), B.SAND)
    }
    if (desert.blockAt(x, info.height - info.surfaceDepth - 1, 7) === B.SANDSTONE) sandstoneColumns++
  }
  assert.ok(depths.size >= 3, `surface depths ${[...depths]}`)
  assert.ok(sandstoneColumns > 80, `sandstone columns ${sandstoneColumns}`)
})

test('bedrock independently thins through the bottom five layers and never rises above them', () => {
  const terrain = new DensityTerrain(0xbedd, constantBiome(BIOME.PLAINS))
  const counts = new Uint32Array(6)
  const side = 64
  for (let x = -side / 2; x < side / 2; x++) for (let z = -side / 2; z < side / 2; z++) {
    for (let y = 0; y <= 5; y++) if (terrain.blockAt(x, y, z) === B.BEDROCK) counts[y]++
  }
  const total = side * side
  assert.equal(counts[0], total)
  assert.ok(counts[1] / total > 0.72 && counts[1] / total < 0.88)
  assert.ok(counts[2] / total > 0.52 && counts[2] / total < 0.68)
  assert.ok(counts[3] / total > 0.32 && counts[3] / total < 0.48)
  assert.ok(counts[4] / total > 0.12 && counts[4] / total < 0.28)
  assert.equal(counts[5], 0)
})

test('terrain statistics remain broad, sea-relative and fast with bounded caches', () => {
  const terrain = new DensityTerrain(0x124)
  const chunks = []
  const started = performance.now()
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) {
    const chunk = new Chunk(cx, cz)
    terrain.copyInto(chunk)
    chunks.push(chunk)
  }
  const elapsed = performance.now() - started
  const oceanHeights = [], landHeights = [], mountainHeights = []
  for (const chunk of chunks) for (let index = 0; index < 256; index++) {
    const height = chunk.colHeight[index], biome = chunk.colBiome[index]
    assert.ok(height >= 20 && height < WORLD_HEIGHT - 1)
    if (biome === BIOME.OCEAN) oceanHeights.push(height)
    else landHeights.push(height)
    if (biome === BIOME.MOUNTAIN) mountainHeights.push(height)
  }
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length
  assert.ok(oceanHeights.length > 20, `ocean columns ${oceanHeights.length}`)
  assert.ok(landHeights.length > 500, `land columns ${landHeights.length}`)
  assert.ok(mountainHeights.length > 20, `mountain columns ${mountainHeights.length}`)
  assert.ok(average(oceanHeights) < DENSITY_SEA_LEVEL - 3)
  assert.ok(average(landHeights) >= DENSITY_SEA_LEVEL - 2)
  assert.ok(average(mountainHeights) > average(landHeights))
  assert.ok(elapsed < 3_000, `25 base chunks took ${elapsed.toFixed(0)}ms`)

  const stats = terrain.cacheStats()
  assert.ok(stats.latticeColumns <= DENSITY_LATTICE_CACHE_LIMIT)
  assert.ok(stats.blockColumns <= DENSITY_COLUMN_CACHE_LIMIT)
})

test('density and block-column caches evict at their declared hard limits', () => {
  const source = constantBiome(BIOME.PLAINS)
  const lattice = new DensityTerrain(0xcace, source)
  for (let index = 0; index < DENSITY_LATTICE_CACHE_LIMIT + 64; index++) {
    lattice.sampleDensity(index * DENSITY_HORIZONTAL_STEP, 48, 0)
  }
  assert.equal(lattice.cacheStats().latticeColumns, DENSITY_LATTICE_CACHE_LIMIT)

  const columns = new DensityTerrain(0xcace, source)
  for (let index = 0; index < DENSITY_COLUMN_CACHE_LIMIT + 64; index++) columns.columnInfo(index, 0)
  assert.equal(columns.cacheStats().blockColumns, DENSITY_COLUMN_CACHE_LIMIT)
  assert.ok(columns.cacheStats().latticeColumns <= DENSITY_LATTICE_CACHE_LIMIT)
})
