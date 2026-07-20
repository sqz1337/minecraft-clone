export type QualityName = 'low' | 'medium' | 'high' | 'ultra'
export type GameMode = 'creative' | 'survival'

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
        renderDistanceOverride: this.renderDistanceOverride,
        lastSeed: this.lastSeed,
        lastGameMode: this.lastGameMode
      }))
    } catch { /* private mode etc. */ }
  }
}
