import type { SerializedBlockEdits, SerializedBlockFacings, SerializedScheduledTicks } from '../world/World'
import type { WeatherKind, WeatherState } from '../weather/Weather'
import type { GameMode } from './Settings'
import type { ItemStack, SerializedInventory } from '../player/Inventory'
import type { SerializedEquipment } from '../player/Equipment'
import type { SavedDrop } from '../world/ItemDrops'
import type { SavedContainer } from '../world/Containers'
import { CHEST_SLOTS } from '../world/Containers'
import { ITEMS } from '../world/Items'
import { B } from '../world/Blocks'
import {
  MOB_KINDS, VILLAGER_PROFESSIONS,
  type MobKind, type SavedEntity, type VillagerProfession
} from '../entities/EntityTypes'
import { parseEnchantments } from '../player/Enchantments'
import { desktopWorlds, isDesktopApp, type NativeWorldRecord } from './Desktop'

const SAVE_VERSION = 1
const STORAGE_PREFIX = 'realmcraft.world.v1.'
const WORLD_CATALOG_KEY = 'realmcraft.worlds.v1'
const WEATHER_KINDS: WeatherKind[] = ['clear', 'cloudy', 'rain', 'storm']

export interface SavedPlayerState {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  flying: boolean
  noclip: boolean
  hotbarPage: number
  selectedSlot: number
  health: number
  hunger: number
  saturation: number
  air: number
  exhaustion: number
  experience: number
  respawnX?: number
  respawnY?: number
  respawnZ?: number
}

export interface WorldSaveData {
  version: typeof SAVE_VERSION
  seed: string
  savedAt: number
  player: SavedPlayerState
  gameMode: GameMode
  /** Permanent dense fog and the world's alternate ambient soundtrack. */
  silentHill?: boolean
  inventory: SerializedInventory
  armor: SerializedEquipment
  drops: SavedDrop[]
  containers: SavedContainer[]
  timeOfDay: number
  weather: WeatherState
  blockEdits: SerializedBlockEdits
  blockFacings: SerializedBlockFacings
  scheduledTicks: SerializedScheduledTicks
  entities: SavedEntity[]
  /** Stored for compatibility; WorldGen upgrades every value to the current baseline. */
  worldGenVersion?: 1 | 2 | 3 | 4
  /** One-shot procedural gameplay state; optional so version-1 saves remain compatible. */
  structureChests?: string[]
  villageChunks?: string[]
  /** Chunks whose procedural village door pairs have been backfilled. */
  villageDoorChunks?: string[]
  /** Chunks already considered by the deterministic terrain-animal pass. */
  animalChunks?: string[]
}

export interface WorldSummary extends NativeWorldRecord {}

function cleanWorldName(value: unknown): string {
  if (typeof value !== 'string') return 'New World'
  const name = value.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 48)
  return name || 'New World'
}

function cleanWorldSummary(value: unknown): WorldSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.seed !== 'string') return null
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || value.seed.length > 200) return null
  return {
    id: value.id,
    name: cleanWorldName(value.name),
    seed: value.seed,
    gameMode: value.gameMode === 'creative' ? 'creative' : 'survival',
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : Date.now(),
    lastPlayed: isFiniteNumber(value.lastPlayed) ? value.lastPlayed : 0,
    silentHill: value.silentHill === true
  }
}

function readLocalCatalog(): WorldSummary[] {
  try {
    const raw = localStorage.getItem(WORLD_CATALOG_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(cleanWorldSummary).filter((world): world is WorldSummary => world !== null)
  } catch {
    return []
  }
}

function writeLocalCatalog(worlds: readonly WorldSummary[]): void {
  try { localStorage.setItem(WORLD_CATALOG_KEY, JSON.stringify(worlds)) } catch { /* native storage may still work */ }
}

function upsertLocalCatalog(world: WorldSummary): void {
  const worlds = readLocalCatalog().filter(candidate => candidate.id !== world.id)
  writeLocalCatalog([world, ...worlds])
}

function localLegacyWorlds(): WorldSummary[] {
  const worlds: WorldSummary[] = []
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(STORAGE_PREFIX)) continue
      const seed = decodeURIComponent(key.slice(STORAGE_PREFIX.length))
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.seed !== seed) continue
      const id = /^[a-zA-Z0-9_-]{1,80}$/.test(seed) ? seed : `legacy_${Math.abs(hashString(seed))}`
      if (id !== seed) {
        const migratedKey = STORAGE_PREFIX + encodeURIComponent(id)
        if (!localStorage.getItem(migratedKey)) localStorage.setItem(migratedKey, raw)
      }
      worlds.push({
        id,
        name: `World ${seed || 'legacy'}`,
        seed,
        gameMode: parsed.gameMode === 'creative' ? 'creative' : 'survival',
        createdAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
        lastPlayed: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
        silentHill: parsed.silentHill === true
      })
    }
  } catch { /* ignore damaged legacy keys */ }
  return worlds
}

function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  return hash | 0
}

function uniqueWorldId(): string {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
  return uuid ? `world_${uuid}` : `world_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Catalog shared by the browser build and the native Tauri world directory. */
export class WorldLibrary {
  async list(): Promise<WorldSummary[]> {
    const local = [...readLocalCatalog(), ...localLegacyWorlds()]
    const native = await desktopWorlds.list() ?? []
    const merged = new Map<string, WorldSummary>()
    for (const candidate of [...local, ...native]) {
      const world = cleanWorldSummary(candidate)
      if (!world) continue
      const existing = merged.get(world.id)
      if (!existing || world.lastPlayed >= existing.lastPlayed) merged.set(world.id, world)
    }
    const worlds = [...merged.values()].sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name))
    writeLocalCatalog(worlds)
    return worlds
  }

  async create(name: string, seed: string, gameMode: GameMode, silentHill = false): Promise<WorldSummary> {
    const now = Date.now()
    const world: WorldSummary = {
      id: uniqueWorldId(),
      name: cleanWorldName(name),
      seed: seed.trim().slice(0, 200) || Math.floor(Math.random() * 1e12).toString(36),
      gameMode,
      createdAt: now,
      lastPlayed: now,
      silentHill
    }
    const worlds = (await this.list()).filter(candidate => candidate.id !== world.id)
    writeLocalCatalog([world, ...worlds])
    await desktopWorlds.register(world)
    return world
  }

  async touch(world: WorldSummary): Promise<WorldSummary> {
    const updated = { ...world, lastPlayed: Date.now() }
    const worlds = (await this.list()).filter(candidate => candidate.id !== world.id)
    writeLocalCatalog([updated, ...worlds])
    await desktopWorlds.register(updated)
    return updated
  }

  async delete(world: WorldSummary): Promise<boolean> {
    const worlds = (await this.list()).filter(candidate => candidate.id !== world.id)
    writeLocalCatalog(worlds)
    try {
      localStorage.removeItem(STORAGE_PREFIX + encodeURIComponent(world.id))
      // Historical saves were keyed by seed rather than an independent world id.
      if (world.id === world.seed) localStorage.removeItem(STORAGE_PREFIX + encodeURIComponent(world.seed))
    } catch { /* native delete remains authoritative in desktop builds */ }
    const native = await desktopWorlds.delete(world.id)
    return native ?? true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseDamage(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

function parseInventory(value: unknown): SerializedInventory {
  const slots: SerializedInventory = Array(36).fill(null)
  if (!Array.isArray(value)) return slots
  for (let i = 0; i < Math.min(36, value.length); i++) {
    const stack = value[i]
    if (!isRecord(stack) || !Number.isInteger(stack.id) || !Number.isInteger(stack.count)) continue
    const item = ITEMS[stack.id as number]
    if (!item || (stack.count as number) <= 0) continue
    const damage = parseDamage(stack.damage)
    const enchantments = parseEnchantments(stack.enchantments, stack.id as number)
    slots[i] = {
      id: stack.id as number,
      count: Math.min(item.stackSize, stack.count as number),
      ...(damage !== undefined ? { damage } : {}),
      ...(enchantments ? { enchantments } : {})
    }
  }
  return slots
}

function parseEquipment(value: unknown): SerializedEquipment {
  const slots: SerializedEquipment = Array(4).fill(null)
  if (!Array.isArray(value)) return slots
  const expected = ['head', 'chest', 'legs', 'feet'] as const
  for (let i = 0; i < Math.min(4, value.length); i++) {
    const stack = parseStack(value[i])
    const armor = stack ? ITEMS[stack.id]?.armor : null
    const wearablePumpkin = i === 0 && stack?.id === B.PUMPKIN
    if (stack && (wearablePumpkin || (armor?.slot === expected[i] && (stack.damage ?? 0) < armor.durability))) {
      slots[i] = { ...stack, count: 1 }
    }
  }
  return slots
}

function parseDrops(value: unknown): SavedDrop[] {
  if (!Array.isArray(value)) return []
  const drops: SavedDrop[] = []
  for (const raw of value.slice(0, 256)) {
    if (!isRecord(raw) || !Number.isInteger(raw.id) || !Number.isInteger(raw.count) ||
      !isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.z) || !ITEMS[raw.id as number]) continue
    const damage = parseDamage(raw.damage)
    const enchantments = parseEnchantments(raw.enchantments, raw.id as number)
    drops.push({
      id: raw.id as number,
      count: Math.min(ITEMS[raw.id as number]!.stackSize, Math.max(1, raw.count as number)),
      ...(damage !== undefined ? { damage } : {}),
      ...(enchantments ? { enchantments } : {}),
      x: raw.x,
      y: raw.y,
      z: raw.z
    })
  }
  return drops
}

function parseStack(value: unknown): ItemStack | null {
  if (!isRecord(value) || !Number.isInteger(value.id) || !Number.isInteger(value.count)) return null
  const item = ITEMS[value.id as number]
  if (!item || (value.count as number) <= 0) return null
  const damage = parseDamage(value.damage)
  const enchantments = parseEnchantments(value.enchantments, value.id as number)
  return {
    id: value.id as number,
    count: Math.min(item.stackSize, value.count as number),
    ...(damage !== undefined ? { damage } : {}),
    ...(enchantments ? { enchantments } : {})
  }
}

function parseContainers(value: unknown): SavedContainer[] {
  if (!Array.isArray(value)) return []
  const containers: SavedContainer[] = []
  const seen = new Set<string>()
  for (const raw of value.slice(0, 4096)) {
    if (!isRecord(raw) || (raw.kind !== 'chest' && raw.kind !== 'furnace')) continue
    if (!Number.isInteger(raw.x) || !Number.isInteger(raw.y) || !Number.isInteger(raw.z)) continue
    const x = raw.x as number, y = raw.y as number, z = raw.z as number
    if (Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000 || y < 0 || y > 512) continue
    const key = x + ',' + y + ',' + z
    if (seen.has(key)) continue
    seen.add(key)

    const size = raw.kind === 'chest' ? CHEST_SLOTS : 3
    const slots: Array<ItemStack | null> = Array(size).fill(null)
    if (Array.isArray(raw.slots)) {
      for (let i = 0; i < Math.min(size, raw.slots.length); i++) slots[i] = parseStack(raw.slots[i])
    }
    if (raw.kind === 'chest') {
      containers.push({ x, y, z, kind: 'chest', slots })
    } else {
      const time = (v: unknown) => isFiniteNumber(v) && v >= 0 ? v : 0
      containers.push({
        x, y, z, kind: 'furnace', slots,
        burn: time(raw.burn),
        burnTotal: time(raw.burnTotal),
        cook: time(raw.cook),
        xp: Math.min(10_000, time(raw.xp))
      })
    }
  }
  return containers
}

function parseEntities(value: unknown): SavedEntity[] {
  if (!Array.isArray(value)) return []
  const entities: SavedEntity[] = []
  const seen = new Set<string>()
  for (const raw of value.slice(0, 256)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 80 || seen.has(raw.id)) continue
    if (!MOB_KINDS.includes(raw.kind as MobKind)) continue
    if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.z) ||
      !isFiniteNumber(raw.vx) || !isFiniteNumber(raw.vy) || !isFiniteNumber(raw.vz) ||
      !isFiniteNumber(raw.yaw) || !isFiniteNumber(raw.health)) continue
    if (Math.abs(raw.x) > 30_000_000 || Math.abs(raw.z) > 30_000_000 || raw.y < -64 || raw.y > 512) continue
    seen.add(raw.id)
    entities.push({
      id: raw.id,
      kind: raw.kind as MobKind,
      x: raw.x, y: raw.y, z: raw.z,
      vx: Math.max(-20, Math.min(20, raw.vx)),
      vy: Math.max(-20, Math.min(20, raw.vy)),
      vz: Math.max(-20, Math.min(20, raw.vz)),
      yaw: raw.yaw,
      health: Math.max(1, Math.min(40, raw.health)),
      age: isFiniteNumber(raw.age) ? Math.max(-1200, Math.min(0, raw.age)) : 0,
      breedCooldown: isFiniteNumber(raw.breedCooldown) ? Math.max(0, Math.min(300, raw.breedCooldown)) : 0,
      eggTimer: isFiniteNumber(raw.eggTimer) ? Math.max(0, Math.min(600, raw.eggTimer)) : 0,
      ...(isFiniteNumber(raw.attackCooldown) ? { attackCooldown: Math.max(0, Math.min(10, raw.attackCooldown)) } : {}),
      ...(isFiniteNumber(raw.fuse) ? { fuse: Math.max(0, Math.min(1.5, raw.fuse)) } : {}),
      ...(isFiniteNumber(raw.angryTime) ? { angryTime: Math.max(0, Math.min(30, raw.angryTime)) } : {}),
      ...(isFiniteNumber(raw.sizeScale)
        ? { sizeScale: raw.sizeScale < 0.75 ? 0.5 : raw.sizeScale < 1.5 ? 1 : 2 }
        : {}),
      ...(typeof raw.persistent === 'boolean' ? { persistent: raw.persistent } : {}),
      ...(isFiniteNumber(raw.despawnAgeTicks)
        ? { despawnAgeTicks: Math.max(0, Math.min(10_000_000, Math.floor(raw.despawnAgeTicks))) }
        : {}),
      ...(typeof raw.sheared === 'boolean' ? { sheared: raw.sheared } : {}),
      ...(raw.kind === 'pig' && typeof raw.saddled === 'boolean' ? { saddled: raw.saddled } : {}),
      ...(isFiniteNumber(raw.woolTimer) ? { woolTimer: Math.max(0, Math.min(300, raw.woolTimer)) } : {}),
      ...(raw.carriedBlock === null || isFiniteNumber(raw.carriedBlock)
        ? { carriedBlock: raw.carriedBlock === null ? null : Math.max(0, Math.min(255, Math.floor(raw.carriedBlock))) }
        : {}),
      ...(raw.kind === 'villager' && VILLAGER_PROFESSIONS.includes(raw.profession as VillagerProfession)
        ? { profession: raw.profession as VillagerProfession }
        : {}),
      ...(raw.kind === 'villager' && isFiniteNumber(raw.homeX) ? { homeX: raw.homeX } : {}),
      ...(raw.kind === 'villager' && isFiniteNumber(raw.homeY) ? { homeY: raw.homeY } : {}),
      ...(raw.kind === 'villager' && isFiniteNumber(raw.homeZ) ? { homeZ: raw.homeZ } : {}),
      ...(raw.kind === 'villager' && typeof raw.villageId === 'string' && raw.villageId.length <= 80
        ? { villageId: raw.villageId }
        : {}),
      ...(raw.kind === 'villager' && typeof raw.homeDoorKey === 'string' && raw.homeDoorKey.length <= 160
        ? { homeDoorKey: raw.homeDoorKey }
        : {})
    })
  }
  return entities
}

function parseKeyList(value: unknown, pattern: RegExp, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const out = new Set<string>()
  for (const raw of value.slice(0, limit)) if (typeof raw === 'string' && pattern.test(raw)) out.add(raw)
  return [...out]
}

function parseSave(value: unknown, seed: string): WorldSaveData | null {
  if (!isRecord(value) || value.version !== SAVE_VERSION || value.seed !== seed) return null

  const player = value.player
  if (
    !isRecord(player) ||
    !isFiniteNumber(player.x) ||
    !isFiniteNumber(player.y) ||
    !isFiniteNumber(player.z) ||
    !isFiniteNumber(player.yaw) ||
    !isFiniteNumber(player.pitch) ||
    typeof player.flying !== 'boolean' ||
    (player.noclip !== undefined && typeof player.noclip !== 'boolean') ||
    (player.hotbarPage !== undefined && !Number.isInteger(player.hotbarPage)) ||
    !Number.isInteger(player.selectedSlot)
  ) return null
  if (Math.abs(player.x) > 30_000_000 || Math.abs(player.z) > 30_000_000 || player.y < -64 || player.y > 512) return null

  const weather = value.weather
  if (
    !isRecord(weather) ||
    !WEATHER_KINDS.includes(weather.kind as WeatherKind) ||
    !isFiniteNumber(weather.nextChange) ||
    !isFiniteNumber(weather.lightningTimer) ||
    !isRecord(weather.out)
  ) return null

  if (!isFiniteNumber(value.timeOfDay) || !isRecord(value.blockEdits)) return null
  const blockFacings = isRecord(value.blockFacings) ? value.blockFacings : {}
  const scheduledTicks: number[] = []
  if (Array.isArray(value.scheduledTicks)) {
    const rawTicks = value.scheduledTicks.slice(0, 4096 * 5)
    for (let i = 0; i + 4 < rawTicks.length; i += 5) {
      const tuple = rawTicks.slice(i, i + 5)
      if (tuple.every(isFiniteNumber)) scheduledTicks.push(...tuple)
    }
  }

  return {
    version: SAVE_VERSION,
    seed,
    savedAt: isFiniteNumber(value.savedAt) ? value.savedAt : Date.now(),
    player: {
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      flying: player.flying,
      noclip: player.noclip === true,
      hotbarPage: Math.max(0, Math.floor(typeof player.hotbarPage === 'number' ? player.hotbarPage : 0)),
      selectedSlot: Math.max(0, Math.floor(player.selectedSlot as number)),
      health: isFiniteNumber(player.health) ? Math.max(1, Math.min(20, player.health)) : 20,
      hunger: isFiniteNumber(player.hunger) ? Math.max(0, Math.min(20, player.hunger)) : 20,
      saturation: isFiniteNumber(player.saturation)
        ? Math.max(0, Math.min(20, player.saturation))
        : 5,
      air: isFiniteNumber(player.air) ? Math.max(0, Math.min(15, player.air)) : 15,
      exhaustion: isFiniteNumber(player.exhaustion) ? Math.max(0, player.exhaustion) : 0,
      experience: isFiniteNumber(player.experience) ? Math.max(0, Math.min(10_000_000, Math.floor(player.experience))) : 0,
      ...(isFiniteNumber(player.respawnX) && isFiniteNumber(player.respawnY) && isFiniteNumber(player.respawnZ)
        ? { respawnX: player.respawnX, respawnY: player.respawnY, respawnZ: player.respawnZ }
        : {})
    },
    gameMode: value.gameMode === 'survival' ? 'survival' : 'creative',
    silentHill: value.silentHill === true,
    inventory: parseInventory(value.inventory),
    armor: parseEquipment(value.armor),
    drops: parseDrops(value.drops),
    containers: parseContainers(value.containers),
    timeOfDay: value.timeOfDay,
    weather: weather as unknown as WeatherState,
    blockEdits: value.blockEdits as SerializedBlockEdits,
    blockFacings: blockFacings as SerializedBlockFacings,
    scheduledTicks,
    entities: parseEntities(value.entities),
    worldGenVersion: value.worldGenVersion === 4 ? 4
      : value.worldGenVersion === 3 ? 3
        : value.worldGenVersion === 2 ? 2 : 1,
    structureChests: parseKeyList(value.structureChests, /^-?\d+,-?\d+,-?\d+$/, 16384),
    villageChunks: parseKeyList(value.villageChunks, /^-?\d+,-?\d+$/, 16384),
    villageDoorChunks: parseKeyList(value.villageDoorChunks, /^-?\d+,-?\d+$/, 16384),
    animalChunks: parseKeyList(value.animalChunks, /^-?\d+,-?\d+$/, 16384)
  }
}

export class WorldSaveStore {
  private readonly storageKey: string
  private pendingNativeSave: Promise<boolean> | null = null

  constructor(
    private readonly seed: string,
    private readonly worldId = seed,
    private summary?: WorldSummary
  ) {
    this.storageKey = STORAGE_PREFIX + encodeURIComponent(worldId)
  }

  load(): WorldSaveData | null {
    try {
      const raw = localStorage.getItem(this.storageKey)
      if (!raw) return null
      return parseSave(JSON.parse(raw), this.seed)
    } catch {
      return null
    }
  }

  async loadAsync(): Promise<WorldSaveData | null> {
    const native = await desktopWorlds.load(this.worldId)
    if (native) {
      try {
        const parsed = parseSave(JSON.parse(native), this.seed)
        if (parsed) {
          try { localStorage.setItem(this.storageKey, native) } catch { /* native copy is enough */ }
          return parsed
        }
      } catch { /* fall through to local compatibility storage */ }
    }
    return this.load()
  }

  save(data: Omit<WorldSaveData, 'version' | 'seed' | 'savedAt'>): boolean {
    try {
      const payload: WorldSaveData = {
        version: SAVE_VERSION,
        seed: this.seed,
        savedAt: Date.now(),
        ...data
      }
      payload.silentHill ??= this.summary?.silentHill ?? false
      const serialized = JSON.stringify(payload)
      let localSaved = true
      try { localStorage.setItem(this.storageKey, serialized) } catch { localSaved = false }
      if (isDesktopApp()) {
        const metadata = this.summary ?? {
          id: this.worldId, name: `World ${this.seed}`, seed: this.seed,
          gameMode: payload.gameMode, createdAt: payload.savedAt, lastPlayed: payload.savedAt,
          silentHill: payload.silentHill === true
        }
        this.summary = {
          ...metadata, gameMode: payload.gameMode, lastPlayed: payload.savedAt,
          silentHill: payload.silentHill === true
        }
        upsertLocalCatalog(this.summary)
        const previous = this.pendingNativeSave ?? Promise.resolve(true)
        this.pendingNativeSave = previous
          .catch(() => false)
          .then(() => desktopWorlds.save(this.worldId, serialized, this.summary!).then(result => result ?? false))
        return true
      }
      if (!localSaved) return false
      if (this.summary) {
        this.summary = {
          ...this.summary, gameMode: payload.gameMode, lastPlayed: payload.savedAt,
          silentHill: payload.silentHill === true
        }
        upsertLocalCatalog(this.summary)
      }
      return true
    } catch {
      return false
    }
  }

  async flush(): Promise<boolean> {
    return this.pendingNativeSave ? await this.pendingNativeSave : true
  }
}
