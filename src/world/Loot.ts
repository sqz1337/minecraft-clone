import { B } from './Blocks'
import { I } from './ItemIds'
import { mulberry32 } from '../util/math'
import { CHEST_SLOTS } from './Containers'

/**
 * Structure chest loot tables, rolled deterministically from the chest's
 * world position and the world seed, in the spirit of classic 1.2.4 dungeon
 * and stronghold chests (limited to items that exist in Realmcraft).
 */

export type LootTableId =
  | 'dungeon'
  | 'mineshaft'
  | 'stronghold_storage'
  | 'stronghold_library'
  | 'village_house'

interface LootEntry {
  id: number
  min: number
  max: number
  weight: number
}

interface LootTable {
  minRolls: number
  maxRolls: number
  entries: LootEntry[]
}

const TABLES: Record<LootTableId, LootTable> = {
  dungeon: {
    minRolls: 3, maxRolls: 6,
    entries: [
      { id: I.BREAD, min: 1, max: 2, weight: 10 },
      { id: I.WHEAT, min: 1, max: 4, weight: 10 },
      { id: I.GUNPOWDER, min: 1, max: 4, weight: 10 },
      { id: I.STRING, min: 1, max: 4, weight: 10 },
      { id: I.BUCKET, min: 1, max: 1, weight: 4 },
      { id: I.APPLE, min: 1, max: 1, weight: 6 },
      { id: I.IRON_INGOT, min: 1, max: 4, weight: 8 },
      { id: I.BONE, min: 2, max: 6, weight: 8 },
      { id: I.ROTTEN_FLESH, min: 2, max: 5, weight: 8 },
      { id: I.COMPASS, min: 1, max: 1, weight: 2 }
    ]
  },
  mineshaft: {
    minRolls: 3, maxRolls: 6,
    entries: [
      { id: B.RAIL, min: 4, max: 8, weight: 10 },
      { id: I.IRON_INGOT, min: 1, max: 4, weight: 10 },
      { id: I.COAL, min: 3, max: 8, weight: 10 },
      { id: I.BREAD, min: 1, max: 3, weight: 10 },
      { id: I.SEEDS, min: 2, max: 4, weight: 8 },
      { id: I.GOLD_INGOT, min: 1, max: 3, weight: 4 },
      { id: I.DIAMOND, min: 1, max: 2, weight: 2 },
      { id: B.TORCH, min: 2, max: 8, weight: 8 }
    ]
  },
  stronghold_storage: {
    minRolls: 2, maxRolls: 5,
    entries: [
      { id: I.IRON_INGOT, min: 1, max: 5, weight: 10 },
      { id: I.COAL, min: 3, max: 8, weight: 10 },
      { id: I.BREAD, min: 1, max: 3, weight: 10 },
      { id: I.APPLE, min: 1, max: 3, weight: 8 },
      { id: I.GOLD_INGOT, min: 1, max: 3, weight: 5 },
      { id: I.ENDER_PEARL, min: 1, max: 1, weight: 2 }
    ]
  },
  stronghold_library: {
    minRolls: 3, maxRolls: 6,
    entries: [
      { id: I.BOOK, min: 1, max: 3, weight: 10 },
      { id: I.PAPER, min: 2, max: 7, weight: 10 },
      { id: I.COMPASS, min: 1, max: 1, weight: 3 },
      { id: I.MAP, min: 1, max: 1, weight: 3 },
      { id: I.CLOCK, min: 1, max: 1, weight: 2 }
    ]
  },
  village_house: {
    minRolls: 2, maxRolls: 4,
    entries: [
      { id: I.BREAD, min: 1, max: 3, weight: 10 },
      { id: I.WHEAT, min: 1, max: 4, weight: 10 },
      { id: I.SEEDS, min: 2, max: 5, weight: 8 },
      { id: I.APPLE, min: 1, max: 2, weight: 8 },
      { id: I.IRON_INGOT, min: 1, max: 2, weight: 3 }
    ]
  }
}

export function isLootTableId(id: string): id is LootTableId {
  return id in TABLES
}

export interface LootStack { slot: number; id: number; count: number }

/** Deterministic chest contents for a structure chest at a world position. */
export function rollLoot(table: LootTableId, x: number, y: number, z: number, seed: number): LootStack[] {
  const def = TABLES[table]
  const rand = mulberry32(
    (Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ Math.imul(z, 0x6c8e9cf5) ^ seed) >>> 0
  )
  const rolls = def.minRolls + Math.floor(rand() * (def.maxRolls - def.minRolls + 1))
  const totalWeight = def.entries.reduce((sum, entry) => sum + entry.weight, 0)
  const used = new Set<number>()
  const out: LootStack[] = []
  for (let i = 0; i < rolls; i++) {
    let pick = rand() * totalWeight
    let entry = def.entries[0]
    for (const candidate of def.entries) {
      pick -= candidate.weight
      if (pick <= 0) { entry = candidate; break }
    }
    const count = entry.min + Math.floor(rand() * (entry.max - entry.min + 1))
    let slot = Math.floor(rand() * CHEST_SLOTS)
    for (let probe = 0; probe < CHEST_SLOTS && used.has(slot); probe++) slot = (slot + 1) % CHEST_SLOTS
    if (used.has(slot)) break
    used.add(slot)
    out.push({ slot, id: entry.id, count })
  }
  return out
}
