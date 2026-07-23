import * as THREE from 'three'
import { Chunk, CHUNK_SIZE, WORLD_HEIGHT, ChunkState } from './Chunk'
import { WorldGen } from './WorldGen'
import {
  B, SOLID, OPAQUE, CROSS, GRAVITY, LIGHT_LEVEL, blockCollisionBox, isValidBlockId, isDirectionalBlock,
  isHorizontalFace, isWheat, wheatAge, isFarmingPlant, isWater as isWaterBlock,
  isLava as isLavaBlock, isFluid, fluidLevel, fluidKind, fluidBlock, isFlammable,
  isLogBlock, isLeafBlock, isBedBlock, isDoorBlock, isDoorOpen, isDoorUpper, canSupportVine,
  oppositeHorizontalFace,
  type BlockCollisionBox, type HorizontalFace
} from './Blocks'
import { buildChunkGeoms } from './Mesher'
import { planTree, type TreeGeneratorKind } from './BiomeDecorator'
import type { Materials } from '../gfx/Materials'
import type { Atlas } from '../gfx/Atlas'
import type { StructurePlan } from './structures/Types'
import type { WorldGenWorkerResponse } from './WorldGenWorkerProtocol'
import { RayHit, rayBoxHit, SerializedBlockEdits, SerializedBlockFacings, SerializedScheduledTicks, ScheduledBlockTick, SIMULATION_STEP, MAX_TICKS_PER_FRAME, RANDOM_TICKS_PER_SECTION, SECTION_HEIGHT, MOB_SIMULATION_RADIUS, MAX_PENDING_GENERATION, LIGHT_CELLS, LIGHT_CHANGED, LIGHT_BORDER_POS_X, LIGHT_BORDER_NEG_X, LIGHT_BORDER_POS_Z, LIGHT_BORDER_NEG_Z, LIGHT_BORDER_DIRECTIONS, scratchSky, scratchBlock, lightOpacity, wantsRandomTick } from './WorldShared'
import type { World } from './World'

type WorldConstructor = { prototype: World }

export function installWorldSimulation(WorldClass: WorldConstructor): void {
  const prototype = WorldClass.prototype
  prototype.scheduleBlockTick = function(this: World, x: number, y: number, z: number, delay: number, kind: 0 | 1 | 2 | 3 | 4 | 5 = 0): void {
    if (y < 1 || y >= WORLD_HEIGHT) return
    const due = this.simulationTick + Math.max(1, Math.floor(delay))
    if (!this.scheduledTickIndex) {
      this.scheduledTickIndex = new Map(this.scheduledTicks.map(tick => [this.scheduledTickKey(tick.x, tick.y, tick.z, tick.kind), tick]))
    }
    const key = this.scheduledTickKey(x, y, z, kind)
    const existing = this.scheduledTickIndex.get(key)
    if (existing) {
      existing.due = Math.min(existing.due, due)
      return
    }
    if (this.scheduledTicks.length >= 8192) {
      // Only low-priority ticks may be dropped on overflow: evicting a TNT fuse
      // (kind 4) or a fluid tick (kind 2) would freeze the block forever.
      let evictable = this.scheduledTicks.findIndex(tick => tick.kind === 0)
      if (evictable === -1) evictable = this.scheduledTicks.findIndex(tick => tick.kind === 1 || tick.kind === 3)
      if (evictable !== -1) {
        const removed = this.scheduledTicks.splice(evictable, 1)[0]
        this.scheduledTickIndex.delete(this.scheduledTickKey(removed.x, removed.y, removed.z, removed.kind))
      }
      // if only critical ticks remain, the queue is allowed to exceed the soft cap
    }
    const tick = { x, y, z, due, kind }
    this.scheduledTicks.push(tick)
    this.scheduledTickIndex.set(key, tick)
  }
  prototype.scheduledTickKey = function(this: World, x: number, y: number, z: number, kind: number): string {
    return `${x},${y},${z},${kind}`
  }
  prototype.notifyBlockAndNeighbors = function(this: World, x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of [
      [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ] as const) this.scheduleBlockTick(x + dx, y + dy, z + dz, 1, 0)
  }
  prototype.scheduleAdjacentDynamicTicks = function(this: World, x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of [
      [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ] as const) {
      const id = this.getBlock(x + dx, y + dy, z + dz)
      if (isFluid(id)) this.scheduleBlockTick(x + dx, y + dy, z + dz, isLavaBlock(id) ? 30 : 5, 2)
      else if (id === B.FIRE) this.scheduleBlockTick(x + dx, y + dy, z + dz, 4, 3)
    }
  }
  prototype.runScheduledTicks = function(this: World): void {
    this.batchBlocks(() => {
      let processed = 0
      for (let i = this.scheduledTicks.length - 1; i >= 0 && processed < 256; i--) {
        const tick = this.scheduledTicks[i]
        if (tick.due > this.simulationTick) continue
        this.scheduledTicks.splice(i, 1)
        this.scheduledTickIndex?.delete(this.scheduledTickKey(tick.x, tick.y, tick.z, tick.kind))
        if (tick.kind === 1) {
          const id = this.getBlock(tick.x, tick.y, tick.z)
          if (id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE || id === B.SAPLING_BIRCH) {
            if (!this.growTree(tick.x, tick.y, tick.z, id === B.SAPLING_SPRUCE)) {
              this.scheduleBlockTick(tick.x, tick.y, tick.z, 200, 1)
            }
          }
        } else if (tick.kind === 2) {
          this.runFluidTick(tick.x, tick.y, tick.z)
        } else if (tick.kind === 3) {
          this.runFireTick(tick.x, tick.y, tick.z)
        } else if (tick.kind === 4) {
          if (this.getBlock(tick.x, tick.y, tick.z) === B.PRIMED_TNT) {
            this.setBlock(tick.x, tick.y, tick.z, B.AIR)
            this.onTntExplode(tick.x + 0.5, tick.y + 0.5, tick.z + 0.5, 4)
          }
        } else if (tick.kind === 5) {
          this.continueFallingBlock(tick.x, tick.y, tick.z)
        } else {
          this.validateFarmingBlock(tick.x, tick.y, tick.z)
        }
        processed++
      }
    })
  }
  prototype.runFluidTick = function(this: World, x: number, y: number, z: number): void {
    let id = this.getBlock(x, y, z)
    const kind = fluidKind(id)
    if (!kind) return
    const opposite = kind === 'water' ? isLavaBlock : isWaterBlock
    const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const

    if (kind === 'lava' && neighbors.some(([dx, dy, dz]) => opposite(this.getBlock(x + dx, y + dy, z + dz)))) {
      this.setBlock(x, y, z, fluidLevel(id) === 0 ? B.OBSIDIAN : B.COBBLESTONE)
      return
    }
    if (kind === 'water') {
      for (const [dx, dy, dz] of neighbors) {
        const nx = x + dx, ny = y + dy, nz = z + dz
        const other = this.getBlock(nx, ny, nz)
        if (!isLavaBlock(other)) continue
        const result = fluidLevel(other) === 0 ? B.OBSIDIAN : fluidLevel(id) === 0 ? B.STONE : B.COBBLESTONE
        this.setBlock(nx, ny, nz, result)
      }
    }

    id = this.getBlock(x, y, z)
    if (fluidKind(id) !== kind) return
    let level = fluidLevel(id)
    if (kind === 'water' && level > 0 && SOLID[this.getBlock(x, y - 1, z)]) {
      let adjacentSources = 0
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const neighbor = this.getBlock(x + dx, y, z + dz)
        if (isWaterBlock(neighbor) && fluidLevel(neighbor) === 0) adjacentSources++
      }
      if (adjacentSources >= 2) {
        this.setBlock(x, y, z, B.WATER)
        level = 0
      }
    }
    if (level > 0) {
      let desired = 8
      const above = this.getBlock(x, y + 1, z)
      if (fluidKind(above) === kind) desired = Math.min(desired, Math.max(1, fluidLevel(above)))
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const neighbor = this.getBlock(x + dx, y, z + dz)
        if (fluidKind(neighbor) === kind) desired = Math.min(desired, fluidLevel(neighbor) + 1)
      }
      if (desired > 7) {
        this.setBlock(x, y, z, B.AIR)
        return
      }
      if (desired !== level) {
        this.setBlock(x, y, z, fluidBlock(kind, desired))
        level = desired
      }
    }

    const spreadInto = (nx: number, ny: number, nz: number, nextLevel: number): void => {
      const target = this.getBlock(nx, ny, nz)
      if (opposite(target)) {
        if (kind === 'lava') this.setBlock(x, y, z, level === 0 ? B.OBSIDIAN : B.COBBLESTONE)
        else this.setBlock(nx, ny, nz, fluidLevel(target) === 0 ? B.OBSIDIAN : level === 0 ? B.STONE : B.COBBLESTONE)
        return
      }
      const targetLevel = fluidKind(target) === kind ? fluidLevel(target) : -1
      const replaceable = target === B.AIR || target === B.FIRE || CROSS[target]
      if (replaceable || (targetLevel > nextLevel && targetLevel > 0)) {
        this.setBlock(nx, ny, nz, fluidBlock(kind, nextLevel))
      }
    }

    if (y > 1) spreadInto(x, y - 1, z, Math.max(1, level))
    const horizontalRange = kind === 'lava' ? 3 : 7
    if (level < horizontalRange) {
      const nextLevel = level + 1
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        spreadInto(x + dx, y, z + dz, nextLevel)
      }
    }
    if (fluidKind(this.getBlock(x, y, z)) === kind) {
      this.scheduleBlockTick(x, y, z, kind === 'lava' ? 30 : 5, 2)
    }
  }
  prototype.runFireTick = function(this: World, x: number, y: number, z: number): void {
    if (this.getBlock(x, y, z) !== B.FIRE) return
    const around = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
    if (around.some(([dx, dy, dz]) => isWaterBlock(this.getBlock(x + dx, y + dy, z + dz)))) {
      this.setBlock(x, y, z, B.AIR)
      return
    }
    const supported = SOLID[this.getBlock(x, y - 1, z)] ||
      around.some(([dx, dy, dz]) => isFlammable(this.getBlock(x + dx, y + dy, z + dz)))
    const roll = this.positionHash(x, y, z, this.simulationTick)
    if (!supported || roll % 7 === 0) {
      this.setBlock(x, y, z, B.AIR)
      return
    }
    for (let i = 0; i < around.length; i++) {
      const [dx, dy, dz] = around[i]
      const nx = x + dx, ny = y + dy, nz = z + dz
      const target = this.getBlock(nx, ny, nz)
      if (!isFlammable(target) || this.positionHash(nx, ny, nz, roll + i) % 4 !== 0) continue
      if (target === B.TNT) this.primeTnt(nx, ny, nz, 40 + roll % 25)
      else this.setBlock(nx, ny, nz, B.FIRE)
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, nz = z + dz
      if (this.getBlock(nx, y, nz) === B.AIR && isFlammable(this.getBlock(nx, y - 1, nz)) &&
        this.positionHash(nx, y, nz, roll) % 5 === 0) this.setBlock(nx, y, nz, B.FIRE)
    }
    if (this.getBlock(x, y, z) === B.FIRE) this.scheduleBlockTick(x, y, z, 8 + roll % 8, 3)
  }
  prototype.validateFarmingBlock = function(this: World, x: number, y: number, z: number): void {
    const id = this.getBlock(x, y, z)
    if (isWheat(id)) {
      const below = this.getBlock(x, y - 1, z)
      if (below !== B.FARMLAND_DRY && below !== B.FARMLAND_WET) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.SUGARCANE) {
      const below = this.getBlock(x, y - 1, z)
      if (below !== B.SUGARCANE && !this.canSugarCaneStay(x, y, z)) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.MUSHROOM_BROWN || id === B.MUSHROOM_RED) {
      if (!OPAQUE[this.getBlock(x, y - 1, z)] || this.getLightLevel(x, y, z) > 12) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.SAPLING_OAK || id === B.SAPLING_SPRUCE || id === B.SAPLING_BIRCH) {
      const below = this.getBlock(x, y - 1, z)
      if (below !== B.GRASS && below !== B.DIRT) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.DEAD_BUSH) {
      if (this.getBlock(x, y - 1, z) !== B.SAND) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.CACTUS) {
      const below = this.getBlock(x, y - 1, z)
      const sideBlocked = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dz]) => SOLID[this.getBlock(x + dx, y, z + dz)])
      if ((below !== B.SAND && below !== B.CACTUS) || sideBlocked) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.WATER_LILY) {
      if (this.getBlock(x, y - 1, z) !== B.WATER) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.VINE) {
      const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE)
      const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE
      const storedFacing = this.blockFacings.get(this.key(cx, cz))?.get(Chunk.index(lx, y, lz))
      const supportsFace = (face: HorizontalFace): boolean => {
        const dx = face === 0 ? 1 : face === 1 ? -1 : 0
        const dz = face === 4 ? 1 : face === 5 ? -1 : 0
        return canSupportVine(this.getBlock(x + dx, y, z + dz))
      }
      const sideSupport = storedFacing === undefined
        ? ([0, 1, 4, 5] as const).some(supportsFace)
        : supportsFace(storedFacing)
      if (!sideSupport && this.getBlock(x, y + 1, z) !== B.VINE) this.breakUnsupportedPlant(x, y, z, id)
    } else if (id === B.FARMLAND_DRY || id === B.FARMLAND_WET) {
      const above = this.getBlock(x, y + 1, z)
      if (SOLID[above] && !CROSS[above]) this.setBlock(x, y, z, B.DIRT)
    } else if (isBedBlock(id)) {
      // a bed half whose partner is gone breaks; the head half drops the bed item
      const facing = this.getBlockFacing(x, y, z)
      const toward = id === B.BED_FOOT ? facing : oppositeHorizontalFace(facing)
      const dx = toward === 0 ? 1 : toward === 1 ? -1 : 0
      const dz = toward === 4 ? 1 : toward === 5 ? -1 : 0
      const partner = this.getBlock(x + dx, y, z + dz)
      const expected = id === B.BED_FOOT ? B.BED_HEAD : B.BED_FOOT
      if (partner !== expected) {
        this.setBlock(x, y, z, B.AIR)
        if (id === B.BED_HEAD) this.onAutomaticBlockBreak(x, y, z, id)
      }
    } else if (isDoorBlock(id)) {
      const door = this.completeDoorAt(x, y, z)
      if (!door || !SOLID[this.getBlock(x, door.lowerY - 1, z)]) this.breakDoor(x, y, z)
    }
  }
  prototype.breakUnsupportedPlant = function(this: World, x: number, y: number, z: number, id: number): void {
    this.setBlock(x, y, z, B.AIR)
    this.onAutomaticBlockBreak(x, y, z, id)
  }
  prototype.runRandomTicks = function(this: World, px: number, pz: number): void {
    const centerX = Math.floor(px / CHUNK_SIZE), centerZ = Math.floor(pz / CHUNK_SIZE)
    const radius = Math.min(4, this.renderDistance)
    for (const chunk of this.chunks.values()) {
      const cx = chunk.cx, cz = chunk.cz
      if (Math.abs(cx - centerX) > radius || Math.abs(cz - centerZ) > radius) continue
      if (chunk.state < ChunkState.GENERATED) continue

      // Sampling coordinates instead of iterating randomTickIndices is important:
      // Set iteration is stable, so a global "first 512" cap permanently starved
      // later cells and chunks. Each active section now receives an equal number
      // of deterministic-looking samples every 20 Hz tick.
      for (let sectionY = 0; sectionY < WORLD_HEIGHT; sectionY += SECTION_HEIGHT) {
        for (let attempt = 0; attempt < RANDOM_TICKS_PER_SECTION; attempt++) {
          const salt = Math.imul(this.simulationTick, 0x9e3779b1) ^
            Math.imul(sectionY + attempt * 17, 0x85ebca6b)
          const roll = this.positionHash(cx, sectionY, cz, salt)
          const lx = roll & 15
          const lz = (roll >>> 4) & 15
          const y = sectionY + ((roll >>> 8) & 15)
          const index = Chunk.index(lx, y, lz)
          const id = chunk.blocks[index]
          if (wantsRandomTick(id)) {
            this.randomTickBlock(cx * CHUNK_SIZE + lx, y, cz * CHUNK_SIZE + lz, id)
          }
        }
      }
    }
  }
  prototype.randomTickBlock = function(this: World, x: number, y: number, z: number, id: number): void {
    const roll = this.positionHash(x, y, z, this.simulationTick)
    if (id === B.GRASS) {
      if (OPAQUE[this.getBlock(x, y + 1, z)]) {
        this.setBlock(x, y, z, B.DIRT)
        return
      }
      const dx = ((roll >>> 3) % 3) - 1
      const dz = ((roll >>> 7) % 3) - 1
      const dy = ((roll >>> 11) % 3) - 1
      const tx = x + dx, ty = y + dy, tz = z + dz
      if (this.getBlock(tx, ty, tz) === B.DIRT && !OPAQUE[this.getBlock(tx, ty + 1, tz)] &&
        this.getLightLevel(tx, ty + 1, tz) >= 9) this.setBlock(tx, ty, tz, B.GRASS)
      return
    }
    if (isLeafBlock(id)) {
      if (roll % 5 === 0 && !this.hasNearbyLog(x, y, z)) {
        this.setBlock(x, y, z, B.AIR)
        this.onAutomaticBlockBreak(x, y, z, id)
      }
      return
    }
    if (id === B.MYCELIUM) {
      if (OPAQUE[this.getBlock(x, y + 1, z)]) {
        this.setBlock(x, y, z, B.DIRT)
        return
      }
      const dx = ((roll >>> 3) % 3) - 1
      const dz = ((roll >>> 7) % 3) - 1
      const dy = ((roll >>> 11) % 3) - 1
      const tx = x + dx, ty = y + dy, tz = z + dz
      if (this.getBlock(tx, ty, tz) === B.DIRT && !OPAQUE[this.getBlock(tx, ty + 1, tz)]) {
        this.setBlock(tx, ty, tz, B.MYCELIUM)
      }
      return
    }
    if (id === B.FARMLAND_DRY || id === B.FARMLAND_WET) {
      const hydrated = this.hasWaterForFarmland(x, y, z)
      if (hydrated && id !== B.FARMLAND_WET) this.setBlock(x, y, z, B.FARMLAND_WET)
      else if (!hydrated && id !== B.FARMLAND_DRY) this.setBlock(x, y, z, B.FARMLAND_DRY)
      else if (!hydrated && id === B.FARMLAND_DRY && !isWheat(this.getBlock(x, y + 1, z)) && roll % 12 === 0) {
        this.setBlock(x, y, z, B.DIRT)
      }
      return
    }
    if (isWheat(id)) {
      this.validateFarmingBlock(x, y, z)
      if (this.getBlock(x, y, z) !== id || id === B.WHEAT_7 || this.getLightLevel(x, y + 1, z) < 9) return
      const wet = this.getBlock(x, y - 1, z) === B.FARMLAND_WET
      if (roll % (wet ? 4 : 7) === 0) this.setBlock(x, y, z, id + 1)
      return
    }
    if (id === B.SUGARCANE) {
      this.validateFarmingBlock(x, y, z)
      if (this.getBlock(x, y, z) !== id || roll % 12 !== 0) return
      let baseY = y
      while (this.getBlock(x, baseY - 1, z) === B.SUGARCANE) baseY--
      let topY = y
      while (this.getBlock(x, topY + 1, z) === B.SUGARCANE) topY++
      if (topY - baseY + 1 < 3 && this.getBlock(x, topY + 1, z) === B.AIR) {
        this.setBlock(x, topY + 1, z, B.SUGARCANE)
      }
      return
    }
    if (id === B.CACTUS) {
      this.validateFarmingBlock(x, y, z)
      if (this.getBlock(x, y, z) !== B.CACTUS || this.getBlock(x, y + 1, z) === B.CACTUS || roll % 900 !== 0) return
      let baseY = y
      while (this.getBlock(x, baseY - 1, z) === B.CACTUS) baseY--
      if (y - baseY + 1 >= 3 || this.getBlock(x, y + 1, z) !== B.AIR) return
      const sideClear = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .every(([dx, dz]) => !SOLID[this.getBlock(x + dx, y + 1, z + dz)])
      if (sideClear) this.setBlock(x, y + 1, z, B.CACTUS)
      return
    }
    if ((id === B.MUSHROOM_BROWN || id === B.MUSHROOM_RED) && roll % 28 === 0) {
      const dx = ((roll >>> 5) % 3) - 1
      const dz = ((roll >>> 9) % 3) - 1
      const nx = x + dx, nz = z + dz
      if ((dx !== 0 || dz !== 0) && this.canPlantMushroom(nx, y, nz)) this.setBlock(nx, y, nz, id)
    }
  }
  prototype.hasWaterForFarmland = function(this: World, x: number, y: number, z: number): boolean {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (isWaterBlock(this.getBlock(x + dx, y, z + dz)) || isWaterBlock(this.getBlock(x + dx, y + 1, z + dz))) return true
      }
    }
    return false
  }
  prototype.hasNearbyLog = function(this: World, x: number, y: number, z: number): boolean {
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
      const id = this.getBlock(x + dx, y + dy, z + dz)
      if (isLogBlock(id)) return true
    }
    return false
  }
  prototype.hasHorizontalWater = function(this: World, x: number, y: number, z: number): boolean {
    return isWaterBlock(this.getBlock(x + 1, y, z)) || isWaterBlock(this.getBlock(x - 1, y, z)) ||
      isWaterBlock(this.getBlock(x, y, z + 1)) || isWaterBlock(this.getBlock(x, y, z - 1))
  }
  prototype.canSugarCaneStay = function(this: World, x: number, y: number, z: number): boolean {
    const below = this.getBlock(x, y - 1, z)
    return (below === B.GRASS || below === B.DIRT || below === B.SAND) && this.hasHorizontalWater(x, y - 1, z)
  }
  prototype.positionHash = function(this: World, x: number, y: number, z: number, salt: number): number {
    let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ Math.imul(z, 0x6c8e9cf5) ^ salt
    h ^= h >>> 16
    h = Math.imul(h, 0x45d9f3b)
    h ^= h >>> 16
    return h >>> 0
  }
}
