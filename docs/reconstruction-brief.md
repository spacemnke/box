# Build brief: reconstructed block geometry

A specification for adding a fourth mode to Weather Cube, in which the
buildings are **generated from data rather than streamed as a mesh**.

Written for another engineer or model picking this up cold. It assumes you have
the repository and have read `README.md`. Everything here is concrete on
purpose: thresholds, units and file names are given so you can start, not so
you must obey — if a number is wrong when you see real output, change it and
say why in the commit.

---

## 0. Orient yourself first

Do not write anything until these are true in your head. Getting the frame
wrong is the single most likely way to waste a day.

**The world.** One cube, spanning `-1 … +1` on every axis. `+X` is east, `+Y`
is up, **`-Z` is north**. Defined in `src/cube.js` (`CUBE_SIZE`, `HALF`).

**The layers**, from `src/slabs.js`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `GROUND_TOP` | `-0.44` | street level; everything stands on this |
| `SKY_BOTTOM` | `0.66` nominal | underside of the cloud lid, moves with cloud cover |

**Scale is not the same in every mode**, and this trips people:

- **Block model** (`src/modelcity.js`): `MODEL_RADIUS_M = 75`, so one unit is
  75 m horizontally, but heights are multiplied by `HEIGHT_EXAGGERATION = 2`.
- **Photoreal** (`src/tiles3d.js`): one unit is 75 m on *every* axis. No
  exaggeration. Google's metres are real metres.

**The new mode must use photoreal's convention — no exaggeration.** You are
measuring real heights; distorting them afterwards makes the measurement
pointless and makes the two modes impossible to compare. If the result looks
too flat, that is information about the block, not a bug to paper over.

**Clipping.** `city.clipPlanes` is four vertical planes at the cube walls plus
one horizontal at the cloud base. Every material you create must carry it or
your geometry will hang out through the glass.

**Weather.** `src/climate.js` `buildClimate()` returns one object that
everything reads: `wetness`, `snowCover`, `night`, `sunDir`, `sunColor`,
`cloudCover`, `windSpeed`, `rainRate`, `fogPerMetre`, and so on. Never derive
weather from anything else — that is how the sky and the rain end up
disagreeing.

**Lighting is already solved. Do not rebuild it.** `src/skyenv.js` renders the
simulated sky into a prefiltered cubemap on `scene.environment`, and there is a
sun `DirectionalLight` with shadows. Use `MeshStandardMaterial` and you inherit
correct sun position, real cast shadows, sky ambient and reflections for free.

**No build step, no CDN.** Vendored dependencies only, in `vendor/`. If you
need a library, `npm pack` it and commit the build, as was done for
`3d-tiles-renderer`.

---

## 1. What to build

A mode called **Reconstructed**. It produces clean, parametric, architectural
geometry for the block around the address: sharp corners, correct heights,
real roof forms, storey-aligned window grids — lit by the existing PBR
pipeline, standing on the existing ground slab, under the existing weather.

The user's words, which are the actual specification:

> use all this data and generate live a high fidelity 3-D model based on all
> these variables so what you would actually see is not the Google maps
> rendering but a high fidelity 3-D rendering for my exact location/block

---

## 2. Why the two existing modes are not that

**Photoreal** has real geometry but it is Google's, and it is photogrammetry:
edges melt, cars fuse into the asphalt, balconies smear, trees are blobs. It is
convincing at 100 m and falls apart at 10 m.

**Block model** builds its own geometry from OpenStreetMap, which gives exact
footprints — but everything vertical is a guess. Heights fall back to 15 m when
untagged. Every roof is flat. Window grids are invented.

Neither is wrong. Each is missing what the other has.

---

## 3. The idea

**Google's mesh is unreliable to look at and excellent to measure.**

OSM gives exact building outlines as vectors. Google's mesh gives real
elevations. Fire rays down onto the mesh inside each OSM footprint, read off
the true roof height and shape, then **discard the mesh** and build clean
geometry from those numbers.

Photogrammetry as an instrument, not as a picture.

Two stages, and keep them genuinely separate — measurement is testable in
isolation and reconstruction is much easier to iterate on when it takes plain
numbers as input:

```
OSM footprints ─┐
                ├─► measure ─► BuildingMetrics[] ─► reconstruct ─► geometry
Google tiles ───┘             (plain JSON)
```

---

## 4. Stage one — measure

New file: `src/measure.js`. Depends on a loaded `Photoreal` instance and the
parsed OSM result. Emits plain data; imports nothing that draws.

### 4.1 Preparation

Raycasting a photogrammetry mesh without acceleration will stall the tab.
`TilesRenderer` exposes `accelerateRaycast`; confirm it is on, and vendor
`three-mesh-bvh` if it turns out to be required. Verify with a stopwatch before
you trust it — 1,000 unaccelerated rays against a few hundred thousand
triangles is seconds, not milliseconds.

Measure only once the tiles have settled. `Photoreal` already exposes
`groundLocked`, which is the right signal: before it, street level is still
moving and every height you take will be wrong.

### 4.2 Sampling a footprint

For each OSM building polygon, projected into world XZ:

1. **Inset the polygon by 1.5 m.** Photogrammetry smears building edges out
   into the street; samples near the boundary are the least trustworthy part of
   the mesh. If the inset collapses the polygon, the building is tiny — take
   the centroid alone and flag it low-confidence.
2. **Jittered grid at 1.5 m spacing** inside the inset polygon, capped at ~60
   samples for large buildings. Jitter matters: a regular grid can land
   entirely between roof ribs and read a systematic bias.
3. **Cast each ray downward** from above the cube. Record the first hit's `y`.
   Keep the hit normal too — you need it for roof classification.
4. Convert to **metres above street**: `(hit.y - GROUND_TOP) * MODEL_RADIUS_M`.

### 4.3 Extracting a height

Do not take the mean. Chimneys, aerials, lift overruns and overhanging trees
all sit in the tail and will drag it.

- Discard samples below 2 m — those are holes in the mesh, or ground showing
  through a courtyard the footprint wrongly encloses.
- Build a histogram at 0.5 m bins. Find the **largest cluster** above 2 m.
- `eaveHeight` = 25th percentile of that cluster.
- `ridgeHeight` = 90th percentile.
- A building where those two differ by more than ~1.5 m has a shaped roof.

Record `sampleCount` and the interquartile range as a **confidence** measure.
You will need it: low confidence should fall back rather than fabricate.

### 4.4 Classifying the roof

From the same samples, fit a least-squares plane. Then, in order:

| Test | Verdict |
| --- | --- |
| tilt < 5°, RMS residual < 0.6 m | **flat** |
| tilt < 5°, edge ring higher than centre by 0.4–1.5 m | **flat with parapet** |
| tilt > 8°, RMS residual < 0.8 m | **shed** — pitch and azimuth from the plane |
| large RMS, symmetric about a line | **gable or hip** |
| height falls monotonically with radius from centroid | **dome** |

For gables, take the ridge azimuth from the footprint's principal axis (the
dominant edge direction, not the bounding box — city blocks are rarely axis
aligned), then verify: sample perpendicular to it and check the profile is a
tent rather than noise. If it is not, downgrade to flat. **A wrong pitched roof
looks far worse than a right flat one.**

The dome test exists because there is a blue-tiled church dome a few doors from
the test address. If the classifier cannot see it, it is not finished.

Emit, per building:

```js
{
  id, ring,                 // the OSM footprint, unchanged
  eaveHeight, ridgeHeight,  // metres above street
  roof: { kind, pitch, azimuth, parapetHeight },
  storeys,                  // OSM building:levels, else round(eaveHeight / 3.2)
  facadeColor,              // see below
  confidence,               // 0..1
  source: 'measured' | 'osm-tag' | 'assumed',
}
```

That `source` field is not decoration. It is what lets the UI be honest about
which buildings are known and which are guessed, and you should surface it.

### 4.5 Façade colour

Raycast horizontally into each façade from outside, at a third and two thirds
of eave height. The intersection carries `uv` and the hit material's `map`;
draw each texture to a small canvas **once, cached by texture UUID**, and read
the texels.

Then de-light the samples in JS using the same logic as the shader in
`src/tiles3d.js` (`delight()`) so the colour you store is albedo, not albedo
plus whatever the sun was doing that afternoon. Take the **median** of the
samples per façade — a mean gets dragged by a single dark window.

If sampling fails, fall back to the palette in `modelcity.js`, and set
`source: 'assumed'`.

### 4.6 When to refuse

Return `null` for a building and let the caller fall back to the OSM extrusion
if: fewer than six valid samples, height under 2.5 m, or interquartile range
over 8 m (usually a footprint that wrongly encloses a courtyard, or a tree
canopy over a low building).

**Refusing is a feature.** A building that opts out and gets a plain extrusion
is invisible; a confidently wrong 40 m tower where a two-storey shop stands is
the thing that destroys trust in the whole model.

---

## 5. Stage two — reconstruct

New file: `src/reconstruct.js`. Takes `BuildingMetrics[]`, returns a
`THREE.Group`. Knows nothing about tiles or rays.

### 5.1 Walls

Extrude the footprint from `GROUND_TOP` to eave height. **Do not use
`ExtrudeGeometry`** — you need control of the UVs. Build the side walls
manually so that `u` runs along the wall in metres and `v` runs up in metres.
Every façade feature downstream depends on UVs being in real metres.

Keep the winding consistent (`ShapeUtils.area` guards this in
`modelcity.js` — reuse that approach) and compute flat normals for walls,
smooth only where you intend a curve.

### 5.2 Roofs

- **flat** — cap the polygon. Triangulate with `ShapeUtils.triangulateShape`.
- **parapet** — a thin extruded ring inset ~0.3 m, standing `parapetHeight`
  above the cap. Cheap, and it is most of what makes a flat roof read as a
  building rather than a box.
- **shed** — cap tilted to the fitted plane.
- **gable / hip** — a straight skeleton is the correct general solution.
  A simpler ridge-and-slope construction is acceptable for convex-ish
  footprints; detect concavity and downgrade to flat rather than emitting a
  self-intersecting mess.
- **dome** — a scaled hemisphere on the footprint's inscribed circle,
  with the eave height as its base.

### 5.3 The details that carry it

These matter more than the roof classifier. In order of value per line of code:

1. **A cornice at eave height** — a 0.4 m band projecting 0.25 m, all the way
   round. One extruded ring per building. It is the single strongest cue that
   something is architecture and not a mass.
2. **Window reveals** — the openings must be *recessed*, not painted on. Even
   0.15 m of depth catches the sun and self-shadows.
3. **A distinct ground floor** — taller than the others (~4.2 m), different
   material, larger openings. Real streets read as shops below and homes above.
4. **String courses** between storeys where `building:levels` is tagged.

### 5.4 The façade material

New file: `src/facade.js`. A `MeshStandardMaterial` patched via
`onBeforeCompile`, following the pattern already used in `modelcity.js` and
`tiles3d.js`.

Drive it from **real metres** off the UVs, and from measured storey counts:

- floor height = eave height / storeys
- bay width from OSM if tagged, else 2.6 m
- window opening ~55% of the bay, ~60% of the floor height
- ground floor treated separately

Weather comes from the same climate uniforms everything else uses: wetness
lowers roughness, snow covers up-facing surfaces, night lights a random but
*stable* subset of windows. Stability matters — seed the randomness on the
window's integer cell coordinates so a given window does not flicker between
frames or change when the camera moves.

For material, read OSM `building:material` and `roof:material` where tagged and
map them to plausible roughness and colour. Where untagged, use the sampled
façade colour with a masonry-like roughness of ~0.8.

### 5.5 Everything that is not a building

Reuse `modelcity.js` wholesale for roads, water, greenery, trees and street
lamps — that code is fine and already correct. This mode replaces the
*buildings* only. Factor the shared parts out rather than copying them.

---

## 6. Wiring it in

- Add `'reconstructed'` to the mode list in `src/main.js`: the `MODE_HINTS`
  map, `setMode()`, the segmented control in `index.html`, the URL `mode`
  parameter, and the remembered-mode logic.
- It **depends on photoreal having loaded**, because that is where the
  measurements come from. So: load tiles → wait for `groundLocked` → measure →
  build → hide the tiles, show the reconstruction. Say what is happening in the
  status line at each step; this sequence takes seconds and silence reads as a
  hang.
- Cache the metrics per location. Re-measuring on every mode switch is waste,
  and the numbers do not change.
- Consider offering the measured heights back to the block model, so it stops
  guessing 15 m even without a key, once a location has been measured.
- Dispose properly on rebuild. `ModelCity.clear()` is the pattern to copy.

---

## 7. Performance

The whole measure-and-build pass should complete inside about two seconds on a
laptop and must never block the frame.

- **Chunk the raycasting across frames.** Ten buildings per frame, or a
  time-sliced loop with a 6 ms budget. A 400 ms stall is very visible.
- Merge the finished geometry: one merged mesh per material, not one mesh per
  building. `BufferGeometryUtils.mergeGeometries` is already vendored.
- Target under 150k triangles for a 150 m block. Photogrammetry for the same
  area is roughly ten times that, so this should also be *lighter* than
  photoreal — if it is not, something has gone wrong.
- Respect the existing Detail setting for shadow casting.

---

## 8. Testing

The repo has an offline harness (`tools/smoke.mjs`) that stubs every network
call and fails on any console error. Extend it; do not invent a new one.

**The measurement test is the valuable one, and it is exact.**
`tools/make-tiles-fixture.py` generates a synthetic tileset whose box heights
are known constants — a 48 m tower to the east, an 18 m slab to the north, a
22 m block on the address itself. So:

- Add matching building footprints to the OSM fixture in `tools/fixtures.mjs`,
  aligned with those boxes.
- Assert measured height is **within 1 m** of the known truth, per building.
- Assert every roof classifies as flat (the fixture is all boxes).
- Then add a pitched box and a dome to the fixture and assert those classify
  correctly too.

That is a real regression test for the hardest part of the work, and it runs
without a network or an API key.

Also add: a triangle-count ceiling, a frame-time check during the build, and a
screenshot for the eye.

---

## 9. Failure modes to plan for, not discover

| What happens | What to do |
| --- | --- |
| Tiles not loaded where a footprint is | refuse that building, extrude from OSM |
| Footprint encloses a courtyard | huge IQR — refuse |
| Tree overhangs a low building | roof reads high; the cluster test should reject the canopy as a separate cluster |
| OSM footprint offset from the real building | measurement lands on next door; compare to neighbours and flag |
| Building demolished or built since capture | disagreement between OSM and mesh; prefer refusing |
| No Google key at all | the mode is unavailable — say so plainly and stay on block model |

---

## 10. Do not

- Do not exaggerate heights. See §0.
- Do not invent detail the data does not support. A guessed height that looks
  plausible is worse than a plain box, because it cannot be told apart from a
  measured one.
- Do not fabricate a roof shape below the confidence threshold.
- Do not rebuild the lighting, the weather, the sky, the cube or the chrome.
  They work.
- Do not add a build step or a CDN dependency.
- Do not delete the photoreal or block modes. The point is to compare.

---

## 11. Done means

1. Reconstructed mode renders the block around Calle del Mar 26, Valencia, with
   heights within a couple of metres of Google's mesh.
2. The church dome nearby is a dome.
3. Buildings have cornices, recessed windows, a distinct ground floor, and
   storey counts matching their real heights.
4. The hour slider moves real shadows across it, as it now does in photoreal.
5. Rain makes it glossy, snow settles on the roofs, windows light at night.
6. Under 150k triangles; measure-and-build under two seconds; no frame stalls.
7. The fixture test asserts measured heights to within 1 m.
8. The UI is honest about which buildings were measured and which were guessed.
9. `npm test` passes with no console errors.

---

## 12. Honest expectations

This will not look like a hand-modelled architectural visualisation, and you
should not promise that it will. Ground truth is a photogrammetry mesh and a
volunteer-drawn map. Ornament, ironwork, signage and the specific character of
a particular façade are not in either source and will not appear.

What it will be: geometrically correct, crisply rendered, honestly lit, and
recognisable as *that* block rather than a generic one. Sharp where the
photogrammetry is melted, and truthful where the OSM extrusion is guessing.

The photoreal mode keeps the photographic detail. Keeping both, and letting
someone switch, is the design — not a compromise.
