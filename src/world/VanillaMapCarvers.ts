import { B } from './Blocks'
import { BIOME } from './Biomes'
import { Chunk } from './Chunk'
import { JavaRandom, long } from './JavaRandom'
import type { CarveChunkStats, CarverBaseSampler } from './MapCarvers'

const RANGE = 8
const f = Math.fround
const FLOAT_PI = f(Math.PI)
const SIN_TABLE = (() => {
  const table = new Float32Array(65536)
  for (let index = 0; index < table.length; index++) {
    table[index] = f(Math.sin(index * Math.PI * 2 / 65536))
  }
  return table
})()

function sin(value: number): number {
  return SIN_TABLE[Math.trunc(f(value * f(10430.38))) & 0xffff]
}

function cos(value: number): number {
  return SIN_TABLE[Math.trunc(f(f(value * f(10430.38)) + f(16384))) & 0xffff]
}

function floor(value: number): number {
  const integer = Math.trunc(value)
  return value < integer ? integer - 1 : integer
}

function multiplyFloat(first: number, second: number): number {
  return f(f(first) * f(second))
}

function topBlockForBiome(biome: number): number {
  if (biome === BIOME.DESERT || biome === BIOME.BEACH) return B.SAND
  if (biome === BIOME.MUSHROOM) return B.MYCELIUM
  return B.GRASS
}

interface CarveContext {
  readonly chunk: Chunk
  readonly sampler: CarverBaseSampler
  changed: number
  caveSystems: number
  ravines: number
}

function isWater(block: number): boolean {
  return block === B.WATER || (block >= B.WATER_1 && block <= B.WATER_7)
}

function canCarve(block: number): boolean {
  return block === B.STONE || block === B.DIRT || block === B.GRASS
}

abstract class VanillaMapGen {
  protected readonly random = new JavaRandom()

  generate(seed: bigint, context: CarveContext): void {
    this.random.setSeed(seed)
    const xSeed = this.random.nextLong()
    const zSeed = this.random.nextLong()
    for (let sourceX = context.chunk.cx - RANGE; sourceX <= context.chunk.cx + RANGE; sourceX++) {
      for (let sourceZ = context.chunk.cz - RANGE; sourceZ <= context.chunk.cz + RANGE; sourceZ++) {
        const sourceSeed = long(long(BigInt(sourceX) * xSeed) ^
          long(BigInt(sourceZ) * zSeed) ^ seed)
        this.random.setSeed(sourceSeed)
        this.recursiveGenerate(sourceX, sourceZ, context)
      }
    }
  }

  protected abstract recursiveGenerate(sourceX: number, sourceZ: number, context: CarveContext): void

  protected waterInBounds(
    blocks: Uint8Array,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number
  ): boolean {
    for (let x = minX; x < maxX; x++) for (let z = minZ; z < maxZ; z++) {
      for (let y = maxY + 1; y >= minY - 1; y--) {
        if (y >= 0 && y < 128 && isWater(blocks[Chunk.index(x, y, z)])) return true
        if (y !== minY - 1 && x !== minX && x !== maxX - 1 &&
          z !== minZ && z !== maxZ - 1) y = minY
      }
    }
    return false
  }

  protected carveEllipsoid(
    context: CarveContext,
    centerX: number,
    centerY: number,
    centerZ: number,
    radiusX: number,
    radiusY: number,
    ravineWidths?: Float32Array
  ): void {
    const chunkX = context.chunk.cx * 16, chunkZ = context.chunk.cz * 16
    let minX = floor(centerX - radiusX) - chunkX - 1
    let maxX = floor(centerX + radiusX) - chunkX + 1
    let minY = floor(centerY - radiusY) - 1
    let maxY = floor(centerY + radiusY) + 1
    let minZ = floor(centerZ - radiusX) - chunkZ - 1
    let maxZ = floor(centerZ + radiusX) - chunkZ + 1
    minX = Math.max(0, minX); maxX = Math.min(16, maxX)
    minY = Math.max(1, minY); maxY = Math.min(120, maxY)
    minZ = Math.max(0, minZ); maxZ = Math.min(16, maxZ)
    if (this.waterInBounds(context.chunk.blocks, minX, maxX, minY, maxY, minZ, maxZ)) return

    for (let x = minX; x < maxX; x++) {
      const normalizedX = (x + chunkX + 0.5 - centerX) / radiusX
      for (let z = minZ; z < maxZ; z++) {
        const normalizedZ = (z + chunkZ + 0.5 - centerZ) / radiusX
        if (normalizedX * normalizedX + normalizedZ * normalizedZ >= 1) continue
        let sawGrass = false
        for (let logicalY = maxY - 1; logicalY >= minY; logicalY--) {
          // The 1.2.5 loop evaluates its ellipse at i3 but starts the block
          // pointer at l=i3+1. Preserve that historical one-cell offset.
          const blockY = logicalY + 1
          const normalizedY = (logicalY + 0.5 - centerY) / radiusY
          const inside = ravineWidths
            ? (normalizedX * normalizedX + normalizedZ * normalizedZ) * ravineWidths[logicalY] +
              normalizedY * normalizedY / 6 < 1
            : normalizedY > -0.7 &&
              normalizedX * normalizedX + normalizedY * normalizedY + normalizedZ * normalizedZ < 1
          if (!inside) continue
          const index = Chunk.index(x, blockY, z)
          const block = context.chunk.blocks[index]
          if (block === B.GRASS) sawGrass = true
          if (!canCarve(block)) continue
          const replacement = logicalY < 10 ? B.LAVA : B.AIR
          if (block !== replacement) {
            context.chunk.blocks[index] = replacement
            context.changed++
          }
          if (replacement === B.AIR && sawGrass && context.chunk.blocks[index - 1] === B.DIRT) {
            context.chunk.blocks[index - 1] = topBlockForBiome(
              context.sampler.biomeAt(x + chunkX, z + chunkZ)
            )
          }
        }
      }
    }
  }
}

class VanillaCaves extends VanillaMapGen {
  protected recursiveGenerate(sourceX: number, sourceZ: number, context: CarveContext): void {
    let systems = this.random.nextInt(this.random.nextInt(this.random.nextInt(40) + 1) + 1)
    if (this.random.nextInt(15) !== 0) systems = 0
    context.caveSystems += systems
    for (let system = 0; system < systems; system++) {
      const x = sourceX * 16 + this.random.nextInt(16)
      const y = this.random.nextInt(this.random.nextInt(120) + 8)
      const z = sourceZ * 16 + this.random.nextInt(16)
      let tunnels = 1
      if (this.random.nextInt(4) === 0) {
        this.largeNode(this.random.nextLong(), context, x, y, z)
        tunnels += this.random.nextInt(4)
      }
      for (let tunnel = 0; tunnel < tunnels; tunnel++) {
        const yaw = f(f(this.random.nextFloat() * FLOAT_PI) * f(2))
        const pitch = f(f(f(this.random.nextFloat() - f(0.5)) * f(2)) / f(8))
        let width = f(f(this.random.nextFloat() * f(2)) + this.random.nextFloat())
        if (this.random.nextInt(10) === 0) {
          width = f(width * f(f(f(this.random.nextFloat() * this.random.nextFloat()) * f(3)) + f(1)))
        }
        this.node(this.random.nextLong(), context, x, y, z, width, yaw, pitch, 0, 0, 1)
      }
    }
  }

  private largeNode(seed: bigint, context: CarveContext, x: number, y: number, z: number): void {
    const width = f(f(1) + f(this.random.nextFloat() * f(6)))
    this.node(seed, context, x, y, z, width, f(0), f(0), -1, -1, 0.5)
  }

  private node(
    seed: bigint,
    context: CarveContext,
    startX: number,
    startY: number,
    startZ: number,
    width: number,
    initialYaw: number,
    initialPitch: number,
    startStep: number,
    endStep: number,
    verticalScale: number
  ): void {
    const targetX = context.chunk.cx * 16 + 8, targetZ = context.chunk.cz * 16 + 8
    let yawVelocity = f(0), pitchVelocity = f(0)
    let x = startX, y = startY, z = startZ, yaw = initialYaw, pitch = initialPitch
    const random = new JavaRandom(seed)
    if (endStep <= 0) {
      const length = RANGE * 16 - 16
      endStep = length - random.nextInt(Math.trunc(length / 4))
    }
    let room = false
    if (startStep === -1) {
      startStep = Math.trunc(endStep / 2)
      room = true
    }
    const branchStep = random.nextInt(Math.trunc(endStep / 2)) + Math.trunc(endStep / 4)
    const steep = random.nextInt(6) === 0
    for (let step = startStep; step < endStep; step++) {
      const angle = f(f(f(step) * FLOAT_PI) / f(endStep))
      const radiusX = 1.5 + f(f(sin(angle) * width) * f(1))
      const radiusY = radiusX * verticalScale
      const pitchCos = cos(pitch), pitchSin = sin(pitch)
      x += cos(yaw) * pitchCos
      y += pitchSin
      z += sin(yaw) * pitchCos
      pitch = f(pitch * (steep ? f(0.92) : f(0.7)))
      pitch = f(pitch + f(pitchVelocity * f(0.1)))
      yaw = f(yaw + f(yawVelocity * f(0.1)))
      pitchVelocity = f(pitchVelocity * f(0.9))
      yawVelocity = f(yawVelocity * f(0.75))
      pitchVelocity = f(pitchVelocity + multiplyFloat(
        multiplyFloat(f(random.nextFloat() - random.nextFloat()), random.nextFloat()), 2
      ))
      yawVelocity = f(yawVelocity + multiplyFloat(
        multiplyFloat(f(random.nextFloat() - random.nextFloat()), random.nextFloat()), 4
      ))
      if (!room && step === branchStep && width > 1 && endStep > 0) {
        this.node(random.nextLong(), context, x, y, z,
          f(f(random.nextFloat() * f(0.5)) + f(0.5)),
          f(yaw - f(FLOAT_PI / f(2))), f(pitch / f(3)), step, endStep, 1)
        this.node(random.nextLong(), context, x, y, z,
          f(f(random.nextFloat() * f(0.5)) + f(0.5)),
          f(yaw + f(FLOAT_PI / f(2))), f(pitch / f(3)), step, endStep, 1)
        return
      }
      if (!room && random.nextInt(4) === 0) continue
      const deltaX = x - targetX, deltaZ = z - targetZ
      const remaining = endStep - step
      const reach = f(f(width + f(2)) + f(16))
      if (deltaX * deltaX + deltaZ * deltaZ - remaining * remaining > reach * reach) return
      if (x < targetX - 16 - radiusX * 2 || z < targetZ - 16 - radiusX * 2 ||
        x > targetX + 16 + radiusX * 2 || z > targetZ + 16 + radiusX * 2) continue
      this.carveEllipsoid(context, x, y, z, radiusX, radiusY)
      if (room) break
    }
  }
}

class VanillaRavines extends VanillaMapGen {
  protected recursiveGenerate(sourceX: number, sourceZ: number, context: CarveContext): void {
    if (this.random.nextInt(50) !== 0) return
    context.ravines++
    const x = sourceX * 16 + this.random.nextInt(16)
    const y = this.random.nextInt(this.random.nextInt(40) + 8) + 20
    const z = sourceZ * 16 + this.random.nextInt(16)
    const yaw = f(f(this.random.nextFloat() * FLOAT_PI) * f(2))
    const pitch = f(f(f(this.random.nextFloat() - f(0.5)) * f(2)) / f(8))
    const width = f(f(f(this.random.nextFloat() * f(2)) + this.random.nextFloat()) * f(2))
    this.node(this.random.nextLong(), context, x, y, z, width, yaw, pitch, 0, 0, 3)
  }

  private node(
    seed: bigint,
    context: CarveContext,
    startX: number,
    startY: number,
    startZ: number,
    width: number,
    initialYaw: number,
    initialPitch: number,
    startStep: number,
    endStep: number,
    verticalScale: number
  ): void {
    const random = new JavaRandom(seed)
    const targetX = context.chunk.cx * 16 + 8, targetZ = context.chunk.cz * 16 + 8
    let yawVelocity = f(0), pitchVelocity = f(0)
    let x = startX, y = startY, z = startZ, yaw = initialYaw, pitch = initialPitch
    if (endStep <= 0) {
      const length = RANGE * 16 - 16
      endStep = length - random.nextInt(Math.trunc(length / 4))
    }
    let room = false
    if (startStep === -1) {
      startStep = Math.trunc(endStep / 2)
      room = true
    }
    const widths = new Float32Array(128)
    let scale = f(1)
    for (let index = 0; index < widths.length; index++) {
      if (index === 0 || random.nextInt(3) === 0) {
        scale = f(f(1) + f(f(random.nextFloat() * random.nextFloat()) * f(1)))
      }
      widths[index] = f(scale * scale)
    }
    for (let step = startStep; step < endStep; step++) {
      const angle = f(f(f(step) * FLOAT_PI) / f(endStep))
      let radiusX = 1.5 + f(f(sin(angle) * width) * f(1))
      let radiusY = radiusX * verticalScale
      radiusX *= random.nextFloat() * 0.25 + 0.75
      radiusY *= random.nextFloat() * 0.25 + 0.75
      const pitchCos = cos(pitch), pitchSin = sin(pitch)
      x += cos(yaw) * pitchCos
      y += pitchSin
      z += sin(yaw) * pitchCos
      pitch = f(pitch * f(0.7))
      pitch = f(pitch + f(pitchVelocity * f(0.05)))
      yaw = f(yaw + f(yawVelocity * f(0.05)))
      pitchVelocity = f(pitchVelocity * f(0.8))
      yawVelocity = f(yawVelocity * f(0.5))
      pitchVelocity = f(pitchVelocity + multiplyFloat(
        multiplyFloat(f(random.nextFloat() - random.nextFloat()), random.nextFloat()), 2
      ))
      yawVelocity = f(yawVelocity + multiplyFloat(
        multiplyFloat(f(random.nextFloat() - random.nextFloat()), random.nextFloat()), 4
      ))
      if (!room && random.nextInt(4) === 0) continue
      const deltaX = x - targetX, deltaZ = z - targetZ
      const remaining = endStep - step
      const reach = f(f(width + f(2)) + f(16))
      if (deltaX * deltaX + deltaZ * deltaZ - remaining * remaining > reach * reach) return
      if (x < targetX - 16 - radiusX * 2 || z < targetZ - 16 - radiusX * 2 ||
        x > targetX + 16 + radiusX * 2 || z > targetZ + 16 + radiusX * 2) continue
      this.carveEllipsoid(context, x, y, z, radiusX, radiusY, widths)
      if (room) break
    }
  }
}

/** Caves followed by ravines, in ChunkProviderGenerate's original order. */
export class VanillaMapCarvers {
  private readonly caves = new VanillaCaves()
  private readonly ravines = new VanillaRavines()

  constructor(readonly seed: bigint) {}

  carveChunk(chunk: Chunk, sampler: CarverBaseSampler): CarveChunkStats {
    const context: CarveContext = {
      chunk, sampler, changed: 0, caveSystems: 0, ravines: 0
    }
    this.caves.generate(this.seed, context)
    this.ravines.generate(this.seed, context)
    return {
      cavePlans: context.caveSystems,
      ravinePlans: context.ravines,
      lakePlans: 0,
      primitivesTested: 0,
      primitivesStamped: 0,
      blocksChanged: context.changed
    }
  }

  clearCaches(): void {}
}
