/**
 * Stable ids for items that are not placeable blocks. The numbering follows
 * classic Minecraft 1.2.4 item ids so saved inventories stay meaningful and
 * future stages (furnace, food, combat) can extend the same ranges.
 * Block items keep sharing the block id range 0..255.
 */
export const I = {
  IRON_SHOVEL: 256,
  IRON_PICKAXE: 257,
  IRON_AXE: 258,
  COAL: 263,
  DIAMOND: 264,
  IRON_INGOT: 265,
  GOLD_INGOT: 266,
  IRON_SWORD: 267,
  WOODEN_SWORD: 268,
  WOODEN_SHOVEL: 269,
  WOODEN_PICKAXE: 270,
  WOODEN_AXE: 271,
  STONE_SWORD: 272,
  STONE_SHOVEL: 273,
  STONE_PICKAXE: 274,
  STONE_AXE: 275,
  DIAMOND_SWORD: 276,
  DIAMOND_SHOVEL: 277,
  DIAMOND_PICKAXE: 278,
  DIAMOND_AXE: 279,
  STICK: 280,
  GOLDEN_SWORD: 283,
  GOLDEN_SHOVEL: 284,
  GOLDEN_PICKAXE: 285,
  GOLDEN_AXE: 286,
  WOODEN_HOE: 290,
  STONE_HOE: 291,
  IRON_HOE: 292,
  DIAMOND_HOE: 293,
  GOLDEN_HOE: 294
} as const

export type ItemId = number
