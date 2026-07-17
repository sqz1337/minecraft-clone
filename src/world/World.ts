import * as THREE from 'three'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT, ChunkState } from './Chunk'
import { WorldGen } from './WorldGen'
import { B, SOLID, CROSS } from './Blocks'
import { buildChunkGeoms } from './Mesher'
import type { Materials } from '../gfx/Materials'
import type { Atlas } from '../gfx/Atlas'

export interface RayHit {
  x: number; y: number; z: number
  nx: number; ny: number; nz: number
  id: number
  dist: number
}

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

  constructor(gen: WorldGen, scene: THREE.Scene, materials: Materials, atlas: Atlas, renderDistance: number, grassDensity: number) {
    this.gen = gen
    this.scene = scene
    this.materials = materials
    this.atlas = atlas
    this.renderDistance = renderDistance
    this.grassDensity = grassDensity
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

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(this.key(cx, cz))
    if (!c || c.state < ChunkState.GENERATED) return B.AIR
    return c.get(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)
  }

  isSolid(x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z)
    return SOLID[id]
  }

  isWater(x: number, y: number, z: number): boolean {
    return this.getBlock(x, y, z) === B.WATER
  }

  setBlock(x: number, y: number, z: number, id: number): void {
    if (y < 1 || y >= WORLD_HEIGHT) return
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
    const c = this.chunks.get(this.key(cx, cz))
    if (!c || c.state < ChunkState.GENERATED) return
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
    c.set(lx, y, lz, id)
    // breaking a support pops the decoration above it
    if (id === B.AIR && y + 1 < WORLD_HEIGHT && CROSS[c.get(lx, y + 1, lz)]) {
      c.set(lx, y + 1, lz, B.AIR)
    }
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
      if (c.state < ChunkState.GENERATED) this.gen.fillChunk(c)
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
        if (genC.state < ChunkState.GENERATED) this.gen.fillChunk(genC)
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
    chunk.state = ChunkState.MESHED
  }

  private disposeChunkMeshes(chunk: Chunk): void {
    for (const kind of ['solid', 'foliage', 'water'] as const) {
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
