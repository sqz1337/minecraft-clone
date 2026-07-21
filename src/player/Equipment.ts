import { ITEMS, type ArmorSlot } from '../world/Items'
import { B } from '../world/Blocks'
import { ARMOR_SLOTS } from './Combat'
import { cloneStack, type ItemStack } from './Inventory'
import { enchantmentLevel, shouldConsumeDurability } from './Enchantments'

export type SerializedEquipment = Array<ItemStack | null>

/** Four persistent armor slots in GUI order: head, chest, legs, feet. */
export class Equipment {
  readonly slots: Array<ItemStack | null> = Array(4).fill(null)
  onChange: () => void = () => {}

  get armorPoints(): number {
    return this.slots.reduce((sum, stack) => sum + (stack ? ITEMS[stack.id]?.armor?.points ?? 0 : 0), 0)
  }

  get protectionLevels(): number {
    return this.slots.reduce((sum, stack) => sum +
      enchantmentLevel(stack, 'protection') +
      enchantmentLevel(stack, 'fire_protection') +
      enchantmentLevel(stack, 'blast_protection') +
      enchantmentLevel(stack, 'projectile_protection'), 0)
  }

  get featherFallingLevel(): number {
    return this.slots.reduce((max, stack) => Math.max(max, enchantmentLevel(stack, 'feather_falling')), 0)
  }

  get respirationLevel(): number {
    return this.slots.reduce((max, stack) => Math.max(max, enchantmentLevel(stack, 'respiration')), 0)
  }

  get aquaAffinity(): boolean {
    return this.slots.some(stack => enchantmentLevel(stack, 'aqua_affinity') > 0)
  }

  accepts(index: number, stack: ItemStack | null): boolean {
    return stack === null || (index === 0 && stack.id === B.PUMPKIN) ||
      ITEMS[stack.id]?.armor?.slot === ARMOR_SLOTS[index]
  }

  damageAll(amount = 1): void {
    let changed = false
    for (let i = 0; i < this.slots.length; i++) {
      const stack = this.slots[i]
      const durability = stack ? ITEMS[stack.id]?.armor?.durability ?? 0 : 0
      if (!stack || durability <= 0) continue
      if (!shouldConsumeDurability(enchantmentLevel(stack, 'unbreaking'))) continue
      stack.damage = (stack.damage ?? 0) + Math.max(1, Math.floor(amount))
      if (stack.damage >= durability) this.slots[i] = null
      changed = true
    }
    if (changed) this.onChange()
  }

  serialize(): SerializedEquipment {
    return this.slots.map(stack => stack ? cloneStack(stack) : null)
  }

  restore(saved?: readonly (ItemStack | null)[]): void {
    this.slots.fill(null)
    if (saved) for (let i = 0; i < Math.min(4, saved.length); i++) {
      const stack = saved[i]
      const durability = stack ? ITEMS[stack.id]?.armor?.durability ?? 0 : 0
      const intact = stack?.id === B.PUMPKIN || (stack && durability > 0 && (stack.damage ?? 0) < durability)
      if (stack && this.accepts(i, stack) && intact) {
        this.slots[i] = cloneStack({ ...stack, count: 1 })
      }
    }
    this.onChange()
  }
}
