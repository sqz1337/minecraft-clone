import { B } from '../Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from '../Chunk'
import { hash2 } from '../../util/math'
import {
  boxContains,
  boxIntersectsChunk,
  boxesIntersect,
  chunkBox,
  type BoundingBox3D
} from './Bounds'
import {
  dungeonPrecedes,
  generateDungeonCandidates,
  generateMineshaft,
  generateStrongholds,
  generateVillage,
  villageCandidateForRegion,
  VILLAGE_SPACING
} from './Generators'
import type {
  DungeonPlan,
  MineshaftPlan,
  StrongholdPlan,
  StructureChest,
  StructureComponent,
  StructurePlan,
  StructureSpawner,
  StructureTerrainSampler,
  VillageBuilding,
  VillageDoorSpot,
  VillageInfo,
  VillagePlan,
  VillagerSpot
} from './Types'

const PLAN_CACHE_LIMIT = 4096
const DESTINATION_CACHE_LIMIT = 1024
const MINE_SOURCE_RADIUS = 7

function floorDiv(value: number, divisor: number): number { return Math.floor(value / divisor) }
function key(x: number, z: number): string { return `${x},${z}` }

function remember<T>(cache: Map<string, T>, cacheKey: string, value: T, limit = PLAN_CACHE_LIMIT): T {
  if (!cache.has(cacheKey) && cache.size >= limit) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(cacheKey, value)
  return value
}

function insideChunk(point: { x: number; z: number }, cx: number, cz: number): boolean {
  const minX = cx * CHUNK_SIZE, minZ = cz * CHUNK_SIZE
  return point.x >= minX && point.x < minX + CHUNK_SIZE && point.z >= minZ && point.z < minZ + CHUNK_SIZE
}

function footprint(building: VillageBuilding): { x0: number; x1: number; z0: number; z1: number; height: number } {
  const { kind, cx, cz } = building
  const halfW = kind === 'large_house' || kind === 'blacksmith' ? 4
    : kind === 'library' || kind === 'farm' ? 3 : 2
  const halfD = kind === 'church' ? 4
    : kind === 'large_house' || kind === 'blacksmith' || kind === 'library' ? 3 : 2
  const height = kind === 'church' ? 8 : kind === 'hut' ? 4 : kind === 'farm' ? 2 : 5
  return { x0: cx - halfW, x1: cx + halfW, z0: cz - halfD, z1: cz + halfD, height }
}

/**
 * One lazy, deterministic index owns starts, destination-chunk clipping and
 * gameplay metadata. No query inspects loaded chunks, so streaming order is
 * irrelevant.
 */
export class StructureIndex {
  private dungeonCache = new Map<string, readonly DungeonPlan[]>()
  private dungeonCandidateCache = new Map<string, readonly DungeonPlan[]>()
  private mineshaftCache = new Map<string, MineshaftPlan | null>()
  private villageCache = new Map<string, VillagePlan | null>()
  private destinationCache = new Map<string, readonly StructurePlan[]>()
  private strongholdCache: StrongholdPlan[] | null = null

  constructor(readonly seed: number, private readonly terrain: StructureTerrainSampler) {}

  dungeonIn(cx: number, cz: number): DungeonPlan | null {
    return this.dungeonsIn(cx, cz)[0] ?? null
  }

  dungeonsIn(cx: number, cz: number): readonly DungeonPlan[] {
    const cacheKey = key(cx, cz)
    const cached = this.dungeonCache.get(cacheKey)
    if (cached) return cached
    const own = this.dungeonCandidatesIn(cx, cz)
    const rivals: DungeonPlan[] = []
    for (let sx = cx - 1; sx <= cx + 1; sx++) for (let sz = cz - 1; sz <= cz + 1; sz++) {
      rivals.push(...this.dungeonCandidatesIn(sx, sz))
    }
    const accepted = own.filter(plan => !rivals.some(rival =>
      rival.id !== plan.id && boxesIntersect(rival.bounds, plan.bounds) && dungeonPrecedes(this.seed, rival, plan)
    ))
    return remember(this.dungeonCache, cacheKey, accepted)
  }

  private dungeonCandidatesIn(cx: number, cz: number): readonly DungeonPlan[] {
    const cacheKey = key(cx, cz)
    const cached = this.dungeonCandidateCache.get(cacheKey)
    if (cached) return cached
    return remember(this.dungeonCandidateCache, cacheKey,
      generateDungeonCandidates(this.seed, cx, cz, this.terrain))
  }

  mineshaftIn(cx: number, cz: number): MineshaftPlan | null {
    const cacheKey = key(cx, cz)
    if (this.mineshaftCache.has(cacheKey)) return this.mineshaftCache.get(cacheKey) ?? null
    return remember(this.mineshaftCache, cacheKey, generateMineshaft(this.seed, cx, cz, this.terrain))
  }

  villageIn(regionX: number, regionZ: number): VillagePlan | null {
    const cacheKey = key(regionX, regionZ)
    if (this.villageCache.has(cacheKey)) return this.villageCache.get(cacheKey) ?? null
    return remember(this.villageCache, cacheKey, generateVillage(this.seed, regionX, regionZ, this.terrain), 512)
  }

  villageCandidate(regionX: number, regionZ: number): { cx: number; cz: number } {
    return villageCandidateForRegion(this.seed, regionX, regionZ)
  }

  strongholds(): StrongholdPlan[] {
    if (!this.strongholdCache) this.strongholdCache = generateStrongholds(this.seed, this.terrain)
    return this.strongholdCache
  }

  plansForChunk(cx: number, cz: number): readonly StructurePlan[] {
    const destinationKey = key(cx, cz)
    const cached = this.destinationCache.get(destinationKey)
    if (cached) return cached
    const destination = chunkBox(cx, cz)
    const plans = new Map<string, StructurePlan>()
    for (let sx = cx - 1; sx <= cx + 1; sx++) for (let sz = cz - 1; sz <= cz + 1; sz++) {
      for (const dungeon of this.dungeonsIn(sx, sz)) {
        if (boxesIntersect(dungeon.bounds, destination)) plans.set(dungeon.id, dungeon)
      }
    }
    for (let sx = cx - MINE_SOURCE_RADIUS; sx <= cx + MINE_SOURCE_RADIUS; sx++) {
      for (let sz = cz - MINE_SOURCE_RADIUS; sz <= cz + MINE_SOURCE_RADIUS; sz++) {
        const mine = this.mineshaftIn(sx, sz)
        if (mine && boxesIntersect(mine.bounds, destination)) plans.set(mine.id, mine)
      }
    }
    const regionX = floorDiv(cx, VILLAGE_SPACING), regionZ = floorDiv(cz, VILLAGE_SPACING)
    for (let rx = regionX - 1; rx <= regionX + 1; rx++) for (let rz = regionZ - 1; rz <= regionZ + 1; rz++) {
      const village = this.villageIn(rx, rz)
      if (village && boxesIntersect(village.bounds, destination)) plans.set(village.id, village)
    }
    for (const stronghold of this.strongholds()) {
      if (boxesIntersect(stronghold.bounds, destination)) plans.set(stronghold.id, stronghold)
    }
    const ordered = [...plans.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    return remember(this.destinationCache, destinationKey, ordered, DESTINATION_CACHE_LIMIT)
  }

  /**
   * Imports a destination result produced by the world-generation worker.
   * Structure plans contain data only, so sharing them avoids repeating raw
   * terrain validation on the render thread without changing world output.
   */
  primePlansForChunk(cx: number, cz: number, plans: readonly StructurePlan[]): void {
    remember(this.destinationCache, key(cx, cz), [...plans], DESTINATION_CACHE_LIMIT)
  }

  stampChunk(chunk: Chunk): void {
    for (const plan of this.plansForChunk(chunk.cx, chunk.cz)) {
      if (plan.kind === 'dungeon') this.stampDungeon(chunk, plan)
      else if (plan.kind === 'mineshaft') this.stampMineshaft(chunk, plan)
      else if (plan.kind === 'stronghold') this.stampStronghold(chunk, plan)
      else this.stampVillage(chunk, plan)
    }
  }

  structureChestsIn(cx: number, cz: number): StructureChest[] {
    const byPosition = new Map<string, StructureChest>()
    for (const plan of this.plansForChunk(cx, cz)) for (const chest of plan.chests) {
      if (insideChunk(chest, cx, cz)) byPosition.set(`${chest.x},${chest.y},${chest.z}`, chest)
    }
    return [...byPosition.values()].sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y)
  }

  structureSpawnersNear(x: number, z: number, radius: number): StructureSpawner[] {
    const minCx = floorDiv(x - radius, CHUNK_SIZE), maxCx = floorDiv(x + radius, CHUNK_SIZE)
    const minCz = floorDiv(z - radius, CHUNK_SIZE), maxCz = floorDiv(z + radius, CHUNK_SIZE)
    const plans = new Map<string, StructurePlan>()
    for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) {
      for (const plan of this.plansForChunk(cx, cz)) plans.set(plan.id, plan)
    }
    const out = new Map<string, StructureSpawner>()
    for (const plan of plans.values()) for (const spawner of plan.spawners) {
      if (Math.hypot(spawner.x - x, spawner.z - z) <= radius) {
        out.set(`${spawner.x},${spawner.y},${spawner.z}`, spawner)
      }
    }
    return [...out.values()]
  }

  villagerSpawnsIn(cx: number, cz: number): VillagerSpot[] {
    const out = new Map<string, VillagerSpot>()
    for (const plan of this.plansForChunk(cx, cz)) {
      if (plan.kind !== 'village') continue
      for (const spot of plan.villagers) if (insideChunk(spot, cx, cz)) {
        out.set(`${spot.villageId}:${spot.x},${spot.y},${spot.z}`, spot)
      }
    }
    return [...out.values()]
  }

  villageFeaturesIn(cx: number, cz: number): VillageInfo[] {
    const out: VillageInfo[] = []
    for (const plan of this.plansForChunk(cx, cz)) {
      if (plan.kind !== 'village') continue
      out.push({
        id: plan.id,
        centerX: plan.centerX, centerY: plan.centerY, centerZ: plan.centerZ,
        radius: Math.max(32, Math.ceil(Math.max(
          plan.bounds.maxX - plan.bounds.minX + 1,
          plan.bounds.maxZ - plan.bounds.minZ + 1
        ) / 2)),
        doors: plan.doors.map(door => ({
          ...door, inside: { ...door.inside }, outside: { ...door.outside }
        }))
      })
    }
    return out
  }

  nearestStronghold(x: number, z: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null
    let bestDistance = Infinity
    for (const plan of this.strongholds()) {
      const centerX = Math.round((plan.bounds.minX + plan.bounds.maxX) / 2)
      const centerZ = Math.round((plan.bounds.minZ + plan.bounds.maxZ) / 2)
      const distance = Math.hypot(centerX - x, centerZ - z)
      if (distance < bestDistance) { bestDistance = distance; best = { x: centerX, z: centerZ } }
    }
    return best
  }

  cacheStats(): { dungeons: number; mineshafts: number; villages: number; destinations: number } {
    return {
      dungeons: this.dungeonCache.size, mineshafts: this.mineshaftCache.size,
      villages: this.villageCache.size, destinations: this.destinationCache.size
    }
  }

  private put(chunk: Chunk, x: number, y: number, z: number, id: number): void {
    const lx = x - chunk.cx * CHUNK_SIZE, lz = z - chunk.cz * CHUNK_SIZE
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 1 || y >= WORLD_HEIGHT) return
    chunk.blocks[(((lx << 4) | lz) << 7) | y] = id
  }

  private get(chunk: Chunk, x: number, y: number, z: number): number {
    const lx = x - chunk.cx * CHUNK_SIZE, lz = z - chunk.cz * CHUNK_SIZE
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR
    return chunk.blocks[(((lx << 4) | lz) << 7) | y]
  }

  private clippedXZ(chunk: Chunk, bounds: BoundingBox3D): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    if (!boxIntersectsChunk(bounds, chunk.cx, chunk.cz)) return null
    const minX = Math.max(bounds.minX, chunk.cx * CHUNK_SIZE)
    const maxX = Math.min(bounds.maxX, chunk.cx * CHUNK_SIZE + CHUNK_SIZE - 1)
    const minZ = Math.max(bounds.minZ, chunk.cz * CHUNK_SIZE)
    const maxZ = Math.min(bounds.maxZ, chunk.cz * CHUNK_SIZE + CHUNK_SIZE - 1)
    return { minX, maxX, minZ, maxZ }
  }

  private stampDungeon(chunk: Chunk, plan: DungeonPlan): void {
    const clipped = this.clippedXZ(chunk, plan.bounds)
    if (!clipped) return
    const entranceAt = (x: number, y: number, z: number) => plan.entrances.some(door => boxContains(door, x, y, z))
    for (let x = clipped.minX; x <= clipped.maxX; x++) for (let z = clipped.minZ; z <= clipped.maxZ; z++) {
      const wall = x === plan.x0 || x === plan.x0 + plan.w - 1 || z === plan.z0 || z === plan.z0 + plan.d - 1
      this.put(chunk, x, plan.floorY - 1, z,
        hash2(x, z, this.seed ^ 0x9055) % 4 === 0 ? B.COBBLESTONE : B.MOSSY_COBBLESTONE)
      for (let y = plan.floorY; y <= plan.floorY + 2; y++) {
        if (entranceAt(x, y, z)) this.put(chunk, x, y, z, B.AIR)
        else this.put(chunk, x, y, z, wall
          ? (hash2(x ^ y, z, this.seed ^ 0xd41) % 4 === 0 ? B.MOSSY_COBBLESTONE : B.COBBLESTONE)
          : B.AIR)
      }
      this.put(chunk, x, plan.floorY + 3, z, B.COBBLESTONE)
    }
    this.put(chunk, plan.spawner.x, plan.spawner.y, plan.spawner.z, B.SPAWNER)
    for (const chest of plan.chests) this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
  }

  private stampMineshaft(chunk: Chunk, plan: MineshaftPlan): void {
    const ordered = [...plan.components].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
    for (const part of ordered) {
      const clipped = this.clippedXZ(chunk, part.bounds)
      if (!clipped) continue
      if (part.kind === 'mineshaft_room') {
        for (let x = clipped.minX; x <= clipped.maxX; x++) for (let z = clipped.minZ; z <= clipped.maxZ; z++) {
          const wall = x === part.bounds.minX || x === part.bounds.maxX || z === part.bounds.minZ || z === part.bounds.maxZ
          this.put(chunk, x, part.bounds.minY, z, B.DIRT)
          for (let y = part.bounds.minY + 1; y < part.bounds.maxY; y++) this.put(chunk, x, y, z, wall ? B.DIRT : B.AIR)
          this.put(chunk, x, part.bounds.maxY, z, B.DIRT)
        }
        continue
      }
      const axisX = part.direction === 0 || part.direction === 1
      for (let x = clipped.minX; x <= clipped.maxX; x++) for (let z = clipped.minZ; z <= clipped.maxZ; z++) {
        const along = axisX ? x : z
        const center = axisX
          ? Math.floor((part.bounds.minZ + part.bounds.maxZ) / 2)
          : Math.floor((part.bounds.minX + part.bounds.maxX) / 2)
        const offset = axisX ? z - center : x - center
        if (part.kind === 'mineshaft_stairs') {
          const span = axisX ? part.bounds.maxX - part.bounds.minX : part.bounds.maxZ - part.bounds.minZ
          const progress = (part.direction === 0 || part.direction === 2)
            ? (along - (axisX ? part.bounds.minX : part.bounds.minZ)) / Math.max(1, span)
            : ((axisX ? part.bounds.maxX : part.bounds.maxZ) - along) / Math.max(1, span)
          const feet = Math.round(part.bounds.minY + 1 + progress * Math.max(0, part.bounds.maxY - part.bounds.minY - 3))
          this.put(chunk, x, feet - 1, z, B.PLANKS)
          this.put(chunk, x, feet, z, B.AIR); this.put(chunk, x, feet + 1, z, B.AIR); this.put(chunk, x, feet + 2, z, B.AIR)
          continue
        }
        this.put(chunk, x, part.bounds.minY, z, B.PLANKS)
        for (let y = part.bounds.minY + 1; y < part.bounds.maxY; y++) this.put(chunk, x, y, z, B.AIR)
        if (part.kind === 'mineshaft_crossing') continue
        if (Math.abs(along) % 5 === 0) {
          if (offset !== 0) {
            this.put(chunk, x, part.bounds.minY + 1, z, B.PLANKS)
            this.put(chunk, x, part.bounds.minY + 2, z, B.PLANKS)
          }
          this.put(chunk, x, part.bounds.maxY, z, B.PLANKS)
        }
        if (part.rails && offset === 0 && Math.abs(along) % 5 !== 0) this.put(chunk, x, part.bounds.minY + 1, z, B.RAIL)
      }
    }
    for (const gap of plan.openings) {
      for (let x = gap.minX; x <= gap.maxX; x++) for (let z = gap.minZ; z <= gap.maxZ; z++) {
        for (let y = gap.minY; y <= gap.maxY; y++) this.put(chunk, x, y, z, B.AIR)
      }
    }
    for (const chest of plan.chests) {
      this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
      if (this.get(chunk, chest.x, chest.y - 1, chest.z) === B.AIR) this.put(chunk, chest.x, chest.y - 1, chest.z, B.PLANKS)
    }
    for (const spawner of plan.spawners) this.put(chunk, spawner.x, spawner.y, spawner.z, B.SPAWNER)
  }

  private strongholdWall(x: number, y: number, z: number): number {
    const roll = hash2(x ^ Math.imul(y, 977), z, this.seed ^ 0x570e) % 20
    return roll < 3 ? B.STONE_BRICK_MOSSY : roll < 6 ? B.STONE_BRICK_CRACKED : B.STONE_BRICK
  }

  private stampStronghold(chunk: Chunk, plan: StrongholdPlan): void {
    const ordered = [...plan.components].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
    for (const part of ordered) {
      const clipped = this.clippedXZ(chunk, part.bounds)
      if (!clipped) continue
      for (let x = clipped.minX; x <= clipped.maxX; x++) for (let z = clipped.minZ; z <= clipped.maxZ; z++) {
        const wall = x === part.bounds.minX || x === part.bounds.maxX || z === part.bounds.minZ || z === part.bounds.maxZ
        this.put(chunk, x, part.bounds.minY, z, this.strongholdWall(x, part.bounds.minY, z))
        for (let y = part.bounds.minY + 1; y < part.bounds.maxY; y++) {
          this.put(chunk, x, y, z, wall ? this.strongholdWall(x, y, z) : B.AIR)
        }
        this.put(chunk, x, part.bounds.maxY, z, this.strongholdWall(x, part.bounds.maxY, z))
      }
      if (part.kind === 'stronghold_prison') {
        const x = Math.floor((part.bounds.minX + part.bounds.maxX) / 2)
        for (let z = part.bounds.minZ + 1; z < part.bounds.maxZ; z += 2) {
          this.put(chunk, x, part.bounds.minY + 1, z, B.GLASS)
          this.put(chunk, x, part.bounds.minY + 2, z, B.GLASS)
        }
      }
    }
    for (const gap of plan.openings) {
      for (let x = gap.x0; x <= gap.x1; x++) for (let z = gap.z0; z <= gap.z1; z++) {
        for (let y = gap.y; y < gap.y + gap.height; y++) this.put(chunk, x, y, z, B.AIR)
      }
    }
    for (const shelf of plan.bookshelves) this.put(chunk, shelf.x, shelf.y, shelf.z, B.BOOKSHELF)
    for (const frame of plan.framePositions) this.put(chunk, frame.x, frame.y, frame.z, B.END_PORTAL_FRAME)
    this.put(chunk, plan.spawner.x, plan.spawner.y, plan.spawner.z, B.SPAWNER)
    for (const chest of plan.chests) this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
  }

  private stampVillage(chunk: Chunk, plan: VillagePlan): void {
    for (const road of plan.roads) {
      const clipped = this.clippedXZ(chunk, road.bounds)
      if (!clipped) continue
      for (let x = clipped.minX; x <= clipped.maxX; x++) for (let z = clipped.minZ; z <= clipped.maxZ; z++) {
        const y = this.terrain.columnInfo(x, z).height
        this.put(chunk, x, y, z, plan.desert ? B.SANDSTONE : B.GRAVEL)
        this.put(chunk, x, y + 1, z, B.AIR)
      }
    }
    for (const building of plan.buildings) {
      if (building.kind === 'well') this.stampVillageWell(chunk, plan, building)
      else if (building.kind === 'farm') this.stampVillageFarm(chunk, building)
      else this.stampVillageBuilding(chunk, plan, building)
    }
    for (const door of plan.doors) {
      this.put(chunk, door.x, door.y, door.z, B.AIR)
      this.put(chunk, door.x, door.y + 1, door.z, B.AIR)
    }
    for (const chest of plan.chests) this.put(chunk, chest.x, chest.y, chest.z, B.CHEST)
  }

  private stampVillageWell(chunk: Chunk, plan: VillagePlan, well: VillageBuilding): void {
    const wall = plan.desert ? B.SANDSTONE : B.COBBLESTONE
    for (let x = well.cx - 2; x <= well.cx + 2; x++) for (let z = well.cz - 2; z <= well.cz + 2; z++) {
      const edge = Math.abs(x - well.cx) === 2 || Math.abs(z - well.cz) === 2
      this.put(chunk, x, well.groundY, z, edge ? wall : B.WATER)
      if (!edge) this.put(chunk, x, well.groundY - 1, z, B.WATER)
      for (let y = well.groundY + 1; y <= well.groundY + 3; y++) this.put(chunk, x, y, z, B.AIR)
    }
    for (const [dx, dz] of [[-2, -2], [-2, 2], [2, -2], [2, 2]] as const) {
      this.put(chunk, well.cx + dx, well.groundY + 1, well.cz + dz, wall)
      this.put(chunk, well.cx + dx, well.groundY + 2, well.cz + dz, wall)
    }
    for (let x = well.cx - 2; x <= well.cx + 2; x++) for (let z = well.cz - 2; z <= well.cz + 2; z++) {
      this.put(chunk, x, well.groundY + 3, z, wall)
    }
  }

  private stampVillageBuilding(chunk: Chunk, plan: VillagePlan, building: VillageBuilding): void {
    const shape = footprint(building)
    const wallId = plan.desert ? B.SANDSTONE
      : building.kind === 'blacksmith' ? B.COBBLESTONE : B.PLANKS
    const cornerId = plan.desert ? B.SANDSTONE : building.kind === 'blacksmith' ? B.COBBLESTONE : B.LOG
    const floorId = plan.desert ? B.SANDSTONE : B.COBBLESTONE
    for (let x = shape.x0; x <= shape.x1; x++) for (let z = shape.z0; z <= shape.z1; z++) {
      for (let y = building.groundY - 2; y <= building.groundY; y++) {
        if (this.get(chunk, x, y, z) === B.AIR) this.put(chunk, x, y, z, floorId)
      }
      this.put(chunk, x, building.groundY, z, floorId)
      const edge = x === shape.x0 || x === shape.x1 || z === shape.z0 || z === shape.z1
      const corner = (x === shape.x0 || x === shape.x1) && (z === shape.z0 || z === shape.z1)
      for (let y = building.groundY + 1; y < building.groundY + shape.height; y++) {
        this.put(chunk, x, y, z, corner ? cornerId : edge ? wallId : B.AIR)
      }
      this.put(chunk, x, building.groundY + shape.height, z, plan.desert ? B.SANDSTONE : B.PLANKS)
      this.put(chunk, x, building.groundY + shape.height + 1, z, B.AIR)
    }
    if (building.kind === 'library') {
      for (let z = shape.z0 + 1; z < shape.z1; z += 2) {
        this.put(chunk, shape.x0 + 1, building.groundY + 1, z, B.BOOKSHELF)
        this.put(chunk, shape.x0 + 1, building.groundY + 2, z, B.BOOKSHELF)
      }
    } else if (building.kind === 'blacksmith') {
      this.put(chunk, shape.x1 - 1, building.groundY + 1, shape.z1 - 1, B.LAVA)
      this.put(chunk, shape.x1 - 2, building.groundY + 1, shape.z1 - 1, B.COBBLESTONE)
    }
    if (building.facing === 0 || building.facing === 1) {
      this.put(chunk, building.cx, building.groundY + 2, shape.z0, B.GLASS)
      this.put(chunk, building.cx, building.groundY + 2, shape.z1, B.GLASS)
    } else {
      this.put(chunk, shape.x0, building.groundY + 2, building.cz, B.GLASS)
      this.put(chunk, shape.x1, building.groundY + 2, building.cz, B.GLASS)
    }
  }

  private stampVillageFarm(chunk: Chunk, farm: VillageBuilding): void {
    const shape = footprint(farm)
    for (let x = shape.x0; x <= shape.x1; x++) for (let z = shape.z0; z <= shape.z1; z++) {
      const edge = x === shape.x0 || x === shape.x1 || z === shape.z0 || z === shape.z1
      if (edge) this.put(chunk, x, farm.groundY, z, B.LOG)
      else if (x === farm.cx) this.put(chunk, x, farm.groundY, z, B.WATER)
      else {
        this.put(chunk, x, farm.groundY, z, B.FARMLAND_WET)
        this.put(chunk, x, farm.groundY + 1, z, B.WHEAT_0 + hash2(x, z, this.seed ^ 0xfa53) % 8)
      }
      this.put(chunk, x, farm.groundY + 2, z, B.AIR)
    }
  }
}

export type {
  DungeonPlan,
  MineshaftPlan,
  StrongholdPlan,
  StructureChest,
  StructurePlan,
  StructureSpawner,
  VillageDoorSpot,
  VillageInfo,
  VillagePlan,
  VillagerSpot
} from './Types'
export type { BoundingBox3D } from './Bounds'
