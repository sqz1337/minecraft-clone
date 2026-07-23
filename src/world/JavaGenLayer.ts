import { long } from './JavaRandom'

const LCG_MULTIPLIER = 0x5851f42d4c957f2dn
const LCG_ADDEND = 0x14057b7ef767814fn

export const VANILLA_BIOME = {
  OCEAN: 0,
  PLAINS: 1,
  DESERT: 2,
  EXTREME_HILLS: 3,
  FOREST: 4,
  TAIGA: 5,
  SWAMP: 6,
  RIVER: 7,
  FROZEN_OCEAN: 10,
  FROZEN_RIVER: 11,
  ICE_PLAINS: 12,
  ICE_MOUNTAINS: 13,
  MUSHROOM_ISLAND: 14,
  MUSHROOM_SHORE: 15,
  BEACH: 16,
  DESERT_HILLS: 17,
  FOREST_HILLS: 18,
  TAIGA_HILLS: 19,
  EXTREME_HILLS_EDGE: 20,
  JUNGLE: 21,
  JUNGLE_HILLS: 22
} as const

function mix(seed: bigint, add: bigint): bigint {
  return long(seed * (seed * LCG_MULTIPLIER + LCG_ADDEND) + add)
}

abstract class GenLayer {
  protected parent?: GenLayer
  private readonly baseSeed: bigint
  private worldGenSeed = 0n
  private chunkSeed = 0n

  constructor(seed: bigint | number, parent?: GenLayer) {
    const source = typeof seed === 'number' ? BigInt(seed) : seed
    let baseSeed = source
    baseSeed = mix(baseSeed, source)
    baseSeed = mix(baseSeed, source)
    baseSeed = mix(baseSeed, source)
    this.baseSeed = baseSeed
    this.parent = parent
  }

  initWorldGenSeed(seed: bigint): void {
    this.worldGenSeed = seed
    this.parent?.initWorldGenSeed(seed)
    this.worldGenSeed = mix(this.worldGenSeed, this.baseSeed)
    this.worldGenSeed = mix(this.worldGenSeed, this.baseSeed)
    this.worldGenSeed = mix(this.worldGenSeed, this.baseSeed)
  }

  protected initChunkSeed(x: number, z: number): void {
    this.chunkSeed = this.worldGenSeed
    this.chunkSeed = mix(this.chunkSeed, BigInt(x))
    this.chunkSeed = mix(this.chunkSeed, BigInt(z))
    this.chunkSeed = mix(this.chunkSeed, BigInt(x))
    this.chunkSeed = mix(this.chunkSeed, BigInt(z))
  }

  protected nextInt(bound: number): number {
    let value = Number((this.chunkSeed >> 24n) % BigInt(bound))
    if (value < 0) value += bound
    this.chunkSeed = mix(this.chunkSeed, this.worldGenSeed)
    return value
  }

  protected choose(first: number, second: number): number {
    return this.nextInt(2) === 0 ? first : second
  }

  abstract getInts(x: number, z: number, width: number, height: number): Int32Array
}

class IslandLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      this.initChunkSeed(x + dx, z + dz)
      result[dx + dz * width] = this.nextInt(10) === 0 ? 1 : 0
    }
    if (x > -width && x <= 0 && z > -height && z <= 0) result[-x + -z * width] = 1
    return result
  }
}

class ZoomLayer extends GenLayer {
  constructor(seed: number, parent: GenLayer, private readonly fuzzy = false) { super(seed, parent) }

  private chooseFour(a: number, b: number, c: number, d: number): number {
    if (this.fuzzy) return [a, b, c, d][this.nextInt(4)]
    if (b === c && c === d) return b
    if (a === b && a === c) return a
    if (a === b && a === d) return a
    if (a === c && a === d) return a
    if (a === b && c !== d) return a
    if (a === c && b !== d) return a
    if (a === d && b !== c) return a
    if (b === c && a !== d) return b
    if (b === d && a !== c) return b
    if (c === d && a !== b) return c
    return [a, b, c, d][this.nextInt(4)]
  }

  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const parentX = x >> 1, parentZ = z >> 1
    const parentWidth = (width >> 1) + 3, parentHeight = (height >> 1) + 3
    const source = this.parent!.getInts(parentX, parentZ, parentWidth, parentHeight)
    const stride = parentWidth << 1
    const expanded = new Int32Array(stride * (parentHeight << 1))
    for (let row = 0; row < parentHeight - 1; row++) {
      let index = (row << 1) * stride
      let northWest = source[row * parentWidth]
      let southWest = source[(row + 1) * parentWidth]
      for (let column = 0; column < parentWidth - 1; column++) {
        this.initChunkSeed((column + parentX) << 1, (row + parentZ) << 1)
        const northEast = source[column + 1 + row * parentWidth]
        const southEast = source[column + 1 + (row + 1) * parentWidth]
        expanded[index] = northWest
        expanded[index++ + stride] = this.choose(northWest, southWest)
        expanded[index] = this.choose(northWest, northEast)
        expanded[index++ + stride] = this.chooseFour(northWest, northEast, southWest, southEast)
        northWest = northEast
        southWest = southEast
      }
    }
    const result = new Int32Array(width * height)
    for (let row = 0; row < height; row++) {
      const offset = (row + (z & 1)) * stride + (x & 1)
      result.set(expanded.subarray(offset, offset + width), row * width)
    }
    return result
  }
}

class AddIslandLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const northWest = source[dx + dz * stride]
      const northEast = source[dx + 2 + dz * stride]
      const southWest = source[dx + (dz + 2) * stride]
      const southEast = source[dx + 2 + (dz + 2) * stride]
      const center = source[dx + 1 + (dz + 1) * stride]
      this.initChunkSeed(x + dx, z + dz)
      if (center === 0 && (northWest !== 0 || northEast !== 0 || southWest !== 0 || southEast !== 0)) {
        let choices = 1, selected = 1
        if (northWest !== 0 && this.nextInt(choices++) === 0) selected = northWest
        if (northEast !== 0 && this.nextInt(choices++) === 0) selected = northEast
        if (southWest !== 0 && this.nextInt(choices++) === 0) selected = southWest
        if (southEast !== 0 && this.nextInt(choices++) === 0) selected = southEast
        result[dx + dz * width] = this.nextInt(3) === 0
          ? selected
          : selected === VANILLA_BIOME.ICE_PLAINS ? VANILLA_BIOME.FROZEN_OCEAN : 0
      } else if (center > 0 && (northWest === 0 || northEast === 0 || southWest === 0 || southEast === 0)) {
        result[dx + dz * width] = this.nextInt(5) === 0
          ? center === VANILLA_BIOME.ICE_PLAINS ? VANILLA_BIOME.FROZEN_OCEAN : 0
          : center
      } else {
        result[dx + dz * width] = center
      }
    }
    return result
  }
}

class AddSnowLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const center = source[dx + 1 + (dz + 1) * stride]
      this.initChunkSeed(x + dx, z + dz)
      result[dx + dz * width] = center === 0 ? 0 : this.nextInt(5) === 0 ? VANILLA_BIOME.ICE_PLAINS : 1
    }
    return result
  }
}

class MushroomLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const nw = source[dx + dz * stride], ne = source[dx + 2 + dz * stride]
      const sw = source[dx + (dz + 2) * stride], se = source[dx + 2 + (dz + 2) * stride]
      const center = source[dx + 1 + (dz + 1) * stride]
      this.initChunkSeed(x + dx, z + dz)
      result[dx + dz * width] = center === 0 && nw === 0 && ne === 0 && sw === 0 && se === 0 &&
        this.nextInt(100) === 0 ? VANILLA_BIOME.MUSHROOM_ISLAND : center
    }
    return result
  }
}

class RiverInitLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x, z, width, height)
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      this.initChunkSeed(x + dx, z + dz)
      const index = dx + dz * width
      result[index] = source[index] <= 0 ? 0 : this.nextInt(2) + 2
    }
    return result
  }
}

class BiomeLayer extends GenLayer {
  private readonly allowed = [
    VANILLA_BIOME.DESERT, VANILLA_BIOME.FOREST, VANILLA_BIOME.EXTREME_HILLS,
    VANILLA_BIOME.SWAMP, VANILLA_BIOME.PLAINS, VANILLA_BIOME.TAIGA, VANILLA_BIOME.JUNGLE
  ]

  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x, z, width, height)
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      this.initChunkSeed(x + dx, z + dz)
      const index = dx + dz * width, value = source[index]
      result[index] = value === 0 ? 0
        : value === VANILLA_BIOME.MUSHROOM_ISLAND ? value
          : value === 1 ? this.allowed[this.nextInt(this.allowed.length)] : VANILLA_BIOME.ICE_PLAINS
    }
    return result
  }
}

class HillsLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    const variants: Record<number, number> = {
      [VANILLA_BIOME.DESERT]: VANILLA_BIOME.DESERT_HILLS,
      [VANILLA_BIOME.FOREST]: VANILLA_BIOME.FOREST_HILLS,
      [VANILLA_BIOME.TAIGA]: VANILLA_BIOME.TAIGA_HILLS,
      [VANILLA_BIOME.PLAINS]: VANILLA_BIOME.FOREST,
      [VANILLA_BIOME.ICE_PLAINS]: VANILLA_BIOME.ICE_MOUNTAINS,
      [VANILLA_BIOME.JUNGLE]: VANILLA_BIOME.JUNGLE_HILLS
    }
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      this.initChunkSeed(x + dx, z + dz)
      const center = source[dx + 1 + (dz + 1) * stride]
      const variant = variants[center] ?? center
      result[dx + dz * width] = this.nextInt(3) === 0 && variant !== center &&
        source[dx + 1 + dz * stride] === center &&
        source[dx + 2 + (dz + 1) * stride] === center &&
        source[dx + (dz + 1) * stride] === center &&
        source[dx + 1 + (dz + 2) * stride] === center ? variant : center
    }
    return result
  }
}

class ShoreLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const center = source[dx + 1 + (dz + 1) * stride]
      const north = source[dx + 1 + dz * stride], east = source[dx + 2 + (dz + 1) * stride]
      const west = source[dx + (dz + 1) * stride], south = source[dx + 1 + (dz + 2) * stride]
      const touchesOcean = north === 0 || east === 0 || west === 0 || south === 0
      if (center === VANILLA_BIOME.MUSHROOM_ISLAND) {
        result[dx + dz * width] = touchesOcean ? VANILLA_BIOME.MUSHROOM_SHORE : center
      } else if (center !== 0 && center !== VANILLA_BIOME.RIVER &&
        center !== VANILLA_BIOME.SWAMP && center !== VANILLA_BIOME.EXTREME_HILLS) {
        result[dx + dz * width] = touchesOcean ? VANILLA_BIOME.BEACH : center
      } else if (center === VANILLA_BIOME.EXTREME_HILLS) {
        result[dx + dz * width] = north !== center || east !== center || west !== center || south !== center
          ? VANILLA_BIOME.EXTREME_HILLS_EDGE : center
      } else result[dx + dz * width] = center
    }
    return result
  }
}

class SwampRiversLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      this.initChunkSeed(x + dx, z + dz)
      const center = source[dx + 1 + (dz + 1) * stride]
      result[dx + dz * width] = center === VANILLA_BIOME.SWAMP && this.nextInt(6) === 0
        ? VANILLA_BIOME.RIVER
        : (center === VANILLA_BIOME.JUNGLE || center === VANILLA_BIOME.JUNGLE_HILLS) &&
          this.nextInt(8) === 0 ? VANILLA_BIOME.RIVER : center
    }
    return result
  }
}

class RiverLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const north = source[dx + 1 + dz * stride], east = source[dx + 2 + (dz + 1) * stride]
      const west = source[dx + (dz + 1) * stride], south = source[dx + 1 + (dz + 2) * stride]
      const center = source[dx + 1 + (dz + 1) * stride]
      result[dx + dz * width] = center === 0 || north === 0 || east === 0 || west === 0 || south === 0 ||
        center !== north || center !== east || center !== west || center !== south ? VANILLA_BIOME.RIVER : -1
    }
    return result
  }
}

class SmoothLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const source = this.parent!.getInts(x - 1, z - 1, width + 2, height + 2)
    const stride = width + 2
    const result = new Int32Array(width * height)
    for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
      const west = source[dx + (dz + 1) * stride], east = source[dx + 2 + (dz + 1) * stride]
      const north = source[dx + 1 + dz * stride], south = source[dx + 1 + (dz + 2) * stride]
      let center = source[dx + 1 + (dz + 1) * stride]
      if (west === east && north === south) {
        this.initChunkSeed(x + dx, z + dz)
        center = this.nextInt(2) === 0 ? west : north
      } else if (west === east) center = west
      else if (north === south) center = north
      result[dx + dz * width] = center
    }
    return result
  }
}

class RiverMixLayer extends GenLayer {
  constructor(seed: number, private readonly biomes: GenLayer, private readonly rivers: GenLayer) { super(seed) }

  override initWorldGenSeed(seed: bigint): void {
    this.biomes.initWorldGenSeed(seed)
    this.rivers.initWorldGenSeed(seed)
    super.initWorldGenSeed(seed)
  }

  getInts(x: number, z: number, width: number, height: number): Int32Array {
    const biomes = this.biomes.getInts(x, z, width, height)
    const rivers = this.rivers.getInts(x, z, width, height)
    const result = new Int32Array(width * height)
    for (let index = 0; index < result.length; index++) {
      if (biomes[index] === VANILLA_BIOME.OCEAN) result[index] = biomes[index]
      else if (rivers[index] < 0) result[index] = biomes[index]
      else if (biomes[index] === VANILLA_BIOME.ICE_PLAINS) result[index] = VANILLA_BIOME.FROZEN_RIVER
      else if (biomes[index] === VANILLA_BIOME.MUSHROOM_ISLAND ||
        biomes[index] === VANILLA_BIOME.MUSHROOM_SHORE) result[index] = VANILLA_BIOME.MUSHROOM_SHORE
      else result[index] = rivers[index]
    }
    return result
  }
}

class VoronoiLayer extends GenLayer {
  getInts(x: number, z: number, width: number, height: number): Int32Array {
    x -= 2
    z -= 2
    const parentX = x >> 2, parentZ = z >> 2
    const parentWidth = (width >> 2) + 3, parentHeight = (height >> 2) + 3
    const source = this.parent!.getInts(parentX, parentZ, parentWidth, parentHeight)
    const stride = parentWidth << 2
    const expanded = new Int32Array(stride * (parentHeight << 2))
    for (let row = 0; row < parentHeight - 1; row++) {
      let northWest = source[row * parentWidth], southWest = source[(row + 1) * parentWidth]
      for (let column = 0; column < parentWidth - 1; column++) {
        const spread = 3.6
        this.initChunkSeed((column + parentX) << 2, (row + parentZ) << 2)
        const nwX = (this.nextInt(1024) / 1024 - 0.5) * spread
        const nwZ = (this.nextInt(1024) / 1024 - 0.5) * spread
        this.initChunkSeed((column + parentX + 1) << 2, (row + parentZ) << 2)
        const neX = (this.nextInt(1024) / 1024 - 0.5) * spread + 4
        const neZ = (this.nextInt(1024) / 1024 - 0.5) * spread
        this.initChunkSeed((column + parentX) << 2, (row + parentZ + 1) << 2)
        const swX = (this.nextInt(1024) / 1024 - 0.5) * spread
        const swZ = (this.nextInt(1024) / 1024 - 0.5) * spread + 4
        this.initChunkSeed((column + parentX + 1) << 2, (row + parentZ + 1) << 2)
        const seX = (this.nextInt(1024) / 1024 - 0.5) * spread + 4
        const seZ = (this.nextInt(1024) / 1024 - 0.5) * spread + 4
        const northEast = source[column + 1 + row * parentWidth]
        const southEast = source[column + 1 + (row + 1) * parentWidth]
        for (let dz = 0; dz < 4; dz++) {
          let index = ((row << 2) + dz) * stride + (column << 2)
          for (let dx = 0; dx < 4; dx++) {
            const nw = (dz - nwZ) ** 2 + (dx - nwX) ** 2
            const ne = (dz - neZ) ** 2 + (dx - neX) ** 2
            const sw = (dz - swZ) ** 2 + (dx - swX) ** 2
            const se = (dz - seZ) ** 2 + (dx - seX) ** 2
            expanded[index++] = nw < ne && nw < sw && nw < se ? northWest
              : ne < nw && ne < sw && ne < se ? northEast
                : sw < nw && sw < ne && sw < se ? southWest : southEast
          }
        }
        northWest = northEast
        southWest = southEast
      }
    }
    const result = new Int32Array(width * height)
    for (let row = 0; row < height; row++) {
      const offset = (row + (z & 3)) * stride + (x & 3)
      result.set(expanded.subarray(offset, offset + width), row * width)
    }
    return result
  }
}

function zoom(seed: number, layer: GenLayer, count: number): GenLayer {
  for (let index = 0; index < count; index++) layer = new ZoomLayer(seed + index, layer)
  return layer
}

export interface VanillaGenLayers {
  readonly generation: { getInts(x: number, z: number, width: number, height: number): Int32Array }
  readonly blocks: { getInts(x: number, z: number, width: number, height: number): Int32Array }
}

/** Exact DEFAULT-world GenLayer graph from Minecraft 1.2.5. */
export function createVanillaGenLayers(seed: bigint): VanillaGenLayers {
  let land: GenLayer = new IslandLayer(1)
  land = new ZoomLayer(2000, land, true)
  land = new AddIslandLayer(1, land)
  land = new ZoomLayer(2001, land)
  land = new AddIslandLayer(2, land)
  land = new AddSnowLayer(2, land)
  land = new ZoomLayer(2002, land)
  land = new AddIslandLayer(3, land)
  land = new ZoomLayer(2003, land)
  land = new AddIslandLayer(4, land)
  land = new MushroomLayer(5, land)

  let rivers = new RiverInitLayer(100, zoom(1000, land, 0))
  rivers = zoom(1000, rivers, 6)
  rivers = new RiverLayer(1, rivers)
  rivers = new SmoothLayer(1000, rivers)

  let biomes: GenLayer = new BiomeLayer(200, zoom(1000, land, 0))
  biomes = zoom(1000, biomes, 2)
  biomes = new HillsLayer(1000, biomes)
  for (let index = 0; index < 4; index++) {
    biomes = new ZoomLayer(1000 + index, biomes)
    if (index === 0) biomes = new AddIslandLayer(3, biomes)
    if (index === 1) {
      biomes = new ShoreLayer(1000, biomes)
      biomes = new SwampRiversLayer(1000, biomes)
    }
  }
  biomes = new SmoothLayer(1000, biomes)
  const mixed = new RiverMixLayer(100, biomes, rivers)
  const voronoi = new VoronoiLayer(10, mixed)
  mixed.initWorldGenSeed(seed)
  voronoi.initWorldGenSeed(seed)
  return { generation: mixed, blocks: voronoi }
}
