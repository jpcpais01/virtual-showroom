// Main-thread side of the cloth worker. Each frame, the awake garments send
// their kinematic particles + colliders; the latest solved positions come back
// asynchronously and are copied in when ready. Falls back to stepping on the
// main thread when module workers are unavailable.

let worker = null;
let nextId = 1;
let pending = false;
const members = new Map(); // id -> { cloth, onResult, job, dtAcc }

function ensureWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./cloth.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      pending = false;
      for (const r of e.data.results) {
        const m = members.get(r.id);
        if (m) m.onResult(r);
      }
    };
    worker.onerror = () => {
      worker = false;
    };
  } catch {
    worker = false;
  }
  return worker;
}

export const clothPool = {
  get threaded() {
    return !!ensureWorker();
  },
  add(cloth, onResult) {
    const id = nextId++;
    members.set(id, { cloth, onResult, job: null, dtAcc: 0 });
    const w = ensureWorker();
    if (w) {
      w.postMessage({
        type: 'add',
        id,
        init: {
          pos: cloth.pos,
          restPos: cloth.restPos,
          mass: cloth.mass,
          tris: cloth.tris,
          stretch: cloth.stretch,
          bend: cloth.bend,
        },
        state: { pos: cloth.pos, vel: cloth.vel },
        params: {
          substeps: cloth.substeps,
          stretchCompliance: cloth.stretchCompliance,
          bendCompliance: cloth.bendCompliance,
          thickness: cloth.thickness,
          friction: cloth.friction,
          damping: cloth.damping,
          dragCoeff: cloth.dragCoeff,
          selfCollision: cloth.selfCollision,
        },
      });
    }
    return id;
  },
  /** queue this frame's input for one garment */
  request(id, dt) {
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
    };
  },
  /** send all queued jobs (once per frame) */
  flush() {
    const w = ensureWorker();
    const jobs = [];
    for (const [, m] of members) {
      if (!m.job) continue;
      if (!w) {
        // main-thread fallback
        const c = m.cloth;
        c.step(Math.min(m.dtAcc, 1 / 30));
        c.computeNormals();
        m.onResult({ pos: null, nrm: null, ke: c.kineticEnergy(), steps: 1 });
        m.job = null;
        m.dtAcc = 0;
        continue;
      }
      if (pending) continue; // keep accumulating time until the worker is free
      m.job.dt = Math.min(m.dtAcc, 1 / 30);
      m.job.invMass = new Float32Array(m.job.invMass);
      jobs.push(m.job);
      m.job = null;
      m.dtAcc = 0;
    }
    if (w && jobs.length) {
      pending = true;
      w.postMessage({ type: 'step', jobs });
    }
  },
};
