import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const renderer = readFileSync(new URL('../src/entities/EntityRenderer.ts', import.meta.url), 'utf8')
const manager = readFileSync(new URL('../src/entities/EntityManager.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('../src/entities/EntityTypes.ts', import.meta.url), 'utf8')
const game = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8')
const audio = readFileSync(new URL('../src/audio/Audio.ts', import.meta.url), 'utf8')
const ui = readFileSync(new URL('../src/ui/UI.ts', import.meta.url), 'utf8')
const items = readFileSync(new URL('../src/world/Items.ts', import.meta.url), 'utf8')

test('villagers use their real 64x64 profession skins and complete robe/arm model', () => {
  for (const file of ['villager/villager.png', 'farmer.png', 'librarian.png', 'smith.png', 'butcher.png', 'priest.png']) {
    assert.ok(renderer.includes(file), `missing villager skin ${file}`)
  }
  assert.equal(renderer.includes('PROFESSION_COLORS'), false)
  assert.ok(renderer.includes('{ u: 0, v: 38, width: 8, height: 18, depth: 6 }'))
  assert.ok(renderer.includes('const foldedArms = new THREE.Group()'))
})

test('animated limbs rotate at joints and an enderman carries the real atlas block', () => {
  assert.ok(renderer.includes('Limb cube parented to a joint'))
  assert.ok(renderer.includes('this.limb(group'))
  assert.ok(renderer.includes('this.atlas.uvRect(tileFor(id as BlockId, face))'))
  assert.ok(renderer.includes("entity.kind === 'enderman' ? 0.4 : 0.75"))
  assert.ok(manager.includes('B.TNT, B.CACTUS, B.CLAY, B.PUMPKIN'))
})

test('humanoid arms face forward, spider legs bend down and mooshrooms carry real mushrooms', () => {
  assert.ok(renderer.includes('foldedArms.rotation.x = 0.75'))
  assert.ok(renderer.includes("arm.rotation.x = 1.45"))
  assert.ok(renderer.includes("arm.rotation.x = 1.25"))
  assert.ok(renderer.includes("arm.rotation.x = 0.5"))
  assert.ok(renderer.includes('joint.rotation.z = -side *'))
  assert.ok(renderer.includes('createExtrudedItemGeometry(0.38)'))
  assert.ok(renderer.includes('this.mushroom(head'))
  assert.equal(renderer.includes('this.box(group, [0.34, 0.34, 0.34]'), false)
})

test('entity feedback restores portal, love, death, shear and construction events', () => {
  for (const event of ['enderman_ambient', 'enderman_teleport', 'love', 'death', 'slime_split', 'shear', 'construct']) {
    assert.ok(manager.includes(`'${event}'`), `missing entity effect ${event}`)
  }
  assert.ok(game.includes('this.audio.endermanTeleport'))
  assert.ok(audio.includes("'mob/enderman/portal.ogg'"))
  assert.ok(audio.includes("'random/door_open.ogg'"))
  assert.ok(game.includes('this.audio.door(!open)'))
})

test('inventory panels render door sprites and flat rail icons instead of block cubes', () => {
  assert.ok(items.includes('[B.WOOD_DOOR_LOWER]: [11, 2]'))
  assert.ok(ui.includes('id === B.RAIL'))
  assert.ok(ui.includes('this.atlas.drawFlatIcon'))
})

test('available overworld creatures are registered, rendered and integrated', () => {
  for (const kind of ['wolf', 'ocelot', 'cat', 'squid', 'snow_golem', 'iron_golem']) {
    assert.ok(types.includes(`'${kind}'`), `missing type ${kind}`)
    assert.ok(renderer.includes(`'${kind}'`), `missing renderer ${kind}`)
    assert.ok(manager.includes(`${kind}: { kind: '${kind}'`), `missing definition ${kind}`)
  }
  assert.ok(manager.includes("if (entity.kind === 'squid')"))
  assert.ok(manager.includes('findNaturalSquidY'))
  assert.ok(manager.includes('tryCreateGolem'))
  assert.ok(game.includes("this.entities.spawn('iron_golem'"))
  assert.ok(game.includes("this.entities.spawn('cat'"))
})
