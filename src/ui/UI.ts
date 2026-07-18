import { HOTBAR, B, tileFor, CROSS } from '../world/Blocks'
import { ITEMS, itemName } from '../world/Items'
import { FURNACE_SMELT_SECONDS, RECIPES, Recipe, recipeIngredients } from '../world/Recipes'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import type { Settings, QualityName, GameMode } from '../core/Settings'
import type { Inventory, ItemStack } from '../player/Inventory'
import type { Crafting, CursorHolder } from '../player/Crafting'
import type { FurnaceState } from '../world/Containers'
import type { MinecraftFont } from './MinecraftFont'

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

/** The container screen currently shown over the game. */
export type UIScreen =
  | { kind: 'inventory'; crafting: Crafting }
  | { kind: 'workbench'; crafting: Crafting }
  | { kind: 'chest'; slots: Array<ItemStack | null>; holder: CursorHolder; double: boolean }
  | { kind: 'furnace'; state: FurnaceState; holder: CursorHolder }
  | { kind: 'admin' }

export class UI {
  onEnterWorld: (seed: string, quality: QualityName, mode: GameMode) => void = () => {}
  onResume: () => void = () => {}
  onQuit: () => void = () => location.reload()
  onSettingsChanged: () => void = () => {}
  onInventoryToggle: () => void = () => {}
  onInventorySlotClick: (slot: number, button: SlotButton) => void = () => {}
  onCraftSlotClick: (index: number, button: SlotButton) => void = () => {}
  onCraftResultClick: () => void = () => {}
  /** Clicks on chest slots (0..26/53) or furnace slots (0 input, 1 fuel, 2 output). */
  onContainerSlotClick: (index: number, button: SlotButton) => void = () => {}
  /** Click on a craftable recipe in the workbench recipe book. */
  onRecipeClick: (index: number) => void = () => {}
  /** Click on an item in the temporary admin panel. */
  onAdminItemClick: (id: number, button: SlotButton) => void = () => {}

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
  private inventoryTitle = document.querySelector<HTMLDivElement>('.inventory-title')!
  private inventoryCraftingTitle = document.querySelector<HTMLDivElement>('.inventory-crafting-title')!
  private workbenchTitle = document.querySelector<HTMLDivElement>('.workbench-title')!
  private furnaceTitle = document.querySelector<HTMLDivElement>('.furnace-title')!
  private furnaceInventoryTitle = document.querySelector<HTMLDivElement>('.furnace-inventory-title')!
  private chestTitle = document.querySelector<HTMLDivElement>('.chest-title')!
  private chestInventoryTitle = document.querySelector<HTMLDivElement>('.chest-inventory-title')!
  private furnaceFlame = el<HTMLDivElement>('furnace-flame')
  private furnaceArrow = el<HTMLDivElement>('furnace-arrow')
  private recipeToggle = el<HTMLButtonElement>('recipe-toggle')
  private recipeBook = el<HTMLDivElement>('recipe-book')
  private adminWindow = el<HTMLDivElement>('admin-window')
  private recipeBookOpen = false
  private inventoryCursor = el<HTMLDivElement>('inventory-cursor')
  private hud = el<HTMLDivElement>('hud')
  private info = el<HTMLDivElement>('info')
  private hotbar = el<HTMLDivElement>('hotbar')
  private blockName = el<HTMLDivElement>('block-name')
  private survivalStats = el<HTMLDivElement>('survival-stats')
  private healthBar = el<HTMLDivElement>('health-bar')
  private hungerBar = el<HTMLDivElement>('hunger-bar')
  private airBar = el<HTMLDivElement>('air-bar')
  private experienceBar = el<HTMLDivElement>('experience-bar')
  private toastEl = el<HTMLDivElement>('toast')
  private underwater = el<HTMLDivElement>('underwater-overlay')
  private damageOverlay = el<HTMLDivElement>('damage-overlay')
  private settingsPanel = el<HTMLDivElement>('settings-panel')
  private slots: HTMLDivElement[] = []
  private hotbarBlocks: readonly number[] = HOTBAR
  private atlas: Atlas | null = null
  private sprites: ItemSprites | null = null
  private inventory: Inventory | null = null
  private screen: UIScreen | null = null
  private mode: GameMode = 'creative'
  private toastTimer: number | null = null
  private blockNameTimer: number | null = null
  private guiScale = 1

  constructor(private settings: Settings, private font: MinecraftFont) {
    this.updateGuiScale()
    window.addEventListener('resize', () => this.updateGuiScale())
    this.inventoryScreen.addEventListener('mousemove', (event) => {
      this.inventoryCursor.style.left = `${event.clientX}px`
      this.inventoryCursor.style.top = `${event.clientY}px`
    })
    this.inventoryScreen.addEventListener('contextmenu', (event) => event.preventDefault())
    this.recipeToggle.addEventListener('click', () => {
      this.recipeBookOpen = !this.recipeBookOpen
      this.renderScreen()
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

  configureGame(atlas: Atlas, sprites: ItemSprites, mode: GameMode, inventory: Inventory): void {
    this.atlas = atlas
    this.sprites = sprites
    this.mode = mode
    this.inventory = inventory
    this.survivalStats.classList.toggle('hidden', mode !== 'survival')
    this.experienceBar.classList.toggle('hidden', mode !== 'survival')
    this.inventoryTitle.replaceChildren(this.font.createCanvas('Inventory', '#404040', false))
    this.inventoryCraftingTitle.replaceChildren(this.font.createCanvas('Crafting', '#404040', false))
    this.workbenchTitle.replaceChildren(this.font.createCanvas('Crafting', '#404040', false))
    this.furnaceTitle.replaceChildren(this.font.createCanvas('Furnace', '#404040', false))
    this.furnaceInventoryTitle.replaceChildren(this.font.createCanvas('Inventory', '#404040', false))
    this.chestInventoryTitle.replaceChildren(this.font.createCanvas('Inventory', '#404040', false))
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
    this.adminWindow.classList.toggle('hidden', kind !== 'admin')
    if (screen?.kind === 'chest') {
      this.chestWindow.classList.toggle('double', screen.double)
      this.chestTitle.replaceChildren(
        this.font.createCanvas(screen.double ? 'Large Chest' : 'Chest', '#404040', false)
      )
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
      if (screen.kind === 'workbench') this.renderRecipeBook(screen.crafting)
    } else if (screen.kind === 'chest') {
      const grid = el<HTMLDivElement>('chest-grid')
      grid.innerHTML = ''
      screen.slots.forEach((stack, index) => {
        grid.appendChild(this.makeClickableSlot(stack, index, this.onContainerSlotClick))
      })
    } else {
      const wraps = ['furnace-input', 'furnace-fuel', 'furnace-output']
      wraps.forEach((id, index) => {
        const wrap = el<HTMLDivElement>(id)
        wrap.innerHTML = ''
        wrap.appendChild(this.makeClickableSlot(screen.state.slots[index], index, this.onContainerSlotClick))
      })
      this.updateFurnace(screen.state)
    }
    this.renderCursor()
  }

  private makeClickableSlot(
    stack: ItemStack | null,
    index: number,
    handler: (index: number, button: SlotButton) => void
  ): HTMLDivElement {
    const slot = this.makeSlot(stack?.id ?? B.AIR, stack, index, true)
    slot.addEventListener('mousedown', (event) => {
      if (event.button === 0 || event.button === 2) handler(index, event.button as SlotButton)
    })
    return slot
  }

  /**
   * The recipe book panel next to the workbench. There is no baked recipe
   * book art in the 1.2.4 assets (the feature is from 1.12), so the panel
   * imitates the classic window chrome; recipes the player can craft right
   * now are clickable and fill the grid from the inventory.
   */
  private renderRecipeBook(crafting: Crafting): void {
    this.recipeBook.classList.toggle('hidden', !this.recipeBookOpen)
    if (!this.recipeBookOpen) return
    const grid = el<HTMLDivElement>('recipe-grid')
    grid.innerHTML = ''
    const counts = new Map<number, number>()
    const stacks = [...this.inventory!.slots, ...crafting.grid]
    for (const stack of stacks) {
      if (stack && stack.damage === undefined) counts.set(stack.id, (counts.get(stack.id) ?? 0) + stack.count)
    }
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
      grid.appendChild(slot)
    })
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
      if (event.button === 0 || event.button === 2) this.onInventorySlotClick(index, event.button as SlotButton)
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
      if (stack.count > 1) {
        const count = this.font.createCanvas(String(stack.count))
        count.classList.add('count')
        slot.appendChild(count)
      }
      const durability = ITEMS[stack.id]?.tool?.tier.durability
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
      slot.title = itemName(stack.id)
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
    const name = id === B.AIR || !ITEMS[id] ? 'Empty hand' : itemName(id)
    this.blockName.replaceChildren(this.font.createCanvas(name))
    this.blockName.classList.add('visible')
    if (this.blockNameTimer !== null) clearTimeout(this.blockNameTimer)
    this.blockNameTimer = window.setTimeout(() => this.blockName.classList.remove('visible'), 1600)
  }

  updateSurvivalStats(health: number, hunger: number, air: number): void {
    if (this.mode !== 'survival') return
    this.healthBar.innerHTML = this.statusIcons('heart', health)
    this.hungerBar.innerHTML = this.statusIcons('food', hunger)
    this.airBar.classList.toggle('hidden', air >= 9.95)
    this.airBar.innerHTML = ''
    for (let i = 0; i < 10; i++) {
      const icon = document.createElement('span')
      icon.className = `status-icon air ${i < Math.ceil(air) ? 'full' : 'empty'}`
      this.airBar.appendChild(icon)
    }
  }

  private statusIcons(kind: 'heart' | 'food', value: number): string {
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

  toast(message: string): void {
    this.toastEl.replaceChildren(this.font.createCanvas(message))
    this.toastEl.classList.remove('hidden')
    this.toastEl.classList.add('visible')
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('visible'), 2200)
  }
}
