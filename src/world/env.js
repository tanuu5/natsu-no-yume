// Uniforms shared by every material (by reference), and the environment of each
// time of day: sun, haze, clouds, exposure and grade.
import * as THREE from 'three';

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v4 = (x = 0, y = 0, z = 0, w = 0) => new THREE.Vector4(x, y, z, w);

export const U = {
  uTime: { value: 0 },
  uSunDir: { value: v3(0, 1, 0) },
  uSunI: { value: 20 },
  uHaze: { value: 1 },
  uMieG: { value: 0.78 },
  uNight: { value: 0 },
  uSkyLut: { value: null },
  uFog: { value: v4(1 / 9000, 500, 0, 0) },
  uFogTint: { value: new THREE.Color(1, 1, 1) },
  uNoise: { value: null },
  uCloudCover: { value: 0.35 },
  uCloudBase: { value: 1300 },
  uCloudThick: { value: 1400 },
  uCloudDens: { value: 1.0 },
  uWind: { value: new THREE.Vector2(0, 0) },
  uTower: { value: [v4(), v4(), v4(), v4()] },
  uCirrus: { value: 0 },
  uCirrusAlt: { value: 7000 },
  uCirrusOffset: { value: new THREE.Vector2(0, 0) },
  uStars: { value: 0 },
  uCloudSteps: { value: 64 },
  uShadowSeed: { value: 0 },
  uWindSway: { value: 1 },
  uLampOn: { value: 0 },
};

export function sunDir(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
  return v3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

// Apply an environment (see shots.js) to the shared uniforms at time t (seconds into the segment).
export function applyEnv(env, t) {
  if (env.sunPath) {
    // the sun moves during the walk: [az, el] at t0 and t1 (seconds into the segment)
    const { t0, t1, from, to } = env.sunPath;
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    U.uSunDir.value.copy(sunDir(from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u));
  } else U.uSunDir.value.copy(env.sun);
  U.uSunI.value = env.sunI;
  U.uHaze.value = env.haze;
  U.uMieG.value = env.mieG;
  U.uNight.value = env.night || 0;
  U.uFog.value.set(env.fog[0], env.fog[1], env.fog[2] || 0, env.fog[3] || 0);
  U.uFogTint.value.setRGB(...(env.fogTint || [1, 1, 1]));
  const c = env.clouds;
  U.uCloudCover.value = c.cover;
  U.uCloudBase.value = c.base;
  U.uCloudThick.value = c.thick;
  U.uCloudDens.value = c.dens;
  U.uWind.value.set(c.wind[0] + c.windV[0] * t, c.wind[1] + c.windV[1] * t);
  for (let i = 0; i < 4; i++) {
    const tw = c.towers[i];
    if (tw) U.uTower.value[i].set(tw[0], tw[1], tw[2], tw[3]);
    else U.uTower.value[i].set(0, 0, 1, 0);
  }
  U.uCirrus.value = c.cirrus || 0;
  U.uCirrusAlt.value = c.cirrusAlt || 7000;
  U.uCirrusOffset.value.set((c.cirrusV ? c.cirrusV[0] : 0) * t, (c.cirrusV ? c.cirrusV[1] : 0) * t);
  U.uStars.value = env.stars || 0;
}
