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
  canOccupyNode, canTravelDirectly, findPath, nodeCenter, nodeForPosition,
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

export function installEntityManagerNavigation(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.navigationProfile = function(this: EntityManager, entity: EntityState, canOpenDoors: boolean, canSwim = true): NavProfile {
    const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
    return {
      width: entity.width * scale,
      height: entity.height * scale,
      maxStep: 1,
      maxFall: 3,
      canSwim: canSwim && entity.kind !== 'enderman',
      canOpenDoors,
      waterCost: 2,
      maxVisited: 768,
      maxDistance: 32
    }
  }
  prototype.nearestNavigationGoal = function(this: EntityManager, goal: NavNode, profile: NavProfile): NavNode | null {
    const direct = canOccupyNode(this.world, goal, profile)
    if (direct) return direct
    const vertical = [0, 1, -1, 2, -2, 3, -3]
    for (let radius = 1; radius <= 2; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (const dz of [-radius, radius]) {
          for (const dy of vertical) {
            const node = canOccupyNode(this.world, { x: goal.x + dx, y: goal.y + dy, z: goal.z + dz }, profile)
            if (node) return node
          }
        }
      }
      for (let dz = -radius + 1; dz < radius; dz++) {
        for (const dx of [-radius, radius]) {
          for (const dy of vertical) {
            const node = canOccupyNode(this.world, { x: goal.x + dx, y: goal.y + dy, z: goal.z + dz }, profile)
            if (node) return node
          }
        }
      }
    }
    return null
  }
  prototype.swimToShore = function(this: EntityManager, entity: EntityState, speed: number, dt: number, canOpenDoors = false): boolean {
    if (entity.inWater || this.touchesWater(entity)) entity.vy = Math.max(entity.vy, 3.2)
    const swimProfile = this.navigationProfile(entity, canOpenDoors, true)
    const dryProfile = this.navigationProfile(entity, canOpenDoors, false)

    let shore = entity.navGoal ? canOccupyNode(this.world, entity.navGoal, dryProfile) : null
    if (!shore || Math.hypot(shore.x - entity.x, shore.z - entity.z) > 14) {
      const start = nodeForPosition(entity.x, entity.y, entity.z, swimProfile)
      const vertical = [0, 1, -1, 2, -2, 3, -3]
      shore = null
      for (let radius = 1; radius <= 12 && !shore; radius++) {
        const candidates: [number, number][] = []
        for (let offset = -radius; offset <= radius; offset++) {
          candidates.push([start.x + offset, start.z - radius], [start.x + offset, start.z + radius])
        }
        for (let offset = -radius + 1; offset < radius; offset++) {
          candidates.push([start.x - radius, start.z + offset], [start.x + radius, start.z + offset])
        }
        for (const [x, z] of candidates) {
          for (const dy of vertical) {
            const candidate = canOccupyNode(this.world, { x, y: start.y + dy, z }, dryProfile)
            if (!candidate || !findPath(this.world, start, candidate, swimProfile)) continue
            shore = candidate
            break
          }
          if (shore) break
        }
      }
      this.clearNavigation(entity)
      if (!shore) {
        entity.vx *= 0.8
        entity.vz *= 0.8
        return false
      }
    }

    const goal = nodeCenter(shore, swimProfile)
    entity.goalX = goal.x
    entity.goalY = goal.y
    entity.goalZ = goal.z
    entity.goalTime = Math.max(entity.goalTime, 2)
    return this.navigate(entity, goal.x, goal.y, goal.z, speed, dt, canOpenDoors ? 'open' : 'none')
  }
  prototype.navigate = function(this: EntityManager, entity: EntityState, goalX: number, goalY: number, goalZ: number, speed: number, dt: number, doorMode: 'none' | 'open' | 'break' = 'none', avoidWater = false): boolean {
    const profile = this.navigationProfile(entity, doorMode !== 'none', !avoidWater)
    const desired = nodeForPosition(goalX, goalY, goalZ, profile)
    let plannedThisTick = false

    if (this.simulationTick >= entity.navProgressAt) {
      const moved = Math.hypot(
        entity.x - entity.navProgressX,
        entity.z - entity.navProgressZ
      )
      if (entity.navIndex < entity.navPath.length && moved < 0.2 && !this.isBreakingClosedDoor(entity)) {
        entity.navStuckCount++
        entity.navPath = []
        entity.navIndex = 0
        entity.navRequested = null
        entity.navGoal = null
        this.resetDoorBreak(entity)
        entity.nextPathAt = this.simulationTick + (entity.navStuckCount >= 3 ? 40 : 0)
      } else if (moved >= 0.2) {
        entity.navStuckCount = 0
      }
      entity.navProgressAt = this.simulationTick + 20
      entity.navProgressX = entity.x
      entity.navProgressY = entity.y
      entity.navProgressZ = entity.z
    }

    let next: NavNode | undefined = entity.navPath[entity.navIndex]
    if (next) {
      const valid = canOccupyNode(this.world, next, profile)
      if (!valid) {
        entity.navPath = []
        entity.navIndex = 0
        entity.navRequested = null
        entity.navGoal = null
        entity.nextPathAt = this.simulationTick
        next = undefined
      } else {
        entity.navPath[entity.navIndex] = next = valid
      }
    }

    const goalChanged = !entity.navRequested || entity.navRequested.x !== desired.x ||
      entity.navRequested.y !== desired.y || entity.navRequested.z !== desired.z
    const exhausted = entity.navIndex >= entity.navPath.length
    const currentNode = nodeForPosition(entity.x, entity.y, entity.z, profile)
    const arrived = exhausted && !!entity.navGoal && currentNode.x === entity.navGoal.x &&
      currentNode.y === entity.navGoal.y && currentNode.z === entity.navGoal.z
    if ((goalChanged || (exhausted && !arrived)) && this.simulationTick >= entity.nextPathAt && this.pathPlansThisTick < 2) {
      const resolvedGoal = this.nearestNavigationGoal(desired, profile)
      const start = nodeForPosition(entity.x, entity.y, entity.z, profile)
      this.pathPlansThisTick++
      this.pathPlanN++
      entity.navPath = resolvedGoal ? findPath(this.world, start, resolvedGoal, profile) ?? [] : []
      entity.navIndex = entity.navPath.length > 1 ? 1 : entity.navPath.length
      entity.navRequested = desired
      entity.navGoal = resolvedGoal
      plannedThisTick = true
      // Vanilla pursuit recalculates in 4-10 ticks. Wandering can keep the
      // cheaper general cadence because its destination is not moving.
      entity.nextPathAt = this.simulationTick + (entity.targetId !== null
        ? 4 + Math.floor(Math.random() * 7)
        : TARGET_SCAN_MIN_TICKS + Math.floor(Math.random() * TARGET_SCAN_JITTER_TICKS))
      next = entity.navPath[entity.navIndex]
    }

    const arrivalRadius = Math.max(0.32, profile.width)
    while (next) {
      const center = nodeCenter(next, profile)
      // A wider vanilla-style arrival radius must never advance past a closed
      // door before the open/break action below has completed.
      if (next.terrain === 'door' &&
        this.world.doorState?.(next.x, next.y, next.z) === 'closed') break
      // Swimming bodies bob around the liquid surface and can be more than half
      // a block above the discrete water node. Horizontal arrival is sufficient
      // there; requiring the feet Y to match leaves mobs circling waypoint one.
      const verticalReached = next.terrain === 'water' || Math.abs(center.y - entity.y) <= 0.65
      if (Math.hypot(center.x - entity.x, center.z - entity.z) > arrivalRadius || !verticalReached) break
      entity.navIndex++
      next = entity.navPath[entity.navIndex]
    }

    // PathNavigate skips to the furthest same-level node with a collision-free
    // direct route. This removes the Manhattan staircase visible on open ground.
    if (!plannedThisTick && next?.terrain === 'ground') {
      for (let index = entity.navPath.length - 1; index > entity.navIndex; index--) {
        const candidate = entity.navPath[index]
        if (candidate.y !== next.y || candidate.terrain !== 'ground') continue
        if (!canTravelDirectly(this.world, entity.x, entity.y, entity.z, candidate, profile)) continue
        entity.navIndex = index
        next = candidate
        break
      }
    }

    if (!next) {
      // Finish within the final cell without another A* pass.
      if (entity.navGoal && Math.hypot(goalX - entity.x, goalZ - entity.z) < 1.1) {
        this.steer(entity, goalX, goalZ, speed, dt)
        return true
      }
      entity.vx *= 0.78
      entity.vz *= 0.78
      return false
    }

    const waypoint = nodeCenter(next, profile)
    if (next.terrain === 'door' && Math.hypot(waypoint.x - entity.x, waypoint.z - entity.z) < 1.5) {
      if (doorMode === 'break') {
        const sameDoor = entity.doorBreakX === next.x && entity.doorBreakY === next.y && entity.doorBreakZ === next.z
        if (!sameDoor) {
          entity.doorBreakX = next.x
          entity.doorBreakY = next.y
          entity.doorBreakZ = next.z
          entity.doorBreakTicks = 0
        }
        entity.doorBreakTicks++
        entity.vx *= 0.72
        entity.vz *= 0.72
        if (entity.doorBreakTicks >= 240) {
          const broken = this.world.breakDoor?.(next.x, next.y, next.z) ?? false
          entity.doorBreakTicks = 0
          if (broken) this.clearNavigation(entity)
          else this.clearNavigation(entity, 10)
        }
        return false
      }
      entity.doorBreakTicks = 0
      if (doorMode !== 'open' || !this.world.openDoor?.(next.x, next.y, next.z)) {
        this.clearNavigation(entity, 10)
        entity.vx *= 0.72
        entity.vz *= 0.72
        return false
      }
    } else if (entity.doorBreakTicks > 0) {
      entity.doorBreakTicks = 0
    }
    if (next.terrain === 'water') entity.vy = Math.max(entity.vy, 1.8)
    if (waypoint.y > entity.y + 0.35 && (entity.onGround || entity.inWater)) {
      entity.vy = Math.max(entity.vy, 7.6)
    }
    this.steer(entity, waypoint.x, waypoint.z, speed, dt)
    return true
  }
  prototype.clearNavigation = function(this: EntityManager, entity: EntityState, delay = 0): void {
    entity.navPath = []
    entity.navIndex = 0
    entity.navRequested = null
    entity.navGoal = null
    entity.nextPathAt = this.simulationTick + delay
    entity.navStuckCount = 0
    entity.navProgressAt = this.simulationTick + 20
    entity.navProgressX = entity.x
    entity.navProgressY = entity.y
    entity.navProgressZ = entity.z
    this.resetDoorBreak(entity)
  }
  prototype.isBreakingClosedDoor = function(this: EntityManager, entity: EntityState): boolean {
    return entity.doorBreakTicks > 0 &&
      this.world.doorState?.(entity.doorBreakX, entity.doorBreakY, entity.doorBreakZ) === 'closed'
  }
  prototype.resetDoorBreak = function(this: EntityManager, entity: EntityState): void {
    entity.doorBreakTicks = 0
    entity.doorBreakX = 0
    entity.doorBreakY = 0
    entity.doorBreakZ = 0
  }
  prototype.faceToward = function(this: EntityManager, entity: EntityState, targetYaw: number, dt: number, rate = Math.PI * 10 / 3): void {
    const delta = Math.atan2(Math.sin(targetYaw - entity.yaw), Math.cos(targetYaw - entity.yaw))
    entity.yaw += clamp(delta, -rate * dt, rate * dt)
  }
  prototype.steer = function(this: EntityManager, entity: EntityState, goalX: number, goalZ: number, speed: number, dt: number): void {
    const dx = goalX - entity.x, dz = goalZ - entity.z, len = Math.hypot(dx, dz)
    if (len <= 0.25) { entity.vx *= 0.82; entity.vz *= 0.82; return }
    entity.vx += (dx / len * speed - entity.vx) * clamp(dt * 8, 0, 1)
    entity.vz += (dz / len * speed - entity.vz) * clamp(dt * 8, 0, 1)
    // Face where we are actually moving, not the raw goal. The goal direction
    // flips sign on tiny position noise when a mob is near/milling on its target,
    // which snapped the body left-right each tick; velocity carries momentum and
    // is smoothed above, so heading off it is stable. Freeze the turn when nearly
    // stopped — a near-zero velocity has no meaningful heading (vanilla behaviour).
    const moveSpeed = Math.hypot(entity.vx, entity.vz)
    if (moveSpeed > 0.35) {
      const targetX = entity.vx / moveSpeed
      const targetZ = entity.vz / moveSpeed
      const headingBlend = clamp(dt * 8, 0, 1)
      entity.headingX += (targetX - entity.headingX) * headingBlend
      entity.headingZ += (targetZ - entity.headingZ) * headingBlend
      const headingLength = Math.hypot(entity.headingX, entity.headingZ)
      if (headingLength > 0.2) {
        entity.headingX /= headingLength
        entity.headingZ /= headingLength
        this.faceToward(entity, Math.atan2(-entity.headingX, -entity.headingZ), dt)
      }
    }
  }
}
