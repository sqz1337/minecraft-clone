import type { ItemStack } from './Inventory'
import { ITEMS } from '../world/Items'

export const ENCHANTMENT_IDS = [
  'protection', 'fire_protection', 'feather_falling', 'blast_protection', 'projectile_protection',
  'respiration', 'aqua_affinity', 'sharpness', 'smite', 'bane_of_arthropods', 'knockback',
  'fire_aspect', 'looting', 'efficiency', 'silk_touch', 'unbreaking', 'fortune',
  'power', 'punch', 'flame', 'infinity'
] as const

export type EnchantmentId = typeof ENCHANTMENT_IDS[number]

export interface EnchantmentInstance {
  id: EnchantmentId
  level: number
}

interface EnchantmentDefinition {
  name: string
  maxLevel: number
  minCost: number
  weight: number
  group?: string
  accepts: (itemId: number) => boolean
}

const item = (id: number) => ITEMS[id]
const isArmor = (id: number) => !!item(id)?.armor
const armorSlot = (id: number, slot: string) => item(id)?.armor?.slot === slot
const isSword = (id: number) => item(id)?.tool?.type === 'sword'
const isTool = (id: number) => {
  const type = item(id)?.tool?.type
  return type === 'pickaxe' || type === 'axe' || type === 'shovel'
}
const isDamageable = (id: number) => !!item(id) && item(id)!.stackSize === 1
const isBow = (id: number) => item(id)?.ranged === 'bow'

export const ENCHANTMENTS: Readonly<Record<EnchantmentId, EnchantmentDefinition>> = {
  protection: { name: 'Protection', maxLevel: 4, minCost: 1, weight: 10, group: 'protection', accepts: isArmor },
  fire_protection: { name: 'Fire Protection', maxLevel: 4, minCost: 10, weight: 5, group: 'protection', accepts: isArmor },
  feather_falling: { name: 'Feather Falling', maxLevel: 4, minCost: 5, weight: 5, accepts: id => armorSlot(id, 'feet') },
  blast_protection: { name: 'Blast Protection', maxLevel: 4, minCost: 5, weight: 2, group: 'protection', accepts: isArmor },
  projectile_protection: { name: 'Projectile Protection', maxLevel: 4, minCost: 3, weight: 5, group: 'protection', accepts: isArmor },
  respiration: { name: 'Respiration', maxLevel: 3, minCost: 10, weight: 2, accepts: id => armorSlot(id, 'head') },
  aqua_affinity: { name: 'Aqua Affinity', maxLevel: 1, minCost: 1, weight: 2, accepts: id => armorSlot(id, 'head') },
  sharpness: { name: 'Sharpness', maxLevel: 5, minCost: 1, weight: 10, group: 'weapon_damage', accepts: isSword },
  smite: { name: 'Smite', maxLevel: 5, minCost: 5, weight: 5, group: 'weapon_damage', accepts: isSword },
  bane_of_arthropods: { name: 'Bane of Arthropods', maxLevel: 5, minCost: 5, weight: 5, group: 'weapon_damage', accepts: isSword },
  knockback: { name: 'Knockback', maxLevel: 2, minCost: 5, weight: 5, accepts: isSword },
  fire_aspect: { name: 'Fire Aspect', maxLevel: 2, minCost: 10, weight: 2, accepts: isSword },
  looting: { name: 'Looting', maxLevel: 3, minCost: 15, weight: 2, accepts: isSword },
  efficiency: { name: 'Efficiency', maxLevel: 5, minCost: 1, weight: 10, accepts: isTool },
  silk_touch: { name: 'Silk Touch', maxLevel: 1, minCost: 15, weight: 1, group: 'harvest', accepts: isTool },
  unbreaking: { name: 'Unbreaking', maxLevel: 3, minCost: 5, weight: 5, accepts: isDamageable },
  fortune: { name: 'Fortune', maxLevel: 3, minCost: 15, weight: 2, group: 'harvest', accepts: isTool },
  power: { name: 'Power', maxLevel: 5, minCost: 1, weight: 10, accepts: isBow },
  punch: { name: 'Punch', maxLevel: 2, minCost: 12, weight: 2, accepts: isBow },
  flame: { name: 'Flame', maxLevel: 1, minCost: 20, weight: 2, accepts: isBow },
  infinity: { name: 'Infinity', maxLevel: 1, minCost: 20, weight: 1, accepts: isBow }
}

export interface EnchantmentOffer {
  cost: number
  enchantments: EnchantmentInstance[]
  clue: string
}

export interface EnchantingState {
  cursor: ItemStack | null
  /** One enchantable item slot. */
  slots: Array<ItemStack | null>
  offers: EnchantmentOffer[]
  bookshelfPower: number
  seed: number
}

function hashSeed(seed: number): number {
  let value = seed | 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  return (value ^ (value >>> 16)) >>> 0
}

function randomGenerator(seed: number): () => number {
  let state = hashSeed(seed) || 0x6d2b79f5
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function canEnchantItem(itemId: number): boolean {
  return ENCHANTMENT_IDS.some(id => ENCHANTMENTS[id].accepts(itemId))
}

function levelFor(definition: EnchantmentDefinition, cost: number, random: () => number): number {
  const span = Math.max(1, Math.floor((cost - definition.minCost) / 10) + 1)
  return Math.max(1, Math.min(definition.maxLevel, 1 + Math.floor(random() * span)))
}

function chooseEnchantments(itemId: number, cost: number, random: () => number): EnchantmentInstance[] {
  const pool = ENCHANTMENT_IDS.filter(id => {
    const definition = ENCHANTMENTS[id]
    return definition.accepts(itemId) && cost >= definition.minCost
  })
  const chosen: EnchantmentInstance[] = []
  const groups = new Set<string>()
  while (pool.length && chosen.length < 3) {
    const eligible = pool.filter(id => !ENCHANTMENTS[id].group || !groups.has(ENCHANTMENTS[id].group!))
    if (!eligible.length) break
    const totalWeight = eligible.reduce((sum, id) => sum + ENCHANTMENTS[id].weight, 0)
    let roll = random() * totalWeight
    let picked = eligible[eligible.length - 1]
    for (const id of eligible) {
      roll -= ENCHANTMENTS[id].weight
      if (roll <= 0) { picked = id; break }
    }
    const definition = ENCHANTMENTS[picked]
    chosen.push({ id: picked, level: levelFor(definition, cost, random) })
    if (definition.group) groups.add(definition.group)
    pool.splice(pool.indexOf(picked), 1)
    if (chosen.length > 0 && random() >= Math.min(0.55, cost / 70)) break
  }
  return chosen
}

/**
 * Deterministic classic offers. In the 1.2 era one visible bookshelf contributes
 * two power, up to 30, and the expensive slot can reach level 50.
 */
export function generateEnchantmentOffers(itemId: number, bookshelfPower: number, seed: number): EnchantmentOffer[] {
  if (!canEnchantItem(itemId)) return []
  const power = Math.max(0, Math.min(30, Math.floor(bookshelfPower)))
  const random = randomGenerator(seed ^ Math.imul(itemId, 31) ^ Math.imul(power, 131))
  const base = 1 + Math.floor(random() * 8) + Math.floor(power / 2) + Math.floor(random() * (power + 1))
  const costs = [
    Math.max(1, Math.floor(base / 3)),
    Math.max(1, Math.floor(base * 2 / 3) + 1),
    Math.max(1, Math.min(50, Math.max(base, power + 10)))
  ]
  return costs.map(cost => {
    const enchantments = chooseEnchantments(itemId, cost, random)
    const first = enchantments[0]
    return {
      cost,
      enchantments,
      clue: first ? enchantmentName(first) : 'Enchantment'
    }
  })
}

export function parseEnchantments(value: unknown, itemId: number): EnchantmentInstance[] | undefined {
  if (!Array.isArray(value) || !canEnchantItem(itemId)) return undefined
  const result: EnchantmentInstance[] = []
  const seen = new Set<EnchantmentId>()
  for (const raw of value.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue
    const id = (raw as Partial<EnchantmentInstance>).id
    const level = (raw as Partial<EnchantmentInstance>).level
    if (!ENCHANTMENT_IDS.includes(id as EnchantmentId) || seen.has(id as EnchantmentId) || !Number.isInteger(level)) continue
    const definition = ENCHANTMENTS[id as EnchantmentId]
    if (!definition.accepts(itemId)) continue
    result.push({ id: id as EnchantmentId, level: Math.max(1, Math.min(definition.maxLevel, level as number)) })
    seen.add(id as EnchantmentId)
  }
  return result.length ? result : undefined
}

export function applyEnchantmentOffer(stack: ItemStack, offer: EnchantmentOffer): boolean {
  if (stack.enchantments?.length || !canEnchantItem(stack.id) || !offer.enchantments.length) return false
  const enchantments = parseEnchantments(offer.enchantments, stack.id)
  if (!enchantments?.length) return false
  stack.enchantments = enchantments
  return true
}

export function enchantmentLevel(stack: ItemStack | null | undefined, id: EnchantmentId): number {
  return stack?.enchantments?.find(enchantment => enchantment.id === id)?.level ?? 0
}

export function enchantmentName(enchantment: EnchantmentInstance): string {
  const suffix = ENCHANTMENTS[enchantment.id].maxLevel > 1 ? ` ${romanNumeral(enchantment.level)}` : ''
  return ENCHANTMENTS[enchantment.id].name + suffix
}

export function stackDisplayName(stack: ItemStack): string {
  const base = ITEMS[stack.id]?.name ?? 'Unknown'
  if (!stack.enchantments?.length) return base
  return `${base}\n${stack.enchantments.map(enchantmentName).join('\n')}`
}

export function romanNumeral(level: number): string {
  return ['', 'I', 'II', 'III', 'IV', 'V'][Math.max(0, Math.min(5, Math.floor(level)))] || String(level)
}

export function shouldConsumeDurability(unbreakingLevel: number, random = Math.random): boolean {
  return random() < 1 / (Math.max(0, Math.floor(unbreakingLevel)) + 1)
}

export function efficiencyMultiplier(level: number): number {
  return level > 0 ? level * level + 1 : 1
}

export function fortuneDropCount(base: number, level: number, random = Math.random): number {
  if (level <= 0) return base
  const bonus = Math.max(0, Math.floor(random() * (level + 2)) - 1)
  return base * (bonus + 1)
}

/** Redstone's classic Fortune rule adds one bounded roll instead of multiplying the base stack. */
export function additiveFortuneDropCount(base: number, level: number, random = Math.random): number {
  return level > 0 ? base + Math.floor(random() * (Math.floor(level) + 1)) : base
}

/** Classic 1.0–1.8 Sharpness: +1.25 damage per level (the 0.5+0.5·lvl curve is 1.9+). */
export function sharpnessBonus(level: number): number {
  return level > 0 ? level * 1.25 : 0
}

export function powerBowBonus(level: number): number {
  return level > 0 ? 0.5 + level * 0.5 : 0
}

export function protectionReduction(levels: number): number {
  return Math.min(0.8, Math.max(0, levels) * 0.04)
}
