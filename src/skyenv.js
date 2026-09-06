// The simulated sky, captured into a cubemap and used as the scene's
// environment light. This is what lets a wet street reflect the actual
// overcast above it, and gives every surface ambient light of the right
// colour instead of a flat grey guess.

import * as THREE from 'three';
import { NOISE, SKY_UNIFORMS, SKY_FUNCTION } from './glsl.js';

const ENV_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// No tone mapping and no colour-space conversion: this is written to a
// half-float target and consumed as linear radiance by the PBR materials.
const ENV_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  uniform vec3 uFogColor;   // declared alongside the shared block, not in it

  ${NOISE}
  ${SKY_UNIFORMS}
  ${SKY_FUNCTION}

  void main() {
    vec3 dir = normalize(vWorldPos);
    vec3 col = skyColor(dir);

    // Below the horizon a surface sees ground, not sky. Cities bounce a
    // surprising amount of light back up, and warm sodium light after dark.
    vec3 ground = mix(uGroundHaze, uFogColor, 0.35) * 0.45;
    ground = mix(ground, vec3(0.16, 0.10, 0.05), uNight * 0.7);
    col = mix(col, ground, smoothstep(0.02, -0.3, dir.y));

    col *= uExposure;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const REBUILD_INTERVAL_MS = 180;

export class SkyEnvironment {
  constructor(shared) {
    this.target = new THREE.WebGLCubeRenderTarget(128, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.cubeCamera = new THREE.CubeCamera(0.1, 20, this.target);

    this.scene = new THREE.Scene();
    this.material = new THREE.ShaderMaterial({
      vertexShader: ENV_VERT,
      fragmentShader: ENV_FRAG,
      uniforms: { ...shared },
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), this.material));

    this.pmrem = null;
    this.generated = null;
    this.dirty = true;
    this._lastBuilt = 0;
  }

  /** @returns {THREE.Texture|null} the filtered environment, once built */
  get texture() {
    return this.generated?.texture || null;
  }

  /**
   * Rebuild if the weather has changed, at most a few times a second — the
   * hour slider can fire this on every frame of a drag otherwise.
   * @returns {boolean} whether the environment was replaced this call
   */
  update(renderer, now = performance.now()) {
    if (!this.dirty || now - this._lastBuilt < REBUILD_INTERVAL_MS) return false;
    this.dirty = false;
    this._lastBuilt = now;

    this.cubeCamera.update(renderer, this.scene);

    // Prefiltering is what makes rough surfaces sample a blurred sky and
    // polished ones a sharp reflection.
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.pmrem.compileCubemapShader();
    }
    const next = this.pmrem.fromCubemap(this.target.texture);
    this.generated?.dispose();
    this.generated = next;
    return true;
  }

  dispose() {
    this.generated?.dispose();
    this.pmrem?.dispose();
    this.target.dispose();
    this.material.dispose();
  }
}
