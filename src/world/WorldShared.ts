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

export interface RayHit {
  x: number; y: number; z: number
  nx: number; ny: number; nz: number
  id: number
  dist: number
  /** Local selection/collision bounds actually intersected by the ray. */
  shape?: BlockCollisionBox
}
export function rayBoxHit(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number
): { t: number; nx: number; ny: number; nz: number } | null {
  let near = 0, far = Infinity
  let hitNx = 0, hitNy = 0, hitNz = 0
  const axes = [
    [origin.x, dir.x, minX, maxX, 1, 0, 0],
    [origin.y, dir.y, minY, maxY, 0, 1, 0],
    [origin.z, dir.z, minZ, maxZ, 0, 0, 1]
  ] as const
  for (const [o, d, min, max, ax, ay, az] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < min || o > max) return null
      continue
    }
    let t1 = (min - o) / d, t2 = (max - o) / d
    let sign = -1
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; sign = 1 }
    if (t1 > near) {
      near = t1
      hitNx = ax * sign; hitNy = ay * sign; hitNz = az * sign
    }
    far = Math.min(far, t2)
    if (near > far) return null
  }
  return far >= 0 ? { t: Math.max(0, near), nx: hitNx, ny: hitNy, nz: hitNz } : null
}
export type SerializedBlockEdits = Record<string, number[]>
export type SerializedBlockFacings = Record<string, number[]>
export type SerializedScheduledTicks = number[]
export interface ScheduledBlockTick {
  x: number
  y: number
  z: number
  due: number
  kind: 0 | 1 | 2 | 3 | 4 | 5
}
export const SIMULATION_STEP = 1 / 20
export const MAX_TICKS_PER_FRAME = 5
export const RANDOM_TICKS_PER_SECTION = 3
export const SECTION_HEIGHT = 16
export const MOB_SIMULATION_RADIUS = 8
export const MAX_PENDING_GENERATION = 2
export const LIGHT_CELLS = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT
export const LIGHT_CHANGED = 1 << 4
export const LIGHT_BORDER_POS_X = 1 << 0
export const LIGHT_BORDER_NEG_X = 1 << 1
export const LIGHT_BORDER_POS_Z = 1 << 2
export const LIGHT_BORDER_NEG_Z = 1 << 3
export const LIGHT_BORDER_DIRECTIONS = [
  [1, 0, LIGHT_BORDER_POS_X],
  [-1, 0, LIGHT_BORDER_NEG_X],
  [0, 1, LIGHT_BORDER_POS_Z],
  [0, -1, LIGHT_BORDER_NEG_Z]
] as const
export const scratchSky = new Uint8Array(LIGHT_CELLS)
export const scratchBlock = new Uint8Array(LIGHT_CELLS)
export function lightOpacity(id: number): number {
  if (OPAQUE[id]) return 15
  if (isWaterBlock(id)) return 3
  if (isLeafBlock(id)) return 1
  return 0
}
export function wantsRandomTick(id: number): boolean {
  return isFarmingPlant(id) || id === B.FARMLAND_DRY || id === B.FARMLAND_WET ||
    id === B.GRASS || id === B.MYCELIUM || id === B.CACTUS || isLeafBlock(id)
}
