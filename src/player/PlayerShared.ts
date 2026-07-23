import * as THREE from 'three'
import { clamp, lerp } from '../util/math'
import { B, SOUND_CAT, blockCollisionBox, isWater, isLava, fluidLevel } from '../world/Blocks'
import type { World } from '../world/World'
import type { AudioMan } from '../audio/Audio'
import { Settings, type ControlAction, type GameMode } from '../core/Settings'
import { damageAfterArmor } from './Combat'
import { experienceProgress, spendExperienceLevels } from './Experience'
import type { EntityRiderPose } from '../entities/EntityTypes'

export const HALF = 0.3
export const HEIGHT = 1.8
export const EYE = 1.62
export const EYE_CROUCH = 1.45
export const GRAVITY = 27
export const JUMP_V = 8.6
export const WALK = 4.4
export const SPRINT = 6.9
export const CROUCH_SPEED = 2.0
export const SWIM = 3.1
export const FLY = 13
export const FLY_SPRINT = 26
export const WATER_SURFACE = 0.875
export type CameraMode = 'first' | 'third-back' | 'third-front'
export function waterCellHeight(id: number, aboveId: number): number {
  if (!isWater(id)) return 0
  return isWater(aboveId) ? 1 : WATER_SURFACE * (8 - fluidLevel(id)) / 8
}
export interface CollisionHit {
  x: number; y: number; z: number
  minX: number; minY: number; minZ: number
  maxX: number; maxY: number; maxZ: number
}
export const COYOTE_TIME = 0.1
export const JUMP_BUFFER_TIME = 0.13
export function fallDamageForHeight(fallHeight: number): number {
  return Math.max(0, Math.floor(Math.max(0, fallHeight) - 3))
}
