import { B, SOLID, isFluid } from './Blocks'
import { BIOME } from './Biomes'
import { Chunk } from './Chunk'
import { JavaRandom, long } from './JavaRandom'

type LakeKind = 'water' | 'lava'

export interface VanillaLakeSampler {
  blockAt(x: number, y: number, z: number): number
  biomeAt(x: number, z: number): number
  surfaceY?(x: number, z: number): number
  villageCandidate?(regionX: number, regionZ: number): { cx: number; cz: number }
}

interface LakePlacement {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly block: number
}

interface LakePlan {
  readonly kind: LakeKind
  readonly placements: readonly LakePlacement[]
}

const CACHE_LIMIT = 1024
const MASK_SIZE = 16 * 16 * 8

function maskIndex(x: number, y: number, z: number): number { return (x * 16 + z) * 8 + y }

function isBoundary(mask: Uint8Array, x: number, y: number, z: number): boolean {
  if (mask[maskIndex(x, y, z)]) return false
  return (x < 15 && !!mask[maskIndex(x + 1, y, z)]) ||
    (x > 0 && !!mask[maskIndex(x - 1, y, z)]) ||
    (z < 15 && !!mask[maskIndex(x, y, z + 1)]) ||
    (z > 0 && !!mask[maskIndex(x, y, z - 1)]) ||
    (y < 7 && !!mask[maskIndex(x, y + 1, z)]) ||
    (y > 0 && !!mask[maskIndex(x, y - 1, z)])
}

function populationOdd(value: bigint): bigint { return long(value / 2n * 2n + 1n) }

/**
 * Population-stage WorldGenLakes port. Plans are replayed into destination
 * chunks so streaming order cannot clip a lake at a chunk boundary.
 */
export class VanillaLakes {
  private caches = new WeakMap<VanillaLakeSampler, Map<string, readonly LakePlan[]>>()

  constructor(readonly seed: bigint) {}

  stampChunk(chunk: Chunk, sampler: VanillaLakeSampler): number {
    let changed = 0
    for (let sourceCx = chunk.cx - 1; sourceCx <= chunk.cx; sourceCx++) {
      for (let sourceCz = chunk.cz - 1; sourceCz <= chunk.cz; sourceCz++) {
        for (const plan of this.plansFor(sourceCx, sourceCz, sampler)) {
          for (const placement of plan.placements) {
            if (Math.floor(placement.x / 16) !== chunk.cx ||
              Math.floor(placement.z / 16) !== chunk.cz ||
              placement.y < 0 || placement.y >= 128) continue
            const index = Chunk.index(
              placement.x - chunk.cx * 16,
              placement.y,
              placement.z - chunk.cz * 16
            )
            if (chunk.blocks[index] === placement.block) continue
            chunk.blocks[index] = placement.block
            changed++
          }
        }
      }
    }
    return changed
  }

  clearCaches(): void { this.caches = new WeakMap() }

  private plansFor(sourceCx: number, sourceCz: number, sampler: VanillaLakeSampler): readonly LakePlan[] {
    let cache = this.caches.get(sampler)
    if (!cache) {
      cache = new Map()
      this.caches.set(sampler, cache)
    }
    const key = `${sourceCx},${sourceCz}`
    const cached = cache.get(key)
    if (cached) return cached

    const random = new JavaRandom(this.seed)
    const xMultiplier = populationOdd(random.nextLong())
    const zMultiplier = populationOdd(random.nextLong())
    random.setSeed(long(long(BigInt(sourceCx) * xMultiplier + BigInt(sourceCz) * zMultiplier) ^ this.seed))
    const plans: LakePlan[] = []
    const village = this.hasVillageStart(sourceCx, sourceCz, sampler)
    const sourceX = sourceCx * 16, sourceZ = sourceCz * 16
    if (!village && random.nextInt(4) === 0) {
      const x = sourceX + random.nextInt(16) + 8
      const y = random.nextInt(128)
      const z = sourceZ + random.nextInt(16) + 8
      const plan = this.createPlan('water', random, x, y, z, sampler)
      if (plan) plans.push(plan)
    }
    if (!village && random.nextInt(8) === 0) {
      const x = sourceX + random.nextInt(16) + 8
      const y = random.nextInt(random.nextInt(120) + 8)
      const z = sourceZ + random.nextInt(16) + 8
      if (y < 63 || random.nextInt(10) === 0) {
        const plan = this.createPlan('lava', random, x, y, z, sampler)
        if (plan) plans.push(plan)
      }
    }
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, plans)
    return plans
  }

  private hasVillageStart(sourceCx: number, sourceCz: number, sampler: VanillaLakeSampler): boolean {
    if (!sampler.villageCandidate || !sampler.surfaceY) return false
    const centerRegionX = Math.floor(sourceCx / 32), centerRegionZ = Math.floor(sourceCz / 32)
    for (let regionX = centerRegionX - 1; regionX <= centerRegionX + 1; regionX++) {
      for (let regionZ = centerRegionZ - 1; regionZ <= centerRegionZ + 1; regionZ++) {
        const candidate = sampler.villageCandidate(regionX, regionZ)
        if (candidate.cx !== sourceCx || candidate.cz !== sourceCz) continue
        const x = sourceCx * 16 + 8, z = sourceCz * 16 + 8
        const biome = sampler.biomeAt(x, z)
        const height = sampler.surfaceY(x, z)
        if ((biome === BIOME.PLAINS || biome === BIOME.DESERT) && height >= 42 && height <= 72) return true
      }
    }
    return false
  }

  private createPlan(
    kind: LakeKind,
    random: JavaRandom,
    chosenX: number,
    chosenY: number,
    chosenZ: number,
    sampler: VanillaLakeSampler
  ): LakePlan | null {
    const originX = chosenX - 8, originZ = chosenZ - 8
    let originY = chosenY
    while (originY > 5 && sampler.blockAt(originX, originY, originZ) === B.AIR) originY--
    if (originY <= 4) return null
    originY -= 4

    const mask = new Uint8Array(MASK_SIZE)
    const ellipsoids = random.nextInt(4) + 4
    for (let ellipse = 0; ellipse < ellipsoids; ellipse++) {
      const diameterX = random.nextDouble() * 6 + 3
      const diameterY = random.nextDouble() * 4 + 2
      const diameterZ = random.nextDouble() * 6 + 3
      const centerX = random.nextDouble() * (16 - diameterX - 2) + 1 + diameterX / 2
      const centerY = random.nextDouble() * (8 - diameterY - 4) + 2 + diameterY / 2
      const centerZ = random.nextDouble() * (16 - diameterZ - 2) + 1 + diameterZ / 2
      for (let x = 1; x < 15; x++) for (let z = 1; z < 15; z++) for (let y = 1; y < 7; y++) {
        const dx = (x - centerX) / (diameterX / 2)
        const dy = (y - centerY) / (diameterY / 2)
        const dz = (z - centerZ) / (diameterZ / 2)
        if (dx * dx + dy * dy + dz * dz < 1) mask[maskIndex(x, y, z)] = 1
      }
    }

    const liquid = kind === 'water' ? B.WATER : B.LAVA
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 8; y++) {
      if (!isBoundary(mask, x, y, z)) continue
      const block = sampler.blockAt(originX + x, originY + y, originZ + z)
      if (y >= 4 && isFluid(block)) return null
      if (y < 4 && !SOLID[block] && block !== liquid) return null
    }

    const placements: LakePlacement[] = []
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 8; y++) {
      if (mask[maskIndex(x, y, z)]) {
        placements.push({ x: originX + x, y: originY + y, z: originZ + z, block: y < 4 ? liquid : B.AIR })
      }
    }

    // Re-expose grass/mycelium around the upper cavity.
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 4; y < 8; y++) {
      if (!mask[maskIndex(x, y, z)]) continue
      const belowY = originY + y - 1
      if (sampler.blockAt(originX + x, belowY, originZ + z) !== B.DIRT) continue
      const biome = sampler.biomeAt(originX + x, originZ + z)
      placements.push({
        x: originX + x, y: belowY, z: originZ + z,
        block: biome === BIOME.MUSHROOM ? B.MYCELIUM : B.GRASS
      })
    }

    if (kind === 'lava') {
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 8; y++) {
        if (!isBoundary(mask, x, y, z) || (y >= 4 && random.nextInt(2) === 0)) continue
        const block = sampler.blockAt(originX + x, originY + y, originZ + z)
        if (SOLID[block]) placements.push({
          x: originX + x, y: originY + y, z: originZ + z, block: B.STONE
        })
      }
    }
    return { kind, placements }
  }
}
