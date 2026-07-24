import { B } from './Blocks'
import { BIOME } from './Biomes'
import { VANILLA_BIOME } from './JavaGenLayer'

export interface VanillaBiomeInfo {
  readonly minHeight: number
  readonly maxHeight: number
  readonly temperature: number
  readonly top: number
  readonly filler: number
}

const f = Math.fround
const DEFAULT = Object.freeze({
  minHeight: f(0.1), maxHeight: f(0.3), temperature: f(0.5),
  top: B.GRASS, filler: B.DIRT
})

const INFO: Readonly<Record<number, VanillaBiomeInfo>> = Object.freeze({
  [VANILLA_BIOME.OCEAN]: {
    ...DEFAULT, minHeight: f(-1), maxHeight: f(0.4),
    top: B.SAND, filler: B.SAND
  },
  [VANILLA_BIOME.PLAINS]: { ...DEFAULT, temperature: f(0.8) },
  [VANILLA_BIOME.DESERT]: {
    ...DEFAULT, minHeight: f(0.1), maxHeight: f(0.2), temperature: f(2),
    top: B.SAND, filler: B.SAND
  },
  [VANILLA_BIOME.EXTREME_HILLS]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(1.3), temperature: f(0.2)
  },
  [VANILLA_BIOME.FOREST]: { ...DEFAULT, temperature: f(0.7) },
  [VANILLA_BIOME.TAIGA]: {
    ...DEFAULT, minHeight: f(0.1), maxHeight: f(0.4), temperature: f(0.05)
  },
  [VANILLA_BIOME.SWAMP]: {
    ...DEFAULT, minHeight: f(-0.2), maxHeight: f(0.1), temperature: f(0.8)
  },
  [VANILLA_BIOME.RIVER]: { ...DEFAULT, minHeight: f(-0.5), maxHeight: f(0) },
  [VANILLA_BIOME.FROZEN_OCEAN]: {
    ...DEFAULT, minHeight: f(-1), maxHeight: f(0.5), temperature: f(0),
    top: B.SAND, filler: B.SAND
  },
  [VANILLA_BIOME.FROZEN_RIVER]: {
    ...DEFAULT, minHeight: f(-0.5), maxHeight: f(0), temperature: f(0)
  },
  [VANILLA_BIOME.ICE_PLAINS]: { ...DEFAULT, temperature: f(0) },
  [VANILLA_BIOME.ICE_MOUNTAINS]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(1.2), temperature: f(0)
  },
  [VANILLA_BIOME.MUSHROOM_ISLAND]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(1), temperature: f(0.9),
    top: B.MYCELIUM
  },
  [VANILLA_BIOME.MUSHROOM_SHORE]: {
    ...DEFAULT, minHeight: f(-1), maxHeight: f(0.1), temperature: f(0.9),
    top: B.MYCELIUM
  },
  [VANILLA_BIOME.BEACH]: {
    ...DEFAULT, minHeight: f(0), maxHeight: f(0.1), temperature: f(0.8),
    top: B.SAND, filler: B.SAND
  },
  [VANILLA_BIOME.DESERT_HILLS]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(0.7), temperature: f(2),
    top: B.SAND, filler: B.SAND
  },
  [VANILLA_BIOME.FOREST_HILLS]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(0.6), temperature: f(0.7)
  },
  [VANILLA_BIOME.TAIGA_HILLS]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(0.7), temperature: f(0.05)
  },
  [VANILLA_BIOME.EXTREME_HILLS_EDGE]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(0.8), temperature: f(0.2)
  },
  [VANILLA_BIOME.JUNGLE]: {
    ...DEFAULT, minHeight: f(0.2), maxHeight: f(0.4), temperature: f(1.2)
  },
  [VANILLA_BIOME.JUNGLE_HILLS]: {
    ...DEFAULT, minHeight: f(1.8), maxHeight: f(0.2), temperature: f(1.2)
  }
})

export function vanillaBiomeInfo(id: number): VanillaBiomeInfo { return INFO[id] ?? DEFAULT }

export function vanillaBiomeForProject(id: number, hill = false): number {
  switch (id) {
    case BIOME.OCEAN: return VANILLA_BIOME.OCEAN
    case BIOME.BEACH: return VANILLA_BIOME.BEACH
    case BIOME.PLAINS: return VANILLA_BIOME.PLAINS
    case BIOME.FOREST: return hill ? VANILLA_BIOME.FOREST_HILLS : VANILLA_BIOME.FOREST
    case BIOME.DESERT: return hill ? VANILLA_BIOME.DESERT_HILLS : VANILLA_BIOME.DESERT
    case BIOME.MOUNTAIN: return VANILLA_BIOME.EXTREME_HILLS
    case BIOME.SNOW: return hill ? VANILLA_BIOME.ICE_MOUNTAINS : VANILLA_BIOME.ICE_PLAINS
    case BIOME.RIVER: return VANILLA_BIOME.RIVER
    case BIOME.TAIGA: return hill ? VANILLA_BIOME.TAIGA_HILLS : VANILLA_BIOME.TAIGA
    case BIOME.SWAMP: return VANILLA_BIOME.SWAMP
    case BIOME.JUNGLE: return hill ? VANILLA_BIOME.JUNGLE_HILLS : VANILLA_BIOME.JUNGLE
    case BIOME.MUSHROOM: return VANILLA_BIOME.MUSHROOM_ISLAND
    default: return VANILLA_BIOME.PLAINS
  }
}
