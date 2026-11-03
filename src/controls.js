import * as THREE from 'three';

/**
 * First-person walk/look controls for desktop and touch.
 *  - drag: look around (or whatever a hook claims, e.g. pulling cloth)
 *  - tap the floor: walk there; WASD / arrows: walk; wheel: step forward/back
 *  - desktop "mouse look" mode: the cursor is hidden (pointer lock) and moving
 *    the mouse turns the view; clicks act on whatever the reticle is on.
 */
export class WalkControls {
  constructor(camera, dom, { bounds, colliders = [], start }) {
    this.camera = camera;
    this.dom = dom;
    this.bounds = bounds;
    this.colliders = colliders;
    this.enabled = false;
    this.lockMove = false;
    this.pos = start.pos.clone();
    this.yaw = start.yaw;
    this.pitch = start.pitch;
    this.yawT = this.yaw; // look targets: the view eases towards them
    this.pitchT = this.pitch;
    this.vel = new THREE.Vector3();
    this.keys = new Set();
    this.walkTarget = null;
    this.fly = null;
    this.bob = 0;
    this.eye = 1.65;
    // hooks (return true when handled)
    this.onTap = null;
    this.onDragStart = null;
    this.onDragMove = null;
    this.onDragEnd = null;
    this.onLookDrag = null;
    this.onWheel = null;

    this._down = null;
    this._mode = null;
    this.onLockChange = null;
    this.mouseLook = false; // set by the app on desktop
    this._lockedAt = 0;
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.dom.classList.remove('is-locked');
      else {
        this.dom.classList.add('is-locked');
        this._lockedAt = performance.now();
      }
      this.onLockChange && this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockChange && this.onLockChange(false));
    addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      // browsers sometimes report one huge jump right after locking: skip it
      if (performance.now() - this._lockedAt < 120) return;
      if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
      // raw mouse deltas while the cursor is hidden; turn directly, no lag
      const k = 0.0022;
      this.yawT -= e.movementX * k;
      this.pitchT = THREE.MathUtils.clamp(this.pitchT - e.movementY * k, -1.2, 1.2);
      this.yaw = this.yawT;
      this.pitch = this.pitchT;
      this.fly = null;
    });
    dom.addEventListener('pointerdown', (e) => this._pd(e));
    addEventListener('pointermove', (e) => this._pm(e));
    addEventListener('pointerup', (e) => this._pu(e));
    addEventListener('pointercancel', (e) => this._pu(e));
    dom.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (/Arrow|Key[WASD]/.test(e.code)) {
        this.walkTarget = null;
        this.fly = null;
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this._apply();
  }

  get locked() {
    return document.pointerLockElement === this.dom;
  }
  /** hide the cursor and turn with the mouse (needs a user gesture) */
  lock() {
    if (!this.mouseLook || this.locked || !this.dom.requestPointerLock) return;
    try {
      const p = this.dom.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.dom.requestPointerLock()?.catch?.(() => {}));
    } catch {
      try {
        this.dom.requestPointerLock();
      } catch {}
    }
  }
  unlock() {
    if (this.locked) document.exitPointerLock();
  }
  /** a synthetic pointer event at the centre of the view (the reticle) */
  centreEvent() {
    const r = this.dom.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse' };
  }

  _pd(e) {
    if (!this.enabled) return;
    if (this.locked) {
      // click while looking around: act on whatever is under the reticle
      if (e.button !== 0) return;
      const c = this.centreEvent();
      if (!(this.onTap && this.onTap(c))) this._walkToPointer(c);
      return;
    }
    if (this.mouseLook && this.onUnlockedClick && this.onUnlockedClick(e)) return;
    this.dom.setPointerCapture?.(e.pointerId);
    this._down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, ev: e, t: performance.now(), id: e.pointerId };
    this._mode = null;
  }
  _pm(e) {
    const d = this._down;
    if (!d || e.pointerId !== d.id) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (!this._mode && moved > 5) {
      this._mode = this.onDragStart && this.onDragStart(d.ev) ? 'grab' : 'look';
      if (this._mode === 'look') this.dom.classList.add('is-dragging');
    }
    if (this._mode === 'grab') this.onDragMove && this.onDragMove(e);
    if (this._mode === 'look') {
      const dx = e.clientX - d.lx;
      const dy = e.clientY - d.ly;
      if (!(this.onLookDrag && this.onLookDrag(dx, dy))) {
        const k = e.pointerType === 'touch' ? 0.0055 : 0.0038;
        this.yawT -= dx * k;
        this.pitchT = THREE.MathUtils.clamp(this.pitchT - dy * k, -1.2, 1.2);
        this.fly = null;
      }
    }
    d.lx = e.clientX;
    d.ly = e.clientY;
  }
  _pu(e) {
    const d = this._down;
    if (!d || e.pointerId !== d.id) return;
    if (this._mode === 'grab') this.onDragEnd && this.onDragEnd(e);
    else if (!this._mode && performance.now() - d.t < 600) {
      if (!(this.onTap && this.onTap(e))) this._walkToPointer(e);
    }
    this.dom.classList.remove('is-dragging');
    this._down = null;
    this._mode = null;
  }
  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    if (this.onWheel && this.onWheel(e.deltaY)) return;
    if (this.lockMove) return;
    const f = this._forward();
    this.walkTarget = null;
    this.fly = null;
    this._move(f.multiplyScalar(-e.deltaY * 0.0025));
  }

  _forward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  _walkToPointer(e) {
    if (this.lockMove) return;
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return;
    if (p.distanceTo(this.pos) > 18) return;
    // stop a bit short of where you clicked
    const dir = p.clone().sub(this.pos).setY(0);
    const len = dir.length();
    if (len < 0.3) return;
    this.walkTarget = this.pos.clone().add(dir.multiplyScalar(Math.max(0, len - 0.6) / len));
    this.fly = null;
  }

  flyTo(pos, yaw, pitch) {
    // shortest yaw path
    let dy = yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.fly = { from: this.pos.clone(), to: pos.clone(), yaw0: this.yaw, yaw1: this.yaw + dy, p0: this.pitch, p1: pitch, t: 0 };
    this.walkTarget = null;
  }

  _move(delta) {
    const p = this.pos.clone().add(delta);
    const m = 0.35;
    const b = this.bounds;
    p.x = THREE.MathUtils.clamp(p.x, b.x0 + m, b.x1 - m);
    p.z = THREE.MathUtils.clamp(p.z, b.z0 + m, b.z1 - m);
    for (const c of this.colliders) {
      const minX = c.min.x - m, maxX = c.max.x + m, minZ = c.min.y - m, maxZ = c.max.y + m;
      if (p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ) {
        // push out along the shallowest axis
        const dx1 = p.x - minX, dx2 = maxX - p.x, dz1 = p.z - minZ, dz2 = maxZ - p.z;
        const mn = Math.min(dx1, dx2, dz1, dz2);
        if (mn === dx1) p.x = minX;
        else if (mn === dx2) p.x = maxX;
        else if (mn === dz1) p.z = minZ;
        else p.z = maxZ;
      }
    }
    const moved = p.distanceTo(this.pos);
    this.pos.copy(p);
    return moved;
  }

  update(dt) {
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / 1.3);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.pos.lerpVectors(f.from, f.to, e);
      this.yaw = f.yaw0 + (f.yaw1 - f.yaw0) * e;
      this.pitch = f.p0 + (f.p1 - f.p0) * e;
      this.yawT = this.yaw;
      this.pitchT = this.pitch;
      if (f.t >= 1) this.fly = null;
    } else if (this.enabled && !this.lockMove) {
      const input = new THREE.Vector3();
      const fwd = this._forward();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const k = this.keys;
      if (k.has('KeyW') || k.has('ArrowUp')) input.add(fwd);
      if (k.has('KeyS') || k.has('ArrowDown')) input.sub(fwd);
      if (k.has('KeyD')) input.add(right);
      if (k.has('KeyA')) input.sub(right);
      if (k.has('ArrowLeft')) this.yawT += dt * 1.8;
      if (k.has('ArrowRight')) this.yawT -= dt * 1.8;
      const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? 3.6 : 2.1;
      if (input.lengthSq() > 0) {
        input.normalize().multiplyScalar(speed);
        this.vel.lerp(input, Math.min(1, dt * 8));
      } else if (this.walkTarget) {
        const d = this.walkTarget.clone().sub(this.pos).setY(0);
        const len = d.length();
        if (len < 0.05) {
          this.walkTarget = null;
          this.vel.set(0, 0, 0);
        } else {
          this.vel.lerp(d.normalize().multiplyScalar(Math.min(2.2, len * 2.2)), Math.min(1, dt * 6));
        }
      } else {
        this.vel.multiplyScalar(Math.max(0, 1 - dt * 10));
      }
      const moved = this._move(this.vel.clone().multiplyScalar(dt));
      if (this.walkTarget && moved < this.vel.length() * dt * 0.2) this.walkTarget = null; // blocked
      this.bob += moved * 5.5;
    }
    this._ease(dt);
    this._apply();
  }

  _ease(dt) {
    if (this.fly) return;
    const k = 1 - Math.exp(-dt * 16);
    this.yaw += (this.yawT - this.yaw) * k;
    this.pitch += (this.pitchT - this.pitch) * k;
  }

  _apply() {
    const c = this.camera;
    c.position.set(this.pos.x, this.pos.y + Math.sin(this.bob) * 0.012, this.pos.z);
    c.rotation.set(0, 0, 0, 'YXZ');
    c.rotation.order = 'YXZ';
    c.rotation.y = this.yaw;
    c.rotation.x = this.pitch;
    c.updateMatrixWorld();
  }
}
