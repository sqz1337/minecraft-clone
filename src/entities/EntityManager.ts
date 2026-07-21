import * as THREE from 'three'
import { B, blockCollisionBox, infestedBlockFor, isFluid, isInfestedBlock, isLava } from '../world/Blocks'
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

const CHUNK_SIZE = 16
const GRAVITY = 25
const STEP = 1 / 20
const MAX_STEPS = 4
export const ELIGIBLE_CHUNK_RADIUS = 8
export const ELIGIBLE_CHUNK_COUNT = (ELIGIBLE_CHUNK_RADIUS * 2 + 1) ** 2
export const SPAWNABLE_CHUNK_COUNT = (ELIGIBLE_CHUNK_RADIUS * 2 - 1) ** 2
const ACTIVE_CHUNKS = ELIGIBLE_CHUNK_RADIUS
export function scaledMobCap(base: number, eligibleChunkCount: number): number {
  return Math.max(0, Math.floor(base * Math.max(0, Math.floor(eligibleChunkCount)) / 256))
}
export const PASSIVE_MOB_CAP = scaledMobCap(15, ELIGIBLE_CHUNK_COUNT)
export const HOSTILE_MOB_CAP = scaledMobCap(70, ELIGIBLE_CHUNK_COUNT)
const ENTITY_HARD_CAP = 256
const BREED_SEARCH_RADIUS = 12
const BREED_DISTANCE = 4.5
const DEATH_ANIMATION_SECONDS = 0.7
const NATURAL_PASSIVE_LOCAL_CAP = 8
const PLAYER_TARGET_ID = 'player'
const TARGET_MEMORY_TICKS = 60
const TARGET_SCAN_MIN_TICKS = 10
const TARGET_SCAN_JITTER_TICKS = 10
const ENDERMAN_STARE_TICKS = 5
export const SILVERFISH_HELP_DELAY_TICKS = 20
export const SILVERFISH_HELP_HORIZONTAL_RADIUS = 10
export const SILVERFISH_HELP_VERTICAL_RADIUS = 5
const SILVERFISH_HIDE_RETRY_TICKS = 40
const MATE_COURTSHIP_TICKS = 60
const TEMPT_COOLDOWN_TICKS = 100
const HARD_DESPAWN_DISTANCE_SQ = 128 ** 2
const RANDOM_DESPAWN_DISTANCE_SQ = 32 ** 2
const RANDOM_DESPAWN_AGE_TICKS = 600
const RANDOM_DESPAWN_CHANCE = 800
const ENDERMAN_CARRYABLE = new Set<number>([
  B.GRASS, B.DIRT, B.SAND, B.GRAVEL, B.FLOWER_Y, B.FLOWER_R,
  B.MUSHROOM_BROWN, B.MUSHROOM_RED, B.TNT, B.PUMPKIN, B.MYCELIUM
])
const SILVERFISH_HIDE_DIRECTIONS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]
] as const)

export interface EligibleChunk {
  cx: number
  cz: number
  /** Vanilla counts the outer ring toward caps but does not spawn inside it. */
  border: boolean
}

/** The 17x17 vanilla eligible-chunk square around one player. */
export function eligibleChunksAround(playerX: number, playerZ: number): EligibleChunk[] {
  const centerX = Math.floor(playerX / CHUNK_SIZE)
  const centerZ = Math.floor(playerZ / CHUNK_SIZE)
  const chunks: EligibleChunk[] = []
  for (let dx = -ELIGIBLE_CHUNK_RADIUS; dx <= ELIGIBLE_CHUNK_RADIUS; dx++) {
    for (let dz = -ELIGIBLE_CHUNK_RADIUS; dz <= ELIGIBLE_CHUNK_RADIUS; dz++) {
      chunks.push({
        cx: centerX + dx,
        cz: centerZ + dz,
        border: Math.abs(dx) === ELIGIBLE_CHUNK_RADIUS || Math.abs(dz) === ELIGIBLE_CHUNK_RADIUS
      })
    }
  }
  return chunks
}

export interface EntityWorld {
  getBlock(x: number, y: number, z: number): number
  isSolid(x: number, y: number, z: number): boolean
  isWater(x: number, y: number, z: number): boolean
  topSolidY(x: number, z: number): number
  biomeAt(x: number, z: number): number
  isSlimeChunk?(cx: number, cz: number): boolean
  getLightLevel(x: number, y: number, z: number): number
  getSkyLight?(x: number, y: number, z: number): number
  getBlockLight?(x: number, y: number, z: number): number
  setBlock?(x: number, y: number, z: number, id: number): void
  primeTnt?(x: number, y: number, z: number, fuseTicks?: number, scattered?: boolean): boolean
  batchBlocks?(action: () => void): void
  doorState?(x: number, y: number, z: number): 'open' | 'closed' | null
  openDoor?(x: number, y: number, z: number): boolean
  setDoorOpen?(x: number, y: number, z: number, open: boolean): boolean
  breakDoor?(x: number, y: number, z: number): boolean
}

export interface EntityHooks {
  drop: (id: number, x: number, y: number, z: number, count: number) => void
  sound: (kind: MobKind, event: 'ambient' | 'hurt' | 'death' | 'step' | 'egg' | 'fuse') => void
  damagePlayer: (amount: number, sourceX: number, sourceZ: number, knockback: number) => boolean
  shootProjectile: (x: number, y: number, z: number, tx: number, ty: number, tz: number, damage: number, shooterId?: string) => void
  explosion: (x: number, y: number, z: number, radius: number) => void
  blockExploded: (x: number, y: number, z: number, id: number) => void
  experience: (x: number, y: number, z: number, amount: number) => void
}

export const PASSIVE_DEFINITIONS: Readonly<Record<PeacefulKind, PassiveDefinition>> = {
  pig: { kind: 'pig', category: 'passive', maxHealth: 10, width: 0.9, height: 0.9, speed: 2.15, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_PORKCHOP, min: 0, max: 2 }] },
  cow: { kind: 'cow', category: 'passive', maxHealth: 10, width: 0.9, height: 1.4, speed: 2, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_BEEF, min: 1, max: 3 }, { id: I.LEATHER, min: 0, max: 2 }] },
  sheep: { kind: 'sheep', category: 'passive', maxHealth: 8, width: 0.9, height: 1.3, speed: 2, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: B.WOOL, min: 1, max: 1 }, { id: I.RAW_MUTTON, min: 1, max: 2 }] },
  chicken: { kind: 'chicken', category: 'passive', maxHealth: 4, width: 0.55, height: 0.95, speed: 1.9, temptingItem: I.SEEDS, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_CHICKEN, min: 1, max: 1 }, { id: I.FEATHER, min: 0, max: 2 }] },
  mooshroom: { kind: 'mooshroom', category: 'passive', maxHealth: 10, width: 0.9, height: 1.4, speed: 2, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_BEEF, min: 1, max: 3 }, { id: I.LEATHER, min: 0, max: 2 }] }
}

export const VILLAGER_DEFINITIONS: Readonly<Record<VillagerKind, VillagerDefinition>> = {
  villager: { kind: 'villager', category: 'villager', maxHealth: 20, width: 0.6, height: 1.8, speed: 1.75, temptingItem: null, attackDamage: 0, followRange: 12, drops: [] }
}

export const HOSTILE_DEFINITIONS: Readonly<Record<HostileKind, HostileDefinition>> = {
  zombie: { kind: 'zombie', category: 'hostile', maxHealth: 20, width: 0.6, height: 1.8, speed: 2.3, temptingItem: null, attackDamage: 3, followRange: 16, drops: [{ id: I.ROTTEN_FLESH, min: 0, max: 2 }] },
  skeleton: { kind: 'skeleton', category: 'hostile', maxHealth: 20, width: 0.6, height: 1.8, speed: 2.15, temptingItem: null, attackDamage: 2, followRange: 16, drops: [{ id: I.BONE, min: 0, max: 2 }, { id: I.ARROW, min: 0, max: 2 }] },
  spider: { kind: 'spider', category: 'hostile', maxHealth: 16, width: 1.35, height: 0.9, speed: 3.35, temptingItem: null, attackDamage: 2, followRange: 16, drops: [{ id: I.STRING, min: 0, max: 2 }, { id: I.SPIDER_EYE, min: 1, max: 1, chance: 0.33 }] },
  creeper: { kind: 'creeper', category: 'hostile', maxHealth: 20, width: 0.6, height: 1.7, speed: 2.15, temptingItem: null, attackDamage: 0, followRange: 16, drops: [{ id: I.GUNPOWDER, min: 0, max: 2 }] },
  slime: { kind: 'slime', category: 'hostile', maxHealth: 16, width: 1.2, height: 1.2, speed: 2.2, temptingItem: null, attackDamage: 3, followRange: 16, drops: [{ id: I.SLIMEBALL, min: 0, max: 2 }] },
  enderman: { kind: 'enderman', category: 'hostile', maxHealth: 40, width: 0.6, height: 2.9, speed: 3.4, temptingItem: null, attackDamage: 7, followRange: 64, drops: [{ id: I.ENDER_PEARL, min: 0, max: 1 }] },
  silverfish: { kind: 'silverfish', category: 'hostile', maxHealth: 8, width: 0.4, height: 0.3, speed: 3.2, temptingItem: null, attackDamage: 1, followRange: 16, drops: [] }
}

export const MOB_DEFINITIONS: Readonly<Record<MobKind, MobDefinition>> = {
  ...PASSIVE_DEFINITIONS, ...VILLAGER_DEFINITIONS, ...HOSTILE_DEFINITIONS
}

export interface SpawnEntry {
  kind: MobKind
  weight: number
  minPack: number
  maxPack: number
}

const HOSTILE_SPAWN_ENTRIES: readonly SpawnEntry[] = [
  { kind: 'spider', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'zombie', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'skeleton', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'creeper', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'slime', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'enderman', weight: 1, minPack: 1, maxPack: 4 }
]

const PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = [
  { kind: 'sheep', weight: 12, minPack: 4, maxPack: 4 },
  { kind: 'pig', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'chicken', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'cow', weight: 8, minPack: 4, maxPack: 4 }
]

const JUNGLE_PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = PASSIVE_SPAWN_ENTRIES.map(entry =>
  entry.kind === 'chicken' ? { ...entry, weight: 20 } : entry)
const MUSHROOM_PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = [
  { kind: 'mooshroom', weight: 8, minPack: 4, maxPack: 8 }
]

/** Vanilla-style weighted biome spawn table for the mob categories implemented here. */
export function spawnEntriesForBiome(
  category: 'hostile' | 'passive', biome: number
): readonly SpawnEntry[] {
  if (category === 'hostile') return biome === BIOME.MUSHROOM ? [] : HOSTILE_SPAWN_ENTRIES
  if (biome === BIOME.MUSHROOM) return MUSHROOM_PASSIVE_SPAWN_ENTRIES
  if (biome === BIOME.OCEAN || biome === BIOME.RIVER || biome === BIOME.BEACH || biome === BIOME.DESERT) return []
  return biome === BIOME.JUNGLE ? JUNGLE_PASSIVE_SPAWN_ENTRIES : PASSIVE_SPAWN_ENTRIES
}

/** Selects one weighted entry from a normalized roll in [0, 1). */
export function pickWeightedSpawnEntry(
  entries: readonly SpawnEntry[], roll: number
): SpawnEntry | null {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0)
  if (total <= 0) return null
  const normalized = Math.max(0, Math.min(1 - Number.EPSILON, finite(roll)))
  const target = normalized * total
  let cursor = 0
  for (const entry of entries) {
    cursor += Math.max(0, entry.weight)
    if (target < cursor) return entry
  }
  return entries[entries.length - 1] ?? null
}

interface EntityState extends EntitySnapshot {
  goalX: number
  goalY: number
  goalZ: number
  goalTime: number
  ambientTime: number
  stepTime: number
  hurtCooldown: number
  persistent: boolean
  attackCooldown: number
  fuse: number
  angryTime: number
  burnTime: number
  /** Remaining seconds of externally applied fire (Fire Aspect, Flame arrows). */
  forcedBurnTime: number
  pendingLooting: number
  /** Highest Y since last standing on ground; fall damage = height − 3 like vanilla. */
  fallPeakY: number
  /** Mob that hurt this one (stray skeleton arrow etc.) — classic infighting target. */
  revengeTargetId: string | null
  /** Simulation tick on which the current target was last visible. */
  lastSeenAt: number
  /** Earliest simulation tick at which an idle mob may scan for a new target. */
  nextTargetScanAt: number
  /** Consecutive visible, unmasked player-look checks for enderman aggro. */
  stareTicks: number
  navPath: NavNode[]
  navIndex: number
  navRequested: NavNode | null
  navGoal: NavNode | null
  nextPathAt: number
  navProgressAt: number
  navProgressX: number
  navProgressY: number
  navProgressZ: number
  navStuckCount: number
  /** Active hostile ticks since it was last within 32 blocks of the player. */
  despawnAgeTicks: number
  targetVisibleTicks: number
  rangedCooldownTicks: number
  slimeJumpDelayTicks: number
  teleportDelayTicks: number
  horizontalCollision: boolean
  doorBreakTicks: number
  doorBreakX: number
  doorBreakY: number
  doorBreakZ: number
  panicSourceX: number
  panicSourceZ: number
  panicGoalUntilTick: number
  mateId: string | null
  mateCourtshipTicks: number
  tempting: boolean
  temptCooldownTicks: number
  temptPlayerX: number
  temptPlayerY: number
  temptPlayerZ: number
  temptLookX: number
  temptLookY: number
  temptLookZ: number
  watchUntilTick: number
  idleLookUntilTick: number
  idleLookYaw: number
  eatGrassTicks: number
  nextGrassAttemptTick: number
  headYaw: number
  headPitch: number
  wingRotation: number
  wingSpeed: number
  avoidTargetId: string | null
  avoidGoalUntilTick: number
  pendingDoorKey: string | null
  closeDoorAt: number
  villagerMateId: string | null
  villagerMateTicks: number
  /** Scheduled classic summon-silverfish goal, expressed in simulation ticks. */
  silverfishCallForHelpAtTick: number
  /** Staggered deterministic idle hide attempt. */
  silverfishHideAtTick: number
}

export interface EntityUpdateContext {
  player: { x: number; y: number; z: number }
  /** Global world spawn; natural mobs must also be farther than 24 blocks from it. */
  worldSpawn?: { x: number; y: number; z: number }
  /** False for creative, dead or noclip players that hostile mobs must ignore. */
  playerTargetable?: boolean
  heldItem: number | null
  /** Item in the player's head slot; a pumpkin suppresses enderman stare aggro. */
  headItem?: number | null
  look?: { x: number; y: number; z: number }
  skyDarkness?: number
  /** Normalized day cycle; night is outside the classic 0.23..0.77 daylight interval. */
  timeOfDay?: number
  /** Active precipitation; exposed endermen treat it like water. */
  raining?: boolean
}

interface AiTarget {
  id: string
  kind: 'player' | MobKind
  x: number
  y: number
  z: number
  width: number
  height: number
  alive: boolean
}

interface TrackedTarget {
  target: AiTarget
  visible: boolean
  distance: number
  goal: { x: number; y: number; z: number }
}

interface NavigationIntent {
  kind: 'move' | 'hold' | 'leap'
  x: number
  y: number
  z: number
  speed: number
  doorMode?: 'none' | 'open' | 'break'
  face?: { x: number; z: number }
}

type PassiveTaskKind = 'swim' | 'panic' | 'mate' | 'tempt' | 'follow_parent' |
  'eat_grass' | 'wander' | 'watch' | 'idle'

export interface SpawnValidationOptions {
  baby?: boolean
  sizeScale?: number
  /** Programmatic births/splits may overlap their parents while still requiring safe terrain. */
  allowEntityOverlap?: boolean
  ignoreEntityIds?: readonly string[]
  source?: 'generic' | 'natural' | 'spawner' | 'restore' | 'structure'
  player?: { x: number; y: number; z: number }
  worldSpawn?: { x: number; y: number; z: number }
  darkness?: number
  /** Deterministic override for the natural slime member's independent 1-in-10 roll. */
  slimeRoll?: number
}

export interface EntityRayHit {
  entity: EntitySnapshot
  distance: number
}

const noopHooks: EntityHooks = {
  drop: () => {}, sound: () => {}, damagePlayer: () => false,
  shootProjectile: () => {}, explosion: () => {}, blockExploded: () => {}, experience: () => {}
}

function finite(value: number, fallback = 0): number { return Number.isFinite(value) ? value : fallback }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
function silverfishHideDelay(id: string, x: number, y: number, z: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193)
  hash ^= Math.imul(Math.floor(x), 0x1f123bb5) ^ Math.imul(Math.floor(y), 0x6c8e9cf5) ^
    Math.imul(Math.floor(z), 0x5f356495)
  return SILVERFISH_HIDE_RETRY_TICKS + ((hash >>> 0) % SILVERFISH_HIDE_RETRY_TICKS)
}
function normalizeSlimeScale(value: number | undefined): 0.5 | 1 | 2 {
  const scale = finite(value ?? 1, 1)
  return scale < 0.75 ? 0.5 : scale < 1.5 ? 1 : 2
}

// Scratch objects for the per-frame entity raycast — never allocate in there.
const scratchRay = new THREE.Ray()
const scratchBox = new THREE.Box3()
const scratchHit = new THREE.Vector3()

export function hostileSpawnAllowed(light: number, distance: number, hostileCount: number, biome: number): boolean {
  return light <= 7 && distance >= 24 && hostileCount < HOSTILE_MOB_CAP && biome !== BIOME.MUSHROOM
}

function isPeacefulKind(kind: MobKind): kind is PeacefulKind {
  return PASSIVE_KINDS.includes(kind as PassiveKind) || SPECIAL_PASSIVE_KINDS.includes(kind as never)
}

/** Entity lifetime, chunk activation, spatial index, physics and passive AI. */
export class EntityManager {
  private entities = new Map<string, EntityState>()
  private spatial = new Map<number, Set<string>>()
  private renderer: EntityRenderer | null
  private accumulator = 0
  private spawnTimer = 2
  private nextId = 1
  private hooks: EntityHooks
  private soundGates = new Map<'ambient' | 'step' | 'egg', number>()
  // Running per-category counts: the getters are hit inside spawn loops.
  private passiveN = 0
  private villagerN = 0
  private hostileN = 0
  private simulationTick = 0
  private pathPlansThisTick = 0
  private pathPlanN = 0
  private villageGraph = new VillageGraph()
  /** Single local rider; unlike the pig's saddle this is intentionally not saved. */
  private riddenPigId: string | null = null

  constructor(private world: EntityWorld, scene?: THREE.Scene, hooks: Partial<EntityHooks> = {}) {
    this.renderer = scene ? new EntityRenderer(scene) : null
    this.hooks = { ...noopHooks, ...hooks }
  }

  get count(): number { return this.entities.size }
  get passiveCount(): number { return this.passiveN }
  get villagerCount(): number { return this.villagerN }
  get hostileCount(): number { return this.hostileN }
  /** Monotonic diagnostic counter used to verify path-recalculation throttling. */
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

  snapshotById(id: string): EntitySnapshot | null {
    const entity = this.entities.get(id)
    return entity ? this.publicSnapshot(entity) : null
  }

  /** Chunk-independent registration; repeated overlapping chunk metadata is deduplicated. */
  registerVillage(metadata: VillageMetadata): void {
    this.villageGraph.registerVillage(metadata)
  }

  private countEntity(kind: MobKind, delta: number): void {
    if (isPeacefulKind(kind)) this.passiveN += delta
    else if (VILLAGER_KINDS.includes(kind as VillagerKind)) this.villagerN += delta
    else this.hostileN += delta
  }

  private publicSnapshot = (e: EntityState): EntitySnapshot => ({
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

  /** Numeric chunk key — exact and collision-free for sane coordinates. */
  private chunkKey(x: number, z: number): number {
    return Math.floor(x / CHUNK_SIZE) * 0x100000000 + Math.floor(z / CHUNK_SIZE)
  }

  private index(entity: EntityState, oldKey?: number): void {
    const nextKey = this.chunkKey(entity.x, entity.z)
    if (oldKey === nextKey) return
    if (oldKey !== undefined) {
      const old = this.spatial.get(oldKey)
      old?.delete(entity.id)
      if (old?.size === 0) this.spatial.delete(oldKey)
    }
    let bucket = this.spatial.get(nextKey)
    if (!bucket) this.spatial.set(nextKey, bucket = new Set())
    bucket.add(entity.id)
  }

  spawn(kind: MobKind, x: number, y: number, z: number, options: {
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
  } = {}): EntitySnapshot | null {
    if (!MOB_KINDS.includes(kind) || this.entities.size >= ENTITY_HARD_CAP) return null
    const passive = isPeacefulKind(kind)
    const villager = VILLAGER_KINDS.includes(kind as VillagerKind)
    if (!options.bypassMobCap && (passive ? this.passiveCount >= PASSIVE_MOB_CAP : !villager && this.hostileCount >= HOSTILE_MOB_CAP)) return null
    const def = MOB_DEFINITIONS[kind]
    const sizeScale = kind === 'slime' ? normalizeSlimeScale(options.sizeScale) : 1
    if (!options.bypassPositionValidation && !this.canSpawnEntity(kind, x, y, z, {
      baby: options.baby, sizeScale,
      allowEntityOverlap: options.allowEntityOverlap,
      ignoreEntityIds: options.ignoreEntityIds
    })) return null
    const maxHealth = kind === 'slime' ? (sizeScale * 2) ** 2 : def.maxHealth
    let id = options.id && !this.entities.has(options.id) ? options.id : ''
    while (!id || this.entities.has(id)) id = `${villager ? 'villager' : passive ? 'animal' : 'hostile'}-${this.nextId++}`
    const entity: EntityState = {
      id, kind, x, y, z, vx: 0, vy: 0, vz: 0, yaw: Math.random() * Math.PI * 2,
      health: maxHealth, maxHealth, width: def.width, height: def.height,
      age: options.baby ? -1200 : 0, breedCooldown: 0,
      eggTimer: kind === 'chicken' ? 300 + Math.random() * 300 : 0,
      active: true, inWater: false, onGround: false, loveTime: 0, panicTime: 0,
      burning: false, sizeScale, sheared: false, saddled: false, woolTimer: 0, carriedBlock: null,
      profession: villager ? options.profession ?? 'farmer' : null,
      homeX: finite(options.homeX ?? x, x), homeY: finite(options.homeY ?? y, y),
      homeZ: finite(options.homeZ ?? z, z),
      villageId: villager ? options.villageId ?? null : null,
      homeDoorKey: villager ? options.homeDoorKey ?? null : null,
      villagerActivity: null,
      goalX: x, goalY: y, goalZ: z, goalTime: 0, ambientTime: 5 + Math.random() * 15,
      stepTime: 0, hurtCooldown: 0, hurtTime: 0, deathTime: 0,
      persistent: options.persistent ?? false,
      attackCooldown: 0, fuse: 0, angryTime: 0, burnTime: 0, forcedBurnTime: 0,
      pendingLooting: 0, fallPeakY: y, revengeTargetId: null,
      targetId: null, lastSeenPosition: null, lastSeenAt: -Infinity,
      nextTargetScanAt: 0, stareTicks: 0,
      navPath: [], navIndex: 0, navRequested: null, navGoal: null, nextPathAt: 0,
      navProgressAt: this.simulationTick + 20,
      navProgressX: x, navProgressY: y, navProgressZ: z, navStuckCount: 0,
      despawnAgeTicks: 0, targetVisibleTicks: 0, rangedCooldownTicks: 0,
      slimeJumpDelayTicks: 10 + Math.floor(Math.random() * 20), teleportDelayTicks: 0,
      horizontalCollision: false,
      doorBreakTicks: 0, doorBreakX: 0, doorBreakY: 0, doorBreakZ: 0,
      activeTask: null,
      panicSourceX: x, panicSourceZ: z, panicGoalUntilTick: 0,
      mateId: null, mateCourtshipTicks: 0,
      tempting: false, temptCooldownTicks: 0,
      temptPlayerX: 0, temptPlayerY: 0, temptPlayerZ: 0,
      temptLookX: 0, temptLookY: 0, temptLookZ: 0,
      watchUntilTick: 0, idleLookUntilTick: 0, idleLookYaw: 0,
      eatGrassTicks: 0, nextGrassAttemptTick: this.simulationTick + 1,
      headYaw: 0, headPitch: 0, wingRotation: 0, wingSpeed: 0,
      avoidTargetId: null, avoidGoalUntilTick: 0,
      pendingDoorKey: null, closeDoorAt: 0,
      villagerMateId: null, villagerMateTicks: 0,
      silverfishCallForHelpAtTick: 0,
      silverfishHideAtTick: kind === 'silverfish'
        ? this.simulationTick + silverfishHideDelay(id, x, y, z)
        : 0
    }
    entity.headYaw = entity.yaw
    this.entities.set(id, entity)
    this.countEntity(kind, 1)
    this.index(entity)
    return this.publicSnapshot(entity)
  }

  /**
   * Shared spawn-volume contract: supported footprint, complete scaled AABB,
   * no solid/fluid cells and (unless explicitly relaxed) no living entity AABB.
   */
  canSpawnEntity(kind: MobKind, x: number, y: number, z: number, options: SpawnValidationOptions = {}): boolean {
    const def = MOB_DEFINITIONS[kind]
    if (!def || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
    const sizeScale = kind === 'slime' ? normalizeSlimeScale(options.sizeScale) : 1
    const scale = (options.baby ? 0.58 : 1) * sizeScale
    const bounds = this.entityBounds(x, y, z, def.width, def.height, scale)
    if (bounds.minY < 1 || bounds.maxY >= 128) return false

    const floorY = Math.floor(y - 0.05)
    for (let bx = bounds.minX; bx <= bounds.maxX; bx++) {
      for (let bz = bounds.minZ; bz <= bounds.maxZ; bz++) {
        if (!this.world.isSolid(bx, floorY, bz) || isFluid(this.world.getBlock(bx, floorY, bz))) return false
      }
    }
    for (let bx = bounds.minX; bx <= bounds.maxX; bx++) {
      for (let by = bounds.minY; by <= bounds.maxY; by++) {
        for (let bz = bounds.minZ; bz <= bounds.maxZ; bz++) {
          if (this.world.isSolid(bx, by, bz) || isFluid(this.world.getBlock(bx, by, bz))) return false
        }
      }
    }
    const ignored = new Set(options.ignoreEntityIds ?? [])
    const minX = x - def.width * scale * 0.5
    const maxX = x + def.width * scale * 0.5
    const minY = y
    const maxY = y + def.height * scale
    const minZ = z - def.width * scale * 0.5
    const maxZ = z + def.width * scale * 0.5
    for (const other of options.allowEntityOverlap ? [] : this.entities.values()) {
      if (ignored.has(other.id) || other.health <= 0) continue
      const otherScale = (other.age < 0 ? 0.58 : 1) * (other.sizeScale ?? 1)
      const half = other.width * otherScale * 0.5
      if (maxX > other.x - half && minX < other.x + half &&
        maxY > other.y && minY < other.y + other.height * otherScale &&
        maxZ > other.z - half && minZ < other.z + half) return false
    }
    const source = options.source ?? 'generic'
    if (source === 'natural') {
      if (!options.player || !options.worldSpawn) return false
      const biome = this.world.biomeAt(x, z)
      const playerDistance = Math.hypot(x - options.player.x, y - options.player.y, z - options.player.z)
      const spawnDistance = Math.hypot(x - options.worldSpawn.x, y - options.worldSpawn.y, z - options.worldSpawn.z)
      if (playerDistance < 24 || spawnDistance < 24) return false
      if (HOSTILE_KINDS.includes(kind as HostileKind)) {
        if (!spawnEntriesForBiome('hostile', biome).some(entry => entry.kind === kind)) return false
        if (!hostileSpawnAllowed(
          this.effectiveLight(x, y, z, options.darkness ?? 0), playerDistance, this.hostileCount, biome
        )) return false
        if (kind === 'slime') {
          const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
          const roll = options.slimeRoll ?? Math.random()
          if (y >= 40 || !this.world.isSlimeChunk?.(cx, cz) || roll < 0 || roll >= 0.1) return false
        }
      } else if (isPeacefulKind(kind)) {
        if (!spawnEntriesForBiome('passive', biome).some(entry => entry.kind === kind)) return false
        const surface = this.world.getBlock(Math.floor(x), floorY, Math.floor(z))
        if (this.world.getLightLevel(x, y, z) < 9) return false
        if (kind === 'mooshroom') {
          if (biome !== BIOME.MUSHROOM || surface !== B.MYCELIUM) return false
        } else {
          if (surface !== B.GRASS && surface !== B.SNOW) return false
        }
      }
    } else if (source === 'spawner' && HOSTILE_KINDS.includes(kind as HostileKind)) {
      if (this.effectiveLight(x, y, z, options.darkness ?? 0) > 7) return false
    }
    return true
  }

  private entityBounds(x: number, y: number, z: number, width: number, height: number, scale: number): {
    minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number
  } {
    const half = Math.max(0.01, width * scale * 0.5 - 0.02)
    return {
      minX: Math.floor(x - half), maxX: Math.floor(x + half),
      minY: Math.floor(y + 0.01), maxY: Math.floor(y + height * scale - 0.01),
      minZ: Math.floor(z - half), maxZ: Math.floor(z + half)
    }
  }

  remove(id: string): boolean {
    const entity = this.entities.get(id)
    if (!entity) return false
    const key = this.chunkKey(entity.x, entity.z)
    this.spatial.get(key)?.delete(id)
    this.entities.delete(id)
    if (this.riddenPigId === id) this.riddenPigId = null
    this.countEntity(entity.kind, -1)
    return true
  }

  /**
   * Releases the occupant of an already-vacated monster-egg cell. The shared
   * spawn contract checks support, the complete 0.4x0.3 AABB, fluids and other
   * entities; an unsafe broken egg therefore never creates an embedded mob.
   */
  releaseSilverfishFromBlock(x: number, y: number, z: number): EntitySnapshot | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z)
    const sx = bx + 0.5, sy = by + 0.01, sz = bz + 0.5
    if (!this.canSpawnEntity('silverfish', sx, sy, sz, { source: 'structure' })) return null
    return this.spawn('silverfish', sx, sy, sz, { bypassMobCap: true })
  }

  /** Turns every safely releasable monster egg in the classic bounded search box into a mob. */
  private awakenNearbyInfestedStone(entity: EntityState): number {
    if (!this.world.setBlock) return 0
    const centerX = Math.floor(entity.x), centerY = Math.floor(entity.y), centerZ = Math.floor(entity.z)
    let awakened = 0
    const awaken = () => {
      // Near-to-far, alternating signs. This is deterministic and mirrors the
      // old summon goal's bounded search rather than scanning loaded chunks.
      for (let ay = 0; ay <= SILVERFISH_HELP_VERTICAL_RADIUS; ay++) {
        const ys = ay === 0 ? [0] : [ay, -ay]
        for (const dy of ys) for (let ax = 0; ax <= SILVERFISH_HELP_HORIZONTAL_RADIUS; ax++) {
          const xs = ax === 0 ? [0] : [ax, -ax]
          for (const dx of xs) for (let az = 0; az <= SILVERFISH_HELP_HORIZONTAL_RADIUS; az++) {
            const zs = az === 0 ? [0] : [az, -az]
            for (const dz of zs) {
              const x = centerX + dx, y = centerY + dy, z = centerZ + dz
              const infested = this.world.getBlock(x, y, z)
              if (!isInfestedBlock(infested)) continue
              this.world.setBlock!(x, y, z, B.AIR)
              if (this.releaseSilverfishFromBlock(x, y, z)) awakened++
              else this.world.setBlock!(x, y, z, infested)
            }
          }
        }
      }
    }
    if (this.world.batchBlocks) this.world.batchBlocks(awaken)
    else awaken()
    return awakened
  }

  queryRadius(x: number, y: number, z: number, radius: number): EntitySnapshot[] {
    const result: EntitySnapshot[] = []
    const minCx = Math.floor((x - radius) / CHUNK_SIZE), maxCx = Math.floor((x + radius) / CHUNK_SIZE)
    const minCz = Math.floor((z - radius) / CHUNK_SIZE), maxCz = Math.floor((z + radius) / CHUNK_SIZE)
    const r2 = radius * radius
    for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) {
      for (const id of this.spatial.get(cx * 0x100000000 + cz) ?? []) {
        const e = this.entities.get(id)
        if (e && (e.x - x) ** 2 + (e.y - y) ** 2 + (e.z - z) ** 2 <= r2) result.push(this.publicSnapshot(e))
      }
    }
    return result
  }

  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, excludeId?: string): EntityRayHit | null {
    let best: EntityState | null = null
    let bestT = maxDistance
    scratchRay.origin.copy(origin)
    scratchRay.direction.copy(direction)
    for (const entity of this.entities.values()) {
      if (!entity.active || entity.health <= 0 || entity.id === excludeId) continue
      // cheap sphere reject before the box test (3.2 covers the largest mob box)
      const ddx = entity.x - origin.x, ddy = entity.y - origin.y, ddz = entity.z - origin.z
      const reach = bestT + 3.2
      if (ddx * ddx + ddy * ddy + ddz * ddz > reach * reach) continue
      const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
      const half = entity.width * scale * 0.5
      scratchBox.min.set(entity.x - half, entity.y, entity.z - half)
      scratchBox.max.set(entity.x + half, entity.y + entity.height * scale, entity.z + half)
      const hit = scratchRay.intersectBox(scratchBox, scratchHit)
      if (!hit) continue
      const t = hit.distanceTo(origin)
      if (t < bestT) { bestT = t; best = entity }
    }
    return best ? { entity: this.publicSnapshot(best), distance: bestT } : null
  }

  /** Endermen evade projectile damage and get up to 64 vanilla-style teleport attempts. */
  damageProjectile(
    id: string, amount: number, sourceX: number, sourceZ: number,
    knockback = 4.2, looting = 0, attackerId?: string
  ): boolean {
    const entity = this.entities.get(id)
    if (!entity || entity.health <= 0) return false
    if (entity.kind === 'enderman') {
      this.tryTeleport(entity, 64)
      return false
    }
    return this.damage(id, amount, sourceX, sourceZ, knockback, looting, attackerId)
  }

  damage(id: string, amount: number, sourceX: number, sourceZ: number, knockback = 4.2, looting = 0, attackerId?: string): boolean {
    const entity = this.entities.get(id)
    if (!entity || entity.health <= 0 || entity.hurtCooldown > 0 || amount <= 0) return false
    entity.health -= amount
    entity.hurtCooldown = 0.45
    entity.hurtTime = 0.5
    entity.panicTime = 4
    entity.panicSourceX = finite(sourceX, entity.x)
    entity.panicSourceZ = finite(sourceZ, entity.z)
    entity.panicGoalUntilTick = 0
    entity.despawnAgeTicks = 0
    if (entity.kind === 'enderman') entity.angryTime = 30
    // classic infighting: a mob hurt by another mob turns on its attacker
    if (attackerId && attackerId !== id && entity.kind !== 'creeper' &&
      HOSTILE_KINDS.includes(entity.kind as HostileKind)) {
      entity.revengeTargetId = attackerId
      const attacker = this.entities.get(attackerId)
      if (attacker && attacker.health > 0) this.rememberTarget(entity, this.entityTarget(attacker))
    }
    const dx = entity.x - sourceX, dz = entity.z - sourceZ
    const len = Math.hypot(dx, dz) || 1
    entity.vx += dx / len * knockback
    entity.vz += dz / len * knockback
    entity.vy = Math.max(entity.vy, 3.2)
    if (entity.health <= 0) {
      entity.health = 0
      entity.deathTime = Number.EPSILON
      entity.pendingLooting = Math.max(0, looting)
      this.hooks.sound(entity.kind, 'death')
    } else {
      this.hooks.sound(entity.kind, 'hurt')
      this.scheduleSilverfishCallForHelp(entity)
      if (entity.kind === 'enderman' && Math.random() < 0.5) this.tryTeleport(entity)
    }
    return true
  }

  /** Sets an external burn (Fire Aspect, Flame arrows) for the given number of seconds. */
  ignite(id: string, seconds: number): void {
    const entity = this.entities.get(id)
    if (!entity || seconds <= 0) return
    entity.forcedBurnTime = Math.max(entity.forcedBurnTime, seconds)
  }

  private shearSheep(id: string): number {
    const entity = this.entities.get(id)
    if (!entity || entity.kind !== 'sheep' || entity.age < 0 || entity.sheared) return 0
    entity.sheared = true
    // delay before the first grass-eating attempt; wool only regrows by eating (vanilla)
    entity.woolTimer = 5 + Math.random() * 10
    entity.persistent = true
    return 1 + Math.floor(Math.random() * 3)
  }

  /** Shears an adult unsheared sheep; retained for callers from earlier stages. */
  shear(id: string): number { return this.shearSheep(id) }

  /**
   * Applies entity-side right-click state and describes the corresponding
   * inventory transaction. The caller remains responsible for consuming or
   * replacing the held item, which keeps creative/survival policy out of AI.
   */
  interact(id: string, heldItemId: number | null): EntityInteractionResult | null {
    const entity = this.entities.get(id)
    if (!entity || entity.health <= 0 || entity.deathTime > 0) return null

    if (entity.kind === 'sheep' && heldItemId === I.SHEARS) {
      const wool = this.shearSheep(id)
      return wool > 0
        ? { type: 'shear', drops: [{ id: B.WOOL, count: wool }], damageTool: true }
        : null
    }

    if (entity.kind === 'mooshroom' && heldItemId === I.SHEARS && entity.age >= 0) {
      entity.kind = 'cow'
      entity.persistent = true
      return {
        type: 'shear',
        drops: [{ id: B.MUSHROOM_RED, count: 5 }],
        damageTool: true,
        transformedTo: 'cow'
      }
    }

    if ((entity.kind === 'cow' || entity.kind === 'mooshroom') && heldItemId === I.BUCKET) {
      entity.persistent = true
      return { type: 'container', replaceHeldWith: I.MILK_BUCKET }
    }
    if (entity.kind === 'mooshroom' && heldItemId === I.BOWL && entity.age >= 0) {
      entity.persistent = true
      return { type: 'container', replaceHeldWith: I.MUSHROOM_STEW }
    }

    if (entity.kind === 'pig') {
      if (!entity.saddled && heldItemId === I.SADDLE && entity.age >= 0) {
        entity.saddled = true
        entity.persistent = true
        return { type: 'saddle', consumeHeld: true }
      }
      // Feeding keeps priority over mounting, matching EntityAnimal.interact.
      if (entity.saddled && entity.age >= 0 && heldItemId !== I.WHEAT) {
        const riding = this.riddenPigId !== entity.id
        this.riddenPigId = riding ? entity.id : null
        entity.persistent = true
        const pose: EntityRiderPose = {
          id: entity.id, x: entity.x, y: entity.y, z: entity.z,
          yaw: entity.yaw, height: entity.height
        }
        return { type: 'ride', riding, pose }
      }
    }
    return null
  }

  /** Sneak/key-driven counterpart to right-click toggling. */
  dismountRider(): EntityRiderPose | null {
    const pose = this.riderPose
    this.riddenPigId = null
    return pose
  }

  /** Vanilla sheep regrow wool only by eating: a tall grass bush at their feet or the grass block below. */
  private tryEatGrass(entity: EntityState): boolean {
    if (!this.world.setBlock) return false
    const x = Math.floor(entity.x), y = Math.floor(entity.y + 0.1), z = Math.floor(entity.z)
    if (this.world.getBlock(x, y, z) === B.TALLGRASS) {
      this.world.setBlock(x, y, z, B.AIR)
      entity.sheared = false
      return true
    }
    if (this.world.getBlock(x, y - 1, z) === B.GRASS) {
      this.world.setBlock(x, y - 1, z, B.DIRT)
      entity.sheared = false
      return true
    }
    return false
  }

  /** Random ±32 XYZ teleport, or a directed 16-block jump toward a distant target. */
  private tryTeleport(entity: EntityState, attempts = 1, toward: AiTarget | null = null): boolean {
    const oldX = entity.x, oldY = entity.y, oldZ = entity.z
    const oldKey = this.chunkKey(oldX, oldZ)
    for (let attempt = 0; attempt < attempts; attempt++) {
      let tx: number, ty: number, tz: number
      if (toward) {
        const dx = toward.x - entity.x
        const dy = toward.y + toward.height * 0.5 - (entity.y + entity.height * 0.5)
        const dz = toward.z - entity.z
        const length = Math.hypot(dx, dy, dz) || 1
        tx = entity.x + dx / length * 16 + (Math.random() - 0.5) * 8
        ty = entity.y + dy / length * 16 + Math.floor(Math.random() * 17) - 8
        tz = entity.z + dz / length * 16 + (Math.random() - 0.5) * 8
      } else {
        tx = entity.x + (Math.random() - 0.5) * 64
        ty = entity.y + Math.floor(Math.random() * 64) - 32
        tz = entity.z + (Math.random() - 0.5) * 64
      }
      ty = clamp(Math.floor(ty), 1, 126)
      while (ty > 1 && !this.world.isSolid(Math.floor(tx), ty - 1, Math.floor(tz))) ty--
      const y = ty + 0.01
      if (!this.canSpawnEntity('enderman', tx, y, tz, { ignoreEntityIds: [entity.id] })) continue
      entity.x = tx
      entity.y = y
      entity.z = tz
      entity.vx = entity.vy = entity.vz = 0
      entity.fallPeakY = entity.y
      this.clearNavigation(entity)
      this.index(entity, oldKey)
      return true
    }
    entity.x = oldX
    entity.y = oldY
    entity.z = oldZ
    return false
  }

  feed(id: string, itemId: number): boolean {
    const entity = this.entities.get(id)
    if (!entity || !isPeacefulKind(entity.kind) || entity.age < 0 || entity.breedCooldown > 0 || entity.loveTime > 0) return false
    if (PASSIVE_DEFINITIONS[entity.kind].temptingItem !== itemId) return false
    entity.loveTime = 30
    entity.persistent = true
    return true
  }

  /** Finishes death after the renderer has had time to show the classic fall-over animation. */
  private finishDeath(entity: EntityState, looting = 0): void {
    const def = MOB_DEFINITIONS[entity.kind]
    // Logical sizes 4 -> 2 -> 1; only the smallest slime drops loot.
    if (entity.kind === 'slime' && (entity.sizeScale ?? 1) > 0.5) {
      const childScale = normalizeSlimeScale((entity.sizeScale ?? 1) * 0.5)
      this.remove(entity.id)
      const babies = 2 + Math.floor(Math.random() * 3)
      for (let i = 0; i < babies; i++) {
        const sx = entity.x + (Math.random() - 0.5) * 0.8
        const sz = entity.z + (Math.random() - 0.5) * 0.8
        let spawned: EntitySnapshot | null = null
        // The death animation may leave the parent slightly airborne. Find the
        // first supported child volume below it instead of bypassing validation.
        for (let drop = 0; drop <= 8 && !spawned; drop++) {
          const sy = Math.floor(entity.y) - drop + 1.01
          if (!this.canSpawnEntity('slime', sx, sy, sz, { sizeScale: childScale, allowEntityOverlap: true })) continue
          spawned = this.spawn('slime', sx, sy, sz, {
            sizeScale: childScale, bypassMobCap: true, allowEntityOverlap: true
          })
        }
        if (spawned) {
          const small = this.entities.get(spawned.id)!
          small.vx = (Math.random() - 0.5) * 4
          small.vz = (Math.random() - 0.5) * 4
          small.vy = 3
        }
      }
      this.hooks.experience(entity.x, entity.y + 0.5, entity.z, 4)
      return
    }
    for (const drop of def.drops) {
      if (entity.kind === 'sheep' && drop.id === B.WOOL && entity.sheared) continue
      if (drop.chance !== undefined && Math.random() > drop.chance) continue
      const count = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1)) +
        (looting > 0 ? Math.floor(Math.random() * (looting + 1)) : 0)
      if (count > 0) this.hooks.drop(drop.id, entity.x, entity.y + 0.45, entity.z, count)
    }
    // only small slimes reach this branch (big ones split above); vanilla gives them 1 XP
    const xp = isPeacefulKind(entity.kind)
      ? (entity.age < 0 ? 0 : 1 + Math.floor(Math.random() * 3))
      : entity.kind === 'villager' ? 0 : entity.kind === 'slime' ? 1 : 5
    if (xp > 0) this.hooks.experience(entity.x, entity.y + 0.5, entity.z, xp)
    this.remove(entity.id)
  }

  update(dt: number, context: EntityUpdateContext): void {
    const safeDt = clamp(finite(dt), 0, 0.2)
    this.accumulator = Math.min(this.accumulator + safeDt, STEP * MAX_STEPS)
    let steps = 0
    while (this.accumulator >= STEP && steps++ < MAX_STEPS) {
      this.accumulator -= STEP
      this.tick(STEP, context)
    }
    // EntityState is a superset of EntitySnapshot: hand the live states to the
    // renderer directly instead of allocating a snapshot array every frame.
    this.renderer?.sync(this.entities.values(), safeDt)
  }

  private tick(dt: number, context: EntityUpdateContext): void {
    this.simulationTick++
    this.pathPlansThisTick = 0
    const pcx = Math.floor(context.player.x / CHUNK_SIZE), pcz = Math.floor(context.player.z / CHUNK_SIZE)
    for (const [event, remaining] of this.soundGates) {
      const next = remaining - dt
      if (next <= 0) this.soundGates.delete(event)
      else this.soundGates.set(event, next)
    }
    for (const entity of [...this.entities.values()]) {
      const ecx = Math.floor(entity.x / CHUNK_SIZE), ecz = Math.floor(entity.z / CHUNK_SIZE)
      entity.active = Math.max(Math.abs(ecx - pcx), Math.abs(ecz - pcz)) <= ACTIVE_CHUNKS
      const playerDistance = Math.hypot(entity.x - context.player.x, entity.z - context.player.z)
      const playerDistanceSq3d = (entity.x - context.player.x) ** 2 +
        (entity.y - context.player.y) ** 2 + (entity.z - context.player.z) ** 2
      entity.hurtTime = Math.max(0, entity.hurtTime - dt)
      if (entity.deathTime > 0) {
        entity.deathTime += dt
        if (entity.active) {
          const oldKey = this.chunkKey(entity.x, entity.z)
          entity.vx *= 0.9
          entity.vz *= 0.9
          this.physics(entity, dt)
          this.index(entity, oldKey)
        }
        if (entity.deathTime >= DEATH_ANIMATION_SECONDS) this.finishDeath(entity, entity.pendingLooting)
        continue
      }
      if (!entity.persistent && HOSTILE_KINDS.includes(entity.kind as HostileKind)) {
        if (playerDistanceSq3d > HARD_DESPAWN_DISTANCE_SQ) {
          this.remove(entity.id)
          continue
        }
        if (playerDistanceSq3d < RANDOM_DESPAWN_DISTANCE_SQ) {
          entity.despawnAgeTicks = 0
        } else if (entity.active) {
          entity.despawnAgeTicks++
          if (entity.despawnAgeTicks > RANDOM_DESPAWN_AGE_TICKS &&
            playerDistanceSq3d > RANDOM_DESPAWN_DISTANCE_SQ &&
            Math.floor(Math.random() * RANDOM_DESPAWN_CHANCE) === 0) {
            this.remove(entity.id)
            continue
          }
        }
      }
      if (!entity.active) continue
      this.resolveEmbedded(entity)
      entity.age = Math.min(0, entity.age + dt)
      entity.breedCooldown = Math.max(0, entity.breedCooldown - dt)
      entity.loveTime = Math.max(0, entity.loveTime - dt)
      entity.panicTime = Math.max(0, entity.panicTime - dt)
      entity.hurtCooldown = Math.max(0, entity.hurtCooldown - dt)
      entity.attackCooldown = Math.max(0, entity.attackCooldown - dt)
      entity.rangedCooldownTicks = Math.max(0, entity.rangedCooldownTicks - 1)
      entity.temptCooldownTicks = Math.max(0, entity.temptCooldownTicks - 1)
      entity.angryTime = Math.max(0, entity.angryTime - dt)
      entity.ambientTime -= dt
      if (entity.ambientTime <= 0) {
        entity.ambientTime = 8 + Math.random() * 22
        if (playerDistance < 24) this.emitCrowdSound(entity.kind, 'ambient')
      }
      if (entity.kind === 'chicken' && entity.age === 0) {
        entity.eggTimer -= dt
        if (entity.eggTimer <= 0) {
          this.hooks.drop(I.EGG, entity.x, entity.y + 0.25, entity.z, 1)
          if (playerDistance < 24) this.emitCrowdSound('chicken', 'egg')
          entity.eggTimer = 300 + Math.random() * 300
        }
      }
      const bodyBlock = this.world.getBlock(Math.floor(entity.x), Math.floor(entity.y + entity.height * 0.35), Math.floor(entity.z))
      if (entity.hurtCooldown <= 0 && this.touchesCactus(entity)) {
        entity.health--
        entity.hurtCooldown = 0.45
        entity.hurtTime = 0.5
        if (entity.health <= 0) {
          entity.health = 0
          entity.deathTime = Number.EPSILON
          this.hooks.sound(entity.kind, 'death')
          continue
        }
        this.hooks.sound(entity.kind, 'hurt')
        this.scheduleSilverfishCallForHelp(entity)
      }
      const lavaBurn = isLava(bodyBlock)
      const fireBurn = bodyBlock === B.FIRE
      // vanilla: sun burning is suppressed while the mob stands in water
      const sunBurn = (entity.kind === 'zombie' || entity.kind === 'skeleton') && !entity.inWater && this.isSunlit(entity, context)
      const rainHurt = entity.kind === 'enderman' && !!context.raining && this.isExposedToSky(entity)
      const waterHurt = entity.kind === 'enderman' && (entity.inWater || rainHurt)
      if (entity.inWater) entity.forcedBurnTime = 0
      else entity.forcedBurnTime = Math.max(0, entity.forcedBurnTime - dt)
      if (lavaBurn || fireBurn || sunBurn || waterHurt || entity.forcedBurnTime > 0) {
        entity.burnTime += dt
        const interval = lavaBurn || waterHurt ? 0.5 : 1
        if (entity.burnTime + 1e-9 >= interval) {
          entity.burnTime -= interval
          entity.health -= lavaBurn ? 4 : waterHurt ? 1 : 1
          entity.hurtTime = 0.5
          if (entity.health <= 0) {
            entity.health = 0
            entity.deathTime = Number.EPSILON
            this.hooks.sound(entity.kind, 'death')
            continue
          }
          this.scheduleSilverfishCallForHelp(entity)
          if (waterHurt) this.tryTeleport(entity)
        }
      } else entity.burnTime = 0
      this.ai(entity, context, dt)
      // Species tasks such as silverfish hiding may intentionally consume the entity.
      if (!this.entities.has(entity.id)) continue
      const oldKey = this.chunkKey(entity.x, entity.z)
      this.physics(entity, dt)
      const groundSpeed = Math.hypot(entity.vx, entity.vz)
      if (entity.onGround && groundSpeed > 0.45) {
        entity.stepTime -= dt
        if (entity.stepTime <= 0) {
          entity.stepTime = entity.kind === 'chicken' ? 0.24 : 0.36
          if (playerDistance < 16) this.emitCrowdSound(entity.kind, 'step')
        }
      } else {
        entity.stepTime = 0
      }
      this.index(entity, oldKey)
    }
    this.separateEntities()
    this.breedPairs()
    this.breedVillagerPairs()
    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 4
      this.tryNaturalSpawn(context)
    }
  }

  /** Avoids dozens of nearby animals starting the same non-critical sample at once. */
  private emitCrowdSound(kind: MobKind, event: 'ambient' | 'step' | 'egg'): void {
    if ((this.soundGates.get(event) ?? 0) > 0) return
    this.hooks.sound(kind, event)
    this.soundGates.set(event, event === 'ambient' ? 0.3 : event === 'egg' ? 0.18 : 0.1)
  }

  private ai(entity: EntityState, context: EntityUpdateContext, dt: number): void {
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
    this.passiveAi(entity, context, dt)
  }

  /**
   * Ordered passive task scheduler. Swimming owns the jump channel only, so a
   * panic/mate/tempt movement task may continue while the animal surfaces.
   * The exposed activeTask is the highest-priority task for diagnostics and
   * rendering.
   */
  private passiveAi(entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = PASSIVE_DEFINITIONS[entity.kind as PeacefulKind]
    const swimming = entity.inWater || this.world.isWater(
      Math.floor(entity.x), Math.floor(entity.y + entity.height * 0.45), Math.floor(entity.z)
    )
    if (swimming) entity.vy = Math.max(entity.vy, 3.2)

    const movementTask = this.passiveMovementTask(entity, context, def, dt)
    entity.activeTask = swimming ? 'swim' : movementTask
  }

  /** Fixed priority: panic, mate, tempt, follow parent, grass, wander, watch, idle. */
  private passiveMovementTask(
    entity: EntityState, context: EntityUpdateContext, def: PassiveDefinition, dt: number
  ): PassiveTaskKind {
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

  /** Panic goals are sampled in the half-plane away from the stored damage source. */
  private passivePanicTask(entity: EntityState, def: PassiveDefinition, dt: number): void {
    if (this.simulationTick >= entity.panicGoalUntilTick ||
      Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 1) {
      this.chooseReachablePanicGoal(entity)
    }
    this.lookHeadAt(entity, entity.goalX, entity.goalY + entity.height * 0.5, entity.goalZ)
    this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, def.speed * 1.55, dt)
  }

  private chooseReachablePanicGoal(entity: EntityState): void {
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

  private passiveMateTask(entity: EntityState, def: PassiveDefinition, dt: number): boolean {
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

  private validMate(entity: EntityState, mate: EntityState | null, radius: number): mate is EntityState {
    return !!mate && mate.id !== entity.id && mate.kind === entity.kind && mate.health > 0 &&
      mate.loveTime > 0 && mate.age === 0 && mate.breedCooldown <= 0 &&
      Math.hypot(mate.x - entity.x, mate.y - entity.y, mate.z - entity.z) < radius
  }

  private passiveTemptTask(
    entity: EntityState, context: EntityUpdateContext, def: PassiveDefinition, dt: number
  ): boolean {
    const player = this.playerTarget({ ...context, playerTargetable: true })
    const distance = this.targetDistance(entity, player)
    let valid = context.heldItem === def.temptingItem && entity.temptCooldownTicks <= 0 &&
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

  private passiveFollowParentTask(entity: EntityState, def: PassiveDefinition, dt: number): boolean {
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

  private passiveEatGrassTask(entity: EntityState): boolean {
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

  private hasEdibleGrass(entity: EntityState): boolean {
    const x = Math.floor(entity.x), y = Math.floor(entity.y + 0.1), z = Math.floor(entity.z)
    return this.world.getBlock(x, y, z) === B.TALLGRASS || this.world.getBlock(x, y - 1, z) === B.GRASS
  }

  private passiveWanderTask(entity: EntityState, def: PassiveDefinition, dt: number): boolean {
    const arrived = Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 0.7
    if (entity.goalTime > 0 && !arrived) {
      entity.goalTime = Math.max(0, entity.goalTime - dt)
      entity.headYaw = entity.yaw
      entity.headPitch = 0
      this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, def.speed * 0.72, dt)
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
    this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, def.speed * 0.72, dt)
    return true
  }

  private passiveWatchTask(entity: EntityState, context: EntityUpdateContext): boolean {
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

  private passiveIdleLookTask(entity: EntityState): void {
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

  private lookHeadAt(entity: EntityState, x: number, y: number, z: number): void {
    const dx = x - entity.x, dz = z - entity.z
    const desiredYaw = Math.atan2(-dx, -dz)
    const yawDelta = Math.atan2(Math.sin(desiredYaw - entity.headYaw), Math.cos(desiredYaw - entity.headYaw))
    entity.headYaw += clamp(yawDelta, -0.28, 0.28)
    const horizontal = Math.max(0.001, Math.hypot(dx, dz))
    const eyeY = entity.y + entity.height * (entity.age < 0 ? 0.58 : 1) * 0.82
    entity.headPitch = clamp(-Math.atan2(y - eyeY, horizontal), -0.65, 0.65)
  }

  /** Village-aware classic schedule: threats, shelter, restriction, social tasks, wander/look. */
  private villagerAi(entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = VILLAGER_DEFINITIONS.villager
    this.tryCloseVillagerDoor(entity)
    const swimming = entity.inWater || this.world.isWater(
      Math.floor(entity.x), Math.floor(entity.y + entity.height * 0.45), Math.floor(entity.z)
    )
    if (swimming) {
      entity.vy = Math.max(entity.vy, 3.2)
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

  private villagerThreat(entity: EntityState): EntityState | null {
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

  private villagerFlee(entity: EntityState, sourceX: number, sourceZ: number, speed: number, dt: number): void {
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

  private resolveVillagerVillage(entity: EntityState): VillageNode | null {
    let village = entity.villageId ? this.villageGraph.getVillage(entity.villageId) : null
    if (!village) village = this.villageGraph.villageAt(entity) ?? this.villageGraph.nearestVillage(entity, 64)
    if (village) entity.villageId = village.id
    return village
  }

  private resolveVillagerDoor(entity: EntityState, village: VillageNode | null): VillageDoorNode | null {
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

  private isInsideVillageDoor(entity: EntityState, door: VillageDoorNode): boolean {
    const nx = door.outside.x - door.inside.x
    const nz = door.outside.z - door.inside.z
    return (entity.x - (door.x + 0.5)) * nx + (entity.z - (door.z + 0.5)) * nz < -0.05
  }

  private villagerMoveIndoors(entity: EntityState, door: VillageDoorNode, speed: number, dt: number): void {
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

  private villagerLeaveHouse(entity: EntityState, door: VillageDoorNode, speed: number, dt: number): void {
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

  private openVillageDoorNear(entity: EntityState, door: VillageDoorNode): void {
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

  private scheduleVillagerDoorClose(entity: EntityState, door: VillageDoorNode): void {
    if (this.world.doorState?.(door.x, door.y, door.z) !== 'open') return
    entity.pendingDoorKey = door.key
    entity.closeDoorAt = Math.min(entity.closeDoorAt || Infinity, this.simulationTick + 20)
  }

  private tryCloseVillagerDoor(entity: EntityState): void {
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

  private villagerReturnToVillage(entity: EntityState, village: VillageNode, speed: number, dt: number): void {
    const dx = village.centerX + 0.5 - entity.x
    const dz = village.centerZ + 0.5 - entity.z
    const distance = Math.hypot(dx, dz) || 1
    const step = Math.min(10, distance)
    this.navigate(
      entity, entity.x + dx / distance * step, village.centerY,
      entity.z + dz / distance * step, speed, dt, 'open'
    )
  }

  private villagerMateTask(entity: EntityState, village: VillageNode, speed: number, dt: number): boolean {
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

  private validVillagerMate(entity: EntityState, mate: EntityState | null, villageId: string): mate is EntityState {
    return !!mate && mate.id !== entity.id && mate.kind === 'villager' && mate.health > 0 &&
      mate.age === 0 && mate.breedCooldown <= 0 && mate.villageId === villageId
  }

  private villagerSocializeTask(entity: EntityState): boolean {
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

  private villagerWanderTask(entity: EntityState, village: VillageNode | null, speed: number, dt: number): boolean {
    const arrived = Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 0.7
    if (entity.goalTime > 0 && !arrived) {
      entity.goalTime = Math.max(0, entity.goalTime - dt)
      this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, speed * 0.72, dt, 'open')
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
    this.navigate(entity, entity.goalX, entity.goalY, entity.goalZ, speed * 0.72, dt, 'open')
    return true
  }

  private hostileAi(entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = HOSTILE_DEFINITIONS[entity.kind as HostileKind]
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

  /** Phase 1: infrequent target selection. It never performs movement or attacks. */
  private selectHostileTarget(
    entity: EntityState,
    context: EntityUpdateContext,
    def: HostileDefinition,
    player: AiTarget,
    spiderBright: boolean
  ): void {
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

  /** Phase 2: target continuation and sight memory, with no action side effects. */
  private continueHostileTarget(
    entity: EntityState,
    context: EntityUpdateContext,
    def: HostileDefinition,
    spiderBright: boolean
  ): TrackedTarget | null {
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

  /** Phase 3a: choose a navigation intent when no attack target exists. */
  private hostileWanderIntent(entity: EntityState, def: HostileDefinition, dt: number): NavigationIntent {
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

  /** Phase 4: execute species attack logic and return its desired movement separately. */
  private hostileAttackAction(
    entity: EntityState,
    context: EntityUpdateContext,
    def: HostileDefinition,
    tracked: TrackedTarget,
    dt: number
  ): NavigationIntent {
    const { target, visible, distance, goal } = tracked
    const dx = target.x - entity.x
    const dz = target.z - entity.z
    if (entity.kind === 'creeper' && target.id === PLAYER_TARGET_ID) {
      if (visible && distance < 3.2) {
        if (entity.fuse === 0) this.hooks.sound('creeper', 'fuse')
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

  /** Phase 3b: the only hostile-AI method allowed to mutate navigation/velocity. */
  private applyNavigationIntent(entity: EntityState, intent: NavigationIntent, dt: number): void {
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

  /** Slimes wait on the ground and move only through discrete size-aware hops. */
  private applySlimeMovement(
    entity: EntityState, intent: NavigationIntent, hasTarget: boolean, dt: number
  ): void {
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

  /** Range + allowed-kind + line-of-sight gate used only while selecting a new target. */
  private canAcquireTarget(entity: EntityState, target: AiTarget, range: number): boolean {
    return this.isAllowedTarget(entity, target) && this.targetDistance(entity, target) <= range &&
      this.canSeeTarget(entity, target)
  }

  private isAllowedTarget(entity: EntityState, target: AiTarget): boolean {
    if (!target.alive || target.id === entity.id) return false
    if (target.kind === 'player') return true
    if (entity.kind === 'zombie' && target.kind === 'villager') return true
    return entity.revengeTargetId === target.id
  }

  private nearestVisibleVillager(entity: EntityState, range: number): AiTarget | null {
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

  private playerTarget(context: EntityUpdateContext): AiTarget {
    return {
      id: PLAYER_TARGET_ID, kind: 'player', x: context.player.x, y: context.player.y,
      z: context.player.z, width: 0.6, height: 1.8, alive: context.playerTargetable ?? true
    }
  }

  private entityTarget(entity: EntityState): AiTarget {
    return {
      id: entity.id, kind: entity.kind, x: entity.x, y: entity.y, z: entity.z,
      width: entity.width * (entity.sizeScale ?? 1),
      height: entity.height * (entity.sizeScale ?? 1), alive: entity.health > 0
    }
  }

  private resolveTarget(id: string | null, context: EntityUpdateContext): AiTarget | null {
    if (!id) return null
    if (id === PLAYER_TARGET_ID) return this.playerTarget(context)
    const entity = this.entities.get(id)
    return entity ? this.entityTarget(entity) : null
  }

  private targetDistance(entity: EntityState, target: AiTarget): number {
    return Math.hypot(
      target.x - entity.x,
      target.y + target.height * 0.5 - (entity.y + entity.height * (entity.sizeScale ?? 1) * 0.5),
      target.z - entity.z
    )
  }

  private canSeeTarget(entity: EntityState, target: AiTarget): boolean {
    return this.hasLineOfSight(
      entity.x, entity.y + entity.height * (entity.sizeScale ?? 1) * 0.85, entity.z,
      target.x, target.y + target.height * 0.85, target.z
    )
  }

  private rememberTarget(entity: EntityState, target: AiTarget): void {
    if (entity.targetId !== target.id) entity.targetVisibleTicks = 0
    entity.targetId = target.id
    this.updateLastSeen(entity, target)
  }

  private updateLastSeen(entity: EntityState, target: AiTarget): void {
    entity.lastSeenAt = this.simulationTick
    entity.lastSeenPosition = { x: target.x, y: target.y, z: target.z }
  }

  private clearTarget(entity: EntityState): void {
    if (entity.revengeTargetId === entity.targetId) entity.revengeTargetId = null
    entity.targetId = null
    entity.lastSeenPosition = null
    entity.lastSeenAt = -Infinity
    entity.targetVisibleTicks = 0
    entity.teleportDelayTicks = 0
    this.clearNavigation(entity)
  }

  private updateEndermanStare(entity: EntityState, context: EntityUpdateContext, player: AiTarget): void {
    const lookedAt = this.isPlayerStaringAtEnderman(entity, context, player)
    entity.stareTicks = lookedAt ? entity.stareTicks + 1 : 0
    if (entity.stareTicks < ENDERMAN_STARE_TICKS) return
    entity.angryTime = 30
    this.rememberTarget(entity, player)
  }

  private isPlayerStaringAtEnderman(
    entity: EntityState, context: EntityUpdateContext, player = this.playerTarget(context)
  ): boolean {
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

  private updateEndermanEnvironment(entity: EntityState, context: EntityUpdateContext): void {
    const wet = !!context.raining && this.isExposedToSky(entity)
    if (wet && Math.random() < 0.05) this.tryTeleport(entity)
    if (!this.isSunlit(entity, context) || Math.random() >= 0.01) return
    entity.angryTime = 0
    entity.revengeTargetId = null
    if (entity.targetId) this.clearTarget(entity)
    this.tryTeleport(entity)
  }

  private updateEndermanTeleportState(
    entity: EntityState, context: EntityUpdateContext, tracked: TrackedTarget
  ): void {
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

  private navigationProfile(entity: EntityState, canOpenDoors: boolean): NavProfile {
    const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
    return {
      width: entity.width * scale,
      height: entity.height * scale,
      maxStep: 1,
      maxFall: 3,
      canSwim: entity.kind !== 'enderman',
      canOpenDoors,
      waterCost: 2,
      maxVisited: 768,
      maxDistance: 32
    }
  }

  private nearestNavigationGoal(goal: NavNode, profile: NavProfile): NavNode | null {
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

  /** Throttled path planning + waypoint following + 20-tick stuck detection. */
  private navigate(
    entity: EntityState,
    goalX: number,
    goalY: number,
    goalZ: number,
    speed: number,
    dt: number,
    doorMode: 'none' | 'open' | 'break' = 'none'
  ): boolean {
    const profile = this.navigationProfile(entity, doorMode !== 'none')
    const desired = nodeForPosition(goalX, goalY, goalZ, profile)

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
      entity.nextPathAt = this.simulationTick + TARGET_SCAN_MIN_TICKS +
        Math.floor(Math.random() * TARGET_SCAN_JITTER_TICKS)
      next = entity.navPath[entity.navIndex]
    }

    while (next) {
      const center = nodeCenter(next, profile)
      if (Math.hypot(center.x - entity.x, center.z - entity.z) > 0.32 || Math.abs(center.y - entity.y) > 0.65) break
      entity.navIndex++
      next = entity.navPath[entity.navIndex]
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
    if (waypoint.y > entity.y + 0.35 && entity.onGround) entity.vy = Math.max(entity.vy, 7.6)
    this.steer(entity, waypoint.x, waypoint.z, speed, dt)
    return true
  }

  private clearNavigation(entity: EntityState, delay = 0): void {
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

  private isBreakingClosedDoor(entity: EntityState): boolean {
    return entity.doorBreakTicks > 0 &&
      this.world.doorState?.(entity.doorBreakX, entity.doorBreakY, entity.doorBreakZ) === 'closed'
  }

  private resetDoorBreak(entity: EntityState): void {
    entity.doorBreakTicks = 0
    entity.doorBreakX = 0
    entity.doorBreakY = 0
    entity.doorBreakZ = 0
  }

  /**
   * Rotates the entity toward a heading at a capped angular speed. A raw
   * `yaw = atan2(...)` snaps instantly, and when the target vector is tiny and
   * noisy (a mob sitting on its goal, mate or the player) atan2 whips around the
   * full circle every tick — which read as mobs spinning wildly. Capping the
   * step keeps turns smooth no matter how jittery the desired heading is.
   */
  private faceToward(entity: EntityState, targetYaw: number, dt: number, rate = 9): void {
    const delta = Math.atan2(Math.sin(targetYaw - entity.yaw), Math.cos(targetYaw - entity.yaw))
    entity.yaw += clamp(delta, -rate * dt, rate * dt)
  }

  private steer(entity: EntityState, goalX: number, goalZ: number, speed: number, dt: number): void {
    const dx = goalX - entity.x, dz = goalZ - entity.z, len = Math.hypot(dx, dz)
    if (len <= 0.25) { entity.vx *= 0.82; entity.vz *= 0.82; return }
    this.faceToward(entity, Math.atan2(-dx, -dz), dt)
    entity.vx += (dx / len * speed - entity.vx) * clamp(dt * 4, 0, 1)
    entity.vz += (dz / len * speed - entity.vz) * clamp(dt * 4, 0, 1)
  }

  /** Arms the classic summon goal on first damage without letting repeated hits postpone it forever. */
  private scheduleSilverfishCallForHelp(entity: EntityState): void {
    if (entity.kind !== 'silverfish' || entity.health <= 0) return
    if (entity.silverfishCallForHelpAtTick <= this.simulationTick) {
      entity.silverfishCallForHelpAtTick = this.simulationTick + SILVERFISH_HELP_DELAY_TICKS
    }
    entity.silverfishHideAtTick = Math.max(
      entity.silverfishHideAtTick,
      entity.silverfishCallForHelpAtTick + SILVERFISH_HIDE_RETRY_TICKS
    )
  }

  /** Runs the delayed summon goal and rearms hiding so the caller cannot vanish on the same tick. */
  private updateSilverfishCallForHelp(entity: EntityState): void {
    if (entity.silverfishCallForHelpAtTick <= 0 ||
      this.simulationTick < entity.silverfishCallForHelpAtTick) return
    entity.silverfishCallForHelpAtTick = 0
    this.awakenNearbyInfestedStone(entity)
    entity.silverfishHideAtTick = this.simulationTick + SILVERFISH_HIDE_RETRY_TICKS
  }

  /** An untargeted, grounded silverfish may replace one adjacent stone block and despawn into it. */
  private trySilverfishHide(entity: EntityState): boolean {
    if (!this.world.setBlock || !entity.onGround ||
      entity.silverfishCallForHelpAtTick > 0 || this.simulationTick < entity.silverfishHideAtTick) return false
    entity.silverfishHideAtTick = this.simulationTick + SILVERFISH_HIDE_RETRY_TICKS
    const x = Math.floor(entity.x), y = Math.floor(entity.y + 0.1), z = Math.floor(entity.z)
    const phase = ((Math.imul(x, 31) ^ Math.imul(y, 17) ^ Math.imul(z, 13)) >>> 0) %
      SILVERFISH_HIDE_DIRECTIONS.length
    for (let offset = 0; offset < SILVERFISH_HIDE_DIRECTIONS.length; offset++) {
      const [dx, dy, dz] = SILVERFISH_HIDE_DIRECTIONS[(phase + offset) % SILVERFISH_HIDE_DIRECTIONS.length]
      const bx = x + dx, by = y + dy, bz = z + dz
      const infested = infestedBlockFor(this.world.getBlock(bx, by, bz))
      if (infested === null) continue
      this.world.setBlock(bx, by, bz, infested)
      this.remove(entity.id)
      return true
    }
    return false
  }

  /** Classic 3D block pickup/placement around the enderman itself, never the column surface. */
  private updateEndermanBlock(entity: EntityState): void {
    if (!this.world.setBlock) return
    if (entity.carriedBlock === null) {
      if (Math.floor(Math.random() * 20) !== 0) return
      const x = Math.floor(entity.x) + Math.floor(Math.random() * 5) - 2
      const y = Math.floor(entity.y) + Math.floor(Math.random() * 3) - 1
      const z = Math.floor(entity.z) + Math.floor(Math.random() * 5) - 2
      if (y < 1 || y >= 127 || !this.hasLineOfSightToBlock(
        entity.x, entity.y + entity.height * 0.85, entity.z, x, y, z
      )) return
      const id = this.world.getBlock(x, y, z)
      if (!ENDERMAN_CARRYABLE.has(id)) return
      this.world.setBlock(x, y, z, B.AIR)
      entity.carriedBlock = id
      return
    }
    if (Math.floor(Math.random() * 2000) !== 0) return
    const x = Math.floor(entity.x) + Math.floor(Math.random() * 3) - 1
    const y = Math.floor(entity.y) + Math.floor(Math.random() * 3) - 1
    const z = Math.floor(entity.z) + Math.floor(Math.random() * 3) - 1
    if (y < 1 || y >= 127 || this.world.getBlock(x, y, z) !== B.AIR ||
      !this.world.isSolid(x, y - 1, z) || isFluid(this.world.getBlock(x, y - 1, z))) return
    const half = entity.width * 0.5
    const intersectsSelf = x + 1 > entity.x - half && x < entity.x + half &&
      y + 1 > entity.y && y < entity.y + entity.height &&
      z + 1 > entity.z - half && z < entity.z + half
    if (!intersectsSelf) {
      this.world.setBlock(x, y, z, entity.carriedBlock)
      entity.carriedBlock = null
    }
  }

  private hasLineOfSight(x: number, y: number, z: number, tx: number, ty: number, tz: number): boolean {
    const dx = tx - x, dy = ty - y, dz = tz - z
    const steps = Math.ceil(Math.hypot(dx, dy, dz) * 2)
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      if (this.world.isSolid(Math.floor(x + dx * t), Math.floor(y + dy * t), Math.floor(z + dz * t))) return false
    }
    return true
  }

  private hasLineOfSightToBlock(
    x: number, y: number, z: number, targetX: number, targetY: number, targetZ: number
  ): boolean {
    const tx = targetX + 0.5, ty = targetY + 0.5, tz = targetZ + 0.5
    const dx = tx - x, dy = ty - y, dz = tz - z
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) * 3))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const bx = Math.floor(x + dx * t), by = Math.floor(y + dy * t), bz = Math.floor(z + dz * t)
      if (bx === targetX && by === targetY && bz === targetZ) return true
      if (this.world.isSolid(bx, by, bz)) return false
    }
    return false
  }

  private effectiveLight(x: number, y: number, z: number, darkness: number): number {
    if (this.world.getBlockLight && this.world.getSkyLight) {
      return Math.max(this.world.getBlockLight(x, y, z), this.world.getSkyLight(x, y, z) - darkness)
    }
    return Math.max(0, this.world.getLightLevel(x, y, z) - darkness)
  }

  private isSunlit(entity: EntityState, context: EntityUpdateContext): boolean {
    const darkness = context.skyDarkness ?? 15
    if (darkness > 4) return false
    const sky = this.world.getSkyLight?.(Math.floor(entity.x), Math.floor(entity.y + entity.height), Math.floor(entity.z))
    return sky === undefined ? this.world.getLightLevel(entity.x, entity.y + entity.height, entity.z) >= 14 : sky >= 14
  }

  private isExposedToSky(entity: EntityState): boolean {
    const x = Math.floor(entity.x), y = Math.floor(entity.y + entity.height), z = Math.floor(entity.z)
    const sky = this.world.getSkyLight?.(x, y, z)
    return sky === undefined ? this.world.topSolidY(x, z) < y : sky >= 15
  }

  private touchesCactus(entity: EntityState): boolean {
    const margin = 1 / 64
    const half = entity.width / 2
    const minX = entity.x - half - margin, maxX = entity.x + half + margin
    const minY = entity.y, maxY = entity.y + entity.height
    const minZ = entity.z - half - margin, maxZ = entity.z + half + margin
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
          if (this.world.getBlock(x, y, z) !== B.CACTUS) continue
          if (maxX > x + 1 / 16 && minX < x + 15 / 16 && maxY > y && minY < y + 1 &&
            maxZ > z + 1 / 16 && minZ < z + 15 / 16) return true
        }
      }
    }
    return false
  }

  /** Shared creeper/TNT-ready explosion engine: radial damage, knockback and block destruction. */
  explode(x: number, y: number, z: number, power: number, player?: { x: number; y: number; z: number }): void {
    // entity damage reaches 2×power blocks like vanilla; block destruction stays at ~power
    for (const target of [...this.entities.values()]) {
      const distance = Math.hypot(target.x - x, target.y + target.height * 0.5 - y, target.z - z)
      const amount = explosionDamage(distance, power)
      if (amount > 0) this.damage(target.id, amount, x, z)
    }
    if (player) {
      const distance = Math.hypot(player.x - x, player.y + 0.9 - y, player.z - z)
      const amount = explosionDamage(distance, power)
      if (amount > 0) this.hooks.damagePlayer(amount, x, z, 6 * (1 - distance / (2 * power)))
    }
    if (this.world.setBlock) {
      const radius = power
      const r = Math.ceil(radius)
      const destroy = () => {
        for (let bx = Math.floor(x) - r; bx <= Math.floor(x) + r; bx++) {
          for (let by = Math.floor(y) - r; by <= Math.floor(y) + r; by++) {
            for (let bz = Math.floor(z) - r; bz <= Math.floor(z) + r; bz++) {
              const distance = Math.hypot(bx + 0.5 - x, by + 0.5 - y, bz + 0.5 - z)
              const id = this.world.getBlock(bx, by, bz)
              if (id !== B.AIR && id !== B.BEDROCK && id !== B.OBSIDIAN && id !== B.PRIMED_TNT && distance < radius * (0.72 + Math.random() * 0.35)) {
                if (id === B.TNT && this.world.primeTnt) {
                  // chained TNT gets a short random fuse and may be tossed aside (cannon-ish)
                  this.world.primeTnt(bx, by, bz, 10 + Math.floor(Math.random() * 21), true)
                } else {
                  this.world.setBlock!(bx, by, bz, B.AIR)
                  this.hooks.blockExploded(bx, by, bz, id)
                }
              }
            }
          }
        }
      }
      if (this.world.batchBlocks) this.world.batchBlocks(destroy)
      else destroy()
    }
    this.hooks.explosion(x, y, z, power)
  }

  private physics(entity: EntityState, dt: number): void {
    entity.inWater = this.world.isWater(Math.floor(entity.x), Math.floor(entity.y + entity.height * 0.45), Math.floor(entity.z))
    if (entity.inWater) {
      entity.vy += 8 * dt
      entity.vx *= 0.92; entity.vz *= 0.92; entity.vy *= 0.88
    } else entity.vy -= GRAVITY * dt
    entity.vy = Math.max(entity.vy, -18)
    const wasGrounded = entity.onGround
    if (entity.kind === 'chicken') {
      // Classic chicken flutter is multiplicative, not a terminal-speed clamp.
      if (!entity.inWater && !wasGrounded && entity.vy < 0) entity.vy *= 0.6
      entity.wingSpeed = clamp(entity.wingSpeed + (wasGrounded ? -0.3 : 1.2), 0, 1)
      entity.wingRotation += entity.wingSpeed * 2
    }
    entity.onGround = false
    entity.horizontalCollision = false
    this.moveAxis(entity, 'x', entity.vx * dt, wasGrounded)
    this.moveAxis(entity, 'z', entity.vz * dt, wasGrounded)
    if (entity.kind === 'spider' && entity.horizontalCollision) entity.vy = Math.max(entity.vy, 4.2)
    this.moveAxis(entity, 'y', entity.vy * dt)
    if (entity.onGround || entity.inWater) {
      if (!wasGrounded && entity.onGround && !entity.inWater) this.applyFallDamage(entity)
      entity.fallPeakY = entity.y
    } else {
      entity.fallPeakY = Math.max(entity.fallPeakY ?? entity.y, entity.y)
    }
  }

  /** Vanilla: mobs take (fall height − 3) damage on landing; chickens glide and are exempt. */
  private applyFallDamage(entity: EntityState): void {
    if (entity.kind === 'chicken' || entity.health <= 0) return
    const amount = Math.ceil((entity.fallPeakY ?? entity.y) - entity.y - 3.05)
    if (amount <= 0) return
    entity.health -= amount
    entity.hurtTime = 0.5
    if (entity.health <= 0) {
      entity.health = 0
      entity.deathTime = Number.EPSILON
      this.hooks.sound(entity.kind, 'death')
    } else {
      this.hooks.sound(entity.kind, 'hurt')
      this.scheduleSilverfishCallForHelp(entity)
    }
  }

  private moveAxis(entity: EntityState, axis: 'x' | 'y' | 'z', amount: number, canStep = false): void {
    if (amount === 0) return
    const steps = Math.max(1, Math.ceil(Math.abs(amount) / 0.2))
    const delta = amount / steps
    for (let i = 0; i < steps; i++) {
      entity[axis] += delta
      if (!this.collidesWorld(entity)) continue
      if (axis !== 'y' && canStep && this.tryStepUp(entity)) continue
      entity[axis] -= delta
      if (axis !== 'y') entity.horizontalCollision = true
      if (axis === 'y' && delta < 0) entity.onGround = true
      if (axis === 'x') entity.vx = 0
      else if (axis === 'y') entity.vy = 0
      else entity.vz = 0
      break
    }
  }

  /** Guaranteed one-block step assist after the normal jump impulse meets a wall. */
  private tryStepUp(entity: EntityState): boolean {
    const previousY = entity.y
    entity.y += 1.001
    if (!this.collidesWorld(entity)) {
      entity.vy = Math.max(entity.vy, 2.2)
      entity.onGround = false
      return true
    }
    entity.y = previousY
    return false
  }

  /** Repairs entities loaded or pushed into terrain instead of leaving them trapped forever. */
  private resolveEmbedded(entity: EntityState): void {
    if (!this.collidesWorld(entity)) return
    const startX = entity.x, startY = entity.y, startZ = entity.z
    const offsets = [
      [0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5],
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]
    ] as const
    for (const [dx, dz] of offsets) {
      for (const dy of [0.25, 0.5, 0.75, 1.001, 1.5, 2.001]) {
        entity.x = startX + dx
        entity.y = startY + dy
        entity.z = startZ + dz
        if (!this.collidesWorld(entity)) {
          entity.vx = entity.vz = 0
          entity.vy = Math.max(0, entity.vy)
          this.clearNavigation(entity)
          return
        }
      }
    }
    entity.x = startX
    entity.z = startZ
    entity.y = Math.max(startY, this.world.topSolidY(Math.floor(startX), Math.floor(startZ)) + 1.001)
    entity.vx = entity.vy = entity.vz = 0
    this.clearNavigation(entity)
  }

  private collidesWorld(entity: EntityState): boolean {
    const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
    const half = entity.width * scale * 0.5 - 0.02
    const bodyMinX = entity.x - half, bodyMaxX = entity.x + half
    const bodyMinY = entity.y + 0.01, bodyMaxY = entity.y + entity.height * scale - 0.01
    const bodyMinZ = entity.z - half, bodyMaxZ = entity.z + half
    const minX = Math.floor(bodyMinX), maxX = Math.floor(bodyMaxX)
    const minY = Math.floor(bodyMinY), maxY = Math.floor(bodyMaxY)
    const minZ = Math.floor(bodyMinZ), maxZ = Math.floor(bodyMaxZ)
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      const shape = blockCollisionBox(this.world.getBlock(x, y, z))
      if (!shape) continue
      if (bodyMaxX > x + shape.minX && bodyMinX < x + shape.maxX &&
        bodyMaxY > y + shape.minY && bodyMinY < y + shape.maxY &&
        bodyMaxZ > z + shape.minZ && bodyMinZ < z + shape.maxZ) return true
    }
    return false
  }

  private separateEntities(): void {
    for (const entity of this.entities.values()) {
      if (!entity.active || entity.health <= 0) continue
      const minCx = Math.floor((entity.x - 1.25) / CHUNK_SIZE), maxCx = Math.floor((entity.x + 1.25) / CHUNK_SIZE)
      const minCz = Math.floor((entity.z - 1.25) / CHUNK_SIZE), maxCz = Math.floor((entity.z + 1.25) / CHUNK_SIZE)
      for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) {
        for (const id of this.spatial.get(cx * 0x100000000 + cz) ?? []) {
          if (id <= entity.id) continue
          const target = this.entities.get(id)
          if (!target || target.health <= 0) continue
          if (Math.abs(target.y - entity.y) > 1.25) continue
          const dx = target.x - entity.x, dz = target.z - entity.z
          const distance = Math.hypot(dx, dz)
          const min = (entity.width + target.width) * 0.42
          if (distance <= 0.001 || distance >= min) continue
          const push = (min - distance) * 0.5
          this.pushIfFree(entity, -dx / distance * push, -dz / distance * push)
          this.pushIfFree(target, dx / distance * push, dz / distance * push)
        }
      }
    }
  }

  /** Nudges an entity sideways and keeps the spatial index in sync. */
  private pushIfFree(entity: EntityState, dx: number, dz: number): void {
    const oldX = entity.x, oldZ = entity.z
    const oldKey = this.chunkKey(oldX, oldZ)
    entity.x += dx
    entity.z += dz
    if (this.collidesWorld(entity)) {
      entity.x = oldX
      entity.z = oldZ
      return
    }
    this.index(entity, oldKey)
  }

  private breedPairs(): void {
    for (const entity of this.entities.values()) {
      if (!isPeacefulKind(entity.kind)) continue
      if (entity.health <= 0 || entity.loveTime <= 0 || entity.age < 0 || entity.breedCooldown > 0) continue
      const partner = entity.mateId ? this.entities.get(entity.mateId) ?? null : null
      if (!this.validMate(entity, partner, BREED_DISTANCE) || partner.mateId !== entity.id ||
        entity.id > partner.id || entity.mateCourtshipTicks < MATE_COURTSHIP_TICKS ||
        partner.mateCourtshipTicks < MATE_COURTSHIP_TICKS ||
        !this.canSeeTarget(entity, this.entityTarget(partner)) || this.entities.size >= ENTITY_HARD_CAP) continue
      const baby = this.spawn(entity.kind,
        (entity.x + partner.x) * 0.5, Math.max(entity.y, partner.y), (entity.z + partner.z) * 0.5, {
        baby: true, persistent: true, bypassMobCap: true,
        ignoreEntityIds: [entity.id, partner.id]
      })
      if (!baby) continue
      entity.loveTime = partner.loveTime = 0
      entity.breedCooldown = partner.breedCooldown = 300
      entity.persistent = partner.persistent = true
      entity.mateId = partner.mateId = null
      entity.mateCourtshipTicks = partner.mateCourtshipTicks = 0
    }
  }

  private nearestMate(entity: EntityState, radius: number): EntityState | null {
    if (!isPeacefulKind(entity.kind)) return null
    let nearest: EntityState | null = null
    let best = radius
    for (const candidate of this.entities.values()) {
      if (candidate.id === entity.id || candidate.kind !== entity.kind || candidate.loveTime <= 0 ||
        candidate.age < 0 || candidate.breedCooldown > 0 ||
        (candidate.mateId && candidate.mateId !== entity.id)) continue
      const distance = Math.hypot(candidate.x - entity.x, candidate.y - entity.y, candidate.z - entity.z)
      if (distance >= best || !this.canSeeTarget(entity, this.entityTarget(candidate))) continue
      best = distance
      nearest = candidate
    }
    return nearest
  }

  private breedVillagerPairs(): void {
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'villager' || entity.health <= 0 || entity.age < 0 ||
        entity.breedCooldown > 0 || !entity.villageId || !entity.villagerMateId ||
        entity.villagerMateTicks < 300) continue
      const partner = this.entities.get(entity.villagerMateId) ?? null
      if (!this.validVillagerMate(entity, partner, entity.villageId) ||
        partner.villagerMateId !== entity.id || partner.villagerMateTicks < 300 || entity.id > partner.id) continue
      const residents = [...this.entities.values()].filter(candidate =>
        candidate.kind === 'villager' && candidate.health > 0 && candidate.villageId === entity.villageId).length
      if (residents >= this.villageGraph.capacity(entity.villageId)) continue
      const baby = this.spawn('villager',
        (entity.x + partner.x) * 0.5, Math.max(entity.y, partner.y), (entity.z + partner.z) * 0.5, {
        baby: true, persistent: true, bypassMobCap: true,
        profession: entity.profession ?? 'farmer',
        homeX: entity.homeX, homeY: entity.homeY, homeZ: entity.homeZ,
        villageId: entity.villageId, homeDoorKey: entity.homeDoorKey ?? undefined,
        ignoreEntityIds: [entity.id, partner.id]
      })
      if (!baby) continue
      entity.breedCooldown = partner.breedCooldown = 300
      entity.villagerMateId = partner.villagerMateId = null
      entity.villagerMateTicks = partner.villagerMateTicks = 0
    }
  }

  private tryNaturalSpawn(context: EntityUpdateContext): void {
    if (!context.worldSpawn) return
    const eligible = eligibleChunksAround(context.player.x, context.player.z)
    const hostileCap = scaledMobCap(70, eligible.length)
    const passiveCap = scaledMobCap(15, eligible.length)
    if (this.hostileCount >= hostileCap && this.passiveCount >= passiveCap) return

    const spawnable = eligible.filter(chunk => !chunk.border)
    for (let i = spawnable.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[spawnable[i], spawnable[j]] = [spawnable[j], spawnable[i]]
    }
    if (this.hostileCount < hostileCap) this.spawnNaturalCategory('hostile', spawnable, hostileCap, context)
    if (this.passiveCount < passiveCap) this.spawnNaturalCategory('passive', spawnable, passiveCap, context)
  }

  private spawnNaturalCategory(
    category: 'hostile' | 'passive', chunks: readonly EligibleChunk[], cap: number,
    context: EntityUpdateContext
  ): void {
    const darkness = context.skyDarkness ?? 0
    for (const chunk of chunks) {
      const count = category === 'hostile' ? this.hostileCount : this.passiveCount
      if (count >= cap || this.entities.size >= ENTITY_HARD_CAP) return
      const x = chunk.cx * CHUNK_SIZE + Math.floor(Math.random() * CHUNK_SIZE) + 0.5
      const z = chunk.cz * CHUNK_SIZE + Math.floor(Math.random() * CHUNK_SIZE) + 0.5
      const biome = this.world.biomeAt(x, z)
      const entry = pickWeightedSpawnEntry(spawnEntriesForBiome(category, biome), Math.random())
      if (!entry) continue
      const surfaceY = this.world.topSolidY(x, z) + 1
      if (surfaceY <= 1) continue
      const baseY = category === 'passive' ? surfaceY : this.findNaturalHostileY(x, z, surfaceY)
      if (baseY === null) continue

      let packSize = entry.minPack + Math.floor(Math.random() * (entry.maxPack - entry.minPack + 1))
      if (category === 'passive') {
        const localPassives = this.queryRadius(x, baseY, z, 24)
          .filter(entity => isPeacefulKind(entity.kind)).length
        if (localPassives >= NATURAL_PASSIVE_LOCAL_CAP) continue
        packSize = Math.min(packSize, NATURAL_PASSIVE_LOCAL_CAP - localPassives)
      }
      for (let member = 0; member < packSize; member++) {
        const currentCount = category === 'hostile' ? this.hostileCount : this.passiveCount
        if (currentCount >= cap || this.entities.size >= ENTITY_HARD_CAP) return
        const sx = x + (Math.random() - 0.5) * 8
        const sz = z + (Math.random() - 0.5) * 8
        const sy = category === 'passive' || baseY === surfaceY
          ? this.world.topSolidY(sx, sz) + 1
          : baseY
        const sizeScale = entry.kind === 'slime'
          ? ([0.5, 1, 2] as const)[Math.floor(Math.random() * 3)]
          : 1
        if (!this.canSpawnEntity(entry.kind, sx, sy, sz, {
          source: 'natural', player: context.player, worldSpawn: context.worldSpawn,
          darkness, sizeScale, slimeRoll: entry.kind === 'slime' ? Math.random() : undefined
        })) continue
        this.spawn(entry.kind, sx, sy, sz, { sizeScale, bypassMobCap: true })
      }
    }
  }

  /** Samples supported underground ledges but always leaves the surface as a final candidate. */
  private findNaturalHostileY(x: number, z: number, surfaceY: number): number | null {
    const maxY = Math.min(127, Math.max(1, surfaceY))
    for (let attempt = 0; attempt < 12; attempt++) {
      const y = attempt === 11 ? surfaceY : 1 + Math.floor(Math.random() * maxY)
      if (y < 1 || y >= 127 || !this.world.isSolid(x, y - 1, z)) continue
      if (isFluid(this.world.getBlock(x, y - 1, z)) || this.world.isSolid(x, y, z)) continue
      return y
    }
    return null
  }

  serialize(): SavedEntity[] {
    return [...this.entities.values()].filter(entity => entity.health > 0).map(entity => ({
      id: entity.id, kind: entity.kind, x: entity.x, y: entity.y, z: entity.z,
      vx: entity.vx, vy: entity.vy, vz: entity.vz, yaw: entity.yaw,
      health: entity.health, age: entity.age, breedCooldown: entity.breedCooldown,
      eggTimer: entity.eggTimer, attackCooldown: entity.attackCooldown,
      fuse: entity.fuse, angryTime: entity.angryTime, sizeScale: entity.sizeScale,
      persistent: entity.persistent, despawnAgeTicks: entity.despawnAgeTicks,
      sheared: entity.sheared, saddled: entity.saddled,
      woolTimer: entity.woolTimer, carriedBlock: entity.carriedBlock,
      ...(entity.kind === 'villager' ? {
        profession: entity.profession ?? 'farmer',
        homeX: entity.homeX, homeY: entity.homeY, homeZ: entity.homeZ,
        villageId: entity.villageId, homeDoorKey: entity.homeDoorKey
      } : {})
    }))
  }

  restore(saved: readonly SavedEntity[]): void {
    this.entities.clear()
    this.spatial.clear()
    this.passiveN = this.villagerN = this.hostileN = 0
    this.simulationTick = 0
    this.pathPlanN = 0
    this.riddenPigId = null
    for (const raw of saved.slice(0, ENTITY_HARD_CAP)) {
      const def = MOB_DEFINITIONS[raw.kind]
      if (!def || !raw.id || this.entities.has(raw.id)) continue
      const x = finite(raw.x), y = finite(raw.y, 64), z = finite(raw.z)
      if (!this.canSpawnEntity(raw.kind, x, y, z, {
        baby: raw.age < 0, sizeScale: raw.sizeScale, source: 'restore'
      })) continue
      const spawned = this.spawn(raw.kind, x, y, z, {
        baby: raw.age < 0,
        persistent: raw.persistent ?? raw.kind === 'villager',
        id: raw.id, bypassMobCap: true,
        sizeScale: raw.sizeScale, profession: raw.profession ?? undefined,
        homeX: raw.homeX, homeY: raw.homeY, homeZ: raw.homeZ,
        villageId: raw.villageId ?? undefined, homeDoorKey: raw.homeDoorKey ?? undefined
      })
      if (!spawned) continue
      const entity = this.entities.get(spawned.id)!
      entity.vx = clamp(finite(raw.vx), -20, 20); entity.vy = clamp(finite(raw.vy), -20, 20); entity.vz = clamp(finite(raw.vz), -20, 20)
      entity.yaw = finite(raw.yaw); entity.health = clamp(finite(raw.health, entity.maxHealth), 1, entity.maxHealth)
      entity.age = clamp(finite(raw.age), -1200, 0); entity.breedCooldown = clamp(finite(raw.breedCooldown), 0, 300)
      entity.eggTimer = raw.kind === 'chicken' ? clamp(finite(raw.eggTimer, 300), 1, 600) : 0
      entity.attackCooldown = clamp(finite(raw.attackCooldown ?? 0), 0, 10)
      entity.fuse = clamp(finite(raw.fuse ?? 0), 0, 1.5)
      entity.angryTime = clamp(finite(raw.angryTime ?? 0), 0, 30)
      entity.despawnAgeTicks = Math.floor(clamp(finite(raw.despawnAgeTicks ?? 0), 0, 10_000_000))
      entity.sheared = !!raw.sheared
      entity.saddled = raw.kind === 'pig' && !!raw.saddled
      entity.woolTimer = clamp(finite(raw.woolTimer ?? 0), 0, 300)
      entity.carriedBlock = Number.isInteger(raw.carriedBlock) ? raw.carriedBlock! : null
    }
  }

  dispose(): void {
    this.renderer?.dispose()
    this.renderer = null
    this.entities.clear()
    this.spatial.clear()
    this.passiveN = this.villagerN = this.hostileN = 0
    this.simulationTick = 0
    this.pathPlanN = 0
    this.riddenPigId = null
  }
}
