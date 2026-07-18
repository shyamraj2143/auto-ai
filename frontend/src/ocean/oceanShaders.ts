export const OCEAN_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const OCEAN_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_time;
uniform float u_dive_progress;
uniform float u_expansion_progress;
uniform float u_surface_cross_progress;
uniform float u_depth;
uniform float u_mode;
uniform float u_reactivity;
uniform float u_quality;
uniform vec3 u_deep_color;
uniform vec3 u_mid_color;
uniform vec3 u_cyan_color;
uniform vec3 u_violet_color;

out vec4 out_color;

const float PI = 3.14159265;
const float TAU = 6.28318530;

mat2 rotate2d(float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return mat2(cosine, -sine, sine, cosine);
}

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32);
  return fract(point.x * point.y);
}

float noise2d(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  local = local * local * (3.0 - 2.0 * local);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
}

float layeredNoise(vec2 point) {
  float value = 0.0;
  float amplitude = 0.52;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int index = 0; index < 3; index++) {
    value += noise2d(point) * amplitude;
    point = turn * point * 2.03 + 7.17;
    amplitude *= mix(0.38, 0.48, u_quality);
  }
  return value;
}

float causticCells(vec2 point, float time) {
  vec2 field = point;
  float sum = 0.0;
  for (int index = 0; index < 2; index++) {
    float layer = float(index);
    field = rotate2d(0.58 + layer * 0.31) * field * (1.34 + layer * 0.08);
    field += vec2(
      time * (0.095 + layer * 0.016),
      -time * (0.072 + layer * 0.012)
    );
    vec2 warped = field + vec2(
      sin(field.y * 2.2 + time * 0.08),
      cos(field.x * 2.0 - time * 0.07)
    ) * 0.23;
    vec2 lattice = sin(
      warped * vec2(5.1, 5.7)
      + vec2(cos(warped.y * 1.8), sin(warped.x * 1.9))
    );
    float ridge = abs(lattice.x + lattice.y);
    sum += pow(max(0.0, 1.0 - ridge * 0.62), 3.2);
  }
  return sum * 0.5;
}

float liquidRibbons(vec2 point, float time) {
  vec2 field = point;
  float ribbons = 0.0;
  for (int index = 0; index < 2; index++) {
    float layer = float(index);
    float sweep = sin(
      field.x * (6.0 + layer * 2.2)
      + sin(field.y * 3.4 + time * (0.26 + layer * 0.08))
      + time * (0.42 - layer * 0.08)
    );
    float ridge = 1.0 - smoothstep(0.0, 0.62, abs(sweep));
    ribbons += pow(ridge, 3.5) * (0.62 - layer * 0.14);
    field = rotate2d(0.72 + layer * 0.3) * field * 1.55 + vec2(2.7, -1.4);
  }
  return ribbons * 0.55;
}

float easeInOut(float value) {
  return value < 0.5
    ? 4.0 * value * value * value
    : 1.0 - pow(-2.0 * value + 2.0, 3.0) * 0.5;
}

float bubbleTunnel(vec2 uv, float aspect, float time) {
  vec2 centered = uv - 0.5;
  centered.x *= aspect;
  float radial = length(centered);
  float angular = atan(centered.y, centered.x) / TAU + 0.5;
  float travel = time * mix(0.82, 1.35, u_depth);
  vec2 grid = vec2(angular * 32.0, radial * 22.0 - travel);
  vec2 cell = floor(grid);
  vec2 local = fract(grid) - 0.5;
  float seed = hash21(cell);
  local += vec2(hash21(cell + 3.7), hash21(cell + 8.1)) * 0.62 - 0.31;
  float speck = 1.0 - smoothstep(0.055, 0.19, length(local));
  float ring = 1.0 - smoothstep(0.025, 0.075, abs(length(local) - 0.13));
  float sparse = smoothstep(mix(0.86, 0.76, u_quality), 0.99, seed);
  float radialMask = smoothstep(0.07, 0.22, radial) * (1.0 - smoothstep(0.62, 1.05, radial));
  return max(speck * 0.72, ring * 0.42) * sparse * radialMask;
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 point = uv - u_center;
  point.x *= aspect;
  point += u_pointer * mix(1.0, 0.36, u_mode);
  point /= max(u_radius, 0.2);

  float expansionEase = easeInOut(u_expansion_progress);
  point *= mix(1.0, 0.34, expansionEase);
  float radius = length(point);
  float outerMask = 1.0 - smoothstep(0.16, 1.38, radius);
  float innerMask = 1.0 - smoothstep(0.10, 0.52, radius);
  float divePulse = sin(PI * clamp(u_dive_progress, 0.0, 1.0));
  float ambientMotion = mix(1.0, 0.52, u_mode);
  float ambientTime = u_time * ambientMotion;
  float speed = mix(0.23, 0.085, u_mode) * mix(1.0, 1.12, u_reactivity);
  speed *= 1.0 + divePulse * 2.15;
  float clockwise = ambientTime * speed * (0.92 + outerMask * 0.36);
  float counterCurrent = ambientTime * speed * 1.68 * innerMask;
  vec2 flow = rotate2d(clockwise - counterCurrent) * point;
  flow *= mix(1.0, 0.58, expansionEase);

  float refractionDirection = mix(1.0, -0.62, u_surface_cross_progress);
  vec2 drift = vec2(
    layeredNoise(flow * 2.2 + vec2(ambientTime * 0.032 * refractionDirection, -ambientTime * 0.024)),
    layeredNoise(flow * 2.2 + vec2(11.7, -4.3) - ambientTime * 0.021 * refractionDirection)
  ) - 0.5;
  float surfaceEnvelope = sin(PI * clamp(u_surface_cross_progress, 0.0, 1.0));
  vec2 surfaceRefraction = vec2(
    sin(uv.y * 31.0 + u_time * 0.8),
    cos(uv.x * 27.0 - u_time * 0.65)
  ) * surfaceEnvelope * 0.035;
  vec2 waterField = flow + drift * mix(0.16, 0.23, u_quality) + surfaceRefraction;
  float broadCurrent = noise2d(
    waterField * 1.55 + drift * 0.9 + vec2(-ambientTime * 0.036, ambientTime * 0.026)
  );
  float flowBand = smoothstep(0.38, 0.88, broadCurrent) * outerMask;
  float caustics = causticCells(waterField * 2.8, ambientTime * (2.25 + divePulse * 1.4)) * outerMask;
  caustics *= mix(0.62, 1.08, broadCurrent);
  float ribbonField = liquidRibbons(waterField * 1.35, ambientTime * 1.15) * outerMask;
  float glintField = pow(
    max(0.0, 1.0 - abs(sin((waterField.x - waterField.y) * 13.0 + ambientTime * 0.9 + broadCurrent * 3.0)) * 1.1),
    4.0
  ) * outerMask;
  float crystalTrace = pow(
    max(0.0, 1.0 - abs(sin((waterField.x + waterField.y) * 17.0 + broadCurrent * 2.4)) * 5.1),
    3.0
  ) * caustics;

  float verticalDepth = smoothstep(0.0, 1.0, uv.y);
  vec3 color = mix(
    u_deep_color,
    u_mid_color,
    0.15 + verticalDepth * 0.18 + broadCurrent * 0.11 + flowBand * 0.035
  );
  color += u_cyan_color * caustics * mix(0.10, 0.17, u_quality) * (1.0 + divePulse * 0.72);
  color += mix(u_cyan_color, u_violet_color, 0.44 + broadCurrent * 0.32)
    * ribbonField
    * mix(0.018, 0.052, u_quality)
    * (1.0 + surfaceEnvelope * 0.7 + u_depth * 0.45);
  color += u_cyan_color * glintField * mix(0.006, 0.022, u_quality) * (1.0 + divePulse * 0.9);
  color += u_violet_color * crystalTrace * 0.042;
  color += mix(u_cyan_color, u_violet_color, broadCurrent) * flowBand * 0.018;

  float fresnel = smoothstep(0.20, 1.12, radius) * outerMask;
  color += mix(u_cyan_color, u_violet_color, broadCurrent) * fresnel * 0.012;

  float primeProgress = smoothstep(0.0, 0.105, u_dive_progress);
  float primeEnvelope = 1.0 - smoothstep(0.08, 0.18, u_dive_progress);
  float pressureWave = exp(-pow((radius - primeProgress * 0.92) * 10.0, 2.0)) * primeEnvelope;
  color += u_cyan_color * pressureWave * 0.10;

  float expansionEnvelope = sin(PI * clamp(u_expansion_progress, 0.0, 1.0));
  float expansionLens = exp(-pow((radius - mix(0.18, 0.82, expansionEase)) * 2.35, 2.0));
  color += mix(u_mid_color, u_cyan_color, 0.72) * expansionLens * expansionEnvelope * 0.14;

  float surfaceY = mix(0.24, 1.14, u_surface_cross_progress);
  float surfaceBand = exp(-pow((uv.y - surfaceY) * 15.0, 2.0)) * surfaceEnvelope;
  color += u_cyan_color * surfaceBand * 0.17;
  color += u_violet_color * surfaceBand * abs(uv.x - 0.5) * 0.055;

  float shaft = pow(max(0.0, sin((uv.x + drift.x * 0.08) * 18.0 + 0.45)), 9.0);
  shaft *= smoothstep(0.04, 0.92, uv.y) * (surfaceEnvelope * 0.8 + u_depth * 0.65 + u_mode * 0.24);
  color += u_cyan_color * shaft * 0.048;

  float tunnelEnvelope = smoothstep(0.24, 0.43, u_dive_progress)
    * (1.0 - smoothstep(0.79, 0.98, u_dive_progress));
  float bubbles = bubbleTunnel(uv, aspect, u_time);
  vec2 screenPoint = (uv - 0.5) * vec2(aspect, 1.0);
  float screenRadius = length(screenPoint);
  float screenAngle = atan(screenPoint.y, screenPoint.x);
  float radialStreaks = pow(max(0.0, sin(screenAngle * 23.0 + broadCurrent * 5.0)), 14.0);
  radialStreaks *= smoothstep(0.12, 0.75, screenRadius) * (1.0 - smoothstep(0.78, 1.18, screenRadius));
  float tunnelHaze = exp(-pow((screenRadius - 0.34) * 3.6, 2.0)) * tunnelEnvelope;
  color += u_cyan_color * bubbles * tunnelEnvelope * 0.42;
  color += mix(u_cyan_color, u_violet_color, broadCurrent) * radialStreaks * tunnelEnvelope * 0.11;
  color += u_cyan_color * tunnelHaze * 0.035;

  float edgePrism = pow(abs(uv.x - 0.5) * 2.0, 3.0) * surfaceEnvelope;
  color += mix(u_cyan_color, u_violet_color, step(0.5, uv.x)) * edgePrism * 0.035;
  color = mix(color, u_deep_color, u_depth * 0.48);

  float homeCopyMask = (1.0 - smoothstep(0.24, 0.58, uv.x)) * smoothstep(0.02, 0.28, uv.y);
  float homePreviewMask = smoothstep(0.47, 0.72, uv.x) * smoothstep(0.08, 0.34, uv.y);
  float authFormMask = smoothstep(0.46, 0.76, uv.x) * smoothstep(0.02, 0.30, uv.y);
  float contentMask = mix(max(homeCopyMask, homePreviewMask), authFormMask, u_mode);
  float contentProtection = 1.0 - smoothstep(0.05, 0.28, u_dive_progress);
  color = mix(color, u_deep_color, contentMask * mix(0.48, 0.62, u_mode) * contentProtection);

  vec2 edgePoint = (uv - 0.5) * vec2(0.84, 1.0);
  float vignette = smoothstep(0.30, 0.72, length(edgePoint));
  color = mix(color, u_deep_color, vignette * mix(0.38, 0.52, u_depth));
  out_color = vec4(color, 1.0);
}
`;
