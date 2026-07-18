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

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
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
