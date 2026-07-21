import { isLava, isWater as isWaterBlock } from '../world/Blocks'

export type NavTerrain = 'ground' | 'water' | 'door'

/** Integer node coordinates: x/z are the minimum footprint cell, y is feet height. */
export interface NavNode {
  x: number
  y: number
  z: number
  terrain: NavTerrain
}

export interface NavProfile {
  width: number
  height: number
  maxStep: number
  maxFall: number
  canSwim: boolean
  canOpenDoors: boolean
  waterCost: number
  maxVisited?: number
  maxDistance?: number
}

export interface NavigationWorld {
  getBlock(x: number, y: number, z: number): number
  isSolid(x: number, y: number, z: number): boolean
  isWater(x: number, y: number, z: number): boolean
  doorState?(x: number, y: number, z: number): 'open' | 'closed' | null
}

interface NodeInspection {
  blocked: boolean
  supported: boolean
  water: boolean
  door: boolean
}

interface SearchRecord {
  node: NavNode
  g: number
  f: number
  parent: string | null
}

class MinHeap {
  private values: SearchRecord[] = []

  get size(): number { return this.values.length }

  push(value: SearchRecord): void {
    let index = this.values.push(value) - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.values[parent].f <= value.f) break
      this.values[index] = this.values[parent]
      index = parent
    }
    this.values[index] = value
  }

  pop(): SearchRecord | null {
    const first = this.values[0]
    const last = this.values.pop()
    if (!first || !last || this.values.length === 0) return first ?? null
    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= this.values.length) break
      const right = left + 1
      const child = right < this.values.length && this.values[right].f < this.values[left].f ? right : left
      if (this.values[child].f >= last.f) break
      this.values[index] = this.values[child]
      index = child
    }
    this.values[index] = last
    return first
  }
}

const keyOf = (node: Pick<NavNode, 'x' | 'y' | 'z'>): string => `${node.x},${node.y},${node.z}`

function footprint(profile: NavProfile): { span: number; height: number } {
  return {
    span: Math.max(1, Math.ceil(profile.width - 1e-6)),
    height: Math.max(1, Math.ceil(profile.height - 1e-6))
  }
}

/** Converts an entity/world center to the integer footprint anchor used by A*. */
export function nodeForPosition(x: number, y: number, z: number, profile: NavProfile): NavNode {
  const { span } = footprint(profile)
  return {
    x: Math.floor(x - span * 0.5 + 1e-5),
    y: Math.floor(y + 0.05),
    z: Math.floor(z - span * 0.5 + 1e-5),
    terrain: 'ground'
  }
}

export function nodeCenter(node: NavNode, profile: NavProfile): { x: number; y: number; z: number } {
  const { span } = footprint(profile)
  return { x: node.x + span * 0.5, y: node.y, z: node.z + span * 0.5 }
}

function inspectNode(world: NavigationWorld, node: Pick<NavNode, 'x' | 'y' | 'z'>, profile: NavProfile): NodeInspection {
  const { span, height } = footprint(profile)
  let water = false
  let door = false
  for (let x = node.x; x < node.x + span; x++) {
    for (let y = node.y; y < node.y + height; y++) {
      for (let z = node.z; z < node.z + span; z++) {
        const id = world.getBlock(x, y, z)
        if (isLava(id)) return { blocked: true, supported: false, water: false, door: false }
        const doorState = world.doorState?.(x, y, z) ?? null
        if (doorState) {
          door = true
          if (doorState === 'closed') {
            if (!profile.canOpenDoors) return { blocked: true, supported: false, water: false, door: false }
          }
          continue
        }
        if (world.isSolid(x, y, z)) return { blocked: true, supported: false, water: false, door: false }
        if (world.isWater(x, y, z) || isWaterBlock(id)) water = true
      }
    }
  }

  let supported = true
  for (let x = node.x; x < node.x + span; x++) {
    for (let z = node.z; z < node.z + span; z++) {
      const id = world.getBlock(x, node.y - 1, z)
      if (!world.isSolid(x, node.y - 1, z) || isLava(id) || isWaterBlock(id)) supported = false
    }
  }
  return { blocked: false, supported, water, door }
}

/** Returns the same node with classified terrain, or null when its full volume is invalid. */
export function canOccupyNode(
  world: NavigationWorld,
  node: Pick<NavNode, 'x' | 'y' | 'z'>,
  profile: NavProfile
): NavNode | null {
  if (node.y < 1 || node.y + Math.ceil(profile.height) > 128) return null
  const inspected = inspectNode(world, node, profile)
  if (inspected.blocked) return null
  if (inspected.water) {
    if (!profile.canSwim) return null
    return { ...node, terrain: inspected.door ? 'door' : 'water' }
  }
  if (!inspected.supported) return null
  return { ...node, terrain: inspected.door ? 'door' : 'ground' }
}

function heuristic(a: Pick<NavNode, 'x' | 'y' | 'z'>, b: Pick<NavNode, 'x' | 'y' | 'z'>): number {
  // A vertical block adds only 0.25 to one horizontal transition, so a larger
  // coefficient would overestimate and break A* optimality with a closed set.
  return Math.abs(a.x - b.x) + Math.abs(a.z - b.z) + Math.abs(a.y - b.y) * 0.25
}

function transitionCost(from: NavNode, to: NavNode, profile: NavProfile): number {
  let cost = 1 + Math.abs(to.y - from.y) * 0.25
  if (to.terrain === 'water') cost += Math.max(0, profile.waterCost)
  if (to.terrain === 'door') cost += 1.25
  return cost
}

function neighborAt(
  world: NavigationWorld,
  current: NavNode,
  dx: number,
  dz: number,
  profile: NavProfile
): NavNode | null {
  const base = { x: current.x + dx, y: current.y, z: current.z + dz }
  const same = canOccupyNode(world, base, profile)
  if (same) return same

  for (let step = 1; step <= profile.maxStep; step++) {
    const raised = canOccupyNode(world, { ...base, y: current.y + step }, profile)
    if (raised) return raised
  }

  // Falling is legal only when the lateral body volume itself is clear. A wall
  // must not be bypassed by discovering a floor somewhere underneath it.
  const lateral = inspectNode(world, base, profile)
  if (lateral.blocked) return null
  for (let fall = 1; fall <= profile.maxFall; fall++) {
    const swept = inspectNode(world, { ...base, y: current.y - fall }, profile)
    if (swept.blocked || (swept.water && !profile.canSwim)) return null
    const lowered = canOccupyNode(world, { ...base, y: current.y - fall }, profile)
    if (lowered) return lowered
  }
  return null
}

/** Bounded four-neighbour A*; returns start→goal (inclusive) or null. */
export function findPath(
  world: NavigationWorld,
  startInput: NavNode,
  goalInput: NavNode,
  profile: NavProfile
): NavNode[] | null {
  const maxVisited = Math.max(1, profile.maxVisited ?? 768)
  const maxDistance = Math.max(1, profile.maxDistance ?? 32)
  const start = canOccupyNode(world, startInput, profile) ?? { ...startInput, terrain: startInput.terrain ?? 'ground' }
  const goal = canOccupyNode(world, goalInput, profile)
  if (!goal) return null
  if (Math.abs(goal.x - start.x) > maxDistance || Math.abs(goal.z - start.z) > maxDistance) return null

  const startKey = keyOf(start)
  const goalKey = keyOf(goal)
  const records = new Map<string, SearchRecord>()
  const closed = new Set<string>()
  const open = new MinHeap()
  const first: SearchRecord = { node: start, g: 0, f: heuristic(start, goal), parent: null }
  records.set(startKey, first)
  open.push(first)

  let visited = 0
  while (open.size > 0 && visited++ < maxVisited) {
    const current = open.pop()!
    const currentKey = keyOf(current.node)
    if (closed.has(currentKey)) continue
    const bestRecord = records.get(currentKey)
    if (!bestRecord || current.g !== bestRecord.g) continue
    if (currentKey === goalKey) {
      const path: NavNode[] = []
      let cursor: SearchRecord | undefined = current
      while (cursor) {
        path.push(cursor.node)
        cursor = cursor.parent ? records.get(cursor.parent) : undefined
      }
      return path.reverse()
    }
    closed.add(currentKey)

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const next = neighborAt(world, current.node, dx, dz, profile)
      if (!next || Math.abs(next.x - start.x) > maxDistance || Math.abs(next.z - start.z) > maxDistance) continue
      const nextKey = keyOf(next)
      if (closed.has(nextKey)) continue
      const g = current.g + transitionCost(current.node, next, profile)
      const known = records.get(nextKey)
      if (known && known.g <= g) continue
      const record: SearchRecord = { node: next, g, f: g + heuristic(next, goal), parent: currentKey }
      records.set(nextKey, record)
      open.push(record)
    }
  }
  return null
}
