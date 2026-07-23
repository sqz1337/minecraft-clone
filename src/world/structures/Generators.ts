import { B, SOLID } from '../Blocks'
import { CHUNK_SIZE, WORLD_HEIGHT } from '../Chunk'
import { clamp, hash2, mulberry32 } from '../../util/math'
import {
  box,
  boxesIntersect,
  horizontalBoxesIntersect,
  unionBoxes,
  type BoundingBox3D
} from './Bounds'
import type {
  CardinalDirection,
  DoorFacing,
  DungeonPlan,
  MineSegment,
  MineshaftPlan,
  StrongholdPlan,
  StrongholdRoom,
  StructureChest,
  StructureComponent,
  StructureComponentKind,
  StructureSpawner,
  StructureTerrainSampler,
  VillageBuilding,
  VillageBuildingKind,
  VillageDoorSpot,
  VillagePlan,
  VillageRoad,
  VillagerSpot
} from './Types'
import { VILLAGE_SPACING, VILLAGE_SEPARATION, VILLAGE_SALT, MINESHAFT_CHANCE_DENOMINATOR, Random, Connector, nextInt, dirX, dirZ, turnLeft, turnRight, floorDiv, solid, air, component, dungeonEntrances, generateDungeonCandidates, dungeonPriority, dungeonPrecedes, isMineshaftCandidate, mineBoxAhead, farConnector, sideConnector, generateMineshaft } from './GeneratorsShared'
import { STRONGHOLD_BIOMES, relocateStrongholdCandidate, strongholdKind, strongholdDimensions, orientedBox, openingAt, generateStrongholdAttempt, generateStrongholds } from './GeneratorsStrongholds'
import { villageCandidateForRegion, villageFootprint, buildingBounds, roadBounds, roadFarConnector, villageDoor, generateVillage } from './GeneratorsVillages'

export * from './GeneratorsShared'
export * from './GeneratorsStrongholds'
export * from './GeneratorsVillages'
