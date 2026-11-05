// Position-based cloth solver (XPBD with small substeps).
//
// Stretch and bending are distance constraints on the triangle mesh, the
// mesh is built from the real sewing pattern so front/back panels share their
// seam particles. Self collision follows Müller's "Ten Minute Physics" cloth
// approach: particles keep `thickness` apart unless they were already closer
// in the rest state; the spatial hash is built once per frame.

class SpatialHash {
  // Dense uniform grid over the garment's current bounding box (not a hashed
  // table): a neighbourhood query then reads 9 contiguous runs of cells
  // instead of hashing 27 scattered ones, which is several times faster.
  constructor(spacing, maxNumObjects) {
    this.spacing = spacing;
    this.cellStart = new Int32Array(1);
    this.cellEntries = new Int32Array(maxNumObjects);
    this.cellOf = new Int32Array(maxNumObjects);
    this.firstAdjId = new Int32Array(maxNumObjects + 1);
    this.adjIds = new Int32Array(16 * maxNumObjects);
  }
  create(pos, n) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    let s = this.spacing;
    // keep the grid a sane size even if the cloth is flung far apart
    while ((x1 - x0) / s > 120 || (y1 - y0) / s > 120 || (z1 - z0) / s > 120) s *= 2;
    this.s = s;
    this.ox = x0;
    this.oy = y0;
    this.oz = z0;
    const nx = (this.nx = Math.floor((x1 - x0) / s) + 1);
    const ny = (this.ny = Math.floor((y1 - y0) / s) + 1);
    const nz = (this.nz = Math.floor((z1 - z0) / s) + 1);
    const cells = nx * ny * nz;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
    const cs = this.cellStart;
    cs.fill(0, 0, cells + 1);
    const inv = 1 / s;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor((pos[3 * i] - x0) * inv);
      const cy = Math.floor((pos[3 * i + 1] - y0) * inv);
      const cz = Math.floor((pos[3 * i + 2] - z0) * inv);
      const c = (cz * ny + cy) * nx + cx;
      this.cellOf[i] = c;
      cs[c]++;
    }
    let start = 0;
    for (let c = 0; c < cells; c++) {
      start += cs[c];
      cs[c] = start;
    }
    cs[cells] = start;
    for (let i = n - 1; i >= 0; i--) this.cellEntries[--cs[this.cellOf[i]]] = i;
  }
  queryAll(pos, n, maxDist, rest = null, restMin = 0) {
    let num = 0;
    const maxDist2 = maxDist * maxDist;
    const rMin2 = restMin * restMin;
    const { s, ox, oy, oz, nx, ny, nz, cellStart: cs, cellEntries: ent } = this;
    const inv = 1 / s;
    for (let i = 0; i < n; i++) {
      this.firstAdjId[i] = num;
      const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      const ax = Math.max(0, Math.floor((px - maxDist - ox) * inv));
      const bx = Math.min(nx - 1, Math.floor((px + maxDist - ox) * inv));
      const ay = Math.max(0, Math.floor((py - maxDist - oy) * inv));
      const by = Math.min(ny - 1, Math.floor((py + maxDist - oy) * inv));
      const az = Math.max(0, Math.floor((pz - maxDist - oz) * inv));
      const bz = Math.min(nz - 1, Math.floor((pz + maxDist - oz) * inv));
      for (let zi = az; zi <= bz; zi++)
        for (let yi = ay; yi <= by; yi++) {
          const row = (zi * ny + yi) * nx;
          const end = cs[row + bx + 1];
          for (let e = cs[row + ax]; e < end; e++) {
            const id1 = ent[e];
            if (id1 >= i) continue;
            const dx = pos[3 * id1] - px;
            const dy = pos[3 * id1 + 1] - py;
            const dz = pos[3 * id1 + 2] - pz;
            if (dx * dx + dy * dy + dz * dz > maxDist2) continue;
            if (rest) {
              // particles that are close in the rest state (same patch of
              // fabric) are held apart by the stretch/bend constraints already
              const rx = rest[3 * id1] - rest[3 * i];
              const ry = rest[3 * id1 + 1] - rest[3 * i + 1];
              const rz = rest[3 * id1 + 2] - rest[3 * i + 2];
              if (rx * rx + ry * ry + rz * rz < rMin2) continue;
            }
            if (num >= this.adjIds.length) {
              const grown = new Int32Array(2 * num);
              grown.set(this.adjIds);
              this.adjIds = grown;
            }
            this.adjIds[num++] = id1;
          }
        }
    }
    this.firstAdjId[n] = num;
  }
}

export class Cloth {
  /**
   * @param {object} o
   * @param {Float32Array} o.pos      initial world positions (n*3)
   * @param {Float32Array} o.restPos  rest-state positions used for collision exemptions
   * @param {Float32Array} o.mass     particle masses (kg)
   * @param {Uint32Array}  o.tris     triangle indices
   * @param {Float32Array} o.stretch  [i, j, rest, ...] stretch constraints
   * @param {Float32Array} o.bend     [i, j, rest, ...] bending constraints
   */
  constructor(o) {
    this.n = o.pos.length / 3;
    this.pos = new Float32Array(o.pos);
    this.prev = new Float32Array(o.pos);
    this.vel = new Float32Array(o.pos.length);
    this.restPos = o.restPos;
    this.tris = o.tris;
    this.mass = o.mass;
    this.invMass = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.invMass[i] = 1 / o.mass[i];
    this.baseInvMass = new Float32Array(this.invMass);
    this.stretch = o.stretch;
    this.bend = o.bend;
    // long-range attachments [i, anchor, maxDist, ...]: a particle may never be
    // farther from its hanger point than the fabric between them allows.
    // Without these, the few solver iterations we can afford let the weight of
    // the whole shirt stretch the fabric next to the hanger by ~30%.
    this.tether = o.tether || null;

    this.stretchCompliance = 2e-7;
    this.bendCompliance = 0.025;
    this.thickness = 0.02;
    this.friction = 0.12;
    this.damping = 0.6; // linear air damping (1/s)
    this.dragCoeff = 1.2; // aerodynamic drag coefficient of the cloth faces
    this.gravity = -9.81;
    this.substeps = 10;
    this.selfRestMin = 0.065; // skip self-collision pairs closer than this at rest
    this.floorY = 0.002;
    this.selfCollision = true;
    this.wind = [0, 0, 0]; // air velocity (m/s), acts through face drag
    this.colliderFriction = 0;
    this.colliders = []; // {type:'sphere', c:[x,y,z], r} | {type:'capsule', a, b, r}

    this.hash = new SpatialHash(0.06, this.n);
    this.normals = new Float32Array(this.n * 3);
  }

  pin(i, x, y, z) {
    this.invMass[i] = 0;
    this.pos[3 * i] = x;
    this.pos[3 * i + 1] = y;
    this.pos[3 * i + 2] = z;
  }
  unpin(i) {
    this.invMass[i] = this.baseInvMass[i];
  }

  step(frameDt) {
    const dt = Math.min(frameDt, 1 / 30);
    const sdt = dt / this.substeps;
    const n = this.n;
    const pos = this.pos;
    const prev = this.prev;
    const vel = this.vel;
    const w = this.invMass;

    // Self collision neighbours are rebuilt every few substeps. The velocity
    // clamp below bounds how far anything can move in between, so the search
    // radius stays small however fast the cloth is being thrown around.
    const rebuildEvery = this.rebuildEvery || (this.substeps <= 4 ? this.substeps : Math.ceil(this.substeps / 2));
    const searchR = this.thickness * (1 + 0.3 * rebuildEvery) + 0.002;
    // cells as big as the search radius: the query then visits ~27 small
    // cells instead of sweeping a big neighbourhood (cost grows with r^3)
    this.hash.spacing = searchR;
    // kinematic particles (hands, mouse) glide to their new targets across
    // the substeps instead of jumping there at the start of the step
    const kt = this.kinTargets;
    let kFrom = null;
    if (kt && kt.length) {
      kFrom = new Float32Array(kt.length);
      for (let a = 0; a < kt.length; a += 4) {
        const j = 3 * kt[a];
        kFrom[a + 1] = pos[j];
        kFrom[a + 2] = pos[j + 1];
        kFrom[a + 3] = pos[j + 2];
      }
    }

    this.activeColliders = this._nearColliders(dt);
    const damp = Math.max(0, 1 - this.damping * sdt);
    // velocity limit keeps self-collision robust: nothing may tunnel through
    // the fabric within one substep (Müller, Ten Minute Physics #15)
    const maxV = (0.3 * this.thickness) / sdt;
    const maxV2 = maxV * maxV;
    for (let s = 0; s < this.substeps; s++) {
      if (kFrom) {
        const f = (s + 1) / this.substeps;
        for (let a = 0; a < kt.length; a += 4) {
          const j = 3 * kt[a];
          pos[j] = kFrom[a + 1] + (kt[a + 1] - kFrom[a + 1]) * f;
          pos[j + 1] = kFrom[a + 2] + (kt[a + 2] - kFrom[a + 2]) * f;
          pos[j + 2] = kFrom[a + 3] + (kt[a + 3] - kFrom[a + 3]) * f;
        }
      }
      if (this.selfCollision && s % rebuildEvery === 0) {
        this.hash.create(pos, n);
        this.hash.queryAll(pos, n, searchR, this.restPos, this.selfRestMin);
      }
      // air drag changes slowly: every other substep is plenty
      if (s % 2 === 0) this._aero(Math.min(2, this.substeps - s) * sdt);
      // The clamp only limits motion *relative to the garment as a whole*:
      // layers can't tunnel through each other, but the shirt as a whole can
      // move as fast as you swing it (a plain clamp made it feel like syrup).
      let mx = 0, my = 0, mz = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        const k = 3 * i;
        vel[k] *= damp;
        vel[k + 1] = (vel[k + 1] + this.gravity * sdt) * damp;
        vel[k + 2] *= damp;
        mx += vel[k];
        my += vel[k + 1];
        mz += vel[k + 2];
        cnt++;
      }
      if (cnt) {
        mx /= cnt;
        my /= cnt;
        mz /= cnt;
      }
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        prev[k] = pos[k];
        prev[k + 1] = pos[k + 1];
        prev[k + 2] = pos[k + 2];
        if (w[i] === 0) continue;
        const rx = vel[k] - mx, ry = vel[k + 1] - my, rz = vel[k + 2] - mz;
        const v2 = rx * rx + ry * ry + rz * rz;
        if (v2 > maxV2) {
          const sc = maxV / Math.sqrt(v2);
          vel[k] = mx + rx * sc;
          vel[k + 1] = my + ry * sc;
          vel[k + 2] = mz + rz * sc;
        }
        pos[k] += vel[k] * sdt;
        pos[k + 1] += vel[k + 1] * sdt;
        pos[k + 2] += vel[k + 2] * sdt;
      }
      // with few substeps (slow CPU) a second stretch pass keeps the fabric
      // from sagging; it is the cheapest part of the step
      this._solveDistances(this.stretch, this.stretchCompliance / (sdt * sdt));
      if (this.substeps < 5) this._solveDistances(this.stretch, this.stretchCompliance / (sdt * sdt));
      this._solveDistances(this.bend, this.bendCompliance / (sdt * sdt));
      if (this.tether) this._solveTethers();
      if (this.selfCollision) this._solveSelf();
      this._solveColliders();
      const inv = 1 / sdt;
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        if (w[i] === 0) {
          vel[k] = vel[k + 1] = vel[k + 2] = 0;
          continue;
        }
        vel[k] = (pos[k] - prev[k]) * inv;
        vel[k + 1] = (pos[k + 1] - prev[k + 1]) * inv;
        vel[k + 2] = (pos[k + 2] - prev[k + 2]) * inv;
      }
    }
  }

  _maxSpeed() {
    let m = 0;
    const v = this.vel;
    for (let i = 0; i < v.length; i += 3) {
      const s = v[i] * v[i] + v[i + 1] * v[i + 1] + v[i + 2] * v[i + 2];
      if (s > m) m = s;
    }
    return Math.sqrt(m);
  }

  kineticEnergy() {
    let e = 0;
    const v = this.vel;
    for (let i = 0; i < this.n; i++) {
      if (this.invMass[i] === 0) continue;
      const k = 3 * i;
      e += v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2];
    }
    return e / this.n;
  }

  _solveDistances(c, alpha) {
    const pos = this.pos;
    const w = this.invMass;
    for (let k = 0; k < c.length; k += 3) {
      const i = c[k];
      const j = c[k + 1];
      const wi = w[i];
      const wj = w[j];
      const ws = wi + wj;
      if (ws === 0) continue;
      const i3 = 3 * i;
      const j3 = 3 * j;
      const dx = pos[i3] - pos[j3];
      const dy = pos[i3 + 1] - pos[j3 + 1];
      const dz = pos[i3 + 2] - pos[j3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len === 0) continue;
      const C = len - c[k + 2];
      const s = -C / (ws + alpha) / len;
      pos[i3] += dx * s * wi;
      pos[i3 + 1] += dy * s * wi;
      pos[i3 + 2] += dz * s * wi;
      pos[j3] -= dx * s * wj;
      pos[j3 + 1] -= dy * s * wj;
      pos[j3 + 2] -= dz * s * wj;
    }
  }

  _solveTethers() {
    const pos = this.pos;
    const w = this.invMass;
    const T = this.tether;
    for (let k = 0; k < T.length; k += 3) {
      const i = T[k];
      const a = T[k + 1];
      if (w[a] !== 0 || w[i] === 0) continue; // only while the anchor is held
      const i3 = 3 * i, a3 = 3 * a;
      const dx = pos[i3] - pos[a3], dy = pos[i3 + 1] - pos[a3 + 1], dz = pos[i3 + 2] - pos[a3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const L = T[k + 2];
      if (d2 <= L * L) continue;
      const s = L / Math.sqrt(d2);
      pos[i3] = pos[a3] + dx * s;
      pos[i3 + 1] = pos[a3 + 1] + dy * s;
      pos[i3 + 2] = pos[a3 + 2] + dz * s;
    }
  }

  _solveSelf() {
    const pos = this.pos;
    const prev = this.prev;
    const rest = this.restPos;
    const w = this.invMass;
    const th = this.thickness;
    const th2 = th * th;
    const adj = this.hash.adjIds;
    const first = this.hash.firstAdjId;
    const fr = this.friction;
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0) continue;
      const i3 = 3 * i;
      for (let a = first[i]; a < first[i + 1]; a++) {
        const j = adj[a];
        if (w[j] === 0) continue;
        const j3 = 3 * j;
        let dx = pos[j3] - pos[i3];
        let dy = pos[j3 + 1] - pos[i3 + 1];
        let dz = pos[j3 + 2] - pos[i3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > th2 || d2 === 0) continue;
        const rx = rest[i3] - rest[j3];
        const ry = rest[i3 + 1] - rest[j3 + 1];
        const rz = rest[i3 + 2] - rest[j3 + 2];
        const r2 = rx * rx + ry * ry + rz * rz;
        let minDist = th;
        if (d2 > r2) continue;
        if (r2 < th2) minDist = Math.sqrt(r2);
        const d = Math.sqrt(d2);
        const corr = (0.5 * (minDist - d)) / d;
        dx *= corr;
        dy *= corr;
        dz *= corr;
        pos[i3] -= dx;
        pos[i3 + 1] -= dy;
        pos[i3 + 2] -= dz;
        pos[j3] += dx;
        pos[j3 + 1] += dy;
        pos[j3 + 2] += dz;
        // friction: pull both towards their average velocity
        const v0x = pos[i3] - prev[i3], v0y = pos[i3 + 1] - prev[i3 + 1], v0z = pos[i3 + 2] - prev[i3 + 2];
        const v1x = pos[j3] - prev[j3], v1y = pos[j3 + 1] - prev[j3 + 1], v1z = pos[j3 + 2] - prev[j3 + 2];
        const ax = (v0x + v1x) * 0.5, ay = (v0y + v1y) * 0.5, az = (v0z + v1z) * 0.5;
        pos[i3] += (ax - v0x) * fr;
        pos[i3 + 1] += (ay - v0y) * fr;
        pos[i3 + 2] += (az - v0z) * fr;
        pos[j3] += (ax - v1x) * fr;
        pos[j3 + 1] += (ay - v1y) * fr;
        pos[j3 + 2] += (az - v1z) * fr;
      }
    }
  }

  // Only colliders near the cloth this step (the room has walls, plinths,
  // hangers... that a held shirt is nowhere near).
  _nearColliders(dt) {
    const pos = this.pos;
    const vel = this.vel;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let v2 = 0;
    for (let k = 0; k < pos.length; k += 3) {
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      const s = vel[k] * vel[k] + vel[k + 1] * vel[k + 1] + vel[k + 2] * vel[k + 2];
      if (s > v2) v2 = s;
    }
    const m = 0.1 + this.thickness + Math.sqrt(v2) * dt * 2;
    x0 -= m; y0 -= m; z0 -= m; x1 += m; y1 += m; z1 += m;
    const out = [];
    for (const c of this.colliders) {
      let a0, a1, b0, b1, c0, c1;
      if (c.type === 'sphere') {
        a0 = c.c[0] - c.r; a1 = c.c[0] + c.r; b0 = c.c[1] - c.r; b1 = c.c[1] + c.r; c0 = c.c[2] - c.r; c1 = c.c[2] + c.r;
      } else if (c.type === 'box') {
        a0 = c.min[0]; a1 = c.max[0]; b0 = c.min[1]; b1 = c.max[1]; c0 = c.min[2]; c1 = c.max[2];
      } else if (c.type === 'capsule') {
        a0 = Math.min(c.a[0], c.b[0]) - c.r; a1 = Math.max(c.a[0], c.b[0]) + c.r;
        b0 = Math.min(c.a[1], c.b[1]) - c.r; b1 = Math.max(c.a[1], c.b[1]) + c.r;
        c0 = Math.min(c.a[2], c.b[2]) - c.r; c1 = Math.max(c.a[2], c.b[2]) + c.r;
      } else {
        out.push(c);
        continue;
      }
      if (a1 < x0 || a0 > x1 || b1 < y0 || b0 > y1 || c1 < z0 || c0 > z1) continue;
      out.push(c);
    }
    return out;
  }

  _solveColliders() {
    const pos = this.pos;
    const w = this.invMass;
    const n = this.n;
    const fy = this.floorY;
    for (let i = 0; i < n; i++) {
      if (w[i] === 0) continue;
      const k = 3 * i;
      if (pos[k + 1] < fy) {
        pos[k + 1] = fy;
        // heavy floor friction
        pos[k] = this.prev[k] + (pos[k] - this.prev[k]) * 0.3;
        pos[k + 2] = this.prev[k + 2] + (pos[k + 2] - this.prev[k + 2]) * 0.3;
      }
    }
    const pad = this.thickness * 0.5;
    const prev = this.prev;
    const fr = this.colliderFriction;
    for (const c of this.activeColliders || this.colliders) {
      if (c.type === 'sphere') {
        const r = c.r + pad;
        for (let i = 0; i < n; i++) {
          if (w[i] === 0) continue;
          const k = 3 * i;
          const dx = pos[k] - c.c[0], dy = pos[k + 1] - c.c[1], dz = pos[k + 2] - c.c[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r * r || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const s = r / d;
          pos[k] = c.c[0] + dx * s;
          pos[k + 1] = c.c[1] + dy * s;
          pos[k + 2] = c.c[2] + dz * s;
        }
      } else if (c.type === 'box') {
        // axis-aligned box (walls, plinth, booth...): push out of the nearest face
        const x0 = c.min[0] - pad, y0 = c.min[1] - pad, z0 = c.min[2] - pad;
        const x1 = c.max[0] + pad, y1 = c.max[1] + pad, z1 = c.max[2] + pad;
        for (let i = 0; i < n; i++) {
          if (w[i] === 0) continue;
          const k = 3 * i;
          const x = pos[k], y = pos[k + 1], z = pos[k + 2];
          if (x <= x0 || x >= x1 || y <= y0 || y >= y1 || z <= z0 || z >= z1) continue;
          let d = x - x0, ax = 0, to = x0;
          if (x1 - x < d) { d = x1 - x; to = x1; }
          if (y - y0 < d) { d = y - y0; ax = 1; to = y0; }
          if (y1 - y < d) { d = y1 - y; ax = 1; to = y1; }
          if (z - z0 < d) { d = z - z0; ax = 2; to = z0; }
          if (z1 - z < d) { d = z1 - z; ax = 2; to = z1; }
          pos[k + ax] = to;
          // surface friction on the other two axes
          for (let a = 0; a < 3; a++) if (a !== ax) pos[k + a] = prev[k + a] + (pos[k + a] - prev[k + a]) * 0.5;
        }
      } else if (c.type === 'capsule') {
        const ax = c.a[0], ay = c.a[1], az = c.a[2];
        const bx = c.b[0] - ax, by = c.b[1] - ay, bz = c.b[2] - az;
        const bb = bx * bx + by * by + bz * bz;
        const r = c.r + pad;
        for (let i = 0; i < n; i++) {
          if (w[i] === 0) continue;
          const k = 3 * i;
          const px = pos[k] - ax, py = pos[k + 1] - ay, pz = pos[k + 2] - az;
          let t = (px * bx + py * by + pz * bz) / bb;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = px - bx * t, dy = py - by * t, dz = pz - bz * t;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r * r || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const s = (r - d) / d;
          pos[k] += dx * s;
          pos[k + 1] += dy * s;
          pos[k + 2] += dz * s;
          if (fr > 0) {
            // friction: cancel part of the tangential motion this substep
            const nx = dx / d, ny = dy / d, nz = dz / d;
            const mx = pos[k] - prev[k], my = pos[k + 1] - prev[k + 1], mz = pos[k + 2] - prev[k + 2];
            const mn = mx * nx + my * ny + mz * nz;
            pos[k] -= (mx - mn * nx) * fr;
            pos[k + 1] -= (my - mn * ny) * fr;
            pos[k + 2] -= (mz - mn * nz) * fr;
          }
        }
      }
    }
  }

  // Air resistance acting along each face normal: makes cloth float and
  // ripple instead of falling like a bead chain.
  _aero(sdt) {
    if (this.dragCoeff <= 0) return;
    const pos = this.pos;
    const vel = this.vel;
    const w = this.invMass;
    const t = this.tris;
    const wx = this.wind[0], wy = this.wind[1], wz = this.wind[2];
        for (let f = 0; f < t.length; f += 3) {
      const a = 3 * t[f], b = 3 * t[f + 1], c = 3 * t[f + 2];
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (area2 === 0) continue;
      nx /= area2;
      ny /= area2;
      nz /= area2;
      const vx = (vel[a] + vel[b] + vel[c]) / 3 - wx;
      const vy = (vel[a + 1] + vel[b + 1] + vel[c + 1]) / 3 - wy;
      const vz = (vel[a + 2] + vel[b + 2] + vel[c + 2]) / 3 - wz;
      const vn = vx * nx + vy * ny + vz * nz;
      // quadratic drag F = 1/2 rho Cd A vn|vn| (rho = 1.2 kg/m^3), split over 3 particles
      const imp = (0.6 * this.dragCoeff * area2 * 0.5 * vn * Math.abs(vn) * sdt) / 3;
      const ia = t[f], ib = t[f + 1], ic = t[f + 2];
      let dv = imp * w[ia];
      if (Math.abs(dv) > Math.abs(vn) * 0.3) dv = vn * 0.3;
      vel[a] -= nx * dv; vel[a + 1] -= ny * dv; vel[a + 2] -= nz * dv;
      dv = imp * w[ib];
      if (Math.abs(dv) > Math.abs(vn) * 0.3) dv = vn * 0.3;
      vel[b] -= nx * dv; vel[b + 1] -= ny * dv; vel[b + 2] -= nz * dv;
      dv = imp * w[ic];
      if (Math.abs(dv) > Math.abs(vn) * 0.3) dv = vn * 0.3;
      vel[c] -= nx * dv; vel[c + 1] -= ny * dv; vel[c + 2] -= nz * dv;
    }
  }

  computeNormals() {
    const nrm = this.normals;
    nrm.fill(0);
    const pos = this.pos;
    const t = this.tris;
    for (let f = 0; f < t.length; f += 3) {
      const a = 3 * t[f], b = 3 * t[f + 1], c = 3 * t[f + 2];
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
      nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
      nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    for (let i = 0; i < nrm.length; i += 3) {
      const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
      nrm[i] /= l;
      nrm[i + 1] /= l;
      nrm[i + 2] /= l;
    }
  }
}
