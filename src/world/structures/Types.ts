import type { BoundingBox3D } from './Bounds'

export type StructureKind = 'dungeon' | 'mineshaft' | 'stronghold' | 'village'
export type StructureMob = 'zombie' | 'skeleton' | 'spider' | 'silverfish'
export type StructureLoot =
  | 'dungeon'
  | 'mineshaft'
  | 'stronghold_storage'
  | 'stronghold_library'
  | 'village_house'
  | 'village_blacksmith'

export type CardinalDirection = 0 | 1 | 2 | 3
export type DoorFacing = 0 | 1 | 4 | 5

export interface StructureChest {
  x: number; y: number; z: number
  loot: StructureLoot
}

export interface StructureSpawner { x: number; y: number; z: number; mob: StructureMob }

export interface VillageDoorSpot {
  key: string
  x: number; y: number; z: number
  facing: DoorFacing
  inside: { x: number; y: number; z: number }
  outside: { x: number; y: number; z: number }
}

export interface VillageInfo {
  id: string
  centerX: number; centerY: number; centerZ: number
  radius: number
  doors: VillageDoorSpot[]
}

export interface VillagerSpot {
  x: number; y: number; z: number
  villageId: string
  homeDoorKey: string
}

export type StructureComponentKind =
  | 'dungeon_room'
  | 'mineshaft_room'
  | 'mineshaft_corridor'
  | 'mineshaft_crossing'
  | 'mineshaft_stairs'
  | 'stronghold_start'
  | 'stronghold_corridor'
  | 'stronghold_crossing'
  | 'stronghold_stairs'
  | 'stronghold_prison'
  | 'stronghold_storage'
  | 'stronghold_library'
  | 'stronghold_portal'
  | 'village_well'
  | 'village_road'
  | 'village_house'
  | 'village_large_house'
  | 'village_farm'
  | 'village_church'
  | 'village_blacksmith'
  | 'village_library'
  | 'village_hut'

/** Pure component descriptor: plans contain no callbacks or loaded-chunk state. */
export interface StructureComponent {
  id: string
  kind: StructureComponentKind
  bounds: BoundingBox3D
  depth: number
  parentId: string | null
  direction?: CardinalDirection
  rails?: boolean
  desert?: boolean
  groundY?: number
}

export interface BaseStructurePlan {
  id: string
  kind: StructureKind
  startCx: number
  startCz: number
  bounds: BoundingBox3D
  components: StructureComponent[]
  chests: StructureChest[]
  spawners: StructureSpawner[]
}

export interface DungeonPlan extends BaseStructurePlan {
  kind: 'dungeon'
  x0: number; z0: number; w: number; d: number
  /** Interior floor/feet level. The structural floor is floorY - 1. */
  floorY: number
  mob: Exclude<StructureMob, 'silverfish'>
  spawner: StructureSpawner
  entrances: BoundingBox3D[]
  attempt: number
  validation: { solidFloor: boolean; solidCeiling: boolean; entranceCount: number; caveContact: boolean }
}

export interface MineSegment {
  x0: number; x1: number; z0: number; z1: number
  y: number
  axis: 'x' | 'z'
  rails: boolean
}

export interface MineshaftPlan extends BaseStructurePlan {
  kind: 'mineshaft'
  segments: MineSegment[]
  openings: BoundingBox3D[]
  candidateDistance: number
}

export interface StrongholdRoom {
  x0: number; z0: number; x1: number; z1: number
  y: number
  height: number
}

export interface StrongholdPlan extends BaseStructurePlan {
  kind: 'stronghold'
  rooms: StrongholdRoom[]
  openings: StrongholdRoom[]
  bookshelves: { x: number; y: number; z: number }[]
  framePositions: { x: number; y: number; z: number }[]
  spawner: StructureSpawner
  portalRoomCount: number
  generationAttempts: number
  relocatedFrom: { x: number; z: number }
}

export type VillageBuildingKind =
  | 'well'
  | 'house'
  | 'large_house'
  | 'farm'
  | 'church'
  | 'blacksmith'
  | 'library'
  | 'hut'

export interface VillageBuilding {
  id: string
  kind: VillageBuildingKind
  parentRoadId: string | null
  cx: number; cz: number
  groundY: number
  facing: DoorFacing
  bounds: BoundingBox3D
}

export interface VillageRoad {
  id: string
  bounds: BoundingBox3D
  direction: CardinalDirection
  depth: number
  parentId: string | null
}

export interface VillagePlan extends BaseStructurePlan {
  kind: 'village'
  centerX: number; centerZ: number
  centerY: number
  desert: boolean
  candidateCx: number; candidateCz: number
  buildings: VillageBuilding[]
  roads: VillageRoad[]
  doors: VillageDoorSpot[]
  villagers: VillagerSpot[]
}

export type StructurePlan = DungeonPlan | MineshaftPlan | StrongholdPlan | VillagePlan

export interface StructureTerrainSampler {
  baseBlockAt(x: number, y: number, z: number): number
  /** Raw terrain after map carvers/lakes, before ores, decorators and structures. */
  structureBlockAt(x: number, y: number, z: number): number
  structureSolidAt(x: number, y: number, z: number): boolean
  biomeAt(x: number, z: number): number
  columnInfo(x: number, z: number): { height: number; biome: number }
}
