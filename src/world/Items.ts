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

export interface FoodInfo {
  readonly hunger: number
  /** Classic saturation modifier; restored saturation is hunger * modifier * 2. */
  readonly saturation: number
  readonly useSeconds: number
  readonly returnsItem: number | null
  readonly effect?: { readonly kind: 'hunger' | 'poison'; readonly chance: number; readonly seconds: number }
}

export type ArmorSlot = 'head' | 'chest' | 'legs' | 'feet'

export interface ArmorInfo {
  readonly slot: ArmorSlot
  readonly points: number
  readonly durability: number
  readonly material: 'leather' | 'iron' | 'diamond' | 'gold'
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
  readonly food: FoodInfo | null
  readonly armor: ArmorInfo | null
  readonly ranged: 'bow' | null
}

function material(
  id: number,
  key: string,
  name: string,
  sprite: readonly [number, number],
  stackSize = 64,
  food: FoodInfo | null = null
): ItemDefinition {
  return { id, key, name, stackSize, placeBlock: null, sprite, tool: null, food, armor: null, ranged: null }
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
    tool: { type, tier },
    food: null,
    armor: null,
    ranged: null
  }
}

function bow(): ItemDefinition {
  return {
    id: I.BOW, key: 'bow', name: 'Bow', stackSize: 1, placeBlock: null,
    sprite: [5, 1], tool: null, food: null, armor: null, ranged: 'bow'
  }
}

const ARMOR_ROW: Record<ArmorSlot, number> = { head: 0, chest: 1, legs: 2, feet: 3 }
const ARMOR_NAME: Record<ArmorSlot, string> = { head: 'Helmet', chest: 'Chestplate', legs: 'Leggings', feet: 'Boots' }
const ARMOR_POINTS: Record<ArmorSlot, readonly [number, number, number, number]> = {
  head: [1, 2, 3, 2], chest: [3, 6, 8, 5], legs: [2, 5, 6, 3], feet: [1, 2, 3, 1]
}
const ARMOR_BASE: Record<ArmorSlot, number> = { head: 11, chest: 16, legs: 15, feet: 13 }

function armor(
  id: number,
  materialName: 'leather' | 'iron' | 'diamond' | 'gold',
  slot: ArmorSlot,
  column: number,
  tierIndex: 0 | 1 | 2 | 3,
  durabilityMultiplier: number
): ItemDefinition {
  const displayMaterial = materialName === 'gold' ? 'Golden' : materialName[0].toUpperCase() + materialName.slice(1)
  return {
    id, key: `${materialName}_${slot}`, name: `${displayMaterial} ${ARMOR_NAME[slot]}`,
    stackSize: 1, placeBlock: null, sprite: [column, ARMOR_ROW[slot]], tool: null, food: null,
    armor: {
      slot, material: materialName, points: ARMOR_POINTS[slot][tierIndex],
      durability: ARMOR_BASE[slot] * durabilityMultiplier
    },
    ranged: null
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
  material(I.APPLE, 'apple', 'Apple', [10, 0], 64, {
    hunger: 4, saturation: 0.3, useSeconds: 1.6, returnsItem: null
  }),
  bow(),
  material(I.ARROW, 'arrow', 'Arrow', [5, 2]),
  material(I.STICK, 'stick', 'Stick', [5, 3]),
  material(I.COAL, 'coal', 'Coal', [7, 0]),
  material(I.IRON_INGOT, 'iron_ingot', 'Iron Ingot', [7, 1]),
  material(I.GOLD_INGOT, 'gold_ingot', 'Gold Ingot', [7, 2]),
  material(I.DIAMOND, 'diamond', 'Diamond', [7, 3]),
  material(I.BOWL, 'bowl', 'Bowl', [7, 4]),
  material(I.MUSHROOM_STEW, 'mushroom_stew', 'Mushroom Stew', [8, 4], 1, {
    hunger: 8, saturation: 0.6, useSeconds: 1.6, returnsItem: I.BOWL
  }),
  material(I.SEEDS, 'seeds', 'Seeds', [9, 0]),
  material(I.WHEAT, 'wheat', 'Wheat', [9, 1]),
  material(I.BREAD, 'bread', 'Bread', [9, 2], 64, {
    hunger: 5, saturation: 0.6, useSeconds: 1.6, returnsItem: null
  }),
  material(I.BONE_MEAL, 'bone_meal', 'Bone Meal', [15, 11]),
  material(I.BONE, 'bone', 'Bone', [12, 1]),
  material(I.SUGAR, 'sugar', 'Sugar', [13, 0]),
  material(I.FEATHER, 'feather', 'Feather', [8, 1]),
  material(I.STRING, 'string', 'String', [8, 0]),
  material(I.GUNPOWDER, 'gunpowder', 'Gunpowder', [8, 2]),
  material(I.FLINT, 'flint', 'Flint', [6, 0]),
  material(I.FLINT_AND_STEEL, 'flint_and_steel', 'Flint and Steel', [5, 0], 1),
  material(I.BUCKET, 'bucket', 'Bucket', [10, 4], 16),
  material(I.WATER_BUCKET, 'water_bucket', 'Water Bucket', [11, 4], 16),
  material(I.LAVA_BUCKET, 'lava_bucket', 'Lava Bucket', [12, 4], 16),
  material(I.SLIMEBALL, 'slimeball', 'Slimeball', [14, 1]),
  material(I.LEATHER, 'leather', 'Leather', [7, 6]),
  material(I.EGG, 'egg', 'Egg', [12, 0], 16),
  material(I.PAPER, 'paper', 'Paper', [10, 3]),
  material(I.BOOK, 'book', 'Book', [11, 3]),
  material(I.RAW_PORKCHOP, 'raw_porkchop', 'Raw Porkchop', [7, 5], 64, {
    hunger: 3, saturation: 0.3, useSeconds: 1.6, returnsItem: null
  }),
  material(I.COOKED_PORKCHOP, 'cooked_porkchop', 'Cooked Porkchop', [8, 5], 64, {
    hunger: 8, saturation: 0.8, useSeconds: 1.6, returnsItem: null
  }),
  material(I.RAW_BEEF, 'raw_beef', 'Raw Beef', [9, 6], 64, {
    hunger: 3, saturation: 0.3, useSeconds: 1.6, returnsItem: null
  }),
  material(I.STEAK, 'steak', 'Steak', [10, 6], 64, {
    hunger: 8, saturation: 0.8, useSeconds: 1.6, returnsItem: null
  }),
  material(I.RAW_CHICKEN, 'raw_chicken', 'Raw Chicken', [9, 7], 64, {
    hunger: 2, saturation: 0.3, useSeconds: 1.6, returnsItem: null,
    effect: { kind: 'hunger', chance: 0.3, seconds: 30 }
  }),
  material(I.COOKED_CHICKEN, 'cooked_chicken', 'Cooked Chicken', [10, 7], 64, {
    hunger: 6, saturation: 0.6, useSeconds: 1.6, returnsItem: null
  }),
  material(I.ROTTEN_FLESH, 'rotten_flesh', 'Rotten Flesh', [11, 5], 64, {
    hunger: 4, saturation: 0.1, useSeconds: 1.6, returnsItem: null,
    effect: { kind: 'hunger', chance: 0.8, seconds: 30 }
  }),
  material(I.ENDER_PEARL, 'ender_pearl', 'Ender Pearl', [11, 6], 16),
  material(I.SPIDER_EYE, 'spider_eye', 'Spider Eye', [11, 8], 64, {
    hunger: 2, saturation: 0.8, useSeconds: 1.6, returnsItem: null,
    effect: { kind: 'poison', chance: 1, seconds: 5 }
  }),
  // Mutton has no classic sprite; ItemSprites paints tinted porkchop copies into (0,9)/(1,9).
  material(I.RAW_MUTTON, 'raw_mutton', 'Raw Mutton', [0, 9], 64, {
    hunger: 2, saturation: 0.3, useSeconds: 1.6, returnsItem: null
  }),
  material(I.COOKED_MUTTON, 'cooked_mutton', 'Cooked Mutton', [1, 9], 64, {
    hunger: 6, saturation: 0.8, useSeconds: 1.6, returnsItem: null
  }),
  material(I.SHEARS, 'shears', 'Shears', [13, 5], 1),
  material(I.COMPASS, 'compass', 'Compass', [6, 3], 64),
  material(I.CLOCK, 'clock', 'Clock', [6, 4], 64),
  material(I.BED, 'bed', 'Bed', [13, 2], 1),
  material(I.MAP, 'map', 'Map', [12, 3], 1),
  armor(I.LEATHER_HELMET, 'leather', 'head', 0, 0, 5),
  armor(I.LEATHER_CHESTPLATE, 'leather', 'chest', 0, 0, 5),
  armor(I.LEATHER_LEGGINGS, 'leather', 'legs', 0, 0, 5),
  armor(I.LEATHER_BOOTS, 'leather', 'feet', 0, 0, 5),
  armor(I.IRON_HELMET, 'iron', 'head', 2, 1, 15),
  armor(I.IRON_CHESTPLATE, 'iron', 'chest', 2, 1, 15),
  armor(I.IRON_LEGGINGS, 'iron', 'legs', 2, 1, 15),
  armor(I.IRON_BOOTS, 'iron', 'feet', 2, 1, 15),
  armor(I.DIAMOND_HELMET, 'diamond', 'head', 3, 2, 33),
  armor(I.DIAMOND_CHESTPLATE, 'diamond', 'chest', 3, 2, 33),
  armor(I.DIAMOND_LEGGINGS, 'diamond', 'legs', 3, 2, 33),
  armor(I.DIAMOND_BOOTS, 'diamond', 'feet', 3, 2, 33),
  armor(I.GOLDEN_HELMET, 'gold', 'head', 4, 3, 7),
  armor(I.GOLDEN_CHESTPLATE, 'gold', 'chest', 4, 3, 7),
  armor(I.GOLDEN_LEGGINGS, 'gold', 'legs', 4, 3, 7),
  armor(I.GOLDEN_BOOTS, 'gold', 'feet', 4, 3, 7),
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
      tool: null,
      food: null,
      armor: null,
      ranged: null
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

export function durabilityForItem(id: number): number {
  const item = ITEMS[id]
  if (!item) return 0
  if (item.ranged === 'bow') return 384
  if (id === I.FLINT_AND_STEEL) return 65
  if (id === I.SHEARS) return 238
  return item.tool?.tier.durability ?? item.armor?.durability ?? 0
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
export function breakInfoFor(blockId: BlockId, held: ItemDefinition | null, creative: boolean, efficiencyLevel = 0): BreakInfo {
  const block = BLOCKS[blockId]
  if (!block || !isFinite(block.hardness)) return { time: Infinity, harvest: false }
  if (creative) return { time: 0.1, harvest: false }

  const tool = held?.tool ?? null
  const matches = tool !== null && block.tool === tool.type
  const harvest = !block.requiresTool || (matches && tool.tier.level >= block.miningLevel)
  let time = block.hardness * (harvest ? 1.5 : 5)
  if (matches) {
    // Efficiency adds to tool speed like classic Minecraft rather than multiplying it.
    let speed = tool.tier.speed
    if (efficiencyLevel > 0) speed += efficiencyLevel * efficiencyLevel + 1
    time /= speed
  }
  return { time: Math.max(0.05, time), harvest }
}
