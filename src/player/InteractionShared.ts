import * as THREE from 'three'
import {
  B, BLOCKS, HOTBAR_PAGES, SOUND_CAT, CROSS, SOLID, isContainerBlock, isDirectionalBlock, tileFor,
  isWheat, wheatAge, isFluid, isWater, isBedBlock, isDoorBlock, isLeafBlock, canSupportVine, oppositeHorizontalFace,
  type HorizontalFace
} from '../world/Blocks'
import { ITEMS, ItemDefinition, breakInfoFor, durabilityForItem } from '../world/Items'
import { I } from '../world/ItemIds'
import type { GameMode } from '../core/Settings'
import type { Inventory, ItemStack } from './Inventory'
import type { ItemDrops } from '../world/ItemDrops'
import type { World, RayHit } from '../world/World'
import type { Player } from './Player'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import type { AudioMan } from '../audio/Audio'
import type { Particles } from '../gfx/Particles'
import type { EntityManager } from '../entities/EntityManager'
import type { ProjectileManager } from '../entities/ProjectileManager'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'
import type { VanillaHeldItems } from '../gfx/VanillaHeldItems'
import { ATTACK_COOLDOWN, MELEE_REACH, bowDamage, bowPower, bowPullSprite, bowVelocity, meleeDamage } from './Combat'
import {
  additiveFortuneDropCount, enchantmentLevel, fortuneDropCount, sharpnessBonus, shouldConsumeDurability
} from './Enchantments'

export const SURVIVAL_REACH = 4.5
export const CREATIVE_REACH = 5.5
export type HandKind = 'block' | 'tool' | 'bow' | 'item'
export const VIEWMODEL_LAYER = 1
