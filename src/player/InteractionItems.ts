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
import { SURVIVAL_REACH, CREATIVE_REACH, HandKind, VIEWMODEL_LAYER } from './InteractionShared'
import type { Interaction } from './Interaction'

type InteractionConstructor = { prototype: Interaction }

export function facingOppositeLook(lookX: number, lookZ: number, axis?: 'x' | 'z'): HorizontalFace {
  const towardPlayerX = -lookX
  const towardPlayerZ = -lookZ
  if (axis === 'x' || (!axis && Math.abs(towardPlayerX) > Math.abs(towardPlayerZ))) {
    return towardPlayerX >= 0 ? 0 : 1
  }
  return towardPlayerZ >= 0 ? 4 : 5
}

export function installInteractionItems(InteractionClass: InteractionConstructor): void {
  const prototype = InteractionClass.prototype
  prototype.chestFits = function(this: Interaction, px: number, py: number, pz: number): boolean {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
    let neighbors = 0
    for (const [dx, dz] of dirs) {
      const nx = px + dx, nz = pz + dz
      if (this.world.getBlock(nx, py, nz) !== B.CHEST) continue
      neighbors++
      for (const [dx2, dz2] of dirs) {
        const fx = nx + dx2, fz = nz + dz2
        if (fx === px && fz === pz) continue
        if (this.world.getBlock(fx, py, fz) === B.CHEST) return false
      }
    }
    return neighbors <= 1
  }
  prototype.facingTowardPlayer = function(this: Interaction, _px: number, _pz: number, axis?: 'x' | 'z'): HorizontalFace {
    this.aimDirection(this.rayDir)
    return facingOppositeLook(this.rayDir.x, this.rayDir.z, axis)
  }
  prototype.alignChestPair = function(this: Interaction, px: number, py: number, pz: number, placedFacing: HorizontalFace): void {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = px + dx, nz = pz + dz
      if (this.world.getBlock(nx, py, nz) !== B.CHEST) continue
      const seamAlongX = dx !== 0
      const placedIsValid = seamAlongX ? (placedFacing === 4 || placedFacing === 5) : (placedFacing === 0 || placedFacing === 1)
      const neighborFacing = this.world.getBlockFacing(nx, py, nz)
      const neighborIsValid = seamAlongX ? (neighborFacing === 4 || neighborFacing === 5) : (neighborFacing === 0 || neighborFacing === 1)
      const facing = placedIsValid
        ? placedFacing
        : neighborIsValid
          ? neighborFacing
          : this.facingTowardPlayer(px, pz, seamAlongX ? 'z' : 'x')
      this.world.setBlockFacing(nx, py, nz, facing)
      this.world.setBlockFacing(px, py, pz, facing)
      return
    }
  }
  prototype.damageHeldItem = function(this: Interaction, amount = 1): void {
    if (this.mode !== 'survival') return
    const stack = this.selectedStack
    const durability = stack ? durabilityForItem(stack.id) : 0
    if (!stack || durability <= 0) return
    if (!shouldConsumeDurability(enchantmentLevel(stack, 'unbreaking'))) return
    stack.damage = (stack.damage ?? 0) + Math.max(1, amount)
    if (stack.damage >= durability) {
      this.inventory.slots[this.selected] = null
      this.audio.toolBreak()
    }
    this.inventory.notify()
  }
  prototype.spawnBlockDrops = function(this: Interaction, id: number, x: number, y: number, z: number, harvest: boolean): void {
    const spawn = (itemId: number, count = 1) => this.drops.spawn(itemId, x + 0.5, y + 0.45, z + 0.5, count)
    const held = this.selectedStack
    const shears = harvest && held?.id === I.SHEARS
    const silkTouch = harvest && enchantmentLevel(held, 'silk_touch') > 0
    const fortune = enchantmentLevel(held, 'fortune')
    const shearsOnlyPlant = id === B.VINE || id === B.DEAD_BUSH || id === B.TALLGRASS || id === B.FERN
    if (silkTouch && !shearsOnlyPlant && BLOCKS[id].hasItem && id !== B.FIRE && id !== B.PRIMED_TNT) {
      spawn(id)
      return
    }
    if (isWheat(id)) {
      if (wheatAge(id) >= 7) {
        spawn(I.WHEAT)
        spawn(I.SEEDS, 1 + Math.floor(Math.random() * 3))
      } else {
        spawn(I.SEEDS)
      }
      return
    }
    if (shears && (isLeafBlock(id) || id === B.VINE || id === B.DEAD_BUSH ||
      id === B.TALLGRASS || id === B.FERN)) {
      spawn(id)
      return
    }
    if (id === B.TALLGRASS || id === B.FERN) {
      if (Math.random() < 0.125) spawn(I.SEEDS)
      return
    }
    if (id === B.GRAVEL && harvest) {
      spawn(Math.random() < 0.1 ? I.FLINT : B.GRAVEL)
      return
    }
    if (isLeafBlock(id)) {
      if (id === B.LEAVES && Math.random() < 0.05) spawn(B.SAPLING_OAK)
      else if (id === B.PINELEAVES && Math.random() < 0.05) spawn(B.SAPLING_SPRUCE)
      else if (id === B.BIRCH_LEAVES && Math.random() < 0.05) spawn(B.SAPLING_BIRCH)
      if (id === B.LEAVES && Math.random() < 0.005) spawn(I.APPLE)
      return
    }
    if (id === B.BED_HEAD) {
      spawn(I.BED)
      return
    }
    if (id === B.BOOKSHELF) {
      spawn(I.BOOK, 3)
      return
    }
    const definition = BLOCKS[id]
    const drop = harvest ? definition.dropItem : null
    if (drop !== null) {
      const [minCount, maxCount] = definition.dropCount
      const baseCount = minCount === maxCount
        ? minCount
        : minCount + Math.floor(Math.random() * (maxCount - minCount + 1))
      const fortuneCount = definition.fortuneMode === 'multiplier'
        ? fortuneDropCount(baseCount, fortune)
        : definition.fortuneMode === 'additive'
          ? additiveFortuneDropCount(baseCount, fortune)
          : baseCount
      spawn(drop, fortuneCount)
      // Iron and gold drop the ore block itself; their XP comes from smelting.
      const [minXp, maxXp] = definition.experience
      const xp = minXp === maxXp ? minXp : minXp + Math.floor(Math.random() * (maxXp - minXp + 1))
      if (xp > 0) this.onExperience(x + 0.5, y + 0.5, z + 0.5, xp)
    }
  }
  prototype.dropAutomaticBlock = function(this: Interaction, x: number, y: number, z: number, id: number): void {
    if (this.mode === 'survival') this.spawnBlockDrops(id, x, y, z, true)
  }
  prototype.dropExplodedBlock = function(this: Interaction, x: number, y: number, z: number, id: number): void {
    if (this.mode === 'survival' && Math.random() < 0.3) this.spawnBlockDrops(id, x, y, z, true)
  }
  prototype.useFarmingItem = function(this: Interaction, hit: RayHit): boolean {
    if (this.mode !== 'survival') return false
    const item = this.selectedItem
    const stack = this.selectedStack
    if (!item || !stack) return false

    if (item.tool?.type === 'hoe' && (hit.id === B.GRASS || hit.id === B.DIRT) && hit.ny > 0) {
      if (this.world.getBlock(hit.x, hit.y + 1, hit.z) !== B.AIR) return true
      this.world.setBlock(hit.x, hit.y, hit.z, B.FARMLAND_DRY)
      this.damageHeldItem()
      this.player.addExhaustion(0.005)
      this.audio.placeBlock('dirt')
      this.swing()
      return true
    }

    if (item.id === I.SEEDS && (hit.id === B.FARMLAND_DRY || hit.id === B.FARMLAND_WET) && hit.ny > 0) {
      const py = hit.y + 1
      if (this.world.canPlantWheat(hit.x, py, hit.z)) {
        this.world.setBlock(hit.x, py, hit.z, B.WHEAT_0)
        this.inventory.remove(this.selected, 1)
        this.audio.placeBlock('grass')
        this.swing()
      }
      return true
    }

    if (item.id === I.BONE_MEAL && this.world.fertilize(hit.x, hit.y, hit.z)) {
      this.inventory.remove(this.selected, 1)
      this.swing()
      return true
    }
    return false
  }
  prototype.finishEating = function(this: Interaction, item: ItemDefinition): void {
    const food = item.food
    if (!food || !this.player.eat(food.hunger, food.saturation)) return
    if (food.effect && Math.random() < food.effect.chance) this.player.applyFoodEffect(food.effect.kind, food.effect.seconds)
    this.inventory.remove(this.selected, 1)
    if (food.returnsItem !== null) {
      const left = this.inventory.add(food.returnsItem, 1)
      if (left > 0) {
        const eye = this.player.eyePos(this.rayOrigin)
        this.drops.spawn(food.returnsItem, eye.x, eye.y - 0.4, eye.z, 1)
      }
    }
    this.audio.burp()
    this.swing()
  }
  prototype.finishDrinkingMilk = function(this: Interaction): void {
    this.player.clearEffects()
    this.replaceOneHeldItem(I.BUCKET)
    this.audio.eat()
    this.swing()
  }
  prototype.replaceOneHeldItem = function(this: Interaction, resultId: number): void {
    if (this.mode !== 'survival') return
    const stack = this.selectedStack
    if (!stack) return
    if (stack.count === 1) {
      this.inventory.slots[this.selected] = { id: resultId, count: 1 }
      this.inventory.notify()
      return
    }
    this.inventory.remove(this.selected, 1)
    const left = this.inventory.add(resultId, 1)
    if (left > 0) {
      const eye = this.player.eyePos(this.rayOrigin)
      this.drops.spawn(resultId, eye.x, eye.y - 0.35, eye.z, 1)
    }
  }
  prototype.useEntityInteraction = function(this: Interaction, entityId: string): boolean {
    const result = this.entities.interact(entityId, this.selectedItem?.id ?? null)
    if (!result) return false
    const entity = this.entities.snapshotById(entityId)

    if (result.type === 'saddle') {
      if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
    } else if (result.type === 'ride') {
      this.player.syncRidingPose(result.riding ? result.pose : null)
    } else if (result.type === 'container') {
      this.replaceOneHeldItem(result.replaceHeldWith)
    } else {
      if (entity) {
        for (const drop of result.drops) {
          this.drops.spawn(drop.id, entity.x, entity.y + 0.7, entity.z, drop.count)
        }
      }
      if (result.damageTool) this.damageHeldItem()
      this.audio.breakBlock('cloth')
    }
    this.swing()
    this.placing = false
    this.placeCooldown = 0.3
    return true
  }
  prototype.useStageNineItem = function(this: Interaction, hit: RayHit): boolean {
    const item = this.selectedItem
    if (!item) return false
    if (item.id === I.BUCKET) {
      if (hit.id !== B.WATER && hit.id !== B.LAVA) return true
      this.world.setBlock(hit.x, hit.y, hit.z, B.AIR)
      this.replaceOneHeldItem(hit.id === B.WATER ? I.WATER_BUCKET : I.LAVA_BUCKET)
      this.audio.splash(false)
      this.swing()
      return true
    }
    if (item.id === I.WATER_BUCKET || item.id === I.LAVA_BUCKET) {
      const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz
      const current = this.world.getBlock(px, py, pz)
      if (current !== B.AIR && current !== B.FIRE && !CROSS[current] && !isFluid(current)) return true
      this.world.setBlock(px, py, pz, item.id === I.WATER_BUCKET ? B.WATER : B.LAVA)
      this.replaceOneHeldItem(I.BUCKET)
      this.audio.splash(false)
      this.swing()
      return true
    }
    if (item.id === I.FLINT_AND_STEEL) {
      let lit = false
      if (hit.id === B.TNT) lit = this.world.primeTnt(hit.x, hit.y, hit.z)
      else lit = this.world.ignite(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz)
      if (lit) {
        this.damageHeldItem()
        this.audio.placeBlock('wood')
        this.swing()
      }
      return true
    }
    return false
  }
  prototype.useBedItem = function(this: Interaction, hit: RayHit): boolean {
    const item = this.selectedItem
    if (item?.id !== I.BED) return false
    let px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz
    if (CROSS[hit.id]) { px = hit.x; py = hit.y; pz = hit.z }
    const facing = oppositeHorizontalFace(this.facingTowardPlayer(px, pz))
    const hx = px + (facing === 0 ? 1 : facing === 1 ? -1 : 0)
    const hz = pz + (facing === 4 ? 1 : facing === 5 ? -1 : 0)
    const fits = (x: number, z: number): boolean => {
      const cur = this.world.getBlock(x, py, z)
      return (cur === B.AIR || CROSS[cur]) && SOLID[this.world.getBlock(x, py - 1, z)] &&
        !this.player.intersectsBlock(x, py, z)
    }
    if (!fits(px, pz) || !fits(hx, hz)) return true
    this.world.setBlock(px, py, pz, B.BED_FOOT, facing)
    this.world.setBlock(hx, py, hz, B.BED_HEAD, facing)
    if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
    this.audio.placeBlock('wood')
    this.swing()
    return true
  }
}
