const MULTIPLIER = 0x5deece66dn
const ADDEND = 0xbn
const MASK = (1n << 48n) - 1n
const WORD_BITS = 24
const WORD_BASE = 0x1000000
const MULTIPLIER_LOW = Number(MULTIPLIER & 0xffffffn)
const MULTIPLIER_HIGH = Number(MULTIPLIER >> 24n)
const LONG_MIN = -(1n << 63n)
const LONG_MAX = (1n << 63n) - 1n

/** Java's signed 64-bit overflow semantics. */
export function long(value: bigint | number): bigint {
  return BigInt.asIntN(64, typeof value === 'number' ? BigInt(Math.trunc(value)) : value)
}

/** Java's signed 32-bit overflow semantics. */
export function int32(value: bigint | number): number {
  const raw = typeof value === 'number' ? BigInt(Math.trunc(value)) : value
  return Number(BigInt.asIntN(32, raw))
}

export function javaStringHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0
  }
  return hash
}

/**
 * Matches Minecraft's create-world seed parsing: valid signed longs stay
 * numeric, all other non-empty strings use String.hashCode().
 */
export function parseJavaWorldSeed(value: string): bigint {
  if (/^[+-]?\d+$/.test(value)) {
    try {
      const parsed = BigInt(value)
      if (parsed >= LONG_MIN && parsed <= LONG_MAX) return parsed
    } catch {
      // Fall through to the same String.hashCode path as the Java client.
    }
  }
  return BigInt(javaStringHash(value))
}

/** Bit-for-bit port of java.util.Random's 48-bit LCG. */
export class JavaRandom {
  private seedHigh = 0
  private seedLow = 0

  constructor(seed: bigint | number = 0n) {
    this.setSeed(seed)
  }

  setSeed(seed: bigint | number): void {
    const value = typeof seed === 'number' ? BigInt(Math.trunc(seed)) : seed
    const scrambled = (value ^ MULTIPLIER) & MASK
    this.seedHigh = Number(scrambled >> 24n)
    this.seedLow = Number(scrambled & 0xffffffn)
  }

  next(bits: number): number {
    // Base-2^24 multiplication keeps every intermediate below 2^53, avoiding
    // BigInt in the hot cave/noise path while remaining exactly 48-bit.
    const lowProduct = this.seedLow * MULTIPLIER_LOW + Number(ADDEND)
    const nextLow = lowProduct % WORD_BASE
    const carry = Math.floor(lowProduct / WORD_BASE)
    const nextHigh = (this.seedHigh * MULTIPLIER_LOW +
      this.seedLow * MULTIPLIER_HIGH + carry) % WORD_BASE
    this.seedHigh = nextHigh
    this.seedLow = nextLow
    if (bits <= WORD_BITS) return Math.floor(nextHigh / 2 ** (WORD_BITS - bits))
    return nextHigh * 2 ** (bits - WORD_BITS) +
      Math.floor(nextLow / 2 ** (48 - bits))
  }

  nextInt(bound?: number): number {
    if (bound === undefined) return this.next(32) | 0
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0x7fffffff) {
      throw new RangeError(`JavaRandom.nextInt bound must be in 1..2147483647, got ${bound}`)
    }
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n)
    }
    for (;;) {
      const bits = this.next(31)
      const value = bits % bound
      // Java performs this expression as a signed int.
      if (bits - value + (bound - 1) <= 0x7fffffff) return value
    }
  }

  nextLong(): bigint {
    const high = BigInt(this.next(32) | 0)
    const low = BigInt(this.next(32) | 0)
    return BigInt.asIntN(64, (high << 32n) + low)
  }

  nextBoolean(): boolean { return this.next(1) !== 0 }

  nextFloat(): number { return this.next(24) / 0x1000000 }

  nextDouble(): number {
    return (this.next(26) * 0x8000000 + this.next(27)) / 0x20000000000000
  }
}
