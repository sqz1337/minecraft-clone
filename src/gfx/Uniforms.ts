import * as THREE from 'three'

/** Shared uniform objects — updated once per frame, referenced by every custom shader. */
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.2) },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uHorizon: { value: new THREE.Color(0.65, 0.78, 0.92) },
  uZenith: { value: new THREE.Color(0.15, 0.38, 0.78) },
  uFogColor: { value: new THREE.Color(0.65, 0.78, 0.92) },
  uFogDensity: { value: 0.01 },
  uCamPos: { value: new THREE.Vector3() },
  uNight: { value: 0 },
  uWind: { value: 1 },
  uFlash: { value: 0 },
  uCloudCover: { value: 0.35 },
  uCloudDark: { value: 0 },
  uCloudOffset: { value: new THREE.Vector2() }
}
