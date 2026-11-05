import * as THREE from 'three';
import { Cloth } from './cloth.js';
import { clothPool } from './clothPool.js';
import { buildTeePattern, FRONT, BACK } from './teeMesh.js';
import { buildSocksPattern } from './socksMesh.js';

const BASE = import.meta.env.BASE_URL;

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

let socksPattern = null;
let socksTextures = null;
function loadSocksTextures(renderer) {
  if (socksTextures) return socksTextures;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const albedo = loader.load(BASE + 'textures/sock_albedo.jpg');
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = aniso;
  const rib = loader.load(BASE + 'textures/sock_rib.png');
  rib.wrapS = rib.wrapT = THREE.RepeatWrapping;
  rib.anisotropy = aniso;
  socksTextures = { albedo, rib };
  return socksTextures;
}

function makeSocksMaterial(tex, pat) {
  const W = pat.pattern.window;
  // 4 wales per tile, 2.4 mm each
  tex.rib.repeat.set(((W.x1 - W.x0) * 2) / 0.0096, (W.y1 - W.y0) / 0.0096);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: tex.albedo,
    roughness: 0.92,
    normalMap: tex.rib,
    normalScale: new THREE.Vector2(0.7, 0.7),
    specularIntensity: 0.18,
    envMapIntensity: 0.3,
    sheen: 1.0,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0x3a3d48),
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.012, 0.011, 0.011);`,
      )
      .replace(
        'mapN.xy *= normalScale;',
        `vec2 knitW = fwidth(vNormalMapUv);
         float knitFade = 1.0 - smoothstep(0.18, 0.45, max(knitW.x, knitW.y));
         mapN.xy *= normalScale * knitFade;`,
      );
  };
  return mat;
}

// What differs between garment types. Everything else (cloth, carrying,
// grabbing, rendering) is shared.
const KINDS = {
  tee: {
    pattern: () => (sharedPattern ||= buildTeePattern(0.028)),
    textures: (r) => loadTextures(r),
    material: (tex) => makeFabricMaterial(tex),
    gsm: 0.24, // kg/m^2, heavyweight cotton jersey
    depth: 0.03,
    label: true,
    rims: [['neck', 0.0042, 8], ['cuffR', 0.0022, 6], ['cuffL', 0.0022, 6], ['hem', 0.0022, 6]],
    rimColor: 0xefeee9,
    rimSheen: 0xd8dae6,
    pinLift: 0.003,
    hangClear: 0.017,
    warm: 180,
  },
  socks: {
    pattern: () => (socksPattern ||= buildSocksPattern(0.014)),
    textures: (r) => loadSocksTextures(r),
    material: (tex, pat) => makeSocksMaterial(tex, pat),
    gsm: 0.42, // cushioned cotton knit
    depth: 0.009,
    label: false,
    rims: [['cuff0', 0.0028, 6], ['cuff1', 0.0028, 6]],
    rimColor: 0x141416,
    rimSheen: 0x3a3d48,
    pinLift: 0,
    warm: 150,
    cloth: { thickness: 0.007, bendCompliance: 0.006, selfRestMin: 0.035, dragCoeff: 0.8 },
  },
};

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
    bumpScale: 0.7,
    normalMap: knit,
    normalScale: new THREE.Vector2(0.4, 0.4),
    // cotton jersey is matte: very little specular, soft sheen at grazing angles
    specularIntensity: 0.22,
    envMapIntensity: 0.35,
    sheen: 1.0,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0xd8dae6),
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
  });
  if (inside) return mat;
  // The inside of the shirt is plain cotton: no print, slightly shaded.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.93, 0.925, 0.91);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = max(roughnessFactor, 0.8);`,
      )
      // the knit is only visible up close: fade it out once a stitch gets
      // smaller than a pixel, otherwise it aliases into stripes (moire)
      .replace(
        'mapN.xy *= normalScale;',
        `vec2 knitW = fwidth(vNormalMapUv);
         float knitFade = 1.0 - smoothstep(0.18, 0.45, max(knitW.x, knitW.y));
         mapN.xy *= normalScale * knitFade;`,
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

  constructor({ renderer, hangerMatrix, name = 'tee', quality = 1, worn = null, kind = 'tee', product = null }) {
    const K = KINDS[kind];
    this.kind = kind;
    this.K = K;
    this.product = product;
    const pat = K.pattern();
    this.pat = pat;
    this.name = name;
    this.tex = K.textures(renderer);
    this.group = new THREE.Group();
    this.group.name = name;
    // the fabric (mesh, rolled edges, label); its matrix carries the solved
    // shape to the hanger's current pose
    this.clothRoot = new THREE.Group();
    this.clothRoot.matrixAutoUpdate = false;
    this.group.add(this.clothRoot);
    this.hangerMatrix = hangerMatrix.clone();
    this.state = 'hanging'; // hanging | lifting | held | returning
    this.sleepTimer = 0;
    this.asleep = false;
    this.quality = quality;

    const n = pat.verts.length;
    // ---- distance to nearest seam: used to inflate the initial shape ----
    const seamPts = pat.verts.filter((v) => v.panel === -1);
    const UX = (v) => v.ux ?? v.x;
    const UY = (v) => v.uy ?? v.y;
    const init = new Float32Array(n * 3);
    const rest = new Float32Array(n * 3);
    const local = new THREE.Vector3();
    pat.verts.forEach((v, i) => {
      let d = Infinity;
      if (v.panel !== -1) {
        for (const s of seamPts) if (s.sock === v.sock) d = Math.min(d, Math.hypot(UX(s) - UX(v), UY(s) - UY(v)));
      } else d = 0;
      // hanging: nearly flat; worn: opened up around the body
      const wgt = Math.min(1, d / (worn ? 0.09 : 0.07));
      const depth = worn ? worn.depth : K.depth;
      // start each layer on its own side of the hanger arm, clear of it, so
      // nothing begins inside the hanger and gets pushed out the wrong side
      const open = worn ? depth * wgt : Math.max(depth * wgt, K.hangClear || 0);
      const z = (v.z0 || 0) + (v.panel === FRONT ? open : v.panel === BACK ? -open : 0);
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
      for (let k = 0; k < 3; k++) mass[tris[t + k]] += (area * K.gsm) / 3;
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
    // (rest lengths come from the flat layout; the area above uses it too)
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
    this.cloth.substeps = quality > 0.7 ? 8 : 6;
    if (K.cloth) Object.assign(this.cloth, K.cloth);

    this._buildRenderMesh(tris, triPanel);
    this._buildRims();
    if (K.label) this._buildLabel();
    this.worn = !!worn;
    let warm = null;
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
        if (K.pinSpan && Math.abs(v.x) > K.pinSpan) continue;
        // the clip/hanger pinches both layers together at its line
        this.hangerLocal.set(id, new THREE.Vector3(v.x, v.y + K.pinLift, v.z0 || 0));
      }
      this._pinToHanger(true);
      this._buildTethers(K.tetherSlack || 1.03);
      this.cloth.colliders = [...Tee.environment, ...this.hangerColliders];
      this.restPos = new THREE.Vector3();
      this.restQuat = new THREE.Quaternion();
      this.hangerMatrix.decompose(this.restPos, this.restQuat, new THREE.Vector3());
      this.livePos = this.restPos.clone();
      this.liveQuat = this.restQuat.clone();
      this.carryPos = this.restPos.clone();
      this.carryQuat = this.restQuat.clone();
      this.liveMatrix = this.hangerMatrix.clone();
      this._one = new THREE.Vector3(1, 1, 1);
      this._tmpV = new THREE.Vector3();
      this._tmpV2 = new THREE.Vector3();
      this._tmpD = new THREE.Vector3();
      this.liftT = 1;
      // settle into a natural drape (in the worker) before it is shown
      warm = { steps: K.warm };
    }
    this.ke = 1;
    this.dirty = true;
    // hidden until the first solved drape arrives
    this.ready = new Promise((res) => (this._readyRes = res));
    this.isReady = false;
    this.group.visible = false;
    this.poolId = clothPool.add(this.cloth, (r) => this._onResult(r), warm, { dedicated: !!worn });
  }

  _onResult(r) {
    const c = this.cloth;
    if (r.pos) {
      // what gets drawn: the solved state as a whole (see _updateClothFrame)
      this.rpos = r.pos;
      this.rnrm = r.nrm;
      this.simMat = r.tag ? (this._simMat ||= new THREE.Matrix4()).fromArray(r.tag) : null;
      // main-thread copy (picking, grabbing), except particles it drives
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
      if (this.label) this._writeLabel();
      this.dirty = false;
      this._readyRes();
    }
  }

  /**
   * The solve runs a frame or so behind and at a fixed 60 Hz, while the
   * hanger moves every frame (120 Hz and up). Drawing the solved fabric as-is
   * made it trail the hanger and judder against it while carried or turned.
   * So the fabric is drawn from the solved state *including* its hanger
   * points, then carried rigidly (one matrix, no per-vertex work) from the
   * hanger pose it was solved for to where the hanger is now: hanger and
   * shoulders always line up, and only the swing of the fabric is a step
   * behind, which the eye can't see.
   */
  _updateClothFrame() {
    const m = this.clothRoot.matrix;
    if (this.simMat && this.liveMatrix) m.copy(this.simMat).invert().premultiply(this.liveMatrix);
    else m.identity();
  }

  // ------------------------------------------------------------ render mesh
  _buildRenderMesh(tris, triPanel) {
    const pat = this.pat;
    const W = pat.pattern.window;
    const uvOf = (i, panel) => {
      const x = pat.verts[i].ux ?? pat.verts[i].x;
      const y = pat.verts[i].uy ?? pat.verts[i].y;
      const u = panel === BACK ? 0.5 + ((W.x1 - x) / (W.x1 - W.x0)) * 0.5 : ((x - W.x0) / (W.x1 - W.x0)) * 0.5;
      return [u, (y - W.y0) / (W.y1 - W.y0)];
    };
    // The render mesh is much denser than the simulation mesh: every sim
    // triangle is split into SUB x SUB triangles evaluated on a Phong-
    // tessellated curved surface, so folds and silhouettes stay smooth while
    // physics runs on the coarser mesh. Points on a shared edge depend only on
    // that edge, so neighbouring triangles always meet without cracks.
    const SUB = this.quality > 0.7 ? 4 : 3;
    this.SUB = SUB;
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
    this.material = this.K.material(this.tex, this.pat);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    // hard spot-light self-shadows on a moving cloth read as dark blotches
    // (and acne); fold shading comes from the normals instead
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.userData.tee = this;
    this.clothRoot.add(this.mesh);
  }

  _buildRims() {
    // Rolled edges: a thin tube along each opening so the fabric reads as
    // having real thickness (rib collar is the thickest).
    const mat = new THREE.MeshPhysicalMaterial({
      color: this.K.rimColor,
      roughness: 0.92,
      sheen: 1,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(this.K.rimSheen),
    });
    this.rims = [];
    const spec = this.K.rims;
    for (const [name, r, seg] of spec) {
      const loop = this.pat.loops[name];
      // the tube follows the smooth (tessellated) edge, not the coarse
      // simulation polygon, so it never sinks inside the fabric
      const n = loop.length * this.SUB;
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
      this.clothRoot.add(mesh);
      this.rims.push({ loop, r, seg, geo, mesh });
    }
  }

  _buildLabel() {
    const geo = new THREE.PlaneGeometry(0.05, 0.0227);
    const mat = new THREE.MeshStandardMaterial({ map: this.tex.label, roughness: 0.55, side: THREE.DoubleSide });
    this.label = new THREE.Mesh(geo, mat);
    this.label.matrixAutoUpdate = false;
    this.clothRoot.add(this.label);
  }

  _buildHanger() {
    if (this.kind === 'socks') return this._buildClipHanger();
    this._buildWireHanger();
  }

  _buildClipHanger() {
    // A chrome sock hanger: hook, short bar and a spring clip gripping the
    // middle of each cuff.
    const g = new THREE.Group();
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde6, metalness: 1, roughness: 0.2 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0e, metalness: 0.3, roughness: 0.4 });
    const off = this.pat.spec.pairOffset;
    const xs = [0, off[0]];
    const bar = new THREE.Mesh(new THREE.BoxGeometry(off[0] + 0.06, 0.012, 0.006), black);
    bar.position.set(off[0] / 2, 0.03, 0);
    g.add(bar);
    xs.forEach((x, k) => {
      const z = k ? off[2] : 0;
      const y = k ? off[1] : 0;
      // clip jaws either side of the cuff + the arm down from the bar
      for (const s of [-1, 1]) {
        const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.003), chrome);
        jaw.position.set(x, y + 0.004, z + s * 0.0045);
        g.add(jaw);
      }
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.03 - y, 0.004), chrome);
      arm.position.set(x, (0.03 + y) / 2 + 0.006, z);
      g.add(arm);
    });
    // same hook geometry as the shirt hangers, so it sits on the same rail
    const hx = off[0] / 2;
    const hook = new THREE.CatmullRomCurve3([
      new THREE.Vector3(hx, 0.036, 0),
      new THREE.Vector3(hx, 0.07, 0),
      new THREE.Vector3(hx, 0.1, 0),
      new THREE.Vector3(hx, 0.125, -0.02),
      new THREE.Vector3(hx, 0.11, -0.04),
      new THREE.Vector3(hx, 0.09, -0.035),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(hook, 30, 0.0026, 8, false), chrome));
    for (const m of g.children) m.castShadow = true;
    this.hangerColliders = [];
    this.capsLocal = [];
    this.cloth.colliders = [...Tee.environment];
    g.matrixAutoUpdate = false;
    g.matrix.copy(this.hangerMatrix);
    this.hanger = g;
    this.group.add(g);
  }

  _buildWireHanger() {
    // Brushed-chrome wire hanger with a matte black body, shaped to the shoulder line.
    const g = new THREE.Group();
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde6, metalness: 1, roughness: 0.18 });
    const body = new THREE.MeshStandardMaterial({ color: 0x0b0b0e, metalness: 0.2, roughness: 0.45 });
    const P = this.pat.pattern;
    const pts = [];
    // The arm reaches past the last pinned shoulder point (a hanger that
    // stops short leaves the outer pins holding the sleeve up in mid-air,
    // which over-stretched the fabric there) and sits right under the
    // shoulder seam, the way a shirt really rests on a hanger.
    const span = 0.214; // = the outermost pinned shoulder point
    const DROP = 0.013; // arm centre below the seam line
    const armPt = (x, drop) => {
      const ax = Math.abs(x);
      // follow shoulder slope beyond the neck point
      const y = ax < P.N[0] ? 0.012 - (ax / P.N[0]) * 0.012 : -((ax - P.N[0]) / (P.S[0] - P.N[0])) * -P.S[1];
      return new THREE.Vector3(x, y - drop, 0);
    };
    for (let i = -20; i <= 20; i++) pts.push(armPt((i / 20) * span, DROP));
    // the visible arm stops a little short of the collider and sits a few mm
    // lower, so its tips can never show through the fabric at the shoulders
    const VIS = 0.194;
    const vis = [];
    for (let i = -20; i <= 20; i++) vis.push(armPt((i / 20) * VIS, DROP + 0.003));
    const curve = new THREE.CatmullRomCurve3(vis);
    // the cloth wraps over the hanger arm: capsule colliders along it
    this.hangerColliders = [];
    this.capsLocal = [];
    for (let i = 0; i < pts.length - 1; i += 5) {
      this.capsLocal.push([pts[i].clone(), pts[Math.min(i + 5, pts.length - 1)].clone()]);
      const a = pts[i].clone().applyMatrix4(this.hangerMatrix);
      const b = pts[Math.min(i + 5, pts.length - 1)].clone().applyMatrix4(this.hangerMatrix);
      // The solver pads colliders by half the cloth thickness (1 cm), so the
      // fabric wraps at ~14 mm from the arm's centre: just outside the 6.5 mm
      // visible tube, and its top meets the pinned seam. (A fatter, lower
      // collider forced the fabric to stretch ~35% over the hanger, which made
      // shoulder bumps and a constant buzz there.)
      this.hangerColliders.push({ type: 'capsule', a: a.toArray(), b: b.toArray(), r: 0.004 });
    }
    this.cloth.colliders = [...Tee.environment, ...this.hangerColliders];
    const arm = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.006, 12, false), body);
    arm.castShadow = true;
    g.add(arm);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12), body);
      cap.position.copy(vis[s < 0 ? 0 : vis.length - 1]);
      g.add(cap);
    }
    const hook = new THREE.CurvePath();
    const hookPts = [
      new THREE.Vector3(0, -0.004, 0),
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
  _buildTethers(slack) {
    // each particle is tied to its nearest hanger point by the straight-line
    // distance across its flat pattern piece (never shorter than the fabric
    // between them, so it only stops over-stretching, it never pulls)
    const pat = this.pat;
    const UX = (v) => v.ux ?? v.x;
    const UY = (v) => v.uy ?? v.y;
    const pins = [...this.hangerLocal.keys()];
    const T = [];
    pat.verts.forEach((v, i) => {
      if (this.hangerLocal.has(i)) return;
      let best = -1, bd = Infinity;
      for (const p of pins) {
        const q = pat.verts[p];
        if (q.sock !== undefined && v.sock !== undefined && q.sock !== v.sock) continue;
        const d = Math.hypot(UX(q) - UX(v), UY(q) - UY(v));
        if (d < bd) { bd = d; best = p; }
      }
      if (best >= 0) T.push(i, best, bd * slack + 0.004);
    });
    this.cloth.tether = new Float32Array(T);
  }

  _pinToHanger() {
    for (const [id, lp] of this.hangerLocal) {
      const target = lp.clone().applyMatrix4(this.hangerMatrix);
      this.cloth.pin(id, target.x, target.y, target.z);
    }
  }

  // ------------------------------------------------------------ carrying
  // Picking a tee up lifts the whole hanger off the rail: the shoulders stay
  // pinned to the hanger exactly as when it hangs, and only the hanger moves
  // (smoothly, speed-limited). That keeps the drape stable however you turn
  // or carry it, where pinching two loose points used to tangle the fabric.

  /** carry the hanger towards this pose (world position + rotation) */
  carryTo(pos, quat) {
    this.wake();
    if (this.state !== 'held') {
      this.state = 'held';
      this.liftT = 0;
    }
    this.carryPos.copy(pos);
    this.carryQuat.copy(quat);
  }

  returnToHanger() {
    this.wake();
    this.state = 'returning';
    this.carryPos.copy(this.restPos);
    this.carryQuat.copy(this.restQuat);
  }

  _moveHanger(dt) {
    const lp = this.livePos, lq = this.liveQuat;
    let tp = this.carryPos;
    // lift straight up off the rail first, so the hook clears the bar
    if (this.state === 'held' && this.liftT < 1) {
      this.liftT = Math.min(1, this.liftT + dt / 0.35);
      if (this.liftT < 1) tp = this._tmpV.copy(this.restPos).setY(this.restPos.y + 0.09 * this.liftT);
    }
    const d = this._tmpD.copy(tp).sub(lp);
    const step = d.clone().multiplyScalar(1 - Math.exp(-dt * 7));
    const maxStep = 2.6 * dt; // m/s
    if (step.length() > maxStep) step.setLength(maxStep);
    lp.add(step);
    // turn gently (angular speed capped) so the sleeves swing, not flip
    const ang = lq.angleTo(this.carryQuat);
    if (ang > 1e-5) {
      const want = ang * (1 - Math.exp(-dt * 4));
      lq.rotateTowards(this.carryQuat, Math.min(want, 2.2 * dt));
    }
    this.liveMatrix.compose(lp, lq, this._one);
    this.hanger.matrix.copy(this.liveMatrix);
    // pins follow the hanger
    const c = this.cloth;
    const v = this._tmpV2;
    for (const [id, l] of this.hangerLocal) {
      if (this.grabbed && this.grabbed.id === id) continue;
      v.copy(l).applyMatrix4(this.liveMatrix);
      c.pos[3 * id] = v.x;
      c.pos[3 * id + 1] = v.y;
      c.pos[3 * id + 2] = v.z;
    }
    this.capsLocal.forEach(([a, b], k) => {
      const cap = this.hangerColliders[k];
      v.copy(a).applyMatrix4(this.liveMatrix);
      cap.a = v.toArray();
      v.copy(b).applyMatrix4(this.liveMatrix);
      cap.b = v.toArray();
    });
    c.colliders = [...Tee.environment, ...this.hangerColliders];
    if (this.state === 'returning' && lp.distanceTo(this.restPos) < 0.002 && lq.angleTo(this.restQuat) < 0.004) {
      lp.copy(this.restPos);
      lq.copy(this.restQuat);
      this.liveMatrix.copy(this.hangerMatrix);
      this.hanger.matrix.copy(this.hangerMatrix);
      this.state = 'hanging';
    }
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
    const stillPinned = this.hangerLocal.has(id);
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
    if (this.hanger && this.state !== 'hanging' && this.state !== 'worn') this._moveHanger(dt);
    if (wind) c.wind = wind;
    // keep the fabric locked to the hanger between solver results
    this._updateClothFrame();
    if (dt > 0 && !this.asleep && !paused && this.isReady) {
      clothPool.request(this.poolId, dt, this.liveMatrix ? this.liveMatrix.elements.slice() : null);
      // sleep when settled on the hanger to save CPU
      // a garment left alone on its hanger comes to rest (real fabric has
      // internal friction), then sleeps
      this.idleT = this.state === 'hanging' && !this.grabbed ? (this.idleT || 0) + dt : 0;
      // (give it a few seconds first, so a tee that was just put back or
      // pulled can swing out and untwist before it is calmed down)
      c.damping = this.idleT > 4 && !this.alwaysAwake ? 3.5 : 0.6;
      if (this.state === 'hanging' && !this.grabbed && !this.alwaysAwake && this.idleT > 4) {
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
    if (this.label) this._writeLabel();
  }

  _writeRenderMesh() {
    const pos = this.geometry.attributes.position.array;
    const nrm = this.geometry.attributes.normal.array;
    const P = this.rpos || this.cloth.pos;
    const Nn = this.rnrm || this.cloth.normals;
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
    const P = this.rpos || this.cloth.pos;
    const Nn = this.rnrm || this.cloth.normals;
    const S = this.SUB;
    const alpha = 0.65;
    const t = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3();
    for (const rim of this.rims) {
      const { loop, r, seg, geo } = rim;
      const pos = geo.attributes.position.array;
      const nrm = geo.attributes.normal.array;
      const L = loop.length;
      const M = L * S;
      if (!rim.ep || rim.ep.length !== M * 3) {
        rim.ep = new Float32Array(M * 3);
        rim.en = new Float32Array(M * 3);
      }
      const ep = rim.ep, en = rim.en;
      // points on the Phong-tessellated boundary edges (same formula as the mesh)
      for (let i = 0; i < L; i++) {
        const a = 3 * loop[i], c = 3 * loop[(i + 1) % L];
        for (let k = 0; k < S; k++) {
          const v = k / S, u = 1 - v;
          const px = u * P[a] + v * P[c], py = u * P[a + 1] + v * P[c + 1], pz = u * P[a + 2] + v * P[c + 2];
          const da = (px - P[a]) * Nn[a] + (py - P[a + 1]) * Nn[a + 1] + (pz - P[a + 2]) * Nn[a + 2];
          const dc = (px - P[c]) * Nn[c] + (py - P[c + 1]) * Nn[c + 1] + (pz - P[c + 2]) * Nn[c + 2];
          const o = 3 * (i * S + k);
          ep[o] = px - alpha * (u * da * Nn[a] + v * dc * Nn[c]);
          ep[o + 1] = py - alpha * (u * da * Nn[a + 1] + v * dc * Nn[c + 1]);
          ep[o + 2] = pz - alpha * (u * da * Nn[a + 2] + v * dc * Nn[c + 2]);
          en[o] = u * Nn[a] + v * Nn[c];
          en[o + 1] = u * Nn[a + 1] + v * Nn[c + 1];
          en[o + 2] = u * Nn[a + 2] + v * Nn[c + 2];
        }
      }
      for (let i = 0; i < M; i++) {
        const p = 3 * i;
        const pn = 3 * ((i + 1) % M);
        const pp = 3 * ((i - 1 + M) % M);
        t.set(ep[pn] - ep[pp], ep[pn + 1] - ep[pp + 1], ep[pn + 2] - ep[pp + 2]).normalize();
        n.set(en[p], en[p + 1], en[p + 2]);
        b.crossVectors(t, n).normalize();
        n.crossVectors(b, t).normalize();
        for (let s2 = 0; s2 < seg; s2++) {
          const ang = (s2 / seg) * Math.PI * 2;
          const cx = Math.cos(ang), sy = Math.sin(ang);
          const ox = n.x * cx + b.x * sy, oy = n.y * cx + b.y * sy, oz = n.z * cx + b.z * sy;
          const k = 3 * (i * seg + s2);
          pos[k] = ep[p] + ox * r;
          pos[k + 1] = ep[p + 1] + oy * r;
          pos[k + 2] = ep[p + 2] + oz * r;
          nrm[k] = ox; nrm[k + 1] = oy; nrm[k + 2] = oz;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.normal.needsUpdate = true;
    }
  }

  _writeLabel() {
    const P = this.rpos || this.cloth.pos;
    const Nn = this.rnrm || this.cloth.normals;
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
