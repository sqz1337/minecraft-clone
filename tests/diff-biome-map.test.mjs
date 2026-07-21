import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { BiomeMap, BIOME_LAYER_CACHE_LIMIT } from './src/world/BiomeMap.ts'",
      "export { BIOME, BIOME_IDS, BIOME_NAMES, BIOME_TERRAIN_PROFILES, isBiomeId } from './src/world/Biomes.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-biome-map-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)), mod, mod.exports
)

const {
  BiomeMap, BIOME_LAYER_CACHE_LIMIT,
  BIOME, BIOME_IDS, BIOME_NAMES, BIOME_TERRAIN_PROFILES, isBiomeId
} = mod.exports

test('biome ids stay compatible and expose vanilla-shaped density profiles', () => {
  assert.deepEqual({ ...BIOME }, {
    OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, MOUNTAIN: 5,
    SNOW: 6, RIVER: 7, TAIGA: 8, SWAMP: 9, JUNGLE: 10, MUSHROOM: 11
  })
  assert.deepEqual([...BIOME_IDS], Array.from({ length: 12 }, (_, index) => index))
  assert.equal(BIOME_NAMES.length, 12)
  for (const id of BIOME_IDS) {
    assert.equal(isBiomeId(id), true)
    assert.ok(Number.isFinite(BIOME_TERRAIN_PROFILES[id].rootHeight))
    assert.ok(BIOME_TERRAIN_PROFILES[id].variation >= 0)
  }
  assert.ok(BIOME_TERRAIN_PROFILES[BIOME.OCEAN].rootHeight < BIOME_TERRAIN_PROFILES[BIOME.PLAINS].rootHeight)
  assert.ok(BIOME_TERRAIN_PROFILES[BIOME.MOUNTAIN].variation > BIOME_TERRAIN_PROFILES[BIOME.PLAINS].variation)
})

test('coordinate-pure layers are deterministic across query order and negative zoom boundaries', () => {
  const points = [
    [-257, -257], [-256, -256], [-255, -255], [-129, 17], [-128, 17], [-127, 17],
    [-17, -33], [-1, -1], [0, 0], [1, 1], [127, -129], [128, -128], [129, -127],
    [4097, -8193]
  ]
  const forward = new BiomeMap(0x1240beef)
  const expected = points.map(([x, z]) => forward.sample(x, z))
  const reverse = new BiomeMap(0x1240beef)
  const reversed = [...points].reverse().map(([x, z]) => reverse.sample(x, z)).reverse()
  assert.deepEqual(reversed, expected)

  const region = forward.getRegion(-37, -29, 49, 41)
  for (let z = 0; z < 41; z++) for (let x = 0; x < 49; x++) {
    assert.equal(region[z * 49 + x], forward.biomeAt(-37 + x, -29 + z))
  }
  const changedSeed = new BiomeMap(0x1240bef0)
  assert.ok(expected.some((value, index) => {
    const [x, z] = points[index]
    return value.biome !== changedSeed.biomeAt(x, z)
  }), 'a changed seed must affect at least one distant biome sample')

  // Overflow the final layer through one local region; eviction may affect
  // speed, never results or memory bounds.
  forward.getRegion(-128, -80, 256, 160)
  const stats = forward.cacheStats()
  assert.ok(stats.layers >= 20)
  assert.equal(stats.largestLayer, BIOME_LAYER_CACHE_LIMIT)
})

function largestComponent(cells, width, predicate) {
  const seen = new Uint8Array(cells.length)
  let largest = 0
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || !predicate(cells[start])) continue
    const queue = [start]
    seen[start] = 1
    let size = 0
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]
      size++
      const x = current % width, z = Math.floor(current / width)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz
        if (nx < 0 || nx >= width || nz < 0 || nz >= cells.length / width) continue
        const next = nz * width + nx
        if (seen[next] || !predicate(cells[next])) continue
        seen[next] = 1
        queue.push(next)
      }
    }
    largest = Math.max(largest, size)
  }
  return largest
}

test('islands, shores, rivers and hills form large connected topology without illegal hot/frozen edges', () => {
  const map = new BiomeMap(0x124)
  const width = 96, step = 16, origin = -768
  const cells = new Uint8Array(width * width)
  const hills = new Uint8Array(width * width)
  const counts = new Uint32Array(12)
  const started = performance.now()
  for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
    const sample = map.sample(origin + x * step, origin + z * step)
    const index = z * width + x
    cells[index] = sample.biome
    hills[index] = sample.hill ? 1 : 0
    counts[sample.biome]++
  }
  const elapsed = performance.now() - started

  const oceanRatio = counts[BIOME.OCEAN] / cells.length
  assert.ok(oceanRatio > 0.2 && oceanRatio < 0.7, `ocean ratio ${oceanRatio}`)
  assert.ok(counts.filter(count => count > 0).length >= 10, `biomes present ${[...counts]}`)
  assert.ok(largestComponent(cells, width, biome => biome === BIOME.OCEAN) > 300)
  assert.ok(largestComponent(cells, width, biome => biome !== BIOME.OCEAN) > 700)

  let beaches = 0, beachesByOcean = 0
  let rivers = 0, connectedRivers = 0
  let hillCells = 0, connectedHills = 0
  let desertSnowEdges = 0
  for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
    const index = z * width + x
    const biome = cells[index]
    const wx = origin + x * step, wz = origin + z * step
    if (biome === BIOME.BEACH) {
      beaches++
      let nearOcean = false
      for (let dz = -32; dz <= 32; dz += 16) for (let dx = -32; dx <= 32; dx += 16) {
        if (map.biomeAt(wx + dx, wz + dz) === BIOME.OCEAN) nearOcean = true
      }
      if (nearOcean) beachesByOcean++
    }
    if (biome === BIOME.RIVER) {
      rivers++
      const connected = [1, 2, 4, 8, 16].some(distance =>
        map.biomeAt(wx + distance, wz) === BIOME.RIVER || map.biomeAt(wx - distance, wz) === BIOME.RIVER ||
        map.biomeAt(wx, wz + distance) === BIOME.RIVER || map.biomeAt(wx, wz - distance) === BIOME.RIVER)
      if (connected) connectedRivers++
    }
    if (hills[index]) {
      hillCells++
      const connected = [1, 2, 4, 8, 16].some(distance =>
        map.sample(wx + distance, wz).hill || map.sample(wx - distance, wz).hill ||
        map.sample(wx, wz + distance).hill || map.sample(wx, wz - distance).hill)
      if (connected) connectedHills++
    }
    if (biome === BIOME.DESERT) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (map.biomeAt(wx + dx, wz + dz) === BIOME.SNOW) desertSnowEdges++
      }
    }
  }

  assert.ok(beaches > 100 && beachesByOcean / beaches > 0.98, `${beachesByOcean}/${beaches} beaches`)
  assert.ok(rivers > 60 && connectedRivers / rivers > 0.9, `${connectedRivers}/${rivers} rivers`)
  assert.ok(hillCells > 50 && connectedHills / hillCells > 0.95, `${connectedHills}/${hillCells} hills`)
  assert.equal(desertSnowEdges, 0)
  assert.ok(elapsed < 7_000, `96x96 layer sample took ${elapsed.toFixed(0)}ms`)
})
