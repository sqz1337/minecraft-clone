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

export function installEntityManagerLifecycle(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.dismountRider = function(this: EntityManager): EntityRiderPose | null {
    const pose = this.riderPose
    this.riddenPigId = null
    return pose
  }
  prototype.tryEatGrass = function(this: EntityManager, entity: EntityState): boolean {
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
  prototype.tryTeleport = function(this: EntityManager, entity: EntityState, attempts = 1, toward: AiTarget | null = null): boolean {
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
      this.hooks.effect('enderman_teleport', oldX, oldY + entity.height * 0.5, oldZ,
        entity.x, entity.y + entity.height * 0.5, entity.z)
      return true
    }
    entity.x = oldX
    entity.y = oldY
    entity.z = oldZ
    return false
  }
  prototype.feed = function(this: EntityManager, id: string, itemId: number): boolean {
    const entity = this.entities.get(id)
    if (!entity || !isPeacefulKind(entity.kind) || entity.age < 0 || entity.breedCooldown > 0 || entity.loveTime > 0) return false
    if (PASSIVE_DEFINITIONS[entity.kind].temptingItem !== itemId) return false
    entity.loveTime = 30
    entity.persistent = true
    this.hooks.effect('love', entity.x, entity.y + entity.height * 0.7, entity.z)
    return true
  }
  prototype.populateChunkAnimals = function(this: EntityManager, cx: number, cz: number, seed: number): number {
    if (this.passiveCount >= WORLDGEN_ANIMAL_CAP || this.entities.size >= ENTITY_HARD_CAP) return 0
    let state = (seed ^ Math.imul(cx, 0x1f123bb5) ^ Math.imul(cz, 0x6c8e9cf5) ^ 0x41c64e6d) | 0
    const random = (): number => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 0x100000000
    }
    // About eighteen packs in the initial radius-8 generation square.
    if (random() >= 1 / 16) return 0
    const centerX = cx * CHUNK_SIZE + 8.5
    const centerZ = cz * CHUNK_SIZE + 8.5
    const entries = spawnEntriesForBiome('passive', this.world.biomeAt(centerX, centerZ))
      .filter(entry => entry.kind !== 'squid')
    const entry = pickWeightedSpawnEntry(entries, random())
    if (!entry) return 0
    const desired = entry.minPack + Math.floor(random() * (entry.maxPack - entry.minPack + 1))
    const anchorX = cx * CHUNK_SIZE + 3.5 + Math.floor(random() * 10)
    const anchorZ = cz * CHUNK_SIZE + 3.5 + Math.floor(random() * 10)
    let spawned = 0
    for (let member = 0; member < desired && this.passiveCount < WORLDGEN_ANIMAL_CAP; member++) {
      const stableId = `world-animal-${cx}-${cz}-${member}`
      if (this.entities.has(stableId)) continue
      for (let attempt = 0; attempt < 8; attempt++) {
        const x = anchorX + Math.floor(random() * 7) - 3
        const z = anchorZ + Math.floor(random() * 7) - 3
        const y = this.world.topSolidY(x, z) + 1
        if (y <= 1 || !this.canSpawnEntity(entry.kind, x, y, z, { source: 'worldgen' })) continue
        const animal = this.spawn(entry.kind, x, y, z, {
          id: stableId,
          persistent: true,
          bypassMobCap: true
        })
        if (animal) spawned++
        break
      }
    }
    return spawned
  }
  prototype.tryCreateGolem = function(this: EntityManager, x: number, y: number, z: number): boolean {
    if (!this.world.setBlock || this.world.getBlock(x, y, z) !== B.PUMPKIN ||
      this.world.getBlock(x, y - 1, z) !== B.SNOW || this.world.getBlock(x, y - 2, z) !== B.SNOW) return false
    const spawnY = y - 2 + 0.01
    const clear = () => {
      this.world.setBlock!(x, y, z, B.AIR)
      this.world.setBlock!(x, y - 1, z, B.AIR)
      this.world.setBlock!(x, y - 2, z, B.AIR)
    }
    if (this.world.batchBlocks) this.world.batchBlocks(clear)
    else clear()
    const spawned = this.spawn('snow_golem', x + 0.5, spawnY, z + 0.5, {
      persistent: true, bypassMobCap: true
    })
    if (spawned) {
      this.hooks.effect('construct', x + 0.5, y - 0.7, z + 0.5)
      return true
    }
    const restore = () => {
      this.world.setBlock!(x, y - 2, z, B.SNOW)
      this.world.setBlock!(x, y - 1, z, B.SNOW)
      this.world.setBlock!(x, y, z, B.PUMPKIN)
    }
    if (this.world.batchBlocks) this.world.batchBlocks(restore)
    else restore()
    return false
  }
  prototype.finishDeath = function(this: EntityManager, entity: EntityState, looting = 0): void {
    const def = MOB_DEFINITIONS[entity.kind]
    // Logical sizes 4 -> 2 -> 1; only the smallest slime drops loot.
    if (entity.kind === 'slime' && (entity.sizeScale ?? 1) > 0.5) {
      const childScale = normalizeSlimeScale((entity.sizeScale ?? 1) * 0.5)
      this.hooks.effect('slime_split', entity.x, entity.y + entity.height * 0.5, entity.z)
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
    this.hooks.effect('death', entity.x, entity.y + entity.height * 0.5, entity.z)
    this.remove(entity.id)
  }
  prototype.update = function(this: EntityManager, dt: number, context: EntityUpdateContext): void {
    const safeDt = clamp(finite(dt), 0, 0.2)
    this.accumulator = Math.min(this.accumulator + safeDt, STEP * MAX_STEPS)
    let steps = 0
    while (this.accumulator >= STEP && steps++ < MAX_STEPS) {
      this.accumulator -= STEP
      this.tick(STEP, context)
    }
    // EntityState is a superset of EntitySnapshot: hand the live states to the
    // renderer directly instead of allocating a snapshot array every frame.
    this.renderer?.sync(this.entities.values(), this.accumulator / STEP, safeDt)
  }
  prototype.tick = function(this: EntityManager, dt: number, context: EntityUpdateContext): void {
    this.simulationTick++
    this.pathPlansThisTick = 0
    const pcx = Math.floor(context.player.x / CHUNK_SIZE), pcz = Math.floor(context.player.z / CHUNK_SIZE)
    for (const [event, remaining] of this.soundGates) {
      const next = remaining - dt
      if (next <= 0) this.soundGates.delete(event)
      else this.soundGates.set(event, next)
    }
    for (const entity of [...this.entities.values()]) {
      entity.previousX = entity.x
      entity.previousY = entity.y
      entity.previousZ = entity.z
      entity.previousYaw = entity.yaw
      const ecx = Math.floor(entity.x / CHUNK_SIZE), ecz = Math.floor(entity.z / CHUNK_SIZE)
      entity.active = Math.max(Math.abs(ecx - pcx), Math.abs(ecz - pcz)) <= ACTIVE_CHUNKS
      if (entity.active && entity.kind === 'enderman' && entity.deathTime <= 0) {
        this.hooks.effect('enderman_ambient', entity.x, entity.y + entity.height * 0.5, entity.z)
      }
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
      // Sounds attenuate over true 3D distance so a mob buried underground (same
      // x/z, far below) is faint rather than as loud as one standing next to you.
      const distance3d = Math.sqrt(playerDistanceSq3d)
      entity.ambientTime -= dt
      if (entity.ambientTime <= 0) {
        entity.ambientTime = 8 + Math.random() * 22
        if (distance3d < 24) this.emitCrowdSound(entity, 'ambient', distance3d)
      }
      if (entity.kind === 'chicken' && entity.age === 0) {
        entity.eggTimer -= dt
        if (entity.eggTimer <= 0) {
          this.hooks.drop(I.EGG, entity.x, entity.y + 0.25, entity.z, 1)
          if (distance3d < 24) this.emitCrowdSound(entity, 'egg', distance3d)
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
          this.emitEntitySound(entity, 'death')
          continue
        }
        this.emitEntitySound(entity, 'hurt')
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
            this.emitEntitySound(entity, 'death')
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
          if (distance3d < 16) this.emitCrowdSound(entity, 'step', distance3d)
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
  prototype.emitEntitySound = function(this: EntityManager, entity: EntityState, event: 'ambient' | 'hurt' | 'death' | 'step' | 'egg' | 'fuse', volume = 1): void {
    this.hooks.sound(
      entity.kind, event,
      entity.x, entity.y + entity.height * (entity.age < 0 ? 0.3 : 0.55), entity.z,
      volume
    )
  }
  prototype.emitCrowdSound = function(this: EntityManager, entity: EntityState, event: 'ambient' | 'step' | 'egg', distance = 0): void {
    const gateKey = `${event}:${Math.floor(entity.x / 8)},${Math.floor(entity.z / 8)}`
    if ((this.soundGates.get(gateKey) ?? 0) > 0) return
    // Hostiles keep directional HRTF attenuation. Peaceful mobs use a simple
    // non-directional distance fade, so a whole herd does not sound equally
    // loud while ordinary player and block sounds remain untouched.
    const hostile = HOSTILE_KINDS.includes(entity.kind as HostileKind)
    this.emitEntitySound(entity, event, hostile ? 1 : Math.max(0.12, 1 - distance / 24))
    this.soundGates.set(gateKey, event === 'ambient' ? 0.3 : event === 'egg' ? 0.18 : 0.1)
  }
}
