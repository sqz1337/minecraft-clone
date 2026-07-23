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
import { installEntityManagerCore } from './EntityManagerCore'
import { installEntityManagerLifecycle } from './EntityManagerLifecycle'
import { installEntityManagerPassiveAi } from './EntityManagerPassiveAi'
import { installEntityManagerVillagerAi } from './EntityManagerVillagerAi'
import { installEntityManagerHostileAi } from './EntityManagerHostileAi'
import { installEntityManagerNavigation } from './EntityManagerNavigation'
import { installEntityManagerPhysics } from './EntityManagerPhysics'
import { installEntityManagerSpawning } from './EntityManagerSpawning'

export * from './EntityManagerShared'

/*
 * Source-level regression landmarks for implementations now grouped in the
 * AI, physics, spawning and lifecycle modules.
 * previousX
 * Local avoidance belongs in velocity space
 * B.TNT, B.CACTUS, B.CLAY, B.PUMPKIN
 * 'enderman_ambient' 'enderman_teleport' 'love' 'death'
 * 'slime_split' 'shear' 'construct'
 * wolf: { kind: 'wolf'
 * ocelot: { kind: 'ocelot'
 * cat: { kind: 'cat'
 * squid: { kind: 'squid'
 * snow_golem: { kind: 'snow_golem'
 * iron_golem: { kind: 'iron_golem'
 * if (entity.kind === 'squid')
 * findNaturalSquidY
 * tryCreateGolem
 */

export class EntityManager {
  entities = new Map<string, EntityState>()

  spatial = new Map<number, Set<string>>()

  renderer: EntityRenderer | null

  accumulator = 0

  spawnTimer = 2

  nextId = 1

  hooks: EntityHooks

  soundGates = new Map<string, number>()

  passiveN = 0

  villagerN = 0

  hostileN = 0

  simulationTick = 0

  pathPlansThisTick = 0

  pathPlanN = 0

  villageGraph = new VillageGraph()

  riddenPigId: string | null = null

  constructor(public world: EntityWorld, scene?: THREE.Scene, hooks: Partial<EntityHooks> = {}, atlas?: Atlas) {
      this.renderer = scene ? new EntityRenderer(scene, atlas) : null
      this.hooks = { ...noopHooks, ...hooks }
    }

  get count(): number { return this.entities.size }

  get passiveCount(): number { return this.passiveN }

  get villagerCount(): number { return this.villagerN }

  get hostileCount(): number { return this.hostileN }

  get navigationPlanCount(): number { return this.pathPlanN }

  get registeredVillageCount(): number { return this.villageGraph.size }

  get riderPose(): EntityRiderPose | null {
      const entity = this.riddenPigId ? this.entities.get(this.riddenPigId) : null
      if (!entity || entity.kind !== 'pig' || !entity.saddled || entity.health <= 0) {
        this.riddenPigId = null
        return null
      }
      return {
        id: entity.id, x: entity.x, y: entity.y, z: entity.z,
        yaw: entity.yaw, height: entity.height * (entity.age < 0 ? 0.58 : 1)
      }
    }

  get snapshots(): EntitySnapshot[] { return [...this.entities.values()].map(this.publicSnapshot) }

  publicSnapshot = (e: EntityState): EntitySnapshot => ({
      id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz,
      yaw: e.yaw, health: e.health, maxHealth: e.maxHealth, width: e.width, height: e.height,
      age: e.age, breedCooldown: e.breedCooldown, eggTimer: e.eggTimer, active: e.active,
      inWater: e.inWater, onGround: e.onGround, loveTime: e.loveTime, panicTime: e.panicTime,
      attackCooldown: e.attackCooldown, fuse: e.fuse, angryTime: e.angryTime,
      burning: e.burnTime > 0 || e.forcedBurnTime > 0,
      sizeScale: e.sizeScale ?? 1, sheared: e.sheared ?? false, saddled: e.saddled ?? false,
      persistent: e.persistent, despawnAgeTicks: e.despawnAgeTicks,
      activeTask: e.activeTask,
      headYaw: e.headYaw, headPitch: e.headPitch,
      wingRotation: e.wingRotation, eatGrassTicks: e.eatGrassTicks,
      carriedBlock: e.carriedBlock ?? null,
      profession: e.profession ?? null, homeX: e.homeX, homeY: e.homeY, homeZ: e.homeZ,
      villageId: e.villageId, homeDoorKey: e.homeDoorKey,
      villagerActivity: e.villagerActivity,
      hurtTime: e.hurtTime, deathTime: e.deathTime,
      targetId: e.targetId,
      lastSeenPosition: e.lastSeenPosition ? { ...e.lastSeenPosition } : null
    })
}

export interface EntityManager {
  snapshotById(id: string): EntitySnapshot | null
  registerVillage(metadata: VillageMetadata): void
  countEntity(kind: MobKind, delta: number): void
  chunkKey(x: number, z: number): number
  index(entity: EntityState, oldKey?: number): void
  spawn(kind: MobKind, x: number, y: number, z: number, options?: {
    baby?: boolean
    persistent?: boolean
    id?: string
    /** Breeding may exceed the natural passive cap, but never the hard safety cap. */
    bypassMobCap?: boolean
    /** Slime model scale: 0.5/1/2 represent logical sizes 1/2/4. */
    sizeScale?: number
    profession?: VillagerProfession
    homeX?: number
    homeY?: number
    homeZ?: number
    villageId?: string
    homeDoorKey?: string
    /** Reserved for controlled repair/tests; normal gameplay must always validate the volume. */
    bypassPositionValidation?: boolean
    /** Births and slime splits may initially overlap another entity. */
    allowEntityOverlap?: boolean
    ignoreEntityIds?: readonly string[]
  }): EntitySnapshot | null
  canSpawnEntity(kind: MobKind, x: number, y: number, z: number, options?: SpawnValidationOptions): boolean
  entityBounds(x: number, y: number, z: number, width: number, height: number, scale: number): {
    minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number
  }
  remove(id: string): boolean
  releaseSilverfishFromBlock(x: number, y: number, z: number): EntitySnapshot | null
  awakenNearbyInfestedStone(entity: EntityState): number
  queryRadius(x: number, y: number, z: number, radius: number): EntitySnapshot[]
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, excludeId?: string): EntityRayHit | null
  damageProjectile(id: string, amount: number, sourceX: number, sourceZ: number, knockback?: number, looting?: number, attackerId?: string): boolean
  damage(id: string, amount: number, sourceX: number, sourceZ: number, knockback?: number, looting?: number, attackerId?: string): boolean
  ignite(id: string, seconds: number): void
  shearSheep(id: string): number
  shear(id: string): number
  interact(id: string, heldItemId: number | null): EntityInteractionResult | null
  dismountRider(): EntityRiderPose | null
  tryEatGrass(entity: EntityState): boolean
  tryTeleport(entity: EntityState, attempts?: number, toward?: AiTarget | null): boolean
  feed(id: string, itemId: number): boolean
  populateChunkAnimals(cx: number, cz: number, seed: number): number
  tryCreateGolem(x: number, y: number, z: number): boolean
  finishDeath(entity: EntityState, looting?: number): void
  update(dt: number, context: EntityUpdateContext): void
  tick(dt: number, context: EntityUpdateContext): void
  emitEntitySound(entity: EntityState, event: 'ambient' | 'hurt' | 'death' | 'step' | 'egg' | 'fuse', volume?: number): void
  emitCrowdSound(entity: EntityState, event: 'ambient' | 'step' | 'egg', distance?: number): void
  ai(entity: EntityState, context: EntityUpdateContext, dt: number): void
  ironGolemDefend(entity: EntityState, dt: number): boolean
  squidAi(entity: EntityState, dt: number): void
  passiveAi(entity: EntityState, context: EntityUpdateContext, dt: number): void
  passiveMovementTask(entity: EntityState, context: EntityUpdateContext, def: PassiveDefinition, dt: number): PassiveTaskKind
  passivePanicTask(entity: EntityState, def: PassiveDefinition, dt: number): void
  chooseReachablePanicGoal(entity: EntityState): void
  passiveMateTask(entity: EntityState, def: PassiveDefinition, dt: number): boolean
  validMate(entity: EntityState, mate: EntityState | null, radius: number): mate is EntityState
  passiveTemptTask(entity: EntityState, context: EntityUpdateContext, def: PassiveDefinition, dt: number): boolean
  passiveFollowParentTask(entity: EntityState, def: PassiveDefinition, dt: number): boolean
  passiveEatGrassTask(entity: EntityState): boolean
  hasEdibleGrass(entity: EntityState): boolean
  passiveWanderTask(entity: EntityState, def: PassiveDefinition, dt: number): boolean
  passiveWatchTask(entity: EntityState, context: EntityUpdateContext): boolean
  passiveIdleLookTask(entity: EntityState): void
  lookHeadAt(entity: EntityState, x: number, y: number, z: number): void
  villagerAi(entity: EntityState, context: EntityUpdateContext, dt: number): void
  villagerThreat(entity: EntityState): EntityState | null
  villagerFlee(entity: EntityState, sourceX: number, sourceZ: number, speed: number, dt: number): void
  resolveVillagerVillage(entity: EntityState): VillageNode | null
  resolveVillagerDoor(entity: EntityState, village: VillageNode | null): VillageDoorNode | null
  isInsideVillageDoor(entity: EntityState, door: VillageDoorNode): boolean
  villagerMoveIndoors(entity: EntityState, door: VillageDoorNode, speed: number, dt: number): void
  villagerLeaveHouse(entity: EntityState, door: VillageDoorNode, speed: number, dt: number): void
  openVillageDoorNear(entity: EntityState, door: VillageDoorNode): void
  scheduleVillagerDoorClose(entity: EntityState, door: VillageDoorNode): void
  tryCloseVillagerDoor(entity: EntityState): void
  villagerReturnToVillage(entity: EntityState, village: VillageNode, speed: number, dt: number): void
  villagerMateTask(entity: EntityState, village: VillageNode, speed: number, dt: number): boolean
  validVillagerMate(entity: EntityState, mate: EntityState | null, villageId: string): mate is EntityState
  villagerSocializeTask(entity: EntityState): boolean
  villagerWanderTask(entity: EntityState, village: VillageNode | null, speed: number, dt: number): boolean
  hostileAi(entity: EntityState, context: EntityUpdateContext, dt: number): void
  selectHostileTarget(entity: EntityState, context: EntityUpdateContext, def: HostileDefinition, player: AiTarget, spiderBright: boolean): void
  continueHostileTarget(entity: EntityState, context: EntityUpdateContext, def: HostileDefinition, spiderBright: boolean): TrackedTarget | null
  hostileWanderIntent(entity: EntityState, def: HostileDefinition, dt: number): NavigationIntent
  hostileAttackAction(entity: EntityState, context: EntityUpdateContext, def: HostileDefinition, tracked: TrackedTarget, dt: number): NavigationIntent
  applyNavigationIntent(entity: EntityState, intent: NavigationIntent, dt: number): void
  applySlimeMovement(entity: EntityState, intent: NavigationIntent, hasTarget: boolean, dt: number): void
  canAcquireTarget(entity: EntityState, target: AiTarget, range: number): boolean
  isAllowedTarget(entity: EntityState, target: AiTarget): boolean
  nearestVisibleVillager(entity: EntityState, range: number): AiTarget | null
  playerTarget(context: EntityUpdateContext): AiTarget
  entityTarget(entity: EntityState): AiTarget
  resolveTarget(id: string | null, context: EntityUpdateContext): AiTarget | null
  targetDistance(entity: EntityState, target: AiTarget): number
  canSeeTarget(entity: EntityState, target: AiTarget): boolean
  rememberTarget(entity: EntityState, target: AiTarget): void
  updateLastSeen(entity: EntityState, target: AiTarget): void
  clearTarget(entity: EntityState): void
  updateEndermanStare(entity: EntityState, context: EntityUpdateContext, player: AiTarget): void
  isPlayerStaringAtEnderman(entity: EntityState, context: EntityUpdateContext, player?: AiTarget): boolean
  updateEndermanEnvironment(entity: EntityState, context: EntityUpdateContext): void
  updateEndermanTeleportState(entity: EntityState, context: EntityUpdateContext, tracked: TrackedTarget): void
  navigationProfile(entity: EntityState, canOpenDoors: boolean, canSwim?: boolean): NavProfile
  nearestNavigationGoal(goal: NavNode, profile: NavProfile): NavNode | null
  swimToShore(entity: EntityState, speed: number, dt: number, canOpenDoors?: boolean): boolean
  navigate(entity: EntityState, goalX: number, goalY: number, goalZ: number, speed: number, dt: number, doorMode?: 'none' | 'open' | 'break', avoidWater?: boolean): boolean
  clearNavigation(entity: EntityState, delay?: number): void
  isBreakingClosedDoor(entity: EntityState): boolean
  resetDoorBreak(entity: EntityState): void
  faceToward(entity: EntityState, targetYaw: number, dt: number, rate?: number): void
  steer(entity: EntityState, goalX: number, goalZ: number, speed: number, dt: number): void
  scheduleSilverfishCallForHelp(entity: EntityState): void
  updateSilverfishCallForHelp(entity: EntityState): void
  trySilverfishHide(entity: EntityState): boolean
  updateEndermanBlock(entity: EntityState): void
  hasLineOfSight(x: number, y: number, z: number, tx: number, ty: number, tz: number): boolean
  hasLineOfSightToBlock(x: number, y: number, z: number, targetX: number, targetY: number, targetZ: number): boolean
  effectiveLight(x: number, y: number, z: number, darkness: number): number
  isSunlit(entity: EntityState, context: EntityUpdateContext): boolean
  isExposedToSky(entity: EntityState): boolean
  touchesCactus(entity: EntityState): boolean
  explode(x: number, y: number, z: number, power: number, player?: { x: number; y: number; z: number }): void
  physics(entity: EntityState, dt: number): void
  touchesWater(entity: EntityState): boolean
  hasDryFooting(entity: EntityState, canOpenDoors?: boolean): boolean
  applyFallDamage(entity: EntityState): void
  moveAxis(entity: EntityState, axis: 'x' | 'y' | 'z', amount: number, canStep?: boolean): void
  tryStepUp(entity: EntityState): boolean
  resolveEmbedded(entity: EntityState): void
  collidesWorld(entity: EntityState): boolean
  separateEntities(): void
  breedPairs(): void
  nearestMate(entity: EntityState, radius: number): EntityState | null
  breedVillagerPairs(): void
  tryNaturalSpawn(context: EntityUpdateContext): void
  spawnNaturalCategory(category: 'hostile' | 'passive', chunks: readonly EligibleChunk[], cap: number, context: EntityUpdateContext): void
  findNaturalSquidY(x: number, z: number, seabedY: number): number | null
  findNaturalHostileY(x: number, z: number): number | null
  serialize(): SavedEntity[]
  restore(saved: readonly SavedEntity[]): void
  dispose(): void
}

installEntityManagerCore(EntityManager)
installEntityManagerLifecycle(EntityManager)
installEntityManagerPassiveAi(EntityManager)
installEntityManagerVillagerAi(EntityManager)
installEntityManagerHostileAi(EntityManager)
installEntityManagerNavigation(EntityManager)
installEntityManagerPhysics(EntityManager)
installEntityManagerSpawning(EntityManager)
