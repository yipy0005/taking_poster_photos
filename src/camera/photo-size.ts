// pickPhotoSize(): clamp the takePhoto request to the soft source limit on the advertised step/min grid (design 2.9, AC-2).
// Pure, DOM-free.

export interface Range {
  min: number;
  max: number;
  step: number;
}

export interface PhotoSizeCaps {
  imageWidth: Range;
  imageHeight: Range;
}

export interface PhotoSize {
  imageWidth: number;
  imageHeight: number;
}

/** Round DOWN onto the advertised grid; a step of 0 or undefined counts as 1. Never below min, never above max. */
function snap(value: number, r: Range): number {
  const step = r.step > 0 ? r.step : 1;
  return Math.min(r.max, Math.max(r.min, r.min + Math.floor((value - r.min) / step) * step));
}

/**
 * The largest photo size the camera offers that does not exceed `maxPx` pixels. A camera within the budget is asked for
 * exactly its maximum. Floor-rounding both sides keeps w*h <= maxPx, except when the camera's own `min` is larger
 * (then its smallest size is used and ingest treats the result as an oversize photo, design 2.7 item 11).
 */
export function pickPhotoSize(caps: PhotoSizeCaps, maxPx: number): PhotoSize {
  const { imageWidth: rw, imageHeight: rh } = caps;
  const s = Math.min(1, Math.sqrt(maxPx / (rw.max * rh.max)));
  if (s === 1) return { imageWidth: rw.max, imageHeight: rh.max };
  return { imageWidth: snap(Math.floor(rw.max * s), rw), imageHeight: snap(Math.floor(rh.max * s), rh) };
}
