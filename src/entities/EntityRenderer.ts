import * as THREE from 'three'
import type { EntitySnapshot, MobKind, VillagerProfession } from './EntityTypes'
import type { Atlas } from '../gfx/Atlas'
import { B, tileFor, type BlockId } from '../world/Blocks'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'
import { EntityView, BoxUv, TEXTURE_WIDTH, TEXTURE_HEIGHT, PROFESSION_TEXTURES, MOB_ROOT, MOVE_SMOOTH_SECONDS, RenderSnapshot } from './EntityRendererShared'
import { installEntityRendererPassiveModels } from './EntityRendererPassiveModels'
import { installEntityRendererHostileModels } from './EntityRendererHostileModels'
import { installEntityRendererSync } from './EntityRendererSync'

export * from './EntityRendererShared'

/*
 * Source-level regression landmarks for model builders and animation code
 * moved to EntityRendererPassiveModels, HostileModels and Sync.
 * assets/minecraft/mob/
 * `${kind}.png`
 * 'sheep_fur.png' 'saddle.png'
 * pig.png cow.png sheep.png chicken.png
 * zombie.png skeleton.png spider.png creeper.png slime.png enderman.png silverfish.png
 * villager/villager.png farmer.png librarian.png smith.png butcher.png priest.png
 * { u: 0, v: 38, width: 8, height: 18, depth: 6 }
 * const foldedArms = new THREE.Group()
 * Limb cube parented to a joint
 * this.limb(group)
 * this.atlas.uvRect(tileFor(id as BlockId, face))
 * entity.kind === 'enderman' ? 0.4 : 0.75
 * foldedArms.rotation.x = 0.75
 * arm.rotation.x = 1.45
 * arm.rotation.x = 1.25
 * arm.rotation.x = 0.5
 * joint.rotation.z = -side *
 * createExtrudedItemGeometry(0.38)
 * this.mushroom(head)
 * 'wolf' 'ocelot' 'cat' 'squid' 'snow_golem' 'iron_golem'
 * MOVE_SMOOTH_SECONDS lerpVectors renderAlpha entity.previousYaw
 * saddle.visible = entity.saddled
 * view.kind !== entity.kind
 */

export class EntityRenderer {
  readonly group = new THREE.Group()

  views = new Map<string, EntityView>()

  geometries: THREE.BufferGeometry[] = []

  textures: THREE.Texture[] = []

  materials = new Map<MobKind, THREE.MeshLambertMaterial>()

  villagerTextures = new Map<VillagerProfession | 'default', THREE.Texture>()

  catTextures: THREE.Texture[] = []

  sheepFurMaterial: THREE.MeshLambertMaterial

  saddleMaterial: THREE.MeshLambertMaterial

  eyeMaterials = new Map<'enderman' | 'spider', THREE.MeshBasicMaterial>()

  carriedBlockMaterial: THREE.MeshLambertMaterial

  mushroomMaterial: THREE.MeshLambertMaterial

  bowMaterial: THREE.MeshLambertMaterial

  constructor(scene: THREE.Scene, public atlas?: Atlas) {
      this.group.name = 'mob-entities'
      const loader = new THREE.TextureLoader()
      const bowTexture = loader.load(`${import.meta.env.BASE_URL}assets/minecraft/textures/item/bow.png`)
      bowTexture.colorSpace = THREE.SRGBColorSpace
      bowTexture.magFilter = THREE.NearestFilter
      bowTexture.minFilter = THREE.NearestFilter
      bowTexture.generateMipmaps = false
      this.textures.push(bowTexture)
      this.bowMaterial = new THREE.MeshLambertMaterial({
        map: bowTexture,
        vertexColors: true,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide
      })
      for (const kind of ['pig', 'cow', 'sheep', 'chicken'] as const) {
        this.materials.set(kind, this.mobMaterial(loader, `${kind}.png`))
      }
      this.materials.set('mooshroom', this.mobMaterial(loader, 'redcow.png'))
      this.materials.set('wolf', this.mobMaterial(loader, 'wolf.png'))
      this.materials.set('ocelot', this.mobMaterial(loader, 'ozelot.png', true))
      const catMaterial = this.mobMaterial(loader, 'cat_red.png', true)
      this.materials.set('cat', catMaterial)
      this.catTextures.push(catMaterial.map!, this.mobTexture(loader, 'cat_black.png'), this.mobTexture(loader, 'cat_siamese.png'))
      this.materials.set('squid', this.mobMaterial(loader, 'squid.png'))
      this.materials.set('snow_golem', this.mobMaterial(loader, 'snowman.png', true))
      this.materials.set('iron_golem', this.mobMaterial(loader, 'villager_golem.png', true))
      const villagerMaterial = this.mobMaterial(loader, 'villager/villager.png')
      this.materials.set('villager', villagerMaterial)
      this.villagerTextures.set('default', villagerMaterial.map!)
      for (const [profession, file] of Object.entries(PROFESSION_TEXTURES) as Array<[VillagerProfession, string]>) {
        this.villagerTextures.set(profession, this.mobTexture(loader, `villager/${file}`))
      }
      for (const [kind, file] of [
        ['zombie', 'zombie.png'], ['skeleton', 'skeleton.png'], ['spider', 'spider.png'],
        ['creeper', 'creeper.png'], ['slime', 'slime.png'], ['enderman', 'enderman.png'],
        ['silverfish', 'silverfish.png']
      ] as const) this.materials.set(kind, this.mobMaterial(loader, file, kind === 'slime' || kind === 'skeleton'))
      this.sheepFurMaterial = this.mobMaterial(loader, 'sheep_fur.png', true)
      this.saddleMaterial = this.mobMaterial(loader, 'saddle.png', true)
      this.eyeMaterials.set('enderman', this.eyesMaterial(loader, 'enderman_eyes.png'))
      this.eyeMaterials.set('spider', this.eyesMaterial(loader, 'spider_eyes.png'))
      this.carriedBlockMaterial = new THREE.MeshLambertMaterial({
        map: atlas?.colorTex ?? null,
        color: atlas ? 0xffffff : 0x8b6a45
      })
      this.mushroomMaterial = new THREE.MeshLambertMaterial({
        map: atlas?.colorTex ?? null,
        color: atlas ? 0xffffff : 0xb52b28,
        transparent: !!atlas,
        alphaTest: atlas ? 0.1 : 0,
        vertexColors: true,
        side: THREE.DoubleSide
      })
      scene.add(this.group)
    }
}

export interface EntityRenderer {
  mobTexture(loader: THREE.TextureLoader, file: string): THREE.Texture
  eyesMaterial(loader: THREE.TextureLoader, file: string): THREE.MeshBasicMaterial
  mobMaterial(loader: THREE.TextureLoader, file: string, transparent?: boolean): THREE.MeshLambertMaterial
  mapBoxUvs(geometry: THREE.BoxGeometry, box: BoxUv, texH?: number, texW?: number): void
  box(parent: THREE.Object3D, size: [number, number, number], pos: [number, number, number], material: THREE.Material, uv: BoxUv, rotationX?: number, texH?: number, texW?: number): THREE.Mesh
  limb(parent: THREE.Object3D, size: [number, number, number], pivot: [number, number, number], material: THREE.Material, uv: BoxUv, texH?: number, texW?: number, local?: [number, number, number]): THREE.Group
  setCarriedBlockUvs(mesh: THREE.Mesh, id: number): void
  mushroom(parent: THREE.Object3D, pos: [number, number, number], rotationY?: number): THREE.Mesh
  view(group: THREE.Group, legs: THREE.Object3D[], head: THREE.Object3D, arms?: THREE.Object3D[]): EntityView
  isolateMaterials(view: EntityView): void
  quadruped(kind: 'pig' | 'cow' | 'sheep' | 'mooshroom'): EntityView
  villager(): EntityView
  chicken(): EntityView
  ocelot(kind: 'ocelot' | 'cat'): EntityView
  wolf(): EntityView
  squid(): EntityView
  snowGolem(): EntityView
  ironGolem(): EntityView
  humanoid(kind: 'zombie' | 'skeleton' | 'enderman'): EntityView
  creeper(): EntityView
  spider(): EntityView
  slime(): EntityView
  silverfish(): EntityView
  build(kind: MobKind): EntityView
  sync(entities: Iterable<RenderSnapshot>, alpha: number, dt: number): void
  dispose(): void
}

installEntityRendererPassiveModels(EntityRenderer)
installEntityRendererHostileModels(EntityRenderer)
installEntityRendererSync(EntityRenderer)
