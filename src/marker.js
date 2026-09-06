// A marker standing on the address itself. The cube is centred on the
// geocoded point, so the marker is simply at the origin — but it has to stay
// findable inside real photogrammetry, where buildings will hide it.

import * as THREE from 'three';
import { GROUND_TOP } from './slabs.js';

const BEAM_HEIGHT = 0.78;   // cube units, comfortably above any roofline
const BEAM_RADIUS = 0.012;

const BEAM_VERT = /* glsl */ `
  varying float vH;
  varying vec2 vUvB;
  void main() {
    vUvB = uv;
    vH = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BEAM_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying float vH;
  varying vec2 vUvB;

  void main() {
    // Bright at the base, fading out as it rises.
    float fade = pow(1.0 - vH, 1.7);
    // A slow pulse travelling up the beam, so it reads as a marker and not
    // as a piece of the scene.
    float pulse = 0.72 + 0.28 * sin((vH * 5.0) - uTime * 2.1);
    // The cylinder's silhouette edges catch more light than its middle.
    float edge = 0.55 + 0.45 * abs(sin(vUvB.x * 3.14159));
    float a = fade * pulse * edge * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const RING_VERT = /* glsl */ `
  varying vec2 vUvR;
  void main() {
    vUvR = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUvR;

  void main() {
    // Two rings expanding out of the centre and fading as they go.
    float r = length(vUvR - 0.5) * 2.0;
    float a = 0.0;
    for (int i = 0; i < 2; i++) {
      float phase = fract(uTime * 0.45 + float(i) * 0.5);
      float band = smoothstep(0.05, 0.0, abs(r - phase));
      a += band * (1.0 - phase);
    }
    // A fixed ring so the spot is marked even between pulses.
    a += smoothstep(0.04, 0.0, abs(r - 0.55)) * 0.7;
    a *= smoothstep(1.0, 0.85, r) * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * The pin, built twice: once depth-tested so it sits correctly among the
 * buildings, and once drawn over everything at low opacity so it can still be
 * found when a roof is in the way.
 */
export class AddressMarker {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'address-marker';

    this.uniforms = {
      uColor: { value: new THREE.Color(0xff6b45) },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
    };
    this.ghostUniforms = {
      uColor: { value: new THREE.Color(0xff8a63) },
      uOpacity: { value: 0.22 },
      uTime: this.uniforms.uTime,
    };

    const beamGeo = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS * 1.5, BEAM_HEIGHT, 12, 1, true);
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0);

    const ringGeo = new THREE.PlaneGeometry(0.42, 0.42);
    ringGeo.rotateX(-Math.PI / 2);

    const headGeo = new THREE.OctahedronGeometry(0.026, 0);
    headGeo.translate(0, BEAM_HEIGHT, 0);

    for (const [uniforms, depthTest, order] of [
      [this.ghostUniforms, false, 26],
      [this.uniforms, true, 12],
    ]) {
      const beamMat = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const ringMat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const headMat = new THREE.MeshBasicMaterial({
        color: uniforms.uColor.value,
        transparent: true,
        opacity: uniforms === this.uniforms ? 1 : 0.3,
        depthWrite: false,
        depthTest,
      });

      const beam = new THREE.Mesh(beamGeo, beamMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      const head = new THREE.Mesh(headGeo, headMat);
      beam.renderOrder = ring.renderOrder = head.renderOrder = order;
      this.group.add(beam, ring, head);
    }

    this.group.position.y = GROUND_TOP + 0.002;

    // Where the label should point, in world space.
    this.headWorld = new THREE.Vector3(0, GROUND_TOP + BEAM_HEIGHT, 0);
  }

  /** Follow the ground when the photoreal tiles settle to street level. */
  setGroundY(y) {
    this.group.position.y = y + 0.002;
    this.headWorld.set(0, y + BEAM_HEIGHT, 0);
  }

  update(time) {
    this.uniforms.uTime.value = time;
  }

  applyClimate(climate) {
    // Warmer and brighter at night, so it stays readable against lit windows.
    this.uniforms.uColor.value
      .set(0xff6b45)
      .lerp(new THREE.Color(0xffb066), climate.night * 0.5);
    this.uniforms.uOpacity.value = 0.85 + climate.night * 0.15;
  }
}
