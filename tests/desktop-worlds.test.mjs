import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'

const bundle = buildSync({
  stdin: {
    contents: "export { WorldLibrary, WorldSaveStore } from './src/core/WorldSave.ts'; export { Settings, CONTROL_DEFINITIONS } from './src/core/Settings.ts'",
    resolveDir: process.cwd(),
    sourcefile: 'desktop-worlds-test-entry.ts',
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
const { WorldLibrary, WorldSaveStore, Settings, CONTROL_DEFINITIONS } = bundledModule.exports

function installStorage() {
  const values = new Map()
  globalThis.localStorage = {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    clear() { values.clear() }
  }
  return values
}

test('world catalog supports independent worlds with the same seed', async () => {
  installStorage()
  const library = new WorldLibrary()
  const first = await library.create('First', 'shared-seed', 'survival')
  const second = await library.create('Second', 'shared-seed', 'creative', true)

  assert.notEqual(first.id, second.id)
  assert.equal(first.silentHill, false)
  assert.equal(second.silentHill, true)
  assert.equal((await library.list()).length, 2)

  const firstStore = new WorldSaveStore(first.seed, first.id, first)
  const secondStore = new WorldSaveStore(second.seed, second.id, second)
  assert.equal(firstStore.save({ gameMode: 'survival', marker: 'first' }), true)
  assert.equal(secondStore.save({ gameMode: 'creative', marker: 'second' }), true)

  const firstRaw = localStorage.getItem(`realmcraft.world.v1.${encodeURIComponent(first.id)}`)
  const secondRaw = localStorage.getItem(`realmcraft.world.v1.${encodeURIComponent(second.id)}`)
  assert.equal(JSON.parse(firstRaw).marker, 'first')
  assert.equal(JSON.parse(secondRaw).marker, 'second')
  assert.equal(JSON.parse(secondRaw).silentHill, true)

  await library.delete(first)
  assert.deepEqual((await library.list()).map(world => world.name), ['Second'])
})

test('desktop shell exposes menus and native world commands', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8') +
    readFileSync(new URL('../src-tauri/src/raw_mouse.rs', import.meta.url), 'utf8')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))

  for (const id of [
    'btn-singleplayer', 'world-select', 'world-create', 'options',
    'video-settings', 'sound-settings', 'controls-list', 'opt-fov', 'opt-sensitivity',
    'btn-fullscreen', 'load-world-canvas', 'load-percent', 'btn-world-silent-hill',
    'btn-save-world', 'btn-quit', 'btn-quit-game'
  ]) assert.ok(html.includes(`id="${id}"`), id)
  assert.equal(html.includes('id="load-bar"'), false)
  assert.equal(html.includes('id="click-start"'), false)

  for (const command of [
    'list_worlds', 'register_world', 'load_world', 'save_world', 'delete_world',
    'set_game_cursor_lock', 'set_app_fullscreen', 'game-mouse-delta', 'quit_app'
  ]) {
    assert.ok(rust.includes(command), command)
  }
  const game = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8')
  assert.ok(game.includes('desktopCursor.lock()'))
  assert.ok(game.includes('desktopCursor.unlock()'))
  assert.ok(game.includes('setSilentHill(this.silentHill)'))
  assert.ok(game.includes('setSilentHillMode(this.silentHill)'))
  assert.ok(game.indexOf('setSilentHillMode(this.silentHill)') > game.indexOf('private enterPlaying()'))
  assert.ok(game.includes("this.state = 'ready'\n    this.requestPlay()"))
  assert.ok(rust.includes('silent_hill'))
  assert.equal(pkg.scripts['desktop:build'], 'tauri build')
  assert.equal(config.build.frontendDist, '../dist')
  assert.deepEqual(config.bundle.targets, ['nsis'])
})

test('controls, display options and fullscreen persist through Settings', () => {
  installStorage()
  const settings = new Settings()
  assert.ok(CONTROL_DEFINITIONS.length >= 17)
  assert.equal(settings.key('forward'), 'KeyW')
  assert.equal(settings.setKey('forward', 'KeyI'), true)
  assert.equal(settings.setKey('jump', 'Escape'), false)
  settings.fullscreen = true
  settings.fov = 92
  settings.mouseSensitivity = 0.75
  settings.invertMouse = true
  settings.soundVolume = 0.65
  settings.musicVolume = 0.25
  settings.save()

  const restored = new Settings()
  restored.load()
  assert.equal(restored.key('forward'), 'KeyI')
  assert.equal(restored.fullscreen, true)
  assert.equal(restored.fov, 92)
  assert.equal(restored.mouseSensitivity, 0.75)
  assert.equal(restored.invertMouse, true)
  assert.equal(restored.soundVolume, 0.65)
  assert.equal(restored.musicVolume, 0.25)
  restored.resetKeys()
  assert.equal(restored.key('forward'), 'KeyW')
})
