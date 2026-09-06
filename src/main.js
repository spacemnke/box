import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  geocode,
  reverseGeocode,
  fetchWeather,
  fetchOSM,
  hourlyAt,
  localStamp,
  probeStreetViewAccess,
  ENABLE_URLS,
} from './data.js';
import { buildClimate } from './climate.js';
import {
  HALF,
  CubeShell,
  createSharedUniforms,
  createGlass,
  createEdges,
  createContactShadow,
  createNorthMarker,
} from './cube.js';
import { AtmosphereSlab, GroundSlab, GROUND_TOP, SKY_BOTTOM } from './slabs.js';
import { WeatherFX } from './weatherfx.js';
import { ModelCity } from './modelcity.js';
import { loadStreetViewCube } from './panorama.js';
import { Photoreal, probeTilesAccess } from './tiles3d.js';
import { AddressMarker } from './marker.js';
import { SkyEnvironment } from './skyenv.js';
import { OVERRIDES } from './overrides.js';

// The modelled square is 150 m across. Heights get a gentle exaggeration:
// a true-to-scale block of air is mostly empty sky, which reads as nothing.
const MODEL_RADIUS_M = 75;
const HEIGHT_EXAGGERATION = 2.0;

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const el = (id) => document.getElementById(id);
const dom = {
  canvas: el('stage'),
  // headline
  ledeCondition: el('lede-condition'),
  ledePlace: el('lede-place'),
  ledeSub: el('lede-sub'),
  btnChange: el('btn-change'),
  // readout
  condLabel: el('wx-cond-label'),
  dialArc: el('dial-arc'),
  wxTemp: el('wx-temp'),
  wxFeels: el('wx-feels'),
  wxWind: el('wx-wind'),
  wxCloud: el('wx-cloud'),
  wxHum: el('wx-hum'),
  wxPrecip: el('wx-precip'),
  wxVis: el('wx-vis'),
  timeSlider: el('time-slider'),
  timeCaption: el('time-caption'),
  btnNow: el('btn-now'),
  // strip
  wxTime: el('wx-time'),
  wxSun: el('wx-sun'),
  wxGust: el('wx-gust'),
  wxPress: el('wx-press'),
  creditStatus: el('credit-status'),
  svCredit: el('sv-credit'),
  // drawer
  btnPanel: el('btn-panel'),
  btnClose: el('btn-close'),
  drawer: el('drawer'),
  form: el('search-form'),
  address: el('address'),
  btnSearch: el('btn-search'),
  btnLocate: el('btn-locate'),
  results: el('results'),
  placeCoords: el('place-coords'),
  segPhoto: el('seg-photo'),
  segModel: el('seg-model'),
  segPhotoreal: el('seg-photoreal'),
  modeHint: el('mode-hint'),
  lightingRow: el('lighting-row'),
  segLit: el('seg-lit'),
  segFlat: el('seg-flat'),
  lightingHint: el('lighting-hint'),
  override: el('override'),
  keyToggle: el('key-toggle'),
  keyBody: el('key-body'),
  apiKey: el('api-key'),
  rememberKey: el('remember-key'),
  btnTestKey: el('btn-testkey'),
  keyReport: el('key-report'),
  optRotate: el('opt-rotate'),
  optGlass: el('opt-glass'),
  optSkyReplace: el('opt-sky-replace'),
  optQuality: el('opt-quality'),
  btnShot: el('btn-shot'),
  btnShare: el('btn-share'),
  status: el('status'),
  // loader
  loader: el('loader'),
  loaderText: el('loader-text'),
  loaderBar: el('loader-bar'),
  // marker label
  pinLabel: el('pin-label'),
  pinWhat: el('pin-what'),
  pinPrecision: el('pin-precision'),
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  place: null,
  weather: null,
  panoMeta: null,
  mode: 'model',          // what is on screen now
  preferredMode: 'photoreal', // what the viewer asked for
  photoReady: false,
  timeOffsetHours: 0,
  override: 'live',
  quality: 0.6,
  lighting: 'lit',
  headingOffset: 0,
  climate: null,
  lastWeatherFetch: 0,
};

/* ------------------------------------------------------------------ */
/* Three.js setup                                                      */
/* ------------------------------------------------------------------ */

const renderer = new THREE.WebGLRenderer({
  canvas: dom.canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.localClippingEnabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

// A long lens and a high three-quarter view: the cube reads as an object on a
// table rather than a room you are standing in. Steep enough to look down
// into the block; the cloud lid thins out at this angle so it does not hide it.
const camera = new THREE.PerspectiveCamera(29, 1, 0.05, 100);
camera.position.set(3.1, 5.3, 3.55);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.35;
controls.maxDistance = 30;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.28;
controls.target.set(0, -0.02, 0);

const shared = createSharedUniforms();

// The simulated sky, as image-based lighting for everything physically lit.
const skyEnv = new SkyEnvironment(shared);

const cubeGroup = new THREE.Group();
scene.add(cubeGroup);

const shell = new CubeShell(shared);
cubeGroup.add(shell.group);

const sky = new AtmosphereSlab(shared);
cubeGroup.add(sky.group);

const groundSlab = new GroundSlab(shared);
groundSlab.setScale(MODEL_RADIUS_M / HEIGHT_EXAGGERATION);
cubeGroup.add(groundSlab.group);

const city = new ModelCity(shared);
cubeGroup.add(city.group);

const fx = new WeatherFX(shared, city.clipPlanes);
cubeGroup.add(fx.group);

const photoreal = new Photoreal(shared, city.clipPlanes);
cubeGroup.add(photoreal.group);
photoreal.onStatus = (what) => {
  if (what === 'error') {
    setStatus(photoreal.error, 'error');
    if (state.mode === 'photoreal') setMode('model');
  } else if (what === 'streaming') {
    setStatus('Streaming Google 3D Tiles…', 'ok');
  } else if (what === 'ground') {
    // The marker stands on the street, wherever the tiles put it.
    marker.setGroundY(GROUND_TOP);
    // The tiles are not height-exaggerated, so one cube unit is MODEL_RADIUS_M metres.
    const metres = -photoreal.groundOffset * MODEL_RADIUS_M;
    setStatus(`Photorealistic 3D Tiles · street level ${metres >= 0 ? '+' : ''}${metres.toFixed(0)} m above the ellipsoid`, 'ok');
  }
};

const glass = createGlass(shared);
const edges = createEdges();
cubeGroup.add(glass, edges);

const marker = new AddressMarker();
cubeGroup.add(marker.group);

scene.add(createContactShadow());
cubeGroup.add(createNorthMarker());

// Rotating the whole cube keeps the panorama, the sun and the wind consistent
// with each other when a heading offset is used.
function applyHeadingOffset() {
  cubeGroup.rotation.y = (-state.headingOffset * Math.PI) / 180;
}

// Lights only matter for the extruded model; the photo panels are unlit.
const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 0.1;
sunLight.shadow.camera.far = 14;
sunLight.shadow.camera.left = -HALF * 1.8;
sunLight.shadow.camera.right = HALF * 1.8;
sunLight.shadow.camera.top = HALF * 1.8;
sunLight.shadow.camera.bottom = -HALF * 1.8;
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.004;
scene.add(sunLight, sunLight.target);

const skyLight = new THREE.HemisphereLight(0x9fc3ff, 0x51504c, 0.9);
scene.add(skyLight);

const bounce = new THREE.DirectionalLight(0xffffff, 0.18);
bounce.position.set(-2, -1.5, -2);
scene.add(bounce);

// The cube is 2 units on a side, so its bounding sphere is half the diagonal.
const CUBE_RADIUS = Math.sqrt(3);

/**
 * Pull the camera back far enough that the whole cube fits the viewport. A
 * portrait phone is narrow enough that the horizontal field of view, not the
 * vertical one, is the binding constraint — without this the cube runs off
 * both sides of the screen.
 */
function fitCamera() {
  const portrait = camera.aspect < 0.9;
  // A short landscape window puts the top bar and the credits hard against
  // the cube, so it gets pushed further away to leave them room.
  const short = window.innerHeight < 620;
  const margin = portrait ? 1.02 : short ? 1.34 : 1.12;
  const vHalf = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const distance = (CUBE_RADIUS * margin) / Math.sin(Math.min(vHalf, hHalf));

  // On a phone the readout and headline sit over the lower third, so the cube
  // is nudged up out of them.
  controls.target.set(0, portrait ? -0.42 : -0.02, 0);

  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(3.1, 5.3, 3.55);
  camera.position.copy(controls.target).addScaledVector(dir.normalize(), distance);
  controls.update();
}

// Once the viewer has moved the camera themselves, leave it alone.
let userMovedCamera = false;
controls.addEventListener('start', () => {
  userMovedCamera = true;
});

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (!userMovedCamera) fitCamera();
  photoreal.onResize(camera, renderer);
}
window.addEventListener('resize', resize);
resize();

/* ------------------------------------------------------------------ */
/* Render loop                                                         */
/* ------------------------------------------------------------------ */

const clock = new THREE.Clock();
let lastCreditTick = -1;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  shared.uTime.value = t;
  controls.update();

  // How far overhead the camera is decides how much lid gets in the way.
  const dx = camera.position.x - controls.target.x;
  const dz = camera.position.z - controls.target.z;
  sky.setViewElevation(Math.atan2(camera.position.y - controls.target.y, Math.hypot(dx, dz)));

  // Rebuilt only when the weather has actually changed.
  if (skyEnv.update(renderer)) scene.environment = skyEnv.texture;

  const flash = fx.update(dt, t);
  shared.uFlash.value = flash;
  sky.update(t);
  if (state.mode === 'photoreal') {
    photoreal.update();
    // Google's terms: their attribution stays on screen while tiles show.
    if ((t | 0) !== lastCreditTick) {
      lastCreditTick = t | 0;
      const credit = photoreal.attributions();
      dom.svCredit.textContent = credit ? `Google · ${credit}` : 'Google';
    }
  }

  if (state.climate) {
    // Lightning briefly overrides the sun for the model geometry too.
    const c = state.climate;
    sunLight.intensity = c.sunIntensity + flash * 2.2;
    skyLight.intensity = c.ambientIntensity + flash * 1.0;
  }

  marker.update(t);
  renderer.render(scene, camera);
  positionPinLabel();
}
requestAnimationFrame(frame);

/* ------------------------------------------------------------------ */
/* The address label, following its marker                             */
/* ------------------------------------------------------------------ */

const pinScreen = new THREE.Vector3();

function positionPinLabel() {
  if (!state.place || dom.pinLabel.hidden) return;
  pinScreen.copy(marker.headWorld).applyMatrix4(cubeGroup.matrixWorld).project(camera);
  // z beyond 1 means the point is behind the camera.
  if (pinScreen.z > 1) {
    dom.pinLabel.style.opacity = '0';
    return;
  }
  dom.pinLabel.style.opacity = '1';
  dom.pinLabel.style.left = `${((pinScreen.x + 1) / 2) * window.innerWidth}px`;
  dom.pinLabel.style.top = `${((1 - pinScreen.y) / 2) * window.innerHeight - 10}px`;
}

const PRECISION_NOTE = {
  house: 'exact address',
  street: 'street match, not the door',
  area: 'approximate',
};

function showPinLabel(place) {
  dom.pinWhat.textContent = shortPlace(place.label);
  dom.pinPrecision.textContent = PRECISION_NOTE[place.precision] || '';
  dom.pinLabel.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Applying a climate to the scene                                     */
/* ------------------------------------------------------------------ */

function applyClimate(climate) {
  state.climate = climate;

  shared.uSunDir.value.copy(climate.sunDir);
  shared.uMoonDir.value.copy(climate.moonDir);
  shared.uSunColor.value.copy(climate.sunColor);
  shared.uZenith.value.copy(climate.zenith);
  shared.uHorizon.value.copy(climate.horizon);
  shared.uGroundHaze.value.copy(climate.groundHaze);
  shared.uSunAltitude.value = climate.sunAltitude;
  shared.uMoonPhase.value = climate.moonPhase;
  shared.uCloudCover.value = climate.cloudCover;
  shared.uCloudDark.value = climate.cloudDark;
  shared.uNight.value = climate.night;
  shared.uHaze.value = climate.haze;
  shared.uExposure.value = climate.exposure;
  shared.uWind.value.copy(climate.wind);
  shared.uFogColor.value.copy(climate.fogColor);

  skyEnv.dirty = true;
  shell.applyClimate(climate);
  fx.applyClimate(climate, state.quality);
  city.applyClimate(climate);
  marker.applyClimate(climate);
  sky.applyClimate(climate);
  groundSlab.applyClimate(climate);
  photoreal.applyClimate(climate);
  // The lid moves with the cloud cover, so the weather's headroom moves too.
  fx.setBand(GROUND_TOP, sky.bottomY);

  // Light rig
  const d = climate.sunDir;
  const usingMoon = d.y < -0.05;
  const dir = usingMoon ? climate.moonDir : d;
  sunLight.position.set(dir.x, Math.max(dir.y, 0.08), dir.z).multiplyScalar(6);
  sunLight.target.position.set(0, GROUND_TOP, 0);
  sunLight.color.copy(usingMoon ? new THREE.Color(0x9fb4ff) : climate.sunColor);
  sunLight.intensity = usingMoon ? 0.14 : climate.sunIntensity;
  sunLight.castShadow =
    !usingMoon &&
    climate.sunIntensity > 0.25 &&
    (state.mode === 'model' || (state.mode === 'photoreal' && state.lighting === 'lit'));

  skyLight.color.copy(climate.zenith).lerp(new THREE.Color(0xffffff), 0.25);
  // After dark the light bouncing back up off a street is sodium-warm, and
  // without it the facades read as flat black cut-outs.
  skyLight.groundColor
    .copy(climate.groundHaze)
    .lerp(new THREE.Color(0xff9a4e), climate.night * 0.6);
  // With image-based lighting doing the ambient, the hemisphere light would
  // otherwise count the sky twice and flatten everything out.
  const imageLit = state.mode === 'photoreal' && state.lighting === 'lit';
  skyLight.intensity = climate.ambientIntensity * (imageLit ? 0.3 : 1);
  bounce.intensity = (0.05 + climate.ambientIntensity * 0.15) * (imageLit ? 0.4 : 1);
  scene.environmentIntensity = 0.5 + climate.dayFactor * 0.7;

  // Scene fog, for the extruded model only. Density is per world unit, and one
  // world unit is MODEL_RADIUS_M metres of real street. 0.8 is a legibility
  // fudge: true Koschmieder extinction hides the model entirely in dense fog,
  // and a diorama you cannot see into is not one.
  const density = climate.fogPerMetre * MODEL_RADIUS_M * 0.8;
  scene.fog = density > 0.01 ? new THREE.FogExp2(climate.fogColor.getHex(), density) : null;

  // Glass response
  glass.material.uniforms.uDroplets.value = climate.rainRate * 0.9;
  glass.material.uniforms.uFrost.value =
    climate.temperature < 2 ? THREE.MathUtils.clamp((2 - climate.temperature) / 8, 0, 0.7) : 0;

  updateReadout(climate);
}

/* ------------------------------------------------------------------ */
/* The reading that drives the render                                  */
/* ------------------------------------------------------------------ */

function currentInstant() {
  return Date.now() + state.timeOffsetHours * 3600 * 1000;
}

function effectiveReading() {
  const w = state.weather;
  if (!w) return null;

  let reading;
  if (state.timeOffsetHours === 0) {
    reading = { ...w.current };
    const h = hourlyAt(w, Date.now());
    if (h) reading.snowDepth = h.snowDepth;
  } else {
    const h = hourlyAt(w, currentInstant());
    if (!h) return { ...w.current };
    reading = {
      temperature: h.temperature,
      apparentTemperature: h.temperature,
      humidity: h.humidity,
      precipitation: h.precipitation,
      rain: h.rain,
      snowfall: h.snowfall,
      snowDepth: h.snowDepth,
      weatherCode: h.weatherCode,
      cloudCover: h.cloudCover,
      visibility: h.visibility,
      windSpeed: h.windSpeed,
      windDirection: h.windDirection,
      windGust: h.windGust,
      isDay: h.isDay,
      pressure: w.current.pressure,
    };
  }

  const override = OVERRIDES[state.override];
  if (override) {
    reading = { ...reading, ...override };
    // The overridden sky is hypothetical, so a "feels like" carried over from
    // the real forecast would be a lie. Fall back to the dry-bulb value.
    reading.apparentTemperature = override.temperature ?? reading.temperature;
  }
  return reading;
}

function refreshClimate() {
  const reading = effectiveReading();
  if (!reading || !state.place) return;
  const instant = currentInstant();
  applyClimate(buildClimate(reading, new Date(instant), state.place.lat, state.place.lon));
}

/* ------------------------------------------------------------------ */
/* Readout                                                             */
/* ------------------------------------------------------------------ */

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round(((((deg % 360) + 360) % 360) / 22.5)) % 16];
const num = (v, digits = 0, suffix = '') =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}${suffix}`;

/** Short name for the headline: the street or the town, not the whole address. */
function shortPlace(label) {
  if (!label) return '';
  const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return label;
  // A house number on its own says nothing; pair it with the street.
  if (/^\d+[a-z]?$/i.test(parts[0]) && parts[1]) return `${parts[1]} ${parts[0]}`;
  return parts[0];
}

const DIAL_CIRCUMFERENCE = 2 * Math.PI * 52;

function updateReadout(climate) {
  const r = climate.reading;
  const w = state.weather;
  const simulated = state.override !== 'live';

  // ---- headline ----------------------------------------------------------
  dom.ledeCondition.textContent = `${climate.conditionText}.`;
  dom.ledePlace.textContent = state.place ? `${shortPlace(state.place.label)}.` : '';
  dom.condLabel.textContent = climate.conditionText;

  const bits = [];
  if (r.temperature !== undefined) bits.push(`${Math.round(r.temperature)}°`);
  if (w) bits.push(`${localStamp(currentInstant(), w.utcOffsetSeconds || 0).slice(11)} local`);
  bits.push(
    simulated
      ? 'simulated sky'
      : state.timeOffsetHours === 0
        ? 'live'
        : `${state.timeOffsetHours > 0 ? '+' : ''}${state.timeOffsetHours} h forecast`
  );
  dom.ledeSub.textContent = bits.join(' · ');

  // ---- dial --------------------------------------------------------------
  dom.wxTemp.textContent = r.temperature === undefined ? '—' : Math.round(r.temperature);
  dom.wxFeels.textContent =
    r.apparentTemperature === undefined ? '' : `feels ${Math.round(r.apparentTemperature)}°`;
  // The arc reads -15 °C to +45 °C over three quarters of the circle.
  const frac = THREE.MathUtils.clamp(((r.temperature ?? 0) + 15) / 60, 0, 1);
  dom.dialArc.style.strokeDashoffset = String(DIAL_CIRCUMFERENCE * (1 - frac * 0.75));

  // ---- rows --------------------------------------------------------------
  dom.wxWind.textContent =
    r.windSpeed === undefined ? '—' : `${r.windSpeed.toFixed(1)} m/s ${compass(r.windDirection ?? 0)}`;
  dom.wxCloud.textContent = num(r.cloudCover, 0, '%');
  dom.wxHum.textContent = num(r.humidity, 0, '%');
  dom.wxPrecip.textContent =
    (r.snowfall ?? 0) > 0 ? `${r.snowfall.toFixed(1)} cm` : `${(r.precipitation ?? 0).toFixed(1)} mm`;
  dom.wxVis.textContent =
    climate.visibility >= 10000
      ? `${(climate.visibility / 1000).toFixed(0)} km`
      : `${Math.round(climate.visibility)} m`;

  // ---- strip -------------------------------------------------------------
  dom.wxSun.textContent = `${climate.sunAltitudeDeg > 0 ? '↑' : '↓'}${climate.sunAltitudeDeg.toFixed(0)}°`;
  dom.wxGust.textContent = num(r.windGust, 0, '');
  dom.wxPress.textContent = num(r.pressure ?? w?.current?.pressure, 0, '');

  if (w) {
    const stamp = localStamp(currentInstant(), w.utcOffsetSeconds || 0);
    dom.wxTime.textContent = stamp.slice(11);
    dom.timeCaption.textContent =
      state.timeOffsetHours === 0
        ? 'Live conditions'
        : `${state.timeOffsetHours > 0 ? '+' : ''}${state.timeOffsetHours} h · ${stamp.replace('T', ' ')}`;
  }
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

function showLoader(text, progress = 0) {
  dom.loader.hidden = false;
  dom.loaderText.textContent = text;
  dom.loaderBar.style.width = `${Math.round(progress * 100)}%`;
}
function hideLoader() {
  dom.loader.hidden = true;
}
function setStatus(text, kind = '') {
  dom.status.textContent = text;
  dom.status.className = `note ${kind}`;
  dom.creditStatus.textContent = text;
}
function openDrawer(open = true) {
  dom.drawer.hidden = !open;
  dom.btnPanel.setAttribute('aria-expanded', String(open));
}

/* ------------------------------------------------------------------ */
/* Building a cube                                                     */
/* ------------------------------------------------------------------ */

async function buildForPlace(place, { preferMode } = {}) {
  // Panels from the previous address must not survive into this one.
  state.photoReady = false;
  state.panoMeta = null;
  shell.clearTextures();

  state.place = place;
  dom.placeCoords.textContent =
    `${place.label} · ${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}` +
    (place.precision && place.precision !== 'house'
      ? ` · matched the ${place.precision}, so the marker may be off by some metres`
      : '');
  dom.ledePlace.textContent = `${shortPlace(place.label)}.`;
  dom.results.hidden = true;
  marker.setGroundY(GROUND_TOP);
  showPinLabel(place);

  try {
    showLoader('Reading the sky', 0.15);
    state.weather = await fetchWeather(place.lat, place.lon);
    state.lastWeatherFetch = Date.now();
    refreshClimate();
  } catch (err) {
    setStatus(`Weather unavailable: ${err.message}`, 'error');
  }

  const want = preferMode || state.preferredMode;
  const wantPhoto = want === 'photo';
  const key = dom.apiKey.value.trim();

  // Always build the block model: it is the fallback, and it is what shows
  // through if Street View has no coverage.
  let stats = 'Block model';
  try {
    showLoader('Cutting the ground', 0.45);
    setStatus('Fetching building footprints from OpenStreetMap…');
    const osm = await fetchOSM(place.lat, place.lon, MODEL_RADIUS_M, (host) => {
      showLoader(`Cutting the ground · ${host}`, 0.45);
    });
    const built = city.build(osm, place.lat, place.lon, MODEL_RADIUS_M, HEIGHT_EXAGGERATION);
    stats = built.buildings
      ? `${built.buildings} building footprints within ${MODEL_RADIUS_M} m, heights ×${HEIGHT_EXAGGERATION}`
      : `OpenStreetMap has no building footprints mapped within ${MODEL_RADIUS_M} m of here`;
    setStatus(stats, built.buildings ? 'ok' : 'error');
  } catch (err) {
    setStatus(`No footprints: ${err.message}. Press Build cube to retry.`, 'error');
  }

  const wantPhotoreal = want === 'photoreal';
  photoreal.dispose();

  if (wantPhoto && key) {
    await loadPhotos(place, key);
  } else if (wantPhotoreal && key) {
    await loadPhotoreal(place, key);
  } else if (wantPhoto || wantPhotoreal) {
    // No key: the block model is a real fallback, not a failure.
    setMode('model');
    setStatus(
      `${stats} · add a Google Maps Platform key in Controls for photorealistic 3D`,
      'ok'
    );
  } else {
    setMode('model');
  }

  hideLoader();
  refreshClimate();
  if (!userMovedCamera) fitCamera();
  writeURL();
}

async function loadPhotos(place, key) {
  try {
    state.photoReady = false;
    shell.clearTextures();
    const { meta, textures } = await loadStreetViewCube(place.lat, place.lon, key, {
      size: 640,
      radius: 80,
      headingOffset: state.headingOffset,
      onProgress: ({ done, total, stage }) => {
        showLoader(`Street View · ${stage}`, 0.5 + (done / total) * 0.5);
      },
    });
    state.panoMeta = meta;
    for (const [name, tex] of Object.entries(textures)) shell.setFaceTexture(name, tex);
    state.photoReady = true;
    setMode('photo');

    const dist = haversine(place.lat, place.lon, meta.lat, meta.lon);
    setStatus(
      `Street View panorama from ${meta.date || 'an unknown date'}, ${dist.toFixed(0)} m from the address`,
      'ok'
    );
    dom.svCredit.textContent = meta.copyright || 'Google Street View';
  } catch (err) {
    state.photoReady = false;
    setMode('model');
    setStatus(`Street View: ${err.message}`, 'error');
    if (/not activated|not been used|is disabled/i.test(err.message)) {
      reportKey([
        { what: 'Street View Static API', ok: false, why: 'Not enabled on this key\u2019s project.', href: ENABLE_URLS.streetview },
      ]);
      openKeyPanel();
    }
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p = Math.PI / 180;
  const a =
    0.5 -
    Math.cos((lat2 - lat1) * p) / 2 +
    (Math.cos(lat1 * p) * Math.cos(lat2 * p) * (1 - Math.cos((lon2 - lon1) * p))) / 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ------------------------------------------------------------------ */
/* Key diagnostics                                                     */
/* ------------------------------------------------------------------ */

/**
 * Render one line per API. Google's own text goes in via textContent, never
 * as markup.
 * @param {{what: string, ok: boolean, why?: string, href?: string}[]} rows
 */
function reportKey(rows) {
  dom.keyReport.innerHTML = '';
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = `line${row.ok ? '' : ' bad'}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = row.what;
    const verdict = document.createElement('span');
    verdict.textContent = row.ok ? 'working' : 'blocked';
    line.append(dot, what, verdict);
    dom.keyReport.appendChild(line);

    if (!row.ok && row.why) {
      const why = document.createElement('p');
      why.className = 'why';
      why.textContent = row.why;
      if (row.href) {
        why.append(' ');
        const a = document.createElement('a');
        a.href = row.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Enable it';
        why.appendChild(a);
      }
      dom.keyReport.appendChild(why);
    }
  }
  dom.keyReport.hidden = rows.length === 0;
}

async function testKey() {
  const key = dom.apiKey.value.trim();
  if (!key) {
    setStatus('Paste a key first.', 'error');
    return;
  }
  const place = state.place || { lat: 39.4739, lon: -0.3742 };
  dom.btnTestKey.disabled = true;
  dom.btnTestKey.textContent = 'Testing…';
  try {
    const [tiles, sv] = await Promise.all([
      probeTilesAccess(key),
      probeStreetViewAccess(key, place.lat, place.lon),
    ]);
    reportKey([
      {
        what: 'Map Tiles API · Photoreal 3D',
        ok: tiles.ok,
        why: tiles.ok ? '' : `${tiles.message}${tiles.detail ? ` ${tiles.detail}` : ''}`,
        href: ENABLE_URLS.tiles,
      },
      {
        what: 'Street View Static API',
        ok: sv.ok,
        why: sv.ok ? '' : `${sv.message}${sv.detail ? ` ${sv.detail}` : ''}`,
        href: ENABLE_URLS.streetview,
      },
    ]);
    setStatus(
      tiles.ok && sv.ok
        ? 'Both APIs are working on this key.'
        : 'See which API is blocked, above.',
      tiles.ok && sv.ok ? 'ok' : 'error'
    );
  } finally {
    dom.btnTestKey.disabled = false;
    dom.btnTestKey.textContent = 'Test key';
  }
}

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */

const MODE_HINTS = {
  model: 'The block model is extruded from OpenStreetMap footprints and needs no key.',
  photoreal: 'Google\u2019s photogrammetry of the block — real shapes, heights and façades — cut to the cube and relit for the weather.',
  photo: 'Four Street View walls and the road surface, relit for the current weather, capped by simulated cloud.',
};

function setMode(mode) {
  if (mode === 'photo' && !state.photoReady) mode = 'model';
  if (mode === 'photoreal' && !photoreal.tiles) mode = 'model';
  state.mode = mode;

  // Sky walls for anything three-dimensional; photo panels for the photo box.
  shell.setMode(mode === 'photo' ? 'photo' : 'sky');
  city.group.visible = mode === 'model';
  photoreal.group.visible = mode === 'photoreal';
  // A photographed street already contains its own ground; the cut slab sits
  // under anything with real geometry on it.
  groundSlab.group.visible = mode !== 'photo';

  for (const [key, btn] of [['photo', dom.segPhoto], ['model', dom.segModel], ['photoreal', dom.segPhotoreal]]) {
    btn.classList.toggle('is-active', mode === key);
    btn.setAttribute('aria-checked', String(mode === key));
  }
  dom.modeHint.textContent = MODE_HINTS[mode];
  dom.lightingRow.hidden = mode !== 'photoreal';
  controls.minDistance = mode === 'photo' ? 0.05 : 0.35;
}

async function loadPhotoreal(place, key) {
  showLoader('Checking the key with Google', 0.55);
  const probe = await probeTilesAccess(key);
  if (!probe.ok) {
    hideLoader();
    setStatus(probe.message, 'error');
    reportKey([
      {
        what: 'Map Tiles API · Photoreal 3D',
        ok: false,
        why: `${probe.message}${probe.detail ? ` ${probe.detail}` : ''}`,
        href: ENABLE_URLS.tiles,
      },
    ]);
    openKeyPanel();
    setMode('model');
    return;
  }

  showLoader('Google 3D Tiles', 0.7);
  photoreal.load(place.lat, place.lon, key, MODEL_RADIUS_M, camera, renderer);
  // Give the first tiles a moment so a late failure surfaces here.
  await new Promise((r) => setTimeout(r, 1200));
  hideLoader();
  if (photoreal.status !== 'error') setMode('photoreal');
}

const LIGHTING_HINTS = {
  lit:
    'The captured imagery is turned back into material colour and lit by the ' +
    'real sun for the chosen minute, casting its own shadows. Move the hour ' +
    'slider and watch them sweep across the block.',
  flat:
    'Google\u2019s own lighting, from the day the block was flown, with the ' +
    'weather graded over it. Relighting is an estimate; this is the ' +
    'photograph.',
};

function setLighting(lighting) {
  state.lighting = lighting;
  photoreal.setLighting(lighting);
  dom.segLit.classList.toggle('is-active', lighting === 'lit');
  dom.segFlat.classList.toggle('is-active', lighting === 'flat');
  dom.segLit.setAttribute('aria-checked', String(lighting === 'lit'));
  dom.segFlat.setAttribute('aria-checked', String(lighting === 'flat'));
  dom.lightingHint.textContent = LIGHTING_HINTS[lighting];
  try {
    localStorage.setItem('weathercube.lighting', lighting);
  } catch { /* private browsing */ }
  refreshClimate();
}

function openKeyPanel() {
  openDrawer(true);
  dom.keyBody.hidden = false;
  dom.keyToggle.setAttribute('aria-expanded', 'true');
  dom.apiKey.focus();
}

/* ------------------------------------------------------------------ */
/* URL state                                                           */
/* ------------------------------------------------------------------ */

function writeURL() {
  if (!state.place) return;
  const p = new URLSearchParams();
  p.set('q', state.place.label);
  p.set('lat', state.place.lat.toFixed(6));
  p.set('lon', state.place.lon.toFixed(6));
  p.set('mode', state.mode);
  if (state.override !== 'live') p.set('sky', state.override);
  if (state.headingOffset) p.set('heading', String(state.headingOffset));
  history.replaceState(null, '', `?${p}`);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

dom.btnPanel.addEventListener('click', () => openDrawer(dom.drawer.hidden));
dom.btnClose.addEventListener('click', () => openDrawer(false));
dom.btnChange.addEventListener('click', () => {
  openDrawer(true);
  dom.address.focus();
  dom.address.select();
});

dom.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = dom.address.value.trim();
  if (!q) return;
  dom.btnSearch.disabled = true;
  setStatus('Looking up the address');
  try {
    showLoader('Finding the address', 0.05);
    const hits = await geocode(q);
    hideLoader();
    if (!hits.length) {
      setStatus('No match. Try adding the city and country.', 'error');
      return;
    }
    if (hits.length === 1) {
      await buildForPlace(hits[0]);
    } else {
      showResults(hits);
      setStatus('Pick the right one.');
    }
  } catch (err) {
    hideLoader();
    setStatus(`Geocoding failed: ${err.message}`, 'error');
  } finally {
    dom.btnSearch.disabled = false;
  }
});

function showResults(hits) {
  dom.results.innerHTML = '';
  for (const hit of hits) {
    const li = document.createElement('li');
    li.textContent = hit.label;
    li.addEventListener('click', () => buildForPlace(hit));
    dom.results.appendChild(li);
  }
  dom.results.hidden = false;
}

dom.btnLocate.addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus('This browser will not share a location.', 'error');
    return;
  }
  setStatus('Asking the browser where you are');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      try {
        const place = await reverseGeocode(lat, lon);
        dom.address.value = place.label;
        await buildForPlace({ ...place, lat, lon });
      } catch {
        await buildForPlace({ label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon });
      }
    },
    (err) => setStatus(`Location denied: ${err.message}`, 'error'),
    { enableHighAccuracy: true, timeout: 12000 }
  );
});

dom.segPhoto.addEventListener('click', async () => {
  rememberMode('photo');
  const key = dom.apiKey.value.trim();
  if (!state.place) return setStatus('Build a cube first.', 'error');
  if (!key) {
    setStatus('Street View needs a Google Maps Platform key.', 'error');
    return openKeyPanel();
  }
  if (state.photoReady) return setMode('photo');
  showLoader('Street View', 0.5);
  await loadPhotos(state.place, key);
  hideLoader();
  refreshClimate();
});

function rememberMode(mode) {
  state.preferredMode = mode;

  let savedLighting = null;
  try {
    savedLighting = localStorage.getItem('weathercube.lighting');
  } catch { /* ignore */ }
  if (savedLighting === 'flat' || savedLighting === 'lit') {
    state.lighting = savedLighting;
    photoreal.lighting = savedLighting;
    dom.segLit.classList.toggle('is-active', savedLighting === 'lit');
    dom.segFlat.classList.toggle('is-active', savedLighting === 'flat');
  }
  try {
    localStorage.setItem('weathercube.mode', mode);
  } catch { /* private browsing */ }
}

dom.segModel.addEventListener('click', () => {
  rememberMode('model');
  setMode('model');
});

dom.segLit.addEventListener('click', () => setLighting('lit'));
dom.segFlat.addEventListener('click', () => setLighting('flat'));

dom.segPhotoreal.addEventListener('click', async () => {
  rememberMode('photoreal');
  const key = dom.apiKey.value.trim();
  if (!state.place) return setStatus('Build a cube first.', 'error');
  if (!key) {
    setStatus('Photoreal 3D needs a Google Maps Platform key with the Map Tiles API enabled.', 'error');
    return openKeyPanel();
  }
  if (photoreal.tiles) return setMode('photoreal');
  await loadPhotoreal(state.place, key);
  refreshClimate();
  writeURL();
});

dom.keyToggle.addEventListener('click', () => {
  const open = dom.keyBody.hidden;
  dom.keyBody.hidden = !open;
  dom.keyToggle.setAttribute('aria-expanded', String(open));
});

dom.apiKey.addEventListener('change', () => {
  if (dom.rememberKey.checked) {
    try {
      localStorage.setItem('weathercube.key', dom.apiKey.value.trim());
    } catch { /* private browsing */ }
  }
});
dom.btnTestKey.addEventListener('click', testKey);
dom.rememberKey.addEventListener('change', () => {
  if (!dom.rememberKey.checked) {
    try { localStorage.removeItem('weathercube.key'); } catch { /* ignore */ }
  }
});

dom.timeSlider.addEventListener('input', () => {
  state.timeOffsetHours = parseInt(dom.timeSlider.value, 10);
  refreshClimate();
});
dom.btnNow.addEventListener('click', () => {
  state.timeOffsetHours = 0;
  dom.timeSlider.value = '0';
  refreshClimate();
});

dom.override.addEventListener('change', () => {
  state.override = dom.override.value;
  refreshClimate();
  writeURL();
});

dom.optRotate.addEventListener('change', () => (controls.autoRotate = dom.optRotate.checked));
dom.optGlass.addEventListener('change', () => {
  glass.visible = dom.optGlass.checked;
  edges.visible = dom.optGlass.checked;
});
dom.optSkyReplace.addEventListener('change', () => {
  const v = dom.optSkyReplace.checked ? 1 : 0;
  for (const face of Object.values(shell.faces)) face.photo.uniforms.uSkyReplace.value = v;
});
dom.optQuality.addEventListener('change', () => {
  state.quality = parseFloat(dom.optQuality.value);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, state.quality >= 1 ? 2 : 1.5));
  // Shadow-mapping a photogrammetry mesh is the most expensive thing here.
  photoreal.setCastShadows(state.quality >= 0.6);
  refreshClimate();
});

dom.btnShot.addEventListener('click', () => {
  renderer.render(scene, camera);
  const link = document.createElement('a');
  const name = (state.place?.label || 'weather-cube').split(',')[0].replace(/\W+/g, '-').toLowerCase();
  link.download = `${name}-cube.png`;
  link.href = renderer.domElement.toDataURL('image/png');
  link.click();
});

dom.btnShare.addEventListener('click', async () => {
  writeURL();
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('Link copied.', 'ok');
  } catch {
    setStatus(location.href);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') openDrawer(false);
  if (e.key === 'c') openDrawer(dom.drawer.hidden);
  if (e.key === 'r') dom.optRotate.click();
});

/* Keep live conditions live. */
setInterval(async () => {
  if (!state.place || state.timeOffsetHours !== 0) return;
  if (Date.now() - state.lastWeatherFetch < 9 * 60 * 1000) return;
  try {
    state.weather = await fetchWeather(state.place.lat, state.place.lon);
    state.lastWeatherFetch = Date.now();
    refreshClimate();
  } catch { /* keep the last good reading */ }
}, 60 * 1000);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(function boot() {
  try {
    const saved = localStorage.getItem('weathercube.key');
    if (saved) dom.apiKey.value = saved;
  } catch { /* ignore */ }

  const params = new URLSearchParams(location.search);
  const heading = parseFloat(params.get('heading'));
  if (Number.isFinite(heading)) {
    state.headingOffset = ((heading % 360) + 360) % 360;
    applyHeadingOffset();
  }
  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  const q = params.get('q');
  if (params.get('sky')) {
    state.override = params.get('sky');
    dom.override.value = state.override;
  }
  // Photoreal is the default; a URL parameter wins, then the last choice made
  // on this device.
  let saved = null;
  try {
    saved = localStorage.getItem('weathercube.mode');
  } catch { /* ignore */ }
  const valid = ['model', 'photoreal', 'photo'];
  const mode = valid.includes(params.get('mode'))
    ? params.get('mode')
    : valid.includes(saved)
      ? saved
      : 'photoreal';
  state.preferredMode = mode;

  let savedLighting = null;
  try {
    savedLighting = localStorage.getItem('weathercube.lighting');
  } catch { /* ignore */ }
  if (savedLighting === 'flat' || savedLighting === 'lit') {
    state.lighting = savedLighting;
    photoreal.lighting = savedLighting;
    dom.segLit.classList.toggle('is-active', savedLighting === 'lit');
    dom.segFlat.classList.toggle('is-active', savedLighting === 'flat');
  }

  // Nothing has loaded yet — give the cube a plausible sky so it is never blank.
  applyClimate(
    buildClimate(
      { temperature: 18, cloudCover: 25, weatherCode: 1, windSpeed: 3, windDirection: 90, humidity: 55 },
      new Date(),
      39.4735,
      -0.3733
    )
  );
  setMode('model');

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    dom.address.value = q || `${lat}, ${lon}`;
    buildForPlace({ label: q || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon }, { preferMode: mode });
  } else {
    // Default to the address in the brief so the page is never empty.
    dom.form.requestSubmit();
  }
})();

/* Exposed for debugging and for the smoke test. */
window.__cube = {
  state, scene, camera, controls, renderer,
  shell, city, fx, glass, sky, groundSlab, photoreal,
  applyClimate, buildClimate, setMode,
  layout: { GROUND_TOP, SKY_BOTTOM },
};
