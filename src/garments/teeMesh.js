// Builds the simulation mesh for the tee from its flat sewing pattern.
//
// Two panels (front, back) are meshed in 2D with a triangular lattice and a
// Delaunay triangulation. Seam edges (shoulders/sleeve tops, underarms/sides)
// are sampled once and shared by both panels, which is exactly how the garment
// is sewn: the shirt becomes a closed tube with openings at neck, cuffs and hem.

import Delaunator from 'delaunator';
import P from './tee-pattern.json';

const FRONT = 0;
const BACK = 1;

function lerp2(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function bezier(p0, c, p1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([
      (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
      (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1],
    ]);
  }
  return out;
}

function neckCurve(depth, n = 40) {
  // centre (0,-depth) -> side neck point N (quarter ellipse)
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (Math.PI / 2) * (1 - i / n);
    out.push([P.N[0] * Math.cos(t), -depth * Math.sin(t)]);
  }
  return out;
}

// resample a polyline at ~h spacing; returns points including both ends
function resample(poly, h) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const l = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    seg.push(l);
    total += l;
  }
  const n = Math.max(1, Math.round(total / h));
  const out = [];
  let si = 0;
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    const d = (total * k) / n;
    while (si < seg.length - 1 && acc + seg[si] < d) {
      acc += seg[si];
      si++;
    }
    const t = seg[si] > 0 ? (d - acc) / seg[si] : 0;
    out.push(lerp2(poly[si], poly[si + 1], Math.min(1, Math.max(0, t))));
  }
  return out;
}

const mirror = (poly) => poly.map(([x, y]) => [-x, y]).reverse();

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPolyline(x, y, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

/**
 * @param {number} h target particle spacing in metres
 */
export function buildTeePattern(h = 0.028) {
  const verts = []; // {x, y, panel (FRONT/BACK/-1 shared), seam?}
  const addVert = (x, y, panel, tag) => {
    verts.push({ x, y, panel, tag });
    return verts.length - 1;
  };

  // ---- shared seams (right side, then mirrored) ----
  const shoulderR = resample([P.N, P.S, P.T], h); // N -> T
  const underR = resample([...bezier(P.U, P.underarmCtrl, P.A, 12), P.H], h); // U -> H
  const seamIds = {};
  const mkSeam = (poly, tag) => poly.map(([x, y]) => addVert(x, y, -1, tag));
  seamIds.shoulderR = mkSeam(shoulderR, 'shoulder');
  seamIds.underR = mkSeam(underR, 'side');
  seamIds.shoulderL = mkSeam(mirror(shoulderR), 'shoulder'); // -T -> -N
  seamIds.underL = mkSeam(mirror(underR), 'side'); // -H -> -U

  const panels = [];
  for (const panel of [FRONT, BACK]) {
    const depth = panel === FRONT ? P.frontNeck : P.backNeck;
    const tagOpen = (t) => t;
    const neckR = resample(neckCurve(depth), h); // centre -> N
    const cuffR = resample([P.T, P.U], h); // T -> U
    const hemR = resample([P.H, [0, P.hemY]], h); // H -> centre hem
    const ids = [];
    const ring = []; // [x,y] polygon for inside test
    const pushOpen = (poly, tag, skipFirst, skipLast) => {
      const a = skipFirst ? 1 : 0;
      const b = skipLast ? poly.length - 1 : poly.length;
      for (let i = a; i < b; i++) {
        ids.push(addVert(poly[i][0], poly[i][1], panel, tagOpen(tag)));
        ring.push(poly[i]);
      }
    };
    const pushSeam = (list) => {
      for (const id of list) {
        ids.push(id);
        ring.push([verts[id].x, verts[id].y]);
      }
    };
    // go around: neck centre -> N (open) | shoulder N->T | cuff T->U | under U->H | hem H->centre->-H | under -H->-U | cuff | shoulder -T->-N | neck -N -> centre
    pushOpen(neckR, 'neck', false, true);
    pushSeam(seamIds.shoulderR);
    pushOpen(cuffR, 'cuffR', true, true);
    pushSeam(seamIds.underR);
    const hemFull = resample([P.H, [-P.H[0], P.H[1]]], h);
    pushOpen(hemFull, 'hem', true, true);
    pushSeam(seamIds.underL);
    pushOpen(mirror(cuffR), 'cuffL', true, true);
    pushSeam(seamIds.shoulderL);
    pushOpen(mirror(neckR), 'neck', true, true); // -N .. centre excluded (it's the first vertex)
    void hemR;

    // interior lattice
    const interior = [];
    const dy = h * Math.sqrt(3) / 2;
    let row = 0;
    for (let y = 0.05; y > P.hemY - 0.01; y -= dy, row++) {
      const off = row % 2 ? h / 2 : 0;
      for (let x = -0.6 + off; x < 0.6; x += h) {
        if (!pointInPoly(x, y, ring)) continue;
        if (distToPolyline(x, y, [...ring, ring[0]]) < 0.55 * h) continue;
        interior.push(addVert(x, y, panel, 'in'));
      }
    }
    const all = [...ids, ...interior];
    const coords = new Float64Array(all.length * 2);
    all.forEach((id, k) => {
      coords[2 * k] = verts[id].x;
      coords[2 * k + 1] = verts[id].y;
    });
    const d = new Delaunator(coords);
    const tris = [];
    for (let t = 0; t < d.triangles.length; t += 3) {
      const a = all[d.triangles[t]];
      const b = all[d.triangles[t + 1]];
      const c = all[d.triangles[t + 2]];
      const va = verts[a], vb = verts[b], vc = verts[c];
      const cx = (va.x + vb.x + vc.x) / 3;
      const cy = (va.y + vb.y + vc.y) / 3;
      if (!pointInPoly(cx, cy, ring)) continue;
      const maxE = Math.max(
        Math.hypot(va.x - vb.x, va.y - vb.y),
        Math.hypot(vb.x - vc.x, vb.y - vc.y),
        Math.hypot(vc.x - va.x, vc.y - va.y),
      );
      if (maxE > 2.2 * h) continue;
      // orient: front faces +z (ccw in xy), back faces -z (cw)
      const cross = (vb.x - va.x) * (vc.y - va.y) - (vb.y - va.y) * (vc.x - va.x);
      const ccw = cross > 0;
      if ((panel === FRONT) === ccw) tris.push(a, b, c);
      else tris.push(a, c, b);
    }
    panels.push({ panel, ring, ids, tris });
  }

  // loops of open edges, used for the rolled hem / rib collar rims
  const byTag = (tag, panel) => panels[panel].ids.filter((id) => verts[id].tag === tag);
  const neckFront = byTag('neck', FRONT); // order: centre->N , then -N->centre(excl) (as pushed)
  const neckBack = byTag('neck', BACK);

  const findNearest = (x, y, filter = () => true) => {
    let best = -1;
    let bd = Infinity;
    verts.forEach((v, i) => {
      if (!filter(v)) return;
      const dd = Math.hypot(v.x - x, v.y - y);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best;
  };

  // rim loops as ordered vertex lists around each opening
  const loops = {
    neck: orderedLoop(neckFront, neckBack, verts, seamIds, 'neck'),
    cuffR: [seamIds.shoulderR.at(-1), ...byTag('cuffR', FRONT), seamIds.underR[0], ...byTag('cuffR', BACK).reverse()],
    cuffL: [seamIds.underL.at(-1), ...byTag('cuffL', FRONT), seamIds.shoulderL[0], ...byTag('cuffL', BACK).reverse()],
    hem: [seamIds.underR.at(-1), ...byTag('hem', FRONT), seamIds.underL[0], ...byTag('hem', BACK).reverse()],
  };

  return {
    verts,
    panels,
    seamIds,
    loops,
    h,
    pattern: P,
    holdIds: [findNearest(P.S[0], P.S[1], (v) => v.panel === -1), findNearest(-P.S[0], P.S[1], (v) => v.panel === -1)],
    hangerIds: verts
      .map((v, i) => (v.tag === 'shoulder' && Math.abs(v.x) <= 0.215 ? i : -1))
      .filter((i) => i >= 0),
    labelAnchor: findNearest(0, -P.backNeck - 0.02, (v) => v.panel === BACK),
    labelAnchorUp: findNearest(0, -P.backNeck, (v) => v.panel === BACK),
    labelAnchorSide: findNearest(0.03, -P.backNeck - 0.02, (v) => v.panel === BACK),
  };
}

function orderedLoop(neckFront, neckBack, verts, seamIds) {
  // front neck was pushed centre->N(excl) then (-N excl)..; re-sort by angle
  // around the neck centre so the loop is ordered continuously.
  const N = seamIds.shoulderR[0];
  const NL = seamIds.shoulderL.at(-1);
  const sortByX = (ids, dir) => [...ids].sort((a, b) => dir * (verts[a].x - verts[b].x));
  const front = sortByX(neckFront, 1); // -x .. +x
  const back = sortByX(neckBack, -1); // +x .. -x
  return [NL, ...front, N, ...back];
}

export { FRONT, BACK, resample, bezier, pointInPoly, distToPolyline };
