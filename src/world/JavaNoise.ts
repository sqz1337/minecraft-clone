import { JavaRandom } from './JavaRandom'

function floor(value: number): number {
  const integer = Math.trunc(value)
  return value < integer ? integer - 1 : integer
}

class NoiseGeneratorPerlin {
  private readonly permutations = new Int32Array(512)
  private readonly xCoord: number
  private readonly yCoord: number
  private readonly zCoord: number

  constructor(random: JavaRandom) {
    this.xCoord = random.nextDouble() * 256
    this.yCoord = random.nextDouble() * 256
    this.zCoord = random.nextDouble() * 256
    for (let index = 0; index < 256; index++) this.permutations[index] = index
    for (let index = 0; index < 256; index++) {
      const swap = random.nextInt(256 - index) + index
      const value = this.permutations[index]
      this.permutations[index] = this.permutations[swap]
      this.permutations[swap] = value
      this.permutations[index + 256] = this.permutations[index]
    }
  }

  private lerp(amount: number, first: number, second: number): number {
    return first + amount * (second - first)
  }

  private grad2(hash: number, x: number, z: number): number {
    const value = hash & 15
    const first = (1 - ((value & 8) >> 3)) * x
    const second = value >= 4 ? (value !== 12 && value !== 14 ? z : x) : 0
    return ((value & 1) !== 0 ? -first : first) + ((value & 2) !== 0 ? -second : second)
  }

  private grad(hash: number, x: number, y: number, z: number): number {
    const value = hash & 15
    const first = value >= 8 ? y : x
    const second = value >= 4 ? (value !== 12 && value !== 14 ? z : x) : y
    return ((value & 1) !== 0 ? -first : first) + ((value & 2) !== 0 ? -second : second)
  }

  add(
    output: Float64Array,
    originX: number,
    originY: number,
    originZ: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    amplitude: number
  ): void {
    if (sizeY === 1) {
      let outputIndex = 0
      const inverseAmplitude = 1 / amplitude
      for (let xIndex = 0; xIndex < sizeX; xIndex++) {
        let x = originX + xIndex * scaleX + this.xCoord
        const floorX = floor(x)
        const permutationX = floorX & 255
        x -= floorX
        const fadeX = x * x * x * (x * (x * 6 - 15) + 10)
        for (let zIndex = 0; zIndex < sizeZ; zIndex++) {
          let z = originZ + zIndex * scaleZ + this.zCoord
          const floorZ = floor(z)
          const permutationZ = floorZ & 255
          z -= floorZ
          const fadeZ = z * z * z * (z * (z * 6 - 15) + 10)
          const a = this.permutations[permutationX]
          const aa = this.permutations[a] + permutationZ
          const b = this.permutations[permutationX + 1]
          const ba = this.permutations[b] + permutationZ
          const first = this.lerp(
            fadeX,
            this.grad2(this.permutations[aa], x, z),
            this.grad(this.permutations[ba], x - 1, 0, z)
          )
          const second = this.lerp(
            fadeX,
            this.grad(this.permutations[aa + 1], x, 0, z - 1),
            this.grad(this.permutations[ba + 1], x - 1, 0, z - 1)
          )
          output[outputIndex++] += this.lerp(fadeZ, first, second) * inverseAmplitude
        }
      }
      return
    }

    let outputIndex = 0
    let previousY = -1
    let x00 = 0, x10 = 0, x01 = 0, x11 = 0
    const inverseAmplitude = 1 / amplitude
    for (let xIndex = 0; xIndex < sizeX; xIndex++) {
      let x = originX + xIndex * scaleX + this.xCoord
      const floorX = floor(x)
      const permutationX = floorX & 255
      x -= floorX
      const fadeX = x * x * x * (x * (x * 6 - 15) + 10)
      for (let zIndex = 0; zIndex < sizeZ; zIndex++) {
        let z = originZ + zIndex * scaleZ + this.zCoord
        const floorZ = floor(z)
        const permutationZ = floorZ & 255
        z -= floorZ
        const fadeZ = z * z * z * (z * (z * 6 - 15) + 10)
        for (let yIndex = 0; yIndex < sizeY; yIndex++) {
          let y = originY + yIndex * scaleY + this.yCoord
          const floorY = floor(y)
          const permutationY = floorY & 255
          y -= floorY
          const fadeY = y * y * y * (y * (y * 6 - 15) + 10)
          if (yIndex === 0 || permutationY !== previousY) {
            previousY = permutationY
            const a = this.permutations[permutationX] + permutationY
            const aa = this.permutations[a] + permutationZ
            const ab = this.permutations[a + 1] + permutationZ
            const b = this.permutations[permutationX + 1] + permutationY
            const ba = this.permutations[b] + permutationZ
            const bb = this.permutations[b + 1] + permutationZ
            x00 = this.lerp(fadeX,
              this.grad(this.permutations[aa], x, y, z),
              this.grad(this.permutations[ba], x - 1, y, z))
            x10 = this.lerp(fadeX,
              this.grad(this.permutations[ab], x, y - 1, z),
              this.grad(this.permutations[bb], x - 1, y - 1, z))
            x01 = this.lerp(fadeX,
              this.grad(this.permutations[aa + 1], x, y, z - 1),
              this.grad(this.permutations[ba + 1], x - 1, y, z - 1))
            x11 = this.lerp(fadeX,
              this.grad(this.permutations[ab + 1], x, y - 1, z - 1),
              this.grad(this.permutations[bb + 1], x - 1, y - 1, z - 1))
          }
          const near = this.lerp(fadeY, x00, x10)
          const far = this.lerp(fadeY, x01, x11)
          output[outputIndex++] += this.lerp(fadeZ, near, far) * inverseAmplitude
        }
      }
    }
  }
}

/** Exact port of Minecraft 1.2.5 NoiseGeneratorOctaves. */
export class NoiseGeneratorOctaves {
  private readonly generators: NoiseGeneratorPerlin[]

  constructor(random: JavaRandom, octaves: number) {
    this.generators = Array.from({ length: octaves }, () => new NoiseGeneratorPerlin(random))
  }

  generate3D(
    output: Float64Array | null,
    x: number,
    y: number,
    z: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number
  ): Float64Array {
    const required = sizeX * sizeY * sizeZ
    const result = output && output.length >= required ? output : new Float64Array(required)
    result.fill(0)
    let amplitude = 1
    for (const generator of this.generators) {
      let originX = x * amplitude * scaleX
      const originY = y * amplitude * scaleY
      let originZ = z * amplitude * scaleZ
      let floorX = Math.floor(originX)
      let floorZ = Math.floor(originZ)
      originX -= floorX
      originZ -= floorZ
      floorX %= 0x1000000
      floorZ %= 0x1000000
      originX += floorX
      originZ += floorZ
      generator.add(
        result, originX, originY, originZ, sizeX, sizeY, sizeZ,
        scaleX * amplitude, scaleY * amplitude, scaleZ * amplitude, amplitude
      )
      amplitude /= 2
    }
    return result
  }

  generate2D(
    output: Float64Array | null,
    x: number,
    z: number,
    sizeX: number,
    sizeZ: number,
    scaleX: number,
    scaleZ: number,
    scaleY = 1
  ): Float64Array {
    return this.generate3D(output, x, 10, z, sizeX, 1, sizeZ, scaleX, scaleY, scaleZ)
  }
}
