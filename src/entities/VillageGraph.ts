export interface VillagePosition {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type VillageDoorFacing = 0 | 1 | 4 | 5

/** Metadata for the lower half of one physical village door. */
export interface VillageDoorNode extends VillagePosition {
  /** Stable world-generation key (normally village id + block position). */
  readonly key: string
  readonly facing: VillageDoorFacing
  readonly inside: VillagePosition
  readonly outside: VillagePosition
}

/** Chunk-independent village metadata accepted by {@link VillageGraph.registerVillage}. */
export interface VillageMetadata {
  readonly id: string
  readonly centerX: number
  readonly centerY: number
  readonly centerZ: number
  readonly radius: number
  readonly doors: readonly VillageDoorNode[]
}

/** Registered village. Door maps may include broken metadata; use listValidDoors for AI. */
export interface VillageNode {
  readonly id: string
  readonly centerX: number
  readonly centerY: number
  readonly centerZ: number
  readonly radius: number
  readonly doors: ReadonlyMap<string, VillageDoorNode>
}

export interface NearestDoorOptions {
  /** Restrict the query to one village. */
  readonly villageId?: string
  /** Euclidean distance from the entity position to the door block centre. */
  readonly maxDistance?: number
}

type DoorReference = string | VillagePosition

interface StoredVillage {
  id: string
  centerX: number
  centerY: number
  centerZ: number
  radius: number
  doors: Map<string, VillageDoorNode>
}

interface DoorRecord {
  villageId: string
  node: VillageDoorNode
}

const positionKey = ({ x, y, z }: VillagePosition): string => `${x},${y},${z}`

function squaredDistance(a: VillagePosition, b: VillagePosition): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function squaredHorizontalDistance(a: VillagePosition, b: VillagePosition): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`)
}

function clonePosition(position: VillagePosition, label: string): VillagePosition {
  requireFinite(position.x, `${label}.x`)
  requireFinite(position.y, `${label}.y`)
  requireFinite(position.z, `${label}.z`)
  return Object.freeze({ x: position.x, y: position.y, z: position.z })
}

function cloneDoor(door: VillageDoorNode, key = door.key): VillageDoorNode {
  if (!key) throw new TypeError('door.key must not be empty')
  requireFinite(door.x, 'door.x')
  requireFinite(door.y, 'door.y')
  requireFinite(door.z, 'door.z')
  if (door.facing !== 0 && door.facing !== 1 && door.facing !== 4 && door.facing !== 5) {
    throw new TypeError('door.facing must be 0, 1, 4, or 5')
  }
  return Object.freeze({
    key,
    x: door.x,
    y: door.y,
    z: door.z,
    facing: door.facing,
    inside: clonePosition(door.inside, 'door.inside'),
    outside: clonePosition(door.outside, 'door.outside')
  })
}

/**
 * Runtime village/door index. It owns no World reference: callers register
 * deterministic generation metadata and report door break/repair events.
 */
export class VillageGraph {
  private readonly villageById = new Map<string, StoredVillage>()
  private readonly doorByKey = new Map<string, DoorRecord>()
  private readonly doorKeyByPosition = new Map<string, string>()
  private readonly doorAliases = new Map<string, string>()
  private readonly brokenDoorKeys = new Set<string>()

  get size(): number { return this.villageById.size }

  clear(): void {
    this.villageById.clear()
    this.doorByKey.clear()
    this.doorKeyByPosition.clear()
    this.doorAliases.clear()
    this.brokenDoorKeys.clear()
  }

  /** Merges a full village or a per-chunk fragment into the existing node. */
  registerVillage(metadata: VillageMetadata): VillageNode {
    if (!metadata.id) throw new TypeError('village.id must not be empty')
    requireFinite(metadata.centerX, 'village.centerX')
    requireFinite(metadata.centerY, 'village.centerY')
    requireFinite(metadata.centerZ, 'village.centerZ')
    requireFinite(metadata.radius, 'village.radius')

    let village = this.villageById.get(metadata.id)
    if (!village) {
      village = {
        id: metadata.id,
        centerX: metadata.centerX,
        centerY: metadata.centerY,
        centerZ: metadata.centerZ,
        radius: Math.max(0, metadata.radius),
        doors: new Map()
      }
      this.villageById.set(metadata.id, village)
    } else {
      // Repeated chunk metadata is authoritative for non-door village fields.
      village.centerX = metadata.centerX
      village.centerY = metadata.centerY
      village.centerZ = metadata.centerZ
      village.radius = Math.max(0, metadata.radius)
    }

    for (const input of metadata.doors) this.registerDoor(village, input)
    return village
  }

  getVillage(id: string): VillageNode | null {
    return this.villageById.get(id) ?? null
  }

  /** Stable ordering keeps AI choices and tests independent of chunk load order. */
  listVillages(): VillageNode[] {
    return [...this.villageById.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Nearest centre in 3D, optionally bounded by an entity-centric distance. */
  nearestVillage(position: VillagePosition, maxDistance = Number.POSITIVE_INFINITY): VillageNode | null {
    if (maxDistance < 0 || Number.isNaN(maxDistance)) return null
    const limitSquared = maxDistance * maxDistance
    let best: StoredVillage | null = null
    let bestDistance = limitSquared
    for (const village of this.villageById.values()) {
      const distance = squaredDistance(position, {
        x: village.centerX, y: village.centerY, z: village.centerZ
      })
      if (distance < bestDistance || (distance === bestDistance && (!best || village.id < best.id))) {
        best = village
        bestDistance = distance
      }
    }
    return best
  }

  /** Nearest village whose horizontal radius contains the supplied entity position. */
  villageAt(position: VillagePosition): VillageNode | null {
    let best: StoredVillage | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const village of this.villageById.values()) {
      const distance = squaredHorizontalDistance(position, {
        x: village.centerX, y: village.centerY, z: village.centerZ
      })
      if (distance > village.radius * village.radius) continue
      if (distance < bestDistance || (distance === bestDistance && (!best || village.id < best.id))) {
        best = village
        bestDistance = distance
      }
    }
    return best
  }

  /** Returns a valid door by generated key or lower-half block position. */
  getDoor(reference: DoorReference): VillageDoorNode | null {
    const key = this.resolveDoorKey(reference)
    if (!key || this.brokenDoorKeys.has(key)) return null
    return this.doorByKey.get(key)?.node ?? null
  }

  /** Finds the closest valid door; distance is measured to its block centre. */
  nearestDoor(position: VillagePosition, options: NearestDoorOptions = {}): VillageDoorNode | null {
    const maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY
    if (maxDistance < 0 || Number.isNaN(maxDistance)) return null
    const villages = options.villageId
      ? [this.villageById.get(options.villageId)].filter((v): v is StoredVillage => Boolean(v))
      : this.villageById.values()
    let best: VillageDoorNode | null = null
    let bestDistance = maxDistance * maxDistance
    for (const village of villages) {
      for (const [key, door] of village.doors) {
        if (this.brokenDoorKeys.has(key)) continue
        const distance = squaredDistance(position, { x: door.x + 0.5, y: door.y, z: door.z + 0.5 })
        if (distance < bestDistance || (distance === bestDistance && (!best || door.key < best.key))) {
          best = door
          bestDistance = distance
        }
      }
    }
    return best
  }

  /** Marks registered metadata invalid without dropping its village association. */
  markDoorBroken(reference: DoorReference): boolean {
    const key = this.resolveDoorKey(reference)
    if (!key || !this.doorByKey.has(key) || this.brokenDoorKeys.has(key)) return false
    this.brokenDoorKeys.add(key)
    return true
  }

  /** Clears a broken marker after the caller has verified/replaced the physical door. */
  markDoorValid(reference: DoorReference): boolean {
    const key = this.resolveDoorKey(reference)
    if (!key || !this.doorByKey.has(key)) return false
    return this.brokenDoorKeys.delete(key)
  }

  isDoorValid(reference: DoorReference): boolean {
    const key = this.resolveDoorKey(reference)
    return Boolean(key && this.doorByKey.has(key) && !this.brokenDoorKeys.has(key))
  }

  /**
   * Removes the node and leaves a tombstone. Re-registering overlapping chunk
   * metadata may restore the node, but it remains invalid until markDoorValid.
   */
  removeDoor(reference: DoorReference): boolean {
    const key = this.resolveDoorKey(reference)
    if (!key) return false
    const record = this.doorByKey.get(key)
    if (!record) return false
    this.brokenDoorKeys.add(key)
    this.doorByKey.delete(key)
    this.villageById.get(record.villageId)?.doors.delete(key)
    const coordinate = positionKey(record.node)
    if (this.doorKeyByPosition.get(coordinate) === key) this.doorKeyByPosition.delete(coordinate)
    return true
  }

  listValidDoors(villageId: string): VillageDoorNode[] {
    const village = this.villageById.get(villageId)
    if (!village) return []
    return [...village.doors]
      .filter(([key]) => !this.brokenDoorKeys.has(key))
      .map(([, door]) => door)
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  validDoorCount(villageId: string): number {
    const village = this.villageById.get(villageId)
    if (!village) return 0
    let count = 0
    for (const key of village.doors.keys()) if (!this.brokenDoorKeys.has(key)) count++
    return count
  }

  /** Classic door-derived population capacity. */
  capacity(villageId: string): number {
    const doors = this.validDoorCount(villageId)
    return doors === 0 ? 0 : Math.max(1, Math.floor(doors * 0.35))
  }

  private registerDoor(village: StoredVillage, input: VillageDoorNode): void {
    const coordinate = positionKey(input)
    const positionalKey = this.doorKeyByPosition.get(coordinate)
    const aliasKey = this.doorAliases.get(input.key)
    if (positionalKey && aliasKey && positionalKey !== aliasKey) {
      throw new Error(`door ${input.key} conflicts with registered position ${coordinate}`)
    }
    const key = positionalKey ?? aliasKey ?? input.key
    const existing = this.doorByKey.get(key)
    if (existing && existing.villageId !== village.id) {
      // One physical door may be reported by multiple intersecting chunks, but
      // it has one deterministic owner in the graph.
      this.doorAliases.set(input.key, key)
      return
    }

    const node = cloneDoor(input, key)
    if (existing) {
      const oldCoordinate = positionKey(existing.node)
      if (oldCoordinate !== coordinate) {
        throw new Error(`door key ${input.key} is registered at two positions`)
      }
      existing.node = node
    } else {
      this.doorByKey.set(key, { villageId: village.id, node })
    }
    this.doorAliases.set(input.key, key)
    this.doorKeyByPosition.set(coordinate, key)
    village.doors.set(key, node)
  }

  private resolveDoorKey(reference: DoorReference): string | null {
    if (typeof reference === 'string') return this.doorAliases.get(reference) ?? reference
    return this.doorKeyByPosition.get(positionKey(reference)) ?? null
  }
}
