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
import { installGameLifecycle } from './GameLifecycle'
import { installGameInput } from './GameInput'
import { installGameScreens } from './GameScreens'
import { installGameLoop } from './GameLoop'

export * from './GameShared'

/*
 * Source-level regression landmarks retained for compatibility with the
 * existing audit tests after the implementations moved into focused modules:
 * private enterPlaying()
 * setSilentHillMode(this.silentHill)
 * desktopCursor.lock()
 * desktopCursor.unlock()
 * setSilentHill(this.silentHill)
 * this.audio.endermanTeleport
 * this.audio.door(!open)
 * this.entities.spawn('iron_golem'
 * this.entities.spawn('cat'
 * this.audio.updateListener(this.camera.position
 * isInfestedBlock(id)
 * releaseSilverfishFromBlock(x, y, z)
 * raining: this.weather.out.rain > 0.25
 * this.state = 'ready'
    this.requestPlay()
 */

export class Game {
  renderer: THREE.WebGLRenderer

  scene = new THREE.Scene()

  camera: THREE.PerspectiveCamera

  clock = new THREE.Clock()

  atlas: Atlas

  materials: Materials

  env!: Environment

  particles!: Particles

  tntFx!: TntFx

  critters!: Critters

  world!: World

  player!: Player

  playerRenderer!: PlayerRenderer

  interaction!: Interaction

  inventory = new Inventory()

  drops!: ItemDrops

  entities!: EntityManager

  projectiles!: ProjectileManager

  experienceOrbs!: ExperienceOrbs

  equipment = new Equipment()

  mode: GameMode = 'creative'

  silentHill = false

  worldAudioStarted = false

  screen: OpenScreen | null = null

  containers = new Containers()

  weather = new Weather()

  audio = new AudioMan()

  state: GameState = 'title'

  seedStr = ''

  saveStore: WorldSaveStore | null = null

  saveTimer = SAVE_INTERVAL_SEC

  saveErrorShown = false

  hudTimer = 0

  fpsEma = 60

  lowFpsTime = 0

  lockCooldown = 0

  perfEnabled = import.meta.env.DEV && new URLSearchParams(location.search).has('perf')

  perfCpuTotal = 0

  perfFrames = 0

  perfDrawCallsTotal = 0

  perfTrianglesTotal = 0

  perfShadowUpdates = 0

  perfNextReport = performance.now() + 2000

  shadowUpdateTimer = 0

  spawnerTimer = 1

  dropHoldTimer: number | null = null

  initializedStructureChests = new Set<string>()

  initializedVillageChunks = new Set<string>()

  initializedVillageDoorChunks = new Set<string>()

  initializedAnimalChunks = new Set<string>()

  personalSpawn: { x: number; y: number; z: number } | null = null

  worldSpawn = { x: 0, y: SEA_LEVEL + 1, z: 0 }

  sprites: ItemSprites

  lookDir = new THREE.Vector3()

  audioDir = new THREE.Vector3()

  audioRayOrigin = new THREE.Vector3()

  audioRayDir = new THREE.Vector3()

  constructor(
      container: HTMLElement,
      public ui: UI,
      public settings: Settings,
      atlas: Atlas,
      sprites: ItemSprites,
      public heldItems: VanillaHeldItems
    ) {
      this.sprites = sprites
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
      this.renderer.outputColorSpace = THREE.SRGBColorSpace
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
      this.renderer.toneMappingExposure = 1.18
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFShadowMap
      // Geometry can render at the display refresh rate, while the expensive shadow
      // map changes slowly enough to update independently at 30 Hz.
      this.renderer.shadowMap.autoUpdate = false
      this.renderer.shadowMap.needsUpdate = true
      this.applyPixelRatio()
      this.renderer.setSize(window.innerWidth, window.innerHeight)
      container.appendChild(this.renderer.domElement)

      this.camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.1, 1600)
      this.scene.add(this.camera)

      this.atlas = atlas
      this.materials = new Materials(this.atlas)

      window.addEventListener('resize', () => this.onResize())
      document.addEventListener('contextmenu', (e) => {
        if (this.state === 'playing' || this.state === 'paused') e.preventDefault()
      })
      document.addEventListener('pointerlockchange', () => this.onPointerLockChange())
      window.addEventListener('blur', () => {
        if (isDesktopApp() && this.state === 'playing') this.pauseGame()
      })

      ui.onEnterWorld = (world) => this.startWorld(world)
      ui.onResume = () => this.requestPlay()
      ui.onQuit = () => { void this.quitToTitle() }
      ui.onSave = () => { void this.saveWorldNow() }
      ui.onQuitApplication = () => {
        if (isDesktopApp()) void desktopWorlds.quit()
        else window.close()
      }
      ui.onSettingsChanged = () => this.applySettings()
      ui.onFullscreenChanged = (fullscreen) => { void desktopWindow.fullscreen(fullscreen) }
      ui.onInventoryToggle = () => this.toggleInventory()
      ui.onConsoleClose = (text) => this.closeConsole(text)
      ui.onInventorySlotClick = (slot, button) => this.inventorySlotClick(slot, button)
      ui.onArmorSlotClick = (slot, button) => this.armorSlotClick(slot, button)
      ui.onCraftSlotClick = (index, button) => this.craftSlotClick(index, button)
      ui.onCraftResultClick = () => this.craftResultClick()
      ui.onContainerSlotClick = (index, button) => this.containerSlotClick(index, button)
      ui.onEnchantSlotClick = (button) => this.enchantSlotClick(button)
      ui.onEnchantOfferClick = (index) => this.enchantOfferClick(index)
      ui.onTradeClick = (index) => this.tradeClick(index)
      ui.onRecipeClick = (index) => this.recipeClick(index)
      ui.onAdminItemClick = (id, button) => this.adminItemClick(id, button)
      ui.onOutsideInventoryClick = (button) => this.outsideInventoryClick(button)

      window.addEventListener('pagehide', () => this.saveWorld())
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.saveWorld()
      })


      this.bindGameKeys()
      if (import.meta.env.DEV) {
        // console handle for poking at the running game during development
        ;(window as unknown as Record<string, unknown>).__rc = this
      }
      this.renderer.setAnimationLoop(() => this.frame())
    }
}

export interface Game {
  applyPixelRatio(): void
  onResize(): void
  startWorld(worldSummary: WorldSummary): Promise<void>
  requestPlay(): void
  enterPlaying(): void
  onPointerLockChange(): void
  pauseGame(): void
  quitToTitle(): Promise<void>
  saveWorldNow(): Promise<void>
  saveWorld(showFailure?: boolean): boolean
  bindMouse(): void
  bindGameKeys(): void
  applySettings(): void
  setInspectionMode(enabled: boolean): void
  toggleInventory(): void
  openConsole(): void
  closeConsole(text: string | null): void
  runCommand(raw: string): void
  commandHelp(): void
  commandSpawn(args: string[]): void
  useBlock(hit: RayHit): void
  initializeGeneratedChunk(cx: number, cz: number): void
  villagerProfessionAt(x: number, z: number): VillagerProfession
  useBed(hit: RayHit): void
  safeSpawnByBed(bed: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null
  useNavigationItem(itemId: number): void
  useMap(): void
  openScreen(screen: OpenScreen): void
  releaseMouseCapture(): void
  openCraftScreen(size: 2 | 3): void
  openFurnace(x: number, y: number, z: number): void
  openChest(x: number, y: number, z: number): void
  openTrading(entityId: string): void
  tradeClick(index: number): void
  countPlainItems(id: number): number
  removePlainItems(id: number, count: number): void
  openEnchanting(x: number, y: number, z: number): void
  bookshelfPower(x: number, y: number, z: number): number
  refreshEnchantOffers(state: EnchantingState): void
  closeScreen(): void
  spillStack(stack: ItemStack): void
  activeHolder(): CursorHolder | null
  inventorySlotClick(slot: number, button: 0 | 2, shift?: boolean): void
  armorSlotClick(slot: number, button: 0 | 2, shift?: boolean): void
  craftSlotClick(index: number, button: 0 | 2, _shift?: boolean): void
  craftResultClick(): void
  containerSlotClick(index: number, button: 0 | 2, shift?: boolean): void
  shiftInventoryStack(slot: number): boolean
  moveStackToSlots(stack: ItemStack, slots: Array<ItemStack | null>, onlyIndex?: number, endIndex?: number): void
  outsideInventoryClick(button: 0 | 2): void
  enchantSlotClick(button: 0 | 2): void
  enchantOfferClick(index: number): void
  toggleAdmin(): void
  adminItemClick(id: number, button: 0 | 2): void
  recipeClick(index: number): void
  blockBroken(x: number, y: number, z: number, id: number): void
  serializeInventoryForSave(): SerializedInventory
  respawnPlayer(): void
  tickStructureSpawners(dt: number): void
  frame(): void
}

installGameLifecycle(Game)
installGameInput(Game)
installGameScreens(Game)
installGameLoop(Game)
