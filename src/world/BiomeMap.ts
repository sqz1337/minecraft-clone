import { hash2 } from '../util/math'
import { BIOME, type BiomeId, isBiomeId } from './Biomes'

/** Marker kept outside the persisted low byte of a biome id. */
const HILL_FLAG = 0x100
const BIOME_MASK = 0xff
const OCEAN = BIOME.OCEAN

const LAND = 64
const CLIMATE_HOT = 65
const CLIMATE_WARM = 66
const CLIMATE_COOL = 67
const CLIMATE_FROZEN = 68
const CLIMATE_HUMID = 69
const MUSHROOM_TOKEN = 70
const NO_RIVER = -1

export const BIOME_LAYER_CACHE_LIMIT = 32_768

export interface BiomeSample {
  readonly biome: BiomeId
  /** Internal hills variants alter density without expanding the public id set. */
  readonly hill: boolean
}

export interface BiomeSource {
  sample(x: number, z: number): BiomeSample
  biomeAt(x: number, z: number): number
}

export interface BiomeMapCacheStats {
  readonly layers: number
  readonly entries: number
  readonly largestLayer: number
}

function key(x: number, z: number): string { return `${x},${z}` }

function choose(seed: number, salt: number, x: number, z: number, values: readonly number[]): number {
  return values[hash2(x, z, seed ^ salt) % values.length]
}

function chance(seed: number, salt: number, x: number, z: number, bound: number): boolean {
  return hash2(x, z, seed ^ salt) % bound === 0
}

function baseBiome(value: number): number { return value & BIOME_MASK }
function isOcean(value: number): boolean { return baseBiome(value) === BIOME.OCEAN }
function withHill(value: number): number { return baseBiome(value) | HILL_FLAG }

abstract class CachedLayer {
  private readonly cache = new Map<string, number>()

  constructor(
    readonly seed: number,
    readonly salt: number,
    private readonly cacheLimit = BIOME_LAYER_CACHE_LIMIT
  ) {}

  get(x: number, z: number): number {
    x = Math.floor(x); z = Math.floor(z)
    const cacheKey = key(x, z)
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return cached
    const value = this.sampleCell(x, z)
    if (this.cache.size >= this.cacheLimit) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(cacheKey, value)
    return value
  }

  cacheSize(): number { return this.cache.size }
  clearCache(): void { this.cache.clear() }
  protected abstract sampleCell(x: number, z: number): number
}

class IslandLayer extends CachedLayer {
  protected sampleCell(x: number, z: number): number {
    if (x === 0 && z === 0) return LAND
    return chance(this.seed, this.salt, x, z, 5) ? LAND : OCEAN
  }
}

function modeOrRandom(seed: number, salt: number, x: number, z: number, values: readonly number[]): number {
  const counts = new Map<number, number>()
  let bestValue = values[0], bestCount = 0
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    if (count > bestCount) { bestValue = value; bestCount = count }
  }
  return bestCount >= 2 ? bestValue : choose(seed, salt, x, z, values)
}

class ZoomLayer extends CachedLayer {
  constructor(
    seed: number,
    salt: number,
    private readonly parent: CachedLayer,
    private readonly fuzzy: boolean
  ) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const px = Math.floor(x / 2), pz = Math.floor(z / 2)
    const oddX = x - px * 2, oddZ = z - pz * 2
    const nw = this.parent.get(px, pz)
    if (oddX === 0 && oddZ === 0) return nw
    const ne = this.parent.get(px + 1, pz)
    if (oddZ === 0) return choose(this.seed, this.salt ^ 0x11, x, z, [nw, ne])
    const sw = this.parent.get(px, pz + 1)
    if (oddX === 0) return choose(this.seed, this.salt ^ 0x22, x, z, [nw, sw])
    const se = this.parent.get(px + 1, pz + 1)
    const values = [nw, ne, sw, se]
    return this.fuzzy
      ? choose(this.seed, this.salt ^ 0x33, x, z, values)
      : modeOrRandom(this.seed, this.salt ^ 0x33, x, z, values)
  }
}

class AddIslandLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = this.parent.get(x, z)
    const around = [
      this.parent.get(x - 1, z - 1), this.parent.get(x + 1, z - 1),
      this.parent.get(x - 1, z + 1), this.parent.get(x + 1, z + 1)
    ]
    const land = around.filter(value => value !== OCEAN)
    if (center === OCEAN && land.length > 0) {
      return chance(this.seed, this.salt ^ 0x41, x, z, 2)
        ? choose(this.seed, this.salt ^ 0x42, x, z, land)
        : OCEAN
    }
    if (center !== OCEAN && around.some(value => value === OCEAN) && chance(this.seed, this.salt ^ 0x43, x, z, 8)) {
      return OCEAN
    }
    return center
  }
}

class RemoveTooMuchOceanLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = this.parent.get(x, z)
    if (center !== OCEAN) return center
    const landNeighbors = [
      this.parent.get(x - 1, z), this.parent.get(x + 1, z),
      this.parent.get(x, z - 1), this.parent.get(x, z + 1)
    ].filter(value => value !== OCEAN).length
    return landNeighbors >= 3 && chance(this.seed, this.salt, x, z, 2) ? LAND : center
  }
}

class MushroomIslandLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    if (this.parent.get(x, z) !== OCEAN || !chance(this.seed, this.salt, x, z, 100)) return this.parent.get(x, z)
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if ((dx !== 0 || dz !== 0) && this.parent.get(x + dx, z + dz) !== OCEAN) return OCEAN
    }
    return MUSHROOM_TOKEN
  }
}

class ClimateLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const value = this.parent.get(x, z)
    if (value === OCEAN || value === MUSHROOM_TOKEN) return value
    const roll = hash2(x, z, this.seed ^ this.salt) % 100
    if (roll < 20) return CLIMATE_HOT
    if (roll < 52) return CLIMATE_WARM
    if (roll < 77) return CLIMATE_COOL
    if (roll < 85) return CLIMATE_FROZEN
    return CLIMATE_HUMID
  }
}

function isWarmClimate(value: number): boolean { return value === CLIMATE_HOT }

class ClimateEdgeLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = this.parent.get(x, z)
    if (center === OCEAN || center === MUSHROOM_TOKEN) return center
    const neighbors = [
      this.parent.get(x - 1, z), this.parent.get(x + 1, z),
      this.parent.get(x, z - 1), this.parent.get(x, z + 1)
    ]
    if (center === CLIMATE_FROZEN && neighbors.some(isWarmClimate)) return CLIMATE_COOL
    if (isWarmClimate(center) && neighbors.includes(CLIMATE_FROZEN)) return CLIMATE_WARM
    return center
  }
}

class BiomeAssignmentLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const climate = this.parent.get(x, z)
    if (climate === OCEAN) return BIOME.OCEAN
    if (climate === MUSHROOM_TOKEN) return BIOME.MUSHROOM
    const roll = hash2(x, z, this.seed ^ this.salt) % 100
    if (climate === CLIMATE_HOT) {
      return roll < 65 ? BIOME.DESERT : roll < 85 ? BIOME.PLAINS : BIOME.FOREST
    }
    if (climate === CLIMATE_WARM) {
      return roll < 35 ? BIOME.PLAINS : roll < 70 ? BIOME.FOREST : roll < 90 ? BIOME.SWAMP : BIOME.DESERT
    }
    if (climate === CLIMATE_COOL) {
      return roll < 45 ? BIOME.TAIGA : roll < 80 ? BIOME.FOREST : BIOME.PLAINS
    }
    if (climate === CLIMATE_FROZEN) return roll < 75 ? BIOME.SNOW : BIOME.TAIGA
    if (climate === CLIMATE_HUMID) {
      return roll < 65 ? BIOME.JUNGLE : roll < 85 ? BIOME.SWAMP : BIOME.FOREST
    }
    return BIOME.PLAINS
  }
}

function jungleCompatible(biome: number): boolean {
  return biome === BIOME.JUNGLE || biome === BIOME.FOREST || biome === BIOME.PLAINS
}

class BiomeEdgeLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = baseBiome(this.parent.get(x, z))
    if (center === BIOME.OCEAN || center === BIOME.MUSHROOM) return center
    const neighbors = [
      baseBiome(this.parent.get(x - 1, z)), baseBiome(this.parent.get(x + 1, z)),
      baseBiome(this.parent.get(x, z - 1)), baseBiome(this.parent.get(x, z + 1))
    ]
    if (center === BIOME.DESERT && neighbors.includes(BIOME.SNOW)) return BIOME.PLAINS
    if (center === BIOME.SWAMP && neighbors.some(value => value === BIOME.DESERT || value === BIOME.SNOW)) return BIOME.PLAINS
    if (center === BIOME.JUNGLE && neighbors.some(value => !jungleCompatible(value))) return BIOME.FOREST
    return center
  }
}

class HillsLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = baseBiome(this.parent.get(x, z))
    if (!chance(this.seed, this.salt, x, z, 7)) return center
    if (center === BIOME.OCEAN || center === BIOME.BEACH || center === BIOME.RIVER ||
      center === BIOME.SWAMP || center === BIOME.MUSHROOM) return center
    const matching = [
      this.parent.get(x - 1, z), this.parent.get(x + 1, z),
      this.parent.get(x, z - 1), this.parent.get(x, z + 1)
    ].filter(value => baseBiome(value) === center).length
    if (matching < 3) return center
    if (center === BIOME.PLAINS || center === BIOME.FOREST) return withHill(BIOME.MOUNTAIN)
    return withHill(center)
  }
}

class ShoreLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = this.parent.get(x, z)
    const biome = baseBiome(center)
    if (biome === BIOME.OCEAN || biome === BIOME.MUSHROOM) return center
    const oceanNeighbor = [
      this.parent.get(x - 1, z), this.parent.get(x + 1, z),
      this.parent.get(x, z - 1), this.parent.get(x, z + 1)
    ].some(isOcean)
    return oceanNeighbor ? BIOME.BEACH : center
  }
}

class SmoothLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = this.parent.get(x, z)
    const west = this.parent.get(x - 1, z), east = this.parent.get(x + 1, z)
    const north = this.parent.get(x, z - 1), south = this.parent.get(x, z + 1)
    if (west === east && north === south) {
      return choose(this.seed, this.salt, x, z, [west, north])
    }
    if (west === east) return west
    if (north === south) return north
    return center
  }
}

class RiverInitLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    return this.parent.get(x, z) === OCEAN ? OCEAN : 2 + hash2(x, z, this.seed ^ this.salt) % 299_999
  }
}

function riverValue(value: number): number { return value >= 2 ? 2 + (value & 1) : value }

class RiverLayer extends CachedLayer {
  constructor(seed: number, salt: number, private readonly parent: CachedLayer) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const center = riverValue(this.parent.get(x, z))
    if (center === OCEAN) return NO_RIVER
    const same = riverValue(this.parent.get(x - 1, z)) === center &&
      riverValue(this.parent.get(x + 1, z)) === center &&
      riverValue(this.parent.get(x, z - 1)) === center &&
      riverValue(this.parent.get(x, z + 1)) === center
    return same ? NO_RIVER : BIOME.RIVER
  }
}

class RiverMixLayer extends CachedLayer {
  constructor(
    seed: number,
    salt: number,
    private readonly biomes: CachedLayer,
    private readonly rivers: CachedLayer
  ) { super(seed, salt) }

  protected sampleCell(x: number, z: number): number {
    const biome = this.biomes.get(x, z)
    const id = baseBiome(biome)
    if (id === BIOME.OCEAN || id === BIOME.MUSHROOM) return biome
    return this.rivers.get(x, z) === BIOME.RIVER ? BIOME.RIVER : biome
  }
}

/**
 * Deterministic GenLayer-shaped biome map.  It keeps the recognizable island,
 * zoom, climate edge, hills, shore and separate river-mix topology of 1.2-era
 * worlds while intentionally retaining Realmcraft's PRNG and twelve biome ids.
 */
export class BiomeMap implements BiomeSource {
  private readonly layers: CachedLayer[] = []
  private readonly output: CachedLayer

  constructor(readonly seed: number) {
    const add = <T extends CachedLayer>(layer: T): T => { this.layers.push(layer); return layer }

    let land: CachedLayer = add(new IslandLayer(seed, 0x1001))
    land = add(new ZoomLayer(seed, 0x1002, land, true))
    land = add(new AddIslandLayer(seed, 0x1003, land))
    land = add(new ZoomLayer(seed, 0x1004, land, false))
    land = add(new AddIslandLayer(seed, 0x1005, land))
    land = add(new RemoveTooMuchOceanLayer(seed, 0x1006, land))
    land = add(new ZoomLayer(seed, 0x1007, land, false))
    land = add(new AddIslandLayer(seed, 0x1008, land))
    land = add(new MushroomIslandLayer(seed, 0x1009, land))
    const climate = add(new ClimateEdgeLayer(seed, 0x1011,
      add(new ClimateLayer(seed, 0x1010, land))))

    let biomes: CachedLayer = add(new BiomeAssignmentLayer(seed, 0x2001, climate))
    biomes = add(new BiomeEdgeLayer(seed, 0x2002, biomes))
    biomes = add(new ZoomLayer(seed, 0x2003, biomes, false))
    biomes = add(new HillsLayer(seed, 0x2004, biomes))
    biomes = add(new ZoomLayer(seed, 0x2005, biomes, false))
    biomes = add(new ShoreLayer(seed, 0x2006, biomes))
    biomes = add(new ZoomLayer(seed, 0x2007, biomes, false))
    biomes = add(new ZoomLayer(seed, 0x2008, biomes, false))
    biomes = add(new SmoothLayer(seed, 0x2009, biomes))

    let rivers: CachedLayer = add(new RiverInitLayer(seed, 0x3001, climate))
    rivers = add(new ZoomLayer(seed, 0x3002, rivers, false))
    rivers = add(new ZoomLayer(seed, 0x3003, rivers, false))
    rivers = add(new ZoomLayer(seed, 0x3004, rivers, false))
    rivers = add(new ZoomLayer(seed, 0x3005, rivers, false))
    rivers = add(new RiverLayer(seed, 0x3006, rivers))
    rivers = add(new SmoothLayer(seed, 0x3007, rivers))

    this.output = add(new RiverMixLayer(seed, 0x4001, biomes, rivers))
  }

  sample(x: number, z: number): BiomeSample {
    const encoded = this.output.get(x, z)
    const raw = baseBiome(encoded)
    return {
      biome: isBiomeId(raw) ? raw : BIOME.PLAINS,
      hill: (encoded & HILL_FLAG) !== 0
    }
  }

  biomeAt(x: number, z: number): number { return this.sample(x, z).biome }

  getRegion(x: number, z: number, width: number, height: number): Uint8Array {
    const safeWidth = Math.max(0, Math.floor(width)), safeHeight = Math.max(0, Math.floor(height))
    const result = new Uint8Array(safeWidth * safeHeight)
    const originX = Math.floor(x), originZ = Math.floor(z)
    for (let dz = 0; dz < safeHeight; dz++) for (let dx = 0; dx < safeWidth; dx++) {
      result[dz * safeWidth + dx] = this.biomeAt(originX + dx, originZ + dz)
    }
    return result
  }

  cacheStats(): BiomeMapCacheStats {
    let entries = 0, largestLayer = 0
    for (const layer of this.layers) {
      const size = layer.cacheSize()
      entries += size
      largestLayer = Math.max(largestLayer, size)
    }
    return { layers: this.layers.length, entries, largestLayer }
  }

  clearCaches(): void { for (const layer of this.layers) layer.clearCache() }
}
