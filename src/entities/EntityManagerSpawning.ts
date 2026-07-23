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

export function installEntityManagerSpawning(EntityManagerClass: EntityManagerConstructor): void {
  const prototype = EntityManagerClass.prototype
  prototype.breedPairs = function(this: EntityManager): void {
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
      this.hooks.effect('love', baby.x, baby.y + 0.65, baby.z)
    }
  }
  prototype.nearestMate = function(this: EntityManager, entity: EntityState, radius: number): EntityState | null {
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
  prototype.breedVillagerPairs = function(this: EntityManager): void {
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
      this.hooks.effect('love', baby.x, baby.y + 0.65, baby.z)
    }
  }
  prototype.tryNaturalSpawn = function(this: EntityManager, context: EntityUpdateContext): void {
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
  prototype.spawnNaturalCategory = function(this: EntityManager, category: 'hostile' | 'passive', chunks: readonly EligibleChunk[], cap: number, context: EntityUpdateContext): void {
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
      const baseY = entry.kind === 'squid'
        ? this.findNaturalSquidY(x, z, surfaceY)
        : category === 'passive' ? surfaceY : this.findNaturalHostileY(x, z, surfaceY)
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
        const sy = entry.kind === 'squid'
          ? this.findNaturalSquidY(sx, sz, this.world.topSolidY(sx, sz) + 1)
          : category === 'passive' || baseY === surfaceY
            ? this.world.topSolidY(sx, sz) + 1
            : baseY
        if (sy === null) continue
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
  prototype.findNaturalSquidY = function(this: EntityManager, x: number, z: number, seabedY: number): number | null {
    const candidates: number[] = []
    for (let y = Math.max(2, seabedY); y < Math.min(127, seabedY + 12); y++) {
      if (this.world.isWater(Math.floor(x), y, Math.floor(z))) candidates.push(y + 0.05)
    }
    return candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : null
  }
  prototype.findNaturalHostileY = function(this: EntityManager, x: number, z: number, surfaceY: number): number | null {
    const maxY = Math.min(127, Math.max(1, surfaceY))
    for (let attempt = 0; attempt < 12; attempt++) {
      const y = attempt === 11 ? surfaceY : 1 + Math.floor(Math.random() * maxY)
      if (y < 1 || y >= 127 || !this.world.isSolid(x, y - 1, z)) continue
      if (isFluid(this.world.getBlock(x, y - 1, z)) || this.world.isSolid(x, y, z)) continue
      return y
    }
    return null
  }
  prototype.serialize = function(this: EntityManager): SavedEntity[] {
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
  prototype.restore = function(this: EntityManager, saved: readonly SavedEntity[]): void {
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
      entity.previousX = entity.x; entity.previousY = entity.y; entity.previousZ = entity.z
      entity.previousYaw = entity.yaw
      entity.headingX = -Math.sin(entity.yaw); entity.headingZ = -Math.cos(entity.yaw)
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
  prototype.dispose = function(this: EntityManager): void {
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
