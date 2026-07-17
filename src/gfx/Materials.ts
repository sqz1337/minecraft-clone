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
  solid: THREE.MeshStandardMaterial
  foliage: THREE.MeshStandardMaterial
  foliageDepth: THREE.MeshDepthMaterial
  water: THREE.ShaderMaterial

  constructor(atlas: Atlas) {
    this.solid = new THREE.MeshStandardMaterial({
      map: atlas.colorTex,
      roughness: 1,
      metalness: 0,
      vertexColors: true
    })

    this.foliage = new THREE.MeshStandardMaterial({
      map: atlas.colorTex,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
      alphaTest: 0.42,
      side: THREE.DoubleSide
    })
    this.injectWind(this.foliage)

    this.foliageDepth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: atlas.colorTex,
      alphaTest: 0.42
    })
    this.injectWind(this.foliageDepth)

    this.water = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: U.uTime,
        uSunDir: U.uSunDir,
        uSunColor: U.uSunColor,
        uHorizon: U.uHorizon,
        uZenith: U.uZenith,
        uFogColor: U.uFogColor,
        uFogDensity: U.uFogDensity,
        uCamPos: U.uCamPos,
        uNight: U.uNight,
        uFlash: U.uFlash
      },
      vertexShader: /* glsl */`
        attribute float aTop;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vTop;
        uniform float uTime;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          if (aTop > 0.5) {
            w.y += sin(w.x * 0.9 + uTime * 1.3) * 0.035
                 + sin(w.z * 1.24 + uTime * 1.7) * 0.03
                 + sin((w.x + w.z) * 0.5 + uTime * 0.8) * 0.03;
          }
          vWorld = w.xyz;
          vNormal = normal;
          vTop = aTop;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vTop;
        uniform float uTime, uFogDensity, uNight, uFlash;
        uniform vec3 uSunDir, uSunColor, uHorizon, uZenith, uFogColor, uCamPos;
        void main() {
          vec3 V = normalize(uCamPos - vWorld);
          vec3 N;
          if (vTop > 0.5) {
            // analytic derivatives of the vertex waves plus finer ripples
            float dx = 0.9 * cos(vWorld.x * 0.9 + uTime * 1.3) * 0.035
                     + 0.5 * cos((vWorld.x + vWorld.z) * 0.5 + uTime * 0.8) * 0.03
                     + sin(vWorld.z * 2.7 + uTime * 2.4) * 0.014
                     + sin(vWorld.x * 5.3 - uTime * 3.1) * 0.008;
            float dz = 1.24 * cos(vWorld.z * 1.24 + uTime * 1.7) * 0.03
                     + 0.5 * cos((vWorld.x + vWorld.z) * 0.5 + uTime * 0.8) * 0.03
                     + sin(vWorld.x * 2.3 - uTime * 2.2) * 0.014
                     + sin(vWorld.z * 4.7 + uTime * 2.9) * 0.008;
            N = normalize(vec3(-dx * 5.0, 1.0, -dz * 5.0));
          } else {
            N = normalize(vNormal);
            if (dot(N, V) < 0.0) N = -N;
          }
          float fres = 0.05 + 0.95 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec3 deep = vec3(0.015, 0.08, 0.14);
          vec3 shallow = vec3(0.06, 0.32, 0.36);
          vec3 base = mix(deep, shallow, pow(max(dot(N, V), 0.0), 1.4));
          vec3 skyRef = mix(uHorizon, uZenith, 0.35 + 0.65 * max(N.y, 0.0));
          vec3 col = mix(base, skyRef * 0.9, fres);
          vec3 H = normalize(V + normalize(uSunDir));
          float sunUp = smoothstep(-0.05, 0.12, uSunDir.y);
          float spec = pow(max(dot(N, H), 0.0), 240.0) * 2.2 * sunUp;
          spec += pow(max(dot(N, H), 0.0), 32.0) * 0.12 * sunUp;
          col += uSunColor * spec;
          col *= 1.0 - uNight * 0.72;
          col += vec3(0.35, 0.38, 0.45) * uFlash;
          float dist = length(uCamPos - vWorld);
          float fogF = clamp(exp(-pow(dist * uFogDensity, 2.0)), 0.0, 1.0);
          // gentle filmic rolloff to sit well with the ACES-toned terrain
          col = 1.0 - exp(-col * 1.7);
          col = mix(uFogColor, col, fogF);
          float alpha = clamp(0.66 + fres * 0.3, 0.0, 0.95);
          gl_FragColor = vec4(col, alpha);
        }
      `
    })
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
