import { B, WOOL_BLOCKS } from './Blocks'
import { I } from './ItemIds'
import type { ItemStack } from '../player/Inventory'

/**
 * Recipe data book for the classic 1.2.4 progression: planks, sticks,
 * crafting table, furnace, chest, torches and all five tool sets in five
 * materials. Shaped patterns are matched inside the crafting grid bounding
 * box with optional mirroring, so a 2x2 recipe works anywhere in the 3x3
 * bench and asymmetric tools (axe, hoe) match both orientations.
 */

/** One required item: a single id or an "any of" group (e.g. both log types). */
export type Ingredient = number | readonly number[]

export interface RecipeResult {
  readonly id: number
  readonly count: number
}

export interface ShapedRecipe {
  readonly kind: 'shaped'
  /** Rows of key characters; a space means "must be empty". */
  readonly pattern: readonly string[]
  readonly keys: Readonly<Record<string, Ingredient>>
  readonly result: RecipeResult
}

export interface ShapelessRecipe {
  readonly kind: 'shapeless'
  readonly ingredients: readonly Ingredient[]
  readonly result: RecipeResult
}

export type Recipe = ShapedRecipe | ShapelessRecipe

function shaped(pattern: readonly string[], keys: Record<string, Ingredient>, id: number, count = 1): ShapedRecipe {
  return { kind: 'shaped', pattern, keys, result: { id, count } }
}

function shapeless(ingredients: readonly Ingredient[], id: number, count = 1): ShapelessRecipe {
  return { kind: 'shapeless', ingredients, result: { id, count } }
}

const ANY_LOG: Ingredient = [B.LOG, B.PINELOG, B.JUNGLE_LOG, B.BIRCH_LOG]
/** Every metadata-free wool color is interchangeable in generic cloth recipes. */
export const ANY_WOOL: Ingredient = WOOL_BLOCKS

interface ToolMaterial {
  readonly item: Ingredient
  readonly sword: number
  readonly shovel: number
  readonly pickaxe: number
  readonly axe: number
  readonly hoe: number
}

interface ArmorMaterial {
  readonly item: Ingredient
  readonly helmet: number
  readonly chestplate: number
  readonly leggings: number
  readonly boots: number
}

const TOOL_MATERIALS: readonly ToolMaterial[] = [
  { item: B.PLANKS, sword: I.WOODEN_SWORD, shovel: I.WOODEN_SHOVEL, pickaxe: I.WOODEN_PICKAXE, axe: I.WOODEN_AXE, hoe: I.WOODEN_HOE },
  { item: B.COBBLESTONE, sword: I.STONE_SWORD, shovel: I.STONE_SHOVEL, pickaxe: I.STONE_PICKAXE, axe: I.STONE_AXE, hoe: I.STONE_HOE },
  { item: I.IRON_INGOT, sword: I.IRON_SWORD, shovel: I.IRON_SHOVEL, pickaxe: I.IRON_PICKAXE, axe: I.IRON_AXE, hoe: I.IRON_HOE },
  { item: I.DIAMOND, sword: I.DIAMOND_SWORD, shovel: I.DIAMOND_SHOVEL, pickaxe: I.DIAMOND_PICKAXE, axe: I.DIAMOND_AXE, hoe: I.DIAMOND_HOE },
  { item: I.GOLD_INGOT, sword: I.GOLDEN_SWORD, shovel: I.GOLDEN_SHOVEL, pickaxe: I.GOLDEN_PICKAXE, axe: I.GOLDEN_AXE, hoe: I.GOLDEN_HOE }
]

const ARMOR_MATERIALS: readonly ArmorMaterial[] = [
  { item: I.LEATHER, helmet: I.LEATHER_HELMET, chestplate: I.LEATHER_CHESTPLATE, leggings: I.LEATHER_LEGGINGS, boots: I.LEATHER_BOOTS },
  { item: I.IRON_INGOT, helmet: I.IRON_HELMET, chestplate: I.IRON_CHESTPLATE, leggings: I.IRON_LEGGINGS, boots: I.IRON_BOOTS },
  { item: I.DIAMOND, helmet: I.DIAMOND_HELMET, chestplate: I.DIAMOND_CHESTPLATE, leggings: I.DIAMOND_LEGGINGS, boots: I.DIAMOND_BOOTS },
  { item: I.GOLD_INGOT, helmet: I.GOLDEN_HELMET, chestplate: I.GOLDEN_CHESTPLATE, leggings: I.GOLDEN_LEGGINGS, boots: I.GOLDEN_BOOTS }
]

export const RECIPES: readonly Recipe[] = [
  shapeless([ANY_LOG], B.PLANKS, 4),
  shaped(['P', 'P'], { P: B.PLANKS }, I.STICK, 4),
  shaped(['PP', 'PP'], { P: B.PLANKS }, B.CRAFTING_TABLE),
  shaped(['CCC', 'C C', 'CCC'], { C: B.COBBLESTONE }, B.FURNACE),
  shaped(['PPP', 'P P', 'PPP'], { P: B.PLANKS }, B.CHEST),
  shaped(['PP', 'PP', 'PP'], { P: B.PLANKS }, B.WOOD_DOOR_LOWER),
  shaped(['C', 'S'], { C: I.COAL, S: I.STICK }, B.TORCH, 4),
  shaped(['P P', ' P '], { P: B.PLANKS }, I.BOWL, 4),
  shaped(['WWW'], { W: I.WHEAT }, I.BREAD),
  shapeless([B.MUSHROOM_BROWN, B.MUSHROOM_RED, I.BOWL], I.MUSHROOM_STEW),
  shapeless([B.SUGARCANE], I.SUGAR),
  shaped(['SSS'], { S: B.SUGARCANE }, I.PAPER, 3),
  shaped(['P', 'P', 'P'], { P: I.PAPER }, I.BOOK),
  shaped(['PPP', 'BBB', 'PPP'], { P: B.PLANKS, B: I.BOOK }, B.BOOKSHELF),
  shaped([' B ', 'DOD', 'OOO'], { B: I.BOOK, D: I.DIAMOND, O: B.OBSIDIAN }, B.ENCHANTING_TABLE),
  shapeless([I.BONE], I.BONE_MEAL, 3),
  shaped([' ST', 'S T', ' ST'], { S: I.STICK, T: I.STRING }, I.BOW),
  shaped(['F', 'S', 'T'], { F: I.FLINT, S: I.STICK, T: I.FEATHER }, I.ARROW, 4),
  shaped(['I I', ' I '], { I: I.IRON_INGOT }, I.BUCKET),
  shaped([' I', 'I '], { I: I.IRON_INGOT }, I.SHEARS),
  shapeless([I.IRON_INGOT, I.FLINT], I.FLINT_AND_STEEL),
  shaped(['GSG', 'SGS', 'GSG'], { G: I.GUNPOWDER, S: B.SAND }, B.TNT),
  shaped(['SS', 'SS'], { S: I.STRING }, B.WOOL),
  shaped(['WWW', 'PPP'], { W: ANY_WOOL, P: B.PLANKS }, I.BED),
  shaped(['SS', 'SS'], { S: B.STONE }, B.STONE_BRICK, 4),
  shaped(['SS', 'SS'], { S: B.SAND }, B.SANDSTONE),
  shaped(['CC', 'CC'], { C: I.CLAY_BALL }, B.CLAY),
  shaped(['BB', 'BB'], { B: I.BRICK }, B.BRICKS),
  shaped(['I I', 'ISI', 'I I'], { I: I.IRON_INGOT, S: I.STICK }, B.RAIL, 16),
  shaped([' I ', 'IRI', ' I '], { I: I.IRON_INGOT, R: I.REDSTONE }, I.COMPASS),
  shaped([' G ', 'GRG', ' G '], { G: I.GOLD_INGOT, R: I.REDSTONE }, I.CLOCK),
  shaped(['PPP', 'PCP', 'PPP'], { P: I.PAPER, C: I.COMPASS }, I.MAP),
  ...TOOL_MATERIALS.flatMap(m => [
    shaped(['M', 'M', 'S'], { M: m.item, S: I.STICK }, m.sword),
    shaped(['M', 'S', 'S'], { M: m.item, S: I.STICK }, m.shovel),
    shaped(['MMM', ' S ', ' S '], { M: m.item, S: I.STICK }, m.pickaxe),
    shaped(['MM', 'MS', ' S'], { M: m.item, S: I.STICK }, m.axe),
    shaped(['MM', ' S', ' S'], { M: m.item, S: I.STICK }, m.hoe)
  ]),
  ...ARMOR_MATERIALS.flatMap(m => [
    shaped(['MMM', 'M M'], { M: m.item }, m.helmet),
    shaped(['M M', 'MMM', 'MMM'], { M: m.item }, m.chestplate),
    shaped(['MMM', 'M M', 'M M'], { M: m.item }, m.leggings),
    shaped(['M M', 'M M'], { M: m.item }, m.boots)
  ])
]

/**
 * Furnace data, classic 1.2.4 values converted from ticks to seconds:
 * every item smelts in 10s, coal burns for 80s (8 items), wooden blocks
 * for 15s, sticks for 5s and wooden tools for 10s. Food recipes join the
 * list is intentionally mineral-focused; stage 6 food is crafted and eaten.
 */
export const FURNACE_SMELT_SECONDS = 10

const SMELTING = new Map<number, RecipeResult>([
  [B.IRON_ORE, { id: I.IRON_INGOT, count: 1 }],
  [B.GOLD_ORE, { id: I.GOLD_INGOT, count: 1 }],
  [B.DIAMOND_ORE, { id: I.DIAMOND, count: 1 }],
  [B.SAND, { id: B.GLASS, count: 1 }],
  [B.COBBLESTONE, { id: B.STONE, count: 1 }],
  [I.CLAY_BALL, { id: I.BRICK, count: 1 }],
  [I.RAW_PORKCHOP, { id: I.COOKED_PORKCHOP, count: 1 }],
  [I.RAW_BEEF, { id: I.STEAK, count: 1 }],
  [I.RAW_CHICKEN, { id: I.COOKED_CHICKEN, count: 1 }],
  [I.RAW_MUTTON, { id: I.COOKED_MUTTON, count: 1 }]
])

const FUEL_SECONDS = new Map<number, number>([
  [I.COAL, 80],
  [B.PLANKS, 15],
  [B.LOG, 15],
  [B.PINELOG, 15],
  [B.JUNGLE_LOG, 15],
  [B.BIRCH_LOG, 15],
  [B.CRAFTING_TABLE, 15],
  [B.CHEST, 15],
  [B.WOOD_DOOR_LOWER, 10],
  [I.WOODEN_SWORD, 10],
  [I.WOODEN_SHOVEL, 10],
  [I.WOODEN_PICKAXE, 10],
  [I.WOODEN_AXE, 10],
  [I.WOODEN_HOE, 10],
  [I.STICK, 5]
])

/** Furnace output for an input item id, or null when it cannot be smelted. */
export function smeltResultFor(id: number): RecipeResult | null {
  return SMELTING.get(id) ?? null
}

/** Classic per-item smelting experience, banked by the furnace until the output is taken. */
const SMELT_XP = new Map<number, number>([
  [B.IRON_ORE, 0.7],
  [B.GOLD_ORE, 1],
  [B.DIAMOND_ORE, 1],
  [B.SAND, 0.1],
  [B.COBBLESTONE, 0.1],
  [I.CLAY_BALL, 0.3],
  [I.RAW_PORKCHOP, 0.35],
  [I.RAW_BEEF, 0.35],
  [I.RAW_CHICKEN, 0.35],
  [I.RAW_MUTTON, 0.35]
])

export function smeltXpFor(id: number): number {
  return SMELT_XP.get(id) ?? 0
}

/** Burn duration of a fuel item in seconds, or 0 when it is not a fuel. */
export function fuelSecondsFor(id: number): number {
  return FUEL_SECONDS.get(id) ?? 0
}

export function ingredientMatches(ingredient: Ingredient, id: number): boolean {
  return typeof ingredient === 'number' ? ingredient === id : ingredient.includes(id)
}

/** One entry per required item of a recipe (pattern cells or shapeless list). */
export function recipeIngredients(recipe: Recipe): Ingredient[] {
  if (recipe.kind === 'shapeless') return [...recipe.ingredients]
  const needs: Ingredient[] = []
  for (const row of recipe.pattern) {
    for (const char of row) {
      if (char !== ' ') needs.push(recipe.keys[char])
    }
  }
  return needs
}

function matchShaped(recipe: ShapedRecipe, grid: readonly (ItemStack | null)[], width: number): boolean {
  // bounding box of the filled cells
  let minX = width, minY = width, maxX = -1, maxY = -1
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      if (!grid[y * width + x]) continue
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  if (maxX < 0) return false

  const rows = recipe.pattern.length
  const cols = Math.max(...recipe.pattern.map(row => row.length))
  if (maxX - minX + 1 !== cols || maxY - minY + 1 !== rows) return false

  const cell = (x: number, y: number): ItemStack | null => grid[(minY + y) * width + (minX + x)]
  const fits = (mirrored: boolean): boolean => {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const char = recipe.pattern[y][mirrored ? cols - 1 - x : x] ?? ' '
        const stack = cell(x, y)
        if (char === ' ') {
          if (stack) return false
          continue
        }
        if (!stack || !ingredientMatches(recipe.keys[char], stack.id)) return false
      }
    }
    return true
  }
  return fits(false) || fits(true)
}

function matchShapeless(recipe: ShapelessRecipe, grid: readonly (ItemStack | null)[]): boolean {
  const present = grid.filter((stack): stack is ItemStack => !!stack).map(stack => stack.id)
  if (present.length !== recipe.ingredients.length) return false
  const remaining = [...recipe.ingredients]
  for (const id of present) {
    const index = remaining.findIndex(ingredient => ingredientMatches(ingredient, id))
    if (index < 0) return false
    remaining.splice(index, 1)
  }
  return true
}

/** Returns the crafting output for a square grid (width 2 or 3), or null. */
export function matchRecipe(grid: readonly (ItemStack | null)[], width: number): RecipeResult | null {
  for (const recipe of RECIPES) {
    const hit = recipe.kind === 'shaped'
      ? matchShaped(recipe, grid, width)
      : matchShapeless(recipe, grid)
    if (hit) return recipe.result
  }
  return null
}
