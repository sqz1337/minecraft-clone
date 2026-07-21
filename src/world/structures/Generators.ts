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

type Random = () => number

interface Connector {
  x: number; y: number; z: number
  direction: CardinalDirection
  depth: number
  parentId: string
}

function nextInt(random: Random, bound: number): number {
  return Math.floor(random() * Math.max(1, Math.floor(bound)))
}

function dirX(direction: CardinalDirection): number {
  return direction === 0 ? 1 : direction === 1 ? -1 : 0
}

function dirZ(direction: CardinalDirection): number {
  return direction === 2 ? 1 : direction === 3 ? -1 : 0
}

function turnLeft(direction: CardinalDirection): CardinalDirection {
  return direction === 0 ? 3 : direction === 1 ? 2 : direction === 2 ? 0 : 1
}

function turnRight(direction: CardinalDirection): CardinalDirection {
  return direction === 0 ? 2 : direction === 1 ? 3 : direction === 2 ? 1 : 0
}

function floorDiv(value: number, divisor: number): number { return Math.floor(value / divisor) }

function solid(sampler: StructureTerrainSampler, x: number, y: number, z: number): boolean {
  return y >= 0 && y < WORLD_HEIGHT && sampler.structureSolidAt(x, y, z)
}

function air(sampler: StructureTerrainSampler, x: number, y: number, z: number): boolean {
  return y >= 0 && y < WORLD_HEIGHT && sampler.structureBlockAt(x, y, z) === B.AIR
}

function component(
  id: string,
  kind: StructureComponentKind,
  bounds: BoundingBox3D,
  depth: number,
  parentId: string | null,
  extra: Partial<StructureComponent> = {}
): StructureComponent {
  return { id, kind, bounds, depth, parentId, ...extra }
}

/* ------------------------------------------------------------------------- */
/* Dungeons: eight deterministic attempts against raw post-carver terrain.   */
/* ------------------------------------------------------------------------- */

function dungeonEntrances(
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

/** Raw sequential candidates for one population chunk, before cross-source arbitration. */
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

/* ------------------------------------------------------------------------- */
/* Mineshaft starts and recursive room/corridor/crossing/stairs graph.        */
/* ------------------------------------------------------------------------- */

export function isMineshaftCandidate(seed: number, cx: number, cz: number): boolean {
  const random = mulberry32(hash2(cx, cz, seed ^ 0x315e5e))
  if (nextInt(random, MINESHAFT_CHANCE_DENOMINATOR) !== 0) return false
  return nextInt(random, 80) < Math.max(Math.abs(cx), Math.abs(cz))
}

function mineBoxAhead(connector: Connector, kind: StructureComponentKind, random: Random): BoundingBox3D {
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

function farConnector(bounds: BoundingBox3D, direction: CardinalDirection, y: number, depth: number, parentId: string): Connector {
  if (direction === 0) return { x: bounds.maxX + 1, y, z: Math.floor((bounds.minZ + bounds.maxZ) / 2), direction, depth, parentId }
  if (direction === 1) return { x: bounds.minX - 1, y, z: Math.floor((bounds.minZ + bounds.maxZ) / 2), direction, depth, parentId }
  if (direction === 2) return { x: Math.floor((bounds.minX + bounds.maxX) / 2), y, z: bounds.maxZ + 1, direction, depth, parentId }
  return { x: Math.floor((bounds.minX + bounds.maxX) / 2), y, z: bounds.minZ - 1, direction, depth, parentId }
}

function sideConnector(
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

/* ------------------------------------------------------------------------- */
/* Strongholds: three relocated ring starts and recursive weighted pieces.    */
/* ------------------------------------------------------------------------- */

const STRONGHOLD_BIOMES = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10])

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

function strongholdKind(random: Random, depth: number, portalPlaced: boolean): StructureComponentKind {
  const roll = nextInt(random, portalPlaced ? 92 : 100)
  if (!portalPlaced && depth >= 3 && roll >= 90) return 'stronghold_portal'
  if (roll < 42) return 'stronghold_corridor'
  if (roll < 58) return 'stronghold_crossing'
  if (roll < 70) return 'stronghold_stairs'
  if (roll < 80) return 'stronghold_prison'
  if (roll < 89) return 'stronghold_storage'
  return 'stronghold_library'
}

function strongholdDimensions(kind: StructureComponentKind): { width: number; depth: number; height: number } {
  if (kind === 'stronghold_corridor') return { width: 5, depth: 9, height: 5 }
  if (kind === 'stronghold_crossing') return { width: 9, depth: 9, height: 5 }
  if (kind === 'stronghold_stairs') return { width: 5, depth: 9, height: 7 }
  if (kind === 'stronghold_prison') return { width: 9, depth: 7, height: 5 }
  if (kind === 'stronghold_storage') return { width: 9, depth: 9, height: 5 }
  if (kind === 'stronghold_library') return { width: 13, depth: 9, height: 7 }
  if (kind === 'stronghold_portal') return { width: 13, depth: 13, height: 7 }
  return { width: 7, depth: 7, height: 5 }
}

function orientedBox(connector: Connector, kind: StructureComponentKind): BoundingBox3D {
  const { width, depth, height } = strongholdDimensions(kind)
  const half = width >> 1
  const floor = connector.y - 1
  if (connector.direction === 0) return box(connector.x, floor, connector.z - half, connector.x + depth - 1, floor + height - 1, connector.z + half)
  if (connector.direction === 1) return box(connector.x - depth + 1, floor, connector.z - half, connector.x, floor + height - 1, connector.z + half)
  if (connector.direction === 2) return box(connector.x - half, floor, connector.z, connector.x + half, floor + height - 1, connector.z + depth - 1)
  return box(connector.x - half, floor, connector.z - depth + 1, connector.x + half, floor + height - 1, connector.z)
}

function openingAt(connector: Connector): StrongholdRoom {
  const x1 = connector.x - dirX(connector.direction)
  const z1 = connector.z - dirZ(connector.direction)
  return {
    x0: Math.min(connector.x, x1), z0: Math.min(connector.z, z1),
    x1: Math.max(connector.x, x1), z1: Math.max(connector.z, z1),
    y: connector.y, height: 3
  }
}

function generateStrongholdAttempt(
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

/* ------------------------------------------------------------------------- */
/* Villages: vanilla grid candidates, recursive roads and bounded buildings.  */
/* ------------------------------------------------------------------------- */

export function villageCandidateForRegion(seed: number, regionX: number, regionZ: number): { cx: number; cz: number } {
  const random = mulberry32(hash2(regionX, regionZ, seed ^ VILLAGE_SALT))
  const spread = VILLAGE_SPACING - VILLAGE_SEPARATION
  return {
    cx: regionX * VILLAGE_SPACING + nextInt(random, spread),
    cz: regionZ * VILLAGE_SPACING + nextInt(random, spread)
  }
}

function villageFootprint(kind: VillageBuildingKind): { halfW: number; halfD: number; height: number } {
  if (kind === 'well') return { halfW: 2, halfD: 2, height: 5 }
  if (kind === 'large_house') return { halfW: 4, halfD: 3, height: 5 }
  if (kind === 'farm') return { halfW: 3, halfD: 2, height: 2 }
  if (kind === 'church') return { halfW: 2, halfD: 4, height: 8 }
  if (kind === 'blacksmith') return { halfW: 4, halfD: 3, height: 5 }
  if (kind === 'library') return { halfW: 3, halfD: 3, height: 5 }
  if (kind === 'hut') return { halfW: 2, halfD: 2, height: 4 }
  return { halfW: 2, halfD: 2, height: 5 }
}

function buildingBounds(kind: VillageBuildingKind, cx: number, groundY: number, cz: number): BoundingBox3D {
  const shape = villageFootprint(kind)
  return box(cx - shape.halfW, groundY - 2, cz - shape.halfD,
    cx + shape.halfW, groundY + shape.height + 2, cz + shape.halfD)
}

function roadBounds(
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

function roadFarConnector(road: VillageRoad): { x: number; z: number } {
  // A turned child is three blocks wide. Moving its centre two cells beyond
  // the parent makes the inclusive boxes face-adjacent without overlap.
  if (road.direction === 0) return { x: road.bounds.maxX + 2, z: Math.floor((road.bounds.minZ + road.bounds.maxZ) / 2) }
  if (road.direction === 1) return { x: road.bounds.minX - 2, z: Math.floor((road.bounds.minZ + road.bounds.maxZ) / 2) }
  if (road.direction === 2) return { x: Math.floor((road.bounds.minX + road.bounds.maxX) / 2), z: road.bounds.maxZ + 2 }
  return { x: Math.floor((road.bounds.minX + road.bounds.maxX) / 2), z: road.bounds.minZ - 2 }
}

function villageDoor(villageId: string, building: VillageBuilding): VillageDoorSpot {
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
