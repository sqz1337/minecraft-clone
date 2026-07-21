import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { OreGenerator, ORE_PROFILES } from './src/world/OreGenerator.ts'",
      "export { Chunk } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'diff-ore-generator-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)
const { OreGenerator, ORE_PROFILES, Chunk, B } = bundledModule.exports

test('the 1.2.4 ore pass exposes every classic profile with exact counts, sizes and heights', () => {
  assert.deepEqual(ORE_PROFILES.map(({ key, attempts, size, height }) => ({ key, attempts, size, height })), [
    { key: 'dirt', attempts: 20, size: 32, height: 'uniform128' },
    { key: 'gravel', attempts: 10, size: 32, height: 'uniform128' },
    { key: 'coal', attempts: 20, size: 16, height: 'uniform128' },
    { key: 'iron', attempts: 20, size: 8, height: 'uniform64' },
    { key: 'gold', attempts: 2, size: 8, height: 'uniform32' },
    { key: 'redstone', attempts: 8, size: 7, height: 'uniform16' },
    { key: 'diamond', attempts: 1, size: 7, height: 'uniform16' },
    { key: 'lapis', attempts: 1, size: 6, height: 'triangular16' }
  ])
  assert.deepEqual(ORE_PROFILES.map(profile => profile.block), [
    B.DIRT, B.GRAVEL, B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE,
    B.REDSTONE_ORE, B.DIAMOND_ORE, B.LAPIS_ORE
  ])
})

test('one source consumes all 82 attempts and builds overlapping minable ellipsoids', () => {
  const generator = new OreGenerator(0x124)
  const plans = generator.plansForSource(-3, 5)
  assert.equal(plans.length, 82)
  for (const profile of ORE_PROFILES) {
    const matching = plans.filter(plan => plan.profile.key === profile.key)
    assert.equal(matching.length, profile.attempts, profile.key)
    for (const plan of matching) {
      assert.equal(plan.ellipsoids.length, profile.size + 1)
      assert.ok(plan.startX >= -48 && plan.startX < -32)
      assert.ok(plan.startZ >= 80 && plan.startZ < 96)
      const yLimit = profile.height === 'uniform128' ? 128
        : profile.height === 'uniform64' ? 64
          : profile.height === 'uniform32' ? 32
            : profile.height === 'uniform16' ? 16 : 31
      assert.ok(plan.startY >= 0 && plan.startY < yLimit, `${profile.key} y=${plan.startY}`)
      for (const ellipsoid of plan.ellipsoids) {
        assert.equal(ellipsoid.radiusX, ellipsoid.radiusY)
        assert.ok(ellipsoid.x - ellipsoid.radiusX >= plan.minX - 1)
        assert.ok(ellipsoid.x + ellipsoid.radiusX < plan.maxX + 1)
        assert.ok(ellipsoid.y - ellipsoid.radiusY >= plan.minY - 1)
        assert.ok(ellipsoid.y + ellipsoid.radiusY < plan.maxY + 1)
      }
    }
  }
  const fixture = plans[0]
  assert.deepEqual([fixture.startX, fixture.startY, fixture.startZ], [-39, 45, 95])
  assert.deepEqual(
    [fixture.minX, fixture.maxX, fixture.minY, fixture.maxY, fixture.minZ, fixture.maxZ],
    [-36, -27, 41, 46, 100, 105]
  )
  assert.deepEqual(fixture.ellipsoids.slice(0, 3).map(ellipsoid => [
    ellipsoid.x, ellipsoid.y, ellipsoid.z, ellipsoid.radiusX, ellipsoid.radiusY
  ].map(value => Number(value.toFixed(6)))), [
    [-27.125235, 44, 102.006928, 0.524148, 0.524148],
    [-27.367407, 44.03125, 102.068995, 1.182641, 1.182641],
    [-27.60958, 44.0625, 102.131062, 0.814301, 0.814301]
  ])
})

test('ore planning is deterministic for negative chunks and cache growth is bounded', () => {
  const first = new OreGenerator(0x51a2)
  const second = new OreGenerator(0x51a2)
  assert.deepEqual(first.plansForSource(-17, -9), second.plansForSource(-17, -9))
  assert.notDeepEqual(first.plansForSource(-17, -9), new OreGenerator(0x51a3).plansForSource(-17, -9))
  for (let cx = 0; cx < 700; cx++) first.plansForSource(cx, 0)
  assert.ok(first.cacheSize() <= 128)
})

test('triangular lapis height is the sum of two uniform 0..15 rolls', () => {
  const generator = new OreGenerator(0x1a915)
  const heights = []
  for (let source = 0; source < 1024; source++) {
    const lapis = generator.plansForSource(source - 512, source % 37 - 18)
      .find(plan => plan.profile.key === 'lapis')
    heights.push(lapis.startY)
  }
  const mean = heights.reduce((sum, value) => sum + value, 0) / heights.length
  assert.ok(Math.min(...heights) <= 2)
  assert.ok(Math.max(...heights) >= 28)
  assert.ok(mean > 14 && mean < 16, `triangular mean ${mean}`)
})

test('one selected destination plan continues across a seam and replaces stone only', () => {
  let fixture = null
  for (let seed = 1; seed < 160 && !fixture; seed++) {
    const generator = new OreGenerator(seed)
    for (const crossing of generator.plansForSource(0, 0)) {
      if (crossing.minX >= 16 || crossing.maxX < 16 || crossing.minY < 1 || crossing.maxY >= 127) continue
      const left = new Chunk(0, 0), right = new Chunk(1, 0)
      left.blocks.fill(B.STONE); right.blocks.fill(B.STONE)
      generator.stampPlanInto(left, crossing)
      generator.stampPlanInto(right, crossing)
      if (left.blocks.includes(crossing.profile.block) && right.blocks.includes(crossing.profile.block)) {
        fixture = { generator, crossing, left, right }
        break
      }
    }
  }
  assert.ok(fixture, 'expected a population vein crossing X=16')

  const protectedIndex = fixture.right.blocks.findIndex(id => id === fixture.crossing.profile.block)
  assert.ok(protectedIndex >= 0)
  const protectedChunk = new Chunk(1, 0)
  protectedChunk.blocks.fill(B.STONE)
  protectedChunk.blocks[protectedIndex] = B.BEDROCK
  fixture.generator.stampPlanInto(protectedChunk, fixture.crossing)
  assert.equal(protectedChunk.blocks[protectedIndex], B.BEDROCK, 'the selected vein must preserve non-stone cells')
})
