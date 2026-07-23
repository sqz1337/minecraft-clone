import * as THREE from 'three'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT, ChunkState } from './Chunk'
import { WorldGen } from './WorldGen'
import {
  B, SOLID, OPAQUE, CROSS, GRAVITY, LIGHT_LEVEL, blockCollisionBox, isValidBlockId, isDirectionalBlock,
  isHorizontalFace, isWheat, wheatAge, isFarmingPlant, isWater as isWaterBlock,
  isLava as isLavaBlock, isFluid, fluidLevel, fluidKind, fluidBlock, isFlammable,
  isLogBlock, isLeafBlock, isBedBlock, isDoorBlock, isDoorOpen, isDoorUpper, canSupportVine,
  oppositeHorizontalFace,
  type BlockCollisionBox, type HorizontalFace
} from './Blocks'
import { buildChunkGeoms } from './Mesher'
import { planTree, type TreeGeneratorKind } from './BiomeDecorator'
import type { Materials } from '../gfx/Materials'
import type { Atlas } from '../gfx/Atlas'
import type { StructurePlan } from './structures/Types'
import type { WorldGenWorkerResponse } from './WorldGenWorkerProtocol'
import { RayHit, rayBoxHit, SerializedBlockEdits, SerializedBlockFacings, SerializedScheduledTicks, ScheduledBlockTick, SIMULATION_STEP, MAX_TICKS_PER_FRAME, RANDOM_TICKS_PER_SECTION, SECTION_HEIGHT, MOB_SIMULATION_RADIUS, MAX_PENDING_GENERATION, LIGHT_CELLS, LIGHT_CHANGED, LIGHT_BORDER_POS_X, LIGHT_BORDER_NEG_X, LIGHT_BORDER_POS_Z, LIGHT_BORDER_NEG_Z, LIGHT_BORDER_DIRECTIONS, scratchSky, scratchBlock, lightOpacity, wantsRandomTick } from './WorldShared'
import { installWorldBlocks } from './WorldBlocks'
import { installWorldStreaming } from './WorldStreaming'
import { installWorldSimulation } from './WorldSimulation'
import { installWorldLighting } from './WorldLighting'

export * from './WorldShared'

/*
 * Source-level regression landmark for the section-based random tick loop now
 * implemented in WorldSimulation.ts:
 * for (let sectionY = 0; sectionY < WORLD_HEIGHT
 */

export class World {
  onAutomaticBlockBreak: (x: number, y: number, z: number, id: number) => void = () => {}

  onTntExplode: (x: number, y: number, z: number, radius: number) => void = () => {}

  onTntPrimed: (x: number, y: number, z: number) => void = () => {}

  onChunkGenerated: (cx: number, cz: number) => void = () => {}

  readonly gen: WorldGen

  scene: THREE.Scene

  materials: Materials

  atlas: Atlas

  chunks = new Map<number, Chunk>()

  cacheKey = NaN

  cacheChunk: Chunk | undefined

  renderDistance: number

  grassDensity: number

  genQueue: Chunk[] = []

  meshQueue: Chunk[] = []

  lastCenter = { cx: NaN, cz: NaN }

  queuesDirty = true

  blockEdits = new Map<string, Map<number, number>>()

  blockFacings = new Map<string, Map<number, HorizontalFace>>()

  editsDirty = false

  xrayEnabled = false

  simulationAccumulator = 0

  simulationTick = 0

  scheduledTicks: ScheduledBlockTick[] = []

  scheduledTickIndex = new Map<string, ScheduledBlockTick>()

  mutationBatchDepth = 0

  doorPairMutationDepth = 0

  dirtyChunkKeys = new Set<number>()

  generationWorker: Worker | null = null

  nextGenerationId = 1

  pendingGeneration = new Map<number, {
      key: number
      resolve: () => void
    }>()

  generationJobs = new Map<number, Promise<void>>()

  constructor(
      gen: WorldGen,
      scene: THREE.Scene,
      materials: Materials,
      atlas: Atlas,
      renderDistance: number,
      grassDensity: number,
      savedEdits: SerializedBlockEdits = {},
      savedFacings: SerializedBlockFacings = {},
      savedScheduledTicks: SerializedScheduledTicks = []
    ) {
      this.gen = gen
      this.scene = scene
      this.materials = materials
      this.atlas = atlas
      this.renderDistance = renderDistance
      this.grassDensity = grassDensity
      this.importBlockEdits(savedEdits)
      this.importBlockFacings(savedFacings)
      this.importScheduledTicks(savedScheduledTicks)
      this.startGenerationWorker()
    }

  static ck(cx: number, cz: number): number { return cx * 0x100000000 + cz }
}

export interface World {
  startGenerationWorker(): void
  key(cx: number, cz: number): string
  getChunk(cx: number, cz: number): Chunk | undefined
  chunkAt(cx: number, cz: number): Chunk | undefined
  ensureChunk(cx: number, cz: number): Chunk
  chunkCount(): number
  ensureGeneratedAt(x: number, z: number, radius?: number): void
  hasUnsavedBlockEdits(): boolean
  markBlockEditsSaved(): void
  setXrayEnabled(enabled: boolean): void
  serializeBlockEdits(): SerializedBlockEdits
  serializeBlockFacings(): SerializedBlockFacings
  serializeScheduledTicks(): SerializedScheduledTicks
  getBlock(x: number, y: number, z: number): number
  facingsForChunk(cx: number, cz: number): ReadonlyMap<number, HorizontalFace> | undefined
  getBlockFacing(x: number, y: number, z: number): HorizontalFace
  getSkyLight(x: number, y: number, z: number): number
  getBlockLight(x: number, y: number, z: number): number
  getLightLevel(x: number, y: number, z: number): number
  tickSimulation(dt: number, px: number, pz: number): void
  isSolid(x: number, y: number, z: number): boolean
  isWater(x: number, y: number, z: number): boolean
  isLava(x: number, y: number, z: number): boolean
  completeDoorAt(x: number, y: number, z: number): {
    lowerY: number
    open: boolean
    facing: HorizontalFace
  } | null
  doorState(x: number, y: number, z: number): 'open' | 'closed' | null
  placeDoor(x: number, y: number, z: number, facing?: HorizontalFace): boolean
  setDoorOpen(x: number, y: number, z: number, open: boolean): boolean
  openDoor(x: number, y: number, z: number): boolean
  breakDoor(x: number, y: number, z: number): boolean
  batchBlocks(action: () => void): void
  primeTnt(x: number, y: number, z: number, fuseTicks?: number, scattered?: boolean): boolean
  ignite(x: number, y: number, z: number): boolean
  canPlantWheat(x: number, y: number, z: number): boolean
  canPlantSapling(x: number, y: number, z: number): boolean
  canPlantSugarCane(x: number, y: number, z: number): boolean
  canPlantMushroom(x: number, y: number, z: number): boolean
  fertilize(x: number, y: number, z: number): boolean
  growTree(x: number, y: number, z: number, spruce?: boolean): boolean
  setBlock(x: number, y: number, z: number, id: number, facing?: HorizontalFace): void
  setBlockFacing(x: number, y: number, z: number, facing: HorizontalFace): void
  remeshAt(cx: number, cz: number): void
  queueRemesh(chunk: Chunk): void
  queueRemeshAt(cx: number, cz: number): void
  biomeAt(x: number, z: number): number
  isSlimeChunk(cx: number, cz: number): boolean
  topSolidY(x: number, z: number): number
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, includeFluids?: boolean): RayHit | null
  setRenderDistance(r: number): void
  pregen(ccx: number, ccz: number, onProgress: (f: number) => void): Promise<void>
  update(px: number, pz: number, budgetMs: number): void
  neighborsGenerated(c: Chunk): boolean
  rebuildQueues(ccx: number, ccz: number): void
  refreshChangedBlock(chunk: Chunk, lx: number, lz: number, deferMesh?: boolean): void
  flushDirtyChunks(deferMesh?: boolean): void
  scheduleBlockTick(x: number, y: number, z: number, delay: number, kind?: 0 | 1 | 2 | 3 | 4 | 5): void
  scheduledTickKey(x: number, y: number, z: number, kind: number): string
  notifyBlockAndNeighbors(x: number, y: number, z: number): void
  scheduleAdjacentDynamicTicks(x: number, y: number, z: number): void
  runScheduledTicks(): void
  runFluidTick(x: number, y: number, z: number): void
  runFireTick(x: number, y: number, z: number): void
  validateFarmingBlock(x: number, y: number, z: number): void
  breakUnsupportedPlant(x: number, y: number, z: number, id: number): void
  runRandomTicks(px: number, pz: number): void
  randomTickBlock(x: number, y: number, z: number, id: number): void
  hasWaterForFarmland(x: number, y: number, z: number): boolean
  hasNearbyLog(x: number, y: number, z: number): boolean
  hasHorizontalWater(x: number, y: number, z: number): boolean
  canSugarCaneStay(x: number, y: number, z: number): boolean
  positionHash(x: number, y: number, z: number, salt: number): number
  rebuildChunkLighting(chunk: Chunk): number
  seedBorderLight(chunk: Chunk, levels: Uint8Array, queue: number[], skyLight: boolean): void
  propagateChunkLight(chunk: Chunk, levels: Uint8Array, queue: number[]): void
  generateChunk(chunk: Chunk): void
  finishGeneratedChunk(chunk: Chunk, structurePlans?: readonly StructurePlan[]): void
  generateChunkAsync(chunk: Chunk): Promise<void>
  handleGenerationResponse(response: WorldGenWorkerResponse): void
  stopGenerationWorker(fallbackPending: boolean): void
  importBlockEdits(serialized: SerializedBlockEdits): void
  importBlockFacings(serialized: SerializedBlockFacings): void
  importScheduledTicks(serialized: SerializedScheduledTicks): void
  rebuildRandomTickIndex(chunk: Chunk): void
  recordBlockEdit(chunk: Chunk, index: number, id: number): void
  recordBlockFacing(chunk: Chunk, index: number, facing: HorizontalFace | null, storeDefault?: boolean): void
  settleFallingColumn(chunk: Chunk, lx: number, startY: number, lz: number): void
  continueFallingBlock(x: number, y: number, z: number): void
  remeshChunk(chunk: Chunk): void
  disposeChunkMeshes(chunk: Chunk): void
  dispose(): void
}

installWorldBlocks(World)
installWorldStreaming(World)
installWorldSimulation(World)
installWorldLighting(World)
