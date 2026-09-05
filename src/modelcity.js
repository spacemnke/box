// A 3D model of the block, extruded from OpenStreetMap footprints.
// This is the mode that needs no API key: real building outlines, real street
// layout, real courtyards — the shape of the place rather than a photo of it.

import * as THREE from 'three';
import { CUBE_SIZE, HALF } from './cube.js';
import { GROUND_TOP, SKY_BOTTOM } from './slabs.js';
import { projector } from './data.js';

const WINDOW_PATCH = {
  vertex: {
    find: '#include <begin_vertex>',
    add: `
      #include <begin_vertex>
      vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    `,
  },
};

/**
 * Facade windows that light up after dark, injected into a standard material
 * so the buildings still receive real lighting and fog.
 */
function makeFacadeMaterial(metresPerUnitXZ, metresPerUnitY) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd8d2c6,
    roughness: 0.82,
    metalness: 0.02,
    vertexColors: true,
    flatShading: false,
  });

  mat.userData.uniforms = {
    uNightLights: { value: 0 },
    uWet: { value: 0 },
    uSnowCover: { value: 0 },
    uMetres: { value: metresPerUnitXZ },
    uMetresY: { value: metresPerUnitY },
    uGroundY: { value: GROUND_TOP },
    uLampColor: { value: new THREE.Color(0xffc98a) },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vWPos;\nvoid main() {')
      .replace(WINDOW_PATCH.vertex.find, WINDOW_PATCH.vertex.add);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `
        varying vec3 vWPos;
        uniform float uNightLights;
        uniform float uWet;
        uniform float uSnowCover;
        uniform float uMetres;
        uniform float uMetresY;
        uniform float uGroundY;
        uniform vec3  uLampColor;

        float hash31(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        void main() {
        `
      )
      .replace(
        '#include <emissivemap_fragment>',
        `
        #include <emissivemap_fragment>
        {
          // Window grid in real metres, measured up from street level:
          // ~3.2 m floors, ~2.6 m bays.
          vec3 m = vec3(vWPos.x * uMetres, (vWPos.y - uGroundY) * uMetresY, vWPos.z * uMetres);
          vec3 cell = vec3(floor(m.x / 2.6), floor(m.y / 3.2), floor(m.z / 2.6));
          vec2 f = vec2(fract(m.x / 2.6 + m.z / 2.6), fract(m.y / 3.2));
          float pane = step(0.20, f.x) * step(f.x, 0.76)
                     * step(0.30, f.y) * step(f.y, 0.84);
          // Only vertical surfaces have windows; roofs do not.
          float wall = 1.0 - smoothstep(0.35, 0.75, abs(normal.y));
          float lit = step(0.52, hash31(cell));
          // Ground floors — shops and doorways — stay lit more often.
          float ground = step(m.y, 4.6) * 0.85;
          float glow = pane * wall * max(lit, ground) * uNightLights;
          totalEmissiveRadiance += uLampColor * glow * 2.4;

          // In daylight the same grid reads as recessed glazing.
          diffuseColor.rgb *= 1.0 - pane * wall * 0.34 * (1.0 - uNightLights);
        }

        // Rain darkens masonry and makes it shine.
        diffuseColor.rgb *= mix(1.0, 0.72, uWet);

        // Snow settles on anything pointing up.
        {
          float upFacing = smoothstep(0.55, 0.95, normal.y);
          vec3 snowCol = vec3(0.90, 0.93, 0.98);
          diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, upFacing * uSnowCover);
        }
        `
      );

    mat.userData.shader = shader;
  };

  mat.customProgramCacheKey = () => 'facade-v1';
  return mat;
}

/**
 * Shapes are authored in XY and then rotated by -90 deg about X, which sends
 * shape +Y to world -Z. Negating here keeps north pointing at world -Z.
 * The ring is also forced counter-clockwise so extruded walls face outwards.
 */
function ringToShape(ring, project, scale) {
  const pts = ring.map((pt) => {
    const p = project(pt.lat, pt.lon);
    return new THREE.Vector2(p.x * scale, -p.z * scale);
  });
  // Drop the duplicated closing vertex, if present.
  if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-9) pts.pop();
  if (THREE.ShapeUtils.area(pts) < 0) pts.reverse();

  const shape = new THREE.Shape();
  pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
  shape.closePath();
  return shape;
}

function ringArea(ring, project) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = project(ring[i].lat, ring[i].lon);
    const b = project(ring[(i + 1) % ring.length].lat, ring[(i + 1) % ring.length].lon);
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area) / 2;
}

const BUILDING_PALETTE = [
  0xd9cfc0, 0xcfc3b2, 0xd6c6ad, 0xc4b9ab, 0xdad2c6, 0xc9bda9, 0xe0d6c4, 0xbfb3a2,
];

/**
 * Build the whole block. Coordinates arrive in lat/lon; everything is projected
 * to metres around the centre, then scaled so `radius` metres fills the cube.
 */
export class ModelCity {
  constructor(shared) {
    this.group = new THREE.Group();
    this.shared = shared;
    this.materials = [];
    this.clipPlanes = [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), HALF * 0.995),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), HALF * 0.995),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), HALF * 0.995),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), HALF * 0.995),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), SKY_BOTTOM - 0.01),
    ];
    this.metresPerUnit = 110;
    this.heightScale = 1;
    this.stats = { buildings: 0, roads: 0, trees: 0 };
  }

  clear() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    this.group.clear();
    this.materials = [];
  }

  /**
   * @param {object} osm   result of fetchOSM
   * @param {number} lat0
   * @param {number} lon0
   * @param {number} radius half-width of the modelled square, metres
   */
  build(osm, lat0, lon0, radius, heightScale = 1) {
    this.clear();
    this.stats = { buildings: 0, roads: 0, trees: 0 };
    this.metresPerUnit = radius;
    this.heightScale = heightScale;
    const project = projector(lat0, lon0);
    const scale = 1 / radius;          // metres -> cube units, horizontally
    const vScale = scale * heightScale; // metres -> cube units, vertically

    const facade = makeFacadeMaterial(radius, radius / heightScale);
    facade.clippingPlanes = this.clipPlanes;
    facade.clipShadows = true;
    this.materials.push(facade);

    // ---- ground ----------------------------------------------------------
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xa8a49b,
      roughness: 0.95,
      metalness: 0.0,
    });
    groundMat.clippingPlanes = this.clipPlanes;
    this.materials.push(groundMat);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(CUBE_SIZE, CUBE_SIZE), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_TOP + 0.0005;
    ground.receiveShadow = true;
    this.group.add(ground);

    // ---- flat layers: water, greenery, roads ------------------------------
    this._addFlat(osm.water, project, scale, 0x33556e, GROUND_TOP + 0.0022, 0.35, 0.0);
    this._addFlat(osm.green, project, scale, 0x5d7a4a, GROUND_TOP + 0.0018, 0.95, 0.0);
    this._addRoads(osm.roads, project, scale);

    // ---- buildings --------------------------------------------------------
    const geometries = [];
    for (const b of osm.buildings) {
      if (b.ring.length < 4) continue;
      if (ringArea(b.ring, project) < 12) continue; // sheds and map noise

      const shape = ringToShape(b.ring, project, scale);
      let geo;
      try {
        geo = new THREE.ExtrudeGeometry(shape, {
          depth: Math.min(b.height * vScale, SKY_BOTTOM - GROUND_TOP - 0.04),
          bevelEnabled: false,
          curveSegments: 1,
        });
      } catch {
        continue;
      }
      // Extrude builds along +Z; lay it down so height runs along +Y.
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, GROUND_TOP + 0.002, 0);

      const colour = new THREE.Color(
        b.colour && CSS.supports?.('color', b.colour)
          ? b.colour
          : BUILDING_PALETTE[Math.floor(Math.abs(hashString(b.name || String(b.ring[0].lat))) % BUILDING_PALETTE.length)]
      );
      const count = geo.attributes.position.count;
      const colours = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colours[i * 3 + 0] = colour.r;
        colours[i * 3 + 1] = colour.g;
        colours[i * 3 + 2] = colour.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      geo.computeVertexNormals();
      geometries.push(geo);
      this.stats.buildings++;
    }

    for (const geo of geometries) {
      const mesh = new THREE.Mesh(geo, facade);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // ---- street lighting ---------------------------------------------------
    this._addStreetLamps(scale, vScale, radius);

    // ---- trees -------------------------------------------------------------
    this._addTrees(osm.trees, project, scale, vScale);

    // ---- the address marker -------------------------------------------------
    this.group.add(this._marker(scale, vScale));

    return this.stats;
  }

  _addFlat(items, project, scale, colour, y, roughness, metalness) {
    if (!items?.length) return;
    const mat = new THREE.MeshStandardMaterial({
      color: colour,
      roughness,
      metalness,
      side: THREE.DoubleSide,
    });
    mat.clippingPlanes = this.clipPlanes;
    this.materials.push(mat);

    for (const item of items) {
      if (item.ring.length < 4) continue;
      const shape = ringToShape(item.ring, project, scale);
      let geo;
      try {
        geo = new THREE.ShapeGeometry(shape);
      } catch {
        continue;
      }
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, y, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  _addRoads(roads, project, scale) {
    if (!roads?.length) return;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x5e5c59,
      roughness: 0.78,
      metalness: 0.0,
    });
    mat.clippingPlanes = this.clipPlanes;
    mat.name = 'road';
    this.materials.push(mat);
    this.roadMaterial = mat;

    const positions = [];
    const y = GROUND_TOP + 0.003;
    this._roadSegments = [];

    for (const road of roads) {
      const w = road.width * scale * 0.5;
      for (let i = 0; i < road.ring.length - 1; i++) {
        const a = project(road.ring[i].lat, road.ring[i].lon);
        const b = project(road.ring[i + 1].lat, road.ring[i + 1].lon);
        const ax = a.x * scale;
        const az = a.z * scale;
        const bx = b.x * scale;
        const bz = b.z * scale;
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const nx = (-dz / len) * w;
        const nz = (dx / len) * w;
        // Two triangles per segment.
        positions.push(
          ax + nx, y, az + nz,
          ax - nx, y, az - nz,
          bx - nx, y, bz - nz,
          ax + nx, y, az + nz,
          bx - nx, y, bz - nz,
          bx + nx, y, bz + nz
        );
        this._roadSegments.push({ ax, az, bx, bz, len, width: road.width });
        this.stats.roads++;
      }
    }

    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    // Road quads are flat on the ground; a straight up normal beats deriving
    // one from winding that varies segment to segment.
    const normals = new Float32Array(positions.length);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * Warm pools of light spaced along the real road centrelines. Cheap enough
   * to be a texture rather than a light, and it follows the actual streets, so
   * a night cube shows the shape of the neighbourhood rather than a black slab.
   */
  _addStreetLamps(scale, vScale, radius) {
    const segments = this._roadSegments || [];
    if (!segments.length) return;

    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,214,150,0.95)');
    g.addColorStop(0.35, 'rgba(255,190,116,0.40)');
    g.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const spacing = 24 * scale; // roughly one lamp every 24 m
    const pools = [];
    for (const seg of segments) {
      if (seg.width < 3) continue;
      const n = Math.max(1, Math.floor(seg.len / spacing));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        pools.push([seg.ax + (seg.bx - seg.ax) * t, seg.az + (seg.bz - seg.az) * t]);
      }
    }
    if (!pools.length) return;

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      clippingPlanes: this.clipPlanes,
    });
    this.lampMaterial = mat;
    this.materials.push(mat);

    const geo = new THREE.PlaneGeometry(16 * scale, 16 * scale);
    const mesh = new THREE.InstancedMesh(geo, mat, pools.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    pools.forEach(([x, z], i) => {
      pos.set(x, GROUND_TOP + 0.006, z);
      m.compose(pos, q, one);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 6;
    mesh.frustumCulled = false;
    this.lamps = mesh;
    this.group.add(mesh);

    // The fittings themselves: small warm dots at lamp-post height.
    const bulbMat = new THREE.MeshBasicMaterial({
      color: 0xffcd8a,
      transparent: true,
      opacity: 0,
      clippingPlanes: this.clipPlanes,
    });
    this.bulbMaterial = bulbMat;
    this.materials.push(bulbMat);
    const bulbGeo = new THREE.SphereGeometry(0.7 * scale, 6, 5);
    const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, pools.length);
    pools.forEach(([x, z], i) => {
      m.makeTranslation(x, GROUND_TOP + 6 * vScale, z);
      bulbs.setMatrixAt(i, m);
    });
    bulbs.instanceMatrix.needsUpdate = true;
    bulbs.frustumCulled = false;
    this.bulbs = bulbs;
    this.group.add(bulbs);
  }

  _addTrees(trees, project, scale, vScale = scale) {
    if (!trees?.length) return;
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.9 });
    trunkMat.clippingPlanes = this.clipPlanes;
    leafMat.clippingPlanes = this.clipPlanes;
    this.materials.push(trunkMat, leafMat);
    this.leafMaterial = leafMat;

    const trunkGeo = new THREE.CylinderGeometry(0.3 * scale, 0.45 * scale, 3 * vScale, 5);
    const leafGeo = new THREE.SphereGeometry(2.6 * scale, 10, 7);
    leafGeo.scale(1, (vScale / scale) * 0.9, 1);

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, trees.length);
    const m = new THREE.Matrix4();

    trees.forEach((t, i) => {
      const p = project(t.lat, t.lon);
      const x = p.x * scale;
      const z = p.z * scale;
      m.makeTranslation(x, GROUND_TOP + 1.5 * vScale, z);
      trunks.setMatrixAt(i, m);
      m.makeTranslation(x, GROUND_TOP + 5.0 * vScale, z);
      leaves.setMatrixAt(i, m);
      this.stats.trees++;
    });
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    trunks.castShadow = leaves.castShadow = true;
    trunks.receiveShadow = leaves.receiveShadow = true;
    this.group.add(trunks, leaves);
  }

  _marker(scale, vScale = scale) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.95 });
    mat.clippingPlanes = this.clipPlanes;
    const pin = new THREE.Mesh(new THREE.ConeGeometry(1.8 * scale, 7 * vScale, 12), mat);
    pin.rotation.x = Math.PI;
    pin.position.y = GROUND_TOP + 10 * vScale;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(2.2 * scale, 14, 10), mat);
    ball.position.y = GROUND_TOP + 14.5 * vScale;
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff5a3c,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    });
    ringMat.clippingPlanes = this.clipPlanes;
    const ring = new THREE.Mesh(new THREE.RingGeometry(3 * scale, 4.2 * scale, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = GROUND_TOP + 0.006;
    group.add(pin, ball, ring);
    group.name = 'address-marker';
    this.marker = group;
    return group;
  }

  applyClimate(climate) {
    for (const mat of this.materials) {
      const u = mat.userData?.uniforms;
      if (u) {
        u.uNightLights.value = climate.night;
        u.uWet.value = climate.wetness;
        u.uSnowCover.value = climate.snowCover;
      }
    }
    if (this.roadMaterial) {
      this.roadMaterial.roughness = THREE.MathUtils.lerp(0.78, 0.16, climate.wetness);
      this.roadMaterial.metalness = THREE.MathUtils.lerp(0.0, 0.35, climate.wetness);
      this.roadMaterial.color
        .set(0x5e5c59)
        .lerp(new THREE.Color(0x24262b), climate.wetness)
        .lerp(new THREE.Color(0xe8ecf2), climate.snowCover * 0.9);
    }
    if (this.leafMaterial) {
      this.leafMaterial.color
        .set(0x4f7a3a)
        .lerp(new THREE.Color(0xdfe6ee), climate.snowCover * 0.6);
    }
    // Street lights come on at dusk and are dimmed by fog and heavy rain,
    // which is also when their glow spreads furthest.
    const lampLevel = climate.night * 0.9 + Math.min(climate.groundFog, 0.4) * 0.2;
    if (this.lampMaterial) {
      this.lampMaterial.opacity = THREE.MathUtils.clamp(lampLevel, 0, 1) * (0.55 + climate.wetness * 0.45);
      if (this.lamps) this.lamps.visible = this.lampMaterial.opacity > 0.01;
    }
    if (this.bulbMaterial) {
      this.bulbMaterial.opacity = THREE.MathUtils.clamp(lampLevel * 1.1, 0, 1);
      if (this.bulbs) this.bulbs.visible = this.bulbMaterial.opacity > 0.01;
    }
    if (this.marker) {
      this.marker.visible = true;
    }
  }
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}
