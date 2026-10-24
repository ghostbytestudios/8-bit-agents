/**
 * Full-screen pass that turns the low-res render into "8-bit" pixels:
 * depth outlines → normal-edge highlights → ordered dithering → palette snap.
 */
export const POST_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const POST_FRAGMENT = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tPalette;
uniform vec2 resolution;
uniform float depthRange;
uniform float outlineThreshold;
uniform float normalEdgeStrength;
uniform float ditherStrength;
uniform float usePalette;
uniform float useOutline;
uniform float useDither;
varying vec2 vUv;

float depthAt(vec2 uv) { return texture2D(tDepth, uv).r; }
vec3 normalAt(vec2 uv) { return texture2D(tNormal, uv).rgb * 2.0 - 1.0; }

// Classic 4x4 Bayer matrix built from the recursive 2x2 form; returns [0, 1).
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 nearestPaletteColor(vec3 color) {
  vec3 best = color;
  float bestDistance = 1e9;
  for (int i = 0; i < PALETTE_SIZE; i++) {
    vec3 candidate = texture2D(tPalette, vec2((float(i) + 0.5) / float(PALETTE_SIZE), 0.5)).rgb;
    vec3 diff = color - candidate;
    // Luma-weighted distance keeps perceived brightness stable.
    float distance = dot(diff * diff, vec3(0.299, 0.587, 0.114));
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  }
  return best;
}

void main() {
  vec2 texel = 1.0 / resolution;
  vec3 color = texture2D(tColor, vUv).rgb;

  if (useOutline > 0.5) {
    float depth = depthAt(vUv);
    float up = depthAt(vUv + vec2(0.0, texel.y));
    float down = depthAt(vUv - vec2(0.0, texel.y));
    float left = depthAt(vUv - vec2(texel.x, 0.0));
    float right = depthAt(vUv + vec2(texel.x, 0.0));

    // Outline the *nearer* side of a depth jump so silhouettes get a 1px border.
    float farthestNeighbor = max(max(up, down), max(left, right));
    float isOutline = step(outlineThreshold, (farthestNeighbor - depth) * depthRange);

    // One-sided normal comparison gives 1px highlights on creases (box edges, desk tops).
    vec3 normal = normalAt(vUv);
    float crease = (1.0 - dot(normal, normalAt(vUv + vec2(0.0, texel.y))))
                 + (1.0 - dot(normal, normalAt(vUv + vec2(texel.x, 0.0))));
    float sameSurface = step(abs(up - depth) * depthRange, outlineThreshold);
    float highlight = step(0.25, crease) * sameSurface * (1.0 - isOutline);

    color = mix(color, color * 1.6 + 0.02, highlight * normalEdgeStrength);
    color = mix(color, color * 0.18, isOutline);
  }

  vec3 srgb = linearToSrgb(clamp(color, 0.0, 1.0));

  if (usePalette > 0.5) {
    if (useDither > 0.5) {
      srgb += (bayer4(gl_FragCoord.xy) - 0.5) * ditherStrength;
    }
    srgb = nearestPaletteColor(srgb);
  }

  gl_FragColor = vec4(srgb, 1.0);
}
`;
