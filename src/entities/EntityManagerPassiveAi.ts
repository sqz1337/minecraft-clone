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

export function installEntityManagerPassiveAi(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.ai = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, dt: number): void {
    if (HOSTILE_KINDS.includes(entity.kind as HostileKind)) {
      entity.activeTask = null
      entity.headYaw = entity.yaw
      entity.headPitch = 0
      this.hostileAi(entity, context, dt)
      return
    }
    if (entity.kind === 'villager') {
      entity.activeTask = null
      entity.headYaw = entity.yaw
      entity.headPitch = 0
      this.villagerAi(entity, context, dt)
      return
    }
    if (entity.kind === 'squid') {
      this.squidAi(entity, dt)
      return
    }
    if (entity.kind === 'iron_golem' && this.ironGolemDefend(entity, dt)) return
    this.passiveAi(entity, context, dt)
  }
  prototype.ironGolemDefend = function(this: EntityManager, entity: EntityState, dt: number): boolean {
    let target: EntityState | null = null
    let best = PASSIVE_DEFINITIONS.iron_golem.followRange
    for (const candidate of this.entities.values()) {
      if (!HOSTILE_KINDS.includes(candidate.kind as HostileKind) || candidate.health <= 0) continue
      const distance = Math.hypot(candidate.x - entity.x, candidate.y - entity.y, candidate.z - entity.z)
      if (distance >= best || !this.canSeeTarget(entity, this.entityTarget(candidate))) continue
      best = distance
      target = candidate
    }
    if (!target) return false
    entity.activeTask = 'protect_village'
    entity.panicTime = 0
    this.lookHeadAt(entity, target.x, target.y + target.height * 0.65, target.z)
    if (best > 2.25) {
      this.navigate(entity, target.x, target.y, target.z, PASSIVE_DEFINITIONS.iron_golem.speed, dt)
    } else {
      entity.vx *= 0.6; entity.vz *= 0.6
      if (entity.attackCooldown <= 0) {
        entity.attackCooldown = 1.2
        this.hooks.effect('golem_attack', entity.x, entity.y + entity.height * 0.65, entity.z)
        this.damage(target.id, 7 + Math.floor(Math.random() * 15), entity.x, entity.z, 6, 0, entity.id)
      }
    }
    return true
  }
  prototype.squidAi = function(this: EntityManager, entity: EntityState, dt: number): void {
    entity.activeTask = 'wander'
    entity.goalTime -= dt
    const arrived = Math.hypot(entity.goalX - entity.x, entity.goalY - entity.y, entity.goalZ - entity.z) < 0.8
    if (entity.goalTime <= 0 || arrived || !this.world.isWater(
      Math.floor(entity.goalX), Math.floor(entity.goalY), Math.floor(entity.goalZ)
    )) {
      entity.goalTime = 2 + Math.random() * 4
      let found = false
      for (let attempt = 0; attempt < 12; attempt++) {
        const angle = Math.random() * Math.PI * 2
        const distance = 2 + Math.random() * 6
        const gx = entity.x + Math.cos(angle) * distance
        const gy = entity.y + (Math.random() - 0.5) * 4
        const gz = entity.z + Math.sin(angle) * distance
        if (!this.world.isWater(Math.floor(gx), Math.floor(gy), Math.floor(gz))) continue
        entity.goalX = gx; entity.goalY = gy; entity.goalZ = gz
        found = true
        break
      }
      if (!found) {
        entity.goalX = entity.x; entity.goalY = entity.y; entity.goalZ = entity.z
      }
    }
    const dx = entity.goalX - entity.x, dy = entity.goalY - entity.y, dz = entity.goalZ - entity.z
    const length = Math.hypot(dx, dy, dz) || 1
    const speed = PASSIVE_DEFINITIONS.squid.speed
    entity.vx += (dx / length * speed - entity.vx) * Math.min(1, dt * 1.8)
    entity.vy += (dy / length * speed * 0.65 - entity.vy) * Math.min(1, dt * 1.8)
    entity.vz += (dz / length * speed - entity.vz) * Math.min(1, dt * 1.8)
    entity.yaw = Math.atan2(-entity.vx, -entity.vz)
    entity.headYaw = entity.yaw
    entity.headPitch = Math.atan2(entity.vy, Math.hypot(entity.vx, entity.vz))
  }
  prototype.passiveAi = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = PASSIVE_DEFINITIONS[entity.kind as PeacefulKind]
    const swimming = entity.inWater || this.touchesWater(entity) ||
      (entity.activeTask === 'swim' && !this.hasDryFooting(entity))
    if (swimming) {
      this.swimToShore(entity, def.speed * 0.85, dt)
      entity.activeTask = 'swim'
      return
    }

    entity.activeTask = this.passiveMovementTask(entity, context, def, dt)
  }
  prototype.passiveMovementTask = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, def: PassiveDefinition, dt: number): PassiveTaskKind {
    if (entity.panicTime > 0) {
      entity.tempting = false
      this.passivePanicTask(entity, def, dt)
      return 'panic'
    }
    if (this.passiveMateTask(entity, def, dt)) return 'mate'
    if (this.passiveTemptTask(entity, context, def, dt)) return 'tempt'
    if (this.passiveFollowParentTask(entity, def, dt)) return 'follow_parent'
    if (this.passiveEatGrassTask(entity)) return 'eat_grass'
    if (this.passiveWanderTask(entity, def, dt)) return 'wander'
    if (this.passiveWatchTask(entity, context)) return 'watch'
    this.passiveIdleLookTask(entity)
    return 'idle'
  }
  prototype.passivePanicTask = function(this: EntityManager, entity: EntityState, def: PassiveDefinition, dt: number): void {
    if (this.simulationTick >= entity.panicGoalUntilTick ||
      Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 1) {
      this.chooseReachablePanicGoal(entity)
    }
    this.lookHeadAt(entity, entity.goalX, entity.goalY + entity.height * 0.5, entity.goalZ)
    this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, def.speed * 1.55, dt)
  }
  prototype.chooseReachablePanicGoal = function(this: EntityManager, entity: EntityState): void {
    let awayX = entity.x - entity.panicSourceX
    let awayZ = entity.z - entity.panicSourceZ
    if (Math.hypot(awayX, awayZ) < 0.01) {
      const randomAngle = Math.random() * Math.PI * 2
      awayX = Math.cos(randomAngle)
      awayZ = Math.sin(randomAngle)
    }
    const baseAngle = Math.atan2(awayZ, awayX)
    const profile = this.navigationProfile(entity, false)
    const start = nodeForPosition(entity.x, entity.y, entity.z, profile)
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = baseAngle + (Math.random() - 0.5) * Math.PI * 0.8
      const distance = 6 + Math.random() * 6
      const desired = nodeForPosition(
        entity.x + Math.cos(angle) * distance, entity.y,
        entity.z + Math.sin(angle) * distance, profile
      )
      const resolved = this.nearestNavigationGoal(desired, profile)
      if (!resolved || !findPath(this.world, start, resolved, profile)) continue
      const center = nodeCenter(resolved, profile)
      entity.goalX = center.x
      entity.goalY = center.y
      entity.goalZ = center.z
      entity.panicGoalUntilTick = this.simulationTick + 20
      return
    }
    const length = Math.hypot(awayX, awayZ) || 1
    entity.goalX = entity.x + awayX / length * 6
    entity.goalY = entity.y
    entity.goalZ = entity.z + awayZ / length * 6
    entity.panicGoalUntilTick = this.simulationTick + 10
  }
  prototype.passiveMateTask = function(this: EntityManager, entity: EntityState, def: PassiveDefinition, dt: number): boolean {
    if (entity.loveTime <= 0 || entity.age < 0 || entity.breedCooldown > 0) {
      entity.mateId = null
      entity.mateCourtshipTicks = 0
      return false
    }
    let mate = entity.mateId ? this.entities.get(entity.mateId) ?? null : null
    if (!this.validMate(entity, mate, BREED_SEARCH_RADIUS)) {
      entity.mateId = null
      entity.mateCourtshipTicks = 0
      mate = this.nearestMate(entity, BREED_SEARCH_RADIUS)
      if (!mate) return false
      entity.mateId = mate.id
      if (!mate.mateId || !this.validMate(mate, this.entities.get(mate.mateId) ?? null, BREED_SEARCH_RADIUS)) {
        mate.mateId = entity.id
        mate.mateCourtshipTicks = 0
      }
      if (mate.mateId !== entity.id) {
        entity.mateId = null
        return false
      }
    }
    if (!mate || mate.mateId !== entity.id) return false
    const distance = Math.hypot(mate.x - entity.x, mate.y - entity.y, mate.z - entity.z)
    const visible = this.canSeeTarget(entity, this.entityTarget(mate))
    entity.mateCourtshipTicks = distance < 3.5 && visible
      ? Math.min(MATE_COURTSHIP_TICKS, entity.mateCourtshipTicks + 1)
      : 0
    this.lookHeadAt(entity, mate.x, mate.y + mate.height * 0.7, mate.z)
    this.navigate(entity, mate.x, mate.y, mate.z, def.speed * 1.12, dt)
    return true
  }
  prototype.validMate = function(this: EntityManager, entity: EntityState, mate: EntityState | null, radius: number): mate is EntityState {
    return !!mate && mate.id !== entity.id && mate.kind === entity.kind && mate.health > 0 &&
      mate.loveTime > 0 && mate.age === 0 && mate.breedCooldown <= 0 &&
      Math.hypot(mate.x - entity.x, mate.y - entity.y, mate.z - entity.z) < radius
  }
  prototype.passiveTemptTask = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, def: PassiveDefinition, dt: number): boolean {
    const player = this.playerTarget({ ...context, playerTargetable: true })
    const distance = this.targetDistance(entity, player)
    let valid = def.temptingItem !== null && context.heldItem === def.temptingItem && entity.temptCooldownTicks <= 0 &&
      distance < 10 && this.canSeeTarget(entity, player)
    if (valid) {
      const profile = this.navigationProfile(entity, false)
      const desired = nodeForPosition(context.player.x, context.player.y, context.player.z, profile)
      const goalChanged = !entity.navRequested || entity.navRequested.x !== desired.x ||
        entity.navRequested.y !== desired.y || entity.navRequested.z !== desired.z
      if (goalChanged) {
        const start = nodeForPosition(entity.x, entity.y, entity.z, profile)
        const goal = this.nearestNavigationGoal(desired, profile)
        valid = !!goal && !!findPath(this.world, start, goal, profile)
      }
    }
    if (!valid) {
      entity.tempting = false
      return false
    }

    const look = context.look ?? { x: 0, y: 0, z: 0 }
    if (entity.tempting && distance < 6) {
      const movedSq = (context.player.x - entity.temptPlayerX) ** 2 +
        (context.player.y - entity.temptPlayerY) ** 2 +
        (context.player.z - entity.temptPlayerZ) ** 2
      const oldLookLength = Math.hypot(entity.temptLookX, entity.temptLookY, entity.temptLookZ)
      const lookLength = Math.hypot(look.x, look.y, look.z)
      const lookDot = oldLookLength > 0 && lookLength > 0
        ? (look.x * entity.temptLookX + look.y * entity.temptLookY + look.z * entity.temptLookZ) /
          (oldLookLength * lookLength)
        : 1
      if (movedSq > 0.01 || lookDot < Math.cos(Math.PI / 36)) {
        entity.tempting = false
        entity.temptCooldownTicks = TEMPT_COOLDOWN_TICKS
        this.clearNavigation(entity, 10)
        return false
      }
    }
    entity.tempting = true
    entity.temptPlayerX = context.player.x
    entity.temptPlayerY = context.player.y
    entity.temptPlayerZ = context.player.z
    entity.temptLookX = look.x
    entity.temptLookY = look.y
    entity.temptLookZ = look.z
    this.lookHeadAt(entity, context.player.x, context.player.y + 1.55, context.player.z)
    if (distance > 1.8) {
      this.navigate(entity, context.player.x, context.player.y, context.player.z, def.speed * 1.1, dt)
    } else {
      entity.vx *= 0.72
      entity.vz *= 0.72
    }
    return true
  }
  prototype.passiveFollowParentTask = function(this: EntityManager, entity: EntityState, def: PassiveDefinition, dt: number): boolean {
    if (entity.age >= 0) return false
    let parent: EntityState | null = null
    let best = 16
    for (const candidate of this.entities.values()) {
      if (candidate.id === entity.id || candidate.kind !== entity.kind || candidate.age !== 0 || candidate.health <= 0) continue
      const distance = Math.hypot(candidate.x - entity.x, candidate.y - entity.y, candidate.z - entity.z)
      if (distance >= best || !this.canSeeTarget(entity, this.entityTarget(candidate))) continue
      best = distance
      parent = candidate
    }
    if (!parent || best <= 3) return false
    this.lookHeadAt(entity, parent.x, parent.y + parent.height * 0.65, parent.z)
    this.navigate(entity, parent.x, parent.y, parent.z, def.speed * 1.1, dt)
    return true
  }
  prototype.passiveEatGrassTask = function(this: EntityManager, entity: EntityState): boolean {
    if (entity.kind !== 'sheep') return false
    if (entity.eatGrassTicks <= 0 && this.simulationTick >= entity.nextGrassAttemptTick) {
      entity.nextGrassAttemptTick = this.simulationTick + 1
      const chance = entity.age < 0 ? 1 / 50 : 1 / 1000
      if (this.hasEdibleGrass(entity) && Math.random() < chance) entity.eatGrassTicks = 40
    }
    if (entity.eatGrassTicks <= 0) return false
    entity.vx *= 0.55
    entity.vz *= 0.55
    entity.headYaw = entity.yaw
    entity.headPitch = 0.9
    entity.eatGrassTicks--
    if (entity.eatGrassTicks === 4 && this.tryEatGrass(entity) && entity.age < 0) {
      // Java stores age in ticks; +60 ticks is three seconds in this real-time state.
      entity.age = Math.min(0, entity.age + 60 * STEP)
    }
    return true
  }
  prototype.hasEdibleGrass = function(this: EntityManager, entity: EntityState): boolean {
    const x = Math.floor(entity.x), y = Math.floor(entity.y + 0.1), z = Math.floor(entity.z)
    return this.world.getBlock(x, y, z) === B.TALLGRASS || this.world.getBlock(x, y - 1, z) === B.GRASS
  }
  prototype.passiveWanderTask = function(this: EntityManager, entity: EntityState, def: PassiveDefinition, dt: number): boolean {
    const arrived = Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 0.7
    if (entity.goalTime > 0 && !arrived) {
      entity.goalTime = Math.max(0, entity.goalTime - dt)
      entity.headYaw = entity.yaw
      entity.headPitch = 0
      this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, def.speed * 0.72, dt, 'none', true)
      return true
    }
    entity.goalTime = 0
    if (Math.random() >= 1 / 80) return false
    const angle = Math.random() * Math.PI * 2
    const distance = 2 + Math.random() * 6
    entity.goalX = entity.x + Math.cos(angle) * distance
    entity.goalY = entity.y
    entity.goalZ = entity.z + Math.sin(angle) * distance
    entity.goalTime = 2 + Math.random() * 5
    this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, def.speed * 0.72, dt, 'none', true)
    return true
  }
  prototype.passiveWatchTask = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext): boolean {
    const player = this.playerTarget({ ...context, playerTargetable: true })
    const visible = this.targetDistance(entity, player) < 6 && this.canSeeTarget(entity, player)
    if (!visible) {
      entity.watchUntilTick = 0
      return false
    }
    if (entity.watchUntilTick <= this.simulationTick) {
      if (Math.random() >= 1 / 40) return false
      entity.watchUntilTick = this.simulationTick + 40 + Math.floor(Math.random() * 40)
    }
    entity.vx *= 0.78
    entity.vz *= 0.78
    this.lookHeadAt(entity, context.player.x, context.player.y + 1.55, context.player.z)
    return true
  }
  prototype.passiveIdleLookTask = function(this: EntityManager, entity: EntityState): void {
    entity.vx *= 0.78
    entity.vz *= 0.78
    entity.headPitch = 0
    if (entity.idleLookUntilTick <= this.simulationTick) {
      entity.idleLookUntilTick = this.simulationTick + 20 + Math.floor(Math.random() * 40)
      entity.idleLookYaw = entity.yaw + (Math.random() - 0.5) * Math.PI
    }
    const delta = Math.atan2(
      Math.sin(entity.idleLookYaw - entity.headYaw), Math.cos(entity.idleLookYaw - entity.headYaw)
    )
    entity.headYaw += clamp(delta, -0.18, 0.18)
  }
  prototype.lookHeadAt = function(this: EntityManager, entity: EntityState, x: number, y: number, z: number): void {
    const dx = x - entity.x, dz = z - entity.z
    const desiredYaw = Math.atan2(-dx, -dz)
    const yawDelta = Math.atan2(Math.sin(desiredYaw - entity.headYaw), Math.cos(desiredYaw - entity.headYaw))
    entity.headYaw += clamp(yawDelta, -0.28, 0.28)
    const horizontal = Math.max(0.001, Math.hypot(dx, dz))
    const eyeY = entity.y + entity.height * (entity.age < 0 ? 0.58 : 1) * 0.82
    entity.headPitch = clamp(-Math.atan2(y - eyeY, horizontal), -0.65, 0.65)
  }
}
