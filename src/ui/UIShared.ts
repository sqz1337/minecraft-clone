import { HOTBAR, B, tileFor, CROSS, RENDER_SHAPE } from '../world/Blocks'
import { ITEMS, durabilityForItem, itemName } from '../world/Items'
import { FURNACE_SMELT_SECONDS, RECIPES, Recipe, recipeIngredients } from '../world/Recipes'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import { CONTROL_DEFINITIONS, displayKey, type Settings, type QualityName, type GameMode, type ControlAction } from '../core/Settings'
import type { Inventory, ItemStack } from '../player/Inventory'
import type { Crafting, CursorHolder } from '../player/Crafting'
import type { FurnaceState } from '../world/Containers'
import type { MinecraftFont } from './MinecraftFont'
import type { Equipment } from '../player/Equipment'
import { stackDisplayName, type EnchantingState } from '../player/Enchantments'
import { VILLAGER_TRADES } from '../entities/Trades'
import type { VillagerProfession } from '../entities/EntityTypes'
import { WorldLibrary, type WorldSummary } from '../core/WorldSave'

export function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error('missing element #' + id)
  return element as T
}
export interface HudData {
  fps: number
  x: number; y: number; z: number
  biome: string
  time: string
  weather: string
  seed: string
  flying: boolean
  noclip: boolean
}
export type SlotButton = 0 | 2
export type SlotHandler = (index: number, button: SlotButton, shift: boolean) => void
export type UIScreen =
  | { kind: 'inventory'; crafting: Crafting }
  | { kind: 'workbench'; crafting: Crafting }
  | { kind: 'chest'; slots: Array<ItemStack | null>; holder: CursorHolder; double: boolean }
  | { kind: 'furnace'; state: FurnaceState; holder: CursorHolder }
  | { kind: 'enchant'; holder: EnchantingState }
  | { kind: 'trade'; holder: CursorHolder; profession: VillagerProfession }
  | { kind: 'admin' }
