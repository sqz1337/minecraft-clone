import { B } from '../world/Blocks'
import { I } from '../world/ItemIds'
import type { VillagerProfession } from './EntityTypes'

export interface TradeStack {
  id: number
  count: number
}

export interface VillagerTrade {
  cost: TradeStack
  result: TradeStack
}

/**
 * Simple fixed trade lists per profession (emeralds in and out), modelled on the
 * classic 1.3 villager offers. Trades never lock and have no price drift.
 */
export const VILLAGER_TRADES: Readonly<Record<VillagerProfession, readonly VillagerTrade[]>> = {
  farmer: [
    { cost: { id: I.WHEAT, count: 20 }, result: { id: I.EMERALD, count: 1 } },
    { cost: { id: I.EMERALD, count: 1 }, result: { id: I.BREAD, count: 6 } },
    { cost: { id: I.EMERALD, count: 1 }, result: { id: I.APPLE, count: 4 } }
  ],
  librarian: [
    { cost: { id: I.PAPER, count: 24 }, result: { id: I.EMERALD, count: 1 } },
    { cost: { id: I.EMERALD, count: 1 }, result: { id: I.BOOK, count: 2 } },
    { cost: { id: I.EMERALD, count: 10 }, result: { id: B.BOOKSHELF, count: 1 } }
  ],
  blacksmith: [
    { cost: { id: I.COAL, count: 16 }, result: { id: I.EMERALD, count: 1 } },
    { cost: { id: I.EMERALD, count: 3 }, result: { id: I.IRON_SWORD, count: 1 } },
    { cost: { id: I.EMERALD, count: 5 }, result: { id: I.IRON_PICKAXE, count: 1 } }
  ],
  butcher: [
    { cost: { id: I.RAW_PORKCHOP, count: 6 }, result: { id: I.EMERALD, count: 1 } },
    { cost: { id: I.RAW_BEEF, count: 6 }, result: { id: I.EMERALD, count: 1 } },
    { cost: { id: I.EMERALD, count: 1 }, result: { id: I.COOKED_PORKCHOP, count: 5 } }
  ],
  priest: [
    { cost: { id: I.ROTTEN_FLESH, count: 32 }, result: { id: I.EMERALD, count: 1 } },
    { cost: { id: I.GOLD_INGOT, count: 8 }, result: { id: I.EMERALD, count: 1 } },
    { cost: { id: I.EMERALD, count: 1 }, result: { id: I.ENDER_PEARL, count: 2 } }
  ]
}
