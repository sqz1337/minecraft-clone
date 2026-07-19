import * as THREE from 'three'
import type { EntitySnapshot, MobKind, VillagerProfession } from './EntityTypes'

interface EntityView {
  group: THREE.Group
  legs: THREE.Object3D[]
  head: THREE.Object3D
  walkPhase: number
  fromPosition: THREE.Vector3
  targetPosition: THREE.Vector3
  moveElapsed: number
  fromYaw: number
  targetYaw: number
  furParts: THREE.Object3D[]
  carriedBlock: THREE.Mesh | null
  materials: THREE.MeshLambertMaterial[]
}

interface BoxUv {
  u: number
  v: number
  width: number
  height: number
  depth: number
}

const TEXTURE_WIDTH = 64
const TEXTURE_HEIGHT = 32
const MOB_ROOT = `${import.meta.env.BASE_URL}assets/minecraft/mob/`
const MOVE_SMOOTH_SECONDS = 1 / 20

/** Classic 64×32 Minecraft mob skins mapped onto block-model cuboids. */
export class EntityRenderer {
  readonly group = new THREE.Group()
  private views = new Map<string, EntityView>()
  private geometries: THREE.BufferGeometry[] = []
  private textures: THREE.Texture[] = []
  private materials = new Map<MobKind, THREE.MeshLambertMaterial>()
  private sheepFurMaterial: THREE.MeshLambertMaterial
  private carriedBlockMaterial = new THREE.MeshLambertMaterial({ color: 0x8b6a45 })
  private mushroomMaterial = new THREE.MeshLambertMaterial({ color: 0xb52b28 })

  constructor(scene: THREE.Scene) {
    this.group.name = 'mob-entities'
    const loader = new THREE.TextureLoader()
    for (const kind of ['pig', 'cow', 'sheep', 'chicken'] as const) {
      this.materials.set(kind, this.mobMaterial(loader, `${kind}.png`))
    }
    this.materials.set('mooshroom', this.mobMaterial(loader, 'redcow.png'))
    this.materials.set('villager', this.mobMaterial(loader, 'villager.png'))
    for (const [kind, file] of [
      ['zombie', 'zombie.png'], ['skeleton', 'skeleton.png'], ['spider', 'spider.png'],
      ['creeper', 'creeper.png'], ['slime', 'slime.png'], ['enderman', 'enderman.png']
    ] as const) this.materials.set(kind, this.mobMaterial(loader, file, kind === 'slime'))
    this.sheepFurMaterial = this.mobMaterial(loader, 'sheep_fur.png', true)
    scene.add(this.group)
  }

  private mobMaterial(loader: THREE.TextureLoader, file: string, transparent = false): THREE.MeshLambertMaterial {
    const texture = loader.load(MOB_ROOT + file)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    this.textures.push(texture)
    return new THREE.MeshLambertMaterial({
      map: texture,
      transparent,
      alphaTest: transparent ? 0.1 : 0,
      side: THREE.FrontSide
    })
  }

  /** Applies the legacy ModelRenderer cuboid unwrap to Three's six box faces. */
  private mapBoxUvs(geometry: THREE.BoxGeometry, box: BoxUv): void {
    const { u, v, width: w, height: h, depth: d } = box
    const rectangles = [
      [u, v + d, u + d, v + d + h],                       // +X
      [u + d + w, v + d, u + d + w + d, v + d + h],       // -X
      [u + d, v, u + d + w, v + d],                       // +Y
      [u + d + w, v, u + d + w * 2, v + d],               // -Y
      [u + d + w + d, v + d, u + d + w + d + w, v + d + h], // +Z
      [u + d, v + d, u + d + w, v + d + h]                // -Z
    ] as const
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let face = 0; face < 6; face++) {
      const [px0, py0, px1, py1] = rectangles[face]
      const u0 = px0 / TEXTURE_WIDTH, u1 = px1 / TEXTURE_WIDTH
      const v0 = 1 - py1 / TEXTURE_HEIGHT, v1 = 1 - py0 / TEXTURE_HEIGHT
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
    pos: [number, number, number],
    material: THREE.Material,
    uv: BoxUv,
    rotationX = 0
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(...size)
    this.mapBoxUvs(geometry, uv)
    this.geometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(...pos)
    mesh.rotation.x = rotationX
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }

  private view(group: THREE.Group, legs: THREE.Object3D[], head: THREE.Object3D): EntityView {
    return {
      group, legs, head,
      walkPhase: Math.random() * Math.PI * 2,
      fromPosition: new THREE.Vector3(),
      targetPosition: new THREE.Vector3(),
      moveElapsed: MOVE_SMOOTH_SECONDS,
      fromYaw: 0,
      targetYaw: 0,
      furParts: [],
      carriedBlock: null,
      materials: []
    }
  }

  /** Each mob needs private material colors for its individual hurt flash. */
  private isolateMaterials(view: EntityView): void {
    const clones = new Map<THREE.Material, THREE.MeshLambertMaterial>()
    view.group.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshLambertMaterial)) return
      let material = clones.get(object.material)
      if (!material) {
        material = object.material.clone()
        clones.set(object.material, material)
      }
      object.material = material
    })
    view.materials = [...clones.values()]
  }

  private quadruped(kind: 'pig' | 'cow' | 'sheep' | 'mooshroom'): EntityView {
    const group = new THREE.Group()
    const material = this.materials.get(kind)!
    const legs: THREE.Object3D[] = []
    const cow = kind === 'cow' || kind === 'mooshroom', sheep = kind === 'sheep'
    const bodyUv: BoxUv = cow
      ? { u: 18, v: 4, width: 12, height: 18, depth: 10 }
      : sheep
        ? { u: 28, v: 8, width: 8, height: 16, depth: 6 }
        : { u: 28, v: 8, width: 10, height: 16, depth: 8 }
    const bodySize: [number, number, number] = cow ? [1.02, 1.5, 0.84] : sheep ? [0.86, 1.42, 0.68] : [0.9, 1.4, 0.74]
    this.box(group, bodySize, [0, cow ? 0.94 : 0.88, 0.08], material, bodyUv, Math.PI / 2)

    const headUv: BoxUv = cow
      ? { u: 0, v: 0, width: 8, height: 8, depth: 6 }
      : sheep
        ? { u: 0, v: 0, width: 6, height: 6, depth: 8 }
        : { u: 0, v: 0, width: 8, height: 8, depth: 8 }
    const headSize: [number, number, number] = cow ? [0.68, 0.68, 0.52] : sheep ? [0.54, 0.54, 0.64] : [0.66, 0.66, 0.66]
    const head = this.box(group, headSize, [0, cow ? 1.18 : 1.08, -0.72], material, headUv)

    if (kind === 'pig') {
      this.box(head, [0.34, 0.25, 0.1], [0, -0.07, -0.38], material,
        { u: 16, v: 16, width: 4, height: 3, depth: 1 })
    } else if (kind === 'cow') {
      this.box(head, [0.1, 0.28, 0.1], [-0.3, 0.34, -0.03], material,
        { u: 22, v: 0, width: 1, height: 3, depth: 1 })
      this.box(head, [0.1, 0.28, 0.1], [0.3, 0.34, -0.03], material,
        { u: 22, v: 0, width: 1, height: 3, depth: 1 })
    } else if (kind === 'mooshroom') {
      this.box(head, [0.1, 0.28, 0.1], [-0.3, 0.34, -0.03], material,
        { u: 22, v: 0, width: 1, height: 3, depth: 1 })
      this.box(head, [0.1, 0.28, 0.1], [0.3, 0.34, -0.03], material,
        { u: 22, v: 0, width: 1, height: 3, depth: 1 })
      this.box(group, [0.34, 0.34, 0.34], [-0.25, 1.72, 0.12], this.mushroomMaterial,
        { u: 0, v: 0, width: 16, height: 16, depth: 16 })
      this.box(group, [0.34, 0.34, 0.34], [0.28, 1.72, 0.32], this.mushroomMaterial,
        { u: 0, v: 0, width: 16, height: 16, depth: 16 })
    } else {
      group.userData.furParts = [
        this.box(group, [0.98, 1.54, 0.78], [0, 0.91, 0.08], this.sheepFurMaterial,
          { u: 28, v: 8, width: 8, height: 16, depth: 6 }, Math.PI / 2),
        this.box(head, [0.64, 0.64, 0.74], [0, 0, 0], this.sheepFurMaterial,
          { u: 0, v: 0, width: 6, height: 6, depth: 8 })
      ]
    }

    const legUv: BoxUv = cow
      ? { u: 0, v: 16, width: 4, height: 12, depth: 4 }
      : { u: 0, v: 16, width: 4, height: kind === 'pig' ? 6 : 12, depth: 4 }
    const legHeight = kind === 'pig' ? 0.56 : 0.7
    for (const x of [-0.3, 0.3]) for (const z of [-0.43, 0.48]) {
      legs.push(this.box(group, [0.2, legHeight, 0.2], [x, legHeight * 0.5, z], material, legUv))
    }
    const view = this.view(group, legs, head)
    view.furParts = group.userData.furParts ?? []
    return view
  }

  /** Classic large-nosed villager with folded arms. */
  private villager(): EntityView {
    const group = new THREE.Group()
    const material = this.materials.get('villager')!
    const legs: THREE.Object3D[] = []
    this.box(group, [0.52, 0.78, 0.32], [0, 1.14, 0], material,
      { u: 16, v: 16, width: 8, height: 12, depth: 4 })
    const head = this.box(group, [0.56, 0.62, 0.56], [0, 1.82, 0], material,
      { u: 0, v: 0, width: 8, height: 10, depth: 8 })
    this.box(head, [0.16, 0.28, 0.16], [0, -0.05, -0.35], material,
      { u: 24, v: 0, width: 2, height: 4, depth: 2 })
    for (const x of [-0.14, 0.14]) legs.push(this.box(group, [0.24, 0.72, 0.25], [x, 0.36, 0], material,
      { u: 0, v: 20, width: 4, height: 12, depth: 4 }))
    this.box(group, [0.62, 0.2, 0.22], [0, 1.15, -0.25], material,
      { u: 40, v: 16, width: 8, height: 4, depth: 4 }, -0.45)
    return this.view(group, legs, head)
  }

  private chicken(): EntityView {
    const group = new THREE.Group()
    const material = this.materials.get('chicken')!
    const legs: THREE.Object3D[] = []
    this.box(group, [0.58, 0.78, 0.58], [0, 0.78, 0.04], material,
      { u: 0, v: 9, width: 6, height: 8, depth: 6 }, Math.PI / 2)
    const head = this.box(group, [0.4, 0.52, 0.34], [0, 1.22, -0.3], material,
      { u: 0, v: 0, width: 4, height: 6, depth: 3 })
    this.box(head, [0.34, 0.16, 0.18], [0, -0.02, -0.25], material,
      { u: 14, v: 0, width: 4, height: 2, depth: 2 })
    this.box(head, [0.16, 0.18, 0.14], [0, -0.18, -0.16], material,
      { u: 14, v: 4, width: 2, height: 2, depth: 2 })
    this.box(group, [0.1, 0.38, 0.54], [-0.34, 0.83, 0.04], material,
      { u: 24, v: 13, width: 1, height: 4, depth: 6 })
    this.box(group, [0.1, 0.38, 0.54], [0.34, 0.83, 0.04], material,
      { u: 24, v: 13, width: 1, height: 4, depth: 6 })
    for (const x of [-0.16, 0.16]) {
      legs.push(this.box(group, [0.1, 0.42, 0.1], [x, 0.25, 0], material,
        { u: 26, v: 0, width: 3, height: 5, depth: 3 }))
    }
    return this.view(group, legs, head)
  }

  private humanoid(kind: 'zombie' | 'skeleton' | 'enderman'): EntityView {
    const group = new THREE.Group()
    const material = this.materials.get(kind)!
    const tall = kind === 'enderman'
    const thin = kind === 'skeleton' || tall
    const bodyHeight = tall ? 1.05 : 0.75
    const legHeight = tall ? 1.25 : 0.75
    const armHeight = tall ? 1.25 : 0.75
    const body = this.box(group, [thin ? 0.38 : 0.5, bodyHeight, thin ? 0.25 : 0.28], [0, legHeight + bodyHeight * 0.5, 0], material,
      { u: 16, v: 16, width: 8, height: 12, depth: 4 })
    const head = this.box(group, [tall ? 0.48 : 0.5, tall ? 0.48 : 0.5, tall ? 0.42 : 0.5], [0, legHeight + bodyHeight + 0.25, 0], material,
      { u: 0, v: 0, width: 8, height: 8, depth: 8 })
    const legs: THREE.Object3D[] = []
    for (const x of [-0.13, 0.13]) legs.push(this.box(group, [thin ? 0.14 : 0.23, legHeight, 0.24], [x, legHeight * 0.5, 0], material,
      { u: 0, v: 16, width: 4, height: 12, depth: 4 }))
    for (const x of [-0.32, 0.32]) legs.push(this.box(group, [thin ? 0.13 : 0.22, armHeight, 0.22], [x, legHeight + bodyHeight * 0.62, 0], material,
      { u: 40, v: 16, width: 4, height: 12, depth: 4 }))
    body.userData.hostile = true
    const view = this.view(group, legs, head)
    if (kind === 'enderman') {
      const geometry = new THREE.BoxGeometry(0.48, 0.48, 0.48)
      this.geometries.push(geometry)
      view.carriedBlock = new THREE.Mesh(geometry, this.carriedBlockMaterial)
      view.carriedBlock.position.set(0, 1.25, -0.48)
      view.carriedBlock.visible = false
      group.add(view.carriedBlock)
    }
    return view
  }

  private creeper(): EntityView {
    const group = new THREE.Group(), material = this.materials.get('creeper')!
    this.box(group, [0.52, 0.82, 0.32], [0, 0.83, 0], material, { u: 16, v: 16, width: 8, height: 12, depth: 4 })
    const head = this.box(group, [0.58, 0.58, 0.58], [0, 1.53, 0], material, { u: 0, v: 0, width: 8, height: 8, depth: 8 })
    const legs: THREE.Object3D[] = []
    for (const x of [-0.18, 0.18]) for (const z of [-0.15, 0.15]) legs.push(this.box(group, [0.24, 0.48, 0.24], [x, 0.24, z], material,
      { u: 0, v: 16, width: 4, height: 6, depth: 4 }))
    return this.view(group, legs, head)
  }

  private spider(): EntityView {
    const group = new THREE.Group(), material = this.materials.get('spider')!
    this.box(group, [0.82, 0.52, 0.92], [0, 0.48, 0.16], material, { u: 0, v: 12, width: 10, height: 8, depth: 12 })
    const head = this.box(group, [0.62, 0.48, 0.62], [0, 0.48, -0.58], material, { u: 32, v: 4, width: 8, height: 8, depth: 8 })
    const legs: THREE.Object3D[] = []
    for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
      const leg = this.box(group, [0.78, 0.1, 0.1], [side * 0.69, 0.42, -0.34 + i * 0.23], material,
        { u: 18, v: 0, width: 16, height: 2, depth: 2 })
      leg.rotation.z = side * (0.34 + Math.abs(i - 1.5) * 0.08)
      legs.push(leg)
    }
    return this.view(group, legs, head)
  }

  private slime(): EntityView {
    const group = new THREE.Group(), material = this.materials.get('slime')!
    const head = this.box(group, [1.1, 1.1, 1.1], [0, 0.56, 0], material, { u: 0, v: 16, width: 8, height: 8, depth: 8 })
    return this.view(group, [], head)
  }

  private build(kind: MobKind): EntityView {
    let view: EntityView
    if (kind === 'chicken') view = this.chicken()
    else if (kind === 'pig' || kind === 'cow' || kind === 'sheep' || kind === 'mooshroom') view = this.quadruped(kind)
    else if (kind === 'villager') view = this.villager()
    else if (kind === 'zombie' || kind === 'skeleton' || kind === 'enderman') view = this.humanoid(kind)
    else if (kind === 'creeper') view = this.creeper()
    else if (kind === 'spider') view = this.spider()
    else view = this.slime()
    this.isolateMaterials(view)
    this.group.add(view.group)
    return view
  }

  sync(entities: readonly EntitySnapshot[], dt: number): void {
    const live = new Set<string>()
    for (const entity of entities) {
      live.add(entity.id)
      let view = this.views.get(entity.id)
      if (!view) {
        view = this.build(entity.kind)
        this.views.set(entity.id, view)
        view.group.position.set(entity.x, entity.y, entity.z)
        view.fromPosition.copy(view.group.position)
        view.targetPosition.copy(view.group.position)
        view.group.rotation.y = entity.yaw
        view.fromYaw = view.targetYaw = entity.yaw
      }
      view.group.visible = entity.active
      if (!entity.active) continue
      if (view.targetPosition.x !== entity.x || view.targetPosition.y !== entity.y || view.targetPosition.z !== entity.z) {
        const distanceSq = view.group.position.distanceToSquared(view.targetPosition.set(entity.x, entity.y, entity.z))
        if (distanceSq > 64) {
          view.group.position.copy(view.targetPosition)
          view.fromPosition.copy(view.targetPosition)
          view.moveElapsed = MOVE_SMOOTH_SECONDS
        } else {
          view.fromPosition.copy(view.group.position)
          view.moveElapsed = 0
        }
      }
      if (Math.abs(Math.atan2(Math.sin(entity.yaw - view.targetYaw), Math.cos(entity.yaw - view.targetYaw))) > 0.0001) {
        view.fromYaw = view.group.rotation.y
        view.targetYaw = view.fromYaw + Math.atan2(
          Math.sin(entity.yaw - view.fromYaw),
          Math.cos(entity.yaw - view.fromYaw)
        )
        view.moveElapsed = 0
      }
      view.moveElapsed = Math.min(MOVE_SMOOTH_SECONDS, view.moveElapsed + dt)
      const linear = view.moveElapsed / MOVE_SMOOTH_SECONDS
      const smooth = linear * linear * (3 - 2 * linear)
      view.group.position.lerpVectors(view.fromPosition, view.targetPosition, smooth)
      view.group.rotation.y = view.fromYaw + (view.targetYaw - view.fromYaw) * smooth
      const deathProgress = Math.min(1, Math.max(0, entity.deathTime) / 0.7)
      view.group.rotation.z = -deathProgress * Math.PI * 0.5
      const scale = (entity.age < 0 ? 0.58 : 1) * (entity.sizeScale ?? 1)
      view.group.scale.setScalar(scale)
      const hurt = entity.hurtTime > 0 || (entity.deathTime > 0 && deathProgress < 0.35)
      const professionColors: Record<VillagerProfession, number> = {
        farmer: 0xffffff, librarian: 0xf2e7d0, blacksmith: 0xc9c9c9, butcher: 0xf3d2d2, priest: 0xd7c1e8
      }
      const baseColor = entity.kind === 'villager' && entity.profession
        ? professionColors[entity.profession]
        : 0xffffff
      for (const material of view.materials) {
        material.color.setHex(hurt ? 0xff5555 : baseColor)
        material.emissive.setHex(hurt ? 0x350000 : 0x000000)
        material.emissiveIntensity = hurt ? 0.8 : 1
      }
      for (const fur of view.furParts) fur.visible = !entity.sheared
      if (view.carriedBlock) {
        view.carriedBlock.visible = entity.carriedBlock !== null
        if (entity.carriedBlock !== null) {
          const colors: Record<number, number> = { 1: 0x6d9b45, 2: 0x795a3a, 4: 0xd8c47d, 9: 0x777777 }
          ;(view.carriedBlock.material as THREE.MeshLambertMaterial).color
            .setHex(hurt ? 0xff5555 : colors[entity.carriedBlock] ?? 0x8b6a45)
        }
      }
      if (entity.kind === 'creeper' && (entity.fuse ?? 0) > 0) {
        const pulse = 1 + Math.sin((entity.fuse ?? 0) * 28) * 0.035
        view.group.scale.multiplyScalar(pulse)
      }
      const speed = Math.hypot(entity.vx, entity.vz)
      view.walkPhase += dt * (3 + speed * 7)
      const swing = Math.sin(view.walkPhase) * Math.min(0.75, speed * 0.28)
      for (let i = 0; i < view.legs.length; i++) view.legs[i].rotation.x = i % 2 ? -swing : swing
      view.head.rotation.x = Math.sin(view.walkPhase * 0.18) * 0.08
    }
    for (const [id, view] of this.views) {
      if (live.has(id)) continue
      view.group.removeFromParent()
      for (const material of view.materials) material.dispose()
      this.views.delete(id)
    }
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const view of this.views.values()) for (const material of view.materials) material.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials.values()) material.dispose()
    this.sheepFurMaterial.dispose()
    this.carriedBlockMaterial.dispose()
    this.mushroomMaterial.dispose()
    for (const texture of this.textures) texture.dispose()
    this.views.clear()
  }
}
