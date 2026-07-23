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

export const VILLAGE_SPACING = 32
export const VILLAGE_SEPARATION = 8
export const VILLAGE_SALT = 10387312
export const MINESHAFT_CHANCE_DENOMINATOR = 100
export type Random = () => number
export interface Connector {
  x: number; y: number; z: number
  direction: CardinalDirection
  depth: number
  parentId: string
}
export function nextInt(random: Random, bound: number): number {
  return Math.floor(random() * Math.max(1, Math.floor(bound)))
}
export function dirX(direction: CardinalDirection): number {
  return direction === 0 ? 1 : direction === 1 ? -1 : 0
}
export function dirZ(direction: CardinalDirection): number {
  return direction === 2 ? 1 : direction === 3 ? -1 : 0
}
export function turnLeft(direction: CardinalDirection): CardinalDirection {
  return direction === 0 ? 3 : direction === 1 ? 2 : direction === 2 ? 0 : 1
}
export function turnRight(direction: CardinalDirection): CardinalDirection {
  return direction === 0 ? 2 : direction === 1 ? 3 : direction === 2 ? 1 : 0
}
export function floorDiv(value: number, divisor: number): number { return Math.floor(value / divisor) }
export function solid(sampler: StructureTerrainSampler, x: number, y: number, z: number): boolean {
  return y >= 0 && y < WORLD_HEIGHT && sampler.structureSolidAt(x, y, z)
}
export function air(sampler: StructureTerrainSampler, x: number, y: number, z: number): boolean {
  return y >= 0 && y < WORLD_HEIGHT && sampler.structureBlockAt(x, y, z) === B.AIR
}
export function component(
  id: string,
  kind: StructureComponentKind,
  bounds: BoundingBox3D,
  depth: number,
  parentId: string | null,
  extra: Partial<StructureComponent> = {}
): StructureComponent {
  return { id, kind, bounds, depth, parentId, ...extra }
}
export function dungeonEntrances(
  sampler: StructureTerrainSampler,
  x0: number,
  z0: number,
  w: number,
  d: number,
  floorY: number
): BoundingBox3D[] {
  const candidates: BoundingBox3D[] = []
  for (let x = x0 + 1; x < x0 + w - 1; x++) {
    if (air(sampler, x, floorY, z0 - 1) && air(sampler, x, floorY + 1, z0 - 1)) {
      candidates.push(box(x, floorY, z0, x, floorY + 1, z0))
    }
    if (air(sampler, x, floorY, z0 + d) && air(sampler, x, floorY + 1, z0 + d)) {
      candidates.push(box(x, floorY, z0 + d - 1, x, floorY + 1, z0 + d - 1))
    }
  }
  for (let z = z0 + 1; z < z0 + d - 1; z++) {
    if (air(sampler, x0 - 1, floorY, z) && air(sampler, x0 - 1, floorY + 1, z)) {
      candidates.push(box(x0, floorY, z, x0, floorY + 1, z))
    }
    if (air(sampler, x0 + w, floorY, z) && air(sampler, x0 + w, floorY + 1, z)) {
      candidates.push(box(x0 + w - 1, floorY, z, x0 + w - 1, floorY + 1, z))
    }
  }
  return candidates
}
export function generateDungeonCandidates(
  seed: number,
  sourceCx: number,
  sourceCz: number,
  sampler: StructureTerrainSampler
): DungeonPlan[] {
  const random = mulberry32(hash2(sourceCx, sourceCz, seed ^ 0xd06e07))
  const plans: DungeonPlan[] = []
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = nextInt(random, 2) * 2 + 7
    const d = nextInt(random, 2) * 2 + 7
    const centerX = sourceCx * CHUNK_SIZE + nextInt(random, CHUNK_SIZE)
    const centerZ = sourceCz * CHUNK_SIZE + nextInt(random, CHUNK_SIZE)
    const x0 = centerX - (w >> 1)
    const z0 = centerZ - (d >> 1)
    // Classic WorldGenDungeons samples nextInt(128); unsuitable heights are
    // rejected by the shell checks instead of biasing every attempt underground.
    const floorY = nextInt(random, WORLD_HEIGHT)

    let solidFloor = true
    let solidCeiling = true
    for (let x = x0; x < x0 + w && (solidFloor || solidCeiling); x++) {
      for (let z = z0; z < z0 + d; z++) {
        if (!solid(sampler, x, floorY - 1, z)) solidFloor = false
        if (!solid(sampler, x, floorY + 3, z)) solidCeiling = false
      }
    }
    if (!solidFloor || !solidCeiling) continue
    const entrances = dungeonEntrances(sampler, x0, z0, w, d, floorY)
    if (entrances.length < 1 || entrances.length > 5) continue

    const mobRoll = nextInt(random, 4)
    const mob: DungeonPlan['mob'] = mobRoll < 2 ? 'zombie' : mobRoll === 2 ? 'skeleton' : 'spider'
    const chests: StructureChest[] = []
    // Vanilla makes two placement attempts and accepts cells with one solid neighbour.
    for (let chestAttempt = 0; chestAttempt < 2; chestAttempt++) {
      for (let probe = 0; probe < 8; probe++) {
        const x = x0 + 1 + nextInt(random, w - 2)
        const z = z0 + 1 + nextInt(random, d - 2)
        const neighbourWalls = Number(x === x0 + 1) + Number(x === x0 + w - 2) +
          Number(z === z0 + 1) + Number(z === z0 + d - 2)
        if (neighbourWalls !== 1 || (x === centerX && z === centerZ) ||
          chests.some(chest => chest.x === x && chest.z === z)) continue
        chests.push({ x, y: floorY, z, loot: 'dungeon' })
        break
      }
    }
    const spawner: StructureSpawner = { x: centerX, y: floorY, z: centerZ, mob }
    const bounds = box(x0, floorY - 1, z0, x0 + w - 1, floorY + 3, z0 + d - 1)
    // Accepted attempts are sequential population: a later room cannot occupy
    // the shell already reserved by an earlier accepted room in this chunk.
    if (plans.some(existing => boxesIntersect(existing.bounds, bounds))) continue
    plans.push({
      id: `dungeon:${sourceCx},${sourceCz}:${attempt}`,
      kind: 'dungeon', startCx: sourceCx, startCz: sourceCz,
      bounds,
      components: [component(`dungeon:${sourceCx},${sourceCz}:${attempt}:room`, 'dungeon_room', bounds, 0, null)],
      x0, z0, w, d, floorY, mob, spawner, spawners: [spawner], chests, entrances, attempt,
      validation: { solidFloor, solidCeiling, entranceCount: entrances.length, caveContact: true }
    })
  }
  return plans
}
export function dungeonPriority(seed: number, plan: DungeonPlan): number {
  return hash2(plan.startCx ^ Math.imul(plan.attempt + 1, 0x51ce), plan.startCz, seed ^ 0xd06e07)
}
export function dungeonPrecedes(seed: number, a: DungeonPlan, b: DungeonPlan): boolean {
  const aPriority = dungeonPriority(seed, a), bPriority = dungeonPriority(seed, b)
  return aPriority < bPriority || (aPriority === bPriority && a.id < b.id)
}
export function isMineshaftCandidate(seed: number, cx: number, cz: number): boolean {
  const random = mulberry32(hash2(cx, cz, seed ^ 0x315e5e))
  if (nextInt(random, MINESHAFT_CHANCE_DENOMINATOR) !== 0) return false
  return nextInt(random, 80) < Math.max(Math.abs(cx), Math.abs(cz))
}
export function mineBoxAhead(connector: Connector, kind: StructureComponentKind, random: Random): BoundingBox3D {
  const corridor = kind === 'mineshaft_corridor'
  const crossing = kind === 'mineshaft_crossing'
  const length = corridor ? 10 + nextInt(random, 12) : crossing ? 7 : 10
  const halfWidth = crossing ? 3 : 1
  const endY = kind === 'mineshaft_stairs' ? connector.y + (random() < 0.55 ? -3 : 3) : connector.y
  const minY = Math.min(connector.y, endY) - 1
  const maxY = Math.max(connector.y, endY) + (crossing ? 3 : 2)
  if (connector.direction === 0) return box(connector.x, minY, connector.z - halfWidth, connector.x + length - 1, maxY, connector.z + halfWidth)
  if (connector.direction === 1) return box(connector.x - length + 1, minY, connector.z - halfWidth, connector.x, maxY, connector.z + halfWidth)
  if (connector.direction === 2) return box(connector.x - halfWidth, minY, connector.z, connector.x + halfWidth, maxY, connector.z + length - 1)
  return box(connector.x - halfWidth, minY, connector.z - length + 1, connector.x + halfWidth, maxY, connector.z)
}
export function farConnector(bounds: BoundingBox3D, direction: CardinalDirection, y: number, depth: number, parentId: string): Connector {
  if (direction === 0) return { x: bounds.maxX + 1, y, z: Math.floor((bounds.minZ + bounds.maxZ) / 2), direction, depth, parentId }
  if (direction === 1) return { x: bounds.minX - 1, y, z: Math.floor((bounds.minZ + bounds.maxZ) / 2), direction, depth, parentId }
  if (direction === 2) return { x: Math.floor((bounds.minX + bounds.maxX) / 2), y, z: bounds.maxZ + 1, direction, depth, parentId }
  return { x: Math.floor((bounds.minX + bounds.maxX) / 2), y, z: bounds.minZ - 1, direction, depth, parentId }
}
export function sideConnector(
  bounds: BoundingBox3D,
  direction: CardinalDirection,
  side: 'left' | 'right',
  y: number,
  depth: number,
  parentId: string
): Connector {
  const next = side === 'left' ? turnLeft(direction) : turnRight(direction)
  const cx = Math.floor((bounds.minX + bounds.maxX) / 2)
  const cz = Math.floor((bounds.minZ + bounds.maxZ) / 2)
  if (next === 0) return { x: bounds.maxX + 1, y, z: cz, direction: next, depth, parentId }
  if (next === 1) return { x: bounds.minX - 1, y, z: cz, direction: next, depth, parentId }
  if (next === 2) return { x: cx, y, z: bounds.maxZ + 1, direction: next, depth, parentId }
  return { x: cx, y, z: bounds.minZ - 1, direction: next, depth, parentId }
}
export function generateMineshaft(
  seed: number,
  startCx: number,
  startCz: number,
  sampler: StructureTerrainSampler
): MineshaftPlan | null {
  if (!isMineshaftCandidate(seed, startCx, startCz)) return null
  const random = mulberry32(hash2(startCx, startCz, seed ^ 0x51ce))
  const centerX = startCx * CHUNK_SIZE + 8
  const centerZ = startCz * CHUNK_SIZE + 8
  const y = clamp(12 + nextInt(random, 18), 10, Math.min(34, sampler.columnInfo(centerX, centerZ).height - 10))
  const roomBounds = box(centerX - 4, y - 1, centerZ - 4, centerX + 4, y + 3, centerZ + 4)
  const room = component(`mineshaft:${startCx},${startCz}:0`, 'mineshaft_room', roomBounds, 0, null)
  const components: StructureComponent[] = [room]
  const openings: BoundingBox3D[] = []
  const chests: StructureChest[] = []
  const spawners: StructureSpawner[] = []
  const queue: Connector[] = [
    { x: roomBounds.maxX + 1, y, z: centerZ, direction: 0, depth: 1, parentId: room.id },
    { x: roomBounds.minX - 1, y, z: centerZ, direction: 1, depth: 1, parentId: room.id },
    { x: centerX, y, z: roomBounds.maxZ + 1, direction: 2, depth: 1, parentId: room.id },
    { x: centerX, y, z: roomBounds.minZ - 1, direction: 3, depth: 1, parentId: room.id }
  ]
  let pieceIndex = 1
  while (queue.length > 0 && components.length < 34) {
    const connector = queue.shift()!
    if (connector.depth > 8 || Math.hypot(connector.x - centerX, connector.z - centerZ) > 88) continue
    let kind: StructureComponentKind
    // Make every accepted graph recognisable before switching to weighted recursion.
    if (pieceIndex === 1) kind = 'mineshaft_corridor'
    else if (pieceIndex === 2) kind = 'mineshaft_crossing'
    else if (pieceIndex === 3) kind = 'mineshaft_stairs'
    else {
      const roll = random()
      kind = roll < 0.68 ? 'mineshaft_corridor' : roll < 0.84 ? 'mineshaft_crossing' : 'mineshaft_stairs'
    }
    const bounds = mineBoxAhead(connector, kind, random)
    if (bounds.minY < 5 || bounds.maxY >= WORLD_HEIGHT - 4 || components.some(existing => boxesIntersect(existing.bounds, bounds))) continue
    const id = `mineshaft:${startCx},${startCz}:${pieceIndex++}`
    const rails = kind === 'mineshaft_corridor' && random() < 0.64
    components.push(component(id, kind, bounds, connector.depth, connector.parentId, {
      direction: connector.direction, rails
    }))
    const parentX = connector.x - dirX(connector.direction)
    const parentZ = connector.z - dirZ(connector.direction)
    openings.push(box(
      Math.min(parentX, connector.x), connector.y, Math.min(parentZ, connector.z),
      Math.max(parentX, connector.x), connector.y + 2, Math.max(parentZ, connector.z)
    ))
    const endY = kind === 'mineshaft_stairs'
      ? (bounds.minY < connector.y - 1 ? connector.y - 3 : connector.y + 3)
      : connector.y
    queue.push(farConnector(bounds, connector.direction, endY, connector.depth + 1, id))
    if (kind === 'mineshaft_crossing' || random() < 0.34) {
      queue.push(sideConnector(bounds, connector.direction, 'left', connector.y, connector.depth + 1, id))
    }
    if (kind === 'mineshaft_crossing' || random() < 0.22) {
      queue.push(sideConnector(bounds, connector.direction, 'right', connector.y, connector.depth + 1, id))
    }
    if (kind === 'mineshaft_corridor' && random() < 0.22) {
      const x = Math.floor((bounds.minX + bounds.maxX) / 2)
      const z = Math.floor((bounds.minZ + bounds.maxZ) / 2)
      chests.push({ x, y: connector.y, z, loot: 'mineshaft' })
    }
  }
  if (components.length < 4) return null
  const segments: MineSegment[] = components
    .filter(part => part.kind === 'mineshaft_corridor' || part.kind === 'mineshaft_stairs')
    .map(part => ({
      x0: part.bounds.minX, x1: part.bounds.maxX, z0: part.bounds.minZ, z1: part.bounds.maxZ,
      y: part.bounds.minY + 1,
      axis: part.direction === 0 || part.direction === 1 ? 'x' : 'z',
      rails: !!part.rails
    }))
  return {
    id: `mineshaft:${startCx},${startCz}`, kind: 'mineshaft', startCx, startCz,
    bounds: unionBoxes(components.map(part => part.bounds)), components, openings, chests, spawners, segments,
    candidateDistance: Math.max(Math.abs(startCx), Math.abs(startCz))
  }
}
