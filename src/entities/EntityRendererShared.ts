import * as THREE from 'three'
import type { EntitySnapshot, MobKind, VillagerProfession } from './EntityTypes'
import type { Atlas } from '../gfx/Atlas'
import { B, tileFor, type BlockId } from '../world/Blocks'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'

export interface EntityView {
  kind: MobKind | null
  group: THREE.Group
  legs: THREE.Object3D[]
  arms: THREE.Object3D[]
  head: THREE.Object3D
  walkPhase: number
  fromPosition: THREE.Vector3
  targetPosition: THREE.Vector3
  moveElapsed: number
  fromYaw: number
  targetYaw: number
  furParts: THREE.Object3D[]
  saddleParts: THREE.Object3D[]
  wings: THREE.Object3D[]
  tails: THREE.Object3D[]
  tentacles: THREE.Object3D[]
  /** Ordered head-to-tail pieces used by the silverfish body wave. */
  segments: THREE.Object3D[]
  carriedBlock: THREE.Mesh | null
  materials: THREE.MeshLambertMaterial[]
}
export interface BoxUv {
  u: number
  v: number
  width: number
  height: number
  depth: number
}
export const TEXTURE_WIDTH = 64
export const TEXTURE_HEIGHT = 32
export const PROFESSION_TEXTURES: Record<VillagerProfession, string> = {
  farmer: 'farmer.png', librarian: 'librarian.png', blacksmith: 'smith.png',
  butcher: 'butcher.png', priest: 'priest.png'
}
export const MOB_ROOT = `${import.meta.env.BASE_URL}assets/minecraft/mob/`
export const MOVE_SMOOTH_SECONDS = 1 / 20
export type RenderSnapshot = EntitySnapshot & {
  previousX: number
  previousY: number
  previousZ: number
  previousYaw: number
}
