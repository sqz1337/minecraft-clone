import * as THREE from 'three'
import type { World } from '../world/World'

const XP_ORB_URL = `${import.meta.env.BASE_URL}assets/minecraft/item/xporb.png`
const VALUES = [17, 7, 3, 1]
const MAX_ORBS = 160

interface Orb {
  value: number
  sprite: THREE.Sprite
  velocity: THREE.Vector3
  age: number
}

export interface ExperiencePlayer {
  pos: THREE.Vector3
  addExperience(amount: number): void
}

/** Lightweight physical XP spheres with classic attraction and pickup behaviour. */
export class ExperienceOrbs {
  private orbs: Orb[] = []
  private material: THREE.SpriteMaterial
  private frameTime = 0
  onPickup: (amount: number) => void = () => {}

  constructor(private scene: THREE.Scene, private world: World) {
    const texture = new THREE.TextureLoader().load(XP_ORB_URL)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    // xporb.png is a 4x4 sheet of 16 animation frames — show one cell, not all.
    texture.repeat.set(0.25, 0.25)
    this.material = new THREE.SpriteMaterial({ map: texture, transparent: true, alphaTest: 0.05, depthWrite: false })
  }

  /** Advances the shared 16-frame twinkle and points the atlas at that cell. */
  private animateFrame(dt: number): void {
    this.frameTime += dt
    const frame = Math.floor(this.frameTime * 8) % 16
    const col = frame % 4, row = Math.floor(frame / 4)
    // flipY is on by default, so the top image row sits at the high V offset.
    this.material.map!.offset.set(col * 0.25, 1 - (row + 1) * 0.25)
  }

  spawn(x: number, y: number, z: number, amount: number): void {
    let left = Math.max(0, Math.floor(amount))
    for (const value of VALUES) {
      while (left >= value) {
        this.spawnOne(x, y, z, value)
        left -= value
      }
    }
  }

  private spawnOne(x: number, y: number, z: number, value: number): void {
    while (this.orbs.length >= MAX_ORBS) this.removeAt(0)
    const sprite = new THREE.Sprite(this.material)
    sprite.position.set(x, y, z)
    sprite.scale.setScalar(0.32)
    this.scene.add(sprite)
    this.orbs.push({
      value,
      sprite,
      velocity: new THREE.Vector3((Math.random() - 0.5) * 2, 2.5 + Math.random(), (Math.random() - 0.5) * 2),
      age: 0
    })
  }

  update(dt: number, player: ExperiencePlayer): void {
    const safeDt = Math.max(0, Math.min(0.1, dt))
    this.animateFrame(safeDt)
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i]
      orb.age += safeDt
      const distanceSq = orb.sprite.position.distanceToSquared(player.pos)
      if (distanceSq < 64) {
        const direction = player.pos.clone().add(new THREE.Vector3(0, 0.8, 0)).sub(orb.sprite.position)
        const distance = Math.max(0.2, direction.length())
        orb.velocity.addScaledVector(direction.normalize(), safeDt * (12 / distance))
      }
      orb.velocity.y -= 14 * safeDt
      orb.velocity.multiplyScalar(Math.pow(0.985, safeDt * 60))
      // per-axis movement so attracted orbs slide along walls instead of entering them
      const pos = orb.sprite.position
      const nx = pos.x + orb.velocity.x * safeDt
      if (this.world.isSolid(Math.floor(nx), Math.floor(pos.y), Math.floor(pos.z))) orb.velocity.x = 0
      else pos.x = nx
      const nz = pos.z + orb.velocity.z * safeDt
      if (this.world.isSolid(Math.floor(pos.x), Math.floor(pos.y), Math.floor(nz))) orb.velocity.z = 0
      else pos.z = nz
      pos.y += orb.velocity.y * safeDt
      const bx = Math.floor(orb.sprite.position.x)
      const by = Math.floor(orb.sprite.position.y - 0.12)
      const bz = Math.floor(orb.sprite.position.z)
      if (this.world.isSolid(bx, by, bz) && orb.sprite.position.y < by + 1.12) {
        orb.sprite.position.y = by + 1.12
        orb.velocity.y = Math.max(0.8, -orb.velocity.y * 0.35)
        orb.velocity.x *= 0.75
        orb.velocity.z *= 0.75
      }
      const pulse = 0.28 + Math.sin(orb.age * 8 + orb.value) * 0.04
      orb.sprite.scale.setScalar(pulse)
      if (orb.age > 0.25 && distanceSq < 1.8) {
        player.addExperience(orb.value)
        this.onPickup(orb.value)
        this.removeAt(i)
      } else if (orb.age > 300 || orb.sprite.position.y < -32) {
        this.removeAt(i)
      }
    }
  }

  private removeAt(index: number): void {
    const [orb] = this.orbs.splice(index, 1)
    if (orb) this.scene.remove(orb.sprite)
  }
}
