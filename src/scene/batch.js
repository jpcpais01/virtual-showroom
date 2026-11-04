import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Static batching. The room and stage are built from a few hundred small
 * meshes; drawing each separately (twice, with the floor reflection) costs a
 * lot of CPU per frame. Meshes that never move are merged into one mesh per
 * material, so the frame needs a few dozen draw calls instead of ~700.
 *
 * Which meshes move is found empirically: the scene's update functions are
 * run through every music section and anything whose transform or visibility
 * changes is left alone.
 */
export function batchStatic(scene, roots, { probe, exclude = [] }) {
  const excluded = new Set();
  for (const o of exclude) o.traverse((c) => excluded.add(c));

  const candidates = [];
  for (const root of roots)
    root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || excluded.has(o)) return;
      if (Array.isArray(o.material) || !o.geometry || o.geometry.morphAttributes?.position) return;
      candidates.push(o);
    });

  const visibleChain = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  scene.updateMatrixWorld(true);
  const before = candidates.map((o) => ({ m: o.matrixWorld.clone(), v: visibleChain(o) }));
  const moving = new Set();
  for (let k = 0; k < 24; k++) {
    probe(k);
    scene.updateMatrixWorld(true);
    candidates.forEach((o, i) => {
      if (!o.matrixWorld.equals(before[i].m) || visibleChain(o) !== before[i].v) moving.add(o);
    });
  }

  // group static meshes by everything that affects how they draw
  const groups = new Map();
  for (const o of candidates) {
    if (moving.has(o) || !visibleChain(o)) continue;
    const g = o.geometry;
    const attrs = Object.keys(g.attributes).sort().join(',');
    const key = [o.material.uuid, attrs, !!g.index, o.castShadow, o.receiveShadow, o.renderOrder, o.frustumCulled].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  let merged = 0;
  let removed = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const geos = list.map((o) => {
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      // mergeGeometries needs matching index presence and no groups
      g.clearGroups();
      return g;
    });
    const geo = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!geo) continue;
    const src = list[0];
    const mesh = new THREE.Mesh(geo, src.material);
    mesh.name = `batch:${src.material.name || src.material.type}`;
    mesh.castShadow = src.castShadow;
    mesh.receiveShadow = src.receiveShadow;
    mesh.renderOrder = src.renderOrder;
    mesh.frustumCulled = src.frustumCulled;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    for (const o of list) {
      o.parent.remove(o);
      removed++;
    }
    merged++;
  }
  return { merged, removed, moving: moving.size };
}
