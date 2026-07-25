// sRGB <-> CIE Lab (D65), plus hex helpers.
// Lab is used everywhere in the pipeline: clustering on (a,b) only, and
// recoloring by keeping each pixel's own L.

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function f(t) {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function finv(t) {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
}

// r,g,b in 0..255 -> [L, a, b]
export function rgbToLab(r, g, b) {
  const rl = LINEAR[r], gl = LINEAR[g], bl = LINEAR[b];
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / Xn;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / Yn;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / Zn;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function encode(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// [L, a, b] -> r,g,b in 0..255 (clamped into gamut)
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = finv(fx) * Xn, y = finv(fy) * Yn, z = finv(fz) * Zn;
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [encode(rl), encode(gl), encode(bl)];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function isValidHex(hex) {
  return hexToRgb(hex) !== null;
}

export function labToHex(L, a, b) {
  return rgbToHex(...labToRgb(L, a, b));
}

export function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToLab(rgb[0], rgb[1], rgb[2]) : null;
}
