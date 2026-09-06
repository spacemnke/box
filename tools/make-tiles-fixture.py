#!/usr/bin/env python3
"""Generate a tiny stand-in 3D Tiles tileset for the offline smoke test.

Writes tools/fixtures/tiles/root.json and block.glb. The GLB is a synthetic
block — a ground plate and coloured boxes — in a local east/north/up frame,
placed on Earth by the tileset's root transform, exactly as a real tileset
would be. It is not real geometry for any real place.
"""
import json
import math
import struct
from pathlib import Path

OUT = Path(__file__).parent / "fixtures" / "tiles"
OUT.mkdir(parents=True, exist_ok=True)

LAT, LON = 39.4739, -0.3742      # same point as the other fixtures
GROUND_H = 40.0                  # metres above the ellipsoid, to exercise settling

# ---------------------------------------------------------------- geometry

positions, normals, colors, indices = [], [], [], []


def add_box(cx, cz, w, d, y0, h, rgb):
    """Axis-aligned box in glTF space (x east, y up, -z north)."""
    x0, x1 = cx - w / 2, cx + w / 2
    z0, z1 = cz - d / 2, cz + d / 2
    y1 = y0 + h
    faces = [
        # (normal, four corners CCW seen from outside)
        ((0, 1, 0), [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)]),
        ((0, -1, 0), [(x0, y0, z1), (x0, y0, z0), (x1, y0, z0), (x1, y0, z1)]),
        ((1, 0, 0), [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)]),
        ((-1, 0, 0), [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)]),
        ((0, 0, 1), [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]),
        ((0, 0, -1), [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)]),
    ]
    for n, quad in faces:
        base = len(positions)
        shade = 1.0 if n[1] > 0 else (0.72 if n[1] == 0 else 0.4)
        for p in quad:
            positions.append(p)
            normals.append(n)
            colors.append(tuple(c * shade for c in rgb))
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])


# Ground plate, slightly larger than the cube so clipping is exercised.
add_box(0, 0, 260, 260, GROUND_H - 1.0, 1.0, (0.36, 0.35, 0.33))

# A grid of buildings.
import random
random.seed(7)
for bx in range(-2, 3):
    for bz in range(-2, 3):
        if bx == 0 and bz == 0:
            continue
        h = 10 + random.random() * 22
        add_box(bx * 46, bz * 46, 26 + random.random() * 10, 26 + random.random() * 10,
                GROUND_H, h, (0.78 + random.random() * 0.12, 0.70 + random.random() * 0.1, 0.58))

# Orientation markers: a tall red tower to the EAST, a green slab to the NORTH.
add_box(70, 0, 14, 14, GROUND_H, 48, (0.85, 0.22, 0.18))
add_box(0, -70, 30, 12, GROUND_H, 18, (0.20, 0.72, 0.30))
# And a small blue block on the address itself.
add_box(0, 0, 16, 16, GROUND_H, 22, (0.25, 0.45, 0.85))

# ---------------------------------------------------------------- glb

def pack(fmt, seq):
    return b"".join(struct.pack(fmt, *v) for v in seq)


pos_bin = pack("<3f", positions)
nrm_bin = pack("<3f", normals)
col_bin = pack("<3f", colors)
idx_bin = struct.pack(f"<{len(indices)}I", *indices)


def pad4(b, fill=b"\x00"):
    return b + fill * ((4 - len(b) % 4) % 4)


bin_chunks = [pad4(pos_bin), pad4(nrm_bin), pad4(col_bin), pad4(idx_bin)]
offsets, off = [], 0
for c in bin_chunks:
    offsets.append(off)
    off += len(c)
bin_blob = b"".join(bin_chunks)

xs = [p[0] for p in positions]; ys = [p[1] for p in positions]; zs = [p[2] for p in positions]
gltf = {
    "asset": {"version": "2.0", "generator": "weather-cube fixture"},
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [{"mesh": 0}],
    "meshes": [{"primitives": [{
        "attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
        "indices": 3,
        "material": 0,
    }]}],
    "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1}}],
    "buffers": [{"byteLength": len(bin_blob)}],
    "bufferViews": [
        {"buffer": 0, "byteOffset": offsets[0], "byteLength": len(pos_bin)},
        {"buffer": 0, "byteOffset": offsets[1], "byteLength": len(nrm_bin)},
        {"buffer": 0, "byteOffset": offsets[2], "byteLength": len(col_bin)},
        {"buffer": 0, "byteOffset": offsets[3], "byteLength": len(idx_bin)},
    ],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3",
         "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
        {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": len(colors), "type": "VEC3"},
        {"bufferView": 3, "componentType": 5125, "count": len(indices), "type": "SCALAR"},
    ],
}
json_blob = pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
total = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
glb = (struct.pack("<4sII", b"glTF", 2, total)
       + struct.pack("<II", len(json_blob), 0x4E4F534A) + json_blob
       + struct.pack("<II", len(bin_blob), 0x004E4942) + bin_blob)
(OUT / "block.glb").write_bytes(glb)

# ---------------------------------------------------------------- tileset

# East-north-up frame at (LAT, LON) on WGS84, as a column-major 4x4 for the
# tileset's root transform. Tile content is glTF Y-up, which the runtime
# maps to the tileset's Z-up, so glTF +Y becomes "up" here.
a, f = 6378137.0, 1 / 298.257223563
e2 = f * (2 - f)
lat, lon = math.radians(LAT), math.radians(LON)
sl, cl, so, co = math.sin(lat), math.cos(lat), math.sin(lon), math.cos(lon)
N = a / math.sqrt(1 - e2 * sl * sl)
px, py, pz = N * cl * co, N * cl * so, N * (1 - e2) * sl
east = (-so, co, 0)
north = (-sl * co, -sl * so, cl)
up = (cl * co, cl * so, sl)
transform = [*east, 0, *north, 0, *up, 0, px, py, pz, 1]

tileset = {
    "asset": {"version": "1.1", "copyright": "Test imagery · Fixture data"},
    "geometricError": 400,
    "root": {
        "transform": transform,
        "boundingVolume": {"box": [0, 0, GROUND_H + 20, 150, 0, 0, 0, 150, 0, 0, 0, 40]},
        "geometricError": 0,
        "refine": "REPLACE",
        "content": {"uri": "block.glb?session=TEST_SESSION"},
    },
}
(OUT / "root.json").write_text(json.dumps(tileset, indent=1))
print(f"wrote {OUT/'block.glb'} ({len(glb)} bytes) and root.json, {len(positions)} vertices")
