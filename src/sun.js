// Solar and lunar position (NOAA-style algorithm, accurate to ~1 arcminute for
// the sun, which is far more than a diorama needs).
// All angles in radians unless a name says otherwise.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function julianDay(date) {
  return date.valueOf() / 86400000 - 0.5 + 2440588;
}

function julianCentury(date) {
  return (julianDay(date) - 2451545) / 36525;
}

/**
 * Sun position for a moment and place.
 * @returns {{azimuth:number, altitude:number, declination:number}}
 *   azimuth measured clockwise from north (0 = N, PI/2 = E), altitude above horizon.
 */
export function sunPosition(date, latDeg, lonDeg) {
  const t = julianCentury(date);

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const sunEqCtr =
    Math.sin(meanAnom * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * RAD) * 0.000289;

  const trueLong = meanLong + sunEqCtr;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * RAD);

  const declination = Math.asin(
    Math.sin(obliqCorr * RAD) * Math.sin(appLong * RAD)
  );
  const rightAsc = Math.atan2(
    Math.cos(obliqCorr * RAD) * Math.sin(appLong * RAD),
    Math.cos(appLong * RAD)
  );

  // Equation of time (minutes)
  const varY = Math.tan((obliqCorr / 2) * RAD) ** 2;
  const eqTime =
    4 *
    DEG *
    (varY * Math.sin(2 * meanLong * RAD) -
      2 * eccent * Math.sin(meanAnom * RAD) +
      4 * eccent * varY * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD) -
      0.5 * varY * varY * Math.sin(4 * meanLong * RAD) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * RAD));

  // Minutes past local (UTC) midnight
  const minutesUTC =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (minutesUTC + eqTime + 4 * lonDeg + 1440) % 1440;
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const lat = latDeg * RAD;
  const ha = hourAngle * RAD;
  const altitude = Math.asin(
    Math.sin(lat) * Math.sin(declination) +
      Math.cos(lat) * Math.cos(declination) * Math.cos(ha)
  );
  // Azimuth clockwise from north.
  const azimuth =
    Math.atan2(
      Math.sin(ha),
      Math.cos(ha) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)
    ) + Math.PI;

  return { azimuth, altitude, declination, rightAscension: rightAsc };
}

/** Rough moon position — good enough to place a moon disc in the night sky. */
export function moonPosition(date, latDeg, lonDeg) {
  const d = julianDay(date) - 2451545;
  const L = (218.316 + 13.176396 * d) * RAD; // ecliptic longitude
  const M = (134.963 + 13.064993 * d) * RAD; // mean anomaly
  const F = (93.272 + 13.229350 * d) * RAD; // mean distance

  const lon = L + 6.289 * RAD * Math.sin(M);
  const lat = 5.128 * RAD * Math.sin(F);
  const e = 23.4397 * RAD;

  const ra = Math.atan2(
    Math.sin(lon) * Math.cos(e) - Math.tan(lat) * Math.sin(e),
    Math.cos(lon)
  );
  const dec = Math.asin(
    Math.sin(lat) * Math.cos(e) + Math.cos(lat) * Math.sin(e) * Math.sin(lon)
  );

  const days = julianDay(date) - 2451545;
  const gmst = (280.16 + 360.9856235 * days) * RAD;
  const H = gmst - lonDeg * -RAD - ra; // sidereal - longitude - RA
  const phi = latDeg * RAD;

  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  );
  const azimuth =
    Math.atan2(
      Math.sin(H),
      Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)
    ) + Math.PI;

  // Illuminated fraction (phase), 0 = new, 1 = full.
  const sun = sunPosition(date, latDeg, lonDeg);
  const elong = Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        Math.sin(sun.declination) * Math.sin(dec) +
          Math.cos(sun.declination) * Math.cos(dec) * Math.cos(sun.rightAscension - ra)
      )
    )
  );
  const phase = (1 - Math.cos(elong)) / 2;

  return { azimuth, altitude, phase };
}

/**
 * Turn an azimuth/altitude pair into a world-space direction.
 * World convention used everywhere in this app: -Z is north, +X is east, +Y is up.
 */
export function toWorldDirection(azimuth, altitude) {
  const cosAlt = Math.cos(altitude);
  return {
    x: cosAlt * Math.sin(azimuth),
    y: Math.sin(altitude),
    z: -cosAlt * Math.cos(azimuth),
  };
}
