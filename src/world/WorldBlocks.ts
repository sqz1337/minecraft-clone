import * as THREE from 'three'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT, ChunkState } from './Chunk'
import { WorldGen } from './WorldGen'
import {
  B, SOLID, OPAQUE, CROSS, GRAVITY, LIGHT_LEVEL, blockCollisionBox, torchSelectionBox, isValidBlockId, isDirectionalBlock,
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
import { World } from './World'

type WorldConstructor = { prototype: World }

export function migrateLegacyChestFacings(
  blockEdits: ReadonlyMap<string, ReadonlyMap<number, number>>,
  blockFacings: Map<string, Map<number, HorizontalFace>>,
  targetX: number,
  targetZ: number
): number {
  const chests: Array<{
    chunkKey: string
    index: number
    x: number
    y: number
    z: number
  }> = []
  const chestPositions = new Set<string>()
  for (const [chunkKey, edits] of blockEdits) {
    const match = /^(-?\d+),(-?\d+)$/.exec(chunkKey)
    if (!match) continue
    const cx = Number(match[1]), cz = Number(match[2])
    for (const [index, id] of edits) {
      if (id !== B.CHEST) continue
      const y = index & (WORLD_HEIGHT - 1)
      const column = index >> 7
      const lx = column >> 4
      const lz = column & (CHUNK_SIZE - 1)
      const chest = {
        chunkKey,
        index,
        x: cx * CHUNK_SIZE + lx,
        y,
        z: cz * CHUNK_SIZE + lz
      }
      chests.push(chest)
      chestPositions.add(`${chest.x},${chest.y},${chest.z}`)
    }
  }

  let migrated = 0
  for (const chest of chests) {
    let facings = blockFacings.get(chest.chunkKey)
    if (facings?.has(chest.index)) continue
    const pair = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).find(
      ([dx, dz]) => chestPositions.has(`${chest.x + dx},${chest.y},${chest.z + dz}`)
    )
    const axis = pair ? (pair[0] !== 0 ? 'z' : 'x') : undefined
    const dx = targetX - (chest.x + 0.5)
    const dz = targetZ - (chest.z + 0.5)
    const facing: HorizontalFace = axis === 'x' || (!axis && Math.abs(dx) > Math.abs(dz))
      ? dx >= 0 ? 0 : 1
      : dz >= 0 ? 4 : 5
    if (!facings) {
      facings = new Map()
      blockFacings.set(chest.chunkKey, facings)
    }
    facings.set(chest.index, facing)
    migrated++
  }
  return migrated
}

export function installWorldBlocks(WorldClass: WorldConstructor): void {
  const prototype = WorldClass.prototype
  prototype.startGenerationWorker = function(this: World): void {
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
  prototype.findSpawnAsync = function(this: World): Promise<{ x: number; z: number; yaw: number }> {
    if (!this.generationWorker) return this.gen.findSpawnAsync()

    const id = this.nextGenerationId++
    return new Promise((resolve, reject) => {
      this.pendingSpawnSearches.set(id, { resolve, reject })
      try {
        this.generationWorker!.postMessage({ type: 'find-spawn', id })
      } catch (error) {
        this.pendingSpawnSearches.delete(id)
        void this.gen.findSpawnAsync().then(resolve, reject)
      }
    })
  }
  prototype.key = function(this: World, cx: number, cz: number): string { return cx + ',' + cz }
  prototype.getChunk = function(this: World, cx: number, cz: number): Chunk | undefined {
    return this.chunkAt(cx, cz)
  }
  prototype.chunkAt = function(this: World, cx: number, cz: number): Chunk | undefined {
    const k = World.ck(cx, cz)
    if (k === this.cacheKey) return this.cacheChunk
    const c = this.chunks.get(k)
    this.cacheKey = k
    this.cacheChunk = c
    return c
  }
  prototype.ensureChunk = function(this: World, cx: number, cz: number): Chunk {
    const k = World.ck(cx, cz)
    let c = this.chunks.get(k)
    if (!c) {
      c = new Chunk(cx, cz)
      this.chunks.set(k, c)
      this.cacheKey = NaN
    }
    return c
  }
  prototype.chunkCount = function(this: World): number { return this.chunks.size }
  prototype.ensureGeneratedAt = function(this: World, x: number, z: number, radius = 0): void {
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
  prototype.hasUnsavedBlockEdits = function(this: World): boolean { return this.editsDirty }
  prototype.markBlockEditsSaved = function(this: World): void { this.editsDirty = false }
  prototype.setXrayEnabled = function(this: World, enabled: boolean): void {
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
  prototype.serializeBlockEdits = function(this: World): SerializedBlockEdits {
    const serialized: SerializedBlockEdits = {}
    for (const [chunkKey, edits] of this.blockEdits) {
      const pairs: number[] = []
      for (const [index, id] of [...edits].sort((a, b) => a[0] - b[0])) pairs.push(index, id)
      if (pairs.length > 0) serialized[chunkKey] = pairs
    }
    return serialized
  }
  prototype.serializeBlockFacings = function(this: World): SerializedBlockFacings {
    const serialized: SerializedBlockFacings = {}
    for (const [chunkKey, facings] of this.blockFacings) {
      const pairs: number[] = []
      for (const [index, face] of [...facings].sort((a, b) => a[0] - b[0])) pairs.push(index, face)
      if (pairs.length > 0) serialized[chunkKey] = pairs
    }
    return serialized
  }
  prototype.serializeScheduledTicks = function(this: World): SerializedScheduledTicks {
    const out: number[] = []
    for (const tick of this.scheduledTicks) {
      out.push(tick.x, tick.y, tick.z, Math.max(1, tick.due - this.simulationTick), tick.kind)
    }
    return out
  }
  prototype.migrateLegacyChestFacings = function(this: World, targetX: number, targetZ: number): number {
    const migrated = migrateLegacyChestFacings(this.blockEdits, this.blockFacings, targetX, targetZ)
    if (migrated > 0) this.editsDirty = true
    return migrated
  }
  prototype.getBlock = function(this: World, x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunkAt(cx, cz)
    if (!c || c.state < ChunkState.GENERATED) return B.AIR
    return c.get(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)
  }
  prototype.facingsForChunk = function(this: World, cx: number, cz: number): ReadonlyMap<number, HorizontalFace> | undefined {
    return this.blockFacings.get(this.key(cx, cz))
  }
  prototype.getBlockFacing = function(this: World, x: number, y: number, z: number): HorizontalFace {
    if (y < 0 || y >= WORLD_HEIGHT) return 4
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    return this.blockFacings.get(this.key(cx, cz))?.get(Chunk.index(lx, y, lz)) ?? 4
  }
  prototype.getSkyLight = function(this: World, x: number, y: number, z: number): number {
    if (y >= WORLD_HEIGHT) return 15
    if (y < 0) return 0
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const chunk = this.chunkAt(cx, cz)
    if (!chunk || chunk.state < ChunkState.GENERATED) return 15
    return chunk.skyLight[Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]
  }
  prototype.getBlockLight = function(this: World, x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const chunk = this.chunkAt(cx, cz)
    if (!chunk || chunk.state < ChunkState.GENERATED) return 0
    return chunk.blockLight[Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]
  }
  prototype.getLightLevel = function(this: World, x: number, y: number, z: number): number {
    return Math.max(this.getSkyLight(x, y, z), this.getBlockLight(x, y, z))
  }
  prototype.tickSimulation = function(this: World, dt: number, px: number, pz: number): void {
    this.simulationAccumulator = Math.min(this.simulationAccumulator + Math.max(0, dt), SIMULATION_STEP * MAX_TICKS_PER_FRAME)
    let steps = 0
    while (this.simulationAccumulator >= SIMULATION_STEP && steps < MAX_TICKS_PER_FRAME) {
      this.simulationAccumulator -= SIMULATION_STEP
      this.simulationTick++
      this.runScheduledTicks()
      this.batchBlocks(() => this.runRandomTicks(px, pz))
      steps++
    }
  }
  prototype.isSolid = function(this: World, x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z)
    return SOLID[id]
  }
  prototype.isWater = function(this: World, x: number, y: number, z: number): boolean {
    return isWaterBlock(this.getBlock(x, y, z))
  }
  prototype.isLava = function(this: World, x: number, y: number, z: number): boolean {
    return isLavaBlock(this.getBlock(x, y, z))
  }
  prototype.completeDoorAt = function(this: World, x: number, y: number, z: number): {
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
  prototype.doorState = function(this: World, x: number, y: number, z: number): 'open' | 'closed' | null {
    const door = this.completeDoorAt(Math.floor(x), Math.floor(y), Math.floor(z))
    return door ? (door.open ? 'open' : 'closed') : null
  }
  prototype.placeDoor = function(this: World, x: number, y: number, z: number, facing: HorizontalFace = 4): boolean {
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
  prototype.setDoorOpen = function(this: World, x: number, y: number, z: number, open: boolean): boolean {
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
  prototype.openDoor = function(this: World, x: number, y: number, z: number): boolean {
    return this.setDoorOpen(x, y, z, true)
  }
  prototype.breakDoor = function(this: World, x: number, y: number, z: number): boolean {
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
  prototype.batchBlocks = function(this: World, action: () => void): void {
    this.mutationBatchDepth = (this.mutationBatchDepth ?? 0) + 1
    try { action() } finally {
      this.mutationBatchDepth--
      if (this.mutationBatchDepth === 0) this.flushDirtyChunks(true)
    }
  }
  prototype.primeTnt = function(this: World, x: number, y: number, z: number, fuseTicks = 80, scattered = false): boolean {
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
  prototype.ignite = function(this: World, x: number, y: number, z: number): boolean {
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
  prototype.canPlantWheat = function(this: World, x: number, y: number, z: number): boolean {
    const below = this.getBlock(x, y - 1, z)
    return this.getBlock(x, y, z) === B.AIR &&
      (below === B.FARMLAND_DRY || below === B.FARMLAND_WET)
  }
  prototype.canPlantSapling = function(this: World, x: number, y: number, z: number): boolean {
    const below = this.getBlock(x, y - 1, z)
    const current = this.getBlock(x, y, z)
    return (current === B.AIR || CROSS[current]) && (below === B.GRASS || below === B.DIRT)
  }
  prototype.canPlantSugarCane = function(this: World, x: number, y: number, z: number): boolean {
    const current = this.getBlock(x, y, z)
    if (current !== B.AIR && !CROSS[current]) return false
    const below = this.getBlock(x, y - 1, z)
    if (below === B.SUGARCANE) return true
    if (below !== B.GRASS && below !== B.DIRT && below !== B.SAND) return false
    return this.hasHorizontalWater(x, y - 1, z)
  }
  prototype.canPlantMushroom = function(this: World, x: number, y: number, z: number): boolean {
    const current = this.getBlock(x, y, z)
    return (current === B.AIR || CROSS[current]) && OPAQUE[this.getBlock(x, y - 1, z)] &&
      this.getLightLevel(x, y, z) <= 12
  }
  prototype.fertilize = function(this: World, x: number, y: number, z: number): boolean {
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
  prototype.growTree = function(this: World, x: number, y: number, z: number, spruce = false): boolean {
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
  prototype.setBlock = function(this: World, x: number, y: number, z: number, id: number, facing?: HorizontalFace): void {
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
      : id === B.TORCH ? (facing ?? null)
      : null
    const previousStoredFacing = isDirectionalBlock(previousId)
      ? previousFacing
      : previousId === B.TORCH ? (storedPreviousFacing ?? null) : null
    const facingChanged = nextFacing !== previousStoredFacing ||
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
      // Breaking a support pops decorations and reports every automatic break
      // through the normal drop hook. Sugar cane is a vertical chain: removing
      // any segment must also remove (and drop) every segment above it.
      if (id === B.AIR) {
        let aboveY = y + 1
        while (aboveY < WORLD_HEIGHT) {
          const aboveId = c.get(lx, aboveY, lz)
          if (!CROSS[aboveId] || aboveId === B.FIRE) break
          const aboveIndex = Chunk.index(lx, aboveY, lz)
          c.set(lx, aboveY, lz, B.AIR)
          c.randomTickIndices.delete(aboveIndex)
          this.recordBlockEdit(c, aboveIndex, B.AIR)
          this.onAutomaticBlockBreak(x, aboveY, z, aboveId)
          if (aboveId !== B.SUGARCANE) break
          aboveY++
        }
        for (const [dx, dz, torchFacing] of [
          [1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]
        ] as const) {
          const torchX = x + dx, torchZ = z + dz
          if (this.getBlock(torchX, y, torchZ) !== B.TORCH) continue
          const torchCx = Math.floor(torchX / CHUNK_SIZE), torchCz = Math.floor(torchZ / CHUNK_SIZE)
          const torchLx = torchX - torchCx * CHUNK_SIZE, torchLz = torchZ - torchCz * CHUNK_SIZE
          const storedTorchFacing = this.blockFacings.get(this.key(torchCx, torchCz))
            ?.get(Chunk.index(torchLx, y, torchLz))
          if (storedTorchFacing !== torchFacing) continue
          this.setBlock(torchX, y, torchZ, B.AIR)
          this.onAutomaticBlockBreak(torchX, y, torchZ, B.TORCH)
        }
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
    this.recordBlockFacing(c, index, nextFacing, id === B.VINE || id === B.TORCH || id === B.CHEST)
    // Lighting is updated immediately so gameplay queries stay correct, while
    // geometry rebuilds use the same per-frame budget as streamed chunks.
    this.refreshChangedBlock(c, lx, lz, true)
  }
  prototype.setBlockFacing = function(this: World, x: number, y: number, z: number, facing: HorizontalFace): void {
    const id = this.getBlock(x, y, z)
    if (!isDirectionalBlock(id)) return
    this.setBlock(x, y, z, id, facing)
  }
  prototype.remeshAt = function(this: World, cx: number, cz: number): void {
    const c = this.chunkAt(cx, cz)
    if (c && c.state === ChunkState.MESHED) this.remeshChunk(c)
  }
  prototype.queueRemesh = function(this: World, chunk: Chunk): void {
    if (chunk.state !== ChunkState.MESHED) return
    chunk.state = ChunkState.GENERATED
    if (!this.meshQueue.includes(chunk)) this.meshQueue.push(chunk)
  }
  prototype.queueRemeshAt = function(this: World, cx: number, cz: number): void {
    const chunk = this.chunkAt(cx, cz)
    if (chunk) this.queueRemesh(chunk)
  }
  prototype.biomeAt = function(this: World, x: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunkAt(cx, cz)
    if (c && c.state >= ChunkState.GENERATED) {
      return c.colBiome[((x - cx * CHUNK_SIZE) << 4) | (z - cz * CHUNK_SIZE)]
    }
    return this.gen.biomeAt(x, z)
  }
  prototype.isSlimeChunk = function(this: World, cx: number, cz: number): boolean {
    return this.gen.isSlimeChunk(cx, cz)
  }
  prototype.topSolidY = function(this: World, x: number, z: number): number {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = this.getBlock(x, y, z)
      if (SOLID[id] && !CROSS[id]) return y
    }
    return -1
  }
  prototype.raycast = function(this: World, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, includeFluids = false): RayHit | null {
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
        const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
        const storedFacing = id === B.TORCH
          ? this.blockFacings.get(this.key(cx, cz))
            ?.get(Chunk.index(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE))
          : undefined
        const shape = id === B.TORCH
          ? torchSelectionBox(storedFacing)
          : (includeFluids && isFluid(id)) || CROSS[id]
            ? { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }
            : blockCollisionBox(id, this.getBlockFacing(x, y, z))
        if (shape) {
          const exact = rayBoxHit(
            origin, dir,
            x + shape.minX, y + shape.minY, z + shape.minZ,
            x + shape.maxX, y + shape.maxY, z + shape.maxZ
          )
          if (exact && exact.t <= maxDist) {
            return {
              x, y, z, nx: exact.nx || nx, ny: exact.ny || ny, nz: exact.nz || nz,
              id, dist: exact.t, shape
            }
          }
        }
      }
    }
    return null
  }
}
