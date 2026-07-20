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
import { Interaction } from '../player/Interaction'
import { Inventory, ItemStack, SerializedInventory, cloneStack } from '../player/Inventory'
import { Crafting, CursorHolder, clickStackSlot, returnStacks, takeIntoCursor } from '../player/Crafting'
import { ItemDrops } from '../world/ItemDrops'
import { ITEMS } from '../world/Items'
import { I } from '../world/ItemIds'
import { B, isBedBlock, isContainerBlock } from '../world/Blocks'
import {
  CHEST_SLOTS, ChestState, Containers, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, FurnaceState
} from '../world/Containers'
import { RECIPES, ingredientMatches, fuelSecondsFor, smeltResultFor } from '../world/Recipes'
import type { RayHit } from '../world/World'
import { ItemSprites } from '../gfx/ItemSprites'
import { VanillaHeldItems } from '../gfx/VanillaHeldItems'
import { Weather } from '../weather/Weather'
import { AudioMan } from '../audio/Audio'
import { Settings, QualityName, GameMode } from './Settings'
import { UI } from '../ui/UI'
import { clamp } from '../util/math'
import { WorldSaveStore } from './WorldSave'
import { EntityManager } from '../entities/EntityManager'
import { ProjectileManager } from '../entities/ProjectileManager'
import { Equipment } from '../player/Equipment'
import { ExperienceOrbs } from '../entities/ExperienceOrbs'
import { applyEnchantmentOffer, canEnchantItem, generateEnchantmentOffers, type EnchantingState } from '../player/Enchantments'
import { experienceAfterDeath } from '../player/Experience'
import { rollLoot } from '../world/Loot'
import { HOSTILE_KINDS, MOB_KINDS, VILLAGER_PROFESSIONS, type HostileKind, type MobKind, type VillagerProfession } from '../entities/EntityTypes'

type GameState = 'title' | 'loading' | 'ready' | 'playing' | 'paused' | 'inventory' | 'chat'
const SAVE_INTERVAL_SEC = 8

/** The container screen currently open over the game world. */
type OpenScreen =
  | { kind: 'inventory'; crafting: Crafting }
  | { kind: 'workbench'; crafting: Crafting }
  | { kind: 'chest'; holder: CursorHolder; slots: Array<ItemStack | null>; parts: ChestState[]; double: boolean }
  | { kind: 'furnace'; holder: CursorHolder; state: FurnaceState; x: number; y: number; z: number }
  | { kind: 'enchant'; holder: EnchantingState; x: number; y: number; z: number }
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
  private tntFx!: TntFx
  private critters!: Critters
  private world!: World
  private player!: Player
  private interaction!: Interaction
  private inventory = new Inventory()
  private drops!: ItemDrops
  private entities!: EntityManager
  private projectiles!: ProjectileManager
  private experienceOrbs!: ExperienceOrbs
  private equipment = new Equipment()
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
  private spawnerTimer = 1
  private initializedStructureChests = new Set<string>()
  private initializedVillageChunks = new Set<string>()
  private personalSpawn: { x: number; y: number; z: number } | null = null
  private worldSpawn = { x: 0, y: SEA_LEVEL + 1, z: 0 }

  private sprites: ItemSprites
  private lookDir = new THREE.Vector3()

  constructor(
    private container: HTMLElement,
    private ui: UI,
    private settings: Settings,
    atlas: Atlas,
    sprites: ItemSprites,
    private heldItems: VanillaHeldItems
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
    ui.onConsoleClose = (text) => this.closeConsole(text)
    ui.onInventorySlotClick = (slot, button) => this.inventorySlotClick(slot, button)
    ui.onArmorSlotClick = (slot, button) => this.armorSlotClick(slot, button)
    ui.onCraftSlotClick = (index, button) => this.craftSlotClick(index, button)
    ui.onCraftResultClick = () => this.craftResultClick()
    ui.onContainerSlotClick = (index, button) => this.containerSlotClick(index, button)
    ui.onEnchantSlotClick = (button) => this.enchantSlotClick(button)
    ui.onEnchantOfferClick = (index) => this.enchantOfferClick(index)
    ui.onRecipeClick = (index) => this.recipeClick(index)
    ui.onAdminItemClick = (id, button) => this.adminItemClick(id, button)
    ui.onOutsideInventoryClick = (button) => this.outsideInventoryClick(button)

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
    this.initializedStructureChests = new Set(saved?.structureChests ?? [])
    this.initializedVillageChunks = new Set(saved?.villageChunks ?? [])
    this.personalSpawn = saved?.player.respawnX !== undefined && saved.player.respawnY !== undefined && saved.player.respawnZ !== undefined
      ? { x: saved.player.respawnX, y: saved.player.respawnY, z: saved.player.respawnZ }
      : null
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
      saved?.blockFacings,
      saved?.scheduledTicks
    )
    this.env = new Environment(this.scene, preset.shadowSize, this.settings.renderDistance * CHUNK_SIZE)
    this.particles = new Particles(this.scene, preset.particleMult)
    this.tntFx = new TntFx(this.scene)
    this.critters = new Critters(this.scene)

    this.player = new Player(this.camera, this.world, this.audio, this.mode)
    this.player.headBobEnabled = this.settings.headBob
    this.player.attachInput(this.renderer.domElement)
    this.inventory.restore(saved?.inventory)
    this.equipment.restore(saved?.armor)
    this.drops = new ItemDrops(this.scene, this.world, this.atlas, this.sprites, this.inventory)
    this.experienceOrbs = new ExperienceOrbs(this.scene, this.world)
    this.entities = new EntityManager(this.world, this.scene, {
      drop: (id, x, y, z, count) => this.drops.spawn(id, x, y, z, count),
      sound: (kind, event) => this.audio.mob(kind, event),
      damagePlayer: (amount, sourceX, sourceZ, knockback) => {
        const hit = this.player.damage(amount)
        if (hit) this.player.knockback(sourceX, sourceZ, knockback)
        return hit
      },
      shootProjectile: (x, y, z, tx, ty, tz, damage) =>
        this.projectiles.shootAt(x, y, z, tx, ty, tz, damage),
      explosion: (x, y, z) => {
        this.particles.burst(x, y, z, [0.45, 0.42, 0.38], 40) // dark debris
        this.particles.burst(x, y, z, [0.82, 0.80, 0.76], 26) // light smoke puff
        this.particles.burst(x, y, z, [1.0, 0.6, 0.2], 12)    // fireball flecks
        this.audio.explosion()
      },
      blockExploded: (x, y, z, id) => {
        this.interaction?.dropExplodedBlock(x, y, z, id)
        this.blockBroken(x, y, z, id)
      },
      experience: (x, y, z, amount) => this.experienceOrbs.spawn(x, y, z, amount)
    })
    this.projectiles = new ProjectileManager(this.world, this.entities, this.scene, {
      damagePlayer: (amount, sourceX, sourceZ, knockback) => {
        const hit = this.player.damage(amount)
        if (hit) this.player.knockback(sourceX, sourceZ, knockback)
        return hit
      },
      pickupArrow: () => {
        if (this.mode !== 'survival') return true
        const accepted = this.inventory.add(I.ARROW, 1) === 0
        if (accepted) this.audio.pickup()
        return accepted
      }
    })
    this.interaction = new Interaction(
      this.world, this.player, this.camera, this.scene, this.atlas, this.sprites, this.heldItems, this.audio, this.particles,
      this.mode, this.inventory, this.drops, this.entities, this.projectiles
    )
    this.interaction.onSelectionChanged = (i) => this.ui.setSelectedSlot(i)
    this.interaction.onPageChanged = (_page, blocks) => this.ui.buildHotbar(this.atlas, blocks)
    this.interaction.onUseBlock = (hit) => this.useBlock(hit)
    this.interaction.onUseMap = () => this.useMap()
    this.interaction.onUseNavigation = (id) => this.useNavigationItem(id)
    this.interaction.onBlockBroken = (x, y, z, id) => this.blockBroken(x, y, z, id)
    this.interaction.onExperience = (x, y, z, amount) => this.experienceOrbs.spawn(x, y, z, amount)
    this.world.onAutomaticBlockBreak = (x, y, z, id) => this.interaction.dropAutomaticBlock(x, y, z, id)
    this.world.onTntPrimed = (x, y, z) => this.tntFx.add(x, y, z)
    this.world.onTntExplode = (x, y, z, radius) => {
      this.tntFx.remove(Math.floor(x), Math.floor(y), Math.floor(z))
      this.entities.explode(x, y, z, radius, this.player.pos)
    }
    this.containers.restore(saved?.containers ?? [])
    this.entities.restore(saved?.entities ?? [])
    this.world.onChunkGenerated = (cx, cz) => this.initializeGeneratedChunk(cx, cz)
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
    const syncEquipmentStats = () => {
      this.player.armorPoints = this.equipment.armorPoints
      this.player.protectionLevels = this.equipment.protectionLevels
      this.player.featherFallingLevel = this.equipment.featherFallingLevel
      this.player.respirationLevel = this.equipment.respirationLevel
      this.player.aquaAffinity = this.equipment.aquaAffinity
    }
    this.equipment.onChange = () => {
      syncEquipmentStats()
      this.ui.renderScreen()
    }
    syncEquipmentStats()
    this.player.onArmorDamaged = () => this.equipment.damageAll(1)
    this.drops.onPickup = () => {
      this.audio.pickup()
      this.ui.toast('Item picked up')
    }
    this.experienceOrbs.onPickup = () => this.audio.experience()
    this.player.onStatsChanged = () => this.ui.updateSurvivalStats(this.player.health, this.player.hunger, this.player.air, this.equipment.armorPoints)
    this.player.onDamage = () => this.ui.showDamage()
    this.player.onDeath = () => this.respawnPlayer()
    this.player.onExperienceChanged = () => this.ui.updateExperience(this.player.experienceLevel, this.player.experienceFraction)
    this.ui.configureGame(this.atlas, this.sprites, this.mode, this.inventory, this.equipment)
    this.ui.buildHotbar(this.atlas, this.interaction.currentHotbar)
    this.ui.updateSurvivalStats(this.player.health, this.player.hunger, this.player.air, this.equipment.armorPoints)
    this.ui.updateExperience(this.player.experienceLevel, this.player.experienceFraction)
    this.bindMouse()

    // Resume at the saved chunk, otherwise pick a scenic first spawn.
    const naturalSpawn = gen.findSpawn()
    this.worldSpawn = {
      x: naturalSpawn.x + 0.5,
      y: Math.max(SEA_LEVEL, gen.heightAt(naturalSpawn.x, naturalSpawn.z)) + 1.05,
      z: naturalSpawn.z + 0.5
    }
    const spawn = saved?.player ?? naturalSpawn
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
        this.player.restoreSurvival(
          saved.player.health,
          saved.player.hunger,
          saved.player.saturation,
          saved.player.air,
          saved.player.exhaustion,
          saved.player.experience
        )
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
        saturation: this.player.saturation,
        air: this.player.air,
        exhaustion: this.player.exhaustion,
        experience: this.player.experienceTotal,
        ...(this.personalSpawn ? {
          respawnX: this.personalSpawn.x, respawnY: this.personalSpawn.y, respawnZ: this.personalSpawn.z
        } : {})
      },
      gameMode: this.mode,
      inventory: this.serializeInventoryForSave(),
      armor: this.equipment.serialize(),
      drops: this.drops.snapshot(),
      containers: this.containers.serialize(),
      timeOfDay: this.env.timeOfDay,
      weather: this.weather.snapshot(),
      blockEdits: this.world.serializeBlockEdits(),
      blockFacings: this.world.serializeBlockFacings(),
      scheduledTicks: this.world.serializeScheduledTicks(),
      entities: this.entities.serialize(),
      structureChests: [...this.initializedStructureChests],
      villageChunks: [...this.initializedVillageChunks]
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
      // While the console is open its input owns the keyboard.
      if (this.state === 'chat') return
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
      if (e.code === 'Slash' && !e.repeat) {
        e.preventDefault()
        this.openConsole()
        return
      }
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10)
        if (n >= 1 && n <= this.interaction.currentHotbar.length) this.interaction.setSelected(n - 1)
      }
      switch (e.code) {
        case 'KeyQ': {
          if (e.repeat) break
          e.preventDefault()
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

  /** Opens the developer command console, freeing the mouse like a container screen. */
  private openConsole(): void {
    if (this.state !== 'playing') return
    this.state = 'chat'
    this.player.enabled = false
    this.player.clearKeys()
    this.interaction.primaryUp()
    this.interaction.secondaryUp()
    // state is already 'chat', so releasing the pointer will not trigger the pause menu
    if (document.pointerLockElement) document.exitPointerLock()
    this.ui.openConsole('/')
  }

  private closeConsole(text: string | null): void {
    if (this.state !== 'chat') return
    if (text) this.runCommand(text)
    this.state = 'paused'
    this.requestPlay()
  }

  /** Minimal slash-command interpreter for testing (spawning creatures, etc.). */
  private runCommand(raw: string): void {
    const echo = raw.startsWith('/') ? raw : '/' + raw
    this.ui.consolePrint(echo)
    const parts = raw.replace(/^\//, '').trim().split(/\s+/).filter(Boolean)
    const name = (parts[0] ?? '').toLowerCase()
    const args = parts.slice(1)
    if (name === '' ) return
    if (name === 'help') { this.commandHelp(); return }
    if (name === 'spawn') { this.commandSpawn(args); return }
    this.ui.consolePrint(`Unknown command: ${name}. Try /help`, 'err')
  }

  private commandHelp(): void {
    this.ui.consolePrint('/spawn <creature> [count] [baby] [profession] — spawn near you', 'info')
    this.ui.consolePrint('/spawn all — one of every creature', 'info')
    this.ui.consolePrint('creatures: ' + MOB_KINDS.join(', '), 'info')
  }

  private commandSpawn(args: string[]): void {
    const target = (args[0] ?? '').toLowerCase()
    if (!target) { this.ui.consolePrint('Usage: /spawn <creature> [count]', 'err'); return }
    const flags = args.slice(1).map(a => a.toLowerCase())
    const baby = flags.includes('baby')
    const count = Math.max(1, Math.min(50, parseInt(flags.find(f => /^\d+$/.test(f)) ?? '1', 10) || 1))
    const profession = VILLAGER_PROFESSIONS.find(p => flags.includes(p))

    const kinds: MobKind[] = target === 'all'
      ? [...MOB_KINDS]
      : MOB_KINDS.includes(target as MobKind) ? [target as MobKind] : []
    if (kinds.length === 0) {
      this.ui.consolePrint(`No such creature "${target}". /help lists them.`, 'err')
      return
    }

    let spawned = 0
    for (const kind of kinds) {
      const per = target === 'all' ? 1 : count
      for (let i = 0; i < per; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = 2 + Math.random() * 2
        const x = this.player.pos.x + Math.cos(angle) * dist
        const z = this.player.pos.z + Math.sin(angle) * dist
        const y = this.world.topSolidY(Math.floor(x), Math.floor(z)) + 1
        const entity = this.entities.spawn(kind, x, y, z, {
          bypassMobCap: true, persistent: true, baby,
          ...(profession ? { profession } : {})
        })
        if (entity) spawned++
      }
    }
    const label = target === 'all' ? `${spawned} creatures` : `${spawned}× ${target}`
    this.ui.consolePrint(`Spawned ${label}${baby ? ' (baby)' : ''}.`, spawned > 0 ? 'ok' : 'err')
  }

  /** Right click on a usable block: crafting table, furnace or chest. */
  private useBlock(hit: RayHit): void {
    if (hit.id === B.CRAFTING_TABLE) this.openCraftScreen(3)
    else if (hit.id === B.FURNACE || hit.id === B.FURNACE_LIT) this.openFurnace(hit.x, hit.y, hit.z)
    else if (hit.id === B.CHEST) this.openChest(hit.x, hit.y, hit.z)
    else if (hit.id === B.ENCHANTING_TABLE) this.openEnchanting(hit.x, hit.y, hit.z)
    else if (isBedBlock(hit.id)) this.useBed(hit)
  }

  /** Attaches deterministic loot and persistent villagers to freshly generated structure chunks. */
  private initializeGeneratedChunk(cx: number, cz: number): void {
    for (const chest of this.world.gen.structureChestsIn(cx, cz)) {
      const key = `${chest.x},${chest.y},${chest.z}`
      if (this.initializedStructureChests.has(key)) continue
      this.initializedStructureChests.add(key)
      if (this.world.getBlock(chest.x, chest.y, chest.z) !== B.CHEST) continue
      const state = this.containers.chestAt(chest.x, chest.y, chest.z)
      if (state.slots.some(Boolean)) continue
      for (const stack of rollLoot(chest.loot, chest.x, chest.y, chest.z, this.world.gen.seedNum)) {
        state.slots[stack.slot] = { id: stack.id, count: stack.count }
      }
    }

    const chunkKey = `${cx},${cz}`
    if (this.initializedVillageChunks.has(chunkKey)) return
    this.initializedVillageChunks.add(chunkKey)
    const spots = this.world.gen.villagerSpawnsIn(cx, cz)
    for (let index = 0; index < spots.length; index++) {
      const spot = spots[index]
      let y = spot.y
      for (let lift = 0; lift < 4 && (this.world.isSolid(spot.x, y, spot.z) || this.world.isSolid(spot.x, y + 1, spot.z)); lift++) y++
      const profession = this.villagerProfessionAt(spot.x, spot.z)
      this.entities.spawn('villager', spot.x + 0.5, y + 0.01, spot.z + 0.5, {
        persistent: true,
        bypassMobCap: true,
        id: `villager-${cx}-${cz}-${index}`,
        profession,
        homeX: spot.x + 0.5,
        homeZ: spot.z + 0.5
      })
    }
  }

  private villagerProfessionAt(x: number, z: number): VillagerProfession {
    const hash = (Math.imul(x, 0x1f123bb5) ^ Math.imul(z, 0x5f356495) ^ this.world.gen.seedNum) >>> 0
    return VILLAGER_PROFESSIONS[hash % VILLAGER_PROFESSIONS.length]
  }

  private useBed(hit: RayHit): void {
    const facing = this.world.getBlockFacing(hit.x, hit.y, hit.z)
    const dx = facing === 0 ? 1 : facing === 1 ? -1 : 0
    const dz = facing === 4 ? 1 : facing === 5 ? -1 : 0
    const head = hit.id === B.BED_HEAD
      ? { x: hit.x, y: hit.y, z: hit.z }
      : { x: hit.x + dx, y: hit.y, z: hit.z + dz }
    if (this.world.getBlock(head.x, head.y, head.z) !== B.BED_HEAD) {
      this.ui.toast('This bed is incomplete')
      return
    }
    const night = this.env.timeOfDay < 0.23 || this.env.timeOfDay > 0.77
    if (!night) {
      this.ui.toast('You can sleep only at night')
      return
    }
    const hostile = this.entities.queryRadius(this.player.pos.x, this.player.pos.y, this.player.pos.z, 8)
      .some(entity => HOSTILE_KINDS.includes(entity.kind as HostileKind))
    if (hostile) {
      this.ui.toast('You may not rest now; monsters are nearby')
      return
    }
    this.personalSpawn = head
    this.env.timeOfDay = 0.25
    this.ui.toast('Slept until morning; respawn point set')
    this.saveWorld()
  }

  private safeSpawnByBed(bed: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
    if (this.world.getBlock(bed.x, bed.y, bed.z) !== B.BED_HEAD) return null
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const
    for (const [dx, dz] of offsets) {
      const x = bed.x + dx, z = bed.z + dz, y = bed.y
      if (this.world.isSolid(x, y - 1, z) && !this.world.isSolid(x, y, z) && !this.world.isSolid(x, y + 1, z)) {
        return { x: x + 0.5, y: y + 0.05, z: z + 0.5 }
      }
    }
    return null
  }

  private useNavigationItem(itemId: number): void {
    if (itemId === I.CLOCK) {
      this.ui.toast(`Clock: ${this.env.timeString()} (${this.env.isNight() ? 'night' : 'day'})`)
      return
    }
    const target = this.personalSpawn ?? this.worldSpawn
    const dx = target.x - this.player.pos.x, dz = target.z - this.player.pos.z
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    const angle = Math.atan2(dx, -dz)
    const direction = directions[(Math.round(angle / (Math.PI / 4)) + 8) % 8]
    this.ui.toast(`Compass: ${direction}, ${Math.round(Math.hypot(dx, dz))} blocks to ${this.personalSpawn ? 'bed' : 'spawn'}`)
  }

  private useMap(): void {
    const size = 96, scale = 2
    const centerX = Math.floor(this.player.pos.x), centerZ = Math.floor(this.player.pos.z)
    const pixels = new Uint8ClampedArray(size * size * 4)
    const palette: Array<readonly [number, number, number]> = [
      [48, 85, 142], [210, 196, 132], [101, 159, 73], [63, 122, 54],
      [218, 199, 125], [112, 112, 104], [224, 232, 235], [65, 111, 160],
      [74, 112, 78], [72, 103, 61], [48, 132, 42], [126, 108, 132]
    ]
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      const wx = centerX + (px - size / 2) * scale
      const wz = centerZ + (py - size / 2) * scale
      const info = this.world.gen.columnInfo(wx, wz)
      const color = palette[info.biome] ?? palette[2]
      const shade = clamp(0.75 + (info.height - SEA_LEVEL) * 0.012, 0.62, 1.2)
      const offset = (py * size + px) * 4
      pixels[offset] = Math.min(255, color[0] * shade)
      pixels[offset + 1] = Math.min(255, color[1] * shade)
      pixels[offset + 2] = Math.min(255, color[2] * shade)
      pixels[offset + 3] = 255
    }
    const spawnPx = Math.round(size / 2 + (this.worldSpawn.x - centerX) / scale)
    const spawnPy = Math.round(size / 2 + (this.worldSpawn.z - centerZ) / scale)
    this.ui.showMap(pixels, size, centerX, centerZ, spawnPx, spawnPy)
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
    this.audio.chestOpen()
    this.openScreen({ kind: 'chest', holder: { cursor: null }, slots, parts, double })
  }

  private openEnchanting(x: number, y: number, z: number): void {
    const holder: EnchantingState = {
      cursor: null,
      slots: [null],
      offers: [],
      bookshelfPower: this.bookshelfPower(x, y, z),
      seed: (Math.random() * 0x7fffffff) | 0
    }
    this.openScreen({ kind: 'enchant', holder, x, y, z })
  }

  private bookshelfPower(x: number, y: number, z: number): number {
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

  private refreshEnchantOffers(state: EnchantingState): void {
    const stack = state.slots[0]
    state.offers = stack && !stack.enchantments?.length
      ? generateEnchantmentOffers(stack.id, state.bookshelfPower, state.seed)
      : []
  }

  private closeScreen(): void {
    const screen = this.screen
    if (screen) {
      if (screen.kind === 'inventory' || screen.kind === 'workbench') {
        screen.crafting.returnAll(this.inventory, (stack) => this.spillStack(stack))
      } else if (screen.kind === 'chest' || screen.kind === 'furnace' || screen.kind === 'enchant') {
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

  private spillStack(stack: ItemStack): void {
    const p = this.player.pos
    this.drops.spawn(stack.id, p.x, p.y + 1.2, p.z, stack.count, {
      damage: stack.damage,
      enchantments: stack.enchantments
    })
  }

  /** The cursor of whichever screen is open. */
  private activeHolder(): CursorHolder | null {
    const screen = this.screen
    if (!screen || screen.kind === 'admin') return null
    return screen.kind === 'inventory' || screen.kind === 'workbench' ? screen.crafting : screen.holder
  }

  private inventorySlotClick(slot: number, button: 0 | 2, shift = false): void {
    const holder = this.activeHolder()
    if (this.state !== 'inventory' || !holder) return
    if (shift && this.shiftInventoryStack(slot)) return
    clickStackSlot(holder, this.inventory.slots, slot, button)
    this.inventory.notify()
  }

  private armorSlotClick(slot: number, button: 0 | 2, shift = false): void {
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
    clickStackSlot(holder, this.equipment.slots, slot, button)
    this.equipment.onChange()
  }

  private craftSlotClick(index: number, button: 0 | 2, _shift = false): void {
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

  private containerSlotClick(index: number, button: 0 | 2, shift = false): void {
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

  private shiftInventoryStack(slot: number): boolean {
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

  private moveStackToSlots(stack: ItemStack, slots: Array<ItemStack | null>, onlyIndex?: number, endIndex?: number): void {
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

  private outsideInventoryClick(button: 0 | 2): void {
    const holder = this.activeHolder()
    if (this.state !== 'inventory' || !holder?.cursor) return
    const stack = holder.cursor
    const count = button === 2 ? 1 : stack.count
    this.spillStack(cloneStack({ ...stack, count }))
    stack.count -= count
    if (stack.count <= 0) holder.cursor = null
    this.ui.renderScreen()
  }

  private enchantSlotClick(button: 0 | 2): void {
    const screen = this.screen
    if (this.state !== 'inventory' || screen?.kind !== 'enchant') return
    const holder = screen.holder
    if (!holder.slots[0] && holder.cursor && (!canEnchantItem(holder.cursor.id) || holder.cursor.enchantments?.length)) return
    clickStackSlot(holder, holder.slots, 0, button)
    this.refreshEnchantOffers(holder)
    this.ui.renderScreen()
  }

  private enchantOfferClick(index: number): void {
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

  /** Spills the contents of a broken chest or furnace into the world. */
  private blockBroken(x: number, y: number, z: number, id: number): void {
    if (!isContainerBlock(id)) return
    const removed = this.containers.remove(x, y, z)
    if (!removed) return
    for (const stack of removed.slots) {
      if (stack) this.drops.spawn(stack.id, x + 0.5, y + 0.5, z + 0.5, stack.count, {
        damage: stack.damage,
        enchantments: stack.enchantments
      })
    }
  }

  /** Inventory for the save file, including anything sitting in an open craft grid. */
  private serializeInventoryForSave(): SerializedInventory {
    const base = this.inventory.serialize()
    const screen = this.screen
    if (!screen || screen.kind === 'admin') return base
    const loose = screen.kind === 'inventory' || screen.kind === 'workbench'
      ? [...screen.crafting.grid, screen.crafting.cursor]
      : screen.kind === 'enchant'
        ? [...screen.holder.slots, screen.holder.cursor]
        : [screen.holder.cursor]
    for (const stack of loose) {
      if (!stack) continue
      const max = ITEMS[stack.id]?.stackSize ?? 1
      let left = stack.count
      if (max > 1 && stack.damage === undefined && !stack.enchantments?.length) {
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
    const deathX = this.player.pos.x, deathY = this.player.pos.y, deathZ = this.player.pos.z
    const deathXp = experienceAfterDeath(this.player.experienceTotal)
    this.player.setExperience(deathXp.retained)
    this.experienceOrbs.spawn(deathX, deathY + 0.5, deathZ, deathXp.dropped)
    for (const stack of this.inventory.serialize()) {
      if (stack) this.drops.spawn(stack.id, deathX, deathY + 0.8, deathZ, stack.count, {
        damage: stack.damage, enchantments: stack.enchantments
      })
    }
    for (const stack of this.equipment.serialize()) {
      if (stack) this.drops.spawn(stack.id, deathX, deathY + 0.8, deathZ, stack.count, {
        damage: stack.damage, enchantments: stack.enchantments
      })
    }
    this.inventory.clear()
    this.equipment.restore([])
    const bedSpawn = this.personalSpawn ? this.safeSpawnByBed(this.personalSpawn) : null
    if (this.personalSpawn && !bedSpawn) this.personalSpawn = null
    const target = bedSpawn ?? this.worldSpawn
    this.player.teleport(target.x, target.y, target.z, 0)
    this.player.resetAfterDeath()
    this.ui.toast(bedSpawn ? 'You died — respawned beside your bed' : 'You died — items dropped at the death point')
  }

  /** Activates dungeon and stronghold spawners only while the player is nearby. */
  private tickStructureSpawners(dt: number): void {
    this.spawnerTimer -= dt
    if (this.spawnerTimer > 0) return
    this.spawnerTimer = 2.5 + Math.random() * 2
    const p = this.player.pos
    for (const spawner of this.world.gen.structureSpawnersNear(p.x, p.z, 20)) {
      if (this.world.getBlock(spawner.x, spawner.y, spawner.z) !== B.SPAWNER) continue
      const distance = Math.hypot(spawner.x + 0.5 - p.x, spawner.y + 0.5 - p.y, spawner.z + 0.5 - p.z)
      if (distance > 16 || distance < 4) continue
      const local = this.entities.queryRadius(spawner.x + 0.5, spawner.y, spawner.z + 0.5, 8)
        .filter(entity => entity.kind === spawner.mob).length
      if (local >= 6) continue
      for (let attempt = 0; attempt < 6; attempt++) {
        const x = spawner.x + Math.floor(Math.random() * 7) - 3
        const z = spawner.z + Math.floor(Math.random() * 7) - 3
        const y = spawner.y
        if (!this.world.isSolid(x, y - 1, z) || this.world.isSolid(x, y, z) || this.world.isSolid(x, y + 1, z)) continue
        this.entities.spawn(spawner.mob, x + 0.5, y + 0.01, z + 0.5)
        break
      }
    }
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
      this.experienceOrbs.update(dt, this.player)
      this.tickStructureSpawners(dt)
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
    this.world.tickSimulation(playing || this.state === 'inventory' ? dt : 0, p.x, p.z)
    this.entities.update(playing ? dt : 0, {
      player: p,
      heldItem: this.interaction.selectedItem?.id ?? null,
      look: this.camera.getWorldDirection(this.lookDir),
      skyDarkness: U.uNight.value * 15
    })
    this.projectiles.update(playing ? dt : 0, p)

    const biome = this.world.biomeAt(Math.floor(p.x), Math.floor(p.z))
    const cold = biome === BIOME.SNOW || p.y > 82
    const dry = biome === BIOME.DESERT
    this.weather.update(playing ? dt : 0, cold, this.audio, dry)
    const w = this.weather.out

    const underwater = this.player.headUnderwater
    this.env.setWeather(w)
    this.env.update(playing ? dt : 0, this.camera, p, underwater, this.world.renderDistance * CHUNK_SIZE)
    // rain wetness: surfaces get darker and glossier
    this.materials.solid.roughness = 1 - w.wetness * 0.45
    this.materials.solid.color.setScalar(1 - w.wetness * 0.12)

    this.particles.update(dt, this.camera.position, w.rain, w.snow, U.uNight.value, underwater, w.wind)
    this.tntFx.update(playing ? dt : 0)
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
      this.ui.updateSurvivalStats(this.player.health, this.player.hunger, this.player.air, this.equipment.armorPoints)
      this.ui.updateHud({
        fps: this.fpsEma,
        x: p.x, y: p.y, z: p.z,
        biome: BIOME_NAMES[biome] ?? '?',
        time: this.env.timeString(),
        weather: this.weather.displayName(cold, dry),
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
