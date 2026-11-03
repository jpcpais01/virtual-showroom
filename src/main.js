import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { buildRoom, ROOM } from './scene/room.js';
import { buildStage } from './scene/stage.js';
import { FloorReflection } from './scene/reflection.js';
import { Tee } from './garments/tee.js';
import { clothPool, stat as clothStat } from './garments/clothPool.js';
import { RaveAudio } from './audio.js';
import { WalkControls } from './controls.js';

const params = new URLSearchParams(location.search);
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

const camera = new THREE.PerspectiveCamera(56, innerWidth / innerHeight, 0.03, 60);

// ---------------------------------------------------------------- loading
const progressEl = document.getElementById('progress');
THREE.DefaultLoadingManager.onProgress = (_u, loaded, total) => {
  progressEl.style.width = `${Math.round((loaded / total) * 85)}%`;
};
const texturesReady = new Promise((res) => (THREE.DefaultLoadingManager.onLoad = res));

// ---------------------------------------------------------------- world
const reflection = new FloorReflection(quality < 1 ? 0.25 : 0.35);
const room = buildRoom(scene, reflection);
const stage = buildStage(scene);

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
const tees = [];
const hero = new Tee({ renderer, hangerMatrix: room.heroHanger, name: 'hero', quality });
scene.add(hero.group);
tees.push(hero);
for (const [i, m] of room.nicheHangers.entries()) {
  const t = new Tee({ renderer, hangerMatrix: m, name: `rail-${i}`, quality });
  scene.add(t.group);
  tees.push(t);
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
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 d = vUv - 0.5;
      c *= mix(1.0, uVig, smoothstep(0.2, 0.95, dot(d, d) * 2.2));
      c += (h(vUv * 1000.0) - 0.5) * 0.018;
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
if (!controls.mouseLook) document.querySelector('.intro__hint').textContent = isMobile ? 'Drag to look around · tap the floor to walk · tap a piece to inspect it' : 'Drag to look around · WASD or click the floor to walk · Click a piece to inspect it';
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
  // stand ~1.7m in front of the garment, looking at it
  const front = new THREE.Vector3(0, 0, 1).transformDirection(tee.hangerMatrix);
  const c = new THREE.Vector3().setFromMatrixPosition(tee.hangerMatrix);
  const pos = c.clone().addScaledVector(front, 1.75);
  pos.y = 1.62;
  return { pos, yaw: Math.atan2(-front.x, -front.z) + Math.PI, pitch: -0.06, lookAt: c.clone().setY(1.62) };
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
  holdDist = THREE.MathUtils.clamp(holdDist + dy * 0.0008, 0.6, 1.6);
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
const $ = (id) => document.getElementById(id);
const panel = $('panel');
const pickBtn = $('pickBtn');
const turnBtn = $('turnBtn');
const panelHint = $('panelHint');
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
  panel.hidden = false;
  pickBtn.textContent = 'Pick it up';
  turnBtn.hidden = true;
  panelHint.textContent = 'Click and drag the fabric to pull it, or pick it up to look closer.';
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
  held = focused;
  holdYaw = 0;
  holdYawTarget = 0;
  holdDist = 1.05;
  controls.flyTo(controls.pos, controls.yaw, -0.04);
  pickBtn.textContent = 'Put it back';
  turnBtn.hidden = false;
  panelHint.textContent = 'Drag the background to turn it in your hands. Scroll to bring it closer. Grab the fabric to pull it.';
  controls.lockMove = true;
}
function putBack() {
  if (!held) return;
  held.returnToHanger();
  held = null;
  pickBtn.textContent = 'Pick it up';
  turnBtn.hidden = true;
  controls.lockMove = false;
  panelHint.textContent = 'Click and drag the fabric to pull it, or pick it up to look closer.';
}
pickBtn.onclick = () => (held ? putBack() : pickUp());
turnBtn.onclick = () => (holdYawTarget += Math.PI);
$('panelClose').onclick = unfocus;
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focused) unfocus();
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
    const s = spots[key];
    controls.flyTo(s.pos, s.yaw, s.pitch);
  };
}

const soundBtn = $('soundToggle');
async function setSound(on) {
  if (on) await audio.start();
  else audio.stop();
  soundBtn.setAttribute('aria-pressed', String(on && audio.playing));
  $('soundLabel').textContent = audio.playing ? 'Sound on' : 'Sound off';
}
soundBtn.onclick = () => setSound(!audio.playing);

function enter(withSound) {
  $('intro').classList.add('is-gone');
  $('hud').hidden = false;
  if (withSound) setSound(true);
  controls.enabled = true;
  if (controls.mouseLook) controls.lock();
  else hint(isMobile ? 'Drag to look · tap the floor to walk · tap a shirt' : 'Drag to look · WASD / click the floor to walk · click a shirt', 6000);
}
$('enterSound').onclick = () => enter(true);
$('enterSilent').onclick = () => enter(false);
// Everything heavy happens behind the intro: textures upload, the garments
// settle in their workers, shaders compile in parallel, and a few frames are
// drawn so nothing stalls once you walk in.
const sceneReady = (async () => {
  await texturesReady;
  progressEl.style.width = '70%';
  await Promise.all([...tees, djTee].map((t) => t.ready));
  progressEl.style.width = '85%';
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) for (const v of Object.values(m)) if (v && v.isTexture) renderer.initTexture(v);
  });
  try {
    await renderer.compileAsync(scene, camera);
  } catch {}
  progressEl.style.width = '95%';
  warmFrames = 0;
  await new Promise((res) => (onWarm = res));
  progressEl.style.width = '100%';
  $('enterActions').hidden = false;
})();
let warmFrames = -1;
let onWarm = null;
if (params.has('auto')) sceneReady.then(() => enter(false));

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let frameAvg = 16;
let lowTimer = 0;
let listenerTimer = 0;
const tmp = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();

// a soft studio key that follows you, so whatever you pick up is lit well
const studio = new THREE.SpotLight(0xfff7f0, 0, 4, 0.6, 0.9, 1.5);
scene.add(studio, studio.target);
let studioK = 0;

function updateHeld(dt, t) {
  studioK += ((held ? 1 : 0) - studioK) * Math.min(1, dt * 3);
  studio.intensity = 2.2 * studioK;
  grade.uniforms.uVig.value = 0.62 - 0.22 * studioK;
  if (!held) return;
  holdYaw += (holdYawTarget - holdYaw) * Math.min(1, dt * 4);
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  right.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const centre = camera.position.clone().addScaledVector(fwd, holdDist);
  // keep the garment clear of the product panel on wide screens
  if (!panel.hidden && innerWidth > 720) centre.addScaledVector(right, -0.22 * holdDist);
  // hands just above eye level, with a little natural sway
  centre.y = camera.position.y + 0.28 + Math.sin(t * 1.1) * 0.008;
  centre.addScaledVector(right, Math.sin(t * 0.7) * 0.01);
  const yaw = holdYaw + Math.sin(t * 0.45) * 0.05;
  const halfSpan = 0.26;
  const off = right.clone().multiplyScalar(Math.cos(yaw) * halfSpan).addScaledVector(fwd, Math.sin(yaw) * halfSpan);
  held.hold(centre.clone().sub(off), centre.clone().add(off));
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
}

let cpuAvg = 0;
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
    const busy = tee === held || (grab && grab.tee === tee);
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

  // simple quality governor
  frameAvg = frameAvg * 0.95 + dt * 1000 * 0.05;
  if (frameAvg > 34 && quality > 0.5) {
    lowTimer += dt;
    if (lowTimer > 3) {
      quality = 0.5;
      renderer.setPixelRatio(1);
      reflection.scale = 0.2;
      resize();
      lowTimer = 0;
    }
  } else lowTimer = 0;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// debugging hooks
window.__khora = { stats: () => ({ updateMs: +cpuAvg.toFixed(2), threaded: clothPool.threaded, workerMs: +clothStat.ms.toFixed(2), steps: { ...clothStat.steps }, frames }), setBench: (b) => (benchMode = b), scene, camera, tees, hero, djTee, controls, audio, focus, pickUp, putBack, setHoldYaw: (y) => (holdYawTarget = y), spots };
