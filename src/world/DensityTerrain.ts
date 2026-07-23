import { B } from './Blocks'
import { BiomeMap, projectBiome, type BiomeSource } from './BiomeMap'
import { type BiomeTerrainProfile } from './Biomes'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { JavaRandom, long } from './JavaRandom'
import { NoiseGeneratorOctaves } from './JavaNoise'
import { vanillaBiomeForProject, vanillaBiomeInfo } from './VanillaBiomes'

export const DENSITY_SEA_LEVEL = 63
export const DENSITY_HORIZONTAL_STEP = 4
export const DENSITY_VERTICAL_STEP = 8
export const DENSITY_LATTICE_HEIGHT = 17
export const DENSITY_LATTICE_CACHE_LIMIT = 64
export const DENSITY_COLUMN_CACHE_LIMIT = 16_384

const CHUNK_CACHE_LIMIT = 64
const CHUNK_SEED_X = 0x4f9939f508n
const CHUNK_SEED_Z = 0x1ef1565bd5n

export interface DensityTerrainColumnInfo {
  readonly height: number
  readonly biome: number
  readonly surfaceDepth: number
}

export interface DensityTerrainCacheStats {
  readonly latticeColumns: number
  readonly blockColumns: number
}

export interface SmoothedTerrainProfile extends BiomeTerrainProfile {
  readonly x: number
  readonly z: number
}

interface BaseChunk {
  readonly blocks: Uint8Array
  readonly heights: Uint8Array
  readonly biomes: Uint8Array
  readonly surfaceDepths: Int8Array
  readonly density: Float64Array
}

const PARABOLIC_WEIGHTS = (() => {
  const result = new Float32Array(25)
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const distance = Math.fround(Math.fround(x * x + z * z) + Math.fround(0.2))
    result[x + 2 + (z + 2) * 5] = Math.fround(10 / Math.fround(Math.sqrt(distance)))
  }
  return result
})()

function chunkKey(x: number, z: number): string { return `${x},${z}` }

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  if (!cache.has(key) && cache.size >= limit) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

function localIndex(x: number, y: number, z: number): number { return (((x << 4) | z) << 7) | y }

/**
 * ChunkProviderGenerate's terrain and biome-surface passes, retaining the
 * coordinate-query API used by structures and decorators.
 */
export class DensityTerrain {
  readonly seaLevel = DENSITY_SEA_LEVEL
  readonly biomeSource: BiomeSource
  readonly seed: bigint

  private readonly random: JavaRandom
  private readonly noise1: NoiseGeneratorOctaves
  private readonly noise2: NoiseGeneratorOctaves
  private readonly noise3: NoiseGeneratorOctaves
  private readonly stoneNoise: NoiseGeneratorOctaves
  private readonly noise5: NoiseGeneratorOctaves
  private readonly noise6: NoiseGeneratorOctaves
  private readonly chunks = new Map<string, BaseChunk>()

  constructor(seed: number | bigint, biomeSource?: BiomeSource) {
    this.seed = typeof seed === 'bigint' ? seed : BigInt(seed)
    this.biomeSource = biomeSource ?? new BiomeMap(this.seed)
    this.random = new JavaRandom(this.seed)
    this.noise1 = new NoiseGeneratorOctaves(this.random, 16)
    this.noise2 = new NoiseGeneratorOctaves(this.random, 16)
    this.noise3 = new NoiseGeneratorOctaves(this.random, 8)
    this.stoneNoise = new NoiseGeneratorOctaves(this.random, 4)
    this.noise5 = new NoiseGeneratorOctaves(this.random, 10)
    this.noise6 = new NoiseGeneratorOctaves(this.random, 16)
    // Vanilla constructs mobSpawnerNoise next. It has no effect on terrain,
    // but consuming the same RNG state documents the complete constructor.
    new NoiseGeneratorOctaves(this.random, 8)
  }

  biomeAt(x: number, z: number): number { return this.biomeSource.biomeAt(Math.floor(x), Math.floor(z)) }

  columnInfo(x: number, z: number): DensityTerrainColumnInfo {
    x = Math.floor(x); z = Math.floor(z)
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16)
    const chunk = this.baseChunk(cx, cz)
    const lx = x - cx * 16, lz = z - cz * 16
    const index = (lx << 4) | lz
    return {
      height: chunk.heights[index],
      biome: chunk.biomes[index],
      surfaceDepth: chunk.surfaceDepths[index]
    }
  }

  surfaceY(x: number, z: number): number { return this.columnInfo(x, z).height }
  surfaceDepthAt(x: number, z: number): number { return this.columnInfo(x, z).surfaceDepth }

  smoothedProfileAt(x: number, z: number): SmoothedTerrainProfile {
    const gridX = Math.floor(x / 4), gridZ = Math.floor(z / 4)
    const biomes = this.generationBiomes(gridX - 2, gridZ - 2, 5, 5)
    const { minHeight, maxHeight } = this.blendProfile(biomes, 5, 2, 2)
    return { x: gridX * 4, z: gridZ * 4, rootHeight: minHeight, variation: maxHeight }
  }

  blockAt(x: number, y: number, z: number): number {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16)
    return this.baseChunk(cx, cz).blocks[localIndex(x - cx * 16, y, z - cz * 16)]
  }

  copyInto(chunk: Chunk): void {
    const base = this.baseChunk(chunk.cx, chunk.cz)
    chunk.blocks.set(base.blocks)
    chunk.colHeight.set(base.heights)
    chunk.colBiome.set(base.biomes)
  }

  sampleDensity(x: number, y: number, z: number): number {
    x = Math.floor(x); z = Math.floor(z)
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16)
    const lx = x - cx * 16, lz = z - cz * 16
    const cellX = Math.min(3, Math.floor(lx / 4)), cellZ = Math.min(3, Math.floor(lz / 4))
    const cellY = Math.max(0, Math.min(15, Math.floor(y / 8)))
    const fx = (lx - cellX * 4) / 4, fz = (lz - cellZ * 4) / 4
    const fy = Math.max(0, Math.min(1, (y - cellY * 8) / 8))
    const density = this.baseChunk(cx, cz).density
    const at = (gx: number, gy: number, gz: number) => density[(gx * 5 + gz) * 17 + gy]
    const lowerNorth = at(cellX, cellY, cellZ) +
      (at(cellX + 1, cellY, cellZ) - at(cellX, cellY, cellZ)) * fx
    const lowerSouth = at(cellX, cellY, cellZ + 1) +
      (at(cellX + 1, cellY, cellZ + 1) - at(cellX, cellY, cellZ + 1)) * fx
    const upperNorth = at(cellX, cellY + 1, cellZ) +
      (at(cellX + 1, cellY + 1, cellZ) - at(cellX, cellY + 1, cellZ)) * fx
    const upperSouth = at(cellX, cellY + 1, cellZ + 1) +
      (at(cellX + 1, cellY + 1, cellZ + 1) - at(cellX, cellY + 1, cellZ + 1)) * fx
    const lower = lowerNorth + (lowerSouth - lowerNorth) * fz
    const upper = upperNorth + (upperSouth - upperNorth) * fz
    return lower + (upper - lower) * fy
  }

  cacheStats(): DensityTerrainCacheStats {
    return { latticeColumns: this.chunks.size, blockColumns: this.chunks.size * 256 }
  }

  clearCaches(): void {
    this.chunks.clear()
    if (this.biomeSource instanceof BiomeMap) this.biomeSource.clearCaches()
  }

  private baseChunk(cx: number, cz: number): BaseChunk {
    const key = chunkKey(cx, cz)
    const cached = this.chunks.get(key)
    if (cached) return cached

    const densityBiomes = this.generationBiomes(cx * 4 - 2, cz * 4 - 2, 10, 10)
    const density = this.initializeNoiseField(cx * 4, cz * 4, densityBiomes)
    const blocks = new Uint8Array(16 * 16 * 128)
    this.interpolateTerrain(blocks, density)

    const finalBiomes = this.blockBiomes(cx * 16, cz * 16, 16, 16)
    const surfaceDepths = new Int8Array(256)
    this.replaceSurface(cx, cz, blocks, finalBiomes, surfaceDepths)

    const heights = new Uint8Array(256)
    const biomes = new Uint8Array(256)
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const column = (x << 4) | z
      biomes[column] = projectBiome(finalBiomes[x + z * 16])
      for (let y = 127; y >= 0; y--) {
        const block = blocks[localIndex(x, y, z)]
        if (block !== B.AIR && block !== B.WATER) { heights[column] = y; break }
      }
    }
    return remember(this.chunks, key, { blocks, heights, biomes, surfaceDepths, density }, CHUNK_CACHE_LIMIT)
  }

  private generationBiomes(x: number, z: number, width: number, height: number): Int32Array {
    if (this.biomeSource.generationBiomes) return this.biomeSource.generationBiomes(x, z, width, height)
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const sample = this.biomeSource.sample((x + dx) * 4, (z + dz) * 4)
      result[dx + dz * width] = sample.vanillaBiome ??
        vanillaBiomeForProject(sample.biome, sample.hill)
    }
    return result
  }

  private blockBiomes(x: number, z: number, width: number, height: number): Int32Array {
    if (this.biomeSource.blockBiomes) return this.biomeSource.blockBiomes(x, z, width, height)
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const sample = this.biomeSource.sample(x + dx, z + dz)
      result[dx + dz * width] = sample.vanillaBiome ??
        vanillaBiomeForProject(sample.biome, sample.hill)
    }
    return result
  }

  private blendProfile(
    biomes: Int32Array,
    stride: number,
    centerX: number,
    centerZ: number
  ): { minHeight: number; maxHeight: number } {
    const f = Math.fround
    const center = vanillaBiomeInfo(biomes[centerX + centerZ * stride])
    let maxHeight = f(0), minHeight = f(0), total = f(0)
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const biome = vanillaBiomeInfo(biomes[centerX + dx + (centerZ + dz) * stride])
      let weight = f(PARABOLIC_WEIGHTS[dx + 2 + (dz + 2) * 5] / f(biome.minHeight + f(2)))
      if (biome.minHeight > center.minHeight) weight = f(weight / f(2))
      maxHeight = f(maxHeight + f(biome.maxHeight * weight))
      minHeight = f(minHeight + f(biome.minHeight * weight))
      total = f(total + weight)
    }
    maxHeight = f(maxHeight / total)
    minHeight = f(minHeight / total)
    return { minHeight, maxHeight }
  }

  private initializeNoiseField(originX: number, originZ: number, biomes: Int32Array): Float64Array {
    const sizeX = 5, sizeY = 17, sizeZ = 5
    const horizontal = 684.41200000000003
    const depth = this.noise6.generate2D(null, originX, originZ, sizeX, sizeZ, 200, 200, 0.5)
    this.noise5.generate2D(null, originX, originZ, sizeX, sizeZ, 1.121, 1.121, 0.5)
    const selector = this.noise3.generate3D(
      null, originX, 0, originZ, sizeX, sizeY, sizeZ,
      horizontal / 80, horizontal / 160, horizontal / 80
    )
    const low = this.noise1.generate3D(
      null, originX, 0, originZ, sizeX, sizeY, sizeZ, horizontal, horizontal, horizontal
    )
    const high = this.noise2.generate3D(
      null, originX, 0, originZ, sizeX, sizeY, sizeZ, horizontal, horizontal, horizontal
    )
    const result = new Float64Array(sizeX * sizeY * sizeZ)
    const f = Math.fround
    let noiseIndex = 0, depthIndex = 0
    for (let x = 0; x < sizeX; x++) for (let z = 0; z < sizeZ; z++) {
      let { minHeight, maxHeight } = this.blendProfile(biomes, 10, x + 2, z + 2)
      maxHeight = f(f(maxHeight * f(0.9)) + f(0.1))
      minHeight = f(f(f(minHeight * f(4)) - f(1)) / f(8))
      let depthNoise = depth[depthIndex++] / 8000
      if (depthNoise < 0) depthNoise = -depthNoise * 0.3
      depthNoise = depthNoise * 3 - 2
      if (depthNoise < 0) {
        depthNoise /= 2
        if (depthNoise < -1) depthNoise = -1
        depthNoise /= 1.4
        depthNoise /= 2
      } else {
        if (depthNoise > 1) depthNoise = 1
        depthNoise /= 8
      }
      for (let y = 0; y < sizeY; y++) {
        let adjustedMin = minHeight + depthNoise * 0.2
        adjustedMin = adjustedMin * sizeY / 16
        const center = sizeY / 2 + adjustedMin * 4
        let falloff = (y - center) * 12 / maxHeight
        if (falloff < 0) falloff *= 4
        const lowValue = low[noiseIndex] / 512
        const highValue = high[noiseIndex] / 512
        const blend = (selector[noiseIndex] / 10 + 1) / 2
        let density = blend < 0 ? lowValue : blend > 1 ? highValue
          : lowValue + (highValue - lowValue) * blend
        density -= falloff
        if (y > sizeY - 4) {
          const topBlend = Math.fround(Math.fround(y - (sizeY - 4)) / Math.fround(3))
          density = density * (1 - topBlend) - 10 * topBlend
        }
        result[noiseIndex++] = density
      }
    }
    return result
  }

  private interpolateTerrain(blocks: Uint8Array, density: Float64Array): void {
    const at = (x: number, y: number, z: number) => density[(x * 5 + z) * 17 + y]
    for (let cellX = 0; cellX < 4; cellX++) for (let cellZ = 0; cellZ < 4; cellZ++) {
      for (let cellY = 0; cellY < 16; cellY++) {
        let northWest = at(cellX, cellY, cellZ)
        let southWest = at(cellX, cellY, cellZ + 1)
        let northEast = at(cellX + 1, cellY, cellZ)
        let southEast = at(cellX + 1, cellY, cellZ + 1)
        const nwY = (at(cellX, cellY + 1, cellZ) - northWest) * 0.125
        const swY = (at(cellX, cellY + 1, cellZ + 1) - southWest) * 0.125
        const neY = (at(cellX + 1, cellY + 1, cellZ) - northEast) * 0.125
        const seY = (at(cellX + 1, cellY + 1, cellZ + 1) - southEast) * 0.125
        for (let subY = 0; subY < 8; subY++) {
          let north = northWest, south = southWest
          const northX = (northEast - northWest) * 0.25
          const southX = (southEast - southWest) * 0.25
          for (let subX = 0; subX < 4; subX++) {
            let value = north - (south - north) * 0.25
            const zStep = (south - north) * 0.25
            for (let subZ = 0; subZ < 4; subZ++) {
              value += zStep
              const y = cellY * 8 + subY
              blocks[localIndex(cellX * 4 + subX, y, cellZ * 4 + subZ)] =
                value > 0 ? B.STONE : y < DENSITY_SEA_LEVEL ? B.WATER : B.AIR
            }
            north += northX
            south += southX
          }
          northWest += nwY
          southWest += swY
          northEast += neY
          southEast += seY
        }
      }
    }
  }

  private replaceSurface(
    cx: number,
    cz: number,
    blocks: Uint8Array,
    biomes: Int32Array,
    depths: Int8Array
  ): void {
    this.random.setSeed(long(BigInt(cx) * CHUNK_SEED_X + BigInt(cz) * CHUNK_SEED_Z))
    const noise = this.stoneNoise.generate3D(null, cx * 16, cz * 16, 0, 16, 16, 1, 0.0625, 0.0625, 0.0625)
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const biome = vanillaBiomeInfo(biomes[x + z * 16])
      const depth = Math.trunc(noise[z + x * 16] / 3 + 3 + this.random.nextDouble() * 0.25)
      depths[(x << 4) | z] = depth
      let remaining = -1
      let top = biome.top, filler = biome.filler
      for (let y = 127; y >= 0; y--) {
        const index = localIndex(x, y, z)
        if (y <= this.random.nextInt(5)) {
          blocks[index] = B.BEDROCK
          continue
        }
        const block = blocks[index]
        if (block === B.AIR) {
          remaining = -1
          continue
        }
        if (block !== B.STONE) continue
        if (remaining === -1) {
          if (depth <= 0) {
            top = B.AIR
            filler = B.STONE
          } else if (y >= DENSITY_SEA_LEVEL - 4 && y <= DENSITY_SEA_LEVEL + 1) {
            top = biome.top
            filler = biome.filler
          }
          if (y < DENSITY_SEA_LEVEL && top === B.AIR) {
            top = biome.temperature < Math.fround(0.15) ? B.ICE : B.WATER
          }
          remaining = depth
          blocks[index] = y >= DENSITY_SEA_LEVEL - 1 ? top : filler
        } else if (remaining > 0) {
          remaining--
          blocks[index] = filler
          if (remaining === 0 && filler === B.SAND) {
            remaining = this.random.nextInt(4)
            filler = B.SANDSTONE
          }
        }
      }
    }
  }
}
