import * as THREE from 'three'
import {
  B, BLOCKS, HOTBAR_PAGES, SOUND_CAT, CROSS, SOLID, isContainerBlock, isDirectionalBlock, tileFor,
  isWheat, wheatAge, isFluid, isWater, isBedBlock, isDoorBlock, isLeafBlock, canSupportVine, oppositeHorizontalFace,
  type HorizontalFace
} from '../world/Blocks'
import { ITEMS, ItemDefinition, breakInfoFor, durabilityForItem } from '../world/Items'
import { I } from '../world/ItemIds'
import type { GameMode } from '../core/Settings'
import type { Inventory, ItemStack } from './Inventory'
import type { ItemDrops } from '../world/ItemDrops'
import type { World, RayHit } from '../world/World'
import type { Player } from './Player'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import type { AudioMan } from '../audio/Audio'
import type { Particles } from '../gfx/Particles'
import type { EntityManager } from '../entities/EntityManager'
import type { ProjectileManager } from '../entities/ProjectileManager'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'
import type { VanillaHeldItems } from '../gfx/VanillaHeldItems'
import { ATTACK_COOLDOWN, MELEE_REACH, bowDamage, bowPower, bowPullSprite, bowVelocity, meleeDamage } from './Combat'
import {
  additiveFortuneDropCount, enchantmentLevel, fortuneDropCount, sharpnessBonus, shouldConsumeDurability
} from './Enchantments'
import { SURVIVAL_REACH, CREATIVE_REACH, HandKind, VIEWMODEL_LAYER } from './InteractionShared'
import { installInteractionHand } from './InteractionHand'
import { installInteractionItems } from './InteractionItems'
import { installInteractionUpdate } from './InteractionUpdate'

export * from './InteractionShared'

export class Interaction {
  selected = 0

  page = 0

  world: World

  player: Player

  camera: THREE.PerspectiveCamera

  atlas: Atlas

  sprites: ItemSprites

  audio: AudioMan

  particles: Particles

  crackMesh: THREE.Mesh

  crackMat: THREE.MeshBasicMaterial

  selectionMesh: THREE.LineSegments

  hand: THREE.Mesh | null = null

  handFlat = false

  handKind: HandKind = 'item'

  handBowStage = -1

  handSwing = 0

  target: RayHit | null = null

  breaking = false

  breakProgress = 0

  breakKey = ''

  placing = false

  placeCooldown = 0

  mineTickTimer = 0

  eatProgress = 0

  eatSoundTimer = 0

  attackCooldown = 0

  attackingEntity = false

  chargingBow = false

  bowCharge = 0

  onSelectionChanged: (index: number) => void = () => {}

  onPageChanged: (page: number, blocks: readonly number[]) => void = () => {}

  onUseBlock: (hit: RayHit) => void = () => {}

  onUseMap: () => void = () => {}

  onUseNavigation: (itemId: number) => void = () => {}

  onBlockBroken: (x: number, y: number, z: number, id: number) => void = () => {}

  onExperience: (x: number, y: number, z: number, amount: number) => void = () => {}

  onUseVillager: (entityId: string) => void = () => {}

  rayDir = new THREE.Vector3()

  rayOrigin = new THREE.Vector3()

  constructor(
      world: World,
      player: Player,
      camera: THREE.PerspectiveCamera,
      scene: THREE.Scene,
      atlas: Atlas,
      sprites: ItemSprites,
      public heldItems: VanillaHeldItems,
      audio: AudioMan,
      particles: Particles,
      public mode: GameMode,
      public inventory: Inventory,
      public drops: ItemDrops,
      public entities: EntityManager,
      public projectiles: ProjectileManager
    ) {
      this.world = world
      this.player = player
      this.camera = camera
      this.atlas = atlas
      this.sprites = sprites
      this.audio = audio
      this.particles = particles

      // Block-breaking overlay. The tiny 0.008 shell + weak polygon offset used to
      // z-fight the block face on GPUs with a low-precision depth buffer (the huge
      // 0.1..1600 near/far range leaves little resolution), so parts of the crack
      // flickered in and out. A clearly larger shell, a stronger camera-ward
      // polygon offset, and DoubleSide (no back-face cull flip at grazing edges)
      // make the overlay win the depth test decisively at every angle.
      this.crackMat = new THREE.MeshBasicMaterial({
        map: atlas.crackTex[0],
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -8,
        alphaTest: 0.02
      })
      this.crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.02, 1.02, 1.02), this.crackMat)
      this.crackMesh.visible = false
      this.crackMesh.renderOrder = 3
      scene.add(this.crackMesh)

      const selectionGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.01, 1.01, 1.01))
      this.selectionMesh = new THREE.LineSegments(selectionGeometry, new THREE.LineBasicMaterial({ color: 0x111111 }))
      this.selectionMesh.visible = false
      this.selectionMesh.renderOrder = 4
      scene.add(this.selectionMesh)

      this.buildHand()
    }

  get currentHotbar(): readonly number[] {
      return this.mode === 'survival'
        ? this.inventory.slots.slice(0, 9).map(stack => stack?.id ?? B.AIR)
        : HOTBAR_PAGES[this.page]
    }

  get selectedItemId(): number { return this.currentHotbar[this.selected] ?? B.AIR }

  get selectedItem(): ItemDefinition | null {
      const id = this.selectedItemId
      return id === B.AIR ? null : ITEMS[id] ?? null
    }

  get selectedStack(): ItemStack | null {
      return this.mode === 'survival' ? this.inventory.slots[this.selected] : null
    }

  get selectedName(): string {
      const item = this.selectedItem
      return item ? item.name : 'Empty hand'
    }

  get swingProgress(): number { return 1 - this.handSwing }

  get heldViewMesh(): THREE.Mesh | null { return this.hand }

  get showsFirstPersonArm(): boolean {
      const item = this.selectedItem
      return !!item && item.placeBlock === null && !item.tool && !item.ranged
    }
}

export interface Interaction {
  aimDirection(target: THREE.Vector3): THREE.Vector3
  aimOrigin(target: THREE.Vector3): THREE.Vector3
  setFirstPersonVisible(visible: boolean): void
  setSelected(i: number): void
  setPage(page: number): void
  cyclePage(): void
  inventoryChanged(): void
  scroll(dir: number): void
  primaryDown(): void
  primaryUp(): void
  secondaryDown(): void
  secondaryUp(): void
  releaseBow(): void
  dropSelected(all?: boolean): void
  buildHand(): void
  updateBowVisual(): void
  applyHandPose(swingProgress: number): void
  swing(): void
  chestFits(px: number, py: number, pz: number): boolean
  facingTowardPlayer(px: number, pz: number, axis?: 'x' | 'z'): HorizontalFace
  alignChestPair(px: number, py: number, pz: number, placedFacing: HorizontalFace): void
  damageHeldItem(amount?: number): void
  spawnBlockDrops(id: number, x: number, y: number, z: number, harvest: boolean): void
  dropAutomaticBlock(x: number, y: number, z: number, id: number): void
  dropExplodedBlock(x: number, y: number, z: number, id: number): void
  useFarmingItem(hit: RayHit): boolean
  finishEating(item: ItemDefinition): void
  finishDrinkingMilk(): void
  replaceOneHeldItem(resultId: number): void
  useEntityInteraction(entityId: string): boolean
  useStageNineItem(hit: RayHit): boolean
  useBedItem(hit: RayHit): boolean
  update(dt: number): void
  dispose(): void
}

installInteractionHand(Interaction)
installInteractionItems(Interaction)
installInteractionUpdate(Interaction)
