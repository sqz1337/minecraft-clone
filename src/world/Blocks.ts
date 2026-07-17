/** Block ids. Stored per-voxel in chunk Uint8Arrays. */
export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  SNOW: 5,
  LOG: 6,
  LEAVES: 7,
  WATER: 8,
  GRAVEL: 9,
  BEDROCK: 10,
  PLANKS: 11,
  TALLGRASS: 12,
  FLOWER_Y: 13,
  FLOWER_R: 14,
  PINELOG: 15,
  PINELEAVES: 16
} as const

export type BlockId = number

const N = 17

export const NAMES: string[] = new Array(N).fill('?')
export const SOLID: boolean[] = new Array(N).fill(false)
export const OPAQUE: boolean[] = new Array(N).fill(false)
export const CROSS: boolean[] = new Array(N).fill(false)
export const BREAK_TIME: number[] = new Array(N).fill(0.5)
export const SOUND_CAT: string[] = new Array(N).fill('stone')

/** Atlas tile indices (8x8 grid). */
export const TILE = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, SAND: 4, SNOW: 5,
  LOG_SIDE: 6, LOG_TOP: 7, LEAVES: 8, GRAVEL: 9, BEDROCK: 10, PLANKS: 11,
  TALLGRASS: 12, FLOWER_Y: 13, FLOWER_R: 14, PINELOG: 15, PINELEAVES: 16, WATER: 17,
  PINELOG_TOP: 18
} as const

function def(id: number, name: string, opts: {
  solid?: boolean; opaque?: boolean; cross?: boolean; time?: number; sound?: string
}) {
  NAMES[id] = name
  SOLID[id] = opts.solid ?? true
  OPAQUE[id] = opts.opaque ?? true
  CROSS[id] = opts.cross ?? false
  BREAK_TIME[id] = opts.time ?? 0.5
  SOUND_CAT[id] = opts.sound ?? 'stone'
}

def(B.AIR, 'Air', { solid: false, opaque: false, time: Infinity, sound: 'none' })
def(B.GRASS, 'Grass Block', { time: 0.5, sound: 'grass' })
def(B.DIRT, 'Dirt', { time: 0.45, sound: 'dirt' })
def(B.STONE, 'Stone', { time: 1.5, sound: 'stone' })
def(B.SAND, 'Sand', { time: 0.4, sound: 'sand' })
def(B.SNOW, 'Snow', { time: 0.35, sound: 'snow' })
def(B.LOG, 'Oak Log', { time: 1.0, sound: 'wood' })
def(B.LEAVES, 'Oak Leaves', { opaque: false, time: 0.25, sound: 'leaf' })
def(B.WATER, 'Water', { solid: false, opaque: false, time: Infinity, sound: 'none' })
def(B.GRAVEL, 'Gravel', { time: 0.5, sound: 'dirt' })
def(B.BEDROCK, 'Bedrock', { time: Infinity, sound: 'stone' })
def(B.PLANKS, 'Oak Planks', { time: 1.0, sound: 'wood' })
def(B.TALLGRASS, 'Tall Grass', { solid: false, opaque: false, cross: true, time: 0.05, sound: 'leaf' })
def(B.FLOWER_Y, 'Dandelion', { solid: false, opaque: false, cross: true, time: 0.05, sound: 'leaf' })
def(B.FLOWER_R, 'Poppy', { solid: false, opaque: false, cross: true, time: 0.05, sound: 'leaf' })
def(B.PINELOG, 'Pine Log', { time: 1.0, sound: 'wood' })
def(B.PINELEAVES, 'Pine Needles', { opaque: false, time: 0.25, sound: 'leaf' })

/** Faces: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. */
export function tileFor(id: BlockId, face: number): number {
  switch (id) {
    case B.GRASS: return face === 2 ? TILE.GRASS_TOP : face === 3 ? TILE.DIRT : TILE.GRASS_SIDE
    case B.DIRT: return TILE.DIRT
    case B.STONE: return TILE.STONE
    case B.SAND: return TILE.SAND
    case B.SNOW: return TILE.SNOW
    case B.LOG: return face === 2 || face === 3 ? TILE.LOG_TOP : TILE.LOG_SIDE
    case B.PINELOG: return face === 2 || face === 3 ? TILE.PINELOG_TOP : TILE.PINELOG
    case B.LEAVES: return TILE.LEAVES
    case B.PINELEAVES: return TILE.PINELEAVES
    case B.WATER: return TILE.WATER
    case B.GRAVEL: return TILE.GRAVEL
    case B.BEDROCK: return TILE.BEDROCK
    case B.PLANKS: return TILE.PLANKS
    case B.TALLGRASS: return TILE.TALLGRASS
    case B.FLOWER_Y: return TILE.FLOWER_Y
    case B.FLOWER_R: return TILE.FLOWER_R
    default: return TILE.STONE
  }
}

/** The nine hotbar blocks, in slot order. */
export const HOTBAR: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.SAND, B.LOG, B.PLANKS, B.LEAVES, B.SNOW, B.GRAVEL
]
