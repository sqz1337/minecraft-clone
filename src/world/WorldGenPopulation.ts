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
import type { WorldGen } from './WorldGen'

type WorldGenConstructor = { prototype: WorldGen }

export function installWorldGenPopulation(WorldGenClass: WorldGenConstructor): void {
  const prototype = WorldGenClass.prototype
  prototype.fillChunk = function(this: WorldGen, chunk: Chunk): void {
    const bx = chunk.cx * CHUNK_SIZE
    const bz = chunk.cz * CHUNK_SIZE
    const blocks = chunk.blocks
    const seed = this.seedNum

    if (this.generatorVersion >= 3) {
      this.densityTerrain.copyInto(chunk)
    } else for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = bx + lx, wz = bz + lz
        const info = this.columnInfo(wx, wz)
        const h = info.height
        const biome = info.biome
        const col = ((lx << 4) | lz) << 7
        chunk.colBiome[(lx << 4) | lz] = biome
        chunk.colHeight[(lx << 4) | lz] = h

        const { top, under, underDepth } = this.surfaceMaterials(wx, wz, info)

        const bedrockH = 1 + (hash2(wx, wz, seed ^ 0x5555) % 2)
        for (let y = 0; y <= h; y++) {
          let id: number
          if (y <= bedrockH) id = B.BEDROCK
          else if (y === h) id = top
          else if (y >= h - underDepth) id = under
          else id = B.STONE
          blocks[col | y] = id
        }

        // water fill
        if (h < this.seaLevel) {
          for (let y = h + 1; y <= this.seaLevel; y++) blocks[col | y] = B.WATER
        }

        // Generator v1 is retained for historical sparse-edit saves. New worlds
        // replay recursive cross-chunk plans after all base columns exist.
        if (this.generatorVersion === 1 && h >= this.seaLevel + 2) {
          // Most tunnels stay underground; rare matching surface samples extend
          // the same noise-carved tunnel outside as a natural cave entrance.
          const surfaceCave1 = Math.abs(this.cave1.noise3(wx * 0.017, h * 0.024, wz * 0.017))
          const surfaceCave2 = Math.abs(this.cave2.noise3(wx * 0.017, h * 0.024, wz * 0.017))
          const opensToSurface = surfaceCave1 < 0.065 && surfaceCave2 < 0.065
          const yTop = Math.min(opensToSurface ? h : h - 7, 90)
          for (let y = 5; y <= yTop; y++) {
            const n1 = Math.abs(this.cave1.noise3(wx * 0.017, y * 0.024, wz * 0.017))
            if (n1 > 0.1) continue
            const n2 = Math.abs(this.cave2.noise3(wx * 0.017, y * 0.024, wz * 0.017))
            if (n2 < 0.1) blocks[col | y] = B.AIR
          }
        }

        if (this.generatorVersion === 1) {
          this.decorateLegacyColumn(chunk, lx, lz, top, h, biome, true)
        }
      }
    }

    if (this.generatorVersion >= 2) {
      this.carvers.carveChunk(chunk, this)
      if (this.generatorVersion === 2) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const wx = bx + lx, wz = bz + lz
          const info = this.columnInfo(wx, wz)
          const { top } = this.surfaceMaterials(wx, wz, info)
          this.decorateLegacyColumn(chunk, lx, lz, top, info.height, info.biome, false)
        }
      }
    }

    if (this.generatorVersion >= 3) {
      // Classic population order: minable ellipsoids precede biome vegetation.
      this.oreGenerator.stampChunk(chunk)
      this.biomeDecorator.decorateChunk(chunk, this)
    } else {
      // Frozen v1/v2 population baseline for sparse-edit saves.
      this.stampOres(chunk)
      for (let tx = bx - 3; tx < bx + CHUNK_SIZE + 3; tx++) {
        for (let tz = bz - 3; tz < bz + CHUNK_SIZE + 3; tz++) {
          const tree = this.treeAt(tx, tz)
          if (tree) this.stampTree(chunk, tree)
        }
      }
    }

    // structures carve last so their interiors stay clear of terrain and trees
    this.stampStructures(chunk)

    chunk.state = 1
  }
  prototype.decorateLegacyColumn = function(this: WorldGen, chunk: Chunk, lx: number, lz: number, top: number, h: number, biome: number, fillDeepCaveAir: boolean): void {
    const wx = chunk.cx * CHUNK_SIZE + lx
    const wz = chunk.cz * CHUNK_SIZE + lz
    const col = ((lx << 4) | lz) << 7
    const blocks = chunk.blocks
    const seed = this.seedNum

    if (top === B.GRASS && h + 1 < WORLD_HEIGHT && blocks[col | h] === B.GRASS) {
      const r = hash01(wx, wz, seed ^ 0xdead)
      const dense = biome === BIOME.JUNGLE ? 0.24
        : biome === BIOME.FOREST ? 0.16
        : biome === BIOME.SWAMP ? 0.14
        : biome === BIOME.PLAINS ? 0.11
        : biome === BIOME.TAIGA ? 0.08
        : 0.04
      if (r < dense) {
        const fernish = (biome === BIOME.JUNGLE || biome === BIOME.TAIGA) && r < dense * 0.5
        blocks[col | (h + 1)] = fernish ? B.FERN : B.TALLGRASS
      } else if (r < dense + 0.014 && (biome === BIOME.PLAINS || biome === BIOME.FOREST)) {
        blocks[col | (h + 1)] = r < dense + 0.007 ? B.FLOWER_Y : B.FLOWER_R
      } else if (r < dense + 0.02 && biome === BIOME.SWAMP) {
        blocks[col | (h + 1)] = r < dense + 0.01 ? B.MUSHROOM_BROWN : B.MUSHROOM_RED
      }
    }

    if (top === B.MYCELIUM && h + 1 < WORLD_HEIGHT && blocks[col | h] === B.MYCELIUM) {
      const r = hash01(wx, wz, seed ^ 0x517005)
      if (r < 0.045) blocks[col | (h + 1)] = r < 0.022 ? B.MUSHROOM_RED : B.MUSHROOM_BROWN
    }

    if ((top === B.GRASS || top === B.SAND) && h === this.seaLevel && blocks[col | (h + 1)] === B.AIR) {
      const wetBank = this.columnInfo(wx + 1, wz).height < this.seaLevel ||
        this.columnInfo(wx - 1, wz).height < this.seaLevel ||
        this.columnInfo(wx, wz + 1).height < this.seaLevel ||
        this.columnInfo(wx, wz - 1).height < this.seaLevel
      const caneChance = biome === BIOME.SWAMP ? 0.16 : 0.08
      if (wetBank && hash01(wx, wz, seed ^ 0x5ca1e) < caneChance) {
        const height = 1 + hash2(wx, wz, seed ^ 0xc4ae) % 3
        for (let dy = 1; dy <= height && h + dy < WORLD_HEIGHT; dy++) blocks[col | (h + dy)] = B.SUGARCANE
      }
    }

    if (h >= this.seaLevel + 2) {
      for (let y = 6; y < h - 7; y++) {
        if (blocks[col | y] !== B.AIR || blocks[col | (y - 1)] === B.AIR || blocks[col | (y - 1)] === B.WATER) continue
        if (hash2(wx ^ Math.imul(y, 131), wz, seed ^ 0x6d757368) % 3072 === 0) {
          blocks[col | y] = hash2(wx, wz ^ y, seed) & 1 ? B.MUSHROOM_BROWN : B.MUSHROOM_RED
        }
      }
    }

    if (fillDeepCaveAir) {
      for (let y = 3; y <= 10; y++) if (blocks[col | y] === B.AIR) blocks[col | y] = B.LAVA
    }
  }
  prototype.stampOres = function(this: WorldGen, chunk: Chunk): void {
    // Include neighboring source chunks so veins continue cleanly across chunk borders.
    for (const ore of ORE_DEFS) {
      for (let sourceCx = chunk.cx - 1; sourceCx <= chunk.cx + 1; sourceCx++) {
        for (let sourceCz = chunk.cz - 1; sourceCz <= chunk.cz + 1; sourceCz++) {
          for (let vein = 0; vein < ore.veinsPerChunk; vein++) {
            const veinSeed = hash2(
              sourceCx,
              sourceCz,
              this.seedNum ^ ore.salt ^ Math.imul(vein + 1, 0x9e3779b1)
            )
            const random = mulberry32(veinSeed)
            let x = sourceCx * CHUNK_SIZE + random() * CHUNK_SIZE
            let y = ore.minY + random() * (ore.maxY - ore.minY + 1)
            let z = sourceCz * CHUNK_SIZE + random() * CHUNK_SIZE
            const size = ore.minSize + Math.floor(random() * (ore.maxSize - ore.minSize + 1))

            for (let step = 0; step < size; step++) {
              const radius = (0.62 + random() * 0.68) * ore.radiusScale
              this.stampOreSphere(chunk, ore.id, x, y, z, radius, ore.minY, ore.maxY)
              x += (random() - 0.5) * 1.7
              y = clamp(y + (random() - 0.5) * 1.15, ore.minY, ore.maxY)
              z += (random() - 0.5) * 1.7
            }
          }
        }
      }
    }
  }
  prototype.stampOreSphere = function(this: WorldGen, chunk: Chunk, oreId: number, centerX: number, centerY: number, centerZ: number, radius: number, oreMinY: number, oreMaxY: number): void {
    const bx = chunk.cx * CHUNK_SIZE
    const bz = chunk.cz * CHUNK_SIZE
    const minX = Math.max(bx, Math.floor(centerX - radius))
    const maxX = Math.min(bx + CHUNK_SIZE - 1, Math.floor(centerX + radius))
    const minZ = Math.max(bz, Math.floor(centerZ - radius))
    const maxZ = Math.min(bz + CHUNK_SIZE - 1, Math.floor(centerZ + radius))
    const minY = Math.max(oreMinY, Math.floor(centerY - radius))
    const maxY = Math.min(oreMaxY, Math.floor(centerY + radius))
    if (minX > maxX || minZ > maxZ) return

    const radiusSq = radius * radius
    for (let wx = minX; wx <= maxX; wx++) {
      for (let wz = minZ; wz <= maxZ; wz++) {
        for (let y = minY; y <= maxY; y++) {
          const dx = wx + 0.5 - centerX
          const dy = y + 0.5 - centerY
          const dz = wz + 0.5 - centerZ
          if (dx * dx + dy * dy + dz * dz > radiusSq) continue
          const index = Chunk.index(wx - bx, y, wz - bz)
          if (chunk.blocks[index] === B.STONE) chunk.blocks[index] = oreId
        }
      }
    }
  }
}
