import * as THREE from 'three'

/**
 * Visual flash for primed TNT. The engine keeps TNT as a static block rather
 * than a full entity, so this overlays a shared additive-white cube that pulses
 * bright and throbs — the classic "about to blow" tell. A true upward hop would
 * need TNT promoted to a moving entity; the throb approximates it in-place.
 */
export class TntFx {
  private group = new THREE.Group()
  private geo = new THREE.BoxGeometry(1.02, 1.02, 1.02)
  private mat: THREE.MeshBasicMaterial
  private active = new Map<string, { mesh: THREE.Mesh; age: number }>()

  constructor(scene: THREE.Scene) {
    this.group.name = 'tnt-fx'
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    scene.add(this.group)
  }

  private key(x: number, y: number, z: number): string { return `${x},${y},${z}` }

  add(x: number, y: number, z: number): void {
    const key = this.key(x, y, z)
    const existing = this.active.get(key)
    if (existing) { existing.age = 0; return }
    const mesh = new THREE.Mesh(this.geo, this.mat)
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5)
    mesh.frustumCulled = false
    this.group.add(mesh)
    this.active.set(key, { mesh, age: 0 })
  }

  remove(x: number, y: number, z: number): void {
    const key = this.key(x, y, z)
    const entry = this.active.get(key)
    if (!entry) return
    this.group.remove(entry.mesh)
    this.active.delete(key)
  }

  update(dt: number): void {
    if (this.active.size === 0) { this.mat.opacity = 0; return }
    // Shared white flash: a fast on/off blink layered over a soft glow.
    const t = performance.now() / 1000
    this.mat.opacity = 0.12 + 0.4 * (0.5 + 0.5 * Math.sin(t * 20))
    for (const entry of this.active.values()) {
      entry.age += dt
      entry.mesh.scale.setScalar(1 + Math.abs(Math.sin(entry.age * 16)) * 0.08)
    }
  }

  dispose(): void {
    this.group.removeFromParent()
    this.geo.dispose()
    this.mat.dispose()
    this.active.clear()
  }
}
