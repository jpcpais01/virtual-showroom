import * as THREE from 'three';

// Small procedural texture helpers (no external assets needed for the room).

function periodicNoise(size, cells, seed) {
  // tileable value noise lattice
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const lat = new Float32Array(cells * cells).map(() => rand());
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const g = (i, j) => lat[((j + cells) % cells) * cells + ((i + cells) % cells)];
      const a = g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx;
      const b = g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx;
      out[y * size + x] = a * (1 - sy) + b * sy;
    }
  }
  return out;
}

function fbm(size, seed, octaves = 5, base = 4) {
  const out = new Float32Array(size * size);
  let amp = 0.5, tot = 0;
  for (let o = 0; o < octaves; o++) {
    const n = periodicNoise(size, base << o, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

function canvasTex(size, fill, { srgb = true, repeat = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  fill(img.data, size);
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** polished micro-cement: albedo + roughness pair */
export function concrete({ base = [26, 27, 31], spread = 14, seed = 3, size = 512, repeat = 4 } = {}) {
  const n = fbm(size, seed, 6, 3);
  const speck = fbm(size, seed + 9, 2, 64);
  const albedo = canvasTex(
    size,
    (d) => {
      for (let i = 0; i < n.length; i++) {
        const v = (n[i] - 0.5) * spread + (speck[i] > 0.72 ? 6 : 0);
        d[4 * i] = base[0] + v;
        d[4 * i + 1] = base[1] + v;
        d[4 * i + 2] = base[2] + v * 1.05;
        d[4 * i + 3] = 255;
      }
    },
    { repeat },
  );
  const rough = canvasTex(
    size,
    (d) => {
      for (let i = 0; i < n.length; i++) {
        const r = 150 + (n[i] - 0.5) * 120 + (speck[i] - 0.5) * 40;
        d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = Math.max(0, Math.min(255, r));
        d[4 * i + 3] = 255;
      }
    },
    { srgb: false, repeat },
  );
  return { albedo, rough };
}

/** soft vertical gradient used for backlit panels */
export function gradientTex(stops, size = 256) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = size;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, size);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** speaker grille / perforated metal (alpha-ish greyscale) */
export function grille(size = 256, holes = 24) {
  return canvasTex(
    size,
    (d, s) => {
      const cell = s / holes;
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const cx = ((x % cell) - cell / 2) / cell;
          const cy = ((y % cell) - cell / 2) / cell;
          const v = Math.hypot(cx, cy) < 0.3 ? 8 : 34;
          const i = 4 * (y * s + x);
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
    },
    { repeat: 1 },
  );
}
