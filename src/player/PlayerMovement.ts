import * as THREE from 'three'
import { clamp, lerp } from '../util/math'
import { B, SOUND_CAT, blockCollisionBox, isWater, isLava, fluidLevel } from '../world/Blocks'
import type { World } from '../world/World'
import type { AudioMan } from '../audio/Audio'
import { Settings, type ControlAction, type GameMode } from '../core/Settings'
import { damageAfterArmor } from './Combat'
import { experienceProgress, spendExperienceLevels } from './Experience'
import type { EntityRiderPose } from '../entities/EntityTypes'
import { HALF, HEIGHT, EYE, EYE_CROUCH, GRAVITY, JUMP_V, WALK, SPRINT, CROUCH_SPEED, SWIM, FLY, FLY_SPRINT, WATER_SURFACE, CameraMode, waterCellHeight, CollisionHit, COYOTE_TIME, JUMP_BUFFER_TIME, fallDamageForHeight } from './PlayerShared'
import type { Player } from './Player'

type PlayerConstructor = { prototype: Player }

export function installPlayerMovement(PlayerClass: PlayerConstructor): void {
  const prototype = PlayerClass.prototype
  prototype.update = function(this: Player, dt: number): void {
    this.hurtTime = Math.max(0, this.hurtTime - dt * 1.65)
    const startX = this.pos.x, startZ = this.pos.z
    if (this.ridingPose) {
      this.crouching = false
      this.sprinting = false
      this.vel.set(0, 0, 0)
      this.updateSurvival(dt, startX, startZ)
      this.syncCamera(dt)
      return
    }
    const freeFlight = this.flying || this.noclip
    const fwd = (this.actionDown('forward') ? 1 : 0) - (this.actionDown('back') ? 1 : 0)
    const strafe = (this.actionDown('right') ? 1 : 0) - (this.actionDown('left') ? 1 : 0)
    this.crouching = this.actionDown('crouch') && !freeFlight
    this.sprinting = this.actionDown('sprint') && fwd > 0 && !this.crouching &&
      (this.mode === 'creative' || this.hunger > 6)

    // water state
    const feetBlock = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z))
    this.inWater = !this.noclip && isWater(feetBlock)
    this.inLava = !this.noclip && isLava(feetBlock)
    const eyeY = this.pos.y + (this.crouching ? EYE_CROUCH : EYE)
    const eyeX = Math.floor(this.pos.x), eyeBlockY = Math.floor(eyeY), eyeZ = Math.floor(this.pos.z)
    const eyeBlock = this.world.getBlock(eyeX, eyeBlockY, eyeZ)
    // Only the uppermost water cell has the classic 7/8 surface. A water cell
    // with more water above is completely filled; treating every cell as 7/8
    // full made underwater fog toggle off at every integer Y boundary.
    const waterHeight = waterCellHeight(eyeBlock, this.world.getBlock(eyeX, eyeBlockY + 1, eyeZ))
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
      const up = (this.actionDown('jump') ? 1 : 0) - (this.actionDown('crouch') ? 1 : 0)
      this.vel.y = lerp(this.vel.y, up * 9, clamp(10 * dt, 0, 1))
    } else if (this.inWater) {
      if (this.actionDown('jump')) {
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
    // water, lava and flight reset the accumulated fall like vanilla
    if (this.onGround || this.inWater || this.inLava || freeFlight) this.fallPeakY = this.pos.y
    else this.fallPeakY = Math.max(this.fallPeakY, this.pos.y)

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
        nx = this.vel.x > 0 ? hit.minX - HALF - 0.001 : hit.maxX + HALF + 0.001
        if (this.inWater && this.actionDown('jump') && (this.onGroundOrNear() || this.canClimbLedge(this.vel.x, 0))) {
          this.vel.y = Math.max(this.vel.y, 5.5)
        }
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
        nz = this.vel.z > 0 ? hit.minZ - HALF - 0.001 : hit.maxZ + HALF + 0.001
        if (this.inWater && this.actionDown('jump') && (this.onGroundOrNear() || this.canClimbLedge(0, this.vel.z))) {
          this.vel.y = Math.max(this.vel.y, 5.5)
        }
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
          ny = hit.maxY + 0.001
          this.onGround = true
        } else {
          ny = hit.minY - HEIGHT - 0.001
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
      // Keep the three-block grace, but floor fractional distance so running
      // across uneven terrain cannot turn a 3.1-block drop into damage.
      const fallHeight = this.fallPeakY - this.pos.y
      const raw = fallDamageForHeight(fallHeight)
      if (raw > 0 && !this.inWater) {
        const reduction = Math.min(0.8, Math.max(0, this.featherFallingLevel) * 0.2)
        const dealt = Math.round(raw * (1 - reduction))
        // fall damage ignores armor, like vanilla
        if (dealt > 0) this.damage(dealt, true)
      }
      this.fallSpeedPeak = 0
      this.fallPeakY = this.pos.y
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
  prototype.updateSurvival = function(this: Player, dt: number, startX: number, startZ: number): void {
    if (this.mode !== 'survival' || this.dead) return
    this.damageCooldown = Math.max(0, this.damageCooldown - dt)

    if (this.touchesCactus()) this.damage(1)

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
        // lava and burning are reduced by armor, like vanilla
        this.damage(inLavaNow ? 4 : 1)
      }
    } else if (this.burnTime > 0) {
      // lingering burn after leaving the fire source
      this.burnTime = Math.max(0, this.burnTime - dt)
      this.fireDamageTimer -= dt
      if (this.fireDamageTimer <= 0) {
        this.fireDamageTimer = 1
        this.damage(1)
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
          // drowning ignores armor, like vanilla
          this.damage(2, true)
        }
      }
    } else {
      this.air = Math.min(15, this.air + dt * 4)
      this.drownTimer = 1
    }

    if (this.hunger <= 0 && this.health > 1) {
      this.hungerTimer -= dt
      if (this.hungerTimer <= 0) {
        this.hungerTimer = 4
        // starvation ignores armor, like vanilla
        this.damage(1, true)
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
  prototype.onGroundOrNear = function(this: Player): boolean {
    return this.collides(this.pos.x, this.pos.y - 0.15, this.pos.z) !== null
  }
  prototype.canClimbLedge = function(this: Player, dx: number, dz: number): boolean {
    const px = this.pos.x + Math.sign(dx) * (HALF + 0.05)
    const pz = this.pos.z + Math.sign(dz) * (HALF + 0.05)
    return this.collides(px, this.pos.y + 0.6, pz) === null
  }
  prototype.tryGroundJump = function(this: Player): void {
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
  prototype.syncCamera = function(this: Player, dt: number): void {
    const hSpeed = Math.hypot(this.vel.x, this.vel.z)
    // head bob
    const bobTarget = this.headBobEnabled && this.onGround && hSpeed > 0.5 ? Math.min(1, hSpeed / SPRINT) : 0
    this.bobAmp = lerp(this.bobAmp, bobTarget, clamp(dt * 6, 0, 1))
    if (this.bobAmp > 0.01) this.bobPhase += hSpeed * dt * 1.6
    const bobY = Math.sin(this.bobPhase * 2) * 0.045 * this.bobAmp
    const bobX = Math.cos(this.bobPhase) * 0.03 * this.bobAmp

    this.landDip = Math.max(0, this.landDip - dt * 1.4)
    const dip = this.landDip * Math.sin(Math.min(1, this.landDip * 8) * Math.PI)

    const eyePosition = this.getEyePosition(new THREE.Vector3())
    eyePosition.x += bobX * Math.cos(this.yaw)
    eyePosition.y += bobY - dip
    eyePosition.z += bobX * -Math.sin(this.yaw)
    const hurtRoll = Math.sin(this.hurtTime * Math.PI * 2) * this.hurtTime * 0.055
    if (this.cameraMode === 'first') {
      this.camera.position.copy(eyePosition)
      this.camera.rotation.set(
        this.pitch + Math.sin(this.hurtTime * Math.PI) * 0.012,
        this.yaw,
        Math.sin(this.bobPhase) * 0.006 * this.bobAmp + hurtRoll
      )
    } else {
      const look = this.getLookDirection(new THREE.Vector3())
      const cameraDirection = this.cameraMode === 'third-back' ? look.clone().multiplyScalar(-1) : look
      const distance = 4
      const hit = this.world.raycast(eyePosition, cameraDirection, distance)
      const safeDistance = hit ? Math.max(0.15, hit.dist - 0.18) : distance
      this.camera.position.copy(eyePosition).addScaledVector(cameraDirection, safeDistance)
      this.camera.rotation.set(
        this.cameraMode === 'third-back' ? this.pitch : -this.pitch,
        this.cameraMode === 'third-back' ? this.yaw : this.yaw + Math.PI,
        hurtRoll
      )
    }

    // FOV kick while sprinting/flying fast
    const fovTarget = this.baseFov * (this.sprinting ? (this.flying ? 1.18 : 1.1) : 1)
    this.camera.fov = lerp(this.camera.fov, fovTarget, clamp(dt * 7, 0, 1))
    this.camera.updateProjectionMatrix()
  }
}
