import { clamp } from '../util/math'
import type { MobKind } from '../entities/EntityTypes'

const SOUND_ROOT = `${import.meta.env.BASE_URL}assets/minecraft/sound/`
const STEP_KINDS = ['cloth', 'grass', 'gravel', 'sand', 'snow', 'stone', 'wood'] as const
export type MobEvent = 'ambient' | 'hurt' | 'death' | 'step' | 'egg' | 'fuse'

function numberedPaths(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}.ogg`)
}

function stepPaths(kind: typeof STEP_KINDS[number]): string[] {
  return numberedPaths(`step/${kind}`, 4)
}

const MOB_SOUNDS: Record<MobKind, Record<MobEvent, readonly string[]>> = {
  pig: {
    ambient: numberedPaths('mob/pig/say', 3),
    hurt: numberedPaths('mob/pig/say', 3),
    death: ['mob/pig/death.ogg'],
    step: numberedPaths('mob/pig/step', 5),
    egg: [], fuse: []
  },
  cow: {
    ambient: numberedPaths('mob/cow/say', 4),
    hurt: numberedPaths('mob/cow/hurt', 3),
    death: numberedPaths('mob/cow/hurt', 3),
    step: numberedPaths('mob/cow/step', 4),
    egg: [], fuse: []
  },
  mooshroom: {
    ambient: numberedPaths('mob/cow/say', 4),
    hurt: numberedPaths('mob/cow/hurt', 3),
    death: numberedPaths('mob/cow/hurt', 3),
    step: numberedPaths('mob/cow/step', 4),
    egg: [], fuse: []
  },
  villager: {
    ambient: [], hurt: [], death: [], step: stepPaths('stone'), egg: [], fuse: []
  },
  sheep: {
    ambient: numberedPaths('mob/sheep/say', 3),
    hurt: numberedPaths('mob/sheep/say', 3),
    death: numberedPaths('mob/sheep/say', 3),
    step: numberedPaths('mob/sheep/step', 5),
    egg: [], fuse: []
  },
  chicken: {
    ambient: numberedPaths('mob/chicken/say', 3),
    hurt: numberedPaths('mob/chicken/hurt', 2),
    death: numberedPaths('mob/chicken/hurt', 2),
    step: [], // the chicken footstep sample is grating — silence it
    egg: ['mob/chicken/plop.ogg'], fuse: []
  },
  zombie: {
    ambient: numberedPaths('mob/zombie/say', 3), hurt: numberedPaths('mob/zombie/hurt', 2),
    death: ['mob/zombie/death.ogg'], step: stepPaths('stone'), egg: [], fuse: []
  },
  skeleton: {
    ambient: numberedPaths('mob/skeleton/say', 3), hurt: numberedPaths('mob/skeleton/hurt', 4),
    death: ['mob/skeleton/death.ogg'], step: stepPaths('stone'), egg: [], fuse: []
  },
  spider: {
    ambient: numberedPaths('mob/spider/say', 4), hurt: numberedPaths('mob/spider/say', 4),
    death: ['mob/spider/death.ogg'], step: numberedPaths('mob/spider/say', 4), egg: [], fuse: []
  },
  creeper: {
    ambient: numberedPaths('mob/creeper/say', 4), hurt: numberedPaths('mob/creeper/say', 4),
    death: ['mob/creeper/death.ogg'], step: stepPaths('stone'), egg: [], fuse: ['random/fuse.ogg']
  },
  slime: {
    ambient: numberedPaths('mob/slime/say', 5), hurt: numberedPaths('mob/slime/say', 5),
    death: numberedPaths('mob/slime/say', 5), step: numberedPaths('mob/slime/say', 5), egg: [], fuse: []
  },
  enderman: {
    ambient: numberedPaths('mob/enderman/idle', 5), hurt: numberedPaths('mob/enderman/hit', 4),
    death: ['mob/enderman/death.ogg'], step: stepPaths('stone'), egg: [], fuse: []
  }
}

const SOUND_FILES = [
  ...STEP_KINDS.flatMap(stepPaths),
  'damage/fallbig1.ogg', 'damage/fallbig2.ogg', 'damage/fallsmall.ogg',
  'damage/hurtflesh1.ogg', 'damage/hurtflesh2.ogg', 'damage/hurtflesh3.ogg',
  'liquid/splash.ogg', 'random/pop.ogg', 'random/click.ogg', 'random/break.ogg',
  'random/bow.ogg', 'random/chestopen.ogg', 'random/fuse.ogg', 'random/orb.ogg',
  ...numberedPaths('random/eat', 3), ...numberedPaths('random/explode', 4),
  'music/calm1.ogg', 'music/calm2.ogg', 'music/calm3.ogg',
  'ambient/weather/rain1.ogg', 'ambient/weather/rain2.ogg',
  'ambient/weather/rain3.ogg', 'ambient/weather/rain4.ogg',
  'ambient/weather/thunder1.ogg', 'ambient/weather/thunder2.ogg', 'ambient/weather/thunder3.ogg',
  ...Object.values(MOB_SOUNDS).flatMap(events => Object.values(events).flat())
] as const

/** Original classic Minecraft samples only; no synthesized sound fallbacks. */
export class AudioMan {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private lowpass: BiquadFilterNode | null = null
  private rainGain: GainNode | null = null
  private rainSource: AudioBufferSourceNode | null = null
  private samples = new Map<string, AudioBuffer>()
  private volume = 0.8
  private rainTarget = 0
  private musicTimer = 30 + Math.random() * 90

  get ready(): boolean { return this.ctx !== null }

  /** Must be called from a user gesture. */
  init(): void {
    if (this.ctx) return
    const ctx = new AudioContext()
    this.ctx = ctx
    this.lowpass = ctx.createBiquadFilter()
    this.lowpass.type = 'lowpass'
    this.lowpass.frequency.value = 20000
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.lowpass)
    this.lowpass.connect(ctx.destination)
    void this.loadSamples()
  }

  private async loadSamples(): Promise<void> {
    if (!this.ctx) return
    await Promise.all([...new Set(SOUND_FILES)].map(async path => {
      try {
        const response = await fetch(SOUND_ROOT + path)
        if (!response.ok) return
        const buffer = await this.ctx!.decodeAudioData(await response.arrayBuffer())
        this.samples.set(path, buffer)
      } catch { /* Missing samples stay silent instead of being synthesized. */ }
    }))
    const rain = this.samples.get('ambient/weather/rain1.ogg')
    if (rain && this.ctx && this.master && !this.rainGain) {
      const source = this.ctx.createBufferSource()
      source.buffer = this.makeSeamlessRainLoop(rain)
      source.loop = true
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(this.master)
      source.start()
      this.rainGain = gain
      this.rainSource = source
    }
  }

  /** Crossfades the sample tail into its head so the short classic clip loops without a silent seam. */
  private makeSeamlessRainLoop(source: AudioBuffer): AudioBuffer {
    if (!this.ctx || source.length < 4) return source
    const fadeFrames = Math.min(Math.floor(source.sampleRate * 0.35), Math.floor(source.length / 4))
    if (fadeFrames < 2) return source
    const outputLength = source.length - fadeFrames
    const output = this.ctx.createBuffer(source.numberOfChannels, outputLength, source.sampleRate)
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
      const input = source.getChannelData(channel)
      const data = output.getChannelData(channel)
      for (let i = 0; i < fadeFrames; i++) {
        const mix = i / (fadeFrames - 1)
        data[i] = input[source.length - fadeFrames + i] * (1 - mix) + input[i] * mix
      }
      data.set(input.subarray(fadeFrames, outputLength), fadeFrames)
    }
    return output
  }

  private sample(paths: string | readonly string[], gain: number, pitch = 1, delay = 0): boolean {
    if (!this.ctx || !this.master) return false
    const choices = typeof paths === 'string' ? [paths] : paths
    const available = choices.filter(path => this.samples.has(path))
    if (available.length === 0) return false
    const path = available[Math.floor(Math.random() * available.length)]
    const source = this.ctx.createBufferSource()
    source.buffer = this.samples.get(path)!
    source.playbackRate.value = Math.max(0.25, pitch)
    const output = this.ctx.createGain()
    output.gain.value = gain
    source.connect(output)
    output.connect(this.master)
    source.start(this.ctx.currentTime + delay)
    return true
  }

  private stepKind(category: string): typeof STEP_KINDS[number] {
    if (category === 'grass' || category === 'leaf') return 'grass'
    if (category === 'dirt') return 'gravel'
    if (category === 'sand') return 'sand'
    if (category === 'snow') return 'snow'
    if (category === 'wood') return 'wood'
    return 'stone'
  }

  setVolume(value: number): void {
    this.volume = value
    if (this.master) this.master.gain.value = value
  }

  setUnderwater(underwater: boolean): void {
    if (!this.lowpass || !this.ctx) return
    this.lowpass.frequency.setTargetAtTime(underwater ? 620 : 20000, this.ctx.currentTime, 0.1)
  }

  footstep(category: string, sprint = false): void {
    if (category === 'water') {
      this.sample('liquid/splash.ogg', sprint ? 0.16 : 0.1, 1.35 + Math.random() * 0.15)
    } else {
      this.sample(stepPaths(this.stepKind(category)), sprint ? 0.22 : 0.15, 0.9 + Math.random() * 0.2)
    }
  }

  breakBlock(category: string): void {
    this.sample(stepPaths(this.stepKind(category)), 0.52, 0.72 + Math.random() * 0.12)
  }

  mineTick(category: string): void {
    this.sample(stepPaths(this.stepKind(category)), 0.09, 0.65 + Math.random() * 0.08)
  }

  placeBlock(category: string): void {
    this.sample(stepPaths(this.stepKind(category)), 0.38, 0.78 + Math.random() * 0.08)
  }

  jump(): void {
    // Classic Minecraft has no separate jump sample.
  }

  land(hard: boolean): void {
    this.sample(hard
      ? ['damage/fallbig1.ogg', 'damage/fallbig2.ogg']
      : 'damage/fallsmall.ogg', hard ? 0.58 : 0.34, 0.95 + Math.random() * 0.08)
  }

  splash(big = true): void {
    this.sample('liquid/splash.ogg', big ? 0.55 : 0.28, big ? 0.9 : 1.2)
  }

  swimStroke(): void {
    this.sample('liquid/splash.ogg', 0.08, 1.45 + Math.random() * 0.15)
  }

  thunder(delay: number): void {
    this.sample(
      ['ambient/weather/thunder1.ogg', 'ambient/weather/thunder2.ogg', 'ambient/weather/thunder3.ogg'],
      0.8,
      0.9 + Math.random() * 0.15,
      delay
    )
  }

  hurt(): void {
    this.sample(
      ['damage/hurtflesh1.ogg', 'damage/hurtflesh2.ogg', 'damage/hurtflesh3.ogg'],
      0.62,
      0.92 + Math.random() * 0.16
    )
  }

  pickup(): void {
    this.sample('random/pop.ogg', 0.32, 1.65 + Math.random() * 0.25)
  }

  craft(): void {
    this.sample('random/click.ogg', 0.3)
  }

  toolBreak(): void {
    this.sample('random/break.ogg', 0.5, 0.95 + Math.random() * 0.1)
  }

  explosion(): void {
    this.sample(numberedPaths('random/explode', 4), 0.78, 0.9 + Math.random() * 0.12)
  }

  bowShoot(power = 1): void {
    this.sample('random/bow.ogg', 0.35 + clamp(power, 0, 1) * 0.22, 0.9 + Math.random() * 0.12)
  }

  eat(): void {
    this.sample(numberedPaths('random/eat', 3), 0.3, 0.9 + Math.random() * 0.18)
  }

  chestOpen(): void {
    this.sample('random/chestopen.ogg', 0.38, 0.96 + Math.random() * 0.08)
  }

  experience(): void {
    this.sample('random/orb.ogg', 0.28, 0.9 + Math.random() * 0.45)
  }

  mob(kind: MobKind, event: MobEvent): void {
    const gain = event === 'step' ? 0.07
      : event === 'ambient' ? 0.3
        : event === 'egg' ? 0.22
          : event === 'death' ? 0.52 : 0.42
    const pitch = 0.92 + Math.random() * 0.16
    this.sample(MOB_SOUNDS[kind][event], gain, pitch)
  }

  updateAmbience(dt: number, opts: { wind: number; rain: number; night: number; underwater: boolean; clear: boolean }): void {
    this.rainTarget = opts.underwater ? 0 : opts.rain * 0.2
    if (!this.rainGain) return
    const rain = this.rainGain.gain
    rain.value += (this.rainTarget - rain.value) * clamp(dt * 1.5, 0, 1)
    this.musicTimer -= dt
    if (this.musicTimer <= 0) {
      this.sample(['music/calm1.ogg', 'music/calm2.ogg', 'music/calm3.ogg'], 0.22)
      this.musicTimer = 180 + Math.random() * 360
    }
  }
}
