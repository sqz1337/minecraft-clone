import { ITEMS } from '../world/Items'
import { matchRecipe } from '../world/Recipes'
import { cloneStack, Inventory, ItemStack } from './Inventory'

export type CraftGridSize = 2 | 3

/** Anything that carries the stack picked up by the mouse cursor. */
export interface CursorHolder {
  cursor: ItemStack | null
}

/**
 * Classic slot click rules shared by every container screen: left click
 * picks up / places / swaps a whole stack, right click picks up half or
 * places a single item.
 */
export function clickStackSlot(holder: CursorHolder, slots: Array<ItemStack | null>, index: number, button: 0 | 2): void {
  const slot = slots[index]
  const cursor = holder.cursor
  if (button === 0) {
    if (!cursor) {
      slots[index] = null
      holder.cursor = slot
      return
    }
    const max = ITEMS[cursor.id]?.stackSize ?? 1
    if (slot && slot.id === cursor.id && slot.damage === undefined && cursor.damage === undefined &&
      !slot.enchantments?.length && !cursor.enchantments?.length && slot.count < max) {
      const moved = Math.min(cursor.count, max - slot.count)
      slot.count += moved
      cursor.count -= moved
      if (cursor.count === 0) holder.cursor = null
      return
    }
    slots[index] = cursor
    holder.cursor = slot
    return
  }

  // right click
  if (!cursor) {
    if (!slot) return
    const taken = Math.ceil(slot.count / 2)
    holder.cursor = cloneStack({ ...slot, count: taken })
    slot.count -= taken
    if (slot.count === 0) slots[index] = null
    return
  }
  const max = ITEMS[cursor.id]?.stackSize ?? 1
  if (!slot) {
    slots[index] = cloneStack({ ...cursor, count: 1 })
    cursor.count -= 1
    if (cursor.count === 0) holder.cursor = null
    return
  }
  if (slot.id === cursor.id && slot.damage === undefined && cursor.damage === undefined &&
    !slot.enchantments?.length && !cursor.enchantments?.length && slot.count < max) {
    slot.count += 1
    cursor.count -= 1
    if (cursor.count === 0) holder.cursor = null
  }
}

/**
 * Output-style slot (furnace result): the whole stack moves onto the
 * cursor; nothing can be placed into it. Returns true when taken.
 */
export function takeIntoCursor(holder: CursorHolder, slots: Array<ItemStack | null>, index: number): boolean {
  const slot = slots[index]
  if (!slot) return false
  const cursor = holder.cursor
  if (!cursor) {
    holder.cursor = slot
    slots[index] = null
    return true
  }
  const max = ITEMS[cursor.id]?.stackSize ?? 1
  if (cursor.id !== slot.id || cursor.damage !== undefined || slot.damage !== undefined ||
    cursor.enchantments?.length || slot.enchantments?.length ||
    cursor.count + slot.count > max) return false
  cursor.count += slot.count
  slots[index] = null
  return true
}

/** Empties loose stacks back into the inventory; overflow spills into the world. */
export function returnStacks(
  stacks: Array<ItemStack | null>,
  inventory: Inventory,
  spill: (stack: ItemStack) => void
): void {
  for (const stack of stacks) {
    if (!stack) continue
    const left = inventory.add(stack.id, stack.count, stack.damage, stack.enchantments)
    if (left > 0) spill(cloneStack({ ...stack, count: left }))
  }
}

/**
 * State of an open crafting screen: the craft grid, the stack carried on
 * the mouse cursor and the computed result.
 */
export class Crafting implements CursorHolder {
  readonly grid: Array<ItemStack | null>
  cursor: ItemStack | null = null

  constructor(readonly size: CraftGridSize) {
    this.grid = Array(size * size).fill(null)
  }

  get result(): ItemStack | null {
    const match = matchRecipe(this.grid, this.size)
    return match ? { id: match.id, count: match.count } : null
  }

  /** Handles a click on any regular slot array (inventory slots or the craft grid). */
  clickSlot(slots: Array<ItemStack | null>, index: number, button: 0 | 2): void {
    clickStackSlot(this, slots, index, button)
  }

  /** Crafts once: moves the result onto the cursor and consumes the grid. */
  takeResult(): boolean {
    const result = this.result
    if (!result) return false
    if (this.cursor) {
      const max = ITEMS[result.id]?.stackSize ?? 1
      if (this.cursor.id !== result.id || this.cursor.damage !== undefined ||
        this.cursor.count + result.count > max) return false
      this.cursor.count += result.count
    } else {
      this.cursor = { id: result.id, count: result.count }
    }
    for (let i = 0; i < this.grid.length; i++) {
      const stack = this.grid[i]
      if (!stack) continue
      stack.count -= 1
      if (stack.count === 0) this.grid[i] = null
    }
    return true
  }

  /** Empties the grid and cursor back into the inventory when the screen closes. */
  returnAll(inventory: Inventory, spill: (stack: ItemStack) => void): void {
    const stacks = [...this.grid, this.cursor]
    this.grid.fill(null)
    this.cursor = null
    returnStacks(stacks, inventory, spill)
  }

  isEmpty(): boolean {
    return this.cursor === null && this.grid.every(stack => stack === null)
  }
}
