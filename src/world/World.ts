import * as THREE from 'three'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT, ChunkState } from './Chunk'
import { WorldGen } from './WorldGen'
import {
  B, SOLID, OPAQUE, CROSS, GRAVITY, LIGHT_LEVEL, isValidBlockId, isDirectionalBlock,
  isHorizontalFace, isWheat, wheatAge, isFarmingPlant, isWater as isWaterBlock,
  isLava as isLavaBlock, isFluid, fluidLevel, fluidKind, fluidBlock, isFlammable,
  isLogBlock, isLeafBlock, isBedBlock, isDoorBlock, isDoorOpen, isDoorUpper, canSupportVine,
  oppositeHorizontalFace,
  type HorizontalFace
} from './Blocks'
import { buildChunkGeoms } from './Mesher'
import { planTree, type TreeGeneratorKind } from './BiomeDecorator'
import type { Materials } from '../gfx/Materials'
import type { Atlas } from '../gfx/Atlas'
import type { StructurePlan } from './structures/Types'
import type { WorldGenWorkerResponse } from './WorldGenWorkerProtocol'

export interface RayHit {
  x: number; y: number; z: number
  nx: number; ny: number; nz: number
  id: number
  dist: number
}

/** Sparse chunk edits encoded as flat block-index/id pairs. */
export type SerializedBlockEdits = Record<string, number[]>
/** Sparse chunk facings encoded as flat block-index/horizontal-face pairs. */
export type SerializedBlockFacings = Record<string, number[]>
/** Scheduled block updates encoded as x/y/z/remaining-ticks/kind tuples. */
export type SerializedScheduledTicks = number[]

/** Tick kinds: 0 validation, 1 sapling, 2 fluid, 3 fire, 4 TNT fuse, 5 falling block. */
interface ScheduledBlockTick {
  x: number
  y: number
  z: number
  due: number
  kind: 0 | 1 | 2 | 3 | 4 | 5
}

const SIMULATION_STEP = 1 / 20
const RANDOM_TICK_INTERVAL = 20
const MAX_TICKS_PER_FRAME = 5
/** Natural spawning simulates the full inner eligible square even when it is not rendered. */
const MOB_SIMULATION_RADIUS = 8
/** One worker executes serially; a small look-ahead keeps it fed without a huge stale backlog. */
const MAX_PENDING_GENERATION = 2

const LIGHT_CELLS = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT
const LIGHT_CHANGED = 1 << 4
const LIGHT_BORDER_POS_X = 1 << 0
const LIGHT_BORDER_NEG_X = 1 << 1
const LIGHT_BORDER_POS_Z = 1 << 2
const LIGHT_BORDER_NEG_Z = 1 << 3
const LIGHT_BORDER_DIRECTIONS = [
  [1, 0, LIGHT_BORDER_POS_X],
  [-1, 0, LIGHT_BORDER_NEG_X],
  [0, 1, LIGHT_BORDER_POS_Z],
  [0, -1, LIGHT_BORDER_NEG_Z]
] as const
// Reused scratch buffers so per-edit relights never allocate.
const scratchSky = new Uint8Array(LIGHT_CELLS)
const scratchBlock = new Uint8Array(LIGHT_CELLS)

/** Light attenuation of a block: opaque blocks stop light, water dims it, leaves barely. */
function lightOpacity(id: number): number {
  if (OPAQUE[id]) return 15
  if (isWaterBlock(id)) return 3
  if (isLeafBlock(id)) return 1
  return 0
}

/** Blocks that participate in random ticks (growth, decay, spread). */
function wantsRandomTick(id: number): boolean {
  return isFarmingPlant(id) || id === B.FARMLAND_DRY || id === B.FARMLAND_WET ||
    id === B.GRASS || id === B.MYCELIUM || id === B.CACTUS || isLeafBlock(id)
}

export class World {
  onAutomaticBlockBreak: (x: number, y: number, z: number, id: number) => void = () => {}
  onTntExplode: (x: number, y: number, z: number, radius: number) => void = () => {}
  /** Fired when a TNT block starts its fuse, so the view can flash it. */
  onTntPrimed: (x: number, y: number, z: number) => void = () => {}
  /** Fired once whenever a chunk finishes terrain generation (fresh or revisited). */
  onChunkGenerated: (cx: number, cz: number) => void = () => {}
  readonly gen: WorldGen
  private scene: THREE.Scene
  private materials: Materials
  private atlas: Atlas
  private chunks = new Map<number, Chunk>()
  /** One-entry chunk cache: block queries cluster heavily in the same chunk. */
  private cacheKey = NaN
  private cacheChunk: Chunk | undefined
  renderDistance: number
  grassDensity: number
  private genQueue: Chunk[] = []
  private meshQueue: Chunk[] = []
  private lastCenter = { cx: NaN, cz: NaN }
  private queuesDirty = true
  private blockEdits = new Map<string, Map<number, number>>()
  private blockFacings = new Map<string, Map<number, HorizontalFace>>()
  private editsDirty = false
  private xrayEnabled = false
  private simulationAccumulator = 0
  private simulationTick = 0
  private scheduledTicks: ScheduledBlockTick[] = []
  private scheduledTickIndex = new Map<string, ScheduledBlockTick>()
  private mutationBatchDepth = 0
  /** Prevents one intentional two-half door mutation from deleting its partner. */
  private doorPairMutationDepth = 0
  private dirtyChunkKeys = new Set<number>()
  private generationWorker: Worker | null = null
  private nextGenerationId = 1
  private pendingGeneration = new Map<number, {
    key: number
    resolve: () => void
  }>()
  private generationJobs = new Map<number, Promise<void>>()

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

  private startGenerationWorker(): void {
    if (typeof Worker === 'undefined') return
    try {
      const worker = new Worker(new URL('./WorldGenWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<WorldGenWorkerResponse>) => this.handleGenerationResponse(event.data)
      worker.onerror = (event) => {
        console.error('World generation worker failed; falling back to the main thread.', event)
        this.stopGenerationWorker(true)
      }
      worker.postMessage({ type: 'init', seed: this.gen.seedStr, version: this.gen.generatorVersion })
      this.generationWorker = worker
    } catch (error) {
      console.warn('Web Worker world generation is unavailable; using synchronous generation.', error)
    }
  }

  /** String key used only for the persisted edit/facing maps (save format). */
  private key(cx: number, cz: number): string { return cx + ',' + cz }

  /** Numeric chunk key — exact and collision-free for |cz| < 2^31. */
  private static ck(cx: number, cz: number): number { return cx * 0x100000000 + cz }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunkAt(cx, cz)
  }

  private chunkAt(cx: number, cz: number): Chunk | undefined {
    const k = World.ck(cx, cz)
    if (k === this.cacheKey) return this.cacheChunk
    const c = this.chunks.get(k)
    this.cacheKey = k
    this.cacheChunk = c
    return c
  }

  private ensureChunk(cx: number, cz: number): Chunk {
    const k = World.ck(cx, cz)
    let c = this.chunks.get(k)
    if (!c) {
      c = new Chunk(cx, cz)
      this.chunks.set(k, c)
      this.cacheKey = NaN
    }
    return c
  }

  chunkCount(): number { return this.chunks.size }

  /** Synchronously materializes terrain around a saved entity before spawn-volume validation. */
  ensureGeneratedAt(x: number, z: number, radius = 0): void {
    const minCx = Math.floor((x - radius) / CHUNK_SIZE), maxCx = Math.floor((x + radius) / CHUNK_SIZE)
    const minCz = Math.floor((z - radius) / CHUNK_SIZE), maxCz = Math.floor((z + radius) / CHUNK_SIZE)
    const ensured: Chunk[] = []
    for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) {
      const chunk = this.ensureChunk(cx, cz)
      if (chunk.state < ChunkState.GENERATED) this.generateChunk(chunk)
      ensured.push(chunk)
    }
    // A second pass pulls skylight/block-light across borders created later in the loop.
    for (const chunk of ensured) this.rebuildChunkLighting(chunk)
    for (const chunk of ensured) this.rebuildChunkLighting(chunk)
  }

  hasUnsavedBlockEdits(): boolean { return this.editsDirty }

  markBlockEditsSaved(): void { this.editsDirty = false }

  setXrayEnabled(enabled: boolean): void {
    if (this.xrayEnabled === enabled) return
    this.xrayEnabled = enabled
    if (enabled) {
      // Ore overlays are built lazily: demote meshed chunks so the streaming
      // queue rebuilds them (with xray geometry) within the frame budget.
      for (const chunk of this.chunks.values()) {
        if (chunk.state === ChunkState.MESHED && !chunk.meshes.xray) chunk.state = ChunkState.GENERATED
      }
      this.queuesDirty = true
    } else {
      for (const chunk of this.chunks.values()) {
        const m = chunk.meshes.xray
        if (m) {
          this.scene.remove(m)
          m.geometry.dispose()
          chunk.meshes.xray = null
        }
      }
    }
  }

  serializeBlockEdits(): SerializedBlockEdits {
    const serialized: SerializedBlockEdits = {}
    for (const [chunkKey, edits] of this.blockEdits) {
      const pairs: number[] = []
      for (const [index, id] of [...edits].sort((a, b) => a[0] - b[0])) pairs.push(index, id)
      if (pairs.length > 0) serialized[chunkKey] = pairs
    }
    return serialized
  }

  serializeBlockFacings(): SerializedBlockFacings {
    const serialized: SerializedBlockFacings = {}
    for (const [chunkKey, facings] of this.blockFacings) {
      const pairs: number[] = []
      for (const [index, face] of [...facings].sort((a, b) => a[0] - b[0])) pairs.push(index, face)
      if (pairs.length > 0) serialized[chunkKey] = pairs
    }
    return serialized
  }

  serializeScheduledTicks(): SerializedScheduledTicks {
    const out: number[] = []
    for (const tick of this.scheduledTicks) {
      out.push(tick.x, tick.y, tick.z, Math.max(1, tick.due - this.simulationTick), tick.kind)
    }
    return out
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunkAt(cx, cz)
    if (!c || c.state < ChunkState.GENERATED) return B.AIR
    return c.get(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)
  }

  /** Sparse facing overrides of one chunk, for bulk consumers like the mesher. */
  facingsForChunk(cx: number, cz: number): ReadonlyMap<number, HorizontalFace> | undefined {
    return this.blockFacings.get(this.key(cx, cz))
  }

  getBlockFacing(x: number, y: number, z: number): HorizontalFace {
    if (y < 0 || y >= WORLD_HEIGHT) return 4
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    return this.blockFacings.get(this.key(cx, cz))?.get(Chunk.index(lx, y, lz)) ?? 4
  }

  getSkyLight(x: number, y: number, z: number): number {
    if (y >= WORLD_HEIGHT) return 15
    if (y < 0) return 0
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const chunk = this.chunkAt(cx, cz)
    if (!chunk || chunk.state < ChunkState.GENERATED) return 15
    return chunk.skyLight[Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]
  }

  getBlockLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const chunk = this.chunkAt(cx, cz)
    if (!chunk || chunk.state < ChunkState.GENERATED) return 0
    return chunk.blockLight[Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]
  }

  /** Unified classic light query used by crops and chunk vertex shading. */
  getLightLevel(x: number, y: number, z: number): number {
    return Math.max(this.getSkyLight(x, y, z), this.getBlockLight(x, y, z))
  }

  /** Advances the deterministic 20 Hz world simulation with bounded catch-up. */
  tickSimulation(dt: number, px: number, pz: number): void {
    this.simulationAccumulator = Math.min(this.simulationAccumulator + Math.max(0, dt), SIMULATION_STEP * MAX_TICKS_PER_FRAME)
    let steps = 0
    while (this.simulationAccumulator >= SIMULATION_STEP && steps < MAX_TICKS_PER_FRAME) {
      this.simulationAccumulator -= SIMULATION_STEP
      this.simulationTick++
      this.runScheduledTicks()
      if (this.simulationTick % RANDOM_TICK_INTERVAL === 0) this.batchBlocks(() => this.runRandomTicks(px, pz))
      steps++
    }
  }

  isSolid(x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z)
    return SOLID[id]
  }

  isWater(x: number, y: number, z: number): boolean {
    return isWaterBlock(this.getBlock(x, y, z))
  }

  isLava(x: number, y: number, z: number): boolean {
    return isLavaBlock(this.getBlock(x, y, z))
  }

  private completeDoorAt(x: number, y: number, z: number): {
    lowerY: number
    open: boolean
    facing: HorizontalFace
  } | null {
    const id = this.getBlock(x, y, z)
    if (!isDoorBlock(id)) return null
    const lowerY = isDoorUpper(id) ? y - 1 : y
    const lower = this.getBlock(x, lowerY, z)
    const upper = this.getBlock(x, lowerY + 1, z)
    if (!isDoorBlock(lower) || isDoorUpper(lower) || !isDoorBlock(upper) || !isDoorUpper(upper)) return null
    const open = isDoorOpen(lower)
    if (isDoorOpen(upper) !== open) return null
    const facing = this.getBlockFacing(x, lowerY, z)
    if (this.getBlockFacing(x, lowerY + 1, z) !== facing) return null
    return { lowerY, open, facing }
  }

  /** Pathfinder-facing state query; either door half resolves the complete pair. */
  doorState(x: number, y: number, z: number): 'open' | 'closed' | null {
    const door = this.completeDoorAt(Math.floor(x), Math.floor(y), Math.floor(z))
    return door ? (door.open ? 'open' : 'closed') : null
  }

  /** Places a supported, closed two-block wooden door without exposing a transient half. */
  placeDoor(x: number, y: number, z: number, facing: HorizontalFace = 4): boolean {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    if (y < 1 || y + 1 >= WORLD_HEIGHT || !isHorizontalFace(facing)) return false
    const replaceable = (id: number): boolean => id === B.AIR || CROSS[id] || isFluid(id)
    if (!SOLID[this.getBlock(x, y - 1, z)] || !replaceable(this.getBlock(x, y, z)) ||
      !replaceable(this.getBlock(x, y + 1, z))) return false

    this.batchBlocks(() => {
      this.doorPairMutationDepth = (this.doorPairMutationDepth ?? 0) + 1
      try {
        this.setBlock(x, y, z, B.WOOD_DOOR_LOWER, facing)
        this.setBlock(x, y + 1, z, B.WOOD_DOOR_UPPER, facing)
      } finally {
        this.doorPairMutationDepth--
      }
    })
    return this.doorState(x, y, z) === 'closed'
  }

  /** Sets both halves to the requested state while preserving their persisted facing. */
  setDoorOpen(x: number, y: number, z: number, open: boolean): boolean {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    const door = this.completeDoorAt(x, y, z)
    if (!door) return false
    if (door.open === open) return true
    const lowerId = open ? B.WOOD_DOOR_LOWER_OPEN : B.WOOD_DOOR_LOWER
    const upperId = open ? B.WOOD_DOOR_UPPER_OPEN : B.WOOD_DOOR_UPPER
    this.batchBlocks(() => {
      this.doorPairMutationDepth = (this.doorPairMutationDepth ?? 0) + 1
      try {
        this.setBlock(x, door.lowerY, z, lowerId, door.facing)
        this.setBlock(x, door.lowerY + 1, z, upperId, door.facing)
      } finally {
        this.doorPairMutationDepth--
      }
    })
    return this.doorState(x, door.lowerY, z) === (open ? 'open' : 'closed')
  }

  openDoor(x: number, y: number, z: number): boolean {
    return this.setDoorOpen(x, y, z, true)
  }

  /** EntityWorld-compatible destruction: either half removes the entire door. */
  breakDoor(x: number, y: number, z: number): boolean {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    const id = this.getBlock(x, y, z)
    if (!isDoorBlock(id)) return false
    const lowerY = isDoorUpper(id) ? y - 1 : y
    this.batchBlocks(() => {
      this.doorPairMutationDepth = (this.doorPairMutationDepth ?? 0) + 1
      try {
        if (isDoorBlock(this.getBlock(x, lowerY + 1, z))) this.setBlock(x, lowerY + 1, z, B.AIR)
        if (isDoorBlock(this.getBlock(x, lowerY, z))) this.setBlock(x, lowerY, z, B.AIR)
      } finally {
        this.doorPairMutationDepth--
      }
    })
    this.onAutomaticBlockBreak(x, lowerY, z, B.WOOD_DOOR_LOWER)
    return true
  }

  /** Apply many block changes with one relight/remesh per touched chunk. */
  batchBlocks(action: () => void): void {
    this.mutationBatchDepth = (this.mutationBatchDepth ?? 0) + 1
    try { action() } finally {
      this.mutationBatchDepth--
      if (this.mutationBatchDepth === 0) this.flushDirtyChunks()
    }
  }

  /**
   * Replaces a placed TNT block with its persistent, scheduled fuse state.
   * `scattered` is a crude stand-in for vanilla's primed-TNT entity being thrown
   * by a neighboring blast: the charge may hop into a random free cell nearby.
   */
  primeTnt(x: number, y: number, z: number, fuseTicks = 80, scattered = false): boolean {
    const id = this.getBlock(x, y, z)
    if (id !== B.TNT && id !== B.PRIMED_TNT) return false
    if (id === B.TNT) this.setBlock(x, y, z, B.PRIMED_TNT)
    if (scattered) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const dx = Math.floor(Math.random() * 3) - 1
        const dy = Math.floor(Math.random() * 2)
        const dz = Math.floor(Math.random() * 3) - 1
        if (dx === 0 && dy === 0 && dz === 0) continue
        const tx = x + dx, ty = y + dy, tz = z + dz
        if (this.getBlock(tx, ty, tz) !== B.AIR) continue
        this.setBlock(x, y, z, B.AIR)
        this.setBlock(tx, ty, tz, B.PRIMED_TNT)
        x = tx; y = ty; z = tz
        break
      }
    }
    this.scheduleBlockTick(x, y, z, Math.max(2, fuseTicks), 4)
    this.onTntPrimed(x, y, z)
    return true
  }

  ignite(x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z)
    if (id === B.TNT) return this.primeTnt(x, y, z)
    if (id !== B.AIR && id !== B.FIRE && !CROSS[id]) return false
    const supported = SOLID[this.getBlock(x, y - 1, z)] || [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ].some(([dx, dy, dz]) => isFlammable(this.getBlock(x + dx, y + dy, z + dz)))
    if (!supported) return false
    this.setBlock(x, y, z, B.FIRE)
    return true
  }

  canPlantWheat(x: number, y: number, z: number): boolean {
    const below = this.getBlock(x, y - 1, z)
    return this.getBlock(x, y, z) === B.AIR &&
      (below === B.FARMLAND_DRY || below === B.FARMLAND_WET)
  }

  canPlantSapling(x: number, y: number, z: number): boolean {
    const below = this.getBlock(x, y - 1, z)
    const current = this.getBlock(x, y, z)
    return (current === B.AIR || CROSS[current]) && (below === B.GRASS || below === B.DIRT)
  }

  canPlantSugarCane(x: number, y: number, z: number): boolean {
    const current = this.getBlock(x, y, z)
    if (current !== B.AIR && !CROSS[current]) return false
    const below = this.getBlock(x, y - 1, z)
    if (below === B.SUGARCANE) return true
    if (below !== B.GRASS && below !== B.DIRT && below !== B.SAND) return false
    return this.hasHorizontalWater(x, y - 1, z)
  }

  canPlantMushroom(x: number, y: number, z: number): boolean {
    const current = this.getBlock(x, y, z)
    return (current === B.AIR || CROSS[current]) && OPAQUE[this.getBlock(x, y - 1, z)] &&
      this.getLightLevel(x, y, z) <= 12
  }

  fertilize(x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z)
    if (isWheat(id) && id !== B.WHEAT_7) {
      const amount = 2 + this.positionHash(x, y, z, this.simulationTick) % 4
      this.setBlock(x, y, z, Math.min(B.WHEAT_7, id + amount))
      return true
    }
    if (id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE || id === B.SAPLING_BIRCH) {
      return this.growTree(x, y, z, id === B.SAPLING_SPRUCE)
    }
    return false
  }

  growTree(x: number, y: number, z: number, spruce = false): boolean {
    const sapling = this.getBlock(x, y, z)
    if (sapling !== B.SAPLING_OAK && sapling !== B.SAPLING_SPRUCE && sapling !== B.SAPLING_BIRCH) return false
    const kind: TreeGeneratorKind = sapling === B.SAPLING_BIRCH ? 'birch'
      : spruce || sapling === B.SAPLING_SPRUCE ? 'taiga_1' : 'small_oak'
    const feature = planTree(
      kind,
      this.positionHash(x, y, z, this.simulationTick ^ 0x51f),
      x, y, z,
      {
        blockAt: (bx, by, bz) => this.getBlock(bx, by, bz),
        surfaceY: (bx, bz) => this.gen.surfaceY(bx, bz),
        biomeAt: (bx, bz) => this.biomeAt(bx, bz)
      }
    )
    if (!feature) return false
    this.batchBlocks(() => {
      for (const placement of feature.placements) {
        this.setBlock(placement.x, placement.y, placement.z, placement.block)
      }
    })
    return true
  }

  setBlock(x: number, y: number, z: number, id: number, facing?: HorizontalFace): void {
    if (y < 1 || y >= WORLD_HEIGHT || !isValidBlockId(id)) return
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunkAt(cx, cz)
    if (!c || c.state < ChunkState.GENERATED) return
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    const index = Chunk.index(lx, y, lz)
    const previousId = c.get(lx, y, lz)
    const storedPreviousFacing = this.blockFacings.get(this.key(cx, cz))?.get(index)
    const previousFacing = storedPreviousFacing ?? 4
    const nextFacing = isDirectionalBlock(id)
      ? (facing ?? (isDirectionalBlock(previousId) ? previousFacing : 4))
      : null
    const facingChanged = nextFacing !== (isDirectionalBlock(previousId) ? previousFacing : null) ||
      (id === B.VINE && nextFacing !== null && storedPreviousFacing === undefined)
    const blockChanged = previousId !== id
    if (!blockChanged && !facingChanged) return

    if (blockChanged) {
      c.set(lx, y, lz, id)
      this.recordBlockEdit(c, index, id)
      if (isDoorBlock(previousId) && (this.doorPairMutationDepth ?? 0) === 0) {
        const partnerY = isDoorUpper(previousId) ? y - 1 : y + 1
        const partner = this.getBlock(x, partnerY, z)
        if (isDoorBlock(partner) && isDoorUpper(partner) !== isDoorUpper(previousId)) {
          this.doorPairMutationDepth = 1
          try { this.setBlock(x, partnerY, z, B.AIR) } finally { this.doorPairMutationDepth = 0 }
        }
      }
      if (isFluid(id) && CROSS[previousId] && previousId !== B.FIRE) {
        this.onAutomaticBlockBreak(x, y, z, previousId)
      }
      // breaking a support pops decorations, but fire owns its own support rules.
      if (id === B.AIR && y + 1 < WORLD_HEIGHT && CROSS[c.get(lx, y + 1, lz)] && c.get(lx, y + 1, lz) !== B.FIRE) {
        c.set(lx, y + 1, lz, B.AIR)
        this.recordBlockEdit(c, Chunk.index(lx, y + 1, lz), B.AIR)
      }
      if (id === B.AIR) {
        this.settleFallingColumn(c, lx, y + 1, lz)
      }
      else if (GRAVITY[id]) this.settleFallingColumn(c, lx, y, lz)

      this.notifyBlockAndNeighbors(x, y, z)
      const finalId = c.get(lx, y, lz)
      if (wantsRandomTick(finalId)) {
        c.randomTickIndices.add(index)
      } else {
        c.randomTickIndices.delete(index)
      }
      if (finalId === B.SAPLING_OAK || finalId === B.SAPLING_SPRUCE || finalId === B.SAPLING_BIRCH) {
        const delay = 600 + this.positionHash(x, y, z, this.simulationTick) % 601
        this.scheduleBlockTick(x, y, z, delay, 1)
      }
      if (isFluid(finalId)) this.scheduleBlockTick(x, y, z, isLavaBlock(finalId) ? 30 : 5, 2)
      if (finalId === B.FIRE) this.scheduleBlockTick(x, y, z, 8, 3)
      this.scheduleAdjacentDynamicTicks(x, y, z)
    }
    // Vines need an explicit value even for face 4: unlike the other
    // directional blocks, a missing entry means a generated metadata-free
    // vine whose support must be inferred once by the mesher.
    this.recordBlockFacing(c, index, nextFacing, id === B.VINE)
    this.refreshChangedBlock(c, lx, lz)
  }

  setBlockFacing(x: number, y: number, z: number, facing: HorizontalFace): void {
    const id = this.getBlock(x, y, z)
    if (!isDirectionalBlock(id)) return
    this.setBlock(x, y, z, id, facing)
  }

  private remeshAt(cx: number, cz: number): void {
    const c = this.chunkAt(cx, cz)
    if (c && c.state === ChunkState.MESHED) this.remeshChunk(c)
  }

  biomeAt(x: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunkAt(cx, cz)
    if (c && c.state >= ChunkState.GENERATED) {
      return c.colBiome[((x - cx * CHUNK_SIZE) << 4) | (z - cz * CHUNK_SIZE)]
    }
    return this.gen.biomeAt(x, z)
  }

  isSlimeChunk(cx: number, cz: number): boolean {
    return this.gen.isSlimeChunk(cx, cz)
  }

  /** Highest solid, non-decoration block in a column (or -1). */
  topSolidY(x: number, z: number): number {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = this.getBlock(x, y, z)
      if (SOLID[id] && !CROSS[id]) return y
    }
    return -1
  }

  /** Voxel DDA raycast; empty buckets may opt into hitting liquid cells. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, includeFluids = false): RayHit | null {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z)
    const stepX = dir.x > 0 ? 1 : -1
    const stepY = dir.y > 0 ? 1 : -1
    const stepZ = dir.z > 0 ? 1 : -1
    const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity
    const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity
    const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity
    let tMaxX = dir.x !== 0 ? Math.abs((stepX > 0 ? x + 1 - origin.x : origin.x - x) / dir.x) : Infinity
    let tMaxY = dir.y !== 0 ? Math.abs((stepY > 0 ? y + 1 - origin.y : origin.y - y) / dir.y) : Infinity
    let tMaxZ = dir.z !== 0 ? Math.abs((stepZ > 0 ? z + 1 - origin.z : origin.z - z) / dir.z) : Infinity
    let nx = 0, ny = 0, nz = 0
    let t = 0

    for (let i = 0; i < 256; i++) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ
      }
      if (t > maxDist) return null
      const id = this.getBlock(x, y, z)
      if (id !== B.AIR && ((includeFluids && isFluid(id)) || (SOLID[id] || CROSS[id] || isDoorBlock(id)))) {
        return { x, y, z, nx, ny, nz, id, dist: t }
      }
    }
    return null
  }

  setRenderDistance(r: number): void {
    this.renderDistance = r
    this.queuesDirty = true
  }

  /** Generate + mesh everything around a chunk position, yielding to the event loop. */
  async pregen(ccx: number, ccz: number, onProgress: (f: number) => void): Promise<void> {
    const r = this.renderDistance
    const generationRadius = Math.max(r + 1, MOB_SIMULATION_RADIUS)
    const genList: [number, number][] = []
    for (let dz = -generationRadius; dz <= generationRadius; dz++) {
      for (let dx = -generationRadius; dx <= generationRadius; dx++) genList.push([ccx + dx, ccz + dz])
    }
    genList.sort((a, b) => (a[0] - ccx) ** 2 + (a[1] - ccz) ** 2 - ((b[0] - ccx) ** 2 + (b[1] - ccz) ** 2))
    const meshList = genList.filter(([cx, cz]) => Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) <= r)
    const total = genList.length + meshList.length
    let done = 0
    let lastYield = performance.now()

    const maybeYield = async () => {
      if (performance.now() - lastYield > 28) {
        onProgress(done / total)
        await new Promise(res => setTimeout(res, 0))
        lastYield = performance.now()
      }
    }

    for (const [cx, cz] of genList) {
      const c = this.ensureChunk(cx, cz)
      if (c.state < ChunkState.GENERATED) await this.generateChunkAsync(c)
      done++
      await maybeYield()
    }
    // second lighting pass so border light converges before the first meshing
    for (const [cx, cz] of genList) {
      const c = this.chunkAt(cx, cz)
      if (c && c.state >= ChunkState.GENERATED) this.rebuildChunkLighting(c)
      await maybeYield()
    }
    for (const [cx, cz] of meshList) {
      const c = this.ensureChunk(cx, cz)
      if (c.state < ChunkState.MESHED) this.remeshChunk(c)
      done++
      await maybeYield()
    }
    onProgress(1)
    this.lastCenter = { cx: ccx, cz: ccz }
    this.queuesDirty = false
  }

  /** Streaming update: budgets chunk gen + meshing per frame. */
  update(px: number, pz: number, budgetMs: number): void {
    const ccx = Math.floor(px / CHUNK_SIZE), ccz = Math.floor(pz / CHUNK_SIZE)
    if (ccx !== this.lastCenter.cx || ccz !== this.lastCenter.cz || this.queuesDirty) {
      this.lastCenter = { cx: ccx, cz: ccz }
      this.queuesDirty = false
      this.rebuildQueues(ccx, ccz)
    }

    const t0 = performance.now()
    while (performance.now() - t0 < budgetMs) {
      const genC = this.genQueue.pop()
      if (genC) {
        if (genC.state < ChunkState.GENERATED) {
          if (this.generationJobs?.has(World.ck(genC.cx, genC.cz))) continue
          if (this.generationWorker && this.pendingGeneration.size >= MAX_PENDING_GENERATION) {
            this.genQueue.push(genC)
            break
          }
          void this.generateChunkAsync(genC)
        }
        continue
      }
      const meshC = this.meshQueue.pop()
      if (meshC) {
        if (meshC.state === ChunkState.MESHED) continue
        if (!this.neighborsGenerated(meshC)) {
          // neighbors still pending — requeue at the far end and stop for this frame
          this.meshQueue.unshift(meshC)
          break
        }
        this.remeshChunk(meshC)
        continue
      }
      break
    }
  }

  private neighborsGenerated(c: Chunk): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunkAt(c.cx + dx, c.cz + dz)
        if (!n || n.state < ChunkState.GENERATED) return false
      }
    }
    return true
  }

  private rebuildQueues(ccx: number, ccz: number): void {
    const r = this.renderDistance
    const generationRadius = Math.max(r + 1, MOB_SIMULATION_RADIUS)
    this.genQueue.length = 0
    this.meshQueue.length = 0
    for (let dz = -generationRadius; dz <= generationRadius; dz++) {
      for (let dx = -generationRadius; dx <= generationRadius; dx++) {
        const c = this.ensureChunk(ccx + dx, ccz + dz)
        const ring = Math.max(Math.abs(dx), Math.abs(dz))
        if (c.state < ChunkState.GENERATED && !this.generationJobs?.has(World.ck(c.cx, c.cz))) this.genQueue.push(c)
        if (ring <= r && c.state < ChunkState.MESHED) this.meshQueue.push(c)
      }
    }
    // pop() takes from the end, so sort farthest-first
    const d2 = (c: Chunk) => (c.cx - ccx) ** 2 + (c.cz - ccz) ** 2
    this.genQueue.sort((a, b) => d2(b) - d2(a))
    this.meshQueue.sort((a, b) => d2(b) - d2(a))

    // unload far chunks
    const limit = Math.max(r + 3, MOB_SIMULATION_RADIUS + 2)
    for (const [k, c] of this.chunks) {
      if (Math.abs(c.cx - ccx) > limit || Math.abs(c.cz - ccz) > limit) {
        this.disposeChunkMeshes(c)
        this.chunks.delete(k)
        this.cacheKey = NaN
      }
    }
  }

  private refreshChangedBlock(chunk: Chunk, lx: number, lz: number): void {
    const keys = [[chunk.cx, chunk.cz]]
    if (lx === 0) keys.push([chunk.cx - 1, chunk.cz])
    if (lx === CHUNK_SIZE - 1) keys.push([chunk.cx + 1, chunk.cz])
    if (lz === 0) keys.push([chunk.cx, chunk.cz - 1])
    if (lz === CHUNK_SIZE - 1) keys.push([chunk.cx, chunk.cz + 1])
    if (lx === 0 && lz === 0) keys.push([chunk.cx - 1, chunk.cz - 1])
    if (lx === 0 && lz === CHUNK_SIZE - 1) keys.push([chunk.cx - 1, chunk.cz + 1])
    if (lx === CHUNK_SIZE - 1 && lz === 0) keys.push([chunk.cx + 1, chunk.cz - 1])
    if (lx === CHUNK_SIZE - 1 && lz === CHUNK_SIZE - 1) keys.push([chunk.cx + 1, chunk.cz + 1])
    if ((this.mutationBatchDepth ?? 0) > 0) {
      this.dirtyChunkKeys ??= new Set<number>()
      for (const [cx, cz] of keys) this.dirtyChunkKeys.add(World.ck(cx, cz))
      return
    }
    const lightChanges = this.rebuildChunkLighting(chunk)
    this.remeshChunk(chunk)
    const remeshed = new Set<number>([World.ck(chunk.cx, chunk.cz)])
    // A light change only needs to ripple in the directions where a border
    // voxel actually changed. Interior digging used to relight all 4 neighbors.
    for (const [dx, dz, borderMask] of LIGHT_BORDER_DIRECTIONS) {
      const neighborKey = World.ck(chunk.cx + dx, chunk.cz + dz)
      const neighbor = this.chunks.get(neighborKey)
      if (!neighbor || neighbor.state < ChunkState.GENERATED) continue
      const touchesBorder = keys.some(([cx, cz]) => cx === neighbor.cx && cz === neighbor.cz)
      const lightChanged = (lightChanges & borderMask) !== 0 && this.rebuildChunkLighting(neighbor) !== 0
      if ((lightChanged || touchesBorder) && neighbor.state === ChunkState.MESHED) {
        this.remeshChunk(neighbor)
        remeshed.add(neighborKey)
      }
    }
    for (let i = 1; i < keys.length; i++) {
      if (!remeshed.has(World.ck(keys[i][0], keys[i][1]))) this.remeshAt(keys[i][0], keys[i][1])
    }
  }

  private flushDirtyChunks(): void {
    if (!this.dirtyChunkKeys?.size) return
    const keys = [...this.dirtyChunkKeys]
    this.dirtyChunkKeys.clear()
    const visited = new Set(keys)
    const rippled: Chunk[] = []
    const lightChanges = new Map<number, number>()
    for (const key of keys) {
      const chunk = this.chunks.get(key)
      if (!chunk || chunk.state < ChunkState.GENERATED) continue
      lightChanges.set(key, this.rebuildChunkLighting(chunk))
    }
    // second pass: pull the fresh light into surrounding chunks
    for (const key of keys) {
      const chunk = this.chunks.get(key)
      if (!chunk) continue
      const changes = lightChanges.get(key) ?? 0
      for (const [dx, dz, borderMask] of LIGHT_BORDER_DIRECTIONS) {
        if ((changes & borderMask) === 0) continue
        const neighborKey = World.ck(chunk.cx + dx, chunk.cz + dz)
        if (visited.has(neighborKey)) continue
        visited.add(neighborKey)
        const neighbor = this.chunks.get(neighborKey)
        if (!neighbor || neighbor.state < ChunkState.GENERATED) continue
        if (this.rebuildChunkLighting(neighbor) && neighbor.state === ChunkState.MESHED) rippled.push(neighbor)
      }
    }
    for (const key of keys) {
      const chunk = this.chunks.get(key)
      if (chunk && chunk.state === ChunkState.MESHED) this.remeshChunk(chunk)
    }
    for (const chunk of rippled) this.remeshChunk(chunk)
  }

  private scheduleBlockTick(x: number, y: number, z: number, delay: number, kind: 0 | 1 | 2 | 3 | 4 | 5 = 0): void {
    if (y < 1 || y >= WORLD_HEIGHT) return
    const due = this.simulationTick + Math.max(1, Math.floor(delay))
    if (!this.scheduledTickIndex) {
      this.scheduledTickIndex = new Map(this.scheduledTicks.map(tick => [this.scheduledTickKey(tick.x, tick.y, tick.z, tick.kind), tick]))
    }
    const key = this.scheduledTickKey(x, y, z, kind)
    const existing = this.scheduledTickIndex.get(key)
    if (existing) {
      existing.due = Math.min(existing.due, due)
      return
    }
    if (this.scheduledTicks.length >= 8192) {
      // Only low-priority ticks may be dropped on overflow: evicting a TNT fuse
      // (kind 4) or a fluid tick (kind 2) would freeze the block forever.
      let evictable = this.scheduledTicks.findIndex(tick => tick.kind === 0)
      if (evictable === -1) evictable = this.scheduledTicks.findIndex(tick => tick.kind === 1 || tick.kind === 3)
      if (evictable !== -1) {
        const removed = this.scheduledTicks.splice(evictable, 1)[0]
        this.scheduledTickIndex.delete(this.scheduledTickKey(removed.x, removed.y, removed.z, removed.kind))
      }
      // if only critical ticks remain, the queue is allowed to exceed the soft cap
    }
    const tick = { x, y, z, due, kind }
    this.scheduledTicks.push(tick)
    this.scheduledTickIndex.set(key, tick)
  }

  private scheduledTickKey(x: number, y: number, z: number, kind: number): string {
    return `${x},${y},${z},${kind}`
  }

  private notifyBlockAndNeighbors(x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of [
      [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ] as const) this.scheduleBlockTick(x + dx, y + dy, z + dz, 1, 0)
  }

  private scheduleAdjacentDynamicTicks(x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of [
      [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ] as const) {
      const id = this.getBlock(x + dx, y + dy, z + dz)
      if (isFluid(id)) this.scheduleBlockTick(x + dx, y + dy, z + dz, isLavaBlock(id) ? 30 : 5, 2)
      else if (id === B.FIRE) this.scheduleBlockTick(x + dx, y + dy, z + dz, 4, 3)
    }
  }

  private runScheduledTicks(): void {
    this.batchBlocks(() => {
      let processed = 0
      for (let i = this.scheduledTicks.length - 1; i >= 0 && processed < 256; i--) {
        const tick = this.scheduledTicks[i]
        if (tick.due > this.simulationTick) continue
        this.scheduledTicks.splice(i, 1)
        this.scheduledTickIndex?.delete(this.scheduledTickKey(tick.x, tick.y, tick.z, tick.kind))
        if (tick.kind === 1) {
          const id = this.getBlock(tick.x, tick.y, tick.z)
          if (id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE || id === B.SAPLING_BIRCH) {
            if (!this.growTree(tick.x, tick.y, tick.z, id === B.SAPLING_SPRUCE)) {
              this.scheduleBlockTick(tick.x, tick.y, tick.z, 200, 1)
            }
          }
        } else if (tick.kind === 2) {
          this.runFluidTick(tick.x, tick.y, tick.z)
        } else if (tick.kind === 3) {
          this.runFireTick(tick.x, tick.y, tick.z)
        } else if (tick.kind === 4) {
          if (this.getBlock(tick.x, tick.y, tick.z) === B.PRIMED_TNT) {
            this.setBlock(tick.x, tick.y, tick.z, B.AIR)
            this.onTntExplode(tick.x + 0.5, tick.y + 0.5, tick.z + 0.5, 4)
          }
        } else if (tick.kind === 5) {
          this.continueFallingBlock(tick.x, tick.y, tick.z)
        } else {
          this.validateFarmingBlock(tick.x, tick.y, tick.z)
        }
        processed++
      }
    })
  }

  private runFluidTick(x: number, y: number, z: number): void {
    let id = this.getBlock(x, y, z)
    const kind = fluidKind(id)
    if (!kind) return
    const opposite = kind === 'water' ? isLavaBlock : isWaterBlock
    const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const

    if (kind === 'lava' && neighbors.some(([dx, dy, dz]) => opposite(this.getBlock(x + dx, y + dy, z + dz)))) {
      this.setBlock(x, y, z, fluidLevel(id) === 0 ? B.OBSIDIAN : B.COBBLESTONE)
      return
    }
    if (kind === 'water') {
      for (const [dx, dy, dz] of neighbors) {
        const nx = x + dx, ny = y + dy, nz = z + dz
        const other = this.getBlock(nx, ny, nz)
        if (!isLavaBlock(other)) continue
        const result = fluidLevel(other) === 0 ? B.OBSIDIAN : fluidLevel(id) === 0 ? B.STONE : B.COBBLESTONE
        this.setBlock(nx, ny, nz, result)
      }
    }

    id = this.getBlock(x, y, z)
    if (fluidKind(id) !== kind) return
    let level = fluidLevel(id)
    if (kind === 'water' && level > 0 && SOLID[this.getBlock(x, y - 1, z)]) {
      let adjacentSources = 0
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const neighbor = this.getBlock(x + dx, y, z + dz)
        if (isWaterBlock(neighbor) && fluidLevel(neighbor) === 0) adjacentSources++
      }
      if (adjacentSources >= 2) {
        this.setBlock(x, y, z, B.WATER)
        level = 0
      }
    }
    if (level > 0) {
      let desired = 8
      const above = this.getBlock(x, y + 1, z)
      if (fluidKind(above) === kind) desired = Math.min(desired, Math.max(1, fluidLevel(above)))
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const neighbor = this.getBlock(x + dx, y, z + dz)
        if (fluidKind(neighbor) === kind) desired = Math.min(desired, fluidLevel(neighbor) + 1)
      }
      if (desired > 7) {
        this.setBlock(x, y, z, B.AIR)
        return
      }
      if (desired !== level) {
        this.setBlock(x, y, z, fluidBlock(kind, desired))
        level = desired
      }
    }

    const spreadInto = (nx: number, ny: number, nz: number, nextLevel: number): void => {
      const target = this.getBlock(nx, ny, nz)
      if (opposite(target)) {
        if (kind === 'lava') this.setBlock(x, y, z, level === 0 ? B.OBSIDIAN : B.COBBLESTONE)
        else this.setBlock(nx, ny, nz, fluidLevel(target) === 0 ? B.OBSIDIAN : level === 0 ? B.STONE : B.COBBLESTONE)
        return
      }
      const targetLevel = fluidKind(target) === kind ? fluidLevel(target) : -1
      const replaceable = target === B.AIR || target === B.FIRE || CROSS[target]
      if (replaceable || (targetLevel > nextLevel && targetLevel > 0)) {
        this.setBlock(nx, ny, nz, fluidBlock(kind, nextLevel))
      }
    }

    if (y > 1) spreadInto(x, y - 1, z, Math.max(1, level))
    const horizontalRange = kind === 'lava' ? 3 : 7
    if (level < horizontalRange) {
      const nextLevel = level + 1
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        spreadInto(x + dx, y, z + dz, nextLevel)
      }
    }
    if (fluidKind(this.getBlock(x, y, z)) === kind) {
      this.scheduleBlockTick(x, y, z, kind === 'lava' ? 30 : 5, 2)
    }
  }

  private runFireTick(x: number, y: number, z: number): void {
    if (this.getBlock(x, y, z) !== B.FIRE) return
    const around = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
    if (around.some(([dx, dy, dz]) => isWaterBlock(this.getBlock(x + dx, y + dy, z + dz)))) {
      this.setBlock(x, y, z, B.AIR)
      return
    }
    const supported = SOLID[this.getBlock(x, y - 1, z)] ||
      around.some(([dx, dy, dz]) => isFlammable(this.getBlock(x + dx, y + dy, z + dz)))
    const roll = this.positionHash(x, y, z, this.simulationTick)
    if (!supported || roll % 7 === 0) {
      this.setBlock(x, y, z, B.AIR)
      return
    }
    for (let i = 0; i < around.length; i++) {
      const [dx, dy, dz] = around[i]
      const nx = x + dx, ny = y + dy, nz = z + dz
      const target = this.getBlock(nx, ny, nz)
      if (!isFlammable(target) || this.positionHash(nx, ny, nz, roll + i) % 4 !== 0) continue
      if (target === B.TNT) this.primeTnt(nx, ny, nz, 40 + roll % 25)
      else this.setBlock(nx, ny, nz, B.FIRE)
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, nz = z + dz
      if (this.getBlock(nx, y, nz) === B.AIR && isFlammable(this.getBlock(nx, y - 1, nz)) &&
        this.positionHash(nx, y, nz, roll) % 5 === 0) this.setBlock(nx, y, nz, B.FIRE)
    }
    if (this.getBlock(x, y, z) === B.FIRE) this.scheduleBlockTick(x, y, z, 8 + roll % 8, 3)
  }

  private validateFarmingBlock(x: number, y: number, z: number): void {
    const id = this.getBlock(x, y, z)
    if (isWheat(id)) {
      const below = this.getBlock(x, y - 1, z)
      if (below !== B.FARMLAND_DRY && below !== B.FARMLAND_WET) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.SUGARCANE) {
      const below = this.getBlock(x, y - 1, z)
      if (below !== B.SUGARCANE && !this.canSugarCaneStay(x, y, z)) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.MUSHROOM_BROWN || id === B.MUSHROOM_RED) {
      if (!OPAQUE[this.getBlock(x, y - 1, z)] || this.getLightLevel(x, y, z) > 12) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE || id === B.SAPLING_BIRCH) {
      const below = this.getBlock(x, y - 1, z)
      if (below !== B.GRASS && below !== B.DIRT) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.DEAD_BUSH) {
      if (this.getBlock(x, y - 1, z) !== B.SAND) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.CACTUS) {
      const below = this.getBlock(x, y - 1, z)
      const sideBlocked = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dz]) => SOLID[this.getBlock(x + dx, y, z + dz)])
      if ((below !== B.SAND && below !== B.CACTUS) || sideBlocked) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.WATER_LILY) {
      if (this.getBlock(x, y - 1, z) !== B.WATER) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.VINE) {
      const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
      const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
      const storedFacing = this.blockFacings.get(this.key(cx, cz))?.get(Chunk.index(lx, y, lz))
      const supportsFace = (face: HorizontalFace): boolean => {
        const dx = face === 0 ? 1 : face === 1 ? -1 : 0
        const dz = face === 4 ? 1 : face === 5 ? -1 : 0
        return canSupportVine(this.getBlock(x + dx, y, z + dz))
      }
      const sideSupport = storedFacing === undefined
        ? ([0, 1, 4, 5] as const).some(supportsFace)
        : supportsFace(storedFacing)
      if (!sideSupport && this.getBlock(x, y + 1, z) !== B.VINE) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.FARMLAND_DRY || id === B.FARMLAND_WET) {
      const above = this.getBlock(x, y + 1, z)
      if (SOLID[above] && !CROSS[above]) this.setBlock(x, y, z, B.DIRT)
    } else if (isBedBlock(id)) {
      // a bed half whose partner is gone breaks; the head half drops the bed item
      const facing = this.getBlockFacing(x, y, z)
      const toward = id === B.BED_FOOT ? facing : oppositeHorizontalFace(facing)
      const dx = toward === 0 ? 1 : toward === 1 ? -1 : 0
      const dz = toward === 4 ? 1 : toward === 5 ? -1 : 0
      const partner = this.getBlock(x + dx, y, z + dz)
      const expected = id === B.BED_FOOT ? B.BED_HEAD : B.BED_FOOT
      if (partner !== expected) {
        this.setBlock(x, y, z, B.AIR)
        if (id === B.BED_HEAD) this.onAutomaticBlockBreak(x, y, z, id)
      }
    } else if (isDoorBlock(id)) {
      const door = this.completeDoorAt(x, y, z)
      if (!door || !SOLID[this.getBlock(x, door.lowerY - 1, z)]) this.breakDoor(x, y, z)
    }
  }

  private breakUnsupportedPlant(x: number, y: number, z: number, id: number): void {
    this.setBlock(x, y, z, B.AIR)
    this.onAutomaticBlockBreak(x, y, z, id)
  }

  private runRandomTicks(px: number, pz: number): void {
    const centerX = Math.floor(px / CHUNK_SIZE), centerZ = Math.floor(pz / CHUNK_SIZE)
    const radius = Math.min(4, this.renderDistance)
    let processed = 0
    for (const chunk of this.chunks.values()) {
      if (processed >= 512) break
      const cx = chunk.cx, cz = chunk.cz
      if (Math.abs(cx - centerX) > radius || Math.abs(cz - centerZ) > radius) continue
      if (chunk.state < ChunkState.GENERATED) continue
      for (const index of chunk.randomTickIndices) {
        if (processed >= 512) break
        const id = chunk.blocks[index]
        if (!wantsRandomTick(id)) continue
        const y = index & (WORLD_HEIGHT - 1)
        const column = index >> 7
        const lx = column >> 4, lz = column & 15
        this.randomTickBlock(cx * CHUNK_SIZE + lx, y, cz * CHUNK_SIZE + lz, id)
        processed++
      }
    }
  }

  private randomTickBlock(x: number, y: number, z: number, id: number): void {
    const roll = this.positionHash(x, y, z, this.simulationTick)
    if (id === B.GRASS) {
      if (OPAQUE[this.getBlock(x, y + 1, z)]) {
        this.setBlock(x, y, z, B.DIRT)
        return
      }
      const dx = ((roll >>> 3) % 3) - 1
      const dz = ((roll >>> 7) % 3) - 1
      const dy = ((roll >>> 11) % 3) - 1
      const tx = x + dx, ty = y + dy, tz = z + dz
      if (this.getBlock(tx, ty, tz) === B.DIRT && !OPAQUE[this.getBlock(tx, ty + 1, tz)] &&
        this.getLightLevel(tx, ty + 1, tz) >= 9) this.setBlock(tx, ty, tz, B.GRASS)
      return
    }
    if (isLeafBlock(id)) {
      if (roll % 5 === 0 && !this.hasNearbyLog(x, y, z)) {
        this.setBlock(x, y, z, B.AIR)
        this.onAutomaticBlockBreak(x, y, z, id)
      }
      return
    }
    if (id === B.MYCELIUM) {
      if (OPAQUE[this.getBlock(x, y + 1, z)]) {
        this.setBlock(x, y, z, B.DIRT)
        return
      }
      const dx = ((roll >>> 3) % 3) - 1
      const dz = ((roll >>> 7) % 3) - 1
      const dy = ((roll >>> 11) % 3) - 1
      const tx = x + dx, ty = y + dy, tz = z + dz
      if (this.getBlock(tx, ty, tz) === B.DIRT && !OPAQUE[this.getBlock(tx, ty + 1, tz)]) {
        this.setBlock(tx, ty, tz, B.MYCELIUM)
      }
      return
    }
    if (id === B.FARMLAND_DRY || id === B.FARMLAND_WET) {
      const hydrated = this.hasWaterForFarmland(x, y, z)
      if (hydrated && id !== B.FARMLAND_WET) this.setBlock(x, y, z, B.FARMLAND_WET)
      else if (!hydrated && id !== B.FARMLAND_DRY) this.setBlock(x, y, z, B.FARMLAND_DRY)
      else if (!hydrated && id === B.FARMLAND_DRY && !isWheat(this.getBlock(x, y + 1, z)) && roll % 12 === 0) {
        this.setBlock(x, y, z, B.DIRT)
      }
      return
    }
    if (isWheat(id)) {
      this.validateFarmingBlock(x, y, z)
      if (this.getBlock(x, y, z) !== id || id === B.WHEAT_7 || this.getLightLevel(x, y + 1, z) < 9) return
      const wet = this.getBlock(x, y - 1, z) === B.FARMLAND_WET
      if (roll % (wet ? 4 : 7) === 0) this.setBlock(x, y, z, id + 1)
      return
    }
    if (id === B.SUGARCANE) {
      this.validateFarmingBlock(x, y, z)
      if (this.getBlock(x, y, z) !== id || roll % 12 !== 0) return
      let baseY = y
      while (this.getBlock(x, baseY - 1, z) === B.SUGARCANE) baseY--
      let topY = y
      while (this.getBlock(x, topY + 1, z) === B.SUGARCANE) topY++
      if (topY - baseY + 1 < 3 && this.getBlock(x, topY + 1, z) === B.AIR) {
        this.setBlock(x, topY + 1, z, B.SUGARCANE)
      }
      return
    }
    if (id === B.CACTUS) {
      this.validateFarmingBlock(x, y, z)
      if (this.getBlock(x, y, z) !== B.CACTUS || this.getBlock(x, y + 1, z) === B.CACTUS || roll % 900 !== 0) return
      let baseY = y
      while (this.getBlock(x, baseY - 1, z) === B.CACTUS) baseY--
      if (y - baseY + 1 >= 3 || this.getBlock(x, y + 1, z) !== B.AIR) return
      const sideClear = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .every(([dx, dz]) => !SOLID[this.getBlock(x + dx, y + 1, z + dz)])
      if (sideClear) this.setBlock(x, y + 1, z, B.CACTUS)
      return
    }
    if ((id === B.MUSHROOM_BROWN || id === B.MUSHROOM_RED) && roll % 28 === 0) {
      const dx = ((roll >>> 5) % 3) - 1
      const dz = ((roll >>> 9) % 3) - 1
      const nx = x + dx, nz = z + dz
      if ((dx !== 0 || dz !== 0) && this.canPlantMushroom(nx, y, nz)) this.setBlock(nx, y, nz, id)
    }
  }

  private hasWaterForFarmland(x: number, y: number, z: number): boolean {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (isWaterBlock(this.getBlock(x + dx, y, z + dz)) || isWaterBlock(this.getBlock(x + dx, y + 1, z + dz))) return true
      }
    }
    return false
  }

  /** Any log kind sustains leaves, like vanilla — the tree species does not matter. */
  private hasNearbyLog(x: number, y: number, z: number): boolean {
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
      const id = this.getBlock(x + dx, y + dy, z + dz)
      if (isLogBlock(id)) return true
    }
    return false
  }

  private hasHorizontalWater(x: number, y: number, z: number): boolean {
    return isWaterBlock(this.getBlock(x + 1, y, z)) || isWaterBlock(this.getBlock(x - 1, y, z)) ||
      isWaterBlock(this.getBlock(x, y, z + 1)) || isWaterBlock(this.getBlock(x, y, z - 1))
  }

  private canSugarCaneStay(x: number, y: number, z: number): boolean {
    const below = this.getBlock(x, y - 1, z)
    return (below === B.GRASS || below === B.DIRT || below === B.SAND) && this.hasHorizontalWater(x, y - 1, z)
  }

  private positionHash(x: number, y: number, z: number, salt: number): number {
    let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ Math.imul(z, 0x6c8e9cf5) ^ salt
    h ^= h >>> 16
    h = Math.imul(h, 0x45d9f3b)
    h ^= h >>> 16
    return h >>> 0
  }

  /**
   * Recomputes both light grids of a chunk: sky columns with water/leaf
   * attenuation, block emitters, seeds from the four generated neighbors and
   * a flood fill. Returns a bit mask for any change plus the affected borders.
   */
  private rebuildChunkLighting(chunk: Chunk): number {
    const sky = scratchSky, block = scratchBlock, blocks = chunk.blocks
    sky.fill(0)
    block.fill(0)
    const skyQueue: number[] = []
    const blockQueue: number[] = []

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        let level = 15
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const index = Chunk.index(lx, y, lz)
          const id = blocks[index]
          if (level > 0) {
            const opacity = lightOpacity(id)
            level = opacity >= 15 ? 0 : Math.max(0, level - opacity)
            if (level > 0) {
              sky[index] = level
              skyQueue.push(index)
            }
          }
          const emitted = LIGHT_LEVEL[id] ?? 0
          if (emitted > 0) {
            block[index] = emitted
            blockQueue.push(index)
          }
        }
      }
    }

    this.seedBorderLight(chunk, sky, skyQueue, true)
    this.seedBorderLight(chunk, block, blockQueue, false)
    this.propagateChunkLight(chunk, sky, skyQueue)
    this.propagateChunkLight(chunk, block, blockQueue)

    let changes = 0
    for (let i = 0; i < LIGHT_CELLS; i++) {
      if (chunk.skyLight[i] !== sky[i] || chunk.blockLight[i] !== block[i]) {
        changes |= LIGHT_CHANGED
        const column = i >> 7
        const lx = column >> 4, lz = column & 15
        if (lx === CHUNK_SIZE - 1) changes |= LIGHT_BORDER_POS_X
        if (lx === 0) changes |= LIGHT_BORDER_NEG_X
        if (lz === CHUNK_SIZE - 1) changes |= LIGHT_BORDER_POS_Z
        if (lz === 0) changes |= LIGHT_BORDER_NEG_Z
      }
    }
    chunk.skyLight.set(sky)
    chunk.blockLight.set(block)
    return changes
  }

  /** Pulls light in across the four chunk borders from already-lit neighbors. */
  private seedBorderLight(chunk: Chunk, levels: Uint8Array, queue: number[], skyLight: boolean): void {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const neighbor = this.chunkAt(chunk.cx + dx, chunk.cz + dz)
      if (!neighbor || neighbor.state < ChunkState.GENERATED) continue
      const source = skyLight ? neighbor.skyLight : neighbor.blockLight
      for (let i = 0; i < CHUNK_SIZE; i++) {
        const lx = dx === 1 ? CHUNK_SIZE - 1 : dx === -1 ? 0 : i
        const lz = dz === 1 ? CHUNK_SIZE - 1 : dz === -1 ? 0 : i
        const nlx = dx === 1 ? 0 : dx === -1 ? CHUNK_SIZE - 1 : i
        const nlz = dz === 1 ? 0 : dz === -1 ? CHUNK_SIZE - 1 : i
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const sourceLevel = source[Chunk.index(nlx, y, nlz)]
          if (sourceLevel <= 1) continue
          const index = Chunk.index(lx, y, lz)
          const id = chunk.blocks[index]
          if (OPAQUE[id]) continue
          const incoming = sourceLevel - Math.max(1, lightOpacity(id))
          if (incoming > levels[index]) {
            levels[index] = incoming
            queue.push(index)
          }
        }
      }
    }
  }

  private propagateChunkLight(chunk: Chunk, levels: Uint8Array, queue: number[]): void {
    let head = 0
    while (head < queue.length) {
      const index = queue[head++]
      const level = levels[index]
      if (level <= 1) continue
      const y = index & (WORLD_HEIGHT - 1)
      const column = index >> 7
      const lx = column >> 4, lz = column & 15
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const nx = lx + dx, ny = y + dy, nz = lz + dz
        if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE || ny < 0 || ny >= WORLD_HEIGHT) continue
        const next = Chunk.index(nx, ny, nz)
        const nextId = chunk.blocks[next]
        if (OPAQUE[nextId]) continue
        const nextLevel = level - Math.max(1, lightOpacity(nextId))
        if (nextLevel <= 0 || levels[next] >= nextLevel) continue
        levels[next] = nextLevel
        queue.push(next)
      }
    }
  }

  private generateChunk(chunk: Chunk): void {
    this.gen.fillChunk(chunk)
    this.finishGeneratedChunk(chunk)
  }

  private finishGeneratedChunk(chunk: Chunk, structurePlans?: readonly StructurePlan[]): void {
    if (structurePlans) this.gen.primeStructurePlans(chunk.cx, chunk.cz, structurePlans)
    const edits = this.blockEdits.get(this.key(chunk.cx, chunk.cz))
    if (edits) {
      for (const [index, id] of edits) chunk.blocks[index] = id
    }
    chunk.state = ChunkState.GENERATED
    this.rebuildRandomTickIndex(chunk)
    this.rebuildChunkLighting(chunk)
    this.onChunkGenerated(chunk.cx, chunk.cz)

    // Border lighting can change when a missing neighbor arrives. Defer the
    // expensive remesh to the normal queue instead of doing it in this event.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const neighbor = this.chunkAt(chunk.cx + dx, chunk.cz + dz)
      if (!neighbor || neighbor.state !== ChunkState.MESHED) continue
      if (!this.rebuildChunkLighting(neighbor)) continue
      neighbor.state = ChunkState.GENERATED
      if (!this.meshQueue.includes(neighbor)) this.meshQueue.push(neighbor)
    }
  }

  private generateChunkAsync(chunk: Chunk): Promise<void> {
    if (chunk.state >= ChunkState.GENERATED) return Promise.resolve()
    const key = World.ck(chunk.cx, chunk.cz)
    const existing = this.generationJobs.get(key)
    if (existing) return existing

    if (!this.generationWorker) {
      this.generateChunk(chunk)
      return Promise.resolve()
    }

    const id = this.nextGenerationId++
    const job = new Promise<void>((resolve) => {
      this.pendingGeneration.set(id, { key, resolve })
      this.generationWorker!.postMessage({ type: 'generate', id, cx: chunk.cx, cz: chunk.cz })
    })
    this.generationJobs.set(key, job)
    return job
  }

  private handleGenerationResponse(response: WorldGenWorkerResponse): void {
    const pending = this.pendingGeneration.get(response.id)
    if (!pending) return
    this.pendingGeneration.delete(response.id)
    this.generationJobs.delete(pending.key)

    const chunk = this.chunks.get(pending.key)
    if (response.type === 'generated' && chunk) {
      chunk.blocks = new Uint8Array(response.blocks)
      chunk.colBiome = new Uint8Array(response.colBiome)
      chunk.colHeight = new Uint8Array(response.colHeight)
      this.finishGeneratedChunk(chunk, response.structurePlans)
    } else if (response.type === 'error' && chunk) {
      console.error(`Worker failed to generate chunk ${response.cx},${response.cz}: ${response.message}`)
      this.generateChunk(chunk)
    }
    pending.resolve()
  }

  private stopGenerationWorker(fallbackPending: boolean): void {
    this.generationWorker?.terminate()
    this.generationWorker = null
    if (!fallbackPending) {
      this.pendingGeneration.clear()
      this.generationJobs.clear()
      return
    }

    const pendingJobs = [...this.pendingGeneration.values()]
    this.pendingGeneration.clear()
    for (const pending of pendingJobs) {
      this.generationJobs.delete(pending.key)
      const chunk = this.chunks.get(pending.key)
      if (chunk && chunk.state < ChunkState.GENERATED) this.generateChunk(chunk)
      pending.resolve()
    }
  }

  private importBlockEdits(serialized: SerializedBlockEdits): void {
    const maxIndex = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT
    for (const [chunkKey, pairs] of Object.entries(serialized)) {
      if (!/^-?\d+,-?\d+$/.test(chunkKey) || !Array.isArray(pairs)) continue
      const edits = new Map<number, number>()
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const index = pairs[i]
        const id = pairs[i + 1]
        if (!Number.isInteger(index) || index < 0 || index >= maxIndex || !isValidBlockId(id)) continue
        edits.set(index, id)
      }
      if (edits.size > 0) this.blockEdits.set(chunkKey, edits)
    }
  }

  private importBlockFacings(serialized: SerializedBlockFacings): void {
    const maxIndex = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT
    for (const [chunkKey, pairs] of Object.entries(serialized)) {
      if (!/^-?\d+,-?\d+$/.test(chunkKey) || !Array.isArray(pairs)) continue
      const facings = new Map<number, HorizontalFace>()
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const index = pairs[i]
        const face = pairs[i + 1]
        if (!Number.isInteger(index) || index < 0 || index >= maxIndex || !isHorizontalFace(face) || face === 4) continue
        facings.set(index, face)
      }
      if (facings.size > 0) this.blockFacings.set(chunkKey, facings)
    }
  }

  private importScheduledTicks(serialized: SerializedScheduledTicks): void {
    if (!Array.isArray(serialized)) return
    for (let i = 0; i + 4 < Math.min(serialized.length, 4096 * 5); i += 5) {
      const x = serialized[i], y = serialized[i + 1], z = serialized[i + 2]
      const delay = serialized[i + 3], kind = serialized[i + 4]
      if (![x, y, z, delay, kind].every(Number.isInteger) || Math.abs(x) > 30_000_000 ||
        Math.abs(z) > 30_000_000 || y < 1 || y >= WORLD_HEIGHT || delay < 1 ||
        (kind !== 0 && kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4 && kind !== 5)) continue
      const tick = { x, y, z, due: delay, kind: kind as 0 | 1 | 2 | 3 | 4 | 5 }
      const key = this.scheduledTickKey(x, y, z, tick.kind)
      const existing = this.scheduledTickIndex.get(key)
      if (existing) existing.due = Math.min(existing.due, delay)
      else {
        this.scheduledTicks.push(tick)
        this.scheduledTickIndex.set(key, tick)
      }
    }
  }

  private rebuildRandomTickIndex(chunk: Chunk): void {
    chunk.randomTickIndices.clear()
    for (let index = 0; index < chunk.blocks.length; index++) {
      if (wantsRandomTick(chunk.blocks[index])) {
        chunk.randomTickIndices.add(index)
      }
    }
  }

  private recordBlockEdit(chunk: Chunk, index: number, id: number): void {
    const chunkKey = this.key(chunk.cx, chunk.cz)
    let edits = this.blockEdits.get(chunkKey)
    if (!edits) {
      edits = new Map()
      this.blockEdits.set(chunkKey, edits)
    }
    edits.set(index, id)
    this.editsDirty = true
  }

  private recordBlockFacing(
    chunk: Chunk,
    index: number,
    facing: HorizontalFace | null,
    storeDefault = false
  ): void {
    const chunkKey = this.key(chunk.cx, chunk.cz)
    let facings = this.blockFacings.get(chunkKey)
    if (facing === null || (facing === 4 && !storeDefault)) {
      if (!facings?.delete(index)) return
      if (facings.size === 0) this.blockFacings.delete(chunkKey)
    } else {
      if (!facings) {
        facings = new Map()
        this.blockFacings.set(chunkKey, facings)
      }
      if (facings.get(index) === facing) return
      facings.set(index, facing)
    }
    this.editsDirty = true
  }

  /**
   * Moves each gravity block of the column down ONE cell and schedules the next
   * step, so sand/gravel visibly fall block-by-block (20 blocks/s) instead of
   * teleporting straight to the bottom of the column.
   */
  private settleFallingColumn(chunk: Chunk, lx: number, startY: number, lz: number): void {
    const replaceable = (id: number) => id === B.AIR || isFluid(id) || CROSS[id]
    let sourceY = startY
    while (sourceY < WORLD_HEIGHT && replaceable(chunk.get(lx, sourceY, lz))) sourceY++

    const wx = chunk.cx * CHUNK_SIZE + lx, wz = chunk.cz * CHUNK_SIZE + lz
    while (sourceY < WORLD_HEIGHT) {
      const id = chunk.get(lx, sourceY, lz)
      if (!GRAVITY[id]) break
      if (sourceY <= 1 || !replaceable(chunk.get(lx, sourceY - 1, lz))) break

      chunk.set(lx, sourceY, lz, B.AIR)
      this.recordBlockEdit(chunk, Chunk.index(lx, sourceY, lz), B.AIR)
      chunk.set(lx, sourceY - 1, lz, id)
      this.recordBlockEdit(chunk, Chunk.index(lx, sourceY - 1, lz), id)
      this.scheduleBlockTick(wx, sourceY - 1, wz, 1, 5)
      sourceY++
    }
  }

  /** Scheduled continuation of a falling sand/gravel block: drops one more cell per simulation tick. */
  private continueFallingBlock(x: number, y: number, z: number): void {
    if (!GRAVITY[this.getBlock(x, y, z)]) return
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const chunk = this.chunkAt(cx, cz)
    if (!chunk || chunk.state < ChunkState.GENERATED) return
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    this.settleFallingColumn(chunk, lx, y, lz)
    this.refreshChangedBlock(chunk, lx, lz)
  }

  remeshChunk(chunk: Chunk): void {
    this.disposeChunkMeshes(chunk)
    const geoms = buildChunkGeoms(this, chunk, this.atlas, this.grassDensity, this.xrayEnabled)
    if (geoms.solid) {
      const m = new THREE.Mesh(geoms.solid, this.materials.solid)
      m.castShadow = true
      m.receiveShadow = true
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.solid = m
    }
    if (geoms.foliage) {
      const m = new THREE.Mesh(geoms.foliage, this.materials.foliage)
      // foliage never casts shadows: the alpha-tested depth pass costs far
      // more than the tiny shadows of grass blades are worth
      m.receiveShadow = true
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.foliage = m
    }
    if (geoms.water) {
      const m = new THREE.Mesh(geoms.water, this.materials.water)
      m.renderOrder = 2
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.water = m
    }
    if (geoms.glass) {
      const m = new THREE.Mesh(geoms.glass, this.materials.glass)
      m.renderOrder = 3
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.glass = m
    }
    if (geoms.emissive) {
      const m = new THREE.Mesh(geoms.emissive, this.materials.emissive)
      m.renderOrder = 4
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.emissive = m
    }
    if (geoms.furnaceFire) {
      const m = new THREE.Mesh(geoms.furnaceFire, this.materials.furnaceFire)
      m.renderOrder = 4
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.furnaceFire = m
    }
    if (geoms.chest) {
      const m = new THREE.Mesh(geoms.chest, this.materials.chest)
      m.castShadow = true
      m.receiveShadow = true
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.chest = m
    }
    if (geoms.largeChest) {
      const m = new THREE.Mesh(geoms.largeChest, this.materials.largeChest)
      m.castShadow = true
      m.receiveShadow = true
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.largeChest = m
    }
    if (geoms.xray) {
      const m = new THREE.Mesh(geoms.xray, this.materials.xrayOre)
      m.visible = this.xrayEnabled
      m.renderOrder = 20
      m.matrixAutoUpdate = false
      this.scene.add(m)
      chunk.meshes.xray = m
    }
    chunk.state = ChunkState.MESHED
  }

  private disposeChunkMeshes(chunk: Chunk): void {
    for (const kind of [
      'solid', 'foliage', 'water', 'glass', 'emissive', 'furnaceFire', 'chest', 'largeChest', 'xray'
    ] as const) {
      const m = chunk.meshes[kind]
      if (m) {
        this.scene.remove(m)
        m.geometry.dispose()
        chunk.meshes[kind] = null
      }
    }
  }

  dispose(): void {
    this.stopGenerationWorker(false)
    for (const c of this.chunks.values()) this.disposeChunkMeshes(c)
    this.chunks.clear()
    this.cacheKey = NaN
    this.cacheChunk = undefined
  }
}
