import * as THREE from 'three'
import { Atlas } from '../gfx/Atlas'
import { Materials } from '../gfx/Materials'
import { Environment } from '../gfx/Environment'
import { Particles } from '../gfx/Particles'
import { Critters } from '../gfx/Critters'
import { U } from '../gfx/Uniforms'
import { World } from '../world/World'
import { WorldGen, BIOME, BIOME_NAMES, SEA_LEVEL } from '../world/WorldGen'
import { CHUNK_SIZE } from '../world/Chunk'
import { Player } from '../player/Player'
import { Interaction } from '../player/Interaction'
import { Inventory, ItemStack, SerializedInventory, cloneStack } from '../player/Inventory'
import { Crafting, CursorHolder, clickStackSlot, returnStacks, takeIntoCursor } from '../player/Crafting'
import { ItemDrops } from '../world/ItemDrops'
import { ITEMS } from '../world/Items'
import { B, isContainerBlock } from '../world/Blocks'
import { CHEST_SLOTS, ChestState, Containers, FURNACE_OUTPUT, FurnaceState } from '../world/Containers'
import { RECIPES, ingredientMatches } from '../world/Recipes'
import type { RayHit } from '../world/World'
import { ItemSprites } from '../gfx/ItemSprites'
import { Weather } from '../weather/Weather'
import { AudioMan } from '../audio/Audio'
import { Settings, QualityName, GameMode } from './Settings'
import { UI } from '../ui/UI'
import { clamp } from '../util/math'
import { WorldSaveStore } from './WorldSave'

type GameState = 'title' | 'loading' | 'ready' | 'playing' | 'paused' | 'inventory'
const SAVE_INTERVAL_SEC = 8

/** The container screen currently open over the game world. */
type OpenScreen =
  | { kind: 'inventory'; crafting: Crafting }
  | { kind: 'workbench'; crafting: Crafting }
  | { kind: 'chest'; holder: CursorHolder; slots: Array<ItemStack | null>; parts: ChestState[]; double: boolean }
  | { kind: 'furnace'; holder: CursorHolder; state: FurnaceState; x: number; y: number; z: number }
  | { kind: 'admin' }

export class Game {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()

  private atlas: Atlas
  private materials: Materials
  private env!: Environment
  private particles!: Particles
  private critters!: Critters
  private world!: World
  private player!: Player
  private interaction!: Interaction
  private inventory = new Inventory()
  private drops!: ItemDrops
  private mode: GameMode = 'creative'
  private screen: OpenScreen | null = null
  private containers = new Containers()
  private weather = new Weather()
  private audio = new AudioMan()

  private state: GameState = 'title'
  private seedStr = ''
  private saveStore: WorldSaveStore | null = null
  private saveTimer = SAVE_INTERVAL_SEC
  private saveErrorShown = false
  private hudTimer = 0
  private fpsEma = 60
  private lowFpsTime = 0
  private lockCooldown = 0
  private perfEnabled = import.meta.env.DEV && new URLSearchParams(location.search).has('perf')
  private perfCpuTotal = 0
  private perfFrames = 0
  private perfDrawCallsTotal = 0
  private perfTrianglesTotal = 0
  private perfShadowUpdates = 0
  private perfNextReport = performance.now() + 2000
  private shadowUpdateTimer = 0

  private sprites: ItemSprites

  constructor(
    private container: HTMLElement,
    private ui: UI,
    private settings: Settings,
    atlas: Atlas,
    sprites: ItemSprites
  ) {
    this.sprites = sprites
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.18
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Geometry can render at the display refresh rate, while the expensive shadow
    // map changes slowly enough to update independently at 30 Hz.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    this.applyPixelRatio()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1600)
    this.scene.add(this.camera)

    this.atlas = atlas
    this.materials = new Materials(this.atlas)

    window.addEventListener('resize', () => this.onResize())
    document.addEventListener('contextmenu', (e) => {
      if (this.state === 'playing' || this.state === 'paused') e.preventDefault()
    })
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange())

    ui.onEnterWorld = (seed, quality, mode) => this.startWorld(seed, quality, mode)
    ui.onResume = () => this.requestPlay()
    ui.onQuit = () => this.quitToTitle()
    ui.onSettingsChanged = () => this.applySettings()
    ui.onInventoryToggle = () => this.toggleInventory()
    ui.onInventorySlotClick = (slot, button) => this.inventorySlotClick(slot, button)
    ui.onCraftSlotClick = (index, button) => this.craftSlotClick(index, button)
    ui.onCraftResultClick = () => this.craftResultClick()
    ui.onContainerSlotClick = (index, button) => this.containerSlotClick(index, button)
    ui.onRecipeClick = (index) => this.recipeClick(index)
    ui.onAdminItemClick = (id, button) => this.adminItemClick(id, button)

    window.addEventListener('pagehide', () => this.saveWorld())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveWorld()
    })

    document.getElementById('click-start')!.addEventListener('click', () => this.requestPlay())

    this.bindGameKeys()
    if (import.meta.env.DEV) {
      // console handle for poking at the running game during development
      ;(window as unknown as Record<string, unknown>).__rc = this
    }
    this.renderer.setAnimationLoop(() => this.frame())
  }

  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.settings.preset.pixelRatioCap))
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }

  private async startWorld(seed: string, quality: QualityName, mode: GameMode): Promise<void> {
    if (this.state !== 'title') return
    this.settings.quality = quality
    this.settings.lastGameMode = mode
    this.settings.save()
    this.mode = mode
    this.audio.init()
    this.audio.setVolume(this.settings.volume)

    this.seedStr = seed || Math.floor(Math.random() * 1e9).toString(36)
    this.settings.lastSeed = this.seedStr
    this.settings.save()
    this.saveStore = new WorldSaveStore(this.seedStr)
    const saved = this.saveStore.load()
    this.state = 'loading'
    this.ui.showLoading()

    const preset = this.settings.preset
    this.applyPixelRatio()

    const gen = new WorldGen(this.seedStr)
    this.world = new World(
      gen,
      this.scene,
      this.materials,
      this.atlas,
      this.settings.renderDistance,
      preset.grassDensity,
      saved?.blockEdits,
      saved?.blockFacings
    )
    this.env = new Environment(this.scene, preset.shadowSize, this.settings.renderDistance * CHUNK_SIZE)
    this.particles = new Particles(this.scene, preset.particleMult)
    this.critters = new Critters(this.scene)

    this.player = new Player(this.camera, this.world, this.audio, this.mode)
    this.player.headBobEnabled = this.settings.headBob
    this.player.attachInput(this.renderer.domElement)
    this.inventory.restore(saved?.inventory)
    this.drops = new ItemDrops(this.scene, this.world, this.atlas, this.sprites, this.inventory)
    this.interaction = new Interaction(
      this.world, this.player, this.camera, this.scene, this.atlas, this.sprites, this.audio, this.particles,
      this.mode, this.inventory, this.drops
    )
    this.interaction.onSelectionChanged = (i) => this.ui.setSelectedSlot(i)
    this.interaction.onPageChanged = (_page, blocks) => this.ui.buildHotbar(this.atlas, blocks)
    this.interaction.onUseBlock = (hit) => this.useBlock(hit)
    this.interaction.onBlockBroken = (x, y, z, id) => this.blockBroken(x, y, z, id)
    this.containers.restore(saved?.containers ?? [])
    this.containers.onFurnaceChanged = (x, y, z) => {
      const screen = this.screen
      if (screen?.kind === 'furnace' && screen.x === x && screen.y === y && screen.z === z) {
        this.ui.renderScreen()
      }
    }
    this.inventory.onChange = () => {
      this.interaction.inventoryChanged()
      this.ui.renderScreen()
    }
    this.drops.onPickup = () => {
      this.audio.pickup()
      this.ui.toast('Item picked up')
    }
    this.player.onStatsChanged = () => this.ui.updateSurvivalStats(this.player.health, this.player.hunger, this.player.air)
    this.player.onDamage = () => this.ui.showDamage()
    this.player.onDeath = () => this.respawnPlayer()
    this.ui.configureGame(this.atlas, this.sprites, this.mode, this.inventory)
    this.ui.buildHotbar(this.atlas, this.interaction.currentHotbar)
    this.ui.updateSurvivalStats(this.player.health, this.player.hunger, this.player.air)
    this.bindMouse()

    // Resume at the saved chunk, otherwise pick a scenic first spawn.
    const spawn = saved?.player ?? gen.findSpawn()
    const ccx = Math.floor(spawn.x / CHUNK_SIZE), ccz = Math.floor(spawn.z / CHUNK_SIZE)
    await this.world.pregen(ccx, ccz, (f) => {
      this.ui.setLoadProgress(f, saved
        ? (f < 0.6 ? 'Restoring terrain' : 'Rebuilding meshes')
        : (f < 0.6 ? 'Generating terrain' : 'Building meshes'))
    })

    if (saved) {
      this.player.teleport(
        saved.player.x,
        saved.player.y,
        saved.player.z,
        saved.player.yaw,
        saved.player.pitch
      )
      this.player.flying = this.mode === 'creative' && saved.player.flying
      if (this.mode === 'survival') {
        this.player.restoreSurvival(saved.player.health, saved.player.hunger, saved.player.air, saved.player.exhaustion)
      }
      this.drops.restore(saved.drops)
      this.interaction.setPage(saved.player.hotbarPage)
      this.interaction.setSelected(saved.player.selectedSlot)
      this.env.timeOfDay = ((saved.timeOfDay % 1) + 1) % 1
      this.weather.restore(saved.weather)
      this.setInspectionMode(saved.player.noclip)
    } else {
      // Land exactly on the terrain that actually generated.
      let sy = this.world.topSolidY(spawn.x, spawn.z)
      if (sy < 0 || sy < SEA_LEVEL - 1) sy = Math.max(SEA_LEVEL, this.world.gen.heightAt(spawn.x, spawn.z))
      this.player.teleport(spawn.x + 0.5, sy + 1.05, spawn.z + 0.5, spawn.yaw)
    }

    this.saveTimer = SAVE_INTERVAL_SEC
    this.state = 'ready'
    this.ui.showClickStart()
    if (saved) this.ui.toast('Saved world restored')
  }

  private requestPlay(): void {
    if (this.state !== 'ready' && this.state !== 'paused') return
    if (performance.now() < this.lockCooldown) {
      // browsers refuse pointer lock right after an unlock; retry shortly
      setTimeout(() => this.requestPlay(), Math.max(60, this.lockCooldown - performance.now()))
      return
    }
    const p = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // pointer lock unavailable (embedded browser etc.) — play without it
        this.enterPlaying()
      })
    }
    // if the lock succeeds, pointerlockchange flips us to playing
    setTimeout(() => {
      if (document.pointerLockElement !== this.renderer.domElement &&
        (this.state === 'ready' || this.state === 'paused')) {
        this.enterPlaying()
      }
    }, 350)
  }

  private enterPlaying(): void {
    this.state = 'playing'
    this.player.enabled = true
    this.ui.hidePause()
    this.ui.showGame()
  }

  private onPointerLockChange(): void {
    if (document.pointerLockElement === this.renderer.domElement) {
      this.enterPlaying()
    } else if (this.state === 'playing') {
      this.lockCooldown = performance.now() + 1300
      this.state = 'paused'
      this.player.enabled = false
      this.player.clearKeys()
      this.interaction.primaryUp()
      this.interaction.secondaryUp()
      this.ui.showPause()
      this.saveWorld()
    }
  }

  private quitToTitle(): void {
    if (this.saveWorld(true)) location.reload()
  }

  private saveWorld(showFailure = false): boolean {
    if (
      !this.saveStore ||
      (this.state !== 'ready' && this.state !== 'playing' && this.state !== 'paused' && this.state !== 'inventory')
    ) return true

    const ok = this.saveStore.save({
      player: {
        x: this.player.pos.x,
        y: this.player.pos.y,
        z: this.player.pos.z,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        flying: this.player.flying,
        noclip: this.player.noclip,
        hotbarPage: this.interaction.page,
        selectedSlot: this.interaction.selected,
        health: this.player.health,
        hunger: this.player.hunger,
        air: this.player.air,
        exhaustion: this.player.exhaustion
      },
      gameMode: this.mode,
      inventory: this.serializeInventoryForSave(),
      drops: this.drops.snapshot(),
      containers: this.containers.serialize(),
      timeOfDay: this.env.timeOfDay,
      weather: this.weather.snapshot(),
      blockEdits: this.world.serializeBlockEdits(),
      blockFacings: this.world.serializeBlockFacings()
    })

    if (ok) {
      this.world.markBlockEditsSaved()
      this.saveErrorShown = false
    } else if (showFailure || !this.saveErrorShown) {
      this.saveErrorShown = true
      this.ui.toast('Could not save world: browser storage is unavailable or full')
    }
    return ok
  }

  private bindMouse(): void {
    const dom = this.renderer.domElement
    dom.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing') return
      if (e.button === 0) this.interaction.primaryDown()
      if (e.button === 2) this.interaction.secondaryDown()
    })
    dom.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.interaction.primaryUp()
      if (e.button === 2) this.interaction.secondaryUp()
    })
    dom.addEventListener('wheel', (e) => {
      if (this.state !== 'playing') return
      e.preventDefault()
      this.interaction.scroll(e.deltaY)
    }, { passive: false })
  }

  private bindGameKeys(): void {
    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyE' && !e.repeat && this.mode === 'survival' &&
        (this.state === 'playing' || this.state === 'inventory')) {
        e.preventDefault()
        this.toggleInventory()
        return
      }
      if (e.code === 'Escape' && this.state === 'inventory') {
        e.preventDefault()
        this.toggleInventory()
        return
      }
      if (e.code === 'KeyO' && !e.repeat && this.mode === 'survival' &&
        (this.state === 'playing' || (this.state === 'inventory' && this.screen?.kind === 'admin'))) {
        e.preventDefault()
        this.toggleAdmin()
        return
      }
      if (this.state !== 'playing') return
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10)
        if (n >= 1 && n <= this.interaction.currentHotbar.length) this.interaction.setSelected(n - 1)
      }
      switch (e.code) {
        case 'KeyQ': {
          this.interaction.dropSelected()
          break
        }
        case 'KeyT': {
          this.env.timeScale = this.env.timeScale === 1 ? 40 : 1
          this.ui.toast(this.env.timeScale > 1 ? 'Time fast-forward ON' : 'Time fast-forward OFF')
          break
        }
        case 'KeyY': {
          const kind = this.weather.cycle()
          this.ui.toast('Weather: ' + kind)
          break
        }
        case 'KeyF': {
          const on = this.player.toggleFlashlight()
          this.ui.toast('Flashlight ' + (on ? 'ON' : 'OFF'))
          break
        }
        case 'KeyG': {
          if (this.mode !== 'creative') {
            this.ui.toast('Flight is only available in Creative; use X for inspection')
            break
          }
          const fly = this.player.toggleFly()
          this.ui.toast(fly ? 'Flight enabled' : 'Flight disabled')
          break
        }
        case 'KeyR': {
          if (e.repeat) break
          if (this.mode !== 'creative') break
          this.interaction.cyclePage()
          this.ui.toast(`Hotbar page ${this.interaction.page + 1}`)
          break
        }
        case 'KeyX': {
          if (e.repeat) break
          this.setInspectionMode(!this.player.noclip)
          this.ui.toast(this.player.noclip ? 'Ore inspection: noclip + xray ON' : 'Ore inspection OFF')
          break
        }
      }
    })
  }

  private applySettings(): void {
    if (!this.world) return
    this.audio.setVolume(this.settings.volume)
    this.player.headBobEnabled = this.settings.headBob
    const preset = this.settings.preset
    this.applyPixelRatio()
    this.env.setShadowMapSize(preset.shadowSize)
    this.world.grassDensity = preset.grassDensity
    if (this.world.renderDistance !== this.settings.renderDistance) {
      this.world.setRenderDistance(this.settings.renderDistance)
      this.env.setViewDistance(this.settings.renderDistance * CHUNK_SIZE)
    }
  }

  private setInspectionMode(enabled: boolean): void {
    this.player.setNoclip(enabled)
    this.materials.setXray(enabled)
    this.world.setXrayEnabled(enabled)
  }

  private toggleInventory(): void {
    if (this.mode !== 'survival') return
    if (this.state === 'playing') {
      this.openCraftScreen(2)
    } else if (this.state === 'inventory') {
      this.closeScreen()
      this.state = 'paused'
      this.requestPlay()
    }
  }

  /** Right click on a usable block: crafting table, furnace or chest. */
  private useBlock(hit: RayHit): void {
    if (hit.id === B.CRAFTING_TABLE) this.openCraftScreen(3)
    else if (hit.id === B.FURNACE || hit.id === B.FURNACE_LIT) this.openFurnace(hit.x, hit.y, hit.z)
    else if (hit.id === B.CHEST) this.openChest(hit.x, hit.y, hit.z)
  }

  private openScreen(screen: OpenScreen): void {
    if (this.mode !== 'survival' || this.state !== 'playing') return
    this.state = 'inventory'
    this.screen = screen
    this.player.enabled = false
    this.player.clearKeys()
    this.interaction.primaryUp()
    this.interaction.secondaryUp()
    this.ui.setScreen(screen)
    this.ui.showInventory(true)
    if (document.pointerLockElement) document.exitPointerLock()
    this.saveWorld()
  }

  /** Opens the personal 2x2 grid or a 3x3 crafting table screen. */
  private openCraftScreen(size: 2 | 3): void {
    this.openScreen({ kind: size === 3 ? 'workbench' : 'inventory', crafting: new Crafting(size) })
  }

  private openFurnace(x: number, y: number, z: number): void {
    const state = this.containers.furnaceAt(x, y, z)
    this.openScreen({ kind: 'furnace', holder: { cursor: null }, state, x, y, z })
  }

  private openChest(x: number, y: number, z: number): void {
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
    this.openScreen({ kind: 'chest', holder: { cursor: null }, slots, parts, double })
  }

  private closeScreen(): void {
    const screen = this.screen
    if (screen) {
      if (screen.kind === 'inventory' || screen.kind === 'workbench') {
        screen.crafting.returnAll(this.inventory, (stack) => this.spillStack(stack))
      } else if (screen.kind === 'chest' || screen.kind === 'furnace') {
        returnStacks([screen.holder.cursor], this.inventory, (stack) => this.spillStack(stack))
        screen.holder.cursor = null
      }
    }
    this.screen = null
    this.ui.setScreen(null)
    this.ui.showInventory(false)
  }

  private spillStack(stack: ItemStack): void {
    const p = this.player.pos
    this.drops.spawn(stack.id, p.x, p.y + 1.2, p.z, stack.count, { damage: stack.damage })
  }

  /** The cursor of whichever screen is open. */
  private activeHolder(): CursorHolder | null {
    const screen = this.screen
    if (!screen || screen.kind === 'admin') return null
    return screen.kind === 'inventory' || screen.kind === 'workbench' ? screen.crafting : screen.holder
  }

  private inventorySlotClick(slot: number, button: 0 | 2): void {
    const holder = this.activeHolder()
    if (this.state !== 'inventory' || !holder) return
    clickStackSlot(holder, this.inventory.slots, slot, button)
    this.inventory.notify()
  }

  private craftSlotClick(index: number, button: 0 | 2): void {
    const screen = this.screen
    if (this.state !== 'inventory' || !screen) return
    if (screen.kind !== 'inventory' && screen.kind !== 'workbench') return
    screen.crafting.clickSlot(screen.crafting.grid, index, button)
    this.ui.renderScreen()
  }

  private craftResultClick(): void {
    const screen = this.screen
    if (this.state !== 'inventory' || !screen) return
    if (screen.kind !== 'inventory' && screen.kind !== 'workbench') return
    if (screen.crafting.takeResult()) {
      this.audio.craft()
      this.ui.renderScreen()
    }
  }

  private containerSlotClick(index: number, button: 0 | 2): void {
    const screen = this.screen
    if (this.state !== 'inventory' || !screen) return
    if (screen.kind === 'chest') {
      clickStackSlot(screen.holder, screen.slots, index, button)
      if (screen.double) {
        screen.parts.forEach((part, half) => {
          for (let i = 0; i < CHEST_SLOTS; i++) part.slots[i] = screen.slots[half * CHEST_SLOTS + i]
        })
      }
    } else if (screen.kind === 'furnace') {
      if (index === FURNACE_OUTPUT) takeIntoCursor(screen.holder, screen.state.slots, index)
      else clickStackSlot(screen.holder, screen.state.slots, index, button)
    } else {
      return
    }
    this.ui.renderScreen()
  }

  /** Temporary admin screen: every item in the registry, click to receive. */
  private toggleAdmin(): void {
    if (this.mode !== 'survival') return
    if (this.state === 'playing') {
      this.openScreen({ kind: 'admin' })
    } else if (this.state === 'inventory' && this.screen?.kind === 'admin') {
      this.closeScreen()
      this.state = 'paused'
      this.requestPlay()
    }
  }

  private adminItemClick(id: number, button: 0 | 2): void {
    if (this.state !== 'inventory' || this.screen?.kind !== 'admin') return
    const item = ITEMS[id]
    if (!item) return
    const count = button === 2 ? item.stackSize : 1
    const left = this.inventory.add(id, count)
    if (left >= count) this.ui.toast('Inventory is full')
  }

  /** Recipe book click: lay the recipe out in the workbench grid from the inventory. */
  private recipeClick(index: number): void {
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
        const left = this.inventory.add(stack.id, stack.count, stack.damage)
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

  /** Spills the contents of a broken chest or furnace into the world. */
  private blockBroken(x: number, y: number, z: number, id: number): void {
    if (!isContainerBlock(id)) return
    const removed = this.containers.remove(x, y, z)
    if (!removed) return
    for (const stack of removed.slots) {
      if (stack) this.drops.spawn(stack.id, x + 0.5, y + 0.5, z + 0.5, stack.count, { damage: stack.damage })
    }
  }

  /** Inventory for the save file, including anything sitting in an open craft grid. */
  private serializeInventoryForSave(): SerializedInventory {
    const base = this.inventory.serialize()
    const screen = this.screen
    if (!screen || screen.kind === 'admin') return base
    const loose = screen.kind === 'inventory' || screen.kind === 'workbench'
      ? [...screen.crafting.grid, screen.crafting.cursor]
      : [screen.holder.cursor]
    for (const stack of loose) {
      if (!stack) continue
      const max = ITEMS[stack.id]?.stackSize ?? 1
      let left = stack.count
      if (max > 1 && stack.damage === undefined) {
        for (const slot of base) {
          if (left === 0) break
          if (!slot || slot.id !== stack.id || slot.damage !== undefined || slot.count >= max) continue
          const moved = Math.min(left, max - slot.count)
          slot.count += moved
          left -= moved
        }
      }
      for (let i = 0; i < base.length && left > 0; i++) {
        if (base[i]) continue
        const moved = Math.min(left, max)
        base[i] = cloneStack({ ...stack, count: moved })
        left -= moved
      }
    }
    return base
  }

  private respawnPlayer(): void {
    const x = Math.floor(this.player.pos.x)
    const z = Math.floor(this.player.pos.z)
    const top = this.world.topSolidY(x, z)
    this.player.teleport(x + 0.5, (top >= 0 ? top : SEA_LEVEL) + 1.05, z + 0.5, this.player.yaw)
    this.player.resetAfterDeath()
    this.ui.toast('You died — respawned with restored health and hunger')
  }

  private frame(): void {
    const frameStart = performance.now()
    const dt = clamp(this.clock.getDelta(), 0.0001, 0.05)
    U.uTime.value += dt

    if (this.state === 'title' || this.state === 'loading') return

    const playing = this.state === 'playing'
    if (playing) {
      this.player.update(dt)
      this.interaction.update(dt)
      this.drops.update(dt, this.player)
      this.saveTimer -= dt
      if (this.saveTimer <= 0) {
        this.saveTimer = SAVE_INTERVAL_SEC
        this.saveWorld()
      }
    }

    // furnaces keep smelting while a container screen is open
    if (playing || this.state === 'inventory') {
      this.containers.update(dt, this.world)
      const screen = this.screen
      if (screen?.kind === 'furnace') this.ui.updateFurnace(screen.state)
    }

    const p = this.player.pos
    this.world.update(p.x, p.z, playing ? 6 : 2)

    const biome = this.world.biomeAt(Math.floor(p.x), Math.floor(p.z))
    const cold = biome === BIOME.SNOW || p.y > 82
    this.weather.update(playing ? dt : 0, cold, this.audio)
    const w = this.weather.out

    const underwater = this.player.headUnderwater
    this.env.setWeather(w)
    this.env.update(playing ? dt : 0, this.camera, p, underwater, this.world.renderDistance * CHUNK_SIZE)
    // rain wetness: surfaces get darker and glossier
    this.materials.solid.roughness = 1 - w.wetness * 0.45
    this.materials.solid.color.setScalar(1 - w.wetness * 0.12)

    this.particles.update(dt, this.camera.position, w.rain, w.snow, U.uNight.value, underwater, w.wind)
    this.critters.update(dt, p, U.uNight.value, w.rain + w.snow)
    this.ui.setUnderwater(underwater)
    this.audio.setUnderwater(underwater)
    this.audio.updateAmbience(dt, {
      wind: w.wind,
      rain: w.rain,
      night: U.uNight.value,
      underwater,
      clear: this.weather.kind === 'clear'
    })

    // HUD + adaptive performance
    const fps = 1 / dt
    this.fpsEma = this.fpsEma * 0.95 + fps * 0.05
    this.hudTimer -= dt
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.25
      this.ui.updateSurvivalStats(this.player.health, this.player.hunger, this.player.air)
      this.ui.updateHud({
        fps: this.fpsEma,
        x: p.x, y: p.y, z: p.z,
        biome: BIOME_NAMES[biome] ?? '?',
        time: this.env.timeString(),
        weather: this.weather.displayName(cold),
        seed: this.seedStr,
        flying: this.player.flying,
        noclip: this.player.noclip
      })
    }
    if (playing) {
      if (this.fpsEma < 25) this.lowFpsTime += dt
      else this.lowFpsTime = 0
      if (this.lowFpsTime > 8 && this.world.renderDistance > 4) {
        this.lowFpsTime = 0
        this.world.setRenderDistance(this.world.renderDistance - 1)
        this.env.setViewDistance(this.world.renderDistance * CHUNK_SIZE)
        this.ui.toast('Performance: render distance reduced to ' + this.world.renderDistance)
      }
    }

    this.shadowUpdateTimer -= dt
    if (this.shadowUpdateTimer <= 0) {
      this.renderer.shadowMap.needsUpdate = true
      this.shadowUpdateTimer += 1 / 30
      if (this.perfEnabled) this.perfShadowUpdates++
    }

    this.renderer.render(this.scene, this.camera)

    if (this.perfEnabled) {
      const now = performance.now()
      const render = this.renderer.info.render
      this.perfCpuTotal += now - frameStart
      this.perfDrawCallsTotal += render.calls
      this.perfTrianglesTotal += render.triangles
      this.perfFrames++
      if (now >= this.perfNextReport) {
        console.info('[realmcraft:perf]', JSON.stringify({
          fps: Number(this.fpsEma.toFixed(1)),
          cpuFrameMs: Number((this.perfCpuTotal / this.perfFrames).toFixed(2)),
          avgDrawCalls: Math.round(this.perfDrawCallsTotal / this.perfFrames),
          avgTriangles: Math.round(this.perfTrianglesTotal / this.perfFrames),
          shadowUpdates: this.perfShadowUpdates,
          chunks: this.world.chunkCount(),
          moving: this.player.vel.lengthSq() > 0.04
        }))
        this.perfCpuTotal = 0
        this.perfDrawCallsTotal = 0
        this.perfTrianglesTotal = 0
        this.perfShadowUpdates = 0
        this.perfFrames = 0
        this.perfNextReport = now + 2000
      }
    }
  }
}
