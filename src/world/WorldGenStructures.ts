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
type SpawnPoint = { x: number; z: number; yaw: number }
type ScoredSpawnPoint = SpawnPoint & { score: number }

function spawnCandidate(gen: WorldGen, i: number): ScoredSpawnPoint | null {
  const x = Math.round((hash01(i, 17, gen.seedNum ^ 0xf00d) - 0.5) * 900)
  const z = Math.round((hash01(i, 71, gen.seedNum ^ 0xbeef) - 0.5) * 900)
  const info = gen.columnInfo(x, z)
  if (info.height < gen.seaLevel + 6 || info.height > gen.seaLevel + 48) return null
  if (info.biome === BIOME.DESERT || info.biome === BIOME.OCEAN || info.biome === BIOME.RIVER ||
    info.biome === BIOME.SWAMP || info.biome === BIOME.MUSHROOM) return null

  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (gen.treeAt(x + dx, z + dz)) return null
    }
  }

  let bestDir = -1, bestDirScore = -1
  for (let d = 0; d < 8; d++) {
    const ang = d * Math.PI / 4
    let waterBonus = 0, dropBonus = 0, treeBonus = 0
    for (let step = 2; step <= 7; step++) {
      const sx = Math.round(x + Math.cos(ang) * step * 14)
      const sz = Math.round(z + Math.sin(ang) * step * 14)
      const sample = gen.columnInfo(sx, sz)
      if (sample.height < gen.seaLevel) waterBonus += 4
      if (sample.height < info.height - 6) dropBonus += 1.5
      if (sample.treeDensity > 0.01) treeBonus += 1
    }
    const directionScore = waterBonus + dropBonus + treeBonus
    if (directionScore > bestDirScore) {
      bestDirScore = directionScore
      bestDir = d
    }
  }

  const vx = Math.floor(Math.floor(x / CHUNK_SIZE) / VILLAGE_SPACING)
  const vz = Math.floor(Math.floor(z / CHUNK_SIZE) / VILLAGE_SPACING)
  let villageBonus = 0
  for (let ax = vx - 1; ax <= vx + 1 && villageBonus === 0; ax++) {
    for (let az = vz - 1; az <= vz + 1; az++) {
      const village = gen.villageIn(ax, az)
      if (village && Math.hypot(village.centerX - x, village.centerZ - z) < 160) {
        villageBonus = 6
        break
      }
    }
  }

  const score = bestDirScore
    + villageBonus
    + Math.min(info.height - gen.seaLevel, 26) * 0.25
    + (info.biome === BIOME.FOREST || info.biome === BIOME.PLAINS ? 3 : 0)
    + (info.biome === BIOME.SNOW ? -3 : 0)
  const ang = bestDir * Math.PI / 4
  return { x, z, yaw: Math.atan2(-Math.cos(ang), -Math.sin(ang)), score }
}

function spawnResult(best: ScoredSpawnPoint | null): SpawnPoint {
  return best ? { x: best.x, z: best.z, yaw: best.yaw } : { x: 8, z: 8, yaw: 0 }
}

export function installWorldGenStructures(WorldGenClass: WorldGenConstructor): void {
  const prototype = WorldGenClass.prototype
  prototype.setInChunk = function(this: WorldGen, chunk: Chunk, wx: number, y: number, wz: number, id: number, replaceSolid = false): void {
    const lx = wx - chunk.cx * CHUNK_SIZE
    const lz = wz - chunk.cz * CHUNK_SIZE
    if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return
    const i = (((lx << 4) | lz) << 7) | y
    const cur = chunk.blocks[i]
    if (!replaceSolid && cur !== B.AIR && cur !== B.TALLGRASS && cur !== B.FERN &&
      cur !== B.FLOWER_Y && cur !== B.FLOWER_R) return
    chunk.blocks[i] = id
  }
  prototype.stampTree = function(this: WorldGen, chunk: Chunk, tree: TreeDef): void {
    const { x, z, baseY, height, kind } = tree
    const topY = baseY + height

    if (kind === 'pine') {
      const leafId = B.PINELEAVES
      // conical spruce
      let radius = 2
      for (let y = topY; y >= baseY + 1; y--) {
        const layer = topY - y
        const r = layer === 0 ? 0 : Math.min(radius, 1 + Math.floor(layer / 2))
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > r + (layer % 2 === 0 ? 0 : 1)) continue
          if (dx === 0 && dz === 0 && y < topY) continue
          this.setInChunk(chunk, x + dx, y, z + dz, leafId)
        }
      }
      this.setInChunk(chunk, x, topY + 1, z, leafId)
      for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.PINELOG, true)
      return
    }

    if (kind === 'mushroom_red' || kind === 'mushroom_brown') {
      const capId = kind === 'mushroom_red' ? B.MUSHROOM_CAP_RED : B.MUSHROOM_CAP_BROWN
      const stemTop = baseY + height - 1
      if (kind === 'mushroom_red') {
        // hollow dome: 5x5 skirt ring two layers tall plus a 3x3 top plate
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue
            if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue
            this.setInChunk(chunk, x + dx, stemTop + dy, z + dz, capId)
          }
        }
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          this.setInChunk(chunk, x + dx, stemTop + 1, z + dz, capId)
        }
      } else {
        // flat 7x7 plate with clipped corners
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          if (Math.abs(dx) === 3 && Math.abs(dz) === 3) continue
          this.setInChunk(chunk, x + dx, stemTop + 1, z + dz, capId)
        }
      }
      for (let y = baseY; y <= stemTop; y++) this.setInChunk(chunk, x, y, z, B.MUSHROOM_STEM, true)
      return
    }

    if (kind === 'jungle') {
      const leafId = B.JUNGLE_LEAVES
      // broad two-layer canopy with a small crown
      for (let dy = -1; dy <= 0; dy++) {
        const r = 3
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r) continue
          if (Math.abs(dx) + Math.abs(dz) > r + 1 && hash01(x + dx * 5, z + dz * 11 + dy, this.seedNum ^ 0x77) > 0.5) continue
          this.setInChunk(chunk, x + dx, topY + dy, z + dz, leafId)
        }
      }
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        this.setInChunk(chunk, x + dx, topY + 1, z + dz, leafId)
      }
      for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.JUNGLE_LOG, true)
      return
    }

    if (kind === 'swamp') {
      const leafId = B.LEAVES
      // wide, flat canopy hanging near the water
      for (let dy = -1; dy <= 0; dy++) {
        const r = 3
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r) continue
          if (dy === -1 && Math.abs(dx) < 2 && Math.abs(dz) < 2) continue
          this.setInChunk(chunk, x + dx, topY + dy, z + dz, leafId)
        }
      }
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue
        this.setInChunk(chunk, x + dx, topY + 1, z + dz, leafId)
      }
      for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.LOG, true)
      return
    }

    // oak blob canopy
    for (let dy = -2; dy <= 1; dy++) {
      const y = topY + dy
      const r = dy <= -1 ? 2 : 1
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && hash01(x + dx * 7, z + dz * 13 + y, this.seedNum ^ 0x33) > 0.4) continue
        this.setInChunk(chunk, x + dx, y, z + dz, B.LEAVES)
      }
    }
    for (let y = baseY; y < topY; y++) this.setInChunk(chunk, x, y, z, B.LOG, true)
  }
  prototype.stampStructures = function(this: WorldGen, chunk: Chunk): void { this.structureIndex.stampChunk(chunk) }
  prototype.dungeonIn = function(this: WorldGen, cx: number, cz: number): DungeonPlan | null { return this.structureIndex.dungeonIn(cx, cz) }
  prototype.dungeonsIn = function(this: WorldGen, cx: number, cz: number): readonly DungeonPlan[] { return this.structureIndex.dungeonsIn(cx, cz) }
  prototype.mineshaftIn = function(this: WorldGen, cx: number, cz: number): MineshaftPlan | null { return this.structureIndex.mineshaftIn(cx, cz) }
  prototype.strongholds = function(this: WorldGen): StrongholdPlan[] { return this.structureIndex.strongholds() }
  prototype.villageIn = function(this: WorldGen, regionX: number, regionZ: number): VillagePlan | null {
    return this.structureIndex.villageIn(regionX, regionZ)
  }
  prototype.villageCandidate = function(this: WorldGen, regionX: number, regionZ: number): { cx: number; cz: number } {
    return this.structureIndex.villageCandidate(regionX, regionZ)
  }
  prototype.structurePlansIn = function(this: WorldGen, cx: number, cz: number): readonly StructurePlan[] {
    return this.structureIndex.plansForChunk(cx, cz)
  }
  prototype.primeStructurePlans = function(this: WorldGen, cx: number, cz: number, plans: readonly StructurePlan[]): void {
    this.structureIndex.primePlansForChunk(cx, cz, plans)
  }
  prototype.structureChestsIn = function(this: WorldGen, cx: number, cz: number): StructureChest[] {
    return this.structureIndex.structureChestsIn(cx, cz)
  }
  prototype.structureSpawnersNear = function(this: WorldGen, x: number, z: number, radius: number): StructureSpawner[] {
    return this.structureIndex.structureSpawnersNear(x, z, radius)
  }
  prototype.villagerSpawnsIn = function(this: WorldGen, cx: number, cz: number): VillagerSpot[] {
    return this.structureIndex.villagerSpawnsIn(cx, cz)
  }
  prototype.villageFeaturesIn = function(this: WorldGen, cx: number, cz: number): VillageInfo[] {
    return this.structureIndex.villageFeaturesIn(cx, cz)
  }
  prototype.nearestStronghold = function(this: WorldGen, x: number, z: number): { x: number; z: number } | null {
    return this.structureIndex.nearestStronghold(x, z)
  }
  prototype.findSpawn = function(this: WorldGen): SpawnPoint {
    let best: ScoredSpawnPoint | null = null
    for (let i = 0; i < 260; i++) {
      const candidate = spawnCandidate(this, i)
      if (candidate && (!best || candidate.score > best.score)) best = candidate
    }
    return spawnResult(best)
  }
  prototype.findSpawnAsync = async function(this: WorldGen): Promise<SpawnPoint> {
    let best: ScoredSpawnPoint | null = null
    let lastYield = performance.now()
    for (let i = 0; i < 260; i++) {
      const candidate = spawnCandidate(this, i)
      if (candidate && (!best || candidate.score > best.score)) best = candidate
      if (performance.now() - lastYield >= 12) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        lastYield = performance.now()
      }
    }
    return spawnResult(best)
  }
}
