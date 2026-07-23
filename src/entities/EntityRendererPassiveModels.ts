import * as THREE from 'three'
import type { EntitySnapshot, MobKind, VillagerProfession } from './EntityTypes'
import type { Atlas } from '../gfx/Atlas'
import { B, tileFor, type BlockId } from '../world/Blocks'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'
import { EntityView, BoxUv, TEXTURE_WIDTH, TEXTURE_HEIGHT, PROFESSION_TEXTURES, MOB_ROOT, MOVE_SMOOTH_SECONDS, RenderSnapshot } from './EntityRendererShared'
import type { EntityRenderer } from './EntityRenderer'

type EntityRendererConstructor = { prototype: EntityRenderer }

export function installEntityRendererPassiveModels(EntityRendererClass: EntityRendererConstructor): void {
  const prototype = EntityRendererClass.prototype
  prototype.mobTexture = function(this: EntityRenderer, loader: THREE.TextureLoader, file: string): THREE.Texture {
    const texture = loader.load(MOB_ROOT + file)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    this.textures.push(texture)
    return texture
  }
  prototype.eyesMaterial = function(this: EntityRenderer, loader: THREE.TextureLoader, file: string): THREE.MeshBasicMaterial {
    const texture = loader.load(MOB_ROOT + file)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    this.textures.push(texture)
    return new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  }
  prototype.mobMaterial = function(this: EntityRenderer, loader: THREE.TextureLoader, file: string, transparent = false): THREE.MeshLambertMaterial {
    const texture = this.mobTexture(loader, file)
    return new THREE.MeshLambertMaterial({
      map: texture,
      transparent,
      alphaTest: transparent ? 0.1 : 0,
      side: THREE.FrontSide
    })
  }
  prototype.mapBoxUvs = function(this: EntityRenderer, geometry: THREE.BoxGeometry, box: BoxUv, texH = TEXTURE_HEIGHT, texW = TEXTURE_WIDTH): void {
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
      const u0 = px0 / texW, u1 = px1 / texW
      const v0 = 1 - py1 / texH, v1 = 1 - py0 / texH
      const offset = face * 4
      uv.setXY(offset, u0, v1)
      uv.setXY(offset + 1, u1, v1)
      uv.setXY(offset + 2, u0, v0)
      uv.setXY(offset + 3, u1, v0)
    }
    uv.needsUpdate = true
  }
  prototype.box = function(this: EntityRenderer, parent: THREE.Object3D, size: [number, number, number], pos: [number, number, number], material: THREE.Material, uv: BoxUv, rotationX = 0, texH = TEXTURE_HEIGHT, texW = TEXTURE_WIDTH): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(...size)
    this.mapBoxUvs(geometry, uv, texH, texW)
    this.geometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(...pos)
    mesh.rotation.x = rotationX
    // Only the main body/head boxes opt back in to shadow casting; rendering
    // every limb into the shadow map costs far more than it shows.
    mesh.castShadow = false
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }
  prototype.limb = function(this: EntityRenderer, parent: THREE.Object3D, size: [number, number, number], pivot: [number, number, number], material: THREE.Material, uv: BoxUv, texH = TEXTURE_HEIGHT, texW = TEXTURE_WIDTH, local: [number, number, number] = [0, -size[1] * 0.5, 0]): THREE.Group {
    const joint = new THREE.Group()
    joint.position.set(...pivot)
    parent.add(joint)
    this.box(joint, size, local, material, uv, 0, texH, texW)
    return joint
  }
  prototype.setCarriedBlockUvs = function(this: EntityRenderer, mesh: THREE.Mesh, id: number): void {
    if (!this.atlas) return
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let face = 0; face < 6; face++) {
      const [u0, v0, u1, v1] = this.atlas.uvRect(tileFor(id as BlockId, face))
      const offset = face * 4
      uv.setXY(offset, u0, v1)
      uv.setXY(offset + 1, u1, v1)
      uv.setXY(offset + 2, u0, v0)
      uv.setXY(offset + 3, u1, v0)
    }
    uv.needsUpdate = true
    mesh.userData.blockId = id
  }
  prototype.mushroom = function(this: EntityRenderer, parent: THREE.Object3D, pos: [number, number, number], rotationY = 0): THREE.Mesh {
    const geometry = createExtrudedItemGeometry(0.38)
    if (this.atlas) setExtrudedItemUv(geometry, this.atlas.uvRect(tileFor(B.MUSHROOM_RED, 0)))
    this.geometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, this.mushroomMaterial)
    mesh.position.set(...pos)
    mesh.rotation.y = rotationY
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }
  prototype.view = function(this: EntityRenderer, group: THREE.Group, legs: THREE.Object3D[], head: THREE.Object3D, arms: THREE.Object3D[] = []): EntityView {
    return {
      kind: null, group, legs, arms, head,
      walkPhase: Math.random() * Math.PI * 2,
      fromPosition: new THREE.Vector3(),
      targetPosition: new THREE.Vector3(),
      moveElapsed: MOVE_SMOOTH_SECONDS,
      fromYaw: 0,
      targetYaw: 0,
      furParts: [],
      saddleParts: [],
      wings: [],
      tails: [],
      tentacles: [],
      segments: [],
      carriedBlock: null,
      heldItem: null,
      materials: []
    }
  }
  prototype.isolateMaterials = function(this: EntityRenderer, view: EntityView): void {
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
  prototype.quadruped = function(this: EntityRenderer, kind: 'pig' | 'cow' | 'sheep' | 'mooshroom'): EntityView {
    const group = new THREE.Group()
    const material = this.materials.get(kind)!
    const legs: THREE.Object3D[] = []
    const saddleParts: THREE.Object3D[] = []
    const cow = kind === 'cow' || kind === 'mooshroom', sheep = kind === 'sheep'
    const bodyUv: BoxUv = cow
      ? { u: 18, v: 4, width: 12, height: 18, depth: 10 }
      : sheep
        ? { u: 28, v: 8, width: 8, height: 16, depth: 6 }
        : { u: 28, v: 8, width: 10, height: 16, depth: 8 }
    const bodySize: [number, number, number] = cow ? [1.02, 1.5, 0.84] : sheep ? [0.86, 1.42, 0.68] : [0.9, 1.4, 0.74]
    // -PI/2 lays the tall body box down so its "belly" strip (udder for cows)
    // faces down. +PI/2 would put the belly texture — and the cow udder — on
    // the spine, which reads as a stray pink "snout" on the animal's back.
    this.box(group, bodySize, [0, cow ? 0.94 : 0.88, 0.08], material, bodyUv, -Math.PI / 2).castShadow = true

    const headUv: BoxUv = cow
      ? { u: 0, v: 0, width: 8, height: 8, depth: 6 }
      : sheep
        ? { u: 0, v: 0, width: 6, height: 6, depth: 8 }
        : { u: 0, v: 0, width: 8, height: 8, depth: 8 }
    const headSize: [number, number, number] = cow ? [0.68, 0.68, 0.52] : sheep ? [0.54, 0.54, 0.64] : [0.66, 0.66, 0.66]
    const head = this.box(group, headSize, [0, cow ? 1.18 : 1.08, -0.72], material, headUv)
    head.castShadow = true

    if (kind === 'pig') {
      this.box(head, [0.34, 0.25, 0.1], [0, -0.07, -0.38], material,
        { u: 16, v: 16, width: 4, height: 3, depth: 1 })
      const saddleBody = this.box(group, [0.91, 1.41, 0.75], [0, 0.88, 0.08], this.saddleMaterial,
        { u: 28, v: 8, width: 10, height: 16, depth: 8 }, -Math.PI / 2)
      const saddleHead = this.box(group, [0.67, 0.67, 0.67], [0, 1.08, -0.72], this.saddleMaterial,
        { u: 0, v: 0, width: 8, height: 8, depth: 8 })
      const saddleSnout = this.box(saddleHead, [0.35, 0.26, 0.11], [0, -0.07, -0.38], this.saddleMaterial,
        { u: 16, v: 16, width: 4, height: 3, depth: 1 })
      saddleParts.push(saddleBody, saddleHead, saddleSnout)
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
      this.mushroom(group, [-0.25, 1.72, 0.12], Math.PI / 5)
      this.mushroom(group, [0.28, 1.72, 0.32], -Math.PI / 5)
      this.mushroom(head, [0, 0.46, 0.02], Math.PI / 2)
    } else {
      // Only a woolly body layer. This sheep_fur.png has an opaque wool face on
      // its head region, so an inflated fur head box would bury the sheep's face
      // in wool — classic sheep keep a bare, visible face.
      group.userData.furParts = [
        this.box(group, [0.98, 1.54, 0.78], [0, 0.91, 0.08], this.sheepFurMaterial,
          { u: 28, v: 8, width: 8, height: 16, depth: 6 }, -Math.PI / 2)
      ]
    }

    const legUv: BoxUv = cow
      ? { u: 0, v: 16, width: 4, height: 12, depth: 4 }
      : { u: 0, v: 16, width: 4, height: kind === 'pig' ? 6 : 12, depth: 4 }
    const legHeight = kind === 'pig' ? 0.56 : 0.7
    for (const x of [-0.3, 0.3]) for (const z of [-0.43, 0.48]) {
      legs.push(this.limb(group, [0.2, legHeight, 0.2], [x, legHeight, z], material, legUv))
    }
    const view = this.view(group, legs, head)
    view.furParts = group.userData.furParts ?? []
    view.saddleParts = saddleParts
    return view
  }
  prototype.villager = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group()
    const material = this.materials.get('villager')!
    const legs: THREE.Object3D[] = []
    const H = 64 // villager.png is 64x64, not the classic 64x32
    this.box(group, [0.5, 0.75, 0.375], [0, 1.125, 0], material,
      { u: 16, v: 20, width: 8, height: 12, depth: 6 }, 0, H).castShadow = true
    // The long outer robe is a second inflated cuboid, not a colour tint.
    this.box(group, [0.56, 1.16, 0.44], [0, 0.94, 0], material,
      { u: 0, v: 38, width: 8, height: 18, depth: 6 }, 0, H)
    const head = this.box(group, [0.56, 0.62, 0.56], [0, 1.82, 0], material,
      { u: 0, v: 0, width: 8, height: 10, depth: 8 }, 0, H)
    head.castShadow = true
    this.box(head, [0.16, 0.28, 0.16], [0, -0.05, -0.35], material,
      { u: 24, v: 0, width: 2, height: 4, depth: 2 }, 0, H)
    for (const x of [-0.125, 0.125]) legs.push(this.limb(group, [0.25, 0.75, 0.25], [x, 0.75, 0], material,
      { u: 0, v: 22, width: 4, height: 12, depth: 4 }, H))
    const foldedArms = new THREE.Group()
    foldedArms.position.set(0, 1.31, -0.06)
    foldedArms.rotation.x = 0.75
    group.add(foldedArms)
    this.box(foldedArms, [0.25, 0.5, 0.25], [-0.375, 0, 0], material,
      { u: 44, v: 22, width: 4, height: 8, depth: 4 }, 0, H)
    this.box(foldedArms, [0.25, 0.5, 0.25], [0.375, 0, 0], material,
      { u: 44, v: 22, width: 4, height: 8, depth: 4 }, 0, H)
    this.box(foldedArms, [0.5, 0.25, 0.25], [0, -0.125, 0], material,
      { u: 40, v: 38, width: 8, height: 4, depth: 4 }, 0, H)
    return this.view(group, legs, head)
  }
  prototype.chicken = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group()
    // The parts were modelled ~1.5 blocks tall; a chicken is small, so build
    // them in an inner group scaled down to sit inside its ~0.7 hitbox.
    const model = new THREE.Group()
    model.scale.setScalar(0.6)
    group.add(model)
    const material = this.materials.get('chicken')!
    const legs: THREE.Object3D[] = []
    this.box(model, [0.58, 0.78, 0.58], [0, 0.78, 0.04], material,
      { u: 0, v: 9, width: 6, height: 8, depth: 6 }, Math.PI / 2).castShadow = true
    const head = this.box(model, [0.4, 0.52, 0.34], [0, 1.22, -0.3], material,
      { u: 0, v: 0, width: 4, height: 6, depth: 3 })
    this.box(head, [0.34, 0.16, 0.18], [0, -0.02, -0.25], material,
      { u: 14, v: 0, width: 4, height: 2, depth: 2 })
    this.box(head, [0.16, 0.18, 0.14], [0, -0.18, -0.16], material,
      { u: 14, v: 4, width: 2, height: 2, depth: 2 })
    const wings = [
      this.box(model, [0.1, 0.38, 0.54], [-0.34, 0.83, 0.04], material,
        { u: 24, v: 13, width: 1, height: 4, depth: 6 }),
      this.box(model, [0.1, 0.38, 0.54], [0.34, 0.83, 0.04], material,
        { u: 24, v: 13, width: 1, height: 4, depth: 6 })
    ]
    for (const x of [-0.16, 0.16]) {
      legs.push(this.limb(model, [0.1, 0.42, 0.1], [x, 0.46, 0], material,
        { u: 26, v: 0, width: 3, height: 5, depth: 3 }))
    }
    const view = this.view(group, legs, head)
    view.wings = wings
    return view
  }
  prototype.ocelot = function(this: EntityRenderer, kind: 'ocelot' | 'cat'): EntityView {
    const group = new THREE.Group(), material = this.materials.get(kind)!
    const legs: THREE.Object3D[] = []
    this.box(group, [0.25, 1, 0.375], [0, 0.42, 0], material,
      { u: 20, v: 0, width: 4, height: 16, depth: 6 }, Math.PI / 2).castShadow = true
    const head = this.box(group, [0.32, 0.25, 0.32], [0, 0.7, -0.55], material,
      { u: 0, v: 0, width: 5, height: 4, depth: 5 })
    this.box(head, [0.19, 0.13, 0.13], [0, -0.04, -0.23], material,
      { u: 0, v: 24, width: 3, height: 2, depth: 2 })
    this.box(head, [0.07, 0.08, 0.13], [-0.1, 0.16, 0.03], material,
      { u: 0, v: 10, width: 1, height: 1, depth: 2 })
    this.box(head, [0.07, 0.08, 0.13], [0.1, 0.16, 0.03], material,
      { u: 6, v: 10, width: 1, height: 1, depth: 2 })
    for (const [x, z, height, uv] of [
      [-0.075, -0.3, 0.55, { u: 40, v: 0, width: 2, height: 10, depth: 2 }],
      [0.075, -0.3, 0.55, { u: 40, v: 0, width: 2, height: 10, depth: 2 }],
      [-0.07, 0.34, 0.38, { u: 8, v: 13, width: 2, height: 6, depth: 2 }],
      [0.07, 0.34, 0.38, { u: 8, v: 13, width: 2, height: 6, depth: 2 }]
    ] as const) legs.push(this.limb(group, [0.12, height, 0.12], [x, height, z], material, uv))
    const tailBase = this.limb(group, [0.07, 0.5, 0.07], [0, 0.55, 0.48], material,
      { u: 0, v: 15, width: 1, height: 8, depth: 1 }, 32, 64, [0, -0.22, 0.18])
    tailBase.rotation.x = 0.9
    const tailTip = this.limb(tailBase, [0.07, 0.5, 0.07], [0, -0.35, 0.28], material,
      { u: 4, v: 15, width: 1, height: 8, depth: 1 }, 32, 64)
    const view = this.view(group, legs, head)
    view.tails = [tailBase, tailTip]
    return view
  }
  prototype.wolf = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('wolf')!
    const legs: THREE.Object3D[] = []
    this.box(group, [0.38, 0.58, 0.38], [0, 0.55, 0.08], material,
      { u: 18, v: 14, width: 6, height: 9, depth: 6 }, Math.PI / 2).castShadow = true
    this.box(group, [0.5, 0.38, 0.44], [0, 0.68, -0.2], material,
      { u: 21, v: 0, width: 8, height: 6, depth: 7 })
    const head = this.box(group, [0.38, 0.38, 0.28], [-0.03, 0.82, -0.52], material,
      { u: 0, v: 0, width: 6, height: 6, depth: 4 })
    this.box(head, [0.19, 0.19, 0.25], [0, -0.02, -0.25], material,
      { u: 0, v: 10, width: 3, height: 3, depth: 4 })
    this.box(head, [0.13, 0.13, 0.07], [-0.13, 0.24, 0.02], material,
      { u: 16, v: 14, width: 2, height: 2, depth: 1 })
    this.box(head, [0.13, 0.13, 0.07], [0.13, 0.24, 0.02], material,
      { u: 16, v: 14, width: 2, height: 2, depth: 1 })
    for (const x of [-0.15, 0.15]) for (const z of [-0.28, 0.37]) {
      legs.push(this.limb(group, [0.13, 0.5, 0.13], [x, 0.5, z], material,
        { u: 0, v: 18, width: 2, height: 8, depth: 2 }))
    }
    const tail = this.limb(group, [0.13, 0.5, 0.13], [0, 0.65, 0.48], material,
      { u: 9, v: 18, width: 2, height: 8, depth: 2 })
    tail.rotation.x = 0.8
    const view = this.view(group, legs, head)
    view.tails = [tail]
    return view
  }
  prototype.squid = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('squid')!
    const head = this.box(group, [0.75, 0.9, 0.75], [0, 1.08, 0], material,
      { u: 0, v: 0, width: 12, height: 16, depth: 12 })
    head.castShadow = true
    const tentacles: THREE.Object3D[] = []
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI * 2 / 8
      const tentacle = this.limb(group, [0.12, 0.72, 0.12],
        [Math.cos(angle) * 0.31, 0.66, Math.sin(angle) * 0.31], material,
        { u: 48, v: 0, width: 2, height: 18, depth: 2 })
      tentacle.rotation.y = -angle + Math.PI / 2
      tentacles.push(tentacle)
    }
    const view = this.view(group, [], head)
    view.tentacles = tentacles
    return view
  }
  prototype.snowGolem = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('snow_golem')!
    this.box(group, [0.75, 0.75, 0.75], [0, 0.38, 0], material,
      { u: 0, v: 36, width: 12, height: 12, depth: 12 }, 0, 64).castShadow = true
    this.box(group, [0.62, 0.62, 0.62], [0, 1.02, 0], material,
      { u: 0, v: 16, width: 10, height: 10, depth: 10 }, 0, 64)
    const head = this.box(group, [0.5, 0.5, 0.5], [0, 1.55, 0], material,
      { u: 0, v: 0, width: 8, height: 8, depth: 8 }, 0, 64)
    const arms = [
      this.limb(group, [0.62, 0.1, 0.1], [-0.3, 1.25, 0], material,
        { u: 32, v: 0, width: 12, height: 2, depth: 2 }, 64, 64, [-0.31, 0, 0]),
      this.limb(group, [0.62, 0.1, 0.1], [0.3, 1.25, 0], material,
        { u: 32, v: 0, width: 12, height: 2, depth: 2 }, 64, 64, [0.31, 0, 0])
    ]
    arms[0].rotation.z = 1
    arms[1].rotation.z = -1
    return this.view(group, [], head)
  }
  prototype.ironGolem = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('iron_golem')!
    this.box(group, [1.12, 0.75, 0.69], [0, 1.78, 0], material,
      { u: 0, v: 40, width: 18, height: 12, depth: 11 }, 0, 128, 128).castShadow = true
    this.box(group, [0.62, 0.34, 0.44], [0, 1.23, 0], material,
      { u: 0, v: 70, width: 9, height: 5, depth: 6 }, 0, 128, 128)
    const head = this.box(group, [0.5, 0.62, 0.5], [0, 2.45, -0.12], material,
      { u: 0, v: 0, width: 8, height: 10, depth: 8 }, 0, 128, 128)
    this.box(head, [0.13, 0.25, 0.13], [0, -0.03, -0.31], material,
      { u: 24, v: 0, width: 2, height: 4, depth: 2 }, 0, 128, 128)
    const legs = [
      this.limb(group, [0.38, 1, 0.31], [-0.28, 1, 0], material,
        { u: 37, v: 0, width: 6, height: 16, depth: 5 }, 128, 128),
      this.limb(group, [0.38, 1, 0.31], [0.28, 1, 0], material,
        { u: 60, v: 0, width: 6, height: 16, depth: 5 }, 128, 128)
    ]
    const arms = [
      this.limb(group, [0.25, 1.88, 0.38], [-0.68, 2.25, 0], material,
        { u: 60, v: 21, width: 4, height: 30, depth: 6 }, 128, 128),
      this.limb(group, [0.25, 1.88, 0.38], [0.68, 2.25, 0], material,
        { u: 60, v: 58, width: 4, height: 30, depth: 6 }, 128, 128)
    ]
    return this.view(group, legs, head, arms)
  }
}
