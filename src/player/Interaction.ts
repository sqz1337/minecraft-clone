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

const SURVIVAL_REACH = 4.5
const CREATIVE_REACH = 5.5
type HandKind = 'block' | 'tool' | 'bow' | 'item'

/**
 * Layer used exclusively by the first-person view model. The main render pass
 * omits this layer; a second pass clears the depth buffer and draws only this
 * layer, so the held item self-occludes correctly yet always sits on top of the
 * world (even the block being mined). Game enables it on the scene lights too.
 */
export const VIEWMODEL_LAYER = 1

export class Interaction {
  selected = 0
  page = 0
  private world: World
  private player: Player
  private camera: THREE.PerspectiveCamera
  private atlas: Atlas
  private sprites: ItemSprites
  private audio: AudioMan
  private particles: Particles

  private crackMesh: THREE.Mesh
  private crackMat: THREE.MeshBasicMaterial
  private selectionMesh: THREE.LineSegments
  private hand: THREE.Mesh | null = null
  private handFlat = false
  private handKind: HandKind = 'item'
  private handBowStage = -1
  private handSwing = 0

  private target: RayHit | null = null
  private breaking = false
  private breakProgress = 0
  private breakKey = ''
  private placing = false
  private placeCooldown = 0
  private mineTickTimer = 0
  private eatProgress = 0
  private attackCooldown = 0
  private attackingEntity = false
  private chargingBow = false
  private bowCharge = 0

  onSelectionChanged: (index: number) => void = () => {}
  onPageChanged: (page: number, blocks: readonly number[]) => void = () => {}
  /** Fired when the player right-clicks a usable block (crafting table, furnace, chest, bed) without crouching. */
  onUseBlock: (hit: RayHit) => void = () => {}
  /** Fired when the player uses a map item. */
  onUseMap: () => void = () => {}
  /** Fired when the player checks a compass or clock. */
  onUseNavigation: (itemId: number) => void = () => {}
  /** Fired after any block has been broken, with its previous id. */
  onBlockBroken: (x: number, y: number, z: number, id: number) => void = () => {}
  /** Spawns recoverable XP at a gameplay source such as an ore. */
  onExperience: (x: number, y: number, z: number, amount: number) => void = () => {}
  /** Fired when the player right-clicks a villager to trade. */
  onUseVillager: (entityId: string) => void = () => {}

  private rayDir = new THREE.Vector3()
  private rayOrigin = new THREE.Vector3()

  constructor(
    world: World,
    player: Player,
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    atlas: Atlas,
    sprites: ItemSprites,
    private heldItems: VanillaHeldItems,
    audio: AudioMan,
    particles: Particles,
    private mode: GameMode,
    private inventory: Inventory,
    private drops: ItemDrops,
    private entities: EntityManager,
    private projectiles: ProjectileManager
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

  setSelected(i: number): void {
    const hotbar = this.currentHotbar
    this.selected = ((i % hotbar.length) + hotbar.length) % hotbar.length
    this.buildHand()
    this.onSelectionChanged(this.selected)
  }

  setPage(page: number): void {
    if (this.mode === 'survival') return
    this.page = ((page % HOTBAR_PAGES.length) + HOTBAR_PAGES.length) % HOTBAR_PAGES.length
    this.selected = Math.min(this.selected, this.currentHotbar.length - 1)
    this.buildHand()
    this.onPageChanged(this.page, this.currentHotbar)
    this.onSelectionChanged(this.selected)
  }

  cyclePage(): void { if (this.mode === 'creative') this.setPage(this.page + 1) }

  inventoryChanged(): void {
    this.buildHand()
    this.onPageChanged(this.page, this.currentHotbar)
    this.onSelectionChanged(this.selected)
  }

  scroll(dir: number): void {
    this.setSelected(this.selected + (dir > 0 ? 1 : -1))
  }

  primaryDown(): void {
    this.breaking = true
    this.attackingEntity = false
    // A left click always swings, even when the ray hits only air. Damage and
    // block breaking are still decided independently in update().
    this.swing()
  }
  primaryUp(): void {
    this.breaking = false
    this.breakProgress = 0
    this.crackMesh.visible = false
    this.attackingEntity = false
  }
  secondaryDown(): void {
    if (this.selectedItem?.ranged === 'bow') {
      this.chargingBow = true
      this.bowCharge = 0
      this.placing = false
      return
    }
    this.placing = true
    this.placeCooldown = 0
  }
  secondaryUp(): void {
    if (this.chargingBow) this.releaseBow()
    this.chargingBow = false
    this.bowCharge = 0
    this.placing = false
    this.eatProgress = 0
  }

  private releaseBow(): void {
    const power = bowPower(this.bowCharge)
    if (power < 0.1 || this.selectedItem?.ranged !== 'bow') return
    const powerLevel = enchantmentLevel(this.selectedStack, 'power')
    if (this.mode === 'survival') {
      const infinity = enchantmentLevel(this.selectedStack, 'infinity') > 0
      const arrowSlot = this.inventory.slots.findIndex(stack => stack?.id === I.ARROW)
      if (arrowSlot < 0) return
      if (!infinity) this.inventory.remove(arrowSlot, 1)
      this.damageHeldItem()
    }
    this.camera.getWorldDirection(this.rayDir)
    const origin = this.camera.getWorldPosition(this.rayOrigin).addScaledVector(this.rayDir, 0.45)
    const punch = enchantmentLevel(this.selectedStack, 'punch')
    const flame = enchantmentLevel(this.selectedStack, 'flame')
    this.projectiles.shoot(
      origin,
      this.rayDir,
      bowVelocity(power),
      bowDamage(power, powerLevel),
      'player',
      { knockback: 2.8 + punch * 1.6, fireSeconds: flame > 0 ? 5 : 0 }
    )
    this.audio.bowShoot(power)
    this.swing()
  }

  /** Throws the complete selected stack forward as one item entity. */
  /** Tap drops a single item; `all` (a held Q) throws the whole selected stack. */
  dropSelected(all = false): void {
    const item = this.selectedItem
    if (!item) return
    let count = 1
    let damage: number | undefined
    let enchantments: ItemStack['enchantments']
    if (this.mode === 'survival') {
      const stack = this.selectedStack
      if (!stack) return
      count = all ? stack.count : 1
      damage = stack.damage
      enchantments = stack.enchantments?.map(enchantment => ({ ...enchantment }))
      this.inventory.remove(this.selected, count)
    }
    this.camera.getWorldDirection(this.rayDir)
    const eye = this.camera.getWorldPosition(this.rayOrigin)
    const velocity = this.rayDir.clone().multiplyScalar(6)
    velocity.y += 2
    this.drops.spawn(item.id, eye.x + this.rayDir.x * 0.4, eye.y - 0.25, eye.z + this.rayDir.z * 0.4, count, {
      velocity,
      pickupDelay: 1.2,
      damage,
      enchantments
    })
    this.swing()
  }

  /** First-person held item, parented to the camera. */
  private buildHand(): void {
    if (this.hand) {
      this.camera.remove(this.hand)
      this.hand.geometry.dispose()
      ;(this.hand.material as THREE.Material).dispose()
    }
    const item = this.selectedItem
    if (!item) {
      this.hand = null
      return
    }
    const id = item.id
    this.handKind = item.ranged === 'bow' ? 'bow' : item.tool ? 'tool' : !item.sprite && !CROSS[id] ? 'block' : 'item'
    this.handFlat = this.handKind !== 'block'
    this.handBowStage = -1
    let geo: THREE.BufferGeometry
    let mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial
    if (item.sprite) {
      const size = this.handKind === 'item' ? 0.28 : this.handKind === 'bow' ? 0.7 : 0.7
      const vanilla = this.heldItems.get(id)
      geo = createExtrudedItemGeometry(size)
      // Official standalone PNGs are not mirrored. Reversing the geometry's
      // legacy U mapping puts axe heads and blades on the vanilla side.
      setExtrudedItemUv(geo, vanilla ? [1, 0, 0, 1] : this.sprites.uvRect(item.sprite[0], item.sprite[1]))
      // Flat extruded items render unlit: MeshLambert would shade each 1px edge
      // wall of the extrusion by the world sun, and because the model rotates
      // with the camera that produced a noisy, pixelated blade. Instead the
      // geometry bakes fixed face shading into vertex colours (flat faces bright,
      // side walls dim) for a stable, natural sense of depth.
      mat = new THREE.MeshBasicMaterial({
        map: vanilla?.texture ?? this.sprites.texture,
        alphaTest: 0.1,
        vertexColors: true
      })
    } else if (this.handFlat) {
      geo = createExtrudedItemGeometry(0.31)
      setExtrudedItemUv(geo, this.atlas.uvRect(tileFor(id, 0)))
      mat = new THREE.MeshBasicMaterial({
        map: this.atlas.colorTex,
        alphaTest: 0.1,
        vertexColors: true
      })
    } else {
      geo = new THREE.BoxGeometry(0.31, 0.31, 0.31)
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      for (let f = 0; f < 6; f++) {
        const [u0, v0, u1, v1] = this.atlas.uvRect(tileFor(id, f))
        for (let i = 0; i < 4; i++) {
          const vi = f * 4 + i
          uv.setXY(vi, uv.getX(vi) < 0.5 ? u0 : u1, uv.getY(vi) < 0.5 ? v0 : v1)
        }
      }
      uv.needsUpdate = true
      const colors = new Float32Array(24 * 3).fill(1)
      if (id === B.GRASS) {
        for (let i = 8; i < 12; i++) {
          colors[i * 3] = 0.62; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 0.38
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      mat = new THREE.MeshLambertMaterial({
        map: this.atlas.colorTex,
        vertexColors: true
      })
    }
    if (this.selectedStack?.enchantments?.length) {
      if (mat instanceof THREE.MeshLambertMaterial) {
        mat.emissive = new THREE.Color(0x5b2c83)
        mat.emissiveIntensity = 0.32
      } else {
        // Unlit items can't glow via emissive; a subtle violet tint keeps the cue.
        mat.color = new THREE.Color(0xe0c8ff)
      }
    }
    // The view model is drawn in its own pass (see VIEWMODEL_LAYER) against a
    // freshly cleared depth buffer, so it needs real depth testing to self-
    // occlude — front faces must hide the back/side faces instead of painting
    // over them — while still sitting on top of the world, including the block
    // being mined and transparent water. fog:false keeps the near overlay at
    // true colour through rain/storm haze.
    mat.depthTest = true
    mat.depthWrite = true
    mat.fog = false
    this.hand = new THREE.Mesh(geo, mat)
    this.hand.frustumCulled = false
    this.hand.layers.set(VIEWMODEL_LAYER)
    this.applyHandPose(0)
    this.updateBowVisual()
    this.camera.add(this.hand)
  }

  /** Classic items.png contains standby plus three bow-pulling sprites, arrow included. */
  private updateBowVisual(): void {
    if (!this.hand || this.handKind !== 'bow') return
    const [column] = bowPullSprite(this.chargingBow ? this.bowCharge : null)
    const stage = column - 5
    if (stage === this.handBowStage) return
    this.handBowStage = stage
    ;(this.hand.material as THREE.MeshBasicMaterial).map = this.heldItems.bow(stage).texture
  }

  private applyHandPose(swingProgress: number): void {
    if (!this.hand) return
    // Keep the model in the lower-right first-person area while leaving enough
    // vertical room for long tools to point up instead of crossing the hotbar.
    const poses: Record<HandKind, { position: [number, number, number]; rotation: [number, number, number] }> = {
      block: { position: [0.64, -0.33, -0.52], rotation: [0.12, Math.PI / 4, 0.06] },
      tool: { position: [0.75, -0.29, -0.70], rotation: [0.04, -1.6, 1.5] },
      bow: { position: [0.75, -0.45, -0.70], rotation: [0.04, -1.6, 1.5] },
      item: { position: [0.60, -0.23, -0.70], rotation: [0.04, -0.42, 0.44] }
    }
    const pose = poses[this.handKind]
    const vanillaRotation = this.heldItems.get(this.selectedItemId)?.firstPersonRotation
    // Three's camera convention needs the vanilla +25-degree screen roll as a
    // positive Z rotation. Negating it made diagonal tools almost horizontal.
    const toolRoll = this.handKind === 'tool' ? 5 : 0
    const modelRoll = vanillaRotation ? THREE.MathUtils.degToRad(vanillaRotation[2] + toolRoll) : pose.rotation[2]
    // Classic ItemRenderer uses different sine curves for translation and
    // rotation, producing a forward/downward jab instead of a linear tilt.
    const rootSwing = Math.sin(Math.sqrt(swingProgress) * Math.PI)
    const linearSwing = Math.sin(swingProgress * Math.PI)
    const doubleSwing = Math.sin(Math.sqrt(swingProgress) * Math.PI * 2)
    const squaredSwing = Math.sin(swingProgress * swingProgress * Math.PI)
    this.hand.position.set(
      pose.position[0] - rootSwing * 0.12,
      pose.position[1] + doubleSwing * 0.05,
      pose.position[2] - linearSwing * 0.07
    )
    this.hand.rotation.set(
      pose.rotation[0] - rootSwing * 1.35,
      pose.rotation[1] - squaredSwing * 0.35,
      modelRoll - rootSwing * 0.35
    )
    if (this.handKind === 'bow' && this.chargingBow) {
      const draw = Math.min(1, this.bowCharge)
      this.hand.position.x -= draw * 0.035
      this.hand.position.z += draw * 0.045
      this.hand.rotation.y += draw * 0.08
    }
  }

  swing(): void { this.handSwing = 1 }

  /**
   * Classic double-chest rule: a new chest may touch at most one other
   * chest, and never one that is already half of a double chest.
   */
  private chestFits(px: number, py: number, pz: number): boolean {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
    let neighbors = 0
    for (const [dx, dz] of dirs) {
      const nx = px + dx, nz = pz + dz
      if (this.world.getBlock(nx, py, nz) !== B.CHEST) continue
      neighbors++
      for (const [dx2, dz2] of dirs) {
        const fx = nx + dx2, fz = nz + dz2
        if (fx === px && fz === pz) continue
        if (this.world.getBlock(fx, py, fz) === B.CHEST) return false
      }
    }
    return neighbors <= 1
  }

  /** The placed block's front points back toward the player, as in classic Minecraft. */
  private facingTowardPlayer(px: number, pz: number, axis?: 'x' | 'z'): HorizontalFace {
    const dx = this.player.pos.x - (px + 0.5)
    const dz = this.player.pos.z - (pz + 0.5)
    if (axis === 'x' || (!axis && Math.abs(dx) > Math.abs(dz))) return dx >= 0 ? 0 : 1
    return dz >= 0 ? 4 : 5
  }

  /** A large chest faces perpendicular to its seam and both halves share one facing. */
  private alignChestPair(px: number, py: number, pz: number, placedFacing: HorizontalFace): void {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = px + dx, nz = pz + dz
      if (this.world.getBlock(nx, py, nz) !== B.CHEST) continue
      const seamAlongX = dx !== 0
      const placedIsValid = seamAlongX ? (placedFacing === 4 || placedFacing === 5) : (placedFacing === 0 || placedFacing === 1)
      const neighborFacing = this.world.getBlockFacing(nx, py, nz)
      const neighborIsValid = seamAlongX ? (neighborFacing === 4 || neighborFacing === 5) : (neighborFacing === 0 || neighborFacing === 1)
      const facing = placedIsValid
        ? placedFacing
        : neighborIsValid
          ? neighborFacing
          : this.facingTowardPlayer(px, pz, seamAlongX ? 'z' : 'x')
      this.world.setBlockFacing(nx, py, nz, facing)
      this.world.setBlockFacing(px, py, pz, facing)
      return
    }
  }

  /** Applies wear to the selected damageable item; breaks it at zero durability. */
  private damageHeldItem(amount = 1): void {
    if (this.mode !== 'survival') return
    const stack = this.selectedStack
    const durability = stack ? durabilityForItem(stack.id) : 0
    if (!stack || durability <= 0) return
    if (!shouldConsumeDurability(enchantmentLevel(stack, 'unbreaking'))) return
    stack.damage = (stack.damage ?? 0) + Math.max(1, amount)
    if (stack.damage >= durability) {
      this.inventory.slots[this.selected] = null
      this.audio.toolBreak()
    }
    this.inventory.notify()
  }

  private spawnBlockDrops(id: number, x: number, y: number, z: number, harvest: boolean): void {
    const spawn = (itemId: number, count = 1) => this.drops.spawn(itemId, x + 0.5, y + 0.45, z + 0.5, count)
    const held = this.selectedStack
    const shears = harvest && held?.id === I.SHEARS
    const silkTouch = harvest && enchantmentLevel(held, 'silk_touch') > 0
    const fortune = enchantmentLevel(held, 'fortune')
    const shearsOnlyPlant = id === B.VINE || id === B.DEAD_BUSH || id === B.TALLGRASS || id === B.FERN
    if (silkTouch && !shearsOnlyPlant && BLOCKS[id].hasItem && id !== B.FIRE && id !== B.PRIMED_TNT) {
      spawn(id)
      return
    }
    if (isWheat(id)) {
      if (wheatAge(id) >= 7) {
        spawn(I.WHEAT)
        spawn(I.SEEDS, 1 + Math.floor(Math.random() * 3))
      } else {
        spawn(I.SEEDS)
      }
      return
    }
    if (shears && (isLeafBlock(id) || id === B.VINE || id === B.DEAD_BUSH ||
      id === B.TALLGRASS || id === B.FERN)) {
      spawn(id)
      return
    }
    if (id === B.TALLGRASS || id === B.FERN) {
      if (Math.random() < 0.125) spawn(I.SEEDS)
      return
    }
    if (id === B.GRAVEL && harvest) {
      spawn(Math.random() < 0.1 ? I.FLINT : B.GRAVEL)
      return
    }
    if (isLeafBlock(id)) {
      if (id === B.LEAVES && Math.random() < 0.05) spawn(B.SAPLING_OAK)
      else if (id === B.PINELEAVES && Math.random() < 0.05) spawn(B.SAPLING_SPRUCE)
      else if (id === B.BIRCH_LEAVES && Math.random() < 0.05) spawn(B.SAPLING_BIRCH)
      if (id === B.LEAVES && Math.random() < 0.005) spawn(I.APPLE)
      return
    }
    if (id === B.BED_HEAD) {
      spawn(I.BED)
      return
    }
    if (id === B.BOOKSHELF) {
      spawn(I.BOOK, 3)
      return
    }
    const definition = BLOCKS[id]
    const drop = harvest ? definition.dropItem : null
    if (drop !== null) {
      const [minCount, maxCount] = definition.dropCount
      const baseCount = minCount === maxCount
        ? minCount
        : minCount + Math.floor(Math.random() * (maxCount - minCount + 1))
      const fortuneCount = definition.fortuneMode === 'multiplier'
        ? fortuneDropCount(baseCount, fortune)
        : definition.fortuneMode === 'additive'
          ? additiveFortuneDropCount(baseCount, fortune)
          : baseCount
      spawn(drop, fortuneCount)
      // Iron and gold drop the ore block itself; their XP comes from smelting.
      const [minXp, maxXp] = definition.experience
      const xp = minXp === maxXp ? minXp : minXp + Math.floor(Math.random() * (maxXp - minXp + 1))
      if (xp > 0) this.onExperience(x + 0.5, y + 0.5, z + 0.5, xp)
    }
  }

  dropAutomaticBlock(x: number, y: number, z: number, id: number): void {
    if (this.mode === 'survival') this.spawnBlockDrops(id, x, y, z, true)
  }

  dropExplodedBlock(x: number, y: number, z: number, id: number): void {
    if (this.mode === 'survival' && Math.random() < 0.3) this.spawnBlockDrops(id, x, y, z, true)
  }

  private useFarmingItem(hit: RayHit): boolean {
    if (this.mode !== 'survival') return false
    const item = this.selectedItem
    const stack = this.selectedStack
    if (!item || !stack) return false

    if (item.tool?.type === 'hoe' && (hit.id === B.GRASS || hit.id === B.DIRT) && hit.ny > 0) {
      if (this.world.getBlock(hit.x, hit.y + 1, hit.z) !== B.AIR) return true
      this.world.setBlock(hit.x, hit.y, hit.z, B.FARMLAND_DRY)
      this.damageHeldItem()
      this.player.addExhaustion(0.005)
      this.audio.placeBlock('dirt')
      this.swing()
      return true
    }

    if (item.id === I.SEEDS && (hit.id === B.FARMLAND_DRY || hit.id === B.FARMLAND_WET) && hit.ny > 0) {
      const py = hit.y + 1
      if (this.world.canPlantWheat(hit.x, py, hit.z)) {
        this.world.setBlock(hit.x, py, hit.z, B.WHEAT_0)
        this.inventory.remove(this.selected, 1)
        this.audio.placeBlock('grass')
        this.swing()
      }
      return true
    }

    if (item.id === I.BONE_MEAL && this.world.fertilize(hit.x, hit.y, hit.z)) {
      this.inventory.remove(this.selected, 1)
      this.swing()
      return true
    }
    return false
  }

  private finishEating(item: ItemDefinition): void {
    const food = item.food
    if (!food || !this.player.eat(food.hunger, food.saturation)) return
    if (food.effect && Math.random() < food.effect.chance) this.player.applyFoodEffect(food.effect.kind, food.effect.seconds)
    this.inventory.remove(this.selected, 1)
    if (food.returnsItem !== null) {
      const left = this.inventory.add(food.returnsItem, 1)
      if (left > 0) {
        const eye = this.player.eyePos(this.rayOrigin)
        this.drops.spawn(food.returnsItem, eye.x, eye.y - 0.4, eye.z, 1)
      }
    }
    this.audio.eat()
    this.swing()
  }

  private finishDrinkingMilk(): void {
    this.player.clearEffects()
    this.replaceOneHeldItem(I.BUCKET)
    this.audio.eat()
    this.swing()
  }

  private replaceOneHeldItem(resultId: number): void {
    if (this.mode !== 'survival') return
    const stack = this.selectedStack
    if (!stack) return
    if (stack.count === 1) {
      this.inventory.slots[this.selected] = { id: resultId, count: 1 }
      this.inventory.notify()
      return
    }
    this.inventory.remove(this.selected, 1)
    const left = this.inventory.add(resultId, 1)
    if (left > 0) {
      const eye = this.player.eyePos(this.rayOrigin)
      this.drops.spawn(resultId, eye.x, eye.y - 0.35, eye.z, 1)
    }
  }

  /** Applies the typed inventory-neutral result returned by EntityManager. */
  private useEntityInteraction(entityId: string): boolean {
    const result = this.entities.interact(entityId, this.selectedItem?.id ?? null)
    if (!result) return false
    const entity = this.entities.snapshotById(entityId)

    if (result.type === 'saddle') {
      if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
    } else if (result.type === 'ride') {
      this.player.syncRidingPose(result.riding ? result.pose : null)
    } else if (result.type === 'container') {
      this.replaceOneHeldItem(result.replaceHeldWith)
    } else {
      if (entity) {
        for (const drop of result.drops) {
          this.drops.spawn(drop.id, entity.x, entity.y + 0.7, entity.z, drop.count)
        }
      }
      if (result.damageTool) this.damageHeldItem()
      this.audio.breakBlock('cloth')
    }
    this.swing()
    this.placing = false
    this.placeCooldown = 0.3
    return true
  }

  private useStageNineItem(hit: RayHit): boolean {
    const item = this.selectedItem
    if (!item) return false
    if (item.id === I.BUCKET) {
      if (hit.id !== B.WATER && hit.id !== B.LAVA) return true
      this.world.setBlock(hit.x, hit.y, hit.z, B.AIR)
      this.replaceOneHeldItem(hit.id === B.WATER ? I.WATER_BUCKET : I.LAVA_BUCKET)
      this.audio.splash(false)
      this.swing()
      return true
    }
    if (item.id === I.WATER_BUCKET || item.id === I.LAVA_BUCKET) {
      const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz
      const current = this.world.getBlock(px, py, pz)
      if (current !== B.AIR && current !== B.FIRE && !CROSS[current] && !isFluid(current)) return true
      this.world.setBlock(px, py, pz, item.id === I.WATER_BUCKET ? B.WATER : B.LAVA)
      this.replaceOneHeldItem(I.BUCKET)
      this.audio.splash(false)
      this.swing()
      return true
    }
    if (item.id === I.FLINT_AND_STEEL) {
      let lit = false
      if (hit.id === B.TNT) lit = this.world.primeTnt(hit.x, hit.y, hit.z)
      else lit = this.world.ignite(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz)
      if (lit) {
        this.damageHeldItem()
        this.audio.placeBlock('wood')
        this.swing()
      }
      return true
    }
    return false
  }

  /** Places both bed halves: foot at the clicked cell, head pointing away from the player. */
  private useBedItem(hit: RayHit): boolean {
    const item = this.selectedItem
    if (item?.id !== I.BED) return false
    let px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz
    if (CROSS[hit.id]) { px = hit.x; py = hit.y; pz = hit.z }
    const facing = oppositeHorizontalFace(this.facingTowardPlayer(px, pz))
    const hx = px + (facing === 0 ? 1 : facing === 1 ? -1 : 0)
    const hz = pz + (facing === 4 ? 1 : facing === 5 ? -1 : 0)
    const fits = (x: number, z: number): boolean => {
      const cur = this.world.getBlock(x, py, z)
      return (cur === B.AIR || CROSS[cur]) && SOLID[this.world.getBlock(x, py - 1, z)] &&
        !this.player.intersectsBlock(x, py, z)
    }
    if (!fits(px, pz) || !fits(hx, hz)) return true
    this.world.setBlock(px, py, pz, B.BED_FOOT, facing)
    this.world.setBlock(hx, py, hz, B.BED_HEAD, facing)
    if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
    this.audio.placeBlock('wood')
    this.swing()
    return true
  }

  update(dt: number): void {
    if (this.chargingBow) {
      this.bowCharge = Math.min(1.2, this.bowCharge + dt)
    }
    this.camera.getWorldDirection(this.rayDir)
    this.rayOrigin.copy(this.camera.position)
    const reach = this.mode === 'survival' ? SURVIVAL_REACH : CREATIVE_REACH
    const hit = this.world.raycast(this.rayOrigin, this.rayDir, reach, this.selectedItem?.id === I.BUCKET)
    const entityHit = this.entities.raycast(this.rayOrigin, this.rayDir, MELEE_REACH)
    const entityIsFirst = !!entityHit && (!hit || entityHit.distance < hit.dist)
    this.target = hit
    this.selectionMesh.visible = !!hit && !entityIsFirst
    if (hit && !entityIsFirst) this.selectionMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5)

    this.attackCooldown = Math.max(0, this.attackCooldown - dt)
    if (this.breaking && entityIsFirst) {
      this.attackingEntity = true
      this.crackMesh.visible = false
      if (this.attackCooldown <= 0) {
        const critical = !this.player.onGround && !this.player.inWater && this.player.vel.y < -0.08
        const stack = this.selectedStack
        const targetKind = entityHit!.entity.kind
        let enchantBonus = sharpnessBonus(enchantmentLevel(stack, 'sharpness'))
        const smite = enchantmentLevel(stack, 'smite')
        if (smite > 0 && (targetKind === 'zombie' || targetKind === 'skeleton')) enchantBonus += 2.5 * smite
        const bane = enchantmentLevel(stack, 'bane_of_arthropods')
        if (bane > 0 && targetKind === 'spider') enchantBonus += 2.5 * bane
        const damage = meleeDamage(this.selectedItem?.id ?? null, critical, enchantBonus)
        const knockback = (this.player.sprinting ? 6.2 : 4.2) + enchantmentLevel(stack, 'knockback') * 1.2
        if (this.entities.damage(
          entityHit!.entity.id, damage, this.player.pos.x, this.player.pos.z, knockback,
          enchantmentLevel(stack, 'looting')
        )) {
          const fireAspect = enchantmentLevel(stack, 'fire_aspect')
          if (fireAspect > 0) this.entities.ignite(entityHit!.entity.id, fireAspect * 4)
          this.attackCooldown = ATTACK_COOLDOWN
          this.swing()
          this.player.addExhaustion(0.1)
          if (this.selectedItem?.tool?.type === 'sword') this.damageHeldItem()
        }
      }
    }

    // breaking
    if (this.breaking && hit && !this.attackingEntity) {
      const key = hit.x + ',' + hit.y + ',' + hit.z
      if (key !== this.breakKey) {
        this.breakKey = key
        this.breakProgress = 0
      }
      const info = breakInfoFor(
        hit.id,
        this.mode === 'survival' ? this.selectedItem : null,
        this.mode === 'creative',
        enchantmentLevel(this.selectedStack, 'efficiency')
      )
      // classic mining penalties: submerged without Aqua Affinity and floating both slow digging
      let breakTime = info.time
      if (this.mode === 'survival') {
        if (this.player.headUnderwater && !this.player.aquaAffinity) breakTime *= 5
        if (!this.player.onGround && !this.player.inWater) breakTime *= 5
      }
      if (isFinite(breakTime)) {
        this.breakProgress += dt
        this.handSwing = Math.max(this.handSwing, 0.55)
        this.mineTickTimer -= dt
        if (this.mineTickTimer <= 0) {
          this.mineTickTimer = 0.24
          this.audio.mineTick(SOUND_CAT[hit.id])
          const avg = this.atlas.tileAvg[tileFor(hit.id, 0)]
          this.particles.burst(hit.x + 0.5 + hit.nx * 0.5, hit.y + 0.5 + hit.ny * 0.5, hit.z + 0.5 + hit.nz * 0.5, avg, 3)
        }
        const frac = this.breakProgress / breakTime
        if (frac >= 1) {
          const id = hit.id
          this.world.setBlock(hit.x, hit.y, hit.z, B.AIR)
          this.onBlockBroken(hit.x, hit.y, hit.z, id)
          if (this.mode === 'survival') {
            this.spawnBlockDrops(id, hit.x, hit.y, hit.z, info.harvest)
            if (isFinite(BLOCKS[id].hardness) && BLOCKS[id].hardness > 0) this.damageHeldItem()
            this.player.addExhaustion(0.005)
          }
          const avg = this.atlas.tileAvg[tileFor(id, 0)]
          this.particles.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, avg, CROSS[id] ? 6 : 16)
          this.audio.breakBlock(SOUND_CAT[id])
          this.breakProgress = 0
          this.crackMesh.visible = false
        } else if (frac > 0.02 && !CROSS[hit.id]) {
          this.crackMesh.visible = true
          this.crackMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5)
          const stage = Math.min(this.atlas.crackTex.length - 1, Math.floor(frac * this.atlas.crackTex.length))
          if (this.crackMat.map !== this.atlas.crackTex[stage]) {
            this.crackMat.map = this.atlas.crackTex[stage]
            this.crackMat.needsUpdate = true
          }
        } else {
          this.crackMesh.visible = false
        }
      }
    } else {
      this.breakProgress = 0
      this.breakKey = ''
      this.crackMesh.visible = false
    }

    // placing / using blocks
    this.placeCooldown -= dt
    if (this.placing && this.placeCooldown <= 0) {
      if (entityIsFirst) {
        const item = this.selectedItem
        if (this.useEntityInteraction(entityHit!.entity.id)) return
        if (item && this.entities.feed(entityHit!.entity.id, item.id)) {
          if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
          this.swing()
          this.placing = false
          this.placeCooldown = 0.3
          return
        }
        if (entityHit!.entity.kind === 'villager' && this.mode === 'survival') {
          this.onUseVillager(entityHit!.entity.id)
          this.placing = false
          this.placeCooldown = 0.3
          return
        }
      }
      // right-clicking a usable block opens it (crouch to place a block instead)
      const usable = !!hit && (hit.id === B.CRAFTING_TABLE || isContainerBlock(hit.id) ||
        hit.id === B.ENCHANTING_TABLE || isBedBlock(hit.id) || isDoorBlock(hit.id))
      if (usable && !this.player.crouching && (this.mode === 'survival' || isDoorBlock(hit!.id))) {
        this.placing = false
        this.onUseBlock(hit!)
        return
      }
      const item = this.selectedItem
      const stack = this.selectedStack
      if (hit && this.useStageNineItem(hit)) {
        this.eatProgress = 0
        this.placeCooldown = 0.24
      } else if (hit && this.useBedItem(hit)) {
        this.eatProgress = 0
        this.placeCooldown = 0.3
      } else if (item?.id === I.MAP) {
        this.onUseMap()
        this.placing = false
        this.placeCooldown = 0.3
      } else if (item?.id === I.COMPASS || item?.id === I.CLOCK) {
        this.onUseNavigation(item.id)
        this.placing = false
        this.placeCooldown = 0.3
      } else if (item?.id === I.MILK_BUCKET && this.mode === 'survival') {
        this.eatProgress += dt
        this.handSwing = Math.max(this.handSwing, 0.32 + Math.sin(this.eatProgress * 18) * 0.08)
        if (this.eatProgress >= 1.6) {
          this.finishDrinkingMilk()
          this.eatProgress = 0
          this.placeCooldown = 0.24
        }
      } else if (item?.food && this.mode === 'survival') {
        if (this.player.hunger < 20) {
          this.eatProgress += dt
          this.handSwing = Math.max(this.handSwing, 0.32 + Math.sin(this.eatProgress * 18) * 0.08)
          if (this.eatProgress >= item.food.useSeconds) {
            this.finishEating(item)
            this.eatProgress = 0
            this.placeCooldown = 0.24
          }
        }
      } else if (hit && this.useFarmingItem(hit)) {
        this.eatProgress = 0
        this.placeCooldown = 0.24
      } else {
        this.eatProgress = 0
        const placeable = item?.placeBlock ?? null
        if (hit && placeable !== null && (this.mode === 'creative' || !!stack)) {
        let px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz
        // clicking a cross plant replaces it directly
        if (CROSS[hit.id]) { px = hit.x; py = hit.y; pz = hit.z }
        const cur = this.world.getBlock(px, py, pz)
        const replaceable = cur !== placeable && (cur === B.AIR || isFluid(cur) || CROSS[cur])
        const vineFacing = placeable === B.VINE
          ? ([
              [1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]
            ] as const).find(([dx, dz]) => canSupportVine(this.world.getBlock(px + dx, py, pz + dz)))?.[2]
          : undefined
        const plantFits = placeable === B.SUGARCANE ? this.world.canPlantSugarCane(px, py, pz)
          : placeable === B.MUSHROOM_BROWN || placeable === B.MUSHROOM_RED ? this.world.canPlantMushroom(px, py, pz)
            : placeable === B.SAPLING_OAK || placeable === B.SAPLING_SPRUCE || placeable === B.SAPLING_BIRCH
              ? this.world.canPlantSapling(px, py, pz)
              : placeable === B.DEAD_BUSH ? this.world.getBlock(px, py - 1, pz) === B.SAND
                : placeable === B.CACTUS
                  ? (this.world.getBlock(px, py - 1, pz) === B.SAND || this.world.getBlock(px, py - 1, pz) === B.CACTUS) &&
                    [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => !SOLID[this.world.getBlock(px + dx, py, pz + dz)])
                  : placeable === B.WATER_LILY ? this.world.getBlock(px, py - 1, pz) === B.WATER
                    : placeable === B.VINE ? vineFacing !== undefined
              : placeable === B.RAIL ? SOLID[this.world.getBlock(px, py - 1, pz)]
              : true
        if (placeable === B.CHEST && !this.chestFits(px, py, pz)) {
          this.placeCooldown = 0.24
        } else if (placeable === B.WOOD_DOOR_LOWER) {
          // A door item is atomic: never fall through to generic one-block placement.
          if (this.player.intersectsBlock(px, py, pz) || this.player.intersectsBlock(px, py + 1, pz)) {
            this.placeCooldown = 0.24
          } else {
            const facing = isDirectionalBlock(placeable) ? this.facingTowardPlayer(px, pz) : undefined
            if (!this.world.placeDoor(px, py, pz, facing)) {
              this.placeCooldown = 0.24
              return
            }
            this.audio.placeBlock(SOUND_CAT[placeable])
            if (this.mode === 'survival') this.inventory.remove(this.selected, 1)
            this.swing()
            this.placeCooldown = 0.24
          }
        } else if (replaceable && plantFits && !this.player.intersectsBlock(px, py, pz)) {
          const facing = placeable === B.VINE ? vineFacing
            : isDirectionalBlock(placeable) ? this.facingTowardPlayer(px, pz) : undefined
          this.world.setBlock(px, py, pz, placeable, facing)
          if (placeable === B.CHEST && facing !== undefined) this.alignChestPair(px, py, pz, facing)
          this.audio.placeBlock(SOUND_CAT[placeable])
          if (this.mode === 'survival') {
            this.inventory.remove(this.selected, 1)
            this.player.addExhaustion(0.005)
          }
          this.swing()
          this.placeCooldown = 0.24
        }
        }
      }
    } else if (!this.placing) {
      this.eatProgress = 0
    }

    // hand animation
    if (this.hand) {
      this.handSwing = Math.max(0, this.handSwing - dt * 4)
      this.updateBowVisual()
      this.applyHandPose(1 - this.handSwing)
    }
  }

  dispose(): void {
    this.crackMesh.geometry.dispose()
    this.selectionMesh.geometry.dispose()
    ;(this.selectionMesh.material as THREE.Material).dispose()
  }
}
