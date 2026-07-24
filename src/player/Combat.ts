import { ITEMS, type ArmorSlot } from '../world/Items'

/** Vanilla entity attack reach is ~3 blocks (block reach stays 4.5). */
export const MELEE_REACH = 3
/** Modern Java sword attack speed is 1.6 attacks/second. */
export const ATTACK_COOLDOWN = 1 / 1.6
export const MAX_ARMOR_POINTS = 20
export const ARMOR_SLOTS: readonly ArmorSlot[] = ['head', 'chest', 'legs', 'feet']

/** Classic 1.2.4 sword damage (wood/gold 4, stone 5, iron 6, diamond 7) with falling criticals. */
export function meleeDamage(itemId: number | null, critical = false, enchantmentBonus = 0): number {
  const item = itemId === null ? null : ITEMS[itemId]
  const tier = item?.tool?.type === 'sword' ? item.tool.tier.key : null
  const base = tier === 'diamond' ? 7 : tier === 'iron' ? 6 : tier === 'stone' ? 5 : tier ? 4 : 1
  const enchanted = base + Math.max(0, enchantmentBonus)
  return critical ? Math.floor(enchanted * 1.5) : enchanted
}

/** Java-style attack strength curve: spam retains 20%, a full charge deals 100%. */
export function chargedMeleeDamage(damage: number, charge: number): number {
  const strength = Math.max(0, Math.min(1, charge))
  return Math.max(0, damage * (0.2 + strength * strength * 0.8))
}

/** 20 armor points reduce 80% of incoming damage, matching the classic armor bar. */
export function damageAfterArmor(amount: number, armorPoints: number, protectionLevels = 0): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const points = Math.max(0, Math.min(MAX_ARMOR_POINTS, armorPoints))
  const armorReduced = amount * (1 - points / 25)
  // vanilla EPF cap: 20 levels × 4% = 80%
  const enchantmentReduction = Math.min(0.8, Math.max(0, protectionLevels) * 0.04)
  const reduced = armorReduced * (1 - enchantmentReduction)
  return Math.max(0, enchantmentReduction > 0 ? Math.floor(reduced) : Math.ceil(reduced))
}

/** Bow charge curve used by classic Minecraft; full charge is reached after 1 second. */
export function bowPower(chargeSeconds: number): number {
  const use = Math.max(0, chargeSeconds) / 1
  return Math.min(1, (use * use + use * 2) / 3)
}

/** Fully drawn arrows hit for 9 like classic Minecraft; Power adds 25% per level. */
export function bowDamage(power: number, powerEnchantment = 0): number {
  const base = Math.max(0, Math.min(1, power)) * 9
  return Math.max(1, Math.ceil(base * (1 + 0.25 * Math.max(0, powerEnchantment))))
}

export function bowVelocity(power: number): number {
  return 3 + Math.max(0, Math.min(1, power)) * 50
}

/** Standby and three classic items.png pulling frames; pulling frames include the arrow. */
export function bowPullSprite(chargeSeconds: number | null): readonly [column: number, row: number] {
  if (chargeSeconds === null) return [5, 1]
  if (chargeSeconds < 0.25) return [6, 1]
  if (chargeSeconds < 0.65) return [7, 1]
  return [8, 1]
}

/**
 * Vanilla explosion damage: reaches 2×power blocks, `impact = (1 − dist/(2·power))·exposure`,
 * `damage = 7·power·(impact² + impact) + 1` (TNT power 4 ≈ 30 max, creeper 3 ≈ 22).
 */
export function explosionDamage(distance: number, power: number, exposure = 1): number {
  const range = 2 * power
  if (power <= 0 || distance >= range || exposure <= 0) return 0
  const impact = (1 - Math.max(0, distance) / range) * Math.min(1, exposure)
  return Math.max(0, Math.floor((impact * impact + impact) * 7 * power + 1))
}
