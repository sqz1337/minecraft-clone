import { ITEMS } from '../world/Items'
import { parseEnchantments, type EnchantmentInstance } from './Enchantments'

export const INVENTORY_SIZE = 36
export const HOTBAR_SIZE = 9

export interface ItemStack {
  id: number
  count: number
  /** Wear of a damageable item (tools); undefined for pristine/stackable items. */
  damage?: number
  /** Persistent classic enchantment data shared by inventory, equipment and drops. */
  enchantments?: EnchantmentInstance[]
}

export type SerializedInventory = Array<ItemStack | null>

function validStack(value: unknown): value is ItemStack {
  if (!value || typeof value !== 'object') return false
  const stack = value as Partial<ItemStack>
  const item = Number.isInteger(stack.id) ? ITEMS[stack.id as number] : null
  if (!item || !Number.isInteger(stack.count) || (stack.count as number) <= 0) return false
  if (stack.damage !== undefined && (!Number.isInteger(stack.damage) || (stack.damage as number) < 0)) return false
  return stack.enchantments === undefined || parseEnchantments(stack.enchantments, stack.id as number) !== undefined
}

export function cloneStack(stack: ItemStack): ItemStack {
  return {
    id: stack.id,
    count: stack.count,
    ...(stack.damage !== undefined ? { damage: stack.damage } : {}),
    ...(stack.enchantments?.length
      ? { enchantments: stack.enchantments.map(enchantment => ({ ...enchantment })) }
      : {})
  }
}

export class Inventory {
  readonly slots: Array<ItemStack | null> = Array(INVENTORY_SIZE).fill(null)
  onChange: () => void = () => {}

  restore(data: unknown): void {
    this.slots.fill(null)
    if (Array.isArray(data)) {
      for (let i = 0; i < Math.min(INVENTORY_SIZE, data.length); i++) {
        const raw = data[i]
        if (!validStack(raw)) continue
        const max = ITEMS[raw.id]!.stackSize
        const enchantments = parseEnchantments(raw.enchantments, raw.id)
        this.slots[i] = cloneStack({
          ...raw,
          count: Math.min(max, raw.count),
          ...(enchantments ? { enchantments } : {})
        })
      }
    }
    this.onChange()
  }

  serialize(): SerializedInventory {
    return this.slots.map(stack => stack ? cloneStack(stack) : null)
  }

  /** Adds items to existing stacks first. Returns the amount that did not fit. */
  add(id: number, count = 1, damage?: number, enchantments?: EnchantmentInstance[]): number {
    const item = ITEMS[id]
    if (!item || count <= 0) return count
    let left = count
    if (item.stackSize > 1 && damage === undefined && !enchantments?.length) {
      for (const stack of this.slots) {
        if (!stack || stack.id !== id || stack.damage !== undefined || stack.count >= item.stackSize) continue
        const moved = Math.min(left, item.stackSize - stack.count)
        stack.count += moved
        left -= moved
        if (left === 0) break
      }
    }
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (this.slots[i]) continue
      const moved = Math.min(left, item.stackSize)
      this.slots[i] = {
        id,
        count: moved,
        ...(damage !== undefined ? { damage } : {}),
        ...(enchantments?.length ? { enchantments: enchantments.map(enchantment => ({ ...enchantment })) } : {})
      }
      left -= moved
    }
    if (left !== count) this.onChange()
    return left
  }

  remove(slot: number, count = 1): boolean {
    const stack = this.slots[slot]
    if (!stack || count <= 0 || stack.count < count) return false
    stack.count -= count
    if (stack.count === 0) this.slots[slot] = null
    this.onChange()
    return true
  }

  swap(a: number, b: number): void {
    if (a === b || a < 0 || b < 0 || a >= INVENTORY_SIZE || b >= INVENTORY_SIZE) return
    ;[this.slots[a], this.slots[b]] = [this.slots[b], this.slots[a]]
    this.onChange()
  }

  /** Fire onChange after slots were mutated directly (crafting screen clicks). */
  notify(): void {
    this.onChange()
  }

  clear(): void {
    this.slots.fill(null)
    this.onChange()
  }
}
