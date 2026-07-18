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
  FURNACE_LIT: 28
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
  CHEST_SIDE: 32, CHEST_TOP: 33, CHEST_FRONT: 34, FURNACE_FRONT_LIT: 35
} as const

export type SoundCategory = 'none' | 'grass' | 'dirt' | 'stone' | 'sand' | 'snow' | 'wood' | 'leaf'

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
  })
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
  return id === B.CHEST || id === B.FURNACE || id === B.FURNACE_LIT
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
