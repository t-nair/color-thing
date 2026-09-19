// Edge-aware feathering of the garment mask, and foreground-colour estimation
// for the partially covered pixels it produces. See "Edge feathering" in the
// README for how this was chosen.
//
// featherMask: a trimap guided filter. Each local window learns a linear
// colour -> alpha model from the pixels it is confident about (more than U px
// from the mask outline) and applies it to the uncertain pixels on the
// outline, so the edge lands where the photo's colours change rather than
// where the binary mask's staircase happens to be. The fit runs at half
// resolution; alpha is only re-evaluated near the outline.

const R = 12;          // window radius, full-res px
const EPS = 1e-4;      // guided-filter regulariser (Lab channels scaled to ~[0, 1])
const U = 2;           // pixels this close to the outline are "unknown": not fitted on
const BAND = 6;        // only pixels this close to the outline get a new alpha
const S = 2;           // subsampling for the fit
const DELTA = 1e-3;    // weight floor for windows whose model explains nothing
const GATE = [0.3, 0.6]; // R^2 below which there is no real colour edge to follow
const FG_R = 12;       // radius of the local colour means used for decontamination

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Box-average downsample by 2, including a partial last row/column.
function half(src, w, h, stride = 1, offset = 0) {
  const sw = (w + 1) >> 1, sh = (h + 1) >> 1;
  const out = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const y0 = 2 * y, y1 = Math.min(h - 1, y0 + 1), ny = y1 - y0 + 1;
    const r0 = y0 * w, r1 = y1 * w;
    for (let x = 0; x < sw; x++) {
      const x0 = 2 * x, x1 = Math.min(w - 1, x0 + 1);
      let sum = src[(r0 + x0) * stride + offset];
      if (x1 !== x0) sum += src[(r0 + x1) * stride + offset];
      if (ny === 2) {
        sum += src[(r1 + x0) * stride + offset];
        if (x1 !== x0) sum += src[(r1 + x1) * stride + offset];
      }
      out[y * sw + x] = sum / ((x1 - x0 + 1) * ny);
    }
  }
  return out;
}

// Box mean over a (2r+1)^2 window clamped at the borders, into caller-owned
// buffers. Both passes walk memory in order.
function boxInto(src, w, h, r, out, tmp, col) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      const x0 = x - r - 1, x1 = x + r;
      if (x1 < w && x > 0) sum += src[row + x1];
      if (x0 >= 0) sum -= src[row + x0];
      tmp[row + x] = sum / (Math.min(w - 1, x1) - Math.max(0, x - r) + 1);
    }
  }
  col.fill(0);
  for (let y = 0; y <= Math.min(r, h - 1); y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) col[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const y0 = y - r - 1, y1 = y + r;
    if (y1 < h && y > 0) { const row = y1 * w; for (let x = 0; x < w; x++) col[x] += tmp[row + x]; }
    if (y0 >= 0) { const row = y0 * w; for (let x = 0; x < w; x++) col[x] -= tmp[row + x]; }
    const inv = 1 / (Math.min(h - 1, y1) - Math.max(0, y - r) + 1);
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = col[x] * inv;
  }
  return out;
}

// For each radius, the pixels whose (2r+1)^2 window holds both garment and
// non-garment pixels -- i.e. within r of the outline -- from one integral image.
function outlineZones(mask, w, h, radii) {
  const W = w + 1;
  const sum = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const o = (y + 1) * W, p = y * W, src = y * w;
    for (let x = 0; x < w; x++) { row += mask[src + x]; sum[o + x + 1] = sum[p + x + 1] + row; }
  }
  return radii.map((r) => {
    const z = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      const top = y0 * W, bot = (y1 + 1) * W, rows = y1 - y0 + 1;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const c = sum[bot + x1 + 1] - sum[top + x1 + 1] - sum[bot + x0] + sum[top + x0];
        if (c > 0 && c < rows * (x1 - x0 + 1)) z[y * w + x] = 1;
      }
    }
    return z;
  });
}

// Bilinear lookup of a full-res pixel into a half-res grid.
function bilinear(x, y, sw, sh, idx, wt) {
  const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / S - 0.5));
  const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / S - 0.5));
  const y0 = fy | 0, x0 = fx | 0;
  const y1 = Math.min(sh - 1, y0 + 1), x1 = Math.min(sw - 1, x0 + 1);
  const ty = fy - y0, tx = fx - x0;
  idx[0] = y0 * sw + x0; idx[1] = y0 * sw + x1; idx[2] = y1 * sw + x0; idx[3] = y1 * sw + x1;
  wt[0] = (1 - tx) * (1 - ty); wt[1] = tx * (1 - ty); wt[2] = (1 - tx) * ty; wt[3] = tx * ty;
}
const lerp4 = (a, idx, wt) => a[idx[0]] * wt[0] + a[idx[1]] * wt[1] + a[idx[2]] * wt[2] + a[idx[3]] * wt[3];

/**
 * Feather a binary garment mask against the photo.
 * @param {Uint8Array} mask  0/1 garment mask
 * @param {{L, a, b}} lab    the photo in Lab (Float32Arrays)
 * @returns {Float32Array}   alpha in [0, 1]
 */
export function featherMask(mask, lab, w, h) {
  const n = w * h;
  const [unknown, inBand] = outlineZones(mask, w, h, [U, BAND]);

  // Confident pixels only: k = 1 away from the outline, and k*p their labels.
  const k = new Float32Array(n), kp = new Float32Array(n);
  for (let i = 0; i < n; i++) if (!unknown[i]) { k[i] = 1; kp[i] = mask[i]; }

  const sw = (w + 1) >> 1, sh = (h + 1) >> 1, m = sw * sh;
  const c0 = half(lab.L, w, h), c1 = half(lab.a, w, h), c2 = half(lab.b, w, h);
  for (let i = 0; i < m; i++) { c0[i] *= 0.01; c1[i] *= 0.01; c2[i] *= 0.01; }
  const K0 = half(k, w, h), P0 = half(kp, w, h);
  const rs = Math.max(1, Math.round(R / S));
  const tmp = new Float32Array(m), col = new Float64Array(sw), plane = new Float32Array(m);
  const box = (src) => boxInto(src, sw, sh, rs, new Float32Array(m), tmp, col);
  const box2 = (x, y) => { for (let i = 0; i < m; i++) plane[i] = x[i] * y[i]; return box(plane); };
  const box3 = (x, y, z) => { for (let i = 0; i < m; i++) plane[i] = x[i] * y[i] * z[i]; return box(plane); };

  // Window statistics over confident pixels.
  const K = box(K0), P = box(P0);
  const M0 = box2(K0, c0), M1 = box2(K0, c1), M2 = box2(K0, c2);
  const Q0 = box2(P0, c0), Q1 = box2(P0, c1), Q2 = box2(P0, c2);
  const V00 = box3(K0, c0, c0), V01 = box3(K0, c0, c1), V02 = box3(K0, c0, c2);
  const V11 = box3(K0, c1, c1), V12 = box3(K0, c1, c2), V22 = box3(K0, c2, c2);

  // Solve each window's colour -> alpha model. Windows are weighted by how
  // much of the mask's variance their model explains, so windows straddling a
  // real colour edge dominate. Outputs reuse the spent statistic planes.
  const WA0 = M0, WA1 = M1, WA2 = M2, WB = Q0, Wt = Q1;
  const R2 = new Float32Array(m), RK = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const kk = K[i];
    if (kk <= 1e-6) { WA0[i] = WA1[i] = WA2[i] = WB[i] = Wt[i] = 0; continue; }
    const inv = 1 / kk, mP = P[i] * inv;
    if (mP < 1e-6 || mP > 1 - 1e-6) {
      // All confident pixels agree: the model is a constant and explains
      // nothing. True for most windows, so this skips most of the solving.
      const wt = kk * DELTA;
      WA0[i] = WA1[i] = WA2[i] = 0; WB[i] = wt * mP; Wt[i] = wt;
      continue;
    }
    const m0 = M0[i] * inv, m1 = M1[i] * inv, m2 = M2[i] * inv;
    const s00 = V00[i] * inv - m0 * m0 + EPS, s01 = V01[i] * inv - m0 * m1, s02 = V02[i] * inv - m0 * m2;
    const s11 = V11[i] * inv - m1 * m1 + EPS, s12 = V12[i] * inv - m1 * m2, s22 = V22[i] * inv - m2 * m2 + EPS;
    const cp0 = Q0[i] * inv - m0 * mP, cp1 = Q1[i] * inv - m1 * mP, cp2 = Q2[i] * inv - m2 * mP;
    // Inverse of the symmetric 3x3 covariance via cofactors.
    const i00 = s11 * s22 - s12 * s12, i01 = s02 * s12 - s01 * s22, i02 = s01 * s12 - s02 * s11;
    const i11 = s00 * s22 - s02 * s02, i12 = s01 * s02 - s00 * s12, i22 = s00 * s11 - s01 * s01;
    const det = s00 * i00 + s01 * i01 + s02 * i02;
    const a0 = (i00 * cp0 + i01 * cp1 + i02 * cp2) / det;
    const a1 = (i01 * cp0 + i11 * cp1 + i12 * cp2) / det;
    const a2 = (i02 * cp0 + i12 * cp1 + i22 * cp2) / det;
    const b = mP - a0 * m0 - a1 * m1 - a2 * m2;
    const explained = Math.max(0, a0 * cp0 + a1 * cp1 + a2 * cp2);
    const wt = kk * (explained + DELTA);
    WA0[i] = wt * a0; WA1[i] = wt * a1; WA2[i] = wt * a2; WB[i] = wt * b; Wt[i] = wt;
    R2[i] = kk * Math.min(1, explained / (mP * (1 - mP)));
    RK[i] = kk;
  }

  // Confidence: mean R^2 of the straddling windows around each point. Where
  // no colour edge explains the outline -- the mask stopped short inside the
  // garment, say -- alpha falls back to the mask instead of smearing.
  const conf = boxInto(R2, sw, sh, rs, R2, tmp, col), den = boxInto(RK, sw, sh, rs, RK, tmp, col);
  for (let i = 0; i < m; i++) {
    const t = clamp01(((den[i] > 1e-6 ? conf[i] / den[i] : 0) - GATE[0]) / (GATE[1] - GATE[0]));
    conf[i] = t * t * (3 - 2 * t);
  }

  // Average the models covering each point (into the spent V planes).
  const sA0 = boxInto(WA0, sw, sh, rs, V00, tmp, col), sA1 = boxInto(WA1, sw, sh, rs, V01, tmp, col);
  const sA2 = boxInto(WA2, sw, sh, rs, V02, tmp, col), sB = boxInto(WB, sw, sh, rs, V11, tmp, col);
  const sW = boxInto(Wt, sw, sh, rs, V12, tmp, col);
  for (let i = 0; i < m; i++) {
    if (sW[i] > 0) { const inv = 1 / sW[i]; sA0[i] *= inv; sA1[i] *= inv; sA2[i] *= inv; sB[i] *= inv; }
  }

  // Apply at full resolution, near the outline only.
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = mask[i];
  const idx = new Int32Array(4), wt = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inBand[i]) continue;
      bilinear(x, y, sw, sh, idx, wt);
      if (lerp4(sW, idx, wt) <= 0) continue; // no confident window nearby
      const q = clamp01(lerp4(sA0, idx, wt) * lab.L[i] * 0.01 + lerp4(sA1, idx, wt) * lab.a[i] * 0.01 +
        lerp4(sA2, idx, wt) * lab.b[i] * 0.01 + lerp4(sB, idx, wt));
      const c = lerp4(conf, idx, wt);
      alpha[i] = c * q + (1 - c) * mask[i];
    }
  }

  // Bright stitch highlights can resemble the background and leave isolated
  // dips just inside the edge. A 3x3 median fills those -- inside the mask
  // only, and only upward, so real sub-pixel fibres outside it survive.
  const out = alpha.slice();
  const v = new Float32Array(9);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!inBand[i] || !mask[i]) continue;
      let c = 0;
      for (let dy = -w; dy <= w; dy += w) for (let dx = -1; dx <= 1; dx++) v[c++] = alpha[i + dy + dx];
      for (let p = 1; p < 9; p++) {
        const t = v[p];
        let q = p - 1;
        while (q >= 0 && v[q] > t) { v[q + 1] = v[q]; q--; }
        v[q + 1] = t;
      }
      if (v[4] > out[i]) out[i] = v[4];
    }
  }
  return out;
}

/**
 * Estimate the garment's own colour at partially covered pixels. A pixel on
 * the edge is a mix I = a*F + (1-a)*B; recoloring I directly carries the
 * background into the result (a pale fringe on a dark pick). Solving for F with
 * B taken as the local background mean removes it. The inversion is unstable
 * as a -> 0, so low-alpha pixels lean on the local garment mean instead.
 *
 * @param {Float32Array} alpha
 * @param {Uint8ClampedArray} rgb  RGBA pixels
 * @returns {Uint8ClampedArray}    RGBA; equal to rgb wherever alpha is ~0 or ~1
 */
export function estimateForeground(alpha, rgb, w, h) {
  const n = w * h;
  const LO = 0.05, HI = 0.95;
  const fg = new Uint8ClampedArray(rgb);
  const kF = new Float32Array(n), kB = new Float32Array(n);
  let partial = 0;
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a >= HI) kF[i] = 1;
    else if (a <= LO) kB[i] = 1;
    if (a > 0.004 && a < HI) partial++;
  }
  if (!partial) return fg;

  const sw = (w + 1) >> 1, sh = (h + 1) >> 1, m = sw * sh;
  const rs = Math.max(1, Math.round(FG_R / S));
  const tmp = new Float32Array(m), col = new Float64Array(sw), plane = new Float32Array(m);
  const KF = half(kF, w, h), KB = half(kB, w, h);
  const ch = [0, 1, 2].map((c) => half(rgb, w, h, 4, c));
  const cntF = boxInto(KF, sw, sh, rs, new Float32Array(m), tmp, col);
  const cntB = boxInto(KB, sw, sh, rs, new Float32Array(m), tmp, col);
  // Local mean colour of confident pixels; -1 where there are none.
  const mean = (Kc, cnt, c) => {
    for (let i = 0; i < m; i++) plane[i] = Kc[i] * ch[c][i];
    const sum = boxInto(plane, sw, sh, rs, new Float32Array(m), tmp, col);
    for (let i = 0; i < m; i++) sum[i] = cnt[i] > 1e-6 ? sum[i] / cnt[i] : -1;
    return sum;
  };
  const Fm = [0, 1, 2].map((c) => mean(KF, cntF, c));
  const Bm = [0, 1, 2].map((c) => mean(KB, cntB, c));

  const idx = new Int32Array(4), wt = new Float32Array(4);
  const known = (arr) => arr[idx[0]] >= 0 && arr[idx[1]] >= 0 && arr[idx[2]] >= 0 && arr[idx[3]] >= 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = alpha[i];
      if (a >= HI || a <= 0.004) continue;
      bilinear(x, y, sw, sh, idx, wt);
      const trust = clamp01((a - 0.15) / 0.45);
      for (let c = 0; c < 3; c++) {
        const I = rgb[i * 4 + c];
        const fMean = known(Fm[c]) ? lerp4(Fm[c], idx, wt) : I;
        const bMean = known(Bm[c]) ? lerp4(Bm[c], idx, wt) : I;
        const solved = Math.min(255, Math.max(0, (I - (1 - a) * bMean) / a));
        fg[i * 4 + c] = trust * solved + (1 - trust) * fMean;
      }
    }
  }
  return fg;
}
