import { watch } from './store.js';

// Paints the latest render to the canvas. Until the first pick there's no
// render buffer, so the original photo stands in.
export function mountCanvasRenderer(canvas) {
  const paint = (image) => {
    if (!image) return;
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    canvas.getContext('2d').putImageData(image, 0, 0);
  };
  return watch((s) => s.renderBuffer ?? s.rawImage, paint);
}
