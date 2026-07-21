import type { WorldGenVersion } from './WorldGen'
import type { StructurePlan } from './structures/Types'

export type WorldGenWorkerRequest =
  | { type: 'init'; seed: string; version: WorldGenVersion }
  | { type: 'generate'; id: number; cx: number; cz: number }

export type WorldGenWorkerResponse =
  | {
      type: 'generated'
      id: number
      cx: number
      cz: number
      blocks: ArrayBuffer
      colBiome: ArrayBuffer
      colHeight: ArrayBuffer
      structurePlans: StructurePlan[]
    }
  | { type: 'error'; id: number; cx: number; cz: number; message: string }
