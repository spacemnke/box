// Offline smoke test: serves the site, stubs every third-party call with
// fixtures, then renders a set of weather states and saves screenshots.
//
//   node tools/smoke.mjs [outDir]

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOMINATIM, OPEN_METEO, OVERPASS } from './fixtures.mjs';
import { panelSVG, METADATA } from './svfixture.mjs';

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
  if (m.type() === 'error' || /THREE\.\w+:|WebGL|shader/i.test(t)) problems.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await page.route(/nominatim/, (r) => r.fulfill(json(NOMINATIM)));
await page.route(/open-meteo/, (r) => r.fulfill(json(OPEN_METEO)));
await page.route(/overpass/, (r) => r.fulfill(json(OVERPASS)));
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
