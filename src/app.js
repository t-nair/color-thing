import { analyze, recolor, MAX_EDGE } from './pipeline.js';
import { isValidHex } from './color.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MIN_EDGE = 400; // below this we warn about resolution
const MIN_SPINNER_MS = 450; // 6.7: the pacing is a UX choice, the work is faster

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    upload: $('screen-upload'),
    edit: $('screen-edit'),
    result: $('screen-result'),
  },
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  kPicker: $('k-picker'),
  modePicker: $('mode-picker'),
  editNote: $('edit-note'),
  uploadError: $('upload-error'),
  previewCanvas: $('preview-canvas'),
  resultCanvas: $('result-canvas'),
  swatches: $('swatches'),
  legendToggle: $('legend-toggle'),
  processing: $('processing'),
};

const state = {
  k: 2,
  onModel: false,   // on-model photos need the model cut away first
  source: null,     // ImageData at working resolution
  analysis: null,   // { labels, alpha, regions, ... }
  targets: [],      // hex per region
  recolored: null,  // ImageData without legend
};

// --- screens ---------------------------------------------------------------

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
}

async function withSpinner(work) {
  el.processing.hidden = false;
  const started = performance.now();
  try {
    // Yield once so the spinner paints before the synchronous pipeline runs.
    await new Promise((r) => setTimeout(r, 30));
    return await work();
  } finally {
    const rest = MIN_SPINNER_MS - (performance.now() - started);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    el.processing.hidden = true;
  }
}

// --- input -----------------------------------------------------------------

function segmented(container, attr, onPick) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest(`button[data-${attr}]`);
    if (!btn) return;
    for (const b of container.querySelectorAll('button')) {
      const on = b === btn;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    onPick(btn.dataset[attr]);
  });
}

segmented(el.kPicker, 'k', (v) => { state.k = Number(v); });
segmented(el.modePicker, 'mode', (v) => { state.onModel = v === 'model'; });

el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files[0]) handleFile(el.fileInput.files[0]);
});

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('dragging');
  });
}
el.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

function fail(message) {
  el.uploadError.textContent = message;
  el.uploadError.hidden = false;
}

async function handleFile(file) {
  el.uploadError.hidden = true;
  if (!/^image\/(jpeg|png)$/.test(file.type)) return fail('Please use a JPG or PNG.');
  if (file.size > MAX_BYTES) return fail('That file is over 10 MB. Try a smaller version.');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return fail("That file couldn't be read as an image.");
  }

  if (Math.max(bitmap.width, bitmap.height) < MIN_EDGE) {
    fail(`Heads up: this image is only ${bitmap.width}×${bitmap.height}. Results are better above ${MIN_EDGE}px.`);
  }

  state.source = toImageData(bitmap);
  bitmap.close?.();

  try {
    await withSpinner(async () => {
      state.analysis = analyze(state.source, state.k, { onModel: state.onModel });
    });
  } catch (err) {
    return fail(err.message || 'Something went wrong reading that image.');
  }

  state.targets = state.analysis.regions.map((r) => r.hex);
  drawMasked(el.previewCanvas, state.source, state.analysis);
  buildSwatches();
  el.editNote.textContent = state.analysis.warning || '';
  el.editNote.hidden = !state.analysis.warning;
  show('edit');
}

// Downscale to the working resolution once; every later stage uses this size,
// so the label map and the pixels always line up.
function toImageData(bitmap) {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function draw(canvas, imageData) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
}

// Fade everything outside the mask toward the page background, using the very
// same alpha the recolor engine composites with -- so what stays crisp here is
// exactly what will be repainted. Isolation is the step most likely to go wrong,
// especially on model shots, and this makes it visible before committing.
function drawMasked(canvas, imageData, analysis) {
  const out = new ImageData(imageData.width, imageData.height);
  out.data.set(imageData.data);
  const d = out.data;
  const bg = [250, 249, 247];
  for (let i = 0; i < analysis.alpha.length; i++) {
    const dim = 0.82 * (1 - analysis.alpha[i] / 255);
    if (dim <= 0) continue;
    const o = i * 4;
    d[o] = Math.round(d[o] + (bg[0] - d[o]) * dim);
    d[o + 1] = Math.round(d[o + 1] + (bg[1] - d[o + 1]) * dim);
    d[o + 2] = Math.round(d[o + 2] + (bg[2] - d[o + 2]) * dim);
  }
  draw(canvas, out);
}

// --- editing ---------------------------------------------------------------

function buildSwatches() {
  el.swatches.replaceChildren();
  state.analysis.regions.forEach((region, i) => {
    const row = document.createElement('div');
    row.className = 'swatch';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = region.hex.toLowerCase();
    picker.setAttribute('aria-label', `Color ${i + 1}`);

    const body = document.createElement('div');
    body.className = 'swatch-body';

    const name = document.createElement('span');
    name.className = 'swatch-name';
    name.textContent = `Color ${i + 1} · ${share(region)}`;

    const text = document.createElement('input');
    text.type = 'text';
    text.value = region.hex;
    text.spellcheck = false;
    text.setAttribute('aria-label', `Hex for color ${i + 1}`);

    picker.addEventListener('input', () => {
      const hex = picker.value.toUpperCase();
      state.targets[i] = hex;
      text.value = hex;
      text.classList.remove('invalid');
      validate();
    });

    text.addEventListener('input', () => {
      const raw = text.value.trim();
      const ok = isValidHex(raw);
      text.classList.toggle('invalid', !ok);
      if (ok) {
        const hex = (raw.startsWith('#') ? raw : '#' + raw).toUpperCase();
        state.targets[i] = hex;
        picker.value = hex.toLowerCase();
      }
      validate();
    });

    body.append(name, text);
    row.append(picker, body);
    el.swatches.append(row);
  });
  validate();
}

function share(region) {
  return `${Math.round((region.count / state.analysis.garmentCount) * 100)}% of garment`;
}

function validate() {
  const ok = [...el.swatches.querySelectorAll('input[type="text"]')].every((i) => isValidHex(i.value));
  $('btn-recolor').disabled = !ok;
}

$('btn-recolor').addEventListener('click', async () => {
  await withSpinner(async () => {
    state.recolored = recolor(state.source, state.analysis, state.targets);
  });
  renderResult();
  show('result');
});

$('btn-cancel').addEventListener('click', restart);
$('btn-back').addEventListener('click', () => show('edit'));
$('btn-restart').addEventListener('click', restart);
el.legendToggle.addEventListener('change', renderResult);

function restart() {
  state.source = state.analysis = state.recolored = null;
  state.targets = [];
  el.fileInput.value = '';
  el.uploadError.hidden = true;
  el.editNote.hidden = true;
  show('upload');
}

// --- 6.8 output ------------------------------------------------------------

function composite(withLegend) {
  const canvas = document.createElement('canvas');
  canvas.width = state.recolored.width;
  canvas.height = state.recolored.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(state.recolored, 0, 0);
  if (withLegend) drawLegend(ctx, canvas.width, canvas.height, state.targets);
  return canvas;
}

// In-image legend, bottom-left: stays readable no matter how small or numerous
// the regions are.
function drawLegend(ctx, w, h, hexes) {
  const unit = Math.max(w, h);
  const pad = Math.round(unit * 0.022);
  const swatch = Math.max(16, Math.round(unit * 0.026));
  const gap = Math.round(swatch * 0.45);
  const fontSize = Math.max(11, Math.round(swatch * 0.62));
  const inner = Math.round(swatch * 0.55);

  ctx.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'middle';

  const labelWidth = Math.max(...hexes.map((hex) => ctx.measureText(hex).width));
  const boxW = inner * 2 + swatch + gap + labelWidth;
  const boxH = inner * 2 + hexes.length * swatch + (hexes.length - 1) * gap;
  const x = pad;
  const y = h - pad - boxH;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
  ctx.lineWidth = Math.max(1, unit * 0.001);
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, Math.round(swatch * 0.3));
  ctx.fill();
  ctx.stroke();

  hexes.forEach((hex, i) => {
    const ry = y + inner + i * (swatch + gap);
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.roundRect(x + inner, ry, swatch, swatch, Math.round(swatch * 0.22));
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.stroke();
    ctx.fillStyle = '#1c1917';
    ctx.fillText(hex, x + inner + swatch + gap, ry + swatch / 2);
  });
}

function renderResult() {
  const canvas = composite(el.legendToggle.checked);
  el.resultCanvas.width = canvas.width;
  el.resultCanvas.height = canvas.height;
  el.resultCanvas.getContext('2d').drawImage(canvas, 0, 0);
}

$('btn-download').addEventListener('click', () => {
  composite(el.legendToggle.checked).toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recolored.png';
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
});
