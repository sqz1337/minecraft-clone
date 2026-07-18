import * as THREE from 'three'
import {
  B, BLOCKS, HOTBAR_PAGES, SOUND_CAT, CROSS, isContainerBlock, isDirectionalBlock, tileFor,
  type HorizontalFace
} from '../world/Blocks'
import { ITEMS, ItemDefinition, breakInfoFor } from '../world/Items'
import type { GameMode } from '../core/Settings'
import type { Inventory, ItemStack } from './Inventory'
import type { ItemDrops } from '../world/ItemDrops'
import type { World, RayHit } from '../world/World'
import type { Player } from './Player'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import type { AudioMan } from '../audio/Audio'
import type { Particles } from '../gfx/Particles'

const REACH = 5.5

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

  private highlight: THREE.LineSegments
  private crackMesh: THREE.Mesh
  private crackMat: THREE.MeshBasicMaterial
  private hand: THREE.Mesh | null = null
  private handFlat = false
  private handSwing = 0

  private target: RayHit | null = null
  private breaking = false
  private breakProgress = 0
  private breakKey = ''
  private placing = false
  private placeCooldown = 0
  private mineTickTimer = 0

  onSelectionChanged: (index: number) => void = () => {}
  onPageChanged: (page: number, blocks: readonly number[]) => void = () => {}
  /** Fired when the player right-clicks a usable block (crafting table, furnace, chest) without crouching. */
  onUseBlock: (hit: RayHit) => void = () => {}
  /** Fired after any block has been broken, with its previous id. */
  onBlockBroken: (x: number, y: number, z: number, id: number) => void = () => {}

  private rayDir = new THREE.Vector3()
  private rayOrigin = new THREE.Vector3()

  constructor(
    world: World,
    player: Player,
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    atlas: Atlas,
    sprites: ItemSprites,
    audio: AudioMan,
    particles: Particles,
    private mode: GameMode,
    private inventory: Inventory,
    private drops: ItemDrops
  ) {
    this.world = world
    this.player = player
    this.camera = camera
    this.atlas = atlas
    this.sprites = sprites
    this.audio = audio
    this.particles = particles

    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002)
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.7 })
    )
    this.highlight.visible = false
    scene.add(this.highlight)

    this.crackMat = new THREE.MeshBasicMaterial({
      map: atlas.crackTex[0],
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2
    })
    this.crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.crackMat)
    this.crackMesh.visible = false
    scene.add(this.crackMesh)

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

  primaryDown(): void { this.breaking = true }
  primaryUp(): void {
    this.breaking = false
    this.breakProgress = 0
    this.crackMesh.visible = false
  }
  secondaryDown(): void {
    this.placing = true
    this.placeCooldown = 0
  }
  secondaryUp(): void { this.placing = false }

  /** Throws one unit of the selected item forward. */
  dropSelected(): void {
    const item = this.selectedItem
    if (!item) return
    let damage: number | undefined
    if (this.mode === 'survival') {
      const stack = this.selectedStack
      if (!stack) return
      damage = stack.damage
      this.inventory.remove(this.selected, 1)
    }
    this.camera.getWorldDirection(this.rayDir)
    const eye = this.camera.getWorldPosition(this.rayOrigin)
    const velocity = this.rayDir.clone().multiplyScalar(6)
    velocity.y += 2
    this.drops.spawn(item.id, eye.x + this.rayDir.x * 0.4, eye.y - 0.25, eye.z + this.rayDir.z * 0.4, 1, {
      velocity,
      pickupDelay: 1.2,
      damage
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
    this.handFlat = !!item.sprite || CROSS[id]
    let geo: THREE.BufferGeometry
    let mat: THREE.MeshStandardMaterial
    if (item.sprite) {
      // tools and materials: large flat sprite from items.png held like a tool
      geo = new THREE.PlaneGeometry(0.42, 0.42)
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      const [u0, v0, u1, v1] = this.sprites.uvRect(item.sprite[0], item.sprite[1])
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) < 0.5 ? u0 : u1, uv.getY(i) < 0.5 ? v0 : v1)
      }
      uv.needsUpdate = true
      mat = new THREE.MeshStandardMaterial({
        map: this.sprites.texture,
        roughness: 1,
        metalness: 0,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide
      })
    } else if (this.handFlat) {
      geo = new THREE.PlaneGeometry(0.28, 0.28)
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      const [u0, v0, u1, v1] = this.atlas.uvRect(tileFor(id, 0))
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) < 0.5 ? u0 : u1, uv.getY(i) < 0.5 ? v0 : v1)
      }
      uv.needsUpdate = true
      mat = new THREE.MeshStandardMaterial({
        map: this.atlas.colorTex,
        roughness: 1,
        metalness: 0,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide
      })
    } else {
      geo = new THREE.BoxGeometry(0.16, 0.16, 0.16)
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
      mat = new THREE.MeshStandardMaterial({
        map: this.atlas.colorTex,
        roughness: 1,
        metalness: 0,
        vertexColors: true
      })
    }
    this.hand = new THREE.Mesh(geo, mat)
    this.hand.frustumCulled = false
    this.hand.renderOrder = 5
    this.hand.position.set(this.handFlat ? 0.31 : 0.3, this.handFlat ? -0.24 : -0.26, -0.55)
    this.hand.rotation.set(this.handFlat ? 0.04 : 0.12, this.handFlat ? -0.2 : Math.PI / 5, this.handFlat ? -0.28 : 0)
    this.camera.add(this.hand)
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

  /** Applies one point of wear to the held tool; breaks it at zero durability. */
  private damageTool(): void {
    if (this.mode !== 'survival') return
    const stack = this.selectedStack
    const tool = stack ? ITEMS[stack.id]?.tool : null
    if (!stack || !tool) return
    stack.damage = (stack.damage ?? 0) + 1
    if (stack.damage >= tool.tier.durability) {
      this.inventory.slots[this.selected] = null
      this.audio.toolBreak()
    }
    this.inventory.notify()
  }

  update(dt: number): void {
    this.camera.getWorldDirection(this.rayDir)
    this.rayOrigin.copy(this.camera.position)
    const hit = this.world.raycast(this.rayOrigin, this.rayDir, REACH)
    this.target = hit

    if (hit && !CROSS[hit.id]) {
      this.highlight.visible = true
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5)
    } else {
      this.highlight.visible = false
    }

    // breaking
    if (this.breaking && hit) {
      const key = hit.x + ',' + hit.y + ',' + hit.z
      if (key !== this.breakKey) {
        this.breakKey = key
        this.breakProgress = 0
      }
      const info = breakInfoFor(hit.id, this.mode === 'survival' ? this.selectedItem : null, this.mode === 'creative')
      if (isFinite(info.time)) {
        this.breakProgress += dt
        this.handSwing = Math.max(this.handSwing, 0.55)
        this.mineTickTimer -= dt
        if (this.mineTickTimer <= 0) {
          this.mineTickTimer = 0.24
          this.audio.mineTick(SOUND_CAT[hit.id])
          const avg = this.atlas.tileAvg[tileFor(hit.id, 0)]
          this.particles.burst(hit.x + 0.5 + hit.nx * 0.5, hit.y + 0.5 + hit.ny * 0.5, hit.z + 0.5 + hit.nz * 0.5, avg, 3)
        }
        const frac = this.breakProgress / info.time
        if (frac >= 1) {
          const id = hit.id
          this.world.setBlock(hit.x, hit.y, hit.z, B.AIR)
          this.onBlockBroken(hit.x, hit.y, hit.z, id)
          if (this.mode === 'survival') {
            const drop = info.harvest ? BLOCKS[id].dropItem : null
            if (drop !== null) this.drops.spawn(drop, hit.x + 0.5, hit.y + 0.45, hit.z + 0.5)
            if (isFinite(BLOCKS[id].hardness) && BLOCKS[id].hardness > 0) this.damageTool()
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
          const stage = Math.min(3, Math.floor(frac * 4))
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
    if (this.placing && hit && this.placeCooldown <= 0) {
      // right-clicking a usable block opens it (crouch to place a block instead)
      const usable = hit.id === B.CRAFTING_TABLE || isContainerBlock(hit.id)
      if (usable && this.mode === 'survival' && !this.player.crouching) {
        this.placing = false
        this.onUseBlock(hit)
        return
      }
      const item = this.selectedItem
      const stack = this.selectedStack
      const placeable = item?.placeBlock ?? null
      if (placeable !== null && (this.mode === 'creative' || !!stack)) {
        let px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz
        // clicking a cross plant replaces it directly
        if (CROSS[hit.id]) { px = hit.x; py = hit.y; pz = hit.z }
        const cur = this.world.getBlock(px, py, pz)
        const replaceable = cur === B.AIR || cur === B.WATER || CROSS[cur]
        if (placeable === B.CHEST && !this.chestFits(px, py, pz)) {
          this.placeCooldown = 0.24
        } else if (replaceable && !this.player.intersectsBlock(px, py, pz)) {
          const facing = isDirectionalBlock(placeable) ? this.facingTowardPlayer(px, pz) : undefined
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

    // hand animation
    if (this.hand) {
      this.handSwing = Math.max(0, this.handSwing - dt * 4)
      const s = Math.sin(this.handSwing * Math.PI)
      if (this.handFlat) {
        this.hand.position.set(0.31 - s * 0.09, -0.24 + s * 0.04, -0.55 - s * 0.13)
        this.hand.rotation.set(0.04 - s * 0.75, -0.2 + s * 0.25, -0.28)
      } else {
        this.hand.position.set(0.3 - s * 0.09, -0.26 + s * 0.04, -0.55 - s * 0.13)
        this.hand.rotation.set(0.12 - s * 0.9, Math.PI / 5 + s * 0.4, 0)
      }
    }
  }

  dispose(): void {
    this.highlight.geometry.dispose()
    this.crackMesh.geometry.dispose()
  }
}
