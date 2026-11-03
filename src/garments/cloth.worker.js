// Runs every garment's cloth simulation off the main thread so rendering
// never waits on physics. The main thread owns pins/grabs (kinematic
// particles) and colliders; this worker owns the dynamics.
import { Cloth } from './cloth.js';

const cloths = new Map();
const STEP = 1 / 60;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'add') {
    const c = new Cloth(m.init);
    c.pos.set(m.state.pos);
    c.prev.set(m.state.pos);
    c.vel.set(m.state.vel);
    Object.assign(c, m.params);
    c.acc = 0;
    cloths.set(m.id, c);
    return;
  }
  if (m.type === 'step') {
    const out = [];
    const transfer = [];
    for (const job of m.jobs) {
      const c = cloths.get(job.id);
      if (!c) continue;
      c.invMass.set(job.invMass);
      c.colliders = job.colliders;
      c.wind = job.wind;
      c.colliderFriction = job.colliderFriction;
      // kinematic particles (pins, hands, mouse) come from the main thread
      const k = job.kin;
      for (let i = 0; i < k.length; i += 4) {
        const j = 3 * k[i];
        c.pos[j] = k[i + 1];
        c.pos[j + 1] = k[i + 2];
        c.pos[j + 2] = k[i + 3];
      }
      // fixed 60 Hz physics, at most two steps per request
      c.acc = Math.min(c.acc + job.dt, 2 * STEP);
      let steps = 0;
      while (c.acc >= STEP - 1e-6 && steps < 2) {
        c.step(STEP);
        c.acc -= STEP;
        steps++;
      }
      c.computeNormals();
      const pos = new Float32Array(c.pos);
      const nrm = new Float32Array(c.normals);
      out.push({ id: job.id, pos, nrm, ke: c.kineticEnergy(), steps });
      transfer.push(pos.buffer, nrm.buffer);
    }
    self.postMessage({ type: 'result', results: out }, transfer);
  }
};
