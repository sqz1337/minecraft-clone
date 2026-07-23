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

export function installEntityManagerVillagerAi(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.villagerAi = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = VILLAGER_DEFINITIONS.villager
    this.tryCloseVillagerDoor(entity)
    const swimming = entity.inWater || this.touchesWater(entity) ||
      (entity.villagerActivity === 'swim' && !this.hasDryFooting(entity, true))
    if (swimming) {
      this.swimToShore(entity, def.speed * 0.85, dt, true)
      entity.villagerActivity = 'swim'
      return
    }
    if (entity.panicTime > 0) {
      this.villagerFlee(entity, entity.panicSourceX, entity.panicSourceZ, def.speed * 1.45, dt)
      entity.villagerActivity = 'panic'
      return
    }

    const zombie = this.villagerThreat(entity)
    if (zombie) {
      this.villagerFlee(entity, zombie.x, zombie.z, def.speed * 1.45, dt)
      entity.villagerActivity = 'avoid'
      return
    }

    const village = this.resolveVillagerVillage(entity)
    const door = this.resolveVillagerDoor(entity, village)
    const time = ((context.timeOfDay ?? 0.32) % 1 + 1) % 1
    const seekShelter = time < 0.23 || time > 0.77 || !!context.raining
    if (seekShelter && door) {
      this.villagerMoveIndoors(entity, door, def.speed, dt)
      entity.villagerActivity = 'indoors'
      return
    }
    const outsideDoorDistance = door ? Math.hypot(
      entity.x - (door.outside.x + 0.5), entity.z - (door.outside.z + 0.5)
    ) : Infinity
    if (!seekShelter && door && (this.isInsideVillageDoor(entity, door) ||
      (entity.pendingDoorKey === door.key && outsideDoorDistance > 0.45))) {
      this.villagerLeaveHouse(entity, door, def.speed, dt)
      entity.villagerActivity = 'leave'
      return
    }
    if (village && Math.hypot(entity.x - village.centerX, entity.z - village.centerZ) > village.radius) {
      this.villagerReturnToVillage(entity, village, def.speed, dt)
      entity.villagerActivity = 'return'
      return
    }
    if (village && this.villagerMateTask(entity, village, def.speed, dt)) {
      entity.villagerActivity = 'mate'
      return
    }
    if (this.villagerSocializeTask(entity)) {
      entity.villagerActivity = 'socialize'
      return
    }
    if (this.villagerWanderTask(entity, village, def.speed, dt)) {
      entity.villagerActivity = 'wander'
      return
    }
    if (this.passiveWatchTask(entity, context)) {
      entity.villagerActivity = 'watch'
      return
    }
    this.passiveIdleLookTask(entity)
    entity.villagerActivity = 'idle'
  }
  prototype.villagerThreat = function(this: EntityManager, entity: EntityState): EntityState | null {
    let threat = entity.avoidTargetId ? this.entities.get(entity.avoidTargetId) ?? null : null
    if (threat?.kind !== 'zombie' || threat.health <= 0 ||
      Math.hypot(threat.x - entity.x, threat.y - entity.y, threat.z - entity.z) > 12) {
      entity.avoidTargetId = null
      threat = null
    }
    if (threat) return threat
    let best = 8
    for (const candidate of this.entities.values()) {
      if (candidate.kind !== 'zombie' || candidate.health <= 0) continue
      const distance = Math.hypot(candidate.x - entity.x, candidate.y - entity.y, candidate.z - entity.z)
      if (distance >= best || !this.canSeeTarget(entity, this.entityTarget(candidate))) continue
      best = distance
      threat = candidate
    }
    entity.avoidTargetId = threat?.id ?? null
    if (threat) entity.avoidGoalUntilTick = 0
    return threat
  }
  prototype.villagerFlee = function(this: EntityManager, entity: EntityState, sourceX: number, sourceZ: number, speed: number, dt: number): void {
    if (this.simulationTick >= entity.avoidGoalUntilTick ||
      Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 1) {
      entity.panicSourceX = sourceX
      entity.panicSourceZ = sourceZ
      this.chooseReachablePanicGoal(entity)
      entity.avoidGoalUntilTick = this.simulationTick + 20
    }
    this.lookHeadAt(entity, entity.goalX, entity.goalY + 1, entity.goalZ)
    this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, speed, dt, 'open')
  }
  prototype.resolveVillagerVillage = function(this: EntityManager, entity: EntityState): VillageNode | null {
    let village = entity.villageId ? this.villageGraph.getVillage(entity.villageId) : null
    if (!village) village = this.villageGraph.villageAt(entity) ?? this.villageGraph.nearestVillage(entity, 64)
    if (village) entity.villageId = village.id
    return village
  }
  prototype.resolveVillagerDoor = function(this: EntityManager, entity: EntityState, village: VillageNode | null): VillageDoorNode | null {
    let door = entity.homeDoorKey ? this.villageGraph.getDoor(entity.homeDoorKey) : null
    if (door && this.world.doorState && this.world.doorState(door.x, door.y, door.z) === null) {
      this.villageGraph.markDoorBroken(door.key)
      door = null
    }
    if (!door && village) {
      for (const candidate of this.villageGraph.listValidDoors(village.id)) {
        if (this.world.doorState && this.world.doorState(candidate.x, candidate.y, candidate.z) === null) {
          this.villageGraph.markDoorBroken(candidate.key)
          continue
        }
        if (!door || Math.hypot(
          candidate.x + 0.5 - entity.x, candidate.y - entity.y, candidate.z + 0.5 - entity.z
        ) < Math.hypot(door.x + 0.5 - entity.x, door.y - entity.y, door.z + 0.5 - entity.z)) door = candidate
      }
    }
    if (!door) {
      entity.homeDoorKey = null
      return null
    }
    entity.homeDoorKey = door.key
    entity.homeX = door.inside.x + 0.5
    entity.homeY = door.inside.y + 0.01
    entity.homeZ = door.inside.z + 0.5
    return door
  }
  prototype.isInsideVillageDoor = function(this: EntityManager, entity: EntityState, door: VillageDoorNode): boolean {
    const nx = door.outside.x - door.inside.x
    const nz = door.outside.z - door.inside.z
    return (entity.x - (door.x + 0.5)) * nx + (entity.z - (door.z + 0.5)) * nz < -0.05
  }
  prototype.villagerMoveIndoors = function(this: EntityManager, entity: EntityState, door: VillageDoorNode, speed: number, dt: number): void {
    if (this.isInsideVillageDoor(entity, door) &&
      Math.hypot(entity.x - (door.inside.x + 0.5), entity.z - (door.inside.z + 0.5)) < 0.45) {
      entity.vx *= 0.65
      entity.vz *= 0.65
      this.scheduleVillagerDoorClose(entity, door)
      return
    }
    this.openVillageDoorNear(entity, door)
    this.navigate(entity, door.inside.x + 0.5, door.inside.y + 0.01, door.inside.z + 0.5, speed, dt, 'open')
  }
  prototype.villagerLeaveHouse = function(this: EntityManager, entity: EntityState, door: VillageDoorNode, speed: number, dt: number): void {
    this.openVillageDoorNear(entity, door)
    const reached = Math.hypot(
      entity.x - (door.outside.x + 0.5), entity.z - (door.outside.z + 0.5)
    ) < 0.45
    if (reached) {
      this.scheduleVillagerDoorClose(entity, door)
      return
    }
    this.navigate(entity, door.outside.x + 0.5, door.outside.y + 0.01, door.outside.z + 0.5, speed, dt, 'open')
  }
  prototype.openVillageDoorNear = function(this: EntityManager, entity: EntityState, door: VillageDoorNode): void {
    if (Math.hypot(entity.x - (door.x + 0.5), entity.z - (door.z + 0.5)) > 2.2) return
    const opened = this.world.setDoorOpen
      ? this.world.setDoorOpen(door.x, door.y, door.z, true)
      : this.world.openDoor?.(door.x, door.y, door.z) ?? false
    if (opened && entity.pendingDoorKey !== door.key) {
      // Arm a conservative fallback close as soon as the door opens. Crossing
      // the plane shortens it to 20 ticks; occupancy checks prevent clipping.
      entity.pendingDoorKey = door.key
      entity.closeDoorAt = this.simulationTick + 40
    }
  }
  prototype.scheduleVillagerDoorClose = function(this: EntityManager, entity: EntityState, door: VillageDoorNode): void {
    if (this.world.doorState?.(door.x, door.y, door.z) !== 'open') return
    entity.pendingDoorKey = door.key
    entity.closeDoorAt = Math.min(entity.closeDoorAt || Infinity, this.simulationTick + 20)
  }
  prototype.tryCloseVillagerDoor = function(this: EntityManager, entity: EntityState): void {
    if (!entity.pendingDoorKey || this.simulationTick < entity.closeDoorAt) return
    const door = this.villageGraph.getDoor(entity.pendingDoorKey)
    if (!door) {
      entity.pendingDoorKey = null
      return
    }
    const occupied = [...this.entities.values()].some(other => other.health > 0 &&
      Math.abs(other.x - (door.x + 0.5)) < 0.65 &&
      Math.abs(other.y - door.y) < other.height &&
      Math.abs(other.z - (door.z + 0.5)) < 0.65)
    if (occupied) {
      entity.closeDoorAt = this.simulationTick + 10
      return
    }
    this.world.setDoorOpen?.(door.x, door.y, door.z, false)
    entity.pendingDoorKey = null
  }
  prototype.villagerReturnToVillage = function(this: EntityManager, entity: EntityState, village: VillageNode, speed: number, dt: number): void {
    const dx = village.centerX + 0.5 - entity.x
    const dz = village.centerZ + 0.5 - entity.z
    const distance = Math.hypot(dx, dz) || 1
    const step = Math.min(10, distance)
    this.navigate(
      entity, entity.x + dx / distance * step, village.centerY,
      entity.z + dz / distance * step, speed, dt, 'open'
    )
  }
  prototype.villagerMateTask = function(this: EntityManager, entity: EntityState, village: VillageNode, speed: number, dt: number): boolean {
    if (entity.age < 0 || entity.breedCooldown > 0) {
      entity.villagerMateId = null
      entity.villagerMateTicks = 0
      return false
    }
    const residents = [...this.entities.values()].filter(candidate =>
      candidate.kind === 'villager' && candidate.health > 0 && candidate.villageId === village.id).length
    if (residents >= this.villageGraph.capacity(village.id)) return false
    let mate = entity.villagerMateId ? this.entities.get(entity.villagerMateId) ?? null : null
    if (!this.validVillagerMate(entity, mate, village.id)) {
      entity.villagerMateId = null
      entity.villagerMateTicks = 0
      mate = null
      let best = 12
      for (const candidate of this.entities.values()) {
        if (!this.validVillagerMate(entity, candidate, village.id) ||
          (candidate.villagerMateId && candidate.villagerMateId !== entity.id)) continue
        const distance = Math.hypot(candidate.x - entity.x, candidate.y - entity.y, candidate.z - entity.z)
        if (distance >= best || !this.canSeeTarget(entity, this.entityTarget(candidate))) continue
        best = distance
        mate = candidate
      }
      if (!mate) return false
      entity.villagerMateId = mate.id
      mate.villagerMateId = entity.id
      mate.villagerMateTicks = 0
    }
    if (!mate || mate.villagerMateId !== entity.id) return false
    const distance = Math.hypot(mate.x - entity.x, mate.y - entity.y, mate.z - entity.z)
    entity.villagerMateTicks = distance < 3.5 && this.canSeeTarget(entity, this.entityTarget(mate))
      ? Math.min(300, entity.villagerMateTicks + 1)
      : 0
    this.lookHeadAt(entity, mate.x, mate.y + 1.45, mate.z)
    this.navigate(entity, mate.x, mate.y, mate.z, speed, dt, 'open')
    return true
  }
  prototype.validVillagerMate = function(this: EntityManager, entity: EntityState, mate: EntityState | null, villageId: string): mate is EntityState {
    return !!mate && mate.id !== entity.id && mate.kind === 'villager' && mate.health > 0 &&
      mate.age === 0 && mate.breedCooldown <= 0 && mate.villageId === villageId
  }
  prototype.villagerSocializeTask = function(this: EntityManager, entity: EntityState): boolean {
    if (entity.age < 0 || Math.random() >= 1 / 80) return false
    let neighbor: EntityState | null = null
    let best = 6
    for (const candidate of this.entities.values()) {
      if (candidate.id === entity.id || candidate.kind !== 'villager' || candidate.health <= 0) continue
      const distance = Math.hypot(candidate.x - entity.x, candidate.z - entity.z)
      if (distance >= best || !this.canSeeTarget(entity, this.entityTarget(candidate))) continue
      best = distance
      neighbor = candidate
    }
    if (!neighbor) return false
    entity.vx *= 0.78
    entity.vz *= 0.78
    this.lookHeadAt(entity, neighbor.x, neighbor.y + 1.45, neighbor.z)
    return true
  }
  prototype.villagerWanderTask = function(this: EntityManager, entity: EntityState, village: VillageNode | null, speed: number, dt: number): boolean {
    const arrived = Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 0.7
    if (entity.goalTime > 0 && !arrived) {
      entity.goalTime = Math.max(0, entity.goalTime - dt)
      this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, speed * 0.72, dt, 'open', true)
      return true
    }
    entity.goalTime = 0
    if (Math.random() >= 1 / 80) return false
    const angle = Math.random() * Math.PI * 2
    const centerX = village?.centerX ?? entity.homeX
    const centerZ = village?.centerZ ?? entity.homeZ
    const radius = Math.min(8, (village?.radius ?? 11) * 0.75)
    const distance = 2 + Math.random() * Math.max(1, radius - 2)
    entity.goalX = centerX + Math.cos(angle) * distance
    entity.goalY = village?.centerY ?? entity.homeY
    entity.goalZ = centerZ + Math.sin(angle) * distance
    entity.goalTime = 2 + Math.random() * 5
    this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, speed * 0.72, dt, 'open', true)
    return true
  }
}
