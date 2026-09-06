// Every network call the app makes lives here.
// All of these run from the visitor's browser; nothing is proxied through a server.

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const GOOGLE_SV = 'https://maps.googleapis.com/maps/api/streetview';

async function getJSON(url, options = {}) {
  const res = await fetch(url, { mode: 'cors', ...options });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Geocoding                                                           */
/* ------------------------------------------------------------------ */

/** Free-text address -> candidate places (OpenStreetMap / Nominatim). */
export async function geocode(query) {
  const url =
    `${NOMINATIM}/search?` +
    new URLSearchParams({
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '6',
    });
  const rows = await getJSON(url);
  return rows.map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    type: r.type,
    address: r.address || {},
  }));
}

/** Coordinates -> a human readable address. */
export async function reverseGeocode(lat, lon) {
  const url =
    `${NOMINATIM}/reverse?` +
    new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: 'jsonv2',
      zoom: '18',
      addressdetails: '1',
    });
  const r = await getJSON(url);
  return {
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    address: r.address || {},
  };
}

/* ------------------------------------------------------------------ */
/* Weather                                                             */
/* ------------------------------------------------------------------ */

const CURRENT_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'pressure_msl',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
];

const HOURLY_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'rain',
  'snowfall',
  'snow_depth',
  'weather_code',
  'cloud_cover',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'is_day',
];

/**
 * Current conditions plus 48h of hourly detail, so the time slider can move
 * through the day with real numbers rather than invented ones.
 */
export async function fetchWeather(lat, lon) {
  const url =
    `${OPEN_METEO}?` +
    new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      current: CURRENT_FIELDS.join(','),
      hourly: HOURLY_FIELDS.join(','),
      daily: 'sunrise,sunset,temperature_2m_max,temperature_2m_min',
      timezone: 'auto',
      forecast_days: '2',
      past_days: '1',
      wind_speed_unit: 'ms',
    });
  const raw = await getJSON(url);
  return normaliseWeather(raw);
}

function normaliseWeather(raw) {
  const c = raw.current || {};
  const hourly = [];
  const times = raw.hourly?.time || [];
  for (let i = 0; i < times.length; i++) {
    hourly.push({
      time: times[i],
      // Open-Meteo returns local wall-clock strings when timezone=auto.
      temperature: raw.hourly.temperature_2m?.[i],
      humidity: raw.hourly.relative_humidity_2m?.[i],
      precipitation: raw.hourly.precipitation?.[i],
      rain: raw.hourly.rain?.[i],
      snowfall: raw.hourly.snowfall?.[i],
      snowDepth: raw.hourly.snow_depth?.[i],
      weatherCode: raw.hourly.weather_code?.[i],
      cloudCover: raw.hourly.cloud_cover?.[i],
      visibility: raw.hourly.visibility?.[i],
      windSpeed: raw.hourly.wind_speed_10m?.[i],
      windDirection: raw.hourly.wind_direction_10m?.[i],
      windGust: raw.hourly.wind_gusts_10m?.[i],
      isDay: raw.hourly.is_day?.[i],
    });
  }

  return {
    source: 'Open-Meteo',
    fetchedAt: new Date().toISOString(),
    timezone: raw.timezone,
    utcOffsetSeconds: raw.utc_offset_seconds,
    current: {
      time: c.time,
      temperature: c.temperature_2m,
      apparentTemperature: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      isDay: c.is_day,
      precipitation: c.precipitation,
      rain: (c.rain || 0) + (c.showers || 0),
      snowfall: c.snowfall,
      weatherCode: c.weather_code,
      cloudCover: c.cloud_cover,
      pressure: c.pressure_msl,
      windSpeed: c.wind_speed_10m,
      windDirection: c.wind_direction_10m,
      windGust: c.wind_gusts_10m,
      visibility: nearestHourly(hourly, c.time)?.visibility,
    },
    hourly,
    daily: {
      sunrise: raw.daily?.sunrise || [],
      sunset: raw.daily?.sunset || [],
      tempMax: raw.daily?.temperature_2m_max || [],
      tempMin: raw.daily?.temperature_2m_min || [],
    },
  };
}

function nearestHourly(hourly, isoTime) {
  if (!isoTime) return null;
  const hour = isoTime.slice(0, 13);
  return hourly.find((h) => h.time.slice(0, 13) === hour) || null;
}

/**
 * Local wall-clock stamp at the modelled place, as 'YYYY-MM-DDTHH:mm'.
 * Open-Meteo returns local times when timezone=auto, so we shift the UTC
 * instant by the location's offset and then read the UTC fields.
 */
export function localStamp(instantMs, utcOffsetSeconds) {
  const d = new Date(instantMs + utcOffsetSeconds * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/** The hourly record covering a given UTC instant at the modelled place. */
export function hourlyAt(weather, instantMs) {
  if (!weather?.hourly?.length) return null;
  const stamp = localStamp(instantMs, weather.utcOffsetSeconds || 0).slice(0, 13);
  return weather.hourly.find((h) => h.time.slice(0, 13) === stamp) || null;
}

/* ------------------------------------------------------------------ */
/* WMO weather codes                                                   */
/* ------------------------------------------------------------------ */

const WMO = {
  0: ['Clear sky', 'clear'],
  1: ['Mainly clear', 'clear'],
  2: ['Partly cloudy', 'cloudy'],
  3: ['Overcast', 'overcast'],
  45: ['Fog', 'fog'],
  48: ['Depositing rime fog', 'fog'],
  51: ['Light drizzle', 'drizzle'],
  53: ['Drizzle', 'drizzle'],
  55: ['Dense drizzle', 'drizzle'],
  56: ['Light freezing drizzle', 'drizzle'],
  57: ['Freezing drizzle', 'drizzle'],
  61: ['Slight rain', 'rain'],
  63: ['Rain', 'rain'],
  65: ['Heavy rain', 'rain'],
  66: ['Light freezing rain', 'rain'],
  67: ['Freezing rain', 'rain'],
  71: ['Slight snow', 'snow'],
  73: ['Snow', 'snow'],
  75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'],
  80: ['Slight rain showers', 'rain'],
  81: ['Rain showers', 'rain'],
  82: ['Violent rain showers', 'rain'],
  85: ['Snow showers', 'snow'],
  86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'thunder'],
  96: ['Thunderstorm with hail', 'thunder'],
  99: ['Thunderstorm with heavy hail', 'thunder'],
};

export function describeWeather(code) {
  const entry = WMO[code] || ['Unknown', 'clear'];
  return { text: entry[0], kind: entry[1] };
}

/* ------------------------------------------------------------------ */
/* Google Street View                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ask Google whether a panorama exists near a point. Metadata requests are
 * free and tell us the real pano location, so the cube can be centred on the
 * camera position rather than the address centroid.
 */
export async function streetViewMetadata(lat, lon, key, radius = 60) {
  const url =
    `${GOOGLE_SV}/metadata?` +
    new URLSearchParams({
      location: `${lat},${lon}`,
      radius: String(radius),
      source: 'outdoor',
      key,
    });
  const meta = await getJSON(url);
  if (meta.status !== 'OK') {
    const err = new Error(
      meta.status === 'ZERO_RESULTS'
        ? `No Street View imagery within ${radius} m of that point.`
        : `Street View: ${meta.status}${meta.error_message ? ` — ${meta.error_message}` : ''}`
    );
    err.status = meta.status;
    throw err;
  }
  return {
    panoId: meta.pano_id,
    lat: meta.location.lat,
    lon: meta.location.lng,
    date: meta.date,
    copyright: meta.copyright,
  };
}

export function streetViewImageURL({ panoId, lat, lon, heading, pitch, size, key, fov = 90 }) {
  const params = new URLSearchParams({
    size: `${size}x${size}`,
    fov: String(fov),
    heading: String(((heading % 360) + 360) % 360),
    pitch: String(pitch),
    key,
    return_error_code: 'true',
  });
  if (panoId) params.set('pano', panoId);
  else params.set('location', `${lat},${lon}`);
  return `${GOOGLE_SV}?${params}`;
}

/** Load one image with CORS enabled so it can become a WebGL texture. */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error('Image failed to load (check the API key, its referrer restrictions, and that Street View Static API is enabled).'));
    img.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* OpenStreetMap geometry (Overpass)                                   */
/* ------------------------------------------------------------------ */

/**
 * Buildings, roads, water and greenery in a square around a point.
 * @param {number} radius half-width of the square, in metres
 */
export async function fetchOSM(lat, lon, radius) {
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon]
    .map((v) => v.toFixed(6))
    .join(',');

  const query = `
    [out:json][timeout:30];
    (
      way["building"](${bbox});
      relation["building"](${bbox});
      way["highway"](${bbox});
      way["natural"="water"](${bbox});
      way["waterway"](${bbox});
      way["leisure"~"park|garden|pitch"](${bbox});
      way["landuse"~"grass|forest|village_green"](${bbox});
      node["natural"="tree"](${bbox});
    );
    out body geom;
  `;

  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${res.status} from ${endpoint}`);
      return parseOSM(await res.json());
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass unreachable');
}

function parseOSM(json) {
  const buildings = [];
  const roads = [];
  const green = [];
  const water = [];
  const trees = [];

  const toRing = (geom) => geom.map((p) => ({ lat: p.lat, lon: p.lon }));

  for (const el of json.elements || []) {
    const tags = el.tags || {};

    if (el.type === 'node') {
      if (tags.natural === 'tree') trees.push({ lat: el.lat, lon: el.lon });
      continue;
    }

    // A multipolygon building is one relation with several outer rings. Joining
    // them into a single ring, as a naive flatMap would, produces nonsense
    // shapes, so each outer way becomes a building in its own right.
    if (el.type === 'relation') {
      if (!tags.building) continue;
      for (const member of el.members || []) {
        if (member.role !== 'outer' || !member.geometry || member.geometry.length < 4) continue;
        buildings.push(describeBuilding(toRing(member.geometry), tags));
      }
      continue;
    }

    const geom = el.geometry;
    if (!geom || geom.length < 2) continue;
    const ring = toRing(geom);

    if (tags.building) {
      buildings.push(describeBuilding(ring, tags));
    } else if (tags.highway) {
      roads.push({ ring, width: roadWidth(tags), kind: tags.highway });
    } else if (tags.natural === 'water' || tags.waterway) {
      water.push({ ring });
    } else if (tags.leisure || tags.landuse) {
      green.push({ ring });
    }
    // Anything else here is a member way pulled in by a relation; it has no
    // tags of its own and belongs to the relation, not to the ground.
  }
  return { buildings, roads, green, water, trees };
}

function describeBuilding(ring, tags) {
  return {
    ring,
    height: buildingHeight(tags),
    name: tags.name,
    levels: parseFloat(tags['building:levels']) || null,
    roofColour: tags['roof:colour'],
    colour: tags['building:colour'],
  };
}

function buildingHeight(tags) {
  const explicit = parseFloat(tags.height || tags['building:height']);
  if (!Number.isNaN(explicit) && explicit > 0) return explicit;
  const levels = parseFloat(tags['building:levels']);
  if (!Number.isNaN(levels) && levels > 0) return levels * 3.2 + 1.2;
  // Unmapped heights: a European city block is typically four to six storeys.
  return 15;
}

function roadWidth(tags) {
  const explicit = parseFloat(tags.width);
  if (!Number.isNaN(explicit) && explicit > 0) return explicit;
  switch (tags.highway) {
    case 'motorway':
    case 'trunk':
    case 'primary':
      return 12;
    case 'secondary':
      return 10;
    case 'tertiary':
      return 8;
    case 'residential':
    case 'unclassified':
      return 7;
    case 'service':
      return 4;
    case 'pedestrian':
    case 'living_street':
      return 6;
    case 'footway':
    case 'path':
    case 'steps':
      return 2.2;
    default:
      return 5;
  }
}

/** Local metre-space projection centred on (lat0, lon0). +X east, -Z north. */
export function projector(lat0, lon0) {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * Math.PI / 180);
  const mPerDegLon = 111412.84 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lon) => ({
    x: (lon - lon0) * mPerDegLon,
    z: -(lat - lat0) * mPerDegLat,
  });
}
