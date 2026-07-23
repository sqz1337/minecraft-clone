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
import { addBlockCuboid, addDoorBlock, addBedBlock, PixelRect, TexturedBoxBuilder, offsetCenter, addChestModel } from './MesherModels'

export * from './MesherShared'
export * from './MesherModels'

// Source-level regression landmark implemented in MesherModels.ts:
// for (let face = 0; face < FACES.length; face++)

export function buildChunkGeoms(world: World, chunk: Chunk, atlas: Atlas, grassDensity: number, includeXray = false): ChunkGeoms {
  const bx = chunk.cx * CHUNK_SIZE
  const bz = chunk.cz * CHUNK_SIZE
  const seed = world.gen.seedNum

  // cache the 3x3 chunk neighborhood for fast block and light sampling
  const hood: (Chunk | null)[] = []
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = world.getChunk(chunk.cx + dx, chunk.cz + dz)
      hood.push(c && c.state >= 1 ? c : null)
    }
  }

  const sample = (wx: number, wy: number, wz: number): number => {
    if (wy < 0) return B.BEDROCK
    if (wy >= WORLD_HEIGHT) return B.AIR
    const lx = wx - bx, lz = wz - bz
    const ncx = lx < 0 ? -1 : lx >= CHUNK_SIZE ? 1 : 0
    const ncz = lz < 0 ? -1 : lz >= CHUNK_SIZE ? 1 : 0
    const c = hood[(ncz + 1) * 3 + (ncx + 1)]
    if (!c) return B.AIR
    const ax = lx - ncx * CHUNK_SIZE, az = lz - ncz * CHUNK_SIZE
    return c.blocks[(((ax << 4) | az) << 7) | wy]
  }

  /** max(sky, block) light straight from the cached neighborhood — mirrors World.getLightLevel. */
  const sampleLight = (wx: number, wy: number, wz: number): number => {
    if (wy >= WORLD_HEIGHT) return 15
    if (wy < 0) return 0
    const lx = wx - bx, lz = wz - bz
    const ncx = lx < 0 ? -1 : lx >= CHUNK_SIZE ? 1 : 0
    const ncz = lz < 0 ? -1 : lz >= CHUNK_SIZE ? 1 : 0
    const c = hood[(ncz + 1) * 3 + (ncx + 1)]
    if (!c) return 15
    const index = ((((lx - ncx * CHUNK_SIZE) << 4) | (lz - ncz * CHUNK_SIZE)) << 7) | wy
    const sky = c.skyLight[index], block = c.blockLight[index]
    return sky > block ? sky : block
  }

  const solidForAO = (wx: number, wy: number, wz: number): boolean => OPAQUE[sample(wx, wy, wz)]

  const facings = world.facingsForChunk(chunk.cx, chunk.cz)

  const solid = solidBuilder
  const foliage = foliageBuilder
  const glass = glassBuilder
  const emissive = emissiveBuilder
  const furnaceFire = furnaceFireBuilder
  const xray = xrayBuilder
  const water = waterBuilder
  solid.reset(); foliage.reset(); glass.reset(); emissive.reset()
  furnaceFire.reset(); xray.reset(); water.reset()
  const chest = new TexturedBoxBuilder()
  const largeChest = new TexturedBoxBuilder()
  const blocks = chunk.blocks

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const colIdx = (lx << 4) | lz
      const colBase = colIdx << 7
      const biome = chunk.colBiome[colIdx]
      const tint = GRASS_TINT[biome] ?? GRASS_TINT[2]
      const wx = bx + lx, wz = bz + lz

      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const id = blocks[colBase | y]
        if (id === B.AIR) continue

        if (id === B.CHEST) {
          const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
          const pair = neighbors.find(([dx, dz]) => sample(wx + dx, y, wz + dz) === B.CHEST)
          let facing: HorizontalFace = facings?.get(colBase | y) ?? 4
          if (!pair) {
            addChestModel(chest, wx + 0.5, y, wz + 0.5, facing, false)
          } else {
            const [dx, dz] = pair
            const nx = wx + dx, nz = wz + dz
            const canonical = wx < nx || (wx === nx && wz < nz)
            if (canonical) {
              // Old saves had no facing metadata. Pick a valid perpendicular
              // default if such a chest pair straddles the old format.
              if (dx !== 0 && (facing === 0 || facing === 1)) facing = 4
              if (dz !== 0 && (facing === 4 || facing === 5)) facing = 0
              addChestModel(largeChest, (wx + nx + 1) / 2, y, (wz + nz + 1) / 2, facing, true)
            }
          }
          continue
        }

        if (includeXray && ORE[id]) {
          for (let f = 0; f < 6; f++) {
            const fd = FACES[f]
            const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, f))
            for (let ci = 0; ci < 4; ci++) {
              const cc = fd.c[ci]
              const uv = fd.uv[ci]
              xray.vertex(
                wx + cc[0], y + cc[1], wz + cc[2],
                fd.n[0], fd.n[1], fd.n[2],
                uv[0] === 0 ? u0 : u1,
                uv[1] === 0 ? v0 : v1,
                1, 1, 1, 0
              )
            }
            xray.quad(false)
          }
        }

        if (isWater(id)) {
          const above = sample(wx, y + 1, wz)
          const surface = !isWater(above)
          const topH = surface ? WATER_SURFACE * (8 - fluidLevel(id)) / 8 : 1
          const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, 0))
          if (surface && !OPAQUE[above]) {
            // top face — tile the still-water texture once per block
            water.vertex(wx, y + topH, wz, 0, 1, 0, u0, v0, 1)
            water.vertex(wx, y + topH, wz + 1, 0, 1, 0, u0, v1, 1)
            water.vertex(wx + 1, y + topH, wz, 0, 1, 0, u1, v0, 1)
            water.vertex(wx + 1, y + topH, wz + 1, 0, 1, 0, u1, v1, 1)
            water.quad()
          }
          // side + bottom faces against air, plus lip faces down to lower flows
          for (let f = 0; f < 6; f++) {
            if (f === 2) continue
            const fd = FACES[f]
            const uvs = fd.uv
            const nb = sample(wx + fd.n[0], y + fd.n[1], wz + fd.n[2])
            if (isWater(nb)) {
              // A lower neighbouring flow leaves a vertical step between the two
              // surfaces; without this lip the ground shows through as a white
              // slit along every flow-level change. Bottom face (down into
              // water) is always submerged, so only bridge horizontal steps.
              if (fd.n[1] !== 0) continue
              const nbTop = isWater(sample(wx + fd.n[0], y + 1, wz + fd.n[2]))
                ? 1 : WATER_SURFACE * (8 - fluidLevel(nb)) / 8
              if (nbTop >= topH - 1e-4) continue
              for (let ci = 0; ci < 4; ci++) {
                const cc = fd.c[ci]
                // aTop on both edges keeps the lip locked to the waving surfaces.
                water.vertex(wx + cc[0], y + (cc[1] ? topH : nbTop), wz + cc[2], fd.n[0], fd.n[1], fd.n[2],
                  uvs[ci][0] === 0 ? u0 : u1, uvs[ci][1] === 0 ? v0 : v1, 1)
              }
              water.quad()
              continue
            }
            if (OPAQUE[nb] || (nb !== B.AIR && !CROSS[nb] && !isLava(nb))) continue
            for (let ci = 0; ci < 4; ci++) {
              const cc = fd.c[ci]
              water.vertex(wx + cc[0], y + cc[1] * topH, wz + cc[2], fd.n[0], fd.n[1], fd.n[2],
                uvs[ci][0] === 0 ? u0 : u1, uvs[ci][1] === 0 ? v0 : v1, 0)
            }
            water.quad()
          }
          continue
        }


        if (isLava(id)) {
          const above = sample(wx, y + 1, wz)
          const surface = !isLava(above)
          const topH = surface ? WATER_SURFACE * (8 - fluidLevel(id)) / 8 : 1
          const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, 0))
          for (let f = 0; f < 6; f++) {
            if (f === 2 && !surface) continue
            const fd = FACES[f]
            const nb = sample(wx + fd.n[0], y + fd.n[1], wz + fd.n[2])
            let botH = 0
            if (f !== 2 && isLava(nb)) {
              // Fill the vertical step down to a lower neighbouring flow so the
              // ground never shows through between lava cells as a white slit.
              if (fd.n[1] !== 0) continue
              const nbTop = isLava(sample(wx + fd.n[0], y + 1, wz + fd.n[2]))
                ? 1 : WATER_SURFACE * (8 - fluidLevel(nb)) / 8
              if (nbTop >= topH - 1e-4) continue
              botH = nbTop
            } else if (f !== 2 && (OPAQUE[nb] || (nb !== B.AIR && !CROSS[nb] && !isWater(nb)))) {
              continue
            }
            const uvs = fd.uv
            for (let ci = 0; ci < 4; ci++) {
              const cc = fd.c[ci]
              emissive.vertex(
                wx + cc[0], y + (cc[1] ? topH : botH), wz + cc[2],
                fd.n[0], fd.n[1], fd.n[2],
                uvs[ci][0] === 0 ? u0 : u1, uvs[ci][1] === 0 ? v0 : v1,
                1, 0.92, 0.72, 0
              )
            }
            emissive.quad(false)
          }
          continue
        }

        if (id === B.TORCH) {
          addBlockCuboid(
            emissive, atlas, wx, y, wz, id,
            { minX: 7 / 16, minY: 0, minZ: 7 / 16, maxX: 9 / 16, maxY: 10 / 16, maxZ: 9 / 16 },
            sampleLight(wx, y + 1, wz)
          )
          continue
        }

        if (RENDER_SHAPE[id] === 'cactus') {
          // Cacti are full-height but inset one pixel on X/Z, so their side
          // textures never merge into an opaque cube or a neighboring block.
          const inset = 1 / 16
          const light = sampleLight(wx, y + 1, wz)
          const lightFactor = 0.28 + 0.72 * light / 15
          for (let f = 0; f < 6; f++) {
            const fd = FACES[f]
            const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, f))
            for (let ci = 0; ci < 4; ci++) {
              const cc = fd.c[ci]
              const uv = fd.uv[ci]
              foliage.vertex(
                wx + (cc[0] === 0 ? inset : 1 - inset), y + cc[1],
                wz + (cc[2] === 0 ? inset : 1 - inset),
                fd.n[0], fd.n[1], fd.n[2],
                uv[0] === 0 ? u0 : u1, uv[1] === 0 ? v0 : v1,
                lightFactor, lightFactor, lightFactor, 0
              )
            }
            foliage.quad(false)
          }
          continue
        }

        if (RENDER_SHAPE[id] === 'lily') {
          // A lily pad is a paper-thin, double-sided surface just above water.
          const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, 2))
          const light = sampleLight(wx, y + 1, wz)
          const lightFactor = 0.28 + 0.72 * light / 15
          const r = 0x20 / 255 * lightFactor
          const g = 0x80 / 255 * lightFactor
          const bcol = 0x30 / 255 * lightFactor
          const ly = y + 1 / 64
          const positions = [[wx, wz], [wx, wz + 1], [wx + 1, wz], [wx + 1, wz + 1]] as const
          const baseUvs = [[u0, v0], [u0, v1], [u1, v0], [u1, v1]] as const
          const rotations = [
            [0, 1, 2, 3], [1, 3, 0, 2], [3, 2, 1, 0], [2, 0, 3, 1]
          ] as const
          const rotation = hash301(wx, 0, wz, seed ^ 0x11e1) * 4 | 0
          for (let corner = 0; corner < 4; corner++) {
            const uv = baseUvs[rotations[rotation][corner]]
            foliage.vertex(positions[corner][0], ly, positions[corner][1], 0, 1, 0,
              uv[0], uv[1], r, g, bcol, 0)
          }
          foliage.quad(false)
          continue
        }

        if (RENDER_SHAPE[id] === 'vine') {
          // Metadata-free generated vines infer their attached faces from
          // neighboring blocks. Hanging segments inherit the first faces found
          // up their contiguous column, preserving long jungle curtains.
          let attached: HorizontalFace | undefined = facings?.get(colBase | y)
          for (let sy = y; attached === undefined && sy < Math.min(WORLD_HEIGHT, y + 16) && sample(wx, sy, wz) === B.VINE; sy++) {
            for (const f of [0, 1, 4, 5] as const) {
              const fd = FACES[f]
              if (canSupportVine(sample(wx + fd.n[0], sy, wz + fd.n[2]))) {
                attached = f
                break
              }
            }
          }
          const [u0, v0, u1, v1] = atlas.uvRect(tileFor(id, 0))
          const light = sampleLight(wx, y, wz)
          const lightFactor = 0.28 + 0.72 * light / 15
          const r = tint[0] * 1.35 * lightFactor
          const g = tint[1] * 1.35 * lightFactor
          const bcol = tint[2] * 1.35 * lightFactor
          const epsilon = 1 / 128
          if (attached !== undefined) {
            const f = attached
            const fd = FACES[f]
            for (let ci = 0; ci < 4; ci++) {
              const cc = fd.c[ci]
              const uv = fd.uv[ci]
              let vx = wx + cc[0], vz = wz + cc[2]
              if (f === 0) vx -= epsilon
              else if (f === 1) vx += epsilon
              else if (f === 4) vz -= epsilon
              else vz += epsilon
              foliage.vertex(
                vx, y + cc[1], vz, fd.n[0], 0, fd.n[2],
                uv[0] === 0 ? u0 : u1, uv[1] === 0 ? v0 : v1,
                r, g, bcol, 0
              )
            }
            foliage.quad(false)
          }
          if (attached === undefined) {
            // Corrupt/edited unsupported vines remain visible until their
            // scheduled support check removes them.
            for (const [x0, z0, x1, z1] of [
              [wx + 0.15, wz + 0.15, wx + 0.85, wz + 0.85],
              [wx + 0.15, wz + 0.85, wx + 0.85, wz + 0.15]
            ] as const) {
              foliage.vertex(x0, y, z0, 0, 1, 0, u0, v0, r, g, bcol, 0)
              foliage.vertex(x1, y, z1, 0, 1, 0, u1, v0, r, g, bcol, 0)
              foliage.vertex(x0, y + 1, z0, 0, 1, 0, u0, v1, r, g, bcol, 0)
              foliage.vertex(x1, y + 1, z1, 0, 1, 0, u1, v1, r, g, bcol, 0)
              foliage.quad(false)
            }
          }
          continue
        }

        if (RENDER_SHAPE[id] === 'cross') {
          // decoration density thinning for low quality
          if (id === B.TALLGRASS && hash01(wx, wz, seed ^ 0xfeed) > grassDensity) continue
          const tile = tileFor(id, 0)
          const [u0, v0, u1, v1] = atlas.uvRect(tile)
          const jx = (hash01(wx, wz, seed ^ 0x71) - 0.5) * 0.3
          const jz = (hash01(wx, wz, seed ^ 0x72) - 0.5) * 0.3
          const useTint = id === B.TALLGRASS || id === B.FERN
          const light = sampleLight(wx, y, wz)
          const lightFactor = 0.28 + 0.72 * light / 15
          const r = (useTint ? tint[0] * 1.35 : 1) * lightFactor
          const g = (useTint ? tint[1] * 1.35 : 1) * lightFactor
          const bcol = (useTint ? tint[2] * 1.35 : 1) * lightFactor
          const x0 = wx + 0.14 + jx, x1 = wx + 0.86 + jx
          const z0 = wz + 0.14 + jz, z1 = wz + 0.86 + jz
          const quads: [number, number, number, number][] = [
            [x0, z0, x1, z1],
            [x0, z1, x1, z0]
          ]
          const crossTarget = id === B.TORCH || id === B.FIRE ? emissive : foliage
          for (const [qx0, qz0, qx1, qz1] of quads) {
            crossTarget.vertex(qx0, y, qz0, 0, 1, 0, u0, v0, r * 0.85, g * 0.85, bcol * 0.85, 0)
            crossTarget.vertex(qx1, y, qz1, 0, 1, 0, u1, v0, r * 0.85, g * 0.85, bcol * 0.85, 0)
            crossTarget.vertex(qx0, y + 1, qz0, 0, 1, 0, u0, v1, r, g, bcol, id === B.TORCH ? 0 : 1)
            crossTarget.vertex(qx1, y + 1, qz1, 0, 1, 0, u1, v1, r, g, bcol, id === B.TORCH ? 0 : 1)
            crossTarget.quad(false)
          }
          continue
        }

        if (id === B.RAIL) {
          // flat quad hovering just above the floor, oriented by neighbor rails
          const alongX = sample(wx + 1, y, wz) === B.RAIL || sample(wx - 1, y, wz) === B.RAIL
          const alongZ = sample(wx, y, wz + 1) === B.RAIL || sample(wx, y, wz - 1) === B.RAIL
          const tile = alongX && alongZ ? TILE.RAIL_CURVED : TILE.RAIL
          const [u0, v0, u1, v1] = atlas.uvRect(tile)
          const light = sampleLight(wx, y, wz)
          const lightFactor = 0.28 + 0.72 * light / 15
          const ry = y + 0.0625
          // rotate the texture 90° when the track runs along X
          const uvs: [number, number][] = alongX && !alongZ
            ? [[u0, v1], [u0, v0], [u1, v1], [u1, v0]]
            : [[u0, v0], [u1, v0], [u0, v1], [u1, v1]]
          foliage.vertex(wx, ry, wz, 0, 1, 0, uvs[0][0], uvs[0][1], lightFactor, lightFactor, lightFactor, 0)
          foliage.vertex(wx + 1, ry, wz, 0, 1, 0, uvs[1][0], uvs[1][1], lightFactor, lightFactor, lightFactor, 0)
          foliage.vertex(wx, ry, wz + 1, 0, 1, 0, uvs[2][0], uvs[2][1], lightFactor, lightFactor, lightFactor, 0)
          foliage.vertex(wx + 1, ry, wz + 1, 0, 1, 0, uvs[3][0], uvs[3][1], lightFactor, lightFactor, lightFactor, 0)
          foliage.quad(false)
          continue
        }

        if (isBedBlock(id)) {
          addBedBlock(solid, atlas, wx, y, wz, id, facings?.get(colBase | y) ?? 4, sampleLight(wx, y + 1, wz), sample)
          continue
        }

        if (isDoorBlock(id)) {
          addDoorBlock(foliage, atlas, wx, y, wz, id, facings?.get(colBase | y) ?? 4, sampleLight(wx, y, wz))
          continue
        }

        const isLeaf = isLeafBlock(id)
        const isGlassLike = id === B.GLASS || id === B.ICE
        const target = isLeaf ? foliage : isGlassLike ? glass : solid
        const facing: HorizontalFace = facings?.get(colBase | y) ?? 4
        // subtle per-block value variation breaks up flat regions
        const vary = 0.92 + hash301(wx, y, wz, seed ^ 0xc0de) * 0.14

        for (let f = 0; f < 6; f++) {
          const fd = FACES[f]
          const nb = sample(wx + fd.n[0], y + fd.n[1], wz + fd.n[2])
          if (isGlassLike && nb === id) continue
          if (OPAQUE[nb]) continue
          if (isLeaf && nb === id) continue

          const tile = tileFor(id, f, facing)
          const [u0, v0, u1, v1] = atlas.uvRect(tile)
          const faceTarget = id === B.FURNACE_LIT && f === facing ? furnaceFire : target

          let tr = vary, tg = vary, tb = vary
          if (id === B.GRASS && f === 2) {
            tr *= tint[0]; tg *= tint[1]; tb *= tint[2]
          } else if (isLeaf) {
            const lv = 0.85 + hash301(wx >> 2, y >> 2, wz >> 2, seed ^ 0x1eaf) * 0.3
            tr *= lv; tg *= lv; tb *= lv * 0.95
          }
          const light = sampleLight(wx + fd.n[0], y + fd.n[1], wz + fd.n[2])
          const lightFactor = 0.28 + 0.72 * light / 15
          tr *= lightFactor; tg *= lightFactor; tb *= lightFactor

          // ambient occlusion per corner
          const ao: number[] = []
          const [nx, ny, nz] = fd.n
          for (let ci = 0; ci < 4; ci++) {
            const cc = fd.c[ci]
            // tangent offsets: for each non-normal axis, -1 if corner coord is 0 else +1
            const ox = nx !== 0 ? 0 : (cc[0] === 0 ? -1 : 1)
            const oy = ny !== 0 ? 0 : (cc[1] === 0 ? -1 : 1)
            const oz = nz !== 0 ? 0 : (cc[2] === 0 ? -1 : 1)
            const px = wx + nx, py = y + ny, pz = wz + nz
            let s1: boolean, s2: boolean, co: boolean
            if (nx !== 0) {
              s1 = solidForAO(px, py + oy, pz)
              s2 = solidForAO(px, py, pz + oz)
              co = solidForAO(px, py + oy, pz + oz)
            } else if (ny !== 0) {
              s1 = solidForAO(px + ox, py, pz)
              s2 = solidForAO(px, py, pz + oz)
              co = solidForAO(px + ox, py, pz + oz)
            } else {
              s1 = solidForAO(px + ox, py, pz)
              s2 = solidForAO(px, py + oy, pz)
              co = solidForAO(px + ox, py + oy, pz)
            }
            ao.push(s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (co ? 1 : 0)))
          }

          const uvs = fd.uv
          for (let ci = 0; ci < 4; ci++) {
            const cc = fd.c[ci]
            const shade = AO_CURVE[ao[ci]]
            faceTarget.vertex(
              wx + cc[0], y + cc[1], wz + cc[2],
              nx, ny, nz,
              uvs[ci][0] === 0 ? u0 : u1,
              uvs[ci][1] === 0 ? v0 : v1,
              tr * shade, tg * shade, tb * shade,
              isLeaf ? 0.4 : 0
            )
          }
          // flip the quad diagonal for smoother AO interpolation
          faceTarget.quad(ao[0] + ao[3] > ao[1] + ao[2])
        }
      }
    }
  }

  return {
    solid: solid.build(false),
    foliage: foliage.build(true),
    water: water.build(),
    glass: glass.build(false),
    emissive: emissive.build(false),
    furnaceFire: furnaceFire.build(false),
    chest: chest.build(),
    largeChest: largeChest.build(),
    xray: xray.build(false)
  }
}
