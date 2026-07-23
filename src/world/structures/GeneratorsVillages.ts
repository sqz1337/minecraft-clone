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

export function villageCandidateForRegion(seed: number, regionX: number, regionZ: number): { cx: number; cz: number } {
  const random = mulberry32(hash2(regionX, regionZ, seed ^ VILLAGE_SALT))
  const spread = VILLAGE_SPACING - VILLAGE_SEPARATION
  return {
    cx: regionX * VILLAGE_SPACING + nextInt(random, spread),
    cz: regionZ * VILLAGE_SPACING + nextInt(random, spread)
  }
}
export function villageFootprint(kind: VillageBuildingKind): { halfW: number; halfD: number; height: number } {
  if (kind === 'well') return { halfW: 2, halfD: 2, height: 5 }
  if (kind === 'large_house') return { halfW: 4, halfD: 3, height: 5 }
  if (kind === 'farm') return { halfW: 3, halfD: 2, height: 2 }
  if (kind === 'church') return { halfW: 2, halfD: 4, height: 8 }
  if (kind === 'blacksmith') return { halfW: 4, halfD: 3, height: 5 }
  if (kind === 'library') return { halfW: 3, halfD: 3, height: 5 }
  if (kind === 'hut') return { halfW: 2, halfD: 2, height: 4 }
  return { halfW: 2, halfD: 2, height: 5 }
}
export function buildingBounds(kind: VillageBuildingKind, cx: number, groundY: number, cz: number): BoundingBox3D {
  const shape = villageFootprint(kind)
  return box(cx - shape.halfW, groundY - 2, cz - shape.halfD,
    cx + shape.halfW, groundY + shape.height + 2, cz + shape.halfD)
}
export function roadBounds(
  sampler: StructureTerrainSampler,
  x: number,
  z: number,
  direction: CardinalDirection,
  length: number
): BoundingBox3D {
  const endX = x + dirX(direction) * (length - 1)
  const endZ = z + dirZ(direction) * (length - 1)
  const midX = Math.floor((x + endX) / 2), midZ = Math.floor((z + endZ) / 2)
  const minH = Math.min(sampler.columnInfo(x, z).height, sampler.columnInfo(midX, midZ).height, sampler.columnInfo(endX, endZ).height)
  const maxH = Math.max(sampler.columnInfo(x, z).height, sampler.columnInfo(midX, midZ).height, sampler.columnInfo(endX, endZ).height)
  if (direction === 0 || direction === 1) {
    return box(Math.min(x, endX), minH, z - 1, Math.max(x, endX), maxH + 1, z + 1)
  }
  return box(x - 1, minH, Math.min(z, endZ), x + 1, maxH + 1, Math.max(z, endZ))
}
export function roadFarConnector(road: VillageRoad): { x: number; z: number } {
  // A turned child is three blocks wide. Moving its centre two cells beyond
  // the parent makes the inclusive boxes face-adjacent without overlap.
  if (road.direction === 0) return { x: road.bounds.maxX + 2, z: Math.floor((road.bounds.minZ + road.bounds.maxZ) / 2) }
  if (road.direction === 1) return { x: road.bounds.minX - 2, z: Math.floor((road.bounds.minZ + road.bounds.maxZ) / 2) }
  if (road.direction === 2) return { x: Math.floor((road.bounds.minX + road.bounds.maxX) / 2), z: road.bounds.maxZ + 2 }
  return { x: Math.floor((road.bounds.minX + road.bounds.maxX) / 2), z: road.bounds.minZ - 2 }
}
export function villageDoor(villageId: string, building: VillageBuilding): VillageDoorSpot {
  const shape = villageFootprint(building.kind)
  const x = building.facing === 0 ? building.cx + shape.halfW
    : building.facing === 1 ? building.cx - shape.halfW : building.cx
  const z = building.facing === 4 ? building.cz + shape.halfD
    : building.facing === 5 ? building.cz - shape.halfD : building.cz
  const dx = building.facing === 0 ? 1 : building.facing === 1 ? -1 : 0
  const dz = building.facing === 4 ? 1 : building.facing === 5 ? -1 : 0
  const y = building.groundY + 1
  return {
    key: `${villageId}:${x},${y},${z}`, x, y, z, facing: building.facing,
    inside: { x: x - dx, y, z: z - dz }, outside: { x: x + dx, y, z: z + dz }
  }
}
export function generateVillage(
  seed: number,
  regionX: number,
  regionZ: number,
  sampler: StructureTerrainSampler
): VillagePlan | null {
  const candidate = villageCandidateForRegion(seed, regionX, regionZ)
  const centerX = candidate.cx * CHUNK_SIZE + 8
  const centerZ = candidate.cz * CHUNK_SIZE + 8
  const info = sampler.columnInfo(centerX, centerZ)
  if (info.biome !== 2 && info.biome !== 4) return null
  if (info.height < 42 || info.height > 72) return null
  const random = mulberry32(hash2(candidate.cx, candidate.cz, seed ^ 0x7a11))
  const desert = info.biome === 4
  const id = `village:${regionX},${regionZ}`
  const wellBounds = buildingBounds('well', centerX, info.height, centerZ)
  const well: VillageBuilding = {
    id: `${id}:well`, kind: 'well', parentRoadId: null, cx: centerX, cz: centerZ, groundY: info.height,
    facing: 4, bounds: wellBounds
  }
  const buildings: VillageBuilding[] = [well]
  const roads: VillageRoad[] = []
  const roadQueue: { x: number; z: number; direction: CardinalDirection; depth: number; parentId: string | null }[] = [
    { x: wellBounds.maxX + 1, z: centerZ, direction: 0, depth: 1, parentId: well.id },
    { x: wellBounds.minX - 1, z: centerZ, direction: 1, depth: 1, parentId: well.id },
    { x: centerX, z: wellBounds.maxZ + 1, direction: 2, depth: 1, parentId: well.id },
    { x: centerX, z: wellBounds.minZ - 1, direction: 3, depth: 1, parentId: well.id }
  ]
  let roadSerial = 0
  while (roadQueue.length > 0 && roads.length < 10) {
    const source = roadQueue.shift()!
    if (source.depth > 3) continue
    const length = 18 + nextInt(random, 17)
    const bounds = roadBounds(sampler, source.x, source.z, source.direction, length)
    if (Math.abs(bounds.maxY - bounds.minY) > 7 || roads.some(existing => boxesIntersect(existing.bounds, bounds))) continue
    const road: VillageRoad = {
      id: `${id}:road:${roadSerial++}`, bounds, direction: source.direction,
      depth: source.depth, parentId: source.parentId
    }
    roads.push(road)
    if (source.depth < 3 && random() < 0.75) {
      const far = roadFarConnector(road)
      const direction = random() < 0.5 ? turnLeft(source.direction) : turnRight(source.direction)
      roadQueue.push({ ...far, direction, depth: source.depth + 1, parentId: road.id })
    }
  }
  if (roads.length < 3) return null
  if (!roads.some(road => road.depth > 1)) return null

  const kinds: VillageBuildingKind[] = [
    'house', 'farm', 'hut', 'large_house', 'church', 'house', 'blacksmith', 'library', 'farm', 'house'
  ]
  let buildingSerial = 0
  let kindCursor = 0
  for (const road of roads) {
    const alongX = road.direction === 0 || road.direction === 1
    const length = alongX ? road.bounds.maxX - road.bounds.minX + 1 : road.bounds.maxZ - road.bounds.minZ + 1
    for (let distance = 6; distance < length - 3 && buildingSerial < 18; distance += 7 + nextInt(random, 4)) {
      const roadX = road.direction === 0 ? road.bounds.minX + distance
        : road.direction === 1 ? road.bounds.maxX - distance
          : Math.floor((road.bounds.minX + road.bounds.maxX) / 2)
      const roadZ = road.direction === 2 ? road.bounds.minZ + distance
        : road.direction === 3 ? road.bounds.maxZ - distance
          : Math.floor((road.bounds.minZ + road.bounds.maxZ) / 2)
      const kind = kinds[kindCursor % kinds.length]
      const shape = villageFootprint(kind)
      const side = (buildingSerial + nextInt(random, 2)) % 2 === 0 ? -1 : 1
      // The door's outside cell lands directly on the three-wide road edge.
      const cx = alongX ? roadX : roadX + side * (shape.halfW + 2)
      const cz = alongX ? roadZ + side * (shape.halfD + 2) : roadZ
      const ground = sampler.columnInfo(cx, cz)
      if (ground.height <= 40 || ground.biome === 0 || ground.biome === 7 || Math.abs(ground.height - info.height) > 7) {
        buildingSerial++
        continue
      }
      const facing: DoorFacing = alongX ? (side > 0 ? 5 : 4) : (side > 0 ? 1 : 0)
      const bounds = buildingBounds(kind, cx, ground.height, cz)
      if (buildings.some(existing => horizontalBoxesIntersect(existing.bounds, bounds, 1)) ||
        roads.some(candidateRoad => candidateRoad.id !== road.id && horizontalBoxesIntersect(candidateRoad.bounds, bounds))) {
        buildingSerial++
        continue
      }
      buildings.push({
        id: `${id}:building:${buildingSerial}`, kind, parentRoadId: road.id,
        cx, cz, groundY: ground.height, facing, bounds
      })
      kindCursor++
      buildingSerial++
    }
  }
  if (buildings.length < 5) return null
  if (!buildings.some(building => building.kind === 'church') ||
    !buildings.some(building => building.kind === 'blacksmith') ||
    !buildings.some(building => building.kind === 'library')) return null
  const doors: VillageDoorSpot[] = []
  const villagers: VillagerSpot[] = []
  const chests: StructureChest[] = []
  for (const building of buildings) {
    if (building.kind === 'well' || building.kind === 'farm') continue
    const door = villageDoor(id, building)
    doors.push(door)
    villagers.push({ x: door.inside.x, y: door.y, z: door.inside.z, villageId: id, homeDoorKey: door.key })
    if (building.kind === 'blacksmith') {
      chests.push({ x: building.cx + 1, y: building.groundY + 1, z: building.cz + 1, loot: 'village_blacksmith' })
    }
  }
  if (doors.length === 0) return null
  villagers.push({ x: centerX + 2, y: info.height + 1, z: centerZ, villageId: id, homeDoorKey: doors[0].key })
  const components: StructureComponent[] = [
    component(well.id, 'village_well', well.bounds, 0, null, { desert, groundY: well.groundY }),
    ...roads.map(road => component(road.id, 'village_road', road.bounds, road.depth, road.parentId, {
      direction: road.direction, desert
    })),
    ...buildings.slice(1).map(building => {
      const parentRoad = roads.find(road => road.id === building.parentRoadId)
      return component(
        building.id,
        `village_${building.kind}` as StructureComponentKind,
        building.bounds,
        (parentRoad?.depth ?? 0) + 1,
        building.parentRoadId ?? well.id,
        { desert, groundY: building.groundY }
      )
    })
  ]
  return {
    id, kind: 'village', startCx: candidate.cx, startCz: candidate.cz,
    candidateCx: candidate.cx, candidateCz: candidate.cz,
    centerX, centerY: info.height + 1, centerZ, desert, buildings, roads, doors, villagers,
    bounds: unionBoxes(components.map(part => part.bounds)), components, chests, spawners: []
  }
}
