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

export function installWorldLighting(WorldClass: WorldConstructor): void {
  const prototype = WorldClass.prototype
  prototype.rebuildChunkLighting = function(this: World, chunk: Chunk): number {
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
  prototype.seedBorderLight = function(this: World, chunk: Chunk, levels: Uint8Array, queue: number[], skyLight: boolean): void {
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
  prototype.propagateChunkLight = function(this: World, chunk: Chunk, levels: Uint8Array, queue: number[]): void {
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
  prototype.generateChunk = function(this: World, chunk: Chunk): void {
    this.gen.fillChunk(chunk)
    this.finishGeneratedChunk(chunk)
  }
  prototype.finishGeneratedChunk = function(this: World, chunk: Chunk, structurePlans?: readonly StructurePlan[]): void {
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
  prototype.generateChunkAsync = function(this: World, chunk: Chunk): Promise<void> {
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
  prototype.handleGenerationResponse = function(this: World, response: WorldGenWorkerResponse): void {
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
  prototype.stopGenerationWorker = function(this: World, fallbackPending: boolean): void {
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
  prototype.importBlockEdits = function(this: World, serialized: SerializedBlockEdits): void {
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
  prototype.importBlockFacings = function(this: World, serialized: SerializedBlockFacings): void {
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
  prototype.importScheduledTicks = function(this: World, serialized: SerializedScheduledTicks): void {
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
  prototype.rebuildRandomTickIndex = function(this: World, chunk: Chunk): void {
    chunk.randomTickIndices.clear()
    for (let index = 0; index < chunk.blocks.length; index++) {
      if (wantsRandomTick(chunk.blocks[index])) {
        chunk.randomTickIndices.add(index)
      }
    }
  }
  prototype.recordBlockEdit = function(this: World, chunk: Chunk, index: number, id: number): void {
    const chunkKey = this.key(chunk.cx, chunk.cz)
    let edits = this.blockEdits.get(chunkKey)
    if (!edits) {
      edits = new Map()
      this.blockEdits.set(chunkKey, edits)
    }
    edits.set(index, id)
    this.editsDirty = true
  }
  prototype.recordBlockFacing = function(this: World, chunk: Chunk, index: number, facing: HorizontalFace | null, storeDefault = false): void {
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
  prototype.settleFallingColumn = function(this: World, chunk: Chunk, lx: number, startY: number, lz: number): void {
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
  prototype.continueFallingBlock = function(this: World, x: number, y: number, z: number): void {
    if (!GRAVITY[this.getBlock(x, y, z)]) return
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const chunk = this.chunkAt(cx, cz)
    if (!chunk || chunk.state < ChunkState.GENERATED) return
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    this.settleFallingColumn(chunk, lx, y, lz)
    this.refreshChangedBlock(chunk, lx, lz)
  }
  prototype.remeshChunk = function(this: World, chunk: Chunk): void {
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
  prototype.disposeChunkMeshes = function(this: World, chunk: Chunk): void {
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
  prototype.dispose = function(this: World): void {
    this.stopGenerationWorker(false)
    for (const c of this.chunks.values()) this.disposeChunkMeshes(c)
    this.chunks.clear()
    this.cacheKey = NaN
    this.cacheChunk = undefined
  }
}
