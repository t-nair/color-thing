import { store, watch, ActionTypes } from './store.js';
import { isValidHex } from './color.js';

const normalize = (raw) => {
  const s = raw.trim();
  return (s.startsWith('#') ? s : '#' + s).toUpperCase();
};

// One row per detected colour. Every edit is dispatched as UPDATE_TARGET; the
// inputs are then synced back from state, so the store stays the only source
// of truth. onValidity(ok) reports whether every hex field currently parses.
export function mountColorEditor(container, { onValidity = () => {} } = {}) {
  let rows = [];

  const validate = () => onValidity(rows.every((r) => isValidHex(r.text.value)));
  const pick = (index, hex) => store.dispatch(ActionTypes.UPDATE_TARGET, { index, hex });

  function build(swatches, state) {
    const shares = state.analysisMeta?.shares ?? [];
    container.replaceChildren();
    rows = swatches.map((source, i) => {
      const row = document.createElement('div');
      row.className = 'swatch';

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = source.toLowerCase();
      picker.setAttribute('aria-label', `Color ${i + 1}`);
      picker.addEventListener('input', () => pick(i, picker.value));

      const body = document.createElement('div');
      body.className = 'swatch-body';

      const name = document.createElement('span');
      name.className = 'swatch-name';
      name.textContent = shares[i] != null
        ? `Color ${i + 1} · ${Math.round(shares[i] * 100)}% of garment`
        : `Color ${i + 1}`;

      const text = document.createElement('input');
      text.type = 'text';
      text.value = source;
      text.spellcheck = false;
      text.setAttribute('aria-label', `Hex for color ${i + 1}`);
      text.addEventListener('input', () => {
        const ok = isValidHex(text.value);
        text.classList.toggle('invalid', !ok);
        if (ok) pick(i, normalize(text.value));
        validate();
      });

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'swatch-reset';
      reset.style.background = source;
      reset.title = `Reset to detected ${source}`;
      reset.setAttribute('aria-label', `Reset color ${i + 1} to detected ${source}`);
      reset.addEventListener('click', () => pick(i, source));

      body.append(name, text);
      row.append(picker, body, reset);
      container.append(row);
      return { picker, text };
    });
    validate();
  }

  function sync(targets) {
    targets.forEach((hex, i) => {
      const row = rows[i];
      if (!row) return;
      if (row.picker.value.toUpperCase() !== hex) row.picker.value = hex.toLowerCase();
      const valid = isValidHex(row.text.value);
      // Don't rewrite a half-typed hex the user is still working on.
      const typing = !valid && document.activeElement === row.text;
      if (!typing && (!valid || normalize(row.text.value) !== hex)) {
        row.text.value = hex;
        row.text.classList.remove('invalid');
      }
    });
    validate();
  }

  const offSwatches = watch((s) => s.sourceSwatches, (swatches, state) => {
    if (swatches.length) build(swatches, state);
    else { container.replaceChildren(); rows = []; }
  });
  const offTargets = watch((s) => s.targets, sync);
  return () => { offSwatches(); offTargets(); };
}
