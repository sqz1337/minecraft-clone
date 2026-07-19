import { B } from './Blocks'
import { ITEMS } from './Items'
import { FURNACE_SMELT_SECONDS, fuelSecondsFor, smeltResultFor, smeltXpFor } from './Recipes'
import { cloneStack, ItemStack } from '../player/Inventory'
import type { World } from './World'

export const CHEST_SLOTS = 27
export const FURNACE_INPUT = 0
export const FURNACE_FUEL = 1
export const FURNACE_OUTPUT = 2

export interface ChestState {
  kind: 'chest'
  slots: Array<ItemStack | null>
}

export interface FurnaceState {
  kind: 'furnace'
  /** [input, fuel, output] */
  slots: Array<ItemStack | null>
  /** Seconds of burn time left on the current fuel. */
  burn: number
  /** Full duration of the current fuel, for the flame indicator. */
  burnTotal: number
  /** Seconds the current input item has been smelting. */
  cook: number
  /** Experience banked per smelted item, granted when the output is taken. */
  xp: number
}

export type ContainerState = ChestState | FurnaceState

export interface SavedContainer {
  x: number
  y: number
  z: number
  kind: 'chest' | 'furnace'
  slots: Array<ItemStack | null>
  burn?: number
  burnTotal?: number
  cook?: number
  xp?: number
}

/**
 * Container data attached to placed chest and furnace blocks, keyed by
 * world position. Furnaces keep smelting while their screen is closed and
 * swap their block between lit and unlit variants; the swap self-heals
 * when the chunk was unloaded at the moment the state changed.
 */
export class Containers {
  private map = new Map<string, ContainerState>()
  /** Fired when a furnace mutates its own slots (fuel consumed, item smelted). */
  onFurnaceChanged: (x: number, y: number, z: number) => void = () => {}

  private key(x: number, y: number, z: number): string {
    return x + ',' + y + ',' + z
  }

  chestAt(x: number, y: number, z: number): ChestState {
    const key = this.key(x, y, z)
    let state = this.map.get(key)
    if (!state || state.kind !== 'chest') {
      state = { kind: 'chest', slots: Array(CHEST_SLOTS).fill(null) }
      this.map.set(key, state)
    }
    return state
  }

  furnaceAt(x: number, y: number, z: number): FurnaceState {
    const key = this.key(x, y, z)
    let state = this.map.get(key)
    if (!state || state.kind !== 'furnace') {
      state = { kind: 'furnace', slots: Array(3).fill(null), burn: 0, burnTotal: 0, cook: 0, xp: 0 }
      this.map.set(key, state)
    }
    return state
  }

  /** Removes and returns the container at a position (block broken). */
  remove(x: number, y: number, z: number): ContainerState | null {
    const key = this.key(x, y, z)
    const state = this.map.get(key) ?? null
    this.map.delete(key)
    return state
  }

  update(dt: number, world: World): void {
    for (const [key, state] of this.map) {
      if (state.kind === 'furnace') this.tickFurnace(key, state, dt, world)
    }
  }

  private tickFurnace(key: string, f: FurnaceState, dt: number, world: World): void {
    const input = f.slots[FURNACE_INPUT]
    const output = f.slots[FURNACE_OUTPUT]
    const result = input ? smeltResultFor(input.id) : null
    const outMax = result ? ITEMS[result.id]?.stackSize ?? 1 : 0
    const canSmelt = result !== null &&
      (!output || (output.id === result.id && output.damage === undefined && output.count + result.count <= outMax))
    let changed = false

    if (f.burn > 0) f.burn = Math.max(0, f.burn - dt)

    if (f.burn <= 0 && canSmelt) {
      const fuel = f.slots[FURNACE_FUEL]
      const seconds = fuel ? fuelSecondsFor(fuel.id) : 0
      if (fuel && seconds > 0) {
        f.burn = seconds
        f.burnTotal = seconds
        fuel.count -= 1
        if (fuel.count === 0) f.slots[FURNACE_FUEL] = null
        changed = true
      }
    }

    if (f.burn > 0 && canSmelt && input && result) {
      f.cook += dt
      if (f.cook >= FURNACE_SMELT_SECONDS) {
        f.cook = 0
        const out = f.slots[FURNACE_OUTPUT]
        if (out) out.count += result.count
        else f.slots[FURNACE_OUTPUT] = { id: result.id, count: result.count }
        f.xp += smeltXpFor(input.id)
        input.count -= 1
        if (input.count === 0) f.slots[FURNACE_INPUT] = null
        changed = true
      }
    } else {
      f.cook = 0
    }

    const [x, y, z] = key.split(',').map(Number)
    const id = world.getBlock(x, y, z)
    const lit = f.burn > 0
    if (id === B.FURNACE && lit) world.setBlock(x, y, z, B.FURNACE_LIT)
    else if (id === B.FURNACE_LIT && !lit) world.setBlock(x, y, z, B.FURNACE)

    if (changed) this.onFurnaceChanged(x, y, z)
  }

  serialize(): SavedContainer[] {
    const saved: SavedContainer[] = []
    for (const [key, state] of this.map) {
      const empty = state.slots.every(stack => !stack)
      if (empty && (state.kind === 'chest' || (state.burn <= 0 && state.xp <= 0))) continue
      const [x, y, z] = key.split(',').map(Number)
      const slots = state.slots.map(stack => stack ? cloneStack(stack) : null)
      if (state.kind === 'chest') {
        saved.push({ x, y, z, kind: 'chest', slots })
      } else {
        saved.push({
          x, y, z, kind: 'furnace', slots,
          burn: state.burn, burnTotal: state.burnTotal, cook: state.cook, xp: state.xp
        })
      }
    }
    return saved
  }

  restore(data: readonly SavedContainer[]): void {
    this.map.clear()
    for (const c of data) {
      const key = this.key(c.x, c.y, c.z)
      if (this.map.has(key)) continue
      const size = c.kind === 'chest' ? CHEST_SLOTS : 3
      const slots: Array<ItemStack | null> = Array(size).fill(null)
      for (let i = 0; i < Math.min(size, c.slots.length); i++) {
        const stack = c.slots[i]
        if (stack) slots[i] = cloneStack(stack)
      }
      if (c.kind === 'chest') {
        this.map.set(key, { kind: 'chest', slots })
      } else {
        this.map.set(key, {
          kind: 'furnace',
          slots,
          burn: c.burn ?? 0,
          burnTotal: c.burnTotal ?? 0,
          cook: c.cook ?? 0,
          xp: c.xp ?? 0
        })
      }
    }
  }
}
