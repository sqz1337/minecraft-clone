import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: "export * from './src/entities/VillageGraph.ts'",
    resolveDir: process.cwd(), sourcefile: 'village-graph-test-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)
const { VillageGraph } = bundledModule.exports

const door = (key, x, z, y = 2) => ({
  key, x, y, z, facing: 4,
  inside: { x, y, z: z - 1 },
  outside: { x, y, z: z + 1 }
})

const village = (id, centerX, centerZ, doors, radius = 12) => ({
  id, centerX, centerY: 2, centerZ, radius, doors
})

test('registration merges chunk fragments and deduplicates physical doors', () => {
  const graph = new VillageGraph()
  graph.registerVillage(village('alpha', 0, 0, [door('alpha:a', 1, 0), door('alpha:b', 3, 0)]))
  graph.registerVillage(village('alpha', 0, 0, [door('alpha:a', 1, 0), door('alpha:c', 5, 0)]))
  graph.registerVillage(village('alpha', 0, 0, [door('chunk-alias', 5, 0)]))

  assert.equal(graph.size, 1)
  assert.equal(graph.getVillage('alpha').doors.size, 3)
  assert.deepEqual(graph.listValidDoors('alpha').map(node => node.key), [
    'alpha:a', 'alpha:b', 'alpha:c'
  ])
  assert.equal(graph.getDoor('chunk-alias').key, 'alpha:c')
})

test('nearest village, containing village, and door queries use entity positions', () => {
  const graph = new VillageGraph()
  graph.registerVillage(village('alpha', 0, 0, [door('alpha:west', -4, 0), door('alpha:east', 4, 0)]))
  graph.registerVillage(village('beta', 40, 0, [door('beta:door', 38, 0)], 8))

  assert.equal(graph.nearestVillage({ x: 34, y: 2, z: 0 }).id, 'beta')
  assert.equal(graph.nearestVillage({ x: 34, y: 2, z: 0 }, 5), null)
  assert.equal(graph.villageAt({ x: 7, y: 100, z: 0 }).id, 'alpha', 'containment is horizontal')
  assert.equal(graph.villageAt({ x: 20, y: 2, z: 0 }), null)
  assert.equal(graph.nearestDoor({ x: 3, y: 2, z: 0 }).key, 'alpha:east')
  assert.equal(graph.nearestDoor({ x: 35, y: 2, z: 0 }, { villageId: 'alpha' }).key, 'alpha:east')
  assert.equal(graph.nearestDoor({ x: 0, y: 2, z: 0 }, { maxDistance: 2 }), null)
})

test('broken and removed doors stay out of queries until explicitly restored', () => {
  const graph = new VillageGraph()
  const metadata = village('alpha', 0, 0, [door('alpha:a', 1, 0), door('alpha:b', 5, 0)])
  graph.registerVillage(metadata)

  assert.equal(graph.markDoorBroken('alpha:a'), true)
  assert.equal(graph.markDoorBroken('alpha:a'), false)
  assert.equal(graph.getDoor('alpha:a'), null)
  assert.deepEqual(graph.listValidDoors('alpha').map(node => node.key), ['alpha:b'])
  assert.equal(graph.nearestDoor({ x: 1.5, y: 2, z: 0.5 }).key, 'alpha:b')
  assert.equal(graph.markDoorValid({ x: 1, y: 2, z: 0 }), true)
  assert.equal(graph.getDoor('alpha:a').key, 'alpha:a')

  assert.equal(graph.removeDoor('alpha:a'), true)
  assert.equal(graph.getVillage('alpha').doors.size, 1)
  graph.registerVillage(metadata)
  assert.equal(graph.getVillage('alpha').doors.size, 2)
  assert.equal(graph.isDoorValid('alpha:a'), false, 'overlapping chunk metadata must not resurrect it')
  assert.equal(graph.markDoorValid('alpha:a'), true)
  assert.equal(graph.isDoorValid('alpha:a'), true)
})

test('capacity follows valid door count with a one-villager minimum', () => {
  const graph = new VillageGraph()
  assert.equal(graph.capacity('missing'), 0)
  const doors = Array.from({ length: 10 }, (_, index) => door(`alpha:${index}`, index * 2, 0))
  graph.registerVillage(village('alpha', 0, 0, doors))

  assert.equal(graph.capacity('alpha'), 3)
  for (let index = 0; index < 5; index++) graph.markDoorBroken(`alpha:${index}`)
  assert.equal(graph.validDoorCount('alpha'), 5)
  assert.equal(graph.capacity('alpha'), 1)
  for (let index = 5; index < 10; index++) graph.markDoorBroken(`alpha:${index}`)
  assert.equal(graph.capacity('alpha'), 0)

  graph.markDoorValid('alpha:0')
  assert.equal(graph.capacity('alpha'), 1)
})
