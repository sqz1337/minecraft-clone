import { HOTBAR, B, tileFor, CROSS, RENDER_SHAPE } from '../world/Blocks'
import { ITEMS, durabilityForItem, itemName } from '../world/Items'
import { FURNACE_SMELT_SECONDS, RECIPES, Recipe, recipeIngredients } from '../world/Recipes'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import { CONTROL_DEFINITIONS, displayKey, type Settings, type QualityName, type GameMode, type ControlAction } from '../core/Settings'
import type { Inventory, ItemStack } from '../player/Inventory'
import type { Crafting, CursorHolder } from '../player/Crafting'
import type { FurnaceState } from '../world/Containers'
import type { MinecraftFont } from './MinecraftFont'
import type { Equipment } from '../player/Equipment'
import { stackDisplayName, type EnchantingState } from '../player/Enchantments'
import { VILLAGER_TRADES } from '../entities/Trades'
import type { VillagerProfession } from '../entities/EntityTypes'
import { WorldLibrary, type WorldSummary } from '../core/WorldSave'
import { el, HudData, SlotButton, SlotHandler, UIScreen } from './UIShared'
import type { UI } from './UI'

type UIConstructor = { prototype: UI }

export function installUIHud(UIClass: UIConstructor): void {
  const prototype = UIClass.prototype
  prototype.setLoadProgress = function(this: UI, fraction: number, label: string): void {
    this.loadProgress = Math.max(0, Math.min(1, fraction))
    this.loadLabel.textContent = label
    this.loadPercent.textContent = `${Math.round(this.loadProgress * 100)}%`
    const tips = [
      'Exploring the seed...', 'Raising mountains...', 'Carving rivers and caves...',
      'Growing forests...', 'Finding a safe place to wake up...'
    ]
    this.loadTip.textContent = tips[Math.min(tips.length - 1, Math.floor(this.loadProgress * tips.length))]
  }
  prototype.drawLoading = function(this: UI, time: number): void {
    if (this.loading.classList.contains('hidden')) {
      this.loadAnimationFrame = null
      return
    }
    const canvas = this.loadCanvas
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const width = canvas.width
    const height = canvas.height
    const sky = ctx.createLinearGradient(0, 0, 0, height)
    sky.addColorStop(0, '#10192c'); sky.addColorStop(0.56, '#355171'); sky.addColorStop(1, '#c28b5a')
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(255,226,165,.82)'
    ctx.beginPath(); ctx.arc(width * .76, 78, 28, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = 'rgba(14,25,42,.45)'
    ctx.beginPath(); ctx.moveTo(0, 210); ctx.lineTo(90, 122); ctx.lineTo(160, 200); ctx.lineTo(245, 112); ctx.lineTo(335, 206); ctx.lineTo(430, 130); ctx.lineTo(width, 216); ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.fill()

    const tileW = 38
    const tileH = 19
    const originX = width / 2
    const originY = 145
    const revealRadius = 1.2 + this.loadProgress * 9.2
    const tiles: Array<{ x: number; z: number }> = []
    for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) tiles.push({ x, z })
    tiles.sort((a, b) => (a.x + a.z) - (b.x + b.z))
    for (const tile of tiles) {
      const distance = Math.hypot(tile.x, tile.z)
      const shimmer = Math.sin(time * .002 + tile.x * 1.9 + tile.z * 1.2) * .18
      if (distance > revealRadius + shimmer) continue
      const noise = Math.sin(tile.x * 1.37 + tile.z * .71) + Math.cos(tile.z * 1.11 - tile.x * .53)
      const level = Math.max(0, Math.min(4, Math.floor(2 + noise * .9)))
      const sx = originX + (tile.x - tile.z) * tileW / 2
      const sy = originY + (tile.x + tile.z) * tileH / 2 - level * 8
      const water = level === 0
      const top = water ? '#477d9a' : level >= 3 ? '#79a956' : '#8bbd61'
      ctx.globalAlpha = Math.min(1, (revealRadius + .65 - distance) * 1.4)
      ctx.fillStyle = top
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + tileW / 2, sy + tileH / 2); ctx.lineTo(sx, sy + tileH); ctx.lineTo(sx - tileW / 2, sy + tileH / 2); ctx.closePath(); ctx.fill()
      ctx.fillStyle = water ? '#315b78' : '#5f7043'
      ctx.beginPath(); ctx.moveTo(sx - tileW / 2, sy + tileH / 2); ctx.lineTo(sx, sy + tileH); ctx.lineTo(sx, sy + tileH + 13); ctx.lineTo(sx - tileW / 2, sy + tileH / 2 + 13); ctx.closePath(); ctx.fill()
      ctx.fillStyle = water ? '#274d68' : '#4b5739'
      ctx.beginPath(); ctx.moveTo(sx, sy + tileH); ctx.lineTo(sx + tileW / 2, sy + tileH / 2); ctx.lineTo(sx + tileW / 2, sy + tileH / 2 + 13); ctx.lineTo(sx, sy + tileH + 13); ctx.closePath(); ctx.fill()
    }
    ctx.globalAlpha = 1
    this.loadAnimationFrame = requestAnimationFrame(next => this.drawLoading(next))
  }
  prototype.setUnderwater = function(this: UI, on: boolean): void { this.underwater.classList.toggle('active', on) }
  prototype.showDamage = function(this: UI): void {
    this.damageOverlay.classList.remove('hit')
    this.survivalStats.classList.remove('hurt')
    void this.damageOverlay.offsetWidth
    this.damageOverlay.classList.add('hit')
    this.survivalStats.classList.add('hurt')
    window.setTimeout(() => this.survivalStats.classList.remove('hurt'), 700)
  }
  prototype.updateHud = function(this: UI, data: HudData): void {
    const lines = [
      `Realmcraft 1.2.4 style (${data.fps.toFixed(0)} fps)`,
      `XYZ: ${data.x.toFixed(1)} / ${data.y.toFixed(1)} / ${data.z.toFixed(1)}`,
      `${data.biome}  ${data.time}  ${data.weather}`,
      `Seed: ${data.seed}`
    ]
    if (data.flying) lines.push('Flight enabled')
    if (data.noclip) lines.push('Xray noclip enabled')
    this.info.replaceChildren(...lines.map(line => this.font.createCanvas(line)))
  }
  prototype.showMap = function(this: UI, pixels: Uint8ClampedArray, size: number, centerX: number, centerZ: number, spawnX: number, spawnY: number): void {
    this.mapCanvas.width = this.mapCanvas.height = size
    const ctx = this.mapCanvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.putImageData(new ImageData(pixels, size, size), 0, 0)
    if (spawnX >= 0 && spawnY >= 0 && spawnX < size && spawnY < size) {
      ctx.fillStyle = '#d72b2b'
      ctx.fillRect(spawnX - 1, spawnY - 1, 3, 3)
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(Math.floor(size / 2), Math.floor(size / 2) - 2, 1, 5)
    ctx.fillRect(Math.floor(size / 2) - 2, Math.floor(size / 2), 5, 1)
    this.mapCaption.replaceChildren(this.font.createCanvas(`Map center: ${centerX}, ${centerZ}`))
    this.mapOverlay.classList.remove('hidden')
    if (this.mapTimer !== null) clearTimeout(this.mapTimer)
    this.mapTimer = window.setTimeout(() => this.mapOverlay.classList.add('hidden'), 4200)
  }
  prototype.toast = function(this: UI, message: string): void {
    this.toastEl.replaceChildren(this.font.createCanvas(message))
    this.toastEl.classList.remove('hidden')
    this.toastEl.classList.add('visible')
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('visible'), 2200)
  }
  prototype.openConsole = function(this: UI, prefill = '/'): void {
    this.consoleEl.classList.remove('hidden')
    this.consoleInput.value = prefill
    this.consoleInput.focus()
    const end = this.consoleInput.value.length
    this.consoleInput.setSelectionRange(end, end)
  }
  prototype.hideConsole = function(this: UI): void {
    this.consoleEl.classList.add('hidden')
    this.consoleInput.value = ''
    this.consoleInput.blur()
  }
  prototype.consolePrint = function(this: UI, message: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
    const line = document.createElement('div')
    line.className = 'line' + (kind === 'info' ? '' : ' ' + kind)
    line.textContent = message
    this.consoleLogEl.append(line)
    while (this.consoleLogEl.childElementCount > 40) this.consoleLogEl.firstElementChild!.remove()
    this.consoleLogEl.scrollTop = this.consoleLogEl.scrollHeight
  }
}
