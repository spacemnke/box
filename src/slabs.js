// The cube is a cross-section, not a hollow box: an opaque lid of atmosphere
// on top, a band of open air with the weather in it, and a solid slab of
// ground below, cut through so you can see its layers.

import * as THREE from 'three';
import { CUBE_SIZE, HALF } from './cube.js';
import { NOISE, SKY_UNIFORMS, SKY_FUNCTION } from './glsl.js';

// Where the three layers meet, in cube units (the cube runs -1 .. +1).
export const GROUND_TOP = -HALF + 0.56; // street level
export const SKY_BOTTOM = HALF - 0.34;  // nominal underside of the cloud lid
const LID_THIN = 0.15;                  // clear sky
const LID_THICK = 0.46;                 // solid overcast

/** The four walls of the cube, as clipping planes. A cross-section is a cut. */
export function cubeClipPlanes() {
  const d = HALF * 0.995;
  return [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), d),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), d),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), d),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), d),
  ];
}

const SLAB_VERT = /* glsl */ `
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

/* ------------------------------------------------------------------ */
/* Atmosphere lid                                                      */
/* ------------------------------------------------------------------ */

const SKY_SLAB_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec2 vUv;

  uniform float uTopY;
  uniform float uBottomY;

  ${NOISE}
  ${SKY_UNIFORMS}
  ${SKY_FUNCTION}

  void main() {
    float facing = vNormalW.y;
    // 0 at the underside of the lid, 1 at the very top of the cube.
    float h = clamp((vWorldPos.y - uBottomY) / max(uTopY - uBottomY, 0.001), 0.0, 1.0);

    // Palette: bright overcast white through to a bruised storm grey, then
    // down to almost nothing at night.
    vec3 clearLit = clamp(uZenith * 1.55 + vec3(0.34), 0.0, 1.0);
    vec3 cloudLit = vec3(0.94, 0.95, 0.97);
    vec3 lit = mix(clearLit, cloudLit, smoothstep(0.12, 0.72, uCloudCover));
    lit = mix(lit, vec3(0.34, 0.36, 0.40), uCloudDark);
    lit = mix(lit, lit * mix(vec3(1.0), uSunColor, 0.55), smoothstep(-0.05, 0.25, uSunDir.y) * 0.7);
    vec3 shade = mix(vec3(0.42, 0.45, 0.50), vec3(0.13, 0.14, 0.17), uCloudDark);

    // A thin sky is a bright plate; a thick one is a dark ceiling.
    vec3 col;
    if (facing > 0.5) {
      // The top of the atmosphere, seen from above: flat and bright.
      col = lit * (1.02 - 0.09 * fbm(vWorldPos.xz * 2.2 + uWind * uTime * 0.01));
    } else if (facing < -0.5) {
      // The underside, where the cloud base hangs. This is the darkest part
      // of the lid — you are looking up into it.
      float base = fbm(vWorldPos.xz * 3.4 + uWind * uTime * 0.012);
      float lumps = smoothstep(0.30, 0.75, base);
      col = mix(shade * 0.34, shade * 0.92, lumps);
      col = mix(col, lit * 0.62, (1.0 - uCloudCover) * 0.7);
    } else {
      // The cut face: a column of atmosphere, bright where the sun reaches
      // the top of the deck and shadowed underneath, with billows showing
      // through it.
      vec2 slice = vec2(vWorldPos.x * 1.4 + vWorldPos.z * 1.4, vWorldPos.y * 4.2);
      float structure = fbm(slice * 2.2 + vec2(uWind.x * uTime * 0.012, 0.0));
      float veil = fbm(slice * 6.0 + 4.0);
      float density = clamp(structure * 0.68 + veil * 0.32, 0.0, 1.0);

      // Light falls off downwards through the deck, hard when it is thick.
      float falloff = pow(h, mix(1.9, 3.2, uCloudCover));
      col = mix(shade * 0.30, lit, falloff);
      // Billows read as brighter tops and shadowed undersides.
      col *= 0.62 + density * 0.85;
      // Feather the bottom edge with the noise so the lid is not a machined
      // block; the puffs hanging below finish the job.
      float edge = smoothstep(0.0, 0.30, h + (density - 0.5) * 0.30);
      col = mix(col * 0.34, col, edge);
    }

    // Night, and lightning lighting the deck from inside.
    col = mix(col, col * vec3(0.10, 0.12, 0.19), uNight);
    col += vec3(0.85, 0.88, 1.0) * uFlash * 0.9;

    col *= uExposure;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Ground                                                              */
/* ------------------------------------------------------------------ */

const GROUND_SLAB_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec2 vUv;

  uniform float uTopY;
  uniform float uMetresPerUnit;   // vertical metres per cube unit
  uniform float uWet;
  uniform float uSnowCover;
  uniform float uStreetGlow;      // warm light spilling from street level

  ${NOISE}
  ${SKY_UNIFORMS}
  ${SKY_FUNCTION}

  // Depth below street level, in metres.
  float depthM() { return max(uTopY - vWorldPos.y, 0.0) * uMetresPerUnit; }

  void main() {
    float facing = vNormalW.y;

    if (facing > 0.5) {
      // The street surface is drawn by the model on top of this; if it shows
      // at all it should just be a neutral ground tone.
      vec3 top = mix(vec3(0.42, 0.41, 0.39), vec3(0.86, 0.89, 0.94), uSnowCover);
      gl_FragColor = vec4(top * (0.35 + uExposure * 0.4), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    if (facing < -0.5) {
      gl_FragColor = vec4(vec3(0.035, 0.036, 0.042), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    float d = depthM();
    vec2 slice = vec2(vWorldPos.x + vWorldPos.z * 0.6, vWorldPos.y * 3.0);
    float grain = fbm(slice * 7.0);
    float coarse = fbm(slice * 2.3 + 11.0);

    // Strata, in real metres below the pavement.
    vec3 madeGround = vec3(0.21, 0.20, 0.20);   // slab, fill, services
    vec3 soil       = vec3(0.22, 0.17, 0.12);
    vec3 gravel     = vec3(0.24, 0.22, 0.20);
    vec3 clay       = vec3(0.19, 0.17, 0.17);
    vec3 rock       = vec3(0.13, 0.14, 0.16);

    vec3 col = madeGround;
    col = mix(col, soil,   smoothstep(0.6, 2.2, d));
    col = mix(col, gravel, smoothstep(4.0, 6.0, d));
    col = mix(col, clay,   smoothstep(8.5, 11.0, d));
    col = mix(col, rock,   smoothstep(13.5, 17.0, d));

    // Bedding planes and mottling, so the cut reads as material rather than
    // a painted gradient. Coarse enough to survive being 60 pixels tall.
    float seam = smoothstep(0.70, 0.99, fract(d * 0.30 + coarse * 0.45));
    col = mix(col, col * 1.65, seam * 0.34);
    col *= 0.74 + grain * 0.48;

    // Rain soaks into the top of the section.
    float nearSurface = 1.0 - smoothstep(0.0, 5.0, d);
    col *= mix(1.0, 0.66, uWet * nearSurface);

    // Deep ground falls away to near black, which is what makes the slab read
    // as a solid volume rather than a painted panel.
    col *= mix(1.0, 0.10, smoothstep(1.5, 16.0, d));

    // The whole section carries a faint internal luminance picked up from the
    // sky, so it looks like a lit solid rather than a hole.
    col += (uZenith * 0.055 + vec3(0.012)) * (1.0 - smoothstep(0.0, 20.0, d));

    // The street edge itself: a bright lip, warm once the lamps are on.
    float lip = 1.0 - smoothstep(0.0, 0.9, d);
    vec3 lipCol = mix(vec3(0.80, 0.82, 0.86), vec3(1.0, 0.70, 0.34), uStreetGlow);
    lipCol = mix(lipCol, vec3(0.95, 0.97, 1.0), uSnowCover);
    col = mix(col, lipCol, pow(lip, 1.8) * (0.55 + uStreetGlow * 0.4));

    col = mix(col, col * vec3(0.34, 0.36, 0.44), uNight * 0.8);
    col += vec3(0.85, 0.88, 1.0) * uFlash * 0.25;
    col *= uExposure;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */

function slabMesh(fragmentShader, shared, extraUniforms, height, centreY) {
  const geo = new THREE.BoxGeometry(CUBE_SIZE * 0.998, height, CUBE_SIZE * 0.998);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SLAB_VERT,
    fragmentShader,
    uniforms: { ...shared, ...extraUniforms },
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = centreY;
  return mesh;
}

/**
 * The lid of cloud, plus the puffs that hang below it. The puffs are what stop
 * the underside looking like a machined surface.
 */
export class AtmosphereSlab {
  constructor(shared) {
    this.shared = shared;
    this.group = new THREE.Group();
    this.clipPlanes = cubeClipPlanes();

    this.topY = HALF;
    this.bottomY = SKY_BOTTOM;
    // The mesh is built at the nominal thickness and then scaled, so the whole
    // lid can breathe with the cloud cover without rebuilding geometry.
    this.nominal = this.topY - SKY_BOTTOM;

    this.uniforms = {
      uTopY: { value: this.topY },
      uBottomY: { value: this.bottomY },
    };

    this.slab = slabMesh(
      SKY_SLAB_FRAG,
      shared,
      this.uniforms,
      this.nominal,
      (this.topY + this.bottomY) / 2
    );
    this.slab.renderOrder = 2;
    this.group.add(this.slab);

    this.puffs = this._buildPuffs();
    this.group.add(this.puffs);
  }

  _buildPuffs() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    // A blob built from overlapping lobes reads as cloud; a plain radial
    // gradient reads as a smudge.
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = 26 + (i % 3) * 9;
      const cx = 64 + Math.cos(a) * 22 + ((i * 13) % 9) - 4;
      const cy = 70 + Math.sin(a) * 13;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.42)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);

    const group = new THREE.Group();
    this.puffList = [];
    const COUNT = 64;
    for (let i = 0; i < COUNT; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        color: 0x6a727d,
        clippingPlanes: this.clipPlanes,
      });
      const sprite = new THREE.Sprite(mat);
      const scale = 0.26 + Math.random() * 0.46;
      sprite.scale.set(scale * 1.6, scale * 0.86, 1);
      // Strictly below the lid: a sprite buried inside it is invisible.
      sprite.position.set(
        (Math.random() - 0.5) * CUBE_SIZE * 0.80,
        this.bottomY - 0.02 - Math.random() * 0.20,
        (Math.random() - 0.5) * CUBE_SIZE * 0.80
      );
      sprite.renderOrder = 3;
      sprite.userData = {
        seed: Math.random(),
        drop: Math.random() * 0.20,
        baseY: sprite.position.y,
        scale,
      };
      group.add(sprite);
      this.puffList.push(sprite);
    }
    return group;
  }

  applyClimate(climate) {
    // A clear sky is a thin bright plate; an overcast one is a thick ceiling.
    const cover = climate.cloudCover;

    const thickness = THREE.MathUtils.lerp(LID_THIN, LID_THICK, Math.max(cover, climate.cloudDark));
    this.bottomY = this.topY - thickness;
    this.slab.scale.y = thickness / this.nominal;
    this.slab.position.y = (this.topY + this.bottomY) / 2;
    this.uniforms.uBottomY.value = this.bottomY;

    for (const puff of this.puffList) {
      puff.userData.baseY = this.bottomY - 0.02 - puff.userData.drop;
    }

    const shade = new THREE.Color()
      .setRGB(0.55, 0.59, 0.65)
      .lerp(new THREE.Color(0.13, 0.14, 0.17), climate.cloudDark)
      .lerp(new THREE.Color(0.06, 0.07, 0.11), climate.night * 0.85);

    for (const puff of this.puffList) {
      const s = puff.userData.seed;
      puff.material.opacity = Math.max(0, cover * 1.05 - s * 0.30) * (0.5 + climate.cloudDark * 0.5);
      puff.material.color.copy(shade).multiplyScalar(0.55 + s * 0.5);
      puff.visible = puff.material.opacity > 0.01;
    }
  }

  update(time) {
    const wind = this.shared.uWind.value;
    for (const puff of this.puffList) {
      const s = puff.userData.seed;
      // Puffs drift with the wind and wrap inside the cube.
      const span = CUBE_SIZE * 0.80;
      const driftX = puff.position.x + wind.x * 0.0015;
      const driftZ = puff.position.z + wind.y * 0.0015;
      puff.position.x = ((driftX + span / 2) % span + span) % span - span / 2;
      puff.position.z = ((driftZ + span / 2) % span + span) % span - span / 2;
      puff.position.y = puff.userData.baseY + Math.sin(time * 0.25 + s * 20) * 0.012;
    }
  }
}

/** The block of ground, cut through. */
export class GroundSlab {
  constructor(shared) {
    this.topY = GROUND_TOP;
    this.bottomY = -HALF;
    this.uniforms = {
      uTopY: { value: this.topY },
      uMetresPerUnit: { value: 37.5 },
      uWet: { value: 0 },
      uSnowCover: { value: 0 },
      uStreetGlow: { value: 0 },
    };
    this.mesh = slabMesh(
      GROUND_SLAB_FRAG,
      shared,
      this.uniforms,
      this.topY - this.bottomY,
      (this.topY + this.bottomY) / 2
    );
    this.mesh.renderOrder = 2;
    this.group = this.mesh;
  }

  /** @param {number} metresPerUnitY vertical metres represented by one unit */
  setScale(metresPerUnitY) {
    this.uniforms.uMetresPerUnit.value = metresPerUnitY;
  }

  applyClimate(climate) {
    this.uniforms.uWet.value = climate.wetness;
    this.uniforms.uSnowCover.value = climate.snowCover;
    this.uniforms.uStreetGlow.value = climate.night;
  }
}
