// Offline smoke test: serves the site, stubs every third-party call with
// fixtures, then renders a set of weather states and saves screenshots.
//
//   node tools/smoke.mjs [outDir]

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOMINATIM, OPEN_METEO, OVERPASS, KNOWN_BUILDINGS } from './fixtures.mjs';
import { panelSVG, METADATA } from './svfixture.mjs';

const TILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiles');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'shots'));
fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === '/') file = path.join(root, 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const problems = [];
page.on('console', (m) => {
  const t = m.text();
  // SwiftShader's ReadPixels stall warning is the screenshotting itself, not the page.
  if (/GPU stall due to ReadPixels/.test(t)) return;
  if (m.type() === 'error' || /THREE\.\w+:|WebGL|shader/i.test(t)) problems.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await page.route(/nominatim/, (r) => r.fulfill(json(NOMINATIM)));
await page.route(/open-meteo/, (r) => r.fulfill(json(OPEN_METEO)));
await page.route(/overpass/, (r) => r.fulfill(json(OVERPASS)));
// Stand-in Google 3D Tiles: a synthetic block placed on Earth at the fixture
// point, served for the root tileset and its single glb.
await page.route(/tile\.googleapis\.com/, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('root.json')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: fs.readFileSync(path.join(TILES_DIR, 'root.json')),
    });
  }
  if (url.pathname.endsWith('.glb')) {
    return route.fulfill({
      status: 200,
      contentType: 'model/gltf-binary',
      headers: { 'access-control-allow-origin': '*' },
      body: fs.readFileSync(path.join(TILES_DIR, 'block.glb')),
    });
  }
  return route.fulfill({ status: 404, body: 'not in fixture' });
});

// Stand-in Street View: metadata plus one labelled panel per face.
await page.route(/maps\.googleapis\.com/, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('/metadata')) {
    return route.fulfill({ ...json(METADATA), headers: { 'access-control-allow-origin': '*' } });
  }
  return route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    headers: { 'access-control-allow-origin': '*' },
    body: panelSVG({
      heading: url.searchParams.get('heading'),
      pitch: url.searchParams.get('pitch'),
    }),
  });
});

await page.goto(base, { waitUntil: 'networkidle' });
try {
  await page.waitForFunction(() => window.__cube?.state?.weather, null, { timeout: 20000 });
} catch (err) {
  console.error('the app never reached a weather state');
  for (const p of [...new Set(problems)]) console.error('  ' + p);
  await browser.close();
  server.close();
  process.exit(1);
}
await page.waitForTimeout(1500);

// DAY / DUSK / NIGHT are offsets from "now" that land on a fixed local hour,
// so the set is comparable however late it happens to be when this runs.
const localHourNow = await page.evaluate(() =>
  Number(document.getElementById('wx-time').textContent.slice(0, 2))
);
const at = (targetHour) => {
  let d = targetHour - localHourNow;
  if (d < -24) d += 24;
  if (d > 24) d -= 24;
  return d;
};
const DAY = at(13);
const DUSK = at(20);
const NIGHT = at(2);

const SCENES = [
  { name: '01-live', sky: 'live', hour: 0 },
  { name: '02-clear-day', sky: 'clear', hour: DAY },
  { name: '03-overcast', sky: 'overcast', hour: DAY },
  { name: '04-rain', sky: 'rain', hour: DAY },
  { name: '05-storm', sky: 'storm', hour: DAY },
  { name: '06-snow', sky: 'snow', hour: DAY },
  { name: '07-fog', sky: 'fog', hour: DAY },
  { name: '08-night-clear', sky: 'clear', hour: NIGHT },
  { name: '09-night-rain', sky: 'rain', hour: NIGHT },
  { name: '10-dusk', sky: 'partly', hour: DUSK },
];

// Hold the camera still so the frames are comparable.
await page.evaluate(() => {
  const { camera, controls } = window.__cube;
  document.getElementById('opt-rotate').checked = false;
  document.getElementById('opt-rotate').dispatchEvent(new Event('change'));
  controls.target.set(0, -0.02, 0);
  camera.position.set(4.05, 3.15, 4.65);
  controls.update();
});

for (const scene of SCENES) {
  await page.evaluate(({ sky, hour }) => {
    const sel = document.getElementById('override');
    sel.value = sky;
    sel.dispatchEvent(new Event('change'));
    const slider = document.getElementById('time-slider');
    slider.value = String(hour);
    slider.dispatchEvent(new Event('input'));
  }, scene);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, `${scene.name}.png`) });
  process.stdout.write(`rendered ${scene.name}\n`);
}

// The default view: steep, looking down into the block through the thinned lid.
await page.evaluate(() => {
  const { camera, controls } = window.__cube;
  controls.target.set(0, -0.02, 0);
  camera.position.set(3.1, 5.3, 3.55);
  controls.update();
  const sel = document.getElementById('override');
  sel.value = 'overcast';
  sel.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(outDir, '12-overhead.png') });

// A close-in view from inside the cube, which is how the photo mode is used.
await page.evaluate(() => {
  const { camera, controls } = window.__cube;
  camera.position.set(0.55, 0.12, 0.55);
  controls.target.set(0, -0.1, -1);
  controls.update();
  const sel = document.getElementById('override');
  sel.value = 'rain';
  sel.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outDir, '11-inside.png') });

/* ---- Street View mode: check the panels land on the right walls ---- */
await page.evaluate(() => {
  document.getElementById('api-key').value = 'TEST_KEY';
  const sel = document.getElementById('override');
  sel.value = 'clear';
  sel.dispatchEvent(new Event('change'));
  const slider = document.getElementById('time-slider');
  slider.dispatchEvent(new Event('input'));
});
await page.evaluate((h) => {
  const slider = document.getElementById('time-slider');
  slider.value = String(h);
  slider.dispatchEvent(new Event('input'));
}, DAY);
await page.click('#btn-panel');
await page.click('#seg-photo');
await page.waitForFunction(() => window.__cube.state.photoReady === true, null, { timeout: 20000 });
await page.waitForTimeout(600);

// Stand in the middle and look at each wall in turn.
const LOOKS = [
  ['north', [0, 0, -1]],
  ['east', [1, 0, 0]],
  ['south', [0, 0, 1]],
  ['west', [-1, 0, 0]],
  ['down', [0, -1, 0]],
];
for (const [name, dir] of LOOKS) {
  await page.evaluate(([d]) => {
    // OrbitControls owns the camera, so steer it by moving the orbit target.
    // A 90 deg field of view frames exactly one wall of the cube.
    const { camera, controls } = window.__cube;
    camera.fov = 90;
    camera.updateProjectionMatrix();
    controls.target.set(d[0] * 2, d[1] * 2, d[2] * 2);
    camera.position.set(-d[0] * 0.02, -d[1] * 0.02, -d[2] * 0.02);
    controls.update();
  }, [dir]);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, `sv-${name}.png`), clip: { x: 470, y: 0, width: 900, height: 900 } });
  process.stdout.write(`rendered sv-${name}\n`);
}

// And an outside view of the photo cube.
await page.evaluate(() => {
  const { camera, controls } = window.__cube;
  camera.fov = 38;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  camera.position.set(2.9, 1.8, 3.3);
  controls.update();
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, 'sv-outside.png') });

/* ---- Photoreal 3D mode: the tiles fixture placed, scaled and settled ---- */
await page.evaluate((h) => {
  const slider = document.getElementById('time-slider');
  slider.value = String(h);
  slider.dispatchEvent(new Event('input'));
  const sel = document.getElementById('override');
  sel.value = 'clear';
  sel.dispatchEvent(new Event('change'));
}, DAY);
await page.click('#seg-photoreal');
try {
  await page.waitForFunction(
    () => window.__cube.state.mode === 'photoreal' && window.__cube.photoreal.groundSettled > 0,
    null,
    { timeout: 25000 }
  );
} catch {
  problems.push('[photoreal] tiles never settled: status=' + (await page.evaluate(() => window.__cube.photoreal.status + ' ' + (window.__cube.photoreal.error || '') + ' settled=' + window.__cube.photoreal.groundSettled)));
}
await page.evaluate(() => {
  const { camera, controls } = window.__cube;
  document.getElementById('btn-close').click();
  controls.target.set(0, -0.02, 0);
  camera.position.set(4.05, 3.15, 4.65);
  controls.update();
});
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(outDir, 'tiles-day.png') });
await page.evaluate((h) => {
  const slider = document.getElementById('time-slider');
  slider.value = String(h);
  slider.dispatchEvent(new Event('input'));
  const sel = document.getElementById('override');
  sel.value = 'rain';
  sel.dispatchEvent(new Event('change'));
}, NIGHT);
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, 'tiles-night-rain.png') });
const tilesInfo = await page.evaluate(() => ({
  status: window.__cube.photoreal.status,
  settled: window.__cube.photoreal.groundSettled,
  groundOffset: window.__cube.photoreal.groundOffset,
  materials: window.__cube.photoreal.materials.size,
  credit: window.__cube.photoreal.attributions(),
}));
console.log('photoreal:', tilesInfo);
process.stdout.write('rendered tiles-day, tiles-night-rain\n');

/* ---- Measurement: heights read off the mesh, against known truth ---- */
// The tileset fixture is built from boxes of known height, and the OSM fixture
// carries footprints on the same rectangles. So the measuring stage can be
// checked against truth with no network and no API key.
const measured = await page.evaluate(async () => {
  const rows = await window.__cube.measureFromTiles();
  return rows
    .filter((r) => r.name && r.name.startsWith('fixture-'))
    .map((r) => ({
      name: r.name,
      eave: r.eaveHeight ? +r.eaveHeight.toFixed(2) : null,
      ridge: r.ridgeHeight ? +r.ridgeHeight.toFixed(2) : null,
      roof: r.roof?.kind || null,
      samples: r.sampleCount || 0,
      confidence: r.confidence,
      source: r.source,
    }));
});
console.log('measured:', measured);
for (const truth of KNOWN_BUILDINGS) {
  const got = measured.find((m) => m.name === truth.name);
  if (!got || got.source !== 'measured') {
    problems.push(`[measure] ${truth.name} was not measured at all`);
    continue;
  }
  // Within half a metre of the box it was measuring.
  if (Math.abs(got.eave - truth.height) > 0.5) {
    problems.push(`[measure] ${truth.name}: ${got.eave} m, expected ${truth.height} m`);
  }
  // Every fixture box is flat-topped.
  if (got.roof !== 'flat') {
    problems.push(`[measure] ${truth.name}: roof read as ${got.roof}, expected flat`);
  }
}

/* ---- Relighting: the sun must actually move the shadows ---- */
// Same weather, three different hours. If lighting is genuinely rebuilt, the
// frames differ; if it were still a grade on a baked photo, they would not.
const sunFrames = [];
for (const [name, hour] of [['morning', at(9)], ['noon', at(13)], ['evening', at(19)]]) {
  await page.evaluate((h) => {
    const sel = document.getElementById('override');
    sel.value = 'clear';
    sel.dispatchEvent(new Event('change'));
    const slider = document.getElementById('time-slider');
    slider.value = String(h);
    slider.dispatchEvent(new Event('input'));
  }, hour);
  await page.waitForTimeout(700);
  const shot = path.join(outDir, `sun-${name}.png`);
  await page.screenshot({ path: shot, clip: { x: 430, y: 140, width: 580, height: 560 } });
  sunFrames.push({ name, bytes: fs.readFileSync(shot) });
  process.stdout.write(`rendered sun-${name}\n`);
}
const distinct = new Set(sunFrames.map((f) => f.bytes.toString('base64'))).size;
console.log(`relighting: ${distinct} distinct frames across three hours (want 3)`);
if (distinct < 3) problems.push('[relight] the sun does not change the render');

// And the sun direction really is being tracked.
const sunTrack = await page.evaluate(() => ({
  sunDir: window.__cube.state.climate.sunDir.toArray().map((v) => +v.toFixed(2)),
  altitude: +window.__cube.state.climate.sunAltitudeDeg.toFixed(1),
  shadows: window.__cube.renderer.shadowMap.enabled,
  lighting: window.__cube.state.lighting,
  environment: !!window.__cube.scene.environment,
}));
console.log('sun track:', sunTrack);
if (!sunTrack.environment) problems.push('[relight] no sky environment map');

/* ---- Phone sideways: short and wide, the layout that clipped the dial ---- */
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, '14-landscape-phone.png') });
const shortFit = await page.evaluate(() => {
  const r = document.querySelector('.readout').getBoundingClientRect();
  const l = document.querySelector('.lede').getBoundingClientRect();
  return {
    readoutTop: Math.round(r.top),
    readoutBottom: Math.round(r.bottom),
    ledeTop: Math.round(l.top),
    ledeBottom: Math.round(l.bottom),
    h: window.innerHeight,
  };
});
console.log('landscape phone:', shortFit);
if (shortFit.readoutTop < 0 || shortFit.readoutBottom > shortFit.h)
  problems.push(`[layout] readout clipped: ${JSON.stringify(shortFit)}`);
if (shortFit.ledeTop < 0 || shortFit.ledeBottom > shortFit.h)
  problems.push(`[layout] headline clipped: ${JSON.stringify(shortFit)}`);

/* ---- Phone: the whole cube has to fit a portrait viewport ---- */
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, '13-phone.png') });
const phoneFit = await page.evaluate(() => {
  const { camera, controls } = window.__cube;
  camera.updateMatrixWorld();
  const THREE_fov = (camera.fov * Math.PI) / 180;
  // Project the eight cube corners and check they all land on screen.
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
  let maxX = 0, maxY = 0;
  for (const [x, y, z] of corners) {
    const v = { x, y, z };
    const p = new (Object.getPrototypeOf(camera.position).constructor)(v.x, v.y, v.z);
    p.project(camera);
    maxX = Math.max(maxX, Math.abs(p.x));
    maxY = Math.max(maxY, Math.abs(p.y));
  }
  return { maxX: +maxX.toFixed(3), maxY: +maxY.toFixed(3), dist: +camera.position.distanceTo(controls.target).toFixed(2) };
});
console.log('phone fit (must be <= 1.0):', phoneFit);
if (phoneFit.maxX > 1 || phoneFit.maxY > 1) problems.push(`[phone] cube overflows viewport: ${JSON.stringify(phoneFit)}`);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);

/* ---- README preview: the model cube at night in the rain, no chrome ---- */
await page.evaluate(() => {
  document.getElementById('btn-close').click();
  for (const sel of ['.topbar', '.lede', '.readout', '.strip', '.credits']) {
    document.querySelector(sel).style.opacity = '0';
  }
  document.getElementById('seg-model').click();
});
await page.evaluate((h) => {
  const slider = document.getElementById('time-slider');
  slider.value = String(h);
  slider.dispatchEvent(new Event('input'));
  const sel = document.getElementById('override');
  sel.value = 'rain';
  sel.dispatchEvent(new Event('change'));
  const { camera, controls } = window.__cube;
  controls.target.set(0, -0.02, 0);
  camera.position.set(3.7, 2.85, 4.25);
  controls.update();
}, NIGHT);
await page.waitForTimeout(1200);
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
await page.screenshot({
  path: path.join(root, 'docs', 'preview-night-rain.png'),
  clip: { x: 340, y: 50, width: 800, height: 800 },
});
await page.evaluate(() => {
  for (const sel of ['.topbar', '.lede', '.readout', '.strip', '.credits']) {
    document.querySelector(sel).style.opacity = '';
  }
});

const stats = await page.evaluate(() => ({
  buildings: window.__cube.city.stats.buildings,
  roads: window.__cube.city.stats.roads,
  trees: window.__cube.city.stats.trees,
  mode: window.__cube.state.mode,
  photoReady: window.__cube.state.photoReady,
  temp: window.__cube.state.weather?.current?.temperature,
  drawCalls: window.__cube.renderer.info.render.calls,
  triangles: window.__cube.renderer.info.render.triangles,
}));

console.log('\nscene stats:', stats);
if (problems.length) {
  console.log('\nconsole problems:');
  for (const p of [...new Set(problems)]) console.log('  ' + p);
} else {
  console.log('\nno console errors');
}

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
