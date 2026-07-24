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
import {
  ATTACK_COOLDOWN, MELEE_REACH, bowDamage, bowPower, bowPullSprite,
  bowVelocity, chargedMeleeDamage, meleeDamage
} from './Combat'
import {
  additiveFortuneDropCount, enchantmentLevel, fortuneDropCount, sharpnessBonus, shouldConsumeDurability
} from './Enchantments'
import { SURVIVAL_REACH, CREATIVE_REACH, HandKind, VIEWMODEL_LAYER } from './InteractionShared'
import type { Interaction } from './Interaction'

type InteractionConstructor = { prototype: Interaction }

export function installInteractionUpdate(InteractionClass: InteractionConstructor): void {
  const prototype = InteractionClass.prototype
  prototype.update = function(this: Interaction, dt: number): void {
    if (this.chargingBow) {
      this.bowCharge = Math.min(1.2, this.bowCharge + dt)
    }
    this.aimDirection(this.rayDir)
    this.aimOrigin(this.rayOrigin)
    const reach = this.mode === 'survival' ? SURVIVAL_REACH : CREATIVE_REACH
    const hit = this.world.raycast(this.rayOrigin, this.rayDir, reach, this.selectedItem?.id === I.BUCKET)
    const entityHit = this.entities.raycast(this.rayOrigin, this.rayDir, MELEE_REACH)
    const entityIsFirst = !!entityHit && (!hit || entityHit.distance < hit.dist)
    this.target = hit
    this.selectionMesh.visible = !!hit && !entityIsFirst
    if (hit && !entityIsFirst) {
      const shape = hit.shape ?? { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }
      this.selectionMesh.position.set(
        hit.x + (shape.minX + shape.maxX) * 0.5,
        hit.y + (shape.minY + shape.maxY) * 0.5,
        hit.z + (shape.minZ + shape.maxZ) * 0.5
      )
      this.selectionMesh.scale?.set?.(
        shape.maxX - shape.minX,
        shape.maxY - shape.minY,
        shape.maxZ - shape.minZ
      )
    }

    this.attackCooldown = Math.min(ATTACK_COOLDOWN, this.attackCooldown + dt)
    if (this.breaking && entityIsFirst) {
      this.attackingEntity = true
      this.crackMesh.visible = false
      if (this.attackQueued) {
        this.attackQueued = false
        const charge = this.attackStrength
        const critical = charge >= 0.9 &&
          !this.player.onGround && !this.player.inWater && this.player.vel.y < -0.08
        const stack = this.selectedStack
        const targetKind = entityHit!.entity.kind
        let enchantBonus = sharpnessBonus(enchantmentLevel(stack, 'sharpness'))
        const smite = enchantmentLevel(stack, 'smite')
        if (smite > 0 && (targetKind === 'zombie' || targetKind === 'skeleton')) enchantBonus += 2.5 * smite
        const bane = enchantmentLevel(stack, 'bane_of_arthropods')
        if (bane > 0 && targetKind === 'spider') enchantBonus += 2.5 * bane
        const damage = chargedMeleeDamage(
          meleeDamage(this.selectedItem?.id ?? null, critical, enchantBonus),
          charge
        )
        const knockback = (
          (this.player.sprinting ? 6.2 : 4.2) + enchantmentLevel(stack, 'knockback') * 1.2
        ) * (0.2 + charge * 0.8)
        this.attackCooldown = 0
        if (this.entities.damage(
          entityHit!.entity.id, damage, this.player.pos.x, this.player.pos.z, knockback,
          enchantmentLevel(stack, 'looting')
        )) {
          const fireAspect = enchantmentLevel(stack, 'fire_aspect')
          if (fireAspect > 0) this.entities.ignite(entityHit!.entity.id, fireAspect * 4)
          this.swing()
          this.player.addExhaustion(0.1)
          if (this.selectedItem?.tool?.type === 'sword') this.damageHeldItem()
        }
      }
    } else if (this.attackQueued) {
      // A click that hit only air or terrain must not remain armed until the
      // player later drags the crosshair across an entity.
      this.attackQueued = false
    }

    // breaking
    if (this.breaking && hit && !this.attackingEntity) {
      const key = hit.x + ',' + hit.y + ',' + hit.z
      if (key !== this.breakKey) {
        this.breakKey = key
        this.breakProgress = 0
      }
      const info = breakInfoFor(
        hit.id,
        this.mode === 'survival' ? this.selectedItem : null,
        this.mode === 'creative',
        enchantmentLevel(this.selectedStack, 'efficiency')
      )
      // classic mining penalties: submerged without Aqua Affinity and floating both slow digging
      let breakTime = info.time
      if (this.mode === 'survival') {
        if (this.player.headUnderwater && !this.player.aquaAffinity) breakTime *= 5
        if (!this.player.onGround && !this.player.inWater) breakTime *= 5
      }
      if (isFinite(breakTime)) {
        this.breakProgress += dt
        this.handSwing = Math.max(this.handSwing, 0.55)
        this.mineTickTimer -= dt
        if (this.mineTickTimer <= 0) {
          this.mineTickTimer = 0.24
          this.audio.mineTick(SOUND_CAT[hit.id])
          const avg = this.atlas.tileAvg[tileFor(hit.id, 0)]
          this.particles.burst(hit.x + 0.5 + hit.nx * 0.5, hit.y + 0.5 + hit.ny * 0.5, hit.z + 0.5 + hit.nz * 0.5, avg, 3)
        }
        const frac = this.breakProgress / breakTime
        if (frac >= 1) {
          const id = hit.id
          this.world.setBlock(hit.x, hit.y, hit.z, B.AIR)
          this.onBlockBroken(hit.x, hit.y, hit.z, id)
          if (this.mode === 'survival') {
            this.spawnBlockDrops(id, hit.x, hit.y, hit.z, info.harvest)
            if (isFinite(BLOCKS[id].hardness) && BLOCKS[id].hardness > 0) this.damageHeldItem()
            this.player.addExhaustion(0.005)
          }
          const avg = this.atlas.tileAvg[tileFor(id, 0)]
          this.particles.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, avg, CROSS[id] ? 6 : 16)
          this.audio.breakBlock(SOUND_CAT[id])
          this.breakProgress = 0
          this.crackMesh.visible = false
        } else if (frac > 0.02 && !CROSS[hit.id]) {
          this.crackMesh.visible = true
          this.crackMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5)
          const stage = Math.min(this.atlas.crackTex.length - 1, Math.floor(frac * this.atlas.crackTex.length))
          if (this.crackMat.map !== this.atlas.crackTex[stage]) {
            this.crackMat.map = this.atlas.crackTex[stage]
            this.crackMat.needsUpdate = true
          }
        } else {
          this.crackMesh.visible = false
        }
      }
    } else {
      this.breakProgress = 0
      this.breakKey = ''
      this.crackMesh.visible = false
    }

    // placing / using blocks
    this.placeCooldown -= dt
    if (this.placing && this.placeCooldown <= 0) {
      if (entityIsFirst) {
        const item = this.selectedItem
        if (this.useEntityInteraction(entityHit!.entity.id)) return
        if (item && this.entities.feed(entityHit!.entity.id, item.id)) {
          if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
          this.swing()
          this.placing = false
          this.placeCooldown = 0.3
          return
        }
        if (entityHit!.entity.kind === 'villager' && this.mode === 'survival') {
          this.onUseVillager(entityHit!.entity.id)
          this.placing = false
          this.placeCooldown = 0.3
          return
        }
      }
      // right-clicking a usable block opens it (crouch to place a block instead)
      const usable = !!hit && (hit.id === B.CRAFTING_TABLE || isContainerBlock(hit.id) ||
        hit.id === B.ENCHANTING_TABLE || isBedBlock(hit.id) || isDoorBlock(hit.id))
      if (usable && !this.player.crouching && (this.mode === 'survival' || isDoorBlock(hit!.id))) {
        this.placing = false
        this.onUseBlock(hit!)
        return
      }
      const item = this.selectedItem
      const stack = this.selectedStack
      if (hit && this.useStageNineItem(hit)) {
        this.eatProgress = 0
        this.placeCooldown = 0.24
      } else if (hit && this.useBedItem(hit)) {
        this.eatProgress = 0
        this.placeCooldown = 0.3
      } else if (item?.id === I.MAP) {
        this.onUseMap()
        this.placing = false
        this.placeCooldown = 0.3
      } else if (item?.id === I.COMPASS || item?.id === I.CLOCK) {
        this.onUseNavigation(item.id)
        this.placing = false
        this.placeCooldown = 0.3
      } else if (item?.id === I.MILK_BUCKET && this.mode === 'survival') {
        this.eatProgress += dt
        this.handSwing = Math.max(this.handSwing, 0.32 + Math.sin(this.eatProgress * 18) * 0.08)
        if (this.eatProgress >= 1.6) {
          this.finishDrinkingMilk()
          this.eatProgress = 0
          this.placeCooldown = 0.24
        }
      } else if (item?.food && this.mode === 'survival') {
        if (this.player.hunger < 20) {
          this.eatProgress += dt
          this.eatSoundTimer -= dt
          if (this.eatSoundTimer <= 0) {
            this.audio.eat()
            this.eatSoundTimer += 0.2
          }
          this.handSwing = Math.max(this.handSwing, 0.32 + Math.sin(this.eatProgress * 18) * 0.08)
          if (this.eatProgress >= item.food.useSeconds) {
            this.finishEating(item)
            this.eatProgress = 0
            this.placeCooldown = 0.24
          }
        }
      } else if (hit && this.useFarmingItem(hit)) {
        this.eatProgress = 0
        this.placeCooldown = 0.24
      } else {
        this.eatProgress = 0
        const placeable = item?.placeBlock ?? null
        if (hit && placeable !== null && (this.mode === 'creative' || !!stack)) {
        let px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz
        // clicking a cross plant replaces it directly
        if (CROSS[hit.id]) { px = hit.x; py = hit.y; pz = hit.z }
        const cur = this.world.getBlock(px, py, pz)
        const replaceable = cur !== placeable && (cur === B.AIR || isFluid(cur) || CROSS[cur])
        const torchFacing: HorizontalFace | undefined = placeable === B.TORCH && hit.ny === 0
          ? hit.nx > 0 ? 0 : hit.nx < 0 ? 1 : hit.nz > 0 ? 4 : 5
          : undefined
        const torchFits = placeable !== B.TORCH || (
          hit.ny >= 0 &&
          (hit.ny === 1
            ? SOLID[this.world.getBlock(px, py - 1, pz)]
            : torchFacing !== undefined &&
              SOLID[this.world.getBlock(px - hit.nx, py, pz - hit.nz)])
        )
        const vineFacing = placeable === B.VINE
          ? ([
              [1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]
            ] as const).find(([dx, dz]) => canSupportVine(this.world.getBlock(px + dx, py, pz + dz)))?.[2]
          : undefined
        const plantFits = placeable === B.SUGARCANE ? this.world.canPlantSugarCane(px, py, pz)
          : placeable === B.MUSHROOM_BROWN || placeable === B.MUSHROOM_RED ? this.world.canPlantMushroom(px, py, pz)
            : placeable === B.SAPLING_OAK || placeable === B.SAPLING_SPRUCE || placeable === B.SAPLING_BIRCH
              ? this.world.canPlantSapling(px, py, pz)
              : placeable === B.DEAD_BUSH ? this.world.getBlock(px, py - 1, pz) === B.SAND
                : placeable === B.CACTUS
                  ? (this.world.getBlock(px, py - 1, pz) === B.SAND || this.world.getBlock(px, py - 1, pz) === B.CACTUS) &&
                    [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => !SOLID[this.world.getBlock(px + dx, py, pz + dz)])
                  : placeable === B.WATER_LILY ? this.world.getBlock(px, py - 1, pz) === B.WATER
                    : placeable === B.VINE ? vineFacing !== undefined
              : placeable === B.RAIL ? SOLID[this.world.getBlock(px, py - 1, pz)]
              : true
        if (placeable === B.CHEST && !this.chestFits(px, py, pz)) {
          this.placeCooldown = 0.24
        } else if (placeable === B.WOOD_DOOR_LOWER) {
          // A door item is atomic: never fall through to generic one-block placement.
          if (this.player.intersectsBlock(px, py, pz) || this.player.intersectsBlock(px, py + 1, pz)) {
            this.placeCooldown = 0.24
          } else {
            const facing = isDirectionalBlock(placeable) ? this.facingTowardPlayer(px, pz) : undefined
            if (!this.world.placeDoor(px, py, pz, facing)) {
              this.placeCooldown = 0.24
              return
            }
            this.audio.placeBlock(SOUND_CAT[placeable])
            if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
            this.swing()
            this.placeCooldown = 0.24
          }
        } else if (replaceable && plantFits && torchFits && !this.player.intersectsBlock(px, py, pz)) {
          const facing = placeable === B.VINE ? vineFacing
            : placeable === B.TORCH ? torchFacing
            : isDirectionalBlock(placeable) ? this.facingTowardPlayer(px, pz) : undefined
          this.world.setBlock(px, py, pz, placeable, facing)
          if (placeable === B.CHEST && facing !== undefined) this.alignChestPair(px, py, pz, facing)
          if (placeable === B.PUMPKIN) this.entities.tryCreateGolem(px, py, pz)
          this.audio.placeBlock(SOUND_CAT[placeable])
          if (this.mode === 'survival') {
            this.inventory.remove(this.selected, 1)
            this.player.addExhaustion(0.005)
          }
          this.swing()
          this.placeCooldown = 0.24
        }
        }
      }
    } else if (!this.placing) {
      this.eatProgress = 0
    }

    // hand animation
    if (this.hand) {
      this.handSwing = Math.max(0, this.handSwing - dt * 4)
      this.updateBowVisual()
      this.applyHandPose(1 - this.handSwing)
    }
  }
  prototype.dispose = function(this: Interaction): void {
    this.crackMesh.geometry.dispose()
    this.selectionMesh.geometry.dispose()
    ;(this.selectionMesh.material as THREE.Material).dispose()
  }
}
