import * as THREE from 'three'
import type { Player } from '../player/Player'
import { VIEWMODEL_LAYER } from '../player/Interaction'

const SKIN_URL = `${import.meta.env.BASE_URL}assets/minecraft/mob/char.png`

interface BoxUv {
  u: number
  v: number
  width: number
  height: number
  depth: number
}

/** Classic 64x32 Steve model plus the right arm used by the first-person view model. */
export class PlayerRenderer {
  readonly model = new THREE.Group()
  private firstPersonArm = new THREE.Group()
  private head!: THREE.Mesh
  private rightArm!: THREE.Mesh
  private leftArm!: THREE.Mesh
  private rightLeg!: THREE.Mesh
  private leftLeg!: THREE.Mesh
  private geometries: THREE.BufferGeometry[] = []
  private texture: THREE.Texture
  private worldMaterial: THREE.MeshLambertMaterial
  private viewMaterial: THREE.MeshBasicMaterial
  private walkPhase = 0
  private heldItem: THREE.Mesh | null = null
  private heldItemId: number | null = null
  private walkAmount = 0
  private rightArmAngle = 0
  private leftArmAngle = 0
  private rightLegAngle = 0
  private leftLegAngle = 0

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    this.texture = new THREE.TextureLoader().load(SKIN_URL)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.worldMaterial = new THREE.MeshLambertMaterial({ map: this.texture })
    this.viewMaterial = new THREE.MeshBasicMaterial({ map: this.texture, fog: false })

    this.buildWorldModel()
    this.buildFirstPersonArm()
    this.model.name = 'local-player-model'
    this.model.visible = false
    scene.add(this.model)
    camera.add(this.firstPersonArm)
  }

  private mapBoxUvs(geometry: THREE.BoxGeometry, box: BoxUv): void {
    const { u, v, width: w, height: h, depth: d } = box
    const rectangles = [
      [u, v + d, u + d, v + d + h],
      [u + d + w, v + d, u + d + w + d, v + d + h],
      [u + d, v, u + d + w, v + d],
      [u + d + w, v, u + d + w * 2, v + d],
      [u + d + w + d, v + d, u + d + w + d + w, v + d + h],
      [u + d, v + d, u + d + w, v + d + h]
    ] as const
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let face = 0; face < 6; face++) {
      const [x0, y0, x1, y1] = rectangles[face]
      const u0 = x0 / 64, u1 = x1 / 64
      const v0 = 1 - y1 / 32, v1 = 1 - y0 / 32
      const offset = face * 4
      uv.setXY(offset, u0, v1)
      uv.setXY(offset + 1, u1, v1)
      uv.setXY(offset + 2, u0, v0)
      uv.setXY(offset + 3, u1, v0)
    }
    uv.needsUpdate = true
  }

  /** Maps every first-person forearm face to skin pixels below the shirt sleeve. */
  private mapBareForearmUvs(geometry: THREE.BoxGeometry): void {
    const rectangles = [
      [40, 24, 44, 32], // +X
      [48, 24, 52, 32], // -X
      [44, 28, 48, 32], // hand cap
      [52, 28, 56, 32], // hidden lower cap
      [52, 24, 56, 32], // +Z
      [44, 24, 48, 32]  // -Z
    ] as const
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let face = 0; face < rectangles.length; face++) {
      const [x0, y0, x1, y1] = rectangles[face]
      const u0 = x0 / 64, u1 = x1 / 64
      const v0 = 1 - y1 / 32, v1 = 1 - y0 / 32
      const offset = face * 4
      uv.setXY(offset, u0, v1)
      uv.setXY(offset + 1, u1, v1)
      uv.setXY(offset + 2, u0, v0)
      uv.setXY(offset + 3, u1, v0)
    }
    uv.needsUpdate = true
  }

  private box(
    parent: THREE.Object3D,
    size: [number, number, number],
    position: [number, number, number],
    uv: BoxUv,
    material: THREE.Material
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(...size)
    this.mapBoxUvs(geometry, uv)
    this.geometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(...position)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }

  private pivotedLimb(
    x: number,
    pivotY: number,
    size: [number, number, number],
    uv: BoxUv
  ): THREE.Mesh {
    const pivot = new THREE.Group()
    pivot.position.set(x, pivotY, 0)
    this.model.add(pivot)
    const limb = this.box(pivot, size, [0, -size[1] / 2, 0], uv, this.worldMaterial)
    // The shadow map updates at 30 Hz while the character animates every frame.
    // Excluding fast-moving limbs prevents a stale shadow silhouette from
    // flickering across the arm/leg texture between shadow updates.
    limb.castShadow = false
    return limb
  }

  private buildWorldModel(): void {
    this.head = this.box(this.model, [0.5, 0.5, 0.5], [0, 1.55, 0],
      { u: 0, v: 0, width: 8, height: 8, depth: 8 }, this.worldMaterial)
    this.box(this.model, [0.5, 0.75, 0.25], [0, 0.925, 0],
      { u: 16, v: 16, width: 8, height: 12, depth: 4 }, this.worldMaterial)
    this.rightArm = this.pivotedLimb(-0.375, 1.3, [0.25, 0.75, 0.25],
      { u: 40, v: 16, width: 4, height: 12, depth: 4 })
    this.leftArm = this.pivotedLimb(0.375, 1.3, [0.25, 0.75, 0.25],
      { u: 40, v: 16, width: 4, height: 12, depth: 4 })
    this.rightLeg = this.pivotedLimb(-0.125, 0.75, [0.25, 0.75, 0.25],
      { u: 0, v: 16, width: 4, height: 12, depth: 4 })
    this.leftLeg = this.pivotedLimb(0.125, 0.75, [0.25, 0.75, 0.25],
      { u: 0, v: 16, width: 4, height: 12, depth: 4 })
  }

  private buildFirstPersonArm(): void {
    const pivot = new THREE.Group()
    // Render only the lower 8px skin section (v=20 maps its sides to v=24..32),
    // not the cyan 4px shirt sleeve from the shoulder. The forearm begins below
    // the viewport and only its hand end reaches the held item.
    pivot.position.set(0.64, -0.62, -0.66)
    pivot.rotation.set(-1.02, 0.08, -0.28)
    const arm = this.box(pivot, [0.19, 0.48, 0.19], [0, 0.20, 0],
      { u: 40, v: 20, width: 4, height: 8, depth: 4 }, this.viewMaterial)
    this.mapBareForearmUvs(arm.geometry as THREE.BoxGeometry)
    pivot.traverse(object => {
      object.layers.set(VIEWMODEL_LAYER)
      if (object instanceof THREE.Mesh) {
        object.castShadow = false
        object.receiveShadow = false
        object.frustumCulled = false
      }
    })
    this.firstPersonArm.add(pivot)
  }

  private syncHeldItem(source: THREE.Mesh | null, itemId: number | null): void {
    if (itemId !== this.heldItemId) {
      if (this.heldItem) {
        this.heldItem.parent?.remove(this.heldItem)
        this.heldItem.geometry.dispose()
        ;(this.heldItem.material as THREE.Material).dispose()
      }
      this.heldItem = null
      this.heldItemId = itemId
      if (source && itemId !== null) {
        const material = (source.material as THREE.Material).clone()
        this.heldItem = new THREE.Mesh(source.geometry.clone(), material)
        this.heldItem.castShadow = true
        this.heldItem.receiveShadow = true
        const kind = source.userData.kind as string | undefined
        this.heldItem.position.set(0, -0.82, -0.12)
        this.heldItem.rotation.set(
          kind === 'block' ? 0.15 : 0.05,
          kind === 'block' ? Math.PI / 4 : -1.55,
          kind === 'block' ? 0.08 : 1.35
        )
        const positions = this.heldItem.geometry.getAttribute('position') as THREE.BufferAttribute
        const bounds = new THREE.Box3().setFromBufferAttribute(positions)
        const size = bounds.getSize(new THREE.Vector3())
        const scale = 0.42 / Math.max(size.x, size.y, size.z)
        this.heldItem.scale.setScalar(scale)
        this.rightArm.parent!.add(this.heldItem)
      }
    }
    if (this.heldItem && source) {
      const heldMaterial = this.heldItem.material as THREE.MeshBasicMaterial
      const sourceMaterial = source.material as THREE.MeshBasicMaterial
      if (heldMaterial.map !== sourceMaterial.map) heldMaterial.map = sourceMaterial.map
    }
  }

  update(
    dt: number,
    player: Player,
    swingProgress: number,
    heldSource: THREE.Mesh | null,
    heldItemId: number | null,
    showFirstPersonArm: boolean
  ): void {
    const firstPerson = player.cameraMode === 'first'
    const cameraDistance = this.camera.position.distanceTo(player.getEyePosition(new THREE.Vector3()))
    this.model.visible = !firstPerson && cameraDistance > 0.72
    this.firstPersonArm.visible = firstPerson && showFirstPersonArm
    this.syncHeldItem(heldSource, heldItemId)

    this.model.position.copy(player.pos)
    this.model.rotation.y = player.yaw
    this.head.rotation.set(player.pitch, 0, 0)

    const speed = Math.hypot(player.vel.x, player.vel.z)
    if (speed > 0.05) this.walkPhase += dt * speed * 2.2
    const walkTarget = player.onGround ? Math.min(1, speed / 4.4) : 0
    this.walkAmount = THREE.MathUtils.damp(this.walkAmount, walkTarget, 11, dt)
    // ModelBiped uses opposing cosine curves for arms and legs. Damping the
    // resulting angles bridges small onGround/velocity discontinuities from
    // collision resolution instead of snapping a limb to zero for one frame.
    const stride = Math.cos(this.walkPhase * 0.6662) * 0.9 * this.walkAmount
    const rightArmTarget = heldItemId !== null ? (-stride * 0.5 + Math.PI / 10) : -stride
    this.rightArmAngle = THREE.MathUtils.damp(this.rightArmAngle, rightArmTarget, 18, dt)
    this.leftArmAngle = THREE.MathUtils.damp(this.leftArmAngle, stride, 18, dt)
    this.rightLegAngle = THREE.MathUtils.damp(this.rightLegAngle, stride, 18, dt)
    this.leftLegAngle = THREE.MathUtils.damp(this.leftLegAngle, -stride, 18, dt)
    this.rightLeg.parent!.rotation.x = this.rightLegAngle
    this.leftLeg.parent!.rotation.x = this.leftLegAngle
    this.rightArm.parent!.rotation.x = this.rightArmAngle
    this.leftArm.parent!.rotation.x = this.leftArmAngle

    const swing = Math.sin(Math.sqrt(Math.max(0, swingProgress)) * Math.PI)
    this.rightArm.parent!.rotation.x += swing * 1.25
    this.rightArm.parent!.rotation.z = swing * 0.22

    const viewPivot = this.firstPersonArm.children[0]
    viewPivot.rotation.set(-1.02 - swing * 0.9, 0.08, -0.28 - swing * 0.2)
    viewPivot.position.set(0.64 - swing * 0.1, -0.62 + swing * 0.03, -0.66 - swing * 0.05)
  }

  dispose(): void {
    this.scene.remove(this.model)
    this.camera.remove(this.firstPersonArm)
    for (const geometry of this.geometries) geometry.dispose()
    if (this.heldItem) {
      this.heldItem.geometry.dispose()
      ;(this.heldItem.material as THREE.Material).dispose()
    }
    this.worldMaterial.dispose()
    this.viewMaterial.dispose()
    this.texture.dispose()
  }
}
