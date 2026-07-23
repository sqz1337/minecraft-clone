import * as THREE from 'three'
import type { Atlas } from '../gfx/Atlas'
import type { ItemSprites } from '../gfx/ItemSprites'
import type { Player } from '../player/Player'
import type { Inventory } from '../player/Inventory'
import type { World } from './World'
import { B, CROSS, SOLID, tileFor } from './Blocks'
import { ITEMS } from './Items'
import type { EnchantmentInstance } from '../player/Enchantments'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'

/** Hard cap for item entities in the world; the oldest drop is culled first. */
const MAX_DROPS = 200
const MERGE_INTERVAL = 0.4
const MERGE_DISTANCE_SQ = 1.2

interface Drop {
  id: number
  count: number
  damage?: number
  enchantments?: EnchantmentInstance[]
  mesh: THREE.Mesh
  velocity: THREE.Vector3
  age: number
  pickupDelay: number
}

export interface SavedDrop {
  id: number
  count: number
  damage?: number
  enchantments?: EnchantmentInstance[]
  x: number
  y: number
  z: number
}

export interface SpawnOptions {
  velocity?: THREE.Vector3
  pickupDelay?: number
  damage?: number
  enchantments?: EnchantmentInstance[]
}

export class ItemDrops {
  private drops: Drop[] = []
  private material: THREE.MeshLambertMaterial
  private flatMaterial: THREE.MeshLambertMaterial
  private spriteMaterial: THREE.MeshLambertMaterial
  private mergeTimer = MERGE_INTERVAL
  onPickup: () => void = () => {}

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private atlas: Atlas,
    private sprites: ItemSprites,
    private inventory: Inventory
  ) {
    this.material = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.08
    })
    this.flatMaterial = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.08,
      side: THREE.DoubleSide
    })
    this.spriteMaterial = new THREE.MeshLambertMaterial({
      map: sprites.texture,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.08,
      side: THREE.DoubleSide
    })
  }

  spawn(id: number, x: number, y: number, z: number, count = 1, options: SpawnOptions = {}): void {
    const item = ITEMS[id]
    if (!item || count <= 0) return
    while (this.drops.length >= MAX_DROPS) this.removeAt(0)

    let geometry: THREE.BufferGeometry
    let material: THREE.MeshLambertMaterial
    if (item.sprite) {
      geometry = createExtrudedItemGeometry(0.45)
      setExtrudedItemUv(geometry, this.sprites.uvRect(item.sprite[0], item.sprite[1]))
      material = this.spriteMaterial
    } else if (CROSS[id]) {
      geometry = createExtrudedItemGeometry(0.45)
      setExtrudedItemUv(geometry, this.atlas.uvRect(tileFor(id, 0)))
      material = this.flatMaterial
    } else {
      geometry = new THREE.BoxGeometry(0.28, 0.28, 0.28)
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
      for (let face = 0; face < 6; face++) {
        const [u0, v0, u1, v1] = this.atlas.uvRect(tileFor(id, face))
        for (let i = 0; i < 4; i++) {
          const vertex = face * 4 + i
          uv.setXY(vertex, uv.getX(vertex) < 0.5 ? u0 : u1, uv.getY(vertex) < 0.5 ? v0 : v1)
        }
      }
      uv.needsUpdate = true
      const colors = new Float32Array(24 * 3).fill(1)
      if (id === B.GRASS) {
        for (let i = 8; i < 12; i++) {
          colors[i * 3] = 0.62; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 0.38
        }
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      material = this.material
    }
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.drops.push({
      id,
      count,
      damage: options.damage,
      enchantments: options.enchantments?.map(enchantment => ({ ...enchantment })),
      mesh,
      velocity: options.velocity?.clone() ??
        new THREE.Vector3((Math.random() - 0.5) * 1.5, 2.5, (Math.random() - 0.5) * 1.5),
      age: 0,
      pickupDelay: options.pickupDelay ?? 0.35
    })
  }

  update(dt: number, player: Player): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i]
      drop.age += dt
      drop.velocity.y -= 16 * dt
      this.moveWithWalls(drop, dt)

      const bx = Math.floor(drop.mesh.position.x)
      const by = Math.floor(drop.mesh.position.y - 0.15)
      const bz = Math.floor(drop.mesh.position.z)
      const below = this.world.getBlock(bx, by, bz)
      if (SOLID[below] && !CROSS[below] && drop.mesh.position.y < by + 1.15) {
        drop.mesh.position.y = by + 1.15
        drop.velocity.y = Math.max(0, -drop.velocity.y * 0.18)
        drop.velocity.x *= 0.82
        drop.velocity.z *= 0.82
      }
      drop.mesh.rotation.y += dt * 1.8
      drop.mesh.rotation.x = Math.sin(drop.age * 2.2) * 0.12

      if (drop.age > drop.pickupDelay && drop.mesh.position.distanceToSquared(player.pos) < 2.6) {
        const left = this.inventory.add(drop.id, drop.count, drop.damage, drop.enchantments)
        if (left < drop.count) this.onPickup()
        drop.count = left
        if (left === 0) {
          this.removeAt(i)
          continue
        }
      }
      if (drop.age > 300 || drop.mesh.position.y < -32) this.removeAt(i)
    }

    this.mergeTimer -= dt
    if (this.mergeTimer <= 0) {
      this.mergeTimer = MERGE_INTERVAL
      this.mergeNearby()
    }
  }

  private solidAt(x: number, y: number, z: number): boolean {
    const id = this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))
    return SOLID[id] && !CROSS[id]
  }

  /** Per-axis integration so thrown drops stop at walls instead of entering blocks. */
  private moveWithWalls(drop: Drop, dt: number): void {
    const pos = drop.mesh.position
    const midY = pos.y + 0.02
    const nx = pos.x + drop.velocity.x * dt
    if (this.solidAt(nx, midY, pos.z)) drop.velocity.x = 0
    else pos.x = nx
    const nz = pos.z + drop.velocity.z * dt
    if (this.solidAt(pos.x, midY, nz)) drop.velocity.z = 0
    else pos.z = nz
    const ny = pos.y + drop.velocity.y * dt
    if (drop.velocity.y > 0 && this.solidAt(pos.x, ny + 0.2, pos.z)) drop.velocity.y = 0
    else pos.y = ny
  }

  /** Combines nearby identical stackable drops to keep the entity count down. */
  private mergeNearby(): void {
    for (let i = 0; i < this.drops.length; i++) {
      const a = this.drops[i]
      const max = ITEMS[a.id]?.stackSize ?? 1
      if (max <= 1 || a.damage !== undefined || a.enchantments?.length) continue
      for (let j = this.drops.length - 1; j > i; j--) {
        const b = this.drops[j]
        if (b.id !== a.id || b.damage !== undefined || b.enchantments?.length || a.count + b.count > max) continue
        if (a.mesh.position.distanceToSquared(b.mesh.position) > MERGE_DISTANCE_SQ) continue
        a.count += b.count
        a.age = Math.min(a.age, b.age)
        this.removeAt(j)
      }
    }
  }

  snapshot(): SavedDrop[] {
    return this.drops.slice(0, 256).map(drop => ({
      id: drop.id,
      count: drop.count,
      ...(drop.damage !== undefined ? { damage: drop.damage } : {}),
      ...(drop.enchantments?.length ? { enchantments: drop.enchantments.map(enchantment => ({ ...enchantment })) } : {}),
      x: drop.mesh.position.x,
      y: drop.mesh.position.y,
      z: drop.mesh.position.z
    }))
  }

  restore(data: readonly SavedDrop[]): void {
    for (const drop of data) this.spawn(drop.id, drop.x, drop.y, drop.z, drop.count, {
      damage: drop.damage,
      enchantments: drop.enchantments
    })
  }

  private removeAt(index: number): void {
    const [drop] = this.drops.splice(index, 1)
    this.scene.remove(drop.mesh)
    drop.mesh.geometry.dispose()
  }
}
