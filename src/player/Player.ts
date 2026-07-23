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
import { installPlayerState } from './PlayerState'
import { installPlayerMovement } from './PlayerMovement'

export * from './PlayerShared'

export class Player {
  pos = new THREE.Vector3()

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

  cameraMode: CameraMode = 'first'

  health = 20

  hunger = 20

  saturation = 5

  air = 15

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

  world: World

  audio: AudioMan

  keys = new Set<string>()

  bobPhase = 0

  bobAmp = 0

  landDip = 0

  baseFov: number

  stepAccum = 0

  wasInWater = false

  fallSpeedPeak = 0

  fallPeakY = 0

  coyote = 0

  jumpBuffer = 0

  swimStrokeTimer = 0

  damageCooldown = 0

  drownTimer = 1

  hungerTimer = 4

  regenTimer = 4

  fireDamageTimer = 0

  hungerEffectTime = 0

  poisonTime = 0

  poisonTickTimer = 1

  ridingPose: EntityRiderPose | null = null

  burnTime = 0

  dead = false

  hurtTime = 0

  nativeMouseCapture = false

  settings: Settings

  constructor(
      camera: THREE.PerspectiveCamera,
      world: World,
      audio: AudioMan,
      public mode: GameMode = 'creative',
      settings?: Settings
    ) {
      this.camera = camera
      this.world = world
      this.audio = audio
      this.settings = settings ?? new Settings()
      this.baseFov = camera.fov
      camera.rotation.order = 'YXZ'
    }

  get experienceLevel(): number { return experienceProgress(this.experienceTotal).level }

  get experienceFraction(): number { return experienceProgress(this.experienceTotal).fraction }

  get ridingEntityId(): string | null { return this.ridingPose?.id ?? null }

  get wantsDismount(): boolean {
      return this.ridingPose !== null && this.actionDown('crouch')
    }
}

export interface Player {
  attachInput(dom: HTMLElement): void
  setNativeMouseCapture(enabled: boolean): void
  applyNativeMouseDelta(x: number, y: number): void
  applyLookDelta(x: number, y: number): void
  actionDown(action: ControlAction): boolean
  applyViewSettings(): void
  clearKeys(): void
  teleport(x: number, y: number, z: number, yaw?: number, pitch?: number): void
  toggleFly(): boolean
  cycleCamera(): CameraMode
  getLookDirection(target?: THREE.Vector3): THREE.Vector3
  getEyePosition(target?: THREE.Vector3): THREE.Vector3
  restoreSurvival(health?: number, hunger?: number, saturation?: number, air?: number, exhaustion?: number, experience?: number): void
  resetAfterDeath(): void
  addExhaustion(amount: number): void
  addExperience(amount: number): void
  setExperience(total: number): void
  spendExperienceLevels(cost: number): boolean
  eat(hunger: number, saturationModifier: number): boolean
  applyFoodEffect(kind: 'hunger' | 'poison', seconds: number): void
  clearEffects(): void
  syncRidingPose(pose: EntityRiderPose | null): void
  damage(amount: number, bypassArmor?: boolean): boolean
  knockback(sourceX: number, sourceZ: number, power?: number): void
  setNoclip(enabled: boolean): void
  toggleNoclip(): boolean
  eyePos(target: THREE.Vector3): THREE.Vector3
  collides(px: number, py: number, pz: number): CollisionHit | null
  touchesCactus(): boolean
  intersectsBlock(x: number, y: number, z: number): boolean
  blockBelowCat(): string
  update(dt: number): void
  updateSurvival(dt: number, startX: number, startZ: number): void
  onGroundOrNear(): boolean
  canClimbLedge(dx: number, dz: number): boolean
  tryGroundJump(): void
  syncCamera(dt: number): void
}

installPlayerState(Player)
installPlayerMovement(Player)
