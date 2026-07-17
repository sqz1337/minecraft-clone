import * as THREE from 'three'

const TS = 16
const GRID = 8
const ATLAS = TS * GRID
const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/minecraft/textures/block/`

const TILE_FILES = [
  'grass_block_top',
  'grass_block_side',
  'dirt',
  'stone',
  'sand',
  'snow',
  'oak_log',
  'oak_log_top',
  'oak_leaves',
  'gravel',
  'bedrock',
  'oak_planks',
  'short_grass',
  'dandelion',
  'poppy',
  'spruce_log',
  'spruce_leaves',
  'water_still',
  'spruce_log_top'
] as const

const CRACK_FILES = ['destroy_stage_0', 'destroy_stage_3', 'destroy_stage_6', 'destroy_stage_9'] as const

function loadImage(name: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Could not load Minecraft texture: ${name}`))
    image.src = `${ASSET_ROOT}${name}.png`
  })
}

function configurePixelTexture(texture: THREE.CanvasTexture): void {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
}

export class Atlas {
  colorTex!: THREE.CanvasTexture
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

    const names = [...new Set([...TILE_FILES, 'grass_block_side_overlay', ...CRACK_FILES])]
    const loaded = await Promise.all(names.map(async name => [name, await loadImage(name)] as const))
    const images = new Map(loaded)

    for (let tile = 0; tile < TILE_FILES.length; tile++) {
      const name = TILE_FILES[tile]
      const image = images.get(name)!
      const ox = (tile % GRID) * TS, oy = Math.floor(tile / GRID) * TS

      if (name === 'grass_block_side') {
        this.drawFrame(ctx, image, ox, oy)
        const overlay = this.tintedFrame(images.get('grass_block_side_overlay')!, '#91bd59')
        ctx.drawImage(overlay, ox, oy)
      } else if (name === 'oak_leaves') {
        ctx.drawImage(this.tintedFrame(image, '#5f9b45'), ox, oy)
      } else if (name === 'spruce_leaves') {
        ctx.drawImage(this.tintedFrame(image, '#619961'), ox, oy)
      } else if (name === 'water_still') {
        ctx.drawImage(this.tintedFrame(image, '#3f76e4'), ox, oy)
      } else {
        this.drawFrame(ctx, image, ox, oy)
      }
    }

    const atlasData = ctx.getImageData(0, 0, ATLAS, ATLAS).data
    for (let tile = 0; tile < TILE_FILES.length; tile++) {
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

    for (const name of CRACK_FILES) {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = TS
      const crackCtx = canvas.getContext('2d')!
      crackCtx.imageSmoothingEnabled = false
      this.drawFrame(crackCtx, images.get(name)!, 0, 0)
      const texture = new THREE.CanvasTexture(canvas)
      configurePixelTexture(texture)
      this.crackTex.push(texture)
    }
  }

  private drawFrame(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number): void {
    const frame = Math.min(image.naturalWidth, image.naturalHeight)
    ctx.drawImage(image, 0, 0, frame, frame, x, y, TS, TS)
  }

  private tintedFrame(image: HTMLImageElement, color: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = TS
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    this.drawFrame(ctx, image, 0, 0)
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, TS, TS)
    ctx.globalCompositeOperation = 'destination-in'
    this.drawFrame(ctx, image, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    return canvas
  }

  /** Draw a fake-isometric block icon for the hotbar. */
  drawIcon(target: HTMLCanvasElement, topTile: number, sideTile: number, tint?: [number, number, number]): void {
    const s = target.width
    const ctx = target.getContext('2d')!
    ctx.clearRect(0, 0, s, s)
    ctx.imageSmoothingEnabled = false
    const srcTop = { x: (topTile % GRID) * TS, y: Math.floor(topTile / GRID) * TS }
    const srcSide = { x: (sideTile % GRID) * TS, y: Math.floor(sideTile / GRID) * TS }
    const m = s * 0.06
    const cxm = s / 2
    const N: [number, number] = [cxm, m]
    const E: [number, number] = [s - m, s * 0.28]
    const S: [number, number] = [cxm, s * 0.5]
    const W: [number, number] = [m, s * 0.28]
    const down = s * 0.44

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
    drawFace(srcSide, S, E, [S[0], S[1] + down], 0.55)
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
