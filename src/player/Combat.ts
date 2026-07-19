import { ITEMS, type ArmorSlot } from '../world/Items'

export const MELEE_REACH = 4.5
export const ATTACK_COOLDOWN = 0.5
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

/** 20 armor points reduce 80% of incoming damage, matching the classic armor bar. */
export function damageAfterArmor(amount: number, armorPoints: number, protectionLevels = 0): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const points = Math.max(0, Math.min(MAX_ARMOR_POINTS, armorPoints))
  const armorReduced = amount * (1 - points / 25)
  const enchantmentReduction = Math.min(0.32, Math.max(0, protectionLevels) * 0.04)
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

/** Radial explosion damage with linear falloff; exposure is reserved for ray visibility. */
export function explosionDamage(distance: number, radius: number, exposure = 1): number {
  if (radius <= 0 || distance >= radius || exposure <= 0) return 0
  const impact = (1 - Math.max(0, distance) / radius) * Math.min(1, exposure)
  return Math.max(0, Math.floor((impact * impact + impact) * 7 * radius / 2 + 1))
}
