const FONT_URL = `${import.meta.env.BASE_URL}assets/minecraft/font/default.png`
const CELL = 8
const GRID = 16

function loadImage(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Could not load Minecraft font: ${FONT_URL}`))
    image.src = FONT_URL
  })
}

/** Renderer for the exact 1.2.4 bitmap font. All dimensions are logical GUI pixels. */
export class MinecraftFont {
  private widths = new Uint8Array(256)
  private tintedAtlases = new Map<string, HTMLCanvasElement>()

  private constructor(private image: HTMLImageElement) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = image.naturalWidth
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data

    for (let code = 0; code < 256; code++) {
      if (code === 32) { this.widths[code] = 4; continue }
      const ox = (code % GRID) * CELL
      const oy = Math.floor(code / GRID) * CELL
      let right = 0
      for (let x = CELL - 1; x >= 0; x--) {
        let occupied = false
        for (let y = 0; y < CELL && !occupied; y++) {
          occupied = pixels[((oy + y) * canvas.width + ox + x) * 4 + 3] > 16
        }
        if (occupied) { right = x + 1; break }
      }
      this.widths[code] = Math.max(2, right + 1)
    }
  }

  static async load(): Promise<MinecraftFont> {
    return new MinecraftFont(await loadImage())
  }

  measure(text: string): number {
    let width = 0
    for (const character of text) width += this.widths[this.code(character)]
    return Math.max(1, width)
  }

  createCanvas(text: string, color = '#ffffff', shadow = true): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    this.draw(canvas, text, color, shadow)
    return canvas
  }

  draw(canvas: HTMLCanvasElement, text: string, color = '#ffffff', shadow = true): void {
    const width = this.measure(text)
    canvas.width = width + (shadow ? 1 : 0)
    canvas.height = CELL + (shadow ? 1 : 0)
    canvas.classList.add('mc-text-canvas')
    const context = canvas.getContext('2d')!
    context.imageSmoothingEnabled = false
    if (shadow) this.drawPass(context, text, this.tinted('#3f3f3f'), 1, 1)
    this.drawPass(context, text, this.tinted(color), 0, 0)
  }

  private drawPass(context: CanvasRenderingContext2D, text: string, atlas: HTMLCanvasElement, x: number, y: number): void {
    let cursor = x
    for (const character of text) {
      const code = this.code(character)
      if (code !== 32) {
        const sx = (code % GRID) * CELL
        const sy = Math.floor(code / GRID) * CELL
        context.drawImage(atlas, sx, sy, CELL, CELL, cursor, y, CELL, CELL)
      }
      cursor += this.widths[code]
    }
  }

  private tinted(color: string): HTMLCanvasElement {
    const cached = this.tintedAtlases.get(color)
    if (cached) return cached
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = this.image.naturalWidth
    const context = canvas.getContext('2d')!
    context.imageSmoothingEnabled = false
    context.drawImage(this.image, 0, 0)
    context.globalCompositeOperation = 'source-in'
    context.fillStyle = color
    context.fillRect(0, 0, canvas.width, canvas.height)
    this.tintedAtlases.set(color, canvas)
    return canvas
  }

  private code(character: string): number {
    const code = character.charCodeAt(0)
    return code >= 0 && code <= 255 ? code : 63
  }
}
