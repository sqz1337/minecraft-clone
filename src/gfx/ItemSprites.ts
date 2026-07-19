import * as THREE from 'three'

const TS = 16
const GRID = 16
const SHEET = TS * GRID
const ITEMS_URL = `${import.meta.env.BASE_URL}assets/minecraft/gui/items.png`

function loadSheet(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Could not load Minecraft item sheet: ${ITEMS_URL}`))
    image.src = ITEMS_URL
  })
}

/** Classic pre-1.5 gui/items.png: icons for items that are not blocks. */
export class ItemSprites {
  canvas = document.createElement('canvas')
  texture!: THREE.CanvasTexture

  async build(): Promise<void> {
    this.canvas.width = this.canvas.height = SHEET
    const ctx = this.canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    const image = await loadSheet()
    ctx.drawImage(image, 0, 0, SHEET, SHEET)

    // Mutton has no classic sprite: paint tinted porkchop copies into unused cells.
    this.paintTintedCopy(ctx, [7, 5], [0, 9], '#d4453f')  // raw mutton — redder meat
    this.paintTintedCopy(ctx, [8, 5], [1, 9], '#b4763c')  // cooked mutton — browner roast

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
  }

  /** Copies one 16x16 cell to another with a multiplied color tint, keeping alpha. */
  private paintTintedCopy(
    ctx: CanvasRenderingContext2D,
    from: readonly [number, number],
    to: readonly [number, number],
    color: string
  ): void {
    const cell = document.createElement('canvas')
    cell.width = cell.height = TS
    const cellCtx = cell.getContext('2d')!
    cellCtx.imageSmoothingEnabled = false
    cellCtx.drawImage(this.canvas, from[0] * TS, from[1] * TS, TS, TS, 0, 0, TS, TS)
    cellCtx.globalCompositeOperation = 'multiply'
    cellCtx.fillStyle = color
    cellCtx.fillRect(0, 0, TS, TS)
    cellCtx.globalCompositeOperation = 'destination-in'
    cellCtx.drawImage(this.canvas, from[0] * TS, from[1] * TS, TS, TS, 0, 0, TS, TS)
    ctx.clearRect(to[0] * TS, to[1] * TS, TS, TS)
    ctx.drawImage(cell, to[0] * TS, to[1] * TS)
  }

  uvRect(column: number, row: number): [number, number, number, number] {
    const inset = 0.02 / SHEET
    const u0 = (column * TS) / SHEET + inset
    const u1 = ((column + 1) * TS) / SHEET - inset
    const v1 = 1 - (row * TS) / SHEET - inset
    const v0 = 1 - ((row + 1) * TS) / SHEET + inset
    return [u0, v0, u1, v1]
  }

  /** Draws the 16x16 sprite into a slot icon canvas. */
  drawIcon(target: HTMLCanvasElement, column: number, row: number): void {
    const s = target.width
    const ctx = target.getContext('2d')!
    ctx.clearRect(0, 0, s, s)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.canvas, column * TS, row * TS, TS, TS, 0, 0, s, s)
  }
}

export async function createItemSprites(): Promise<ItemSprites> {
  const sprites = new ItemSprites()
  await sprites.build()
  return sprites
}
