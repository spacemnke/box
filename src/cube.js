// The cube itself: six inward-facing interior panels, a glass shell around
// them, an edge frame and the contact shadow that sits it on a surface.

import * as THREE from 'three';
import {
  PHOTO_VERT,
  PHOTO_FRAG,
  SKYBOX_VERT,
  SKYBOX_FRAG,
  NOISE,
  SKY_UNIFORMS,
  SKY_FUNCTION,
} from './glsl.js';

export const CUBE_SIZE = 2;
export const HALF = CUBE_SIZE / 2;

/** Shared uniform objects — one instance drives every shader in the scene. */
export function createSharedUniforms() {
  return {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uSunColor: { value: new THREE.Color(0xfff0dd) },
    uZenith: { value: new THREE.Color(0x3f79d6) },
    uHorizon: { value: new THREE.Color(0xb9d3ef) },
    uGroundHaze: { value: new THREE.Color(0x6d7783) },
    uSunAltitude: { value: 0.5 },
    uMoonPhase: { value: 0.5 },
    uCloudCover: { value: 0.3 },
    uCloudDark: { value: 0 },
    uCloudHeight: { value: 1.0 },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0) },
    uNight: { value: 0 },
    uHaze: { value: 0.05 },
    uFlash: { value: 0 },
    uExposure: { value: 1 },
    uFogColor: { value: new THREE.Color(0xc7ccd2) },
  };
}

// name, position, euler rotation, Street View heading/pitch for that face
export const FACES = [
  { name: 'north', pos: [0, 0, -HALF], rot: [0, 0, 0], heading: 0, pitch: 0 },
  { name: 'east', pos: [HALF, 0, 0], rot: [0, -Math.PI / 2, 0], heading: 90, pitch: 0 },
  { name: 'south', pos: [0, 0, HALF], rot: [0, Math.PI, 0], heading: 180, pitch: 0 },
  { name: 'west', pos: [-HALF, 0, 0], rot: [0, Math.PI / 2, 0], heading: 270, pitch: 0 },
  { name: 'up', pos: [0, HALF, 0], rot: [Math.PI / 2, 0, 0], heading: 0, pitch: 90 },
  { name: 'down', pos: [0, -HALF, 0], rot: [-Math.PI / 2, 0, 0], heading: 0, pitch: -90 },
];

function photoMaterial(shared, { isGround }) {
  return new THREE.ShaderMaterial({
    vertexShader: PHOTO_VERT,
    fragmentShader: PHOTO_FRAG,
    side: THREE.FrontSide,
    uniforms: {
      ...shared,
      uMap: { value: null },
      uHasMap: { value: 0 },
      uIsGround: { value: isGround ? 1 : 0 },
      uWet: { value: 0 },
      uSnow: { value: 0 },
      uFogAmount: { value: 0 },
      uSkyReplace: { value: 1 },
      uWindow: { value: 0 },
      uRipple: { value: 0 },
      uSnowFlecks: { value: 0 },
    },
  });
}

function skyMaterial(shared, { isGround }) {
  return new THREE.ShaderMaterial({
    vertexShader: SKYBOX_VERT,
    fragmentShader: SKYBOX_FRAG,
    side: THREE.FrontSide,
    uniforms: {
      ...shared,
      uIsGround: { value: isGround ? 1 : 0 },
    },
  });
}

/**
 * Six panels forming the inside of the cube. Each panel faces the centre, so
 * the direction from the centre to a fragment is the panorama direction —
 * which is exactly what the sky and photo shaders want.
 */
export class CubeShell {
  constructor(shared) {
    this.shared = shared;
    this.group = new THREE.Group();
    this.faces = {};

    const geo = new THREE.PlaneGeometry(CUBE_SIZE, CUBE_SIZE, 1, 1);

    for (const face of FACES) {
      const isGround = face.name === 'down';
      const photo = photoMaterial(shared, { isGround });
      const sky = skyMaterial(shared, { isGround });

      const mesh = new THREE.Mesh(geo, sky);
      mesh.position.set(...face.pos);
      mesh.rotation.set(...face.rot);
      mesh.renderOrder = 0;
      mesh.name = `face-${face.name}`;
      this.group.add(mesh);

      this.faces[face.name] = { ...face, mesh, photo, sky, isGround };
    }
  }

  /** 'photo' shows Street View panels; 'sky' shows open sky (model mode). */
  setMode(mode) {
    for (const key of Object.keys(this.faces)) {
      const f = this.faces[key];
      // The top panel always renders live sky: a photographed sky cannot
      // change weather, and the top of the cube is where weather reads best.
      const usePhoto = mode === 'photo' && key !== 'up' && f.photo.uniforms.uHasMap.value > 0.5;
      f.mesh.material = usePhoto ? f.photo : f.sky;
    }
  }

  setFaceTexture(name, texture) {
    const f = this.faces[name];
    if (!f) return;
    f.photo.uniforms.uMap.value = texture;
    f.photo.uniforms.uHasMap.value = texture ? 1 : 0;
  }

  clearTextures() {
    for (const f of Object.values(this.faces)) {
      f.photo.uniforms.uMap.value?.dispose?.();
      f.photo.uniforms.uMap.value = null;
      f.photo.uniforms.uHasMap.value = 0;
    }
  }

  /** Per-frame weather values that only the photo panels care about. */
  applyClimate(climate) {
    for (const f of Object.values(this.faces)) {
      const u = f.photo.uniforms;
      u.uWet.value = climate.wetness;
      u.uSnow.value = climate.snowCover;
      u.uFogAmount.value = climate.photoFog * (f.isGround ? 0.55 : 1.0);
      u.uWindow.value = climate.night * 0.9;
      u.uRipple.value = climate.rainRate * (1 - climate.snowCover);
      u.uSnowFlecks.value = climate.snowRate;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Glass shell                                                         */
/* ------------------------------------------------------------------ */

const GLASS_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const GLASS_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec2 vUv;

  uniform float uDroplets;   // rain on the glass
  uniform float uFrost;      // condensation / ice
  uniform float uTint;

  ${NOISE}
  ${SKY_UNIFORMS}
  ${SKY_FUNCTION}

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - clamp(dot(viewDir, vNormalW), 0.0, 1.0), 3.2);

    // Reflect the simulated sky off the pane so the glass belongs to the scene.
    vec3 refl = reflect(-viewDir, vNormalW);
    vec3 env = skyColor(refl) * 0.55;

    float alpha = fres * 0.55 + 0.05;
    vec3 col = env * (fres * 0.9 + 0.12);

    // A hard specular glint along the sun direction sells "glass".
    float spec = pow(max(dot(refl, uSunDir), 0.0), 220.0);
    col += uSunColor * spec * 1.6 * smoothstep(-0.05, 0.15, uSunDir.y);

    // Beads of water running down the outside.
    if (uDroplets > 0.001) {
      // Small beads on a fine grid, each sliding at its own pace.
      vec2 p = vUv * vec2(34.0, 46.0);
      vec2 cell = floor(p);
      float seed = hash21(cell);
      vec2 f = fract(p) - 0.5;
      float fall = fract(seed * 7.3 + uTime * (0.06 + seed * 0.20));
      f.y += (fall - 0.5) * 0.9;
      float d = length(f * vec2(1.0, 0.8));
      float bead = smoothstep(0.20 * (0.35 + seed * 0.65), 0.03, d);
      float trail = smoothstep(0.05, 0.0, abs(f.x)) * smoothstep(0.45, 0.0, f.y) * 0.18;
      float drop = clamp(bead + trail, 0.0, 1.0) * step(0.62, seed);
      // A bead is a tiny lens: it bends a brighter piece of sky towards you.
      vec3 lens = skyColor(normalize(refl + vec3(f.x, -f.y, 0.0) * 0.8));
      col += mix(vec3(0.7, 0.78, 0.92), lens, 0.6) * drop * uDroplets * 0.30;
      alpha += drop * uDroplets * 0.22;
    }

    // Frosted rim when it is cold enough to matter.
    if (uFrost > 0.001) {
      float edge = 1.0 - smoothstep(0.0, 0.38, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
      float crystal = fbm(vUv * 26.0) * 0.6 + 0.4;
      float frost = edge * crystal * uFrost;
      col += vec3(0.85, 0.92, 1.0) * frost * 0.45;
      alpha += frost * 0.4;
    }

    col *= uExposure;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92) * uTint);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createGlass(shared) {
  const geo = new THREE.BoxGeometry(CUBE_SIZE * 1.012, CUBE_SIZE * 1.012, CUBE_SIZE * 1.012);
  const mat = new THREE.ShaderMaterial({
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    uniforms: {
      ...shared,
      uDroplets: { value: 0 },
      uFrost: { value: 0 },
      uTint: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 20;
  mesh.name = 'glass';
  return mesh;
}

/* ------------------------------------------------------------------ */
/* Edge frame + contact shadow                                         */
/* ------------------------------------------------------------------ */

export function createEdges() {
  const s = CUBE_SIZE * 1.014;
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s));
  const mat = new THREE.LineBasicMaterial({
    color: 0xdfe7f2,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 21;
  return lines;
}

/** A small "N" plate outside the north face, so the cube can be oriented. */
export function createNorthMarker() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = '#e8eef8';
  ctx.font = '700 74px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', 64, 70);
  ctx.beginPath();
  ctx.moveTo(64, 8);
  ctx.lineTo(80, 26);
  ctx.lineTo(48, 26);
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.45 })
  );
  sprite.scale.setScalar(0.2);
  // Outside the glass, low and to the north, so it never sits over the scene.
  sprite.position.set(0, -HALF * 1.12, -HALF * 1.45);
  sprite.name = 'north-marker';
  return sprite;
}

export function createContactShadow() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // On a black ground a dark shadow does nothing; a faint pool of spill light
  // is what actually seats the cube on a surface.
  grad.addColorStop(0, 'rgba(150,170,190,0.20)');
  grad.addColorStop(0.35, 'rgba(120,140,165,0.08)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(CUBE_SIZE * 3.2, CUBE_SIZE * 3.2),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -HALF * 1.06;
  mesh.renderOrder = -1;
  return mesh;
}
