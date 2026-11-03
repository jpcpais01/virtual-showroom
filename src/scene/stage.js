import * as THREE from 'three';
import { ROOM, BLUE } from './room.js';
import { grille } from './textures.js';

const BASE = import.meta.env.BASE_URL;

// ------------------------------------------------------------------ shaders
const ledWallShader = {
  uniforms: {
    uTime: { value: 0 },
    uKick: { value: 0 },
    uEnergy: { value: 0.5 },
    uSection: { value: 0 },
    uBuild: { value: 0 },
    uPrint: { value: null },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime, uKick, uEnergy, uSection, uBuild, uAspect;
    uniform sampler2D uPrint;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
    void main(){
      vec2 grid = vec2(150.0, 150.0 / uAspect);
      vec2 cell = fract(vUv * grid) - 0.5;
      vec2 q = (floor(vUv * grid) + 0.5) / grid;
      // LED pixels: dots up close, fading to a flat average when they get
      // smaller than a few screen pixels (avoids shimmering moire)
      float px = max(fwidth(vUv.x * grid.x), fwidth(vUv.y * grid.y));
      float dots = smoothstep(0.55, 0.2, length(cell)) * 1.6;
      float led = mix(dots, 0.85, smoothstep(0.18, 0.45, px));
      q = mix(q, vUv, smoothstep(0.18, 0.45, px));
      vec2 p = (q - 0.5) * vec2(uAspect, 1.0);
      float r = length(p);
      float a = atan(p.y, p.x);
      float t = uTime;
      vec3 blue = vec3(0.025, 0.17, 1.0);
      vec3 col = vec3(0.0);
      // tunnel rings expanding with the beat
      float rings = sin(18.0 * log(r + 0.04) - t * 4.0 - uKick * 1.5);
      rings = smoothstep(0.6, 1.0, rings);
      // thorny radial spikes, echoing the tribal print
      float spikes = pow(abs(sin(a * 7.0 + t * 0.6 + sin(r * 6.0 - t))), 18.0) * smoothstep(1.2, 0.2, r);
      // horizontal scan bars for the groove section
      float bars = smoothstep(0.92, 1.0, sin(q.y * 40.0 + t * 6.0));
      float sec = uSection; // 0 groove, 1 build, 2 break, 3 drop
      col += blue * rings * (0.25 + 0.9 * uKick) * (sec > 2.5 ? 1.4 : 0.8);
      col += blue * spikes * (0.5 + uEnergy);
      col += vec3(0.3, 0.5, 1.0) * bars * (sec < 0.5 ? 0.35 : 0.12);
      // breakdown: slow breathing glow + rising sparkle
      if (sec > 1.5 && sec < 2.5) {
        col = blue * (0.25 + 0.25 * sin(t * 1.5)) * smoothstep(1.3, 0.0, r);
        col += vec3(0.6, 0.75, 1.0) * step(0.985 - uBuild * 0.06, hash(floor(q * grid) + floor(t * 12.0))) * uBuild;
      }
      // the KHORA heart print, centred and pulsing
      float ph = 0.86;
      vec2 pu = vec2((q.x - 0.5) * uAspect / (ph * 0.718) + 0.5, (q.y - 0.5) / ph + 0.5);
      if (pu.x > 0.0 && pu.x < 1.0 && pu.y > 0.0 && pu.y < 1.0) {
        vec2 pm = texture2D(uPrint, vec2(pu.x, pu.y)).rg;
        float pulse = 1.0 + uKick * 1.6 * uEnergy;
        col = mix(col * 0.6, blue * pulse * 1.15, pm.r);
        col = mix(col, vec3(0.92, 0.95, 1.0) * (0.9 + uKick * 0.6), pm.g);
      }
      col *= led * 0.62;
      col += vec3(0.004, 0.006, 0.02); // panel black level
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const beamShader = {
  uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uIntensity: { value: 1 }, uLen: { value: 9 } },
  vertexShader: /* glsl */ `
    varying float vAlong; varying vec3 vN; varying vec3 vV; varying vec3 vW;
    uniform float uLen;
    void main(){
      vAlong = -position.y / uLen;
      vec4 wp = modelMatrix * vec4(position,1.0);
      vW = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      vV = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor; uniform float uIntensity;
    varying float vAlong; varying vec3 vN; varying vec3 vV; varying vec3 vW;
    float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
    void main(){
      float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
      float fall = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.6);
      float floorFade = smoothstep(0.0, 0.5, vW.y);
      float dust = 0.85 + 0.15 * hash(floor(vW * 40.0));
      float a = edge * fall * floorFade * uIntensity * dust;
      gl_FragColor = vec4(uColor * a, 1.0);
    }`,
};

function beamMaterial(color) {
  const m = new THREE.ShaderMaterial({
    ...beamShader,
    uniforms: THREE.UniformsUtils.clone(beamShader.uniforms),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  m.uniforms.uColor.value = new THREE.Color(color);
  return m;
}

// ------------------------------------------------------------------ mannequin
const skin = new THREE.MeshPhysicalMaterial({
  color: 0x101014,
  roughness: 0.28,
  metalness: 0.1,
  clearcoat: 1,
  clearcoatRoughness: 0.08,
});

function capsuleBetween(a, b, r, mat) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len), 6, 16), mat);
  m.castShadow = true;
  setCapsule(m, a, b);
  return m;
}
function setCapsule(m, a, b) {
  m.position.copy(a).add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}

/** two-bone IK: returns elbow position */
function solveElbow(shoulder, hand, l1, l2, pole) {
  const d = hand.clone().sub(shoulder);
  let dist = d.length();
  dist = Math.min(dist, l1 + l2 - 1e-4);
  const dir = d.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const poleDir = pole.clone().sub(shoulder);
  poleDir.sub(dir.clone().multiplyScalar(poleDir.dot(dir))).normalize();
  return shoulder.clone().addScaledVector(dir, a).addScaledVector(poleDir, h);
}

export class DJMannequin {
  constructor() {
    this.group = new THREE.Group();
    this.upper = new THREE.Group(); // everything above the hips bobs to the beat
    this.group.add(this.upper);
    const g = this.upper;
    // torso: lathe profile, flattened front-to-back
    const prof = [
      [0.0, 0.95], [0.135, 0.96], [0.15, 1.02], [0.145, 1.1], [0.16, 1.22], [0.175, 1.32], [0.17, 1.38], [0.13, 1.44], [0.06, 1.47], [0.0, 1.475],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const torso = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), skin);
    torso.scale.z = 0.66;
    torso.castShadow = true;
    g.add(torso);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.055, 0.14, 20), skin);
    neck.position.y = 1.52;
    g.add(neck);
    this.head = new THREE.Group();
    this.head.position.y = 1.58;
    g.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 24), skin);
    skull.scale.set(0.88, 1.18, 1.0);
    skull.position.y = 0.1;
    skull.castShadow = true;
    this.head.add(skull);
    // headphones
    const hpMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1f, roughness: 0.35, metalness: 0.6 });
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.012, 10, 32, Math.PI), hpMat);
    band.position.y = 0.11;
    this.head.add(band);
    for (const s of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 24), hpMat);
      cup.rotation.z = Math.PI / 2;
      cup.position.set(s * 0.1, 0.095, 0);
      this.head.add(cup);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.045, 0.004, 6, 24),
        new THREE.MeshBasicMaterial({ color: BLUE.clone().multiplyScalar(3) }),
      );
      ring.rotation.y = Math.PI / 2;
      ring.position.set(s * 0.117, 0.095, 0);
      this.head.add(ring);
    }
    // hips + legs (mostly hidden by the booth)
    const hips = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), skin);
    hips.scale.set(1.05, 0.7, 0.72);
    hips.position.y = 0.95;
    this.group.add(hips);
    for (const s of [-1, 1]) {
      this.group.add(capsuleBetween(new THREE.Vector3(s * 0.09, 0.92, 0), new THREE.Vector3(s * 0.1, 0.5, 0.02), 0.068, skin));
      this.group.add(capsuleBetween(new THREE.Vector3(s * 0.1, 0.5, 0.02), new THREE.Vector3(s * 0.1, 0.08, 0), 0.05, skin));
    }
    // arms
    this.arms = [-1, 1].map((s) => {
      const shoulder = new THREE.Vector3(s * 0.2, 1.4, 0);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.058, 20, 14), skin);
      ball.position.copy(shoulder);
      g.add(ball);
      const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.24, 6, 14), skin);
      const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.037, 0.23, 6, 14), skin);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), skin);
      hand.scale.set(0.8, 0.5, 1.2);
      upperArm.castShadow = fore.castShadow = true;
      g.add(upperArm, fore, hand);
      return { s, shoulder, upperArm, fore, hand, elbow: new THREE.Vector3(), wrist: new THREE.Vector3() };
    });
    this.l1 = 0.29;
    this.l2 = 0.27;
    this.pose = 0; // 0 = A-pose (for dressing), 1 = DJ pose
    this.time = 0;
  }

  /** world-space capsule colliders for the cloth (computed after update) */
  colliders() {
    const m = this.upper.matrixWorld;
    const v = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m).toArray();
    const out = [
      { type: 'capsule', a: v(-0.065, 1.0, 0), b: v(-0.07, 1.33, 0), r: 0.105 },
      { type: 'capsule', a: v(0.065, 1.0, 0), b: v(0.07, 1.33, 0), r: 0.105 },
      { type: 'capsule', a: v(-0.19, 1.39, 0), b: v(0.19, 1.39, 0), r: 0.065 },
      { type: 'capsule', a: v(0, 1.4, 0), b: v(0, 1.56, 0), r: 0.055 },
    ];
    for (const arm of this.arms) {
      const w = (p) => p.clone().applyMatrix4(m).toArray();
      out.push({ type: 'capsule', a: w(arm.shoulder), b: w(arm.elbow), r: 0.05 });
      out.push({ type: 'capsule', a: w(arm.elbow), b: w(arm.wrist), r: 0.042 });
    }
    return out;
  }

  update(dt, info, deck) {
    this.time += dt;
    const t = this.time;
    const groove = info.kick;
    // the body bobs on the kick, head nods a bit later
    this.upper.position.y = -0.018 * groove * (info.section === 'break' ? 0.3 : 1);
    this.upper.rotation.y = Math.sin(t * 0.4) * 0.08;
    this.head.rotation.x = 0.18 + 0.12 * Math.exp(-((info.phase + 0.85) % 1) * 5);
    this.head.rotation.z = Math.sin(t * 0.7) * 0.05;
    const p = this.pose;
    for (const arm of this.arms) {
      // A-pose target (arms ~28° below horizontal, matching the sleeve angle)
      const aDir = new THREE.Vector3(arm.s * Math.cos(0.49), -Math.sin(0.49), 0);
      const aHand = arm.shoulder.clone().addScaledVector(aDir, this.l1 + this.l2 - 0.002);
      // DJ targets in local space: right hand on the mixer, left on the jog / headphones
      let dj;
      if (arm.s > 0) {
        dj = new THREE.Vector3(0.06 + Math.sin(t * 0.9) * 0.07, deck.y + 0.08, 0.43 + Math.sin(t * 1.3) * 0.03);
      } else {
        const toEar = info.section === 'break' ? 1 : 0;
        this._ear = THREE.MathUtils.lerp(this._ear || 0, toEar, Math.min(1, dt * 2));
        const jog = new THREE.Vector3(-0.4 + Math.cos(t * 2) * 0.03, deck.y + 0.1, 0.42 + Math.sin(t * 2) * 0.03);
        const ear = new THREE.Vector3(-0.14, 1.66, 0.04);
        dj = jog.lerp(ear, this._ear);
      }
      const target = aHand.lerp(dj, p);
      const pole = new THREE.Vector3(arm.s * 0.9, 0.6, -0.8).lerp(new THREE.Vector3(arm.s * 0.6, 1.0, -0.6), p);
      arm.elbow.copy(solveElbow(arm.shoulder, target, this.l1, this.l2, pole.add(arm.shoulder)));
      arm.wrist.copy(target);
      setCapsule(arm.upperArm, arm.shoulder, arm.elbow);
      setCapsule(arm.fore, arm.elbow, arm.wrist);
      arm.hand.position.copy(arm.wrist).addScaledVector(arm.wrist.clone().sub(arm.elbow).normalize(), 0.05);
      arm.hand.lookAt(arm.hand.position.clone().add(arm.wrist.clone().sub(arm.elbow)));
    }
  }
}

// ------------------------------------------------------------------ stage
export function buildStage(scene) {
  const group = new THREE.Group();
  scene.add(group);
  const colliders = [];
  const loader = new THREE.TextureLoader();
  const z0 = ROOM.z0;
  const stageDepth = 3.4;
  const stageFront = z0 + stageDepth;
  const stageH = 0.4;

  const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.6, metalness: 0.2 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.4, metalness: 0.5 });
  const alu = new THREE.MeshStandardMaterial({ color: 0x8d9299, roughness: 0.35, metalness: 1 });

  // platform with a light strip on the nose
  const platform = new THREE.Mesh(new THREE.BoxGeometry(8.4, stageH, stageDepth), black);
  platform.position.set(0, stageH / 2, z0 + stageDepth / 2);
  platform.receiveShadow = true;
  group.add(platform);
  const noseMat = new THREE.MeshBasicMaterial({ color: BLUE.clone().multiplyScalar(4) });
  const nose = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.02, 0.02), noseMat);
  nose.position.set(0, stageH - 0.01, stageFront + 0.005);
  group.add(nose);
  colliders.push({ min: new THREE.Vector2(-4.3, z0), max: new THREE.Vector2(4.3, stageFront + 0.35) });

  // LED wall
  const print = loader.load(BASE + 'textures/print_mask.png');
  const ledMat = new THREE.ShaderMaterial({ ...ledWallShader, uniforms: THREE.UniformsUtils.clone(ledWallShader.uniforms), fog: false });
  ledMat.uniforms.uPrint.value = print;
  const wallW = 7.2;
  const wallH = 3.7;
  ledMat.uniforms.uAspect.value = wallW / wallH;
  const led = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH), ledMat);
  led.position.set(0, stageH + 0.35 + wallH / 2, z0 + 0.06);
  group.add(led);
  const ledFrame = new THREE.Mesh(new THREE.BoxGeometry(wallW + 0.12, wallH + 0.12, 0.1), black);
  ledFrame.position.copy(led.position).add(new THREE.Vector3(0, 0, -0.06));
  group.add(ledFrame);
  const ledLight = new THREE.RectAreaLight(0x1f55ff, 4, wallW, wallH);
  ledLight.position.copy(led.position).add(new THREE.Vector3(0, 0, 0.05));
  ledLight.lookAt(0, led.position.y, 0);
  group.add(ledLight);

  // DJ booth: facade glows, deck surface for the gear
  const booth = new THREE.Group();
  booth.position.set(0, stageH, z0 + 1.9);
  group.add(booth);
  const boothBody = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.02, 0.75), black);
  boothBody.position.y = 0.51;
  boothBody.castShadow = boothBody.receiveShadow = true;
  booth.add(boothBody);
  const facadeMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uKick: { value: 0 }, uWord: { value: null } },
    vertexShader: ledWallShader.vertexShader,
    fragmentShader: /* glsl */ `
      uniform float uTime, uKick; uniform sampler2D uWord; varying vec2 vUv;
      void main(){
        vec3 blue = vec3(0.025, 0.17, 1.0);
        float sweep = smoothstep(0.0, 0.25, 0.25 - abs(fract(vUv.x * 0.5 - uTime * 0.25) - 0.5));
        vec3 col = blue * (0.12 + 0.35 * uKick) + blue * sweep * 0.5;
        vec2 wu = (vUv - vec2(0.5, 0.5)) * vec2(2.3 / 1.4, 1.02 / (1.4 * 97.0 / 492.0)) + 0.5;
        float w = 0.0;
        if (wu.x > 0.0 && wu.x < 1.0 && wu.y > 0.0 && wu.y < 1.0) w = texture2D(uWord, wu).a;
        col = mix(col, vec3(0.85, 0.9, 1.0) * 1.4, w);
        float lines = 1.0;
        gl_FragColor = vec4(col * lines, 1.0);
      }`,
    fog: false,
  });
  const word = loader.load(BASE + 'textures/wordmark.png');
  facadeMat.uniforms.uWord.value = word;
  const facade = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.02), facadeMat);
  facade.position.set(0, 0.51, 0.376);
  booth.add(facade);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 0.85), deckMat);
  top.position.y = 1.04;
  booth.add(top);
  const deckY = 1.06;
  // two media players + mixer
  const jogMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.25, metalness: 0.8 });
  const ringMat = new THREE.MeshBasicMaterial({ color: BLUE.clone().multiplyScalar(4) });
  const jogs = [];
  for (const x of [-0.55, 0.55]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.1, 0.42), deckMat);
    p.position.set(x, deckY + 0.05, 0.02);
    p.castShadow = true;
    booth.add(p);
    const jog = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 40), jogMat);
    jog.position.set(x, deckY + 0.11, 0.05);
    booth.add(jog);
    jogs.push(jog);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.103, 0.004, 6, 48), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(jog.position).add(new THREE.Vector3(0, 0.011, 0));
    booth.add(ring);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3c6bff).multiplyScalar(1.5) }));
    screen.rotation.x = -Math.PI / 2 + 0.3;
    screen.position.set(x, deckY + 0.105, -0.13);
    booth.add(screen);
  }
  const mixer = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.42), deckMat);
  mixer.position.set(0, deckY + 0.045, 0.02);
  booth.add(mixer);
  const knobMat = new THREE.MeshStandardMaterial({ color: 0xd0d4dc, roughness: 0.3, metalness: 0.9 });
  const meters = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      const k = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.018, 12), knobMat);
      k.position.set(-0.12 + c * 0.08, deckY + 0.1, -0.15 + r * 0.055);
      booth.add(k);
    }
    const meter = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.002, 0.1), new THREE.MeshBasicMaterial({ color: 0x5f8cff }));
    meter.position.set(-0.12 + c * 0.08, deckY + 0.092, 0.12);
    booth.add(meter);
    meters.push(meter);
  }
  colliders.push({ min: new THREE.Vector2(-1.3, z0 + 1.4), max: new THREE.Vector2(1.3, z0 + 2.4) });

  // speaker stacks
  const gr = grille();
  const grilleMat = new THREE.MeshStandardMaterial({ map: gr, roughness: 0.8, metalness: 0.3 });
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x0e0e10, roughness: 0.7 });
  const cones = [];
  for (const s of [-1, 1]) {
    const stack = new THREE.Group();
    stack.position.set(s * 3.35, stageH, stageFront - 0.7);
    stack.rotation.y = -s * 0.25;
    group.add(stack);
    const sub = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.75, 0.8), black);
    sub.position.y = 0.375;
    sub.castShadow = true;
    stack.add(sub);
    for (const [y, r] of [[0.375, 0.28]]) {
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.5, 0.08, 40, 1, true), coneMat);
      cone.rotation.x = Math.PI / 2;
      cone.position.set(0, y, 0.38);
      stack.add(cone);
      cones.push(cone);
      const dust = new THREE.Mesh(new THREE.SphereGeometry(r * 0.28, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), alu);
      dust.rotation.x = Math.PI / 2;
      dust.position.set(0, y, 0.37);
      stack.add(dust);
      cones.push(dust);
    }
    for (let i = 0; i < 3; i++) {
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.36, 0.6), black);
      top.position.set(0, 0.95 + i * 0.38, -0.05);
      top.rotation.x = -i * 0.04;
      top.castShadow = true;
      stack.add(top);
      const g = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.3), grilleMat);
      g.position.set(0, 0.95 + i * 0.38, 0.252);
      stack.add(g);
    }
  }

  // truss with moving heads
  const truss = new THREE.Group();
  truss.position.set(0, ROOM.h - 0.45, stageFront - 0.6);
  group.add(truss);
  const tubeG = new THREE.CylinderGeometry(0.02, 0.02, 8, 8);
  for (const [y, z] of [[0.15, 0.15], [0.15, -0.15], [-0.15, 0.15], [-0.15, -0.15]]) {
    const t = new THREE.Mesh(tubeG, alu);
    t.rotation.z = Math.PI / 2;
    t.position.set(0, y, z);
    truss.add(t);
  }
  const diagG = new THREE.CylinderGeometry(0.008, 0.008, 0.42, 6);
  for (let i = -13; i <= 13; i++) {
    for (const [y, z, rx, rz] of [[0, 0.15, 0, 0.78], [0, -0.15, 0, -0.78], [0.15, 0, 0.78, Math.PI / 2], [-0.15, 0, -0.78, Math.PI / 2]]) {
      const d = new THREE.Mesh(diagG, alu);
      d.position.set(i * 0.3, y, z);
      d.rotation.set(rx, 0, rz);
      truss.add(d);
    }
  }
  const heads = [];
  const headX = [-2.7, -0.9, 0.9, 2.7];
  for (let i = 0; i < headX.length; i++) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.26), black);
    base.position.set(headX[i], -0.24, 0);
    truss.add(base);
    const yoke = new THREE.Group();
    yoke.position.set(headX[i], -0.32, 0);
    truss.add(yoke);
    const arms = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.06), black);
    arms.position.y = -0.1;
    yoke.add(arms);
    const tilt = new THREE.Group();
    tilt.position.y = -0.2;
    yoke.add(tilt);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.3, 20), black);
    tilt.add(head);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.085, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lens.rotation.x = Math.PI / 2;
    lens.position.y = -0.152;
    tilt.add(lens);
    const len = 9;
    const beamGeo = new THREE.CylinderGeometry(0.06, 0.75, len, 32, 1, true);
    beamGeo.translate(0, -len / 2, 0);
    const beam = new THREE.Mesh(beamGeo, beamMaterial(i % 2 ? 0x2f66ff : 0xbcd0ff));
    beam.material.uniforms.uLen.value = len;
    beam.position.y = -0.15;
    beam.frustumCulled = false;
    beam.renderOrder = 10;
    tilt.add(beam);
    heads.push({ yoke, tilt, beam, lens, i });
  }
  // two real spotlights follow beams 1 and 2 so the floor actually lights up
  const followSpots = [1, 2].map((k) => {
    const sp = new THREE.SpotLight(k === 1 ? 0x3a6bff : 0xcfdcff, 60, 14, 0.18, 0.5, 2);
    sp.position.set(0, 0, 0);
    group.add(sp, sp.target);
    return { sp, head: heads[k] };
  });

  // lasers: fans from the stage front
  const laserGroup = new THREE.Group();
  group.add(laserGroup);
  const lasers = [];
  const laserGeo = new THREE.BoxGeometry(0.006, 0.006, 16);
  laserGeo.translate(0, 0, 8);
  for (const s of [-1, 1]) {
    const emitter = new THREE.Group();
    emitter.position.set(s * 3.2, ROOM.h - 0.75, stageFront - 0.3);
    laserGroup.add(emitter);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.12, 0.3), black);
    emitter.add(box);
    for (let i = 0; i < 9; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(i % 3 === 0 ? 0x88aaff : 0x2457ff).multiplyScalar(5),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const l = new THREE.Mesh(laserGeo, mat);
      l.frustumCulled = false;
      emitter.add(l);
      lasers.push({ l, s, i, emitter });
    }
  }

  // DJ
  const dj = new DJMannequin();
  dj.group.position.set(0, stageH, z0 + 1.9 - 0.55);
  group.add(dj.group);

  const ledLightBase = 4;
  return {
    group,
    colliders,
    dj,
    deck: { y: deckY, z: 0.0 },
    boothWorld: new THREE.Vector3(0, 1.5, z0 + 1.9),
    update(dt, info) {
      const t = info.t;
      const secIdx = { groove: 0, build: 1, break: 2, drop: 3 }[info.section];
      ledMat.uniforms.uTime.value = t;
      ledMat.uniforms.uKick.value = info.kick;
      ledMat.uniforms.uEnergy.value = info.energy;
      ledMat.uniforms.uSection.value = secIdx;
      ledMat.uniforms.uBuild.value = info.buildUp;
      ledLight.intensity = ledLightBase * (0.5 + info.kick * info.energy);
      facadeMat.uniforms.uTime.value = t;
      facadeMat.uniforms.uKick.value = info.kick;
      noseMat.color.copy(BLUE).multiplyScalar(2 + 4 * info.kick);
      for (const j of jogs) j.rotation.y += dt * 3.5;
      meters.forEach((m, i) => (m.scale.z = 0.3 + 0.7 * Math.max(info.kick, 0.5 * Math.abs(Math.sin(t * 6 + i)))));
      for (const c of cones) c.position.z = (c.geometry.type === 'SphereGeometry' ? 0.37 : 0.38) + info.kick * 0.012 * info.energy;

      // moving heads choreography
      const drop = info.section === 'drop';
      const brk = info.section === 'break';
      for (const h of heads) {
        const ph = h.i * 1.3;
        const speed = drop ? 1.3 : brk ? 0.25 : 0.6;
        const pan = Math.sin(t * speed + ph) * (drop ? 0.9 : 0.5) + (h.i < 2 ? 0.25 : -0.25);
        const tilt = 0.55 + Math.sin(t * speed * 0.7 + ph * 2) * (drop ? 0.35 : 0.2);
        h.yoke.rotation.y = pan;
        h.tilt.rotation.x = tilt;
        let inten = brk ? 0.12 + 0.1 * Math.sin(t + h.i) : 0.35 + 0.65 * info.kick * info.energy;
        if (drop && (info.beat % 2 === 0) && info.phase < 0.12 && h.i % 2 === info.bar % 2) inten = 1.6; // strobe hits
        h.beam.material.uniforms.uIntensity.value = inten * 0.32;
        h.lens.material.color.setScalar(1 + inten * 6);
      }
      truss.updateMatrixWorld(true);
      for (const f of followSpots) {
        const head = f.head;
        const origin = new THREE.Vector3(0, -0.15, 0).applyMatrix4(head.tilt.matrixWorld);
        const dir = new THREE.Vector3(0, -1, 0).transformDirection(head.tilt.matrixWorld);
        f.sp.position.copy(origin);
        f.sp.target.position.copy(origin).addScaledVector(dir, 5);
        f.sp.intensity = 90 * head.beam.material.uniforms.uIntensity.value;
      }
      // lasers only in the build and the drop
      const laserOn = drop ? 1 : info.section === 'build' ? 0.35 : 0;
      laserGroup.visible = laserOn > 0;
      for (const L of lasers) {
        const fan = (L.i - 4) * (drop ? 0.11 : 0.07);
        const sweep = Math.sin(t * (drop ? 1.6 : 0.8) + L.s) * 0.5;
        L.l.rotation.set(0.1 + 0.05 * Math.sin(t * 0.9 + L.i), -L.s * 0.35 + fan + sweep * L.s * 0.6, 0);
        L.l.material.opacity = laserOn * (drop ? 0.6 + 0.4 * info.kick : 0.5);
        L.l.material.color.setScalar(0).add(new THREE.Color(L.i % 3 === 0 ? 0x88aaff : 0x2457ff).multiplyScalar(4 * laserOn * (0.6 + 0.6 * info.kick)));
      }
      dj.update(dt, info, { y: deckY - 0.02 });
    },
  };
}
