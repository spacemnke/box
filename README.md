# Weather Cube

Type an address and get a cross-section of that place: a cube cut out of the
world, with the ground it stands on below, its buildings in the middle, and the
weather actually happening over it right now on top.

<img src="docs/preview-night-rain.png" alt="The cube at night in the rain" width="720">

## The cube is a cut, not a box

Three layers, stacked and sectioned so you can see into all of them at once:

- **A lid of atmosphere.** Bright and thin on a clear day, a thick bruised
  ceiling under a storm. Its cut face shows the cloud deck in profile, lit from
  above and shadowed underneath, with billows hanging below the base.
- **A band of open air**, where the rain, snow, fog and lightning happen. It
  darkens as the deck above it thickens, which is what makes falling rain read
  as bright.
- **A block of ground**, cut through: made ground, soil, gravel, clay and rock
  by real depth, with a lit lip at street level that turns sodium-warm once the
  lamps come on.

The buildings stand on top of the ground block, in the air.

The cube can be filled three ways:

**Photoreal 3D** — Google's Photorealistic 3D Tiles: the photogrammetry mesh
of the block, true shapes, true heights, true façades, cut to the cube and
*genuinely relit*. This is the one where you recognise your own roof, and it
is the default. Needs a Google Maps Platform key with the Map Tiles API
enabled; without one the block model loads instead.

**3D block model** — the actual building footprints around the address,
extruded from OpenStreetMap, with the real street network, courtyards, parks
and street trees. Needs no key at all.

**Street View** — four Google Street View walls at north, east, south and west
plus the road surface underfoot, from the panorama nearest the address. Needs
the same key with the Street View Static API enabled.

Either way the weather is the same simulation: real conditions from Open-Meteo,
a sun and moon placed by astronomical position for that latitude, longitude and
minute, and rain, snow, fog, cloud, wind and lightning driven by the actual
numbers.

---

## Running it

**Live:** https://spacemnke.github.io/box/ — deployed by the Pages workflow on
every push.

It is a static site with no build step. Because it uses ES modules it has to be
served over HTTP rather than opened from the filesystem.

```bash
npm start          # http://localhost:8000  (python3 -m http.server)
```

or any static server you like — `npx serve`, `caddy file-server`, nginx.

Three.js is vendored in `vendor/`, so the site works with no package install
and no CDN.

## Using it

1. Type an address and press **Build cube**, or press **Use my location**.
2. With a Google key saved, the photoreal block streams in. Without one, the
   block model appears instead.
3. The mode you pick is remembered on the device.

Controls: drag to orbit, scroll to zoom — zoom right in and you are standing
inside the cube. `c` opens and closes the controls drawer, `r` toggles
auto-rotate, `Esc` closes the drawer. **Save PNG** writes out the current frame.

The **Hour** slider walks ±24 hours through the real hourly forecast, so you
can watch your street move from this morning's fog into tonight's clear sky.
**Simulate a different sky** replaces the forecast with a named condition —
useful for seeing your own street in weather it is not currently having. The
readout says plainly when what you are looking at is simulated rather than
live.

## The Google Maps Platform key

One browser key, on a project with billing set up, with:

- **Map Tiles API** enabled, for Photoreal 3D
- **Street View Static API** enabled, for the photo walls

The key is kept in `localStorage` in your browser and sent only to Google.

**Restricting it by website: use the origin, with no path.**
`https://your.site/*`, not `https://your.site/some/page/*`. Under the default
referrer policy a browser sends only the origin on cross-origin requests, so a
restriction that includes a path never matches and Google returns 403. The app
detects this case and says so by name.

**Costs.** Street View is five image requests per cube plus one free metadata
request. 3D Tiles are billed per root-tile session; the loader restricts
itself to a sphere around the address so a cube pulls in far less than a map
view would. Both sit comfortably inside Google's monthly credit for personal
use.

**Terms.** While Google's tiles are on screen the footer shows Google's name
and the copyright strings the tiles carry, as their terms require. Nothing is
cached or pre-rendered.

If Street View has no coverage within 80 m of the address, or 3D Tiles do not
cover the area, the app says so and stays on the block model.

## URL parameters

`?q=Calle+del+Mar+26,+Valencia&lat=39.4738&lon=-0.3743&mode=model&sky=rain&heading=0`

| key | meaning |
| --- | --- |
| `lat`, `lon` | the point to model; skips geocoding |
| `q` | label shown for that point |
| `mode` | `model`, `photoreal` or `photo` |
| `sky` | a simulated condition (`clear`, `overcast`, `fog`, `rain`, `storm`, `snow`, …) |
| `heading` | rotate which compass bearing the panorama walls sit on |

**Copy link** writes the current state into the URL.

---

## How the simulation works

`src/climate.js` is the single place where a weather reading becomes render
parameters. Everything downstream — sky, particles, lighting, the wet look on
the road — reads from that one object, so the sky and the rain can never
disagree about what the weather is.

**Sun and moon** (`src/sun.js`) use the NOAA solar position algorithm, so the
sun sits where it actually sits over that address at that minute, and the
shadows in the model fall the right way. Twilight is treated as the long,
bright thing it is: the street stays readable to about 6° below the horizon
and is only properly dark by 16°.

**Sky** (`src/glsl.js`) is one GLSL function shared by the interior walls, the
glass shell's reflections and the Street View walls. Cloud cover remaps a
two-layer fBm deck between an empty sky and a solid ceiling; the deck drifts
with the real wind vector. Stars are placed in cells on a sphere so they stay
round.

**The layers** (`src/slabs.js`) are two shaded boxes. The lid's thickness and
colour follow the cloud cover, from a thin luminous blue-white plate to a deep
overcast ceiling, and the weather is re-fitted into whatever headroom is left
below it. The interior walls are deliberately *not* open sky: they are the far
air under that deck, so they darken as it thickens. Getting this wrong washes
the middle of the cube out and the rain vanishes into it.

**Fog** is the part most likely to be got wrong. Visibility is reported in
metres, but the cube only spans about 150 m, so visibility is first converted
to an extinction coefficient (Koschmieder, `k = 3.912 / V`) and then applied
across the cube's real size. A 4 km-visibility rainy afternoon barely dims the
far side of the block, which is correct; 200 m fog swallows it, which is also
correct.

**Precipitation** (`src/weatherfx.js`) advances entirely on the GPU — instance
positions are a function of time, wind and a per-instance seed — so heavy rain
costs the same as drizzle. Rain streaks lie along their own velocity vector and
tilt with the wind; snow sways; a dry gale lifts dust instead.

**Street View relighting** (`PHOTO_FRAG` in `src/glsl.js`) is the interesting
one. A photograph is fixed weather, so the shader takes it apart: sky pixels
are detected by blueness and brightness above the horizon and replaced with the
simulated sky, so the photographed sky can storm over. Rain darkens and
saturates the lower frame and rings the ground panel with ripples; night
crushes the image and lets the brightest pixels — lamps, shopfronts, lit
windows — glow back through; snow settles on the upward-facing half.

**Relighting the photogrammetry** is the part that turns a photograph into a
render. Google's textures have a summer afternoon baked into them, so before
anything can be lit they have to be taken apart.

Two signals do most of the work. Daylight shadows are lit by the sky rather
than the sun, which makes them both darker *and* bluer than the surfaces
around them — a signature that finds them without knowing the geometry. And
the broad light-to-dark gradient across a surface is the capture sun, whose
direction is guessable: aerial flights happen in clear weather near local
noon, so a high sun towards the equator, derived from the latitude, predicts
it well enough to divide out. What is left is close to material colour.

That albedo then goes through ordinary physically based shading: the real sun
for the real minute as a directional light, casting its own shadow map, with
the simulated sky rendered to a prefiltered cubemap for ambient and
reflections. So the weather changes the surfaces rather than being painted
over them — wet asphalt drops to a roughness of 0.09 and mirrors the actual
overcast above it, snow covers what faces the sky and goes matte, and at
night the brightest pixels of the capture become the emissive lamps and
shopfronts they were photographed as.

It is an estimate, not a recovery: where it estimates badly, **As captured**
switches back to Google's own lighting with the weather graded over it. The
tell that it is real is the hour slider — move it and the shadows sweep
across the block.

**Photoreal 3D** (`src/tiles3d.js`) streams Google's tiles through
`3d-tiles-renderer`, re-oriented so the address sits at the origin with north
along -Z, scaled so 75 m fills the cube, and masked to a sphere around the
address so only the block's tiles load. Google tiles do not know where the
ground is relative to the ellipsoid, so the loader drops a grid of rays after
each tile arrives, takes the lowest street-level hit, and lifts the whole
mesh onto the ground slab — re-settling as finer tiles come in and locking
once it stops moving. The photogrammetry is a photograph wrapped around
geometry, so weather is a grade on it, as with the Street View walls:
overcast flattens the baked shadows, rain darkens and glosses upward faces,
night crushes the capture and lets its brightest pixels glow, snow settles
by surface normal.

**The block model** (`src/modelcity.js`) extrudes each footprint using
`height`, or `building:levels × 3.2 m`, or a 15 m guess for European blocks.
Heights are exaggerated 2× because a true-to-scale 150 m box of air is mostly
empty sky. Facades get a real-metre window grid — recessed glazing by day, lit
windows after dark, more of them on ground floors — and street lamps are spaced
along the real road centrelines, so a night cube shows the shape of the actual
neighbourhood.

## Where this is going

The modes are being replaced by a single one, in which the buildings are
generated from data rather than streamed as a mesh. Photogrammetry as an
instrument rather than as a picture.

- [`docs/reconstruction-brief.md`](docs/reconstruction-brief.md) — the design
- [`docs/next-step.md`](docs/next-step.md) — the state of play and what to
  build next, including the further Google APIs that each remove a guess

**Stage one is built.** `src/measure.js` reads real building heights and roof
forms off Google's mesh by raycasting inside OpenStreetMap footprints. The
offline test asserts it against a fixture of boxes with known heights, and it
lands exactly: 48 m, 18 m and 22 m.

## Data sources

| what | who | key needed |
| --- | --- | --- |
| Weather | [Open-Meteo](https://open-meteo.com) | no |
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org) / OpenStreetMap | no |
| Buildings, roads, trees | [Overpass](https://overpass-api.de) / OpenStreetMap | no |
| Street View imagery | Google Maps Platform | yes |

All requests go straight from the browser. There is no server, and nothing is
logged anywhere.

Nominatim and Overpass are volunteer-run and rate-limited; be gentle with them.

## Testing

```bash
npm test
```

Serves the site, stubs every third-party call with fixtures, and renders a
sweep of weather states to `shots/` — clear, overcast, rain, storm, snow, fog,
night, dusk — plus one view of each Street View wall from inside the cube,
which is how the panorama orientation is checked (facing north, east must be on
the right), and a synthetic 3D Tiles tileset placed on Earth at the fixture
point, which checks the tiles land in the cube, on the ground, the right way
round (its red tower is east, its green slab north). It renders the same
weather at three different hours and fails unless all three frames differ,
which is the difference between relighting and a grade. It also checks the
layout on a portrait phone and a phone held sideways, and regenerates the
README preview. It fails on any console error.

`tools/make-tiles-fixture.py` regenerates that tileset.

Fixtures are synthetic and are labelled as such; they are not real data for any
real address.

## Type

The page uses whatever transitional serif the reader already has — Iowan Old
Style, Palatino, Georgia — with no webfont request. It will look a little
different on a machine that has none of them.

## Layout

```
index.html          shell and controls
styles.css
src/
  main.js           wiring, UI, render loop
  data.js           every network call
  climate.js        weather reading -> render parameters
  sun.js            solar and lunar position
  glsl.js           shared sky, and the Street View relighting shader
  slabs.js          the cloud lid and the cut block of ground
  cube.js           the six interior panels, glass shell, frame
  modelcity.js      OpenStreetMap footprints -> extruded block
  weatherfx.js      rain, snow, drift, ground fog, lightning
  panorama.js       Street View panel loading
  tiles3d.js        Google Photorealistic 3D Tiles, placed, de-lit and relit
  skyenv.js         the simulated sky as a prefiltered environment map
  marker.js         the beam standing on the address
  overrides.js      the named simulated conditions
tools/              offline smoke test and its fixtures
vendor/three/       pinned three.js r169, plus the glTF and Draco loaders
vendor/3d-tiles-renderer/  pinned 3d-tiles-renderer 0.5.2
```
