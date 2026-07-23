import * as THREE from 'three'
import {
  B, SOLID, OPAQUE, CROSS, ORE, RENDER_SHAPE, TILE, tileFor, isWater, isLava, isLeafBlock, isBedBlock,
  isDoorBlock, doorCollisionBox, fluidLevel, canSupportVine, type HorizontalFace
} from './Blocks'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './Chunk'
import { GRASS_TINT } from './WorldGen'
import { hash301, hash01 } from '../util/math'
import type { World } from './World'
import type { Atlas } from '../gfx/Atlas'
import { ChunkGeoms, FaceDef, FACES, AO_CURVE, WATER_SURFACE, GeomBuilder, WaterBuilder, solidBuilder, foliageBuilder, glassBuilder, emissiveBuilder, furnaceFireBuilder, xrayBuilder, waterBuilder } from './MesherShared'

export function addBlockCuboid(
  builder: GeomBuilder,
  atlas: Atlas,
  wx: number,
  y: number,
  wz: number,
  id: number,
  shape: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  light: number
): void {
  const sx = shape.maxX - shape.minX
  const sy = shape.maxY - shape.minY
  const sz = shape.maxZ - shape.minZ
  const lf = 0.28 + 0.72 * light / 15
  for (let face = 0; face < FACES.length; face++) {
    const fd = FACES[face]
    const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, face))
    for (let ci = 0; ci < 4; ci++) {
      const cc = fd.c[ci]
      const uv = fd.uv[ci]
      builder.vertex(
        wx + shape.minX + cc[0] * sx,
        y + shape.minY + cc[1] * sy,
        wz + shape.minZ + cc[2] * sz,
        fd.n[0], fd.n[1], fd.n[2],
        uv[0] === 0 ? u0 : u1,
        uv[1] === 0 ? v0 : v1,
        lf, lf, lf, 0
      )
    }
    builder.quad(false)
  }
}
export function addDoorBlock(
  builder: GeomBuilder,
  atlas: Atlas,
  wx: number,
  y: number,
  wz: number,
  id: number,
  facing: HorizontalFace,
  light: number
): void {
  const shape = doorCollisionBox(id, facing)
  const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, facing, facing))
  const lf = 0.28 + 0.72 * light / 15
  const sizeX = shape.maxX - shape.minX
  const sizeZ = shape.maxZ - shape.minZ
  const thinX = sizeX < sizeZ
  const edgeFraction = 3 / 16

  for (let face = 0; face < FACES.length; face++) {
    const fd = FACES[face]
    const broad = thinX ? fd.n[0] !== 0 : fd.n[2] !== 0
    const faceU1 = broad ? u1 : u0 + (u1 - u0) * edgeFraction
    for (let ci = 0; ci < 4; ci++) {
      const cc = fd.c[ci]
      const uv = fd.uv[ci]
      builder.vertex(
        wx + shape.minX + cc[0] * sizeX,
        y + cc[1],
        wz + shape.minZ + cc[2] * sizeZ,
        fd.n[0], fd.n[1], fd.n[2],
        uv[0] === 0 ? u0 : faceU1,
        uv[1] === 0 ? v0 : v1,
        lf * (broad ? 1 : 0.82), lf * (broad ? 1 : 0.82), lf * (broad ? 1 : 0.82), 0
      )
    }
    builder.quad(false)
  }
}
export function addBedBlock(
  builder: GeomBuilder,
  atlas: Atlas,
  wx: number,
  y: number,
  wz: number,
  id: number,
  facing: HorizontalFace,
  light: number,
  sample: (x: number, y: number, z: number) => number
): void {
  const h = 0.5625
  const lf = 0.28 + 0.72 * light / 15

  const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, 2, facing))
  // RenderBlocks rotates the source tile's horizontal axis along the bed.
  // That keeps the pillow at the outer end instead of turning it sideways.
  const topUv: Record<number, [number, number][]> = {
    4: [[u0, v0], [u1, v0], [u0, v1], [u1, v1]],
    5: [[u1, v1], [u0, v1], [u1, v0], [u0, v0]],
    0: [[u0, v1], [u0, v0], [u1, v1], [u1, v0]],
    1: [[u1, v0], [u1, v1], [u0, v0], [u0, v1]]
  }
  const tuv = topUv[facing] ?? topUv[4]
  const topCorners = [[0, 0], [0, 1], [1, 0], [1, 1]] as const
  for (let ci = 0; ci < 4; ci++) {
    builder.vertex(
      wx + topCorners[ci][0], y + h, wz + topCorners[ci][1],
      0, 1, 0, tuv[ci][0], tuv[ci][1], lf, lf, lf, 0
    )
  }
  builder.quad(false)

  for (const f of [0, 1, 4, 5] as const) {
    const fd = FACES[f]
    const nb = sample(wx + fd.n[0], y, wz + fd.n[2])
    if (isBedBlock(nb)) continue
    const [su0, sv0, su1, sv1] = atlas.uvRect(tileFor(id, f, facing))
    const vLo = sv0, vHi = sv0 + (sv1 - sv0) * h
    // RenderBlocks flips exactly one lateral face. Without this mirror the
    // leg pixels point toward the center seam on one side of the bed.
    const flipSide = (facing === 4 && f === 0) || (facing === 5 && f === 1) ||
      (facing === 0 && f === 5) || (facing === 1 && f === 4)
    for (let ci = 0; ci < 4; ci++) {
      const cc = fd.c[ci]
      const uv = fd.uv[ci]
      const sideU = flipSide ? 1 - uv[0] : uv[0]
      builder.vertex(
        wx + cc[0], y + cc[1] * h, wz + cc[2],
        fd.n[0], fd.n[1], fd.n[2],
        sideU === 0 ? su0 : su1,
        uv[1] === 0 ? vLo : vHi,
        lf * 0.85, lf * 0.85, lf * 0.85, 0
      )
    }
    builder.quad(false)
  }

  // Vanilla renders the wooden underside three pixels above the floor. The
  // transparent side textures then supply the short legs below that board.
  const fd = FACES[3]
  const [bu0, bv0, bu1, bv1] = atlas.uvRect(tileFor(id, 3, facing))
  for (let ci = 0; ci < 4; ci++) {
    const cc = fd.c[ci]
    const uv = fd.uv[ci]
    builder.vertex(
      wx + cc[0], y + 0.1875, wz + cc[2], 0, -1, 0,
      uv[0] === 0 ? bu0 : bu1, uv[1] === 0 ? bv0 : bv1,
      lf * 0.6, lf * 0.6, lf * 0.6, 0
    )
  }
  builder.quad(false)
}
export type PixelRect = readonly [x: number, y: number, width: number, height: number]
export class TexturedBoxBuilder {
  private pos: number[] = []
  private nrm: number[] = []
  private uv: number[] = []
  private idx: number[] = []
  private vcount = 0

  private rotate(x: number, z: number, facing: HorizontalFace): [number, number] {
    if (facing === 5) return [-x, -z]
    if (facing === 0) return [z, -x]
    if (facing === 1) return [-z, x]
    return [x, z]
  }

  private quad(
    centerX: number,
    centerZ: number,
    facing: HorizontalFace,
    corners: readonly (readonly [number, number, number])[],
    normal: readonly [number, number, number],
    faceUvs: readonly (readonly [number, number])[],
    rect: PixelRect,
    textureWidth: number,
    textureHeight: number
  ): void {
    const [rx, rz] = this.rotate(normal[0], normal[2], facing)
    const [px, py, pw, ph] = rect
    const u0 = px / textureWidth, u1 = (px + pw) / textureWidth
    const v0 = 1 - (py + ph) / textureHeight, v1 = 1 - py / textureHeight
    for (let i = 0; i < 4; i++) {
      const [lx, ly, lz] = corners[i]
      const [x, z] = this.rotate(lx, lz, facing)
      const uv = faceUvs[i]
      this.pos.push(centerX + x, ly, centerZ + z)
      this.nrm.push(rx, normal[1], rz)
      this.uv.push(uv[0] === 0 ? u0 : u1, uv[1] === 0 ? v0 : v1)
      this.vcount++
    }
    const a = this.vcount - 4
    this.idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
  }

  box(
    centerX: number,
    y0: number,
    centerZ: number,
    widthPx: number,
    heightPx: number,
    depthPx: number,
    textureX: number,
    textureY: number,
    textureWidth: number,
    facing: HorizontalFace
  ): void {
    const x0 = -widthPx / 32, x1 = widthPx / 32
    const z0 = -depthPx / 32, z1 = depthPx / 32
    const y1 = y0 + heightPx / 16
    const u = textureX, v = textureY, dx = widthPx, dy = heightPx, dz = depthPx
    const f1 = u + dz, f2 = f1 + dx, f3 = f2 + dx, f4 = f2 + dz
    const vertical = v + dz
    const rects: PixelRect[] = [
      [f2, vertical, dz, dy],
      [u, vertical, dz, dy],
      [f2, v, f3 - f2, dz],
      [f1, v, f2 - f1, dz],
      [f4, vertical, dx, dy],
      [f1, vertical, dx, dy]
    ]
    const corners = [
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z1], [x1, y1, z0]],
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z0], [x0, y1, z1]],
      [[x0, y1, z0], [x0, y1, z1], [x1, y1, z0], [x1, y1, z1]],
      [[x0, y0, z1], [x0, y0, z0], [x1, y0, z1], [x1, y0, z0]],
      [[x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1]],
      [[x1, y0, z0], [x0, y0, z0], [x1, y1, z0], [x0, y1, z0]]
    ] as const
    for (let face = 0; face < 6; face++) {
      this.quad(centerX, centerZ, facing, corners[face], FACES[face].n, FACES[face].uv, rects[face], textureWidth, 64)
    }
  }

  build(): THREE.BufferGeometry | null {
    if (this.vcount === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    geometry.setIndex(this.idx)
    geometry.computeBoundingSphere()
    return geometry
  }
}
export function offsetCenter(
  centerX: number,
  centerZ: number,
  localX: number,
  localZ: number,
  facing: HorizontalFace
): [number, number] {
  if (facing === 5) return [centerX - localX, centerZ - localZ]
  if (facing === 0) return [centerX + localZ, centerZ - localX]
  if (facing === 1) return [centerX - localZ, centerZ + localX]
  return [centerX + localX, centerZ + localZ]
}
export function addChestModel(
  builder: TexturedBoxBuilder,
  centerX: number,
  y: number,
  centerZ: number,
  facing: HorizontalFace,
  large: boolean
): void {
  const width = large ? 30 : 14
  const textureWidth = large ? 128 : 64
  builder.box(centerX, y, centerZ, width, 10, 14, 0, 19, textureWidth, facing)
  builder.box(centerX, y + 10 / 16, centerZ, width, 5, 14, 0, 0, textureWidth, facing)
  const [latchX, latchZ] = offsetCenter(centerX, centerZ, 0, 15 / 32, facing)
  builder.box(latchX, y + 7 / 16, latchZ, 2, 4, 1, 0, 0, textureWidth, facing)
}
