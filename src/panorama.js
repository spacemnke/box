// Loads the five Street View faces that wrap the inside of the cube.
// The top face is deliberately not photographed: the sky is simulated, so it
// can actually change with the weather.

import * as THREE from 'three';
import { streetViewMetadata, streetViewImageURL, loadImage } from './data.js';

const SIDE_FACES = [
  { name: 'north', heading: 0, pitch: 0 },
  { name: 'east', heading: 90, pitch: 0 },
  { name: 'south', heading: 180, pitch: 0 },
  { name: 'west', heading: 270, pitch: 0 },
  { name: 'down', heading: 0, pitch: -90 },
];

/**
 * @param {number} lat
 * @param {number} lon
 * @param {string} key      Google Maps Platform API key (browser key)
 * @param {object} options  { size, radius, headingOffset, onProgress }
 */
export async function loadStreetViewCube(lat, lon, key, options = {}) {
  const { size = 640, radius = 60, headingOffset = 0, onProgress = () => {} } = options;

  onProgress({ stage: 'metadata', done: 0, total: SIDE_FACES.length + 1 });
  const meta = await streetViewMetadata(lat, lon, key, radius);

  const textures = {};
  let done = 1;

  for (const face of SIDE_FACES) {
    const url = streetViewImageURL({
      panoId: meta.panoId,
      heading: face.heading + headingOffset,
      pitch: face.pitch,
      size,
      key,
      fov: 90,
    });
    const img = await loadImage(url);
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    textures[face.name] = tex;

    done++;
    onProgress({ stage: face.name, done, total: SIDE_FACES.length + 1 });
  }

  return { meta, textures };
}
