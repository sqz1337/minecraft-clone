import * as THREE from 'three'
import { B, isLava } from '../world/Blocks'
import { BIOME } from '../world/WorldGen'
import { I } from '../world/ItemIds'
import { explosionDamage } from '../player/Combat'
import { EntityRenderer } from './EntityRenderer'
import {
  HOSTILE_KINDS, MOB_KINDS, PASSIVE_KINDS, SPECIAL_PASSIVE_KINDS, VILLAGER_KINDS,
  type EntitySnapshot, type HostileDefinition, type HostileKind, type MobDefinition,
  type MobKind, type PassiveDefinition, type PassiveKind, type PeacefulKind, type SavedEntity,
  type VillagerDefinition, type VillagerKind, type VillagerProfession
} from './EntityTypes'

const CHUNK_SIZE = 16
const GRAVITY = 25
const STEP = 1 / 20
const MAX_STEPS = 4
const ACTIVE_CHUNKS = 6
const DESPAWN_DISTANCE = 160
export const PASSIVE_MOB_CAP = 24
export const HOSTILE_MOB_CAP = 32
const ENTITY_HARD_CAP = 96
const BREED_SEARCH_RADIUS = 12
const BREED_DISTANCE = 4.5
const DEATH_ANIMATION_SECONDS = 0.7
const NATURAL_PASSIVE_LOCAL_CAP = 8

export interface EntityWorld {
  getBlock(x: number, y: number, z: number): number
  isSolid(x: number, y: number, z: number): boolean
  isWater(x: number, y: number, z: number): boolean
  topSolidY(x: number, z: number): number
  biomeAt(x: number, z: number): number
  getLightLevel(x: number, y: number, z: number): number
  getSkyLight?(x: number, y: number, z: number): number
  getBlockLight?(x: number, y: number, z: number): number
  setBlock?(x: number, y: number, z: number, id: number): void
  primeTnt?(x: number, y: number, z: number, fuseTicks?: number, scattered?: boolean): boolean
  batchBlocks?(action: () => void): void
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
  zombie: { kind: 'zombie', category: 'hostile', maxHealth: 20, width: 0.6, height: 1.8, speed: 2.3, temptingItem: null, attackDamage: 3, followRange: 22, drops: [{ id: I.ROTTEN_FLESH, min: 0, max: 2 }] },
  skeleton: { kind: 'skeleton', category: 'hostile', maxHealth: 20, width: 0.6, height: 1.8, speed: 2.15, temptingItem: null, attackDamage: 2, followRange: 24, drops: [{ id: I.BONE, min: 0, max: 2 }, { id: I.ARROW, min: 0, max: 2 }] },
  spider: { kind: 'spider', category: 'hostile', maxHealth: 16, width: 1.35, height: 0.9, speed: 3.35, temptingItem: null, attackDamage: 2, followRange: 20, drops: [{ id: I.STRING, min: 0, max: 2 }, { id: I.SPIDER_EYE, min: 1, max: 1, chance: 0.33 }] },
  creeper: { kind: 'creeper', category: 'hostile', maxHealth: 20, width: 0.6, height: 1.7, speed: 2.15, temptingItem: null, attackDamage: 0, followRange: 20, drops: [{ id: I.GUNPOWDER, min: 0, max: 2 }] },
  slime: { kind: 'slime', category: 'hostile', maxHealth: 16, width: 1.2, height: 1.2, speed: 2.2, temptingItem: null, attackDamage: 3, followRange: 16, drops: [{ id: I.SLIMEBALL, min: 0, max: 2 }] },
  enderman: { kind: 'enderman', category: 'hostile', maxHealth: 40, width: 0.6, height: 2.9, speed: 3.4, temptingItem: null, attackDamage: 7, followRange: 28, drops: [{ id: I.ENDER_PEARL, min: 0, max: 1 }] }
}

export const MOB_DEFINITIONS: Readonly<Record<MobKind, MobDefinition>> = {
  ...PASSIVE_DEFINITIONS, ...VILLAGER_DEFINITIONS, ...HOSTILE_DEFINITIONS
}

interface EntityState extends EntitySnapshot {
  goalX: number
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
}

export interface EntityUpdateContext {
  player: { x: number; y: number; z: number }
  heldItem: number | null
  look?: { x: number; y: number; z: number }
  skyDarkness?: number
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

// Scratch objects for the per-frame entity raycast — never allocate in there.
const scratchRay = new THREE.Ray()
const scratchBox = new THREE.Box3()
const scratchHit = new THREE.Vector3()

export function hostileSpawnAllowed(light: number, distance: number, hostileCount: number, biome: number): boolean {
  return light <= 7 && distance >= 24 && distance <= 128 && hostileCount < HOSTILE_MOB_CAP &&
    biome !== BIOME.OCEAN && biome !== BIOME.RIVER && biome !== BIOME.MUSHROOM
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

  constructor(private world: EntityWorld, scene?: THREE.Scene, hooks: Partial<EntityHooks> = {}) {
    this.renderer = scene ? new EntityRenderer(scene) : null
    this.hooks = { ...noopHooks, ...hooks }
  }

  get count(): number { return this.entities.size }
  get passiveCount(): number { return this.passiveN }
  get villagerCount(): number { return this.villagerN }
  get hostileCount(): number { return this.hostileN }
  get snapshots(): EntitySnapshot[] { return [...this.entities.values()].map(this.publicSnapshot) }

  snapshotById(id: string): EntitySnapshot | null {
    const entity = this.entities.get(id)
    return entity ? this.publicSnapshot(entity) : null
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
    sizeScale: e.sizeScale ?? 1, sheared: e.sheared ?? false,
    carriedBlock: e.carriedBlock ?? null,
    profession: e.profession ?? null, homeX: e.homeX, homeZ: e.homeZ,
    hurtTime: e.hurtTime, deathTime: e.deathTime
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
    /** 1 for normal mobs; 0.5 spawns a small slime. */
    sizeScale?: number
    profession?: VillagerProfession
    homeX?: number
    homeZ?: number
  } = {}): EntitySnapshot | null {
    if (!MOB_KINDS.includes(kind) || this.entities.size >= ENTITY_HARD_CAP) return null
    const passive = isPeacefulKind(kind)
    const villager = VILLAGER_KINDS.includes(kind as VillagerKind)
    if (!options.bypassMobCap && (passive ? this.passiveCount >= PASSIVE_MOB_CAP : !villager && this.hostileCount >= HOSTILE_MOB_CAP)) return null
    const def = MOB_DEFINITIONS[kind]
    const sizeScale = kind === 'slime' ? clamp(options.sizeScale ?? 1, 0.25, 1) : 1
    // vanilla small slime has 1 HP
    const maxHealth = kind === 'slime' && sizeScale < 1 ? 1 : def.maxHealth
    let id = options.id && !this.entities.has(options.id) ? options.id : ''
    while (!id || this.entities.has(id)) id = `${villager ? 'villager' : passive ? 'animal' : 'hostile'}-${this.nextId++}`
    const entity: EntityState = {
      id, kind, x, y, z, vx: 0, vy: 0, vz: 0, yaw: Math.random() * Math.PI * 2,
      health: maxHealth, maxHealth, width: def.width, height: def.height,
      age: options.baby ? -1200 : 0, breedCooldown: 0,
      eggTimer: kind === 'chicken' ? 300 + Math.random() * 300 : 0,
      active: true, inWater: false, onGround: false, loveTime: 0, panicTime: 0,
      burning: false, sizeScale, sheared: false, woolTimer: 0, carriedBlock: null,
      profession: villager ? options.profession ?? 'farmer' : null,
      homeX: finite(options.homeX ?? x, x), homeZ: finite(options.homeZ ?? z, z),
      goalX: x, goalZ: z, goalTime: 0, ambientTime: 5 + Math.random() * 15,
      stepTime: 0, hurtCooldown: 0, hurtTime: 0, deathTime: 0,
      persistent: options.persistent ?? false,
      attackCooldown: 0, fuse: 0, angryTime: 0, burnTime: 0, forcedBurnTime: 0,
      pendingLooting: 0, fallPeakY: y, revengeTargetId: null
    }
    this.entities.set(id, entity)
    this.countEntity(kind, 1)
    this.index(entity)
    return this.publicSnapshot(entity)
  }

  remove(id: string): boolean {
    const entity = this.entities.get(id)
    if (!entity) return false
    const key = this.chunkKey(entity.x, entity.z)
    this.spatial.get(key)?.delete(id)
    this.entities.delete(id)
    this.countEntity(entity.kind, -1)
    return true
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

  damage(id: string, amount: number, sourceX: number, sourceZ: number, knockback = 4.2, looting = 0, attackerId?: string): boolean {
    const entity = this.entities.get(id)
    if (!entity || entity.health <= 0 || entity.hurtCooldown > 0 || amount <= 0) return false
    entity.health -= amount
    entity.hurtCooldown = 0.45
    entity.hurtTime = 0.5
    entity.panicTime = 4
    if (entity.kind === 'enderman') entity.angryTime = 30
    // classic infighting: a mob hurt by another mob turns on its attacker
    if (attackerId && attackerId !== id && entity.kind !== 'creeper' &&
      HOSTILE_KINDS.includes(entity.kind as HostileKind)) {
      entity.revengeTargetId = attackerId
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

  /** Shears an adult unsheared sheep; returns the wool count or 0. */
  shear(id: string): number {
    const entity = this.entities.get(id)
    if (!entity || entity.kind !== 'sheep' || entity.age < 0 || entity.sheared) return 0
    entity.sheared = true
    // delay before the first grass-eating attempt; wool only regrows by eating (vanilla)
    entity.woolTimer = 5 + Math.random() * 10
    entity.persistent = true
    return 1 + Math.floor(Math.random() * 3)
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

  /** Endermen blink to a nearby free spot when hurt. */
  private tryTeleport(entity: EntityState): boolean {
    for (let attempt = 0; attempt < 12; attempt++) {
      const tx = entity.x + (Math.random() - 0.5) * 24
      const tz = entity.z + (Math.random() - 0.5) * 24
      const baseY = Math.floor(entity.y)
      for (let dy = 4; dy >= -8; dy--) {
        const y = baseY + dy
        if (y < 2) continue
        if (!this.world.isSolid(Math.floor(tx), y - 1, Math.floor(tz))) continue
        const oldX = entity.x, oldY = entity.y, oldZ = entity.z
        entity.x = tx
        entity.y = y + 0.01
        entity.z = tz
        if (!this.collidesWorld(entity) && !this.world.isWater(Math.floor(tx), y, Math.floor(tz))) {
          entity.vx = entity.vy = entity.vz = 0
          entity.fallPeakY = entity.y
          return true
        }
        entity.x = oldX; entity.y = oldY; entity.z = oldZ
        break
      }
    }
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
    // a big slime splits into small ones instead of dropping loot
    if (entity.kind === 'slime' && (entity.sizeScale ?? 1) >= 1) {
      this.remove(entity.id)
      const babies = 2 + Math.floor(Math.random() * 2)
      for (let i = 0; i < babies; i++) {
        const spawned = this.spawn('slime', entity.x + (Math.random() - 0.5) * 0.8, entity.y + 0.2,
          entity.z + (Math.random() - 0.5) * 0.8, { sizeScale: 0.5, bypassMobCap: true })
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
      if (!entity.persistent && playerDistance > DESPAWN_DISTANCE) { this.remove(entity.id); continue }
      if (!entity.active) continue
      this.resolveEmbedded(entity)
      entity.hurtTime = Math.max(0, entity.hurtTime - dt)
      if (entity.deathTime > 0) {
        const oldKey = this.chunkKey(entity.x, entity.z)
        entity.deathTime += dt
        entity.vx *= 0.9
        entity.vz *= 0.9
        this.physics(entity, dt)
        this.index(entity, oldKey)
        if (entity.deathTime >= DEATH_ANIMATION_SECONDS) this.finishDeath(entity, entity.pendingLooting)
        continue
      }
      entity.age = Math.min(0, entity.age + dt)
      entity.breedCooldown = Math.max(0, entity.breedCooldown - dt)
      entity.loveTime = Math.max(0, entity.loveTime - dt)
      entity.panicTime = Math.max(0, entity.panicTime - dt)
      entity.hurtCooldown = Math.max(0, entity.hurtCooldown - dt)
      entity.attackCooldown = Math.max(0, entity.attackCooldown - dt)
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
      if (entity.kind === 'sheep' && entity.sheared && entity.age === 0) {
        entity.woolTimer = Math.max(0, (entity.woolTimer ?? 0) - dt)
        if (entity.woolTimer <= 0) {
          entity.woolTimer = 4 + Math.random() * 6
          this.tryEatGrass(entity)
        }
      }
      const bodyBlock = this.world.getBlock(Math.floor(entity.x), Math.floor(entity.y + entity.height * 0.35), Math.floor(entity.z))
      const lavaBurn = isLava(bodyBlock)
      const fireBurn = bodyBlock === B.FIRE
      // vanilla: sun burning is suppressed while the mob stands in water
      const sunBurn = (entity.kind === 'zombie' || entity.kind === 'skeleton') && !entity.inWater && this.isSunlit(entity, context)
      const waterHurt = entity.kind === 'enderman' && entity.inWater
      if (entity.inWater) entity.forcedBurnTime = 0
      else entity.forcedBurnTime = Math.max(0, entity.forcedBurnTime - dt)
      if (lavaBurn || fireBurn || sunBurn || waterHurt || entity.forcedBurnTime > 0) {
        entity.burnTime += dt
        const interval = lavaBurn || waterHurt ? 0.5 : 1
        if (entity.burnTime >= interval) {
          entity.burnTime -= interval
          entity.health -= lavaBurn ? 4 : waterHurt ? 1 : 1
          entity.hurtTime = 0.5
          if (entity.health <= 0) {
            entity.health = 0
            entity.deathTime = Number.EPSILON
            this.hooks.sound(entity.kind, 'death')
            continue
          }
          if (waterHurt) this.tryTeleport(entity)
        }
      } else entity.burnTime = 0
      this.ai(entity, context, dt)
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
      this.hostileAi(entity, context, dt)
      return
    }
    if (entity.kind === 'villager') {
      this.villagerAi(entity, context, dt)
      return
    }
    const def = PASSIVE_DEFINITIONS[entity.kind as PeacefulKind]
    const dxp = context.player.x - entity.x, dzp = context.player.z - entity.z
    const playerDist = Math.hypot(dxp, dzp)
    let goalX = entity.goalX, goalZ = entity.goalZ, speed = def.speed
    const mate = entity.loveTime > 0 ? this.nearestMate(entity, BREED_SEARCH_RADIUS) : null
    if (entity.panicTime > 0) {
      goalX = entity.x - dxp * 2
      goalZ = entity.z - dzp * 2
      speed *= 1.55
    } else if (mate) {
      goalX = mate.x
      goalZ = mate.z
      speed *= 1.12
    } else if (context.heldItem === def.temptingItem && playerDist < 10 && playerDist > 1.8) {
      goalX = context.player.x
      goalZ = context.player.z
      speed *= 1.1
    } else {
      entity.goalTime -= dt
      if (entity.goalTime <= 0 || Math.hypot(goalX - entity.x, goalZ - entity.z) < 0.7) {
        entity.goalTime = 2 + Math.random() * 5
        const angle = Math.random() * Math.PI * 2
        const distance = 2 + Math.random() * 6
        entity.goalX = goalX = entity.x + Math.cos(angle) * distance
        entity.goalZ = goalZ = entity.z + Math.sin(angle) * distance
      }
    }
    const dx = goalX - entity.x, dz = goalZ - entity.z, len = Math.hypot(dx, dz)
    if (len > 0.3) {
      this.faceToward(entity, Math.atan2(-dx, -dz), dt)
      const targetX = dx / len * speed, targetZ = dz / len * speed
      entity.vx += (targetX - entity.vx) * clamp(dt * 4, 0, 1)
      entity.vz += (targetZ - entity.vz) * clamp(dt * 4, 0, 1)
      const aheadX = Math.floor(entity.x + dx / len * (entity.width * 0.6 + 0.3))
      const aheadZ = Math.floor(entity.z + dz / len * (entity.width * 0.6 + 0.3))
      const feetY = Math.floor(entity.y + 0.05)
      const blockedAhead = this.world.isSolid(aheadX, feetY, aheadZ) ||
        this.world.isSolid(aheadX, feetY + 1, aheadZ)
      const clearAbove = !this.world.isSolid(aheadX, feetY + 2, aheadZ)
      if (entity.onGround && blockedAhead && clearAbove) entity.vy = Math.max(entity.vy, 7.6)
    } else {
      entity.vx *= 0.82
      entity.vz *= 0.82
    }
  }

  /** Villagers wander around their generated home and flee the player after being hurt. */
  private villagerAi(entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = VILLAGER_DEFINITIONS.villager
    const dxp = context.player.x - entity.x, dzp = context.player.z - entity.z
    let goalX = entity.goalX, goalZ = entity.goalZ, speed = def.speed
    if (entity.panicTime > 0) {
      goalX = entity.x - dxp * 1.5
      goalZ = entity.z - dzp * 1.5
      speed *= 1.45
    } else {
      entity.goalTime -= dt
      const outsideHome = Math.hypot(entity.x - entity.homeX, entity.z - entity.homeZ) > 11
      if (outsideHome || entity.goalTime <= 0 || Math.hypot(goalX - entity.x, goalZ - entity.z) < 0.7) {
        entity.goalTime = 2 + Math.random() * 5
        const angle = Math.random() * Math.PI * 2
        const distance = outsideHome ? 0 : 2 + Math.random() * 8
        entity.goalX = goalX = outsideHome ? entity.homeX : entity.homeX + Math.cos(angle) * distance
        entity.goalZ = goalZ = outsideHome ? entity.homeZ : entity.homeZ + Math.sin(angle) * distance
      }
    }
    this.steer(entity, goalX, goalZ, speed, dt)
  }

  private hostileAi(entity: EntityState, context: EntityUpdateContext, dt: number): void {
    const def = HOSTILE_DEFINITIONS[entity.kind as HostileKind]
    if (this.pursueRevengeTarget(entity, def, dt)) return
    const dx = context.player.x - entity.x
    const dz = context.player.z - entity.z
    const dy = context.player.y + 0.9 - (entity.y + entity.height * 0.5)
    const distance = Math.hypot(dx, dy, dz)
    let aggressive = distance <= def.followRange
    if (entity.kind === 'enderman') {
      if (context.look && distance < def.followRange) {
        const inv = 1 / Math.max(0.001, distance)
        if (context.look.x * -dx * inv + context.look.y * -dy * inv + context.look.z * -dz * inv > 0.985) {
          entity.angryTime = 30
        }
      }
      aggressive = entity.angryTime > 0 && distance <= def.followRange
    }
    if (entity.kind === 'spider' && (context.skyDarkness ?? 15) < 5 && entity.panicTime <= 0) aggressive = false
    if (entity.kind === 'enderman' && !aggressive) this.updateEndermanBlock(entity)

    if (!aggressive) {
      entity.goalTime -= dt
      if (entity.goalTime <= 0 || Math.hypot(entity.goalX - entity.x, entity.goalZ - entity.z) < 0.7) {
        const angle = Math.random() * Math.PI * 2
        entity.goalTime = 2 + Math.random() * 4
        entity.goalX = entity.x + Math.cos(angle) * (2 + Math.random() * 5)
        entity.goalZ = entity.z + Math.sin(angle) * (2 + Math.random() * 5)
      }
      this.steer(entity, entity.goalX, entity.goalZ, def.speed * 0.65, dt)
      return
    }

    if (entity.kind === 'creeper') {
      if (distance < 3.2 && this.hasLineOfSight(entity.x, entity.y + 1, entity.z, context.player.x, context.player.y + 1, context.player.z)) {
        if (entity.fuse === 0) this.hooks.sound('creeper', 'fuse')
        entity.fuse += dt
        entity.vx *= 0.72; entity.vz *= 0.72
        if (entity.fuse >= 1.5) {
          this.remove(entity.id)
          this.explode(entity.x, entity.y + 0.8, entity.z, 3, context.player)
        }
        return
      }
      entity.fuse = Math.max(0, entity.fuse - dt * 1.8)
    }

    if (entity.kind === 'skeleton') {
      if (distance < 15 && distance > 4 && this.hasLineOfSight(entity.x, entity.y + 1.45, entity.z, context.player.x, context.player.y + 1.25, context.player.z)) {
        if (entity.attackCooldown <= 0) {
          entity.attackCooldown = 1.55 + Math.random() * 0.45
          this.hooks.shootProjectile(
            entity.x, entity.y + 1.45, entity.z,
            context.player.x, context.player.y + 1.15, context.player.z, 3, entity.id
          )
        }
        const strafe = Math.atan2(dz, dx) + Math.PI / 2
        this.steer(entity, entity.x + Math.cos(strafe) * 2, entity.z + Math.sin(strafe) * 2, def.speed * 0.7, dt)
        this.faceToward(entity, Math.atan2(-dx, -dz), dt)
        return
      }
    }

    this.steer(entity, context.player.x, context.player.z, def.speed, dt)
    const meleeRange = Math.max(1.25, entity.width * (entity.sizeScale ?? 1) * 0.5 + 0.9)
    // vanilla small slimes are harmless
    const attackDamage = entity.kind === 'slime' && (entity.sizeScale ?? 1) < 1 ? 0 : def.attackDamage
    if (distance < meleeRange && entity.attackCooldown <= 0 && attackDamage > 0) {
      if (this.hooks.damagePlayer(attackDamage, entity.x, entity.z, entity.kind === 'enderman' ? 5 : 3.2)) {
        entity.attackCooldown = entity.kind === 'spider' ? 0.8 : 1
      }
    }
  }

  /**
   * Classic skeleton-vs-zombie style infighting: a mob hurt by another mob
   * chases and melees the attacker until one of them dies or gets out of range.
   */
  private pursueRevengeTarget(entity: EntityState, def: HostileDefinition, dt: number): boolean {
    if (!entity.revengeTargetId) return false
    const target = this.entities.get(entity.revengeTargetId)
    if (!target || target.health <= 0) {
      entity.revengeTargetId = null
      return false
    }
    const dx = target.x - entity.x, dz = target.z - entity.z
    const dy = target.y + target.height * 0.5 - (entity.y + entity.height * 0.5)
    const distance = Math.hypot(dx, dy, dz)
    if (distance > def.followRange) {
      entity.revengeTargetId = null
      return false
    }
    this.steer(entity, target.x, target.z, def.speed, dt)
    const meleeRange = Math.max(1.25, (entity.width * (entity.sizeScale ?? 1) + target.width) * 0.5 + 0.9)
    const attackDamage = entity.kind === 'slime' && (entity.sizeScale ?? 1) < 1 ? 0 : def.attackDamage
    if (distance < meleeRange && entity.attackCooldown <= 0 && attackDamage > 0) {
      if (this.damage(target.id, attackDamage, entity.x, entity.z, 3.2, 0, entity.id)) entity.attackCooldown = 1
    }
    return true
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
    const aheadX = Math.floor(entity.x + dx / len * (entity.width * 0.6 + 0.35))
    const aheadZ = Math.floor(entity.z + dz / len * (entity.width * 0.6 + 0.35))
    const feetY = Math.floor(entity.y + 0.05)
    const blocked = this.world.isSolid(aheadX, feetY, aheadZ) || this.world.isSolid(aheadX, feetY + 1, aheadZ)
    if (blocked && entity.kind === 'spider') entity.vy = Math.max(entity.vy, 4.8)
    else if (entity.onGround && blocked && !this.world.isSolid(aheadX, feetY + 2, aheadZ)) entity.vy = Math.max(entity.vy, 7.6)
  }

  /** Sparse classic-style enderman block interaction; deliberately limited to natural terrain blocks. */
  private updateEndermanBlock(entity: EntityState): void {
    if (!this.world.setBlock || Math.random() > 0.0025) return
    const x = Math.floor(entity.x + (Math.random() - 0.5) * 5)
    const z = Math.floor(entity.z + (Math.random() - 0.5) * 5)
    const y = this.world.topSolidY(x, z)
    if (y < 1) return
    if (entity.carriedBlock === null) {
      const id = this.world.getBlock(x, y, z)
      if (id !== B.GRASS && id !== B.DIRT && id !== B.SAND && id !== B.GRAVEL) return
      this.world.setBlock(x, y, z, B.AIR)
      entity.carriedBlock = id
      entity.persistent = true
    } else if (this.world.getBlock(x, y + 1, z) === B.AIR) {
      this.world.setBlock(x, y + 1, z, entity.carriedBlock)
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
    // chickens flutter down slowly like vanilla — that is also why they take no fall damage
    if (entity.kind === 'chicken' && !entity.inWater && entity.vy < -3) entity.vy = -3
    const wasGrounded = entity.onGround
    entity.onGround = false
    this.moveAxis(entity, 'x', entity.vx * dt, wasGrounded)
    this.moveAxis(entity, 'z', entity.vz * dt, wasGrounded)
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
          return
        }
      }
    }
    entity.x = startX
    entity.z = startZ
    entity.y = Math.max(startY, this.world.topSolidY(Math.floor(startX), Math.floor(startZ)) + 1.001)
    entity.vx = entity.vy = entity.vz = 0
  }

  private collidesWorld(entity: EntityState): boolean {
    const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
    const half = entity.width * scale * 0.5 - 0.02
    const minX = Math.floor(entity.x - half), maxX = Math.floor(entity.x + half)
    const minY = Math.floor(entity.y + 0.01), maxY = Math.floor(entity.y + entity.height * scale - 0.01)
    const minZ = Math.floor(entity.z - half), maxZ = Math.floor(entity.z + half)
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      if (this.world.isSolid(x, y, z)) return true
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
      const partner = [...this.entities.values()].find(other => other.id !== entity.id && other.kind === entity.kind &&
        other.loveTime > 0 && other.age === 0 && other.breedCooldown <= 0 &&
        Math.hypot(other.x - entity.x, other.z - entity.z) < BREED_DISTANCE)
      if (!partner || this.entities.size >= ENTITY_HARD_CAP) continue
      entity.loveTime = partner.loveTime = 0
      entity.breedCooldown = partner.breedCooldown = 300
      entity.persistent = partner.persistent = true
      this.spawn(entity.kind, (entity.x + partner.x) * 0.5, Math.max(entity.y, partner.y), (entity.z + partner.z) * 0.5, {
        baby: true, persistent: true, bypassMobCap: true
      })
    }
  }

  private nearestMate(entity: EntityState, radius: number): EntityState | null {
    if (!isPeacefulKind(entity.kind)) return null
    let nearest: EntityState | null = null
    let best = radius
    for (const candidate of this.entities.values()) {
      if (candidate.id === entity.id || candidate.kind !== entity.kind || candidate.loveTime <= 0 ||
        candidate.age < 0 || candidate.breedCooldown > 0) continue
      const distance = Math.hypot(candidate.x - entity.x, candidate.z - entity.z)
      if (distance >= best) continue
      best = distance
      nearest = candidate
    }
    return nearest
  }

  private tryNaturalSpawn(context: EntityUpdateContext): void {
    const player = context.player
    const darkness = context.skyDarkness ?? 0
    const canSpawnHostile = this.hostileCount < HOSTILE_MOB_CAP
    if (!canSpawnHostile && this.passiveCount >= PASSIVE_MOB_CAP) return
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * Math.PI * 2
      const distance = 28 + Math.random() * 48
      const x = Math.floor(player.x + Math.cos(angle) * distance) + 0.5
      const z = Math.floor(player.z + Math.sin(angle) * distance) + 0.5
      const surfaceY = this.world.topSolidY(x, z) + 1
      const biome = this.world.biomeAt(x, z)
      if (canSpawnHostile) {
        let y = surfaceY
        // Daylight still permits cave spawns: sample real air pockets below the surface.
        if (surfaceY > 10 && (darkness < 7 || Math.random() < 0.65)) {
          for (let caveAttempt = 0; caveAttempt < 10; caveAttempt++) {
            const candidate = 4 + Math.floor(Math.random() * Math.max(1, surfaceY - 8))
            if (this.world.isSolid(x, candidate - 1, z) &&
              !this.world.isSolid(x, candidate, z) && !this.world.isSolid(x, candidate + 1, z)) {
              y = candidate
              break
            }
          }
        }
        if (hostileSpawnAllowed(this.effectiveLight(x, y, z, darkness), distance, this.hostileCount, biome)) {
        const eligible = biome === BIOME.SNOW
          ? HOSTILE_KINDS.filter(kind => kind !== 'slime' && kind !== 'spider')
          : biome === BIOME.FOREST
            ? HOSTILE_KINDS.filter(kind => kind !== 'slime')
            : HOSTILE_KINDS
        const kind = eligible[Math.floor(Math.random() * eligible.length)]
        const group = kind === 'zombie' || kind === 'skeleton' ? 1 + Math.floor(Math.random() * 3) : 1
        for (let i = 0; i < group && this.hostileCount < HOSTILE_MOB_CAP; i++) {
          const sx = x + (Math.random() - 0.5) * 3, sz = z + (Math.random() - 0.5) * 3
          const sy = y === surfaceY ? this.world.topSolidY(sx, sz) + 1 : y
          if (!this.world.isSolid(sx, sy, sz) && !this.world.isSolid(sx, sy + 1, sz)) this.spawn(kind, sx, sy, sz)
        }
        return
        }
      }
      const y = surfaceY
      const surface = this.world.getBlock(x, y - 1, z)
      if (y <= 1 || (surface !== B.GRASS && surface !== B.SNOW && surface !== B.SAND && surface !== B.MYCELIUM)) continue
      if (this.passiveCount >= PASSIVE_MOB_CAP) continue
      if (this.world.getLightLevel(x, y, z) < 9) continue
      if (biome !== BIOME.PLAINS && biome !== BIOME.FOREST && biome !== BIOME.SNOW &&
        biome !== BIOME.TAIGA && biome !== BIOME.SWAMP && biome !== BIOME.JUNGLE && biome !== BIOME.MUSHROOM) continue
      const localPassives = this.queryRadius(x, y, z, 24)
        .filter(entity => isPeacefulKind(entity.kind)).length
      if (localPassives >= NATURAL_PASSIVE_LOCAL_CAP) continue
      const kind: PeacefulKind = biome === BIOME.MUSHROOM ? 'mooshroom'
        : biome === BIOME.SNOW || biome === BIOME.TAIGA ? 'sheep'
          : PASSIVE_KINDS[Math.floor(Math.random() * PASSIVE_KINDS.length)]
      const group = Math.min(2 + Math.floor(Math.random() * 2), NATURAL_PASSIVE_LOCAL_CAP - localPassives)
      for (let i = 0; i < group && this.passiveCount < PASSIVE_MOB_CAP; i++) {
        const sx = x + (Math.random() - 0.5) * 4, sz = z + (Math.random() - 0.5) * 4
        const sy = this.world.topSolidY(sx, sz) + 1
        this.spawn(kind, sx, sy, sz)
      }
      return
    }
  }

  serialize(): SavedEntity[] {
    return [...this.entities.values()].filter(entity => entity.health > 0).map(entity => ({
      id: entity.id, kind: entity.kind, x: entity.x, y: entity.y, z: entity.z,
      vx: entity.vx, vy: entity.vy, vz: entity.vz, yaw: entity.yaw,
      health: entity.health, age: entity.age, breedCooldown: entity.breedCooldown,
      eggTimer: entity.eggTimer, attackCooldown: entity.attackCooldown,
      fuse: entity.fuse, angryTime: entity.angryTime, sizeScale: entity.sizeScale,
      sheared: entity.sheared, woolTimer: entity.woolTimer, carriedBlock: entity.carriedBlock,
      ...(entity.kind === 'villager' ? { profession: entity.profession ?? 'farmer', homeX: entity.homeX, homeZ: entity.homeZ } : {})
    }))
  }

  restore(saved: readonly SavedEntity[]): void {
    this.entities.clear()
    this.spatial.clear()
    this.passiveN = this.villagerN = this.hostileN = 0
    for (const raw of saved.slice(0, ENTITY_HARD_CAP)) {
      const def = MOB_DEFINITIONS[raw.kind]
      if (!def || !raw.id || this.entities.has(raw.id)) continue
      const spawned = this.spawn(raw.kind, finite(raw.x), finite(raw.y, 64), finite(raw.z), {
        baby: raw.age < 0, persistent: true, id: raw.id, bypassMobCap: true,
        sizeScale: raw.sizeScale, profession: raw.profession ?? undefined,
        homeX: raw.homeX, homeZ: raw.homeZ
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
      entity.sheared = !!raw.sheared
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
  }
}
