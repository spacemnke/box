// Turns a weather reading plus a sun position into the numbers the renderer
// actually needs. Everything visual downstream reads from this one object, so
// "what the sky looks like" and "what the rain does" can never disagree.

import * as THREE from 'three';
import { describeWeather } from './data.js';
import { sunPosition, moonPosition, toWorldDirection } from './sun.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

function mixColor(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), clamp(t, 0, 1));
}

/** 1 when x is at or past `full`, 0 at or before `none`, eased in between. */
function smootherstep(x, none, full) {
  const t = clamp((x - none) / (full - none), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * @param {object} reading  { temperature, cloudCover, precipitation, rain,
 *                            snowfall, snowDepth, weatherCode, visibility,
 *                            windSpeed, windDirection, humidity }
 * @param {Date}   date     the moment being simulated (local wall clock)
 * @param {number} lat
 * @param {number} lon
 */
export function buildClimate(reading, date, lat, lon) {
  const sun = sunPosition(date, lat, lon);
  const moon = moonPosition(date, lat, lon);
  const sunDir = toWorldDirection(sun.azimuth, sun.altitude);
  const moonDir = toWorldDirection(moon.azimuth, moon.altitude);

  const alt = sun.altitude; // radians
  const altDeg = (alt * 180) / Math.PI;

  const { text: conditionText, kind } = describeWeather(reading.weatherCode ?? 0);

  const cloudCover = clamp((reading.cloudCover ?? 0) / 100, 0, 1);
  const precip = Math.max(reading.precipitation ?? 0, reading.rain ?? 0);
  const snowfall = reading.snowfall ?? 0;
  const temperature = reading.temperature ?? 12;
  const humidity = clamp((reading.humidity ?? 60) / 100, 0, 1);
  const windSpeed = reading.windSpeed ?? 0; // m/s
  const windDirDeg = reading.windDirection ?? 0; // direction wind comes FROM

  // ---- night factor -------------------------------------------------------
  // Twilight is long and bright: the street is still readable at civil dusk
  // (-6 deg) and only properly dark by nautical dusk (-12 to -16 deg).
  const night = smootherstep(altDeg, 2, -16);
  const lightLevel = 1 - night;
  const goldenHour = clamp(1 - Math.abs(altDeg - 4) / 10, 0, 1);
  const dayFactor = clamp((altDeg + 6) / 12, 0, 1);

  // ---- precipitation intensities -----------------------------------------
  const isSnowing = snowfall > 0.005 || (kind === 'snow' && precip > 0);
  const isRaining = !isSnowing && (precip > 0.02 || kind === 'rain' || kind === 'drizzle' || kind === 'thunder');

  // mm/h -> 0..1 intensity, with drizzle still visible.
  const rainRate = isRaining ? clamp(0.18 + precip / 6, 0.12, 1) * (kind === 'drizzle' ? 0.55 : 1) : 0;
  const snowRate = isSnowing ? clamp(0.25 + snowfall / 2.2, 0.15, 1) : 0;
  const thunder = kind === 'thunder';

  // Wetness lingers a little after the rain stops, and high humidity keeps
  // stone dark. Snow melt also leaves the street wet.
  const wetness = clamp(
    Math.max(rainRate * 1.25, precip > 0 ? 0.55 : 0) +
      (humidity > 0.9 ? 0.15 : 0) +
      (kind === 'fog' ? 0.25 : 0),
    0,
    1
  );

  // Lying snow: prefer the measured depth, fall back to accumulation guess.
  const measuredDepth = reading.snowDepth ?? null;
  let snowCover = 0;
  if (measuredDepth != null && measuredDepth > 0) {
    snowCover = clamp(measuredDepth / 0.08, 0, 1);
  } else if (isSnowing && temperature <= 1.5) {
    snowCover = clamp(snowRate * 0.7, 0, 0.85);
  }
  if (temperature > 4) snowCover *= clamp(1 - (temperature - 4) / 4, 0, 1);

  // ---- visibility / fog ---------------------------------------------------
  // Visibility is reported in metres, but the cube only spans ~150 m. Fog has
  // to be converted to an extinction coefficient before it is applied, or a
  // perfectly ordinary rainy day whites the whole model out.
  const visibility = reading.visibility ?? (kind === 'fog' ? 300 : 20000); // metres
  // Koschmieder: visibility is where contrast falls to 2%, so k = 3.912 / V.
  const fogPerMetre = 3.912 / Math.max(visibility, 30);

  // How washed out the *sky* looks — an aesthetic term, not an optical one,
  // because the sky is kilometres deep even when the street is clear.
  let haze = clamp(1 - visibility / 9000, 0, 1);
  if (kind === 'fog') haze = Math.max(haze, 0.7);
  haze = Math.max(haze, rainRate * 0.18, snowRate * 0.32);

  // Ground fog only really shows below about 1.5 km of visibility.
  const groundFog = clamp((1600 - visibility) / 1500, 0, 1);

  // Attenuation across a typical street-width of photographed depth.
  const photoFog = 1 - Math.exp(-fogPerMetre * 45);

  // ---- colour grading -----------------------------------------------------
  const sunHorizonColor = new THREE.Color('#ff9a4d');
  const sunHighColor = new THREE.Color('#fff4e0');
  let sunColor = mixColor(sunHorizonColor, sunHighColor, clamp((altDeg + 2) / 22, 0, 1));
  if (cloudCover > 0.5) sunColor = mixColor(sunColor, new THREE.Color('#c9d2dc'), (cloudCover - 0.5) * 1.4);

  // Sky gradient endpoints move through night -> twilight -> day.
  const zenithNight = new THREE.Color('#050a18');
  const zenithTwilight = new THREE.Color('#1d3a6b');
  const zenithDay = new THREE.Color('#3f79d6');
  const horizonNight = new THREE.Color('#0b1428');
  const horizonTwilight = new THREE.Color('#e2764a');
  const horizonDay = new THREE.Color('#b9d3ef');

  const twilight = clamp(1 - Math.abs(altDeg) / 9, 0, 1);
  let zenith = mixColor(zenithNight, zenithDay, dayFactor);
  zenith = mixColor(zenith, zenithTwilight, twilight * 0.8);
  let horizon = mixColor(horizonNight, horizonDay, dayFactor);
  horizon = mixColor(horizon, horizonTwilight, twilight * 0.85);

  // Overcast pulls everything to flat grey.
  const overcastGrey = new THREE.Color('#8f98a4');
  zenith = mixColor(zenith, overcastGrey.clone().multiplyScalar(lerp(0.10, 0.85, dayFactor)), cloudCover * 0.75);
  horizon = mixColor(horizon, overcastGrey.clone().multiplyScalar(lerp(0.12, 0.95, dayFactor)), cloudCover * 0.6);

  // Storms go darker and greener-grey still.
  const stormAmount = thunder ? 0.85 : clamp(rainRate * 0.8, 0, 0.7);
  zenith = mixColor(zenith, new THREE.Color('#2b3138'), stormAmount * 0.6 * dayFactor);
  horizon = mixColor(horizon, new THREE.Color('#535a61'), stormAmount * 0.5 * dayFactor);

  const groundHaze = mixColor(horizon, new THREE.Color('#2a2f36'), 0.45);

  // Fog colour tracks the sky it sits under.
  const fogColor = mixColor(horizon, new THREE.Color('#c7ccd2'), 0.35 * dayFactor);

  // ---- light --------------------------------------------------------------
  // A diorama has to stay readable, so the night floor is lifted well above
  // physical darkness and overcast keeps a strong sky-light term.
  // A low sun still rakes hard across a street, so the curve keeps a strong
  // floor as soon as the disc clears the horizon rather than fading to nothing.
  const sunIntensity =
    (altDeg <= 0 ? 0 : 0.35 + 1.9 * Math.sqrt(Math.sin(alt))) *
    lerp(1, 0.25, cloudCover) *
    lerp(1, 0.55, haze);
  const ambientIntensity =
    lerp(0.45, 1.0, lightLevel) * lerp(1, 1.5, cloudCover) * lerp(1, 0.85, stormAmount);
  const exposure = lerp(1.20, 1.0, lightLevel) * lerp(1, 0.88, stormAmount) * lerp(1, 1.06, snowCover);

  // Wind blows TOWARDS (direction + 180). Meteorological azimuth: 0 = from N.
  const towards = ((windDirDeg + 180) % 360) * (Math.PI / 180);
  const wind = new THREE.Vector2(Math.sin(towards), -Math.cos(towards)).multiplyScalar(windSpeed);

  return {
    // raw echo, so the UI can show what drove the render
    reading,
    date,
    conditionText,
    kind,
    // sun / moon
    sunDir: new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z).normalize(),
    moonDir: new THREE.Vector3(moonDir.x, moonDir.y, moonDir.z).normalize(),
    sunAltitude: alt,
    sunAltitudeDeg: altDeg,
    sunAzimuthDeg: (sun.azimuth * 180) / Math.PI,
    moonPhase: moon.phase,
    // atmosphere
    night,
    lightLevel,
    dayFactor,
    goldenHour,
    cloudCover,
    cloudDark: stormAmount,
    haze,
    fogPerMetre,
    groundFog,
    photoFog,
    visibility,
    fogColor,
    zenith,
    horizon,
    groundHaze,
    sunColor,
    exposure,
    sunIntensity,
    ambientIntensity,
    // precipitation
    rainRate,
    snowRate,
    wetness,
    snowCover,
    thunder,
    // wind
    wind,
    windSpeed,
    windDirDeg,
    temperature,
    humidity,
  };
}
