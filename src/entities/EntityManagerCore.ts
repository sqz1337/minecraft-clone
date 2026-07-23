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

export function installEntityManagerCore(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.snapshotById = function(this: EntityManager, id: string): EntitySnapshot | null {
    const entity = this.entities.get(id)
    return entity ? this.publicSnapshot(entity) : null
  }
  prototype.registerVillage = function(this: EntityManager, metadata: VillageMetadata): void {
    this.villageGraph.registerVillage(metadata)
  }
  prototype.countEntity = function(this: EntityManager, kind: MobKind, delta: number): void {
    if (isPeacefulKind(kind)) this.passiveN += delta
    else if (VILLAGER_KINDS.includes(kind as VillagerKind)) this.villagerN += delta
    else this.hostileN += delta
  }
  prototype.chunkKey = function(this: EntityManager, x: number, z: number): number {
    return Math.floor(x / CHUNK_SIZE) * 0x100000000 + Math.floor(z / CHUNK_SIZE)
  }
  prototype.index = function(this: EntityManager, entity: EntityState, oldKey?: number): void {
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
  prototype.spawn = function(this: EntityManager, kind: MobKind, x: number, y: number, z: number, options: {
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
      previousX: x, previousY: y, previousZ: z, previousYaw: 0,
      headingX: 0, headingZ: -1,
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
    entity.previousYaw = entity.yaw
    entity.headingX = -Math.sin(entity.yaw)
    entity.headingZ = -Math.cos(entity.yaw)
    entity.headYaw = entity.yaw
    this.entities.set(id, entity)
    this.countEntity(kind, 1)
    this.index(entity)
    return this.publicSnapshot(entity)
  }
  prototype.canSpawnEntity = function(this: EntityManager, kind: MobKind, x: number, y: number, z: number, options: SpawnValidationOptions = {}): boolean {
    const def = MOB_DEFINITIONS[kind]
    if (!def || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
    const sizeScale = kind === 'slime' ? normalizeSlimeScale(options.sizeScale) : 1
    const scale = (options.baby ? 0.58 : 1) * sizeScale
    const bounds = this.entityBounds(x, y, z, def.width, def.height, scale)
    if (bounds.minY < 1 || bounds.maxY >= 128) return false
    const aquatic = kind === 'squid'

    const floorY = Math.floor(y - 0.05)
    if (!aquatic) {
      for (let bx = bounds.minX; bx <= bounds.maxX; bx++) {
        for (let bz = bounds.minZ; bz <= bounds.maxZ; bz++) {
          if (!this.world.isSolid(bx, floorY, bz) || isFluid(this.world.getBlock(bx, floorY, bz))) return false
        }
      }
    }
    let waterCells = 0
    for (let bx = bounds.minX; bx <= bounds.maxX; bx++) {
      for (let by = bounds.minY; by <= bounds.maxY; by++) {
        for (let bz = bounds.minZ; bz <= bounds.maxZ; bz++) {
          const id = this.world.getBlock(bx, by, bz)
          if (this.world.isSolid(bx, by, bz) || (!aquatic && isFluid(id))) return false
          if (this.world.isWater(bx, by, bz)) waterCells++
        }
      }
    }
    if (aquatic && waterCells === 0) return false
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
    if (source === 'natural' || source === 'worldgen') {
      if (source === 'natural' && (!options.player || !options.worldSpawn)) return false
      const biome = this.world.biomeAt(x, z)
      const playerDistance = options.player
        ? Math.hypot(x - options.player.x, y - options.player.y, z - options.player.z)
        : Number.POSITIVE_INFINITY
      if (source === 'natural') {
        const spawnDistance = Math.hypot(
          x - options.worldSpawn!.x, y - options.worldSpawn!.y, z - options.worldSpawn!.z
        )
        if (playerDistance < 24 || spawnDistance < 24) return false
      }
      if (HOSTILE_KINDS.includes(kind as HostileKind)) {
        if (source === 'worldgen') return false
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
        if (kind === 'squid') {
          if (biome !== BIOME.OCEAN && biome !== BIOME.RIVER) return false
          return waterCells > 0
        }
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
  prototype.entityBounds = function(this: EntityManager, x: number, y: number, z: number, width: number, height: number, scale: number): {
    minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number
  } {
    const half = Math.max(0.01, width * scale * 0.5 - 0.02)
    return {
      minX: Math.floor(x - half), maxX: Math.floor(x + half),
      minY: Math.floor(y + 0.01), maxY: Math.floor(y + height * scale - 0.01),
      minZ: Math.floor(z - half), maxZ: Math.floor(z + half)
    }
  }
  prototype.remove = function(this: EntityManager, id: string): boolean {
    const entity = this.entities.get(id)
    if (!entity) return false
    const key = this.chunkKey(entity.x, entity.z)
    this.spatial.get(key)?.delete(id)
    this.entities.delete(id)
    if (this.riddenPigId === id) this.riddenPigId = null
    this.countEntity(entity.kind, -1)
    return true
  }
  prototype.releaseSilverfishFromBlock = function(this: EntityManager, x: number, y: number, z: number): EntitySnapshot | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z)
    const sx = bx + 0.5, sy = by + 0.01, sz = bz + 0.5
    if (!this.canSpawnEntity('silverfish', sx, sy, sz, { source: 'structure' })) return null
    return this.spawn('silverfish', sx, sy, sz, { bypassMobCap: true })
  }
  prototype.awakenNearbyInfestedStone = function(this: EntityManager, entity: EntityState): number {
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
  prototype.queryRadius = function(this: EntityManager, x: number, y: number, z: number, radius: number): EntitySnapshot[] {
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
  prototype.raycast = function(this: EntityManager, origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, excludeId?: string): EntityRayHit | null {
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
  prototype.damageProjectile = function(this: EntityManager, id: string, amount: number, sourceX: number, sourceZ: number, knockback = 4.2, looting = 0, attackerId?: string): boolean {
    const entity = this.entities.get(id)
    if (!entity || entity.health <= 0) return false
    if (entity.kind === 'enderman') {
      this.tryTeleport(entity, 64)
      return false
    }
    return this.damage(id, amount, sourceX, sourceZ, knockback, looting, attackerId)
  }
  prototype.damage = function(this: EntityManager, id: string, amount: number, sourceX: number, sourceZ: number, knockback = 4.2, looting = 0, attackerId?: string): boolean {
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
      this.emitEntitySound(entity, 'death')
    } else {
      this.emitEntitySound(entity, 'hurt')
      this.scheduleSilverfishCallForHelp(entity)
      if (entity.kind === 'enderman' && Math.random() < 0.5) this.tryTeleport(entity)
    }
    return true
  }
  prototype.ignite = function(this: EntityManager, id: string, seconds: number): void {
    const entity = this.entities.get(id)
    if (!entity || seconds <= 0) return
    entity.forcedBurnTime = Math.max(entity.forcedBurnTime, seconds)
  }
  prototype.shearSheep = function(this: EntityManager, id: string): number {
    const entity = this.entities.get(id)
    if (!entity || entity.kind !== 'sheep' || entity.age < 0 || entity.sheared) return 0
    entity.sheared = true
    // delay before the first grass-eating attempt; wool only regrows by eating (vanilla)
    entity.woolTimer = 5 + Math.random() * 10
    entity.persistent = true
    this.hooks.effect('shear', entity.x, entity.y + entity.height * 0.55, entity.z)
    return 1 + Math.floor(Math.random() * 3)
  }
  prototype.shear = function(this: EntityManager, id: string): number { return this.shearSheep(id) }
  prototype.interact = function(this: EntityManager, id: string, heldItemId: number | null): EntityInteractionResult | null {
    const entity = this.entities.get(id)
    if (!entity || entity.health <= 0 || entity.deathTime > 0) return null

    if (entity.kind === 'sheep' && heldItemId === I.SHEARS) {
      const wool = this.shearSheep(id)
      return wool > 0
        ? { type: 'shear', drops: [{ id: B.WOOL, count: wool }], damageTool: true }
        : null
    }

    if (entity.kind === 'mooshroom' && heldItemId === I.SHEARS && entity.age >= 0) {
      this.hooks.effect('shear', entity.x, entity.y + entity.height * 0.65, entity.z)
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
}
