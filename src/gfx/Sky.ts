import * as THREE from 'three'
import { U } from './Uniforms'

/** Sky dome (gradient, sun, moon, stars) plus a drifting procedural cloud layer. */
export class Sky {
  group = new THREE.Group()
  private dome: THREE.Mesh
  private clouds: THREE.Mesh

  constructor() {
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTime: U.uTime,
        uSunDir: U.uSunDir,
        uSunColor: U.uSunColor,
        uHorizon: U.uHorizon,
        uZenith: U.uZenith,
        uNight: U.uNight,
        uFlash: U.uFlash,
        uCloudDark: U.uCloudDark
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // pin to far plane
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uSunDir, uSunColor, uHorizon, uZenith;
        uniform float uTime, uNight, uFlash, uCloudDark;

        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
          if (h < 0.0) sky = mix(uHorizon, uHorizon * 0.62, clamp(-h * 2.5, 0.0, 1.0));

          vec3 sd = normalize(uSunDir);
          float cosSun = dot(d, sd);
          float sunUp = smoothstep(-0.12, 0.02, sd.y);
          // warm glow around the sun
          sky += uSunColor * pow(max(cosSun, 0.0), 12.0) * 0.28 * sunUp * (1.0 - uCloudDark * 0.7);
          sky += uSunColor * pow(max(cosSun, 0.0), 90.0) * 0.55 * sunUp;
          // sun disk
          float disk = smoothstep(0.99938, 0.99972, cosSun);
          sky += uSunColor * disk * 4.0 * sunUp * (1.0 - uCloudDark * 0.85);

          // moon opposite the sun
          vec3 md = -sd;
          float cosMoon = dot(d, md);
          float moonUp = smoothstep(-0.05, 0.1, md.y);
          float moonDisk = smoothstep(0.99965, 0.99985, cosMoon);
          float crater = hash13(floor(d * 900.0));
          sky += (vec3(0.85, 0.9, 1.0) * (0.8 + crater * 0.2) * moonDisk
                + vec3(0.35, 0.45, 0.65) * pow(max(cosMoon, 0.0), 80.0) * 0.35) * moonUp * uNight;

          // stars
          float night = uNight * smoothstep(0.02, 0.2, h);
          if (night > 0.01) {
            vec3 cell = floor(d * 180.0);
            float star = hash13(cell);
            if (star > 0.9955) {
              vec3 f = fract(d * 180.0) - 0.5;
              float fall = smoothstep(0.45, 0.05, length(f));
              float tw = 0.55 + 0.45 * sin(uTime * (1.5 + star * 4.0) + star * 90.0);
              sky += vec3(0.9, 0.92, 1.0) * (star - 0.9955) / 0.0045 * fall * tw * night;
            }
          }

          sky += vec3(0.8, 0.85, 1.0) * uFlash * 0.7;
          gl_FragColor = vec4(sky, 1.0);
        }
      `
    })
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), domeMat)
    this.dome.frustumCulled = false
    this.dome.renderOrder = -10
    this.dome.scale.setScalar(900)
    this.group.add(this.dome)

    const cloudMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: U.uTime,
        uCover: U.uCloudCover,
        uDark: U.uCloudDark,
        uSunColor: U.uSunColor,
        uNight: U.uNight,
        uFlash: U.uFlash,
        uOffset: U.uCloudOffset
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform float uTime, uCover, uDark, uNight, uFlash;
        uniform vec3 uSunColor;
        uniform vec2 uOffset;

        float h21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vn(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x),
                     mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 11.7; a *= 0.5; }
          return s;
        }

        void main() {
          vec2 world = (vUv - 0.5) * 4600.0 + uOffset;
          vec2 p = world * 0.0014 + vec2(uTime * 0.009, uTime * 0.004);
          float n = fbm(p);
          float edge = 0.92 - uCover * 0.62;
          float a = smoothstep(edge, edge + 0.2, n);
          float shade = fbm(p * 2.3 + 3.7);
          vec3 col = mix(vec3(1.04, 1.02, 0.99), vec3(0.42, 0.45, 0.52), clamp(uDark * 0.85 + shade * 0.45, 0.0, 1.0));
          col *= mix(vec3(1.0), uSunColor * 1.1, 0.4);
          col = mix(col, col * vec3(0.16, 0.19, 0.3), uNight * 0.9);
          col += vec3(uFlash) * 0.9;
          float r = length(vUv - 0.5) * 2.0;
          a *= smoothstep(1.0, 0.5, r) * 0.92;
          gl_FragColor = vec4(col, a);
        }
      `
    })
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(4600, 4600), cloudMat)
    this.clouds.rotation.x = -Math.PI / 2
    this.clouds.position.y = 235
    this.clouds.renderOrder = -5
    this.clouds.frustumCulled = false
    this.group.add(this.clouds)
  }

  update(camPos: THREE.Vector3): void {
    // dome follows the camera; clouds stay world-anchored via uOffset
    this.dome.position.copy(camPos)
    this.clouds.position.x = camPos.x
    this.clouds.position.z = camPos.z
    // plane is rotated -90° about X, so its uv-y axis runs along world -z
    U.uCloudOffset.value.set(camPos.x, -camPos.z)
  }
}
