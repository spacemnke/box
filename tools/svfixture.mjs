// Stand-in Street View panels for the offline smoke test.
// Each panel is labelled with the direction it faces and with what should sit
// on its left and right edges, which is how the cube's orientation is checked.

const NEIGHBOURS = {
  0: ['W', 'N', 'E'],
  90: ['N', 'E', 'S'],
  180: ['E', 'S', 'W'],
  270: ['S', 'W', 'N'],
};

const HUE = { 0: 205, 90: 25, 180: 130, 270: 285 };

export function panelSVG({ heading, pitch }) {
  const size = 640;
  if (Number(pitch) === -90) {
    // The road surface under the camera.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" fill="#4a4a4c"/>
      <rect x="300" y="0" width="40" height="${size}" fill="#c9c4a8"/>
      <circle cx="320" cy="320" r="60" fill="#5a5a5d"/>
      <text x="320" y="120" font-family="sans-serif" font-size="46" fill="#e8e8ea"
            text-anchor="middle">GROUND</text>
    </svg>`;
  }

  const h = Number(heading) % 360;
  const [left, centre, right] = NEIGHBOURS[h] || ['?', '?', '?'];
  const hue = HUE[h] ?? 0;

  // A sky band, a skyline of blocks, and big edge labels.
  const blocks = [];
  for (let i = 0; i < 7; i++) {
    const x = i * 92;
    const top = 170 + ((i * 53) % 130);
    blocks.push(
      `<rect x="${x}" y="${top}" width="84" height="${size - top - 90}" fill="hsl(${hue},18%,${38 + (i % 3) * 7}%)"/>`
    );
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        blocks.push(
          `<rect x="${x + 12 + c * 24}" y="${top + 22 + r * 46}" width="15" height="28" fill="hsl(${hue},22%,${62 + ((i + r + c) % 3) * 9}%)"/>`
        );
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7fb2e8"/><stop offset="100%" stop-color="#cfe2f3"/>
    </linearGradient></defs>
    <rect width="${size}" height="${size}" fill="url(#sky)"/>
    ${blocks.join('')}
    <rect x="0" y="${size - 90}" width="${size}" height="90" fill="#4a4a4c"/>
    <text x="320" y="100" font-family="sans-serif" font-size="86" font-weight="700"
          fill="#12202e" text-anchor="middle">${centre}</text>
    <text x="18" y="330" font-family="sans-serif" font-size="40" font-weight="700"
          fill="#12202e" text-anchor="start">&#8592;${left}</text>
    <text x="622" y="330" font-family="sans-serif" font-size="40" font-weight="700"
          fill="#12202e" text-anchor="end">${right}&#8594;</text>
    <text x="320" y="${size - 30}" font-family="sans-serif" font-size="34"
          fill="#e8e8ea" text-anchor="middle">heading ${h}</text>
  </svg>`;
}

export const METADATA = {
  status: 'OK',
  pano_id: 'TEST_PANO',
  location: { lat: 39.4739, lng: -0.3742 },
  date: '2025-04',
  copyright: '© Test imagery',
};
