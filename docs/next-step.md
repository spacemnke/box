# Next step: render the block in realistic 3D from Google's data

A handoff. Stage one — measuring the block — is built, verified and merged.
This describes stage two: turning those measurements into a rendered building,
and pulling in the further Google APIs that raise it from *correct* to
*realistic*.

Read [`reconstruction-brief.md`](reconstruction-brief.md) first. It carries the
frame conventions, the scale traps and the overall design. This document
assumes it and does not repeat it.

---

## 1. Where the work actually is

**Done and verified.** `src/measure.js` reads real building heights and roof
forms off Google's photogrammetry by raycasting inside OpenStreetMap
footprints. It is exact: the offline test asserts measured heights against a
fixture built from boxes of known height, and all three land on the nose —
48.00 m, 18.00 m, 22.00 m.

Call it with `window.__cube.measureFromTiles()` once photoreal has loaded. It
returns one row per building:

```js
{
  ring, ring2d,              // footprint, lat/lon and world XZ
  eaveHeight, ridgeHeight,   // metres above street
  roof: { kind, pitch, azimuth, parapetHeight },
  sampleCount, iqr, confidence,
  source: 'measured' | 'unmeasured',
}
```

`roof.kind` is one of `flat`, `shed`, `gable`, `dome`. Buildings it could not
measure come back as `source: 'unmeasured'` with no heights — that is
deliberate, and you must honour it rather than substituting a guess.

**Not started.** Everything below.

**One trap already paid for.** Measure against `Photoreal.streetY`, never
`GROUND_TOP`. The tiles sit 0.004 units clear of the ground slab to avoid
z-fighting, which is 30 cm of real world at cube scale. It showed up as every
building reading exactly 0.3 m too tall.

---

## 2. What "realistic" has to mean here

Be precise about the target, because "realistic" pulls in two directions and
only one of them is achievable.

**Not** photographic. The specific ironwork on a Valencian balcony, the
lettering on a shopfront, the exact patina of one façade — none of that is in
any data source available. Chasing it produces an uncanny near-miss.

**Yes** architecturally and optically truthful:

- correct volumes, to the metre
- roof forms that match what is actually up there
- storey lines at real heights, openings at real proportions
- materials that respond correctly to sun, sky, rain and night
- shadows that fall where the sun actually is, at the minute shown

The bar to hold yourself to: **someone who lives on that street should be able
to point at their own building.** Not recognise the pixels — recognise the
massing, the height relative to next door, the corner, the roofline.

---

## 3. The rendering work

### 3.1 Geometry — `src/reconstruct.js`

Takes `BuildingMetrics[]`, returns a `THREE.Group`. Pure: no rays, no network.

Build walls manually rather than with `ExtrudeGeometry` — you need UVs in
**metres**, because every façade feature downstream is driven off them. `u`
along the wall, `v` up, both in real metres.

Roofs by `roof.kind`, per the brief. Then the details that actually carry it,
in order of value per line of code:

1. **A cornice at eave height.** A 0.4 m band projecting 0.25 m. One extruded
   ring per building. This is the single strongest signal that something is
   architecture rather than a mass, and it is nearly free.
2. **Recessed window reveals.** 0.15 m of depth is enough to catch the sun and
   self-shadow. Painted-on windows read as wallpaper at any distance.
3. **A distinct ground floor**, ~4.2 m, different material, larger openings.
4. **String courses** between storeys where `building:levels` is tagged.

Merge aggressively: one geometry per material, not per building. Target under
150k triangles for the 150 m block — roughly a tenth of what the
photogrammetry costs for the same area.

### 3.2 Façade material — `src/facade.js`

A `MeshStandardMaterial` patched through `onBeforeCompile`, following the
pattern already in `modelcity.js` and `tiles3d.js`. Drive everything off the
metre-space UVs and the measured storey count.

Weather comes from the existing climate uniforms — do not invent new ones.
Wetness lowers roughness, snow covers up-facing surfaces, night lights
windows.

**Seed window randomness on the window's integer cell coordinates.** If you
seed on anything view-dependent, windows flicker as the camera moves and the
whole thing falls apart.

### 3.3 Lighting — already done, do not rebuild

`src/skyenv.js` puts the simulated sky on `scene.environment` as a prefiltered
cubemap; the sun is a `DirectionalLight` with shadow mapping, positioned from
real solar geometry. Use `MeshStandardMaterial` and all of it applies for free:
correct sun, real cast shadows, sky ambient, wet-surface reflections.

---

## 4. The Google data that raises the fidelity

Currently one Google API is used: Map Tiles, for the photogrammetry. There are
four more that would each remove a guess. **Verify endpoint shapes and coverage
against current documentation before building on them** — the descriptions
below are from memory and cannot be checked from the build environment.

### 4.1 Solar API — authoritative roof geometry

**The highest-value addition on this list.** `buildingInsights:findClosest`
returns, per building, a `solarPotential.roofSegmentStats[]` array where each
segment carries a pitch, an azimuth, an area and a centre height.

That is *measured roof plane geometry, from Google, per roof plane* — which is
strictly better than my raycast classifier, because it resolves multi-plane
roofs my histogram collapses into one. A hipped roof with four faces comes back
as four segments with four azimuths.

Use it as the primary roof source where coverage exists, and fall back to
`measure.js` where it does not. Keep the raycast path — it is the only thing
that works everywhere.

Coverage is good across Spain and much of Europe and North America; it is
billed per request; it needs the Solar API enabled on the key alongside Map
Tiles.

### 4.2 Solar API data layers — a true elevation raster

The same API's `dataLayers` endpoint returns a DSM — a digital surface model
raster at roughly 0.1–0.25 m per pixel, as GeoTIFF.

That is a better height source than raycasting a mesh: denser, cleaner, and
already the surface rather than a triangulation of it. The cost is a GeoTIFF
decoder in the browser, which means vendoring something like `geotiff.js` and
respecting the no-CDN rule.

Worth doing only after the roof-segment work above, which gets most of the
benefit for far less machinery.

### 4.3 Places API — what the buildings actually are

`places:searchNearby` over the block returns businesses with types, names and
opening hours. That turns generic geometry into a street:

- a building with ground-floor retail gets shopfronts, not residential windows
- opening hours drive which ground floors are lit at 22:00 and which are dark
- a `place.type` of `church` or `museum` justifies different massing treatment

This is the cheapest large gain in *character* on the list. It is also the one
most likely to look wrong if over-applied — signage and logos are not yours to
render.

### 4.4 Street View Static — façade colour at eye level

Already integrated (`src/panorama.js`), currently used as a display mode that
is being removed. **Repurpose it rather than deleting it.**

Aerial photogrammetry sees roofs well and walls poorly — walls are captured at
a grazing angle, at low resolution, often in shadow. Street View sees walls
straight on. Sampling façade colour from the panorama nearest each building
would beat the aerial sampling described in the brief.

Practical approach: for each building facing the street, take the Street View
panorama nearest its centroid, request the heading that points at it, and
sample the image. Then de-light it with the same logic as
`delight()` in `src/tiles3d.js` so what you store is albedo, not albedo plus
that afternoon's sun.

### 4.5 Geocoding API — the marker's precision

Nominatim currently supplies the address point, and it frequently returns the
middle of the street rather than the building. Google's Geocoder returns
`location_type: ROOFTOP` where it has it, which would put the marker on the
right building rather than near it.

Small, but it is the difference between "somewhere on your road" and "your
door", and the app already surfaces that distinction to the viewer.

---

## 5. Removing the other modes

This is the point of the exercise and it should happen **last**, once the
reconstruction stands on its own.

- Street View, block-model and photoreal stop being selectable. Delete the
  segmented control, `MODE_HINTS`, the mode branches in `setMode()`, the `mode`
  URL parameter and the remembered-mode logic in `src/main.js`.
- **Photoreal is not deleted — it is demoted to infrastructure.** The tiles
  still load, get measured and sampled, then `photoreal.group.visible = false`.
  It is the instrument.
- The OSM extrusion survives only as a silent per-building fallback for
  `source: 'unmeasured'`. Never as a mode.
- Accept the consequence deliberately: **no Google key means no cube.** Say so
  plainly. Do not quietly show a block of guessed boxes and let someone believe
  they are looking at their measured building.

---

## 6. Order of work

Each step should end somewhere shippable.

1. **Geometry from measurements** — walls, flat roofs, parapets, cornices.
   Boring shapes, correct heights. Ugly but true.
2. **Façade material** — storeys, openings, ground floor, weather response.
   This is where it starts looking like a building.
3. **Shaped roofs** — gable, shed, dome from the existing classifier.
4. **Solar API roof segments** — replace the classifier where coverage exists.
5. **Street View façade colour** — replace the aerial colour sampling.
6. **Places API** — shopfronts and night-lighting behaviour.
7. **Remove the modes.** Only when 1–3 are genuinely better than what they
   replace.

Do not do 4–6 before 1–3. They are refinements to something that must first
exist.

---

## 7. How to know it works

The offline harness (`tools/smoke.mjs`) stubs every network call, fails on any
console error, and needs no API key. Extend it; do not start a new one.

Already asserted, keep passing:

- measured heights within 0.5 m of the fixture's known boxes
- every fixture roof classifies as flat
- one weather at three hours produces three different frames — the test that
  distinguishes real lighting from a grade
- the cube fits a portrait phone and a phone held sideways

Add:

- a triangle-count ceiling
- geometry is watertight — no building with zero or negative volume
- `source: 'unmeasured'` buildings never receive a fabricated height
- a pitched box and a dome in the tileset fixture, asserted to classify
  correctly

Regenerate the tileset fixture with `python3 tools/make-tiles-fixture.py`
after adding shapes to it.

---

## 8. Things that will go wrong

| Symptom | Cause | What to do |
| --- | --- | --- |
| Buildings float or sink | measured against `GROUND_TOP` instead of `Photoreal.streetY` | see §1 |
| Windows shimmer when the camera moves | randomness seeded on anything view-dependent | seed on integer cell coordinates |
| Roofs self-intersect | concave footprint through the gable builder | detect concavity, downgrade to flat |
| Whole block one storey tall | height exaggeration applied on top of real measurements | do not exaggerate; see the brief §0 |
| Frame stalls for half a second | raycasting or building without time-slicing | 6 ms budget, yield between slices |
| A shop reads as a 40 m tower | measurement accepted below the confidence threshold | tighten, or refuse |

---

## 9. The standard to hold

The existing code is heavily commented, and the comments explain *why* rather
than *what* — the 30 cm z-fighting trap, why a mean is the wrong statistic for
roof height, why refusing to measure is a feature. Match that. The next person
after you will be a model reading this cold, exactly as you are now.

And keep the honesty in the interface. The app already tells the viewer when a
geocode matched a street rather than a door, and when a sky is simulated rather
than forecast. Reconstruction adds a new thing worth being honest about: which
buildings were measured and which were guessed. Surface it.
