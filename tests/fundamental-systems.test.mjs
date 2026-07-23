import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'

const bundle = buildSync({
  stdin: {
    contents: [
      "export { B, blockCollisionBox, doorCollisionBox } from './src/world/Blocks.ts'",
      "export { addBedBlock } from './src/world/MesherModels.ts'",
      "export { GeomBuilder } from './src/world/MesherShared.ts'",
      "export { vanillaCelestialPhase, horizonFogDensity, horizonHazeOpacity } from './src/gfx/Environment.ts'"
    ].join(';'),
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
const {
  B, blockCollisionBox, doorCollisionBox, addBedBlock, GeomBuilder, vanillaCelestialPhase, horizonFogDensity,
  horizonHazeOpacity
} = bundledModule.exports

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

test('bed geometry keeps the vanilla wooden underside three pixels above the floor', () => {
  const builder = new GeomBuilder()
  addBedBlock(builder, { uvRect: () => [0, 0, 1, 1] }, 10, 20, 30, B.BED_HEAD, 4, 15, () => B.AIR)
  const geometry = builder.build(false)
  const positions = geometry.getAttribute('position')
  const normals = geometry.getAttribute('normal')
  const undersideY = []
  for (let index = 0; index < positions.count; index++) {
    if (normals.getY(index) === -1) undersideY.push(positions.getY(index))
  }
  assert.deepEqual(undersideY, [20.1875, 20.1875, 20.1875, 20.1875])
})

test('bed top UVs keep the pillow axis aligned with the bed direction', () => {
  const expected = {
    4: [0, 0, 1, 0, 0, 1, 1, 1],
    5: [1, 1, 0, 1, 1, 0, 0, 0],
    0: [0, 1, 0, 0, 1, 1, 1, 0],
    1: [1, 0, 1, 1, 0, 0, 0, 1]
  }
  for (const [facing, wanted] of Object.entries(expected)) {
    const builder = new GeomBuilder()
    addBedBlock(builder, { uvRect: () => [0, 0, 1, 1] }, 0, 0, 0, B.BED_HEAD, Number(facing), 15, () => B.AIR)
    const uv = builder.build(false).getAttribute('uv')
    const actual = []
    for (let index = 0; index < 4; index++) actual.push(uv.getX(index), uv.getY(index))
    assert.deepEqual(actual, wanted)
  }
})

test('bed side UVs mirror the classic outer leg face', () => {
  const flippedFaceOffset = { 4: 4, 5: 8, 0: 16, 1: 12 }
  for (const [facing, offset] of Object.entries(flippedFaceOffset)) {
    const builder = new GeomBuilder()
    addBedBlock(builder, { uvRect: () => [0, 0, 1, 1] }, 0, 0, 0, B.BED_HEAD, Number(facing), 15, () => B.AIR)
    const uv = builder.build(false).getAttribute('uv')
    assert.deepEqual(
      [uv.getX(offset), uv.getX(offset + 1), uv.getX(offset + 2), uv.getX(offset + 3)],
      [1, 0, 1, 0]
    )
  }
})

test('sun motion uses the classic smoothed 20-minute celestial cycle', () => {
  assert.equal(vanillaCelestialPhase(0.25), 0)
  assert.equal(vanillaCelestialPhase(0.75), 0.5)
  const clock = 17.5 / 24
  const linearSunY = Math.sin(2 * Math.PI * (clock - 0.25))
  const smoothedSunY = Math.sin(2 * Math.PI * vanillaCelestialPhase(clock))
  assert.ok(smoothedSunY > linearSunY, 'classic curve should retain more evening light')
  const environment = readFileSync(new URL('../src/gfx/Environment.ts', import.meta.url), 'utf8')
  assert.ok(environment.includes('dayLengthSec = 1200'))
})

test('high viewpoints gain enough horizon haze to hide the square chunk edge', () => {
  const seaLevelDensity = horizonFogDensity(112, 64)
  const mountainDensity = horizonFogDensity(112, 106)
  assert.ok(mountainDensity > seaLevelDensity)
  assert.ok(Math.exp(-((mountainDensity * 112) ** 2)) < 0.04)
  assert.equal(horizonHazeOpacity(64), 0)
  assert.equal(horizonHazeOpacity(98), 1)
  assert.equal(horizonHazeOpacity(106), 1)
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
  assert.ok(audio.includes("category === 'music' ? this.musicVolume : this.soundVolume"))
  assert.ok(audio.includes("'random/burp.ogg'"))
})

test('bed cutouts, sleeping, eating and respawn streaming keep their dedicated paths', () => {
  const materials = readFileSync(new URL('../src/gfx/Materials.ts', import.meta.url), 'utf8')
  const game = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8')
  const loop = readFileSync(new URL('../src/core/GameLoop.ts', import.meta.url), 'utf8')
  const input = readFileSync(new URL('../src/core/GameInput.ts', import.meta.url), 'utf8')
  const eating = readFileSync(new URL('../src/player/InteractionUpdate.ts', import.meta.url), 'utf8')
  assert.ok(materials.includes('alphaTest: 0.42'))
  assert.ok(game.includes("document.addEventListener('contextmenu', (e) => e.preventDefault())"))
  assert.ok(input.includes('Vanilla snaps directly into the sleeping view'))
  assert.ok(loop.indexOf('ensureGeneratedAt(target.x') < loop.indexOf('this.player.teleport(target.x'))
  assert.ok(eating.includes('this.eatSoundTimer += 0.2'))
})
