import { B } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { hash2, mulberry32 } from '../util/math'

type Random = () => number

export interface OreProfile {
  readonly key: 'dirt' | 'gravel' | 'coal' | 'iron' | 'gold' | 'redstone' | 'diamond' | 'lapis'
  readonly block: number
  readonly attempts: number
  readonly size: number
  readonly height: 'uniform128' | 'uniform64' | 'uniform32' | 'uniform16' | 'triangular16'
}

export interface OreEllipsoid {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly radiusX: number
  readonly radiusY: number
}

export interface OreVeinPlan {
  readonly id: string
  readonly sourceCx: number
  readonly sourceCz: number
  readonly sequence: number
  readonly profile: OreProfile
  /** Coordinates passed to WorldGenMinable, before its classic +8 X/Z offset. */
  readonly startX: number
  readonly startY: number
  readonly startZ: number
  readonly ellipsoids: readonly OreEllipsoid[]
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly minZ: number
  readonly maxZ: number
}

/**
 * The exact ChunkProviderGenerate/BiomeDecorator ore pass used by the 1.2 era.
 * Counts, vein sizes and height distributions intentionally stay data-driven so
 * tests can guard every entry rather than sampling a lucky seed.
 */
export const ORE_PROFILES: readonly OreProfile[] = [
  { key: 'dirt', block: B.DIRT, attempts: 20, size: 32, height: 'uniform128' },
  { key: 'gravel', block: B.GRAVEL, attempts: 10, size: 32, height: 'uniform128' },
  { key: 'coal', block: B.COAL_ORE, attempts: 20, size: 16, height: 'uniform128' },
  { key: 'iron', block: B.IRON_ORE, attempts: 20, size: 8, height: 'uniform64' },
  { key: 'gold', block: B.GOLD_ORE, attempts: 2, size: 8, height: 'uniform32' },
  { key: 'redstone', block: B.REDSTONE_ORE, attempts: 8, size: 7, height: 'uniform16' },
  { key: 'diamond', block: B.DIAMOND_ORE, attempts: 1, size: 7, height: 'uniform16' },
  { key: 'lapis', block: B.LAPIS_ORE, attempts: 1, size: 6, height: 'triangular16' }
] as const

const PLAN_CACHE_LIMIT = 128

function nextInt(random: Random, bound: number): number {
  return Math.floor(random() * bound)
}

function oreY(random: Random, distribution: OreProfile['height']): number {
  if (distribution === 'uniform128') return nextInt(random, 128)
  if (distribution === 'uniform64') return nextInt(random, 64)
  if (distribution === 'uniform32') return nextInt(random, 32)
  if (distribution === 'uniform16') return nextInt(random, 16)
  return nextInt(random, 16) + nextInt(random, 16)
}

function intersectsChunk(plan: OreVeinPlan, cx: number, cz: number): boolean {
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE
  return plan.maxX >= x0 && plan.minX < x0 + CHUNK_SIZE &&
    plan.maxZ >= z0 && plan.minZ < z0 + CHUNK_SIZE
}

function buildVein(
  random: Random,
  sourceCx: number,
  sourceCz: number,
  sequence: number,
  profile: OreProfile,
  startX: number,
  startY: number,
  startZ: number
): OreVeinPlan {
  // WorldGenMinable 1.2.4: a short angled segment whose samples become
  // overlapping, independently widened XZ/Y ellipsoids.
  const angle = random() * Math.PI
  const xA = startX + 8 + Math.sin(angle) * profile.size / 8
  const xB = startX + 8 - Math.sin(angle) * profile.size / 8
  const zA = startZ + 8 + Math.cos(angle) * profile.size / 8
  const zB = startZ + 8 - Math.cos(angle) * profile.size / 8
  const yA = startY + nextInt(random, 3) - 2
  const yB = startY + nextInt(random, 3) - 2
  const ellipsoids: OreEllipsoid[] = []
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (let step = 0; step <= profile.size; step++) {
    const t = step / profile.size
    const x = xA + (xB - xA) * t
    const y = yA + (yB - yA) * t
    const z = zA + (zB - zA) * t
    // The classic routine draws one diameter noise value and reuses it for
    // both the horizontal and vertical envelope at this step.
    const diameterNoise = random() * profile.size / 16
    const envelope = Math.sin(step * Math.PI / profile.size) + 1
    const radiusX = (envelope * diameterNoise + 1) / 2
    const radiusY = radiusX
    ellipsoids.push({ x, y, z, radiusX, radiusY })
    minX = Math.min(minX, Math.floor(x - radiusX))
    maxX = Math.max(maxX, Math.floor(x + radiusX))
    minY = Math.min(minY, Math.floor(y - radiusY))
    maxY = Math.max(maxY, Math.floor(y + radiusY))
    minZ = Math.min(minZ, Math.floor(z - radiusX))
    maxZ = Math.max(maxZ, Math.floor(z + radiusX))
  }

  return {
    id: `ore:${sourceCx},${sourceCz}:${sequence}:${profile.key}`,
    sourceCx, sourceCz, sequence, profile, startX, startY, startZ,
    ellipsoids, minX, maxX, minY, maxY, minZ, maxZ
  }
}

/** Deterministic, destination-clipped replay of the classic ore population pass. */
export class OreGenerator {
  private readonly cache = new Map<string, readonly OreVeinPlan[]>()

  constructor(readonly seed: number) {}

  plansForSource(sourceCx: number, sourceCz: number): readonly OreVeinPlan[] {
    const cacheKey = `${sourceCx},${sourceCz}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const random = mulberry32(hash2(sourceCx, sourceCz, this.seed ^ 0x0ee5cafe))
    const plans: OreVeinPlan[] = []
    let sequence = 0
    for (const profile of ORE_PROFILES) {
      for (let attempt = 0; attempt < profile.attempts; attempt++) {
        const startX = sourceCx * CHUNK_SIZE + nextInt(random, CHUNK_SIZE)
        const startY = oreY(random, profile.height)
        const startZ = sourceCz * CHUNK_SIZE + nextInt(random, CHUNK_SIZE)
        plans.push(buildVein(
          random, sourceCx, sourceCz, sequence++, profile, startX, startY, startZ
        ))
      }
    }

    if (this.cache.size >= PLAN_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(cacheKey, plans)
    return plans
  }

  plansForChunk(cx: number, cz: number): OreVeinPlan[] {
    const plans: OreVeinPlan[] = []
    // WorldGenMinable adds +8 to a start chosen in [0, 15]. Even a size-32
    // vein can therefore touch only its source chunk or the positive neighbour.
    for (let sourceCx = cx - 1; sourceCx <= cx; sourceCx++) {
      for (let sourceCz = cz - 1; sourceCz <= cz; sourceCz++) {
        for (const plan of this.plansForSource(sourceCx, sourceCz)) {
          if (intersectsChunk(plan, cx, cz)) plans.push(plan)
        }
      }
    }
    return plans.sort((a, b) =>
      a.sourceCx - b.sourceCx || a.sourceCz - b.sourceCz || a.sequence - b.sequence
    )
  }

  stampChunk(chunk: Chunk): void {
    for (const plan of this.plansForChunk(chunk.cx, chunk.cz)) {
      this.stampPlanInto(chunk, plan)
    }
  }

  /** Replay one selected vein into one destination, useful for arbitration and exact seam verification. */
  stampPlanInto(chunk: Chunk, plan: OreVeinPlan): void {
    if (!intersectsChunk(plan, chunk.cx, chunk.cz)) return
    for (const ellipsoid of plan.ellipsoids) this.stampEllipsoid(chunk, plan.profile.block, ellipsoid)
  }

  cacheSize(): number { return this.cache.size }

  private stampEllipsoid(chunk: Chunk, oreId: number, ellipsoid: OreEllipsoid): void {
    const bx = chunk.cx * CHUNK_SIZE, bz = chunk.cz * CHUNK_SIZE
    const minX = Math.max(bx, Math.floor(ellipsoid.x - ellipsoid.radiusX))
    const maxX = Math.min(bx + CHUNK_SIZE - 1, Math.floor(ellipsoid.x + ellipsoid.radiusX))
    const minY = Math.max(0, Math.floor(ellipsoid.y - ellipsoid.radiusY))
    const maxY = Math.min(WORLD_HEIGHT - 1, Math.floor(ellipsoid.y + ellipsoid.radiusY))
    const minZ = Math.max(bz, Math.floor(ellipsoid.z - ellipsoid.radiusX))
    const maxZ = Math.min(bz + CHUNK_SIZE - 1, Math.floor(ellipsoid.z + ellipsoid.radiusX))
    if (minX > maxX || minY > maxY || minZ > maxZ) return

    for (let x = minX; x <= maxX; x++) {
      const nx = (x + 0.5 - ellipsoid.x) / ellipsoid.radiusX
      const nxSq = nx * nx
      if (nxSq >= 1) continue
      for (let y = minY; y <= maxY; y++) {
        const ny = (y + 0.5 - ellipsoid.y) / ellipsoid.radiusY
        const nxySq = nxSq + ny * ny
        if (nxySq >= 1) continue
        for (let z = minZ; z <= maxZ; z++) {
          const nz = (z + 0.5 - ellipsoid.z) / ellipsoid.radiusX
          if (nxySq + nz * nz >= 1) continue
          const index = Chunk.index(x - bx, y, z - bz)
          if (chunk.blocks[index] === B.STONE) chunk.blocks[index] = oreId
        }
      }
    }
  }
}
