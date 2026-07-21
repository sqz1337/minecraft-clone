import { hash2, mulberry32, clamp } from '../util/math'
import { B, SOLID, isFluid, isWater } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'

/** Vanilla MapGenBase examined source chunks in an eight-chunk halo. */
export const CARVER_SOURCE_RADIUS = 8
export const DEEP_LAVA_TOP = 10
export const MAX_CAVE_STARTS_PER_SOURCE = 12
export const MAX_CAVE_PRIMITIVES_PER_SOURCE = 768
export const MAX_RAVINE_PRIMITIVES_PER_SOURCE = 128
export const PLAN_CACHE_LIMIT = 2048

const CAVE_SALT = 0x43415645
const RAVINE_SALT = 0x52415645
const WATER_LAKE_SALT = 0x574c414b
const LAVA_LAKE_SALT = 0x4c4c414b

export type LakeKind = 'water' | 'lava'
export type CarvePrimitiveKind = 'room' | 'tunnel' | 'ravine'

/**
 * World-coordinate view of terrain before caves, ravines, lakes, ores and
 * decorations. It deliberately does not expose loaded chunks: map generation
 * must give the same answer regardless of streaming order.
 */
export interface CarverBaseSampler {
  baseBlockAt(x: number, y: number, z: number): number
  surfaceY(x: number, z: number): number
  biomeAt(x: number, z: number): number
  /** Optional biome/structure policy owned by WorldGen rather than the carver. */
  allowLake?(kind: LakeKind, x: number, z: number, biome: number): boolean
}

export interface FeatureBounds {
  minX: number; minY: number; minZ: number
  maxX: number; maxY: number; maxZ: number
}

export interface CarvePrimitive {
  kind: CarvePrimitiveKind
  x: number; y: number; z: number
  rx: number; ry: number; rz: number
  branchId: number
  parentBranchId: number | null
}

export interface CarvePlan {
  kind: 'cave' | 'ravine'
  sourceCx: number
  sourceCz: number
  branchCount: number
  primitives: readonly CarvePrimitive[]
  bounds: FeatureBounds
}

/** Mask indexing is ((localX * 16 + localZ) * 8 + localY). */
export interface LakePlan {
  kind: LakeKind
  sourceCx: number
  sourceCz: number
  biome: number
  originX: number
  originY: number
  originZ: number
  liquid: number
  mask: Uint8Array
  bounds: FeatureBounds
}

export interface StampStats {
  primitivesTested: number
  primitivesStamped: number
  blocksChanged: number
}

export interface CarveChunkStats extends StampStats {
  cavePlans: number
  ravinePlans: number
  lakePlans: number
}

export interface MapCarverCacheStats {
  cavePlans: number
  ravinePlans: number
  lakePlans: number
}

type Random = () => number

function nextInt(random: Random, bound: number): number {
  const safeBound = Math.max(1, Math.floor(bound))
  return Math.floor(random() * safeBound)
}

function nextSeed(random: Random): number {
  return Math.floor(random() * 0x100000000) >>> 0
}

function sourceKey(cx: number, cz: number): string { return `${cx},${cz}` }

function rememberBounded<T>(cache: Map<string, T>, key: string, value: T): T {
  if (!cache.has(key) && cache.size >= PLAN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

function emptyBounds(): FeatureBounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  }
}

function includePrimitive(bounds: FeatureBounds, primitive: CarvePrimitive): void {
  bounds.minX = Math.min(bounds.minX, primitive.x - primitive.rx)
  bounds.minY = Math.min(bounds.minY, primitive.y - primitive.ry)
  bounds.minZ = Math.min(bounds.minZ, primitive.z - primitive.rz)
  bounds.maxX = Math.max(bounds.maxX, primitive.x + primitive.rx)
  bounds.maxY = Math.max(bounds.maxY, primitive.y + primitive.ry)
  bounds.maxZ = Math.max(bounds.maxZ, primitive.z + primitive.rz)
}

function includeCell(bounds: FeatureBounds, x: number, y: number, z: number): void {
  bounds.minX = Math.min(bounds.minX, x)
  bounds.minY = Math.min(bounds.minY, y)
  bounds.minZ = Math.min(bounds.minZ, z)
  bounds.maxX = Math.max(bounds.maxX, x)
  bounds.maxY = Math.max(bounds.maxY, y)
  bounds.maxZ = Math.max(bounds.maxZ, z)
}

function boundsIntersectChunk(bounds: FeatureBounds, chunk: Chunk): boolean {
  const minX = chunk.cx * CHUNK_SIZE
  const minZ = chunk.cz * CHUNK_SIZE
  return bounds.maxX >= minX && bounds.minX < minX + CHUNK_SIZE &&
    bounds.maxZ >= minZ && bounds.minZ < minZ + CHUNK_SIZE &&
    bounds.maxY >= 2 && bounds.minY < WORLD_HEIGHT
}

function primitiveIntersectsChunk(primitive: CarvePrimitive, chunk: Chunk): boolean {
  const minX = chunk.cx * CHUNK_SIZE
  const minZ = chunk.cz * CHUNK_SIZE
  return primitive.x + primitive.rx >= minX && primitive.x - primitive.rx < minX + CHUNK_SIZE &&
    primitive.z + primitive.rz >= minZ && primitive.z - primitive.rz < minZ + CHUNK_SIZE &&
    primitive.y + primitive.ry >= 2 && primitive.y - primitive.ry < WORLD_HEIGHT
}

function carvable(id: number): boolean {
  return id === B.STONE || id === B.DIRT || id === B.GRASS || id === B.MYCELIUM ||
    id === B.SNOW || id === B.SAND || id === B.GRAVEL || id === B.SANDSTONE
}

class PlanAccumulator {
  readonly primitives: CarvePrimitive[] = []
  readonly bounds = emptyBounds()
  branchCount = 0

  constructor(readonly limit: number) {}

  branch(): number { return this.branchCount++ }

  push(primitive: CarvePrimitive): boolean {
    if (this.primitives.length >= this.limit) return false
    this.primitives.push(primitive)
    includePrimitive(this.bounds, primitive)
    return true
  }
}

function buildCaveTunnel(
  accumulator: PlanAccumulator,
  seed: number,
  startX: number,
  startY: number,
  startZ: number,
  width: number,
  yaw: number,
  pitch: number,
  parentBranchId: number | null,
  depth = 0,
  startStep = 0,
  totalSteps?: number
): void {
  if (accumulator.primitives.length >= accumulator.limit) return
  const random = mulberry32(seed)
  const branchId = accumulator.branch()
  const steps = totalSteps ?? (84 + nextInt(random, 28))
  if (startStep >= steps - 2) return
  const remaining = steps - startStep
  const splitStep = startStep + Math.floor(remaining * (0.28 + random() * 0.38))
  const dampPitch = random() < 0.5
  let x = startX, y = startY, z = startZ
  let yawVelocity = 0
  let pitchVelocity = 0

  for (let step = startStep; step < steps; step++) {
    if (accumulator.primitives.length >= accumulator.limit) return
    const phase = step / steps
    const horizontalRadius = 1.35 + Math.sin(phase * Math.PI) * width
    const verticalRadius = horizontalRadius * (0.62 + random() * 0.12)
    const horizontal = Math.cos(pitch)
    x += Math.cos(yaw) * horizontal
    y += Math.sin(pitch)
    z += Math.sin(yaw) * horizontal

    pitch *= dampPitch ? 0.72 : 0.91
    pitch += pitchVelocity * 0.1
    yaw += yawVelocity * 0.1
    pitchVelocity *= 0.9
    yawVelocity *= 0.75
    pitchVelocity += (random() - random()) * random() * 1.6
    yawVelocity += (random() - random()) * random() * 3.2

    accumulator.push({
      kind: 'tunnel', x, y, z,
      rx: horizontalRadius,
      ry: verticalRadius,
      rz: horizontalRadius,
      branchId,
      parentBranchId
    })

    const canSplit = depth < 2 && width > 1.15 && remaining > 24 && step === splitStep
    if (!canSplit) continue
    const childWidth = width * (0.52 + random() * 0.16)
    const leftSeed = nextSeed(random)
    const rightSeed = nextSeed(random)
    buildCaveTunnel(
      accumulator, leftSeed, x, y, z, childWidth,
      yaw - Math.PI / 2, pitch / 3, branchId, depth + 1, step + 1, steps
    )
    buildCaveTunnel(
      accumulator, rightSeed, x, y, z, childWidth,
      yaw + Math.PI / 2, pitch / 3, branchId, depth + 1, step + 1, steps
    )
    return
  }
}

function makeCavePlan(seed: number, sourceCx: number, sourceCz: number): CarvePlan | null {
  const random = mulberry32(hash2(sourceCx, sourceCz, seed ^ CAVE_SALT))
  let starts = nextInt(random, nextInt(random, nextInt(random, 40) + 1) + 1)
  if (nextInt(random, 15) !== 0) starts = 0
  starts = Math.min(starts, MAX_CAVE_STARTS_PER_SOURCE)
  if (starts === 0) return null

  const accumulator = new PlanAccumulator(MAX_CAVE_PRIMITIVES_PER_SOURCE)
  for (let start = 0; start < starts && accumulator.primitives.length < accumulator.limit; start++) {
    const x = sourceCx * CHUNK_SIZE + random() * CHUNK_SIZE
    const y = clamp(nextInt(random, nextInt(random, 120) + 8), 4, WORLD_HEIGHT - 5)
    const z = sourceCz * CHUNK_SIZE + random() * CHUNK_SIZE
    let tunnels = 1
    if (nextInt(random, 4) === 0) {
      const radius = 1.5 + random() * 5.5
      accumulator.push({
        kind: 'room', x, y, z,
        rx: radius,
        ry: radius * (0.48 + random() * 0.16),
        rz: radius,
        branchId: -1,
        parentBranchId: null
      })
      tunnels += nextInt(random, 4)
    }
    for (let tunnel = 0; tunnel < tunnels && accumulator.primitives.length < accumulator.limit; tunnel++) {
      const yaw = random() * Math.PI * 2
      const pitch = (random() - 0.5) * 0.25
      let width = 0.8 + random() * 1.9
      if (nextInt(random, 10) === 0) width *= 1 + random() * random() * 2.5
      buildCaveTunnel(accumulator, nextSeed(random), x, y, z, width, yaw, pitch, null)
    }
  }
  if (accumulator.primitives.length === 0) return null
  return {
    kind: 'cave', sourceCx, sourceCz,
    branchCount: accumulator.branchCount,
    primitives: accumulator.primitives,
    bounds: accumulator.bounds
  }
}

function makeRavinePlan(seed: number, sourceCx: number, sourceCz: number): CarvePlan | null {
  const sourceRandom = mulberry32(hash2(sourceCx, sourceCz, seed ^ RAVINE_SALT))
  if (nextInt(sourceRandom, 50) !== 0) return null
  const random = mulberry32(nextSeed(sourceRandom))
  const accumulator = new PlanAccumulator(MAX_RAVINE_PRIMITIVES_PER_SOURCE)
  const branchId = accumulator.branch()
  const steps = 84 + nextInt(random, 28)
  const width = 2 + random() * 3.2
  let x = sourceCx * CHUNK_SIZE + sourceRandom() * CHUNK_SIZE
  let y = clamp(20 + nextInt(sourceRandom, nextInt(sourceRandom, 40) + 8), 8, WORLD_HEIGHT - 12)
  let z = sourceCz * CHUNK_SIZE + sourceRandom() * CHUNK_SIZE
  let yaw = sourceRandom() * Math.PI * 2
  let pitch = (sourceRandom() - 0.5) * 0.12
  let yawVelocity = 0
  let pitchVelocity = 0

  for (let step = 0; step < steps && accumulator.primitives.length < accumulator.limit; step++) {
    const phase = step / steps
    const horizontalRadius = (1.45 + Math.sin(phase * Math.PI) * width) * (0.88 + random() * 0.18)
    const verticalRadius = horizontalRadius * (2.05 + random() * 0.55)
    const horizontal = Math.cos(pitch)
    x += Math.cos(yaw) * horizontal
    y += Math.sin(pitch)
    z += Math.sin(yaw) * horizontal
    accumulator.push({
      kind: 'ravine', x, y, z,
      rx: horizontalRadius,
      ry: verticalRadius,
      rz: horizontalRadius,
      branchId,
      parentBranchId: null
    })

    pitch *= 0.7
    pitch += pitchVelocity * 0.05
    yaw += yawVelocity * 0.05
    pitchVelocity *= 0.8
    yawVelocity *= 0.5
    pitchVelocity += (random() - random()) * random() * 0.8
    yawVelocity += (random() - random()) * random() * 2.2
  }
  if (accumulator.primitives.length === 0) return null
  return {
    kind: 'ravine', sourceCx, sourceCz,
    branchCount: accumulator.branchCount,
    primitives: accumulator.primitives,
    bounds: accumulator.bounds
  }
}

function lakeMaskIndex(x: number, y: number, z: number): number {
  return ((x * 16 + z) * 8 + y)
}

function lakeMaskBoundary(mask: Uint8Array, x: number, y: number, z: number): boolean {
  if (mask[lakeMaskIndex(x, y, z)]) return false
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const nx = x + dx, ny = y + dy, nz = z + dz
    if (nx < 0 || nx >= 16 || ny < 0 || ny >= 8 || nz < 0 || nz >= 16) continue
    if (mask[lakeMaskIndex(nx, ny, nz)]) return true
  }
  return false
}

function makeLakePlan(
  seed: number,
  sourceCx: number,
  sourceCz: number,
  kind: LakeKind,
  sampler: CarverBaseSampler
): LakePlan | null {
  const salt = kind === 'water' ? WATER_LAKE_SALT : LAVA_LAKE_SALT
  const random = mulberry32(hash2(sourceCx, sourceCz, seed ^ salt))
  if (nextInt(random, kind === 'water' ? 4 : 8) !== 0) return null

  const originX = sourceCx * CHUNK_SIZE + nextInt(random, CHUNK_SIZE)
  const originZ = sourceCz * CHUNK_SIZE + nextInt(random, CHUNK_SIZE)
  const centerX = originX + 8
  const centerZ = originZ + 8
  const biome = sampler.biomeAt(centerX, centerZ)
  if (sampler.allowLake && !sampler.allowLake(kind, centerX, centerZ, biome)) return null

  const requestedY = kind === 'water'
    ? nextInt(random, WORLD_HEIGHT)
    : nextInt(random, nextInt(random, WORLD_HEIGHT - 8) + 8)
  let anchorY = clamp(requestedY, 5, WORLD_HEIGHT - 2)
  while (anchorY > 5 && sampler.baseBlockAt(centerX, anchorY, centerZ) === B.AIR) anchorY--
  if (kind === 'lava' && anchorY >= sampler.surfaceY(centerX, centerZ) && nextInt(random, 10) !== 0) return null
  const originY = anchorY - 4
  if (originY < 2 || originY + 7 >= WORLD_HEIGHT) return null

  const mask = new Uint8Array(16 * 16 * 8)
  const ellipsoids = 4 + nextInt(random, 4)
  for (let ellipse = 0; ellipse < ellipsoids; ellipse++) {
    const sizeX = random() * 6 + 3
    const sizeY = random() * 4 + 2
    const sizeZ = random() * 6 + 3
    const centerLocalX = random() * (16 - sizeX - 2) + 1 + sizeX / 2
    const centerLocalY = random() * (8 - sizeY - 2) + 1 + sizeY / 2
    const centerLocalZ = random() * (16 - sizeZ - 2) + 1 + sizeZ / 2
    for (let x = 1; x < 15; x++) for (let z = 1; z < 15; z++) for (let y = 1; y < 7; y++) {
      const dx = (x - centerLocalX) / (sizeX / 2)
      const dy = (y - centerLocalY) / (sizeY / 2)
      const dz = (z - centerLocalZ) / (sizeZ / 2)
      if (dx * dx + dy * dy + dz * dz < 1) mask[lakeMaskIndex(x, y, z)] = 1
    }
  }

  // A single, global acceptance decision prevents one half of a cross-chunk
  // lake from being accepted while the other half is rejected.
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 8; y++) {
    if (!lakeMaskBoundary(mask, x, y, z)) continue
    const id = sampler.baseBlockAt(originX + x, originY + y, originZ + z)
    if (y >= 4 ? isFluid(id) : !SOLID[id]) return null
  }

  const bounds = emptyBounds()
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 8; y++) {
    if (mask[lakeMaskIndex(x, y, z)]) includeCell(bounds, originX + x, originY + y, originZ + z)
  }
  if (!Number.isFinite(bounds.minX)) return null
  return {
    kind, sourceCx, sourceCz, biome,
    originX, originY, originZ,
    liquid: kind === 'water' ? B.WATER : B.LAVA,
    mask,
    bounds
  }
}

function primitiveTouchesWater(primitive: CarvePrimitive, sampler: CarverBaseSampler): boolean {
  const hx = primitive.rx + 1
  const hy = primitive.ry + 1
  const hz = primitive.rz + 1
  const minX = Math.floor(primitive.x - hx), maxX = Math.floor(primitive.x + hx)
  const minY = Math.max(1, Math.floor(primitive.y - hy)), maxY = Math.min(WORLD_HEIGHT - 1, Math.floor(primitive.y + hy))
  const minZ = Math.floor(primitive.z - hz), maxZ = Math.floor(primitive.z + hz)
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) for (let y = minY; y <= maxY; y++) {
    const dx = (x + 0.5 - primitive.x) / hx
    const dy = (y + 0.5 - primitive.y) / hy
    const dz = (z + 0.5 - primitive.z) / hz
    if (dx * dx + dy * dy + dz * dz > 1) continue
    if (isWater(sampler.baseBlockAt(x, y, z))) return true
  }
  return false
}

function stampPrimitive(chunk: Chunk, primitive: CarvePrimitive): number {
  const chunkX = chunk.cx * CHUNK_SIZE
  const chunkZ = chunk.cz * CHUNK_SIZE
  const minX = Math.max(chunkX, Math.floor(primitive.x - primitive.rx))
  const maxX = Math.min(chunkX + CHUNK_SIZE - 1, Math.floor(primitive.x + primitive.rx))
  const minY = Math.max(2, Math.floor(primitive.y - primitive.ry))
  const maxY = Math.min(WORLD_HEIGHT - 2, Math.floor(primitive.y + primitive.ry))
  const minZ = Math.max(chunkZ, Math.floor(primitive.z - primitive.rz))
  const maxZ = Math.min(chunkZ + CHUNK_SIZE - 1, Math.floor(primitive.z + primitive.rz))
  if (minX > maxX || minY > maxY || minZ > maxZ) return 0

  let changed = 0
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) for (let y = minY; y <= maxY; y++) {
    const dx = (x + 0.5 - primitive.x) / primitive.rx
    const dy = (y + 0.5 - primitive.y) / primitive.ry
    const dz = (z + 0.5 - primitive.z) / primitive.rz
    if (dx * dx + dy * dy + dz * dz >= 1) continue
    const index = Chunk.index(x - chunkX, y, z - chunkZ)
    if (!carvable(chunk.blocks[index])) continue
    chunk.blocks[index] = y <= DEEP_LAVA_TOP ? B.LAVA : B.AIR
    changed++
  }
  return changed
}

/**
 * Pure, order-independent cave/ravine/lake planner. Every destination chunk
 * replays plans from surrounding source chunks and writes only into itself.
 */
export class MapCarvers {
  readonly seed: number
  private caveCache = new Map<string, CarvePlan | null>()
  private ravineCache = new Map<string, CarvePlan | null>()
  private lakeCaches = new WeakMap<CarverBaseSampler, Map<string, readonly LakePlan[]>>()
  private waterVetoCaches = new WeakMap<CarverBaseSampler, WeakMap<CarvePlan, Uint8Array>>()

  constructor(seed: number) { this.seed = seed | 0 }

  cavePlanFor(sourceCx: number, sourceCz: number): CarvePlan | null {
    const key = sourceKey(sourceCx, sourceCz)
    if (this.caveCache.has(key)) return this.caveCache.get(key) ?? null
    return rememberBounded(this.caveCache, key, makeCavePlan(this.seed, sourceCx, sourceCz))
  }

  ravinePlanFor(sourceCx: number, sourceCz: number): CarvePlan | null {
    const key = sourceKey(sourceCx, sourceCz)
    if (this.ravineCache.has(key)) return this.ravineCache.get(key) ?? null
    return rememberBounded(this.ravineCache, key, makeRavinePlan(this.seed, sourceCx, sourceCz))
  }

  lakePlansFor(sourceCx: number, sourceCz: number, sampler: CarverBaseSampler): readonly LakePlan[] {
    let cache = this.lakeCaches.get(sampler)
    if (!cache) {
      cache = new Map()
      this.lakeCaches.set(sampler, cache)
    }
    const key = sourceKey(sourceCx, sourceCz)
    const cached = cache.get(key)
    if (cached) return cached
    const plans: LakePlan[] = []
    const water = makeLakePlan(this.seed, sourceCx, sourceCz, 'water', sampler)
    const lava = makeLakePlan(this.seed, sourceCx, sourceCz, 'lava', sampler)
    if (water) plans.push(water)
    if (lava) plans.push(lava)
    return rememberBounded(cache, key, plans)
  }

  cacheStatsFor(sampler?: CarverBaseSampler): MapCarverCacheStats {
    return {
      cavePlans: this.caveCache.size,
      ravinePlans: this.ravineCache.size,
      lakePlans: sampler ? this.lakeCaches.get(sampler)?.size ?? 0 : 0
    }
  }

  clearCaches(): void {
    this.caveCache.clear()
    this.ravineCache.clear()
    this.lakeCaches = new WeakMap()
    this.waterVetoCaches = new WeakMap()
  }

  /** Diagnostic seam used by tests and by future structure-aware population. */
  stampCarvePlanInto(chunk: Chunk, plan: CarvePlan, sampler: CarverBaseSampler): StampStats {
    const veto = new Uint8Array(plan.primitives.length)
    for (let i = 0; i < plan.primitives.length; i++) {
      if (primitiveTouchesWater(plan.primitives[i], sampler)) veto[i] = 1
    }
    return this.stampCarvePlan(chunk, plan, veto)
  }

  /** Diagnostic seam for a single already accepted lake plan. */
  stampLakePlanInto(chunk: Chunk, plan: LakePlan): number {
    if (!boundsIntersectChunk(plan.bounds, chunk)) return 0
    const chunkX = chunk.cx * CHUNK_SIZE
    const chunkZ = chunk.cz * CHUNK_SIZE
    let changed = 0
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 8; y++) {
      if (!plan.mask[lakeMaskIndex(x, y, z)]) continue
      const wx = plan.originX + x, wy = plan.originY + y, wz = plan.originZ + z
      if (wy <= 1 || wy >= WORLD_HEIGHT || Math.floor(wx / CHUNK_SIZE) !== chunk.cx || Math.floor(wz / CHUNK_SIZE) !== chunk.cz) continue
      const index = Chunk.index(wx - chunkX, wy, wz - chunkZ)
      if (chunk.blocks[index] === B.BEDROCK) continue
      const next = y >= 4 ? B.AIR : plan.liquid
      if (chunk.blocks[index] === next) continue
      chunk.blocks[index] = next
      changed++
    }
    return changed
  }

  carveChunk(chunk: Chunk, sampler: CarverBaseSampler): CarveChunkStats {
    const stats: CarveChunkStats = {
      cavePlans: 0, ravinePlans: 0, lakePlans: 0,
      primitivesTested: 0, primitivesStamped: 0, blocksChanged: 0
    }
    for (let sourceCx = chunk.cx - CARVER_SOURCE_RADIUS; sourceCx <= chunk.cx + CARVER_SOURCE_RADIUS; sourceCx++) {
      for (let sourceCz = chunk.cz - CARVER_SOURCE_RADIUS; sourceCz <= chunk.cz + CARVER_SOURCE_RADIUS; sourceCz++) {
        const cave = this.cavePlanFor(sourceCx, sourceCz)
        if (cave && boundsIntersectChunk(cave.bounds, chunk)) {
          stats.cavePlans++
          this.addStampStats(stats, this.stampCarvePlan(chunk, cave, this.waterVetoFor(cave, sampler)))
        }
        const ravine = this.ravinePlanFor(sourceCx, sourceCz)
        if (ravine && boundsIntersectChunk(ravine.bounds, chunk)) {
          stats.ravinePlans++
          this.addStampStats(stats, this.stampCarvePlan(chunk, ravine, this.waterVetoFor(ravine, sampler)))
        }
      }
    }

    // A vanilla-sized 16x8x16 lake begins inside its source chunk and can
    // reach only that chunk and its positive X/Z neighbors.
    for (let sourceCx = chunk.cx - 1; sourceCx <= chunk.cx; sourceCx++) {
      for (let sourceCz = chunk.cz - 1; sourceCz <= chunk.cz; sourceCz++) {
        for (const lake of this.lakePlansFor(sourceCx, sourceCz, sampler)) {
          if (!boundsIntersectChunk(lake.bounds, chunk)) continue
          stats.lakePlans++
          stats.blocksChanged += this.stampLakePlanInto(chunk, lake)
        }
      }
    }
    return stats
  }

  private addStampStats(target: CarveChunkStats, addition: StampStats): void {
    target.primitivesTested += addition.primitivesTested
    target.primitivesStamped += addition.primitivesStamped
    target.blocksChanged += addition.blocksChanged
  }

  private waterVetoFor(plan: CarvePlan, sampler: CarverBaseSampler): Uint8Array {
    let plans = this.waterVetoCaches.get(sampler)
    if (!plans) {
      plans = new WeakMap()
      this.waterVetoCaches.set(sampler, plans)
    }
    const cached = plans.get(plan)
    if (cached) return cached
    const veto = new Uint8Array(plan.primitives.length)
    for (let i = 0; i < plan.primitives.length; i++) {
      if (primitiveTouchesWater(plan.primitives[i], sampler)) veto[i] = 1
    }
    plans.set(plan, veto)
    return veto
  }

  private stampCarvePlan(chunk: Chunk, plan: CarvePlan, veto: Uint8Array): StampStats {
    const stats: StampStats = { primitivesTested: 0, primitivesStamped: 0, blocksChanged: 0 }
    if (!boundsIntersectChunk(plan.bounds, chunk)) return stats
    for (let i = 0; i < plan.primitives.length; i++) {
      const primitive = plan.primitives[i]
      if (!primitiveIntersectsChunk(primitive, chunk)) continue
      stats.primitivesTested++
      if (veto[i]) continue
      const changed = stampPrimitive(chunk, primitive)
      if (changed > 0) stats.primitivesStamped++
      stats.blocksChanged += changed
    }
    return stats
  }
}
