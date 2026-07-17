import * as THREE from 'three'
import { clamp } from '../util/math'

interface Bird {
  group: THREE.Group
  wingL: THREE.Mesh
  wingR: THREE.Mesh
  angle: number
  radius: number
  height: number
  speed: number
  phase: number
}

/** A few distant birds circling above the terrain. Hidden at night and in rain. */
export class Critters {
  group = new THREE.Group()
  private birds: Bird[] = []
  private opacity = 1
  private mat: THREE.MeshBasicMaterial

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.MeshBasicMaterial({ color: 0x1c1d20, side: THREE.DoubleSide, transparent: true })
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7, 4), this.mat)
      body.rotation.x = Math.PI / 2
      const wingGeo = new THREE.PlaneGeometry(1.1, 0.34)
      const wingL = new THREE.Mesh(wingGeo, this.mat)
      wingL.position.x = -0.55
      const wingR = new THREE.Mesh(wingGeo, this.mat)
      wingR.position.x = 0.55
      g.add(body, wingL, wingR)
      this.group.add(g)
      this.birds.push({
        group: g, wingL, wingR,
        angle: Math.random() * Math.PI * 2,
        radius: 30 + Math.random() * 50,
        height: 28 + Math.random() * 20,
        speed: 0.12 + Math.random() * 0.15,
        phase: Math.random() * 10
      })
    }
    scene.add(this.group)
  }

  update(dt: number, playerPos: THREE.Vector3, night: number, precip: number): void {
    const targetOpacity = clamp(1 - night * 2, 0, 1) * clamp(1 - precip * 1.5, 0, 1)
    this.opacity += (targetOpacity - this.opacity) * clamp(dt, 0, 1)
    this.mat.opacity = this.opacity
    this.group.visible = this.opacity > 0.03
    if (!this.group.visible) return

    const t = performance.now() / 1000
    for (const b of this.birds) {
      b.angle += b.speed * dt
      const x = playerPos.x + Math.cos(b.angle) * b.radius
      const z = playerPos.z + Math.sin(b.angle) * b.radius
      const y = playerPos.y + b.height + Math.sin(t * 0.4 + b.phase) * 3
      b.group.position.set(x, y, z)
      // face along the tangent of the circle
      b.group.rotation.y = -b.angle
      const flap = Math.sin(t * 9 + b.phase) * 0.55
      b.wingL.rotation.z = flap
      b.wingR.rotation.z = -flap
    }
  }
}
