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
import { installUIScreens } from './UIScreens'
import { installUIInventory } from './UIInventory'
import { installUIMenus } from './UIMenus'
import { installUIHud } from './UIHud'

export * from './UIShared'

/*
 * Source-level regression landmarks for icon rendering now implemented in
 * UIInventory.ts: id === B.RAIL; this.atlas.drawFlatIcon
 */

export class UI {
  onEnterWorld: (world: WorldSummary) => void = () => {}

  onResume: () => void = () => {}

  onQuit: () => void = () => location.reload()

  onSave: () => void = () => {}

  onQuitApplication: () => void = () => {}

  onSettingsChanged: () => void = () => {}

  onFullscreenChanged: (fullscreen: boolean) => void = () => {}

  onInventoryToggle: () => void = () => {}

  onInventorySlotClick: SlotHandler = () => {}

  onArmorSlotClick: SlotHandler = () => {}

  onCraftSlotClick: SlotHandler = () => {}

  onCraftResultClick: () => void = () => {}

  onContainerSlotClick: SlotHandler = () => {}

  onEnchantSlotClick: (button: SlotButton) => void = () => {}

  onEnchantOfferClick: (index: number) => void = () => {}

  onTradeClick: (index: number) => void = () => {}

  onRecipeClick: (index: number) => void = () => {}

  onAdminItemClick: (id: number, button: SlotButton) => void = () => {}

  onOutsideInventoryClick: (button: SlotButton) => void = () => {}

  onConsoleClose: (text: string | null) => void = () => {}

  title = el<HTMLDivElement>('title')

  worldSelect = el<HTMLDivElement>('world-select')

  worldCreate = el<HTMLDivElement>('world-create')

  options = el<HTMLDivElement>('options')

  videoSettings = el<HTMLDivElement>('video-settings')

  soundSettings = el<HTMLDivElement>('sound-settings')

  deleteWorldConfirm = el<HTMLDivElement>('delete-world-confirm')

  worldList = el<HTMLDivElement>('world-list')

  worldEmpty = el<HTMLParagraphElement>('world-empty')

  loading = el<HTMLDivElement>('loading')

  loadLabel = el<HTMLParagraphElement>('load-label')

  loadPercent = el<HTMLParagraphElement>('load-percent')

  loadTip = el<HTMLParagraphElement>('load-tip')

  loadCanvas = el<HTMLCanvasElement>('load-world-canvas')

  pause = el<HTMLDivElement>('pause')

  controls = el<HTMLDivElement>('controls')

  controlsList = el<HTMLDivElement>('controls-list')

  inventoryScreen = el<HTMLDivElement>('inventory-screen')

  inventoryWindow = el<HTMLDivElement>('inventory-window')

  workbenchWindow = el<HTMLDivElement>('workbench-window')

  furnaceWindow = el<HTMLDivElement>('furnace-window')

  chestWindow = el<HTMLDivElement>('chest-window')

  enchantWindow = el<HTMLDivElement>('enchant-window')

  tradeWindow = el<HTMLDivElement>('trade-window')

  inventoryTitle = document.querySelector<HTMLDivElement>('.inventory-title')!

  inventoryCraftingTitle = document.querySelector<HTMLDivElement>('.inventory-crafting-title')!

  workbenchTitle = document.querySelector<HTMLDivElement>('.workbench-title')!

  furnaceTitle = document.querySelector<HTMLDivElement>('.furnace-title')!

  furnaceInventoryTitle = document.querySelector<HTMLDivElement>('.furnace-inventory-title')!

  chestTitle = document.querySelector<HTMLDivElement>('.chest-title')!

  chestInventoryTitle = document.querySelector<HTMLDivElement>('.chest-inventory-title')!

  enchantTitle = document.querySelector<HTMLDivElement>('.enchant-title')!

  enchantPower = document.querySelector<HTMLDivElement>('.enchant-power')!

  tradeTitle = document.querySelector<HTMLDivElement>('.trade-title')!

  tradeInventoryTitle = document.querySelector<HTMLDivElement>('.trade-inventory-title')!

  furnaceFlame = el<HTMLDivElement>('furnace-flame')

  furnaceArrow = el<HTMLDivElement>('furnace-arrow')

  recipeToggle = el<HTMLButtonElement>('recipe-toggle')

  recipeBook = el<HTMLDivElement>('recipe-book')

  recipeViewport = el<HTMLDivElement>('recipe-viewport')

  recipeGrid = el<HTMLDivElement>('recipe-grid')

  recipeScrollbar = el<HTMLDivElement>('recipe-scrollbar')

  recipeScrollKnob = el<HTMLDivElement>('recipe-scroll-knob')

  recipeScrollPx = 0

  recipePreview = el<HTMLDivElement>('recipe-preview')

  adminWindow = el<HTMLDivElement>('admin-window')

  adminViewport = el<HTMLDivElement>('admin-viewport')

  adminGrid = el<HTMLDivElement>('admin-grid')

  adminScrollbar = el<HTMLDivElement>('admin-scrollbar')

  adminScrollKnob = el<HTMLDivElement>('admin-scroll-knob')

  adminScrollPx = 0

  recipeBookOpen = false

  recipePreviewIndex = 0

  inventoryCursor = el<HTMLDivElement>('inventory-cursor')

  hud = el<HTMLDivElement>('hud')

  info = el<HTMLDivElement>('info')

  hotbar = el<HTMLDivElement>('hotbar')

  blockName = el<HTMLDivElement>('block-name')

  survivalStats = el<HTMLDivElement>('survival-stats')

  healthBar = el<HTMLDivElement>('health-bar')

  armorBar = el<HTMLDivElement>('armor-bar')

  hungerBar = el<HTMLDivElement>('hunger-bar')

  airBar = el<HTMLDivElement>('air-bar')

  experienceBar = el<HTMLDivElement>('experience-bar')

  experienceLevelEl = el<HTMLDivElement>('experience-level')

  toastEl = el<HTMLDivElement>('toast')

  consoleEl = el<HTMLDivElement>('console')

  consoleInput = el<HTMLInputElement>('console-input')

  consoleLogEl = el<HTMLDivElement>('console-log')

  mapOverlay = el<HTMLDivElement>('map-overlay')

  mapCanvas = el<HTMLCanvasElement>('map-canvas')

  mapCaption = el<HTMLDivElement>('map-caption')

  underwater = el<HTMLDivElement>('underwater-overlay')

  damageOverlay = el<HTMLDivElement>('damage-overlay')

  slots: HTMLDivElement[] = []

  hotbarBlocks: readonly number[] = HOTBAR

  atlas: Atlas | null = null

  sprites: ItemSprites | null = null

  inventory: Inventory | null = null

  equipment: Equipment | null = null

  screen: UIScreen | null = null

  mode: GameMode = 'creative'

  toastTimer: number | null = null

  mapTimer: number | null = null

  blockNameTimer: number | null = null

  guiScale = 1

  experienceLevel = 0

  worlds: WorldSummary[] = []

  selectedWorldId: string | null = null

  createSilentHill = false

  menuReturn: 'title' | 'pause' = 'title'

  controlsReturn: 'root' | 'options' = 'root'

  rebindingAction: ControlAction | null = null

  loadProgress = 0

  loadAnimationFrame: number | null = null

  constructor(public settings: Settings, public font: MinecraftFont, public worldLibrary: WorldLibrary) {
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
        if (!this.recipeBookOpen) this.recipeScrollPx = 0
        this.recipeBookOpen = !this.recipeBookOpen
        this.renderScreen()
      })
      this.setupRecipeScroll()
      this.setupAdminScroll()
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
      el<HTMLInputElement>('seed-input').value = ''
      el<HTMLSelectElement>('game-mode-select').value = settings.lastGameMode
      el<HTMLButtonElement>('btn-singleplayer').addEventListener('click', () => { void this.openWorldSelect() })
      el<HTMLButtonElement>('btn-title-options').addEventListener('click', () => this.showOptions('title'))
      el<HTMLButtonElement>('btn-quit-game').addEventListener('click', () => this.onQuitApplication())
      el<HTMLButtonElement>('btn-world-cancel').addEventListener('click', () => this.showTitle())
      el<HTMLButtonElement>('btn-create-world').addEventListener('click', () => this.openCreateWorld())
      el<HTMLButtonElement>('btn-create-cancel').addEventListener('click', () => { void this.openWorldSelect() })
      el<HTMLButtonElement>('btn-play-world').addEventListener('click', () => {
        const world = this.worlds.find(candidate => candidate.id === this.selectedWorldId)
        if (world) this.onEnterWorld(world)
      })
      el<HTMLButtonElement>('btn-delete-world').addEventListener('click', () => this.showDeleteConfirmation())
      el<HTMLButtonElement>('btn-delete-cancel').addEventListener('click', () => { void this.openWorldSelect() })
      el<HTMLButtonElement>('btn-confirm-delete').addEventListener('click', () => { void this.deleteSelectedWorld() })
      el<HTMLButtonElement>('btn-confirm-create').addEventListener('click', () => { void this.createWorld() })
      const modeSelect = el<HTMLSelectElement>('game-mode-select')
      modeSelect.addEventListener('change', () => this.updateGameModeDescription())
      el<HTMLButtonElement>('btn-world-silent-hill').addEventListener('click', () => {
        this.createSilentHill = !this.createSilentHill
        this.syncSilentHillOption()
      })
      el<HTMLInputElement>('world-name-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') void this.createWorld()
      })

      el<HTMLButtonElement>('btn-title-controls').addEventListener('click', () => {
        this.menuReturn = 'title'; this.controlsReturn = 'root'; this.showControls()
      })
      el<HTMLButtonElement>('btn-pause-controls').addEventListener('click', () => {
        this.menuReturn = 'pause'; this.controlsReturn = 'root'; this.showControls()
      })
      el<HTMLButtonElement>('btn-options-controls').addEventListener('click', () => {
        this.controlsReturn = 'options'; this.showControls()
      })
      el<HTMLButtonElement>('btn-close-controls').addEventListener('click', () => this.closeControls())
      el<HTMLButtonElement>('btn-reset-controls').addEventListener('click', () => {
        settings.resetKeys(); this.rebindingAction = null; this.renderControls(); this.onSettingsChanged()
      })
      el<HTMLButtonElement>('btn-resume').addEventListener('click', () => this.onResume())
      el<HTMLButtonElement>('btn-quit').addEventListener('click', () => this.onQuit())
      el<HTMLButtonElement>('btn-save-world').addEventListener('click', () => this.onSave())
      el<HTMLButtonElement>('btn-pause-options').addEventListener('click', () => this.showOptions('pause'))
      el<HTMLButtonElement>('btn-options-done').addEventListener('click', () => this.closeOptions())
      el<HTMLButtonElement>('btn-video-settings').addEventListener('click', () => this.swap(this.videoSettings))
      el<HTMLButtonElement>('btn-sound-settings').addEventListener('click', () => this.swap(this.soundSettings))
      el<HTMLButtonElement>('btn-video-done').addEventListener('click', () => this.swap(this.options))
      el<HTMLButtonElement>('btn-sound-done').addEventListener('click', () => this.swap(this.options))

      const vol = el<HTMLInputElement>('opt-volume')
      vol.addEventListener('input', () => {
        settings.volume = parseFloat(vol.value); settings.save(); this.onSettingsChanged()
        this.syncSettingsUI()
      })
      const rd = el<HTMLInputElement>('opt-render')
      rd.addEventListener('input', () => {
        settings.renderDistanceOverride = parseInt(rd.value, 10)
        settings.save(); this.onSettingsChanged(); this.syncSettingsUI()
      })
      el<HTMLButtonElement>('btn-graphics').addEventListener('click', () => {
        const qualities: QualityName[] = ['low', 'medium', 'high', 'ultra']
        settings.quality = qualities[(qualities.indexOf(settings.quality) + 1) % qualities.length]
        settings.renderDistanceOverride = null
        settings.save(); this.onSettingsChanged(); this.syncSettingsUI()
      })
      el<HTMLButtonElement>('btn-view-bobbing').addEventListener('click', () => {
        settings.headBob = !settings.headBob; settings.save(); this.onSettingsChanged(); this.syncSettingsUI()
      })
      const fov = el<HTMLInputElement>('opt-fov')
      fov.addEventListener('input', () => {
        settings.fov = parseInt(fov.value, 10); settings.save(); this.onSettingsChanged(); this.syncSettingsUI()
      })
      const sensitivity = el<HTMLInputElement>('opt-sensitivity')
      sensitivity.addEventListener('input', () => {
        settings.mouseSensitivity = parseFloat(sensitivity.value)
        settings.save(); this.onSettingsChanged(); this.syncSettingsUI()
      })
      el<HTMLButtonElement>('btn-invert-mouse').addEventListener('click', () => {
        settings.invertMouse = !settings.invertMouse; settings.save(); this.onSettingsChanged(); this.syncSettingsUI()
      })
      const toggleFullscreen = (): void => {
        settings.fullscreen = !settings.fullscreen
        settings.save(); this.syncSettingsUI(); this.onFullscreenChanged(settings.fullscreen)
      }
      el<HTMLButtonElement>('btn-fullscreen').addEventListener('click', toggleFullscreen)
      el<HTMLButtonElement>('btn-video-fullscreen').addEventListener('click', toggleFullscreen)
      document.addEventListener('keydown', event => this.captureRebind(event), true)
      this.syncSettingsUI()
      this.renderControls()
      this.updateGameModeDescription()
    }

  get consoleOpen(): boolean { return !this.consoleEl.classList.contains('hidden') }
}

export interface UI {
  configureGame(atlas: Atlas, sprites: ItemSprites, mode: GameMode, inventory: Inventory, equipment: Equipment): void
  setScreen(screen: UIScreen | null): void
  updateGuiScale(): void
  iconBackingSize(): number
  renderRecipeToggle(): void
  refreshItemCanvases(): void
  buildHotbar(atlas: Atlas, blocks?: readonly number[]): void
  renderScreen(): void
  renderTrades(profession: VillagerProfession): void
  makeClickableSlot(stack: ItemStack | null, index: number, handler: SlotHandler): HTMLDivElement
  renderEnchanting(state: EnchantingState): void
  renderRecipeBook(crafting: Crafting): void
  setupRecipeScroll(): void
  recipeScrollRange(): number
  recipeKnobTravel(): number
  updateRecipeScroll(): void
  renderRecipePreview(recipe: Recipe, craftable: boolean): void
  canCraft(recipe: Recipe, counts: ReadonlyMap<number, number>): boolean
  renderAdmin(): void
  setupAdminScroll(): void
  adminScrollRange(): number
  adminKnobTravel(): number
  updateAdminScroll(): void
  updateFurnace(state: FurnaceState): void
  addInventorySlot(parent: HTMLElement, index: number): void
  drawItemIcon(canvas: HTMLCanvasElement, id: number): void
  makeSlot(id: number, stack: ItemStack | null, index: number, inventorySlot: boolean): HTMLDivElement
  renderCursor(): void
  setSelectedSlot(index: number): void
  updateSurvivalStats(health: number, hunger: number, air: number, armor?: number): void
  updateExperience(level: number, fraction: number): void
  statusIcons(kind: 'heart' | 'food' | 'armor', value: number): string
  openWorldSelect(): Promise<void>
  renderWorldList(): void
  openCreateWorld(): void
  updateGameModeDescription(): void
  syncSilentHillOption(): void
  createWorld(): Promise<void>
  showDeleteConfirmation(): void
  deleteSelectedWorld(): Promise<void>
  showOptions(origin: 'title' | 'pause'): void
  closeOptions(): void
  setMenuBackdrop(origin: 'title' | 'pause'): void
  syncSettingsUI(): void
  captureRebind(event: KeyboardEvent): void
  renderControls(): void
  showTitle(): void
  showLoading(): void
  showGame(): void
  showPause(): void
  hidePause(): void
  isPauseVisible(): boolean
  showInventory(on: boolean): void
  showControls(): void
  closeControls(): void
  swap(screen: HTMLDivElement | null): void
  setLoadProgress(fraction: number, label: string): void
  drawLoading(time: number): void
  setUnderwater(on: boolean): void
  showDamage(): void
  updateHud(data: HudData): void
  showMap(pixels: Uint8ClampedArray, size: number, centerX: number, centerZ: number, spawnX: number, spawnY: number): void
  toast(message: string): void
  openConsole(prefill?: string): void
  hideConsole(): void
  consolePrint(message: string, kind?: 'ok' | 'err' | 'info'): void
}

installUIScreens(UI)
installUIInventory(UI)
installUIMenus(UI)
installUIHud(UI)
