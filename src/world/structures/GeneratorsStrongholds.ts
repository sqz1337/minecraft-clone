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

export const STRONGHOLD_BIOMES = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10])
export function relocateStrongholdCandidate(
  x: number,
  z: number,
  sampler: StructureTerrainSampler
): { x: number; z: number } {
  let best: { x: number; z: number; distance: number } | null = null
  for (let dz = -112; dz <= 112; dz += 16) {
    for (let dx = -112; dx <= 112; dx += 16) {
      const distance = dx * dx + dz * dz
      if (distance > 112 * 112 || (best && distance >= best.distance)) continue
      const sx = x + dx, sz = z + dz
      if (!STRONGHOLD_BIOMES.has(sampler.biomeAt(sx, sz))) continue
      best = { x: sx, z: sz, distance }
    }
  }
  return best ? { x: best.x, z: best.z } : { x, z }
}
export function strongholdKind(random: Random, depth: number, portalPlaced: boolean): StructureComponentKind {
  const roll = nextInt(random, portalPlaced ? 92 : 100)
  if (!portalPlaced && depth >= 3 && roll >= 90) return 'stronghold_portal'
  if (roll < 42) return 'stronghold_corridor'
  if (roll < 58) return 'stronghold_crossing'
  if (roll < 70) return 'stronghold_stairs'
  if (roll < 80) return 'stronghold_prison'
  if (roll < 89) return 'stronghold_storage'
  return 'stronghold_library'
}
export function strongholdDimensions(kind: StructureComponentKind): { width: number; depth: number; height: number } {
  if (kind === 'stronghold_corridor') return { width: 5, depth: 9, height: 5 }
  if (kind === 'stronghold_crossing') return { width: 9, depth: 9, height: 5 }
  if (kind === 'stronghold_stairs') return { width: 5, depth: 9, height: 7 }
  if (kind === 'stronghold_prison') return { width: 9, depth: 7, height: 5 }
  if (kind === 'stronghold_storage') return { width: 9, depth: 9, height: 5 }
  if (kind === 'stronghold_library') return { width: 13, depth: 9, height: 7 }
  if (kind === 'stronghold_portal') return { width: 13, depth: 13, height: 7 }
  return { width: 7, depth: 7, height: 5 }
}
export function orientedBox(connector: Connector, kind: StructureComponentKind): BoundingBox3D {
  const { width, depth, height } = strongholdDimensions(kind)
  const half = width >> 1
  const floor = connector.y - 1
  if (connector.direction === 0) return box(connector.x, floor, connector.z - half, connector.x + depth - 1, floor + height - 1, connector.z + half)
  if (connector.direction === 1) return box(connector.x - depth + 1, floor, connector.z - half, connector.x, floor + height - 1, connector.z + half)
  if (connector.direction === 2) return box(connector.x - half, floor, connector.z, connector.x + half, floor + height - 1, connector.z + depth - 1)
  return box(connector.x - half, floor, connector.z - depth + 1, connector.x + half, floor + height - 1, connector.z)
}
export function openingAt(connector: Connector): StrongholdRoom {
  const x1 = connector.x - dirX(connector.direction)
  const z1 = connector.z - dirZ(connector.direction)
  return {
    x0: Math.min(connector.x, x1), z0: Math.min(connector.z, z1),
    x1: Math.max(connector.x, x1), z1: Math.max(connector.z, z1),
    y: connector.y, height: 3
  }
}
export function generateStrongholdAttempt(
  seed: number,
  index: number,
  originX: number,
  originZ: number,
  attempt: number,
  sampler: StructureTerrainSampler,
  relocatedFrom: { x: number; z: number }
): StrongholdPlan | null {
  const random = mulberry32(hash2(originX ^ Math.imul(index + 1, 0x51ce), originZ, seed ^ attempt ^ 0x570e))
  const surface = sampler.columnInfo(originX, originZ).height
  const y = clamp(surface - 30 + nextInt(random, 9) - 4, 12, 30)
  const startBounds = box(originX - 3, y - 1, originZ - 3, originX + 3, y + 3, originZ + 3)
  const start = component(`stronghold:${index}:${attempt}:0`, 'stronghold_start', startBounds, 0, null)
  const components: StructureComponent[] = [start]
  const openings: StrongholdRoom[] = []
  const queue: Connector[] = [
    { x: startBounds.maxX + 1, y, z: originZ, direction: 0, depth: 1, parentId: start.id },
    { x: startBounds.minX - 1, y, z: originZ, direction: 1, depth: 1, parentId: start.id },
    { x: originX, y, z: startBounds.maxZ + 1, direction: 2, depth: 1, parentId: start.id },
    { x: originX, y, z: startBounds.minZ - 1, direction: 3, depth: 1, parentId: start.id }
  ]
  let serial = 1
  let portalPlaced = false
  while (queue.length > 0 && components.length < 38) {
    const connector = queue.shift()!
    if (connector.depth > 10 || Math.hypot(connector.x - originX, connector.z - originZ) > 120) continue
    const kind = strongholdKind(random, connector.depth, portalPlaced)
    const bounds = orientedBox(connector, kind)
    if (bounds.minY < 5 || bounds.maxY > WORLD_HEIGHT - 5 ||
      components.some(existing => boxesIntersect(existing.bounds, bounds))) continue
    const id = `stronghold:${index}:${attempt}:${serial++}`
    const part = component(id, kind, bounds, connector.depth, connector.parentId, { direction: connector.direction })
    components.push(part)
    openings.push(openingAt(connector))
    if (kind === 'stronghold_portal') portalPlaced = true
    const nextY = kind === 'stronghold_stairs'
      ? clamp(connector.y + (random() < 0.5 ? -2 : 2), 10, 32)
      : connector.y
    if (kind !== 'stronghold_portal') {
      queue.push(farConnector(bounds, connector.direction, nextY, connector.depth + 1, id))
      if (kind === 'stronghold_crossing' || kind === 'stronghold_library' || random() < 0.34) {
        queue.push(sideConnector(bounds, connector.direction, 'left', connector.y, connector.depth + 1, id))
      }
      if (kind === 'stronghold_crossing' || random() < 0.27) {
        queue.push(sideConnector(bounds, connector.direction, 'right', connector.y, connector.depth + 1, id))
      }
    }
  }
  if (!portalPlaced) return null

  const portalParts = components.filter(part => part.kind === 'stronghold_portal')
  if (portalParts.length !== 1) return null
  const portal = portalParts[0]
  const portalY = portal.bounds.minY + 2
  const frameX = Math.floor((portal.bounds.minX + portal.bounds.maxX) / 2)
  const frameZ = Math.floor((portal.bounds.minZ + portal.bounds.maxZ) / 2)
  const framePositions: { x: number; y: number; z: number }[] = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2
    if (edge && !(Math.abs(dx) === 2 && Math.abs(dz) === 2)) framePositions.push({ x: frameX + dx, y: portalY, z: frameZ + dz })
  }
  const bookshelves: { x: number; y: number; z: number }[] = []
  const chests: StructureChest[] = []
  for (const part of components) {
    const cx = Math.floor((part.bounds.minX + part.bounds.maxX) / 2)
    const cz = Math.floor((part.bounds.minZ + part.bounds.maxZ) / 2)
    const feetY = part.bounds.minY + 1
    if (part.kind === 'stronghold_storage') chests.push({ x: cx, y: feetY, z: cz, loot: 'stronghold_storage' })
    if (part.kind === 'stronghold_library') {
      chests.push({ x: part.bounds.minX + 2, y: feetY, z: part.bounds.minZ + 2, loot: 'stronghold_library' })
      chests.push({ x: part.bounds.maxX - 2, y: feetY, z: part.bounds.maxZ - 2, loot: 'stronghold_library' })
      for (let x = part.bounds.minX + 1; x < part.bounds.maxX; x += 2) {
        for (let dy = 1; dy <= 3; dy++) {
          bookshelves.push({ x, y: part.bounds.minY + dy, z: part.bounds.minZ + 1 })
          bookshelves.push({ x, y: part.bounds.minY + dy, z: part.bounds.maxZ - 1 })
        }
      }
    }
  }
  // Keep the established gameplay contract: every stronghold exposes useful loot.
  for (const part of components) {
    if (chests.length >= 4 || part.kind === 'stronghold_portal' || part.kind === 'stronghold_start') continue
    chests.push({
      x: Math.floor((part.bounds.minX + part.bounds.maxX) / 2), y: part.bounds.minY + 1,
      z: Math.floor((part.bounds.minZ + part.bounds.maxZ) / 2), loot: 'stronghold_storage'
    })
  }
  const spawner: StructureSpawner = {
    x: portal.bounds.minX + 2, y: portal.bounds.minY + 1,
    z: Math.floor((portal.bounds.minZ + portal.bounds.maxZ) / 2), mob: 'silverfish'
  }
  const rooms: StrongholdRoom[] = components.map(part => ({
    x0: part.bounds.minX, z0: part.bounds.minZ, x1: part.bounds.maxX, z1: part.bounds.maxZ,
    y: part.bounds.minY + 1, height: part.bounds.maxY - part.bounds.minY + 1
  }))
  return {
    id: `stronghold:${index}`, kind: 'stronghold', startCx: floorDiv(originX, CHUNK_SIZE), startCz: floorDiv(originZ, CHUNK_SIZE),
    bounds: unionBoxes(components.map(part => part.bounds)), components, rooms, openings, bookshelves,
    framePositions, spawner, spawners: [spawner], chests, portalRoomCount: 1,
    generationAttempts: attempt + 1, relocatedFrom
  }
}
export function generateStrongholds(seed: number, sampler: StructureTerrainSampler): StrongholdPlan[] {
  const out: StrongholdPlan[] = []
  const baseAngle = (seed % 6283) / 1000
  for (let index = 0; index < 3; index++) {
    const ringRandom = mulberry32(seed ^ Math.imul(index + 1, 0x9e3779b1))
    const angle = baseAngle + index * Math.PI * 2 / 3 + (ringRandom() - 0.5) * 0.35
    const distance = 640 + ringRandom() * 512
    const raw = { x: Math.round(Math.cos(angle) * distance), z: Math.round(Math.sin(angle) * distance) }
    const relocated = relocateStrongholdCandidate(raw.x, raw.z, sampler)
    let plan: StrongholdPlan | null = null
    // A start is discarded and replayed until its weighted graph owns one portal room.
    for (let attempt = 0; attempt < 256 && !plan; attempt++) {
      plan = generateStrongholdAttempt(seed, index, relocated.x, relocated.z, attempt, sampler, raw)
    }
    if (!plan) throw new Error(`Unable to create portal room for stronghold ${index}`)
    out.push(plan)
  }
  return out
}
