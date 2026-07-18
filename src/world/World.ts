import * as THREE from 'three'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT, ChunkState } from './Chunk'
import { WorldGen } from './WorldGen'
import {
  B, SOLID, CROSS, GRAVITY, isValidBlockId, isDirectionalBlock, isHorizontalFace,
  type HorizontalFace
} from './Blocks'
import { buildChunkGeoms } from './Mesher'
import type { Materials } from '../gfx/Materials'
import type { Atlas } from '../gfx/Atlas'

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

export class World {
  readonly gen: WorldGen
  private scene: THREE.Scene
  private materials: Materials
  private atlas: Atlas
  private chunks = new Map<string, Chunk>()
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

  constructor(
    gen: WorldGen,
    scene: THREE.Scene,
    materials: Materials,
    atlas: Atlas,
    renderDistance: number,
    grassDensity: number,
    savedEdits: SerializedBlockEdits = {},
    savedFacings: SerializedBlockFacings = {}
  ) {
    this.gen = gen
    this.scene = scene
    this.materials = materials
    this.atlas = atlas
    this.renderDistance = renderDistance
    this.grassDensity = grassDensity
    this.importBlockEdits(savedEdits)
    this.importBlockFacings(savedFacings)
  }

  private key(cx: number, cz: number): string { return cx + ',' + cz }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(this.key(cx, cz))
  }

  private ensureChunk(cx: number, cz: number): Chunk {
    let c = this.chunks.get(this.key(cx, cz))
    if (!c) {
      c = new Chunk(cx, cz)
      this.chunks.set(this.key(cx, cz), c)
    }
    return c
  }

  chunkCount(): number { return this.chunks.size }

  hasUnsavedBlockEdits(): boolean { return this.editsDirty }

  markBlockEditsSaved(): void { this.editsDirty = false }

  setXrayEnabled(enabled: boolean): void {
    this.xrayEnabled = enabled
    for (const chunk of this.chunks.values()) {
      if (chunk.meshes.xray) chunk.meshes.xray.visible = enabled
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

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(this.key(cx, cz))
    if (!c || c.state < ChunkState.GENERATED) return B.AIR
    return c.get(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)
  }

  getBlockFacing(x: number, y: number, z: number): HorizontalFace {
    if (y < 0 || y >= WORLD_HEIGHT) return 4
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    return this.blockFacings.get(this.key(cx, cz))?.get(Chunk.index(lx, y, lz)) ?? 4
  }

  isSolid(x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z)
    return SOLID[id]
  }

  isWater(x: number, y: number, z: number): boolean {
    return this.getBlock(x, y, z) === B.WATER
  }

  setBlock(x: number, y: number, z: number, id: number, facing?: HorizontalFace): void {
    if (y < 1 || y >= WORLD_HEIGHT || !isValidBlockId(id)) return
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(this.key(cx, cz))
    if (!c || c.state < ChunkState.GENERATED) return
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    const index = Chunk.index(lx, y, lz)
    const previousId = c.get(lx, y, lz)
    const previousFacing = this.blockFacings.get(this.key(cx, cz))?.get(index) ?? 4
    const nextFacing = isDirectionalBlock(id)
      ? (facing ?? (isDirectionalBlock(previousId) ? previousFacing : 4))
      : null
    const facingChanged = nextFacing !== (isDirectionalBlock(previousId) ? previousFacing : null)
    const blockChanged = previousId !== id
    if (!blockChanged && !facingChanged) return

    if (blockChanged) {
      c.set(lx, y, lz, id)
      this.recordBlockEdit(c, index, id)
      // breaking a support pops the decoration above it
      if (id === B.AIR && y + 1 < WORLD_HEIGHT && CROSS[c.get(lx, y + 1, lz)]) {
        c.set(lx, y + 1, lz, B.AIR)
        this.recordBlockEdit(c, Chunk.index(lx, y + 1, lz), B.AIR)
      }
      if (id === B.AIR) this.settleFallingColumn(c, lx, y + 1, lz)
      else if (GRAVITY[id]) this.settleFallingColumn(c, lx, y, lz)
    }
    this.recordBlockFacing(c, index, nextFacing)
    this.remeshChunk(c)
    if (lx === 0) this.remeshAt(cx - 1, cz)
    if (lx === CHUNK_SIZE - 1) this.remeshAt(cx + 1, cz)
    if (lz === 0) this.remeshAt(cx, cz - 1)
    if (lz === CHUNK_SIZE - 1) this.remeshAt(cx, cz + 1)
    if (lx === 0 && lz === 0) this.remeshAt(cx - 1, cz - 1)
    if (lx === 0 && lz === CHUNK_SIZE - 1) this.remeshAt(cx - 1, cz + 1)
    if (lx === CHUNK_SIZE - 1 && lz === 0) this.remeshAt(cx + 1, cz - 1)
    if (lx === CHUNK_SIZE - 1 && lz === CHUNK_SIZE - 1) this.remeshAt(cx + 1, cz + 1)
  }

  setBlockFacing(x: number, y: number, z: number, facing: HorizontalFace): void {
    const id = this.getBlock(x, y, z)
    if (!isDirectionalBlock(id)) return
    this.setBlock(x, y, z, id, facing)
  }

  private remeshAt(cx: number, cz: number): void {
    const c = this.chunks.get(this.key(cx, cz))
    if (c && c.state === ChunkState.MESHED) this.remeshChunk(c)
  }

  biomeAt(x: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(this.key(cx, cz))
    if (c && c.state >= ChunkState.GENERATED) {
      return c.colBiome[((x - cx * CHUNK_SIZE) << 4) | (z - cz * CHUNK_SIZE)]
    }
    return this.gen.biomeAt(x, z)
  }

  /** Highest solid, non-decoration block in a column (or -1). */
  topSolidY(x: number, z: number): number {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = this.getBlock(x, y, z)
      if (SOLID[id] && !CROSS[id]) return y
    }
    return -1
  }

  /** Voxel DDA raycast against solid + cross blocks. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
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
      if (id !== B.AIR && id !== B.WATER && (SOLID[id] || CROSS[id])) {
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
    const genList: [number, number][] = []
    for (let dz = -r - 1; dz <= r + 1; dz++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) genList.push([ccx + dx, ccz + dz])
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
      if (c.state < ChunkState.GENERATED) this.generateChunk(c)
      done++
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
        if (genC.state < ChunkState.GENERATED) this.generateChunk(genC)
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
        const n = this.chunks.get(this.key(c.cx + dx, c.cz + dz))
        if (!n || n.state < ChunkState.GENERATED) return false
      }
    }
    return true
  }

  private rebuildQueues(ccx: number, ccz: number): void {
    const r = this.renderDistance
    this.genQueue.length = 0
    this.meshQueue.length = 0
    for (let dz = -r - 1; dz <= r + 1; dz++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const c = this.ensureChunk(ccx + dx, ccz + dz)
        const ring = Math.max(Math.abs(dx), Math.abs(dz))
        if (c.state < ChunkState.GENERATED) this.genQueue.push(c)
        if (ring <= r && c.state < ChunkState.MESHED) this.meshQueue.push(c)
      }
    }
    // pop() takes from the end, so sort farthest-first
    const d2 = (c: Chunk) => (c.cx - ccx) ** 2 + (c.cz - ccz) ** 2
    this.genQueue.sort((a, b) => d2(b) - d2(a))
    this.meshQueue.sort((a, b) => d2(b) - d2(a))

    // unload far chunks
    const limit = r + 3
    for (const [k, c] of this.chunks) {
      if (Math.abs(c.cx - ccx) > limit || Math.abs(c.cz - ccz) > limit) {
        this.disposeChunkMeshes(c)
        this.chunks.delete(k)
      }
    }
  }

  private generateChunk(chunk: Chunk): void {
    this.gen.fillChunk(chunk)
    const edits = this.blockEdits.get(this.key(chunk.cx, chunk.cz))
    if (!edits) return
    for (const [index, id] of edits) chunk.blocks[index] = id
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

  private recordBlockFacing(chunk: Chunk, index: number, facing: HorizontalFace | null): void {
    const chunkKey = this.key(chunk.cx, chunk.cz)
    let facings = this.blockFacings.get(chunkKey)
    if (facing === null || facing === 4) {
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

  private settleFallingColumn(chunk: Chunk, lx: number, startY: number, lz: number): void {
    const replaceable = (id: number) => id === B.AIR || id === B.WATER || CROSS[id]
    let sourceY = startY
    while (sourceY < WORLD_HEIGHT && replaceable(chunk.get(lx, sourceY, lz))) sourceY++

    while (sourceY < WORLD_HEIGHT) {
      const id = chunk.get(lx, sourceY, lz)
      if (!GRAVITY[id]) break

      let targetY = sourceY
      while (targetY > 1 && replaceable(chunk.get(lx, targetY - 1, lz))) targetY--
      if (targetY === sourceY) break

      chunk.set(lx, sourceY, lz, B.AIR)
      this.recordBlockEdit(chunk, Chunk.index(lx, sourceY, lz), B.AIR)
      chunk.set(lx, targetY, lz, id)
      this.recordBlockEdit(chunk, Chunk.index(lx, targetY, lz), id)
      sourceY++
    }
  }

  remeshChunk(chunk: Chunk): void {
    this.disposeChunkMeshes(chunk)
    const geoms = buildChunkGeoms(this, chunk, this.atlas, this.grassDensity)
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
      m.castShadow = true
      m.receiveShadow = true
      m.customDepthMaterial = this.materials.foliageDepth
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
    for (const c of this.chunks.values()) this.disposeChunkMeshes(c)
    this.chunks.clear()
  }
}
