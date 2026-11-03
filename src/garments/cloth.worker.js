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
      // kinematic particles (pins, hands, mouse) come from the main thread
      const k = job.kin;
      for (let i = 0; i < k.length; i += 4) {
        const j = 3 * k[i];
        c.pos[j] = k[i + 1];
        c.pos[j + 1] = k[i + 2];
        c.pos[j + 2] = k[i + 3];
      }
      // Keep the cloth in real time. Normally that is one 60 Hz step per
      // request; if the machine falls behind we take up to three steps or
      // longer ones, rather than letting the fabric drift into slow motion.
      c.acc = Math.min(c.acc + job.dt, 0.1);
      let steps = 0;
      let simT = 0;
      if (c.acc >= STEP * 0.5) {
        steps = Math.min(3, Math.max(1, Math.round(c.acc / STEP)));
        const h = Math.min(c.acc / steps, 1 / 30);
        for (let s = 0; s < steps; s++) c.step(h);
        simT = h * steps;
        c.acc = Math.max(0, c.acc - h * steps);
        if (c.acc > 0.05) c.acc = 0;
      }
      if (!steps) continue;
      const res = result(job.id, c, steps, simT);
      out.push(res.r);
      transfer.push(...res.transfer);
    }
    self.postMessage({ type: 'result', results: out, ms: performance.now() - t0 }, transfer);
  }
};
