import * as THREE from 'three'

const PIXELS = 16

type Point = readonly [x: number, y: number, z: number]
type SpriteUv = readonly [u: number, v: number]

/**
 * Builds the classic pre-model-system Minecraft item mesh: a front and back
 * face plus one-pixel-wide edge strips, extruded by 1/16 of the icon size.
 * `spriteUv` remains in icon-local coordinates so animated icons (the bow)
 * can swap atlas cells without rebuilding the mesh.
 */
export function createExtrudedItemGeometry(size: number): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const spriteUvs: number[] = []
  const indices: number[] = []

  const quad = (
    points: readonly [Point, Point, Point, Point],
    normal: Point,
    uvs: readonly [SpriteUv, SpriteUv, SpriteUv, SpriteUv]
  ): void => {
    const first = positions.length / 3
    for (let i = 0; i < 4; i++) {
      positions.push(...points[i])
      normals.push(...normal)
      spriteUvs.push(...uvs[i])
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }

  const half = size / 2
  const halfDepth = size / PIXELS / 2
  const step = size / PIXELS

  // The icon is mirrored horizontally in the right hand, matching the
  // classic first-person renderer and the existing hotbar sprite direction.
  quad(
    [[-half, -half, halfDepth], [half, -half, halfDepth], [half, half, halfDepth], [-half, half, halfDepth]],
    [0, 0, 1],
    [[1, 0], [0, 0], [0, 1], [1, 1]]
  )
  quad(
    [[-half, -half, -halfDepth], [-half, half, -halfDepth], [half, half, -halfDepth], [half, -half, -halfDepth]],
    [0, 0, -1],
    [[1, 0], [1, 1], [0, 1], [0, 0]]
  )

  // Two textured walls per pixel column/row reproduce ItemRenderer's
  // renderItemIn2D extrusion. Alpha testing removes walls outside the icon.
  for (let i = 0; i < PIXELS; i++) {
    const x0 = -half + i * step
    const x1 = x0 + step
    const u = 1 - (i + 0.5) / PIXELS
    quad(
      [[x0, -half, -halfDepth], [x0, -half, halfDepth], [x0, half, halfDepth], [x0, half, -halfDepth]],
      [-1, 0, 0],
      [[u, 0], [u, 0], [u, 1], [u, 1]]
    )
    quad(
      [[x1, -half, halfDepth], [x1, -half, -halfDepth], [x1, half, -halfDepth], [x1, half, halfDepth]],
      [1, 0, 0],
      [[u, 0], [u, 0], [u, 1], [u, 1]]
    )

    const y0 = -half + i * step
    const y1 = y0 + step
    const v = (i + 0.5) / PIXELS
    quad(
      [[-half, y0, -halfDepth], [half, y0, -halfDepth], [half, y0, halfDepth], [-half, y0, halfDepth]],
      [0, -1, 0],
      [[1, v], [0, v], [0, v], [1, v]]
    )
    quad(
      [[-half, y1, halfDepth], [half, y1, halfDepth], [half, y1, -halfDepth], [-half, y1, -halfDepth]],
      [0, 1, 0],
      [[1, v], [0, v], [0, v], [1, v]]
    )
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('spriteUv', new THREE.Float32BufferAttribute(spriteUvs, 2))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(spriteUvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/** Maps the icon-local UVs of an extruded item to one cell in an atlas. */
export function setExtrudedItemUv(
  geometry: THREE.BufferGeometry,
  rect: readonly [u0: number, v0: number, u1: number, v1: number]
): void {
  const source = geometry.getAttribute('spriteUv') as THREE.BufferAttribute
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
  const [u0, v0, u1, v1] = rect
  for (let i = 0; i < source.count; i++) {
    uv.setXY(
      i,
      u0 + source.getX(i) * (u1 - u0),
      v0 + source.getY(i) * (v1 - v0)
    )
  }
  uv.needsUpdate = true
}
