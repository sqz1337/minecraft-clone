import * as THREE from 'three'
import type { EntitySnapshot, MobKind, VillagerProfession } from './EntityTypes'
import type { Atlas } from '../gfx/Atlas'
import { B, tileFor, type BlockId } from '../world/Blocks'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'
import { EntityView, BoxUv, TEXTURE_WIDTH, TEXTURE_HEIGHT, PROFESSION_TEXTURES, MOB_ROOT, MOVE_SMOOTH_SECONDS, RenderSnapshot } from './EntityRendererShared'
import type { EntityRenderer } from './EntityRenderer'

type EntityRendererConstructor = { prototype: EntityRenderer }

export function installEntityRendererSync(EntityRendererClass: EntityRendererConstructor): void {
  const prototype = EntityRendererClass.prototype
  prototype.sync = function(this: EntityRenderer, entities: Iterable<RenderSnapshot>, alpha: number, dt: number): void {
    const renderAlpha = THREE.MathUtils.clamp(alpha, 0, 1)
    const live = new Set<string>()
    for (const entity of entities) {
      live.add(entity.id)
      let view = this.views.get(entity.id)
      if (view && view.kind !== entity.kind) {
        view.group.removeFromParent()
        for (const material of view.materials) material.dispose()
        this.views.delete(entity.id)
        view = undefined
      }
      if (!view) {
        view = this.build(entity.kind)
        this.views.set(entity.id, view)
        view.group.position.set(entity.x, entity.y, entity.z)
        view.fromPosition.copy(view.group.position)
        view.targetPosition.copy(view.group.position)
        view.group.rotation.y = entity.yaw
        view.fromYaw = view.targetYaw = entity.yaw
      }
      view.group.visible = entity.active
      if (!entity.active) continue
      view.fromPosition.set(entity.previousX, entity.previousY, entity.previousZ)
      view.targetPosition.set(entity.x, entity.y, entity.z)
      if (view.fromPosition.distanceToSquared(view.targetPosition) > 64) {
        view.group.position.copy(view.targetPosition)
      } else {
        view.group.position.lerpVectors(view.fromPosition, view.targetPosition, renderAlpha)
      }
      view.fromYaw = entity.previousYaw
      view.targetYaw = view.fromYaw + Math.atan2(
        Math.sin(entity.yaw - view.fromYaw),
        Math.cos(entity.yaw - view.fromYaw)
      )
      view.group.rotation.y = view.fromYaw + (view.targetYaw - view.fromYaw) * renderAlpha
      // Kept as the documented simulation interval for diagnostics/tests; the
      // interpolation itself now uses the fixed-step accumulator instead of
      // restarting an ease curve on every transform update.
      view.moveElapsed = MOVE_SMOOTH_SECONDS
      const deathProgress = Math.min(1, Math.max(0, entity.deathTime) / 0.7)
      view.group.rotation.z = -deathProgress * Math.PI * 0.5
      const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
      view.group.scale.setScalar(scale)
      const hurt = entity.hurtTime > 0 || (entity.deathTime > 0 && deathProgress < 0.35)
      const villagerTexture = entity.kind === 'villager'
        ? this.villagerTextures.get(entity.profession ?? 'default')
        : undefined
      const catTexture = entity.kind === 'cat'
        ? this.catTextures[[...entity.id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % this.catTextures.length]
        : undefined
      for (const material of view.materials) {
        const skin = villagerTexture ?? catTexture
        if (skin && material.map !== skin) {
          material.map = skin
          material.needsUpdate = true
        }
        material.color.setHex(hurt ? 0xff5555 : 0xffffff)
        material.emissive.setHex(hurt ? 0x350000 : 0x000000)
        material.emissiveIntensity = hurt ? 0.8 : 1
      }
      for (const fur of view.furParts) fur.visible = !entity.sheared
      for (const saddle of view.saddleParts) saddle.visible = entity.saddled
      if (view.carriedBlock) {
        view.carriedBlock.visible = entity.carriedBlock !== null
        if (entity.carriedBlock !== null) {
          if (view.carriedBlock.userData.blockId !== entity.carriedBlock) {
            this.setCarriedBlockUvs(view.carriedBlock, entity.carriedBlock)
          }
          ;(view.carriedBlock.material as THREE.MeshLambertMaterial).color.setHex(hurt ? 0xff5555 : 0xffffff)
        }
      }
      if (entity.kind === 'creeper' && (entity.fuse ?? 0) > 0) {
        const pulse = 1 + Math.sin((entity.fuse ?? 0) * 28) * 0.035
        view.group.scale.multiplyScalar(pulse)
      }
      const speed = Math.hypot(entity.vx, entity.vz)
      view.walkPhase += dt * (3 + speed * 7)
      const maxSwing = entity.kind === 'enderman' ? 0.4 : 0.75
      const swing = Math.sin(view.walkPhase) * Math.min(maxSwing, speed * 0.28)
      for (let i = 0; i < view.legs.length; i++) {
        const leg = view.legs[i]
        if (entity.kind === 'spider') {
          const pair = i % 4
          const side = i < 4 ? -1 : 1
          const phase = [0, Math.PI, Math.PI / 2, Math.PI * 1.5][pair]
          leg.rotation.x = 0
          leg.rotation.y = leg.userData.baseY + side * Math.cos(view.walkPhase * 1.33 + phase) * 0.22
          leg.rotation.z = leg.userData.baseZ + side * Math.abs(Math.sin(view.walkPhase * 0.67 + phase)) * 0.18
        } else {
          leg.rotation.x = view.legs.length === 4
            ? (i === 0 || i === 3 ? swing : -swing)
            : (i % 2 ? -swing : swing)
        }
      }
      for (let i = 0; i < view.arms.length; i++) {
        const arm = view.arms[i]
        arm.rotation.z = 0
        arm.rotation.y = 0
        if (entity.kind === 'zombie') arm.rotation.x = 1.45 + (i % 2 ? swing : -swing) * 0.15
        else if (entity.kind === 'skeleton') {
          arm.rotation.x = 1.25 + Math.sin(view.walkPhase * 0.35) * 0.08
          arm.rotation.y = i === 0 ? -0.18 : 0.18
        }
        else if (entity.kind === 'enderman' && entity.carriedBlock !== null) {
          arm.rotation.x = 0.5
          arm.rotation.z = i === 0 ? 0.05 : -0.05
        } else {
          arm.rotation.x = (i % 2 ? swing : -swing) * (entity.kind === 'enderman' ? 0.5 : 1)
        }
      }
      const relativeHeadYaw = Math.atan2(
        Math.sin(entity.headYaw - entity.yaw), Math.cos(entity.headYaw - entity.yaw)
      )
      view.head.rotation.y = Math.max(-1.3, Math.min(1.3, relativeHeadYaw))
      view.head.rotation.x = entity.headPitch + Math.sin(view.walkPhase * 0.18) * 0.08
      if (view.wings.length === 2) {
        const flap = 0.25 + Math.sin(entity.wingRotation) * 0.55
        view.wings[0].rotation.z = -flap
        view.wings[1].rotation.z = flap
      }
      for (let i = 0; i < view.tails.length; i++) {
        view.tails[i].rotation.z = Math.sin(view.walkPhase * 0.65 + i * 0.4) * 0.18
      }
      if (view.tentacles.length > 0) {
        const curl = 0.18 + Math.sin(view.walkPhase * 0.55) * 0.22
        for (const tentacle of view.tentacles) tentacle.rotation.x = curl
      }
      if (view.segments.length > 0) {
        const lookYaw = view.head.rotation.y
        for (let i = 0; i < view.segments.length; i++) {
          const segment = view.segments[i]
          const distanceFromShoulders = Math.abs(i - 2)
          const phase = view.walkPhase * 0.9 + i * Math.PI * 0.15
          segment.rotation.x = 0
          segment.rotation.y = Math.cos(phase) * 0.12 * (1 + distanceFromShoulders) +
            (i === 0 ? lookYaw * 0.2 : 0)
          segment.position.x = segment.userData.silverfishBaseX +
            Math.sin(phase) * 0.018 * distanceFromShoulders
        }
      }
    }
    for (const [id, view] of this.views) {
      if (live.has(id)) continue
      view.group.removeFromParent()
      for (const material of view.materials) material.dispose()
      this.views.delete(id)
    }
  }
  prototype.dispose = function(this: EntityRenderer): void {
    this.group.removeFromParent()
    for (const view of this.views.values()) for (const material of view.materials) material.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials.values()) material.dispose()
    this.sheepFurMaterial.dispose()
    this.saddleMaterial.dispose()
    for (const material of this.eyeMaterials.values()) material.dispose()
    this.carriedBlockMaterial.dispose()
    this.mushroomMaterial.dispose()
    this.bowMaterial.dispose()
    for (const texture of this.textures) texture.dispose()
    this.views.clear()
  }
}
