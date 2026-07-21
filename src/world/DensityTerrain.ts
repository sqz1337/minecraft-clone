import { SimplexNoise, fbm2, fbm3 } from '../util/Noise'
import { clamp, hash2, hash3, lerp, smoothstep } from '../util/math'
import { B } from './Blocks'
import { BIOME, terrainProfileForBiome, type BiomeTerrainProfile } from './Biomes'
import { BiomeMap, type BiomeSample, type BiomeSource } from './BiomeMap'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'

export const DENSITY_SEA_LEVEL = 63
export const DENSITY_HORIZONTAL_STEP = 4
export const DENSITY_VERTICAL_STEP = 8
export const DENSITY_LATTICE_HEIGHT = WORLD_HEIGHT / DENSITY_VERTICAL_STEP + 1
export const DENSITY_LATTICE_CACHE_LIMIT = 8_192
export const DENSITY_COLUMN_CACHE_LIMIT = 16_384

const LOW_NOISE_SALT = 0x1a2b3c4d
const HIGH_NOISE_SALT = 0x2b3c4d5e
const SELECT_NOISE_SALT = 0x3c4d5e6f
const DEPTH_NOISE_SALT = 0x4d5e6f70
const SURFACE_NOISE_SALT = 0x5e6f7081
const BEDROCK_SALT = 0x6f708192
const SURFACE_RANDOM_SALT = 0x708192a3
const OCEAN_MATERIAL_SALT = 0x8192a3b4
const SANDSTONE_SALT = 0x192a3b4c

export interface DensityTerrainColumnInfo {
  /** Highest natural non-fluid block before map carvers and population. */
  readonly height: number
  readonly biome: number
  readonly surfaceDepth: number
}

export interface DensityTerrainCacheStats {
  readonly latticeColumns: number
  readonly blockColumns: number
}

export interface SmoothedTerrainProfile extends BiomeTerrainProfile {
  /** Absolute block coordinate of the 4x4 density-lattice column. */
  readonly x: number
  readonly z: number
}

interface TerrainColumn {
  readonly blocks: Uint8Array
  readonly info: DensityTerrainColumnInfo
}

interface SurfaceMaterials {
  readonly top: number
  readonly filler: number
}

const PARABOLIC_WEIGHTS = (() => {
  const weights = new Float64Array(25)
  let index = 0
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    weights[index++] = 10 / Math.sqrt(dx * dx + dz * dz + 0.2)
  }
  return weights
})()

function cacheKey(x: number, z: number): string { return `${x},${z}` }

function rememberBounded<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  if (!cache.has(key) && cache.size >= limit) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

function profileForSample(sample: BiomeSample): BiomeTerrainProfile {
  const profile = terrainProfileForBiome(sample.biome)
  if (!sample.hill || sample.biome === BIOME.MOUNTAIN) return profile
  return {
    rootHeight: profile.rootHeight + 0.38,
    variation: profile.variation + 0.24
  }
}

function surfaceMaterials(sample: BiomeSample, x: number, z: number, y: number, seed: number): SurfaceMaterials {
  if (sample.biome === BIOME.OCEAN) {
    const gravel = hash2(x, z, seed ^ OCEAN_MATERIAL_SALT) % 100 < 38
    return gravel ? { top: B.GRAVEL, filler: B.GRAVEL } : { top: B.SAND, filler: B.SAND }
  }
  if (sample.biome === BIOME.BEACH || sample.biome === BIOME.DESERT) {
    return { top: B.SAND, filler: B.SAND }
  }
  if (sample.biome === BIOME.RIVER) return { top: B.GRAVEL, filler: B.DIRT }
  if (sample.biome === BIOME.SNOW) return { top: B.SNOW, filler: B.DIRT }
  if (sample.biome === BIOME.MOUNTAIN && (sample.hill || y >= DENSITY_SEA_LEVEL + 18)) {
    return { top: B.STONE, filler: B.STONE }
  }
  if (sample.biome === BIOME.MUSHROOM) return { top: B.MYCELIUM, filler: B.DIRT }
  return { top: B.GRASS, filler: B.DIRT }
}

/**
 * A 1.2-shaped 3D density generator using Realmcraft's seeded Simplex noise.
 * It is deliberately coordinate-pure: chunks, arbitrary block samples and
 * structure/carver probes all observe the same immutable base columns.
 */
export class DensityTerrain {
  readonly seaLevel = DENSITY_SEA_LEVEL
  readonly biomeSource: BiomeSource

  private readonly lowNoise: SimplexNoise
  private readonly highNoise: SimplexNoise
  private readonly selectNoise: SimplexNoise
  private readonly depthNoise: SimplexNoise
  private readonly surfaceNoise: SimplexNoise
  private readonly latticeCache = new Map<string, Float32Array>()
  private readonly columnCache = new Map<string, TerrainColumn>()

  constructor(readonly seed: number, biomeSource?: BiomeSource) {
    this.biomeSource = biomeSource ?? new BiomeMap(seed)
    this.lowNoise = new SimplexNoise(seed ^ LOW_NOISE_SALT)
    this.highNoise = new SimplexNoise(seed ^ HIGH_NOISE_SALT)
    this.selectNoise = new SimplexNoise(seed ^ SELECT_NOISE_SALT)
    this.depthNoise = new SimplexNoise(seed ^ DEPTH_NOISE_SALT)
    this.surfaceNoise = new SimplexNoise(seed ^ SURFACE_NOISE_SALT)
  }

  biomeAt(x: number, z: number): number { return this.biomeSource.biomeAt(Math.floor(x), Math.floor(z)) }

  columnInfo(x: number, z: number): DensityTerrainColumnInfo {
    const info = this.columnAt(Math.floor(x), Math.floor(z)).info
    return { height: info.height, biome: info.biome, surfaceDepth: info.surfaceDepth }
  }

  surfaceY(x: number, z: number): number { return this.columnInfo(x, z).height }

  surfaceDepthAt(x: number, z: number): number {
    return this.columnAt(Math.floor(x), Math.floor(z)).info.surfaceDepth
  }

  /** Diagnostic/profile seam also used to verify the vanilla-shaped 5x5 blend. */
  smoothedProfileAt(x: number, z: number): SmoothedTerrainProfile {
    const gx = Math.floor(x / DENSITY_HORIZONTAL_STEP)
    const gz = Math.floor(z / DENSITY_HORIZONTAL_STEP)
    const profile = this.blendedProfile(gx, gz)
    return { x: gx * DENSITY_HORIZONTAL_STEP, z: gz * DENSITY_HORIZONTAL_STEP, ...profile }
  }

  blockAt(x: number, y: number, z: number): number {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    return this.columnAt(x, z).blocks[y]
  }

  /** Fill only the immutable terrain baseline; no carvers, ores or population. */
  copyInto(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SIZE, baseZ = chunk.cz * CHUNK_SIZE
    for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const column = this.columnAt(baseX + lx, baseZ + lz)
      const columnIndex = (lx << 4) | lz
      chunk.blocks.set(column.blocks, columnIndex << 7)
      chunk.colHeight[columnIndex] = column.info.height
      chunk.colBiome[columnIndex] = column.info.biome
    }
  }

  /** Continuous density before sea fill, surface replacement and bedrock. */
  sampleDensity(x: number, y: number, z: number): number {
    if (y <= 0) return this.interpolateDensity(x, 0, z)
    if (y >= WORLD_HEIGHT) return this.interpolateDensity(x, WORLD_HEIGHT, z)
    return this.interpolateDensity(x, y, z)
  }

  cacheStats(): DensityTerrainCacheStats {
    return { latticeColumns: this.latticeCache.size, blockColumns: this.columnCache.size }
  }

  clearCaches(): void {
    this.latticeCache.clear()
    this.columnCache.clear()
    if (this.biomeSource instanceof BiomeMap) this.biomeSource.clearCaches()
  }

  private columnAt(x: number, z: number): TerrainColumn {
    const key = cacheKey(x, z)
    const cached = this.columnCache.get(key)
    if (cached) return cached

    const gx = Math.floor(x / DENSITY_HORIZONTAL_STEP)
    const gz = Math.floor(z / DENSITY_HORIZONTAL_STEP)
    const fx = (x - gx * DENSITY_HORIZONTAL_STEP) / DENSITY_HORIZONTAL_STEP
    const fz = (z - gz * DENSITY_HORIZONTAL_STEP) / DENSITY_HORIZONTAL_STEP
    const d00 = this.latticeColumn(gx, gz)
    const d10 = this.latticeColumn(gx + 1, gz)
    const d01 = this.latticeColumn(gx, gz + 1)
    const d11 = this.latticeColumn(gx + 1, gz + 1)
    const blocks = new Uint8Array(WORLD_HEIGHT)

    for (let y = 0; y < WORLD_HEIGHT; y++) {
      const gy = Math.floor(y / DENSITY_VERTICAL_STEP)
      const fy = (y - gy * DENSITY_VERTICAL_STEP) / DENSITY_VERTICAL_STEP
      const lower = lerp(lerp(d00[gy], d10[gy], fx), lerp(d01[gy], d11[gy], fx), fz)
      const upper = lerp(lerp(d00[gy + 1], d10[gy + 1], fx), lerp(d01[gy + 1], d11[gy + 1], fx), fz)
      const density = lerp(lower, upper, fy)
      blocks[y] = density > 0 ? B.STONE : y <= this.seaLevel ? B.WATER : B.AIR
    }

    const sample = this.biomeSource.sample(x, z)
    const surfaceDepth = this.surfaceDepth(x, z)
    this.replaceSurface(blocks, sample, x, z, surfaceDepth)
    let height = 0
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (blocks[y] !== B.AIR && blocks[y] !== B.WATER) { height = y; break }
    }
    const column: TerrainColumn = {
      blocks,
      info: Object.freeze({ height, biome: sample.biome, surfaceDepth })
    }
    return rememberBounded(this.columnCache, key, column, DENSITY_COLUMN_CACHE_LIMIT)
  }

  private replaceSurface(
    blocks: Uint8Array,
    sample: BiomeSample,
    x: number,
    z: number,
    surfaceDepth: number
  ): void {
    let fillerRemaining = -1
    let sandstoneRemaining = 0
    let activeFiller: number = B.DIRT

    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (y <= 4 && hash3(x, y, z, this.seed ^ BEDROCK_SALT) % 5 >= y) {
        blocks[y] = B.BEDROCK
        continue
      }
      const block = blocks[y]
      if (block === B.AIR || block === B.WATER) {
        fillerRemaining = -1
        sandstoneRemaining = 0
        continue
      }
      if (block !== B.STONE) continue

      if (fillerRemaining < 0) {
        const materials = surfaceMaterials(sample, x, z, y, this.seed)
        activeFiller = materials.filler
        blocks[y] = y >= this.seaLevel - 1 ? materials.top : materials.filler
        fillerRemaining = surfaceDepth
        sandstoneRemaining = 0
        continue
      }
      if (fillerRemaining > 0) {
        blocks[y] = activeFiller
        fillerRemaining--
        if (fillerRemaining === 0 && activeFiller === B.SAND) {
          sandstoneRemaining = 1 + hash3(x, y, z, this.seed ^ SANDSTONE_SALT) % 4
        }
        continue
      }
      if (sandstoneRemaining > 0) {
        blocks[y] = B.SANDSTONE
        sandstoneRemaining--
      }
    }
  }

  private surfaceDepth(x: number, z: number): number {
    const noise = fbm2(this.surfaceNoise, x / 32, z / 32, 4)
    const jitter = (hash2(x, z, this.seed ^ SURFACE_RANDOM_SALT) & 0xffff) / 0x10000
    return clamp(Math.floor(3 + noise * 1.75 + jitter * 0.5), 1, 6)
  }

  private interpolateDensity(x: number, y: number, z: number): number {
    const gx = Math.floor(x / DENSITY_HORIZONTAL_STEP)
    const gz = Math.floor(z / DENSITY_HORIZONTAL_STEP)
    const fx = (x - gx * DENSITY_HORIZONTAL_STEP) / DENSITY_HORIZONTAL_STEP
    const fz = (z - gz * DENSITY_HORIZONTAL_STEP) / DENSITY_HORIZONTAL_STEP
    const gy = clamp(Math.floor(y / DENSITY_VERTICAL_STEP), 0, DENSITY_LATTICE_HEIGHT - 2)
    const fy = clamp((y - gy * DENSITY_VERTICAL_STEP) / DENSITY_VERTICAL_STEP, 0, 1)
    const d00 = this.latticeColumn(gx, gz), d10 = this.latticeColumn(gx + 1, gz)
    const d01 = this.latticeColumn(gx, gz + 1), d11 = this.latticeColumn(gx + 1, gz + 1)
    const lower = lerp(lerp(d00[gy], d10[gy], fx), lerp(d01[gy], d11[gy], fx), fz)
    const upper = lerp(lerp(d00[gy + 1], d10[gy + 1], fx), lerp(d01[gy + 1], d11[gy + 1], fx), fz)
    return lerp(lower, upper, fy)
  }

  private latticeColumn(gx: number, gz: number): Float32Array {
    const key = cacheKey(gx, gz)
    const cached = this.latticeCache.get(key)
    if (cached) return cached

    const worldX = gx * DENSITY_HORIZONTAL_STEP
    const worldZ = gz * DENSITY_HORIZONTAL_STEP
    const { rootHeight, variation } = this.blendedProfile(gx, gz)
    const depth = fbm2(this.depthNoise, worldX / 200, worldZ / 200, 4) * 3
    // A small continental lift keeps ordinary land just above the Y=63 water
    // line while ocean/river root heights still carve broad basins.
    const centerY = this.seaLevel + 3 + rootHeight * 16 + depth
    const stretch = 5 + variation * 24
    const density = new Float32Array(DENSITY_LATTICE_HEIGHT)

    for (let gy = 0; gy < DENSITY_LATTICE_HEIGHT; gy++) {
      const y = gy * DENSITY_VERTICAL_STEP
      const low = fbm3(this.lowNoise, worldX / 180, y / 96, worldZ / 180, 5)
      const high = fbm3(this.highNoise, worldX / 180, y / 96, worldZ / 180, 5)
      const selector = smoothstep(-0.65, 0.65,
        fbm3(this.selectNoise, worldX / 320, y / 160, worldZ / 320, 3))
      const terrainNoise = lerp(low, high, selector) * 1.45
      let value = terrainNoise - (y - centerY) / stretch
      if (y > 104) value = lerp(value, -2, (y - 104) / 24)
      if (y < 8) value = lerp(2, value, y / 8)
      density[gy] = value
    }

    return rememberBounded(this.latticeCache, key, density, DENSITY_LATTICE_CACHE_LIMIT)
  }

  private blendedProfile(gx: number, gz: number): BiomeTerrainProfile {
    const worldX = gx * DENSITY_HORIZONTAL_STEP
    const worldZ = gz * DENSITY_HORIZONTAL_STEP
    const centerProfile = profileForSample(this.biomeSource.sample(worldX, worldZ))
    let rootHeight = 0, variation = 0, totalWeight = 0, weightIndex = 0
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const profile = profileForSample(this.biomeSource.sample(
        (gx + dx) * DENSITY_HORIZONTAL_STEP,
        (gz + dz) * DENSITY_HORIZONTAL_STEP
      ))
      let weight = PARABOLIC_WEIGHTS[weightIndex++] / (profile.variation + 2)
      if (profile.rootHeight > centerProfile.rootHeight) weight *= 0.5
      rootHeight += profile.rootHeight * weight
      variation += profile.variation * weight
      totalWeight += weight
    }
    rootHeight /= totalWeight
    variation /= totalWeight
    return { rootHeight, variation }
  }
}
