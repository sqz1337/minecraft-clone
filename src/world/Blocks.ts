import { I } from './ItemIds'

/** Stable block ids. These values are persisted in saved world edits. */
export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  SNOW: 5,
  LOG: 6,
  LEAVES: 7,
  WATER: 8,
  GRAVEL: 9,
  BEDROCK: 10,
  PLANKS: 11,
  TALLGRASS: 12,
  FLOWER_Y: 13,
  FLOWER_R: 14,
  PINELOG: 15,
  PINELEAVES: 16,
  COBBLESTONE: 17,
  COAL_ORE: 18,
  IRON_ORE: 19,
  GOLD_ORE: 20,
  DIAMOND_ORE: 21,
  GLASS: 22,
  BRICKS: 23,
  TORCH: 24,
  CRAFTING_TABLE: 25,
  FURNACE: 26,
  CHEST: 27,
  FURNACE_LIT: 28,
  FARMLAND_DRY: 29,
  FARMLAND_WET: 30,
  WHEAT_0: 31,
  WHEAT_1: 32,
  WHEAT_2: 33,
  WHEAT_3: 34,
  WHEAT_4: 35,
  WHEAT_5: 36,
  WHEAT_6: 37,
  WHEAT_7: 38,
  SUGARCANE: 39,
  MUSHROOM_BROWN: 40,
  MUSHROOM_RED: 41,
  SAPLING_OAK: 42,
  SAPLING_SPRUCE: 43,
  WATER_1: 44,
  WATER_2: 45,
  WATER_3: 46,
  WATER_4: 47,
  WATER_5: 48,
  WATER_6: 49,
  WATER_7: 50,
  LAVA: 51,
  LAVA_1: 52,
  LAVA_2: 53,
  LAVA_3: 54,
  LAVA_4: 55,
  LAVA_5: 56,
  LAVA_6: 57,
  LAVA_7: 58,
  OBSIDIAN: 59,
  FIRE: 60,
  TNT: 61,
  PRIMED_TNT: 62,
  BOOKSHELF: 63,
  ENCHANTING_TABLE: 64,
  WOOL: 65,
  JUNGLE_LOG: 66,
  JUNGLE_LEAVES: 67,
  MYCELIUM: 68,
  MUSHROOM_STEM: 69,
  MUSHROOM_CAP_RED: 70,
  MUSHROOM_CAP_BROWN: 71,
  FERN: 72,
  MOSSY_COBBLESTONE: 73,
  SPAWNER: 74,
  STONE_BRICK: 75,
  STONE_BRICK_MOSSY: 76,
  STONE_BRICK_CRACKED: 77,
  RAIL: 78,
  BED_FOOT: 79,
  BED_HEAD: 80,
  SANDSTONE: 81,
  END_PORTAL_FRAME: 82
} as const

export type BlockId = number
/** Horizontal face indices shared with the mesher: +X, -X, +Z, -Z. */
export type HorizontalFace = 0 | 1 | 4 | 5

/** Tool categories that can speed up or gate block breaking. */
export type ToolType = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword'

/** Atlas tile indices (8x8 grid). */
export const TILE = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, SAND: 4, SNOW: 5,
  LOG_SIDE: 6, LOG_TOP: 7, LEAVES: 8, GRAVEL: 9, BEDROCK: 10, PLANKS: 11,
  TALLGRASS: 12, FLOWER_Y: 13, FLOWER_R: 14, PINELOG: 15, PINELEAVES: 16, WATER: 17,
  PINELOG_TOP: 18, COBBLESTONE: 19, COAL_ORE: 20, IRON_ORE: 21, GOLD_ORE: 22,
  DIAMOND_ORE: 23, GLASS: 24, BRICKS: 25, TORCH: 26, CRAFTING_SIDE: 27,
  CRAFTING_TOP: 28, CRAFTING_FRONT: 29, FURNACE_SIDE: 30, FURNACE_FRONT: 31,
  CHEST_SIDE: 32, CHEST_TOP: 33, CHEST_FRONT: 34, FURNACE_FRONT_LIT: 35,
  FARMLAND_DRY: 36, FARMLAND_WET: 37,
  WHEAT_0: 38, WHEAT_1: 39, WHEAT_2: 40, WHEAT_3: 41,
  WHEAT_4: 42, WHEAT_5: 43, WHEAT_6: 44, WHEAT_7: 45,
  SUGARCANE: 46, MUSHROOM_BROWN: 47, MUSHROOM_RED: 48,
  SAPLING_OAK: 49, SAPLING_SPRUCE: 50,
  LAVA: 51, OBSIDIAN: 52, FIRE: 53,
  TNT_SIDE: 54, TNT_TOP: 55, TNT_BOTTOM: 56,
  BOOKSHELF: 57, ENCHANTING_TOP: 58, ENCHANTING_SIDE: 59, ENCHANTING_BOTTOM: 60,
  WOOL: 61,
  JUNGLE_LOG: 62, JUNGLE_LEAVES: 63, MYCELIUM_TOP: 64, MYCELIUM_SIDE: 65,
  MUSHROOM_STEM: 66, MUSHROOM_CAP_RED: 67, MUSHROOM_CAP_BROWN: 68, MUSHROOM_PORES: 69,
  FERN: 70, MOSSY_COBBLESTONE: 71, SPAWNER: 72,
  STONE_BRICK: 73, STONE_BRICK_MOSSY: 74, STONE_BRICK_CRACKED: 75,
  RAIL: 76, RAIL_CURVED: 77,
  BED_HEAD_TOP: 78, BED_FOOT_TOP: 79, BED_HEAD_END: 80, BED_HEAD_SIDE: 81,
  BED_FOOT_END: 82, BED_FOOT_SIDE: 83,
  SANDSTONE_TOP: 84, SANDSTONE_SIDE: 85, SANDSTONE_BOTTOM: 86,
  END_FRAME_TOP: 87, END_FRAME_SIDE: 88
} as const

export type SoundCategory = 'none' | 'grass' | 'dirt' | 'stone' | 'sand' | 'snow' | 'wood' | 'leaf' | 'cloth'

export interface FaceTiles {
  side: number
  top: number
  bottom: number
  front?: number
  back?: number
}

export interface BlockDefinition {
  readonly id: BlockId
  readonly key: string
  readonly name: string
  readonly tiles: number | FaceTiles
  readonly solid: boolean
  readonly opaque: boolean
  readonly cross: boolean
  /** Classic hardness value; break time derives from it (see Items.breakInfoFor). */
  readonly hardness: number
  /** Tool type that mines this block faster. */
  readonly tool: ToolType | null
  /** When true the block drops nothing unless mined with a good-enough `tool`. */
  readonly requiresTool: boolean
  /** Minimum tool tier that can harvest drops: 0 wood, 1 stone, 2 iron, 3 diamond. */
  readonly miningLevel: number
  readonly sound: SoundCategory
  readonly dropItem: number | null
  readonly hasItem: boolean
  readonly gravity: boolean
  readonly ore: boolean
  readonly lightLevel: number
  readonly hotbarPage: number | null
  readonly hotbarSlot: number | null
}

interface BlockOptions {
  solid?: boolean
  opaque?: boolean
  cross?: boolean
  hardness?: number
  tool?: ToolType
  requiresTool?: boolean
  miningLevel?: number
  sound?: SoundCategory
  dropItem?: number | null
  hasItem?: boolean
  gravity?: boolean
  ore?: boolean
  lightLevel?: number
  hotbarPage?: number
  hotbarSlot?: number
}

function block(
  id: BlockId,
  key: string,
  name: string,
  tiles: number | FaceTiles,
  options: BlockOptions = {}
): BlockDefinition {
  return {
    id,
    key,
    name,
    tiles,
    solid: options.solid ?? true,
    opaque: options.opaque ?? true,
    cross: options.cross ?? false,
    hardness: options.hardness ?? 1,
    tool: options.tool ?? null,
    requiresTool: options.requiresTool ?? false,
    miningLevel: options.miningLevel ?? 0,
    sound: options.sound ?? 'stone',
    dropItem: options.dropItem === undefined ? id : options.dropItem,
    hasItem: options.hasItem ?? true,
    gravity: options.gravity ?? false,
    ore: options.ore ?? false,
    lightLevel: options.lightLevel ?? 0,
    hotbarPage: options.hotbarSlot === undefined ? null : (options.hotbarPage ?? 0),
    hotbarSlot: options.hotbarSlot ?? null
  }
}

const DEFINITIONS: BlockDefinition[] = [
  block(B.AIR, 'air', 'Air', TILE.STONE, {
    solid: false, opaque: false, hardness: Infinity, sound: 'none', dropItem: null, hasItem: false
  }),
  block(B.GRASS, 'grass', 'Grass Block', {
    side: TILE.GRASS_SIDE, top: TILE.GRASS_TOP, bottom: TILE.DIRT
  }, { hardness: 0.6, tool: 'shovel', sound: 'grass', dropItem: B.DIRT, hotbarSlot: 0 }),
  block(B.DIRT, 'dirt', 'Dirt', TILE.DIRT, {
    hardness: 0.5, tool: 'shovel', sound: 'dirt', hotbarSlot: 1
  }),
  block(B.STONE, 'stone', 'Stone', TILE.STONE, {
    hardness: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'stone',
    dropItem: B.COBBLESTONE, hotbarSlot: 2
  }),
  block(B.SAND, 'sand', 'Sand', TILE.SAND, {
    hardness: 0.5, tool: 'shovel', sound: 'sand', gravity: true, hotbarSlot: 3
  }),
  block(B.SNOW, 'snow', 'Snow', TILE.SNOW, {
    hardness: 0.2, tool: 'shovel', sound: 'snow', hotbarSlot: 7
  }),
  block(B.LOG, 'oak_log', 'Oak Log', {
    side: TILE.LOG_SIDE, top: TILE.LOG_TOP, bottom: TILE.LOG_TOP
  }, { hardness: 2, tool: 'axe', sound: 'wood', hotbarSlot: 4 }),
  block(B.LEAVES, 'oak_leaves', 'Oak Leaves', TILE.LEAVES, {
    opaque: false, hardness: 0.2, sound: 'leaf', dropItem: null, hotbarSlot: 6
  }),
  block(B.WATER, 'water', 'Water', TILE.WATER, {
    solid: false, opaque: false, hardness: Infinity, sound: 'none', dropItem: null, hasItem: false
  }),
  block(B.GRAVEL, 'gravel', 'Gravel', TILE.GRAVEL, {
    hardness: 0.6, tool: 'shovel', sound: 'dirt', gravity: true, hotbarSlot: 8
  }),
  block(B.BEDROCK, 'bedrock', 'Bedrock', TILE.BEDROCK, {
    hardness: Infinity, sound: 'stone', dropItem: null, hasItem: false
  }),
  block(B.PLANKS, 'oak_planks', 'Oak Planks', TILE.PLANKS, {
    hardness: 2, tool: 'axe', sound: 'wood', hotbarSlot: 5
  }),
  block(B.TALLGRASS, 'tall_grass', 'Tall Grass', TILE.TALLGRASS, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'leaf', dropItem: null,
    hotbarPage: 2, hotbarSlot: 4
  }),
  block(B.FLOWER_Y, 'dandelion', 'Dandelion', TILE.FLOWER_Y, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'leaf',
    hotbarPage: 2, hotbarSlot: 5
  }),
  block(B.FLOWER_R, 'poppy', 'Poppy', TILE.FLOWER_R, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'leaf',
    hotbarPage: 2, hotbarSlot: 6
  }),
  block(B.PINELOG, 'spruce_log', 'Pine Log', {
    side: TILE.PINELOG, top: TILE.PINELOG_TOP, bottom: TILE.PINELOG_TOP
  }, { hardness: 2, tool: 'axe', sound: 'wood', hotbarPage: 2, hotbarSlot: 2 }),
  block(B.PINELEAVES, 'spruce_leaves', 'Pine Needles', TILE.PINELEAVES, {
    opaque: false, hardness: 0.2, sound: 'leaf', dropItem: null, hotbarPage: 2, hotbarSlot: 3
  }),
  block(B.COBBLESTONE, 'cobblestone', 'Cobblestone', TILE.COBBLESTONE, {
    hardness: 2, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 1, hotbarSlot: 0
  }),
  block(B.COAL_ORE, 'coal_ore', 'Coal Ore', TILE.COAL_ORE, {
    hardness: 3, tool: 'pickaxe', requiresTool: true, sound: 'stone', ore: true,
    dropItem: I.COAL, hotbarPage: 1, hotbarSlot: 1
  }),
  block(B.IRON_ORE, 'iron_ore', 'Iron Ore', TILE.IRON_ORE, {
    hardness: 3, tool: 'pickaxe', requiresTool: true, miningLevel: 1, sound: 'stone', ore: true,
    hotbarPage: 1, hotbarSlot: 2
  }),
  block(B.GOLD_ORE, 'gold_ore', 'Gold Ore', TILE.GOLD_ORE, {
    hardness: 3, tool: 'pickaxe', requiresTool: true, miningLevel: 2, sound: 'stone', ore: true,
    hotbarPage: 1, hotbarSlot: 3
  }),
  block(B.DIAMOND_ORE, 'diamond_ore', 'Diamond Ore', TILE.DIAMOND_ORE, {
    hardness: 3, tool: 'pickaxe', requiresTool: true, miningLevel: 2, sound: 'stone', ore: true,
    dropItem: I.DIAMOND, hotbarPage: 1, hotbarSlot: 4
  }),
  block(B.GLASS, 'glass', 'Glass', TILE.GLASS, {
    opaque: false, hardness: 0.3, sound: 'stone', dropItem: null, hotbarPage: 1, hotbarSlot: 5
  }),
  block(B.BRICKS, 'bricks', 'Bricks', TILE.BRICKS, {
    hardness: 2, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 1, hotbarSlot: 6
  }),
  block(B.TORCH, 'torch', 'Torch', TILE.TORCH, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'wood', lightLevel: 14,
    hotbarPage: 2, hotbarSlot: 1
  }),
  block(B.CRAFTING_TABLE, 'crafting_table', 'Crafting Table', {
    side: TILE.CRAFTING_SIDE, top: TILE.CRAFTING_TOP, bottom: TILE.PLANKS,
    front: TILE.CRAFTING_FRONT
  }, { hardness: 2.5, tool: 'axe', sound: 'wood', hotbarPage: 1, hotbarSlot: 7 }),
  block(B.FURNACE, 'furnace', 'Furnace', {
    side: TILE.FURNACE_SIDE, top: TILE.STONE, bottom: TILE.STONE,
    front: TILE.FURNACE_FRONT
  }, { hardness: 3.5, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 1, hotbarSlot: 8 }),
  block(B.CHEST, 'chest', 'Chest', {
    side: TILE.CHEST_SIDE, top: TILE.CHEST_TOP, bottom: TILE.CHEST_TOP,
    front: TILE.CHEST_FRONT
  }, { opaque: false, hardness: 2.5, tool: 'axe', sound: 'wood', hotbarPage: 2, hotbarSlot: 0 }),
  block(B.FURNACE_LIT, 'furnace_lit', 'Furnace', {
    side: TILE.FURNACE_SIDE, top: TILE.STONE, bottom: TILE.STONE,
    front: TILE.FURNACE_FRONT_LIT
  }, {
    hardness: 3.5, tool: 'pickaxe', requiresTool: true, sound: 'stone',
    dropItem: B.FURNACE, hasItem: false, lightLevel: 13
  }),
  block(B.FARMLAND_DRY, 'farmland_dry', 'Farmland', {
    side: TILE.DIRT, top: TILE.FARMLAND_DRY, bottom: TILE.DIRT
  }, { hardness: 0.6, tool: 'shovel', sound: 'dirt', dropItem: B.DIRT, hasItem: false }),
  block(B.FARMLAND_WET, 'farmland_wet', 'Hydrated Farmland', {
    side: TILE.DIRT, top: TILE.FARMLAND_WET, bottom: TILE.DIRT
  }, { hardness: 0.6, tool: 'shovel', sound: 'dirt', dropItem: B.DIRT, hasItem: false }),
  ...([
    [B.WHEAT_0, TILE.WHEAT_0], [B.WHEAT_1, TILE.WHEAT_1],
    [B.WHEAT_2, TILE.WHEAT_2], [B.WHEAT_3, TILE.WHEAT_3],
    [B.WHEAT_4, TILE.WHEAT_4], [B.WHEAT_5, TILE.WHEAT_5],
    [B.WHEAT_6, TILE.WHEAT_6], [B.WHEAT_7, TILE.WHEAT_7]
  ] as const).map(([id, tile], age) => block(id, `wheat_${age}`, 'Wheat Crops', tile, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'grass',
    dropItem: null, hasItem: false
  })),
  block(B.SUGARCANE, 'sugar_cane', 'Sugar Cane', TILE.SUGARCANE, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'grass',
    hotbarPage: 3, hotbarSlot: 0
  }),
  block(B.MUSHROOM_BROWN, 'brown_mushroom', 'Brown Mushroom', TILE.MUSHROOM_BROWN, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'grass',
    hotbarPage: 3, hotbarSlot: 1
  }),
  block(B.MUSHROOM_RED, 'red_mushroom', 'Red Mushroom', TILE.MUSHROOM_RED, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'grass',
    hotbarPage: 3, hotbarSlot: 2
  }),
  block(B.SAPLING_OAK, 'oak_sapling', 'Oak Sapling', TILE.SAPLING_OAK, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'grass',
    hotbarPage: 3, hotbarSlot: 3
  }),
  block(B.SAPLING_SPRUCE, 'spruce_sapling', 'Spruce Sapling', TILE.SAPLING_SPRUCE, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'grass',
    hotbarPage: 3, hotbarSlot: 4
  }),
  ...([B.WATER_1, B.WATER_2, B.WATER_3, B.WATER_4, B.WATER_5, B.WATER_6, B.WATER_7] as const)
    .map((id, index) => block(id, `water_${index + 1}`, 'Flowing Water', TILE.WATER, {
      solid: false, opaque: false, hardness: Infinity, sound: 'none', dropItem: null, hasItem: false
    })),
  block(B.LAVA, 'lava', 'Lava', TILE.LAVA, {
    solid: false, opaque: false, hardness: Infinity, sound: 'none', dropItem: null,
    hasItem: false, lightLevel: 15
  }),
  ...([B.LAVA_1, B.LAVA_2, B.LAVA_3, B.LAVA_4, B.LAVA_5, B.LAVA_6, B.LAVA_7] as const)
    .map((id, index) => block(id, `lava_${index + 1}`, 'Flowing Lava', TILE.LAVA, {
      solid: false, opaque: false, hardness: Infinity, sound: 'none', dropItem: null,
      hasItem: false, lightLevel: 15
    })),
  block(B.OBSIDIAN, 'obsidian', 'Obsidian', TILE.OBSIDIAN, {
    hardness: 50, tool: 'pickaxe', requiresTool: true, miningLevel: 3, sound: 'stone',
    hotbarPage: 3, hotbarSlot: 5
  }),
  block(B.FIRE, 'fire', 'Fire', TILE.FIRE, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'none', dropItem: null,
    hasItem: false, lightLevel: 15
  }),
  block(B.TNT, 'tnt', 'TNT', {
    side: TILE.TNT_SIDE, top: TILE.TNT_TOP, bottom: TILE.TNT_BOTTOM
  }, { hardness: 0, sound: 'grass', hotbarPage: 3, hotbarSlot: 6 }),
  block(B.PRIMED_TNT, 'primed_tnt', 'Primed TNT', {
    side: TILE.TNT_SIDE, top: TILE.TNT_TOP, bottom: TILE.TNT_BOTTOM
  }, { solid: false, opaque: false, hardness: Infinity, sound: 'none', dropItem: null, hasItem: false }),
  block(B.BOOKSHELF, 'bookshelf', 'Bookshelf', TILE.BOOKSHELF, {
    hardness: 1.5, tool: 'axe', sound: 'wood', dropItem: null, hotbarPage: 3, hotbarSlot: 7
  }),
  block(B.ENCHANTING_TABLE, 'enchanting_table', 'Enchanting Table', {
    side: TILE.ENCHANTING_SIDE, top: TILE.ENCHANTING_TOP, bottom: TILE.ENCHANTING_BOTTOM
  }, {
    opaque: false, hardness: 5, tool: 'pickaxe', requiresTool: true, miningLevel: 0,
    sound: 'stone', hotbarPage: 3, hotbarSlot: 8
  }),
  block(B.WOOL, 'wool', 'Wool', TILE.WOOL, {
    hardness: 0.8, sound: 'cloth', hotbarPage: 4, hotbarSlot: 0
  }),
  block(B.JUNGLE_LOG, 'jungle_log', 'Jungle Log', {
    side: TILE.JUNGLE_LOG, top: TILE.LOG_TOP, bottom: TILE.LOG_TOP
  }, { hardness: 2, tool: 'axe', sound: 'wood', hotbarPage: 4, hotbarSlot: 1 }),
  block(B.JUNGLE_LEAVES, 'jungle_leaves', 'Jungle Leaves', TILE.JUNGLE_LEAVES, {
    opaque: false, hardness: 0.2, sound: 'leaf', dropItem: null, hotbarPage: 4, hotbarSlot: 2
  }),
  block(B.MYCELIUM, 'mycelium', 'Mycelium', {
    side: TILE.MYCELIUM_SIDE, top: TILE.MYCELIUM_TOP, bottom: TILE.DIRT
  }, { hardness: 0.6, tool: 'shovel', sound: 'grass', dropItem: B.DIRT, hotbarPage: 4, hotbarSlot: 3 }),
  block(B.MUSHROOM_STEM, 'mushroom_stem', 'Mushroom Stem', TILE.MUSHROOM_STEM, {
    hardness: 0.2, tool: 'axe', sound: 'wood', dropItem: null, hotbarPage: 4, hotbarSlot: 4
  }),
  block(B.MUSHROOM_CAP_RED, 'mushroom_cap_red', 'Red Mushroom Cap', {
    side: TILE.MUSHROOM_CAP_RED, top: TILE.MUSHROOM_CAP_RED, bottom: TILE.MUSHROOM_PORES
  }, { hardness: 0.2, tool: 'axe', sound: 'wood', dropItem: B.MUSHROOM_RED, hotbarPage: 4, hotbarSlot: 5 }),
  block(B.MUSHROOM_CAP_BROWN, 'mushroom_cap_brown', 'Brown Mushroom Cap', {
    side: TILE.MUSHROOM_CAP_BROWN, top: TILE.MUSHROOM_CAP_BROWN, bottom: TILE.MUSHROOM_PORES
  }, { hardness: 0.2, tool: 'axe', sound: 'wood', dropItem: B.MUSHROOM_BROWN, hotbarPage: 4, hotbarSlot: 6 }),
  block(B.FERN, 'fern', 'Fern', TILE.FERN, {
    solid: false, opaque: false, cross: true, hardness: 0, sound: 'leaf', dropItem: null,
    hotbarPage: 4, hotbarSlot: 7
  }),
  block(B.MOSSY_COBBLESTONE, 'mossy_cobblestone', 'Mossy Cobblestone', TILE.MOSSY_COBBLESTONE, {
    hardness: 2, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 4, hotbarSlot: 8
  }),
  block(B.SPAWNER, 'spawner', 'Monster Spawner', TILE.SPAWNER, {
    hardness: 5, tool: 'pickaxe', requiresTool: true, sound: 'stone', dropItem: null,
    hotbarPage: 5, hotbarSlot: 6
  }),
  block(B.STONE_BRICK, 'stone_brick', 'Stone Bricks', TILE.STONE_BRICK, {
    hardness: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 5, hotbarSlot: 0
  }),
  block(B.STONE_BRICK_MOSSY, 'stone_brick_mossy', 'Mossy Stone Bricks', TILE.STONE_BRICK_MOSSY, {
    hardness: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 5, hotbarSlot: 1
  }),
  block(B.STONE_BRICK_CRACKED, 'stone_brick_cracked', 'Cracked Stone Bricks', TILE.STONE_BRICK_CRACKED, {
    hardness: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 5, hotbarSlot: 2
  }),
  block(B.RAIL, 'rail', 'Rail', TILE.RAIL, {
    solid: false, opaque: false, hardness: 0.7, sound: 'stone', hotbarPage: 5, hotbarSlot: 5
  }),
  block(B.BED_FOOT, 'bed_foot', 'Bed', {
    side: TILE.BED_FOOT_SIDE, top: TILE.BED_FOOT_TOP, bottom: TILE.PLANKS,
    back: TILE.BED_FOOT_END
  }, { opaque: false, hardness: 0.2, sound: 'wood', dropItem: null, hasItem: false }),
  block(B.BED_HEAD, 'bed_head', 'Bed', {
    side: TILE.BED_HEAD_SIDE, top: TILE.BED_HEAD_TOP, bottom: TILE.PLANKS,
    front: TILE.BED_HEAD_END
  }, { opaque: false, hardness: 0.2, sound: 'wood', dropItem: null, hasItem: false }),
  block(B.SANDSTONE, 'sandstone', 'Sandstone', {
    side: TILE.SANDSTONE_SIDE, top: TILE.SANDSTONE_TOP, bottom: TILE.SANDSTONE_BOTTOM
  }, { hardness: 0.8, tool: 'pickaxe', requiresTool: true, sound: 'stone', hotbarPage: 5, hotbarSlot: 3 }),
  block(B.END_PORTAL_FRAME, 'end_portal_frame', 'End Portal Frame', {
    side: TILE.END_FRAME_SIDE, top: TILE.END_FRAME_TOP, bottom: TILE.SANDSTONE_BOTTOM
  }, { hardness: Infinity, sound: 'stone', dropItem: null, hotbarPage: 5, hotbarSlot: 4 })
]

const BLOCK_COUNT = Math.max(...Object.values(B)) + 1

export const BLOCKS: readonly BlockDefinition[] = (() => {
  const byId = new Array<BlockDefinition>(BLOCK_COUNT)
  for (const definition of DEFINITIONS) {
    if (byId[definition.id]) throw new Error(`Duplicate block id ${definition.id}`)
    byId[definition.id] = Object.freeze(definition)
  }
  for (let id = 0; id < byId.length; id++) {
    if (!byId[id]) throw new Error(`Block registry is missing id ${id}`)
  }
  return Object.freeze(byId)
})()

/** Compatibility views derived from the registry for the current renderer/gameplay code. */
export const NAMES: readonly string[] = BLOCKS.map(definition => definition.name)
export const SOLID: readonly boolean[] = BLOCKS.map(definition => definition.solid)
export const OPAQUE: readonly boolean[] = BLOCKS.map(definition => definition.opaque)
export const CROSS: readonly boolean[] = BLOCKS.map(definition => definition.cross)
export const SOUND_CAT: readonly SoundCategory[] = BLOCKS.map(definition => definition.sound)
export const GRAVITY: readonly boolean[] = BLOCKS.map(definition => definition.gravity)
export const ORE: readonly boolean[] = BLOCKS.map(definition => definition.ore)
export const LIGHT_LEVEL: readonly number[] = BLOCKS.map(definition => definition.lightLevel)

export const WHEAT_STAGES: readonly number[] = Object.freeze([
  B.WHEAT_0, B.WHEAT_1, B.WHEAT_2, B.WHEAT_3,
  B.WHEAT_4, B.WHEAT_5, B.WHEAT_6, B.WHEAT_7
])

export function isWheat(id: number): boolean {
  return id >= B.WHEAT_0 && id <= B.WHEAT_7
}

export function wheatAge(id: number): number {
  return isWheat(id) ? id - B.WHEAT_0 : -1
}

export function isFarmingPlant(id: number): boolean {
  return isWheat(id) || id === B.SUGARCANE || id === B.MUSHROOM_BROWN ||
    id === B.MUSHROOM_RED || id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE
}

export type FluidKind = 'water' | 'lava'

export function isWater(id: number): boolean {
  return id === B.WATER || (id >= B.WATER_1 && id <= B.WATER_7)
}

export function isLava(id: number): boolean {
  return id === B.LAVA || (id >= B.LAVA_1 && id <= B.LAVA_7)
}

export function isFluid(id: number): boolean { return isWater(id) || isLava(id) }

/** Source blocks have level 0; progressively thinner flows use levels 1..7. */
export function fluidLevel(id: number): number {
  if (id === B.WATER || id === B.LAVA) return 0
  if (id >= B.WATER_1 && id <= B.WATER_7) return id - B.WATER_1 + 1
  if (id >= B.LAVA_1 && id <= B.LAVA_7) return id - B.LAVA
  return -1
}

export function fluidKind(id: number): FluidKind | null {
  return isWater(id) ? 'water' : isLava(id) ? 'lava' : null
}

export function fluidBlock(kind: FluidKind, level: number): number {
  const clamped = Math.max(0, Math.min(7, Math.floor(level)))
  if (kind === 'water') return clamped === 0 ? B.WATER : B.WATER_1 + clamped - 1
  return B.LAVA + clamped
}

export function isFlammable(id: number): boolean {
  return id === B.LOG || id === B.PINELOG || id === B.JUNGLE_LOG || id === B.LEAVES ||
    id === B.PINELEAVES || id === B.JUNGLE_LEAVES ||
    id === B.PLANKS || id === B.CRAFTING_TABLE || id === B.CHEST || id === B.BOOKSHELF ||
    id === B.TNT || id === B.WOOL
}

export function isLeafBlock(id: number): boolean {
  return id === B.LEAVES || id === B.PINELEAVES || id === B.JUNGLE_LEAVES
}

export function isBedBlock(id: number): boolean {
  return id === B.BED_FOOT || id === B.BED_HEAD
}

const HOTBAR_PAGE_COUNT = Math.max(...BLOCKS.map(definition => definition.hotbarPage ?? 0)) + 1
export const HOTBAR_PAGES: readonly (readonly number[])[] = Object.freeze(
  Array.from({ length: HOTBAR_PAGE_COUNT }, (_, page) => Object.freeze(
    BLOCKS
      .filter(definition => definition.hotbarPage === page)
      .sort((a, b) => (a.hotbarSlot ?? 0) - (b.hotbarSlot ?? 0))
      .map(definition => definition.id)
  ))
)
export const HOTBAR: readonly number[] = HOTBAR_PAGES[0]

export function isValidBlockId(id: unknown): id is BlockId {
  return Number.isInteger(id) && (id as number) >= 0 && (id as number) < BLOCKS.length
}

/** Blocks that carry container data (chest contents, furnace state). */
export function isContainerBlock(id: number): boolean {
  return id === B.CHEST || id === B.FURNACE || id === B.FURNACE_LIT
}

export function isDirectionalBlock(id: number): boolean {
  return id === B.CHEST || id === B.FURNACE || id === B.FURNACE_LIT ||
    id === B.BED_FOOT || id === B.BED_HEAD
}

export function isHorizontalFace(face: unknown): face is HorizontalFace {
  return face === 0 || face === 1 || face === 4 || face === 5
}

export function oppositeHorizontalFace(face: HorizontalFace): HorizontalFace {
  if (face === 0) return 1
  if (face === 1) return 0
  if (face === 4) return 5
  return 4
}

/** Faces: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. */
export function tileFor(id: BlockId, face: number, facing: HorizontalFace = 4): number {
  const tiles = BLOCKS[id]?.tiles ?? TILE.STONE
  if (typeof tiles === 'number') return tiles
  if (face === 2) return tiles.top
  if (face === 3) return tiles.bottom
  if (face === facing && tiles.front !== undefined) return tiles.front
  if (face === oppositeHorizontalFace(facing) && tiles.back !== undefined) return tiles.back
  return tiles.side
}
