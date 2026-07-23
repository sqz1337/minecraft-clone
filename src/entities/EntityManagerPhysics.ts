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

export function installEntityManagerPhysics(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.scheduleSilverfishCallForHelp = function(this: EntityManager, entity: EntityState): void {
    if (entity.kind !== 'silverfish' || entity.health <= 0) return
    if (entity.silverfishCallForHelpAtTick <= this.simulationTick) {
      entity.silverfishCallForHelpAtTick = this.simulationTick + SILVERFISH_HELP_DELAY_TICKS
    }
    entity.silverfishHideAtTick = Math.max(
      entity.silverfishHideAtTick,
      entity.silverfishCallForHelpAtTick + SILVERFISH_HIDE_RETRY_TICKS
    )
  }
  prototype.updateSilverfishCallForHelp = function(this: EntityManager, entity: EntityState): void {
    if (entity.silverfishCallForHelpAtTick <= 0 ||
      this.simulationTick < entity.silverfishCallForHelpAtTick) return
    entity.silverfishCallForHelpAtTick = 0
    this.awakenNearbyInfestedStone(entity)
    entity.silverfishHideAtTick = this.simulationTick + SILVERFISH_HIDE_RETRY_TICKS
  }
  prototype.trySilverfishHide = function(this: EntityManager, entity: EntityState): boolean {
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
  prototype.updateEndermanBlock = function(this: EntityManager, entity: EntityState): void {
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
  prototype.hasLineOfSight = function(this: EntityManager, x: number, y: number, z: number, tx: number, ty: number, tz: number): boolean {
    const dx = tx - x, dy = ty - y, dz = tz - z
    const steps = Math.ceil(Math.hypot(dx, dy, dz) * 2)
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      if (this.world.isSolid(Math.floor(x + dx * t), Math.floor(y + dy * t), Math.floor(z + dz * t))) return false
    }
    return true
  }
  prototype.hasLineOfSightToBlock = function(this: EntityManager, x: number, y: number, z: number, targetX: number, targetY: number, targetZ: number): boolean {
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
  prototype.effectiveLight = function(this: EntityManager, x: number, y: number, z: number, darkness: number): number {
    if (this.world.getBlockLight && this.world.getSkyLight) {
      return Math.max(this.world.getBlockLight(x, y, z), this.world.getSkyLight(x, y, z) - darkness)
    }
    return Math.max(0, this.world.getLightLevel(x, y, z) - darkness)
  }
  prototype.isSunlit = function(this: EntityManager, entity: EntityState, context: EntityUpdateContext): boolean {
    const darkness = context.skyDarkness ?? 15
    if (darkness > 4) return false
    const sky = this.world.getSkyLight?.(Math.floor(entity.x), Math.floor(entity.y + entity.height), Math.floor(entity.z))
    return sky === undefined ? this.world.getLightLevel(entity.x, entity.y + entity.height, entity.z) >= 14 : sky >= 14
  }
  prototype.isExposedToSky = function(this: EntityManager, entity: EntityState): boolean {
    const x = Math.floor(entity.x), y = Math.floor(entity.y + entity.height), z = Math.floor(entity.z)
    const sky = this.world.getSkyLight?.(x, y, z)
    return sky === undefined ? this.world.topSolidY(x, z) < y : sky >= 15
  }
  prototype.touchesCactus = function(this: EntityManager, entity: EntityState): boolean {
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
  prototype.explode = function(this: EntityManager, x: number, y: number, z: number, power: number, player?: { x: number; y: number; z: number }): void {
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
  prototype.physics = function(this: EntityManager, entity: EntityState, dt: number): void {
    entity.inWater = this.touchesWater(entity)
    if (entity.kind === 'squid') {
      if (entity.inWater) {
        entity.vx *= 0.985; entity.vy *= 0.985; entity.vz *= 0.985
      } else {
        entity.vy -= GRAVITY * dt
      }
      entity.onGround = false
      entity.horizontalCollision = false
      this.moveAxis(entity, 'x', entity.vx * dt)
      this.moveAxis(entity, 'z', entity.vz * dt)
      this.moveAxis(entity, 'y', entity.vy * dt)
      return
    }
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
  prototype.touchesWater = function(this: EntityManager, entity: EntityState): boolean {
    const x = Math.floor(entity.x), z = Math.floor(entity.z)
    const bottom = Math.floor(entity.y + 0.05)
    const top = Math.floor(entity.y + entity.height * 0.9)
    for (let y = bottom; y <= top; y++) {
      if (this.world.isWater(x, y, z)) return true
    }
    return false
  }
  prototype.hasDryFooting = function(this: EntityManager, entity: EntityState, canOpenDoors = false): boolean {
    const profile = this.navigationProfile(entity, canOpenDoors, false)
    return canOccupyNode(this.world, nodeForPosition(entity.x, entity.y, entity.z, profile), profile) !== null
  }
  prototype.applyFallDamage = function(this: EntityManager, entity: EntityState): void {
    if (entity.kind === 'chicken' || entity.health <= 0) return
    const amount = Math.ceil((entity.fallPeakY ?? entity.y) - entity.y - 3.05)
    if (amount <= 0) return
    entity.health -= amount
    entity.hurtTime = 0.5
    if (entity.health <= 0) {
      entity.health = 0
      entity.deathTime = Number.EPSILON
      this.emitEntitySound(entity, 'death')
    } else {
      this.emitEntitySound(entity, 'hurt')
      this.scheduleSilverfishCallForHelp(entity)
    }
  }
  prototype.moveAxis = function(this: EntityManager, entity: EntityState, axis: 'x' | 'y' | 'z', amount: number, canStep = false): void {
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
  prototype.tryStepUp = function(this: EntityManager, entity: EntityState): boolean {
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
  prototype.resolveEmbedded = function(this: EntityManager, entity: EntityState): void {
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
  prototype.collidesWorld = function(this: EntityManager, entity: EntityState): boolean {
    const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
    const half = entity.width * scale * 0.5 - 0.02
    const bodyMinX = entity.x - half, bodyMaxX = entity.x + half
    const bodyMinY = entity.y + 0.01, bodyMaxY = entity.y + entity.height * scale - 0.01
    const bodyMinZ = entity.z - half, bodyMaxZ = entity.z + half
    const minX = Math.floor(bodyMinX), maxX = Math.floor(bodyMaxX)
    const minY = Math.floor(bodyMinY), maxY = Math.floor(bodyMaxY)
    const minZ = Math.floor(bodyMinZ), maxZ = Math.floor(bodyMaxZ)
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      const shape = blockCollisionBox(
        this.world.getBlock(x, y, z),
        this.world.getBlockFacing?.(x, y, z) ?? 4
      )
      if (!shape) continue
      if (bodyMaxX > x + shape.minX && bodyMinX < x + shape.maxX &&
        bodyMaxY > y + shape.minY && bodyMinY < y + shape.maxY &&
        bodyMaxZ > z + shape.minZ && bodyMinZ < z + shape.maxZ) return true
    }
    return false
  }
  prototype.separateEntities = function(this: EntityManager): void {
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
          let dx = target.x - entity.x, dz = target.z - entity.z
          let distance = Math.hypot(dx, dz)
          const min = (entity.width + target.width) * 0.42
          if (distance >= min) continue
          if (distance <= 0.001) {
            // A stable tie-break direction separates coincident spawns without
            // choosing a new random left/right side every simulation tick.
            const angle = ((entity.id < target.id ? 1 : -1) * 0.754877666) % (Math.PI * 2)
            dx = Math.cos(angle)
            dz = Math.sin(angle)
            distance = 1
          }
          const nx = dx / distance, nz = dz / distance
          const impulse = Math.min(1.2, Math.max(0, min - distance) * 6)
          // Local avoidance belongs in velocity space. Directly changing x/z
          // fought path steering on the next tick and produced the familiar
          // rapid left-right wobble in crowds and narrow doorways.
          entity.vx -= nx * impulse
          entity.vz -= nz * impulse
          target.vx += nx * impulse
          target.vz += nz * impulse
        }
      }
    }
  }
}
