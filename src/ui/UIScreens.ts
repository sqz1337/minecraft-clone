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

export function installUIScreens(UIClass: UIConstructor): void {
  const prototype = UIClass.prototype
  prototype.configureGame = function(this: UI, atlas: Atlas, sprites: ItemSprites, mode: GameMode, inventory: Inventory, equipment: Equipment): void {
    this.atlas = atlas
    this.sprites = sprites
    this.mode = mode
    this.inventory = inventory
    this.equipment = equipment
    this.survivalStats.classList.toggle('hidden', mode !== 'survival')
    this.experienceBar.classList.toggle('hidden', mode !== 'survival')
    this.inventoryTitle.replaceChildren(this.font.createCanvas('Inventory', '#404040', false))
    this.inventoryCraftingTitle.replaceChildren(this.font.createCanvas('Crafting', '#404040', false))
    this.workbenchTitle.replaceChildren(this.font.createCanvas('Crafting', '#404040', false))
    this.furnaceTitle.replaceChildren(this.font.createCanvas('Furnace', '#404040', false))
    this.furnaceInventoryTitle.replaceChildren(this.font.createCanvas('Inventory', '#404040', false))
    this.chestInventoryTitle.replaceChildren(this.font.createCanvas('Inventory', '#404040', false))
    this.enchantTitle.replaceChildren(this.font.createCanvas('Enchant', '#404040', false))
    this.tradeInventoryTitle.replaceChildren(this.font.createCanvas('Inventory', '#404040', false))
    document.querySelector<HTMLDivElement>('.recipe-book-title')!
      .replaceChildren(this.font.createCanvas('Recipes', '#404040', false))
    document.querySelector<HTMLDivElement>('.admin-title')!
      .replaceChildren(this.font.createCanvas('All items (admin)', '#404040', false))
    document.querySelector<HTMLDivElement>('.admin-hint')!
      .replaceChildren(this.font.createCanvas('LMB +1  RMB +stack', '#404040', false))
    // classic book item icon from gui/items.png as the toggle face
    this.renderRecipeToggle()
    this.renderScreen()
  }
  prototype.setScreen = function(this: UI, screen: UIScreen | null): void {
    this.screen = screen
    const kind = screen?.kind ?? null
    this.inventoryWindow.classList.toggle('hidden', kind !== 'inventory')
    this.workbenchWindow.classList.toggle('hidden', kind !== 'workbench')
    this.furnaceWindow.classList.toggle('hidden', kind !== 'furnace')
    this.chestWindow.classList.toggle('hidden', kind !== 'chest')
    this.enchantWindow.classList.toggle('hidden', kind !== 'enchant')
    this.tradeWindow.classList.toggle('hidden', kind !== 'trade')
    this.adminWindow.classList.toggle('hidden', kind !== 'admin')
    if (screen?.kind === 'chest') {
      this.chestWindow.classList.toggle('double', screen.double)
      this.chestTitle.replaceChildren(
        this.font.createCanvas(screen.double ? 'Large Chest' : 'Chest', '#404040', false)
      )
    }
    if (screen?.kind === 'trade') {
      const profession = screen.profession[0].toUpperCase() + screen.profession.slice(1)
      this.tradeTitle.replaceChildren(this.font.createCanvas(`Villager - ${profession}`, '#404040', false))
    }
  }
  prototype.updateGuiScale = function(this: UI): void {
    let scale = 1
    while (window.innerWidth / (scale + 1) >= 320 && window.innerHeight / (scale + 1) >= 240) scale++
    const changed = scale !== this.guiScale
    this.guiScale = scale
    document.documentElement.style.setProperty('--mc-scale', String(scale))
    if (changed && this.atlas) {
      // Existing canvases keep their bitmap backing store after a CSS transform;
      // redraw them so one source pixel maps cleanly to the current GUI scale.
      requestAnimationFrame(() => {
        this.refreshItemCanvases()
        this.renderRecipeToggle()
      })
    }
  }
  prototype.iconBackingSize = function(this: UI): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    return Math.max(16, Math.round(16 * this.guiScale * dpr))
  }
  prototype.renderRecipeToggle = function(this: UI): void {
    if (!this.sprites) return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = this.iconBackingSize()
    this.sprites.drawIcon(canvas, 11, 3)
    this.recipeToggle.replaceChildren(canvas)
  }
  prototype.refreshItemCanvases = function(this: UI): void {
    if (!this.atlas) return
    const size = this.iconBackingSize()
    document.querySelectorAll<HTMLCanvasElement>('canvas.item-icon').forEach((canvas) => {
      const id = Number(canvas.dataset.itemId)
      if (!Number.isInteger(id) || !ITEMS[id]) return
      canvas.width = canvas.height = size
      this.drawItemIcon(canvas, id)
    })
  }
  prototype.buildHotbar = function(this: UI, atlas: Atlas, blocks: readonly number[] = HOTBAR): void {
    this.atlas = atlas
    this.hotbarBlocks = blocks
    this.hotbar.innerHTML = ''
    this.slots = []
    blocks.forEach((id, index) => {
      const stack = this.mode === 'survival' ? this.inventory?.slots[index] ?? null : null
      const slot = this.makeSlot(id, stack, index, false)
      this.hotbar.appendChild(slot)
      this.slots.push(slot)
    })
    this.setSelectedSlot(0)
  }
  prototype.renderScreen = function(this: UI): void {
    const screen = this.screen
    if (!this.atlas || !this.inventory || this.mode !== 'survival' || !screen) return
    if (screen.kind === 'admin') {
      this.renderAdmin()
      this.renderCursor()
      return
    }
    const main = el<HTMLDivElement>(`${screen.kind}-main`)
    const hotbar = el<HTMLDivElement>(`${screen.kind}-hotbar`)
    main.innerHTML = ''
    hotbar.innerHTML = ''
    for (let index = 9; index < 36; index++) this.addInventorySlot(main, index)
    for (let index = 0; index < 9; index++) this.addInventorySlot(hotbar, index)

    if (screen.kind === 'inventory' || screen.kind === 'workbench') {
      const craft = el<HTMLDivElement>(`${screen.kind}-craft`)
      const result = el<HTMLDivElement>(`${screen.kind}-result`)
      craft.innerHTML = ''
      result.innerHTML = ''
      screen.crafting.grid.forEach((stack, index) => {
        craft.appendChild(this.makeClickableSlot(stack, index, this.onCraftSlotClick))
      })
      const output = screen.crafting.result
      const slot = this.makeSlot(output?.id ?? B.AIR, output, 0, true)
      slot.addEventListener('mousedown', (event) => {
        if (event.button === 0 || event.button === 2) this.onCraftResultClick()
      })
      result.appendChild(slot)
      if (screen.kind === 'inventory') {
        const armor = el<HTMLDivElement>('inventory-armor')
        armor.innerHTML = ''
        this.equipment?.slots.forEach((stack, index) => {
          armor.appendChild(this.makeClickableSlot(stack, index, this.onArmorSlotClick))
        })
      }
      if (screen.kind === 'workbench') this.renderRecipeBook(screen.crafting)
    } else if (screen.kind === 'chest') {
      const grid = el<HTMLDivElement>('chest-grid')
      grid.innerHTML = ''
      screen.slots.forEach((stack, index) => {
        grid.appendChild(this.makeClickableSlot(stack, index, this.onContainerSlotClick))
      })
    } else if (screen.kind === 'furnace') {
      const wraps = ['furnace-input', 'furnace-fuel', 'furnace-output']
      wraps.forEach((id, index) => {
        const wrap = el<HTMLDivElement>(id)
        wrap.innerHTML = ''
        wrap.appendChild(this.makeClickableSlot(screen.state.slots[index], index, this.onContainerSlotClick))
      })
      this.updateFurnace(screen.state)
    } else if (screen.kind === 'enchant') {
      this.renderEnchanting(screen.holder)
    } else if (screen.kind === 'trade') {
      this.renderTrades(screen.profession)
    }
    this.renderCursor()
  }
  prototype.renderTrades = function(this: UI, profession: VillagerProfession): void {
    const offers = el<HTMLDivElement>('trade-offers')
    offers.innerHTML = ''
    const counts = new Map<number, number>()
    for (const stack of this.inventory!.slots) {
      if (stack && stack.damage === undefined && !stack.enchantments?.length) {
        counts.set(stack.id, (counts.get(stack.id) ?? 0) + stack.count)
      }
    }
    VILLAGER_TRADES[profession].forEach((trade, index) => {
      const affordable = (counts.get(trade.cost.id) ?? 0) >= trade.cost.count
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'trade-offer'
      button.classList.toggle('unavailable', !affordable)
      const cost = this.makeSlot(trade.cost.id, { id: trade.cost.id, count: trade.cost.count }, index, true)
      const arrow = this.font.createCanvas('>', affordable ? '#404040' : '#8b3a3a', false)
      const result = this.makeSlot(trade.result.id, { id: trade.result.id, count: trade.result.count }, index, true)
      button.append(cost, arrow, result)
      button.setAttribute(
        'aria-label',
        `Trade ${trade.cost.count} ${itemName(trade.cost.id)} for ${trade.result.count} ${itemName(trade.result.id)}`
      )
      button.addEventListener('click', () => { if (affordable) this.onTradeClick(index) })
      offers.appendChild(button)
    })
  }
  prototype.makeClickableSlot = function(this: UI, stack: ItemStack | null, index: number, handler: SlotHandler): HTMLDivElement {
    const slot = this.makeSlot(stack?.id ?? B.AIR, stack, index, true)
    slot.addEventListener('mousedown', (event) => {
      if (event.button === 0 || event.button === 2) handler(index, event.button as SlotButton, event.shiftKey)
    })
    return slot
  }
  prototype.renderEnchanting = function(this: UI, state: EnchantingState): void {
    const slotWrap = el<HTMLDivElement>('enchant-item')
    slotWrap.innerHTML = ''
    const slot = this.makeClickableSlot(state.slots[0], 0, (_index, button) => this.onEnchantSlotClick(button))
    slotWrap.appendChild(slot)
    this.enchantPower.replaceChildren(this.font.createCanvas(`Power ${state.bookshelfPower}/30`, '#404040', false))
    const offers = el<HTMLDivElement>('enchant-offers')
    offers.innerHTML = ''
    for (let index = 0; index < 3; index++) {
      const offer = state.offers[index]
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'enchant-offer'
      if (!offer) {
        button.disabled = true
      } else {
        const affordable = this.experienceLevel >= offer.cost
        button.classList.toggle('unavailable', !affordable)
        button.title = offer.enchantments.map(enchantment => `${enchantment.id} ${enchantment.level}`).join(', ')
        button.append(
          this.font.createCanvas(offer.clue, affordable ? '#403020' : '#6b5a48', false),
          this.font.createCanvas(String(offer.cost), affordable ? '#80ff20' : '#ff6060', false)
        )
        button.addEventListener('click', () => this.onEnchantOfferClick(index))
      }
      offers.appendChild(button)
    }
  }
  prototype.renderRecipeBook = function(this: UI, crafting: Crafting): void {
    this.recipeBook.classList.toggle('hidden', !this.recipeBookOpen)
    this.recipePreview.classList.toggle('hidden', !this.recipeBookOpen)
    if (!this.recipeBookOpen) return
    const grid = this.recipeGrid
    grid.innerHTML = ''
    const counts = new Map<number, number>()
    const stacks = [...this.inventory!.slots, ...crafting.grid]
    for (const stack of stacks) {
      if (stack && stack.damage === undefined) counts.set(stack.id, (counts.get(stack.id) ?? 0) + stack.count)
    }
    this.recipePreviewIndex = Math.min(this.recipePreviewIndex, RECIPES.length - 1)
    RECIPES.forEach((recipe, index) => {
      const craftable = this.canCraft(recipe, counts)
      const slot = this.makeClickableSlot(
        { id: recipe.result.id, count: recipe.result.count },
        index,
        (recipeIndex, button) => {
          if (button === 0 && craftable) this.onRecipeClick(recipeIndex)
        }
      )
      if (!craftable) slot.classList.add('uncraftable')
      slot.classList.toggle('previewed', index === this.recipePreviewIndex)
      slot.tabIndex = 0
      slot.setAttribute('role', 'button')
      slot.setAttribute('aria-label', `${itemName(recipe.result.id)} recipe`)
      const showPreview = () => {
        this.recipePreviewIndex = index
        grid.querySelectorAll('.inventory-slot').forEach((candidate, candidateIndex) => {
          candidate.classList.toggle('previewed', candidateIndex === index)
        })
        this.renderRecipePreview(recipe, craftable)
      }
      slot.addEventListener('mouseenter', showPreview)
      slot.addEventListener('focus', showPreview)
      grid.appendChild(slot)
    })
    this.updateRecipeScroll()
    const selected = RECIPES[this.recipePreviewIndex]
    this.renderRecipePreview(selected, this.canCraft(selected, counts))
  }
  prototype.setupRecipeScroll = function(this: UI): void {
    this.recipeViewport.addEventListener('wheel', (event) => {
      event.preventDefault()
      this.recipeScrollPx += Math.sign(event.deltaY) * 18
      this.updateRecipeScroll()
    }, { passive: false })

    this.recipeScrollKnob.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const travel = this.recipeKnobTravel()
      if (travel <= 0) return
      const range = this.recipeScrollRange()
      const startY = event.clientY
      const startPx = this.recipeScrollPx
      const scale = this.guiScale || 1
      const onMove = (move: MouseEvent) => {
        const deltaLocal = (move.clientY - startY) / scale
        this.recipeScrollPx = startPx + (deltaLocal / travel) * range
        this.updateRecipeScroll()
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }
  prototype.recipeScrollRange = function(this: UI): number {
    return Math.max(0, this.recipeGrid.scrollHeight - this.recipeViewport.clientHeight)
  }
  prototype.recipeKnobTravel = function(this: UI): number {
    return Math.max(0, this.recipeScrollbar.clientHeight - this.recipeScrollKnob.offsetHeight)
  }
  prototype.updateRecipeScroll = function(this: UI): void {
    const range = this.recipeScrollRange()
    this.recipeScrollPx = Math.max(0, Math.min(range, this.recipeScrollPx))
    this.recipeGrid.style.transform = `translateY(${-this.recipeScrollPx}px)`
    this.recipeScrollbar.classList.toggle('disabled', range <= 0)
    this.recipeScrollbar.setAttribute('aria-valuemin', '0')
    this.recipeScrollbar.setAttribute('aria-valuemax', `${Math.round(range)}`)
    this.recipeScrollbar.setAttribute('aria-valuenow', `${Math.round(this.recipeScrollPx)}`)
    const travel = this.recipeKnobTravel()
    this.recipeScrollKnob.style.top = `${range > 0 ? (this.recipeScrollPx / range) * travel : 0}px`
  }
  prototype.renderRecipePreview = function(this: UI, recipe: Recipe, craftable: boolean): void {
    const grid = el<HTMLDivElement>('recipe-preview-grid')
    const result = el<HTMLDivElement>('recipe-preview-result')
    const name = el<HTMLDivElement>('recipe-preview-name')
    const kind = el<HTMLDivElement>('recipe-preview-kind')
    const status = el<HTMLDivElement>('recipe-preview-status')
    const ingredients: Array<number | readonly number[] | null> = Array(9).fill(null)

    if (recipe.kind === 'shaped') {
      recipe.pattern.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          const key = row[x]
          if (key !== ' ') ingredients[y * 3 + x] = recipe.keys[key] ?? null
        }
      })
    } else {
      recipe.ingredients.forEach((ingredient, index) => { ingredients[index] = ingredient })
    }

    grid.replaceChildren(...ingredients.map((ingredient, index) => {
      if (ingredient === null) return this.makeSlot(B.AIR, null, index, true)
      const ids = typeof ingredient === 'number' ? [ingredient] : [...ingredient]
      const slot = this.makeSlot(ids[0], { id: ids[0], count: 1 }, index, true)
      const alternatives = ids.map(id => itemName(id)).join(' / ')
      slot.title = alternatives
      slot.setAttribute('aria-label', alternatives)
      return slot
    }))
    result.replaceChildren(this.makeSlot(
      recipe.result.id,
      { id: recipe.result.id, count: recipe.result.count },
      0,
      true
    ))
    name.replaceChildren(this.font.createCanvas(itemName(recipe.result.id), '#404040', false))
    kind.replaceChildren(this.font.createCanvas(recipe.kind === 'shaped' ? 'Shaped 3x3' : 'Shapeless', '#404040', false))
    status.replaceChildren(this.font.createCanvas(craftable ? 'Ready to craft' : 'Missing items', '#404040', false))
    status.classList.toggle('unavailable', !craftable)
    this.recipePreview.setAttribute(
      'aria-label',
      `${itemName(recipe.result.id)}, ${recipe.kind} recipe, ${craftable ? 'ready to craft' : 'missing items'}`
    )
  }
  prototype.canCraft = function(this: UI, recipe: Recipe, counts: ReadonlyMap<number, number>): boolean {
    const pool = new Map(counts)
    for (const ingredient of recipeIngredients(recipe)) {
      const ids = typeof ingredient === 'number' ? [ingredient] : ingredient
      const id = ids.find(candidate => (pool.get(candidate) ?? 0) > 0)
      if (id === undefined) return false
      pool.set(id, pool.get(id)! - 1)
    }
    return true
  }
}
