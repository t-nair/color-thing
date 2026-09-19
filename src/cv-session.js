import { analyze, recolor } from './pipeline.js';

// Holds one photo's analysis between calls. The label map and per-region stats
// that recolor needs never leave here -- the store only sees the mask and hexes.
// Runs inside the worker, or on the main thread if a worker isn't available.
export function createCvSession() {
  let source = null;
  let analysis = null;

  return {
    analyze(image, { k, onModel }) {
      source = image;
      analysis = null;
      analysis = analyze(image, k, { onModel });
      return {
        mask: analysis.alpha,
        swatches: analysis.regions.map((r) => r.hex),
        shares: analysis.regions.map((r) => r.count / analysis.garmentCount),
        warning: analysis.warning,
      };
    },

    recolor(targets) {
      if (!analysis) throw new Error('Nothing to recolor yet.');
      return recolor(source, analysis, targets);
    },
  };
}
