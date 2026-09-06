// Synthetic responses used only by tools/smoke.mjs, so the renderer can be
// exercised without touching the network. These are NOT real Valencia data.

const LAT = 39.4739;
const LON = -0.3742;

export const NOMINATIM = [
  {
    display_name: 'Test Block, Sample District, Sample City, 00000, Testland',
    lat: String(LAT),
    lon: String(LON),
    type: 'house',
    address: { road: 'Test Street', city: 'Sample City' },
  },
];

function hours(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

const N = 72;
export const OPEN_METEO = {
  timezone: 'Europe/Madrid',
  utc_offset_seconds: 7200,
  current: {
    time: '2026-09-05T14:00',
    temperature_2m: 27.4,
    relative_humidity_2m: 58,
    apparent_temperature: 29.1,
    is_day: 1,
    precipitation: 0,
    rain: 0,
    showers: 0,
    snowfall: 0,
    weather_code: 2,
    cloud_cover: 38,
    pressure_msl: 1015,
    wind_speed_10m: 4.2,
    wind_direction_10m: 110,
    wind_gusts_10m: 8.1,
  },
  hourly: {
    time: hours(N, (i) => {
      const d = new Date(Date.UTC(2026, 8, 4, 0) + i * 3600000);
      const p = (v) => String(v).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:00`;
    }),
    temperature_2m: hours(N, (i) => 20 + 7 * Math.sin((i / 24) * Math.PI * 2)),
    relative_humidity_2m: hours(N, () => 60),
    precipitation: hours(N, (i) => (i % 17 === 0 ? 3.2 : 0)),
    rain: hours(N, (i) => (i % 17 === 0 ? 3.2 : 0)),
    snowfall: hours(N, () => 0),
    snow_depth: hours(N, () => 0),
    weather_code: hours(N, (i) => (i % 17 === 0 ? 63 : 2)),
    cloud_cover: hours(N, (i) => 20 + 40 * Math.abs(Math.sin(i / 5))),
    visibility: hours(N, () => 21000),
    wind_speed_10m: hours(N, () => 4),
    wind_direction_10m: hours(N, () => 110),
    wind_gusts_10m: hours(N, () => 8),
    is_day: hours(N, (i) => (i % 24 > 6 && i % 24 < 20 ? 1 : 0)),
  },
  daily: {
    sunrise: ['2026-09-04T07:44', '2026-09-05T07:45', '2026-09-06T07:46'],
    sunset: ['2026-09-04T20:40', '2026-09-05T20:38', '2026-09-06T20:37'],
    temperature_2m_max: [29, 28, 30],
    temperature_2m_min: [19, 18, 20],
  },
};

/* A synthetic grid of perimeter blocks with courtyards, plus a street grid. */
function rect(cx, cz, w, h) {
  // metres -> degrees around (LAT, LON)
  const mLat = 1 / 111132;
  const mLon = 1 / (111412 * Math.cos((LAT * Math.PI) / 180));
  const pts = [
    [cx - w / 2, cz - h / 2],
    [cx + w / 2, cz - h / 2],
    [cx + w / 2, cz + h / 2],
    [cx - w / 2, cz + h / 2],
    [cx - w / 2, cz - h / 2],
  ];
  return pts.map(([x, z]) => ({ lat: LAT - z * mLat, lon: LON + x * mLon }));
}

const elements = [];
let id = 1;
for (let bx = -1; bx <= 1; bx++) {
  for (let bz = -1; bz <= 1; bz++) {
    const cx = bx * 70;
    const cz = bz * 70;
    // Four wings around a courtyard.
    const wings = [
      [cx, cz - 22, 52, 12],
      [cx, cz + 22, 52, 12],
      [cx - 22, cz, 12, 52],
      [cx + 22, cz, 12, 52],
    ];
    wings.forEach(([x, z, w, h], k) => {
      elements.push({
        type: 'way',
        id: id++,
        tags: { building: 'yes', 'building:levels': String(4 + ((bx + bz + k) % 3)) },
        geometry: rect(x, z, w, h),
      });
    });
  }
}
// Streets between the blocks.
const mLat = 1 / 111132;
const mLon = 1 / (111412 * Math.cos((LAT * Math.PI) / 180));
for (let i = -2; i <= 2; i++) {
  const o = i * 35;
  elements.push({
    type: 'way',
    id: id++,
    tags: { highway: 'residential' },
    geometry: [
      { lat: LAT - -140 * mLat, lon: LON + o * mLon },
      { lat: LAT - 140 * mLat, lon: LON + o * mLon },
    ],
  });
  elements.push({
    type: 'way',
    id: id++,
    tags: { highway: 'residential' },
    geometry: [
      { lat: LAT - o * mLat, lon: LON + -140 * mLon },
      { lat: LAT - o * mLat, lon: LON + 140 * mLon },
    ],
  });
}
// A small park and a row of street trees.
elements.push({
  type: 'way',
  id: id++,
  tags: { leisure: 'park' },
  geometry: rect(-70, 70, 46, 46),
});
for (let i = -4; i <= 4; i++) {
  elements.push({
    type: 'node',
    id: id++,
    tags: { natural: 'tree' },
    lat: LAT - 8 * mLat,
    lon: LON + i * 12 * mLon,
  });
}

/* ------------------------------------------------------------------ */
/* Footprints matching the 3D Tiles fixture, for the measurement test.  */
/* tools/make-tiles-fixture.py builds boxes of known height at known    */
/* offsets; these are the same rectangles as OSM ways, so measured      */
/* heights can be asserted against truth.                               */
/* ------------------------------------------------------------------ */

export const KNOWN_BUILDINGS = [
  { name: 'fixture-tower-east', east: 70, north: 0, w: 14, d: 14, height: 48 },
  { name: 'fixture-slab-north', east: 0, north: 70, w: 30, d: 12, height: 18 },
  { name: 'fixture-block-centre', east: 0, north: 0, w: 16, d: 16, height: 22 },
];

for (const b of KNOWN_BUILDINGS) {
  elements.push({
    type: 'way',
    id: id++,
    tags: { building: 'yes', name: b.name },
    // rect() takes (centre east, centre south) — north is negative south.
    geometry: rect(b.east, -b.north, b.w, b.d),
  });
}

export const OVERPASS = { elements };
export const CENTRE = { lat: LAT, lon: LON };
