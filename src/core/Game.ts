import * as THREE from 'three'
import { Atlas } from '../gfx/Atlas'
import { Materials } from '../gfx/Materials'
import { Environment } from '../gfx/Environment'
import { Particles } from '../gfx/Particles'
import { Critters } from '../gfx/Critters'
import { U } from '../gfx/Uniforms'
import { World } from '../world/World'
import { WorldGen, BIOME, BIOME_NAMES, SEA_LEVEL } from '../world/WorldGen'
import { CHUNK_SIZE } from '../world/Chunk'
import { Player } from '../player/Player'
import { Interaction } from '../player/Interaction'
import { Weather } from '../weather/Weather'
import { AudioMan } from '../audio/Audio'
import { Settings, QUALITIES, QualityName } from './Settings'
import { UI } from '../ui/UI'
import { clamp } from '../util/math'

type GameState = 'title' | 'loading' | 'ready' | 'playing' | 'paused'

export class Game {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()

  private atlas: Atlas
  private materials: Materials
  private env!: Environment
  private particles!: Particles
  private critters!: Critters
  private world!: World
  private player!: Player
  private interaction!: Interaction
  private weather = new Weather()
  private audio = new AudioMan()

  private state: GameState = 'title'
  private seedStr = ''
  private hudTimer = 0
  private fpsEma = 60
  private lowFpsTime = 0
  private lockCooldown = 0
  private perfEnabled = import.meta.env.DEV && new URLSearchParams(location.search).has('perf')
  private perfCpuTotal = 0
  private perfFrames = 0
  private perfDrawCallsTotal = 0
  private perfTrianglesTotal = 0
  private perfShadowUpdates = 0
  private perfNextReport = performance.now() + 2000
  private shadowUpdateTimer = 0

  constructor(private container: HTMLElement, private ui: UI, private settings: Settings, atlas: Atlas) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.18
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Geometry can render at the display refresh rate, while the expensive shadow
    // map changes slowly enough to update independently at 30 Hz.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    this.applyPixelRatio()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1600)
    this.scene.add(this.camera)

    this.atlas = atlas
    this.materials = new Materials(this.atlas)

    window.addEventListener('resize', () => this.onResize())
    document.addEventListener('contextmenu', (e) => {
      if (this.state === 'playing' || this.state === 'paused') e.preventDefault()
    })
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange())

    ui.onEnterWorld = (seed, quality) => this.startWorld(seed, quality)
    ui.onResume = () => this.requestPlay()
    ui.onSettingsChanged = () => this.applySettings()

    document.getElementById('click-start')!.addEventListener('click', () => this.requestPlay())

    this.bindGameKeys()
    if (import.meta.env.DEV) {
      // console handle for poking at the running game during development
      ;(window as unknown as Record<string, unknown>).__rc = this
    }
    this.renderer.setAnimationLoop(() => this.frame())
  }

  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.settings.preset.pixelRatioCap))
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }

  private async startWorld(seed: string, quality: QualityName): Promise<void> {
    if (this.state !== 'title') return
    this.settings.quality = quality
    this.settings.save()
    this.audio.init()
    this.audio.setVolume(this.settings.volume)

    this.seedStr = seed || Math.floor(Math.random() * 1e9).toString(36)
    this.state = 'loading'
    this.ui.showLoading()

    const preset = this.settings.preset
    this.applyPixelRatio()

    const gen = new WorldGen(this.seedStr)
    this.world = new World(gen, this.scene, this.materials, this.atlas, this.settings.renderDistance, preset.grassDensity)
    this.env = new Environment(this.scene, preset.shadowSize, this.settings.renderDistance * CHUNK_SIZE)
    this.particles = new Particles(this.scene, preset.particleMult)
    this.critters = new Critters(this.scene)

    this.player = new Player(this.camera, this.world, this.audio)
    this.player.headBobEnabled = this.settings.headBob
    this.player.attachInput(this.renderer.domElement)
    this.interaction = new Interaction(this.world, this.player, this.camera, this.scene, this.atlas, this.audio, this.particles)
    this.interaction.onSelectionChanged = (i) => this.ui.setSelectedSlot(i)
    this.ui.buildHotbar(this.atlas)
    this.bindMouse()

    // pick a scenic spawn, then generate the world around it
    const spawn = gen.findSpawn()
    const ccx = Math.floor(spawn.x / CHUNK_SIZE), ccz = Math.floor(spawn.z / CHUNK_SIZE)
    await this.world.pregen(ccx, ccz, (f) => {
      this.ui.setLoadProgress(f, f < 0.6 ? 'Generating terrain' : 'Building meshes')
    })

    // land exactly on the terrain that actually generated
    let sy = this.world.topSolidY(spawn.x, spawn.z)
    if (sy < 0 || sy < SEA_LEVEL - 1) sy = Math.max(SEA_LEVEL, this.world.gen.heightAt(spawn.x, spawn.z))
    this.player.teleport(spawn.x + 0.5, sy + 1.05, spawn.z + 0.5, spawn.yaw)

    this.state = 'ready'
    this.ui.showClickStart()
  }

  private requestPlay(): void {
    if (this.state !== 'ready' && this.state !== 'paused') return
    if (performance.now() < this.lockCooldown) {
      // browsers refuse pointer lock right after an unlock; retry shortly
      setTimeout(() => this.requestPlay(), Math.max(60, this.lockCooldown - performance.now()))
      return
    }
    const p = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // pointer lock unavailable (embedded browser etc.) — play without it
        this.enterPlaying()
      })
    }
    // if the lock succeeds, pointerlockchange flips us to playing
    setTimeout(() => {
      if (document.pointerLockElement !== this.renderer.domElement &&
        (this.state === 'ready' || this.state === 'paused')) {
        this.enterPlaying()
      }
    }, 350)
  }

  private enterPlaying(): void {
    this.state = 'playing'
    this.player.enabled = true
    this.ui.hidePause()
    this.ui.showGame()
  }

  private onPointerLockChange(): void {
    if (document.pointerLockElement === this.renderer.domElement) {
      this.enterPlaying()
    } else if (this.state === 'playing') {
      this.lockCooldown = performance.now() + 1300
      this.state = 'paused'
      this.player.enabled = false
      this.player.clearKeys()
      this.interaction.primaryUp()
      this.interaction.secondaryUp()
      this.ui.showPause()
    }
  }

  private bindMouse(): void {
    const dom = this.renderer.domElement
    dom.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing') return
      if (e.button === 0) this.interaction.primaryDown()
      if (e.button === 2) this.interaction.secondaryDown()
    })
    dom.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.interaction.primaryUp()
      if (e.button === 2) this.interaction.secondaryUp()
    })
    dom.addEventListener('wheel', (e) => {
      if (this.state !== 'playing') return
      e.preventDefault()
      this.interaction.scroll(e.deltaY)
    }, { passive: false })
  }

  private bindGameKeys(): void {
    document.addEventListener('keydown', (e) => {
      if (this.state !== 'playing') return
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10)
        if (n >= 1 && n <= 9) this.interaction.setSelected(n - 1)
      }
      switch (e.code) {
        case 'KeyT': {
          this.env.timeScale = this.env.timeScale === 1 ? 40 : 1
          this.ui.toast(this.env.timeScale > 1 ? 'Time fast-forward ON' : 'Time fast-forward OFF')
          break
        }
        case 'KeyY': {
          const kind = this.weather.cycle()
          this.ui.toast('Weather: ' + kind)
          break
        }
        case 'KeyF': {
          const on = this.player.toggleFlashlight()
          this.ui.toast('Flashlight ' + (on ? 'ON' : 'OFF'))
          break
        }
        case 'KeyG': {
          const fly = this.player.toggleFly()
          this.ui.toast(fly ? 'Flight enabled' : 'Flight disabled')
          break
        }
      }
    })
  }

  private applySettings(): void {
    if (!this.world) return
    this.audio.setVolume(this.settings.volume)
    this.player.headBobEnabled = this.settings.headBob
    const preset = this.settings.preset
    this.applyPixelRatio()
    this.env.setShadowMapSize(preset.shadowSize)
    this.world.grassDensity = preset.grassDensity
    if (this.world.renderDistance !== this.settings.renderDistance) {
      this.world.setRenderDistance(this.settings.renderDistance)
      this.env.setViewDistance(this.settings.renderDistance * CHUNK_SIZE)
    }
  }

  private frame(): void {
    const frameStart = performance.now()
    const dt = clamp(this.clock.getDelta(), 0.0001, 0.05)
    U.uTime.value += dt

    if (this.state === 'title' || this.state === 'loading') return

    const playing = this.state === 'playing'
    if (playing) {
      this.player.update(dt)
      this.interaction.update(dt)
    }

    const p = this.player.pos
    this.world.update(p.x, p.z, playing ? 6 : 2)

    const biome = this.world.biomeAt(Math.floor(p.x), Math.floor(p.z))
    const cold = biome === BIOME.SNOW || p.y > 82
    this.weather.update(playing ? dt : 0, cold, this.audio)
    const w = this.weather.out

    const underwater = this.player.headUnderwater
    this.env.setWeather(w)
    this.env.update(playing ? dt : 0, this.camera, p, underwater, this.world.renderDistance * CHUNK_SIZE)
    // rain wetness: surfaces get darker and glossier
    this.materials.solid.roughness = 1 - w.wetness * 0.45
    this.materials.solid.color.setScalar(1 - w.wetness * 0.12)

    this.particles.update(dt, this.camera.position, w.rain, w.snow, U.uNight.value, underwater, w.wind)
    this.critters.update(dt, p, U.uNight.value, w.rain + w.snow)
    this.ui.setUnderwater(underwater)
    this.audio.setUnderwater(underwater)
    this.audio.updateAmbience(dt, {
      wind: w.wind,
      rain: w.rain,
      night: U.uNight.value,
      underwater,
      clear: this.weather.kind === 'clear'
    })

    // HUD + adaptive performance
    const fps = 1 / dt
    this.fpsEma = this.fpsEma * 0.95 + fps * 0.05
    this.hudTimer -= dt
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.25
      this.ui.updateHud({
        fps: this.fpsEma,
        x: p.x, y: p.y, z: p.z,
        biome: BIOME_NAMES[biome] ?? '?',
        time: this.env.timeString(),
        weather: this.weather.displayName(cold),
        seed: this.seedStr,
        flying: this.player.flying
      })
    }
    if (playing) {
      if (this.fpsEma < 25) this.lowFpsTime += dt
      else this.lowFpsTime = 0
      if (this.lowFpsTime > 8 && this.world.renderDistance > 4) {
        this.lowFpsTime = 0
        this.world.setRenderDistance(this.world.renderDistance - 1)
        this.env.setViewDistance(this.world.renderDistance * CHUNK_SIZE)
        this.ui.toast('Performance: render distance reduced to ' + this.world.renderDistance)
      }
    }

    this.shadowUpdateTimer -= dt
    if (this.shadowUpdateTimer <= 0) {
      this.renderer.shadowMap.needsUpdate = true
      this.shadowUpdateTimer += 1 / 30
      if (this.perfEnabled) this.perfShadowUpdates++
    }

    this.renderer.render(this.scene, this.camera)

    if (this.perfEnabled) {
      const now = performance.now()
      const render = this.renderer.info.render
      this.perfCpuTotal += now - frameStart
      this.perfDrawCallsTotal += render.calls
      this.perfTrianglesTotal += render.triangles
      this.perfFrames++
      if (now >= this.perfNextReport) {
        console.info('[realmcraft:perf]', JSON.stringify({
          fps: Number(this.fpsEma.toFixed(1)),
          cpuFrameMs: Number((this.perfCpuTotal / this.perfFrames).toFixed(2)),
          avgDrawCalls: Math.round(this.perfDrawCallsTotal / this.perfFrames),
          avgTriangles: Math.round(this.perfTrianglesTotal / this.perfFrames),
          shadowUpdates: this.perfShadowUpdates,
          chunks: this.world.chunkCount(),
          moving: this.player.vel.lengthSq() > 0.04
        }))
        this.perfCpuTotal = 0
        this.perfDrawCallsTotal = 0
        this.perfTrianglesTotal = 0
        this.perfShadowUpdates = 0
        this.perfFrames = 0
        this.perfNextReport = now + 2000
      }
    }
  }
}
