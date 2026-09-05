// Shared GLSL. The sky is written once and reused by the skybox, by the
// Street View faces (so photographed sky can be replaced by simulated sky) and
// by the glass shell's reflections.

export const NOISE = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float total = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 6; i++) {
      total += valueNoise(p) * amp;
      p = p * 2.03 + vec2(17.3, 9.1);
      amp *= 0.5;
    }
    return total;
  }

  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

// Uniform block shared by every shader that draws sky.
export const SKY_UNIFORMS = /* glsl */ `
  uniform vec3  uSunDir;        // normalised, world space
  uniform vec3  uMoonDir;
  uniform vec3  uSunColor;
  uniform vec3  uZenith;
  uniform vec3  uHorizon;
  uniform vec3  uGroundHaze;
  uniform float uSunAltitude;   // radians, negative below horizon
  uniform float uMoonPhase;
  uniform float uCloudCover;    // 0..1
  uniform float uCloudDark;     // 0..1 storm darkening
  uniform float uCloudHeight;
  uniform float uTime;
  uniform vec2  uWind;          // metres/second, world XZ
  uniform float uNight;         // 0 = full day, 1 = full night
  uniform float uHaze;          // 0..1, from visibility
  uniform float uFlash;         // lightning
  uniform float uExposure;
`;

export const SKY_FUNCTION = /* glsl */ `
  // Two-layer animated cloud deck projected onto a plane above the viewer.
  float cloudField(vec3 dir, float height, float scale, float t) {
    float y = max(dir.y, 0.015);
    // Dividing by deck height spreads a higher layer over a wider footprint.
    vec2 uv = (dir.xz / y) * (scale / max(height, 0.05)) + uWind * t * 0.004;
    float base = fbm(uv);
    float detail = fbm(uv * 2.7 + vec2(t * 0.01, -t * 0.007));
    float d = base * 0.72 + detail * 0.28;
    // Coverage remaps the noise so 0 gives an empty sky and 1 a solid deck.
    float threshold = mix(0.78, 0.22, uCloudCover);
    float softness = mix(0.16, 0.30, uCloudCover);
    float c = smoothstep(threshold, threshold + softness, d);
    // Fade the deck out towards the horizon so it reads as a ceiling.
    return c * smoothstep(0.0, 0.16, dir.y);
  }

  // Stars are placed in cells on a sphere around the viewer, so they stay
  // round and evenly spread instead of smearing towards the horizon.
  vec3 starField(vec3 dir) {
    vec3 total = vec3(0.0);
    for (int layer = 0; layer < 2; layer++) {
      float density = layer == 0 ? 58.0 : 97.0;
      vec3 s = dir * density + float(layer) * 11.3;
      vec3 cell = floor(s);
      vec3 f = fract(s) - 0.5;
      float rnd = hash31(cell);
      float present = step(0.976, rnd);
      float dot_ = smoothstep(0.34, 0.02, length(f));
      float mag = pow(hash31(cell + 3.7), 3.5);
      float twinkle = 0.65 + 0.35 * sin(uTime * 1.7 + rnd * 60.0);
      // Faint colour variation keeps a starfield from looking printed on.
      vec3 tint = mix(vec3(0.78, 0.86, 1.0), vec3(1.0, 0.92, 0.80), hash31(cell + 9.1));
      total += tint * present * dot_ * mag * twinkle * 2.2;
    }
    return total;
  }

  vec3 skyColor(vec3 dir) {
    dir = normalize(dir);
    float up = clamp(dir.y, -1.0, 1.0);

    // Base gradient: zenith to horizon, and a hazy ground half below.
    vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 1.0, max(up, 0.0)));
    col = mix(uGroundHaze, col, smoothstep(-0.25, 0.05, up));

    // Stars and moon, only once the sun is properly down.
    if (uNight > 0.01) {
      col += starField(dir) * uNight * smoothstep(0.0, 0.1, up);
      float moonDot = dot(dir, uMoonDir);
      float moonDisc = smoothstep(0.99955, 0.99985, moonDot);
      float moonGlow = pow(max(moonDot, 0.0), 900.0) * 0.35;
      col += (vec3(0.95, 0.95, 0.88) * moonDisc * (0.35 + 0.65 * uMoonPhase)
              + vec3(0.5, 0.55, 0.7) * moonGlow) * uNight;
    }

    // Sun disc plus forward scattering halo.
    float sunDot = dot(dir, uSunDir);
    float disc = smoothstep(0.99965, 0.99990, sunDot);
    float halo = pow(max(sunDot, 0.0), 120.0) * 0.55
               + pow(max(sunDot, 0.0), 8.0) * 0.16;
    float sunUp = smoothstep(-0.12, 0.06, uSunDir.y);
    col += uSunColor * (disc * 12.0 + halo) * sunUp * (1.0 - uCloudCover * 0.75);

    // Clouds.
    float deck = cloudField(dir, uCloudHeight, 0.55, uTime);
    float high = cloudField(dir, uCloudHeight * 2.2, 0.22, uTime * 0.6) * 0.5;
    float cloud = clamp(deck + high * (1.0 - deck), 0.0, 1.0);

    float sunSide = clamp(dot(normalize(dir + uSunDir * 0.35), uSunDir), 0.0, 1.0);
    vec3 cloudLit = mix(vec3(0.62, 0.66, 0.72), uSunColor * 1.15, sunSide * sunUp);
    vec3 cloudBase = mix(vec3(0.30, 0.32, 0.36), cloudLit, 0.55);
    vec3 cloudCol = mix(cloudBase, cloudLit, pow(sunSide, 2.0));
    cloudCol = mix(cloudCol, cloudCol * vec3(0.28, 0.30, 0.35), uCloudDark);
    cloudCol = mix(cloudCol, cloudCol * 0.12 + vec3(0.02, 0.025, 0.05), uNight);

    col = mix(col, cloudCol, cloud * 0.94);

    // Haze / fog washes the whole dome out near the horizon first.
    vec3 hazeCol = mix(uHorizon, vec3(0.72, 0.74, 0.77), 0.35);
    hazeCol = mix(hazeCol, hazeCol * 0.16, uNight);
    col = mix(col, hazeCol, uHaze * 0.75 * (0.30 + 0.70 * (1.0 - smoothstep(0.0, 0.5, up))));

    // Lightning lights the cloud base from within.
    col += vec3(0.85, 0.88, 1.0) * uFlash * (0.35 + cloud * 1.2);

    return col;
  }
`;

/* ------------------------------------------------------------------ */
/* Street View face shader                                             */
/* ------------------------------------------------------------------ */

export const PHOTO_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const PHOTO_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uMap;
  uniform float uIsGround;     // 1.0 for the downward face
  uniform float uWet;          // 0..1 surface wetness
  uniform float uSnow;         // 0..1 lying snow
  uniform float uFogAmount;    // 0..1
  uniform vec3  uFogColor;
  uniform float uSkyReplace;   // 0..1 how strongly photographed sky is restyled
  uniform float uWindow;       // night window/lamp glow strength
  uniform float uHasMap;
  uniform float uRipple;       // rain ripples on the ground face
  uniform float uSnowFlecks;

  varying vec3 vWorldPos;
  varying vec2 vUv;

  ${NOISE}
  ${SKY_UNIFORMS}
  ${SKY_FUNCTION}

  vec3 saturate3(vec3 c, float amount) {
    float l = luma(c);
    return mix(vec3(l), c, amount);
  }

  void main() {
    vec3 dir = normalize(vWorldPos);
    vec3 photo = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : vec3(0.42, 0.44, 0.47);

    // ---- how much of this pixel is sky? -------------------------------
    // Sky pixels in a street photo are bright, blue-leaning and above the
    // horizon. That is enough to swap in a simulated sky convincingly.
    float blueness = photo.b - max(photo.r, photo.g);
    float bright = luma(photo);
    // Deliberately strict: a cream facade in sunlight is bright and slightly
    // blue too, and restyling one looks far worse than leaving real sky alone.
    float skyish = smoothstep(0.045, 0.19, blueness) * smoothstep(0.50, 0.78, bright);
    float blownOut = smoothstep(0.88, 0.98, bright) * smoothstep(0.10, 0.35, dir.y);
    float mask = clamp(max(skyish, blownOut), 0.0, 1.0);
    mask *= smoothstep(0.02, 0.34, dir.y);       // only well above the horizon
    mask *= (1.0 - uIsGround);

    vec3 simSky = skyColor(dir);
    vec3 col = mix(photo, simSky, mask * uSkyReplace);

    // ---- relight the photograph ---------------------------------------
    float sunUp = smoothstep(-0.10, 0.15, uSunDir.y);
    vec3 dayTint = mix(vec3(0.80, 0.84, 0.95), uSunColor, sunUp * (1.0 - uCloudCover * 0.6));
    vec3 lit = col * mix(vec3(1.0), dayTint, 0.55);

    // Overcast flattens contrast and cools everything down.
    lit = mix(lit, saturate3(lit, 0.72) * 0.86, uCloudCover * 0.55);

    // Night: crush the photo, then let the brightest pixels — lamps, shop
    // fronts, lit windows — glow back through.
    float l = luma(col);
    vec3 nightBase = saturate3(col, 0.45) * vec3(0.16, 0.19, 0.30);
    float lampMask = smoothstep(0.55, 0.92, l);
    vec3 lamps = mix(vec3(1.0, 0.78, 0.45), vec3(1.0, 0.95, 0.85), smoothstep(0.8, 1.0, l));
    nightBase += lamps * lampMask * uWindow;
    lit = mix(lit, nightBase, uNight * (1.0 - mask * uSkyReplace * 0.85));

    // ---- wet surfaces ---------------------------------------------------
    // Rain darkens and saturates what it lands on, and the ground most of all.
    float wetWeight = uWet * mix(0.45, 1.0, uIsGround);
    float lowFrame = 1.0 - smoothstep(-0.55, 0.05, dir.y);
    wetWeight *= mix(0.5, 1.0, max(lowFrame, uIsGround));
    lit = mix(lit, saturate3(lit, 1.25) * 0.62, wetWeight * 0.7);

    if (uIsGround > 0.5 && uRipple > 0.001) {
      // Concentric ripples from scattered impact points.
      vec2 p = vUv * 18.0;
      float r = 0.0;
      for (int i = 0; i < 3; i++) {
        vec2 cell = floor(p) + float(i) * 3.17;
        vec2 f = fract(p) - 0.5;
        float seed = hash21(cell);
        float phase = fract(uTime * 1.6 + seed);
        float radius = phase * 0.62;
        float ring = smoothstep(radius, radius - 0.10, length(f))
                   * smoothstep(radius - 0.20, radius - 0.10, length(f));
        r += ring * (1.0 - phase);
        p *= 1.31;
      }
      lit += vec3(0.55, 0.62, 0.72) * r * uRipple * 0.35;
    }

    // ---- lying snow ------------------------------------------------------
    if (uSnow > 0.001) {
      float snowMask = uIsGround > 0.5
        ? 1.0
        : (1.0 - smoothstep(-0.6, -0.1, dir.y)) * 0.55;
      float grain = 0.85 + 0.15 * valueNoise(vUv * 220.0);
      vec3 snowCol = mix(vec3(0.88, 0.91, 0.96), uSunColor * 1.05, sunUp * 0.35);
      snowCol = mix(snowCol, snowCol * vec3(0.30, 0.34, 0.48), uNight);
      lit = mix(lit, snowCol * grain, clamp(uSnow, 0.0, 1.0) * snowMask);
    }

    // Airborne snow and drizzle sitting between camera and wall.
    lit += vec3(0.9, 0.93, 1.0) * uSnowFlecks * 0.04;

    // ---- distance haze ----------------------------------------------------
    lit = mix(lit, uFogColor, clamp(uFogAmount, 0.0, 1.0));
    lit += vec3(0.85, 0.88, 1.0) * uFlash * 0.55;

    lit *= uExposure;

    gl_FragColor = vec4(lit, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Interior sky box (used behind the OSM model)                        */
/* ------------------------------------------------------------------ */

export const SKYBOX_VERT = PHOTO_VERT;

export const SKYBOX_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  uniform float uIsGround;
  uniform vec3  uFogColor;

  ${NOISE}
  ${SKY_UNIFORMS}
  ${SKY_FUNCTION}

  void main() {
    vec3 dir = normalize(vWorldPos);
    vec3 col = uIsGround > 0.5 ? uFogColor * 0.8 : skyColor(dir);

    // These walls are the far air *inside* the cube, under the cloud lid —
    // not open sky. Under a thick deck that air is much darker than the sky
    // above it, and it is darker still near the ground. Getting this wrong
    // washes the whole middle of the cube out and the rain disappears into it.
    float underDeck = mix(1.0, 0.26, uCloudCover) * mix(1.0, 0.55, uCloudDark);
    underDeck *= mix(0.62, 1.0, smoothstep(-0.55, 0.40, dir.y));
    col *= underDeck;

    col *= uExposure;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
