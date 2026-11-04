// Simulation mesh for a pair of KHORA crew socks, from the flat pattern in
// socks-pattern.json. Each sock is two knit layers (front/back) joined along
// the whole outline except the cuff, exactly like the tee is built: a flat
// lattice per layer, Delaunay-triangulated, with the outline vertices shared.

import Delaunator from 'delaunator';
import P from './socks-pattern.json';
import { FRONT, BACK, resample, bezier, pointInPoly, distToPolyline } from './teeMesh.js';

export function buildSocksPattern(h = 0.014) {
  const verts = [];
  const add = (x, y, panel, tag, sock) => {
    const [ox, oy, oz] = sock ? P.pairOffset : [0, 0, 0];
    // x/y: position in the flat layout; ux/uy: texture coordinates (both
    // socks share one texture); z0: depth offset (second sock hangs behind)
    verts.push({ x: x + ox, y: y + oy, ux: x, uy: y, z0: oz, panel, tag, sock });
    return verts.length - 1;
  };
  const O = P.outline;
  // seam: everything except the cuff, from the cuff's right corner round to its left corner
  const seamPoly = [
    ...O.legRight,
    ...bezier(O.heel[0], O.heel[1], O.heel[2], 14).slice(1),
    ...O.sole.slice(1),
    ...bezier(O.toe[0], O.toe[1], O.toe[2], 12).slice(1),
    ...bezier(O.instep[0], O.instep[1], O.instep[2], 10).slice(1),
    ...O.legFront.slice(1),
  ];
  const seam = resample(seamPoly, h);
  const cuff = resample([O.legFront[1], O.legRight[0]], h); // left -> right

  const panels = [];
  const loops = {};
  const hangerIds = [];
  for (const sock of [0, 1]) {
    const seamIds = seam.map(([x, y]) => add(x, y, -1, 'seam', sock));
    for (const panel of [FRONT, BACK]) {
      const ids = [];
      const ring = [];
      for (let i = 1; i < cuff.length - 1; i++) {
        ids.push(add(cuff[i][0], cuff[i][1], panel, 'cuff', sock));
        ring.push(cuff[i]);
      }
      for (const id of seamIds) {
        ids.push(id);
        ring.push([verts[id].ux, verts[id].uy]);
      }
      const interior = [];
      const dy = (h * Math.sqrt(3)) / 2;
      let row = 0;
      for (let y = 0.002; y > -0.35; y -= dy, row++) {
        const off = row % 2 ? h / 2 : 0;
        for (let x = -0.24 + off; x < 0.08; x += h) {
          if (!pointInPoly(x, y, ring)) continue;
          if (distToPolyline(x, y, [...ring, ring[0]]) < 0.55 * h) continue;
          interior.push(add(x, y, panel, 'in', sock));
        }
      }
      const all = [...ids, ...interior];
      const coords = new Float64Array(all.length * 2);
      all.forEach((id, k) => {
        coords[2 * k] = verts[id].ux;
        coords[2 * k + 1] = verts[id].uy;
      });
      const d = new Delaunator(coords);
      const tris = [];
      for (let t = 0; t < d.triangles.length; t += 3) {
        const a = all[d.triangles[t]], b = all[d.triangles[t + 1]], c = all[d.triangles[t + 2]];
        const va = verts[a], vb = verts[b], vc = verts[c];
        if (!pointInPoly((va.ux + vb.ux + vc.ux) / 3, (va.uy + vb.uy + vc.uy) / 3, ring)) continue;
        const maxE = Math.max(
          Math.hypot(va.ux - vb.ux, va.uy - vb.uy),
          Math.hypot(vb.ux - vc.ux, vb.uy - vc.uy),
          Math.hypot(vc.ux - va.ux, vc.uy - va.uy),
        );
        if (maxE > 2.2 * h) continue;
        const cross = (vb.ux - va.ux) * (vc.uy - va.uy) - (vb.uy - va.uy) * (vc.ux - va.ux);
        if ((panel === FRONT) === cross > 0) tris.push(a, b, c);
        else tris.push(a, c, b);
      }
      panels.push({ panel, ring, ids, tris });
    }
    // cuff opening loop: front cuff left->right, right corner, back cuff right->left, left corner
    const cf = verts.map((v, i) => (v.sock === sock && v.tag === 'cuff' && v.panel === FRONT ? i : -1)).filter((i) => i >= 0);
    const cb = verts.map((v, i) => (v.sock === sock && v.tag === 'cuff' && v.panel === BACK ? i : -1)).filter((i) => i >= 0);
    cf.sort((a, b) => verts[a].ux - verts[b].ux);
    cb.sort((a, b) => verts[b].ux - verts[a].ux);
    loops[`cuff${sock}`] = [seamIds.at(-1), ...cf, seamIds[0], ...cb];
    // the clip grips the middle of the cuff, both layers
    for (const id of [...cf, ...cb]) if (Math.abs(verts[id].ux) < 0.026) hangerIds.push(id);
  }
  return { verts, panels, loops, hangerIds, h, pattern: { window: P.window }, spec: P };
}
