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

export function installGameInput(GameClass: GameConstructor): void {
  const prototype = GameClass.prototype
  prototype.bindMouse = function(this: Game): void {
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
  prototype.bindGameKeys = function(this: Game): void {
    document.addEventListener('keydown', (e) => {
      const bound = (action: Parameters<Settings['key']>[0]) => e.code === this.settings.key(action)
      // While the console is open its input owns the keyboard.
      if (this.state === 'chat') return
      if (bound('inventory') && !e.repeat && this.mode === 'survival' &&
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
      if (e.code === 'Escape' && this.state === 'playing' && isDesktopApp()) {
        e.preventDefault()
        this.pauseGame()
        return
      }
      if (bound('admin') && !e.repeat && this.mode === 'survival' &&
        (this.state === 'playing' || (this.state === 'inventory' && this.screen?.kind === 'admin'))) {
        e.preventDefault()
        this.toggleAdmin()
        return
      }
      if (this.state !== 'playing') return
      if (bound('console') && !e.repeat) {
        e.preventDefault()
        this.openConsole()
        return
      }
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10)
        if (n >= 1 && n <= this.interaction.currentHotbar.length) this.interaction.setSelected(n - 1)
      }
      if (e.repeat) return
      if (bound('perspective')) {
        e.preventDefault()
        const mode = this.player.cycleCamera()
        this.ui.toast(mode === 'first' ? 'Camera: first person'
          : mode === 'third-back' ? 'Camera: third person (back)' : 'Camera: third person (front)')
      } else if (bound('drop')) {
        e.preventDefault()
        // Tap: drop one. Keep holding ~1.2s: dump the rest of the stack.
        this.interaction.dropSelected(false)
        if (this.dropHoldTimer !== null) window.clearTimeout(this.dropHoldTimer)
        this.dropHoldTimer = window.setTimeout(() => {
          this.dropHoldTimer = null
          if (this.state === 'playing') this.interaction.dropSelected(true)
        }, 1200)
      } else if (bound('time')) {
        this.env.timeScale = this.env.timeScale === 1 ? 40 : 1
        this.ui.toast(this.env.timeScale > 1 ? 'Time fast-forward ON' : 'Time fast-forward OFF')
      } else if (bound('weather')) {
        const kind = this.weather.cycle()
        this.ui.toast('Weather: ' + kind)
      } else if (bound('flashlight')) {
        const on = this.player.toggleFlashlight()
        this.ui.toast('Flashlight ' + (on ? 'ON' : 'OFF'))
      } else if (bound('flight')) {
        if (this.mode !== 'creative') {
          this.ui.toast('Flight is only available in Creative; use inspection mode instead')
        } else {
          const fly = this.player.toggleFly()
          this.ui.toast(fly ? 'Flight enabled' : 'Flight disabled')
        }
      } else if (bound('hotbarPage') && this.mode === 'creative') {
        this.interaction.cyclePage()
        this.ui.toast(`Hotbar page ${this.interaction.page + 1}`)
      } else if (bound('inspection')) {
        this.setInspectionMode(!this.player.noclip)
        this.ui.toast(this.player.noclip ? 'Ore inspection: noclip + xray ON' : 'Ore inspection OFF')
      }
    })
    // Releasing Q before the hold fires cancels the "dump whole stack" timer.
    document.addEventListener('keyup', (e) => {
      if (e.code === this.settings.key('drop') && this.dropHoldTimer !== null) {
        window.clearTimeout(this.dropHoldTimer)
        this.dropHoldTimer = null
      }
    })
  }
  prototype.applySettings = function(this: Game): void {
    if (!this.world) return
    this.audio.setVolume(this.settings.volume)
    this.player.headBobEnabled = this.settings.headBob
    this.player.applyViewSettings()
    const preset = this.settings.preset
    this.applyPixelRatio()
    this.env.setShadowsEnabled(preset.shadows)
    this.env.setShadowMapSize(preset.shadowSize)
    this.world.grassDensity = preset.grassDensity
    if (this.world.renderDistance !== this.settings.renderDistance) {
      this.world.setRenderDistance(this.settings.renderDistance)
      this.env.setViewDistance(this.settings.renderDistance * CHUNK_SIZE)
    }
  }
  prototype.setInspectionMode = function(this: Game, enabled: boolean): void {
    this.player.setNoclip(enabled)
    this.materials.setXray(enabled)
    this.world.setXrayEnabled(enabled)
  }
  prototype.toggleInventory = function(this: Game): void {
    if (this.mode !== 'survival') return
    if (this.state === 'playing') {
      this.openCraftScreen(2)
    } else if (this.state === 'inventory') {
      this.closeScreen()
      this.state = 'paused'
      this.requestPlay()
    }
  }
  prototype.openConsole = function(this: Game): void {
    if (this.state !== 'playing') return
    this.state = 'chat'
    this.player.enabled = false
    this.player.clearKeys()
    this.interaction.primaryUp()
    this.interaction.secondaryUp()
    // state is already 'chat', so releasing the pointer will not trigger the pause menu
    this.releaseMouseCapture()
    this.ui.openConsole('/')
  }
  prototype.closeConsole = function(this: Game, text: string | null): void {
    if (this.state !== 'chat') return
    if (text) this.runCommand(text)
    this.state = 'paused'
    this.requestPlay()
  }
  prototype.runCommand = function(this: Game, raw: string): void {
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
  prototype.commandHelp = function(this: Game): void {
    this.ui.consolePrint('/spawn <creature> [count] [baby] [profession] — spawn near you', 'info')
    this.ui.consolePrint('/spawn all — one of every creature', 'info')
    this.ui.consolePrint('creatures: ' + MOB_KINDS.join(', '), 'info')
  }
  prototype.commandSpawn = function(this: Game, args: string[]): void {
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
        let x = this.player.pos.x + Math.cos(angle) * dist
        let z = this.player.pos.z + Math.sin(angle) * dist
        let y = this.world.topSolidY(Math.floor(x), Math.floor(z)) + 1
        if (kind === 'squid') {
          let water: { x: number; y: number; z: number } | null = null
          for (let attempt = 0; attempt < 64 && !water; attempt++) {
            const bx = Math.floor(this.player.pos.x + (Math.random() - 0.5) * 24)
            const bz = Math.floor(this.player.pos.z + (Math.random() - 0.5) * 24)
            const bottom = this.world.topSolidY(bx, bz) + 1
            for (let by = bottom; by < Math.min(127, bottom + 12); by++) {
              if (this.world.isWater(bx, by, bz)) { water = { x: bx + 0.5, y: by + 0.05, z: bz + 0.5 }; break }
            }
          }
          if (!water) continue
          x = water.x; y = water.y; z = water.z
        }
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
  prototype.useBlock = function(this: Game, hit: RayHit): void {
    if (hit.id === B.CRAFTING_TABLE) this.openCraftScreen(3)
    else if (hit.id === B.FURNACE || hit.id === B.FURNACE_LIT) this.openFurnace(hit.x, hit.y, hit.z)
    else if (hit.id === B.CHEST) this.openChest(hit.x, hit.y, hit.z)
    else if (hit.id === B.ENCHANTING_TABLE) this.openEnchanting(hit.x, hit.y, hit.z)
    else if (isBedBlock(hit.id)) this.useBed(hit)
    else if (isDoorBlock(hit.id)) {
      const open = this.world.doorState(hit.x, hit.y, hit.z) === 'open'
      if (this.world.setDoorOpen(hit.x, hit.y, hit.z, !open)) this.audio.door(!open)
    }
  }
  prototype.initializeGeneratedChunk = function(this: Game, cx: number, cz: number): void {
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
    if (!this.initializedAnimalChunks.has(chunkKey)) {
      this.initializedAnimalChunks.add(chunkKey)
      this.entities.populateChunkAnimals(cx, cz, this.world.gen.seedNum)
    }
    const villages = this.world.gen.villageFeaturesIn(cx, cz)
    for (const village of villages) this.entities.registerVillage(village)
    if (!this.initializedVillageDoorChunks.has(chunkKey)) {
      for (const village of villages) {
        for (const door of village.doors) {
          if (Math.floor(door.x / CHUNK_SIZE) !== cx || Math.floor(door.z / CHUNK_SIZE) !== cz) continue
          if (this.world.doorState(door.x, door.y, door.z)) continue
          this.world.placeDoor(door.x, door.y, door.z, door.facing)
        }
      }
      this.initializedVillageDoorChunks.add(chunkKey)
    }

    if (this.initializedVillageChunks.has(chunkKey)) return
    this.initializedVillageChunks.add(chunkKey)
    const spots = this.world.gen.villagerSpawnsIn(cx, cz)
    for (let index = 0; index < spots.length; index++) {
      const spot = spots[index]
      let y = spot.y
      for (let lift = 0; lift < 4 && (this.world.isSolid(spot.x, y, spot.z) || this.world.isSolid(spot.x, y + 1, spot.z)); lift++) y++
      const profession = this.villagerProfessionAt(spot.x, spot.z)
      if (!this.entities.canSpawnEntity('villager', spot.x + 0.5, y + 0.01, spot.z + 0.5)) continue
      this.entities.spawn('villager', spot.x + 0.5, y + 0.01, spot.z + 0.5, {
        persistent: true,
        bypassMobCap: true,
        id: `villager-${spot.villageId}-${spot.x}-${spot.z}-${index}`,
        profession,
        homeX: spot.x + 0.5,
        homeY: y + 0.01,
        homeZ: spot.z + 0.5,
        villageId: spot.villageId,
        homeDoorKey: spot.homeDoorKey
      })
    }
    for (const village of villages) {
      if (Math.floor(village.centerX / CHUNK_SIZE) !== cx || Math.floor(village.centerZ / CHUNK_SIZE) !== cz) continue
      const golemId = `iron-golem-${village.id}`
      let y = village.centerY
      for (let lift = 0; lift < 6 && (this.world.isSolid(village.centerX, y, village.centerZ) ||
        this.world.isSolid(village.centerX, y + 1, village.centerZ) ||
        this.world.isSolid(village.centerX, y + 2, village.centerZ)); lift++) y++
      if (!this.entities.snapshotById(golemId)) {
        this.entities.spawn('iron_golem', village.centerX + 0.5, y + 0.01, village.centerZ + 0.5, {
          persistent: true, bypassMobCap: true, id: golemId
        })
      }
      const catId = `cat-${village.id}`
      if (!this.entities.snapshotById(catId)) {
        const catX = village.centerX + 2.5
        const catZ = village.centerZ + 0.5
        const catY = this.world.topSolidY(Math.floor(catX), Math.floor(catZ)) + 1.01
        this.entities.spawn('cat', catX, catY, catZ, {
          persistent: true, bypassMobCap: true, id: catId
        })
      }
    }
  }
  prototype.villagerProfessionAt = function(this: Game, x: number, z: number): VillagerProfession {
    const hash = (Math.imul(x, 0x1f123bb5) ^ Math.imul(z, 0x5f356495) ^ this.world.gen.seedNum) >>> 0
    return VILLAGER_PROFESSIONS[hash % VILLAGER_PROFESSIONS.length]
  }
  prototype.useBed = function(this: Game, hit: RayHit): void {
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
  prototype.safeSpawnByBed = function(this: Game, bed: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
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
  prototype.useNavigationItem = function(this: Game, itemId: number): void {
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
  prototype.useMap = function(this: Game): void {
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
      const shade = clamp(0.75 + (info.height - this.world.gen.seaLevel) * 0.012, 0.62, 1.2)
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
}
