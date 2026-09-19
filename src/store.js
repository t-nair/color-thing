// Centralised app state: a single store, updated only through dispatch, with
// publish-subscribe fan-out. The UI and the CV pipeline never call each other --
// each subscribes to the slice of state it cares about and dispatches results.

export const ActionTypes = Object.freeze({
  LOAD_IMAGE: 'LOAD_IMAGE',
  ANALYSIS_COMPLETE: 'ANALYSIS_COMPLETE',
  UPDATE_TARGET: 'UPDATE_TARGET',
  RENDER_BUFFER_READY: 'RENDER_BUFFER_READY',
  // Beyond the core flow:
  SET_OPTIONS: 'SET_OPTIONS',
  PIPELINE_ERROR: 'PIPELINE_ERROR',
  RESET: 'RESET',
});

const EMPTY = Object.freeze([]);

export const initialState = Object.freeze({
  rawImage: null,        // ImageData | null -- original pixels at working resolution
  maskData: null,        // Uint8Array | null -- feathered garment alpha, 0..255 per pixel
  sourceSwatches: EMPTY, // string[] -- detected hex per region, dominant first
  targetHex: null,       // string | null -- the most recent pick
  renderBuffer: null,    // ImageData | null -- recolored pixels ready for canvas

  // The app recolors each region independently, so a single targetHex isn't
  // enough to render from: targets[i] is the pick for sourceSwatches[i].
  targets: EMPTY,
  settings: Object.freeze({ k: 2, onModel: false }),
  analysisMeta: null,    // { shares: number[], warning: string | null } | null
  status: 'idle',        // 'idle' | 'analyzing' | 'ready' | 'rendering' | 'error'
  error: null,           // string | null
});

export function reducer(state, type, payload) {
  switch (type) {
    case ActionTypes.LOAD_IMAGE:
      return {
        ...state,
        rawImage: payload,
        maskData: null,
        sourceSwatches: EMPTY,
        renderBuffer: null,
        // Picks for the previous photo's regions mean nothing for this one.
        targets: EMPTY,
        targetHex: null,
        analysisMeta: null,
        status: 'analyzing',
        error: null,
      };

    case ActionTypes.ANALYSIS_COMPLETE: {
      const swatches = Object.freeze([...payload.swatches]);
      return {
        ...state,
        maskData: payload.mask,
        sourceSwatches: swatches,
        targets: swatches, // every region starts at its detected colour
        analysisMeta: Object.freeze({
          shares: Object.freeze([...(payload.shares ?? [])]),
          warning: payload.warning ?? null,
        }),
        status: 'ready',
      };
    }

    case ActionTypes.UPDATE_TARGET: {
      const { index, hex } = payload;
      const next = String(hex).toUpperCase();
      if (!(index >= 0 && index < state.targets.length) || state.targets[index] === next) return state;
      const targets = [...state.targets];
      targets[index] = next;
      return { ...state, targets: Object.freeze(targets), targetHex: next, status: 'rendering' };
    }

    case ActionTypes.RENDER_BUFFER_READY:
      return { ...state, renderBuffer: payload, status: 'ready' };

    case ActionTypes.SET_OPTIONS:
      return { ...state, settings: Object.freeze({ ...state.settings, ...payload }) };

    case ActionTypes.PIPELINE_ERROR:
      return { ...state, status: 'error', error: payload };

    case ActionTypes.RESET:
      return { ...initialState, settings: state.settings };

    default:
      throw new Error(`Unknown action: ${type}`);
  }
}

export function createStore(reduce, initial) {
  let state = initial;
  const listeners = [];
  const queue = [];
  let dispatching = false;

  return Object.freeze({
    // State is frozen, so this is read-only at the top level. Typed arrays and
    // ImageData can't be frozen -- treat them as immutable by convention.
    getState: () => state,

    subscribe(callback) {
      listeners.push(callback);
      return () => {
        const i = listeners.indexOf(callback);
        if (i !== -1) listeners.splice(i, 1);
      };
    },

    // A listener that dispatches is queued rather than re-entering, so every
    // listener sees every state in order.
    dispatch(actionType, payload) {
      queue.push([actionType, payload]);
      if (dispatching) return;
      dispatching = true;
      try {
        while (queue.length) {
          const [type, data] = queue.shift();
          const next = reduce(state, type, data);
          if (next === state) continue;
          state = Object.freeze(next);
          for (const listener of [...listeners]) listener(state);
        }
      } finally {
        queue.length = 0;
        dispatching = false;
      }
    },
  });
}

export const store = createStore(reducer, initialState);

/**
 * Subscribe to one slice of state: onChange(value, state) runs only when
 * selector(state) changes by identity. Reducers replace what they touch, so
 * identity is a reliable change signal.
 */
export function watch(selector, onChange, target = store) {
  let prev = selector(target.getState());
  return target.subscribe((state) => {
    const next = selector(state);
    if (next === prev) return;
    prev = next;
    onChange(next, state);
  });
}
