import { store, watch, ActionTypes } from './store.js';
import { startCvPipeline } from './cv-service.js';
import { mountColorEditor } from './color-editor.js';
import { mountCanvasRenderer } from './canvas-renderer.js';
import { MAX_EDGE } from './pipeline.js';

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

// --- wiring ----------------------------------------------------------------
// This file owns screens, upload and export. Everything else reacts to the
// store: the CV pipeline, the colour editor and the preview canvas.

startCvPipeline();
mountCanvasRenderer(el.previewCanvas);
mountColorEditor(el.swatches, {
  onValidity: (ok) => { $('btn-recolor').disabled = !ok; },
});

// --- screens ---------------------------------------------------------------

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
}

// Analysis progress. The spinner holds for a minimum time once shown.
let spinnerShownAt = 0;
let spinnerTimer = 0;
watch((s) => s.status === 'analyzing', (analyzing) => {
  clearTimeout(spinnerTimer);
  if (analyzing) {
    spinnerShownAt = performance.now();
    el.processing.hidden = false;
  } else {
    const rest = MIN_SPINNER_MS - (performance.now() - spinnerShownAt);
    spinnerTimer = setTimeout(() => { el.processing.hidden = true; }, Math.max(0, rest));
  }
});

// Analysis finished: move on to editing.
watch((s) => s.sourceSwatches, (swatches, state) => {
  if (!swatches.length) return;
  const warning = state.analysisMeta?.warning;
  el.editNote.textContent = warning || '';
  el.editNote.hidden = !warning;
  show('edit');
});

watch((s) => s.error, (error, state) => {
  if (!error) return;
  if (state.sourceSwatches.length) {
    el.editNote.textContent = error;
    el.editNote.hidden = false;
  } else {
    fail(error);
  }
});

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

segmented(el.kPicker, 'k', (v) => store.dispatch(ActionTypes.SET_OPTIONS, { k: Number(v) }));
segmented(el.modePicker, 'mode', (v) => store.dispatch(ActionTypes.SET_OPTIONS, { onModel: v === 'model' }));

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

  const image = toImageData(bitmap);
  bitmap.close?.();
  store.dispatch(ActionTypes.LOAD_IMAGE, image);
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

// --- editing ---------------------------------------------------------------

// The preview is already live, so this only moves to the export screen.
$('btn-recolor').addEventListener('click', () => {
  renderResult();
  show('result');
});

$('btn-cancel').addEventListener('click', restart);
$('btn-back').addEventListener('click', () => show('edit'));
$('btn-restart').addEventListener('click', restart);
el.legendToggle.addEventListener('change', renderResult);

function restart() {
  store.dispatch(ActionTypes.RESET);
  el.fileInput.value = '';
  el.uploadError.hidden = true;
  el.editNote.hidden = true;
  show('upload');
}

// --- 6.8 output ------------------------------------------------------------

function composite(withLegend) {
  const { renderBuffer, rawImage, targets } = store.getState();
  const image = renderBuffer ?? rawImage; // no picks yet: the photo is the result
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(image, 0, 0);
  if (withLegend) drawLegend(ctx, canvas.width, canvas.height, targets);
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

// A pick made just before switching screens may still be rendering.
watch((s) => s.renderBuffer, (buffer) => { if (buffer && !el.screens.result.hidden) renderResult(); });
watch((s) => s.status === 'rendering', (rendering) => { $('btn-download').disabled = rendering; });

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
