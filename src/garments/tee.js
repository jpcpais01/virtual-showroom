import * as THREE from 'three';
import { Cloth } from './cloth.js';
import { clothPool } from './clothPool.js';
import { buildTeePattern, FRONT, BACK } from './teeMesh.js';

const BASE = import.meta.env.BASE_URL;
const FABRIC_GSM = 0.24; // kg/m^2, heavyweight cotton jersey

let sharedPattern = null;
let sharedTextures = null;

function loadTextures(renderer) {
  if (sharedTextures) return sharedTextures;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const albedo = loader.load(BASE + 'textures/tee_albedo.jpg');
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = aniso;
  const aux = loader.load(BASE + 'textures/tee_aux.png');
  aux.anisotropy = aniso;
  const knit = loader.load(BASE + 'textures/knit_normal.png');
  knit.wrapS = knit.wrapT = THREE.RepeatWrapping;
  knit.anisotropy = aniso;
  const label = loader.load(BASE + 'textures/neck_label.jpg');
  label.colorSpace = THREE.SRGBColorSpace;
  label.anisotropy = aniso;
  sharedTextures = { albedo, aux, knit, label };
  return sharedTextures;
}

function makeFabricMaterial(tex, { inside = false } = {}) {
  const W = sharedPattern.pattern.window;
  // knit tile ~8 mm; atlas half covers (x1-x0) metres
  const knit = tex.knit;
  knit.repeat.set(((W.x1 - W.x0) * 2) / 0.008, (W.y1 - W.y0) / 0.008);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: tex.albedo,
    roughness: 1.0,
    roughnessMap: tex.aux,
    bumpMap: tex.aux,
    bumpScale: 1.2,
    normalMap: knit,
    normalScale: new THREE.Vector2(0.35, 0.35),
    sheen: 1.0,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0xd8dae6),
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
  });
  if (inside) return mat;
  // The inside of the shirt is plain cotton: no print, slightly shaded.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.93, 0.925, 0.91);`,
    );
  };
  return mat;
}

/**
 * A simulated KHORA tee hanging on a hanger. World-space simulation.
 */
export class Tee {
  /** static world colliders (walls, furniture) shared by every garment */
  static environment = [];

  constructor({ renderer, hangerMatrix, name = 'tee', quality = 1, worn = null }) {
    if (!sharedPattern) sharedPattern = buildTeePattern(0.024);
    const pat = sharedPattern;
    this.pat = pat;
    this.name = name;
    this.tex = loadTextures(renderer);
    this.group = new THREE.Group();
    this.group.name = name;
    this.hangerMatrix = hangerMatrix.clone();
    this.state = 'hanging'; // hanging | lifting | held | returning
    this.sleepTimer = 0;
    this.asleep = false;
    this.quality = quality;

    const n = pat.verts.length;
    // ---- distance to nearest seam: used to inflate the initial shape ----
    const seamPts = pat.verts.filter((v) => v.panel === -1);
    const init = new Float32Array(n * 3);
    const rest = new Float32Array(n * 3);
    const local = new THREE.Vector3();
    pat.verts.forEach((v, i) => {
      let d = Infinity;
      if (v.panel !== -1) for (const s of seamPts) d = Math.min(d, Math.hypot(s.x - v.x, s.y - v.y));
      else d = 0;
      // hanging: nearly flat; worn: opened up around the body
      const wgt = Math.min(1, d / (worn ? 0.09 : 0.07));
      const depth = worn ? worn.depth : 0.03;
      const z = v.panel === FRONT ? depth * wgt : v.panel === BACK ? -depth * wgt : 0;
      local.set(v.x, v.y, z).applyMatrix4(this.hangerMatrix);
      init.set([local.x, local.y, local.z], 3 * i);
      rest.set([v.x, v.y, z], 3 * i);
    });

    // ---- triangles, masses, constraints ----
    const triList = [];
    const triPanel = [];
    for (const p of pat.panels) {
      for (let k = 0; k < p.tris.length; k += 3) {
        triList.push(p.tris[k], p.tris[k + 1], p.tris[k + 2]);
        triPanel.push(p.panel);
      }
    }
    const tris = new Uint32Array(triList);
    const mass = new Float32Array(n);
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map((i) => pat.verts[i]);
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
      for (let k = 0; k < 3; k++) mass[tris[t + k]] += (area * FABRIC_GSM) / 3;
    }
    for (let i = 0; i < n; i++) if (mass[i] === 0) mass[i] = 1e-4;

    const edgeKey = (a, b) => (a < b ? a * 100000 + b : b * 100000 + a);
    const edgeTris = new Map();
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tris[t + e];
        const b = tris[t + ((e + 1) % 3)];
        const c = tris[t + ((e + 2) % 3)];
        const key = edgeKey(a, b);
        if (!edgeTris.has(key)) edgeTris.set(key, { a, b, opp: [] });
        edgeTris.get(key).opp.push({ c, panel: triPanel[t / 3] });
      }
    }
    const d2 = (i, j) => Math.hypot(pat.verts[i].x - pat.verts[j].x, pat.verts[i].y - pat.verts[j].y);
    const d3 = (i, j) =>
      Math.hypot(init[3 * i] - init[3 * j], init[3 * i + 1] - init[3 * j + 1], init[3 * i + 2] - init[3 * j + 2]);
    const stretch = [];
    const bend = [];
    for (const e of edgeTris.values()) {
      stretch.push(e.a, e.b, d2(e.a, e.b));
      if (e.opp.length === 2) {
        const [o1, o2] = e.opp;
        const flat = o1.panel === o2.panel;
        bend.push(o1.c, o2.c, flat ? d2(o1.c, o2.c) : d3(o1.c, o2.c));
      }
    }
    this.edges = edgeTris;
    this.cloth = new Cloth({
      pos: init,
      restPos: rest,
      mass,
      tris,
      stretch: new Float32Array(stretch),
      bend: new Float32Array(bend),
    });
    this.cloth.substeps = quality > 0.7 ? 10 : 7;

    this._buildRenderMesh(tris, triPanel);
    this._buildRims();
    this._buildLabel();
    this.worn = !!worn;
    let warm = null;
    this.pinTargets = new Map(); // id -> {target, from, t}
    this.hangerLocal = new Map();
    if (worn) {
      this.cloth.colliders = worn.colliders();
      this.cloth.colliderFriction = 0.6;
      this.alwaysAwake = true;
      this.state = 'worn';
      // the body poses while the shirt settles; the worker replays the
      // collider frames so the page never blocks on it
      const frames = [];
      for (let i = 0; i < 160; i++) {
        if (worn.beforeStep) worn.beforeStep(i);
        frames.push(worn.colliders());
      }
      this.cloth.colliders = frames[0];
      warm = { steps: 160, colliders: frames };
    } else {
      this._buildHanger();
      for (const id of pat.hangerIds) {
        const v = pat.verts[id];
        this.hangerLocal.set(id, new THREE.Vector3(v.x, v.y + 0.006, 0));
      }
      this._pinToHanger(true);
      this.cloth.colliders = [...Tee.environment, ...this.hangerColliders];
      // settle into a natural drape (in the worker) before it is shown
      warm = { steps: 90 };
    }
    this.ke = 1;
    this.dirty = true;
    // hidden until the first solved drape arrives
    this.ready = new Promise((res) => (this._readyRes = res));
    this.isReady = false;
    this.group.visible = false;
    this.poolId = clothPool.add(this.cloth, (r) => this._onResult(r), warm);
  }

  _onResult(r) {
    const c = this.cloth;
    if (r.pos) {
      // take the solved state, except particles the main thread is driving
      const w = c.invMass;
      for (let i = 0; i < c.n; i++) {
        if (w[i] === 0) continue;
        const k = 3 * i;
        c.pos[k] = r.pos[k];
        c.pos[k + 1] = r.pos[k + 1];
        c.pos[k + 2] = r.pos[k + 2];
      }
      c.normals.set(r.nrm);
    }
    this.ke = r.ke;
    this.dirty = true;
    if (!this.isReady) {
      this.isReady = true;
      this.group.visible = true;
      if (!r.pos) c.computeNormals();
      this._writeRenderMesh();
      this._writeRims();
      this._writeLabel();
      this.dirty = false;
      this._readyRes();
    }
  }

  // ------------------------------------------------------------ render mesh
  _buildRenderMesh(tris, triPanel) {
    const pat = this.pat;
    const W = pat.pattern.window;
    const uvOf = (i, panel) => {
      const { x, y } = pat.verts[i];
      const u = panel === BACK ? 0.5 + ((W.x1 - x) / (W.x1 - W.x0)) * 0.5 : ((x - W.x0) / (W.x1 - W.x0)) * 0.5;
      return [u, (y - W.y0) / (W.y1 - W.y0)];
    };
    // The render mesh is much denser than the simulation mesh: every sim
    // triangle is split into SUB x SUB triangles evaluated on a Phong-
    // tessellated curved surface, so folds and silhouettes stay smooth while
    // physics runs on the coarser mesh. Points on a shared edge depend only on
    // that edge, so neighbouring triangles always meet without cracks.
    const SUB = this.quality > 0.7 ? 3 : 2;
    const keyMap = new Map();
    const A = [], B = [], C = [], WA = [], WB = [], WC = [];
    const uvs = [];
    const vert = (key, a, b, c, u, v, w, panel) => {
      let id = keyMap.get(key);
      if (id !== undefined) return id;
      id = A.length;
      keyMap.set(key, id);
      A.push(a); B.push(b); C.push(c); WA.push(u); WB.push(v); WC.push(w);
      const ua = uvOf(a, panel), ub = uvOf(b, panel), uc = uvOf(c, panel);
      uvs.push(u * ua[0] + v * ub[0] + w * uc[0], u * ua[1] + v * ub[1] + w * uc[1]);
      return id;
    };
    const point = (a, b, c, i, j, panel, t) => {
      const N = SUB;
      const v = i / N, w = j / N, u = 1 - v - w;
      // corners
      if (u === 1) return vert(`v${a}_${panel}`, a, a, a, 1, 0, 0, panel);
      if (v === 1) return vert(`v${b}_${panel}`, b, b, b, 1, 0, 0, panel);
      if (w === 1) return vert(`v${c}_${panel}`, c, c, c, 1, 0, 0, panel);
      // edges: key by the edge's lower index so both triangles agree
      const edge = (p, q, tq) => {
        const lo = Math.min(p, q), hi = Math.max(p, q);
        const k = Math.round((p === lo ? tq : 1 - tq) * N); // steps from lo
        return vert(`e${lo}_${hi}_${k}_${panel}`, lo, hi, hi, 1 - k / N, k / N, 0, panel);
      };
      if (w === 0) return edge(a, b, v);
      if (v === 0) return edge(a, c, w);
      if (u < 1e-9) return edge(b, c, w);
      return vert(`t${t}_${i}_${j}`, a, b, c, u, v, w, panel);
    };
    const index = [];
    const faceSim = [];
    for (let t = 0; t < tris.length; t += 3) {
      const p = triPanel[t / 3];
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const g = [];
      for (let i = 0; i <= SUB; i++) {
        g[i] = [];
        for (let j = 0; j <= SUB - i; j++) g[i][j] = point(a, b, c, i, j, p, t);
      }
      for (let i = 0; i < SUB; i++) {
        for (let j = 0; j < SUB - i; j++) {
          index.push(g[i][j], g[i + 1][j], g[i][j + 1]);
          faceSim.push(t / 3);
          if (i + j < SUB - 1) {
            index.push(g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]);
            faceSim.push(t / 3);
          }
        }
      }
    }
    this.simTris = tris;
    this.faceSim = new Uint32Array(faceSim);
    this.rA = new Uint32Array(A); this.rB = new Uint32Array(B); this.rC = new Uint32Array(C);
    this.wA = new Float32Array(WA); this.wB = new Float32Array(WB); this.wC = new Float32Array(WC);
    const n = A.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    this.geometry = geo;
    this.material = makeFabricMaterial(this.tex);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.tee = this;
    this.group.add(this.mesh);
  }

  _buildRims() {
    // Rolled edges: a thin tube along each opening so the fabric reads as
    // having real thickness (rib collar is the thickest).
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xefeee9,
      roughness: 0.92,
      sheen: 1,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0xd8dae6),
    });
    this.rims = [];
    const spec = [
      ['neck', 0.0042, 8],
      ['cuffR', 0.0022, 6],
      ['cuffL', 0.0022, 6],
      ['hem', 0.0022, 6],
    ];
    for (const [name, r, seg] of spec) {
      const loop = this.pat.loops[name];
      const n = loop.length;
      const pos = new Float32Array(n * seg * 3);
      const nrm = new Float32Array(n * seg * 3);
      const idx = [];
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n;
        for (let s = 0; s < seg; s++) {
          const s2 = (s + 1) % seg;
          const a = i * seg + s, b = i2 * seg + s, c = i2 * seg + s2, d = i * seg + s2;
          idx.push(a, c, b, a, d, c);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.tee = this;
      this.group.add(mesh);
      this.rims.push({ loop, r, seg, geo, mesh });
    }
  }

  _buildLabel() {
    const geo = new THREE.PlaneGeometry(0.05, 0.0227);
    const mat = new THREE.MeshStandardMaterial({ map: this.tex.label, roughness: 0.55, side: THREE.DoubleSide });
    this.label = new THREE.Mesh(geo, mat);
    this.label.matrixAutoUpdate = false;
    this.group.add(this.label);
  }

  _buildHanger() {
    // Brushed-chrome wire hanger with a matte black body, shaped to the shoulder line.
    const g = new THREE.Group();
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde6, metalness: 1, roughness: 0.18 });
    const body = new THREE.MeshStandardMaterial({ color: 0x0b0b0e, metalness: 0.2, roughness: 0.45 });
    const P = this.pat.pattern;
    const pts = [];
    const span = 0.2;
    for (let i = -20; i <= 20; i++) {
      const x = (i / 20) * span;
      const ax = Math.abs(x);
      // follow shoulder slope beyond the neck point
      const y = ax < P.N[0] ? 0.012 - (ax / P.N[0]) * 0.012 : -((ax - P.N[0]) / (P.S[0] - P.N[0])) * -P.S[1];
      pts.push(new THREE.Vector3(x, y - 0.012, 0));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    // the cloth wraps over the hanger arm: capsule colliders along it
    this.hangerColliders = [];
    for (let i = 0; i < pts.length - 1; i += 5) {
      const a = pts[i].clone().applyMatrix4(this.hangerMatrix);
      const b = pts[Math.min(i + 5, pts.length - 1)].clone().applyMatrix4(this.hangerMatrix);
      this.hangerColliders.push({ type: 'capsule', a: a.toArray(), b: b.toArray(), r: 0.024 });
    }
    this.cloth.colliders = [...Tee.environment, ...this.hangerColliders];
    const arm = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.009, 12, false), body);
    arm.castShadow = true;
    g.add(arm);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.009, 16, 12), body);
      cap.position.copy(pts[s < 0 ? 0 : pts.length - 1]);
      g.add(cap);
    }
    const hook = new THREE.CurvePath();
    const hookPts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0.07, 0),
      new THREE.Vector3(0, 0.1, 0.0),
      new THREE.Vector3(0, 0.125, -0.02),
      new THREE.Vector3(0, 0.11, -0.04),
      new THREE.Vector3(0, 0.09, -0.035),
    ];
    hook.add(new THREE.CatmullRomCurve3(hookPts));
    const hookMesh = new THREE.Mesh(new THREE.TubeGeometry(hook.curves[0], 40, 0.0028, 8, false), chrome);
    hookMesh.castShadow = true;
    g.add(hookMesh);
    g.matrixAutoUpdate = false;
    g.matrix.copy(this.hangerMatrix);
    this.hanger = g;
    this.group.add(g);
  }

  // ------------------------------------------------------------ pinning
  _pinToHanger(immediate) {
    const cloth = this.cloth;
    for (const [id, lp] of this.hangerLocal) {
      const target = lp.clone().applyMatrix4(this.hangerMatrix);
      if (immediate) {
        cloth.pin(id, target.x, target.y, target.z);
      } else {
        const p = cloth.pos;
        this.pinTargets.set(id, {
          from: new THREE.Vector3(p[3 * id], p[3 * id + 1], p[3 * id + 2]),
          target,
          t: 0,
          dur: 0.45,
        });
        cloth.invMass[id] = 0;
      }
    }
  }

  releaseFromHanger() {
    for (const id of this.hangerLocal.keys()) {
      if (!this.pat.holdIds.includes(id)) this.cloth.unpin(id);
      this.pinTargets.delete(id);
    }
  }

  /** Pick up: the two dropped-shoulder points are pinched and carried to `targets`. */
  hold(left, right) {
    this.wake();
    if (this.state === 'hanging' || this.state === 'returning') {
      this.releaseFromHanger();
      this.cloth.colliders = [...Tee.environment];
      this.state = 'held';
    }
    const [ia, ib] = this.pat.holdIds;
    // holdIds[0] is +x (wearer's left / viewer's right when facing front)
    this._setHold(ia, right);
    this._setHold(ib, left);
  }

  _setHold(id, target) {
    const c = this.cloth;
    c.invMass[id] = 0;
    const cur = new THREE.Vector3(c.pos[3 * id], c.pos[3 * id + 1], c.pos[3 * id + 2]);
    // ease towards the hand position with a speed limit, so the fabric trails
    // naturally and the solver never sees a teleport
    const d = target.clone().sub(cur).multiplyScalar(0.18);
    const maxStep = 1.4 / 60;
    if (d.length() > maxStep) d.setLength(maxStep);
    cur.add(d);
    c.pos[3 * id] = cur.x;
    c.pos[3 * id + 1] = cur.y;
    c.pos[3 * id + 2] = cur.z;
  }

  holdPoint(k) {
    const id = this.pat.holdIds[k];
    const p = this.cloth.pos;
    return new THREE.Vector3(p[3 * id], p[3 * id + 1], p[3 * id + 2]);
  }

  returnToHanger() {
    this.wake();
    this.state = 'returning';
    this.cloth.colliders = [...Tee.environment, ...this.hangerColliders];
    for (const id of this.pat.holdIds) this.cloth.unpin(id);
    this._pinToHanger(false);
  }

  wake() {
    this.asleep = false;
    this.sleepTimer = 0;
    this.ke = 1;
  }

  // ------------------------------------------------------------ grabbing
  grab(id, point) {
    this.wake();
    this.grabbed = { id, wasMass: this.cloth.invMass[id] };
    this.cloth.invMass[id] = 0;
    this.drag(point);
  }
  drag(point) {
    if (!this.grabbed) return;
    const { id } = this.grabbed;
    const c = this.cloth;
    const cur = new THREE.Vector3(c.pos[3 * id], c.pos[3 * id + 1], c.pos[3 * id + 2]);
    // follow the mouse closely; the cap only stops teleports that would
    // tear through the solver
    const d = point.clone().sub(cur).multiplyScalar(0.7);
    if (d.length() > 0.06) d.setLength(0.06);
    cur.add(d);
    c.pos[3 * id] = cur.x;
    c.pos[3 * id + 1] = cur.y;
    c.pos[3 * id + 2] = cur.z;
  }
  release() {
    if (!this.grabbed) return;
    const { id, wasMass } = this.grabbed;
    const stillPinned = this.pinTargets.has(id) || (this.state !== 'held' && this.hangerLocal.has(id)) ||
      (this.state === 'held' && this.pat.holdIds.includes(id));
    if (!stillPinned) this.cloth.invMass[id] = wasMass || this.cloth.baseInvMass[id];
    this.grabbed = null;
  }

  /** nearest sim particle to a raycast hit on the render mesh */
  particleFromHit(hit) {
    const t = this.faceSim[hit.faceIndex] * 3;
    const p = this.cloth.pos;
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < 3; k++) {
      const id = this.simTris[t + k];
      const d = hit.point.distanceToSquared(new THREE.Vector3(p[3 * id], p[3 * id + 1], p[3 * id + 2]));
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ per frame
  update(dt, { wind, paused = false } = {}) {
    const c = this.cloth;
    // animate pins sliding back onto the hanger
    if (this.pinTargets.size) {
      for (const [id, pt] of this.pinTargets) {
        pt.t = Math.min(1, pt.t + dt / pt.dur);
        const e = pt.t * pt.t * (3 - 2 * pt.t);
        const v = pt.from.clone().lerp(pt.target, e);
        c.pos[3 * id] = v.x;
        c.pos[3 * id + 1] = v.y;
        c.pos[3 * id + 2] = v.z;
        if (pt.t >= 1) this.pinTargets.delete(id);
      }
      if (!this.pinTargets.size && this.state === 'returning') this.state = 'hanging';
    }
    if (wind) c.wind = wind;
    if (dt > 0 && !this.asleep && !paused && this.isReady) {
      clothPool.request(this.poolId, dt);
      // sleep when settled on the hanger to save CPU
      // a garment left alone on its hanger comes to rest (real fabric has
      // internal friction), then sleeps
      this.idleT = this.state === 'hanging' && !this.grabbed ? (this.idleT || 0) + dt : 0;
      c.damping = this.idleT > 1.2 && !this.alwaysAwake ? 3.5 : 0.6;
      if (this.state === 'hanging' && !this.grabbed && !this.alwaysAwake) {
        if (this.ke < 2e-4) this.sleepTimer += dt;
        else this.sleepTimer = 0;
        if (this.sleepTimer > 1.0) this.asleep = true;
      }
    }
    if (dt === 0) {
      c.computeNormals();
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this._writeRenderMesh();
    this._writeRims();
    this._writeLabel();
  }

  _writeRenderMesh() {
    const pos = this.geometry.attributes.position.array;
    const nrm = this.geometry.attributes.normal.array;
    const P = this.cloth.pos;
    const Nn = this.cloth.normals;
    const RA = this.rA, RB = this.rB, RC = this.rC, WA = this.wA, WB = this.wB, WC = this.wC;
    const alpha = 0.65; // Phong tessellation shape factor
    for (let r = 0, n = RA.length; r < n; r++) {
      const a = 3 * RA[r], b = 3 * RB[r], c = 3 * RC[r];
      const u = WA[r], v = WB[r], w = WC[r];
      const k = 3 * r;
      const px = u * P[a] + v * P[b] + w * P[c];
      const py = u * P[a + 1] + v * P[b + 1] + w * P[c + 1];
      const pz = u * P[a + 2] + v * P[b + 2] + w * P[c + 2];
      // distance of the flat point to each corner's tangent plane
      const da = (px - P[a]) * Nn[a] + (py - P[a + 1]) * Nn[a + 1] + (pz - P[a + 2]) * Nn[a + 2];
      const db = (px - P[b]) * Nn[b] + (py - P[b + 1]) * Nn[b + 1] + (pz - P[b + 2]) * Nn[b + 2];
      const dc = (px - P[c]) * Nn[c] + (py - P[c + 1]) * Nn[c + 1] + (pz - P[c + 2]) * Nn[c + 2];
      pos[k] = px - alpha * (u * da * Nn[a] + v * db * Nn[b] + w * dc * Nn[c]);
      pos[k + 1] = py - alpha * (u * da * Nn[a + 1] + v * db * Nn[b + 1] + w * dc * Nn[c + 1]);
      pos[k + 2] = pz - alpha * (u * da * Nn[a + 2] + v * db * Nn[b + 2] + w * dc * Nn[c + 2]);
      const nx = u * Nn[a] + v * Nn[b] + w * Nn[c];
      const ny = u * Nn[a + 1] + v * Nn[b + 1] + w * Nn[c + 1];
      const nz = u * Nn[a + 2] + v * Nn[b + 2] + w * Nn[c + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nrm[k] = nx / l;
      nrm[k + 1] = ny / l;
      nrm[k + 2] = nz / l;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  _writeRims() {
    const P = this.cloth.pos;
    const Nn = this.cloth.normals;
    const t = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3();
    for (const rim of this.rims) {
      const { loop, r, seg, geo } = rim;
      const pos = geo.attributes.position.array;
      const nrm = geo.attributes.normal.array;
      const L = loop.length;
      for (let i = 0; i < L; i++) {
        const p = 3 * loop[i];
        const pn = 3 * loop[(i + 1) % L];
        const pp = 3 * loop[(i - 1 + L) % L];
        t.set(P[pn] - P[pp], P[pn + 1] - P[pp + 1], P[pn + 2] - P[pp + 2]).normalize();
        n.set(Nn[p], Nn[p + 1], Nn[p + 2]);
        b.crossVectors(t, n).normalize();
        n.crossVectors(b, t).normalize();
        for (let s = 0; s < seg; s++) {
          const ang = (s / seg) * Math.PI * 2;
          const cx = Math.cos(ang), sy = Math.sin(ang);
          const ox = n.x * cx + b.x * sy, oy = n.y * cx + b.y * sy, oz = n.z * cx + b.z * sy;
          const k = 3 * (i * seg + s);
          pos[k] = P[p] + ox * r;
          pos[k + 1] = P[p + 1] + oy * r;
          pos[k + 2] = P[p + 2] + oz * r;
          nrm[k] = ox; nrm[k + 1] = oy; nrm[k + 2] = oz;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.normal.needsUpdate = true;
    }
  }

  _writeLabel() {
    const P = this.cloth.pos;
    const Nn = this.cloth.normals;
    const at = (i) => new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
    const c = at(this.pat.labelAnchor);
    const up = at(this.pat.labelAnchorUp).sub(c).normalize();
    // back panel normal points away from the body; the label sits inside
    const nb = new THREE.Vector3(Nn[3 * this.pat.labelAnchor], Nn[3 * this.pat.labelAnchor + 1], Nn[3 * this.pat.labelAnchor + 2]);
    const inward = nb.clone().negate();
    const side = new THREE.Vector3().crossVectors(up, inward).normalize();
    const upO = new THREE.Vector3().crossVectors(inward, side).normalize();
    const m = new THREE.Matrix4().makeBasis(side, upO, inward);
    m.setPosition(c.clone().addScaledVector(inward, 0.0035).addScaledVector(upO, 0.006));
    this.label.matrix.copy(m);
  }
}
