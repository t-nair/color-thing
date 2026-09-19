// The CV pipeline's two store observers. Neither touches the DOM: they read
// state, run the math (in a Web Worker when possible) and dispatch the result.

import { store, watch, ActionTypes } from './store.js';
import { createCvSession } from './cv-session.js';

// Promise-based front for the worker. If the worker can't be created or fails
// to load (e.g. no module-worker support), requests run on the main thread.
function createEngine() {
  const local = createCvSession();
  const pending = new Map();
  let nextId = 0;
  let worker = null;

  const runLocal = (req) => {
    // Yield first so a spinner can paint before the synchronous work.
    setTimeout(() => {
      try { req.resolve(local[req.type](...req.args)); } catch (err) { req.reject(err); }
    }, 30);
  };

  try {
    worker = new Worker(new URL('./cv.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const req = pending.get(data.id);
      if (!req) return;
      pending.delete(data.id);
      if (data.ok) req.resolve(data.result);
      else req.reject(new Error(data.error));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      worker = null;
      for (const req of pending.values()) runLocal(req);
      pending.clear();
    };
  } catch {
    worker = null;
  }

  return {
    call(type, ...args) {
      return new Promise((resolve, reject) => {
        const req = { type, args, resolve, reject };
        if (!worker) return runLocal(req);
        const id = nextId++;
        pending.set(id, req);
        worker.postMessage({ id, type, args });
      });
    },
  };
}

export function startCvPipeline(engine = createEngine()) {
  // Bumped on every new photo, so results for a replaced photo are dropped.
  let generation = 0;

  // Analysis: a new rawImage -> forward Lab, isolation, clustering.
  watch((s) => s.rawImage, async (rawImage, state) => {
    const gen = ++generation;
    if (!rawImage) return;
    try {
      const result = await engine.call('analyze', rawImage, state.settings);
      if (gen === generation) store.dispatch(ActionTypes.ANALYSIS_COMPLETE, result);
    } catch (err) {
      if (gen === generation) store.dispatch(ActionTypes.PIPELINE_ERROR, err.message || 'Something went wrong reading that image.');
    }
  });

  // Recolor: a new pick -> pixel swap + inverse Lab over the existing mask.
  // Colour pickers fire on every drag step, so keep at most one request in
  // flight and coalesce the rest into a single rerun with the latest picks.
  let busy = false;
  let again = false;

  async function render() {
    const { maskData, targets } = store.getState();
    if (!maskData) return;
    const gen = generation;
    busy = true;
    try {
      const buffer = await engine.call('recolor', targets);
      if (gen === generation && !again) store.dispatch(ActionTypes.RENDER_BUFFER_READY, buffer);
    } catch (err) {
      if (gen === generation) store.dispatch(ActionTypes.PIPELINE_ERROR, err.message || 'Recoloring failed.');
    } finally {
      busy = false;
      if (again) {
        again = false;
        render();
      }
    }
  }

  // Watches targets rather than targetHex: picking the same hex for a second
  // region leaves targetHex unchanged but still needs a render.
  watch((s) => s.targets, (_, state) => {
    if (state.targetHex === null) return; // fresh analysis, nothing picked yet
    if (busy) again = true;
    else render();
  });
}
