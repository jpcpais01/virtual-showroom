import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { buildRoom, ROOM } from './scene/room.js';
import { buildStage } from './scene/stage.js';
import { buildDetails } from './scene/details.js';
import { FloorReflection } from './scene/reflection.js';
import { batchStatic } from './scene/batch.js';
import { Tee } from './garments/tee.js';
import { clothPool, stat as clothStat } from './garments/clothPool.js';
import { RaveAudio } from './audio.js';
import { WalkControls } from './controls.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
let quality = params.has('low') ? 0.5 : isMobile ? 0.7 : 1;

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// Render resolution is the biggest GPU cost: cap at 1.5x (retina-sharp with
// the post chain) and only multisample when we are not already supersampling.
const pixelRatio = Math.min(devicePixelRatio, quality < 1 ? 1 : 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020308);
scene.fog = new THREE.FogExp2(0x03050c, 0.032);

const BASE_FOV = 56;
const FOCUS_FOV = 42; // a longer "lens" when looking at a piece: flatter, more like a product shot
const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.03, 60);

// ---------------------------------------------------------------- loading
const progressEl = document.getElementById('progress');
const progressPct = document.getElementById('progressPct');
let progressShown = 0;
function setProgress(p) {
  progressShown = Math.max(progressShown, Math.round(p));
  progressEl.style.width = `${progressShown}%`;
  progressPct.textContent = progressShown;
}
THREE.DefaultLoadingManager.onProgress = (_u, loaded, total) => setProgress((loaded / total) * 65);
const texturesReady = new Promise((res) => (THREE.DefaultLoadingManager.onLoad = res));

// ---------------------------------------------------------------- world
const reflection = new FloorReflection(quality < 1 ? 0.25 : 0.35);
const room = buildRoom(scene, reflection);
const stage = buildStage(scene);
const details = buildDetails(scene, room, reflection);

// solid things the cloth must not pass through when you pull or carry it
{
  const z0 = ROOM.z0;
  Tee.environment = [
    [[-50, -1, -50], [ROOM.x0 + 0.42, 10, 50]], // left wall + niche frame
    [[ROOM.x1 - 0.02, -1, -50], [50, 10, 50]],
    [[-50, -1, -50], [50, 10, z0 + 0.12]],
    [[-50, -1, ROOM.z1 - 0.02], [50, 10, 50]],
    [[-50, ROOM.h - 0.02, -50], [50, 20, 50]],
    [[-1.2, -1, 0.6], [1.2, 0.32, 1.8]], // hero plinth
    [[-4.2, -1, z0], [4.2, 0.4, z0 + 3.4]], // stage
    [[-1.2, -1, z0 + 1.48], [1.2, 1.5, z0 + 2.32]], // DJ booth + gear
    [[ROOM.x1 - 2.03, -1, -1.53], [ROOM.x1 - 1.17, 1.06, 0.93]], // cash desk
  ].map(([min, max]) => ({ type: 'box', min, max }));
}
// product copy for the panel (names and specs are placeholders to confirm)
const PRODUCTS = {
  tee: {
    eyebrow: 'KHORA · Drop 01',
    title: 'Heart Tee',
    colour: 'White / Royal blue',
    swatch: 'white',
    bullets: ['Oversized, dropped shoulder', 'Embroidered K♡ monogram on the chest', 'Royal blue thorn-heart print on the back', 'Woven KHORA neck label', 'Cotton jersey, rib collar'],
    specs: [['Fit', 'Oversized'], ['Fabric', 'Cotton'], ['Colour', 'White']],
    focusDist: 1.75,
    centreDrop: 0.36,
    holdDist: 1.05,
    holdY: 0.3,
  },
  socks: {
    eyebrow: 'KHORA · Drop 01',
    title: 'Thorn Socks',
    colour: 'Black / Royal blue',
    swatch: 'black',
    bullets: ['Ribbed crew length', 'Royal blue thorn jacquard around the calf', 'KHORA knitted into the sole', 'Cushioned cotton knit', 'Sold as a pair'],
    specs: [['Length', 'Crew'], ['Knit', 'Rib'], ['Colour', 'Black']],
    focusDist: 0.75,
    centreDrop: 0.17,
    holdDist: 0.72,
    holdY: 0.15,
  },
};
const tees = [];
const hero = new Tee({ renderer, hangerMatrix: room.heroHanger, name: 'hero', quality, product: PRODUCTS.tee });
scene.add(hero.group);
tees.push(hero);
for (const [i, m] of room.nicheHangers.entries()) {
  const t = new Tee({ renderer, hangerMatrix: m, name: `rail-${i}`, quality, product: PRODUCTS.tee });
  scene.add(t.group);
  tees.push(t);
}
// the socks hang on the same rail, between the two shirts
{
  const a = new THREE.Vector3().setFromMatrixPosition(room.nicheHangers[0]);
  const b = new THREE.Vector3().setFromMatrixPosition(room.nicheHangers[1]);
  const m = room.nicheHangers[0].clone();
  const mid = a.add(b).multiplyScalar(0.5);
  // centre the pair on the hook (the hanger origin is at the first sock)
  const side = new THREE.Vector3(1, 0, 0).transformDirection(m);
  mid.addScaledVector(side, -0.05);
  m.setPosition(mid);
  const socks = new Tee({ renderer, hangerMatrix: m, name: 'socks', quality, kind: 'socks', product: PRODUCTS.socks });
  scene.add(socks.group);
  tees.push(socks);
}
// the DJ wears one too, simulated against the mannequin's body
const dj = stage.dj;
stage.group.updateMatrixWorld(true);
dj.pose = 0;
dj.update(0, { kick: 0, phase: 0, section: 'groove' }, { y: 1.04 });
dj.group.updateMatrixWorld(true);
const djFrame = () => new THREE.Matrix4().copy(dj.upper.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(0, 1.478, 0));
const djTee = new Tee({
  renderer,
  hangerMatrix: djFrame(),
  name: 'dj',
  quality: 0.5,
  worn: {
    depth: 0.17,
    colliders: () => {
      dj.group.updateMatrixWorld(true);
      return dj.colliders();
    },
    beforeStep: (i) => {
      // after the shirt settles on the A-posed body, bring the arms to the decks
      dj.pose = Math.min(1, Math.max(0, (i - 70) / 80));
      dj.update(1 / 60, { kick: 0, phase: 0, section: 'groove' }, { y: 1.04 });
    },
  },
});
djTee.label.visible = false;
scene.add(djTee.group);
const grabbables = tees;

// merge everything that never moves into one draw call per material
if (!params.has('nobatch')) {
  const sections = ['groove', 'build', 'break', 'drop'];
  const res = batchStatic(scene, [room.group, stage.group, details.group], {
    exclude: [room.floor, dj.group],
    probe: (k) => {
      const info = { t: k * 0.73 + 0.1, beat: k, bar: k, phase: (k * 0.37) % 1, section: sections[k % 4], kick: (k % 3) / 2, snare: k % 2, buildUp: (k % 5) / 5, bpm: 126, energy: [0.6, 0.75, 0.35, 1][k % 4] };
      stage.update(1 / 60, info);
      room.update(info);
    },
  });
  if (params.has('debug')) console.log('static batching', res);
}

// environment reflections for chrome / glossy surfaces, captured once
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(scene, 0.03, 0.1, 40, { position: new THREE.Vector3(0, 1.8, 0) }).texture;
scene.environmentIntensity = 0.45;

// ---------------------------------------------------------------- post
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: pixelRatio > 1.25 ? 0 : 4 }),
);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.5, 0.5, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVig: { value: 0.62 }, uRes: { value: new THREE.Vector2() } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVig; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      // a touch of lens fringing towards the corners (none in the middle)
      vec2 off = d * r2 * 0.007;
      vec3 c = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
      // gentle S-curve: deeper blacks, a little more punch in the mids
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      c *= mix(1.0, uVig, smoothstep(0.2, 0.95, r2 * 2.2));
      c += (h(vUv * 1000.0) - 0.5) * 0.016;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(grade);

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  reflection.setSize(w * pr, h * pr);
  grade.uniforms.uRes.value.set(w, h);
  details.setPixelRatio(pr);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- audio
const audio = new RaveAudio();

// ---------------------------------------------------------------- controls & interaction
const spots = {
  entrance: { pos: new THREE.Vector3(0, 1.65, 5.6), yaw: 0, pitch: -0.04 },
  hero: { pos: new THREE.Vector3(0, 1.62, 3.15), yaw: 0, pitch: -0.02 },
  rail: { pos: new THREE.Vector3(ROOM.x0 + 2.9, 1.62, -1.0), yaw: Math.PI / 2, pitch: -0.02 },
  booth: { pos: new THREE.Vector3(0, 1.7, -2.1), yaw: 0, pitch: 0.06 },
};
const colliders = [...room.colliders, ...stage.colliders];
const controls = new WalkControls(camera, canvas, { bounds: ROOM, colliders, start: spots[params.get('spot')] || spots.entrance });
// desktop: hidden cursor, the mouse turns the view (pointer lock). The cursor
// comes back whenever a product panel is open or Esc is pressed.
controls.mouseLook = !isMobile && matchMedia('(pointer: fine)').matches && !params.has('nolock');
controls.onUnlockedClick = () => {
  if (focused) return false;
  controls.lock();
  return true;
};
const reticle = document.getElementById('reticle');
if (!controls.mouseLook) {
  const ih = $('introHint');
  ih.textContent = isMobile ? 'Drag to look around · tap the floor to walk · tap a piece to inspect it' : 'Drag to look around · WASD or click the floor to walk · Click a piece to inspect it';
  ih.hidden = false;
  $('introKeys').hidden = true;
}
controls.onLockChange = (locked) => {
  reticle.hidden = !locked;
  if (locked) hint('Move the mouse to look · WASD to walk · click a shirt · Esc for the cursor', 5000);
  else if (!focused && controls.enabled && controls.mouseLook) hint('Click anywhere to look around');
};

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let focused = null; // Tee
let held = null; // Tee
let holdYaw = 0;
let holdYawTarget = 0;
let holdDist = 1.05;
let grab = null; // {tee, plane}

function pick(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const meshes = grabbables.map((t) => t.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits[0] || null;
}

function teeFocusSpot(tee) {
  // stand in front of the garment (closer for small pieces), looking at it
  const pr = tee.product || PRODUCTS.tee;
  const front = new THREE.Vector3(0, 0, 1).transformDirection(tee.hangerMatrix);
  const c = new THREE.Vector3().setFromMatrixPosition(tee.hangerMatrix);
  const pos = c.clone().addScaledVector(front, pr.focusDist);
  pos.y = 1.62;
  const cy = c.y - pr.centreDrop;
  const pitch = THREE.MathUtils.clamp(Math.atan2(cy - 1.62, pr.focusDist), -0.3, 0.35);
  // with the product panel on the right, turn a little so the piece sits in
  // the middle of the free space to its left
  let yaw = Math.atan2(-front.x, -front.z) + Math.PI;
  if (innerWidth > 720) {
    const focal = innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(FOCUS_FOV / 2));
    yaw -= Math.atan(170 / focal);
  }
  return { pos, yaw, pitch, lookAt: c.clone().setY(cy) };
}

function showProduct(pr) {
  panel.querySelector('.panel__eyebrow').textContent = pr.eyebrow;
  $('panelSpecs').replaceChildren(
    ...(pr.specs || []).map(([k, v]) => {
      const d = document.createElement('div');
      d.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
      return d;
    }),
  );
  panel.querySelector('.panel__title').textContent = pr.title;
  panel.querySelector('.panel__colour').innerHTML = `<span class="swatch swatch--${pr.swatch}"></span> ${pr.colour}`;
  const ul = panel.querySelector('.panel__list');
  ul.replaceChildren(...pr.bullets.map((b) => Object.assign(document.createElement('li'), { textContent: b })));
}

controls.onTap = (ev) => {
  const hit = pick(ev);
  if (hit && !held) {
    focus(hit.object.userData.tee);
    return true;
  }
  return false;
};

controls.onDragStart = (ev) => {
  const hit = pick(ev);
  if (!hit) return false;
  const tee = hit.object.userData.tee;
  const id = tee.particleFromHit(hit);
  const n = new THREE.Vector3();
  camera.getWorldDirection(n);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.negate(), hit.point);
  tee.grab(id, hit.point);
  grab = { tee, plane };
  canvas.classList.add('is-dragging');
  hint(held ? 'Pulling the fabric — let go to drop it' : 'Pulling the fabric');
  return true;
};
controls.onDragMove = (ev) => {
  if (!grab) return false;
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(grab.plane, p)) grab.tee.drag(p);
  return true;
};
controls.onDragEnd = () => {
  if (!grab) return false;
  grab.tee.release();
  grab = null;
  canvas.classList.remove('is-dragging');
  hint(null);
  return true;
};
// while holding a garment, dragging the background turns it in your hands
controls.onLookDrag = (dx) => {
  if (!held) return false;
  holdYawTarget += dx * 0.008;
  return true;
};
controls.onWheel = (dy) => {
  if (!held) return false;
  holdDist = THREE.MathUtils.clamp(holdDist + dy * 0.0008, 0.35, 1.6);
  return true;
};
// hover test at most once per frame
let hoverEv = null;
canvas.addEventListener('pointermove', (ev) => {
  if (grab || ev.buttons || ev.pointerType === 'touch' || controls.locked) return;
  if (!hoverEv) requestAnimationFrame(() => {
    canvas.classList.toggle('is-hover', !!pick(hoverEv));
    hoverEv = null;
  });
  hoverEv = ev;
});

// ---------------------------------------------------------------- UI
const panel = $('panel');
const pickBtn = $('pickBtn');
const turnBtn = $('turnBtn');
const panelHint = $('panelHint');
const setPickLabel = (t) => ($('pickLabel').textContent = t);
// one entry per product, in the order the pager walks through them
const pieces = [hero, ...tees.filter((t) => t.kind === 'socks')];
function stepPiece(dir) {
  if (!pieces.length) return;
  const cur = focused ? pieces.findIndex((p) => p.product === focused.product) : -1;
  const next = pieces[(cur + dir + pieces.length) % pieces.length];
  if (held) putBack();
  focus(next);
}
$('prevPiece').onclick = () => stepPiece(-1);
$('nextPiece').onclick = () => stepPiece(1);

// ---- area nav: a pill slides under the area you are in
const navBtns = [...document.querySelectorAll('[data-goto]')];
const navPill = document.createElement('span');
navPill.className = 'hud__pill';
document.querySelector('.hud__nav').prepend(navPill);
let navActive = null;
function setActiveNav(key) {
  navActive = key;
  const b = navBtns.find((x) => x.dataset.goto === key);
  for (const x of navBtns) x.classList.toggle('is-active', x === b);
  if (!b || !b.offsetWidth) {
    navPill.style.opacity = 0;
    return;
  }
  const w = `${b.offsetWidth}px`;
  const tr = `translateX(${b.offsetLeft}px)`;
  if (navPill.style.width === w && navPill.style.transform === tr) return;
  // first time it shows: appear in place instead of sliding in from the side
  const first = navPill.style.opacity !== '1';
  if (first) navPill.style.transition = 'none';
  navPill.style.width = w;
  navPill.style.transform = tr;
  navPill.style.opacity = 1;
  if (first) {
    void navPill.offsetWidth;
    navPill.style.transition = '';
  }
}
addEventListener('resize', () => navActive && setActiveNav(navActive));
function areaAt(p) {
  if (p.x < -3.2 && p.z < 3) return 'rail';
  if (p.z < -1.2 && Math.abs(p.x) < 5) return 'booth';
  if (Math.abs(p.x) < 2.6 && p.z < 4.2) return 'hero';
  return 'entrance';
}

// ---- controls legend (H)
const keysPanel = $('keysPanel');
const helpBtn = $('helpToggle');
{
  const cap = (k, wide) => `<span class="keys__cap${wide ? ' keys__cap--wide' : ''}">${k}</span>`;
  const rows = [
    [cap('Mouse', 1), 'Look around'],
    [cap('W') + cap('A') + cap('S') + cap('D'), 'Walk'],
    [cap('Shift', 1), 'Walk faster'],
    [cap('Click', 1), 'Inspect a piece'],
    [cap('E'), 'Pick up / put back'],
    [cap('Drag', 1), 'Pull the fabric'],
    [cap('Esc', 1), 'Show the cursor'],
    [cap('H'), 'Hide this'],
  ];
  $('hudKeys').innerHTML = rows.map(([k, t]) => `<li>${k}<span>${t}</span></li>`).join('');
}
let keysTimer = 0;
function showKeys(on, ms = 0) {
  clearTimeout(keysTimer);
  keysPanel.hidden = !on;
  helpBtn.setAttribute('aria-pressed', String(on));
  if (on && ms) keysTimer = setTimeout(() => showKeys(false), ms);
}
helpBtn.onclick = () => showKeys(keysPanel.hidden);
let hintTimer = 0;
function hint(text, ms = 0) {
  const el = $('hint');
  clearTimeout(hintTimer);
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
  if (ms) hintTimer = setTimeout(() => (el.hidden = true), ms);
}

function focus(tee) {
  focused = tee;
  controls.unlock();
  hint(null);
  const s = teeFocusSpot(tee);
  controls.flyTo(s.pos, s.yaw, s.pitch);
  const wasOpen = !panel.hidden;
  showProduct(tee.product || PRODUCTS.tee);
  panel.hidden = false;
  if (wasOpen) {
    panel.classList.remove('is-swap');
    void panel.offsetWidth;
    panel.classList.add('is-swap');
  }
  const idx = Math.max(0, pieces.findIndex((p) => p.product === tee.product));
  $('pieceCount').textContent = `${String(idx + 1).padStart(2, '0')} / ${String(pieces.length).padStart(2, '0')}`;
  setPickLabel(tee.kind === 'socks' ? 'Pick them up' : 'Pick it up');
  setActiveNav(tee === hero ? 'hero' : 'rail');
  turnBtn.hidden = true;
  panelHint.textContent = isMobile ? 'Drag the fabric to pull it, or pick it up to look closer.' : 'Click and drag the fabric to pull it, or pick it up to look closer.';
}
function unfocus() {
  if (held) putBack();
  focused = null;
  panel.hidden = true;
  controls.lock();
  if (!controls.locked && controls.mouseLook) hint('Click anywhere to look around');
}
function pickUp() {
  if (!focused) return;
  if (putting && putting !== focused) putting.returnToHanger();
  putting = null;
  held = focused;
  holdYaw = 0;
  holdYawTarget = 0;
  holdDist = (held.product || PRODUCTS.tee).holdDist;
  controls.flyTo(controls.pos, controls.yaw, -0.04);
  setPickLabel(held.kind === 'socks' ? 'Put them back' : 'Put it back');
  turnBtn.hidden = false;
  panelHint.textContent = isMobile ? 'Drag the background to turn it. Grab the fabric to pull it.' : 'Drag the background to turn the hanger. Scroll to bring it closer. Grab the fabric to pull it.';
  controls.lockMove = true;
}
let putting = null; // tee being turned to face front before it goes back
function putBack() {
  if (!held) return;
  // turn it to face front in your hands first, then hang it up, so it never
  // twists around the hanger on the way back
  if (Math.abs(holdYaw) > 0.25) {
    holdYawTarget = Math.round(holdYaw / (2 * Math.PI)) * 2 * Math.PI;
    putting = held;
  } else held.returnToHanger();
  setPickLabel(held.kind === 'socks' ? 'Pick them up' : 'Pick it up');
  // look back at where it hangs
  controls.flyTo(controls.pos, controls.yaw, teeFocusSpot(held).pitch);
  held = null;
  turnBtn.hidden = true;
  controls.lockMove = false;
  panelHint.textContent = isMobile ? 'Drag the fabric to pull it, or pick it up to look closer.' : 'Click and drag the fabric to pull it, or pick it up to look closer.';
}
pickBtn.onclick = () => (held ? putBack() : pickUp());
turnBtn.onclick = () => (holdYawTarget += Math.PI);
$('panelClose').onclick = unfocus;
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focused) unfocus();
  if ((e.key === 'h' || e.key === 'H') && controls.enabled) showKeys(keysPanel.hidden);
  if (e.key === 'e' || e.key === 'E') {
    if (focused) held ? putBack() : pickUp();
  }
});

for (const b of document.querySelectorAll('[data-goto]')) {
  b.onclick = () => {
    const key = b.dataset.goto;
    if (held) putBack();
    if (key === 'hero') return focus(hero);
    unfocus();
    setActiveNav(key);
    const s = spots[key];
    controls.flyTo(s.pos, s.yaw, s.pitch);
  };
}

const soundBtn = $('soundToggle');
async function setSound(on) {
  if (on) await audio.start();
  else audio.stop();
  soundBtn.setAttribute('aria-pressed', String(on && audio.playing));
  $('soundLabel').textContent = audio.playing ? `${audio.info().bpm || 126} BPM` : 'Sound off';
}
soundBtn.onclick = () => setSound(!audio.playing);

function enter(withSound) {
  $('intro').classList.add('is-gone');
  $('hud').hidden = false;
  if (withSound) setSound(true);
  controls.enabled = true;
  if (controls.mouseLook) {
    controls.lock();
    showKeys(true, 9000);
  } else hint(isMobile ? 'Drag to look · tap the floor to walk · tap a shirt' : 'Drag to look · WASD / click the floor to walk · click a shirt', 6000);
}
$('enterSound').onclick = () => enter(true);
$('enterSilent').onclick = () => enter(false);
// Everything heavy happens behind the intro: textures upload, the garments
// settle in their workers, shaders compile in parallel, and a few frames are
// drawn so nothing stalls once you walk in.
const sceneReady = (async () => {
  await texturesReady;
  setProgress(70);
  await Promise.all([...tees, djTee].map((t) => t.ready));
  setProgress(85);
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) for (const v of Object.values(m)) if (v && v.isTexture) renderer.initTexture(v);
  });
  try {
    await renderer.compileAsync(scene, camera);
  } catch {}
  setProgress(95);
  warmFrames = 0;
  await new Promise((res) => (onWarm = res));
  setProgress(100);
  $('introLoad').hidden = true;
  $('enterActions').hidden = false;
})();
let warmFrames = -1;
let onWarm = null;
if (params.has('auto')) sceneReady.then(() => enter(false));

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let frameAvg = 16;
let listenerTimer = 0;
const tmp = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();

// a soft studio key that follows you, so whatever you pick up is lit well
const studio = new THREE.SpotLight(0xfff7f0, 0, 4, 0.6, 0.9, 1.5);
scene.add(studio, studio.target);
let studioK = 0;

const UP = new THREE.Vector3(0, 1, 0);
const carryQuat = new THREE.Quaternion();
function updateHeld(dt, t) {
  studioK += ((held ? 1 : 0) - studioK) * Math.min(1, dt * 3);
  studio.intensity = 1.5 * studioK;
  grade.uniforms.uVig.value = 0.62 - 0.22 * studioK;
  holdYaw += (holdYawTarget - holdYaw) * Math.min(1, dt * 4);
  const carried = held || putting;
  if (!carried) return;
  if (putting && Math.abs(holdYaw - holdYawTarget) < 0.15) {
    putting.returnToHanger();
    putting = null;
    return;
  }
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  right.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const centre = camera.position.clone().addScaledVector(fwd, holdDist);
  // keep the garment clear of the product panel on wide screens
  if (!panel.hidden && innerWidth > 720) centre.addScaledVector(right, -0.22 * holdDist);
  // the hanger is held up at about eye level, facing you, with a little
  // natural hand sway
  centre.y = camera.position.y + (carried.product || PRODUCTS.tee).holdY + Math.sin(t * 1.1) * 0.006;
  centre.addScaledVector(right, Math.sin(t * 0.7) * 0.008);
  const yaw = controls.yaw + holdYaw + Math.sin(t * 0.45) * 0.04;
  carryQuat.setFromAxisAngle(UP, yaw);
  carried.carryTo(centre, carryQuat);
  studio.position.copy(camera.position).addScaledVector(right, 0.7).add(new THREE.Vector3(0, 0.9, 0)).addScaledVector(fwd, 0.1);
  studio.target.position.copy(centre).add(new THREE.Vector3(0, -0.3, 0));
}

const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const djSphere = new THREE.Sphere(new THREE.Vector3(), 0.9);
const _sph = new THREE.Sphere();
function teeSphere(tee) {
  _sph.center.setFromMatrixPosition(tee.hangerMatrix);
  _sph.center.y -= 0.4;
  _sph.radius = 0.8;
  return _sph;
}
// reticle: highlight when it is over a shirt (pointer-lock mode)
let reticleTimer = 0;
function updateReticle(dt) {
  if (!controls.locked) return;
  if ((reticleTimer += dt) < 0.05) return;
  reticleTimer = 0;
  const hit = pick(controls.centreEvent());
  reticle.classList.toggle('is-hot', !!hit);
  if (hit) reticle.dataset.label = `Inspect · ${hit.object.userData.tee.product?.title || ''}`;
}

// resolution levels: [pixel ratio cap, floor reflection scale]
const GOV = [[1.5, 0.35], [1.25, 0.3], [1, 0.25], [0.85, 0.2], [0.7, 0.16]];
let govLevel = GOV.findIndex(([pr]) => pr <= pixelRatio + 1e-3);
if (govLevel < 0) govLevel = 0;
const govFloor = govLevel;
let govTimer = -4; // let the first seconds settle before judging
const rawHist = new Float32Array(90);
let rawN = 0;
let refreshMs = 16.7;
const govFailedAt = [];
let lastFrameAt = 0;
function setGov(level) {
  govLevel = level;
  const [pr, refl] = GOV[level];
  renderer.setPixelRatio(Math.min(devicePixelRatio, pr));
  composer.setPixelRatio(renderer.getPixelRatio());
  reflection.scale = refl;
  resize();
}
let cpuAvg = 0;
let navTimer = 0;
let frames = 0;
let benchMode = params.has('bench');
function tick() {
  if (warmFrames < 0) {
    // still loading behind the intro: draw nothing yet
    clock.getDelta();
    requestAnimationFrame(tick);
    return;
  }
  const tStart = performance.now();
  frames++;
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const info = audio.info();
  controls.update(dt);
  updateHeld(dt, clock.elapsedTime);
  // lens: ease the field of view towards the product shot / walking value
  const fovT = focused && !held ? FOCUS_FOV : BASE_FOV;
  if (Math.abs(camera.fov - fovT) > 0.01) {
    camera.fov += (fovT - camera.fov) * (1 - Math.exp(-dt * 3.2));
    camera.updateProjectionMatrix();
  }
  if (!focused && (navTimer += dt) > 0.25) {
    navTimer = 0;
    setActiveNav(areaAt(controls.pos));
  }

  const t = info.t;
  // HVAC breeze keeps the display piece alive when you are near it
  const camPos = camera.position;
  camera.updateMatrixWorld();
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);
  for (const tee of tees) {
    const near = camPos.distanceTo(tmp.setFromMatrixPosition(tee.hangerMatrix)) < 6.5;
    tee.alwaysAwake = tee === hero && near;
    if (tee.alwaysAwake) tee.wake();
    const wind = [Math.sin(t * 0.31) * 0.12, 0, 0.1 + Math.sin(t * 0.53 + 1) * 0.12];
    // garments you cannot see wait (frozen) instead of using CPU; while you
    // hold one, everything else waits so it gets the whole budget
    const busy = tee === held || tee === putting || tee.state !== 'hanging' || (grab && grab.tee === tee);
    const paused = !busy && (!!held || !frustum.intersectsSphere(teeSphere(tee)));
    tee.update(dt, { wind: tee === hero ? wind : [0, 0, 0], paused });
  }
  stage.update(dt, info);
  // DJ shirt follows the body; skip the solve when far away
  const djDist = camPos.distanceTo(stage.boothWorld);
  dj.group.updateMatrixWorld(true);
  djTee.cloth.colliders = dj.colliders();
  djSphere.center.copy(stage.boothWorld).setY(1.3);
  djTee.update(dt, { wind: [0, 0, 0], paused: djDist > 14 || !!held || !frustum.intersectsSphere(djSphere) });
  clothPool.flush();
  room.update(info);
  details.update(info, clock.elapsedTime);
  if ((listenerTimer += dt) > 0.15) {
    listenerTimer = 0;
    audio.setListener(djDist);
  }

  cpuAvg = cpuAvg * 0.95 + (performance.now() - tStart) * 0.05;
  if (benchMode && warmFrames > 4) {
    // debug: measure simulation throughput without the GPU in the way
    requestAnimationFrame(tick);
    return;
  }
  reflection.update(renderer, scene, camera);
  grade.uniforms.uTime.value = t % 100;
  composer.render(dt);
  updateReticle(dt);
  if (warmFrames >= 0 && ++warmFrames === 4 && onWarm) onWarm();

  // Resolution governor: when frames are slow (e.g. a laptop in quiet /
  // battery mode), render fewer pixels until it is smooth again, and step
  // back up when there is headroom.
  // The target is the display's own refresh rate (120 Hz and up on João's
  // screen, 60 on most), measured from the fastest recent frames.
  const now = performance.now();
  const raw = lastFrameAt ? now - lastFrameAt : 16;
  lastFrameAt = now;
  if (raw < 250) {
    frameAvg = frameAvg * 0.94 + raw * 0.06;
    rawHist[rawN++ % rawHist.length] = raw;
  }
  govTimer += dt;
  if (govTimer > 1.2 && rawN >= rawHist.length) {
    const sorted = Float32Array.from(rawHist).sort();
    refreshMs = Math.min(34, Math.max(4, sorted[Math.floor(sorted.length * 0.2)]));
    if (frameAvg > refreshMs * 1.3 + 0.5 && govLevel < GOV.length - 1) {
      govFailedAt[govLevel] = now;
      setGov(govLevel + 1);
      govTimer = 0;
    } else if (frameAvg < refreshMs * 1.06 && govLevel > govFloor && now - (govFailedAt[govLevel - 1] || -1e9) > 30000) {
      setGov(govLevel - 1);
      govTimer = -4;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// debugging hooks
window.__khora = { renderer, stats: () => ({ refreshMs: +refreshMs.toFixed(2), gov: govLevel, frameMs: +frameAvg.toFixed(2), updateMs: +cpuAvg.toFixed(2), threaded: clothPool.threaded, workerMs: +clothStat.ms.toFixed(2), steps: { ...clothStat.steps }, info: { ...clothStat.info }, frames }), setBench: (b) => (benchMode = b), scene, camera, tees, hero, djTee, controls, audio, focus, pickUp, putBack, setHoldYaw: (y) => (holdYawTarget = y), spots };
