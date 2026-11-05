// Main-thread side of the cloth workers. Garments are spread over a few
// workers so they simulate in parallel on separate cores. Each frame the awake
// garments send their kinematic particles + colliders; the latest solved
// positions come back asynchronously and are copied in when ready. Falls back
// to stepping on the main thread when module workers are unavailable.

export const stat = { ms: 0, steps: {}, info: {} };

let workers = null; // [{ w, pending }] or false
let nextId = 1;
let sharedNext = 0;
const members = new Map(); // id -> { cloth, onResult, job, dtAcc, slot }

function ensureWorkers() {
  if (workers !== null) return workers;
  try {
    const cores = navigator.hardwareConcurrency || 4;
    const count = Math.max(1, Math.min(4, cores - 2));
    workers = [];
    for (let i = 0; i < count; i++) {
      const slot = { w: new Worker(new URL('./cloth.worker.js', import.meta.url), { type: 'module' }), pending: false };
      slot.w.onmessage = (e) => {
        slot.pending = false;
        if (e.data.ms) stat.ms = stat.ms * 0.9 + e.data.ms * 0.1;
        for (const r of e.data.results) {
          stat.steps[r.id] = (stat.steps[r.id] || 0) + (r.simT || 0);
          if (r.n) stat.info[r.id] = { n: r.n, sub: r.sub, stepMs: +(+r.stepMs).toFixed(2), dropped: +(+r.dropped).toFixed(2) };
          const m = members.get(r.id);
          if (m) m.onResult(r);
        }
      };
      const slow = +new URLSearchParams(location.search).get('slow');
      if (slow > 1) slot.w.postMessage({ type: 'cfg', slow });
      slot.w.onerror = (err) => console.warn('cloth worker error', err.message);
      workers.push(slot);
    }
  } catch {
    workers = false;
  }
  return workers;
}

export const clothPool = {
  get threaded() {
    return !!ensureWorkers();
  },
  /**
   * Register a cloth. `warm` = { steps, colliders?: [per step] } settles the
   * initial drape inside the worker; onResult fires once that is done.
   */
  add(cloth, onResult, warm = null, { dedicated = false } = {}) {
    const id = nextId++;
    const ws = ensureWorkers();
    // A garment that never sleeps (the DJ's shirt) gets the last worker to
    // itself, so it never shares a core with the shirt you're holding.
    let slot = null;
    if (ws) {
      const shared = ws.length > 1 ? ws.length - 1 : 1;
      slot = dedicated ? ws[ws.length - 1] : ws[sharedNext++ % shared];
    }
    members.set(id, { cloth, onResult, job: null, dtAcc: 0, slot });
    if (!slot) {
      // main-thread fallback: settle now
      if (warm) {
        for (let i = 0; i < warm.steps; i++) {
          if (warm.colliders) cloth.colliders = warm.colliders[i];
          cloth.step(1 / 60);
        }
        cloth.vel.fill(0);
      }
      cloth.computeNormals();
      queueMicrotask(() => onResult({ pos: null, nrm: null, ke: 1, steps: 0 }));
      return id;
    }
    slot.w.postMessage({
      type: 'add',
      id,
      init: {
        pos: cloth.pos,
        restPos: cloth.restPos,
        mass: cloth.mass,
        tris: cloth.tris,
        stretch: cloth.stretch,
        bend: cloth.bend,
        tether: cloth.tether,
      },
      state: { pos: cloth.pos, vel: cloth.vel, invMass: cloth.invMass, colliders: cloth.colliders },
      params: {
        substeps: cloth.substeps,
        stretchCompliance: cloth.stretchCompliance,
        bendCompliance: cloth.bendCompliance,
        thickness: cloth.thickness,
        friction: cloth.friction,
        damping: cloth.damping,
        dragCoeff: cloth.dragCoeff,
        selfCollision: cloth.selfCollision,
        selfRestMin: cloth.selfRestMin,
        colliderFriction: cloth.colliderFriction || 0,
      },
      warm,
    });
    return id;
  },
  /** queue this frame's input for one garment */
  request(id, dt, tag = null) {
    const m = members.get(id);
    m.dtAcc += dt;
    const c = m.cloth;
    const kin = [];
    for (let i = 0; i < c.n; i++) if (c.invMass[i] === 0) kin.push(i, c.pos[3 * i], c.pos[3 * i + 1], c.pos[3 * i + 2]);
    m.job = {
      id,
      kin,
      invMass: c.invMass,
      colliders: c.colliders,
      wind: c.wind,
      colliderFriction: c.colliderFriction,
      damping: c.damping,
      // echoed back with the result: lets the garment know which hanger pose
      // a solved state belongs to
      tag,
    };
  },
  /** send all queued jobs (once per frame) */
  flush() {
    const batches = new Map();
    for (const [, m] of members) {
      if (!m.job) continue;
      if (!m.slot) {
        // main-thread fallback
        const c = m.cloth;
        c.step(Math.min(m.dtAcc, 1 / 30));
        c.computeNormals();
        m.onResult({ pos: null, nrm: null, ke: c.kineticEnergy(), steps: 1 });
        m.job = null;
        m.dtAcc = 0;
        continue;
      }
      if (m.slot.pending) continue; // keep accumulating time until that worker is free
      m.job.dt = m.dtAcc;
      m.job.invMass = new Float32Array(m.job.invMass);
      if (!batches.has(m.slot)) batches.set(m.slot, []);
      batches.get(m.slot).push(m.job);
      m.job = null;
      m.dtAcc = 0;
    }
    for (const [slot, jobs] of batches) {
      slot.pending = true;
      slot.w.postMessage({ type: 'step', jobs });
    }
  },
};
