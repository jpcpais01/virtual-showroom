import * as THREE from 'three';

/**
 * Planar reflection for the polished floor (y = 0). Renders the scene from a
 * mirrored camera into a half-res target; the floor material samples it with
 * projective coordinates and blurs/distorts it to look like polished concrete
 * rather than a mirror. Based on three's Reflector (oblique near plane).
 */
export class FloorReflection {
  constructor(scale = 0.5) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 0 });
    this.target.texture.generateMipmaps = true;
    this.target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.camera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this.hidden = []; // objects not rendered in the reflection (the floor itself)
    this.enabled = true;
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
  }

  setSize(w, h) {
    this.target.setSize(Math.max(2, Math.floor(w * this.scale)), Math.max(2, Math.floor(h * this.scale)));
  }

  update(renderer, scene, camera) {
    if (!this.enabled) return;
    const vc = this.camera;
    const normal = new THREE.Vector3(0, 1, 0);
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);

    vc.position.set(camPos.x, -camPos.y, camPos.z);
    const target = look.clone();
    target.y = -target.y;
    vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    vc.lookAt(target);
    vc.far = camera.far;
    vc.near = camera.near;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix);
    this.textureMatrix.multiply(vc.matrixWorldInverse);

    // oblique near plane so nothing below the floor leaks into the reflection
    this._plane.setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(0, 0, 0));
    this._plane.applyMatrix4(vc.matrixWorldInverse);
    const clip = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const pm = vc.projectionMatrix;
    const q = this._q;
    q.x = (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    clip.multiplyScalar(2.0 / clip.dot(q));
    pm.elements[2] = clip.x;
    pm.elements[6] = clip.y;
    pm.elements[10] = clip.z + 1.0 - 0.003;
    pm.elements[14] = clip.w;

    for (const o of this.hidden) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, vc);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
    for (const o of this.hidden) o.visible = true;
  }

  /** Patch a MeshStandardMaterial so it adds the blurred reflection. */
  patch(material, { strength = 0.9, blur = 1.0 } = {}) {
    const self = this;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.tReflect = { value: self.target.texture };
      shader.uniforms.reflectMatrix = { value: self.textureMatrix };
      shader.uniforms.reflectStrength = { value: strength };
      shader.uniforms.reflectBlur = { value: blur };
      self.uniforms = shader.uniforms;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 reflectMatrix;\nvarying vec4 vReflUv;\nvarying vec3 vWPos;')
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vec4 wp4 = modelMatrix * vec4(transformed, 1.0);
           vReflUv = reflectMatrix * wp4;
           vWPos = wp4.xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform sampler2D tReflect;
           uniform float reflectStrength;
           uniform float reflectBlur;
           varying vec4 vReflUv;
           varying vec3 vWPos;
           float rHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }`,
        )
        .replace(
          '#include <opaque_fragment>',
          `
          {
            vec2 ruv = vReflUv.xy / vReflUv.w;
            // micro-roughness: perturb by the surface normal and a little noise
            vec2 jitter = normal.xz * 0.025 * reflectBlur;
            float rough = roughnessFactor;
            float lod = 1.0 + rough * 5.0 * reflectBlur;
            vec3 refl = vec3(0.0);
            float wsum = 0.0;
            for (int i = 0; i < 6; i++) {
              float a = float(i) * 2.399 + rHash(vWPos.xz * 37.0) * 6.283;
              float r = (0.0015 + 0.012 * rough) * reflectBlur * sqrt(float(i) + 0.5);
              vec2 o = vec2(cos(a), sin(a)) * r;
              refl += textureLod(tReflect, ruv + jitter + o, lod).rgb;
              wsum += 1.0;
            }
            refl /= wsum;
            vec3 V = normalize(cameraPosition - vWPos);
            float fres = 0.08 + 0.92 * pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
            outgoingLight += refl * reflectStrength * mix(0.35, 1.0, fres) * (1.0 - rough * 0.6);
          }
          #include <opaque_fragment>`,
        );
    };
    material.customProgramCacheKey = () => 'floor-reflect';
  }
}
