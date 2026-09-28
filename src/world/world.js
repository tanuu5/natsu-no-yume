// The world and how a view of it is rendered for one temporal sample.
//
// Per frame (once): the sky pass for each visible segment.
// Per sample: sun + shadows, the scene into a float target with jitter/DOF offsets.
// The engine then composites sky + scene (and dissolves between segments).
import * as THREE from 'three';
import { W, H, SEGMENTS } from '../timeline.js';
import { Rig } from './rig.js';
import { Sky } from './sky.js';
import { Sea } from './sea.js';
import { U, applyEnv } from './env.js';
import { patchChunks } from './materials.js';
import { buildTerrain, terrainMaterial } from './terrain.js';
import { ENVS, WALKS, cameraAt } from './shots.js';
import { sunTrans } from './atmo.js';
import { MODELS, FAMILY, loadModels } from './models/index.js';
import { buildScenery } from './scenery.js';
import { buildHarbor, populateHarbor } from './harbor.js';
import { populateStreets } from './streetlife.js';
import { populatePlants } from './planting.js';
import { buildVillage, buildStreet } from './village.js';
import { groundNatural } from './geo.js';
import { buildPaddies } from './paddies.js';
import { fireflies, birds, furin } from './life.js';
import { EV } from '../timeline.js';
import { buildSeawall, buildCutWall, populateRailway } from './railway.js';
import { materials, NIGHT } from './lib.js';

export class World {
  constructor(E) {
    patchChunks();
    this.E = E;
    this.rig = new Rig(E);
    this.sky = new Sky(this.rig);
    this.sea = new Sea(this.rig);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffffff, 1, 2);  // turns on USE_FOG -> our aerial perspective
    scene.add(this.sea.mesh);
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    // three r186's PCF path adds the bias without flipping it for reversed depth,
    // so with reversed Z a positive bias pushes receivers toward the light
    sun.shadow.bias = this.rig.reversed ? 0.00012 : -0.0002;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 2.0;
    const sc = sun.shadow.camera;
    sc.near = 300; sc.far = 900;
    scene.add(sun, sun.target);
    this.sun = sun;
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(52, W / H, 0.1, 90000);
    this.terrainMat = terrainMaterial();
    this.shots = {};
    // two slots so two segments can dissolve
    this.slots = [0, 1].map(() => ({
      sky: this.rig.target(W, H, { depth: false }), main: this.rig.target(W, H), seg: null,
      refl: this.rig.target(W / 2, H / 2), reflMat: new THREE.Matrix4(),
      refl2: this.rig.target(W / 2, H / 2), reflMat2: new THREE.Matrix4(),
    }));
    this.reflCam = new THREE.PerspectiveCamera(52, W / H, 0.1, 90000);
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.lut = this.rig.target(256, 128, { depth: false });
    this.equi = this.rig.target(1024, 512, { depth: false });
    this.frameT = -1;
    this.skyPasses = +(E.params.get('skypasses') || 4);
    this.skySteps = +(E.params.get('skysteps') || 90);
  }

  async init() {
    await loadModels();
    if (!this.E.params.has('noworld')) {
      this.scene.add(buildScenery(this.terrainMat));
      this.scene.add(buildHarbor());
      this.scene.add(buildStreet());
      this.scene.add(buildSeawall());
      this.scene.add(buildCutWall());
      const t0 = performance.now();
      this.village = buildVillage(MODELS);
      this.scene.add(this.village);
      console.warn(`village: ${this.village.userData.lots.length} lots, ${(performance.now() - t0).toFixed(0)} ms`);
      this.addLife();
      const t1 = performance.now();
      this.harborLife = populateHarbor(MODELS);
      this.scene.add(this.harborLife.group);
      this.railway = populateRailway(MODELS, FAMILY);
      this.scene.add(this.railway.group);
      this.scene.add(populateStreets(MODELS, FAMILY, this.village.userData.lots));
      if (!this.E.params.has('noplants')) this.scene.add(populatePlants(MODELS, FAMILY, { walks: WALKS, lots: this.village.userData.lots }));
      console.warn(`harbour ${this.harborLife.boats.length} boats + railway: ${(performance.now() - t1).toFixed(0)} ms`);
    }
    // model viewer: ?view=model&model=NAME[&yaw=deg&pitch=deg&dist=m&tod=noon&water=1]
    const P = this.E.params;
    if (P.get('view') === 'model') this.setupViewer(P);
  }

  setupViewer(P) {
    const name = P.get('model') || 'swatches';
    const obj = MODELS[name](Object.fromEntries(P.entries()));
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const water = P.get('water') === '1';
    const vs = new THREE.Scene();
    vs.fog = this.scene.fog;
    vs.add(this.sun, this.sun.target);
    if (water) vs.add(this.sea.mesh);
    else {
      const M = materials();
      const g = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), M.concrete);
      const uv = g.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - 0.5) * 400, (uv.getY(i) - 0.5) * 400);
      const col = new Float32Array(uv.count * 3).fill(1);
      g.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.receiveShadow = true;
      vs.add(g);
    }
    vs.add(obj);
    const yaw = (+(P.get('yaw') ?? 35) * Math.PI) / 180, pitch = (+(P.get('pitch') ?? 12) * Math.PI) / 180;
    const dist = +(P.get('dist') || size * 1.1);
    const eye = [center.x + dist * Math.cos(pitch) * Math.sin(yaw), center.y + dist * Math.sin(pitch), center.z + dist * Math.cos(pitch) * Math.cos(yaw)];
    this.viewer = { scene: vs, eye, look: center.toArray(), tod: P.get('tod') || 'noon', radius: size * 0.6, center };
  }

  addLife() {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    // a black kite circling high over the terraces (morning)
    this.kite = birds({
      count: 1, span: 1.6, color: 0x2b2118, seed: 3,
      path: (t) => {
        const a = 2.2 + t * 0.19;
        const c = [292, 58 + 4 * Math.sin(t * 0.2), -172];
        return { pos: V(c[0] + Math.cos(a) * 42, c[1], c[2] + Math.sin(a) * 34), dir: V(-Math.sin(a) * 42, 0.3 * Math.cos(t * 0.2), Math.cos(a) * 34), flap: 0.35 * Math.sin(t * 1.3) - 0.2, bank: 0.32 };
      },
    });
    // gulls wheeling over the harbour (sunset)
    this.gulls = birds({
      count: 6, span: 1.1, color: 0xd8d4cc, seed: 9,
      path: (t, i) => {
        const r = 25 + i * 9, sp = 0.22 + 0.05 * i, a = i * 1.7 + t * sp * (i % 2 ? 1 : -1);
        const c = [10 + i * 8, 12 + i * 3 + 3 * Math.sin(t * 0.5 + i), -45 - i * 8];
        const d = i % 2 ? 1 : -1;
        return { pos: V(c[0] + Math.cos(a) * r, c[1], c[2] + Math.sin(a) * r * 0.7), dir: V(-Math.sin(a) * r * d, 0.2 * Math.cos(t * 0.5 + i), Math.cos(a) * r * 0.7 * d), flap: t * (7 + i) + i, bank: 0.25 * d };
      },
    });
    this.fireflies = fireflies({ center: [335, 38, -228], radius: 75, count: 320 }, (x, z) => Math.max(0, groundNatural(x, z)));
    this.scene.add(this.kite, this.gulls, this.fireflies);
    // a wind chime under the eave of a house on the right of the noon walk
    const lots = this.village.userData.lots.filter((l) => l.street && l.side === 1);
    const lot = lots.reduce((a, b) => (Math.abs(b.x - 226) < Math.abs(a.x - 226) ? b : a));
    const fx = Math.sin(lot.rotY), fz = Math.cos(lot.rotY);
    const hd = Math.min(lot.d - 1.2, 10) / 2;
    const seg = 24;   // noon starts at 24 s; gusts in the walk's local time
    this.furin = furin({ gusts: EV.chimes.map((t) => t - seg) });
    this.furin.position.set(lot.x + fx * (hd + 0.42), lot.padH + 2.32, lot.z + fz * (hd + 0.42));
    this.scene.add(this.furin);
  }

  // Lazily build what a segment needs: terrain around its walk, sky equirects, IBL.
  shot(id) {
    if (this.viewer) id = this.viewer.tod;
    if (this.shots[id]) return this.shots[id];
    const walk = WALKS[id], env = ENVS[id];
    const terrain = this.viewer || this.E.params.has('noterrain') ? new THREE.Group() : buildTerrain({ ...walk.terrain, material: this.terrainMat });
    if (walk.paddyPlane !== undefined && !this.paddies && !this.viewer) {
      const t0 = performance.now();
      this.paddies = buildPaddies(this.terrainMat);
      this.scene.add(this.paddies);
      console.warn(`paddies: levels ${this.paddies.userData.levels}, ${(performance.now() - t0).toFixed(0)} ms`);
    }
    terrain.visible = false;
    this.scene.add(terrain);
    // environment renders at the walk's start
    const cam = cameraAt(walk, 0);
    applyEnv(env, 0);
    this.sky.equiU.uGround.value.setRGB(...env.ground);
    const lut = this.rig.target(256, 128, { depth: false });
    const equi = this.rig.target(1024, 512, { depth: false });
    const camPos = new THREE.Vector3(...cam.p);
    this.rig.begin();
    U.uCloudSteps.value = 48;
    this.sky.renderEquirect(lut, camPos, false);
    this.sky.renderEquirect(equi, camPos, true);
    const envMap = this.sky.envMap(equi);
    this.rig.end();
    const s = { id, walk, env, terrain, lut, equi, envMap };
    this.shots[id] = s;
    return s;
  }

  // Set every uniform / light for segment `id` at local time tl.
  setup(s, tl) {
    applyEnv(s.env, tl);
    U.uTime.value = tl + SEGMENTS.findIndex((g) => g.id === s.id) * 100;
    U.uSkyLut.value = s.lut.texture;
    this.scene.environment = s.envMap;
    this.scene.environmentIntensity = s.env.envI || 1;
    if (this.viewer) { this.viewer.scene.environment = s.envMap; this.viewer.scene.environmentIntensity = s.env.envI || 1; }
    for (const k of Object.keys(this.shots)) this.shots[k].terrain.visible = k === s.id;
    // sun light: colour from the atmosphere's transmittance at the ground
    const sd = U.uSunDir.value;
    const tr = sunTrans(5, sd, s.env.haze);
    this.sun.color.setRGB(tr[0], tr[1], tr[2]);
    this.sun.intensity = s.env.sunI;
    this.sun.visible = sd.y > -0.02;
    this.sun.castShadow = !this.E.params.has('noshadow');
    // creatures of each time of day
    if (this.kite) {
      this.kite.visible = s.id === 'morning';
      this.gulls.visible = s.id === 'sunset' || s.id === 'afternoon';
      this.fireflies.visible = s.id === 'night';
      if (this.kite.visible) this.kite.userData.update(tl);
      if (this.gulls.visible) this.gulls.userData.update(tl);
      this.furin.visible = s.id === 'noon';
      if (this.furin.visible) this.furin.userData.update(tl);
    }
    if (this.harborLife) {
      this.harborLife.update(tl);
      const seg = SEGMENTS.find((g) => g.id === s.id);
      this.railway.update(tl + (seg ? seg.start : 0));
    }
    // dusk lights: lamps and lit windows
    for (const m of NIGHT) m.emissiveIntensity = (s.env.lamps || 0) * m.userData.night * 3.0;
    this.sea.uniforms.uSunColor.value.set(tr[0] * s.env.sunI, tr[1] * s.env.sunI, tr[2] * s.env.sunI);
    this.sea.uniforms.uEnvSky.value = s.equi.texture;
    this.sea.uniforms.uChop.value = s.env.chop ?? 0.6;
  }

  // Place the camera for segment s at local time tl, with sub-pixel/lens offsets.
  // Place the camera for segment s at local time tl. `offset` = sub-pixel window
  // offset (px); `lens` = [u, v] in the unit disk for depth of field (the camera moves
  // on the aperture and the window shifts so the focus plane stays put).
  // Returns the total window offset used (px).
  placeCamera(s, tl, offset = [0, 0], lens = null) {
    const c = cameraAt(s.walk, tl);
    if (this.viewer) { c.p = this.viewer.eye.slice(); c.look = this.viewer.look.slice(); c.fov = 40; c.roll = 0; c.aperture = 0; }
    // debug: ?cam=x,y,z,lx,ly,lz[,fov] overrides the walk
    const dbg = this.E.params.get('cam');
    if (dbg) {
      const v = dbg.split(',').map(Number);
      c.p = v.slice(0, 3); c.look = v.slice(3, 6); c.roll = 0; c.aperture = 0;
      if (v[6]) c.fov = v[6];
    }
    const cam = this.camera;
    cam.fov = c.fov;
    cam.position.set(...c.p);
    cam.up.set(0, 1, 0);
    cam.lookAt(...c.look);
    if (c.roll) cam.rotateZ(c.roll);
    let ox = offset[0], oy = offset[1];
    if (lens && c.aperture > 0) {
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      const lx = lens[0] * c.aperture, ly = lens[1] * c.aperture;
      cam.position.x += e[0] * lx + e[4] * ly;
      cam.position.y += e[1] * lx + e[5] * ly;
      cam.position.z += e[2] * lx + e[6] * ly;
      const fpx = (H / 2) / Math.tan((c.fov * Math.PI) / 360);
      ox += -lx * fpx / c.focus;
      oy += ly * fpx / c.focus;
    }
    if (ox || oy) cam.setViewOffset(W, H, ox, oy, W, H);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.lastOffset = [ox, oy];
    return c;
  }

  // Shadow frustum: a box around the area in front of the camera, snapped to texels.
  fitShadow(cam) {
    const sd = U.uSunDir.value;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const center = cam.position.clone().addScaledVector(fwd, 45);
    const half = 75;
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.updateProjectionMatrix();
    // snap in light space
    const texel = (2 * half) / this.sun.shadow.mapSize.x;
    const lz = sd.clone().negate();
    const lx = new THREE.Vector3(0, 1, 0).cross(lz).normalize();
    const ly = lz.clone().cross(lx);
    const px = Math.round(center.dot(lx) / texel) * texel;
    const py = Math.round(center.dot(ly) / texel) * texel;
    const pz = center.dot(lz);
    const c = lx.multiplyScalar(px).add(ly.multiplyScalar(py)).add(lz.multiplyScalar(pz));
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(sd, 600);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  // Debug: slices of the cloud noise (r, g, b, a) side by side -> slot 0 sky.
  debugNoise() {
    if (!this.dbgMat) {
      this.dbgMat = new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `precision highp float; precision highp sampler3D; varying vec2 vUv; uniform sampler3D uNoise;
        void main(){ float k = floor(vUv.x * 4.0); vec2 uv = vec2(fract(vUv.x * 4.0), vUv.y);
          vec4 n = texture(uNoise, vec3(uv, 0.3)); float v = k < 0.5 ? n.r : k < 1.5 ? n.g : k < 2.5 ? n.b : n.a;
          // histogram strip at the bottom
          vec3 c = vec3(v * v);
          if (vUv.y < 0.08) { float x = fract(vUv.x * 4.0); c = vec3(step(abs(v - x), 0.004)); }
          gl_FragColor = vec4(c, 1.0); }`,
        uniforms: { uNoise: { value: this.sky.noise.texture } }, depthTest: false, depthWrite: false,
      });
    }
    this.rig.begin();
    this.rig.fullscreen(this.dbgMat, this.slots[0].sky);
    this.slots[0].main.texture; // unchanged
    this.rig.r.setRenderTarget(this.slots[0].main);
    this.rig.r.setClearColor(0, 0);
    this.rig.r.clear(true, true, false);
    this.rig.end();
  }

  // Once per frame: sky for each visible segment.
  prepareFrame(frameT, visible) {
    this.frameT = frameT;
    this.rig.begin();
    visible.forEach((v, i) => {
      const slot = this.slots[i];
      const s = this.shot(v.seg.id);
      slot.seg = s;
      const tl = frameT - v.seg.start;
      this.setup(s, tl);
      this.placeCamera(s, tl);
      U.uCloudSteps.value = this.skySteps;
      this.sky.renderScreen(slot.sky, this.camera, this.skyPasses, frameT);
      if (!this.E.params.has('norefl')) {
        this.renderReflection(slot, 0, slot.refl, slot.reflMat);
        if (s.walk.paddyPlane !== undefined && this.paddies) this.renderReflection(slot, s.walk.paddyPlane, slot.refl2, slot.reflMat2);
      }
    });
    this.rig.end();
  }

  // Planar reflection in the plane y = planeY: the mirrored sky, then the scene
  // (clipped below the plane), seen by a camera mirrored through the plane.
  renderReflection(slot, planeY, rt, mat) {
    const cam = this.camera, mc = this.reflCam;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    mc.fov = cam.fov * 1.15;
    mc.aspect = cam.aspect;
    mc.near = cam.near; mc.far = cam.far;
    mc.position.set(cam.position.x, 2 * planeY - cam.position.y, cam.position.z);
    mc.up.set(0, 1, 0);
    mc.lookAt(mc.position.x + dir.x, mc.position.y - dir.y, mc.position.z + dir.z);
    mc.updateProjectionMatrix();
    mc.updateMatrixWorld();
    U.uCloudSteps.value = 50;
    this.sky.renderScreen(rt, mc, 1, 0);
    const r = this.rig.r;
    this.fitShadow(cam);
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    this.shadowSlot = -1;
    this.sea.mesh.visible = false;
    if (this.paddies) this.paddies.children[0].visible = false;
    this.clipPlane.constant = -planeY + 0.02;
    r.clippingPlanes = [this.clipPlane];
    r.setRenderTarget(rt);
    r.clear(false, true, false);
    r.render(this.viewer ? this.viewer.scene : this.scene, mc);
    r.clippingPlanes = [];
    this.sea.mesh.visible = true;
    if (this.paddies) this.paddies.children[0].visible = true;
    // world -> reflection texture uv
    mat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    mat.multiply(mc.projectionMatrix).multiply(mc.matrixWorldInverse);
  }

  // One temporal sample of segment slot i at time t.
  renderSample(i, t, jitter, sampleIndex) {
    const slot = this.slots[i];
    const s = slot.seg;
    const tl = t - SEGMENTS.find((g) => g.id === s.id).start;
    this.rig.begin();
    this.setup(s, tl);
    U.uShadowSeed.value = sampleIndex * 0.618;
    const su = this.sea.uniforms;
    su.uRefl.value = slot.refl.texture;
    su.uReflMat.value.copy(slot.reflMat);
    su.uReflOn.value = this.E.params.has('norefl') ? 0 : 1;
    if (this.paddies) {
      const pu = this.paddies.userData.uniforms;
      pu.uRefl.value = slot.refl2.texture;
      pu.uReflMat.value.copy(slot.reflMat2);
      pu.uReflOn.value = s.walk.paddyPlane !== undefined && !this.E.params.has('norefl') ? 1 : 0;
      pu.uEnvSky.value = s.equi.texture;
      pu.uSunColor.value.copy(su.uSunColor.value);
      this.paddies.visible = s.walk.paddyPlane !== undefined || this.E.params.has('cam');
    }
    // content shifts by +jitter px (matches the engine's 2D layers)
    // aperture sample: Vogel disk, rotated per frame
    const n = 16, gold = 2.399963;
    const k = sampleIndex % n, rr = Math.sqrt((k + 0.5) / n), th = k * gold + this.frameT * 1.3;
    this.placeCamera(s, tl, [-jitter[0], -jitter[1]], [rr * Math.cos(th), rr * Math.sin(th)]);
    // shadow map (and its matrices) only change once per frame per slot
    const newShadow = sampleIndex === 0 || this.shadowSlot !== i;
    if (newShadow) this.fitShadow(this.camera);
    const r = this.rig.r;
    // the sun doesn't move within a frame: draw its shadow map once per frame per slot
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = newShadow;
    this.shadowSlot = i;
    r.setRenderTarget(slot.main);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    const hide = this.E.params.get('hide') || '';
    this.sea.mesh.visible = !hide.includes('sea');
    if (this.viewer) {
      // shadow box around the model
      const sc = this.sun.shadow.camera, R = Math.max(8, this.viewer.radius * 1.4);
      sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.updateProjectionMatrix();
      this.sun.target.position.copy(this.viewer.center);
      this.sun.position.copy(this.viewer.center).addScaledVector(U.uSunDir.value, 300);
      this.sun.target.updateMatrixWorld(); this.sun.updateMatrixWorld();
    }
    r.render(this.viewer ? this.viewer.scene : this.scene, this.camera);
    // sun position on screen for the lens flare (slot 0 only)
    if (i === 0) {
      const sd = U.uSunDir.value;
      const p = this.camera.position.clone().addScaledVector(sd, 1e5).project(this.camera);
      const inFront = this.camera.getWorldDirection(new THREE.Vector3()).dot(sd) > 0.1;
      const strength = (s.env.flare || 0) * (inFront && sd.y > -0.01 ? 1 : 0);
      this.sunScreen = [p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, strength, 1];
      const tr = sunTrans(5, sd, s.env.haze);
      this.sunColor = [tr[0] * s.env.sunI, tr[1] * s.env.sunI, tr[2] * s.env.sunI];
    }
    if (this.E.params.has('info') && sampleIndex === 0) {
      const sh = this.sun.shadow;
      console.warn('shadow', 'reversedState', r.state.buffers.depth.getReversed(), 'camRev', sh.camera.reversedDepth, 'cmp', sh.map && sh.map.depthTexture && sh.map.depthTexture.compareFunction, 'bias', sh.bias, 'proj', sh.camera.projectionMatrix.elements.map((v) => v.toFixed(4)).join(','));
      const tv = s.terrain.children.map((m) => m.visible + ':' + m.geometry.index.count / 3).join(' ');
      console.warn('info', JSON.stringify(r.info.render), 'cam', this.camera.position.toArray().map((v) => v.toFixed(1)).join(','), 'terrainVisible', s.terrain.visible, tv, 'reversed', this.rig.reversed);
    }
    this.rig.end();
  }
}
