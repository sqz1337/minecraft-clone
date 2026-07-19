import * as THREE from 'three'
import type { EntityManager } from './EntityManager'

export type ProjectileOwner = 'player' | 'mob'

export interface ProjectileSnapshot {
  id: number
  owner: ProjectileOwner
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  damage: number
  stuck: boolean
}

interface ProjectileState extends ProjectileSnapshot {
  life: number
  mesh: THREE.Mesh | null
  knockback: number
  fireSeconds: number
}

export interface ShootOptions {
  knockback?: number
  fireSeconds?: number
}

export interface ProjectilePlayer {
  x: number; y: number; z: number
}

export interface ProjectileHooks {
  damagePlayer: (amount: number, sourceX: number, sourceZ: number, knockback: number) => boolean
  /** Returns true when the player accepted a recovered arrow into the inventory. */
  pickupArrow: () => boolean
}

/** Shared arrow/projectile simulation used by bows and skeletons. */
export class ProjectileManager {
  private projectiles: ProjectileState[] = []
  private nextId = 1
  private geometry: THREE.BoxGeometry | null = null
  private material: THREE.MeshLambertMaterial | null = null
  private group: THREE.Group | null = null
  private hooks: ProjectileHooks

  constructor(
    private world: { isSolid(x: number, y: number, z: number): boolean },
    private entities: EntityManager,
    scene?: THREE.Scene,
    hooks: Partial<ProjectileHooks> = {}
  ) {
    this.hooks = { damagePlayer: () => false, pickupArrow: () => false, ...hooks }
    if (scene) {
      this.group = new THREE.Group()
      this.group.name = 'projectiles'
      scene.add(this.group)
      this.geometry = new THREE.BoxGeometry(0.06, 0.06, 0.72)
      this.material = new THREE.MeshLambertMaterial({ color: 0xd8c59b })
    }
  }

  get snapshots(): ProjectileSnapshot[] {
    return this.projectiles.map(({ id, owner, x, y, z, vx, vy, vz, damage, stuck }) =>
      ({ id, owner, x, y, z, vx, vy, vz, damage, stuck }))
  }

  shoot(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    speed: number,
    damage: number,
    owner: ProjectileOwner,
    options: ShootOptions = {}
  ): number {
    const dir = direction.clone().normalize()
    const mesh = this.geometry && this.material ? new THREE.Mesh(this.geometry, this.material) : null
    if (mesh) {
      mesh.castShadow = true
      mesh.position.copy(origin)
      this.group?.add(mesh)
    }
    const state: ProjectileState = {
      id: this.nextId++, owner, x: origin.x, y: origin.y, z: origin.z,
      vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed,
      damage: Math.max(1, damage), stuck: false, life: 0, mesh,
      knockback: options.knockback ?? 2.8,
      fireSeconds: options.fireSeconds ?? 0
    }
    this.projectiles.push(state)
    return state.id
  }

  shootAt(x: number, y: number, z: number, tx: number, ty: number, tz: number, damage: number): number {
    const origin = new THREE.Vector3(x, y, z)
    const direction = new THREE.Vector3(tx - x, ty - y, tz - z)
    const horizontal = Math.hypot(direction.x, direction.z)
    direction.y += horizontal * 0.05
    return this.shoot(origin, direction, 24, damage, 'mob')
  }

  update(dt: number, player: ProjectilePlayer): void {
    const safeDt = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0))
    for (const projectile of [...this.projectiles]) {
      projectile.life += safeDt
      if (projectile.life > (projectile.stuck ? 60 : 30)) { this.remove(projectile); continue }
      if (projectile.stuck && projectile.owner === 'player' && projectile.life > 0.5) {
        const distance = Math.hypot(projectile.x - player.x, projectile.y - (player.y + 0.9), projectile.z - player.z)
        if (distance < 1.7 && this.hooks.pickupArrow()) { this.remove(projectile); continue }
      }
      if (!projectile.stuck) {
        const steps = Math.max(1, Math.ceil(Math.hypot(projectile.vx, projectile.vy, projectile.vz) * safeDt / 0.2))
        const stepDt = safeDt / steps
        for (let i = 0; i < steps && !projectile.stuck; i++) this.step(projectile, stepDt, player)
      }
      this.syncMesh(projectile)
    }
  }

  private step(projectile: ProjectileState, dt: number, player: ProjectilePlayer): void {
    const ox = projectile.x, oy = projectile.y, oz = projectile.z
    const nx = ox + projectile.vx * dt, ny = oy + projectile.vy * dt, nz = oz + projectile.vz * dt
    const dx = nx - ox, dy = ny - oy, dz = nz - oz
    const distance = Math.hypot(dx, dy, dz)
    if (projectile.owner === 'player' && distance > 0) {
      const hit = this.entities.raycast(
        new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, dy, dz).normalize(), distance + 0.02
      )
      if (hit) {
        this.entities.damage(hit.entity.id, projectile.damage, ox, oz, projectile.knockback)
        if (projectile.fireSeconds > 0) this.entities.ignite(hit.entity.id, projectile.fireSeconds)
        this.remove(projectile)
        return
      }
    } else if (projectile.owner === 'mob' && this.segmentHitsPlayer(ox, oy, oz, nx, ny, nz, player)) {
      this.hooks.damagePlayer(projectile.damage, ox, oz, 3.2)
      this.remove(projectile)
      return
    }
    projectile.x = nx; projectile.y = ny; projectile.z = nz
    if (this.world.isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
      projectile.x = ox; projectile.y = oy; projectile.z = oz
      projectile.vx = projectile.vy = projectile.vz = 0
      projectile.stuck = true
      return
    }
    projectile.vy -= 20 * dt
    const drag = Math.pow(0.99, dt * 20)
    projectile.vx *= drag; projectile.vy *= drag; projectile.vz *= drag
  }

  private segmentHitsPlayer(ox: number, oy: number, oz: number, nx: number, ny: number, nz: number, player: ProjectilePlayer): boolean {
    const dx = nx - ox, dy = ny - oy, dz = nz - oz
    const length2 = dx * dx + dy * dy + dz * dz || 1
    const px = player.x - ox, py = player.y + 0.9 - oy, pz = player.z - oz
    const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / length2))
    return Math.hypot(ox + dx * t - player.x, oy + dy * t - (player.y + 0.9), oz + dz * t - player.z) < 0.45
  }

  private syncMesh(projectile: ProjectileState): void {
    if (!projectile.mesh) return
    projectile.mesh.position.set(projectile.x, projectile.y, projectile.z)
    const direction = new THREE.Vector3(projectile.vx, projectile.vy, projectile.vz)
    if (direction.lengthSq() > 0.001) projectile.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize())
  }

  private remove(projectile: ProjectileState): void {
    projectile.mesh?.removeFromParent()
    const index = this.projectiles.indexOf(projectile)
    if (index >= 0) this.projectiles.splice(index, 1)
  }

  dispose(): void {
    for (const projectile of [...this.projectiles]) this.remove(projectile)
    this.geometry?.dispose()
    this.material?.dispose()
    this.group?.removeFromParent()
  }
}
