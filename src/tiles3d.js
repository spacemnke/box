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
const TILES_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';

/**
 * Ask Google directly whether this key may fetch 3D tiles, and relay whatever
 * they say. The tiles renderer swallows the response body, and "it didn't
 * work" is not something anyone can act on — Google's own message names the
 * problem precisely.
 * @returns {Promise<{ok: boolean, message?: string, detail?: string}>}
 */
export async function probeTilesAccess(key) {
  let res;
  try {
    res = await fetch(`${TILES_ROOT}?key=${encodeURIComponent(key)}`);
  } catch {
    return {
      ok: false,
      message: 'Could not reach tile.googleapis.com — check the network, or an ad blocker.',
    };
  }
  if (res.ok) return { ok: true };

  let detail = '';
  let reason = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
    reason = body?.error?.details?.[0]?.reason || body?.error?.status || '';
  } catch { /* not JSON */ }

  const blob = `${reason} ${detail}`.toLowerCase();
  let message;
  if (blob.includes('referer') || blob.includes('referrer')) {
    // The usual cause. Browsers send only the origin on cross-origin requests
    // under the default referrer policy, so a key restricted to a path never
    // matches. The restriction has to be origin-wide.
    message =
      'Google is blocking the referrer. Your key is restricted to a URL with a path, ' +
      'but browsers only send the origin, so it never matches. Change the website ' +
      `restriction to ${location.origin}/*`;
  } else if (blob.includes('billing')) {
    message = 'Billing is not enabled on the key\u2019s Google Cloud project.';
  } else if (blob.includes('service_disabled') || blob.includes('has not been used') || blob.includes('is disabled')) {
    message = 'The Map Tiles API is not enabled on this key\u2019s project.';
  } else if (blob.includes('api key not valid') || blob.includes('api_key_invalid')) {
    message = 'Google does not recognise this API key.';
  } else {
    message = `Google refused the tiles request (HTTP ${res.status}).`;
  }
  return { ok: false, message, detail };
}

/* ------------------------------------------------------------------ */
/* Relighting                                                          */
/* ------------------------------------------------------------------ */

/**
 * The sun the photogrammetry was flown under. Aerial capture happens in clear
 * weather near local noon, so a high sun towards the equator is a good guess,
 * and knowing roughly where it was is what lets its shadows be divided out.
 */
export function captureSunDirection(lat) {
  const towardsEquator = lat >= 0 ? Math.PI : 0; // south in the north, north in the south
  const altitude = THREE.MathUtils.degToRad(Math.max(35, 90 - Math.abs(Math.abs(lat) - 23.4)));
  const c = Math.cos(altitude);
  return new THREE.Vector3(c * Math.sin(towardsEquator), Math.sin(altitude), -c * Math.cos(towardsEquator))
    .normalize();
}

// Shared by both materials.
const RELIGHT_PARS = /* glsl */ `
  varying vec3 vNrmW;
  uniform float uNight;
  uniform float uWet;
  uniform float uSnowCover;
  uniform float uCloudCover;
  uniform float uExposure;
  uniform float uFlash;
  uniform vec3  uSunColor;
  uniform vec3  uSunDir;
  uniform vec3  uCaptureSun;
  uniform float uDelight;

  ${NOISE}

  vec3 saturate3(vec3 c, float amount) {
    float l = luma(c);
    return mix(vec3(l), c, amount);
  }

  /**
   * Recover something close to material colour from a texture with a summer
   * afternoon baked into it.
   *
   * Two things are removed. Daylight shadows are lit by the sky rather than
   * the sun, so they are both darker and bluer than the surfaces around them
   * — that signature finds them without needing to know the geometry. And the
   * broad light-to-dark gradient across a surface is the capture sun, which
   * the normal predicts well enough to divide out.
   *
   * It cannot be exact. What survives is good enough that a new sun looks
   * like the only sun.
   */
  vec3 delight(vec3 c, vec3 n) {
    float l = luma(c);
    float blueShift = c.b - (c.r + c.g) * 0.5;
    float shadow = smoothstep(-0.01, 0.09, blueShift) * smoothstep(0.62, 0.10, l);
    shadow *= uDelight;

    // Lift the shadow towards full daylight and take the sky's blue out of it.
    vec3 lifted = c * mix(1.0, 2.0, shadow);
    lifted = mix(lifted, vec3(luma(lifted)) * 1.04, shadow * 0.45);

    // Divide out the directional term the capture sun left behind.
    float bakedNdotL = clamp(dot(n, uCaptureSun) * 0.5 + 0.5, 0.0, 1.0);
    float bakedIrradiance = mix(1.0, 0.66 + 0.46 * bakedNdotL, uDelight);
    vec3 albedo = lifted / max(bakedIrradiance, 0.5);

    // Albedo, not radiance: masonry, render and asphalt sit well below white,
    // and leaving the capture's exposure in blows the relit result out.
    albedo *= 0.80;

    // Photogrammetry is noisy; a little desaturation keeps stray colour from
    // being amplified into confetti by the division.
    albedo = saturate3(albedo, 0.92);
    return clamp(albedo, 0.0, 1.05);
  }
`;

const VERTEX_NORMAL_PATCH = /* glsl */ `
  #include <begin_vertex>
  vNrmW = normalize(mat3(modelMatrix) * normal);
`;

/**
 * Physically lit: the texture is turned back into approximate albedo and then
 * lit by the real sun for the real minute, with real cast shadows and the
 * simulated sky as ambient. Weather changes the surfaces themselves — wet
 * asphalt goes glossy and reflects the overcast — rather than being painted
 * over the top.
 */
function makeLitMaterial(source, uniforms, clipPlanes) {
  const mat = new THREE.MeshStandardMaterial({
    map: source.map || null,
    color: 0xffffff,
    vertexColors: !!source.vertexColors,
    roughness: 0.88,
    metalness: 0.0,
    side: THREE.FrontSide,
    clippingPlanes: clipPlanes,
    envMapIntensity: 1,
  });
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vNrmW;\nvoid main() {')
      .replace('#include <begin_vertex>', VERTEX_NORMAL_PATCH);

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${RELIGHT_PARS}\nvoid main() {`)
      // Albedo, once the texture and any vertex colours are both in.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb = delight(diffuseColor.rgb, normalize(vNrmW));

        // Snow is a material, not a tint: it covers what faces the sky.
        float upFacing = smoothstep(0.35, 0.88, vNrmW.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.92, 0.96), uSnowCover * upFacing);
        // Wet stone darkens because the water film traps light in it.
        diffuseColor.rgb *= mix(1.0, 0.70, uWet * mix(0.5, 1.0, upFacing));`
      )
      // Rain makes surfaces mirror-like where it pools, and snow dead matte.
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        {
          float up = smoothstep(0.35, 0.88, vNrmW.y);
          float puddling = uWet * mix(0.35, 1.0, up);
          roughnessFactor = mix(roughnessFactor, 0.09, puddling);
          roughnessFactor = mix(roughnessFactor, 0.95, uSnowCover * up);
        }`
      )
      // After dark the brightest pixels are the lit ones: lamps, shopfronts,
      // windows. They become the light sources they were when photographed.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float l = luma(diffuseColor.rgb);
          float up = smoothstep(0.35, 0.88, vNrmW.y);
          float lamps = smoothstep(0.58, 0.95, l) * (1.0 - up * 0.65);
          totalEmissiveRadiance += vec3(1.0, 0.76, 0.44) * lamps * uNight * 1.5;
          totalEmissiveRadiance += vec3(0.85, 0.88, 1.0) * uFlash * 0.5;
        }`
      );
  };
  mat.customProgramCacheKey = () => 'photoreal-lit-v1';
  return mat;
}

/**
 * As captured: Google's own lighting, with the weather graded over it. Kept
 * because relighting is an estimate, and somewhere it estimates badly this is
 * the honest picture.
 */
function makeFlatMaterial(source, uniforms, clipPlanes) {
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
      .replace('#include <begin_vertex>', VERTEX_NORMAL_PATCH);

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${RELIGHT_PARS}\nvoid main() {`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 c = diffuseColor.rgb;
          float sunUp = smoothstep(-0.10, 0.15, uSunDir.y);
          vec3 dayTint = mix(vec3(0.80, 0.84, 0.95), uSunColor, sunUp * (1.0 - uCloudCover * 0.6));
          c *= mix(vec3(1.0), dayTint, 0.45);
          c = mix(c, saturate3(c, 0.72) * 0.80, uCloudCover * 0.55);

          float upFacing = smoothstep(0.35, 0.90, vNrmW.y);
          c = mix(c, saturate3(c, 1.25) * 0.60, uWet * mix(0.55, 1.0, upFacing) * 0.7);

          float l = luma(diffuseColor.rgb);
          vec3 nightBase = saturate3(c, 0.45) * vec3(0.17, 0.20, 0.31);
          nightBase += vec3(1.0, 0.78, 0.45) * smoothstep(0.60, 0.95, l) * (1.0 - upFacing * 0.6) * 0.55;
          c = mix(c, nightBase, uNight);

          if (uSnowCover > 0.001) {
            vec3 snowCol = mix(vec3(0.88, 0.91, 0.96), uSunColor * 1.05, sunUp * 0.35);
            snowCol = mix(snowCol, snowCol * vec3(0.30, 0.34, 0.48), uNight);
            c = mix(c, snowCol, uSnowCover * upFacing);
          }

          c += vec3(0.85, 0.88, 1.0) * uFlash * 0.5;
          diffuseColor.rgb = c * uExposure;
        }`
      );
  };
  mat.customProgramCacheKey = () => 'photoreal-flat-v1';
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
      uCaptureSun: { value: new THREE.Vector3(0, 1, 0) },
      uDelight: { value: 1 },
    };

    // 'lit' rebuilds the lighting from scratch; 'flat' keeps Google's.
    this.lighting = 'lit';
    this.castShadows = true;

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
    this.uniforms.uCaptureSun.value.copy(captureSunDirection(lat));
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
      const make = this.lighting === 'lit' ? makeLitMaterial : makeFlatMaterial;
      obj.material = make(old, this.uniforms, this.clipPlanes);
      obj.castShadow = obj.receiveShadow = this.lighting === 'lit' && this.castShadows;
      this.materials.add(obj.material);
      // The map is shared with the source material; keep it alive.
      old.map = null;
      old.dispose();
    });
  }

  /**
   * Switch between rebuilt lighting and the captured imagery. Tiles already on
   * screen are re-materialised in place, so nothing has to be downloaded again.
   * @param {'lit'|'flat'} lighting
   */
  setLighting(lighting) {
    if (lighting === this.lighting) return;
    this.lighting = lighting;
    if (!this.tiles) return;
    for (const mat of this.materials) mat.dispose();
    this.materials.clear();
    this.tiles.forEachLoadedModel((scene) => this._restyle(scene));
  }

  setCastShadows(on) {
    this.castShadows = on;
    if (!this.tiles) return;
    this.tiles.forEachLoadedModel((scene) => {
      scene.traverse((obj) => {
        if (obj.isMesh) obj.castShadow = obj.receiveShadow = this.lighting === 'lit' && on;
      });
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
