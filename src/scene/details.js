import * as THREE from 'three';
import { ROOM, BLUE } from './room.js';
import { textTex } from './textures.js';

const BASE = import.meta.env.BASE_URL;

// Soft light shaft for a spot light seen through a little haze: an open cone,
// brightest along its axis and fading towards the floor. Additive, no depth
// write, a single cheap draw.
const shaftShader = {
  uniforms: { uColor: { value: new THREE.Color() }, uIntensity: { value: 1 }, uLen: { value: 1 } },
  vertexShader: /* glsl */ `
    uniform float uLen;
    varying float vAlong; varying vec3 vN; varying vec3 vV; varying float vY;
    void main(){
      vAlong = -position.y / uLen;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vY = wp.y;
      vN = normalize(mat3(modelMatrix) * normal);
      vV = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor; uniform float uIntensity;
    varying float vAlong; varying vec3 vN; varying vec3 vV; varying float vY;
    void main(){
      float edge = pow(abs(dot(normalize(vN), normalize(vV))), 3.0);
      float fall = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.4) * smoothstep(0.02, 0.3, vAlong);
      float a = edge * fall * smoothstep(0.0, 0.6, vY) * uIntensity;
      gl_FragColor = vec4(uColor * a, 1.0);
    }`,
};

function shaft(from, to, angle, color, intensity) {
  const len = from.distanceTo(to) * 1.05;
  const geo = new THREE.CylinderGeometry(0.05, Math.tan(angle) * len, len, 40, 1, true);
  geo.translate(0, -len / 2, 0);
  const mat = new THREE.ShaderMaterial({
    ...shaftShader,
    uniforms: THREE.UniformsUtils.clone(shaftShader.uniforms),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  mat.uniforms.uColor.value.set(color);
  mat.uniforms.uIntensity.value = intensity;
  mat.uniforms.uLen.value = len;
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(from);
  // cylinder's -Y axis -> towards the target
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from).normalize());
  m.renderOrder = 9;
  return m;
}

// Dust drifting through the light. Moves entirely in the vertex shader.
function dust(count, min, max, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(count * 3);
  const ph = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[3 * i] = min.x + rnd() * (max.x - min.x);
    pos[3 * i + 1] = min.y + rnd() * (max.y - min.y);
    pos[3 * i + 2] = min.z + rnd() * (max.z - min.z);
    ph[i] = rnd() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uLow: { value: min.y }, uSpan: { value: max.y - min.y } },
    vertexShader: /* glsl */ `
      uniform float uTime, uPx, uLow, uSpan; attribute float phase; varying float vA;
      void main(){
        vec3 p = position;
        float t = uTime * 0.05 + phase;
        p.x += sin(t * 1.7 + phase) * 0.25;
        p.z += cos(t * 1.3 + phase * 0.7) * 0.25;
        p.y = uLow + mod(p.y - uLow + uTime * 0.02 * (0.5 + fract(phase)), uSpan);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uPx * (1.0 + fract(phase * 3.1)) * 2.2 / -mv.z;
        vA = smoothstep(7.0, 1.5, -mv.z) * (0.35 + 0.65 * fract(phase * 7.3)) * smoothstep(0.0, 0.3, (p.y - uLow) / uSpan) * smoothstep(1.0, 0.7, (p.y - uLow) / uSpan);
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA;
        gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a * 0.35, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 8;
  return pts;
}

/**
 * Finishing details layered on the room: ceiling baffles and suspended
 * linear lights, wall fins, a halo over the display, light shafts and dust,
 * product plaques, the cash desk set dressing and a logo projected on the
 * floor at the entrance. Almost all of it is static and gets merged into a
 * handful of draw calls by the static batcher.
 */
export function buildDetails(scene, room, reflection) {
  const group = new THREE.Group();
  group.name = 'details';
  scene.add(group);
  const animated = [];
  const loader = new THREE.TextureLoader();

  const matte = new THREE.MeshStandardMaterial({ color: 0x0c0c0f, roughness: 0.75, metalness: 0.1 });
  // ceiling baffles: near-black so the ambient light doesn't turn them into a grey band
  const baffleMat = new THREE.MeshStandardMaterial({ color: 0x040405, roughness: 0.9, metalness: 0 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.4, metalness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd4d8e0, metalness: 1, roughness: 0.12 });
  const wire = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 1, roughness: 0.4 });

  // ------------------------------------------------------------ ceiling
  // open baffle ceiling over the shop floor (the stage keeps its truss)
  const cans = Object.values(room.lights).map((l) => l.position.x);
  const bz0 = -4.5, bz1 = ROOM.z1 - 0.1;
  const baffleGeo = new THREE.BoxGeometry(0.035, 0.22, bz1 - bz0);
  for (let x = ROOM.x0 + 0.35; x < ROOM.x1 - 0.3; x += 0.4) {
    if (cans.some((c) => Math.abs(c - x) < 0.13)) continue;
    const b = new THREE.Mesh(baffleGeo, baffleMat);
    b.position.set(x, ROOM.h - 0.11, (bz0 + bz1) / 2);
    group.add(b);
  }
  // suspended linear pendants under the baffles (replace flush strips)
  const diffWhite = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe4eaff).multiplyScalar(2.1) });
  const diffBlue = new THREE.MeshBasicMaterial({ color: BLUE.clone().multiplyScalar(3.2) });
  const housingGeo = new THREE.BoxGeometry(2.8, 0.045, 0.07);
  const diffGeo = new THREE.PlaneGeometry(2.76, 0.05);
  const wireGeo = new THREE.CylinderGeometry(0.0015, 0.0015, 0.32, 4);
  for (let i = 0; i < 7; i++) {
    const z = 5.5 - i * 1.9;
    const near = z < -3;
    for (const x of [-4.6, 0, 4.6]) {
      const y = ROOM.h - 0.36;
      const h = new THREE.Mesh(housingGeo, steel);
      h.position.set(x, y, z);
      group.add(h);
      const d = new THREE.Mesh(diffGeo, near ? diffBlue : diffWhite);
      d.rotation.x = Math.PI / 2;
      d.position.set(x, y - 0.0235, z);
      group.add(d);
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(wireGeo, wire);
        w.position.set(x + s * 1.2, y + 0.18, z);
        group.add(w);
      }
    }
  }

  // ------------------------------------------------------------ walls
  // black steel fins either side of the entrance and beside the LED wall
  const finGeo = new THREE.BoxGeometry(0.04, ROOM.h - 0.25, 0.14);
  const fin = (x, z, rot = 0) => {
    const f = new THREE.Mesh(finGeo, steel);
    f.position.set(x, (ROOM.h - 0.25) / 2 + 0.06, z);
    f.rotation.y = rot;
    group.add(f);
  };
  for (let x = ROOM.x0 + 0.5; x < ROOM.x1 - 0.4; x += 0.32) {
    if (Math.abs(x) < 1.75) continue; // doors
    fin(x, ROOM.z1 - 0.08);
  }
  for (let x = 4.0; x < ROOM.x1 - 0.4; x += 0.32) {
    fin(x, ROOM.z0 + 0.08);
    fin(-x, ROOM.z0 + 0.08);
  }
  // steel skirting band
  const skirtGeo = new THREE.BoxGeometry(1, 0.1, 0.012);
  const skirtBand = (len, x, z, ry) => {
    const m = new THREE.Mesh(skirtGeo, steel);
    m.scale.x = len;
    m.position.set(x, 0.1, z);
    m.rotation.y = ry;
    group.add(m);
  };
  skirtBand(ROOM.z1 - ROOM.z0 - 0.2, ROOM.x0 + 0.012, (ROOM.z0 + ROOM.z1) / 2, Math.PI / 2);
  skirtBand(ROOM.z1 - ROOM.z0 - 0.2, ROOM.x1 - 0.012, (ROOM.z0 + ROOM.z1) / 2, Math.PI / 2);

  // ------------------------------------------------------------ hero display
  const heroC = new THREE.Vector3(0, 0, 1.2);
  // halo ring over the display, hung on three wires
  const haloY = 3.35;
  const haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe8eeff).multiplyScalar(2.4) });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.011, 10, 120), haloMat);
  halo.rotation.x = Math.PI / 2;
  halo.position.set(heroC.x, haloY, heroC.z);
  group.add(halo);
  const haloBack = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.016, 8, 120, Math.PI * 2), steel);
  haloBack.rotation.x = Math.PI / 2;
  haloBack.position.set(heroC.x, haloY + 0.014, heroC.z);
  group.add(haloBack);
  const haloWire = new THREE.CylinderGeometry(0.0015, 0.0015, ROOM.h - haloY, 4);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
    const w = new THREE.Mesh(haloWire, wire);
    w.position.set(heroC.x + Math.cos(a) * 0.62, haloY + (ROOM.h - haloY) / 2, heroC.z + Math.sin(a) * 0.62);
    group.add(w);
  }
  const haloBase = new THREE.Color(0xe8eeff);
  animated.push((info) => haloMat.color.copy(haloBase).multiplyScalar(2.2 + info.kick * 0.5 * info.energy));
  // chrome trim around the plinth top
  const trim = new THREE.Mesh(new THREE.BoxGeometry(2.42, 0.012, 1.22), chrome);
  trim.position.set(heroC.x, 0.326, heroC.z);
  group.add(trim);
  // plaque on the plinth front
  const plaqueTex = textTex(
    [
      { text: 'HEART TEE', size: 54, weight: 600, spacing: 0.32 },
      { text: 'KHORA  ·  DROP 01', size: 26, weight: 500, spacing: 0.5, alpha: 0.65, gap: 18 },
    ],
    1024,
    200,
  );
  const plaque = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.121),
    new THREE.MeshBasicMaterial({ map: plaqueTex, transparent: true, color: new THREE.Color(0.85, 0.88, 0.95), depthWrite: false }),
  );
  plaque.position.set(heroC.x, 0.17, heroC.z + 0.602);
  group.add(plaque);

  // ------------------------------------------------------------ rail niche
  // product names under the pieces, printed on the backdrop
  const names = [
    ['HEART TEE', -2.0],
    ['THORN SOCKS', -1.0],
    ['HEART TEE', 0.0],
  ];
  for (const [text, z] of names) {
    const t = textTex([{ text, size: 44, weight: 600, spacing: 0.3 }, { text: 'KHORA · DROP 01', size: 22, weight: 500, spacing: 0.45, alpha: 0.65, gap: 12 }], 512, 120);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.145),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, color: new THREE.Color(1.1, 1.15, 1.3), depthWrite: false }),
    );
    m.position.set(ROOM.x0 + 0.03, 0.95, z);
    m.rotation.y = Math.PI / 2;
    group.add(m);
  }

  // ------------------------------------------------------------ light shafts + dust
  const key = room.lights.key;
  group.add(shaft(key.position.clone(), key.target.position.clone().add(new THREE.Vector3(-0.3, -1.6, -0.6)), 0.27, 0xfff4ea, 0.035));
  const motes = dust(420, new THREE.Vector3(-2.2, 0.3, -0.6), new THREE.Vector3(2.4, 4.2, 4.6), 7);
  group.add(motes);
  const motes2 = dust(160, new THREE.Vector3(ROOM.x0 + 0.5, 0.3, -3.6), new THREE.Vector3(ROOM.x0 + 3.2, 4.2, 1.6), 3);
  group.add(motes2);
  animated.push((info, t) => {
    motes.material.uniforms.uTime.value = t;
    motes2.material.uniforms.uTime.value = t;
  });

  // ------------------------------------------------------------ cash desk
  const deskX = ROOM.x1 - 1.6, deskZ = -0.3, deskTop = 1.06;
  // POS tablet on a stand, screen facing the shop
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.12, 20), chrome);
  stand.position.set(deskX - 0.12, deskTop + 0.06, deskZ + 0.55);
  group.add(stand);
  const tablet = new THREE.Group();
  tablet.position.set(deskX - 0.12, deskTop + 0.17, deskZ + 0.55);
  tablet.rotation.set(0, -Math.PI / 2, 0);
  tablet.rotateX(-0.35);
  group.add(tablet);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.012), steel);
  tablet.add(slab);
  const scrTex = textTex([{ text: 'KHORA', size: 70, weight: 600, spacing: 0.3 }, { text: 'WELCOME', size: 22, weight: 500, spacing: 0.6, alpha: 0.7, gap: 14 }], 512, 340, '#0a3fd6');
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.16), new THREE.MeshBasicMaterial({ map: scrTex, color: new THREE.Color(1.3, 1.3, 1.3) }));
  scr.position.z = 0.0065;
  tablet.add(scr);
  // shopping bags: matte black with the wordmark, rope handles
  const wm = loader.load(BASE + 'textures/wordmark.png');
  wm.colorSpace = THREE.SRGBColorSpace;
  const bagMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.85 });
  const wordMat = new THREE.MeshBasicMaterial({ map: wm, transparent: true, color: new THREE.Color(0.9, 0.92, 0.98), depthWrite: false });
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.6 });
  const bag = (x, z, ry, s) => {
    const g = new THREE.Group();
    g.position.set(x, deskTop, z);
    g.rotation.y = ry;
    g.scale.setScalar(s);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.36, 0.12), bagMat);
    body.position.y = 0.18;
    g.add(body);
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2 * (97 / 492)), wordMat);
    w.position.set(0, 0.2, 0.0605);
    g.add(w);
    for (const zz of [-0.045, 0.045]) {
      const h = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.004, 6, 20, Math.PI), ropeMat);
      h.position.set(0, 0.36, zz);
      g.add(h);
    }
    group.add(g);
  };
  bag(deskX + 0.05, deskZ - 0.7, -Math.PI / 2 + 0.15, 1);
  bag(deskX + 0.18, deskZ - 0.45, -Math.PI / 2 - 0.2, 0.85);
  // a chrome sphere on a black column: reflects the whole room
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 24), matte);
  col.position.set(deskX + 0.1, deskTop + 0.08, deskZ + 1.0);
  group.add(col);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.075, 32, 24), chrome);
  ball.position.set(deskX + 0.1, deskTop + 0.235, deskZ + 1.0);
  group.add(ball);

  // two small pendants over the desk, with the pool of light they throw
  // (painted on, so the desk doesn't cost another real light)
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1e0).multiplyScalar(3) });
  const poolTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,240,220,0.42)');
    grd.addColorStop(0.5, 'rgba(255,240,220,0.18)');
    grd.addColorStop(1, 'rgba(255,240,220,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const dz of [-0.55, 0.55]) {
    const lampY = 1.95;
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.2, 28, 1, true), steel);
    shade.position.set(deskX, lampY, deskZ + dz);
    group.add(shade);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.01, 28), steel);
    cap.position.set(deskX, lampY + 0.1, deskZ + dz);
    group.add(cap);
    const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.1, 28), lampMat);
    bulb.rotation.x = Math.PI / 2;
    bulb.position.set(deskX, lampY - 0.095, deskZ + dz);
    group.add(bulb);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, ROOM.h - lampY - 0.1, 4), wire);
    cord.position.set(deskX, (ROOM.h + lampY + 0.1) / 2, deskZ + dz);
    group.add(cord);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(deskX, deskTop + 0.002, deskZ + dz);
    pool.renderOrder = 3;
    group.add(pool);
  }

  // ------------------------------------------------------------ entrance
  // the monogram projected onto the floor just inside the doors
  const mono = loader.load(BASE + 'textures/monogram.png');
  mono.colorSpace = THREE.SRGBColorSpace;
  const gobo = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.42 * (720 / 333)),
    new THREE.MeshBasicMaterial({ map: mono, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(0x3a6bff).multiplyScalar(0.9), fog: false }),
  );
  gobo.rotation.x = -Math.PI / 2;
  gobo.position.set(0, 0.004, ROOM.z1 - 2.1);
  gobo.renderOrder = 2;
  group.add(gobo);
  reflection.hidden.push(gobo);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.635, 96),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3a6bff).multiplyScalar(0.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(gobo.position);
  ring.renderOrder = 2;
  group.add(ring);
  reflection.hidden.push(ring);

  return {
    group,
    update(info, t) {
      for (const f of animated) f(info, t);
    },
    setPixelRatio(pr) {
      motes.material.uniforms.uPx.value = pr * innerHeight * 0.0016;
      motes2.material.uniforms.uPx.value = pr * innerHeight * 0.0016;
    },
  };
}
