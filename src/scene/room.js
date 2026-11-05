import * as THREE from 'three';
import { concrete, gradientTex } from './textures.js';

const BASE = import.meta.env.BASE_URL;
export const BLUE = new THREE.Color(0x0a4dff);
export const ROOM = { x0: -8, x1: 8, z0: -8.5, z1: 7, h: 4.8 };

/**
 * The shop: polished floor, micro-cement walls, black ceiling with linear
 * lights, the hero display, the wall rail niche, the wordmark wall and the
 * cash desk. Returns anchors for the garments and the camera colliders.
 */
export function buildRoom(scene, reflection) {
  const loader = new THREE.TextureLoader();
  const group = new THREE.Group();
  scene.add(group);
  const colliders = []; // camera blockers: {min: Vector2(x,z), max: Vector2(x,z)}
  const animated = [];
  const W = ROOM.x1 - ROOM.x0;
  const D = ROOM.z1 - ROOM.z0;
  const cx = (ROOM.x0 + ROOM.x1) / 2;
  const cz = (ROOM.z0 + ROOM.z1) / 2;

  // ------------------------------------------------------------- floor
  const fl = concrete({ base: [20, 21, 25], spread: 16, seed: 11, repeat: 6, joint: 1.2 });
  const floorMat = new THREE.MeshStandardMaterial({
    map: fl.albedo,
    roughnessMap: fl.rough,
    roughness: 0.55,
    metalness: 0.0,
  });
  reflection.patch(floorMat, { strength: 0.85, blur: 1.0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);
  reflection.hidden.push(floor);

  // ------------------------------------------------------------- walls / ceiling
  const wl = concrete({ base: [30, 31, 36], spread: 22, seed: 5, repeat: 3 });
  const wallMat = new THREE.MeshStandardMaterial({ map: wl.albedo, roughnessMap: wl.rough, roughness: 0.9 });
  const mkWall = (w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  mkWall(W, ROOM.h, cx, ROOM.h / 2, ROOM.z0, 0); // back (behind stage)
  mkWall(W, ROOM.h, cx, ROOM.h / 2, ROOM.z1, Math.PI); // front
  mkWall(D, ROOM.h, ROOM.x0, ROOM.h / 2, cz, Math.PI / 2); // left
  mkWall(D, ROOM.h, ROOM.x1, ROOM.h / 2, cz, -Math.PI / 2); // right
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 0.95 }),
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(cx, ROOM.h, cz);
  group.add(ceil);

  // skirting light: a thin blue line where walls meet the floor
  const skirtMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x1a5cff).multiplyScalar(2.2) });
  const skirt = (len, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.012, 0.012), skirtMat);
    m.position.set(x, 0.03, z);
    m.rotation.y = ry;
    group.add(m);
  };
  skirt(W - 0.1, cx, ROOM.z1 - 0.03, 0);
  skirt(D - 0.1, ROOM.x0 + 0.03, cz, Math.PI / 2);
  skirt(D - 0.1, ROOM.x1 - 0.03, cz, Math.PI / 2);

  // (ceiling: baffles and suspended linear lights live in details.js)

  // vertical blue LED tubes along the side walls, pulsing with the kick
  const tubeMat = new THREE.MeshBasicMaterial({ color: BLUE.clone().multiplyScalar(4) });
  const tubeGeo = new THREE.CylinderGeometry(0.018, 0.018, 3.6, 10);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = 5.6 - i * 2.4;
      if (side < 0 && z < 2.2 && z > -4.2) continue; // left niche
      if (side > 0 && z < 2.0 && z > -2.6) continue; // wordmark wall
      const t = new THREE.Mesh(tubeGeo, tubeMat);
      t.position.set(side * (ROOM.x1 - 0.06), 2.0, z);
      group.add(t);
    }
  }
  animated.push((info) => {
    const k = 2.5 + info.kick * 4 * info.energy;
    tubeMat.color.copy(BLUE).multiplyScalar(k);
  });

  // ------------------------------------------------------------- materials
  const stone = new THREE.MeshPhysicalMaterial({
    color: 0x0c0c0f,
    roughness: 0.22,
    metalness: 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: 1, roughness: 0.22 });
  const brushed = new THREE.MeshStandardMaterial({ color: 0xbfc4cc, metalness: 1, roughness: 0.32 });

  // ------------------------------------------------------------- hero display
  // A floating chrome bar hung from the ceiling on cables, over a black stone plinth.
  const hero = new THREE.Group();
  hero.position.set(0, 0, 1.2);
  group.add(hero);
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.32, 1.2), stone);
  plinth.position.y = 0.16;
  plinth.castShadow = plinth.receiveShadow = true;
  hero.add(plinth);
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(2.36, 0.01, 1.16),
    new THREE.MeshBasicMaterial({ color: BLUE.clone().multiplyScalar(3) }),
  );
  glow.position.y = 0.004;
  hero.add(glow);
  const BAR_Y = 1.98;
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.7, 20), chrome);
  bar.rotation.z = Math.PI / 2;
  bar.position.y = BAR_Y;
  bar.castShadow = true;
  hero.add(bar);
  for (const s of [-1, 1]) {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, ROOM.h - BAR_Y, 6), brushed);
    cable.position.set(s * 0.8, BAR_Y + (ROOM.h - BAR_Y) / 2, 0);
    hero.add(cable);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 12), chrome);
    cap.position.set(s * 0.85, BAR_Y, 0);
    hero.add(cap);
  }
  colliders.push({ min: new THREE.Vector2(-1.35, 0.45), max: new THREE.Vector2(1.35, 1.95) });
  // the hanger hook sits on top of the bar
  const heroHanger = new THREE.Matrix4().makeTranslation(0, BAR_Y - 0.105, 1.2 + 0.025);

  // ------------------------------------------------------------- left wall niche rail
  const niche = new THREE.Group();
  niche.position.set(ROOM.x0, 0, -1.0);
  group.add(niche);
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 3.3),
    new THREE.MeshBasicMaterial({
      map: gradientTex([
        [0, '#040a2e'],
        [0.45, '#0a2fae'],
        [0.75, '#081f7a'],
        [1, '#02061c'],
      ]),
    }),
  );
  back.material.color.setScalar(0.5);
  back.position.set(0.02, 1.85, 0);
  back.rotation.y = Math.PI / 2;
  niche.add(back);
  // frame
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.5 });
  for (const [w, h, y, z] of [
    [5.5, 0.15, 3.57, 0],
    [5.5, 0.15, 0.13, 0],
    [0.15, 3.6, 1.85, 2.68],
    [0.15, 3.6, 1.85, -2.68],
  ]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.4, h, w === 5.5 ? 5.5 : 0.15), frameMat);
    f.position.set(0.2, y, z);
    niche.add(f);
  }
  const nicheRail = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 4.6, 16), chrome);
  nicheRail.rotation.x = Math.PI / 2;
  nicheRail.position.set(0.55, 2.12, 0);
  nicheRail.castShadow = true;
  niche.add(nicheRail);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 12), chrome);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(0.28, 2.12, s * 2.2);
    niche.add(arm);
  }
  colliders.push({ min: new THREE.Vector2(ROOM.x0, -3.9), max: new THREE.Vector2(ROOM.x0 + 1.1, 1.9) });
  const nicheHangers = [-1.0, 1.0].map((z) => {
    const m = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    m.setPosition(ROOM.x0 + 0.55 + 0.025, 2.12 - 0.105, -1.0 + z);
    return m;
  });

  // ------------------------------------------------------------- wordmark wall (right)
  const wm = loader.load(BASE + 'textures/wordmark.png');
  wm.colorSpace = THREE.SRGBColorSpace;
  const wordmark = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 3.6 * (97 / 492)),
    new THREE.MeshBasicMaterial({ map: wm, transparent: true, color: new THREE.Color(0xc8d6ff).multiplyScalar(2.2), depthWrite: false }),
  );
  wordmark.position.set(ROOM.x1 - 0.03, 2.75, -0.3);
  wordmark.rotation.y = -Math.PI / 2;
  group.add(wordmark);
  // monolith cash desk with chrome top and blue under-glow
  const desk = new THREE.Group();
  desk.position.set(ROOM.x1 - 1.6, 0, -0.3);
  group.add(desk);
  const deskBody = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 2.4), stone);
  deskBody.position.y = 0.52;
  deskBody.castShadow = deskBody.receiveShadow = true;
  desk.add(deskBody);
  const deskTop = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.04, 2.46), brushed);
  deskTop.position.y = 1.04;
  desk.add(deskTop);
  const under = new THREE.Mesh(
    new THREE.BoxGeometry(0.76, 0.012, 2.36),
    new THREE.MeshBasicMaterial({ color: BLUE.clone().multiplyScalar(3) }),
  );
  under.position.y = 0.012;
  desk.add(under);
  colliders.push({ min: new THREE.Vector2(ROOM.x1 - 2.1, -1.6), max: new THREE.Vector2(ROOM.x1 - 1.1, 1.0) });

  // two low round benches near the hero display (blue velvet)
  const velvet = new THREE.MeshPhysicalMaterial({
    color: 0x0b2a9a,
    roughness: 0.9,
    sheen: 1,
    sheenColor: new THREE.Color(0x6e8cff),
    sheenRoughness: 0.4,
  });
  for (const [x, z] of [
    [-3.2, 3.4],
    [3.0, 3.6],
  ]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.42, 48), velvet);
    b.position.set(x, 0.21, z);
    b.castShadow = b.receiveShadow = true;
    group.add(b);
    colliders.push({ min: new THREE.Vector2(x - 0.65, z - 0.65), max: new THREE.Vector2(x + 0.65, z + 0.65) });
  }

  // entrance: black glass doors outlined with light
  const doorGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe6ecff).multiplyScalar(1.4) });
  for (const [w, h, x, y] of [
    [2.6, 0.03, 0, 3.0],
    [0.03, 3.0, -1.3, 1.5],
    [0.03, 3.0, 1.3, 1.5],
    [0.02, 3.0, 0, 1.5],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), doorGlow);
    m.position.set(x, y, ROOM.z1 - 0.02);
    group.add(m);
  }

  // ------------------------------------------------------------- lights
  // Light budget is deliberately small (every light costs on every lit pixel):
  // hemisphere + 3 spots here, 2 follow spots + 1 point light on the stage.
  scene.add(new THREE.HemisphereLight(0x4152a0, 0x0a0a10, 1.7));
  // hero key: neutral white so the garment colour reads true
  const key = new THREE.SpotLight(0xfff6ee, 44, 12, 0.3, 0.7, 2);
  key.position.set(1.6, ROOM.h - 0.1, 4.4);
  key.target.position.set(0, 1.55, 1.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 9;
  key.shadow.radius = 3;
  group.add(key, key.target);
  // blue rim from behind: paler than the brand blue so the back of a white
  // tee still reads white (with a cool edge) instead of turning blue
  const rim = new THREE.SpotLight(0x7d98ff, 34, 12, 0.4, 0.6, 2);
  rim.position.set(0.4, ROOM.h - 0.1, -2.2);
  rim.target.position.set(0, 1.6, 1.2);
  group.add(rim, rim.target);
  // niche key
  const nk = new THREE.SpotLight(0xfff4ea, 30, 10, 0.5, 0.7, 2);
  nk.position.set(ROOM.x0 + 3.4, ROOM.h - 0.1, -1.0);
  nk.target.position.set(ROOM.x0 + 0.5, 1.6, -1.0);
  group.add(nk, nk.target);
  // visible downlight cans for the spots
  const canMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.4, metalness: 0.6 });
  const lensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff6ee).multiplyScalar(4) });
  for (const l of [key, rim, nk]) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 20), canMat);
    can.position.copy(l.position).add(new THREE.Vector3(0, 0.02, 0));
    group.add(can);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), lensMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.copy(l.position).add(new THREE.Vector3(0, -0.062, 0));
    group.add(lens);
  }

  // fake volumetric cone under the hero key spot (haze catching light)
  animated.push((info) => {
    const k = 1 + info.kick * 0.15 * info.energy;
    rim.intensity = 34 * k;
  });

  return {
    group,
    floor,
    colliders,
    heroHanger,
    nicheHangers,
    lights: { key, rim, nk },
    update(info) {
      for (const f of animated) f(info);
    },
  };
}
