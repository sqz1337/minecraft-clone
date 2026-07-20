import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { Interaction } from './src/player/Interaction.ts'",
      "export { World } from './src/world/World.ts'",
      "export { Chunk, ChunkState } from './src/world/Chunk.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export * as THREE from 'three'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'bugfix-regressions-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const { Interaction, World, Chunk, ChunkState, B, THREE } = bundledModule.exports

test('Q drops one complete survival stack as one entity', () => {
  const removed = []
  const spawned = []
  const interaction = Object.create(Interaction.prototype)
  Object.assign(interaction, {
    mode: 'survival', selected: 0, handSwing: 0,
    inventory: {
      slots: [{ id: B.DIRT, count: 64 }],
      remove: (slot, count) => { removed.push({ slot, count }); return true }
    },
    camera: new THREE.PerspectiveCamera(),
    rayDir: new THREE.Vector3(), rayOrigin: new THREE.Vector3(),
    drops: { spawn: (...args) => spawned.push(args) }
  })

  interaction.dropSelected()

  assert.deepEqual(removed, [{ slot: 0, count: 64 }])
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0][0], B.DIRT)
  assert.equal(spawned[0][4], 64)
})

function meshedChunk(cx, cz) {
  const chunk = new Chunk(cx, cz)
  chunk.state = ChunkState.MESHED
  return chunk
}

// numeric chunk key, mirrors World.ck
const ck = (cx, cz) => cx * 0x100000000 + cz

test('interior block refresh does not relight four unaffected neighbor chunks', () => {
  const center = meshedChunk(0, 0)
  const chunks = new Map([
    [ck(0, 0), center], [ck(1, 0), meshedChunk(1, 0)], [ck(-1, 0), meshedChunk(-1, 0)],
    [ck(0, 1), meshedChunk(0, 1)], [ck(0, -1), meshedChunk(0, -1)]
  ])
  const world = Object.create(World.prototype)
  Object.assign(world, { chunks, mutationBatchDepth: 0, dirtyChunkKeys: new Set() })
  const relit = []
  world.rebuildChunkLighting = chunk => { relit.push(`${chunk.cx},${chunk.cz}`); return 1 << 4 }
  world.remeshChunk = () => {}

  world.refreshChangedBlock(center, 8, 8)

  assert.deepEqual(relit, ['0,0'])
})

test('a changed light border still relights and remeshes its neighbor', () => {
  const center = meshedChunk(0, 0)
  const east = meshedChunk(1, 0)
  const world = Object.create(World.prototype)
  Object.assign(world, {
    chunks: new Map([[ck(0, 0), center], [ck(1, 0), east]]),
    mutationBatchDepth: 0, dirtyChunkKeys: new Set()
  })
  const relit = []
  const remeshed = []
  world.rebuildChunkLighting = chunk => {
    relit.push(`${chunk.cx},${chunk.cz}`)
    return chunk === center ? (1 << 4) | (1 << 0) : (1 << 4)
  }
  world.remeshChunk = chunk => remeshed.push(`${chunk.cx},${chunk.cz}`)

  world.refreshChangedBlock(center, 8, 8)

  assert.deepEqual(relit, ['0,0', '1,0'])
  assert.deepEqual(remeshed, ['0,0', '1,0'])
})
