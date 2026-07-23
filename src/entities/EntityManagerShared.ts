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

export const CHUNK_SIZE = 16
export const GRAVITY = 25
export const STEP = 1 / 20
export const MAX_STEPS = 4
export const ELIGIBLE_CHUNK_RADIUS = 8
export const ELIGIBLE_CHUNK_COUNT = (ELIGIBLE_CHUNK_RADIUS * 2 + 1) ** 2
export const SPAWNABLE_CHUNK_COUNT = (ELIGIBLE_CHUNK_RADIUS * 2 - 1) ** 2
export const ACTIVE_CHUNKS = ELIGIBLE_CHUNK_RADIUS
export function scaledMobCap(base: number, eligibleChunkCount: number): number {
  return Math.max(0, Math.floor(base * Math.max(0, Math.floor(eligibleChunkCount)) / 256))
}
export const PASSIVE_MOB_CAP = scaledMobCap(15, ELIGIBLE_CHUNK_COUNT)
export const HOSTILE_MOB_CAP = scaledMobCap(70, ELIGIBLE_CHUNK_COUNT)
export const ENTITY_HARD_CAP = 256
export const BREED_SEARCH_RADIUS = 12
export const BREED_DISTANCE = 4.5
export const DEATH_ANIMATION_SECONDS = 0.7
export const NATURAL_PASSIVE_LOCAL_CAP = 8
export const WORLDGEN_ANIMAL_CAP = 64
export const PLAYER_TARGET_ID = 'player'
export const TARGET_MEMORY_TICKS = 60
export const TARGET_SCAN_MIN_TICKS = 10
export const TARGET_SCAN_JITTER_TICKS = 10
export const ENDERMAN_STARE_TICKS = 5
export const SILVERFISH_HELP_DELAY_TICKS = 20
export const SILVERFISH_HELP_HORIZONTAL_RADIUS = 10
export const SILVERFISH_HELP_VERTICAL_RADIUS = 5
export const SILVERFISH_HIDE_RETRY_TICKS = 40
export const MATE_COURTSHIP_TICKS = 60
export const TEMPT_COOLDOWN_TICKS = 100
export const HARD_DESPAWN_DISTANCE_SQ = 128 ** 2
export const RANDOM_DESPAWN_DISTANCE_SQ = 32 ** 2
export const RANDOM_DESPAWN_AGE_TICKS = 600
export const RANDOM_DESPAWN_CHANCE = 800
export const ENDERMAN_CARRYABLE = new Set<number>([
  B.GRASS, B.DIRT, B.SAND, B.GRAVEL, B.FLOWER_Y, B.FLOWER_R,
  B.MUSHROOM_BROWN, B.MUSHROOM_RED, B.TNT, B.CACTUS, B.CLAY, B.PUMPKIN, B.MYCELIUM
])
export const SILVERFISH_HIDE_DIRECTIONS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]
] as const)
export interface EligibleChunk {
  cx: number
  cz: number
  /** Vanilla counts the outer ring toward caps but does not spawn inside it. */
  border: boolean
}
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
  getBlockFacing?(x: number, y: number, z: number): HorizontalFace
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
  sound: (
    kind: MobKind,
    event: 'ambient' | 'hurt' | 'death' | 'step' | 'egg' | 'fuse',
    x: number, y: number, z: number,
    volume?: number
  ) => void
  damagePlayer: (amount: number, sourceX: number, sourceZ: number, knockback: number) => boolean
  shootProjectile: (x: number, y: number, z: number, tx: number, ty: number, tz: number, damage: number, shooterId?: string) => void
  explosion: (x: number, y: number, z: number, radius: number) => void
  blockExploded: (x: number, y: number, z: number, id: number) => void
  experience: (x: number, y: number, z: number, amount: number) => void
  effect: (
    event: 'enderman_ambient' | 'enderman_teleport' | 'love' | 'death' | 'slime_split' | 'shear' | 'construct' | 'golem_attack',
    x: number, y: number, z: number,
    targetX?: number, targetY?: number, targetZ?: number
  ) => void
}
export const PASSIVE_DEFINITIONS: Readonly<Record<PeacefulKind, PassiveDefinition>> = {
  pig: { kind: 'pig', category: 'passive', maxHealth: 10, width: 0.9, height: 0.9, speed: 2.15, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_PORKCHOP, min: 0, max: 2 }] },
  cow: { kind: 'cow', category: 'passive', maxHealth: 10, width: 0.9, height: 1.4, speed: 2, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_BEEF, min: 1, max: 3 }, { id: I.LEATHER, min: 0, max: 2 }] },
  sheep: { kind: 'sheep', category: 'passive', maxHealth: 8, width: 0.9, height: 1.3, speed: 2, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: B.WOOL, min: 1, max: 1 }, { id: I.RAW_MUTTON, min: 1, max: 2 }] },
  chicken: { kind: 'chicken', category: 'passive', maxHealth: 4, width: 0.55, height: 0.95, speed: 1.9, temptingItem: I.SEEDS, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_CHICKEN, min: 1, max: 1 }, { id: I.FEATHER, min: 0, max: 2 }] },
  mooshroom: { kind: 'mooshroom', category: 'passive', maxHealth: 10, width: 0.9, height: 1.4, speed: 2, temptingItem: I.WHEAT, attackDamage: 0, followRange: 10, drops: [{ id: I.RAW_BEEF, min: 1, max: 3 }, { id: I.LEATHER, min: 0, max: 2 }] },
  wolf: { kind: 'wolf', category: 'passive', maxHealth: 8, width: 0.6, height: 0.8, speed: 3, temptingItem: I.BONE, attackDamage: 0, followRange: 16, drops: [] },
  ocelot: { kind: 'ocelot', category: 'passive', maxHealth: 10, width: 0.6, height: 0.7, speed: 3.2, temptingItem: I.RAW_FISH, attackDamage: 0, followRange: 16, drops: [] },
  cat: { kind: 'cat', category: 'passive', maxHealth: 10, width: 0.6, height: 0.7, speed: 3.2, temptingItem: I.RAW_FISH, attackDamage: 0, followRange: 16, drops: [] },
  squid: { kind: 'squid', category: 'passive', maxHealth: 10, width: 0.95, height: 0.95, speed: 1.8, temptingItem: null, attackDamage: 0, followRange: 12, drops: [] },
  snow_golem: { kind: 'snow_golem', category: 'passive', maxHealth: 4, width: 0.7, height: 1.9, speed: 1.9, temptingItem: null, attackDamage: 0, followRange: 16, drops: [] },
  iron_golem: { kind: 'iron_golem', category: 'passive', maxHealth: 100, width: 1.4, height: 2.7, speed: 1.5, temptingItem: null, attackDamage: 0, followRange: 16, drops: [{ id: I.IRON_INGOT, min: 3, max: 5 }] }
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
export const HOSTILE_SPAWN_ENTRIES: readonly SpawnEntry[] = [
  { kind: 'spider', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'zombie', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'skeleton', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'creeper', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'slime', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'enderman', weight: 1, minPack: 1, maxPack: 4 }
]
export const PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = [
  { kind: 'sheep', weight: 12, minPack: 4, maxPack: 4 },
  { kind: 'pig', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'chicken', weight: 10, minPack: 4, maxPack: 4 },
  { kind: 'cow', weight: 8, minPack: 4, maxPack: 4 }
]
export const JUNGLE_PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = PASSIVE_SPAWN_ENTRIES.map(entry =>
  entry.kind === 'chicken' ? { ...entry, weight: 20 } : entry).concat([
    { kind: 'ocelot', weight: 2, minPack: 1, maxPack: 2 }
  ])
export const FOREST_PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = PASSIVE_SPAWN_ENTRIES.concat([
  { kind: 'wolf', weight: 5, minPack: 2, maxPack: 4 }
])
export const WATER_PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = [
  { kind: 'squid', weight: 10, minPack: 1, maxPack: 4 }
]
export const MUSHROOM_PASSIVE_SPAWN_ENTRIES: readonly SpawnEntry[] = [
  { kind: 'mooshroom', weight: 8, minPack: 4, maxPack: 8 }
]
export function spawnEntriesForBiome(
  category: 'hostile' | 'passive', biome: number
): readonly SpawnEntry[] {
  if (category === 'hostile') return biome === BIOME.MUSHROOM ? [] : HOSTILE_SPAWN_ENTRIES
  if (biome === BIOME.MUSHROOM) return MUSHROOM_PASSIVE_SPAWN_ENTRIES
  if (biome === BIOME.OCEAN || biome === BIOME.RIVER) return WATER_PASSIVE_SPAWN_ENTRIES
  if (biome === BIOME.BEACH || biome === BIOME.DESERT) return []
  if (biome === BIOME.JUNGLE) return JUNGLE_PASSIVE_SPAWN_ENTRIES
  if (biome === BIOME.FOREST || biome === BIOME.TAIGA) return FOREST_PASSIVE_SPAWN_ENTRIES
  return PASSIVE_SPAWN_ENTRIES
}
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
export interface EntityState extends EntitySnapshot {
  /** Previous fixed-tick transform used for frame interpolation. */
  previousX: number
  previousY: number
  previousZ: number
  previousYaw: number
  /** Low-pass horizontal heading; unlike a raw waypoint vector it cannot flip every tick. */
  headingX: number
  headingZ: number
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
export interface AiTarget {
  id: string
  kind: 'player' | MobKind
  x: number
  y: number
  z: number
  width: number
  height: number
  alive: boolean
}
export interface TrackedTarget {
  target: AiTarget
  visible: boolean
  distance: number
  goal: { x: number; y: number; z: number }
}
export interface NavigationIntent {
  kind: 'move' | 'hold' | 'leap'
  x: number
  y: number
  z: number
  speed: number
  doorMode?: 'none' | 'open' | 'break'
  face?: { x: number; z: number }
}
export type PassiveTaskKind = 'swim' | 'panic' | 'mate' | 'tempt' | 'follow_parent' |
  'eat_grass' | 'wander' | 'watch' | 'idle'
export interface SpawnValidationOptions {
  baby?: boolean
  sizeScale?: number
  /** Programmatic births/splits may overlap their parents while still requiring safe terrain. */
  allowEntityOverlap?: boolean
  ignoreEntityIds?: readonly string[]
  source?: 'generic' | 'natural' | 'worldgen' | 'spawner' | 'restore' | 'structure'
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
export const noopHooks: EntityHooks = {
  drop: () => {}, sound: () => {}, damagePlayer: () => false,
  shootProjectile: () => {}, explosion: () => {}, blockExploded: () => {}, experience: () => {}, effect: () => {}
}
export function finite(value: number, fallback = 0): number { return Number.isFinite(value) ? value : fallback }
export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
export function silverfishHideDelay(id: string, x: number, y: number, z: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193)
  hash ^= Math.imul(Math.floor(x), 0x1f123bb5) ^ Math.imul(Math.floor(y), 0x6c8e9cf5) ^
    Math.imul(Math.floor(z), 0x5f356495)
  return SILVERFISH_HIDE_RETRY_TICKS + ((hash >>> 0) % SILVERFISH_HIDE_RETRY_TICKS)
}
export function normalizeSlimeScale(value: number | undefined): 0.5 | 1 | 2 {
  const scale = finite(value ?? 1, 1)
  return scale < 0.75 ? 0.5 : scale < 1.5 ? 1 : 2
}
export const scratchRay = new THREE.Ray()
export const scratchBox = new THREE.Box3()
export const scratchHit = new THREE.Vector3()
export function hostileSpawnAllowed(light: number, distance: number, hostileCount: number, biome: number): boolean {
  return light <= 7 && distance >= 24 && hostileCount < HOSTILE_MOB_CAP && biome !== BIOME.MUSHROOM
}
export function isPeacefulKind(kind: MobKind): kind is PeacefulKind {
  return PASSIVE_KINDS.includes(kind as PassiveKind) || SPECIAL_PASSIVE_KINDS.includes(kind as never)
}
