import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'

const bundle = buildSync({
  stdin: {
    contents: "export { B, blockCollisionBox, doorCollisionBox } from './src/world/Blocks.ts'",
    resolveDir: process.cwd(),
    sourcefile: 'fundamental-systems-test-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule,
  bundledModule.exports
)
const { B, blockCollisionBox, doorCollisionBox } = bundledModule.exports

test('doors, beds and chests expose model-shaped collision boxes', () => {
  assert.deepEqual(doorCollisionBox(B.WOOD_DOOR_LOWER, 4), {
    minX: 0, minY: 0, minZ: 13 / 16, maxX: 1, maxY: 1, maxZ: 1
  })
  assert.deepEqual(doorCollisionBox(B.WOOD_DOOR_LOWER_OPEN, 4), {
    minX: 13 / 16, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1
  })
  assert.equal(blockCollisionBox(B.BED_FOOT).maxY, 9 / 16)
  assert.equal(blockCollisionBox(B.CHEST).maxY, 14 / 16)
})

test('dropped sprite items and doors are real volumetric meshes', () => {
  const drops = readFileSync(new URL('../src/world/ItemDrops.ts', import.meta.url), 'utf8')
  const mesher = readFileSync(new URL('../src/world/Mesher.ts', import.meta.url), 'utf8')
  assert.ok(drops.includes('createExtrudedItemGeometry'))
  assert.equal(drops.includes('new THREE.PlaneGeometry'), false)
  assert.ok(mesher.includes('doorCollisionBox'))
  assert.ok(mesher.includes('for (let face = 0; face < FACES.length; face++)'))
})

test('world ticks are sampled per section instead of starving a stable Set suffix', () => {
  const world = readFileSync(new URL('../src/world/World.ts', import.meta.url), 'utf8')
  assert.ok(world.includes('RANDOM_TICKS_PER_SECTION'))
  assert.ok(world.includes('for (let sectionY = 0; sectionY < WORLD_HEIGHT'))
  assert.equal(world.includes('processed >= 512'), false)
})

test('mob motion uses fixed-step snapshots and velocity-space separation', () => {
  const manager = readFileSync(new URL('../src/entities/EntityManager.ts', import.meta.url), 'utf8')
  const renderer = readFileSync(new URL('../src/entities/EntityRenderer.ts', import.meta.url), 'utf8')
  assert.ok(manager.includes('previousX'))
  assert.ok(manager.includes('Local avoidance belongs in velocity space'))
  assert.equal(manager.includes('private pushIfFree'), false)
  assert.ok(renderer.includes('renderAlpha'))
  assert.ok(renderer.includes('entity.previousYaw'))
})

test('audio owns HRTF panners, category buses and a camera-driven listener', () => {
  const audio = readFileSync(new URL('../src/audio/Audio.ts', import.meta.url), 'utf8')
  const game = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8')
  assert.ok(audio.includes('createPanner()'))
  assert.ok(audio.includes("panner.panningModel = 'HRTF'"))
  assert.ok(audio.includes('setOcclusionProbe('))
  assert.ok(audio.includes("obstruction.type = 'lowpass'"))
  assert.ok(audio.includes('HOSTILE_SOUND_KINDS.has(kind) ? position : undefined'))
  assert.ok(audio.includes('updateListener('))
  assert.ok(game.includes('this.audio.updateListener(this.camera.position'))
})
