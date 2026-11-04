// Runs cloth simulations off the main thread so rendering never waits on
// physics. Several of these workers run in parallel (one or more garments
// each). The main thread owns pins/grabs (kinematic particles) and colliders;
// this worker owns the dynamics.
import { Cloth } from './cloth.js';

const cloths = new Map();
const STEP = 1 / 60;
// test hook: ?slow=N emulates a CPU N times slower (quiet mode / low end)
let slow = 1;

function result(id, c, steps, simT = 0) {
  c.computeNormals();
  const pos = new Float32Array(c.pos);
  const nrm = new Float32Array(c.normals);
  return { r: { id, pos, nrm, ke: c.kineticEnergy(), steps, simT, stepMs: c.stepMs || 0, sub: c.substeps, n: c.n, dropped: c.dropped || 0 }, transfer: [pos.buffer, nrm.buffer] };
}

// Hard CPU budget per worker: one 60 Hz step of every garment this worker
// runs must fit in BUDGET ms, even on a throttled laptop CPU, or the cloth
// falls behind real time and moves in slow motion. When over budget we shed
// substeps (slightly stretchier fabric) from whichever garment has the most;
// when there is room we give them back. Time itself is never dropped.
const BUDGET = 9;
const MIN_SUB = 3;
function budget(jobs) {
  let load = 0;
  const cs = [];
  for (const job of jobs) {
    const c = cloths.get(job.id);
    if (!c || !c.stepMs) continue;
    load += c.stepMs;
    cs.push(c);
  }
  if (!cs.length) return;
  if (load > BUDGET * 1.1) {
    let worst = null;
    for (const c of cs) if (c.substeps > MIN_SUB && (!worst || c.substeps > worst.substeps)) worst = c;
    if (worst) {
      worst.substeps--;
      worst.stepMs = 0;
    }
  } else {
    let best = null;
    for (const c of cs) if (c.substeps < c.baseSubsteps && (!best || c.substeps < best.substeps)) best = c;
    if (best && load + best.stepMs / best.substeps < BUDGET * 0.9) {
      best.substeps++;
      best.stepMs = 0;
    }
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cfg') {
    slow = m.slow || 1;
    return;
  }
  if (m.type === 'add') {
    const c = new Cloth(m.init);
    c.pos.set(m.state.pos);
    c.prev.set(m.state.pos);
    c.vel.set(m.state.vel);
    c.invMass.set(m.state.invMass);
    Object.assign(c, m.params);
    c.baseSubsteps = c.substeps;
    c.colliders = m.state.colliders || [];
    c.acc = 0;
    // settle into the initial drape here instead of blocking the page load
    const w = m.warm;
    if (w) {
      for (let i = 0; i < w.steps; i++) {
        if (w.colliders) c.colliders = w.colliders[i];
        c.step(STEP);
      }
      c.vel.fill(0);
    }
    cloths.set(m.id, c);
    const { r, transfer } = result(m.id, c, 0);
    self.postMessage({ type: 'result', results: [r], ms: 0 }, transfer);
    return;
  }
  if (m.type === 'step') {
    const t0 = performance.now();
    const out = [];
    const transfer = [];
    for (const job of m.jobs) {
      const c = cloths.get(job.id);
      if (!c) continue;
      c.invMass.set(job.invMass);
      c.colliders = job.colliders;
      c.wind = job.wind;
      c.colliderFriction = job.colliderFriction || 0;
      c.damping = job.damping;
      // kinematic particles (pins, hands, mouse) come from the main thread;
      // the solver glides them to these targets during the step
      c.kinTargets = job.kin;
      // Fixed 60 Hz steps (a varying step size makes XPBD cloth jitter).
      // Normally one step per request.
      // Up to three steps to catch up after a late frame, as long as that
      // still fits in about a frame; beyond that time is dropped.
      const cap = c.stepMs && c.stepMs * 3 > 18 ? 2 : 3;
      c.dropped = (c.dropped || 0) + Math.max(0, c.acc + job.dt - cap * STEP);
      c.acc = Math.min(c.acc + job.dt, cap * STEP);
      let steps = 0;
      let simT = 0;
      while (c.acc >= STEP * 0.999 && steps < cap) {
        const ts = performance.now();
        c.step(STEP);
        if (slow > 1) {
          const until = performance.now() + (performance.now() - ts) * (slow - 1);
          while (performance.now() < until);
        }
        const ms = performance.now() - ts;
        c.stepMs = c.stepMs ? c.stepMs * 0.8 + ms * 0.2 : ms;
        c.acc -= STEP;
        steps++;
        simT += STEP;
      }
      if (!steps) continue;
      const res = result(job.id, c, steps, simT);
      out.push(res.r);
      transfer.push(...res.transfer);
    }
    budget(m.jobs);
    self.postMessage({ type: 'result', results: out, ms: performance.now() - t0 }, transfer);
  }
};
