import { B, OPAQUE, SOLID, isWater, canSupportVine } from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { hash2, mulberry32 } from '../util/math'
import { Random, BiomeDecoratorSampler, TreeGeneratorKind, DecorationFeatureKind, PlacementMode, DecorationPlacement, DecorationBounds, DecorationFeature, DecoratorAttemptCounts, DecoratorProfile, BiomeDecorationPlan, DecoratorStampStats, DecoratorCacheStats, DECORATOR_BIOME, BASE_PROFILE, profile, DECORATOR_PROFILES, WeightedTreeKind, TREE_WEIGHTS, DEFAULT_TREE_WEIGHTS, treeWeightsForBiome, selectTreeGenerator, DECORATOR_PLAN_CACHE_LIMIT, DECORATOR_SOURCE_OFFSETS, DECORATOR_SALT, CARDINALS, nextInt, sourceKey, clampY, topSolidOrLiquidY, isLeaf, isSmallPlant, treeReplaceable, groundForTree, groundForPlant, placementReplaceable, intersectsChunk, linePoints } from './BiomeDecoratorShared'
import { PlanningWorld, FeatureBuilder, clearForTree, addLeafDisk, addConiferDisk, hangVine, smallTree, bigOak, taigaTree, swampTree, jungleShrub, jungleHuge, generateTree, hugeMushroom } from './BiomeDecoratorTrees'
import { terrainDisk, flowerPatch, grassPatch, deadBushPatch, mushroomPatch, hasAdjacentWater, reedPatch, cactusCanStay, cactusPatch, waterLilyPatch, pumpkinPatch, vineColumn, boundsFor } from './BiomeDecoratorFlora'
import { profileForBiome, planTree, planHugeMushroom, buildPlan } from './BiomeDecoratorPlanning'

export * from './BiomeDecoratorShared'
export * from './BiomeDecoratorTrees'
export * from './BiomeDecoratorFlora'
export * from './BiomeDecoratorPlanning'

export class BiomeDecorator {
  readonly seed: number
  private planCaches = new WeakMap<BiomeDecoratorSampler, Map<string, BiomeDecorationPlan>>()

  constructor(seed: number) { this.seed = seed | 0 }

  planForSource(
    sourceCx: number,
    sourceCz: number,
    sampler: BiomeDecoratorSampler
  ): BiomeDecorationPlan {
    let cache = this.planCaches.get(sampler)
    if (!cache) {
      cache = new Map()
      this.planCaches.set(sampler, cache)
    }
    const key = sourceKey(sourceCx, sourceCz)
    const cached = cache.get(key)
    if (cached) return cached
    const plan = buildPlan(this.seed, sourceCx, sourceCz, sampler)
    if (cache.size >= DECORATOR_PLAN_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, plan)
    return plan
  }

  plansForChunk(cx: number, cz: number, sampler: BiomeDecoratorSampler): BiomeDecorationPlan[] {
    const result: BiomeDecorationPlan[] = []
    for (const dx of DECORATOR_SOURCE_OFFSETS) for (const dz of DECORATOR_SOURCE_OFFSETS) {
      const plan = this.planForSource(cx + dx, cz + dz, sampler)
      if (plan.features.some(feature => intersectsChunk(feature.bounds, cx, cz))) result.push(plan)
    }
    return result.sort((a, b) => a.sourceCx - b.sourceCx || a.sourceCz - b.sourceCz)
  }

  /** Diagnostic seam for a single accepted feature. */
  stampFeatureInto(chunk: Chunk, feature: DecorationFeature): number {
    if (!intersectsChunk(feature.bounds, chunk.cx, chunk.cz)) return 0
    const bx = chunk.cx * CHUNK_SIZE, bz = chunk.cz * CHUNK_SIZE
    let changed = 0
    for (const placement of feature.placements) {
      const lx = placement.x - bx, lz = placement.z - bz
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE ||
        placement.y < 0 || placement.y >= WORLD_HEIGHT) continue
      const index = Chunk.index(lx, placement.y, lz)
      const current = chunk.blocks[index]
      if (current === placement.block || !placementReplaceable(current, placement)) continue
      chunk.blocks[index] = placement.block
      changed++
    }
    return changed
  }

  decorateChunk(chunk: Chunk, sampler: BiomeDecoratorSampler): DecoratorStampStats {
    const stats: DecoratorStampStats = {
      plansTested: 0, featuresTested: 0, featuresStamped: 0, blocksChanged: 0
    }
    for (const plan of this.plansForChunk(chunk.cx, chunk.cz, sampler)) {
      stats.plansTested++
      for (const feature of plan.features) {
        if (!intersectsChunk(feature.bounds, chunk.cx, chunk.cz)) continue
        stats.featuresTested++
        const changed = this.stampFeatureInto(chunk, feature)
        if (changed > 0) stats.featuresStamped++
        stats.blocksChanged += changed
      }
    }
    return stats
  }

  cacheStatsFor(sampler: BiomeDecoratorSampler): DecoratorCacheStats {
    return { plans: this.planCaches.get(sampler)?.size ?? 0 }
  }

  clearCaches(): void { this.planCaches = new WeakMap() }
}
