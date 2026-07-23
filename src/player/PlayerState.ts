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

export function installPlayerState(PlayerClass: PlayerConstructor): void {
  const prototype = PlayerClass.prototype
  prototype.attachInput = function(this: Player, dom: HTMLElement): void {
    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return
      this.keys.add(e.code)
      if (e.code === this.settings.key('jump')) {
        e.preventDefault()
        if (!e.repeat && !this.flying && !this.noclip && !this.inWater) this.jumpBuffer = JUMP_BUFFER_TIME
      }
    })
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.clearKeys())
    dom.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.nativeMouseCapture || document.pointerLockElement === null) return
      this.applyLookDelta(e.movementX, e.movementY)
    })
  }
  prototype.setNativeMouseCapture = function(this: Player, enabled: boolean): void {
    this.nativeMouseCapture = enabled
  }
  prototype.applyNativeMouseDelta = function(this: Player, x: number, y: number): void {
    if (!this.enabled || !this.nativeMouseCapture) return
    this.applyLookDelta(x, y)
  }
  prototype.applyLookDelta = function(this: Player, x: number, y: number): void {
    const sensitivity = 0.0008 + this.settings.mouseSensitivity * 0.0028
    this.yaw -= x * sensitivity
    this.pitch -= y * sensitivity * (this.settings.invertMouse ? -1 : 1)
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01)
  }
  prototype.actionDown = function(this: Player, action: ControlAction): boolean {
    return this.keys.has(this.settings.key(action))
  }
  prototype.applyViewSettings = function(this: Player): void {
    this.baseFov = this.settings.fov
  }
  prototype.clearKeys = function(this: Player): void {
    this.keys.clear()
    this.jumpBuffer = 0
  }
  prototype.teleport = function(this: Player, x: number, y: number, z: number, yaw = 0, pitch = -0.08): void {
    this.ridingPose = null
    this.pos.set(x, y, z)
    this.vel.set(0, 0, 0)
    this.fallPeakY = y
    this.yaw = yaw
    this.pitch = clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01)
    this.syncCamera(0)
  }
  prototype.toggleFly = function(this: Player): boolean {
    this.flying = !this.flying
    if (this.flying) this.vel.y = 0
    return this.flying
  }
  prototype.cycleCamera = function(this: Player): CameraMode {
    this.cameraMode = this.cameraMode === 'first' ? 'third-back'
      : this.cameraMode === 'third-back' ? 'third-front' : 'first'
    this.syncCamera(0)
    return this.cameraMode
  }
  prototype.getLookDirection = function(this: Player, target = new THREE.Vector3()): THREE.Vector3 {
    const cosPitch = Math.cos(this.pitch)
    return target.set(
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch
    ).normalize()
  }
  prototype.getEyePosition = function(this: Player, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(this.pos.x, this.pos.y + (this.crouching ? EYE_CROUCH : EYE), this.pos.z)
  }
  prototype.restoreSurvival = function(this: Player, health = 20, hunger = 20, saturation = 5, air = 15, exhaustion = 0, experience = 0): void {
    this.health = clamp(health, 1, 20)
    this.hunger = clamp(hunger, 0, 20)
    this.saturation = clamp(saturation, 0, this.hunger)
    this.air = clamp(air, 0, 15)
    this.exhaustion = Math.max(0, exhaustion)
    this.experienceTotal = Math.max(0, Math.floor(experience))
    this.dead = false
    this.onStatsChanged()
    this.onExperienceChanged()
  }
  prototype.resetAfterDeath = function(this: Player): void {
    this.health = 20
    this.hunger = 20
    this.saturation = 5
    this.air = 15
    this.exhaustion = 0
    this.dead = false
    this.damageCooldown = 0
    this.onStatsChanged()
  }
  prototype.addExhaustion = function(this: Player, amount: number): void {
    if (this.mode === 'survival' && !this.noclip) this.exhaustion += Math.max(0, amount)
  }
  prototype.addExperience = function(this: Player, amount: number): void {
    if (this.mode !== 'survival' || !Number.isFinite(amount) || amount <= 0) return
    this.experienceTotal += Math.floor(amount)
    this.onExperienceChanged()
  }
  prototype.setExperience = function(this: Player, total: number): void {
    this.experienceTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0))
    this.onExperienceChanged()
  }
  prototype.spendExperienceLevels = function(this: Player, cost: number): boolean {
    const remaining = spendExperienceLevels(this.experienceTotal, cost)
    if (remaining === null) return false
    this.experienceTotal = remaining
    this.onExperienceChanged()
    return true
  }
  prototype.eat = function(this: Player, hunger: number, saturationModifier: number): boolean {
    if (this.mode !== 'survival' || this.dead || this.hunger >= 20) return false
    this.hunger = Math.min(20, this.hunger + Math.max(0, hunger))
    this.saturation = Math.min(
      this.hunger,
      this.saturation + Math.max(0, hunger * saturationModifier * 2)
    )
    this.onStatsChanged()
    return true
  }
  prototype.applyFoodEffect = function(this: Player, kind: 'hunger' | 'poison', seconds: number): void {
    if (kind === 'hunger') this.hungerEffectTime = Math.max(this.hungerEffectTime, seconds)
    else this.poisonTime = Math.max(this.poisonTime, seconds)
  }
  prototype.clearEffects = function(this: Player): void {
    this.hungerEffectTime = 0
    this.poisonTime = 0
    this.poisonTickTimer = 1
  }
  prototype.syncRidingPose = function(this: Player, pose: EntityRiderPose | null): void {
    if (pose) {
      this.ridingPose = { ...pose }
      this.pos.set(pose.x, pose.y + pose.height * 0.72, pose.z)
      this.vel.set(0, 0, 0)
      this.onGround = false
      this.fallPeakY = this.pos.y
      this.syncCamera(0)
      return
    }
    const previous = this.ridingPose
    if (!previous) return
    this.ridingPose = null
    const sideX = Math.cos(previous.yaw), sideZ = -Math.sin(previous.yaw)
    const forwardX = -Math.sin(previous.yaw), forwardZ = -Math.cos(previous.yaw)
    const candidates = [
      [sideX, sideZ], [-sideX, -sideZ], [forwardX, forwardZ], [-forwardX, -forwardZ]
    ] as const
    const y = previous.y + 0.02
    let placed = false
    for (const [dx, dz] of candidates) {
      const x = previous.x + dx * 1.25, z = previous.z + dz * 1.25
      if (this.collides(x, y, z) || !this.collides(x, y - 0.18, z)) continue
      this.pos.set(x, y, z)
      placed = true
      break
    }
    if (!placed) this.pos.set(previous.x, previous.y + previous.height + 0.02, previous.z)
    this.vel.set(0, 0, 0)
    this.fallPeakY = this.pos.y
    this.syncCamera(0)
  }
  prototype.damage = function(this: Player, amount: number, bypassArmor = false): boolean {
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
  prototype.knockback = function(this: Player, sourceX: number, sourceZ: number, power = 3.2): void {
    const dx = this.pos.x - sourceX, dz = this.pos.z - sourceZ
    const length = Math.hypot(dx, dz) || 1
    this.vel.x += dx / length * power
    this.vel.z += dz / length * power
    this.vel.y = Math.max(this.vel.y, Math.min(4, power * 0.55))
  }
  prototype.setNoclip = function(this: Player, enabled: boolean): void {
    this.noclip = enabled
    this.onGround = false
    this.inWater = false
    this.inLava = false
    this.headUnderwater = false
    this.coyote = 0
    this.jumpBuffer = 0
    this.vel.y = 0
  }
  prototype.toggleNoclip = function(this: Player): boolean {
    this.setNoclip(!this.noclip)
    return this.noclip
  }
  prototype.eyePos = function(this: Player, target: THREE.Vector3): THREE.Vector3 {
    return target.set(this.pos.x, this.pos.y + (this.crouching ? EYE_CROUCH : EYE), this.pos.z)
  }
  prototype.collides = function(this: Player, px: number, py: number, pz: number): CollisionHit | null {
    const playerMinX = px - HALF, playerMaxX = px + HALF
    const playerMinY = py, playerMaxY = py + HEIGHT
    const playerMinZ = pz - HALF, playerMaxZ = pz + HALF
    const x0 = Math.floor(px - HALF), x1 = Math.floor(px + HALF)
    const y0 = Math.floor(py), y1 = Math.floor(py + HEIGHT)
    const z0 = Math.floor(pz - HALF), z1 = Math.floor(pz + HALF)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const facing = this.world.getBlockFacing?.(x, y, z) ?? 4
          const shape = blockCollisionBox(this.world.getBlock(x, y, z), facing)
          if (!shape) continue
          const minX = x + shape.minX, maxX = x + shape.maxX
          const minY = y + shape.minY, maxY = y + shape.maxY
          const minZ = z + shape.minZ, maxZ = z + shape.maxZ
          if (playerMaxX > minX && playerMinX < maxX && playerMaxY > minY && playerMinY < maxY &&
            playerMaxZ > minZ && playerMinZ < maxZ) {
            return { x, y, z, minX, minY, minZ, maxX, maxY, maxZ }
          }
        }
      }
    }
    return null
  }
  prototype.touchesCactus = function(this: Player): boolean {
    const margin = 1 / 64
    const minX = this.pos.x - HALF - margin, maxX = this.pos.x + HALF + margin
    const minY = this.pos.y, maxY = this.pos.y + HEIGHT
    const minZ = this.pos.z - HALF - margin, maxZ = this.pos.z + HALF + margin
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
          if (this.world.getBlock(x, y, z) !== B.CACTUS) continue
          if (maxX > x + 1 / 16 && minX < x + 15 / 16 && maxY > y && minY < y + 1 &&
            maxZ > z + 1 / 16 && minZ < z + 15 / 16) return true
        }
      }
    }
    return false
  }
  prototype.intersectsBlock = function(this: Player, x: number, y: number, z: number): boolean {
    return (
      x + 1 > this.pos.x - HALF && x < this.pos.x + HALF &&
      y + 1 > this.pos.y && y < this.pos.y + HEIGHT &&
      z + 1 > this.pos.z - HALF && z < this.pos.z + HALF
    )
  }
  prototype.blockBelowCat = function(this: Player): string {
    const id = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.4), Math.floor(this.pos.z))
    return SOUND_CAT[id] ?? 'stone'
  }
}
