import { SimplexNoise, fbm2, ridged2 } from '../util/Noise'
import { xmur3, hash01, hash2, mulberry32, clamp, lerp, smoothstep } from '../util/math'
import { B, SOLID } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { MapCarvers, type CarverBaseSampler } from './MapCarvers'
import { BiomeDecorator } from './BiomeDecorator'
import { OreGenerator } from './OreGenerator'
import { DensityTerrain, DENSITY_SEA_LEVEL } from './DensityTerrain'
import { BIOME, BIOME_NAMES, GRASS_TINT } from './Biomes'
import {
  StructureIndex,
  type DungeonPlan,
  type MineshaftPlan,
  type StrongholdPlan,
  type StructureChest,
  type StructurePlan,
  type StructureSpawner,
  type VillageInfo,
  type VillagePlan,
  type VillagerSpot
} from './structures/StructureIndex'
import { VILLAGE_SPACING } from './structures/Generators'
import { SEA_LEVEL, LEGACY_SEA_LEVEL, CURRENT_WORLD_GEN_VERSION, WorldGenVersion, JAVA_RANDOM_MULTIPLIER, JAVA_RANDOM_ADDEND, JAVA_RANDOM_MASK, SLIME_CHUNK_SALT, javaRandomNextInt10, isSlimeChunkForSeed, ColumnInfo, TreeKind, TreeDef, OreDef, ORE_DEFS } from './WorldGenShared'
import { installWorldGenTerrain } from './WorldGenTerrain'
import { installWorldGenPopulation } from './WorldGenPopulation'
import { installWorldGenStructures } from './WorldGenStructures'

export * from './WorldGenShared'

export class WorldGen {
  readonly seedNum: number

  readonly seedStr: string

  readonly generatorVersion: WorldGenVersion

  readonly seaLevel: number

  continent: SimplexNoise

  hills: SimplexNoise

  ridge: SimplexNoise

  mask: SimplexNoise

  temp: SimplexNoise

  moist: SimplexNoise

  river: SimplexNoise

  detail: SimplexNoise

  cave1: SimplexNoise

  cave2: SimplexNoise

  special: SimplexNoise

  carvers: MapCarvers

  oreGenerator: OreGenerator

  biomeDecorator: BiomeDecorator

  densityTerrain: DensityTerrain

  structureIndex: StructureIndex

  structureTerrainCache = new Map<string, Uint8Array>()

  colCache = new Map<string, ColumnInfo>()

  constructor(seedStr: string, generatorVersion: WorldGenVersion = CURRENT_WORLD_GEN_VERSION) {
      this.seedStr = seedStr
      this.generatorVersion = generatorVersion
      this.seaLevel = generatorVersion >= 3 ? SEA_LEVEL : LEGACY_SEA_LEVEL
      const s = xmur3(seedStr)
      this.seedNum = s
      this.continent = new SimplexNoise(s ^ 0x1000)
      this.hills = new SimplexNoise(s ^ 0x2000)
      this.ridge = new SimplexNoise(s ^ 0x3000)
      this.mask = new SimplexNoise(s ^ 0x4000)
      this.temp = new SimplexNoise(s ^ 0x5000)
      this.moist = new SimplexNoise(s ^ 0x6000)
      this.river = new SimplexNoise(s ^ 0x7000)
      this.detail = new SimplexNoise(s ^ 0x8000)
      this.cave1 = new SimplexNoise(s ^ 0x9000)
      this.cave2 = new SimplexNoise(s ^ 0xa000)
      this.special = new SimplexNoise(s ^ 0xb000)
      this.carvers = new MapCarvers(s)
      this.oreGenerator = new OreGenerator(s)
      this.biomeDecorator = new BiomeDecorator(s)
      this.densityTerrain = new DensityTerrain(s)
      this.structureIndex = new StructureIndex(s, this)
    }
}

export interface WorldGen {
  columnInfo(x: number, z: number): ColumnInfo
  heightAt(x: number, z: number): number
  surfaceY(x: number, z: number): number
  biomeAt(x: number, z: number): number
  isSlimeChunk(cx: number, cz: number): boolean
  baseBlockAt(x: number, y: number, z: number): number
  structureBlockAt(x: number, y: number, z: number): number
  structureSolidAt(x: number, y: number, z: number): boolean
  blockAt(x: number, y: number, z: number): number
  treeDensityForBiome(biome: number, height: number): number
  surfaceMaterials(x: number, z: number, info: ColumnInfo): { top: number; under: number; underDepth: number }
  treeAt(x: number, z: number): TreeDef | null
  fillChunk(chunk: Chunk): void
  decorateLegacyColumn(chunk: Chunk, lx: number, lz: number, top: number, h: number, biome: number, fillDeepCaveAir: boolean): void
  stampOres(chunk: Chunk): void
  stampOreSphere(chunk: Chunk, oreId: number, centerX: number, centerY: number, centerZ: number, radius: number, oreMinY: number, oreMaxY: number): void
  setInChunk(chunk: Chunk, wx: number, y: number, wz: number, id: number, replaceSolid?: boolean): void
  stampTree(chunk: Chunk, tree: TreeDef): void
  stampStructures(chunk: Chunk): void
  dungeonIn(cx: number, cz: number): DungeonPlan | null
  dungeonsIn(cx: number, cz: number): readonly DungeonPlan[]
  mineshaftIn(cx: number, cz: number): MineshaftPlan | null
  strongholds(): StrongholdPlan[]
  villageIn(regionX: number, regionZ: number): VillagePlan | null
  villageCandidate(regionX: number, regionZ: number): { cx: number; cz: number }
  structurePlansIn(cx: number, cz: number): readonly StructurePlan[]
  primeStructurePlans(cx: number, cz: number, plans: readonly StructurePlan[]): void
  structureChestsIn(cx: number, cz: number): StructureChest[]
  structureSpawnersNear(x: number, z: number, radius: number): StructureSpawner[]
  villagerSpawnsIn(cx: number, cz: number): VillagerSpot[]
  villageFeaturesIn(cx: number, cz: number): VillageInfo[]
  nearestStronghold(x: number, z: number): { x: number; z: number } | null
  findSpawn(): { x: number, z: number, yaw: number }
}

installWorldGenTerrain(WorldGen)
installWorldGenPopulation(WorldGen)
installWorldGenStructures(WorldGen)
