// Runs cloth simulations off the main thread so rendering never waits on
// physics. Several of these workers run in parallel (one or more garments
// each). The main thread owns pins/grabs (kinematic particles) and colliders;
// this worker owns the dynamics.
import { Cloth } from './cloth.js';

const cloths = new Map();
const STEP = 1 / 60;

function result(id, c, steps, simT = 0) {
  c.computeNormals();
  const pos = new Float32Array(c.pos);
  const nrm = new Float32Array(c.normals);
  return { r: { id, pos, nrm, ke: c.kineticEnergy(), steps, simT }, transfer: [pos.buffer, nrm.buffer] };
}

self.onmessage = (e) => {
  const m = e.data;
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
      // Normally one step per request; two when catching up; anything
      // beyond that is dropped rather than snowballing.
      c.acc = Math.min(c.acc + job.dt, 2 * STEP);
      let steps = 0;
      let simT = 0;
      while (c.acc >= STEP * 0.999 && steps < 2) {
        const ts = performance.now();
        c.step(STEP);
        // adapt the substep count to this machine so a step always fits
        // comfortably inside a frame (fewer substeps = slightly stretchier)
        const ms = performance.now() - ts;
        c.stepMs = c.stepMs ? c.stepMs * 0.8 + ms * 0.2 : ms;
        if (c.stepMs > 9 && c.substeps > 6) {
          c.substeps--;
          c.stepMs = 0;
        } else if (c.stepMs < 5 && c.substeps < c.baseSubsteps) {
          c.substeps++;
          c.stepMs = 0;
        }
        c.acc -= STEP;
        steps++;
        simT += STEP;
      }
      if (!steps) continue;
      const res = result(job.id, c, steps, simT);
      out.push(res.r);
      transfer.push(...res.transfer);
    }
    self.postMessage({ type: 'result', results: out, ms: performance.now() - t0 }, transfer);
  }
};
