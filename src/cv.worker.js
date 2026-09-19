import { createCvSession } from './cv-session.js';

const session = createCvSession();

self.onmessage = ({ data: { id, type, args } }) => {
  try {
    if (type === 'analyze') {
      const result = session.analyze(...args);
      // The session keeps its alpha for recolor, so transfer a copy.
      const mask = result.mask.slice();
      self.postMessage({ id, ok: true, result: { ...result, mask } }, [mask.buffer]);
    } else if (type === 'recolor') {
      const image = session.recolor(...args);
      self.postMessage({ id, ok: true, result: image }, [image.data.buffer]);
    } else {
      throw new Error(`Unknown request: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
