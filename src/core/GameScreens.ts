import * as THREE from 'three'
import { Atlas } from '../gfx/Atlas'
import { Materials } from '../gfx/Materials'
import { Environment } from '../gfx/Environment'
import { Particles } from '../gfx/Particles'
import { TntFx } from '../gfx/TntFx'
import { Critters } from '../gfx/Critters'
import { U } from '../gfx/Uniforms'
import { World } from '../world/World'
import { WorldGen, BIOME, BIOME_NAMES, SEA_LEVEL } from '../world/WorldGen'
import { CHUNK_SIZE } from '../world/Chunk'
import { Player } from '../player/Player'
import { Interaction, VIEWMODEL_LAYER } from '../player/Interaction'
import { Inventory, ItemStack, SerializedInventory, cloneStack } from '../player/Inventory'
import { Crafting, CursorHolder, clickStackSlot, returnStacks, takeIntoCursor } from '../player/Crafting'
import { ItemDrops } from '../world/ItemDrops'
import { ITEMS } from '../world/Items'
import { I } from '../world/ItemIds'
import { B, isBedBlock, isContainerBlock, isDoorBlock, isInfestedBlock } from '../world/Blocks'
import {
  CHEST_SLOTS, ChestState, Containers, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, FurnaceState
} from '../world/Containers'
import { RECIPES, ingredientMatches, fuelSecondsFor, smeltResultFor } from '../world/Recipes'
import type { RayHit } from '../world/World'
import { ItemSprites } from '../gfx/ItemSprites'
import { VanillaHeldItems } from '../gfx/VanillaHeldItems'
import { PlayerRenderer } from '../gfx/PlayerRenderer'
import { Weather } from '../weather/Weather'
import { AudioMan } from '../audio/Audio'
import { Settings, GameMode } from './Settings'
import { UI } from '../ui/UI'
import { clamp } from '../util/math'
import { WorldSaveStore, type WorldSummary } from './WorldSave'
import { desktopCursor, desktopWindow, desktopWorlds, isDesktopApp } from './Desktop'
import { EntityManager } from '../entities/EntityManager'
import { ProjectileManager } from '../entities/ProjectileManager'
import { Equipment } from '../player/Equipment'
import { ExperienceOrbs } from '../entities/ExperienceOrbs'
import { applyEnchantmentOffer, canEnchantItem, generateEnchantmentOffers, type EnchantingState } from '../player/Enchantments'
import { experienceAfterDeath } from '../player/Experience'
import { rollLoot } from '../world/Loot'
import { HOSTILE_KINDS, MOB_KINDS, VILLAGER_PROFESSIONS, type HostileKind, type MobKind, type VillagerProfession } from '../entities/EntityTypes'
import { VILLAGER_TRADES } from '../entities/Trades'
import { GameState, SAVE_INTERVAL_SEC, OpenScreen } from './GameShared'
import type { Game } from './Game'

type GameConstructor = { prototype: Game }

export function installGameScreens(GameClass: GameConstructor): void {
  const prototype = GameClass.prototype
  prototype.openScreen = function(this: Game, screen: OpenScreen): void {
    if (this.mode !== 'survival' || this.state !== 'playing') return
    this.state = 'inventory'
    this.screen = screen
    this.player.enabled = false
    this.player.clearKeys()
    this.interaction.primaryUp()
    this.interaction.secondaryUp()
    this.ui.setScreen(screen)
    this.ui.showInventory(true)
    this.releaseMouseCapture()
    this.saveWorld()
  }
  prototype.releaseMouseCapture = function(this: Game): void {
    if (isDesktopApp()) {
      this.player.setNativeMouseCapture(false)
      this.renderer.domElement.style.cursor = ''
      void desktopCursor.unlock()
    } else if (document.pointerLockElement) {
      document.exitPointerLock()
    }
  }
  prototype.openCraftScreen = function(this: Game, size: 2 | 3): void {
    this.openScreen({ kind: size === 3 ? 'workbench' : 'inventory', crafting: new Crafting(size) })
  }
  prototype.openFurnace = function(this: Game, x: number, y: number, z: number): void {
    const state = this.containers.furnaceAt(x, y, z)
    this.openScreen({ kind: 'furnace', holder: { cursor: null }, state, x, y, z })
  }
  prototype.openChest = function(this: Game, x: number, y: number, z: number): void {
    // an adjacent chest makes this half of a large chest; lower x/z is the first half
    const positions: Array<[number, number, number]> = [[x, y, z]]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (this.world.getBlock(x + dx, y, z + dz) === B.CHEST) {
        positions.push([x + dx, y, z + dz])
        break
      }
    }
    positions.sort((a, b) => a[0] - b[0] || a[2] - b[2])
    const parts = positions.map(([px, py, pz]) => this.containers.chestAt(px, py, pz))
    const double = parts.length > 1
    const slots = double ? parts.flatMap(part => part.slots) : parts[0].slots
    this.audio.chestOpen()
    this.world.setChestOpen(positions, true)
    this.openScreen({ kind: 'chest', holder: { cursor: null }, slots, parts, positions, double })
  }
  prototype.openTrading = function(this: Game, entityId: string): void {
    const entity = this.entities.snapshotById(entityId)
    if (!entity || entity.kind !== 'villager') return
    this.audio.mob('villager', 'ambient')
    this.openScreen({ kind: 'trade', holder: { cursor: null }, profession: entity.profession ?? 'farmer' })
  }
  prototype.tradeClick = function(this: Game, index: number): void {
    const screen = this.screen
    if (this.state !== 'inventory' || screen?.kind !== 'trade') return
    const trade = VILLAGER_TRADES[screen.profession][index]
    if (!trade || this.countPlainItems(trade.cost.id) < trade.cost.count) return
    this.removePlainItems(trade.cost.id, trade.cost.count)
    const left = this.inventory.add(trade.result.id, trade.result.count)
    if (left > 0) this.spillStack({ id: trade.result.id, count: left })
    this.audio.craft()
    this.ui.renderScreen()
  }
  prototype.countPlainItems = function(this: Game, id: number): number {
    let total = 0
    for (const stack of this.inventory.slots) {
      if (stack && stack.id === id && stack.damage === undefined && !stack.enchantments?.length) total += stack.count
    }
    return total
  }
  prototype.removePlainItems = function(this: Game, id: number, count: number): void {
    let left = count
    for (let i = 0; i < this.inventory.slots.length && left > 0; i++) {
      const stack = this.inventory.slots[i]
      if (!stack || stack.id !== id || stack.damage !== undefined || stack.enchantments?.length) continue
      const taken = Math.min(left, stack.count)
      stack.count -= taken
      left -= taken
      if (stack.count <= 0) this.inventory.slots[i] = null
    }
    this.inventory.notify()
  }
  prototype.openEnchanting = function(this: Game, x: number, y: number, z: number): void {
    const holder: EnchantingState = {
      cursor: null,
      slots: [null],
      offers: [],
      bookshelfPower: this.bookshelfPower(x, y, z),
      seed: (Math.random() * 0x7fffffff) | 0
    }
    this.openScreen({ kind: 'enchant', holder, x, y, z })
  }
  prototype.bookshelfPower = function(this: Game, x: number, y: number, z: number): number {
    let shelves = 0
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue
      for (let dy = 0; dy <= 1; dy++) {
        if (this.world.getBlock(x + dx, y + dy, z + dz) !== B.BOOKSHELF) continue
        const gapX = x + Math.sign(dx), gapZ = z + Math.sign(dz)
        if (this.world.getBlock(gapX, y + dy, gapZ) === B.AIR) shelves++
      }
    }
    return Math.min(30, shelves * 2)
  }
  prototype.refreshEnchantOffers = function(this: Game, state: EnchantingState): void {
    const stack = state.slots[0]
    state.offers = stack && !stack.enchantments?.length
      ? generateEnchantmentOffers(stack.id, state.bookshelfPower, state.seed)
      : []
  }
  prototype.closeScreen = function(this: Game): void {
    const screen = this.screen
    if (screen) {
      if (screen.kind === 'chest') {
        this.world.setChestOpen(screen.positions, false)
        this.audio.chestClose()
      }
      if (screen.kind === 'inventory' || screen.kind === 'workbench') {
        screen.crafting.returnAll(this.inventory, (stack) => this.spillStack(stack))
      } else if (screen.kind === 'chest' || screen.kind === 'furnace' || screen.kind === 'enchant' || screen.kind === 'trade') {
        const loose = screen.kind === 'enchant' ? [...screen.holder.slots, screen.holder.cursor] : [screen.holder.cursor]
        returnStacks(loose, this.inventory, (stack) => this.spillStack(stack))
        screen.holder.cursor = null
        if (screen.kind === 'enchant') screen.holder.slots[0] = null
      }
    }
    this.screen = null
    this.ui.setScreen(null)
    this.ui.showInventory(false)
  }
  prototype.spillStack = function(this: Game, stack: ItemStack): void {
    const p = this.player.pos
    this.drops.spawn(stack.id, p.x, p.y + 1.2, p.z, stack.count, {
      damage: stack.damage,
      enchantments: stack.enchantments
    })
  }
  prototype.activeHolder = function(this: Game): CursorHolder | null {
    const screen = this.screen
    if (!screen || screen.kind === 'admin') return null
    return screen.kind === 'inventory' || screen.kind === 'workbench' ? screen.crafting : screen.holder
  }
  prototype.inventorySlotClick = function(this: Game, slot: number, button: 0 | 2, shift = false): void {
    const holder = this.activeHolder()
    if (this.state !== 'inventory' || !holder) return
    if (shift && this.shiftInventoryStack(slot)) return
    clickStackSlot(holder, this.inventory.slots, slot, button)
    this.inventory.notify()
  }
  prototype.armorSlotClick = function(this: Game, slot: number, button: 0 | 2, shift = false): void {
    const holder = this.activeHolder()
    if (this.state !== 'inventory' || !holder || this.screen?.kind !== 'inventory' || slot < 0 || slot >= 4) return
    if (shift) {
      const stack = this.equipment.slots[slot]
      if (stack && this.inventory.add(stack.id, stack.count, stack.damage, stack.enchantments) === 0) {
        this.equipment.slots[slot] = null
        this.equipment.onChange()
      }
      return
    }
    if (holder.cursor && !this.equipment.accepts(slot, holder.cursor)) return
    const equipped = this.equipment.slots[slot]
    const cursor = holder.cursor
    if (!cursor) {
      this.equipment.slots[slot] = null
      holder.cursor = equipped
    } else if (!equipped) {
      this.equipment.slots[slot] = cloneStack({ ...cursor, count: 1 })
      cursor.count--
      if (cursor.count === 0) holder.cursor = null
    } else if (cursor.count === 1) {
      this.equipment.slots[slot] = cursor
      holder.cursor = equipped
    }
    this.equipment.onChange()
  }
  prototype.craftSlotClick = function(this: Game, index: number, button: 0 | 2, _shift = false): void {
    const screen = this.screen
    if (this.state !== 'inventory' || !screen) return
    if (screen.kind !== 'inventory' && screen.kind !== 'workbench') return
    screen.crafting.clickSlot(screen.crafting.grid, index, button)
    this.ui.renderScreen()
  }
  prototype.craftResultClick = function(this: Game): void {
    const screen = this.screen
    if (this.state !== 'inventory' || !screen) return
    if (screen.kind !== 'inventory' && screen.kind !== 'workbench') return
    if (screen.crafting.takeResult()) {
      this.audio.craft()
      this.ui.renderScreen()
    }
  }
  prototype.containerSlotClick = function(this: Game, index: number, button: 0 | 2, shift = false): void {
    const screen = this.screen
    if (this.state !== 'inventory' || !screen) return
    if (screen.kind === 'chest') {
      if (shift) {
        const stack = screen.slots[index]
        if (stack) {
          const left = this.inventory.add(stack.id, stack.count, stack.damage, stack.enchantments)
          if (left === 0) screen.slots[index] = null
          else stack.count = left
        }
      } else {
      clickStackSlot(screen.holder, screen.slots, index, button)
      }
      if (screen.double) {
        screen.parts.forEach((part, half) => {
          for (let i = 0; i < CHEST_SLOTS; i++) part.slots[i] = screen.slots[half * CHEST_SLOTS + i]
        })
      }
    } else if (screen.kind === 'furnace') {
      if (shift) {
        const stack = screen.state.slots[index]
        if (stack) {
          const original = stack.count
          const left = this.inventory.add(stack.id, original, stack.damage, stack.enchantments)
          const moved = original - left
          if (left === 0) screen.state.slots[index] = null
          else stack.count = left
          if (index === FURNACE_OUTPUT && moved > 0) {
            const gained = Math.floor(screen.state.xp * moved / original)
            screen.state.xp = Math.max(0, screen.state.xp - gained)
            if (gained > 0) this.player.addExperience(gained)
          }
        }
      } else
      if (index === FURNACE_OUTPUT) {
        if (takeIntoCursor(screen.holder, screen.state.slots, index)) {
          // grant the XP banked per smelted item, keeping the fractional remainder
          const gained = Math.floor(screen.state.xp)
          if (gained > 0) {
            screen.state.xp -= gained
            this.player.addExperience(gained)
          }
        }
      }
      else clickStackSlot(screen.holder, screen.state.slots, index, button)
    } else {
      return
    }
    this.ui.renderScreen()
  }
  prototype.shiftInventoryStack = function(this: Game, slot: number): boolean {
    const stack = this.inventory.slots[slot]
    const screen = this.screen
    if (!stack || !screen) return false
    if (screen.kind === 'chest') {
      this.moveStackToSlots(stack, screen.slots)
    } else if (screen.kind === 'furnace') {
      const target = smeltResultFor(stack.id) ? FURNACE_INPUT : fuelSecondsFor(stack.id) > 0 ? FURNACE_FUEL : -1
      if (target < 0) return false
      this.moveStackToSlots(stack, screen.state.slots, target)
    } else if (screen.kind === 'inventory') {
      const armorSlot = this.equipment.slots.findIndex((current, index) => !current && this.equipment.accepts(index, stack))
      if (armorSlot >= 0) {
        this.equipment.slots[armorSlot] = cloneStack({ ...stack, count: 1 })
        stack.count--
        this.equipment.onChange()
      } else {
        this.moveStackToSlots(stack, this.inventory.slots, slot < 9 ? 9 : 0, slot < 9 ? 35 : 8)
      }
    } else {
      this.moveStackToSlots(stack, this.inventory.slots, slot < 9 ? 9 : 0, slot < 9 ? 35 : 8)
    }
    if (stack.count <= 0) this.inventory.slots[slot] = null
    this.inventory.notify()
    this.ui.renderScreen()
    return true
  }
  prototype.moveStackToSlots = function(this: Game, stack: ItemStack, slots: Array<ItemStack | null>, onlyIndex?: number, endIndex?: number): void {
    const start = onlyIndex ?? 0
    const end = endIndex ?? onlyIndex ?? slots.length - 1
    const max = ITEMS[stack.id]?.stackSize ?? 1
    for (let i = start; i <= end && stack.count > 0; i++) {
      const target = slots[i]
      if (!target || target.id !== stack.id || target.damage !== stack.damage || target.enchantments?.length || stack.enchantments?.length) continue
      const moved = Math.min(stack.count, max - target.count)
      target.count += moved
      stack.count -= moved
    }
    for (let i = start; i <= end && stack.count > 0; i++) {
      if (slots[i]) continue
      const moved = Math.min(stack.count, max)
      slots[i] = cloneStack({ ...stack, count: moved })
      stack.count -= moved
    }
  }
  prototype.outsideInventoryClick = function(this: Game, button: 0 | 2): void {
    const holder = this.activeHolder()
    if (this.state !== 'inventory' || !holder?.cursor) return
    const stack = holder.cursor
    const count = button === 2 ? 1 : stack.count
    this.spillStack(cloneStack({ ...stack, count }))
    stack.count -= count
    if (stack.count <= 0) holder.cursor = null
    this.ui.renderScreen()
  }
  prototype.enchantSlotClick = function(this: Game, button: 0 | 2): void {
    const screen = this.screen
    if (this.state !== 'inventory' || screen?.kind !== 'enchant') return
    const holder = screen.holder
    if (!holder.slots[0] && holder.cursor && (!canEnchantItem(holder.cursor.id) || holder.cursor.enchantments?.length)) return
    clickStackSlot(holder, holder.slots, 0, button)
    this.refreshEnchantOffers(holder)
    this.ui.renderScreen()
  }
  prototype.enchantOfferClick = function(this: Game, index: number): void {
    const screen = this.screen
    if (this.state !== 'inventory' || screen?.kind !== 'enchant') return
    const stack = screen.holder.slots[0]
    const offer = screen.holder.offers[index]
    if (!stack || !offer || !offer.enchantments.length || stack.enchantments?.length) return
    if (!this.player.spendExperienceLevels(offer.cost)) {
      this.ui.toast(`Requires level ${offer.cost}`)
      return
    }
    if (!applyEnchantmentOffer(stack, offer)) return
    screen.holder.seed = (screen.holder.seed + 0x6d2b79f5) | 0
    this.refreshEnchantOffers(screen.holder)
    this.inventory.notify()
    this.audio.craft()
    this.ui.toast('Item enchanted')
  }
  prototype.toggleAdmin = function(this: Game): void {
    if (this.mode !== 'survival') return
    if (this.state === 'playing') {
      this.openScreen({ kind: 'admin' })
    } else if (this.state === 'inventory' && this.screen?.kind === 'admin') {
      this.closeScreen()
      this.state = 'paused'
      this.requestPlay()
    }
  }
  prototype.adminItemClick = function(this: Game, id: number, button: 0 | 2): void {
    if (this.state !== 'inventory' || this.screen?.kind !== 'admin') return
    const item = ITEMS[id]
    if (!item) return
    const count = button === 2 ? item.stackSize : 1
    const left = this.inventory.add(id, count)
    if (left >= count) this.ui.toast('Inventory is full')
  }
  prototype.recipeClick = function(this: Game, index: number): void {
    const screen = this.screen
    if (this.state !== 'inventory' || screen?.kind !== 'workbench') return
    const recipe = RECIPES[index]
    if (!recipe) return
    const grid = screen.crafting.grid
    const returnGrid = () => {
      for (let i = 0; i < grid.length; i++) {
        const stack = grid[i]
        if (!stack) continue
        grid[i] = null
        const left = this.inventory.add(stack.id, stack.count, stack.damage, stack.enchantments)
        if (left > 0) this.spillStack(cloneStack({ ...stack, count: left }))
      }
    }
    returnGrid()

    // one item per pattern cell, anchored to the top-left of the 3x3 grid
    const cells: Array<{ cell: number; ingredient: number | readonly number[] }> = []
    if (recipe.kind === 'shaped') {
      recipe.pattern.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] !== ' ') cells.push({ cell: y * 3 + x, ingredient: recipe.keys[row[x]] })
        }
      })
    } else {
      recipe.ingredients.forEach((ingredient, i) => cells.push({ cell: i, ingredient }))
    }
    for (const { cell, ingredient } of cells) {
      const slotIndex = this.inventory.slots.findIndex(
        stack => stack !== null && stack.damage === undefined && ingredientMatches(ingredient, stack.id)
      )
      if (slotIndex < 0) {
        // ingredients ran out mid-layout (should not happen for craftable recipes)
        returnGrid()
        break
      }
      const id = this.inventory.slots[slotIndex]!.id
      this.inventory.remove(slotIndex, 1)
      grid[cell] = { id, count: 1 }
    }
    this.inventory.notify()
  }
}
