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
import { World } from './World'

type WorldConstructor = { prototype: World }

export function installWorldStreaming(WorldClass: WorldConstructor): void {
  const prototype = WorldClass.prototype
  prototype.setRenderDistance = function(this: World, r: number): void {
    this.renderDistance = r
    this.queuesDirty = true
  }
  prototype.pregen = async function(this: World, ccx: number, ccz: number, onProgress: (f: number) => void): Promise<void> {
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
  prototype.update = function(this: World, px: number, pz: number, budgetMs: number): void {
    const ccx = Math.floor(px / CHUNK_SIZE), ccz = Math.floor(pz / CHUNK_SIZE)
    if (ccx !== this.lastCenter.cx || ccz !== this.lastCenter.cz || this.queuesDirty) {
      this.lastCenter = { cx: ccx, cz: ccz }
      this.queuesDirty = false
      this.rebuildQueues(ccx, ccz)
    }

    const t0 = performance.now()
    while (performance.now() - t0 < budgetMs) {
      let progressed = false
      const genC = this.genQueue.pop()
      if (genC) {
        if (genC.state >= ChunkState.GENERATED || this.generationJobs?.has(World.ck(genC.cx, genC.cz))) {
          progressed = true
        } else if (!this.generationWorker || this.pendingGeneration.size < MAX_PENDING_GENERATION) {
          void this.generateChunkAsync(genC)
          progressed = true
        } else {
          // The worker is full, but a completed chunk may still be ready to mesh.
          this.genQueue.push(genC)
        }
      }

      const meshC = this.meshQueue.pop()
      if (meshC) {
        if (meshC.state === ChunkState.MESHED) {
          progressed = true
        } else if (!this.neighborsGenerated(meshC)) {
          // Try the next-nearest entry on the following pass/frame.
          this.meshQueue.unshift(meshC)
        } else {
          this.remeshChunk(meshC)
          progressed = true
        }
      }
      if (!progressed) break
    }
  }
  prototype.neighborsGenerated = function(this: World, c: Chunk): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunkAt(c.cx + dx, c.cz + dz)
        if (!n || n.state < ChunkState.GENERATED) return false
      }
    }
    return true
  }
  prototype.rebuildQueues = function(this: World, ccx: number, ccz: number): void {
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
  prototype.refreshChangedBlock = function(this: World, chunk: Chunk, lx: number, lz: number, deferMesh = false): void {
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
    if (deferMesh) this.queueRemesh(chunk)
    else this.remeshChunk(chunk)
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
        if (deferMesh) this.queueRemesh(neighbor)
        else this.remeshChunk(neighbor)
        remeshed.add(neighborKey)
      }
    }
    for (let i = 1; i < keys.length; i++) {
      if (remeshed.has(World.ck(keys[i][0], keys[i][1]))) continue
      if (deferMesh) this.queueRemeshAt(keys[i][0], keys[i][1])
      else this.remeshAt(keys[i][0], keys[i][1])
    }
  }
  prototype.flushDirtyChunks = function(this: World, deferMesh = false): void {
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
      if (!chunk || chunk.state !== ChunkState.MESHED) continue
      if (deferMesh) this.queueRemesh(chunk)
      else this.remeshChunk(chunk)
    }
    for (const chunk of rippled) {
      if (deferMesh) this.queueRemesh(chunk)
      else this.remeshChunk(chunk)
    }
  }
}
