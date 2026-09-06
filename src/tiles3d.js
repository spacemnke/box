// Google Photorealistic 3D Tiles inside the cube: the real photogrammetry
// mesh of the block — true shapes, true heights, true façades — cut to the
// cube's footprint and relit for the weather.

import * as THREE from 'three';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  ReorientationPlugin,
  LoadRegionPlugin,
  SphereRegion,
  UnloadTilesPlugin,
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CUBE_SIZE, HALF } from './cube.js';
import { GROUND_TOP } from './slabs.js';
import { NOISE } from './glsl.js';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Relighting                                                          */
/* ------------------------------------------------------------------ */

// Photogrammetry is a photograph wrapped around geometry: it carries the
// sunlight of the day it was flown. So, as with the Street View walls, the
// weather is applied as a grade on top of it rather than as real lighting.
function makeRelitMaterial(source, uniforms, clipPlanes) {
  const mat = new THREE.MeshBasicMaterial({
    map: source.map || null,
    color: source.color ? source.color.clone() : new THREE.Color(0xffffff),
    vertexColors: !!source.vertexColors,
    side: THREE.FrontSide,
    clippingPlanes: clipPlanes,
  });
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vNrmW;\nvoid main() {')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vNrmW = normalize(mat3(modelMatrix) * normal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `
        varying vec3 vNrmW;
        uniform float uNight;
        uniform float uWet;
        uniform float uSnowCover;
        uniform float uCloudCover;
        uniform float uExposure;
        uniform float uFlash;
        uniform vec3  uSunColor;
        uniform vec3  uSunDir;

        ${NOISE}

        vec3 saturate3(vec3 c, float amount) {
          float l = luma(c);
          return mix(vec3(l), c, amount);
        }

        void main() {`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Runs after both the texture and any vertex colours are in, so the
          // luminance keys below see the real surface, not a white base.
          vec3 c = diffuseColor.rgb;

          // Sun colour: the capture was midday; tint towards the current sun.
          float sunUp = smoothstep(-0.10, 0.15, uSunDir.y);
          vec3 dayTint = mix(vec3(0.80, 0.84, 0.95), uSunColor, sunUp * (1.0 - uCloudCover * 0.6));
          c *= mix(vec3(1.0), dayTint, 0.45);

          // Overcast flattens the baked shadows and cools everything.
          c = mix(c, saturate3(c, 0.72) * 0.80, uCloudCover * 0.55);

          // Rain darkens and saturates; ground more than walls.
          float upFacing = smoothstep(0.35, 0.90, vNrmW.y);
          float wetWeight = uWet * mix(0.55, 1.0, upFacing);
          c = mix(c, saturate3(c, 1.25) * 0.60, wetWeight * 0.7);

          // Night: crush the daylight capture, keep a little warm glow in the
          // brightest pixels so streets and shopfronts do not go dead.
          float l = luma(diffuseColor.rgb);
          vec3 nightBase = saturate3(c, 0.45) * vec3(0.17, 0.20, 0.31);
          float lampMask = smoothstep(0.60, 0.95, l) * (1.0 - upFacing * 0.6);
          nightBase += vec3(1.0, 0.78, 0.45) * lampMask * 0.55;
          c = mix(c, nightBase, uNight);

          // Snow settles on whatever faces up.
          if (uSnowCover > 0.001) {
            float grain = 0.86 + 0.14 * valueNoise(vNrmW.xz * 40.0 + gl_FragCoord.xy * 0.05);
            vec3 snowCol = mix(vec3(0.88, 0.91, 0.96), uSunColor * 1.05, sunUp * 0.35);
            snowCol = mix(snowCol, snowCol * vec3(0.30, 0.34, 0.48), uNight);
            c = mix(c, snowCol * grain, uSnowCover * smoothstep(0.45, 0.90, vNrmW.y));
          }

          c += vec3(0.85, 0.88, 1.0) * uFlash * 0.5;
          c *= uExposure;
          diffuseColor.rgb = c;
        }`
      );
  };
  mat.customProgramCacheKey = () => 'photoreal-relit-v1';
  return mat;
}

/* ------------------------------------------------------------------ */

export class Photoreal {
  /**
   * @param {object} shared     the shared sky uniforms
   * @param {THREE.Plane[]} clipPlanes  the cube's walls
   */
  constructor(shared, clipPlanes) {
    this.shared = shared;
    this.clipPlanes = clipPlanes;

    // Outer group: cube placement. Inner: metres -> cube units, and the turn
    // from the plugin's "X west, Z north" frame to this app's "X east, Z south".
    this.group = new THREE.Group();
    this.group.name = 'photoreal';
    this.inner = new THREE.Group();
    this.inner.rotation.y = Math.PI;
    this.group.add(this.inner);

    this.uniforms = {
      uNight: { value: 0 },
      uWet: { value: 0 },
      uSnowCover: { value: 0 },
      uCloudCover: shared.uCloudCover,
      uExposure: shared.uExposure,
      uFlash: shared.uFlash,
      uSunColor: shared.uSunColor,
      uSunDir: shared.uSunDir,
    };

    this.tiles = null;
    this.materials = new Set();
    this.status = 'idle';
    this.error = null;
    this.groundSettled = 0;   // settle attempts made
    this.groundStable = 0;    // consecutive attempts that barely moved
    this.groundLocked = false;
    this.groundOffset = 0;
    this._settleIn = 0;
    this.radiusM = 75;
    this.onStatus = () => {};

    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath('./vendor/three/addons/libs/draco/gltf/');

    this._raycaster = new THREE.Raycaster();
  }

  /**
   * Start streaming the tiles around a point.
   * @param {number} lat
   * @param {number} lon
   * @param {string} key      Google Maps Platform key with Map Tiles API enabled
   * @param {number} radiusM  half-width of the cube in metres
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderer} renderer
   */
  load(lat, lon, key, radiusM, camera, renderer) {
    this.dispose();
    this.radiusM = radiusM;
    this.status = 'loading';
    this.error = null;
    this.groundSettled = 0;
    this.groundStable = 0;
    this.groundLocked = false;
    this.groundOffset = 0;
    this._settleIn = 0;

    const tiles = new TilesRenderer();
    this.tiles = tiles;

    tiles.registerPlugin(
      new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true, useRecommendedSettings: false })
    );
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.dracoLoader }));
    tiles.registerPlugin(new ReorientationPlugin({ lat: lat * DEG, lon: lon * DEG, height: 0 }));
    tiles.registerPlugin(new UnloadTilesPlugin({ delay: 2000 }));

    // Only the tiles under the cube are wanted. The region is tested against
    // tile volumes in the tileset's own (Earth-centred) frame, so it is built
    // there; the generous radius absorbs not knowing the ground height yet.
    const centre = WGS84_ELLIPSOID.getCartographicToPosition(lat * DEG, lon * DEG, 40, new THREE.Vector3());
    const region = new SphereRegion({
      sphere: new THREE.Sphere(centre, radiusM * 1.5 + 120),
      errorTarget: 0.6,
      mask: true,
    });
    tiles.registerPlugin(new LoadRegionPlugin({ regions: [region] }));

    // The cube is small on screen, so screen-space error alone would never
    // refine to the finest level. Push hard; the region keeps the area small.
    tiles.errorTarget = 2.5;
    tiles.autoDisableRendererCulling = true;

    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);

    tiles.addEventListener('load-model', ({ scene }) => {
      this._restyle(scene);
      // The mesh joins the group on the next update, so settle a frame later.
      this._settleIn = 2;
    });
    tiles.addEventListener('dispose-model', ({ scene }) => this._release(scene));
    tiles.addEventListener('load-root-tileset', () => {
      this.status = 'streaming';
      this.onStatus('streaming');
    });
    tiles.addEventListener('load-error', ({ error, url }) => {
      // A failed root request means the key is wrong or the API is not
      // enabled; a failed tile is just a tile.
      if (this.status === 'loading' || /root\.json/.test(String(url))) {
        this.status = 'error';
        this.error = describeTilesError(error, url);
        this.onStatus('error');
      }
    });

    // Metres -> cube units; the ground is lifted onto the ground slab once the
    // first tiles reveal where it actually is.
    this.inner.scale.setScalar(1 / radiusM);
    this.inner.position.y = GROUND_TOP;
    this.inner.add(tiles.group);
  }

  _restyle(scene) {
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
      const old = obj.material;
      const mat = makeRelitMaterial(old, this.uniforms, this.clipPlanes);
      obj.material = mat;
      this.materials.add(mat);
      // The map is shared; do not dispose it with the old material.
      old.map = null;
      old.dispose();
    });
  }

  _release(scene) {
    scene.traverse((obj) => {
      if (obj.isMesh && obj.material?.userData?.uniforms === this.uniforms) {
        this.materials.delete(obj.material);
      }
    });
  }

  /**
   * Find street level under the address by dropping rays on a small grid and
   * taking the lowest hit, then lift the whole tileset so it sits on the
   * ground slab. Runs a few times as detail streams in, then locks.
   */
  _settleGround() {
    if (!this.tiles || this.groundLocked) return;
    // Tiles that arrived this frame have not been through a render yet, so
    // their world matrices are stale; without this the rays miss everything.
    this.group.updateMatrixWorld(true);
    const rc = this._raycaster;
    const hits = [];
    const spread = 18 / this.radiusM; // ±18 m in cube units
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        rc.set(new THREE.Vector3(i * spread, HALF * 4, j * spread), new THREE.Vector3(0, -1, 0));
        const hit = rc.intersectObject(this.tiles.group, true)[0];
        if (hit) hits.push(hit.point.y);
      }
    }
    if (hits.length < 3) return;
    hits.sort((a, b) => a - b);
    // The lowest hits are the street; ignore the very lowest in case a ray
    // slipped through a gap in the mesh.
    const street = hits[Math.min(1, hits.length - 1)];
    // A hair above the ground slab, so the two surfaces never z-fight.
    const delta = GROUND_TOP + 0.004 - street;
    if (Math.abs(delta) > 0.002) {
      this.inner.position.y += delta;
      this.groundOffset += delta;
    }
    this.groundSettled++;
    // Coarse tiles arrive first and their ground is a few metres out; keep
    // re-settling as finer ones stream in, and lock once it stops moving.
    const stable = Math.abs(delta) < 0.5 / this.radiusM;
    this.groundStable = stable ? this.groundStable + 1 : 0;
    if (this.groundStable >= 2 || this.groundSettled >= 10) this.groundLocked = true;
    this.onStatus('ground');
  }

  onResize(camera, renderer) {
    this.tiles?.setResolutionFromRenderer(camera, renderer);
  }

  update() {
    if (!this.tiles) return;
    this.tiles.update();
    if (this._settleIn > 0 && --this._settleIn === 0) this._settleGround();
  }

  applyClimate(climate) {
    this.uniforms.uNight.value = climate.night;
    this.uniforms.uWet.value = climate.wetness;
    this.uniforms.uSnowCover.value = climate.snowCover;
  }

  /** Copyright strings Google requires on screen while its tiles are shown. */
  attributions() {
    if (!this.tiles) return '';
    return this.tiles
      .getAttributions()
      .filter((a) => a.type === 'string' && a.value)
      .map((a) => a.value)
      .join(' · ');
  }

  get progress() {
    return this.tiles ? this.tiles.loadProgress : 0;
  }

  dispose() {
    if (this.tiles) {
      this.inner.remove(this.tiles.group);
      this.tiles.dispose();
      this.tiles = null;
    }
    for (const m of this.materials) m.dispose();
    this.materials.clear();
    this.status = 'idle';
  }
}

function describeTilesError(error, url) {
  const msg = String(error?.message || error || '');
  if (/403|401|API key|not authorized|PERMISSION/i.test(msg)) {
    return 'Google rejected the key. Enable the Map Tiles API on it and check its referrer restrictions.';
  }
  if (/404/.test(msg)) return 'No 3D Tiles coverage here.';
  if (/429/.test(msg)) return 'Google is rate-limiting this key.';
  return `3D Tiles: ${msg || 'failed to load'}${url ? ` (${String(url).split('?')[0]})` : ''}`;
}

export { CUBE_SIZE as _CUBE_SIZE };
