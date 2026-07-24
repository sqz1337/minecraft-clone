import { HOTBAR, B, tileFor, CROSS, RENDER_SHAPE } from '../world/Blocks'
import { ITEMS, durabilityForItem, itemName } from '../world/Items'
import { FURNACE_SMELT_SECONDS, RECIPES, Recipe, recipeIngredients } from '../world/Recipes'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import { CONTROL_DEFINITIONS, displayKey, type Settings, type QualityName, type GameMode, type ControlAction } from '../core/Settings'
import type { Inventory, ItemStack } from '../player/Inventory'
import type { Crafting, CursorHolder } from '../player/Crafting'
import type { FurnaceState } from '../world/Containers'
import type { MinecraftFont } from './MinecraftFont'
import type { Equipment } from '../player/Equipment'
import { stackDisplayName, type EnchantingState } from '../player/Enchantments'
import { VILLAGER_TRADES } from '../entities/Trades'
import type { VillagerProfession } from '../entities/EntityTypes'
import { WorldLibrary, type WorldSummary } from '../core/WorldSave'
import { el, HudData, SlotButton, SlotHandler, UIScreen } from './UIShared'
import type { UI } from './UI'

type UIConstructor = { prototype: UI }

export function installUIInventory(UIClass: UIConstructor): void {
  const prototype = UIClass.prototype
  prototype.renderAdmin = function(this: UI): void {
    const grid = this.adminGrid
    grid.innerHTML = ''
    for (const item of ITEMS) {
      if (!item) continue
      grid.appendChild(this.makeClickableSlot(
        { id: item.id, count: 1 },
        item.id,
        (id, button) => this.onAdminItemClick(id, button)
      ))
    }
    this.adminScrollPx = 0
    this.updateAdminScroll()
  }
  prototype.setupAdminScroll = function(this: UI): void {
    this.adminViewport.addEventListener('wheel', (event) => {
      event.preventDefault()
      // One notch scrolls roughly one row of slots.
      this.adminScrollPx += Math.sign(event.deltaY) * 18
      this.updateAdminScroll()
    }, { passive: false })

    this.adminScrollKnob.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const travel = this.adminKnobTravel()
      if (travel <= 0) return
      const range = this.adminScrollRange()
      const startY = event.clientY
      const startPx = this.adminScrollPx
      const scale = this.guiScale || 1
      const onMove = (move: MouseEvent) => {
        // Mouse moves in screen pixels; the window is scaled, so undo the scale.
        const deltaLocal = (move.clientY - startY) / scale
        this.adminScrollPx = startPx + (deltaLocal / travel) * range
        this.updateAdminScroll()
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }
  prototype.adminScrollRange = function(this: UI): number {
    return Math.max(0, this.adminGrid.scrollHeight - this.adminViewport.clientHeight)
  }
  prototype.adminKnobTravel = function(this: UI): number {
    return Math.max(0, this.adminScrollbar.clientHeight - this.adminScrollKnob.offsetHeight)
  }
  prototype.updateAdminScroll = function(this: UI): void {
    const range = this.adminScrollRange()
    this.adminScrollPx = Math.max(0, Math.min(range, this.adminScrollPx))
    this.adminGrid.style.transform = `translateY(${-this.adminScrollPx}px)`
    this.adminScrollbar.classList.toggle('disabled', range <= 0)
    const travel = this.adminKnobTravel()
    const knobTop = range > 0 ? (this.adminScrollPx / range) * travel : 0
    this.adminScrollKnob.style.top = `${knobTop}px`
  }
  prototype.updateFurnace = function(this: UI, state: FurnaceState): void {
    const burn = state.burnTotal > 0 ? Math.max(0, Math.min(1, state.burn / state.burnTotal)) : 0
    const cook = Math.max(0, Math.min(1, state.cook / FURNACE_SMELT_SECONDS))
    const flameHeight = Math.round(burn * 14)
    this.furnaceFlame.style.height = `${flameHeight}px`
    this.furnaceFlame.style.top = `${36 + 14 - flameHeight}px`
    this.furnaceFlame.style.backgroundPosition = `-176px ${flameHeight - 14}px`
    this.furnaceArrow.style.width = `${Math.round(cook * 24)}px`
  }
  prototype.addInventorySlot = function(this: UI, parent: HTMLElement, index: number): void {
    const stack = this.inventory!.slots[index]
    const slot = this.makeSlot(stack?.id ?? B.AIR, stack, index, true)
    slot.addEventListener('mousedown', (event) => {
      if (event.button === 0 || event.button === 2) this.onInventorySlotClick(index, event.button as SlotButton, event.shiftKey)
    })
    parent.appendChild(slot)
  }
  prototype.drawItemIcon = function(this: UI, canvas: HTMLCanvasElement, id: number): void {
    const item = ITEMS[id]
    if (!item || !this.atlas) return
    if (item.sprite && this.sprites) {
      this.sprites.drawIcon(canvas, item.sprite[0], item.sprite[1])
    } else if (CROSS[id] || id === B.RAIL || RENDER_SHAPE[id] === 'lily' || RENDER_SHAPE[id] === 'vine') {
      this.atlas.drawFlatIcon(canvas, tileFor(id, 0))
    } else {
      const tint: [number, number, number] | undefined = id === B.GRASS ? [0.62, 0.8, 0.38] : undefined
      this.atlas.drawIcon(canvas, tileFor(id, 2), tileFor(id, 0), tint, tileFor(id, 4))
    }
  }
  prototype.makeSlot = function(this: UI, id: number, stack: ItemStack | null, index: number, inventorySlot: boolean): HTMLDivElement {
    const slot = document.createElement('div')
    slot.className = inventorySlot ? 'inventory-slot' : 'slot'
    slot.dataset.slot = String(index)
    if (id !== B.AIR && ITEMS[id]) {
      const canvas = document.createElement('canvas')
      canvas.className = 'item-icon'
      canvas.dataset.itemId = String(id)
      canvas.width = canvas.height = this.iconBackingSize()
      this.drawItemIcon(canvas, id)
      slot.appendChild(canvas)
    }
    if (stack) {
      if (stack.enchantments?.length) slot.classList.add('enchanted')
      if (stack.count > 1) {
        const count = this.font.createCanvas(String(stack.count))
        count.classList.add('count')
        slot.appendChild(count)
      }
      const durability = durabilityForItem(stack.id)
      if (durability && stack.damage) {
        const fraction = Math.max(0, 1 - stack.damage / durability)
        const track = document.createElement('div')
        track.className = 'dura-track'
        const fill = document.createElement('div')
        fill.className = 'dura-fill'
        fill.style.width = `${Math.max(1, Math.round(fraction * 13))}px`
        fill.style.background = `rgb(${Math.round(255 * (1 - fraction))},${Math.round(255 * fraction)},0)`
        track.appendChild(fill)
        slot.appendChild(track)
      }
      slot.dataset.tooltip = stackDisplayName(stack).replaceAll('\n', ' · ')
    }
    return slot
  }
  prototype.renderCursor = function(this: UI): void {
    this.inventoryCursor.innerHTML = ''
    const screen = this.screen
    const holder = !screen || screen.kind === 'admin' ? null
      : screen.kind === 'inventory' || screen.kind === 'workbench' ? screen.crafting
      : screen.holder
    const stack = holder?.cursor ?? null
    if (stack) {
      const ghost = this.makeSlot(stack.id, stack, 0, true)
      ghost.className = 'cursor-stack'
      this.inventoryCursor.appendChild(ghost)
    }
    this.inventoryCursor.classList.toggle('visible', !!stack)
  }
  prototype.setSelectedSlot = function(this: UI, index: number): void {
    this.slots.forEach((slot, current) => slot.classList.toggle('selected', index === current))
    const id = this.hotbarBlocks[index] ?? B.AIR
    const selectedStack = this.mode === 'survival' ? this.inventory?.slots[index] ?? null : null
    const name = selectedStack
      ? stackDisplayName(selectedStack).replaceAll('\n', ' · ')
      : id === B.AIR || !ITEMS[id] ? 'Empty hand' : itemName(id)
    this.blockName.replaceChildren(this.font.createCanvas(name))
    this.blockName.classList.add('visible')
    if (this.blockNameTimer !== null) clearTimeout(this.blockNameTimer)
    this.blockNameTimer = window.setTimeout(() => this.blockName.classList.remove('visible'), 1600)
  }
  prototype.updateSurvivalStats = function(
    this: UI,
    health: number,
    hunger: number,
    air: number,
    armor = 0,
    saturation = 0
  ): void {
    if (this.mode !== 'survival') return
    this.healthBar.innerHTML = this.statusIcons('heart', health)
    this.hungerBar.innerHTML = this.statusIcons('food', hunger)
    this.hungerBar.classList.toggle('depleted', saturation <= 0.001)
    this.armorBar.innerHTML = armor > 0 ? this.statusIcons('armor', armor) : ''
    // 15 seconds of air shown as the classic 10 bubbles (1.5 s per bubble)
    this.airBar.classList.toggle('hidden', air >= 14.95)
    this.airBar.innerHTML = ''
    for (let i = 0; i < 10; i++) {
      const icon = document.createElement('span')
      icon.className = `status-icon air ${i < Math.ceil(air / 1.5) ? 'full' : 'empty'}`
      this.airBar.appendChild(icon)
    }
  }
  prototype.updateExperience = function(this: UI, level: number, fraction: number): void {
    this.experienceLevel = Math.max(0, Math.floor(level))
    const fill = el<HTMLDivElement>('experience-fill')
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 182)}px`
    this.experienceLevelEl.replaceChildren(
      ...(this.experienceLevel > 0 ? [this.font.createCanvas(String(this.experienceLevel), '#80ff20')] : [])
    )
    if (this.screen?.kind === 'enchant') this.renderScreen()
  }
  prototype.updateAttackIndicator = function(this: UI, charge: number, visible: boolean): void {
    const clamped = Math.max(0, Math.min(1, charge))
    this.attackIndicator.classList.toggle('visible', visible)
    this.attackIndicator.style.setProperty('--attack-charge', clamped.toFixed(3))
  }
  prototype.statusIcons = function(
    this: UI,
    kind: 'heart' | 'food' | 'armor',
    value: number
  ): string {
    let html = ''
    for (let i = 0; i < 10; i++) {
      const remaining = value - i * 2
      const fill = remaining >= 2 ? 'full' : remaining >= 1 ? 'half' : 'empty'
      html += `<span class="status-icon ${kind}"><span class="status-fill ${fill}"></span></span>`
    }
    return html
  }
}
