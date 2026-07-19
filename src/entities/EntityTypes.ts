export const PASSIVE_KINDS = ['pig', 'cow', 'sheep', 'chicken'] as const
export type PassiveKind = typeof PASSIVE_KINDS[number]

/** Peaceful mobs added by the Overworld stage without changing the original farm-animal registry. */
export const SPECIAL_PASSIVE_KINDS = ['mooshroom'] as const
export type SpecialPassiveKind = typeof SPECIAL_PASSIVE_KINDS[number]
export type PeacefulKind = PassiveKind | SpecialPassiveKind

export const VILLAGER_KINDS = ['villager'] as const
export type VillagerKind = typeof VILLAGER_KINDS[number]
export const VILLAGER_PROFESSIONS = ['farmer', 'librarian', 'blacksmith', 'butcher', 'priest'] as const
export type VillagerProfession = typeof VILLAGER_PROFESSIONS[number]

export const HOSTILE_KINDS = ['zombie', 'skeleton', 'spider', 'creeper', 'slime', 'enderman'] as const
export type HostileKind = typeof HOSTILE_KINDS[number]
export const MOB_KINDS = [...PASSIVE_KINDS, ...SPECIAL_PASSIVE_KINDS, ...VILLAGER_KINDS, ...HOSTILE_KINDS] as const
export type MobKind = typeof MOB_KINDS[number]

export interface SavedEntity {
  id: string
  kind: MobKind
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  health: number
  /** Negative while a passive animal is a growing baby, zero otherwise. */
  age: number
  breedCooldown: number
  eggTimer: number
  attackCooldown?: number
  fuse?: number
  angryTime?: number
  /** Model scale multiplier: 1 for normal mobs, 0.5 for split small slimes. */
  sizeScale?: number
  /** True while a sheep is waiting for its wool to grow back. */
  sheared?: boolean
  woolTimer?: number
  /** Block currently carried by an enderman, or null. */
  carriedBlock?: number | null
  /** Village role and home are present only for generated villagers. */
  profession?: VillagerProfession | null
  homeX?: number
  homeZ?: number
}

export interface EntitySnapshot extends SavedEntity {
  maxHealth: number
  width: number
  height: number
  active: boolean
  inWater: boolean
  onGround: boolean
  loveTime: number
  panicTime: number
  burning: boolean
  sizeScale: number
  sheared: boolean
  carriedBlock: number | null
  profession: VillagerProfession | null
  homeX: number
  homeZ: number
  /** Remaining red damage-flash time in seconds. */
  hurtTime: number
  /** Elapsed death-animation time; zero while alive. */
  deathTime: number
}

export interface EntityDrop {
  id: number
  min: number
  max: number
  chance?: number
}

export interface MobDefinition {
  kind: MobKind
  category: 'passive' | 'villager' | 'hostile'
  maxHealth: number
  width: number
  height: number
  speed: number
  temptingItem: number | null
  attackDamage: number
  followRange: number
  drops: readonly EntityDrop[]
}

export interface PassiveDefinition extends MobDefinition {
  kind: PeacefulKind
  category: 'passive'
  temptingItem: number
}

export interface VillagerDefinition extends MobDefinition {
  kind: VillagerKind
  category: 'villager'
  temptingItem: null
}

export interface HostileDefinition extends MobDefinition {
  kind: HostileKind
  category: 'hostile'
  temptingItem: null
}
