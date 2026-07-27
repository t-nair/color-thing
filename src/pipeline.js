// Classical-CV pipeline: background removal -> chrominance clustering ->
// mask cleanup -> lightness-preserving recolor. Deterministic, no model calls.

import { rgbToLab, labToRgb, labToHex, hexToLab, lToY, yToL } from './color.js';

// Everything (analysis and output) runs at this resolution so the label map and
// the pixels always line up -- no upsampling, no blocky region edges.
export const MAX_EDGE = 1600;

export const BG = -1; // label for background pixels

// How much high-pass lightness counts against chrominance when clustering.
// 0 reproduces the original chrominance-only behaviour.
const HP_WEIGHT = 0.8;

// Which lightness percentile within a region counts as "the colour of the
// garment". Lightness constancy means people read a surface's colour from its
// lit areas and discount shadow, so anchoring on the median made picks land
// visibly lighter than asked for. This is the one value that decides both the
// detected swatch and what the recolor engine matches.
const SURFACE_PERCENTILE = 0.75;

// --- deterministic RNG (same photo + same k => same clusters, every run) ---
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 6.2 Garment isolation
// ---------------------------------------------------------------------------

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < hist.length; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 0;
  for (let i = 0; i < hist.length; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const diff = sumB / wB - (sum - sumB) / wF;
    const between = wB * wF * diff * diff;
    if (between > best) { best = between; thr = i; }
  }
  return thr;
}

function percentile(values, p) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  if (!n) return 0;
  if (p <= 0) return a[0];
  if (p >= 1) return a[n - 1];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

const median = (values) => percentile(values, 0.5);

// Binary morphology with a square structuring element. A square is separable,
// so this runs as a horizontal pass then a vertical one -- O(r) per pixel
// instead of O(r^2).
function morph(mask, w, h, r, dilate) {
  const n = mask.length;
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);
  const want = dilate ? 1 : 0; // dilate looks for any 1; erode for any 0

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x1 = Math.min(w - 1, x + r);
      let found = 0;
      for (let xx = Math.max(0, x - r); xx <= x1; xx++) {
        if (mask[row + xx] === want) { found = 1; break; }
      }
      tmp[row + x] = found;
    }
  }
  for (let y = 0; y < h; y++) {
    const y1 = Math.min(h - 1, y + r), y0 = Math.max(0, y - r);
    for (let x = 0; x < w; x++) {
      let found = 0;
      for (let yy = y0; yy <= y1; yy++) {
        if (tmp[yy * w + x]) { found = 1; break; }
      }
      out[y * w + x] = dilate ? found : found ^ 1;
    }
  }
  return out;
}

const open = (m, w, h, r) => morph(morph(m, w, h, r, false), w, h, r, true);
const close = (m, w, h, r) => morph(morph(m, w, h, r, true), w, h, r, false);

// Label 4-connected components of a binary mask into `comp` (-1 elsewhere).
// Returns the size of each component id.
function components(mask, w, h, comp) {
  const n = mask.length;
  comp.fill(-1);
  const stack = new Int32Array(n);
  const sizes = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || comp[start] !== -1) continue;
    const id = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = start;
    comp[start] = id;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && comp[p - 1] === -1) { comp[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && comp[p + 1] === -1) { comp[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && comp[p - w] === -1) { comp[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && comp[p + w] === -1) { comp[p + w] = id; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
  return sizes;
}

function largestComponent(mask, w, h) {
  const comp = new Int32Array(mask.length);
  const sizes = components(mask, w, h, comp);
  let best = -1, bestSize = 0;
  sizes.forEach((s, id) => { if (s > bestSize) { bestSize = s; best = id; } });
  const out = new Uint8Array(mask.length);
  if (best >= 0) for (let i = 0; i < mask.length; i++) if (comp[i] === best) out[i] = 1;
  return out;
}

// Mean of `values` over a square window, counting masked-in pixels only.
// Separable with a sliding window, so cost is independent of radius.
function boxMean(values, mask, w, h, r) {
  const n = w * h;
  const hSum = new Float64Array(n);
  const hCnt = new Int32Array(n);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0, cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) {
      if (mask[row + x]) { sum += values[row + x]; cnt++; }
    }
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        const add = x + r, rem = x - r - 1;
        if (add < w && mask[row + add]) { sum += values[row + add]; cnt++; }
        if (rem >= 0 && mask[row + rem]) { sum -= values[row + rem]; cnt--; }
      }
      hSum[row + x] = sum; hCnt[row + x] = cnt;
    }
  }

  const out = new Float32Array(n);
  for (let x = 0; x < w; x++) {
    let sum = 0, cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) { sum += hSum[y * w + x]; cnt += hCnt[y * w + x]; }
    for (let y = 0; y < h; y++) {
      if (y > 0) {
        const add = y + r, rem = y - r - 1;
        if (add < h) { sum += hSum[add * w + x]; cnt += hCnt[add * w + x]; }
        if (rem >= 0) { sum -= hSum[rem * w + x]; cnt -= hCnt[rem * w + x]; }
      }
      const i = y * w + x;
      out[i] = cnt > 0 ? sum / cnt : values[i];
    }
  }
  return out;
}

// Sobel gradient magnitude over lightness.
function sobel(L, w, h) {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = L[i - w - 1], tc = L[i - w], tr = L[i - w + 1];
      const bl = L[i + w - 1], bc = L[i + w], br = L[i + w + 1];
      const gx = tr + 2 * L[i + 1] + br - tl - 2 * L[i - 1] - bl;
      const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
      g[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return g;
}

// Otsu threshold over an arbitrary float field, restricted to masked pixels.
function otsuOver(values, mask, w, h) {
  const n = w * h;
  const hist = new Uint32Array(64);
  let count = 0, max = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { count++; if (values[i] > max) max = values[i]; }
  if (!count || max <= 0) return Infinity;
  const scale = 63 / max;
  for (let i = 0; i < n; i++) if (mask[i]) hist[Math.min(63, (values[i] * scale) | 0)]++;
  return otsu(hist, count) / scale;
}

// Estimate background from a border band, then flood fill inward over pixels
// close to it. Flood filling (rather than a plain threshold) means dark areas
// *inside* the garment aren't mistaken for background.
function foregroundMask(lab, w, h) {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const Ls = [], as = [], bs = [];
  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= band && x < w - band) { x = w - band - 1; continue; }
      const i = y * w + x;
      Ls.push(lab.L[i]); as.push(lab.a[i]); bs.push(lab.b[i]);
    }
  }
  const bgL = median(Ls), bgA = median(as), bgB = median(bs);

  const n = w * h;
  const dist = new Float32Array(n);
  const hist = new Uint32Array(64);
  for (let i = 0; i < n; i++) {
    const dL = lab.L[i] - bgL, dA = lab.a[i] - bgA, dB = lab.b[i] - bgB;
    const d = Math.sqrt(dL * dL + dA * dA + dB * dB);
    dist[i] = d;
    hist[Math.min(63, d | 0)]++;
  }
  const base = Math.max(6, Math.min(40, otsu(hist, n)));

  // Flood fill background inward from the frame edge, so dark areas *inside*
  // the garment aren't mistaken for background.
  const flood = (thr) => {
    const bg = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    const push = (p) => { if (!bg[p] && dist[p] < thr) { bg[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    const m = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) { m[i] = bg[i] ? 0 : 1; count += m[i]; }
    return { mask: m, count };
  };

  // If a garment colour is close to the background, the fill can leak through
  // and swallow the garment. Falling back to tighter thresholds recovers it.
  let picked = null;
  for (const factor of [1, 0.6, 0.35]) {
    const attempt = flood(Math.max(4, base * factor));
    if (!picked || attempt.count > picked.count) picked = attempt;
    if (attempt.count >= n * 0.15) { picked = attempt; break; }
  }

  const r = Math.max(1, Math.round(Math.min(w, h) / 400));
  return largestComponent(close(open(picked.mask, w, h, r), w, h, r), w, h);
}

// ---------------------------------------------------------------------------
// On-model isolation: cut the person away and keep only the garment
// ---------------------------------------------------------------------------

// Skin hue window in the Lab a/b plane. Deliberately permissive on lightness and
// chroma: across skin tones melanin moves L and chroma far more than hue, so hue
// has to do the discriminating for this to work on everyone.
const SKIN_HUE_MIN = 15, SKIN_HUE_MAX = 70;

/**
 * Classify skin inside `person`. Colour alone is not enough -- beige, tan and
 * camel garments sit squarely in the skin gamut -- so smoothness carries equal
 * weight: fabric has stitch/weave texture, skin does not.
 * Returns null when the photo contains no meaningful amount of skin.
 */
function skinMask(lab, person, texture, textureThr, w, h) {
  const n = w * h;
  let personCount = 0;
  for (let i = 0; i < n; i++) personCount += person[i];

  const seed = new Uint8Array(n);
  let seedCount = 0;
  for (let i = 0; i < n; i++) {
    if (!person[i] || texture[i] > textureThr) continue;
    const a = lab.a[i], b = lab.b[i], L = lab.L[i];
    if (L < 12 || L > 96) continue;
    const chroma = Math.hypot(a, b);
    if (chroma < 6 || chroma > 60) continue;
    const hue = Math.atan2(b, a) * 180 / Math.PI;
    if (hue < SKIN_HUE_MIN || hue > SKIN_HUE_MAX) continue;
    seed[i] = 1; seedCount++;
  }
  if (seedCount < personCount * 0.02) return null;

  // Tighten onto this person's actual tone rather than trusting the fixed window.
  const Ls = [], as = [], bs = [];
  const stride = Math.max(1, Math.floor(seedCount / 5000));
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (seed[i] && s++ % stride === 0) { Ls.push(lab.L[i]); as.push(lab.a[i]); bs.push(lab.b[i]); }
  }
  const mL = median(Ls), mA = median(as), mB = median(bs);

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!person[i] || texture[i] > textureThr) continue;
    const dA = lab.a[i] - mA, dB = lab.b[i] - mB;
    if (Math.hypot(dA, dB) > 12) continue;
    if (Math.abs(lab.L[i] - mL) > 35) continue;
    out[i] = 1;
  }
  return out;
}

/**
 * Isolate the garment. In flat-lay mode that is just the foreground. In
 * on-model mode the model is cut away: skin classification decides what is
 * garment and what is body, while edges make the cut land on the real
 * neckline/cuff/hem and keep the garment from bleeding into hair or trousers.
 */
export function isolate(lab, w, h, onModel) {
  const person = foregroundMask(lab, w, h);
  if (!onModel) return { mask: person, warning: null };

  const n = w * h;
  const shortEdge = Math.min(w, h);
  const r = Math.max(1, Math.round(shortEdge / 400));

  const grad = sobel(lab.L, w, h);
  const texture = boxMean(grad, person, w, h, Math.max(2, Math.round(shortEdge * 0.012)));
  const textureThr = otsuOver(texture, person, w, h);

  const skin = skinMask(lab, person, texture, textureThr, w, h);
  if (!skin) return { mask: person, warning: null }; // no skin: same as flat-lay

  // Only the strongest edges are used as cuts, so ordinary fabric texture
  // doesn't shred the garment into fragments.
  const edgeThr = otsuOver(grad, person, w, h) * 1.6;

  const skinWide = morph(skin, w, h, r * 2, true);
  const candidate = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    candidate[i] = person[i] && !skinWide[i] && grad[i] < edgeThr ? 1 : 0;
  }

  // Largest surviving piece is the garment; hair, trousers and accessories are
  // now separate components.
  const picked = largestComponent(open(candidate, w, h, r), w, h);

  // Give back exactly what the cuts took -- dilating by the same radius the skin
  // mask was widened by -- but never back into skin.
  const allowed = new Uint8Array(n);
  for (let i = 0; i < n; i++) allowed[i] = person[i] && !skin[i] ? 1 : 0;

  let grown = morph(picked, w, h, r * 2, true);
  for (let i = 0; i < n; i++) grown[i] = grown[i] && allowed[i] ? 1 : 0;
  grown = close(grown, w, h, r);
  for (let i = 0; i < n; i++) grown[i] = grown[i] && allowed[i] ? 1 : 0;

  let count = 0, personCount = 0;
  for (let i = 0; i < n; i++) { count += grown[i]; personCount += person[i]; }
  if (count < personCount * 0.1) {
    // The skin detector ate the garment -- a smooth fabric in a skin tone.
    return {
      mask: person,
      warning: "Couldn't tell the garment apart from skin, so the whole subject is selected. This happens with beige and camel colours on a model.",
    };
  }
  return { mask: largestComponent(grown, w, h), warning: null };
}

// ---------------------------------------------------------------------------
// 6.3 Colour identification: k-means on chrominance plus high-pass lightness
// ---------------------------------------------------------------------------

// `feats` is an array of D equal-length feature columns. Returns k centroids,
// each a Float64Array of length D.
function kmeans(feats, k, seed = 12345) {
  const d = feats.length;
  const n = feats[0].length;
  const rand = rng(seed);
  const cent = Array.from({ length: k }, () => new Float64Array(d));

  const dist2 = (i, c) => {
    let sum = 0;
    for (let j = 0; j < d; j++) { const v = feats[j][i] - c[j]; sum += v * v; }
    return sum;
  };
  const seedAt = (c, i) => { for (let j = 0; j < d; j++) cent[c][j] = feats[j][i]; };

  // k-means++ seeding
  seedAt(0, Math.min(n - 1, (rand() * n) | 0));
  const best = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dd = dist2(i, cent[c - 1]);
      if (dd < best[i]) best[i] = dd;
      total += best[i];
    }
    let target = rand() * total, pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= best[i];
      if (target <= 0) { pick = i; break; }
    }
    seedAt(c, pick);
  }

  const assign = new Int32Array(n);
  for (let iter = 0; iter < 30; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = dist2(i, cent[c]);
        if (dd < bd) { bd = dd; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; moved++; }
    }
    const sums = Array.from({ length: k }, () => new Float64Array(d));
    const cnt = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      for (let j = 0; j < d; j++) sums[c][j] += feats[j][i];
      cnt[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] > 0) for (let j = 0; j < d; j++) cent[c][j] = sums[c][j] / cnt[c];
    }
    if (moved === 0) break;
  }
  return cent;
}

// Majority (modal) filter over the label map -- the multi-label equivalent of
// morphological opening/closing, and it can't leave gaps or overlaps.
// Separable, using a sliding window: horizontal per-label counts first, then a
// vertical sweep over those, so each pixel costs O(k) rather than O(k*r^2).
function despeckle(labels, w, h, k, r, passes = 2) {
  const n = labels.length;
  const hcount = new Uint16Array(n * k); // per-pixel label counts, row window
  const win = new Int32Array(k);
  let src = labels;

  for (let pass = 0; pass < passes; pass++) {
    hcount.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      win.fill(0);
      for (let x = 0; x <= Math.min(w - 1, r); x++) {
        const l = src[row + x];
        if (l !== BG) win[l]++;
      }
      for (let x = 0; x < w; x++) {
        if (x > 0) {
          const add = x + r, rem = x - r - 1;
          if (add < w) { const l = src[row + add]; if (l !== BG) win[l]++; }
          if (rem >= 0) { const l = src[row + rem]; if (l !== BG) win[l]--; }
        }
        const base = (row + x) * k;
        for (let c = 0; c < k; c++) hcount[base + c] = win[c];
      }
    }

    const out = new Int32Array(n);
    for (let x = 0; x < w; x++) {
      win.fill(0);
      for (let y = 0; y <= Math.min(h - 1, r); y++) {
        const base = (y * w + x) * k;
        for (let c = 0; c < k; c++) win[c] += hcount[base + c];
      }
      for (let y = 0; y < h; y++) {
        if (y > 0) {
          const add = y + r, rem = y - r - 1;
          if (add < h) { const b = (add * w + x) * k; for (let c = 0; c < k; c++) win[c] += hcount[b + c]; }
          if (rem >= 0) { const b = (rem * w + x) * k; for (let c = 0; c < k; c++) win[c] -= hcount[b + c]; }
        }
        const i = y * w + x;
        if (src[i] === BG) { out[i] = BG; continue; }
        let bi = src[i], bc = -1;
        for (let c = 0; c < k; c++) if (win[c] > bc) { bc = win[c]; bi = c; }
        out[i] = bi;
      }
    }
    src = out;
  }
  return src;
}

// Absorb connected components below minArea into whichever label surrounds them.
// The whole component is reassigned in one shot from a vote of its boundary
// neighbours: growing a fill front instead would bias toward whichever direction
// it scanned first and leave rectilinear staircase edges.
function dropSmallRegions(labels, w, h, k, minArea) {
  const n = labels.length;
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes = [];

  // Components here are same-label runs, so this can't reuse `components()`.
  for (let start = 0; start < n; start++) {
    if (labels[start] === BG || comp[start] !== -1) continue;
    const label = labels[start];
    const id = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = start; comp[start] = id;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && comp[p - 1] === -1 && labels[p - 1] === label) { comp[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && comp[p + 1] === -1 && labels[p + 1] === label) { comp[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && comp[p - w] === -1 && labels[p - w] === label) { comp[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && comp[p + w] === -1 && labels[p + w] === label) { comp[p + w] = id; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
  const small = sizes.map((s) => s < minArea);
  if (!small.some(Boolean)) return labels;

  // Tally the labels immediately outside each small component.
  const votes = new Int32Array(sizes.length * k);
  for (let i = 0; i < n; i++) {
    const id = comp[i];
    if (id === -1 || !small[id]) continue;
    const x = i % w, y = (i / w) | 0;
    const vote = (q) => {
      const qid = comp[q];
      if (qid === id) return;                       // inside the same component
      if (qid !== -1 && small[qid]) return;         // neighbour is also being absorbed
      const l = labels[q];
      if (l !== BG) votes[id * k + l]++;
    };
    if (x > 0) vote(i - 1);
    if (x < w - 1) vote(i + 1);
    if (y > 0) vote(i - w);
    if (y < h - 1) vote(i + w);
  }

  const winner = new Int32Array(sizes.length).fill(-1);
  for (let id = 0; id < sizes.length; id++) {
    if (!small[id]) continue;
    let bi = -1, bc = 0;
    for (let c = 0; c < k; c++) if (votes[id * k + c] > bc) { bc = votes[id * k + c]; bi = c; }
    winner[id] = bi; // -1 means no labelled neighbours; keep the original label
  }

  const out = Int32Array.from(labels);
  for (let i = 0; i < n; i++) {
    const id = comp[i];
    if (id !== -1 && small[id] && winner[id] >= 0) out[i] = winner[id];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse an ImageData: isolate the garment and split it into k colour regions.
 * Returns the label map, a feathered garment alpha, and per-region stats.
 */
export function analyze(imageData, k, { onModel = false } = {}) {
  const { width: w, height: h, data } = imageData;
  const n = w * h;

  const lab = { L: new Float32Array(n), a: new Float32Array(n), b: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const [L, A, B] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    lab.L[i] = L; lab.a[i] = A; lab.b[i] = B;
  }

  const { mask, warning } = isolate(lab, w, h, onModel);
  let garmentCount = 0;
  for (let i = 0; i < n; i++) garmentCount += mask[i];
  if (garmentCount < 200) {
    throw new Error(onModel
      ? "Couldn't find a garment in this photo. Try a shot where the garment fills more of the frame."
      : "Couldn't separate the garment from the background. Try a photo on a plainer background.");
  }

  // High-pass lightness: L minus its local average. Subtracting a *local* mean
  // strips the smooth lighting gradient -- the thing chrominance-only clustering
  // was protecting against -- while keeping the high-frequency contrast that
  // distinguishes tone-on-tone colours (gold yarn vs brown pattern, grey vs
  // charcoal). On a solid-colour garment this is ~0 everywhere, so flat-lay
  // behaviour is unchanged.
  const localL = boxMean(lab.L, mask, w, h, Math.max(4, Math.round(Math.min(w, h) * 0.05)));
  const hp = new Float32Array(n);
  for (let i = 0; i < n; i++) hp[i] = (lab.L[i] - localL[i]) * HP_WEIGHT;

  // Fit on a subsample; assign every garment pixel afterwards.
  const stride = Math.max(1, Math.floor(garmentCount / 20000));
  const sa = [], sb = [], sh = [];
  let seen = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (seen++ % stride === 0) { sa.push(lab.a[i]); sb.push(lab.b[i]); sh.push(hp[i]); }
  }
  const cent = kmeans([Float64Array.from(sa), Float64Array.from(sb), Float64Array.from(sh)], k);

  let labels = new Int32Array(n).fill(BG);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    let bi = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dx = lab.a[i] - cent[c][0], dy = lab.b[i] - cent[c][1], dz = hp[i] - cent[c][2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; bi = c; }
    }
    labels[i] = bi;
  }

  // 6.4 mask cleanup. Kept deliberately gentle: a wider window or a larger
  // minimum area erases fine patterns (lace holes, stitch detail) rather than
  // cleaning them.
  labels = despeckle(labels, w, h, k, 1, 1);
  labels = dropSmallRegions(labels, w, h, k, Math.max(12, Math.round(garmentCount * 0.0002)));

  // Per-region stats. The anchor lightness renders the swatch and is what the
  // recolor engine matches the pick to; anchor chroma is the reference it
  // scales saturation against. Both come from the same percentile so the
  // anchored pixel reproduces the picked colour exactly, not just its lightness.
  const byRegion = Array.from({ length: k }, () => ({ L: [], C: [], count: 0 }));
  const statStride = Math.max(1, Math.floor(garmentCount / 30000));
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l === BG) continue;
    const rec = byRegion[l];
    rec.count++;
    if (rec.count % statStride === 0 || rec.L.length < 100) {
      rec.L.push(lab.L[i]);
      rec.C.push(Math.hypot(lab.a[i], lab.b[i]));
    }
  }

  // Build regions largest-first, then remap the label map to match, so region
  // index 0 is always the dominant colour.
  const kept = [];
  for (let c = 0; c < k; c++) {
    if (byRegion[c].count === 0) continue; // collapsed cluster: drop it
    const anchorL = percentile(byRegion[c].L, SURFACE_PERCENTILE);
    kept.push({
      cluster: c,
      // High-pass lightness steers assignment only; the displayed colour is the
      // cluster's lit-surface lightness with its centroid chrominance (PRD 6.3).
      hex: labToHex(anchorL, cent[c][0], cent[c][1]),
      anchorL,
      anchorC: percentile(byRegion[c].C, SURFACE_PERCENTILE),
      a: cent[c][0],
      b: cent[c][1],
      count: byRegion[c].count,
    });
  }
  kept.sort((p, q) => q.count - p.count);

  const remap = new Int32Array(k).fill(BG);
  kept.forEach((reg, idx) => { remap[reg.cluster] = idx; });
  for (let i = 0; i < n; i++) if (labels[i] !== BG) labels[i] = remap[labels[i]];
  const regions = kept.map(({ cluster, ...rest }) => rest);

  // Feathered garment edge (3x3 box blur of the binary mask) for compositing.
  const alpha = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          sum += mask[yy * w + xx]; cnt++;
        }
      }
      alpha[y * w + x] = Math.round((sum / cnt) * 255);
    }
  }

  return { width: w, height: h, labels, alpha, regions, garmentCount, warning };
}

/**
 * 6.6 Recolor engine. Each pixel keeps its own lightness structure (folds,
 * shadows, stitching); a/b are replaced with the target colour, scaled by how
 * saturated that pixel was relative to its region so it isn't a flat fill.
 *
 * Lightness is rescaled rather than shifted. Diffuse shading is
 * reflectance x illumination, so preserving each pixel's *ratio* to the region
 * anchor swaps the dye while leaving the lighting alone. Shifting L* instead
 * kept the absolute spread constant no matter how dark the pick was, which left
 * highlights sitting ~14 L* above a dark pick -- and since people read a
 * surface's colour from its lit areas, the result looked lighter than asked for.
 */
export function recolor(imageData, analysis, targetHexes) {
  const { width: w, height: h } = analysis;
  const src = imageData.data;
  const out = new ImageData(w, h);
  const dst = out.data;
  dst.set(src);

  const targets = analysis.regions.map((reg, i) => {
    const hex = targetHexes[i];
    if (!hex || hex.toUpperCase() === reg.hex.toUpperCase()) return null; // unchanged: leave pixels alone
    const lab = hexToLab(hex);
    if (!lab) return null;
    const anchorY = lToY(reg.anchorL);
    return {
      L: lab[0], a: lab[1], b: lab[2],
      anchorL: reg.anchorL,
      anchorC: reg.anchorC,
      targetY: lToY(lab[0]),
      anchorY,
      // An almost-black region makes the luminance ratio explode; fall back to
      // the additive shift there, where the two models barely differ anyway.
      proportional: anchorY > 1e-4,
    };
  });
  if (targets.every((t) => t === null)) return out;

  const n = w * h;
  for (let i = 0; i < n; i++) {
    const label = analysis.labels[i];
    if (label === BG) continue;
    const t = targets[label];
    if (!t) continue;
    const alpha = analysis.alpha[i] / 255;
    if (alpha <= 0) continue;

    const o = i * 4;
    const [L, a, b] = rgbToLab(src[o], src[o + 1], src[o + 2]);
    const chroma = Math.hypot(a, b);
    const ratio = t.anchorC > 2 ? Math.min(1.6, chroma / t.anchorC) : 1;
    const newL = Math.max(0, Math.min(100, t.proportional
      ? yToL(t.targetY * (lToY(L) / t.anchorY))
      : L + (t.L - t.anchorL)));
    const [nr, ng, nb] = labToRgb(newL, t.a * ratio, t.b * ratio);

    dst[o] = Math.round(src[o] + (nr - src[o]) * alpha);
    dst[o + 1] = Math.round(src[o + 1] + (ng - src[o + 1]) * alpha);
    dst[o + 2] = Math.round(src[o + 2] + (nb - src[o + 2]) * alpha);
  }
  return out;
}
