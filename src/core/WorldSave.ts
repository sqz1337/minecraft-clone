import type { SerializedBlockEdits, SerializedBlockFacings } from '../world/World'
import type { WeatherKind, WeatherState } from '../weather/Weather'
import type { GameMode } from './Settings'
import type { ItemStack, SerializedInventory } from '../player/Inventory'
import type { SavedDrop } from '../world/ItemDrops'
import type { SavedContainer } from '../world/Containers'
import { CHEST_SLOTS } from '../world/Containers'
import { ITEMS } from '../world/Items'

const SAVE_VERSION = 1
const STORAGE_PREFIX = 'realmcraft.world.v1.'
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
  air: number
  exhaustion: number
}

export interface WorldSaveData {
  version: typeof SAVE_VERSION
  seed: string
  savedAt: number
  player: SavedPlayerState
  gameMode: GameMode
  inventory: SerializedInventory
  drops: SavedDrop[]
  containers: SavedContainer[]
  timeOfDay: number
  weather: WeatherState
  blockEdits: SerializedBlockEdits
  blockFacings: SerializedBlockFacings
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
    slots[i] = {
      id: stack.id as number,
      count: Math.min(item.stackSize, stack.count as number),
      ...(damage !== undefined ? { damage } : {})
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
    drops.push({
      id: raw.id as number,
      count: Math.min(ITEMS[raw.id as number]!.stackSize, Math.max(1, raw.count as number)),
      ...(damage !== undefined ? { damage } : {}),
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
  return {
    id: value.id as number,
    count: Math.min(item.stackSize, value.count as number),
    ...(damage !== undefined ? { damage } : {})
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
        cook: time(raw.cook)
      })
    }
  }
  return containers
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
      air: isFiniteNumber(player.air) ? Math.max(0, Math.min(10, player.air)) : 10,
      exhaustion: isFiniteNumber(player.exhaustion) ? Math.max(0, player.exhaustion) : 0
    },
    gameMode: value.gameMode === 'survival' ? 'survival' : 'creative',
    inventory: parseInventory(value.inventory),
    drops: parseDrops(value.drops),
    containers: parseContainers(value.containers),
    timeOfDay: value.timeOfDay,
    weather: weather as unknown as WeatherState,
    blockEdits: value.blockEdits as SerializedBlockEdits,
    blockFacings: blockFacings as SerializedBlockFacings
  }
}

export class WorldSaveStore {
  private readonly storageKey: string

  constructor(private readonly seed: string) {
    this.storageKey = STORAGE_PREFIX + encodeURIComponent(seed)
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

  save(data: Omit<WorldSaveData, 'version' | 'seed' | 'savedAt'>): boolean {
    try {
      const payload: WorldSaveData = {
        version: SAVE_VERSION,
        seed: this.seed,
        savedAt: Date.now(),
        ...data
      }
      localStorage.setItem(this.storageKey, JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }
}
