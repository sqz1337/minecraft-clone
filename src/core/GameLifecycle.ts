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

export function installGameLifecycle(GameClass: GameConstructor): void {
  const prototype = GameClass.prototype
  prototype.applyPixelRatio = function(this: Game): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.settings.preset.pixelRatioCap))
  }
  prototype.onResize = function(this: Game): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }
  prototype.startWorld = async function(this: Game, worldSummary: WorldSummary): Promise<void> {
    if (this.state !== 'title') return
    this.settings.lastGameMode = worldSummary.gameMode
    this.settings.save()
    this.mode = worldSummary.gameMode
    this.audio.init()
    this.audio.setVolumes(this.settings.soundVolume, this.settings.musicVolume)

    this.seedStr = worldSummary.seed
    this.settings.lastSeed = this.seedStr
    this.settings.save()
    this.state = 'loading'
    this.ui.showLoading()
    this.saveStore = new WorldSaveStore(this.seedStr, worldSummary.id, worldSummary)
    const saved = await this.saveStore.loadAsync()
    if (saved) this.mode = saved.gameMode
    this.silentHill = worldSummary.silentHill || saved?.silentHill === true
    this.worldAudioStarted = false
    this.initializedStructureChests = new Set(saved?.structureChests ?? [])
    this.initializedVillageChunks = new Set(saved?.villageChunks ?? [])
    this.initializedVillageDoorChunks = new Set(saved?.villageDoorChunks ?? [])
    this.initializedAnimalChunks = new Set(saved?.animalChunks ?? [])
    this.personalSpawn = saved?.player.respawnX !== undefined && saved.player.respawnY !== undefined && saved.player.respawnZ !== undefined
      ? { x: saved.player.respawnX, y: saved.player.respawnY, z: saved.player.respawnZ }
      : null
    const preset = this.settings.preset
    this.applyPixelRatio()

    const gen = new WorldGen(this.seedStr, saved?.worldGenVersion)
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
    this.audio.setOcclusionProbe((listener, source) => {
      this.audioRayOrigin.set(listener.x, listener.y, listener.z)
      this.audioRayDir.set(source.x - listener.x, source.y - listener.y, source.z - listener.z)
      const distance = this.audioRayDir.length()
      if (distance <= 1) return false
      this.audioRayDir.multiplyScalar(1 / distance)
      // Stop before the source cell so a block's own collision shape is not
      // mistaken for a wall between the block and the player.
      return this.world.raycast(this.audioRayOrigin, this.audioRayDir, Math.max(0, distance - 0.65)) !== null
    })
    this.env = new Environment(this.scene, preset.shadowSize, this.settings.renderDistance * CHUNK_SIZE)
    this.env.setSilentHill(this.silentHill)
    this.env.setShadowsEnabled(preset.shadows)
    // The held-item view-model pass renders only VIEWMODEL_LAYER; let the scene
    // lights reach that layer too so a block held in hand is still lit.
    for (const light of [this.env.sun, this.env.hemi, this.env.ambient]) light.layers.enable(VIEWMODEL_LAYER)
    this.particles = new Particles(this.scene, preset.particleMult)
    this.tntFx = new TntFx(this.scene)
    this.critters = new Critters(this.scene)

    this.player = new Player(this.camera, this.world, this.audio, this.mode, this.settings)
    this.playerRenderer = new PlayerRenderer(this.scene, this.camera)
    this.player.headBobEnabled = this.settings.headBob
    this.player.attachInput(this.renderer.domElement)
    void desktopCursor.listen((x, y) => this.player.applyNativeMouseDelta(x, y))
    this.inventory.restore(saved?.inventory)
    this.equipment.restore(saved?.armor)
    this.drops = new ItemDrops(this.scene, this.world, this.atlas, this.sprites, this.inventory)
    this.experienceOrbs = new ExperienceOrbs(this.scene, this.world)
    this.entities = new EntityManager(this.world, this.scene, {
      drop: (id, x, y, z, count) => this.drops.spawn(id, x, y, z, count),
      sound: (kind, event, x, y, z, volume) => this.audio.mob(kind, event, volume, { x, y, z }),
      damagePlayer: (amount, sourceX, sourceZ, knockback) => {
        const hit = this.player.damage(amount)
        if (hit) this.player.knockback(sourceX, sourceZ, knockback)
        return hit
      },
      shootProjectile: (x, y, z, tx, ty, tz, damage, shooterId) => {
        this.audio.mobBowShoot({ x, y, z })
        this.projectiles.shootAt(x, y, z, tx, ty, tz, damage, shooterId)
      },
      explosion: (x, y, z) => {
        this.particles.burst(x, y, z, [0.45, 0.42, 0.38], 40) // dark debris
        this.particles.burst(x, y, z, [0.82, 0.80, 0.76], 26) // light smoke puff
        this.particles.burst(x, y, z, [1.0, 0.6, 0.2], 12)    // fireball flecks
        this.audio.explosion({ x, y, z })
      },
      blockExploded: (x, y, z, id) => {
        this.interaction?.dropExplodedBlock(x, y, z, id)
        this.blockBroken(x, y, z, id)
      },
      experience: (x, y, z, amount) => this.experienceOrbs.spawn(x, y, z, amount),
      effect: (event, x, y, z, targetX, targetY, targetZ) => {
        if (event === 'enderman_ambient') {
          this.particles.burst(x, y, z, [0.58, 0.08, 0.82], 2)
        } else if (event === 'enderman_teleport') {
          this.particles.burst(x, y, z, [0.58, 0.08, 0.82], 34)
          this.audio.endermanTeleport({ x, y, z })
          if (targetX !== undefined && targetY !== undefined && targetZ !== undefined) {
            this.particles.burst(targetX, targetY, targetZ, [0.72, 0.18, 0.96], 34)
            this.audio.endermanTeleport({ x: targetX, y: targetY, z: targetZ })
          }
        } else if (event === 'love') {
          this.particles.burst(x, y, z, [1, 0.18, 0.42], 9)
        } else if (event === 'death') {
          this.particles.burst(x, y, z, [0.82, 0.82, 0.82], 18)
        } else if (event === 'slime_split') {
          this.particles.burst(x, y, z, [0.25, 0.82, 0.2], 24)
        } else if (event === 'shear') {
          this.particles.burst(x, y, z, [0.9, 0.88, 0.84], 14)
        } else if (event === 'construct') {
          this.particles.burst(x, y, z, [0.92, 0.96, 1], 32)
        } else if (event === 'golem_attack') {
          this.audio.ironGolemAttack()
        }
      }
    }, this.atlas)
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
    this.interaction.onUseVillager = (entityId) => this.openTrading(entityId)
    this.interaction.onExperience = (x, y, z, amount) => this.experienceOrbs.spawn(x, y, z, amount)
    this.world.onAutomaticBlockBreak = (x, y, z, id) => this.interaction.dropAutomaticBlock(x, y, z, id)
    this.world.onTntPrimed = (x, y, z) => this.tntFx.add(x, y, z)
    this.world.onTntExplode = (x, y, z, radius) => {
      this.tntFx.remove(Math.floor(x), Math.floor(y), Math.floor(z))
      this.entities.explode(x, y, z, radius, this.player.pos)
    }
    this.containers.restore(saved?.containers ?? [])
    const generatedDuringLoad: Array<readonly [number, number]> = []
    this.world.onChunkGenerated = (cx, cz) => { generatedDuringLoad.push([cx, cz]) }
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
    this.player.onDeath = () => this.handlePlayerDeath()
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
      y: Math.max(gen.seaLevel, gen.heightAt(naturalSpawn.x, naturalSpawn.z)) + 1.05,
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
      for (const entity of saved.entities) this.world.ensureGeneratedAt(entity.x, entity.z, 2)
      this.entities.restore(saved.entities)
    }
    for (const [cx, cz] of generatedDuringLoad) this.initializeGeneratedChunk(cx, cz)
    this.world.onChunkGenerated = (cx, cz) => this.initializeGeneratedChunk(cx, cz)

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
      if (sy < 0 || sy < gen.seaLevel - 1) sy = Math.max(gen.seaLevel, this.world.gen.heightAt(spawn.x, spawn.z))
      this.player.teleport(spawn.x + 0.5, sy + 1.05, spawn.z + 0.5, spawn.yaw)
    }

    this.saveTimer = SAVE_INTERVAL_SEC
    this.state = 'ready'
    this.requestPlay()
    if (saved) this.ui.toast('Saved world restored')
  }
  prototype.requestPlay = function(this: Game): void {
    if (this.state !== 'ready' && this.state !== 'paused') return
    if (isDesktopApp()) {
      void desktopCursor.lock().then(locked => {
        if (this.state !== 'ready' && this.state !== 'paused') return
        if (locked) {
          this.player.setNativeMouseCapture(true)
          this.renderer.domElement.style.cursor = 'none'
        }
        this.enterPlaying()
      }).catch(() => {
        if (this.state === 'ready' || this.state === 'paused') this.enterPlaying()
      })
      return
    }
    if (performance.now() < this.lockCooldown) {
      // browsers refuse pointer lock right after an unlock; retry shortly
      setTimeout(() => this.requestPlay(), Math.max(60, this.lockCooldown - performance.now()))
      return
    }
    let p: Promise<void> | undefined
    try {
      p = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
    } catch {
      this.enterPlaying()
      return
    }
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
  prototype.enterPlaying = function(this: Game): void {
    if (!this.worldAudioStarted) {
      this.worldAudioStarted = true
      this.audio.setSilentHillMode(this.silentHill)
    }
    this.state = 'playing'
    this.player.enabled = true
    this.ui.hidePause()
    this.ui.showGame()
  }
  prototype.onPointerLockChange = function(this: Game): void {
    if (document.pointerLockElement === this.renderer.domElement) {
      this.enterPlaying()
    } else if (this.state === 'playing') this.pauseGame()
  }
  prototype.pauseGame = function(this: Game): void {
    if (this.state !== 'playing') return
    if (isDesktopApp()) {
      this.player.setNativeMouseCapture(false)
      this.renderer.domElement.style.cursor = ''
      void desktopCursor.unlock()
    } else {
      this.lockCooldown = performance.now() + 1300
    }
    this.state = 'paused'
    this.player.enabled = false
    this.player.clearKeys()
    this.interaction.primaryUp()
    this.interaction.secondaryUp()
    this.ui.showPause()
    this.saveWorld()
  }
  prototype.quitToTitle = async function(this: Game): Promise<void> {
    if (!this.saveWorld(true)) return
    if (this.saveStore && !await this.saveStore.flush()) {
      this.ui.toast('Could not finish writing the world save')
      return
    }
    location.reload()
  }
  prototype.saveWorldNow = async function(this: Game): Promise<void> {
    if (!this.saveWorld(true)) return
    const flushed = await this.saveStore?.flush()
    this.ui.toast(flushed === false ? 'Could not finish writing the world save' : 'Saved the world')
  }
  prototype.saveWorld = function(this: Game, showFailure = false): boolean {
    if (
      !this.saveStore ||
      (this.state !== 'ready' && this.state !== 'playing' && this.state !== 'paused' &&
        this.state !== 'inventory' && this.state !== 'dead')
    ) return true

    // If the app closes while the death screen is open, persist the already
    // dropped inventory but reopen at a valid respawn instead of health zero.
    const closedWhileDeadSpawn = this.state === 'dead'
      ? (this.personalSpawn ? this.safeSpawnByBed(this.personalSpawn) : null) ?? this.worldSpawn
      : null
    const ok = this.saveStore.save({
      player: {
        x: closedWhileDeadSpawn?.x ?? this.player.pos.x,
        y: closedWhileDeadSpawn?.y ?? this.player.pos.y,
        z: closedWhileDeadSpawn?.z ?? this.player.pos.z,
        yaw: closedWhileDeadSpawn ? 0 : this.player.yaw,
        pitch: closedWhileDeadSpawn ? -0.08 : this.player.pitch,
        flying: this.player.flying,
        noclip: this.player.noclip,
        hotbarPage: this.interaction.page,
        selectedSlot: this.interaction.selected,
        health: closedWhileDeadSpawn ? 20 : this.player.health,
        hunger: closedWhileDeadSpawn ? 20 : this.player.hunger,
        saturation: closedWhileDeadSpawn ? 5 : this.player.saturation,
        air: closedWhileDeadSpawn ? 15 : this.player.air,
        exhaustion: closedWhileDeadSpawn ? 0 : this.player.exhaustion,
        experience: this.player.experienceTotal,
        ...(this.personalSpawn ? {
          respawnX: this.personalSpawn.x, respawnY: this.personalSpawn.y, respawnZ: this.personalSpawn.z
        } : {})
      },
      gameMode: this.mode,
      silentHill: this.silentHill,
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
      worldGenVersion: this.world.gen.generatorVersion,
      structureChests: [...this.initializedStructureChests],
      villageChunks: [...this.initializedVillageChunks],
      villageDoorChunks: [...this.initializedVillageDoorChunks],
      animalChunks: [...this.initializedAnimalChunks]
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
}
