// Precipitation and atmosphere living inside the cube.
// Particles are advanced entirely on the GPU: the CPU only ever writes a
// handful of uniforms, so a heavy downpour costs the same as drizzle.

import * as THREE from 'three';
import { CUBE_SIZE, HALF } from './cube.js';

const RAIN_MAX = 9000;
const SNOW_MAX = 6000;
const DRIFT_MAX = 900;

const COMMON_VERT_HEAD = /* glsl */ `
  uniform float uTime;
  uniform vec2  uWind;
  uniform float uCount;      // how many instances are currently active
  uniform float uSpan;       // cube extent the particles wrap inside
  uniform float uSize;
  uniform float uLength;
  uniform float uFallSpeed;

  attribute vec3 iSeed;      // three independent randoms per instance
  attribute float iIndex;

  varying float vFade;
  varying vec2 vLocal;

  float wrap(float v, float span) {
    return mod(v + span * 0.5, span) - span * 0.5;
  }
`;

const RAIN_VERT = /* glsl */ `
  ${COMMON_VERT_HEAD}

  void main() {
    // Instances beyond the active count collapse to a degenerate point.
    if (iIndex >= uCount) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vFade = 0.0;
      vLocal = vec2(0.0);
      return;
    }

    float speed = uFallSpeed * (0.75 + iSeed.z * 0.5);
    vec3 base = (iSeed - 0.5) * uSpan;

    vec3 p;
    p.x = wrap(base.x + uWind.x * uTime * 0.05, uSpan);
    p.z = wrap(base.z + uWind.y * uTime * 0.05, uSpan);
    p.y = wrap(base.y - speed * uTime, uSpan);

    // Streaks lie along the drop's own velocity, tilted by wind.
    vec3 vel = normalize(vec3(uWind.x * 0.06, -1.0, uWind.y * 0.06));
    vec3 toCam = normalize(cameraPosition - p);
    vec3 right = normalize(cross(vel, toCam));

    float len = uLength * (0.7 + iSeed.x * 0.6);
    vec3 world = p + right * position.x * uSize + vel * position.y * len;

    vLocal = position.xy;
    vFade = 0.45 + iSeed.y * 0.55;

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const RAIN_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  varying vec2 vLocal;

  void main() {
    // Soft-edged streak: fade across the width and at both ends.
    float across = 1.0 - smoothstep(0.15, 0.5, abs(vLocal.x));
    float along = 1.0 - smoothstep(0.25, 0.5, abs(vLocal.y));
    float a = across * along * vFade * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const FLAKE_VERT = /* glsl */ `
  ${COMMON_VERT_HEAD}
  uniform float uSway;

  void main() {
    if (iIndex >= uCount) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vFade = 0.0;
      vLocal = vec2(0.0);
      return;
    }

    float speed = uFallSpeed * (0.55 + iSeed.z * 0.9);
    vec3 base = (iSeed - 0.5) * uSpan;
    float phase = iSeed.x * 31.4;

    vec3 p;
    p.y = wrap(base.y - speed * uTime, uSpan);
    p.x = wrap(base.x + uWind.x * uTime * 0.05 + sin(uTime * 0.9 + phase) * uSway, uSpan);
    p.z = wrap(base.z + uWind.y * uTime * 0.05 + cos(uTime * 0.7 + phase * 1.3) * uSway, uSpan);

    vec3 toCam = normalize(cameraPosition - p);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 up = normalize(cross(toCam, right));

    float s = uSize * (0.55 + iSeed.y * 0.9);
    vec3 world = p + right * position.x * s + up * position.y * s;

    vLocal = position.xy;
    vFade = 0.5 + iSeed.z * 0.5;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FLAKE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  varying vec2 vLocal;

  void main() {
    float d = length(vLocal) * 2.0;
    float a = (1.0 - smoothstep(0.35, 1.0, d)) * vFade * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

function makeInstanced({ count, vert, frag, uniforms, blending }) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;

  const seeds = new Float32Array(count * 3);
  const indices = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i * 3 + 0] = Math.random();
    seeds[i * 3 + 1] = Math.random();
    seeds[i * 3 + 2] = Math.random();
    indices[i] = i;
  }
  geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  geo.setAttribute('iIndex', new THREE.InstancedBufferAttribute(indices, 1));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CUBE_SIZE);

  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: blending ?? THREE.NormalBlending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

export class WeatherFX {
  constructor(shared, clipPlanes) {
    this.group = new THREE.Group();
    this.shared = shared;

    this.rain = makeInstanced({
      count: RAIN_MAX,
      vert: RAIN_VERT,
      frag: RAIN_FRAG,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: shared.uTime,
        uWind: shared.uWind,
        uCount: { value: 0 },
        uSpan: { value: CUBE_SIZE * 0.995 },
        uSize: { value: 0.0035 },
        uLength: { value: 0.075 },
        uFallSpeed: { value: 2.2 },
        uColor: { value: new THREE.Color(0xbcd2ea) },
        uOpacity: { value: 0.55 },
      },
    });

    this.snow = makeInstanced({
      count: SNOW_MAX,
      vert: FLAKE_VERT,
      frag: FLAKE_FRAG,
      uniforms: {
        uTime: shared.uTime,
        uWind: shared.uWind,
        uCount: { value: 0 },
        uSpan: { value: CUBE_SIZE * 0.995 },
        uSize: { value: 0.012 },
        uLength: { value: 0 },
        uFallSpeed: { value: 0.16 },
        uSway: { value: 0.05 },
        uColor: { value: new THREE.Color(0xffffff) },
        uOpacity: { value: 0.9 },
      },
    });

    // Dust, pollen or leaf litter — what a dry gale actually looks like.
    this.drift = makeInstanced({
      count: DRIFT_MAX,
      vert: FLAKE_VERT,
      frag: FLAKE_FRAG,
      uniforms: {
        uTime: shared.uTime,
        uWind: shared.uWind,
        uCount: { value: 0 },
        uSpan: { value: CUBE_SIZE * 0.995 },
        uSize: { value: 0.008 },
        uLength: { value: 0 },
        uFallSpeed: { value: 0.03 },
        uSway: { value: 0.12 },
        uColor: { value: new THREE.Color(0xd8c9a8) },
        uOpacity: { value: 0.35 },
      },
    });

    this.group.add(this.rain, this.snow, this.drift);

    // Volumetric-ish fog: a stack of soft horizontal sheets. Cheap, and it
    // gives fog real depth as the cube rotates.
    this.fog = this._buildFogSheets(clipPlanes);
    this.group.add(this.fog);

    this._flash = 0;
    this._nextStrike = 3;
    this._strikeEnergy = 0;
  }

  _buildFogSheets(clipPlanes) {
    const group = new THREE.Group();
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);

    const layers = 12;
    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        color: 0xc9cfd6,
        clippingPlanes: clipPlanes || null,
      });
      // Sheets stay inside the cube; anything wider pokes through the glass.
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(CUBE_SIZE * 0.99, CUBE_SIZE * 0.99), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = -HALF * 0.99 + t * CUBE_SIZE * 0.82;
      mesh.userData.baseHeight = mesh.position.y;
      mesh.userData.t = t;
      mesh.renderOrder = 9;
      group.add(mesh);
    }
    return group;
  }

  /** @param {number} quality 0.35..1 — scales particle counts for weaker GPUs */
  applyClimate(climate, quality = 1) {
    const q = THREE.MathUtils.clamp(quality, 0.2, 1);

    // Rain
    const rainCount = Math.floor(RAIN_MAX * climate.rainRate * q);
    this.rain.material.uniforms.uCount.value = rainCount;
    this.rain.geometry.instanceCount = rainCount;
    this.rain.visible = rainCount > 0;
    this.rain.material.uniforms.uFallSpeed.value = 1.6 + climate.rainRate * 1.9;
    this.rain.material.uniforms.uLength.value = 0.045 + climate.rainRate * 0.075;
    this.rain.material.uniforms.uOpacity.value = 0.28 + climate.rainRate * 0.45;
    this.rain.material.uniforms.uColor.value
      .set(0xbcd2ea)
      .lerp(new THREE.Color(0x6c7a8c), climate.night * 0.75);

    // Snow
    const snowCount = Math.floor(SNOW_MAX * climate.snowRate * q);
    this.snow.material.uniforms.uCount.value = snowCount;
    this.snow.geometry.instanceCount = snowCount;
    this.snow.visible = snowCount > 0;
    this.snow.material.uniforms.uFallSpeed.value = 0.10 + climate.snowRate * 0.13;
    this.snow.material.uniforms.uSway.value = 0.03 + Math.min(climate.windSpeed, 14) * 0.006;
    this.snow.material.uniforms.uSize.value = 0.009 + climate.snowRate * 0.008;
    this.snow.material.uniforms.uOpacity.value = 0.6 + climate.snowRate * 0.35;

    // Wind-blown debris, only when it is dry and actually blowing.
    const dry = climate.rainRate < 0.05 && climate.snowRate < 0.05;
    const gust = THREE.MathUtils.clamp((climate.windSpeed - 4) / 12, 0, 1);
    const driftCount = Math.floor(DRIFT_MAX * (dry ? gust : 0) * q);
    this.drift.material.uniforms.uCount.value = driftCount;
    this.drift.geometry.instanceCount = driftCount;
    this.drift.visible = driftCount > 0;
    this.drift.material.uniforms.uOpacity.value = 0.18 + gust * 0.25;

    // Ground fog
    const fogStrength = climate.groundFog;
    for (const sheet of this.fog.children) {
      const t = sheet.userData.t;
      // Densest near the ground, thinning with height. Kept light enough that
      // the nearest buildings still read through it.
      sheet.material.opacity = fogStrength * (0.20 * (1 - t * 0.55));
      sheet.material.color.copy(climate.fogColor);
      sheet.visible = sheet.material.opacity > 0.004;
    }
    this.fog.visible = fogStrength > 0.01;

    this._thunder = climate.thunder;
    this._climate = climate;
  }

  /** @returns {number} current lightning flash value, 0..1 */
  update(dt, time) {
    // Drift the fog sheets with the wind so the whole box feels alive.
    const wind = this.shared.uWind.value;
    for (const sheet of this.fog.children) {
      sheet.position.x = Math.sin(time * 0.05 + sheet.userData.t * 3) * 0.05 * (1 + wind.length() * 0.05);
      sheet.position.z = Math.cos(time * 0.04 + sheet.userData.t * 2) * 0.05;
      sheet.position.y = sheet.userData.baseHeight + Math.sin(time * 0.3 + sheet.userData.t * 6) * 0.01;
    }

    // Lightning: an initial stroke, a couple of flickers, then a long wait.
    this._flash = Math.max(0, this._flash - dt * 5.5);
    if (this._thunder) {
      this._nextStrike -= dt;
      if (this._nextStrike <= 0) {
        this._strikeEnergy = 0.55 + Math.random() * 0.75;
        this._flash = this._strikeEnergy;
        this._nextStrike = 2.5 + Math.random() * 7;
        this._flickers = 1 + Math.floor(Math.random() * 3);
        this._flickerIn = 0.06;
      }
      if (this._flickers > 0) {
        this._flickerIn -= dt;
        if (this._flickerIn <= 0) {
          this._flash = this._strikeEnergy * (0.4 + Math.random() * 0.5);
          this._flickers--;
          this._flickerIn = 0.05 + Math.random() * 0.09;
        }
      }
    }
    return this._flash;
  }
}
