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

export function installGameLoop(GameClass: GameConstructor): void {
  const prototype = GameClass.prototype
  prototype.blockBroken = function(this: Game, x: number, y: number, z: number, id: number): void {
    if (isInfestedBlock(id)) {
      // Interaction has already replaced the egg with air, so the centralized
      // entity validator can assess the exact emergence volume.
      this.entities.releaseSilverfishFromBlock(x, y, z)
      return
    }
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
  prototype.serializeInventoryForSave = function(this: Game): SerializedInventory {
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
  prototype.handlePlayerDeath = function(this: Game): void {
    if (this.state === 'dead') return
    this.entities.dismountRider()
    const deathX = this.player.pos.x, deathY = this.player.pos.y, deathZ = this.player.pos.z
    const score = this.player.experienceTotal
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
    this.state = 'dead'
    this.player.enabled = false
    this.player.clearKeys()
    this.interaction.primaryUp()
    this.interaction.secondaryUp()
    this.interaction.setFirstPersonVisible(false)
    this.ui.hideSleep()
    this.releaseMouseCapture()
    this.ui.showDeath(score)
  }
  prototype.respawnPlayer = function(this: Game, resume = true): void {
    if (this.state !== 'dead') return
    if (this.personalSpawn) {
      // getBlock intentionally returns air for unloaded chunks, so the bed
      // region must exist before validating the saved respawn point.
      this.world.ensureGeneratedAt(this.personalSpawn.x, this.personalSpawn.z, 2)
    }
    const bedSpawn = this.personalSpawn ? this.safeSpawnByBed(this.personalSpawn) : null
    if (this.personalSpawn && !bedSpawn) this.personalSpawn = null
    const target = bedSpawn ?? this.worldSpawn
    // Collision must be available before teleporting. Otherwise the player gets
    // one or more physics frames in air while streaming catches up.
    this.world.ensureGeneratedAt(target.x, target.z, 2)
    this.player.teleport(target.x, target.y, target.z, 0)
    this.player.resetAfterDeath()
    this.interaction.setFirstPersonVisible(this.player.cameraMode === 'first')
    this.state = 'ready'
    this.ui.showGame()
    this.ui.toast(bedSpawn ? 'Respawned beside your bed' : 'Respawned at the world spawn')
    this.saveWorld()
    if (resume) this.requestPlay()
  }
  prototype.tickSleep = function(this: Game, dt: number): void {
    const sleep = this.sleepTransition
    if (!sleep) return
    const darkAt = 1.25, messageEnds = 3, wakeAt = 3.25, finish = 4.5
    sleep.elapsed += dt
    const ease = (value: number): number => {
      const t = clamp(value, 0, 1)
      return t * t * (3 - 2 * t)
    }
    if (sleep.elapsed < darkAt) {
      this.camera.position.copy(sleep.bedPosition)
      this.camera.quaternion.copy(sleep.bedQuaternion)
      this.ui.setSleepProgress(ease(sleep.elapsed / darkAt))
      return
    }
    this.env.timeOfDay = 0.25
    if (sleep.elapsed < messageEnds) {
      this.camera.position.copy(sleep.bedPosition)
      this.camera.quaternion.copy(sleep.bedQuaternion)
      this.ui.setSleepProgress(1, sleep.message)
      return
    }
    if (sleep.elapsed < wakeAt) {
      this.camera.position.copy(sleep.bedPosition)
      this.camera.quaternion.copy(sleep.bedQuaternion)
      this.ui.setSleepProgress(1)
      return
    }
    if (!sleep.awake) {
      const wake = this.safeSpawnByBed(sleep.head) ?? {
        x: this.player.pos.x,
        y: this.player.pos.y,
        z: this.player.pos.z
      }
      this.player.teleport(wake.x, wake.y, wake.z, this.player.yaw, this.player.pitch)
      sleep.awake = true
    }
    const t = ease((sleep.elapsed - wakeAt) / (finish - wakeAt))
    this.ui.setSleepProgress(1 - t)
    if (sleep.elapsed < finish) return
    this.sleepTransition = null
    this.state = 'playing'
    this.player.enabled = true
    this.interaction.setFirstPersonVisible(this.player.cameraMode === 'first')
    this.ui.hideSleep()
    this.ui.toast('Respawn point set')
    this.saveWorld()
  }
  prototype.tickStructureSpawners = function(this: Game, dt: number): void {
    this.spawnerTimer -= dt
    if (this.spawnerTimer > 0) return
    this.spawnerTimer = 2.5 + Math.random() * 2
    const p = this.player.pos
    for (const spawner of this.world.gen.structureSpawnersNear(p.x, p.z, 20)) {
      if (this.world.getBlock(spawner.x, spawner.y, spawner.z) !== B.SPAWNER) continue
      // vanilla: a spawner is active within 16 blocks with no minimum distance
      const distance = Math.hypot(spawner.x + 0.5 - p.x, spawner.y + 0.5 - p.y, spawner.z + 0.5 - p.z)
      if (distance > 16) continue
      const local = this.entities.queryRadius(spawner.x + 0.5, spawner.y, spawner.z + 0.5, 8)
        .filter(entity => entity.kind === spawner.mob).length
      if (local >= 6) continue
      for (let attempt = 0; attempt < 6; attempt++) {
        const x = spawner.x + Math.floor(Math.random() * 7) - 3
        const z = spawner.z + Math.floor(Math.random() * 7) - 3
        const y = spawner.y
        if (!this.entities.canSpawnEntity(spawner.mob, x + 0.5, y + 0.01, z + 0.5, {
          source: 'spawner', darkness: U.uNight.value * 15
        })) continue
        if (this.entities.spawn(spawner.mob, x + 0.5, y + 0.01, z + 0.5, { bypassMobCap: true })) break
      }
    }
  }
  prototype.frame = function(this: Game): void {
    const frameStart = performance.now()
    const dt = clamp(this.clock.getDelta(), 0.0001, 0.05)
    U.uTime.value += dt

    this.audio.updateMenuMusic(dt, this.state === 'title')
    if (this.state === 'title' || this.state === 'loading') return
    if (this.state === 'sleeping') this.tickSleep(dt)

    const playing = this.state === 'playing'
    if (playing) {
      this.player.syncRidingPose(this.entities.riderPose)
      if (this.player.wantsDismount) {
        this.entities.dismountRider()
        this.player.syncRidingPose(null)
      }
      this.player.update(dt)
      this.interaction.update(dt)
      this.interaction.setFirstPersonVisible(this.player.cameraMode === 'first')
      this.playerRenderer.update(
        dt,
        this.player,
        this.interaction.swingProgress,
        this.interaction.heldViewMesh,
        this.interaction.selectedItem?.id ?? null,
        this.interaction.showsFirstPersonArm
      )
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
      worldSpawn: this.worldSpawn,
      playerTargetable: this.mode === 'survival' && this.player.health > 0 && !this.player.noclip,
      heldItem: this.interaction.selectedItem?.id ?? null,
      headItem: this.equipment.slots[0]?.id ?? null,
      look: this.player.getLookDirection(this.lookDir),
      skyDarkness: U.uNight.value * 15,
      timeOfDay: this.env.timeOfDay,
      // Snow is precipitation but does not wet entities; only actual rain hurts endermen.
      raining: this.weather.out.rain > 0.25
    })
    this.player.syncRidingPose(this.entities.riderPose)
    this.projectiles.update(playing ? dt : 0, p)

    const biome = this.world.biomeAt(Math.floor(p.x), Math.floor(p.z))
    const cold = biome === BIOME.SNOW || p.y > 82
    const dry = biome === BIOME.DESERT
    this.weather.update(playing ? dt : 0, cold, this.audio, dry)
    const w = this.weather.out

    const underwater = this.player.headUnderwater
    this.env.setWeather(w)
    this.env.update(playing ? dt : 0, this.camera, p, underwater, this.world.renderDistance * CHUNK_SIZE)
    // rain wetness: surfaces get darker
    this.materials.solid.color.setScalar(1 - w.wetness * 0.12)

    this.particles.update(dt, this.camera.position, w.rain, w.snow, U.uNight.value, underwater, w.wind)
    this.tntFx.update(playing ? dt : 0)
    this.critters.update(dt, p, U.uNight.value, w.rain + w.snow)
    this.ui.setUnderwater(underwater)
    this.audio.updateListener(this.camera.position, this.camera.getWorldDirection(this.audioDir))
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
        weather: this.silentHill ? 'Silent Hill fog' : this.weather.displayName(cold, dry),
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

    // Main world pass excludes the view model, then a second pass clears depth
    // and draws only the view model so the held item self-occludes yet stays on
    // top of the world (including the block being mined and transparent water).
    this.camera.layers.disable(VIEWMODEL_LAYER)
    this.renderer.render(this.scene, this.camera)
    this.renderer.autoClear = false
    this.renderer.clearDepth()
    this.camera.layers.set(VIEWMODEL_LAYER)
    this.renderer.render(this.scene, this.camera)
    this.camera.layers.set(0)
    this.renderer.autoClear = true

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
