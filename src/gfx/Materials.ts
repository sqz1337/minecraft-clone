import * as THREE from 'three'
import type { Atlas } from './Atlas'
import { U } from './Uniforms'

const WIND_VERTEX = /* glsl */`
  {
    float ph = position.x * 1.7 + position.z * 1.3 + position.y * 0.6;
    float sway = aSway * uWindStrength;
    transformed.x += (sin(uWindTime * 1.9 + ph) + 0.5 * sin(uWindTime * 3.7 + ph * 1.7)) * 0.05 * sway;
    transformed.z += cos(uWindTime * 1.6 + ph * 0.8) * 0.045 * sway;
  }
`

export class Materials {
  solid: THREE.MeshLambertMaterial
  foliage: THREE.MeshLambertMaterial
  glass: THREE.MeshLambertMaterial
  emissive: THREE.MeshBasicMaterial
  furnaceFire: THREE.MeshBasicMaterial
  chest: THREE.MeshLambertMaterial
  largeChest: THREE.MeshLambertMaterial
  xrayOre: THREE.MeshBasicMaterial
  water: THREE.MeshLambertMaterial

  constructor(atlas: Atlas) {
    // Lambert everywhere: AO, sky/block light and tinting are already baked
    // into vertex colors by the mesher, so per-pixel PBR buys nothing here.
    this.solid = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      // Beds and doors live in the solid mesh but their classic terrain.png
      // tiles contain real cutout pixels (not black geometry).
      alphaTest: 0.42
    })

    this.foliage = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      alphaTest: 0.42,
      side: THREE.DoubleSide
    })
    this.injectWind(this.foliage)

    this.glass = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.58,
      alphaTest: 0.08,
      depthWrite: false,
      side: THREE.DoubleSide
    })

    this.emissive = new THREE.MeshBasicMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
      toneMapped: false
    })

    this.furnaceFire = new THREE.MeshBasicMaterial({
      map: atlas.colorTex,
      vertexColors: true
    })
    this.furnaceFire.onBeforeCompile = (shader) => {
      shader.uniforms.uFurnaceTime = U.uTime
      shader.fragmentShader = 'uniform float uFurnaceTime;\n' + shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float furnaceFireMask = smoothstep(0.08, 0.42, diffuseColor.r - diffuseColor.b)
          * smoothstep(0.18, 0.7, diffuseColor.r);
        float furnaceFlicker = 0.88
          + 0.1 * sin(uFurnaceTime * 9.0)
          + 0.06 * sin(uFurnaceTime * 17.0 + 1.7);
        diffuseColor.rgb = mix(
          diffuseColor.rgb,
          diffuseColor.rgb * furnaceFlicker + vec3(0.12, 0.035, 0.0),
          furnaceFireMask
        );`
      )
    }
    this.furnaceFire.customProgramCacheKey = () => 'furnace-fire-v1'

    this.chest = new THREE.MeshLambertMaterial({ map: atlas.chestTex })
    this.largeChest = new THREE.MeshLambertMaterial({ map: atlas.largeChestTex })

    this.xrayOre = new THREE.MeshBasicMaterial({
      map: atlas.colorTex,
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false
    })

    // Classic vanilla-style water: the semi-transparent blue still-water tile
    // from terrain.png, lit and fogged through the same built-in pipeline as the
    // terrain (so it matches sun/night/fog exactly). A gentle vertex wave on the
    // surface keeps it alive; the texture itself carries the animated look.
    this.water = new THREE.MeshLambertMaterial({
      map: atlas.colorTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    this.injectWaterWave(this.water)
  }

  /** Undulates the water surface (aTop vertices) in world space, seamless across chunks. */
  private injectWaterWave(mat: THREE.Material): void {
    mat.onBeforeCompile = (shader: { uniforms: Record<string, unknown>, vertexShader: string }) => {
      shader.uniforms.uWaterTime = U.uTime
      shader.vertexShader =
        'attribute float aTop;\nuniform float uWaterTime;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          if (aTop > 0.5) {
            vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
            transformed.y += sin(wp.x * 0.9 + uWaterTime * 1.3) * 0.045
                           + sin(wp.z * 1.24 + uWaterTime * 1.7) * 0.04
                           + sin((wp.x + wp.z) * 0.5 + uWaterTime * 0.8) * 0.035;
          }
        `)
    }
    mat.customProgramCacheKey = () => 'water-wave-v2'
  }

  setXray(enabled: boolean): void {
    this.solid.transparent = enabled
    this.solid.opacity = enabled ? 0.1 : 1
    this.solid.depthWrite = !enabled
    this.solid.needsUpdate = true
  }

  private injectWind(mat: THREE.Material): void {
    mat.onBeforeCompile = (shader: { uniforms: Record<string, unknown>, vertexShader: string }) => {
      shader.uniforms.uWindTime = U.uTime
      shader.uniforms.uWindStrength = U.uWind
      shader.vertexShader =
        'attribute float aSway;\nuniform float uWindTime;\nuniform float uWindStrength;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_VERTEX)
    }
    mat.customProgramCacheKey = () => 'wind-' + mat.type
  }
}
