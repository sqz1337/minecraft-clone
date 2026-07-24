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

export function installInteractionHand(InteractionClass: InteractionConstructor): void {
  const prototype = InteractionClass.prototype
  prototype.aimDirection = function(this: Interaction, target: THREE.Vector3): THREE.Vector3 {
    const player = this.player as Player | undefined
    return player && typeof player.getLookDirection === 'function'
      ? player.getLookDirection(target)
      : this.camera.getWorldDirection(target)
  }
  prototype.aimOrigin = function(this: Interaction, target: THREE.Vector3): THREE.Vector3 {
    const player = this.player as Player | undefined
    if (player && typeof player.getEyePosition === 'function') return player.getEyePosition(target)
    return typeof this.camera.getWorldPosition === 'function'
      ? this.camera.getWorldPosition(target)
      : target.copy(this.camera.position)
  }
  prototype.setFirstPersonVisible = function(this: Interaction, visible: boolean): void {
    if (this.hand) this.hand.visible = visible
  }
  prototype.setSelected = function(this: Interaction, i: number): void {
    const hotbar = this.currentHotbar
    this.selected = ((i % hotbar.length) + hotbar.length) % hotbar.length
    this.buildHand()
    this.onSelectionChanged(this.selected)
  }
  prototype.setPage = function(this: Interaction, page: number): void {
    if (this.mode === 'survival') return
    this.page = ((page % HOTBAR_PAGES.length) + HOTBAR_PAGES.length) % HOTBAR_PAGES.length
    this.selected = Math.min(this.selected, this.currentHotbar.length - 1)
    this.buildHand()
    this.onPageChanged(this.page, this.currentHotbar)
    this.onSelectionChanged(this.selected)
  }
  prototype.cyclePage = function(this: Interaction): void { if (this.mode === 'creative') this.setPage(this.page + 1) }
  prototype.inventoryChanged = function(this: Interaction): void {
    this.buildHand()
    this.onPageChanged(this.page, this.currentHotbar)
    this.onSelectionChanged(this.selected)
  }
  prototype.scroll = function(this: Interaction, dir: number): void {
    this.setSelected(this.selected + (dir > 0 ? 1 : -1))
  }
  prototype.primaryDown = function(this: Interaction): void {
    this.breaking = true
    this.attackQueued = true
    this.attackingEntity = false
    // A left click always swings, even when the ray hits only air. Damage and
    // block breaking are still decided independently in update().
    this.swing()
  }
  prototype.primaryUp = function(this: Interaction): void {
    this.breaking = false
    this.attackQueued = false
    this.breakProgress = 0
    this.crackMesh.visible = false
    this.attackingEntity = false
  }
  prototype.secondaryDown = function(this: Interaction): void {
    if (this.selectedItem?.ranged === 'bow') {
      this.chargingBow = true
      this.bowCharge = 0
      this.placing = false
      return
    }
    if (this.selectedItem?.tool?.type === 'sword') {
      this.placing = false
      return
    }
    this.placing = true
    this.placeCooldown = 0
    this.eatSoundTimer = 0.08
  }
  prototype.secondaryUp = function(this: Interaction): void {
    if (this.chargingBow) this.releaseBow()
    this.chargingBow = false
    this.bowCharge = 0
    this.placing = false
    this.eatProgress = 0
    this.eatSoundTimer = 0
  }
  prototype.releaseBow = function(this: Interaction): void {
    const power = bowPower(this.bowCharge)
    if (power < 0.1 || this.selectedItem?.ranged !== 'bow') return
    const powerLevel = enchantmentLevel(this.selectedStack, 'power')
    if (this.mode === 'survival') {
      const infinity = enchantmentLevel(this.selectedStack, 'infinity') > 0
      const arrowSlot = this.inventory.slots.findIndex(stack => stack?.id === I.ARROW)
      if (arrowSlot < 0) return
      if (!infinity) this.inventory.remove(arrowSlot, 1)
      this.damageHeldItem()
    }
    this.aimDirection(this.rayDir)
    const origin = this.aimOrigin(this.rayOrigin).addScaledVector(this.rayDir, 0.45)
    const punch = enchantmentLevel(this.selectedStack, 'punch')
    const flame = enchantmentLevel(this.selectedStack, 'flame')
    this.projectiles.shoot(
      origin,
      this.rayDir,
      bowVelocity(power),
      bowDamage(power, powerLevel),
      'player',
      { knockback: 2.8 + punch * 1.6, fireSeconds: flame > 0 ? 5 : 0 }
    )
    this.audio.bowShoot(power)
    this.swing()
  }
  prototype.dropSelected = function(this: Interaction, all = true): void {
    const item = this.selectedItem
    if (!item) return
    let count = 1
    let damage: number | undefined
    let enchantments: ItemStack['enchantments']
    if (this.mode === 'survival') {
      const stack = this.selectedStack
      if (!stack) return
      count = all ? stack.count : 1
      damage = stack.damage
      enchantments = stack.enchantments?.map(enchantment => ({ ...enchantment }))
      this.inventory.remove(this.selected, count)
    }
    this.aimDirection(this.rayDir)
    const eye = this.aimOrigin(this.rayOrigin)
    const velocity = this.rayDir.clone().multiplyScalar(6)
    velocity.y += 2
    this.drops.spawn(item.id, eye.x + this.rayDir.x * 0.4, eye.y - 0.25, eye.z + this.rayDir.z * 0.4, count, {
      velocity,
      pickupDelay: 1.2,
      damage,
      enchantments
    })
    this.swing()
  }
  prototype.buildHand = function(this: Interaction): void {
    if (this.hand) {
      this.camera.remove(this.hand)
      this.hand.geometry.dispose()
      ;(this.hand.material as THREE.Material).dispose()
    }
    const item = this.selectedItem
    if (!item) {
      this.hand = null
      return
    }
    const id = item.id
    this.handKind = item.ranged === 'bow' ? 'bow' : item.tool ? 'tool' : !item.sprite && !CROSS[id] ? 'block' : 'item'
    this.handFlat = this.handKind !== 'block'
    this.handBowStage = -1
    let geo: THREE.BufferGeometry
    let mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial
    if (item.sprite) {
      const size = this.handKind === 'item' ? 0.28 : this.handKind === 'bow' ? 0.7 : 0.7
      const vanilla = this.heldItems.get(id)
      geo = createExtrudedItemGeometry(size)
      // Official standalone PNGs are not mirrored. Reversing the geometry's
      // legacy U mapping puts axe heads and blades on the vanilla side.
      setExtrudedItemUv(geo, vanilla ? [1, 0, 0, 1] : this.sprites.uvRect(item.sprite[0], item.sprite[1]))
      // Flat extruded items render unlit: MeshLambert would shade each 1px edge
      // wall of the extrusion by the world sun, and because the model rotates
      // with the camera that produced a noisy, pixelated blade. Instead the
      // geometry bakes fixed face shading into vertex colours (flat faces bright,
      // side walls dim) for a stable, natural sense of depth.
      mat = new THREE.MeshBasicMaterial({
        map: vanilla?.texture ?? this.sprites.texture,
        alphaTest: 0.1,
        vertexColors: true
      })
    } else if (this.handFlat) {
      geo = createExtrudedItemGeometry(0.31)
      setExtrudedItemUv(geo, this.atlas.uvRect(tileFor(id, 0)))
      mat = new THREE.MeshBasicMaterial({
        map: this.atlas.colorTex,
        alphaTest: 0.1,
        vertexColors: true
      })
    } else {
      geo = new THREE.BoxGeometry(0.31, 0.31, 0.31)
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      for (let f = 0; f < 6; f++) {
        const [u0, v0, u1, v1] = this.atlas.uvRect(tileFor(id, f))
        for (let i = 0; i < 4; i++) {
          const vi = f * 4 + i
          uv.setXY(vi, uv.getX(vi) < 0.5 ? u0 : u1, uv.getY(vi) < 0.5 ? v0 : v1)
        }
      }
      uv.needsUpdate = true
      const colors = new Float32Array(24 * 3).fill(1)
      if (id === B.GRASS) {
        for (let i = 8; i < 12; i++) {
          colors[i * 3] = 0.62; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 0.38
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      mat = new THREE.MeshLambertMaterial({
        map: this.atlas.colorTex,
        vertexColors: true
      })
    }
    if (this.selectedStack?.enchantments?.length) {
      if (mat instanceof THREE.MeshLambertMaterial) {
        mat.emissive = new THREE.Color(0x5b2c83)
        mat.emissiveIntensity = 0.32
      } else {
        // Unlit items can't glow via emissive; a subtle violet tint keeps the cue.
        mat.color = new THREE.Color(0xe0c8ff)
      }
    }
    // The view model is drawn in its own pass (see VIEWMODEL_LAYER) against a
    // freshly cleared depth buffer, so it needs real depth testing to self-
    // occlude — front faces must hide the back/side faces instead of painting
    // over them — while still sitting on top of the world, including the block
    // being mined and transparent water. fog:false keeps the near overlay at
    // true colour through rain/storm haze.
    mat.depthTest = true
    mat.depthWrite = true
    mat.fog = false
    this.hand = new THREE.Mesh(geo, mat)
    this.hand.userData.kind = this.handKind
    this.hand.frustumCulled = false
    this.hand.layers.set(VIEWMODEL_LAYER)
    this.applyHandPose(0)
    this.updateBowVisual()
    this.camera.add(this.hand)
  }
  prototype.updateBowVisual = function(this: Interaction): void {
    if (!this.hand || this.handKind !== 'bow') return
    const [column] = bowPullSprite(this.chargingBow ? this.bowCharge : null)
    const stage = column - 5
    if (stage === this.handBowStage) return
    this.handBowStage = stage
    ;(this.hand.material as THREE.MeshBasicMaterial).map = this.heldItems.bow(stage).texture
  }
  prototype.applyHandPose = function(this: Interaction, swingProgress: number): void {
    if (!this.hand) return
    // Keep the model in the lower-right first-person area while leaving enough
    // vertical room for long tools to point up instead of crossing the hotbar.
    const poses: Record<HandKind, { position: [number, number, number]; rotation: [number, number, number] }> = {
      block: { position: [0.64, -0.33, -0.52], rotation: [0.12, Math.PI / 4, 0.06] },
      tool: { position: [0.75, -0.29, -0.70], rotation: [0.04, -1.6, 1.5] },
      bow: { position: [0.75, -0.45, -0.70], rotation: [0.04, -1.6, 1.5] },
      item: { position: [0.60, -0.23, -0.70], rotation: [0.04, -0.42, 0.44] }
    }
    const pose = poses[this.handKind]
    const vanillaRotation = this.heldItems.get(this.selectedItemId)?.firstPersonRotation
    // Three's camera convention needs the vanilla +25-degree screen roll as a
    // positive Z rotation. Negating it made diagonal tools almost horizontal.
    const toolRoll = this.handKind === 'tool' ? 5 : 0
    const modelRoll = vanillaRotation ? THREE.MathUtils.degToRad(vanillaRotation[2] + toolRoll) : pose.rotation[2]
    // Classic ItemRenderer uses different sine curves for translation and
    // rotation, producing a forward/downward jab instead of a linear tilt.
    const rootSwing = Math.sin(Math.sqrt(swingProgress) * Math.PI)
    const linearSwing = Math.sin(swingProgress * Math.PI)
    const doubleSwing = Math.sin(Math.sqrt(swingProgress) * Math.PI * 2)
    const squaredSwing = Math.sin(swingProgress * swingProgress * Math.PI)
    this.hand.position.set(
      pose.position[0] - rootSwing * 0.12,
      pose.position[1] + doubleSwing * 0.05,
      pose.position[2] - linearSwing * 0.07
    )
    this.hand.rotation.set(
      pose.rotation[0] - rootSwing * 1.35,
      pose.rotation[1] - squaredSwing * 0.35,
      modelRoll - rootSwing * 0.35
    )
    if (this.handKind === 'bow' && this.chargingBow) {
      const draw = Math.min(1, this.bowCharge)
      this.hand.position.x -= draw * 0.035
      this.hand.position.z += draw * 0.045
      this.hand.rotation.y += draw * 0.08
    }
  }
  prototype.swing = function(this: Interaction): void { this.handSwing = 1 }
}
