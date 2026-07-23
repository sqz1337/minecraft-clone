import { BIOME, type BiomeId } from './Biomes'
import { createVanillaGenLayers, VANILLA_BIOME, type VanillaGenLayers } from './JavaGenLayer'

export const BIOME_LAYER_CACHE_LIMIT = 32_768
const TILE_SIZE = 128
const TILE_CACHE_LIMIT = 64

export interface BiomeSample {
  readonly biome: BiomeId
  readonly hill: boolean
  /** Original Minecraft biome id used by the density and surface passes. */
  readonly vanillaBiome?: number
}

export interface BiomeSource {
  sample(x: number, z: number): BiomeSample
  biomeAt(x: number, z: number): number
  generationBiomes?(x: number, z: number, width: number, height: number): Int32Array
  blockBiomes?(x: number, z: number, width: number, height: number): Int32Array
}

export interface BiomeMapCacheStats {
  readonly layers: number
  readonly entries: number
  readonly largestLayer: number
}

export function projectBiome(vanilla: number): BiomeId {
  switch (vanilla) {
    case VANILLA_BIOME.OCEAN:
    case VANILLA_BIOME.FROZEN_OCEAN:
      return BIOME.OCEAN
    case VANILLA_BIOME.BEACH:
      return BIOME.BEACH
    case VANILLA_BIOME.PLAINS:
      return BIOME.PLAINS
    case VANILLA_BIOME.FOREST:
    case VANILLA_BIOME.FOREST_HILLS:
      return BIOME.FOREST
    case VANILLA_BIOME.DESERT:
    case VANILLA_BIOME.DESERT_HILLS:
      return BIOME.DESERT
    case VANILLA_BIOME.EXTREME_HILLS:
    case VANILLA_BIOME.EXTREME_HILLS_EDGE:
      return BIOME.MOUNTAIN
    case VANILLA_BIOME.ICE_PLAINS:
    case VANILLA_BIOME.ICE_MOUNTAINS:
      return BIOME.SNOW
    case VANILLA_BIOME.RIVER:
    case VANILLA_BIOME.FROZEN_RIVER:
      return BIOME.RIVER
    case VANILLA_BIOME.TAIGA:
    case VANILLA_BIOME.TAIGA_HILLS:
      return BIOME.TAIGA
    case VANILLA_BIOME.SWAMP:
      return BIOME.SWAMP
    case VANILLA_BIOME.JUNGLE:
    case VANILLA_BIOME.JUNGLE_HILLS:
      return BIOME.JUNGLE
    case VANILLA_BIOME.MUSHROOM_ISLAND:
    case VANILLA_BIOME.MUSHROOM_SHORE:
      return BIOME.MUSHROOM
    default:
      return BIOME.PLAINS
  }
}

export function isVanillaHill(vanilla: number): boolean {
  return vanilla === VANILLA_BIOME.DESERT_HILLS ||
    vanilla === VANILLA_BIOME.FOREST_HILLS ||
    vanilla === VANILLA_BIOME.TAIGA_HILLS ||
    vanilla === VANILLA_BIOME.ICE_MOUNTAINS ||
    vanilla === VANILLA_BIOME.JUNGLE_HILLS
}

/**
 * Minecraft 1.2.5's complete GenLayer graph. Public biome ids stay compatible
 * with Realmcraft while terrain generation retains every vanilla variant.
 */
export class BiomeMap implements BiomeSource {
  private readonly layers: VanillaGenLayers
  private readonly blockTiles = new Map<string, Int32Array>()
  private sampledCells = 0

  constructor(readonly seed: number | bigint) {
    this.layers = createVanillaGenLayers(typeof seed === 'bigint' ? seed : BigInt(seed))
  }

  sample(x: number, z: number): BiomeSample {
    x = Math.floor(x)
    z = Math.floor(z)
    const tileX = Math.floor(x / TILE_SIZE), tileZ = Math.floor(z / TILE_SIZE)
    const key = `${tileX},${tileZ}`
    let tile = this.blockTiles.get(key)
    if (!tile) {
      tile = this.layers.blocks.getInts(tileX * TILE_SIZE, tileZ * TILE_SIZE, TILE_SIZE, TILE_SIZE)
      if (this.blockTiles.size >= TILE_CACHE_LIMIT) {
        const oldest = this.blockTiles.keys().next().value as string | undefined
        if (oldest !== undefined) this.blockTiles.delete(oldest)
      }
      this.blockTiles.set(key, tile)
    }
    const localX = x - tileX * TILE_SIZE, localZ = z - tileZ * TILE_SIZE
    const vanillaBiome = tile[localX + localZ * TILE_SIZE]
    this.sampledCells++
    return { biome: projectBiome(vanillaBiome), hill: isVanillaHill(vanillaBiome), vanillaBiome }
  }

  biomeAt(x: number, z: number): number { return this.sample(x, z).biome }

  getRegion(x: number, z: number, width: number, height: number): Uint8Array {
    const vanilla = this.blockBiomes(x, z, width, height)
    const result = new Uint8Array(width * height)
    for (let index = 0; index < result.length; index++) result[index] = projectBiome(vanilla[index])
    return result
  }

  /** Low-resolution biomes consumed by initializeNoiseField. */
  generationBiomes(x: number, z: number, width: number, height: number): Int32Array {
    this.sampledCells += width * height
    return this.layers.generation.getInts(x, z, width, height)
  }

  /** Voronoi-zoomed final block biomes. */
  blockBiomes(x: number, z: number, width: number, height: number): Int32Array {
    this.sampledCells += width * height
    return this.layers.blocks.getInts(x, z, width, height)
  }

  cacheStats(): BiomeMapCacheStats {
    return {
      layers: 23,
      entries: this.blockTiles.size * TILE_SIZE * TILE_SIZE,
      largestLayer: Math.min(BIOME_LAYER_CACHE_LIMIT, this.sampledCells)
    }
  }

  clearCaches(): void {
    this.blockTiles.clear()
    this.sampledCells = 0
  }
}
