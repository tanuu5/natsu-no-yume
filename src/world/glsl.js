// Shared GLSL: a physically based single-scattering atmosphere (Rayleigh + Mie +
// ozone), volumetric cumulus on a spherical shell, a high cloud layer, stars, and the
// aerial-perspective function every material uses for distance haze.
// Units: metres; world y = altitude above the sea. Radiance is linear, sun = uSunI.

export const ATMOS = /* glsl */`
#ifndef PI
#define PI 3.14159265359
#endif
#define PLANET_R 6360000.0
#define ATMOS_R 6440000.0
const vec3 BETA_R = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float BETA_M = 3.996e-6;
const float EXT_M = 4.44e-6;
const vec3 ABS_O = vec3(0.650e-6, 1.881e-6, 0.085e-6);

uniform vec3 uSunDir;
uniform float uSunI;
uniform float uHaze;
uniform float uMieG;
uniform float uNight;      // 0 day .. 1 night (stars, moonlight floor)

vec2 raySph(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e12, -1e12);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
vec3 atmoDensity(float h) {
  h = max(h, 0.0);
  return vec3(exp(-h / 8000.0), exp(-h / 1200.0) * uHaze, max(0.0, 1.0 - abs(h - 25000.0) / 15000.0));
}
vec3 atmoExt(vec3 od) { return BETA_R * od.x + vec3(EXT_M) * od.y + ABS_O * od.z; }

// Transmittance from planet-centred point p towards the sun (0 when the planet is in the way).
vec3 sunTrans(vec3 p) {
  float r = length(p);
  float mu = dot(p / r, uSunDir);
  float muH = -sqrt(max(0.0, 1.0 - (PLANET_R * PLANET_R) / (r * r)));
  float vis = smoothstep(muH - 0.006, muH + 0.004, mu);
  if (vis <= 0.0) return vec3(0.0);
  float L = max(raySph(p, uSunDir, ATMOS_R).y, 0.0);
  vec3 od = vec3(0.0);
  float dt = L / 6.0;
  for (int i = 0; i < 6; i++) {
    vec3 q = p + uSunDir * ((float(i) + 0.5) * dt);
    od += atmoDensity(length(q) - PLANET_R);
  }
  return exp(-atmoExt(od * dt)) * vis;
}
float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

// In-scattered radiance along roW + t*rd for t in [0, tMax]; T = transmittance.
vec3 atmosphere(vec3 roW, vec3 rd, float tMax, out vec3 T) {
  vec3 ro = roW + vec3(0.0, PLANET_R, 0.0);
  float t1 = raySph(ro, rd, ATMOS_R).y;
  vec2 tg = raySph(ro, rd, PLANET_R);
  if (tg.x > 0.0) t1 = min(t1, tg.x);
  t1 = max(min(t1, tMax), 0.0);
  float mu = dot(rd, uSunDir);
  float pR = phaseR(mu), pM = phaseM(mu, uMieG);
  vec3 od = vec3(0.0), sR = vec3(0.0), sM = vec3(0.0);
  float tPrev = 0.0;
  const int N = 20;
  for (int i = 0; i < N; i++) {
    float u = (float(i) + 1.0) / float(N);
    float t = t1 * u * u;
    float dt = t - tPrev;
    vec3 p = ro + rd * (tPrev + 0.5 * dt);
    tPrev = t;
    vec3 d = atmoDensity(length(p) - PLANET_R) * dt;
    vec3 att = exp(-atmoExt(od + 0.5 * d)) * sunTrans(p);
    od += d;
    sR += d.x * att;
    sM += d.y * att;
  }
  T = exp(-atmoExt(od));
  vec3 single = sR * BETA_R * pR + sM * BETA_M * pM;
  // cheap multiple scattering: an isotropic share of the single-scattered light
  vec3 ms = (sR * BETA_R + sM * BETA_M) * (0.06 / (4.0 * PI)) * 4.0;
  return uSunI * (single + ms);
}
vec3 atmosphere(vec3 roW, vec3 rd) { vec3 T; return atmosphere(roW, rd, 1e12, T); }
`;

// Aerial perspective for scene materials: exponential height fog lit by the sky in
// the view direction (sampled from a small equirect of the clear atmosphere).
export const AERIAL = /* glsl */`
uniform sampler2D uSkyLut;
uniform vec4 uFog;        // x: density at sea level (1/m), y: height falloff (m), z: extra blue-hour floor, w: sun glow boost
uniform vec3 uFogTint;
vec2 dirToLut(vec3 d) {
  // three's equirect convention
  float u = atan(d.z, d.x) / (2.0 * PI) + 0.5;
  float v = asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5;
  return vec2(u, clamp(v, 0.002, 0.998));
}
vec3 skyLut(vec3 d) { return texture(uSkyLut, dirToLut(d)).rgb; }
// returns vec4(inscatter rgb, transmittance)
vec4 aerial(vec3 camPos, vec3 wp) {
  vec3 v = wp - camPos;
  float dist = length(v);
  vec3 d = v / max(dist, 1e-4);
  float hc = max(camPos.y, -2.0), hp = max(wp.y, -2.0);
  float k = 1.0 / uFog.y;
  float dh = hp - hc;
  float fe = abs(dh) > 0.01 ? (exp(-hc * k) - exp(-hp * k)) / (dh * k) : exp(-hc * k);
  float od = uFog.x * dist * max(fe, 0.0);
  float T = exp(-od);
  vec3 dirH = normalize(vec3(d.x, max(d.y, 0.0) * 0.35 + 0.012, d.z));
  vec3 ins = skyLut(dirH) * uFogTint;
  return vec4(ins * (1.0 - T), T);
}
`;

// Volumetric clouds + high layer + stars. Needs ATMOS.
export const CLOUDS = /* glsl */`
uniform highp sampler3D uNoise;   // r: perlin-worley, g/b/a: worley fbm (3 freqs)
uniform float uCloudCover;
uniform float uCloudBase;
uniform float uCloudThick;
uniform float uCloudDens;
uniform vec2 uWind;               // accumulated wind offset (m)
uniform vec4 uTower[4];           // x, z, radius, height of towering cumulus
uniform float uCirrus;            // high layer amount
uniform float uCirrusAlt;
uniform vec2 uCirrusOffset;
uniform float uStars;
uniform float uCloudSteps;

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

// Towering cumulus adds height + coverage around its centre.
float towerField(vec2 xz, out float extraTop) {
  float cov = 0.0;
  extraTop = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 tw = uTower[i];
    if (tw.w <= 0.0) continue;
    float r = length(xz - tw.xy) / tw.z;
    float f = max(0.0, 1.0 - r * r);
    cov = max(cov, smoothstep(0.0, 0.5, f));
    extraTop = max(extraTop, tw.w * pow(f, 0.6));
  }
  return cov;
}

float cloudDensity(vec3 pw, float alt, bool detail) {
  vec3 p = pw + vec3(uWind.x, 0.0, uWind.y);
  float extraTop;
  float tcov = towerField(pw.xz, extraTop);
  float top = uCloudBase + uCloudThick + extraTop;
  float hf = (alt - uCloudBase) / max(top - uCloudBase, 1.0);
  if (hf < 0.0 || hf > 1.0) return 0.0;
  // coverage: large-scale weather (~20 km), patches of cloud and clear sky
  float wth = texture(uNoise, vec3(p.xz * 0.00005, 0.37)).a;
  float cov = uCloudCover * mix(0.35, 1.7, smoothstep(0.3, 0.75, wth));
  cov = clamp(max(cov, tcov * 0.95), 0.0, 0.95);
  // vertical profile: flat bases, rounded tops
  float prof = smoothstep(0.0, 0.08, hf) * smoothstep(1.0, 0.45 - 0.25 * tcov, hf);
  float base = texture(uNoise, p * vec3(0.00024, 0.00036, 0.00024)).r;
  float d = clamp((base * prof - (1.0 - cov)) / max(cov, 0.05), 0.0, 1.0);
  if (d <= 0.0) return 0.0;
  if (detail) {
    vec4 dn = texture(uNoise, p * 0.0011 + vec3(0.0, -alt * 0.00015, 0.0));
    float det = dn.g * 0.7 + dn.b * 0.3;
    det = mix(1.0 - det, det, smoothstep(0.05, 0.5, hf));   // wispy bottoms, billowy tops
    d = clamp((d - det * 0.35) / 0.65, 0.0, 1.0);
  }
  return d * uCloudDens;
}

float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }

// Returns vec4(scattered radiance, transmittance); tC = transmittance-weighted depth.
vec4 cloudMarch(vec3 roW, vec3 rd, float jitter, out float tC) {
  tC = 0.0;
  vec3 ro = roW + vec3(0.0, PLANET_R, 0.0);
  float maxTop = uCloudThick;
  for (int i = 0; i < 4; i++) maxTop = max(maxTop, uTower[i].w + uCloudThick);
  vec2 iB = raySph(ro, rd, PLANET_R + uCloudBase);
  vec2 iT = raySph(ro, rd, PLANET_R + uCloudBase + maxTop);
  float camAlt = roW.y;
  float t0, t1;
  if (camAlt < uCloudBase) { t0 = iB.y; t1 = iT.y; }
  else { t0 = 0.0; t1 = iT.y; }
  vec2 ig = raySph(ro, rd, PLANET_R);
  if (ig.x > 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  t1 = min(t1, 90000.0);
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  float steps = uCloudSteps;
  float len = t1 - t0;
  float mu = dot(rd, uSunDir);
  // sun light reaching the cloud layer (reddens at sunset)
  vec3 pMid = ro + rd * (t0 + min(len, 8000.0) * 0.3);
  vec3 sunCol = sunTrans(pMid) * uSunI;
  vec3 ambTop = atmosphere(vec3(0.0, uCloudBase + 1500.0, 0.0), vec3(0.0, 1.0, 0.0)) * 2.4 + vec3(0.02, 0.03, 0.05) * uNight;
  vec3 ambBot = ambTop * 0.35 + sunCol * max(uSunDir.y, 0.0) * 0.06 * vec3(0.55, 0.65, 0.75);
  float T = 1.0;
  vec3 S = vec3(0.0);
  float wsum = 0.0;
  // step length grows with distance (constant angular footprint); coarse in empty
  // space, fine inside cloud
  float t = t0;
  float dtC = clamp(t0 * 0.006, 25.0, 260.0);
  t += dtC * jitter * 2.0;
  bool inside = false;
  int miss = 0;
  const float EXT = 0.055;
  for (int i = 0; i < 220; i++) {
    if (float(i) >= steps * 2.4 || t > t1 || T < 0.012) break;
    float dtF = clamp(t * 0.0035, 18.0, 160.0);
    vec3 p = ro + rd * t;
    float alt = length(p) - PLANET_R;
    vec3 pw = roW + rd * t;
    float d = cloudDensity(pw, alt, true);
    if (d > 0.002) {
      if (!inside) { inside = true; t = max(t0, t - dtC * 0.9); miss = 0; continue; }
      miss = 0;
      // light march towards the sun
      float odL = 0.0;
      float sl = 40.0;
      vec3 q = pw;
      for (int j = 0; j < 6; j++) {
        q += uSunDir * sl;
        float qa = length(q + vec3(0.0, PLANET_R, 0.0)) - PLANET_R;
        odL += cloudDensity(q, qa, j < 2) * sl;
        sl *= 1.8;
      }
      float extraTop;
      towerField(pw.xz, extraTop);
      float hf = clamp((alt - uCloudBase) / (uCloudThick + extraTop), 0.0, 1.0);
      // multiple-scattering octaves (Wrenninge)
      vec3 L = vec3(0.0);
      float a = 1.0, b = 1.0, c = 1.0;
      for (int k = 0; k < 4; k++) {
        float ph = mix(hg(mu, 0.8 * c), hg(mu, -0.25 * c), 0.3);
        L += sunCol * (a * ph * exp(-odL * EXT * b));
        a *= 0.55; b *= 0.4; c *= 0.5;
      }
      L *= 3.2;
      float powder = 1.0 - exp(-d * 60.0 * EXT - odL * EXT * 0.4);
      L *= mix(0.5, 1.0, powder);
      L += mix(ambBot, ambTop, smoothstep(0.0, 0.9, hf)) * (0.6 + 0.5 * hf);
      float sig = d * EXT;
      float tr = exp(-sig * dtF);
      S += T * L * (1.0 - tr);
      wsum += T * (1.0 - tr) * t;
      T *= tr;
      t += dtF;
    } else {
      if (inside && ++miss > 3) inside = false;
      t += inside ? dtF : dtC;
      dtC = clamp(t * 0.006, 25.0, 260.0);
    }
  }
  tC = wsum / max(1.0 - T, 1e-4);
  return vec4(S, T);
}

// High, thin layer: mackerel sky / cirrus that catches the sunset.
vec4 highClouds(vec3 roW, vec3 rd) {
  if (uCirrus <= 0.0 || rd.y <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 ro = roW + vec3(0.0, PLANET_R, 0.0);
  float t = raySph(ro, rd, PLANET_R + uCirrusAlt).y;
  if (t <= 0.0 || t > 160000.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 p = roW + rd * t;
  vec2 q = p.xz + uCirrusOffset;
  float n = texture(uNoise, vec3(q * 0.00005, 0.61)).a;
  float cells = texture(uNoise, vec3(q * vec2(0.00032, 0.00022), 0.13)).g;
  float streak = texture(uNoise, vec3(q * vec2(0.00009, 0.0003), 0.83)).r;
  float d = smoothstep(0.52, 0.85, n * 0.55 + cells * 0.45 + streak * 0.25 - 0.1 + uCirrus * 0.25) * uCirrus;
  d *= smoothstep(160000.0, 40000.0, t);
  vec3 pc = ro + rd * t;
  vec3 sc = sunTrans(pc) * uSunI;
  float mu = dot(rd, uSunDir);
  vec3 amb = atmosphere(vec3(0.0, uCirrusAlt, 0.0), vec3(0.0, 1.0, 0.0)) * 2.0;
  vec3 L = sc * (hg(mu, 0.6) * 0.8 + 0.08) + amb * 0.5;
  float a = clamp(d, 0.0, 0.85);
  return vec4(L * a, 1.0 - a);
}

float starField(vec3 d) {
  // stars on a cube-map grid, one candidate per cell; magnitudes follow a steep
  // power law (a few bright stars, many faint ones)
  vec3 a = abs(d);
  vec2 uv; float face;
  if (a.x > a.y && a.x > a.z) { uv = d.zy / a.x; face = sign(d.x); }
  else if (a.y > a.z) { uv = d.xz / a.y; face = 2.0 + sign(d.y); }
  else { uv = d.xy / a.z; face = 4.0 + sign(d.z); }
  float s = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float N = layer == 0 ? 900.0 : layer == 1 ? 420.0 : 160.0;
    float p = layer == 0 ? 0.965 : layer == 1 ? 0.985 : 0.993;
    vec2 g = (uv * 0.5 + 0.5) * N;
    vec2 id = floor(g);
    vec2 f = fract(g);
    float h = hash12(id + face * 131.7 + float(layer) * 17.3);
    if (h > p) {
      vec2 c = hash22(id + face * 7.1 + float(layer) * 3.3) * 0.7 + 0.15;
      float r = length(f - c) * 1400.0 / N;
      float m = pow(hash12(id * 1.37 + 3.1 + float(layer)), 3.0);
      float b = layer == 0 ? 0.25 * m : layer == 1 ? 0.8 * m : 3.0 * (0.3 + m);
      s += b * exp(-r * r * 1.6);
    }
  }
  // a faint Milky Way band (tilted great circle) made of dust-dimmed fbm glow
  vec3 gp = normalize(vec3(0.35, 0.55, -0.76));
  float band = exp(-pow(dot(d, gp) / 0.16, 2.0));
  float n = texture(uNoise, d * 0.9 + 0.3).a * 0.6 + texture(uNoise, d * 2.7).g * 0.4;
  s += band * smoothstep(0.35, 0.8, n) * 0.035;
  return s;
}

// The full sky seen along rd (clouds included). jitter in [0,1) decorrelates steps.
vec3 skyColor(vec3 roW, vec3 rd, float jitter, bool withClouds) {
  vec3 Tsky;
  vec3 sky = atmosphere(roW, rd, 1e12, Tsky);
  // sun disc
  float mu = dot(rd, uSunDir);
  float sunCos = 0.99998;
  float disc = smoothstep(sunCos - 0.000012, sunCos + 0.000004, mu);
  vec3 ro = roW + vec3(0.0, PLANET_R, 0.0);
  if (raySph(ro, rd, PLANET_R).x < 0.0) {
    // limb darkening, bright core that blooms
    sky += disc * Tsky * uSunI * 2600.0;
    // night: stars, a faint airglow
    if (uStars > 0.0) {
      float el = max(rd.y, 0.0);
      sky += starField(rd) * uStars * 0.9 * Tsky * Tsky * smoothstep(0.0, 0.25, el);
      sky += vec3(0.004, 0.007, 0.016) * uNight * (1.0 - 0.6 * el);
    }
  }
  if (!withClouds) return sky;
  vec4 hc = highClouds(roW, rd);
  sky = sky * hc.a + hc.rgb * Tsky;
  float tC;
  vec4 cl = cloudMarch(roW, rd, jitter, tC);
  if (cl.a < 0.999) {
    vec3 Tc;
    vec3 inC = atmosphere(roW, rd, tC, Tc);
    sky = inC + Tc * cl.rgb + cl.a * (sky - inC);
  }
  return sky;
}
`;

// Tileable Perlin-Worley 3D noise, rendered slice by slice into a 3D texture.
export const NOISE3D = /* glsl */`
uniform float uZ;
uniform float uSize;
varying vec2 vUv;
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float worley(vec3 p, float freq) {
  vec3 id = floor(p * freq);
  vec3 fd = fract(p * freq);
  float m = 1e9;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 h = hash33(mod(id + o, vec3(freq)) + 0.5);
    vec3 d = o + h - fd;
    m = min(m, dot(d, d));
  }
  return 1.0 - sqrt(m);
}
vec3 ghash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float gnoise(vec3 x, float freq) {
  vec3 p = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float r = 0.0;
  #define G(o) dot(ghash(mod(p + o, freq)), w - o)
  float a = G(vec3(0,0,0)), b = G(vec3(1,0,0)), c = G(vec3(0,1,0)), d = G(vec3(1,1,0));
  float e = G(vec3(0,0,1)), f = G(vec3(1,0,1)), g = G(vec3(0,1,1)), h = G(vec3(1,1,1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f, u.x), mix(g, h, u.x), u.y), u.z);
}
float perlinFbm(vec3 p, float freq, int oct) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p * freq, freq);
    n += a;
    freq *= 2.0;
    a *= 0.5;
  }
  return s / n;
}
float worleyFbm(vec3 p, float freq) {
  return worley(p, freq) * 0.625 + worley(p, freq * 2.0) * 0.25 + worley(p, freq * 4.0) * 0.125;
}
void main() {
  vec3 p = vec3(vUv, (uZ + 0.5) / uSize);
  float pf = clamp(perlinFbm(p, 4.0, 5) * 1.5 + 0.5, 0.0, 1.0);
  float w4 = worleyFbm(p, 4.0);
  float r = clamp(w4 * 0.8 + pf * 0.35 - 0.12, 0.0, 1.0);
  float g = worleyFbm(p, 8.0);
  float b = worleyFbm(p, 16.0);
  float a = clamp(perlinFbm(p, 2.0, 4) * 2.4 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(r, g, b, a);
}
`;
