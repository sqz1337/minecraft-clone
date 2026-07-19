import * as THREE from 'three'
import { clamp, lerp } from '../util/math'
import { B, SOLID, CROSS, SOUND_CAT, isWater, isLava, fluidLevel } from '../world/Blocks'
import type { World } from '../world/World'
import type { AudioMan } from '../audio/Audio'
import type { GameMode } from '../core/Settings'
import { damageAfterArmor } from './Combat'
import { experienceProgress, spendExperienceLevels } from './Experience'

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
const COYOTE_TIME = 0.1
const JUMP_BUFFER_TIME = 0.13

export class Player {
  pos = new THREE.Vector3()      // feet center
  vel = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = false
  flying = false
  noclip = false
  crouching = false
  sprinting = false
  inWater = false
  inLava = false
  headUnderwater = false
  enabled = false
  headBobEnabled = true
  health = 20
  hunger = 20
  saturation = 5
  air = 10
  exhaustion = 0
  armorPoints = 0
  protectionLevels = 0
  featherFallingLevel = 0
  respirationLevel = 0
  aquaAffinity = false
  experienceTotal = 0
  onStatsChanged: () => void = () => {}
  onDamage: (amount: number) => void = () => {}
  onDeath: () => void = () => {}
  onArmorDamaged: () => void = () => {}
  onExperienceChanged: () => void = () => {}

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
  private jumpBuffer = 0
  private swimStrokeTimer = 0
  private damageCooldown = 0
  private drownTimer = 1
  private hungerTimer = 4
  private regenTimer = 4
  private fireDamageTimer = 0
  private hungerEffectTime = 0
  private poisonTime = 0
  private poisonTickTimer = 1
  /** Seconds of lingering burn after leaving fire or lava; water extinguishes it. */
  private burnTime = 0
  private dead = false
  private hurtTime = 0
  flashlight: THREE.SpotLight
  private flashOn = false

  constructor(camera: THREE.PerspectiveCamera, world: World, audio: AudioMan, private mode: GameMode = 'creative') {
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
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat && !this.flying && !this.noclip && !this.inWater) this.jumpBuffer = JUMP_BUFFER_TIME
      }
    })
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.clearKeys())
    dom.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement === null) return
      this.yaw -= e.movementX * 0.0022
      this.pitch -= e.movementY * 0.0022
      this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01)
    })
  }

  clearKeys(): void {
    this.keys.clear()
    this.jumpBuffer = 0
  }

  teleport(x: number, y: number, z: number, yaw = 0, pitch = -0.08): void {
    this.pos.set(x, y, z)
    this.vel.set(0, 0, 0)
    this.yaw = yaw
    this.pitch = clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01)
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

  restoreSurvival(health = 20, hunger = 20, saturation = 5, air = 10, exhaustion = 0, experience = 0): void {
    this.health = clamp(health, 1, 20)
    this.hunger = clamp(hunger, 0, 20)
    this.saturation = clamp(saturation, 0, this.hunger)
    this.air = clamp(air, 0, 10)
    this.exhaustion = Math.max(0, exhaustion)
    this.experienceTotal = Math.max(0, Math.floor(experience))
    this.dead = false
    this.onStatsChanged()
    this.onExperienceChanged()
  }

  resetAfterDeath(): void {
    this.health = 20
    this.hunger = 20
    this.saturation = 5
    this.air = 10
    this.exhaustion = 0
    this.dead = false
    this.damageCooldown = 0
    this.onStatsChanged()
  }

  addExhaustion(amount: number): void {
    if (this.mode === 'survival' && !this.noclip) this.exhaustion += Math.max(0, amount)
  }

  get experienceLevel(): number { return experienceProgress(this.experienceTotal).level }
  get experienceFraction(): number { return experienceProgress(this.experienceTotal).fraction }

  addExperience(amount: number): void {
    if (this.mode !== 'survival' || !Number.isFinite(amount) || amount <= 0) return
    this.experienceTotal += Math.floor(amount)
    this.onExperienceChanged()
  }

  setExperience(total: number): void {
    this.experienceTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0))
    this.onExperienceChanged()
  }

  spendExperienceLevels(cost: number): boolean {
    const remaining = spendExperienceLevels(this.experienceTotal, cost)
    if (remaining === null) return false
    this.experienceTotal = remaining
    this.onExperienceChanged()
    return true
  }

  eat(hunger: number, saturationModifier: number): boolean {
    if (this.mode !== 'survival' || this.dead || this.hunger >= 20) return false
    this.hunger = Math.min(20, this.hunger + Math.max(0, hunger))
    this.saturation = Math.min(
      this.hunger,
      this.saturation + Math.max(0, hunger * saturationModifier * 2)
    )
    this.onStatsChanged()
    return true
  }

  /** Lightweight food-borne effects; intentionally separate from the future potion system. */
  applyFoodEffect(kind: 'hunger' | 'poison', seconds: number): void {
    if (kind === 'hunger') this.hungerEffectTime = Math.max(this.hungerEffectTime, seconds)
    else this.poisonTime = Math.max(this.poisonTime, seconds)
  }

  damage(amount: number, bypassArmor = false): boolean {
    if (this.mode !== 'survival' || this.noclip || this.dead || amount <= 0 || this.damageCooldown > 0) return false
    const actual = bypassArmor ? Math.ceil(amount) : damageAfterArmor(amount, this.armorPoints, this.protectionLevels)
    if (actual <= 0) return false
    this.health = Math.max(0, this.health - actual)
    this.damageCooldown = 0.55
    this.hurtTime = 1
    this.audio.hurt()
    if (!bypassArmor && this.armorPoints > 0) this.onArmorDamaged()
    this.onDamage(actual)
    this.onStatsChanged()
    if (this.health <= 0) {
      this.dead = true
      this.onDeath()
    }
    return true
  }

  knockback(sourceX: number, sourceZ: number, power = 3.2): void {
    const dx = this.pos.x - sourceX, dz = this.pos.z - sourceZ
    const length = Math.hypot(dx, dz) || 1
    this.vel.x += dx / length * power
    this.vel.z += dz / length * power
    this.vel.y = Math.max(this.vel.y, Math.min(4, power * 0.55))
  }

  setNoclip(enabled: boolean): void {
    this.noclip = enabled
    this.onGround = false
    this.inWater = false
    this.inLava = false
    this.headUnderwater = false
    this.coyote = 0
    this.jumpBuffer = 0
    this.vel.y = 0
  }

  toggleNoclip(): boolean {
    this.setNoclip(!this.noclip)
    return this.noclip
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
    this.hurtTime = Math.max(0, this.hurtTime - dt * 1.65)
    const startX = this.pos.x, startZ = this.pos.z
    const k = this.keys
    const freeFlight = this.flying || this.noclip
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    this.crouching = (k.has('ControlLeft') || k.has('KeyC')) && !freeFlight
    this.sprinting = (k.has('ShiftLeft') || k.has('ShiftRight')) && fwd > 0 && !this.crouching &&
      (this.mode === 'creative' || this.hunger > 6)

    // water state
    const feetBlock = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z))
    this.inWater = !this.noclip && isWater(feetBlock)
    this.inLava = !this.noclip && isLava(feetBlock)
    const eyeY = this.pos.y + (this.crouching ? EYE_CROUCH : EYE)
    const eyeBlock = this.world.getBlock(Math.floor(this.pos.x), Math.floor(eyeY), Math.floor(this.pos.z))
    const waterHeight = isWater(eyeBlock) ? WATER_SURFACE * (8 - fluidLevel(eyeBlock)) / 8 : 0
    this.headUnderwater = !this.noclip && waterHeight > 0 && (eyeY - Math.floor(eyeY)) < waterHeight

    if (this.inWater && !this.wasInWater && this.vel.y < -3) {
      this.audio.splash(true)
    }
    this.wasInWater = this.inWater

    this.tryGroundJump()

    // wanted horizontal velocity in world space
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw)
    const dirX = -sinY * fwd + cosY * strafe
    const dirZ = -cosY * fwd - sinY * strafe
    const dirLen = Math.hypot(dirX, dirZ)
    let speed = freeFlight
      ? (this.sprinting ? FLY_SPRINT : FLY)
      : this.inWater ? SWIM
        : this.crouching ? CROUCH_SPEED
          : this.sprinting ? SPRINT : WALK

    const tx = dirLen > 0 ? (dirX / dirLen) * speed : 0
    const tz = dirLen > 0 ? (dirZ / dirLen) * speed : 0
    const accel = freeFlight ? 8 : this.onGround ? 12 : this.inWater ? 4 : 2.2
    const blend = clamp(accel * dt, 0, 1)
    this.vel.x = lerp(this.vel.x, tx, blend)
    this.vel.z = lerp(this.vel.z, tz, blend)

    // vertical motion
    if (freeFlight) {
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
      const sneakHold = this.crouching && wasGround && this.vel.y <= 0 && !this.inWater
      // X
      let nx = this.pos.x + this.vel.x * sdt
      let hit = this.collides(nx, this.pos.y, this.pos.z)
      if (hit) {
        nx = this.vel.x > 0 ? hit.x - HALF - 0.001 : hit.x + 1 + HALF + 0.001
        if (this.inWater && k.has('Space') && this.onGroundOrNear()) this.vel.y = Math.max(this.vel.y, 5.5)
        this.vel.x = 0
      } else if (sneakHold && !this.collides(nx, this.pos.y - 0.1, this.pos.z)) {
        // sneaking never walks off an edge
        nx = this.pos.x
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
      } else if (sneakHold && !this.collides(this.pos.x, this.pos.y - 0.1, nz)) {
        nz = this.pos.z
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
      // classic rule: one damage per block fallen beyond three; feather falling softens it
      const fallHeight = impact * impact / (2 * GRAVITY)
      const raw = Math.ceil(fallHeight - 3.05)
      if (raw > 0 && !this.inWater) {
        const reduction = Math.min(0.8, Math.max(0, this.featherFallingLevel) * 0.2)
        const dealt = Math.round(raw * (1 - reduction))
        if (dealt > 0) this.damage(dealt)
      }
      this.fallSpeedPeak = 0
    }
    if (this.onGround) {
      this.coyote = COYOTE_TIME
      this.fallSpeedPeak = 0
    } else {
      this.coyote = Math.max(0, this.coyote - dt)
    }

    if (this.noclip) {
      this.pos.addScaledVector(this.vel, dt)
      this.onGround = false
      this.fallSpeedPeak = 0
      this.stepAccum = 0
      this.updateSurvival(dt, startX, startZ)
      this.syncCamera(dt)
      return
    }

    // Consume a press made just before landing without waiting for another keydown.
    this.tryGroundJump()
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt)

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
      if (this.mode === 'survival') this.damage(100)
      else {
        const ty = this.world.topSolidY(Math.floor(this.pos.x), Math.floor(this.pos.z))
        this.pos.y = (ty >= 0 ? ty : 64) + 1.2
        this.vel.set(0, 0, 0)
      }
    }

    this.updateSurvival(dt, startX, startZ)
    this.syncCamera(dt)
  }

  private updateSurvival(dt: number, startX: number, startZ: number): void {
    if (this.mode !== 'survival' || this.dead) return
    this.damageCooldown = Math.max(0, this.damageCooldown - dt)

    const bodyBlock = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.7), Math.floor(this.pos.z))
    const inLavaNow = this.inLava || isLava(bodyBlock)
    const inFireNow = bodyBlock === B.FIRE
    if (inLavaNow) this.burnTime = Math.max(this.burnTime, 6)
    else if (inFireNow) this.burnTime = Math.max(this.burnTime, 3)
    if (this.inWater) this.burnTime = 0
    if (inLavaNow || inFireNow) {
      this.fireDamageTimer -= dt
      if (this.fireDamageTimer <= 0) {
        this.fireDamageTimer = inLavaNow ? 0.65 : 1
        this.damage(inLavaNow ? 4 : 1, true)
      }
    } else if (this.burnTime > 0) {
      // lingering burn after leaving the fire source
      this.burnTime = Math.max(0, this.burnTime - dt)
      this.fireDamageTimer -= dt
      if (this.fireDamageTimer <= 0) {
        this.fireDamageTimer = 1
        this.damage(1, true)
      }
    } else {
      this.fireDamageTimer = 0
    }

    if (!this.noclip) {
      const distance = Math.hypot(this.pos.x - startX, this.pos.z - startZ)
      this.addExhaustion(distance * (this.sprinting ? 0.1 : this.inWater ? 0.04 : 0.01))
    }
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1)
      else if (this.hunger > 0) this.hunger = Math.max(0, this.hunger - 1)
      this.onStatsChanged()
    }

    if (this.hungerEffectTime > 0) {
      this.hungerEffectTime = Math.max(0, this.hungerEffectTime - dt)
      this.addExhaustion(dt * 0.2)
    }
    if (this.poisonTime > 0) {
      this.poisonTime = Math.max(0, this.poisonTime - dt)
      this.poisonTickTimer -= dt
      if (this.poisonTickTimer <= 0) {
        this.poisonTickTimer = 1.25
        if (this.health > 1) {
          this.health--
          this.onDamage(1)
          this.onStatsChanged()
        }
      }
    } else this.poisonTickTimer = 1

    if (this.headUnderwater && !this.noclip) {
      this.air = Math.max(0, this.air - dt / (1 + Math.max(0, this.respirationLevel)))
      if (this.air <= 0) {
        this.drownTimer -= dt
        if (this.drownTimer <= 0) {
          this.drownTimer = 1
          this.damage(2)
        }
      }
    } else {
      this.air = Math.min(10, this.air + dt * 4)
      this.drownTimer = 1
    }

    if (this.hunger <= 0 && this.health > 1) {
      this.hungerTimer -= dt
      if (this.hungerTimer <= 0) {
        this.hungerTimer = 4
        this.damage(1)
      }
    } else {
      this.hungerTimer = 4
    }

    if (this.hunger >= 18 && this.health < 20) {
      this.regenTimer -= dt
      if (this.regenTimer <= 0) {
        this.regenTimer = 4
        this.health = Math.min(20, this.health + 1)
        this.addExhaustion(3)
        this.onStatsChanged()
      }
    } else {
      this.regenTimer = 4
    }
  }

  private onGroundOrNear(): boolean {
    return this.collides(this.pos.x, this.pos.y - 0.15, this.pos.z) !== null
  }

  private tryGroundJump(): void {
    if (
      this.jumpBuffer <= 0 ||
      this.flying ||
      this.noclip ||
      this.inWater ||
      (!this.onGround && this.coyote <= 0)
    ) return

    this.vel.y = JUMP_V
    this.onGround = false
    this.coyote = 0
    this.jumpBuffer = 0
    this.audio.jump()
    this.addExhaustion(this.sprinting ? 0.8 : 0.2)
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
    const hurtRoll = Math.sin(this.hurtTime * Math.PI * 2) * this.hurtTime * 0.055
    this.camera.rotation.set(
      this.pitch + Math.sin(this.hurtTime * Math.PI) * 0.012,
      this.yaw,
      Math.sin(this.bobPhase) * 0.006 * this.bobAmp + hurtRoll
    )

    // FOV kick while sprinting/flying fast
    const fovTarget = this.baseFov * (this.sprinting ? (this.flying ? 1.18 : 1.1) : 1)
    this.camera.fov = lerp(this.camera.fov, fovTarget, clamp(dt * 7, 0, 1))
    this.camera.updateProjectionMatrix()
  }
}
