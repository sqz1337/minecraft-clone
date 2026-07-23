import * as THREE from 'three'
import type { Atlas } from '../gfx/Atlas'
import {
  B, blockCollisionBox, infestedBlockFor, isFluid, isInfestedBlock, isLava,
  type HorizontalFace
} from '../world/Blocks'
import { BIOME } from '../world/WorldGen'
import { I } from '../world/ItemIds'
import { explosionDamage } from '../player/Combat'
import { EntityRenderer } from './EntityRenderer'
import {
  canOccupyNode, findPath, nodeCenter, nodeForPosition,
  type NavNode, type NavProfile
} from './Pathfinder'
import {
  VillageGraph,
  type VillageDoorNode, type VillageMetadata, type VillageNode
} from './VillageGraph'
import {
  HOSTILE_KINDS, MOB_KINDS, PASSIVE_KINDS, SPECIAL_PASSIVE_KINDS, VILLAGER_KINDS,
  type EntityInteractionResult, type EntityRiderPose, type EntitySnapshot,
  type HostileDefinition, type HostileKind, type MobDefinition,
  type MobKind, type PassiveDefinition, type PassiveKind, type PeacefulKind, type SavedEntity,
  type VillagerDefinition, type VillagerKind, type VillagerProfession
} from './EntityTypes'
import { CHUNK_SIZE, GRAVITY, STEP, MAX_STEPS, ELIGIBLE_CHUNK_RADIUS, ELIGIBLE_CHUNK_COUNT, SPAWNABLE_CHUNK_COUNT, ACTIVE_CHUNKS, scaledMobCap, PASSIVE_MOB_CAP, HOSTILE_MOB_CAP, ENTITY_HARD_CAP, BREED_SEARCH_RADIUS, BREED_DISTANCE, DEATH_ANIMATION_SECONDS, NATURAL_PASSIVE_LOCAL_CAP, WORLDGEN_ANIMAL_CAP, PLAYER_TARGET_ID, TARGET_MEMORY_TICKS, TARGET_SCAN_MIN_TICKS, TARGET_SCAN_JITTER_TICKS, ENDERMAN_STARE_TICKS, SILVERFISH_HELP_DELAY_TICKS, SILVERFISH_HELP_HORIZONTAL_RADIUS, SILVERFISH_HELP_VERTICAL_RADIUS, SILVERFISH_HIDE_RETRY_TICKS, MATE_COURTSHIP_TICKS, TEMPT_COOLDOWN_TICKS, HARD_DESPAWN_DISTANCE_SQ, RANDOM_DESPAWN_DISTANCE_SQ, RANDOM_DESPAWN_AGE_TICKS, RANDOM_DESPAWN_CHANCE, ENDERMAN_CARRYABLE, SILVERFISH_HIDE_DIRECTIONS, EligibleChunk, eligibleChunksAround, EntityWorld, EntityHooks, PASSIVE_DEFINITIONS, VILLAGER_DEFINITIONS, HOSTILE_DEFINITIONS, MOB_DEFINITIONS, SpawnEntry, HOSTILE_SPAWN_ENTRIES, PASSIVE_SPAWN_ENTRIES, JUNGLE_PASSIVE_SPAWN_ENTRIES, FOREST_PASSIVE_SPAWN_ENTRIES, WATER_PASSIVE_SPAWN_ENTRIES, MUSHROOM_PASSIVE_SPAWN_ENTRIES, spawnEntriesForBiome, pickWeightedSpawnEntry, EntityState, EntityUpdateContext, AiTarget, TrackedTarget, NavigationIntent, PassiveTaskKind, SpawnValidationOptions, EntityRayHit, noopHooks, finite, clamp, silverfishHideDelay, normalizeSlimeScale, scratchRay, scratchBox, scratchHit, hostileSpawnAllowed, isPeacefulKind } from './EntityManagerShared'
import type { EntityManager } from './EntityManager'

type EntityManagerConstructor = { prototype: EntityManager }

export function installEntityManagerHostileAi(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.hostileAi = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = HOSTILE_DEFINITIONS[entity.kind as HostileKind]
    const swimming = entity.inWater || this.touchesWater(entity) ||
      (entity.navPath.some(node => node.terrain === 'water') && !this.hasDryFooting(entity))
    // Endermen keep their dedicated water-damage/teleport response. Other land
    // hostiles use the same shore-seeking escape as animals and villagers.
    if (swimming && entity.kind !== 'enderman') {
      this.swimToShore(entity, def.speed * 0.9, dt)
      return
    }
    const playerTarget = this.playerTarget(context)
    const spiderBright = entity.kind === 'spider' && entity.panicTime <= 0 &&
      this.effectiveLight(entity.x, entity.y + 0.45, entity.z, context.skyDarkness ?? 0) >= 8
    if (entity.kind === 'silverfish') this.updateSilverfishCallForHelp(entity)
    if (entity.kind === 'enderman') this.updateEndermanEnvironment(entity, context)
    this.selectHostileTarget(entity, context, def, playerTarget, spiderBright)
    const tracked = this.continueHostileTarget(entity, context, def, spiderBright)
    if (!tracked && entity.kind === 'silverfish' && this.trySilverfishHide(entity)) return
    if (tracked && entity.kind === 'enderman') this.updateEndermanTeleportState(entity, context, tracked)
    if (!tracked && entity.kind === 'enderman') this.updateEndermanBlock(entity)
    const intent = tracked
      ? this.hostileAttackAction(entity, context, def, tracked, dt)
      : this.hostileWanderIntent(entity, def, dt)
    if (entity.kind === 'slime') {
      this.applySlimeMovement(entity, intent, !!tracked, dt)
      return
    }
    this.applyNavigationIntent(entity, intent, dt)
  }
  prototype.selectHostileTarget = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, def: HostileDefinition, player: AiTarget, spiderBright: boolean): void {
    if (entity.kind === 'enderman') this.updateEndermanStare(entity, context, player)
    if (entity.revengeTargetId && entity.targetId !== entity.revengeTargetId) {
      const attacker = this.entities.get(entity.revengeTargetId)
      if (attacker?.health) this.rememberTarget(entity, this.entityTarget(attacker))
      else entity.revengeTargetId = null
    }
    if (entity.targetId || this.simulationTick < entity.nextTargetScanAt) return
    entity.nextTargetScanAt = this.simulationTick + TARGET_SCAN_MIN_TICKS +
      Math.floor(Math.random() * TARGET_SCAN_JITTER_TICKS)
    const mayTargetPlayer = !spiderBright && (entity.kind !== 'enderman' || entity.angryTime > 0)
    if (mayTargetPlayer && this.canAcquireTarget(entity, player, def.followRange)) {
      this.rememberTarget(entity, player)
      return
    }
    if (entity.kind === 'zombie') {
      const villager = this.nearestVisibleVillager(entity, 16)
      if (villager) this.rememberTarget(entity, villager)
    }
  }
  prototype.continueHostileTarget = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, def: HostileDefinition, spiderBright: boolean): TrackedTarget | null {
    let target = this.resolveTarget(entity.targetId, context)
    if (target && !this.isAllowedTarget(entity, target)) target = null
    if (entity.kind === 'enderman' && entity.angryTime <= 0 && target?.id === PLAYER_TARGET_ID) target = null
    if (spiderBright && target?.id === PLAYER_TARGET_ID && Math.random() < 0.01) target = null
    if (!target) {
      if (entity.targetId) this.clearTarget(entity)
      return null
    }

    const distance = this.targetDistance(entity, target)
    const hasSight = this.canSeeTarget(entity, target)
    const visible = distance <= def.followRange * 1.5 && hasSight
    if (visible) this.updateLastSeen(entity, target)
    const breakingDoor = entity.kind === 'zombie' && this.isBreakingClosedDoor(entity)
    if ((hasSight && distance > def.followRange * 2) ||
      (this.simulationTick - entity.lastSeenAt > TARGET_MEMORY_TICKS && !breakingDoor)) {
      this.clearTarget(entity)
      return null
    }
    const goal = visible ? target : entity.lastSeenPosition
    return goal ? { target, visible, distance, goal } : null
  }
  prototype.hostileWanderIntent = function(this: EntityManager, entity: EntityState, def: HostileDefinition, dt: number): NavigationIntent {
    entity.goalTime -= dt
    if (entity.goalTime <= 0 || Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 0.7) {
      const angle = Math.random() * Math.PI * 2
      entity.goalTime = 2 + Math.random() * 4
      entity.goalX = entity.x + Math.cos(angle) * (2 + Math.random() * 5)
      entity.goalY = entity.y
      entity.goalZ = entity.z + Math.sin(angle) * (2 + Math.random() * 5)
    }
    return {
      kind: 'move', x: entity.goalX, y: entity.goalY, z: entity.goalZ,
      speed: def.speed * 0.65, doorMode: entity.kind === 'zombie' ? 'break' : 'none'
    }
  }
  prototype.hostileAttackAction = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, def: HostileDefinition, tracked: TrackedTarget, dt: number): NavigationIntent {
    const { target, visible, distance, goal } = tracked
    const dx = target.x - entity.x
    const dz = target.z - entity.z
    if (entity.kind === 'creeper' && target.id === PLAYER_TARGET_ID) {
      if (visible && distance < 3.2) {
        if (entity.fuse === 0) this.emitEntitySound(entity, 'fuse')
        entity.fuse += dt
        if (entity.fuse >= 1.5) {
          this.remove(entity.id)
          this.explode(entity.x, entity.y + 0.8, entity.z, 3, context.player)
        }
        return { kind: 'hold', x: entity.x, y: entity.y, z: entity.z, speed: 0 }
      }
      entity.fuse = Math.max(0, entity.fuse - dt * 1.8)
    }

    if (entity.kind === 'skeleton') {
      entity.targetVisibleTicks = visible ? entity.targetVisibleTicks + 1 : 0
      if (visible && distance <= 10 && entity.rangedCooldownTicks <= 0) {
        entity.rangedCooldownTicks = 60
        this.hooks.shootProjectile(
          entity.x, entity.y + 1.45, entity.z,
          target.x, target.y + 1.15, target.z, 3, entity.id
        )
      }
      if (visible && distance <= 10 && entity.targetVisibleTicks >= 20) {
        return {
          kind: 'hold', x: entity.x, y: entity.y, z: entity.z, speed: 0,
          face: { x: target.x, z: target.z }
        }
      }
    }

    if (entity.kind === 'spider' && visible && entity.onGround && distance >= 2 && distance <= 6 && Math.random() < 0.1) {
      const horizontal = Math.hypot(dx, dz) || 1
      entity.vx = dx / horizontal * 5
      entity.vz = dz / horizontal * 5
      entity.vy = Math.max(entity.vy, 6.5)
      return {
        kind: 'leap', x: target.x, y: target.y, z: target.z, speed: 0,
        face: { x: target.x, z: target.z }
      }
    }

    const meleeRange = Math.max(1.25,
      (entity.width * (entity.sizeScale ?? 1) + target.width) * 0.5 + 0.9)
    const slimeSize = (entity.sizeScale ?? 1) * 2
    const attackDamage = entity.kind === 'slime' ? (slimeSize > 1 ? slimeSize : 0) : def.attackDamage
    if (visible && distance < meleeRange && entity.attackCooldown <= 0 && attackDamage > 0) {
      const hit = target.id === PLAYER_TARGET_ID
        ? this.hooks.damagePlayer(attackDamage, entity.x, entity.z, entity.kind === 'enderman' ? 5 : 3.2)
        : this.damage(target.id, attackDamage, entity.x, entity.z, 3.2, 0, entity.id)
      if (hit) entity.attackCooldown = entity.kind === 'spider' ? 0.8 : 1
    }
    return {
      kind: 'move', x: goal.x, y: goal.y, z: goal.z, speed: def.speed,
      doorMode: entity.kind === 'zombie' ? 'break' : 'none'
    }
  }
  prototype.applyNavigationIntent = function(this: EntityManager, entity: EntityState, intent: NavigationIntent, dt: number): void {
    if (intent.kind === 'hold' || intent.kind === 'leap') {
      if (intent.face) {
        this.faceToward(entity, Math.atan2(entity.x - intent.face.x, entity.z - intent.face.z), dt)
      }
      if (intent.kind === 'leap') return
      entity.vx *= 0.72
      entity.vz *= 0.72
      return
    }
    this.navigate(entity, intent.x, intent.y, intent.z, intent.speed, dt, intent.doorMode ?? 'none')
    if (intent.face) {
      this.faceToward(entity, Math.atan2(entity.x - intent.face.x, entity.z - intent.face.z), dt)
    }
  }
  prototype.applySlimeMovement = function(this: EntityManager, entity: EntityState, intent: NavigationIntent, hasTarget: boolean, dt: number): void {
    const dx = intent.x - entity.x, dz = intent.z - entity.z
    const distance = Math.hypot(dx, dz)
    if (distance > 0.1) this.faceToward(entity, Math.atan2(-dx, -dz), dt)
    if (!entity.onGround) return
    entity.slimeJumpDelayTicks--
    if (entity.slimeJumpDelayTicks > 0) {
      entity.vx *= 0.55
      entity.vz *= 0.55
      return
    }
    const normalDelay = 10 + Math.floor(Math.random() * 20)
    entity.slimeJumpDelayTicks = Math.max(1, hasTarget ? Math.floor(normalDelay / 3) : normalDelay)
    const logicalSize = (entity.sizeScale ?? 1) * 2
    entity.vy = Math.max(entity.vy, 7.2 + logicalSize * 0.25)
    if (distance > 0.1) {
      const speed = HOSTILE_DEFINITIONS.slime.speed * (0.82 + logicalSize * 0.045)
      entity.vx = dx / distance * speed
      entity.vz = dz / distance * speed
    }
    entity.onGround = false
  }
  prototype.canAcquireTarget = function(this: EntityManager, entity: EntityState, target: AiTarget, range: number): boolean {
    return this.isAllowedTarget(entity, target) && this.targetDistance(entity, target) <= range &&
      this.canSeeTarget(entity, target)
  }
  prototype.isAllowedTarget = function(this: EntityManager, entity: EntityState, target: AiTarget): boolean {
    if (!target.alive || target.id === entity.id) return false
    if (target.kind === 'player') return true
    if (entity.kind === 'zombie' && target.kind === 'villager') return true
    return entity.revengeTargetId === target.id
  }
  prototype.nearestVisibleVillager = function(this: EntityManager, entity: EntityState, range: number): AiTarget | null {
    let nearest: AiTarget | null = null
    let best = range
    for (const candidate of this.entities.values()) {
      if (candidate.kind !== 'villager' || candidate.health <= 0) continue
      const target = this.entityTarget(candidate)
      const distance = this.targetDistance(entity, target)
      if (distance >= best || !this.canSeeTarget(entity, target)) continue
      best = distance
      nearest = target
    }
    return nearest
  }
  prototype.playerTarget = function(this: EntityManager, context: EntityUpdateContext): AiTarget {
    return {
      id: PLAYER_TARGET_ID, kind: 'player', x: context.player.x, y: context.player.y,
      z: context.player.z, width: 0.6, height: 1.8, alive: context.playerTargetable ?? true
    }
  }
  prototype.entityTarget = function(this: EntityManager, entity: EntityState): AiTarget {
    return {
      id: entity.id, kind: entity.kind, x: entity.x, y: entity.y, z: entity.z,
      width: entity.width * (entity.sizeScale ?? 1),
      height: entity.height * (entity.sizeScale ?? 1), alive: entity.health > 0
    }
  }
  prototype.resolveTarget = function(this: EntityManager, id: string | null, context: EntityUpdateContext): AiTarget | null {
    if (!id) return null
    if (id === PLAYER_TARGET_ID) return this.playerTarget(context)
    const entity = this.entities.get(id)
    return entity ? this.entityTarget(entity) : null
  }
  prototype.targetDistance = function(this: EntityManager, entity: EntityState, target: AiTarget): number {
    return Math.hypot(
      target.x - entity.x,
      target.y + target.height * 0.5 - (entity.y + entity.height * (entity.sizeScale ?? 1) * 0.5),
      target.z - entity.z
    )
  }
  prototype.canSeeTarget = function(this: EntityManager, entity: EntityState, target: AiTarget): boolean {
    return this.hasLineOfSight(
      entity.x, entity.y + entity.height * (entity.sizeScale ?? 1) * 0.85, entity.z,
      target.x, target.y + target.height * 0.85, target.z
    )
  }
  prototype.rememberTarget = function(this: EntityManager, entity: EntityState, target: AiTarget): void {
    if (entity.targetId !== target.id) entity.targetVisibleTicks = 0
    entity.targetId = target.id
    this.updateLastSeen(entity, target)
  }
  prototype.updateLastSeen = function(this: EntityManager, entity: EntityState, target: AiTarget): void {
    entity.lastSeenAt = this.simulationTick
    entity.lastSeenPosition = { x: target.x, y: target.y, z: target.z }
  }
  prototype.clearTarget = function(this: EntityManager, entity: EntityState): void {
    if (entity.revengeTargetId === entity.targetId) entity.revengeTargetId = null
    entity.targetId = null
    entity.lastSeenPosition = null
    entity.lastSeenAt = -Infinity
    entity.targetVisibleTicks = 0
    entity.teleportDelayTicks = 0
    this.clearNavigation(entity)
  }
  prototype.updateEndermanStare = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, player: AiTarget): void {
    const lookedAt = this.isPlayerStaringAtEnderman(entity, context, player)
    entity.stareTicks = lookedAt ? entity.stareTicks + 1 : 0
    if (entity.stareTicks < ENDERMAN_STARE_TICKS) return
    entity.angryTime = 30
    this.rememberTarget(entity, player)
  }
  prototype.isPlayerStaringAtEnderman = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, player = this.playerTarget(context)): boolean {
    if (!player.alive || !context.look || context.headItem === B.PUMPKIN) return false
    const distance = this.targetDistance(entity, player)
    const dx = entity.x - player.x
    const dy = entity.y + entity.height * 0.85 - (player.y + player.height * 0.85)
    const dz = entity.z - player.z
    const inv = 1 / Math.max(0.001, Math.hypot(dx, dy, dz))
    const dot = context.look.x * dx * inv + context.look.y * dy * inv + context.look.z * dz * inv
    return distance <= HOSTILE_DEFINITIONS.enderman.followRange &&
      dot > 1 - 0.025 / Math.max(distance, 0.1) && this.canSeeTarget(entity, player)
  }
  prototype.updateEndermanEnvironment = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext): void {
    const wet = !!context.raining && this.isExposedToSky(entity)
    if (wet && Math.random() < 0.05) this.tryTeleport(entity)
    if (!this.isSunlit(entity, context) || Math.random() >= 0.01) return
    entity.angryTime = 0
    entity.revengeTargetId = null
    if (entity.targetId) this.clearTarget(entity)
    this.tryTeleport(entity)
  }
  prototype.updateEndermanTeleportState = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, tracked: TrackedTarget): void {
    if (tracked.target.id !== PLAYER_TARGET_ID || !tracked.visible) {
      entity.teleportDelayTicks = 0
      return
    }
    if (tracked.distance < 4 && this.isPlayerStaringAtEnderman(entity, context, tracked.target)) {
      entity.teleportDelayTicks = 0
      if (Math.random() < 0.1) this.tryTeleport(entity)
      return
    }
    if (tracked.distance <= 16) {
      entity.teleportDelayTicks = 0
      return
    }
    entity.teleportDelayTicks++
    if (entity.teleportDelayTicks < 30) return
    entity.teleportDelayTicks = 0
    this.tryTeleport(entity, 1, tracked.target)
  }
}
