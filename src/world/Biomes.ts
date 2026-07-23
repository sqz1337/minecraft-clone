/**
 * Stable Realmcraft biome ids.  These numbers are stored in Chunk.colBiome and
 * are consumed by rendering, spawning, structures and biome decorators.
 */
export const BIOME = {
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  DESERT: 4,
  MOUNTAIN: 5,
  SNOW: 6,
  RIVER: 7,
  TAIGA: 8,
  SWAMP: 9,
  JUNGLE: 10,
  MUSHROOM: 11
} as const

export type BiomeId = (typeof BIOME)[keyof typeof BIOME]

export const BIOME_IDS: readonly BiomeId[] = Object.freeze([
  BIOME.OCEAN,
  BIOME.BEACH,
  BIOME.PLAINS,
  BIOME.FOREST,
  BIOME.DESERT,
  BIOME.MOUNTAIN,
  BIOME.SNOW,
  BIOME.RIVER,
  BIOME.TAIGA,
  BIOME.SWAMP,
  BIOME.JUNGLE,
  BIOME.MUSHROOM
])

export const BIOME_NAMES: readonly string[] = Object.freeze([
  'Ocean',
  'Beach',
  'Plains',
  'Forest',
  'Desert',
  'Mountains',
  'Snowfields',
  'River',
  'Taiga',
  'Swamp',
  'Jungle',
  'Mushroom Island'
])

/** Grass/foliage tint per biome (multiplies the pale grass texture). */
export const GRASS_TINT: readonly (readonly [number, number, number])[] = Object.freeze([
  [0.55, 0.72, 0.45], // ocean (normally unused)
  [0.66, 0.74, 0.44], // beach
  [0.62, 0.80, 0.38], // plains
  [0.40, 0.66, 0.28], // forest
  [0.72, 0.72, 0.40], // desert
  [0.52, 0.66, 0.40], // mountains
  [0.58, 0.70, 0.52], // snowfields
  [0.55, 0.75, 0.42], // river banks
  [0.45, 0.63, 0.42], // taiga
  [0.42, 0.55, 0.30], // swamp
  [0.30, 0.72, 0.20], // jungle
  [0.58, 0.62, 0.58]  // mushroom island
])

/** Minecraft 1.2.5 BiomeGenBase minHeight/maxHeight values. */
export interface BiomeTerrainProfile {
  readonly rootHeight: number
  readonly variation: number
}

export const BIOME_TERRAIN_PROFILES: Readonly<Record<BiomeId, BiomeTerrainProfile>> = Object.freeze({
  [BIOME.OCEAN]: Object.freeze({ rootHeight: -1.0, variation: 0.40 }),
  [BIOME.BEACH]: Object.freeze({ rootHeight: 0.0, variation: 0.10 }),
  [BIOME.PLAINS]: Object.freeze({ rootHeight: 0.10, variation: 0.30 }),
  [BIOME.FOREST]: Object.freeze({ rootHeight: 0.10, variation: 0.30 }),
  [BIOME.DESERT]: Object.freeze({ rootHeight: 0.10, variation: 0.20 }),
  [BIOME.MOUNTAIN]: Object.freeze({ rootHeight: 0.20, variation: 1.30 }),
  [BIOME.SNOW]: Object.freeze({ rootHeight: 0.10, variation: 0.30 }),
  [BIOME.RIVER]: Object.freeze({ rootHeight: -0.50, variation: 0.00 }),
  [BIOME.TAIGA]: Object.freeze({ rootHeight: 0.10, variation: 0.40 }),
  [BIOME.SWAMP]: Object.freeze({ rootHeight: -0.20, variation: 0.10 }),
  [BIOME.JUNGLE]: Object.freeze({ rootHeight: 0.20, variation: 0.40 }),
  [BIOME.MUSHROOM]: Object.freeze({ rootHeight: 0.20, variation: 1.00 })
})

export function isBiomeId(value: number): value is BiomeId {
  return Number.isInteger(value) && value >= BIOME.OCEAN && value <= BIOME.MUSHROOM
}

export function terrainProfileForBiome(biome: number): BiomeTerrainProfile {
  return BIOME_TERRAIN_PROFILES[isBiomeId(biome) ? biome : BIOME.PLAINS]
}
