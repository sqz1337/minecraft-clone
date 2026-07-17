import { HOTBAR, NAMES, B, tileFor, CROSS } from '../world/Blocks'
import type { Atlas } from '../gfx/Atlas'
import type { Settings, QualityName } from '../core/Settings'

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id)
  if (!e) throw new Error('missing element #' + id)
  return e as T
}

export interface HudData {
  fps: number
  x: number; y: number; z: number
  biome: string
  time: string
  weather: string
  seed: string
  flying: boolean
}

export class UI {
  onEnterWorld: (seed: string, quality: QualityName) => void = () => {}
  onResume: () => void = () => {}
  onSettingsChanged: () => void = () => {}

  private title = el<HTMLDivElement>('title')
  private loading = el<HTMLDivElement>('loading')
  private loadBar = el<HTMLDivElement>('load-bar')
  private loadLabel = el<HTMLParagraphElement>('load-label')
  private clickStart = el<HTMLDivElement>('click-start')
  private pause = el<HTMLDivElement>('pause')
  private controls = el<HTMLDivElement>('controls')
  private hud = el<HTMLDivElement>('hud')
  private info = el<HTMLDivElement>('info')
  private hotbar = el<HTMLDivElement>('hotbar')
  private blockName = el<HTMLDivElement>('block-name')
  private toastEl = el<HTMLDivElement>('toast')
  private underwater = el<HTMLDivElement>('underwater-overlay')
  private settingsPanel = el<HTMLDivElement>('settings-panel')
  private slots: HTMLDivElement[] = []
  private toastTimer: number | null = null
  private blockNameTimer: number | null = null

  constructor(private settings: Settings) {
    el<HTMLButtonElement>('btn-enter').addEventListener('click', () => {
      const seed = el<HTMLInputElement>('seed-input').value.trim()
      const quality = el<HTMLSelectElement>('quality-select').value as QualityName
      this.onEnterWorld(seed, quality)
    })
    el<HTMLSelectElement>('quality-select').value = settings.quality

    el<HTMLButtonElement>('btn-title-controls').addEventListener('click', () => this.showControls(true))
    el<HTMLButtonElement>('btn-pause-controls').addEventListener('click', () => this.showControls(true))
    el<HTMLButtonElement>('btn-close-controls').addEventListener('click', () => this.showControls(false))
    el<HTMLButtonElement>('btn-resume').addEventListener('click', () => this.onResume())
    el<HTMLButtonElement>('btn-quit').addEventListener('click', () => location.reload())
    el<HTMLButtonElement>('btn-pause-settings').addEventListener('click', () => {
      this.settingsPanel.classList.toggle('hidden')
    })

    // settings bindings
    const vol = el<HTMLInputElement>('opt-volume')
    vol.value = String(settings.volume)
    vol.addEventListener('input', () => {
      settings.volume = parseFloat(vol.value)
      settings.save()
      this.onSettingsChanged()
    })
    const rd = el<HTMLInputElement>('opt-render')
    const rdVal = el<HTMLElement>('opt-render-val')
    rd.value = String(settings.renderDistance)
    rdVal.textContent = String(settings.renderDistance)
    rd.addEventListener('input', () => {
      settings.renderDistanceOverride = parseInt(rd.value, 10)
      rdVal.textContent = rd.value
      settings.save()
      this.onSettingsChanged()
    })
    const q = el<HTMLSelectElement>('opt-quality')
    q.value = settings.quality
    q.addEventListener('change', () => {
      settings.quality = q.value as QualityName
      settings.renderDistanceOverride = null
      rd.value = String(settings.renderDistance)
      rdVal.textContent = rd.value
      settings.save()
      this.onSettingsChanged()
    })
    const bob = el<HTMLInputElement>('opt-bob')
    bob.checked = settings.headBob
    bob.addEventListener('change', () => {
      settings.headBob = bob.checked
      settings.save()
      this.onSettingsChanged()
    })
  }

  buildHotbar(atlas: Atlas): void {
    this.hotbar.innerHTML = ''
    this.slots = []
    HOTBAR.forEach((id, i) => {
      const slot = document.createElement('div')
      slot.className = 'slot'
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 44
      if (CROSS[id]) {
        atlas.drawFlatIcon(canvas, tileFor(id, 0))
      } else {
        const top = tileFor(id, 2), side = tileFor(id, 0)
        const tint: [number, number, number] | undefined = id === B.GRASS ? [0.62, 0.8, 0.38] : undefined
        atlas.drawIcon(canvas, top, side, tint)
      }
      slot.appendChild(canvas)
      const num = document.createElement('span')
      num.className = 'num'
      num.textContent = String(i + 1)
      slot.appendChild(num)
      this.hotbar.appendChild(slot)
      this.slots.push(slot)
    })
    this.setSelectedSlot(0)
  }

  setSelectedSlot(i: number): void {
    this.slots.forEach((s, j) => s.classList.toggle('selected', i === j))
    this.blockName.textContent = NAMES[HOTBAR[i]]
    this.blockName.classList.add('visible')
    if (this.blockNameTimer !== null) clearTimeout(this.blockNameTimer)
    this.blockNameTimer = window.setTimeout(() => this.blockName.classList.remove('visible'), 1600)
  }

  showTitle(): void { this.swap(this.title) }
  showLoading(): void { this.swap(this.loading) }
  showClickStart(): void { this.swap(this.clickStart) }

  showGame(): void {
    this.swap(null)
    this.hud.classList.remove('hidden')
  }

  showPause(): void {
    this.pause.classList.remove('hidden')
  }

  hidePause(): void {
    this.pause.classList.add('hidden')
    this.settingsPanel.classList.add('hidden')
  }

  isPauseVisible(): boolean { return !this.pause.classList.contains('hidden') }

  private showControls(on: boolean): void {
    this.controls.classList.toggle('hidden', !on)
  }

  private swap(screen: HTMLDivElement | null): void {
    for (const s of [this.title, this.loading, this.clickStart, this.pause]) {
      s.classList.toggle('hidden', s !== screen)
    }
  }

  setLoadProgress(f: number, label: string): void {
    this.loadBar.style.width = (f * 100).toFixed(1) + '%'
    this.loadLabel.textContent = label
  }

  setUnderwater(on: boolean): void {
    this.underwater.classList.toggle('active', on)
  }

  updateHud(d: HudData): void {
    this.info.innerHTML =
      `<span class="chip">${d.fps.toFixed(0)} FPS</span>` +
      `<span class="chip">${d.biome}</span>` +
      `<span class="chip">☀ ${d.time}</span>` +
      `<span class="chip">${d.weather}</span>` +
      `<span class="chip">XYZ ${d.x.toFixed(0)} ${d.y.toFixed(0)} ${d.z.toFixed(0)}</span>` +
      `<span class="chip dim">seed ${d.seed}</span>` +
      (d.flying ? '<span class="chip fly">FLIGHT</span>' : '')
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg
    this.toastEl.classList.remove('hidden')
    this.toastEl.classList.add('visible')
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('visible')
    }, 2200)
  }
}
