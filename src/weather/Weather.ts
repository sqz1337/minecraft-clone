import { lerp, clamp } from '../util/math'
import { U } from '../gfx/Uniforms'
import type { WeatherOut } from '../gfx/Environment'
import type { AudioMan } from '../audio/Audio'

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm'

export interface WeatherState {
  kind: WeatherKind
  nextChange: number
  lightningTimer: number
  out: WeatherOut
}

const KINDS: WeatherKind[] = ['clear', 'cloudy', 'rain', 'storm']

interface Targets {
  cloudCover: number; cloudDark: number; lightMul: number; fogMul: number; precip: number; wind: number
}

const TARGETS: Record<WeatherKind, Targets> = {
  clear: { cloudCover: 0.26, cloudDark: 0, lightMul: 1, fogMul: 1, precip: 0, wind: 0.8 },
  cloudy: { cloudCover: 0.62, cloudDark: 0.3, lightMul: 0.78, fogMul: 1.25, precip: 0, wind: 1.2 },
  rain: { cloudCover: 0.85, cloudDark: 0.62, lightMul: 0.55, fogMul: 1.7, precip: 0.8, wind: 1.7 },
  storm: { cloudCover: 0.97, cloudDark: 0.88, lightMul: 0.38, fogMul: 2.1, precip: 1, wind: 2.6 }
}

export class Weather {
  kind: WeatherKind = 'clear'
  out: WeatherOut = {
    cloudCover: 0.26, cloudDark: 0, lightMul: 1, fogMul: 1, rain: 0, snow: 0, wind: 0.8, wetness: 0
  }
  private nextChange = 90 + Math.random() * 120
  private lightningTimer = 6

  cycle(): WeatherKind {
    const i = KINDS.indexOf(this.kind)
    this.kind = KINDS[(i + 1) % KINDS.length]
    this.nextChange = 90 + Math.random() * 150
    return this.kind
  }

  displayName(cold: boolean, dry = false): string {
    if (dry && (this.kind === 'rain' || this.kind === 'storm')) return 'Dry overcast'
    if (this.kind === 'rain' && cold) return 'Snow'
    if (this.kind === 'storm' && cold) return 'Blizzard'
    return this.kind.charAt(0).toUpperCase() + this.kind.slice(1)
  }

  snapshot(): WeatherState {
    return {
      kind: this.kind,
      nextChange: this.nextChange,
      lightningTimer: this.lightningTimer,
      out: { ...this.out }
    }
  }

  restore(state: WeatherState): void {
    if (!KINDS.includes(state.kind)) return
    this.kind = state.kind
    this.nextChange = clamp(Number.isFinite(state.nextChange) ? state.nextChange : 120, 1, 240)
    this.lightningTimer = clamp(Number.isFinite(state.lightningTimer) ? state.lightningTimer : 6, 0.1, 20)

    const source = state.out
    if (!source || typeof source !== 'object') return
    this.out = {
      cloudCover: clamp(Number.isFinite(source.cloudCover) ? source.cloudCover : 0.26, 0, 1),
      cloudDark: clamp(Number.isFinite(source.cloudDark) ? source.cloudDark : 0, 0, 1),
      lightMul: clamp(Number.isFinite(source.lightMul) ? source.lightMul : 1, 0.1, 1),
      fogMul: clamp(Number.isFinite(source.fogMul) ? source.fogMul : 1, 0.5, 3),
      rain: clamp(Number.isFinite(source.rain) ? source.rain : 0, 0, 1),
      snow: clamp(Number.isFinite(source.snow) ? source.snow : 0, 0, 1),
      wind: clamp(Number.isFinite(source.wind) ? source.wind : 0.8, 0, 4),
      wetness: clamp(Number.isFinite(source.wetness) ? source.wetness : 0, 0, 1)
    }
  }

  update(dt: number, cold: boolean, audio: AudioMan, dry = false, exposure = 1): void {
    this.nextChange -= dt
    if (this.nextChange <= 0) {
      // weighted random transition, biased toward clear-ish weather
      const r = Math.random()
      this.kind = r < 0.38 ? 'clear' : r < 0.66 ? 'cloudy' : r < 0.9 ? 'rain' : 'storm'
      this.nextChange = 90 + Math.random() * 150
    }

    const t = TARGETS[this.kind]
    const k = clamp(dt * 0.35, 0, 1) // slow transitions
    const o = this.out
    o.cloudCover = lerp(o.cloudCover, t.cloudCover, k)
    o.cloudDark = lerp(o.cloudDark, t.cloudDark, k)
    o.lightMul = lerp(o.lightMul, t.lightMul, k)
    o.fogMul = lerp(o.fogMul, t.fogMul, k)
    o.wind = lerp(o.wind, t.wind, k)
    const precip = lerp(o.rain + o.snow, t.precip, k)
    o.rain = dry || cold ? 0 : precip
    o.snow = dry ? 0 : cold ? precip : 0
    o.wetness = lerp(o.wetness, o.rain > 0.25 ? 1 : 0, clamp(dt * 0.12, 0, 1))

    // lightning
    if (this.kind === 'storm' && o.cloudDark > 0.6) {
      this.lightningTimer -= dt
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 4 + Math.random() * 11
        U.uFlash.value = clamp(exposure, 0, 1)
        audio.thunder(0.5 + Math.random() * 2.5, clamp(exposure, 0, 1))
      }
    }
  }
}
