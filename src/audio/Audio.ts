import { clamp } from '../util/math'

/**
 * Fully synthesized audio: footsteps, block break/place, wind, rain,
 * thunder, birds, splashes. No audio assets required.
 * Everything routes through master gain -> underwater lowpass -> destination.
 */
export class AudioMan {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private lowpass: BiquadFilterNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private windGain: GainNode | null = null
  private rainGain: GainNode | null = null
  private volume = 0.8
  private birdTimer = 3
  private windTarget = 0.1
  private rainTarget = 0

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

    // 2 seconds of white noise, reused by every noise-based sound
    const len = ctx.sampleRate * 2
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.noiseBuf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1

    // looping wind
    this.windGain = this.makeLoop(400, 0.08)
    // looping rain (brighter noise)
    this.rainGain = this.makeLoop(5200, 0, 900)
  }

  private makeLoop(freq: number, gain: number, highpass = 0): GainNode {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = freq
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(filter)
    let tail: AudioNode = filter
    if (highpass > 0) {
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = highpass
      filter.connect(hp)
      tail = hp
    }
    tail.connect(g)
    g.connect(this.master!)
    src.start()
    return g
  }

  setVolume(v: number): void {
    this.volume = v
    if (this.master) this.master.gain.value = v
  }

  setUnderwater(under: boolean): void {
    if (!this.lowpass || !this.ctx) return
    this.lowpass.frequency.setTargetAtTime(under ? 620 : 20000, this.ctx.currentTime, 0.1)
  }

  /** Filtered noise burst — the workhorse for impacts and steps. */
  private burst(opts: {
    dur: number; gain: number; type?: BiquadFilterType; freq: number; q?: number
    attack?: number; freqEnd?: number; delay?: number
  }): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + (opts.delay ?? 0)
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    src.playbackRate.value = 0.9 + Math.random() * 0.2
    const f = ctx.createBiquadFilter()
    f.type = opts.type ?? 'lowpass'
    f.frequency.setValueAtTime(opts.freq, t0)
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.freqEnd), t0 + opts.dur)
    f.Q.value = opts.q ?? 0.8
    const g = ctx.createGain()
    const attack = opts.attack ?? 0.004
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(opts.gain, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur)
    src.connect(f); f.connect(g); g.connect(this.master)
    src.start(t0, Math.random())
    src.stop(t0 + opts.dur + 0.05)
  }

  private thump(freq: number, gain: number, dur = 0.09, delay = 0): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + delay
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(freq, t0)
    o.frequency.exponentialRampToValueAtTime(Math.max(24, freq * 0.5), t0 + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t0)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    o.connect(g); g.connect(this.master)
    o.start(t0)
    o.stop(t0 + dur + 0.02)
  }

  footstep(cat: string, sprint = false): void {
    const v = (sprint ? 0.16 : 0.11) * (0.85 + Math.random() * 0.3)
    switch (cat) {
      case 'grass':
      case 'leaf':
        this.burst({ dur: 0.09, gain: v, freq: 700, freqEnd: 250 }); break
      case 'dirt':
        this.burst({ dur: 0.1, gain: v, freq: 420, freqEnd: 180 }); break
      case 'sand':
        this.burst({ dur: 0.14, gain: v * 0.9, type: 'bandpass', freq: 1400, q: 0.5 }); break
      case 'snow':
        this.burst({ dur: 0.07, gain: v, freq: 500, freqEnd: 240 })
        this.burst({ dur: 0.06, gain: v * 0.6, freq: 380, delay: 0.035 }); break
      case 'wood':
        this.thump(140, v * 1.1, 0.07)
        this.burst({ dur: 0.05, gain: v * 0.5, freq: 900 }); break
      case 'water':
        this.burst({ dur: 0.16, gain: v, type: 'bandpass', freq: 1100, q: 1.4, freqEnd: 500 }); break
      default:
        this.burst({ dur: 0.07, gain: v * 0.9, type: 'bandpass', freq: 1600, q: 1.2, freqEnd: 700 })
    }
  }

  breakBlock(cat: string): void {
    switch (cat) {
      case 'stone':
        this.burst({ dur: 0.22, gain: 0.32, type: 'bandpass', freq: 1300, q: 0.7, freqEnd: 300 })
        this.thump(90, 0.22, 0.1); break
      case 'wood':
        this.thump(110, 0.32, 0.12)
        this.burst({ dur: 0.18, gain: 0.2, freq: 800, freqEnd: 200 }); break
      case 'sand':
      case 'snow':
        this.burst({ dur: 0.24, gain: 0.28, freq: 1000, freqEnd: 260 }); break
      case 'leaf':
        this.burst({ dur: 0.16, gain: 0.22, type: 'highpass', freq: 900 }); break
      default:
        this.burst({ dur: 0.2, gain: 0.3, freq: 700, freqEnd: 200 })
        this.thump(70, 0.16, 0.09)
    }
  }

  /** Crunchy tick while mining. */
  mineTick(cat: string): void {
    const freq = cat === 'stone' ? 1800 : cat === 'wood' ? 1000 : 800
    this.burst({ dur: 0.045, gain: 0.09, type: 'bandpass', freq, q: 1.6 })
  }

  placeBlock(cat: string): void {
    this.thump(cat === 'stone' ? 120 : 150, 0.24, 0.07)
    this.burst({ dur: 0.07, gain: 0.14, freq: 1000, freqEnd: 400 })
  }

  jump(): void {
    this.burst({ dur: 0.06, gain: 0.05, freq: 500, freqEnd: 900 })
  }

  land(hard: boolean): void {
    this.thump(hard ? 70 : 100, hard ? 0.3 : 0.14, hard ? 0.14 : 0.08)
    this.burst({ dur: 0.08, gain: hard ? 0.16 : 0.08, freq: 500, freqEnd: 200 })
  }

  splash(big = true): void {
    this.burst({ dur: big ? 0.5 : 0.25, gain: big ? 0.34 : 0.18, type: 'bandpass', freq: 900, q: 0.6, freqEnd: 2600, attack: 0.02 })
  }

  swimStroke(): void {
    this.burst({ dur: 0.22, gain: 0.08, type: 'bandpass', freq: 700, q: 1, freqEnd: 1400, attack: 0.05 })
  }

  thunder(delay: number): void {
    if (!this.ctx || !this.master) return
    const dist = clamp(delay / 3, 0.15, 1)
    this.burst({ dur: 2.6, gain: 0.5 * (1.2 - dist), freq: 160, freqEnd: 45, attack: 0.02, delay })
    this.burst({ dur: 3.6, gain: 0.3 * (1.2 - dist), freq: 90, freqEnd: 30, attack: 0.4, delay: delay + 0.25 })
    this.thump(45, 0.35 * (1.2 - dist), 1.6, delay)
  }

  private chirp(): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const notes = 2 + Math.floor(Math.random() * 3)
    const base = 2400 + Math.random() * 1400
    for (let i = 0; i < notes; i++) {
      const t0 = ctx.currentTime + i * (0.09 + Math.random() * 0.06)
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.25), t0)
      o.frequency.exponentialRampToValueAtTime(base * (1.05 + Math.random() * 0.3), t0 + 0.05)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(0.028, t0 + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08)
      o.connect(g); g.connect(this.master)
      o.start(t0)
      o.stop(t0 + 0.1)
    }
  }

  updateAmbience(dt: number, opts: { wind: number; rain: number; night: number; underwater: boolean; clear: boolean }): void {
    if (!this.ctx || !this.windGain || !this.rainGain) return
    this.windTarget = 0.05 + opts.wind * 0.055
    this.rainTarget = opts.underwater ? 0 : opts.rain * 0.16
    const wg = this.windGain.gain, rg = this.rainGain.gain
    wg.value += (this.windTarget - wg.value) * clamp(dt * 1.5, 0, 1)
    rg.value += (this.rainTarget - rg.value) * clamp(dt * 1.5, 0, 1)

    // occasional birdsong on clear days
    if (opts.night < 0.3 && opts.clear && !opts.underwater) {
      this.birdTimer -= dt
      if (this.birdTimer <= 0) {
        this.birdTimer = 4 + Math.random() * 9
        this.chirp()
      }
    }
  }
}
