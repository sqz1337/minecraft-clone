import * as THREE from 'three'
import { clamp, lerp } from '../util/math'
import { B, SOLID, CROSS, SOUND_CAT } from '../world/Blocks'
import type { World } from '../world/World'
import type { AudioMan } from '../audio/Audio'

const HALF = 0.3
const HEIGHT = 1.8
const EYE = 1.62
const EYE_CROUCH = 1.45
const GRAVITY = 27
const JUMP_V = 8.6
const WALK = 4.4
const SPRINT = 6.9
const CROUCH_SPEED = 2.0
const SWIM = 3.1
const FLY = 13
const FLY_SPRINT = 26
const WATER_SURFACE = 0.875

export class Player {
  pos = new THREE.Vector3()      // feet center
  vel = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = false
  flying = false
  crouching = false
  sprinting = false
  inWater = false
  headUnderwater = false
  enabled = false
  headBobEnabled = true

  camera: THREE.PerspectiveCamera
  private world: World
  private audio: AudioMan
  private keys = new Set<string>()
  private bobPhase = 0
  private bobAmp = 0
  private landDip = 0
  private baseFov: number
  private stepAccum = 0
  private wasInWater = false
  private fallSpeedPeak = 0
  private coyote = 0
  private swimStrokeTimer = 0
  flashlight: THREE.SpotLight
  private flashOn = false

  constructor(camera: THREE.PerspectiveCamera, world: World, audio: AudioMan) {
    this.camera = camera
    this.world = world
    this.audio = audio
    this.baseFov = camera.fov
    camera.rotation.order = 'YXZ'

    this.flashlight = new THREE.SpotLight(0xfff1cf, 0, 44, 0.5, 0.45, 1.3)
    this.flashlight.position.set(0, 0, 0)
    camera.add(this.flashlight)
    camera.add(this.flashlight.target)
    this.flashlight.target.position.set(0, 0, -1)
  }

  attachInput(dom: HTMLElement): void {
    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return
      this.keys.add(e.code)
      if (e.code === 'Space') e.preventDefault()
      if (e.code === 'Space' && this.onGround && !this.flying && !this.inWater) {
        this.vel.y = JUMP_V
        this.onGround = false
        this.audio.jump()
      }
    })
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
    dom.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement === null) return
      this.yaw -= e.movementX * 0.0022
      this.pitch -= e.movementY * 0.0022
      this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01)
    })
  }

  clearKeys(): void { this.keys.clear() }

  teleport(x: number, y: number, z: number, yaw = 0): void {
    this.pos.set(x, y, z)
    this.vel.set(0, 0, 0)
    this.yaw = yaw
    this.pitch = -0.08
    this.syncCamera(0)
  }

  toggleFlashlight(): boolean {
    this.flashOn = !this.flashOn
    this.flashlight.intensity = this.flashOn ? 120 : 0
    return this.flashOn
  }

  toggleFly(): boolean {
    this.flying = !this.flying
    if (this.flying) this.vel.y = 0
    return this.flying
  }

  eyePos(target: THREE.Vector3): THREE.Vector3 {
    return target.set(this.pos.x, this.pos.y + (this.crouching ? EYE_CROUCH : EYE), this.pos.z)
  }

  private isSolidAt(x: number, y: number, z: number): boolean {
    const id = this.world.getBlock(x, y, z)
    return SOLID[id] && !CROSS[id]
  }

  private collides(px: number, py: number, pz: number): { x: number, y: number, z: number } | null {
    const x0 = Math.floor(px - HALF), x1 = Math.floor(px + HALF)
    const y0 = Math.floor(py), y1 = Math.floor(py + HEIGHT)
    const z0 = Math.floor(pz - HALF), z1 = Math.floor(pz + HALF)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          if (this.isSolidAt(x, y, z)) return { x, y, z }
        }
      }
    }
    return null
  }

  /** True if placing a block at (x,y,z) would intersect the player. */
  intersectsBlock(x: number, y: number, z: number): boolean {
    return (
      x + 1 > this.pos.x - HALF && x < this.pos.x + HALF &&
      y + 1 > this.pos.y && y < this.pos.y + HEIGHT &&
      z + 1 > this.pos.z - HALF && z < this.pos.z + HALF
    )
  }

  blockBelowCat(): string {
    const id = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.4), Math.floor(this.pos.z))
    return SOUND_CAT[id] ?? 'stone'
  }

  update(dt: number): void {
    const k = this.keys
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    this.crouching = (k.has('ControlLeft') || k.has('KeyC')) && !this.flying
    this.sprinting = (k.has('ShiftLeft') || k.has('ShiftRight')) && fwd > 0 && !this.crouching

    // water state
    const feetBlock = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z))
    this.inWater = feetBlock === B.WATER
    const eyeY = this.pos.y + (this.crouching ? EYE_CROUCH : EYE)
    const eyeBlock = this.world.getBlock(Math.floor(this.pos.x), Math.floor(eyeY), Math.floor(this.pos.z))
    this.headUnderwater = eyeBlock === B.WATER && (eyeY - Math.floor(eyeY)) < WATER_SURFACE

    if (this.inWater && !this.wasInWater && this.vel.y < -3) {
      this.audio.splash(true)
    }
    this.wasInWater = this.inWater

    // wanted horizontal velocity in world space
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw)
    const dirX = -sinY * fwd + cosY * strafe
    const dirZ = -cosY * fwd - sinY * strafe
    const dirLen = Math.hypot(dirX, dirZ)
    let speed = this.flying
      ? (this.sprinting ? FLY_SPRINT : FLY)
      : this.inWater ? SWIM
        : this.crouching ? CROUCH_SPEED
          : this.sprinting ? SPRINT : WALK

    const tx = dirLen > 0 ? (dirX / dirLen) * speed : 0
    const tz = dirLen > 0 ? (dirZ / dirLen) * speed : 0
    const accel = this.flying ? 8 : this.onGround ? 12 : this.inWater ? 4 : 2.2
    const blend = clamp(accel * dt, 0, 1)
    this.vel.x = lerp(this.vel.x, tx, blend)
    this.vel.z = lerp(this.vel.z, tz, blend)

    // vertical motion
    if (this.flying) {
      const up = (k.has('Space') ? 1 : 0) - (k.has('ControlLeft') || k.has('KeyC') ? 1 : 0)
      this.vel.y = lerp(this.vel.y, up * 9, clamp(10 * dt, 0, 1))
    } else if (this.inWater) {
      if (k.has('Space')) {
        this.vel.y = lerp(this.vel.y, 4.4, clamp(6 * dt, 0, 1))
        this.swimStrokeTimer -= dt
        if (this.swimStrokeTimer <= 0) {
          this.swimStrokeTimer = 0.55
          this.audio.swimStroke()
        }
      } else {
        this.vel.y -= 6.5 * dt
        this.vel.y = Math.max(this.vel.y, -3)
        // gentle buoyancy near the surface
        if (!this.headUnderwater && this.vel.y < 0) this.vel.y *= 1 - clamp(3 * dt, 0, 0.9)
      }
    } else {
      this.vel.y -= GRAVITY * dt
      this.vel.y = Math.max(this.vel.y, -42)
    }

    if (!this.onGround && this.vel.y < this.fallSpeedPeak) this.fallSpeedPeak = this.vel.y

    // integrate with substeps so fast falls can't tunnel through blocks
    const maxDisp = Math.max(Math.abs(this.vel.x), Math.abs(this.vel.y), Math.abs(this.vel.z)) * dt
    const steps = Math.max(1, Math.ceil(maxDisp / 0.4))
    const sdt = dt / steps
    const wasGround = this.onGround
    this.onGround = false

    for (let s = 0; s < steps; s++) {
      // X
      let nx = this.pos.x + this.vel.x * sdt
      let hit = this.collides(nx, this.pos.y, this.pos.z)
      if (hit) {
        nx = this.vel.x > 0 ? hit.x - HALF - 0.001 : hit.x + 1 + HALF + 0.001
        if (this.inWater && k.has('Space') && this.onGroundOrNear()) this.vel.y = Math.max(this.vel.y, 5.5)
        this.vel.x = 0
      }
      this.pos.x = nx
      // Z
      let nz = this.pos.z + this.vel.z * sdt
      hit = this.collides(this.pos.x, this.pos.y, nz)
      if (hit) {
        nz = this.vel.z > 0 ? hit.z - HALF - 0.001 : hit.z + 1 + HALF + 0.001
        if (this.inWater && k.has('Space') && this.onGroundOrNear()) this.vel.y = Math.max(this.vel.y, 5.5)
        this.vel.z = 0
      }
      this.pos.z = nz
      // Y
      let ny = this.pos.y + this.vel.y * sdt
      hit = this.collides(this.pos.x, ny, this.pos.z)
      if (hit) {
        if (this.vel.y <= 0) {
          ny = hit.y + 1 + 0.001
          this.onGround = true
        } else {
          ny = hit.y - HEIGHT - 0.001
        }
        this.vel.y = 0
      }
      this.pos.y = ny
    }

    // landing feedback
    if (!wasGround && this.onGround) {
      const impact = -this.fallSpeedPeak
      if (impact > 7) {
        this.audio.land(impact > 16)
        this.landDip = Math.min(0.3, impact * 0.014)
      }
      this.fallSpeedPeak = 0
    }
    if (this.onGround) {
      this.coyote = 0.09
      this.fallSpeedPeak = 0
    } else {
      this.coyote -= dt
    }

    // footsteps
    const hSpeed = Math.hypot(this.vel.x, this.vel.z)
    if (this.onGround && hSpeed > 0.8) {
      this.stepAccum += hSpeed * dt
      const strideLen = this.sprinting ? 2.9 : 2.2
      if (this.stepAccum > strideLen) {
        this.stepAccum = 0
        this.audio.footstep(this.inWater ? 'water' : this.blockBelowCat(), this.sprinting)
      }
    } else if (!this.onGround) {
      this.stepAccum = 0.7 * (this.sprinting ? 2.9 : 2.2)
    }

    // safety net: never fall through the world
    if (this.pos.y < -10) {
      const ty = this.world.topSolidY(Math.floor(this.pos.x), Math.floor(this.pos.z))
      this.pos.y = (ty >= 0 ? ty : 64) + 1.2
      this.vel.set(0, 0, 0)
    }

    this.syncCamera(dt)
  }

  private onGroundOrNear(): boolean {
    return this.collides(this.pos.x, this.pos.y - 0.15, this.pos.z) !== null
  }

  private syncCamera(dt: number): void {
    const hSpeed = Math.hypot(this.vel.x, this.vel.z)
    // head bob
    const bobTarget = this.headBobEnabled && this.onGround && hSpeed > 0.5 ? Math.min(1, hSpeed / SPRINT) : 0
    this.bobAmp = lerp(this.bobAmp, bobTarget, clamp(dt * 6, 0, 1))
    if (this.bobAmp > 0.01) this.bobPhase += hSpeed * dt * 1.6
    const bobY = Math.sin(this.bobPhase * 2) * 0.045 * this.bobAmp
    const bobX = Math.cos(this.bobPhase) * 0.03 * this.bobAmp

    this.landDip = Math.max(0, this.landDip - dt * 1.4)
    const dip = this.landDip * Math.sin(Math.min(1, this.landDip * 8) * Math.PI)

    const eye = this.crouching ? EYE_CROUCH : EYE
    this.camera.position.set(
      this.pos.x + bobX * Math.cos(this.yaw),
      this.pos.y + eye + bobY - dip,
      this.pos.z + bobX * -Math.sin(this.yaw)
    )
    this.camera.rotation.set(this.pitch, this.yaw, Math.sin(this.bobPhase) * 0.006 * this.bobAmp)

    // FOV kick while sprinting/flying fast
    const fovTarget = this.baseFov * (this.sprinting ? (this.flying ? 1.18 : 1.1) : 1)
    this.camera.fov = lerp(this.camera.fov, fovTarget, clamp(dt * 7, 0, 1))
    this.camera.updateProjectionMatrix()
  }
}
