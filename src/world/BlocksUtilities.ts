import { I } from './ItemIds'
import { B, BlockId, HorizontalFace, ToolType, TILE, SoundCategory, BlockRenderShape, DropRange, FortuneMode, FaceTiles, BlockDefinition, BlockOptions, block, DEFINITIONS, BLOCK_COUNT, BLOCKS, NAMES, SOLID, OPAQUE, CROSS, RENDER_SHAPE, SOUND_CAT, GRAVITY, ORE, LIGHT_LEVEL } from './BlocksDefinitions'

export interface BlockCollisionBox {
  readonly minX: number; readonly minY: number; readonly minZ: number
  readonly maxX: number; readonly maxY: number; readonly maxZ: number
}
export const FULL_COLLISION_BOX: BlockCollisionBox = Object.freeze({
  minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1
})
export const CACTUS_COLLISION_BOX: BlockCollisionBox = Object.freeze({
  minX: 1 / 16, minY: 0, minZ: 1 / 16,
  maxX: 15 / 16, maxY: 1, maxZ: 15 / 16
})
export const LILY_COLLISION_BOX: BlockCollisionBox = Object.freeze({
  minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1 / 64, maxZ: 1
})
export const BED_COLLISION_BOX: BlockCollisionBox = Object.freeze({
  minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 9 / 16, maxZ: 1
})
export const CHEST_COLLISION_BOX: BlockCollisionBox = Object.freeze({
  minX: 1 / 16, minY: 0, minZ: 1 / 16,
  maxX: 15 / 16, maxY: 14 / 16, maxZ: 15 / 16
})
export function doorCollisionBox(id: number, facing: HorizontalFace = 4): BlockCollisionBox {
  const openFacing: Record<HorizontalFace, HorizontalFace> = { 0: 5, 1: 4, 4: 0, 5: 1 }
  const planeFacing = isDoorOpen(id) ? openFacing[facing] : facing
  const thickness = 3 / 16
  if (planeFacing === 0) return { minX: 1 - thickness, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }
  if (planeFacing === 1) return { minX: 0, minY: 0, minZ: 0, maxX: thickness, maxY: 1, maxZ: 1 }
  if (planeFacing === 4) return { minX: 0, minY: 0, minZ: 1 - thickness, maxX: 1, maxY: 1, maxZ: 1 }
  return { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: thickness }
}
export function blockCollisionBox(id: number, facing: HorizontalFace = 4): BlockCollisionBox | null {
  if (isDoorBlock(id)) return doorCollisionBox(id, facing)
  if (isBedBlock(id)) return BED_COLLISION_BOX
  if (id === B.CHEST) return CHEST_COLLISION_BOX
  if (id === B.CACTUS) return CACTUS_COLLISION_BOX
  if (id === B.WATER_LILY) return LILY_COLLISION_BOX
  return SOLID[id] && !CROSS[id] ? FULL_COLLISION_BOX : null
}
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
    id === B.MUSHROOM_RED || id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE ||
    id === B.SAPLING_BIRCH
}
export type FluidKind = 'water' | 'lava'
export function isWater(id: number): boolean {
  return id === B.WATER || (id >= B.WATER_1 && id <= B.WATER_7)
}
export function isLava(id: number): boolean {
  return id === B.LAVA || (id >= B.LAVA_1 && id <= B.LAVA_7)
}
export function isFluid(id: number): boolean { return isWater(id) || isLava(id) }
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
  return isLogBlock(id) || isLeafBlock(id) || id === B.VINE || id === B.DEAD_BUSH ||
    id === B.PLANKS || id === B.CRAFTING_TABLE || id === B.CHEST || id === B.BOOKSHELF ||
    id === B.TNT || isWoolBlock(id) || isDoorBlock(id)
}
export const WOOL_BLOCKS: readonly BlockId[] = Object.freeze([
  B.WOOL,
  B.WOOL_ORANGE, B.WOOL_MAGENTA, B.WOOL_LIGHT_BLUE, B.WOOL_YELLOW,
  B.WOOL_LIME, B.WOOL_PINK, B.WOOL_GRAY, B.WOOL_LIGHT_GRAY,
  B.WOOL_CYAN, B.WOOL_PURPLE, B.WOOL_BLUE, B.WOOL_BROWN,
  B.WOOL_GREEN, B.WOOL_RED, B.WOOL_BLACK
])
export function woolBlockForColor(color: number): BlockId {
  if (!Number.isInteger(color) || color < 0 || color >= WOOL_BLOCKS.length) {
    throw new RangeError(`Invalid wool color ${color}; expected an integer from 0 to 15`)
  }
  return WOOL_BLOCKS[color]
}
export function woolColorForBlock(id: number): number | null {
  const color = WOOL_BLOCKS.indexOf(id)
  return color < 0 ? null : color
}
export function isWoolBlock(id: number): boolean {
  return woolColorForBlock(id) !== null
}
export function isLogBlock(id: number): boolean {
  return id === B.LOG || id === B.PINELOG || id === B.JUNGLE_LOG || id === B.BIRCH_LOG
}
export function isLeafBlock(id: number): boolean {
  return id === B.LEAVES || id === B.PINELEAVES || id === B.JUNGLE_LEAVES || id === B.BIRCH_LEAVES
}
export function canSupportVine(id: number): boolean {
  return !!SOLID[id] && !!OPAQUE[id] && RENDER_SHAPE[id] === 'cube' &&
    id !== B.CHEST && !isBedBlock(id) && !isDoorBlock(id)
}
export function isBedBlock(id: number): boolean {
  return id === B.BED_FOOT || id === B.BED_HEAD
}
export function isDoorBlock(id: number): boolean {
  return id === B.WOOD_DOOR_LOWER || id === B.WOOD_DOOR_UPPER ||
    id === B.WOOD_DOOR_LOWER_OPEN || id === B.WOOD_DOOR_UPPER_OPEN
}
export function isDoorOpen(id: number): boolean {
  return id === B.WOOD_DOOR_LOWER_OPEN || id === B.WOOD_DOOR_UPPER_OPEN
}
export function isDoorUpper(id: number): boolean {
  return id === B.WOOD_DOOR_UPPER || id === B.WOOD_DOOR_UPPER_OPEN
}
export function isSilverfishInfestable(id: number): boolean {
  return infestedBlockFor(id) !== null
}
export function infestedBlockFor(id: number): BlockId | null {
  if (id === B.STONE) return B.INFESTED_STONE
  if (id === B.COBBLESTONE) return B.INFESTED_COBBLESTONE
  if (id === B.STONE_BRICK || id === B.STONE_BRICK_MOSSY || id === B.STONE_BRICK_CRACKED) {
    return B.INFESTED_STONE_BRICK
  }
  return null
}
export function isInfestedBlock(id: number): boolean {
  return id === B.INFESTED_STONE || id === B.INFESTED_COBBLESTONE ||
    id === B.INFESTED_STONE_BRICK
}
export const HOTBAR_PAGE_COUNT = Math.max(...BLOCKS.map(definition => definition.hotbarPage ?? 0)) + 1
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
export function isContainerBlock(id: number): boolean {
  return id === B.CHEST || id === B.FURNACE || id === B.FURNACE_LIT
}
export function isDirectionalBlock(id: number): boolean {
  return id === B.CHEST || id === B.FURNACE || id === B.FURNACE_LIT ||
    id === B.BED_FOOT || id === B.BED_HEAD || id === B.VINE || isDoorBlock(id)
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
export function tileFor(id: BlockId, face: number, facing: HorizontalFace = 4): number {
  const tiles = BLOCKS[id]?.tiles ?? TILE.STONE
  if (typeof tiles === 'number') return tiles
  if (face === 2) return tiles.top
  if (face === 3) return tiles.bottom
  if (face === facing && tiles.front !== undefined) return tiles.front
  if (face === oppositeHorizontalFace(facing) && tiles.back !== undefined) return tiles.back
  return tiles.side
}
