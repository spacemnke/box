// Measuring the block from Google's photogrammetry.
//
// The mesh is unreliable to look at — edges melt, cars fuse into the asphalt —
// but it is an excellent instrument. Fire rays down inside each OpenStreetMap
// footprint and it will tell you the true height of the building and the shape
// of its roof. Those numbers, not the mesh, are what gets built.
//
// This module emits plain data and draws nothing.

import * as THREE from 'three';
import { HALF } from './cube.js';
import { GROUND_TOP } from './slabs.js';

/** Metres of inset from the footprint edge before sampling. */
const EDGE_INSET_M = 1.5;
const SAMPLE_SPACING_M = 1.5;
const MAX_SAMPLES = 60;
const MIN_SAMPLES = 6;
/** Below this, a hit is ground showing through rather than a roof. */
const MIN_BUILDING_M = 2.5;
/** Above this spread, the footprint is enclosing something it should not. */
const MAX_IQR_M = 8;
const HISTOGRAM_BIN_M = 0.5;
/** Time slice per frame, so measuring never stalls the render. */
const FRAME_BUDGET_MS = 6;

/* ------------------------------------------------------------------ */
/* Polygon helpers                                                     */
/* ------------------------------------------------------------------ */

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Push every edge inward by `d` and re-intersect neighbours. Good enough for
 * building footprints, which are mostly convex or gently concave; the caller
 * checks the result still has sensible area and falls back if not.
 */
function insetPolygon(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  const wind = signedArea(pts) > 0 ? 1 : -1;
  const out = [];

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];

    // Inward normals of the two edges meeting at this vertex.
    const e1 = new THREE.Vector2(cur.x - prev.x, cur.y - prev.y).normalize();
    const e2 = new THREE.Vector2(next.x - cur.x, next.y - cur.y).normalize();
    const n1 = new THREE.Vector2(-e1.y, e1.x).multiplyScalar(wind);
    const n2 = new THREE.Vector2(-e2.y, e2.x).multiplyScalar(wind);

    // Offset both edges by d and intersect them.
    const bisector = n1.clone().add(n2);
    if (bisector.lengthSq() < 1e-9) continue; // a spike; drop the vertex
    bisector.normalize();
    const cosHalf = bisector.dot(n1);
    if (Math.abs(cosHalf) < 0.15) continue; // near-reflex, would shoot off
    out.push(new THREE.Vector2(cur.x + (bisector.x * d) / cosHalf, cur.y + (bisector.y * d) / cosHalf));
  }

  if (out.length < 3) return null;
  // An inset that flipped or nearly vanished is not usable.
  const before = Math.abs(signedArea(pts));
  const after = Math.abs(signedArea(out));
  if (signedArea(out) * signedArea(pts) < 0 || after < before * 0.06) return null;
  return out;
}

function bounds(pts) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
}

function centroid(pts) {
  const c = new THREE.Vector2();
  for (const p of pts) c.add(p);
  return c.divideScalar(pts.length);
}

/** The dominant edge direction — how the building actually sits, which for a
 *  city block is rarely aligned with north. */
function principalAxis(pts) {
  let best = null;
  let bestLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = new THREE.Vector2(b.x - a.x, b.y - a.y).normalize();
    }
  }
  return best || new THREE.Vector2(1, 0);
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * The largest run of populated histogram bins. A mean would be dragged by
 * chimneys, aerials and lift overruns; the modal cluster is the roof.
 */
function largestCluster(values, binSize = HISTOGRAM_BIN_M) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const bins = new Map();
  for (const v of sorted) {
    const k = Math.floor(v / binSize);
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);

  let best = { count: 0, from: 0, to: 0 };
  let runStart = keys[0];
  let runCount = 0;
  for (let i = 0; i < keys.length; i++) {
    runCount += bins.get(keys[i]);
    const contiguous = i + 1 < keys.length && keys[i + 1] === keys[i] + 1;
    if (!contiguous) {
      if (runCount > best.count) best = { count: runCount, from: runStart, to: keys[i] };
      runStart = keys[i + 1];
      runCount = 0;
    }
  }
  const lo = best.from * binSize;
  const hi = (best.to + 1) * binSize;
  return sorted.filter((v) => v >= lo && v <= hi);
}

/** Least-squares fit of y = ax + bz + c over the samples. */
function fitPlane(samples) {
  let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, n = samples.length;
  let sxy = 0, szy = 0, sy = 0;
  for (const s of samples) {
    sxx += s.x * s.x; sxz += s.x * s.z; szz += s.z * s.z;
    sx += s.x; sz += s.z; sy += s.h;
    sxy += s.x * s.h; szy += s.z * s.h;
  }
  // Solve the 3x3 normal equations by Cramer's rule.
  const m = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]];
  const rhs = [sxy, szy, sy];
  const det = (M) =>
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(m);
  if (Math.abs(D) < 1e-9) return null;
  const sub = (col) => m.map((row, i) => row.map((v, j) => (j === col ? rhs[i] : v)));
  const a = det(sub(0)) / D;
  const b = det(sub(1)) / D;
  const c = det(sub(2)) / D;

  let sse = 0;
  for (const s of samples) sse += (s.h - (a * s.x + b * s.z + c)) ** 2;
  const rms = Math.sqrt(sse / n);
  // Normal of y = ax + bz + c is (-a, 1, -b).
  const tilt = Math.atan(Math.hypot(a, b));
  return { a, b, c, rms, tiltDeg: (tilt * 180) / Math.PI, azimuth: Math.atan2(-a, b) };
}

/* ------------------------------------------------------------------ */
/* Roof classification                                                 */
/* ------------------------------------------------------------------ */

/**
 * Conservative on purpose: anything not clearly shaped is called flat. A
 * wrong pitched roof looks far worse than a right flat one.
 */
function classifyRoof(samples, ring, eaveHeight, ridgeHeight) {
  const plane = fitPlane(samples);
  const spread = ridgeHeight - eaveHeight;

  if (!plane) return { kind: 'flat', pitch: 0, azimuth: 0, parapetHeight: 0 };

  // --- dome: height falls away from the centre in every direction ---------
  const c = centroid(ring);
  let maxR = 0;
  for (const p of ring) maxR = Math.max(maxR, Math.hypot(p.x - c.x, p.y - c.y));
  if (maxR > 1 && spread > 1.5) {
    let inner = [];
    let outer = [];
    for (const s of samples) {
      const r = Math.hypot(s.x - c.x, s.z - c.y) / maxR;
      if (r < 0.35) inner.push(s.h);
      else if (r > 0.7) outer.push(s.h);
    }
    if (inner.length >= 3 && outer.length >= 3) {
      const innerMed = percentile(inner.sort((p, q) => p - q), 0.5);
      const outerMed = percentile(outer.sort((p, q) => p - q), 0.5);
      // A dome rises steeply at the centre and is radially symmetric, which a
      // gable is not — a gable's outer ring is high along the ridge line.
      const rise = innerMed - outerMed;
      if (rise > spread * 0.55 && plane.tiltDeg < 12) {
        return { kind: 'dome', pitch: 0, azimuth: 0, parapetHeight: 0, riseM: rise };
      }
    }
  }

  // --- shed: one clean tilted plane ---------------------------------------
  if (plane.tiltDeg > 8 && plane.rms < 0.8) {
    return { kind: 'shed', pitch: plane.tiltDeg, azimuth: plane.azimuth, parapetHeight: 0 };
  }

  // --- gable: a tent across the building's short axis ----------------------
  if (spread > 1.5 && plane.rms > 0.7) {
    const axis = principalAxis(ring);
    const across = new THREE.Vector2(-axis.y, axis.x);
    let mid = [];
    let edges = [];
    let maxD = 0;
    for (const s of samples) {
      maxD = Math.max(maxD, Math.abs((s.x - c.x) * across.x + (s.z - c.y) * across.y));
    }
    if (maxD > 1) {
      for (const s of samples) {
        const d = Math.abs((s.x - c.x) * across.x + (s.z - c.y) * across.y) / maxD;
        if (d < 0.3) mid.push(s.h);
        else if (d > 0.7) edges.push(s.h);
      }
      if (mid.length >= 3 && edges.length >= 3) {
        const midMed = percentile(mid.sort((p, q) => p - q), 0.5);
        const edgeMed = percentile(edges.sort((p, q) => p - q), 0.5);
        if (midMed - edgeMed > spread * 0.45) {
          const halfWidth = maxD;
          return {
            kind: 'gable',
            pitch: (Math.atan2(midMed - edgeMed, halfWidth) * 180) / Math.PI,
            azimuth: Math.atan2(axis.x, -axis.y),
            parapetHeight: 0,
          };
        }
      }
    }
  }

  // --- flat, possibly with a parapet ---------------------------------------
  // A parapet reads as a ring of samples near the edge sitting above the
  // middle of the roof.
  let ringSamples = [];
  let middle = [];
  let maxR2 = 0;
  for (const p of ring) maxR2 = Math.max(maxR2, Math.hypot(p.x - c.x, p.y - c.y));
  for (const s of samples) {
    const r = maxR2 > 0 ? Math.hypot(s.x - c.x, s.z - c.y) / maxR2 : 0;
    if (r > 0.75) ringSamples.push(s.h);
    else if (r < 0.5) middle.push(s.h);
  }
  let parapetHeight = 0;
  if (ringSamples.length >= 3 && middle.length >= 3) {
    const rimMed = percentile(ringSamples.sort((p, q) => p - q), 0.5);
    const midMed = percentile(middle.sort((p, q) => p - q), 0.5);
    const lift = rimMed - midMed;
    if (lift > 0.4 && lift < 1.5) parapetHeight = lift;
  }
  return { kind: 'flat', pitch: 0, azimuth: 0, parapetHeight };
}

/* ------------------------------------------------------------------ */
/* Measuring                                                           */
/* ------------------------------------------------------------------ */

/**
 * Measure one footprint against the mesh.
 * @param {THREE.Vector2[]} ring  footprint in world XZ (x, y=z), cube units
 * @param {number} streetY  world y of street level; not GROUND_TOP, because
 *   the tiles sit a hair above the ground slab and that gap is 30 cm of real
 *   world at cube scale
 * @returns {object|null} metrics in metres above street, or null to refuse
 */
export function measureFootprint(ring, target, raycaster, metresPerUnit, streetY = GROUND_TOP) {
  const perUnit = metresPerUnit;
  const insetUnits = EDGE_INSET_M / perUnit;
  const inner = insetPolygon(ring, insetUnits) || ring;
  const usedFallback = inner === ring;

  const bb = bounds(inner);
  const step = SAMPLE_SPACING_M / perUnit;
  const points = [];
  for (let x = bb.minX + step * 0.5; x <= bb.maxX; x += step) {
    for (let y = bb.minY + step * 0.5; y <= bb.maxY; y += step) {
      const jx = x + (Math.random() - 0.5) * step * 0.6;
      const jy = y + (Math.random() - 0.5) * step * 0.6;
      if (pointInPolygon(jx, jy, inner)) points.push([jx, jy]);
    }
  }
  if (!points.length) {
    const c = centroid(inner);
    points.push([c.x, c.y]);
  }
  // Thin evenly rather than truncating, so big buildings stay evenly covered.
  const stride = Math.max(1, Math.ceil(points.length / MAX_SAMPLES));
  const chosen = points.filter((_, i) => i % stride === 0);

  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  const samples = [];
  for (const [x, z] of chosen) {
    origin.set(x, HALF * 3, z);
    raycaster.set(origin, down);
    const hit = raycaster.intersectObject(target, true)[0];
    if (!hit) continue;
    const h = (hit.point.y - streetY) * perUnit;
    if (h < MIN_BUILDING_M) continue;
    samples.push({ x, z, h, ny: hit.face ? hit.face.normal.y : 1 });
  }

  if (samples.length < MIN_SAMPLES && !usedFallback) return null;
  if (!samples.length) return null;

  const heights = samples.map((s) => s.h).sort((a, b) => a - b);
  const iqr = percentile(heights, 0.75) - percentile(heights, 0.25);
  if (iqr > MAX_IQR_M) return null;

  const cluster = largestCluster(samples.map((s) => s.h));
  if (!cluster.length) return null;
  const eaveHeight = percentile(cluster, 0.25);
  const ridgeHeight = percentile(cluster, 0.9);
  if (eaveHeight < MIN_BUILDING_M) return null;

  const clusterSamples = samples.filter((s) => s.h >= cluster[0] && s.h <= cluster[cluster.length - 1]);
  const roof = classifyRoof(clusterSamples.length >= MIN_SAMPLES ? clusterSamples : samples, ring, eaveHeight, ridgeHeight);

  // Confidence: enough samples, and they agree with each other.
  const coverage = Math.min(1, samples.length / MIN_SAMPLES / 2);
  const agreement = Math.max(0, 1 - iqr / MAX_IQR_M);
  return {
    eaveHeight,
    ridgeHeight,
    roof,
    sampleCount: samples.length,
    iqr,
    confidence: +(coverage * 0.4 + agreement * 0.6).toFixed(3),
    source: 'measured',
  };
}

/**
 * Measure every footprint, yielding to the renderer between time slices so the
 * frame never stalls.
 *
 * @param {object[]} buildings  from fetchOSM, with rings already projected
 * @param {THREE.Object3D} target  the loaded tiles group
 * @param {number} metresPerUnit
 * @param {number} streetY  world y of street level, from Photoreal.streetY
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function measureBlock(buildings, target, metresPerUnit, streetY, onProgress) {
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true; // honoured when a BVH is present
  target.updateMatrixWorld(true);

  const out = [];
  let slice = performance.now();
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    let metrics = null;
    try {
      metrics = measureFootprint(b.ring2d, target, raycaster, metresPerUnit, streetY);
    } catch {
      metrics = null; // a degenerate footprint must not stop the block
    }
    out.push(metrics ? { ...b, ...metrics } : { ...b, source: 'unmeasured', confidence: 0 });

    if (performance.now() - slice > FRAME_BUDGET_MS) {
      onProgress?.(i + 1, buildings.length);
      await new Promise((r) => requestAnimationFrame(r));
      slice = performance.now();
    }
  }
  onProgress?.(buildings.length, buildings.length);
  return out;
}

export const _internals = {
  insetPolygon,
  pointInPolygon,
  largestCluster,
  fitPlane,
  classifyRoof,
  percentile,
  principalAxis,
};
