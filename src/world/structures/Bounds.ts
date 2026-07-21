import { CHUNK_SIZE, WORLD_HEIGHT } from '../Chunk'

/**
 * Inclusive world-space bounds.  The x0/y0/z0 aliases keep the old structure
 * debug API readable while min/max names make the inclusive contract explicit.
 */
export interface BoundingBox3D {
  minX: number; minY: number; minZ: number
  maxX: number; maxY: number; maxZ: number
  x0: number; y0: number; z0: number
  x1: number; y1: number; z1: number
}

export function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): BoundingBox3D {
  const x0 = Math.min(Math.floor(minX), Math.floor(maxX))
  const y0 = Math.min(Math.floor(minY), Math.floor(maxY))
  const z0 = Math.min(Math.floor(minZ), Math.floor(maxZ))
  const x1 = Math.max(Math.floor(minX), Math.floor(maxX))
  const y1 = Math.max(Math.floor(minY), Math.floor(maxY))
  const z1 = Math.max(Math.floor(minZ), Math.floor(maxZ))
  return { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1, x0, y0, z0, x1, y1, z1 }
}

export function boxesIntersect(a: BoundingBox3D, b: BoundingBox3D): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ
}

export function boxContains(bounds: BoundingBox3D, x: number, y: number, z: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX &&
    y >= bounds.minY && y <= bounds.maxY &&
    z >= bounds.minZ && z <= bounds.maxZ
}

export function unionBoxes(boxes: readonly BoundingBox3D[]): BoundingBox3D {
  if (boxes.length === 0) throw new Error('Cannot union an empty bounding-box list')
  let minX = boxes[0].minX, minY = boxes[0].minY, minZ = boxes[0].minZ
  let maxX = boxes[0].maxX, maxY = boxes[0].maxY, maxZ = boxes[0].maxZ
  for (let i = 1; i < boxes.length; i++) {
    const next = boxes[i]
    minX = Math.min(minX, next.minX); minY = Math.min(minY, next.minY); minZ = Math.min(minZ, next.minZ)
    maxX = Math.max(maxX, next.maxX); maxY = Math.max(maxY, next.maxY); maxZ = Math.max(maxZ, next.maxZ)
  }
  return box(minX, minY, minZ, maxX, maxY, maxZ)
}

export function chunkBox(cx: number, cz: number): BoundingBox3D {
  return box(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE,
    cx * CHUNK_SIZE + CHUNK_SIZE - 1, WORLD_HEIGHT - 1, cz * CHUNK_SIZE + CHUNK_SIZE - 1)
}

export function boxIntersectsChunk(bounds: BoundingBox3D, cx: number, cz: number): boolean {
  return boxesIntersect(bounds, chunkBox(cx, cz))
}

export function horizontalBoxesIntersect(a: BoundingBox3D, b: BoundingBox3D, padding = 0): boolean {
  return a.minX - padding <= b.maxX && a.maxX + padding >= b.minX &&
    a.minZ - padding <= b.maxZ && a.maxZ + padding >= b.minZ
}
