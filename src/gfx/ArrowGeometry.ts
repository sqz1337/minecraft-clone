import * as THREE from 'three'

type Point = readonly [x: number, y: number, z: number]
type Uv = readonly [u: number, v: number]

/**
 * Classic pre-1.8 arrow: two crossed shaft/feather planes and a small rear cap.
 * UVs select the same regions of item/arrows.png as RenderArrow in Minecraft 1.2.5.
 * The mesh points along local +Z so ProjectileManager can orient it to velocity.
 */
export function createArrowGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  const quad = (
    points: readonly [Point, Point, Point, Point],
    normal: Point,
    texture: readonly [Uv, Uv, Uv, Uv]
  ): void => {
    const first = positions.length / 3
    for (let i = 0; i < 4; i++) {
      positions.push(...points[i])
      normals.push(...normal)
      uvs.push(...texture[i])
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }

  const halfLength = 0.45
  const halfWidth = 0.1125
  const mainUv = [[0, 27 / 32], [0, 1], [0.5, 1], [0.5, 27 / 32]] as const

  quad(
    [[-halfWidth, 0, -halfLength], [halfWidth, 0, -halfLength], [halfWidth, 0, halfLength], [-halfWidth, 0, halfLength]],
    [0, 1, 0],
    mainUv
  )
  quad(
    [[0, -halfWidth, -halfLength], [0, halfWidth, -halfLength], [0, halfWidth, halfLength], [0, -halfWidth, halfLength]],
    [1, 0, 0],
    mainUv
  )

  const capUv = [[0, 22 / 32], [5 / 32, 22 / 32], [5 / 32, 27 / 32], [0, 27 / 32]] as const
  quad(
    [[-halfWidth, -halfWidth, -halfLength], [halfWidth, -halfWidth, -halfLength], [halfWidth, halfWidth, -halfLength], [-halfWidth, halfWidth, -halfLength]],
    [0, 0, -1],
    capUv
  )

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}
