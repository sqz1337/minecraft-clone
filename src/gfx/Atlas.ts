import * as THREE from 'three'

const TS = 16
const GRID = 8
const ATLAS = TS * GRID
const TERRAIN_URL = `${import.meta.env.BASE_URL}assets/minecraft/terrain.png`
const CHEST_URL = `${import.meta.env.BASE_URL}assets/minecraft/item/chest.png`
const LARGE_CHEST_URL = `${import.meta.env.BASE_URL}assets/minecraft/item/largechest.png`

type SourceTile = readonly [column: number, row: number]

// Coordinates in the pre-1.5 terrain.png atlas, in the same order as TILE in Blocks.ts.
const TILE_SOURCES: readonly SourceTile[] = [
  [0, 0],   // grass top
  [3, 0],   // grass side
  [2, 0],   // dirt
  [1, 0],   // stone
  [2, 1],   // sand
  [2, 4],   // snow
  [4, 1],   // oak log side
  [5, 1],   // oak log top
  [4, 3],   // oak leaves
  [3, 1],   // gravel
  [1, 1],   // bedrock
  [4, 0],   // oak planks
  [7, 2],   // tall grass
  [13, 0],  // dandelion
  [12, 0],  // rose
  [4, 7],   // spruce log side
  [4, 8],   // spruce leaves
  [13, 12], // still water
  [5, 1],   // spruce log top (shared by the classic atlas)
  [0, 1],   // cobblestone
  [2, 2],   // coal ore
  [1, 2],   // iron ore
  [0, 2],   // gold ore
  [2, 3],   // diamond ore
  [1, 3],   // glass
  [7, 0],   // bricks
  [0, 5],   // torch
  [11, 3],  // crafting table side
  [11, 2],  // crafting table top
  [12, 3],  // crafting table front
  [13, 2],  // furnace side
  [12, 2],  // furnace front
  [10, 1],  // chest side
  [9, 1],   // chest top
  [11, 1],  // chest front
  [13, 3]   // furnace front, lit
]

const GRASS_SIDE_OVERLAY: SourceTile = [6, 2]
const CRACK_SOURCES: readonly SourceTile[] = [[0, 15], [3, 15], [6, 15], [9, 15]]

function loadImage(url: string, label: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Could not load Minecraft ${label}: ${url}`))
    image.src = url
  })
}

function configurePixelTexture(texture: THREE.Texture): void {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
}

export class Atlas {
  colorTex!: THREE.CanvasTexture
  chestTex!: THREE.Texture
  largeChestTex!: THREE.Texture
  crackTex: THREE.CanvasTexture[] = []
  canvas = document.createElement('canvas')
  tileAvg: [number, number, number][] = []

  uvRect(tile: number): [number, number, number, number] {
    const col = tile % GRID, row = Math.floor(tile / GRID)
    const inset = 0.02 / ATLAS
    const u0 = (col * TS) / ATLAS + inset
    const u1 = ((col + 1) * TS) / ATLAS - inset
    const v1 = 1 - (row * TS) / ATLAS - inset
    const v0 = 1 - ((row + 1) * TS) / ATLAS + inset
    return [u0, v0, u1, v1]
  }

  async build(): Promise<void> {
    this.canvas.width = this.canvas.height = ATLAS
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingEnabled = false

    const [terrain, chest, largeChest] = await Promise.all([
      loadImage(TERRAIN_URL, 'terrain atlas'),
      loadImage(CHEST_URL, 'chest texture'),
      loadImage(LARGE_CHEST_URL, 'large chest texture')
    ])
    this.chestTex = new THREE.Texture(chest)
    this.largeChestTex = new THREE.Texture(largeChest)
    configurePixelTexture(this.chestTex)
    configurePixelTexture(this.largeChestTex)
    this.chestTex.needsUpdate = true
    this.largeChestTex.needsUpdate = true

    for (let tile = 0; tile < TILE_SOURCES.length; tile++) {
      const source = TILE_SOURCES[tile]
      const ox = (tile % GRID) * TS, oy = Math.floor(tile / GRID) * TS

      if (tile === 1) {
        this.drawTerrainTile(ctx, terrain, source, ox, oy)
        const overlay = this.tintedTerrainTile(terrain, GRASS_SIDE_OVERLAY, '#91bd59')
        ctx.drawImage(overlay, ox, oy)
      } else if (tile === 8) {
        ctx.drawImage(this.tintedTerrainTile(terrain, source, '#5f9b45'), ox, oy)
      } else if (tile === 16) {
        ctx.drawImage(this.tintedTerrainTile(terrain, source, '#619961'), ox, oy)
      } else {
        this.drawTerrainTile(ctx, terrain, source, ox, oy)
      }
    }

    const atlasData = ctx.getImageData(0, 0, ATLAS, ATLAS).data
    for (let tile = 0; tile < TILE_SOURCES.length; tile++) {
      const ox = (tile % GRID) * TS, oy = Math.floor(tile / GRID) * TS
      let r = 0, g = 0, b = 0, n = 0
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        const i = ((oy + y) * ATLAS + ox + x) * 4
        const a = atlasData[i + 3] / 255
        if (a > 0.1) {
          r += atlasData[i] * a
          g += atlasData[i + 1] * a
          b += atlasData[i + 2] * a
          n += a
        }
      }
      this.tileAvg[tile] = n > 0 ? [r / n / 255, g / n / 255, b / n / 255] : [0.5, 0.5, 0.5]
    }

    this.colorTex = new THREE.CanvasTexture(this.canvas)
    configurePixelTexture(this.colorTex)

    for (const source of CRACK_SOURCES) {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = TS
      const crackCtx = canvas.getContext('2d')!
      crackCtx.imageSmoothingEnabled = false
      this.drawTerrainTile(crackCtx, terrain, source, 0, 0)
      const texture = new THREE.CanvasTexture(canvas)
      configurePixelTexture(texture)
      this.crackTex.push(texture)
    }
  }

  private drawTerrainTile(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    source: SourceTile,
    x: number,
    y: number
  ): void {
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight) / 16
    ctx.drawImage(
      image,
      source[0] * sourceSize,
      source[1] * sourceSize,
      sourceSize,
      sourceSize,
      x,
      y,
      TS,
      TS
    )
  }

  private tintedTerrainTile(image: HTMLImageElement, source: SourceTile, color: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = TS
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    this.drawTerrainTile(ctx, image, source, 0, 0)
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, TS, TS)
    ctx.globalCompositeOperation = 'destination-in'
    this.drawTerrainTile(ctx, image, source, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    return canvas
  }

  /** Draw a fake-isometric block icon for the hotbar. */
  drawIcon(
    target: HTMLCanvasElement,
    topTile: number,
    sideTile: number,
    tint?: [number, number, number],
    frontTile = sideTile
  ): void {
    const s = target.width
    const ctx = target.getContext('2d')!
    ctx.clearRect(0, 0, s, s)
    ctx.imageSmoothingEnabled = false
    const srcTop = { x: (topTile % GRID) * TS, y: Math.floor(topTile / GRID) * TS }
    const srcSide = { x: (sideTile % GRID) * TS, y: Math.floor(sideTile / GRID) * TS }
    const srcFront = { x: (frontTile % GRID) * TS, y: Math.floor(frontTile / GRID) * TS }
    // Keep the silhouette on integer backing-store pixels. Slot canvases are
    // rendered at the effective GUI scale, so fractional coordinates here
    // would be magnified into the muddy icons that canvas affine transforms
    // otherwise produce at 2x/3x GUI scale.
    const m = Math.max(1, Math.round(s / 16))
    const cxm = Math.round(s / 2)
    const shoulder = Math.round(s * 0.28125)
    const N: [number, number] = [cxm, m]
    const E: [number, number] = [s - m, shoulder]
    const S: [number, number] = [cxm, Math.round(s * 0.5)]
    const W: [number, number] = [m, shoulder]
    const down = Math.round(s * 0.4375)

    const drawFace = (
      src: { x: number, y: number },
      p0: [number, number], pu: [number, number], pv: [number, number],
      shade: number, faceTint?: [number, number, number]
    ) => {
      ctx.save()
      const setTransform = () => ctx.setTransform(
        (pu[0] - p0[0]) / TS, (pu[1] - p0[1]) / TS,
        (pv[0] - p0[0]) / TS, (pv[1] - p0[1]) / TS,
        p0[0], p0[1]
      )
      setTransform()
      ctx.drawImage(this.canvas, src.x, src.y, TS, TS, 0, 0, TS, TS)
      if (shade < 1 || faceTint) {
        ctx.globalCompositeOperation = 'multiply'
        const t = faceTint ?? [1, 1, 1]
        ctx.fillStyle = `rgb(${Math.round(255 * shade * t[0])},${Math.round(255 * shade * t[1])},${Math.round(255 * shade * t[2])})`
        setTransform()
        ctx.fillRect(0, 0, TS, TS)
      }
      ctx.restore()
      ctx.globalCompositeOperation = 'source-over'
    }
    drawFace(srcTop, N, E, W, 1, tint)
    drawFace(srcSide, W, S, [W[0], W[1] + down], 0.72)
    drawFace(srcFront, S, E, [S[0], S[1] + down], 0.55)
  }

  /** Draw a flat (cross-plant) icon for the hotbar. */
  drawFlatIcon(target: HTMLCanvasElement, tile: number, tint?: [number, number, number]): void {
    const s = target.width
    const ctx = target.getContext('2d')!
    ctx.clearRect(0, 0, s, s)
    ctx.imageSmoothingEnabled = false
    const sx = (tile % GRID) * TS, sy = Math.floor(tile / GRID) * TS
    ctx.drawImage(this.canvas, sx, sy, TS, TS, s * 0.08, s * 0.08, s * 0.84, s * 0.84)
    if (tint) {
      ctx.globalCompositeOperation = 'multiply'
      ctx.fillStyle = `rgb(${Math.round(255 * tint[0])},${Math.round(255 * tint[1])},${Math.round(255 * tint[2])})`
      ctx.fillRect(0, 0, s, s)
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(this.canvas, sx, sy, TS, TS, s * 0.08, s * 0.08, s * 0.84, s * 0.84)
      ctx.globalCompositeOperation = 'source-over'
    }
  }
}

export async function createAtlas(): Promise<Atlas> {
  const atlas = new Atlas()
  await atlas.build()
  return atlas
}
