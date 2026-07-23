import { clamp } from '../util/math'
import { HOSTILE_KINDS, type MobKind } from '../entities/EntityTypes'

const SOUND_ROOT = `${import.meta.env.BASE_URL}assets/minecraft/sound/`
const REALMCRAFT_MUSIC_ROOT = `${import.meta.env.BASE_URL}assets/realmcraft/music/silent-hill/`
export const SILENT_HILL_TRACKS = [
  'silent_hill/music1.mp3', 'silent_hill/music2.mp3',
  'silent_hill/music3.mp3', 'silent_hill/music4.mp3'
] as const
const STEP_KINDS = ['cloth', 'grass', 'gravel', 'sand', 'snow', 'stone', 'wood'] as const
export type MobEvent = 'ambient' | 'hurt' | 'death' | 'step' | 'egg' | 'fuse'
export interface SoundPosition { x: number; y: number; z: number }
type SoundCategory = 'block' | 'mob' | 'player' | 'weather' | 'music' | 'effects'
type OcclusionProbe = (listener: SoundPosition, source: SoundPosition) => boolean
const HOSTILE_SOUND_KINDS = new Set<MobKind>(HOSTILE_KINDS)

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
  wolf: {
    ambient: numberedPaths('mob/wolf/bark', 3), hurt: numberedPaths('mob/wolf/hurt', 3),
    death: ['mob/wolf/death.ogg'], step: stepPaths('grass'), egg: [], fuse: []
  },
  ocelot: {
    ambient: numberedPaths('mob/cat/meow', 4), hurt: numberedPaths('mob/cat/hitt', 3),
    death: numberedPaths('mob/cat/hitt', 3), step: stepPaths('grass'), egg: [], fuse: []
  },
  cat: {
    ambient: [...numberedPaths('mob/cat/meow', 4), ...numberedPaths('mob/cat/purr', 3)],
    hurt: numberedPaths('mob/cat/hitt', 3), death: numberedPaths('mob/cat/hitt', 3),
    step: stepPaths('grass'), egg: [], fuse: []
  },
  squid: { ambient: [], hurt: ['liquid/splash.ogg'], death: ['liquid/splash.ogg'], step: [], egg: [], fuse: [] },
  snow_golem: { ambient: [], hurt: stepPaths('snow'), death: stepPaths('snow'), step: stepPaths('snow'), egg: [], fuse: [] },
  iron_golem: {
    ambient: [], hurt: numberedPaths('mob/irongolem/hit', 4), death: ['mob/irongolem/death.ogg'],
    step: numberedPaths('mob/irongolem/walk', 4), egg: [], fuse: []
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
  },
  silverfish: {
    // This asset pack predates dedicated silverfish samples. Keep it quiet at
    // rest and reuse the unobtrusive stone set for contact/death feedback.
    ambient: [], hurt: stepPaths('stone'), death: stepPaths('stone'),
    step: stepPaths('stone'), egg: [], fuse: []
  }
}

const SOUND_FILES = [
  ...STEP_KINDS.flatMap(stepPaths),
  'damage/fallbig1.ogg', 'damage/fallbig2.ogg', 'damage/fallsmall.ogg',
  'damage/hurtflesh1.ogg', 'damage/hurtflesh2.ogg', 'damage/hurtflesh3.ogg',
  'liquid/splash.ogg', 'random/pop.ogg', 'random/click.ogg', 'random/break.ogg', 'random/burp.ogg',
  'random/door_open.ogg', 'random/door_close.ogg',
  'mob/enderman/portal.ogg', 'mob/enderman/portal2.ogg', 'mob/irongolem/throw.ogg',
  'random/bow.ogg', 'random/chestopen.ogg', 'random/fuse.ogg', 'random/orb.ogg',
  ...numberedPaths('random/eat', 3), ...numberedPaths('random/explode', 4),
  'music/calm1.ogg', 'music/calm2.ogg', 'music/calm3.ogg',
  ...SILENT_HILL_TRACKS,
  'ambient/weather/rain1.ogg', 'ambient/weather/rain2.ogg',
  'ambient/weather/rain3.ogg', 'ambient/weather/rain4.ogg',
  'ambient/weather/thunder1.ogg', 'ambient/weather/thunder2.ogg', 'ambient/weather/thunder3.ogg',
  ...Object.values(MOB_SOUNDS).flatMap(events => Object.values(events).flat())
] as const

/** Original classic Minecraft samples only; no synthesized sound fallbacks. */
export class AudioMan {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private buses = new Map<SoundCategory, GainNode>()
  private lowpass: BiquadFilterNode | null = null
  private rainGain: GainNode | null = null
  private rainSource: AudioBufferSourceNode | null = null
  private calmSource: AudioBufferSourceNode | null = null
  private samples = new Map<string, AudioBuffer>()
  private soundVolume = 0.8
  private musicVolume = 0.8
  private rainTarget = 0
  private musicTimer = 30 + Math.random() * 90
  private menuMusic = false
  private uiClickAudio: HTMLAudioElement | null = null
  private silentHillMode = false
  private silentHillSource: AudioBufferSourceNode | null = null
  private silentHillTrackIndex = Math.floor(Math.random() * SILENT_HILL_TRACKS.length)
  private silentHillGap = 0
  private listenerPosition: SoundPosition = { x: 0, y: 0, z: 0 }
  private occlusionProbe: OcclusionProbe | null = null

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
    this.master.gain.value = 1
    for (const category of ['block', 'mob', 'player', 'weather', 'music', 'effects'] as const) {
      const bus = ctx.createGain()
      bus.gain.value = category === 'music' ? this.musicVolume : this.soundVolume
      bus.connect(this.master)
      this.buses.set(category, bus)
    }
    this.master.connect(this.lowpass)
    this.lowpass.connect(ctx.destination)
    void this.loadSamples()
  }

  private async loadSamples(): Promise<void> {
    if (!this.ctx) return
    await Promise.all([...new Set(SOUND_FILES)].map(async path => {
      try {
        const url = path.startsWith('silent_hill/')
          ? REALMCRAFT_MUSIC_ROOT + path.slice('silent_hill/'.length)
          : SOUND_ROOT + path
        const response = await fetch(url)
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
      gain.connect(this.buses.get('weather') ?? this.master)
      source.start()
      this.rainGain = gain
      this.rainSource = source
    }
    if (this.silentHillMode) this.startSilentHillMusic()
  }

  /** Enables the per-world alternate soundtrack and suppresses random calm tracks. */
  setSilentHillMode(enabled: boolean): void {
    this.silentHillMode = enabled
    this.musicTimer = 30 + Math.random() * 90
    if (enabled) this.stopCalmMusic()
    if (!enabled) {
      const source = this.silentHillSource
      this.silentHillSource = null
      if (source) {
        source.onended = null
        try { source.stop() } catch { /* it may have ended between frames */ }
      }
      return
    }
    this.silentHillGap = 0
    this.startSilentHillMusic()
  }

  private startSilentHillMusic(): void {
    if (!this.silentHillMode || !this.ctx || !this.master || this.silentHillSource) return
    const available = SILENT_HILL_TRACKS.filter(path => this.samples.has(path))
    if (available.length === 0) return
    const path = available[this.silentHillTrackIndex % available.length]
    this.silentHillTrackIndex = (this.silentHillTrackIndex + 1) % available.length
    const source = this.ctx.createBufferSource()
    source.buffer = this.samples.get(path)!
    const gain = this.ctx.createGain()
    gain.gain.value = 0.28
    source.connect(gain)
    gain.connect(this.buses.get('music') ?? this.master)
    this.silentHillSource = source
    source.onended = () => {
      if (this.silentHillSource !== source) return
      this.silentHillSource = null
      this.silentHillGap = 1.5
    }
    source.start()
  }

  private stopCalmMusic(): void {
    const source = this.calmSource
    this.calmSource = null
    if (!source) return
    source.onended = null
    try { source.stop() } catch { /* it may have ended between frames */ }
  }

  private startCalmMusic(): boolean {
    if (!this.ctx || !this.master || this.calmSource || this.silentHillMode) return false
    const tracks = ['music/calm1.ogg', 'music/calm2.ogg', 'music/calm3.ogg'] as const
    const available = tracks.filter(path => this.samples.has(path))
    if (available.length === 0) return false
    const source = this.ctx.createBufferSource()
    source.buffer = this.samples.get(available[Math.floor(Math.random() * available.length)])!
    const gain = this.ctx.createGain()
    gain.gain.value = 0.22
    source.connect(gain)
    gain.connect(this.buses.get('music') ?? this.master)
    this.calmSource = source
    source.onended = () => {
      if (this.calmSource !== source) return
      this.calmSource = null
      this.musicTimer = this.menuMusic ? 8 + Math.random() * 18 : 180 + Math.random() * 360
    }
    source.start()
    return true
  }

  /** Keeps the classic calm soundtrack alive on the title screen after the first user gesture. */
  updateMenuMusic(dt: number, active: boolean): void {
    if (active !== this.menuMusic) {
      this.menuMusic = active
      if (active) this.musicTimer = 0
    }
    if (!active || this.silentHillMode || this.calmSource) return
    this.musicTimer -= dt
    if (this.musicTimer <= 0) this.startCalmMusic()
  }

  /**
   * Crossfades the sample tail into its head so the short classic clip loops
   * without a seam. Rain is essentially decorrelated noise, so a linear
   * crossfade drops ~3 dB of power at its midpoint (the two halves add in power,
   * not amplitude) — which is audible as the rain briefly dipping every loop.
   * An equal-power (cos/sin) crossfade keeps loudness constant across the seam.
   */
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
        const fadeOut = Math.cos(mix * Math.PI * 0.5)
        const fadeIn = Math.sin(mix * Math.PI * 0.5)
        data[i] = input[source.length - fadeFrames + i] * fadeOut + input[i] * fadeIn
      }
      data.set(input.subarray(fadeFrames, outputLength), fadeFrames)
    }
    return output
  }

  private sample(
    paths: string | readonly string[],
    gain: number,
    pitch = 1,
    delay = 0,
    position?: SoundPosition,
    category: SoundCategory = 'effects'
  ): boolean {
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
    const destination = this.buses.get(category) ?? this.master
    if (position) {
      const panner = this.ctx.createPanner()
      panner.panningModel = 'HRTF'
      panner.distanceModel = 'inverse'
      panner.refDistance = 1.5
      panner.maxDistance = category === 'weather' ? 128 : 48
      panner.rolloffFactor = category === 'mob' ? 1.15 : 1
      panner.positionX.value = position.x
      panner.positionY.value = position.y
      panner.positionZ.value = position.z
      if (this.occlusionProbe?.(this.listenerPosition, position)) {
        // A wall does not make a sound vanish: it removes high frequencies and
        // some direct energy, closely matching Minecraft's readable muffling.
        const obstruction = this.ctx.createBiquadFilter()
        obstruction.type = 'lowpass'
        obstruction.frequency.value = 950
        obstruction.Q.value = 0.7
        output.gain.value *= 0.58
        output.connect(obstruction)
        obstruction.connect(panner)
      } else {
        output.connect(panner)
      }
      panner.connect(destination)
    } else {
      output.connect(destination)
    }
    source.start(this.ctx.currentTime + delay)
    return true
  }

  /** Updates the WebAudio listener from the actual render camera once per frame. */
  updateListener(position: SoundPosition, forward: SoundPosition, up: SoundPosition = { x: 0, y: 1, z: 0 }): void {
    this.listenerPosition = { ...position }
    if (!this.ctx) return
    const listener = this.ctx.listener
    listener.positionX.value = position.x
    listener.positionY.value = position.y
    listener.positionZ.value = position.z
    listener.forwardX.value = forward.x
    listener.forwardY.value = forward.y
    listener.forwardZ.value = forward.z
    listener.upX.value = up.x
    listener.upY.value = up.y
    listener.upZ.value = up.z
  }

  /** Supplies a cheap world ray test used only when a positional sound starts. */
  setOcclusionProbe(probe: OcclusionProbe | null): void {
    this.occlusionProbe = probe
  }

  private stepKind(category: string): typeof STEP_KINDS[number] {
    if (category === 'grass' || category === 'leaf') return 'grass'
    if (category === 'dirt') return 'gravel'
    if (category === 'sand') return 'sand'
    if (category === 'snow') return 'snow'
    if (category === 'wood') return 'wood'
    return 'stone'
  }

  setVolumes(sound: number, music: number): void {
    this.soundVolume = clamp(sound, 0, 1)
    this.musicVolume = clamp(music, 0, 1)
    for (const [category, bus] of this.buses) {
      bus.gain.value = category === 'music' ? this.musicVolume : this.soundVolume
    }
  }

  setUnderwater(underwater: boolean): void {
    if (!this.lowpass || !this.ctx) return
    this.lowpass.frequency.setTargetAtTime(underwater ? 620 : 20000, this.ctx.currentTime, 0.1)
  }

  footstep(category: string, sprint = false): void {
    if (category === 'water') {
      this.sample('liquid/splash.ogg', sprint ? 0.16 : 0.1, 1.35 + Math.random() * 0.15, 0, undefined, 'player')
    } else {
      this.sample(stepPaths(this.stepKind(category)), sprint ? 0.22 : 0.15, 0.9 + Math.random() * 0.2, 0, undefined, 'player')
    }
  }

  breakBlock(category: string): void {
    this.sample(stepPaths(this.stepKind(category)), 0.52, 0.72 + Math.random() * 0.12, 0, undefined, 'block')
  }

  mineTick(category: string): void {
    this.sample(stepPaths(this.stepKind(category)), 0.09, 0.65 + Math.random() * 0.08, 0, undefined, 'block')
  }

  placeBlock(category: string): void {
    this.sample(stepPaths(this.stepKind(category)), 0.38, 0.78 + Math.random() * 0.08, 0, undefined, 'block')
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
    this.sample('liquid/splash.ogg', big ? 0.55 : 0.28, big ? 0.9 : 1.2, 0, undefined, 'effects')
  }

  swimStroke(): void {
    this.sample('liquid/splash.ogg', 0.08, 1.45 + Math.random() * 0.15)
  }

  thunder(delay: number): void {
    this.sample(
      ['ambient/weather/thunder1.ogg', 'ambient/weather/thunder2.ogg', 'ambient/weather/thunder3.ogg'],
      0.8,
      0.9 + Math.random() * 0.15,
      delay,
      undefined,
      'weather'
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

  /** Uses the original click sample and an HTML-audio fallback while WebAudio is still loading. */
  uiClick(): void {
    if (this.sample('random/click.ogg', 0.3)) return
    if (typeof Audio === 'undefined') return
    if (!this.uiClickAudio) {
      this.uiClickAudio = new Audio(SOUND_ROOT + 'random/click.ogg')
      this.uiClickAudio.preload = 'auto'
    }
    this.uiClickAudio.volume = clamp(this.soundVolume * 0.38, 0, 1)
    this.uiClickAudio.currentTime = 0
    void this.uiClickAudio.play().catch(() => {})
  }

  toolBreak(): void {
    this.sample('random/break.ogg', 0.5, 0.95 + Math.random() * 0.1)
  }

  explosion(position?: SoundPosition): void {
    this.sample(numberedPaths('random/explode', 4), 0.78, 0.9 + Math.random() * 0.12, 0, position, 'effects')
  }

  bowShoot(power = 1): void {
    this.sample('random/bow.ogg', 0.35 + clamp(power, 0, 1) * 0.22, 0.9 + Math.random() * 0.12)
  }

  mobBowShoot(position: SoundPosition): void {
    // EntityAIArrowAttack: volume 1.0, pitch 1 / (random * 0.4 + 0.8).
    this.sample('random/bow.ogg', 1, 1 / (Math.random() * 0.4 + 0.8), 0, position, 'mob')
  }

  eat(): void {
    this.sample(numberedPaths('random/eat', 3), 0.5 + Math.random() * 0.5, 0.8 + Math.random() * 0.4)
  }

  burp(): void {
    this.sample('random/burp.ogg', 0.5, 0.9 + Math.random() * 0.1)
  }

  chestOpen(): void {
    this.sample('random/chestopen.ogg', 0.38, 0.96 + Math.random() * 0.08, 0, undefined, 'block')
  }

  door(open: boolean): void {
    this.sample(`random/door_${open ? 'open' : 'close'}.ogg`, 0.45, 0.9 + Math.random() * 0.1, 0, undefined, 'block')
  }

  endermanTeleport(position: SoundPosition): void {
    this.sample(['mob/enderman/portal.ogg', 'mob/enderman/portal2.ogg'], 0.68, 0.96 + Math.random() * 0.08,
      0, position, 'mob')
  }

  ironGolemAttack(): void {
    this.sample('mob/irongolem/throw.ogg', 0.58, 0.95 + Math.random() * 0.1, 0, undefined, 'mob')
  }

  experience(): void {
    this.sample('random/orb.ogg', 0.28, 0.9 + Math.random() * 0.45)
  }

  mob(kind: MobKind, event: MobEvent, volume = 1, position?: SoundPosition): void {
    const gain = event === 'step' ? 0.07
      : event === 'ambient' ? 0.3
        : event === 'egg' ? 0.22
          : event === 'death' ? 0.52 : 0.42
    const scaled = gain * Math.max(0, Math.min(1, volume))
    if (scaled <= 0.001) return
    const pitch = 0.92 + Math.random() * 0.16
    const spatialPosition = HOSTILE_SOUND_KINDS.has(kind) ? position : undefined
    this.sample(MOB_SOUNDS[kind][event], scaled, pitch, 0, spatialPosition, 'mob')
  }

  updateAmbience(dt: number, opts: { wind: number; rain: number; night: number; underwater: boolean; clear: boolean }): void {
    this.rainTarget = opts.underwater ? 0 : opts.rain * 0.2
    if (this.rainGain) {
      const rain = this.rainGain.gain
      rain.value += (this.rainTarget - rain.value) * clamp(dt * 1.5, 0, 1)
    }
    if (this.silentHillMode) {
      this.silentHillGap = Math.max(0, this.silentHillGap - dt)
      if (this.silentHillGap === 0) this.startSilentHillMusic()
      return
    }
    this.menuMusic = false
    if (this.calmSource) return
    this.musicTimer -= dt
    if (this.musicTimer <= 0) this.startCalmMusic()
  }
}
