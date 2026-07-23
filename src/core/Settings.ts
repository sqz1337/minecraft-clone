export type QualityName = 'low' | 'medium' | 'high' | 'ultra'
export type GameMode = 'creative' | 'survival'

export const CONTROL_DEFINITIONS = [
  { id: 'forward', label: 'Walk Forward', category: 'Movement', defaultKey: 'KeyW' },
  { id: 'back', label: 'Walk Backward', category: 'Movement', defaultKey: 'KeyS' },
  { id: 'left', label: 'Strafe Left', category: 'Movement', defaultKey: 'KeyA' },
  { id: 'right', label: 'Strafe Right', category: 'Movement', defaultKey: 'KeyD' },
  { id: 'jump', label: 'Jump / Fly Up', category: 'Movement', defaultKey: 'Space' },
  { id: 'sprint', label: 'Sprint', category: 'Movement', defaultKey: 'ShiftLeft' },
  { id: 'crouch', label: 'Sneak / Fly Down', category: 'Movement', defaultKey: 'ControlLeft' },
  { id: 'inventory', label: 'Open Inventory', category: 'Gameplay', defaultKey: 'KeyE' },
  { id: 'drop', label: 'Drop Item', category: 'Gameplay', defaultKey: 'KeyQ' },
  { id: 'perspective', label: 'Change Perspective', category: 'Gameplay', defaultKey: 'F5' },
  { id: 'console', label: 'Open Command', category: 'Gameplay', defaultKey: 'Slash' },
  { id: 'flashlight', label: 'Toggle Flashlight', category: 'Gameplay', defaultKey: 'KeyF' },
  { id: 'flight', label: 'Toggle Flight', category: 'Creative', defaultKey: 'KeyG' },
  { id: 'hotbarPage', label: 'Next Hotbar Page', category: 'Creative', defaultKey: 'KeyR' },
  { id: 'inspection', label: 'Inspection Mode', category: 'Creative', defaultKey: 'KeyX' },
  { id: 'admin', label: 'Admin Items', category: 'Creative', defaultKey: 'KeyO' },
  { id: 'time', label: 'Fast-forward Time', category: 'Creative', defaultKey: 'KeyT' },
  { id: 'weather', label: 'Cycle Weather', category: 'Creative', defaultKey: 'KeyY' }
] as const

export type ControlAction = typeof CONTROL_DEFINITIONS[number]['id']
export type KeyBindings = Record<ControlAction, string>

export function defaultKeyBindings(): KeyBindings {
  return Object.fromEntries(CONTROL_DEFINITIONS.map(control => [control.id, control.defaultKey])) as KeyBindings
}

export function displayKey(code: string): string {
  const names: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt',
    Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Minus: '-', Equal: '=', Backquote: '`',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
  }
  if (names[code]) return names[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`
  return code.replace(/([a-z])([A-Z])/g, '$1 $2')
}

export interface QualityPreset {
  renderDistance: number
  shadows: boolean
  shadowSize: number
  pixelRatioCap: number
  grassDensity: number   // fraction of tall grass decorations kept
  particleMult: number
}

export const QUALITIES: Record<QualityName, QualityPreset> = {
  low: { renderDistance: 4, shadows: false, shadowSize: 1024, pixelRatioCap: 1, grassDensity: 0.35, particleMult: 0.4 },
  medium: { renderDistance: 6, shadows: false, shadowSize: 2048, pixelRatioCap: 1.25, grassDensity: 0.6, particleMult: 0.7 },
  high: { renderDistance: 7, shadows: true, shadowSize: 2048, pixelRatioCap: 1.5, grassDensity: 1, particleMult: 1 },
  ultra: { renderDistance: 10, shadows: true, shadowSize: 4096, pixelRatioCap: 2, grassDensity: 1, particleMult: 1.4 }
}

const STORAGE_KEY = 'realmcraft.settings.v1'

export class Settings {
  quality: QualityName = 'high'
  volume = 0.8
  headBob = true
  fullscreen = false
  fov = 75
  mouseSensitivity = 0.5
  invertMouse = false
  keyBindings: KeyBindings = defaultKeyBindings()
  renderDistanceOverride: number | null = null
  lastSeed = ''
  lastGameMode: GameMode = 'survival'

  get preset(): QualityPreset { return QUALITIES[this.quality] }
  get renderDistance(): number { return this.renderDistanceOverride ?? this.preset.renderDistance }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw)
      if (data.quality in QUALITIES) this.quality = data.quality
      if (typeof data.volume === 'number') this.volume = data.volume
      if (typeof data.headBob === 'boolean') this.headBob = data.headBob
      if (typeof data.fullscreen === 'boolean') this.fullscreen = data.fullscreen
      if (typeof data.fov === 'number') this.fov = Math.max(55, Math.min(100, Math.round(data.fov)))
      if (typeof data.mouseSensitivity === 'number') this.mouseSensitivity = Math.max(0, Math.min(1, data.mouseSensitivity))
      if (typeof data.invertMouse === 'boolean') this.invertMouse = data.invertMouse
      if (data.keyBindings && typeof data.keyBindings === 'object') {
        for (const control of CONTROL_DEFINITIONS) {
          const value = data.keyBindings[control.id]
          if (typeof value === 'string' && value.length > 0 && value.length <= 32 && value !== 'Escape') {
            this.keyBindings[control.id] = value
          }
        }
      }
      if (typeof data.renderDistanceOverride === 'number') this.renderDistanceOverride = data.renderDistanceOverride
      if (data.renderDistanceOverride === null) this.renderDistanceOverride = null
      if (typeof data.lastSeed === 'string') this.lastSeed = data.lastSeed.slice(0, 200)
      if (data.lastGameMode === 'creative' || data.lastGameMode === 'survival') this.lastGameMode = data.lastGameMode
    } catch { /* corrupted storage — use defaults */ }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        quality: this.quality,
        volume: this.volume,
        headBob: this.headBob,
        fullscreen: this.fullscreen,
        fov: this.fov,
        mouseSensitivity: this.mouseSensitivity,
        invertMouse: this.invertMouse,
        keyBindings: this.keyBindings,
        renderDistanceOverride: this.renderDistanceOverride,
        lastSeed: this.lastSeed,
        lastGameMode: this.lastGameMode
      }))
    } catch { /* private mode etc. */ }
  }

  key(action: ControlAction): string { return this.keyBindings[action] }

  setKey(action: ControlAction, code: string): boolean {
    if (!code || code === 'Escape' || code.length > 32) return false
    this.keyBindings[action] = code
    this.save()
    return true
  }

  resetKeys(): void {
    this.keyBindings = defaultKeyBindings()
    this.save()
  }
}
