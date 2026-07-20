import { HOTBAR, B, tileFor, CROSS } from '../world/Blocks'
import { ITEMS, durabilityForItem, itemName } from '../world/Items'
import { FURNACE_SMELT_SECONDS, RECIPES, Recipe, recipeIngredients } from '../world/Recipes'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import type { Settings, QualityName, GameMode } from '../core/Settings'
import type { Inventory, ItemStack } from '../player/Inventory'
import type { Crafting, CursorHolder } from '../player/Crafting'
import type { FurnaceState } from '../world/Containers'
import type { MinecraftFont } from './MinecraftFont'
import type { Equipment } from '../player/Equipment'
import { stackDisplayName, type EnchantingState } from '../player/Enchantments'
import { VILLAGER_TRADES } from '../entities/Trades'
import type { VillagerProfession } from '../entities/EntityTypes'

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error('missing element #' + id)
  return element as T
}

export interface HudData {
  fps: number
  x: number; y: number; z: number
  biome: string
  time: string
  weather: string
  seed: string
  flying: boolean
  noclip: boolean
}

export type SlotButton = 0 | 2
export type SlotHandler = (index: number, button: SlotButton, shift: boolean) => void

/** The container screen currently shown over the game. */
export type UIScreen =
  | { kind: 'inventory'; crafting: Crafting }
  | { kind: 'workbench'; crafting: Crafting }
  | { kind: 'chest'; slots: Array<ItemStack | null>; holder: CursorHolder; double: boolean }
  | { kind: 'furnace'; state: FurnaceState; holder: CursorHolder }
  | { kind: 'enchant'; holder: EnchantingState }
  | { kind: 'trade'; holder: CursorHolder; profession: VillagerProfession }
  | { kind: 'admin' }

export class UI {
  onEnterWorld: (seed: string, quality: QualityName, mode: GameMode) => void = () => {}
  onResume: () => void = () => {}
  onQuit: () => void = () => location.reload()
  onSettingsChanged: () => void = () => {}
  onInventoryToggle: () => void = () => {}
  onInventorySlotClick: SlotHandler = () => {}
  onArmorSlotClick: SlotHandler = () => {}
  onCraftSlotClick: SlotHandler = () => {}
  onCraftResultClick: () => void = () => {}
  /** Clicks on chest slots (0..26/53) or furnace slots (0 input, 1 fuel, 2 output). */
  onContainerSlotClick: SlotHandler = () => {}
  onEnchantSlotClick: (button: SlotButton) => void = () => {}
  onEnchantOfferClick: (index: number) => void = () => {}
  /** Click on a villager trade row. */
  onTradeClick: (index: number) => void = () => {}
  /** Click on a craftable recipe in the workbench recipe book. */
  onRecipeClick: (index: number) => void = () => {}
  /** Click on an item in the temporary admin panel. */
  onAdminItemClick: (id: number, button: SlotButton) => void = () => {}
  onOutsideInventoryClick: (button: SlotButton) => void = () => {}
  /** Console submit (text without leading slash) or cancel (null). */
  onConsoleClose: (text: string | null) => void = () => {}

  private title = el<HTMLDivElement>('title')
  private loading = el<HTMLDivElement>('loading')
  private loadBar = el<HTMLDivElement>('load-bar')
  private loadLabel = el<HTMLParagraphElement>('load-label')
  private clickStart = el<HTMLDivElement>('click-start')
  private pause = el<HTMLDivElement>('pause')
  private controls = el<HTMLDivElement>('controls')
  private inventoryScreen = el<HTMLDivElement>('inventory-screen')
  private inventoryWindow = el<HTMLDivElement>('inventory-window')
  private workbenchWindow = el<HTMLDivElement>('workbench-window')
  private furnaceWindow = el<HTMLDivElement>('furnace-window')
  private chestWindow = el<HTMLDivElement>('chest-window')
  private enchantWindow = el<HTMLDivElement>('enchant-window')
  private tradeWindow = el<HTMLDivElement>('trade-window')
  private inventoryTitle = document.querySelector<HTMLDivElement>('.inventory-title')!
  private inventoryCraftingTitle = document.querySelector<HTMLDivElement>('.inventory-crafting-title')!
  private workbenchTitle = document.querySelector<HTMLDivElement>('.workbench-title')!
  private furnaceTitle = document.querySelector<HTMLDivElement>('.furnace-title')!
  private furnaceInventoryTitle = document.querySelector<HTMLDivElement>('.furnace-inventory-title')!
  private chestTitle = document.querySelector<HTMLDivElement>('.chest-title')!
  private chestInventoryTitle = document.querySelector<HTMLDivElement>('.chest-inventory-title')!
  private enchantTitle = document.querySelector<HTMLDivElement>('.enchant-title')!
  private enchantPower = document.querySelector<HTMLDivElement>('.enchant-power')!
  private tradeTitle = document.querySelector<HTMLDivElement>('.trade-title')!
  private tradeInventoryTitle = document.querySelector<HTMLDivElement>('.trade-inventory-title')!
  private furnaceFlame = el<HTMLDivElement>('furnace-flame')
  private furnaceArrow = el<HTMLDivElement>('furnace-arrow')
  private recipeToggle = el<HTMLButtonElement>('recipe-toggle')
  private recipeBook = el<HTMLDivElement>('recipe-book')
  private recipePreview = el<HTMLDivElement>('recipe-preview')
  private adminWindow = el<HTMLDivElement>('admin-window')
  private recipeBookOpen = false
  private recipePreviewIndex = 0
  private inventoryCursor = el<HTMLDivElement>('inventory-cursor')
  private hud = el<HTMLDivElement>('hud')
  private info = el<HTMLDivElement>('info')
  private hotbar = el<HTMLDivElement>('hotbar')
  private blockName = el<HTMLDivElement>('block-name')
  private survivalStats = el<HTMLDivElement>('survival-stats')
  private healthBar = el<HTMLDivElement>('health-bar')
  private armorBar = el<HTMLDivElement>('armor-bar')
  private hungerBar = el<HTMLDivElement>('hunger-bar')
  private airBar = el<HTMLDivElement>('air-bar')
  private experienceBar = el<HTMLDivElement>('experience-bar')
  private experienceLevelEl = el<HTMLDivElement>('experience-level')
  private toastEl = el<HTMLDivElement>('toast')
  private consoleEl = el<HTMLDivElement>('console')
  private consoleInput = el<HTMLInputElement>('console-input')
  private consoleLogEl = el<HTMLDivElement>('console-log')
  private mapOverlay = el<HTMLDivElement>('map-overlay')
  private mapCanvas = el<HTMLCanvasElement>('map-canvas')
  private mapCaption = el<HTMLDivElement>('map-caption')
  private underwater = el<HTMLDivElement>('underwater-overlay')
  private damageOverlay = el<HTMLDivElement>('damage-overlay')
  private settingsPanel = el<HTMLDivElement>('settings-panel')
  private slots: HTMLDivElement[] = []
  private hotbarBlocks: readonly number[] = HOTBAR
  private atlas: Atlas | null = null
  private sprites: ItemSprites | null = null
  private inventory: Inventory | null = null
  private equipment: Equipment | null = null
  private screen: UIScreen | null = null
  private mode: GameMode = 'creative'
  private toastTimer: number | null = null
  private mapTimer: number | null = null
  private blockNameTimer: number | null = null
  private guiScale = 1
  private experienceLevel = 0

  constructor(private settings: Settings, private font: MinecraftFont) {
    this.updateGuiScale()
    window.addEventListener('resize', () => this.updateGuiScale())
    this.inventoryScreen.addEventListener('mousemove', (event) => {
      this.inventoryCursor.style.left = `${event.clientX}px`
      this.inventoryCursor.style.top = `${event.clientY}px`
    })
    this.inventoryScreen.addEventListener('contextmenu', (event) => event.preventDefault())
    this.inventoryScreen.addEventListener('mousedown', (event) => {
      if (event.target === this.inventoryScreen && (event.button === 0 || event.button === 2)) {
        this.onOutsideInventoryClick(event.button as SlotButton)
      }
    })
    this.recipeToggle.addEventListener('click', () => {
      this.recipeBookOpen = !this.recipeBookOpen
      this.renderScreen()
    })
    this.consoleInput.addEventListener('keydown', (event) => {
      // Keep typing from leaking into the game's global key handler.
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        const text = this.consoleInput.value.trim()
        this.hideConsole()
        this.onConsoleClose(text.length > 0 ? text : null)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.hideConsole()
        this.onConsoleClose(null)
      }
    })
    el<HTMLInputElement>('seed-input').value = settings.lastSeed
    el<HTMLSelectElement>('quality-select').value = settings.quality
    el<HTMLSelectElement>('game-mode-select').value = settings.lastGameMode
    el<HTMLButtonElement>('btn-enter').addEventListener('click', () => {
      const seed = el<HTMLInputElement>('seed-input').value.trim()
      const quality = el<HTMLSelectElement>('quality-select').value as QualityName
      const mode = el<HTMLSelectElement>('game-mode-select').value as GameMode
      this.onEnterWorld(seed, quality, mode)
    })

    el<HTMLButtonElement>('btn-title-controls').addEventListener('click', () => this.showControls(true))
    el<HTMLButtonElement>('btn-pause-controls').addEventListener('click', () => this.showControls(true))
    el<HTMLButtonElement>('btn-close-controls').addEventListener('click', () => this.showControls(false))
    el<HTMLButtonElement>('btn-resume').addEventListener('click', () => this.onResume())
    el<HTMLButtonElement>('btn-quit').addEventListener('click', () => this.onQuit())
    el<HTMLButtonElement>('btn-pause-settings').addEventListener('click', () => this.settingsPanel.classList.toggle('hidden'))

    const vol = el<HTMLInputElement>('opt-volume')
    vol.value = String(settings.volume)
    vol.addEventListener('input', () => {
      settings.volume = parseFloat(vol.value); settings.save(); this.onSettingsChanged()
    })
    const rd = el<HTMLInputElement>('opt-render')
    const rdVal = el<HTMLElement>('opt-render-val')
    rd.value = String(settings.renderDistance); rdVal.textContent = String(settings.renderDistance)
    rd.addEventListener('input', () => {
      settings.renderDistanceOverride = parseInt(rd.value, 10)
      rdVal.textContent = rd.value; settings.save(); this.onSettingsChanged()
    })
    const q = el<HTMLSelectElement>('opt-quality')
    q.value = settings.quality
    q.addEventListener('change', () => {
      settings.quality = q.value as QualityName
      settings.renderDistanceOverride = null
      rd.value = String(settings.renderDistance); rdVal.textContent = rd.value
      settings.save(); this.onSettingsChanged()
    })
    const bob = el<HTMLInputElement>('opt-bob')
    bob.checked = settings.headBob
    bob.addEventListener('change', () => {
      settings.headBob = bob.checked; settings.save(); this.onSettingsChanged()
    })
  }

  configureGame(atlas: Atlas, sprites: ItemSprites, mode: GameMode, inventory: Inventory, equipment: Equipment): void {
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

  /** The state backing the currently open inventory/workbench/furnace/chest screen. */
  setScreen(screen: UIScreen | null): void {
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

  private updateGuiScale(): void {
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

  private iconBackingSize(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    return Math.max(16, Math.round(16 * this.guiScale * dpr))
  }

  private renderRecipeToggle(): void {
    if (!this.sprites) return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = this.iconBackingSize()
    this.sprites.drawIcon(canvas, 11, 3)
    this.recipeToggle.replaceChildren(canvas)
  }

  private refreshItemCanvases(): void {
    if (!this.atlas) return
    const size = this.iconBackingSize()
    document.querySelectorAll<HTMLCanvasElement>('canvas.item-icon').forEach((canvas) => {
      const id = Number(canvas.dataset.itemId)
      if (!Number.isInteger(id) || !ITEMS[id]) return
      canvas.width = canvas.height = size
      this.drawItemIcon(canvas, id)
    })
  }

  buildHotbar(atlas: Atlas, blocks: readonly number[] = HOTBAR): void {
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

  renderScreen(): void {
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

  /** Fixed villager trade rows: cost → result, greyed out when unaffordable. */
  private renderTrades(profession: VillagerProfession): void {
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

  private makeClickableSlot(
    stack: ItemStack | null,
    index: number,
    handler: SlotHandler
  ): HTMLDivElement {
    const slot = this.makeSlot(stack?.id ?? B.AIR, stack, index, true)
    slot.addEventListener('mousedown', (event) => {
      if (event.button === 0 || event.button === 2) handler(index, event.button as SlotButton, event.shiftKey)
    })
    return slot
  }

  private renderEnchanting(state: EnchantingState): void {
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

  /**
   * The recipe book panel next to the workbench. There is no baked recipe
   * book art in the 1.2.4 assets (the feature is from 1.12), so the panel
   * imitates the classic window chrome; recipes the player can craft right
   * now are clickable and fill the grid from the inventory.
   */
  private renderRecipeBook(crafting: Crafting): void {
    this.recipeBook.classList.toggle('hidden', !this.recipeBookOpen)
    this.recipePreview.classList.toggle('hidden', !this.recipeBookOpen)
    if (!this.recipeBookOpen) return
    const grid = el<HTMLDivElement>('recipe-grid')
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
    const selected = RECIPES[this.recipePreviewIndex]
    this.renderRecipePreview(selected, this.canCraft(selected, counts))
  }

  /** Shows the exact 3x3 placement for the recipe selected in the book. */
  private renderRecipePreview(recipe: Recipe, craftable: boolean): void {
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

  private canCraft(recipe: Recipe, counts: ReadonlyMap<number, number>): boolean {
    const pool = new Map(counts)
    for (const ingredient of recipeIngredients(recipe)) {
      const ids = typeof ingredient === 'number' ? [ingredient] : ingredient
      const id = ids.find(candidate => (pool.get(candidate) ?? 0) > 0)
      if (id === undefined) return false
      pool.set(id, pool.get(id)! - 1)
    }
    return true
  }

  /** Temporary admin panel: every registered item, click to receive it. */
  private renderAdmin(): void {
    const grid = el<HTMLDivElement>('admin-grid')
    grid.innerHTML = ''
    for (const item of ITEMS) {
      if (!item) continue
      grid.appendChild(this.makeClickableSlot(
        { id: item.id, count: 1 },
        item.id,
        (id, button) => this.onAdminItemClick(id, button)
      ))
    }
  }

  /** Live furnace indicators: flame burns down, arrow fills left to right. */
  updateFurnace(state: FurnaceState): void {
    const burn = state.burnTotal > 0 ? Math.max(0, Math.min(1, state.burn / state.burnTotal)) : 0
    const cook = Math.max(0, Math.min(1, state.cook / FURNACE_SMELT_SECONDS))
    const flameHeight = Math.round(burn * 14)
    this.furnaceFlame.style.height = `${flameHeight}px`
    this.furnaceFlame.style.top = `${36 + 14 - flameHeight}px`
    this.furnaceFlame.style.backgroundPosition = `-176px ${flameHeight - 14}px`
    this.furnaceArrow.style.width = `${Math.round(cook * 24)}px`
  }

  private addInventorySlot(parent: HTMLElement, index: number): void {
    const stack = this.inventory!.slots[index]
    const slot = this.makeSlot(stack?.id ?? B.AIR, stack, index, true)
    slot.addEventListener('mousedown', (event) => {
      if (event.button === 0 || event.button === 2) this.onInventorySlotClick(index, event.button as SlotButton, event.shiftKey)
    })
    parent.appendChild(slot)
  }

  private drawItemIcon(canvas: HTMLCanvasElement, id: number): void {
    const item = ITEMS[id]
    if (!item || !this.atlas) return
    if (item.sprite && this.sprites) {
      this.sprites.drawIcon(canvas, item.sprite[0], item.sprite[1])
    } else if (CROSS[id]) {
      this.atlas.drawFlatIcon(canvas, tileFor(id, 0))
    } else {
      const tint: [number, number, number] | undefined = id === B.GRASS ? [0.62, 0.8, 0.38] : undefined
      this.atlas.drawIcon(canvas, tileFor(id, 2), tileFor(id, 0), tint, tileFor(id, 4))
    }
  }

  private makeSlot(id: number, stack: ItemStack | null, index: number, inventorySlot: boolean): HTMLDivElement {
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

  /** Renders the stack carried by the mouse while a container screen is open. */
  renderCursor(): void {
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

  setSelectedSlot(index: number): void {
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

  updateSurvivalStats(health: number, hunger: number, air: number, armor = 0): void {
    if (this.mode !== 'survival') return
    this.healthBar.innerHTML = this.statusIcons('heart', health)
    this.hungerBar.innerHTML = this.statusIcons('food', hunger)
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

  updateExperience(level: number, fraction: number): void {
    this.experienceLevel = Math.max(0, Math.floor(level))
    const fill = el<HTMLDivElement>('experience-fill')
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 182)}px`
    this.experienceLevelEl.replaceChildren(
      ...(this.experienceLevel > 0 ? [this.font.createCanvas(String(this.experienceLevel), '#80ff20')] : [])
    )
    if (this.screen?.kind === 'enchant') this.renderScreen()
  }

  private statusIcons(kind: 'heart' | 'food' | 'armor', value: number): string {
    let html = ''
    for (let i = 0; i < 10; i++) {
      const remaining = value - i * 2
      const fill = remaining >= 2 ? 'full' : remaining >= 1 ? 'half' : 'empty'
      html += `<span class="status-icon ${kind}"><span class="status-fill ${fill}"></span></span>`
    }
    return html
  }

  showTitle(): void { this.swap(this.title) }
  showLoading(): void { this.swap(this.loading) }
  showClickStart(): void { this.swap(this.clickStart) }
  showGame(): void { this.swap(null); this.hud.classList.remove('hidden') }
  showPause(): void { this.pause.classList.remove('hidden') }
  hidePause(): void { this.pause.classList.add('hidden'); this.settingsPanel.classList.add('hidden') }
  isPauseVisible(): boolean { return !this.pause.classList.contains('hidden') }

  showInventory(on: boolean): void {
    this.inventoryScreen.classList.toggle('hidden', !on)
    if (on) this.renderScreen()
    else this.renderCursor()
  }

  private showControls(on: boolean): void { this.controls.classList.toggle('hidden', !on) }
  private swap(screen: HTMLDivElement | null): void {
    for (const item of [this.title, this.loading, this.clickStart, this.pause]) item.classList.toggle('hidden', item !== screen)
  }

  setLoadProgress(fraction: number, label: string): void {
    this.loadBar.style.width = (fraction * 100).toFixed(1) + '%'
    this.loadLabel.textContent = label
  }

  setUnderwater(on: boolean): void { this.underwater.classList.toggle('active', on) }

  showDamage(): void {
    this.damageOverlay.classList.remove('hit')
    this.survivalStats.classList.remove('hurt')
    void this.damageOverlay.offsetWidth
    this.damageOverlay.classList.add('hit')
    this.survivalStats.classList.add('hurt')
    window.setTimeout(() => this.survivalStats.classList.remove('hurt'), 700)
  }

  updateHud(data: HudData): void {
    const lines = [
      `Realmcraft 1.2.4 style (${data.fps.toFixed(0)} fps)`,
      `XYZ: ${data.x.toFixed(1)} / ${data.y.toFixed(1)} / ${data.z.toFixed(1)}`,
      `${data.biome}  ${data.time}  ${data.weather}`,
      `Seed: ${data.seed}`
    ]
    if (data.flying) lines.push('Flight enabled')
    if (data.noclip) lines.push('Xray noclip enabled')
    this.info.replaceChildren(...lines.map(line => this.font.createCanvas(line)))
  }

  /** Displays a classic pixel map with the player centered and the original spawn marked in red. */
  showMap(pixels: Uint8ClampedArray, size: number, centerX: number, centerZ: number, spawnX: number, spawnY: number): void {
    this.mapCanvas.width = this.mapCanvas.height = size
    const ctx = this.mapCanvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.putImageData(new ImageData(pixels, size, size), 0, 0)
    if (spawnX >= 0 && spawnY >= 0 && spawnX < size && spawnY < size) {
      ctx.fillStyle = '#d72b2b'
      ctx.fillRect(spawnX - 1, spawnY - 1, 3, 3)
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(Math.floor(size / 2), Math.floor(size / 2) - 2, 1, 5)
    ctx.fillRect(Math.floor(size / 2) - 2, Math.floor(size / 2), 5, 1)
    this.mapCaption.replaceChildren(this.font.createCanvas(`Map center: ${centerX}, ${centerZ}`))
    this.mapOverlay.classList.remove('hidden')
    if (this.mapTimer !== null) clearTimeout(this.mapTimer)
    this.mapTimer = window.setTimeout(() => this.mapOverlay.classList.add('hidden'), 4200)
  }

  toast(message: string): void {
    this.toastEl.replaceChildren(this.font.createCanvas(message))
    this.toastEl.classList.remove('hidden')
    this.toastEl.classList.add('visible')
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('visible'), 2200)
  }

  get consoleOpen(): boolean { return !this.consoleEl.classList.contains('hidden') }

  openConsole(prefill = '/'): void {
    this.consoleEl.classList.remove('hidden')
    this.consoleInput.value = prefill
    this.consoleInput.focus()
    const end = this.consoleInput.value.length
    this.consoleInput.setSelectionRange(end, end)
  }

  hideConsole(): void {
    this.consoleEl.classList.add('hidden')
    this.consoleInput.value = ''
    this.consoleInput.blur()
  }

  /** Appends a persistent line to the console log (kind tints ok/err). */
  consolePrint(message: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
    const line = document.createElement('div')
    line.className = 'line' + (kind === 'info' ? '' : ' ' + kind)
    line.textContent = message
    this.consoleLogEl.append(line)
    while (this.consoleLogEl.childElementCount > 40) this.consoleLogEl.firstElementChild!.remove()
    this.consoleLogEl.scrollTop = this.consoleLogEl.scrollHeight
  }
}
