import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  stdin: {
    contents: [
      "export * from './src/player/Experience.ts'",
      "export * from './src/player/Enchantments.ts'",
      "export { Inventory, cloneStack } from './src/player/Inventory.ts'",
      "export { Equipment } from './src/player/Equipment.ts'",
      "export * from './src/player/Combat.ts'",
      "export { EntityManager } from './src/entities/EntityManager.ts'",
      "export { WorldSaveStore } from './src/core/WorldSave.ts'",
      "export { matchRecipe } from './src/world/Recipes.ts'",
      "export { B } from './src/world/Blocks.ts'",
      "export { I } from './src/world/ItemIds.ts'",
      "export { ITEMS } from './src/world/Items.ts'"
    ].join(';'),
    resolveDir: process.cwd(), sourcefile: 'stage10-test-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': "'/'" }, logLevel: 'silent'
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  await import('node:module').then(({ createRequire }) => createRequire(import.meta.url)),
  bundledModule, bundledModule.exports
)

const {
  B, I, ITEMS, Inventory, Equipment, EntityManager, WorldSaveStore, matchRecipe,
  experienceToNextLevel, experienceForLevel, levelForExperience, experienceProgress,
  spendExperienceLevels, experienceAfterDeath, generateEnchantmentOffers,
  applyEnchantmentOffer, enchantmentLevel, stackDisplayName, shouldConsumeDurability,
  efficiencyMultiplier, fortuneDropCount, sharpnessBonus, damageAfterArmor, bowDamage
} = bundledModule.exports

test('stage 10 registers books, bookshelves, enchanting tables and their recipes', () => {
  assert.equal(ITEMS[I.PAPER].name, 'Paper')
  assert.equal(ITEMS[I.BOOK].name, 'Book')
  assert.equal(ITEMS[B.BOOKSHELF].placeBlock, B.BOOKSHELF)
  assert.equal(ITEMS[B.ENCHANTING_TABLE].placeBlock, B.ENCHANTING_TABLE)

  const table = [
    null, { id: I.BOOK, count: 1 }, null,
    { id: I.DIAMOND, count: 1 }, { id: B.OBSIDIAN, count: 1 }, { id: I.DIAMOND, count: 1 },
    { id: B.OBSIDIAN, count: 1 }, { id: B.OBSIDIAN, count: 1 }, { id: B.OBSIDIAN, count: 1 }
  ]
  assert.deepEqual(matchRecipe(table, 3), { id: B.ENCHANTING_TABLE, count: 1 })
})

test('experience levels, spending and full death loss are internally consistent', () => {
  assert.equal(experienceToNextLevel(0), 7)
  assert.equal(levelForExperience(experienceForLevel(18)), 18)
  const total = experienceForLevel(12) + 5
  assert.deepEqual(experienceProgress(total), {
    total, level: 12, intoLevel: 5, nextLevel: experienceToNextLevel(12),
    fraction: 5 / experienceToNextLevel(12)
  })
  assert.equal(spendExperienceLevels(total, 4), experienceForLevel(8) + 5)
  assert.equal(spendExperienceLevels(total, 13), null)
  // vanilla drop: 7 × current level, capped at 100 and at the actual XP held
  const death = experienceAfterDeath(250)
  assert.deepEqual(death, { retained: 0, dropped: 7 * levelForExperience(250) })
  assert.deepEqual(experienceAfterDeath(10_000), { retained: 0, dropped: 100 })
  // below level 1 nothing drops (7 × level 0)
  assert.deepEqual(experienceAfterDeath(5), { retained: 0, dropped: 0 })
})

test('classic offers are deterministic, priced by bookshelf power and applicable once', () => {
  const first = generateEnchantmentOffers(I.DIAMOND_PICKAXE, 30, 12345)
  const second = generateEnchantmentOffers(I.DIAMOND_PICKAXE, 30, 12345)
  assert.deepEqual(first, second)
  assert.equal(first.length, 3)
  assert.ok(first.every(offer => offer.cost >= 1 && offer.cost <= 50 && offer.enchantments.length > 0))
  assert.ok(first[2].cost >= first[1].cost && first[1].cost >= first[0].cost)

  const stack = { id: I.DIAMOND_PICKAXE, count: 1 }
  assert.equal(applyEnchantmentOffer(stack, first[2]), true)
  assert.ok(stack.enchantments.length > 0)
  assert.equal(applyEnchantmentOffer(stack, first[0]), false)
  assert.ok(stackDisplayName(stack).includes('\n'))
})

test('enchantment effects feed mining, durability, combat, armor and bows', () => {
  assert.equal(efficiencyMultiplier(3), 10)
  assert.equal(shouldConsumeDurability(3, () => 0.24), true)
  assert.equal(shouldConsumeDurability(3, () => 0.26), false)
  assert.equal(fortuneDropCount(1, 3, () => 0.99), 4)
  assert.equal(sharpnessBonus(4), 5)
  assert.ok(damageAfterArmor(10, 10, 4) < damageAfterArmor(10, 10, 0))
  assert.ok(bowDamage(1, 4) > bowDamage(1, 0))
})

test('enchantments survive inventory, equipment and world-save validation', () => {
  const enchantments = [{ id: 'protection', level: 4 }, { id: 'unbreaking', level: 3 }]
  const inventory = new Inventory()
  inventory.add(I.DIAMOND_HELMET, 1, 7, enchantments)
  const restored = new Inventory()
  restored.restore(inventory.serialize())
  assert.deepEqual(restored.slots[0].enchantments, enchantments)

  const equipment = new Equipment()
  equipment.restore([{ id: I.DIAMOND_HELMET, count: 1, damage: 7, enchantments }, null, null, null])
  assert.equal(equipment.protectionLevels, 4)
  assert.equal(enchantmentLevel(equipment.slots[0], 'unbreaking'), 3)

  const memory = new Map()
  globalThis.localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value)
  }
  const store = new WorldSaveStore('stage-10')
  assert.equal(store.save({
    player: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flying: false, noclip: false,
      hotbarPage: 0, selectedSlot: 0, health: 20, hunger: 20, saturation: 5, air: 10,
      exhaustion: 0, experience: 987 },
    gameMode: 'survival', inventory: restored.serialize(), armor: equipment.serialize(), drops: [], containers: [],
    timeOfDay: 0.25, weather: { kind: 'clear', nextChange: 10, lightningTimer: 10, out: {} },
    blockEdits: {}, blockFacings: {}, scheduledTicks: [], entities: []
  }), true)
  const loaded = store.load()
  assert.equal(loaded.player.experience, 987)
  assert.deepEqual(loaded.inventory[0].enchantments, enchantments)
  assert.deepEqual(loaded.armor[0].enchantments, enchantments)
})

test('mob deaths emit recoverable XP through the shared entity hook', () => {
  const world = {
    getBlock: (_x, y) => y <= 0 ? B.GRASS : B.AIR, isSolid: (_x, y) => y <= 0, isWater: () => false,
    topSolidY: () => 0, biomeAt: () => 2, getLightLevel: () => 15
  }
  const experience = []
  const manager = new EntityManager(world, undefined, { experience: (_x, _y, _z, amount) => experience.push(amount) })
  const zombie = manager.spawn('zombie', 0, 1, 0)
  manager.damage(zombie.id, 100, 0, 1)
  assert.deepEqual(experience, [])
  for (let i = 0; i < 15; i++) manager.update(0.05, { player: { x: 0, y: 1, z: 0 }, heldItem: null })
  assert.deepEqual(experience, [5])
})
