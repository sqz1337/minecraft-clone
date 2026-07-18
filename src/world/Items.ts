import { B, BLOCKS, BlockId, ToolType } from './Blocks'
import { I } from './ItemIds'

/** Tool material tiers, classic 1.2.4 values. */
export interface ToolTier {
  readonly key: string
  readonly name: string
  /** Mining level: which `miningLevel` blocks this tier can harvest. */
  readonly level: number
  /** Dig speed multiplier when the tool type matches the block. */
  readonly speed: number
  /** Uses before the tool breaks. */
  readonly durability: number
}

export const TIERS = {
  wood: { key: 'wood', name: 'Wooden', level: 0, speed: 2, durability: 59 },
  stone: { key: 'stone', name: 'Stone', level: 1, speed: 4, durability: 131 },
  iron: { key: 'iron', name: 'Iron', level: 2, speed: 6, durability: 250 },
  diamond: { key: 'diamond', name: 'Diamond', level: 3, speed: 8, durability: 1561 },
  gold: { key: 'gold', name: 'Golden', level: 0, speed: 12, durability: 32 }
} as const satisfies Record<string, ToolTier>

export interface ToolInfo {
  readonly type: ToolType
  readonly tier: ToolTier
}

export interface ItemDefinition {
  readonly id: number
  readonly key: string
  readonly name: string
  readonly stackSize: number
  /** Block placed by right click, or null for pure items (materials, tools). */
  readonly placeBlock: BlockId | null
  /** [column, row] in the classic gui/items.png sheet; null → rendered from the block atlas. */
  readonly sprite: readonly [number, number] | null
  readonly tool: ToolInfo | null
}

function material(id: number, key: string, name: string, sprite: readonly [number, number]): ItemDefinition {
  return { id, key, name, stackSize: 64, placeBlock: null, sprite, tool: null }
}

function tool(id: number, tier: ToolTier, type: ToolType, sprite: readonly [number, number]): ItemDefinition {
  const typeName = type.charAt(0).toUpperCase() + type.slice(1)
  return {
    id,
    key: `${tier.key}_${type}`,
    name: `${tier.name} ${typeName}`,
    stackSize: 1,
    placeBlock: null,
    sprite,
    tool: { type, tier }
  }
}

// items.png columns per tier and rows per tool type (classic pre-1.5 sheet).
const TIER_COLUMN = { wood: 0, stone: 1, iron: 2, diamond: 3, gold: 4 } as const
const TOOL_ROW = { sword: 4, shovel: 5, pickaxe: 6, axe: 7, hoe: 8 } as const

const TOOL_IDS: Record<keyof typeof TIERS, Record<ToolType, number>> = {
  wood: { sword: I.WOODEN_SWORD, shovel: I.WOODEN_SHOVEL, pickaxe: I.WOODEN_PICKAXE, axe: I.WOODEN_AXE, hoe: I.WOODEN_HOE },
  stone: { sword: I.STONE_SWORD, shovel: I.STONE_SHOVEL, pickaxe: I.STONE_PICKAXE, axe: I.STONE_AXE, hoe: I.STONE_HOE },
  iron: { sword: I.IRON_SWORD, shovel: I.IRON_SHOVEL, pickaxe: I.IRON_PICKAXE, axe: I.IRON_AXE, hoe: I.IRON_HOE },
  diamond: { sword: I.DIAMOND_SWORD, shovel: I.DIAMOND_SHOVEL, pickaxe: I.DIAMOND_PICKAXE, axe: I.DIAMOND_AXE, hoe: I.DIAMOND_HOE },
  gold: { sword: I.GOLDEN_SWORD, shovel: I.GOLDEN_SHOVEL, pickaxe: I.GOLDEN_PICKAXE, axe: I.GOLDEN_AXE, hoe: I.GOLDEN_HOE }
}

const NON_BLOCK_ITEMS: ItemDefinition[] = [
  material(I.STICK, 'stick', 'Stick', [5, 3]),
  material(I.COAL, 'coal', 'Coal', [7, 0]),
  material(I.IRON_INGOT, 'iron_ingot', 'Iron Ingot', [7, 1]),
  material(I.GOLD_INGOT, 'gold_ingot', 'Gold Ingot', [7, 2]),
  material(I.DIAMOND, 'diamond', 'Diamond', [7, 3]),
  ...(Object.keys(TIERS) as (keyof typeof TIERS)[]).flatMap(tierKey =>
    (Object.keys(TOOL_ROW) as ToolType[]).map(type =>
      tool(TOOL_IDS[tierKey][type], TIERS[tierKey], type, [TIER_COLUMN[tierKey], TOOL_ROW[type]])
    )
  )
]

const ITEM_COUNT = Math.max(...NON_BLOCK_ITEMS.map(item => item.id)) + 1

/**
 * Item registry: indices 0..255 mirror placeable blocks, 256+ are pure items.
 * Slots without an item are null.
 */
export const ITEMS: readonly (ItemDefinition | null)[] = (() => {
  const byId = new Array<ItemDefinition | null>(ITEM_COUNT).fill(null)
  for (const block of BLOCKS) {
    if (!block.hasItem) continue
    byId[block.id] = Object.freeze({
      id: block.id,
      key: block.key,
      name: block.name,
      stackSize: 64,
      placeBlock: block.id,
      sprite: null,
      tool: null
    })
  }
  for (const item of NON_BLOCK_ITEMS) {
    if (byId[item.id]) throw new Error(`Duplicate item id ${item.id}`)
    byId[item.id] = Object.freeze(item)
  }
  return Object.freeze(byId)
})()

export function itemName(id: number): string {
  return ITEMS[id]?.name ?? 'Unknown'
}

export function isValidItemId(id: unknown): id is number {
  return Number.isInteger(id) && (id as number) >= 0 && (id as number) < ITEMS.length && !!ITEMS[id as number]
}

export interface BreakInfo {
  /** Seconds to break the block with the held item. */
  time: number
  /** Whether the block will drop its item when broken this way. */
  harvest: boolean
}

/**
 * Classic break-time formula: hardness × 1.5 when the block can be harvested,
 * hardness × 5 when the current tool cannot harvest it; a matching tool type
 * divides the result by the tier speed. Creative digs everything quickly.
 */
export function breakInfoFor(blockId: BlockId, held: ItemDefinition | null, creative: boolean): BreakInfo {
  const block = BLOCKS[blockId]
  if (!block || !isFinite(block.hardness)) return { time: Infinity, harvest: false }
  if (creative) return { time: 0.1, harvest: false }

  const tool = held?.tool ?? null
  const matches = tool !== null && block.tool === tool.type
  const harvest = !block.requiresTool || (matches && tool.tier.level >= block.miningLevel)
  let time = block.hardness * (harvest ? 1.5 : 5)
  if (matches) time /= tool.tier.speed
  return { time: Math.max(0.05, time), harvest }
}
