import * as THREE from 'three'
import type { EntitySnapshot, MobKind, VillagerProfession } from './EntityTypes'
import type { Atlas } from '../gfx/Atlas'
import { B, tileFor, type BlockId } from '../world/Blocks'
import { createExtrudedItemGeometry, setExtrudedItemUv } from '../gfx/HeldItemGeometry'
import { EntityView, BoxUv, TEXTURE_WIDTH, TEXTURE_HEIGHT, PROFESSION_TEXTURES, MOB_ROOT, MOVE_SMOOTH_SECONDS, RenderSnapshot } from './EntityRendererShared'
import type { EntityRenderer } from './EntityRenderer'

type EntityRendererConstructor = { prototype: EntityRenderer }

export function installEntityRendererHostileModels(EntityRendererClass: EntityRendererConstructor): void {
  const prototype = EntityRendererClass.prototype
  prototype.humanoid = function(this: EntityRenderer, kind: 'zombie' | 'skeleton' | 'enderman'): EntityView {
    const group = new THREE.Group()
    const material = this.materials.get(kind)!
    const tall = kind === 'enderman'
    const thin = kind === 'skeleton' || tall
    const bodyHeight = tall ? 0.7 : 0.75
    const legHeight = tall ? 1.72 : 0.75
    const armHeight = tall ? 1.72 : 0.75
    const body = this.box(group, [thin ? 0.38 : 0.5, bodyHeight, thin ? 0.25 : 0.28], [0, legHeight + bodyHeight * 0.5, 0], material,
      { u: tall ? 32 : 16, v: 16, width: 8, height: 12, depth: 4 })
    body.castShadow = true
    const head = this.box(group, [tall ? 0.48 : 0.5, tall ? 0.48 : 0.5, tall ? 0.42 : 0.5], [0, legHeight + bodyHeight + 0.25, 0], material,
      { u: 0, v: 0, width: 8, height: 8, depth: 8 })
    head.castShadow = true
    const legs: THREE.Object3D[] = []
    for (const x of [-0.13, 0.13]) legs.push(this.limb(group, [thin ? 0.14 : 0.23, legHeight, 0.24], [x, legHeight, 0], material,
      { u: tall ? 56 : 0, v: tall ? 0 : 16, width: tall ? 2 : 4, height: tall ? 30 : 12, depth: tall ? 2 : 4 }))
    const arms: THREE.Object3D[] = []
    for (const x of [-0.32, 0.32]) {
      arms.push(this.limb(group, [thin ? 0.13 : 0.22, armHeight, 0.22],
        [x, legHeight + bodyHeight, 0], material,
        { u: tall ? 56 : 40, v: tall ? 0 : 16, width: tall ? 2 : 4, height: tall ? 30 : 12, depth: tall ? 2 : 4 }))
    }
    if (kind === 'skeleton') {
      const bow = new THREE.Group()
      bow.position.set(0, -armHeight * 0.55, -0.18)
      bow.rotation.set(0.15, 0, -0.2)
      arms[1].add(bow)
      this.box(bow, [0.055, 0.42, 0.055], [0, 0.2, 0], this.bowMaterial,
        { u: 0, v: 0, width: 1, height: 7, depth: 1 }, 0.35)
      this.box(bow, [0.055, 0.42, 0.055], [0, -0.2, 0], this.bowMaterial,
        { u: 0, v: 0, width: 1, height: 7, depth: 1 }, -0.35)
      this.box(bow, [0.025, 0.78, 0.025], [0.075, 0, 0], this.bowMaterial,
        { u: 0, v: 0, width: 1, height: 12, depth: 1 })
    }
    body.userData.hostile = true
    const view = this.view(group, legs, head, arms)
    if (kind === 'enderman') {
      this.box(head, [0.5, 0.5, 0.44], [0, 0, 0], this.eyeMaterials.get('enderman')!,
        { u: 0, v: 0, width: 8, height: 8, depth: 8 })
      const geometry = new THREE.BoxGeometry(0.48, 0.48, 0.48)
      this.geometries.push(geometry)
      view.carriedBlock = new THREE.Mesh(geometry, this.carriedBlockMaterial)
      view.carriedBlock.position.set(0, 1.18, -0.62)
      view.carriedBlock.rotation.set(THREE.MathUtils.degToRad(20), THREE.MathUtils.degToRad(45), 0)
      view.carriedBlock.visible = false
      group.add(view.carriedBlock)
    }
    return view
  }
  prototype.creeper = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('creeper')!
    this.box(group, [0.52, 0.82, 0.32], [0, 0.83, 0], material, { u: 16, v: 16, width: 8, height: 12, depth: 4 }).castShadow = true
    const head = this.box(group, [0.58, 0.58, 0.58], [0, 1.53, 0], material, { u: 0, v: 0, width: 8, height: 8, depth: 8 })
    head.castShadow = true
    const legs: THREE.Object3D[] = []
    for (const x of [-0.18, 0.18]) for (const z of [-0.15, 0.15]) legs.push(this.limb(group, [0.24, 0.48, 0.24], [x, 0.48, z], material,
      { u: 0, v: 16, width: 4, height: 6, depth: 4 }))
    return this.view(group, legs, head)
  }
  prototype.spider = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('spider')!
    this.box(group, [0.82, 0.52, 0.92], [0, 0.48, 0.16], material, { u: 0, v: 12, width: 10, height: 8, depth: 12 }).castShadow = true
    const head = this.box(group, [0.62, 0.48, 0.62], [0, 0.48, -0.58], material, { u: 32, v: 4, width: 8, height: 8, depth: 8 })
    head.castShadow = true
    this.box(head, [0.64, 0.5, 0.64], [0, 0, 0], this.eyeMaterials.get('spider')!, { u: 32, v: 4, width: 8, height: 8, depth: 8 })
    const legs: THREE.Object3D[] = []
    for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
      const joint = new THREE.Group()
      joint.position.set(side * 0.3, 0.42, -0.34 + i * 0.23)
      group.add(joint)
      this.box(joint, [0.78, 0.1, 0.1], [side * 0.39, 0, 0], material,
        { u: 18, v: 0, width: 16, height: 2, depth: 2 })
      const spread = (i < 2 ? 1 : -1) * (i % 2 === 0 ? Math.PI / 4 : Math.PI / 8)
      joint.rotation.y = side * spread
      // The limb extends along local +/-X. This sign bends both sides down;
      // the inverse sign made every leg point above the spider's body.
      joint.rotation.z = -side * (i === 0 || i === 3 ? Math.PI / 4 : Math.PI * 0.185)
      joint.userData.baseY = joint.rotation.y
      joint.userData.baseZ = joint.rotation.z
      legs.push(joint)
    }
    return this.view(group, legs, head)
  }
  prototype.slime = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('slime')!
    const head = this.box(group, [1.1, 1.1, 1.1], [0, 0.56, 0], material,
      { u: 0, v: 0, width: 8, height: 8, depth: 8 })
    this.box(group, [0.82, 0.82, 0.82], [0, 0.56, 0], material,
      { u: 0, v: 16, width: 6, height: 6, depth: 6 })
    this.box(group, [0.18, 0.18, 0.14], [-0.25, 0.67, -0.51], material,
      { u: 32, v: 0, width: 2, height: 2, depth: 2 })
    this.box(group, [0.18, 0.18, 0.14], [0.25, 0.67, -0.51], material,
      { u: 32, v: 4, width: 2, height: 2, depth: 2 })
    this.box(group, [0.1, 0.1, 0.1], [0.05, 0.38, -0.54], material,
      { u: 32, v: 8, width: 1, height: 1, depth: 1 })
    head.castShadow = true
    return this.view(group, [], head)
  }
  prototype.silverfish = function(this: EntityRenderer): EntityView {
    const group = new THREE.Group(), material = this.materials.get('silverfish')!
    const parts = [
      { size: [3, 2, 2], uv: [0, 0] },
      { size: [4, 3, 2], uv: [0, 4] },
      { size: [6, 4, 3], uv: [0, 9] },
      { size: [3, 3, 3], uv: [0, 16] },
      { size: [2, 2, 3], uv: [0, 22] },
      { size: [2, 1, 2], uv: [11, 0] },
      { size: [1, 1, 2], uv: [13, 4] }
    ] as const
    const segments: THREE.Object3D[] = []
    let zPixels = -3.5
    for (let i = 0; i < parts.length; i++) {
      const [width, height, depth] = parts[i].size
      const [u, v] = parts[i].uv
      const segment = this.box(
        group,
        [width / 16, height / 16, depth / 16],
        [0, height / 32, zPixels / 16],
        material,
        { u, v, width, height, depth }
      )
      segment.castShadow = true
      segment.userData.silverfishBaseX = segment.position.x
      segments.push(segment)
      const next = parts[i + 1]
      if (next) zPixels += (depth + next.size[2]) * 0.5
    }
    // ModelSilverfish also has three thin dorsal plates attached to the broad
    // middle segments. Parenting them keeps each plate in the same body wave.
    for (const fin of [
      { segment: 2, size: [10, 8, 1], uv: [20, 0] },
      { segment: 3, size: [6, 4, 1], uv: [20, 11] },
      { segment: 4, size: [6, 5, 1], uv: [20, 18] }
    ] as const) {
      const [width, height, depth] = fin.size
      const [u, v] = fin.uv
      const bodyHeight = parts[fin.segment].size[1]
      const plate = this.box(
        segments[fin.segment],
        [width / 16, height / 16, depth / 16],
        [0, (bodyHeight + height) / 32, 0],
        material,
        { u, v, width, height, depth }
      )
      plate.castShadow = true
    }
    const view = this.view(group, [], segments[0])
    view.segments = segments
    return view
  }
  prototype.build = function(this: EntityRenderer, kind: MobKind): EntityView {
    let view: EntityView
    if (kind === 'chicken') view = this.chicken()
    else if (kind === 'pig' || kind === 'cow' || kind === 'sheep' || kind === 'mooshroom') view = this.quadruped(kind)
    else if (kind === 'wolf') view = this.wolf()
    else if (kind === 'ocelot' || kind === 'cat') view = this.ocelot(kind)
    else if (kind === 'squid') view = this.squid()
    else if (kind === 'snow_golem') view = this.snowGolem()
    else if (kind === 'iron_golem') view = this.ironGolem()
    else if (kind === 'villager') view = this.villager()
    else if (kind === 'zombie' || kind === 'skeleton' || kind === 'enderman') view = this.humanoid(kind)
    else if (kind === 'creeper') view = this.creeper()
    else if (kind === 'spider') view = this.spider()
    else if (kind === 'slime') view = this.slime()
    else view = this.silverfish()
    view.kind = kind
    this.isolateMaterials(view)
    this.group.add(view.group)
    return view
  }
}
