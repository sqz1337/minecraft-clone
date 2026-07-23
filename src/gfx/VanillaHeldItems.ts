import * as THREE from 'three'
import { ITEMS, type ItemDefinition } from '../world/Items'

const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/minecraft/`

interface VanillaModelJson {
  parent?: string
  textures?: Record<string, string>
  display?: Record<string, { rotation?: [number, number, number] }>
}

export interface VanillaHeldModel {
  readonly texture: THREE.Texture
  readonly firstPersonRotation: readonly [number, number, number]
}

const NAME_OVERRIDES: Readonly<Record<string, string | null>> = {
  seeds: 'wheat_seeds',
  slimeball: 'slime_ball',
  raw_porkchop: 'porkchop',
  raw_beef: 'beef',
  steak: 'cooked_beef',
  raw_chicken: 'chicken',
  raw_mutton: 'mutton',
  compass: 'compass_16',
  clock: 'clock_00',
  bed: null, // 26.2 uses a composite two-block model; keep the existing bed icon for now.
  wood_door: null, // this legacy registry uses the canonical gui/items.png door cell
  emerald: null, // no extracted vanilla asset (emerald is 1.3+); the tinted sprite is used instead
  redstone: null, // these restored legacy materials intentionally use gui/items.png cells
  brick: null,
  clay_ball: null,
  lapis_lazuli: null,
  saddle: null,
  snowball: null,
  milk_bucket: null,
  raw_fish: null,
  ink_sac: null,
  map: 'filled_map'
}

/** Maps the project's item registry to names in the official Java client. */
export function vanillaHeldModelName(item: ItemDefinition): string | null {
  if (item.tool) {
    const material = item.tool.tier.key === 'wood' ? 'wooden'
      : item.tool.tier.key === 'gold' ? 'golden'
        : item.tool.tier.key
    return `${material}_${item.tool.type}`
  }
  if (item.armor) {
    const material = item.armor.material === 'gold' ? 'golden' : item.armor.material
    const piece = item.armor.slot === 'head' ? 'helmet'
      : item.armor.slot === 'chest' ? 'chestplate'
        : item.armor.slot === 'legs' ? 'leggings' : 'boots'
    return `${material}_${piece}`
  }
  return item.key in NAME_OVERRIDES ? NAME_OVERRIDES[item.key] : item.key
}

interface ResolvedJson {
  textureName?: string
  firstPersonRotation: [number, number, number]
}

/** Loads the original item JSONs and the PNG layers referenced by them. */
export class VanillaHeldItems {
  private byItem = new Map<number, VanillaHeldModel>()
  private bowFrames: VanillaHeldModel[] = []
  private jsonCache = new Map<string, Promise<ResolvedJson>>()
  private textureCache = new Map<string, Promise<THREE.Texture>>()

  async build(): Promise<void> {
    const loads: Promise<void>[] = []
    for (const item of ITEMS) {
      if (!item?.sprite) continue
      const name = vanillaHeldModelName(item)
      if (!name) continue
      loads.push(this.load(name).then(model => { this.byItem.set(item.id, model) }))
    }
    loads.push(Promise.all(['bow', 'bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2'].map(name => this.load(name)))
      .then(frames => { this.bowFrames = frames }))
    await Promise.all(loads)
  }

  get(itemId: number): VanillaHeldModel | null {
    return this.byItem.get(itemId) ?? null
  }

  bow(stage: number): VanillaHeldModel {
    return this.bowFrames[Math.max(0, Math.min(this.bowFrames.length - 1, stage))]
  }

  private async load(name: string): Promise<VanillaHeldModel> {
    const json = await this.resolveJson(name)
    if (!json.textureName) throw new Error(`Vanilla model ${name} has no layer0 texture`)
    return {
      texture: await this.loadTexture(json.textureName),
      firstPersonRotation: json.firstPersonRotation
    }
  }

  private resolveJson(name: string): Promise<ResolvedJson> {
    const cached = this.jsonCache.get(name)
    if (cached) return cached
    const pending = (async (): Promise<ResolvedJson> => {
      const response = await fetch(`${ASSET_ROOT}models/item/${name}.json`)
      if (!response.ok) throw new Error(`Missing vanilla held-item model: ${name}`)
      const own = await response.json() as VanillaModelJson
      let inherited: ResolvedJson | null = null
      const parent = own.parent?.replace(/^minecraft:item\//, '').replace(/^item\//, '')
      if (parent && !parent.startsWith('builtin/')) inherited = await this.resolveJson(parent)
      const textureRef = own.textures?.layer0
      const textureName = textureRef?.replace(/^minecraft:item\//, '').replace(/^item\//, '') ?? inherited?.textureName
      const rotation = own.display?.firstperson_righthand?.rotation ?? inherited?.firstPersonRotation ?? [0, -90, 25]
      return { textureName, firstPersonRotation: rotation }
    })()
    this.jsonCache.set(name, pending)
    return pending
  }

  private loadTexture(name: string): Promise<THREE.Texture> {
    const cached = this.textureCache.get(name)
    if (cached) return cached
    const pending = new THREE.TextureLoader().loadAsync(`${ASSET_ROOT}textures/item/${name}.png`).then(texture => {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.generateMipmaps = false
      return texture
    })
    this.textureCache.set(name, pending)
    return pending
  }
}

export async function createVanillaHeldItems(): Promise<VanillaHeldItems> {
  const items = new VanillaHeldItems()
  await items.build()
  return items
}
