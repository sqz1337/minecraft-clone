import * as THREE from 'three'

export const CHUNK_SIZE = 16
export const WORLD_HEIGHT = 128

export const ChunkState = { EMPTY: 0, GENERATED: 1, MESHED: 2 } as const
export type ChunkStateT = (typeof ChunkState)[keyof typeof ChunkState]

export interface ChunkMeshes {
  solid: THREE.Mesh | null
  foliage: THREE.Mesh | null
  water: THREE.Mesh | null
}

export class Chunk {
  readonly cx: number
  readonly cz: number
  blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT)
  /** Per-column biome id and surface height, filled during generation. */
  colBiome = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
  colHeight = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
  state: ChunkStateT = ChunkState.EMPTY
  meshes: ChunkMeshes = { solid: null, foliage: null, water: null }

  constructor(cx: number, cz: number) {
    this.cx = cx
    this.cz = cz
  }

  static index(lx: number, y: number, lz: number): number {
    return (((lx << 4) | lz) << 7) | y
  }

  get(lx: number, y: number, lz: number): number {
    return this.blocks[(((lx << 4) | lz) << 7) | y]
  }

  set(lx: number, y: number, lz: number, id: number): void {
    this.blocks[(((lx << 4) | lz) << 7) | y] = id
  }
}
