// Small canvas helpers shared by ingest and the Adjust screen: EXIF orientation transforms, JPEG encoding of a bitmap,
// and a detection raster. Every canvas is zeroed after use (design 2.7 item 4).
import type { Raster } from '../cv/geometry.ts';

export interface OrientationTransform {
  /** setTransform(a, b, c, d, e, f) arguments mapping stored pixels to upright pixels. */
  matrix: readonly [a: number, b: number, c: number, d: number, e: number, f: number];
  width: number;
  height: number;
}

/** Transform that draws an image of stored size w x h upright for EXIF orientation 1..8. */
export function orientationTransform(orientation: number, w: number, h: number): OrientationTransform {
  switch (orientation) {
    case 2:
      return { matrix: [-1, 0, 0, 1, w, 0], width: w, height: h };
    case 3:
      return { matrix: [-1, 0, 0, -1, w, h], width: w, height: h };
    case 4:
      return { matrix: [1, 0, 0, -1, 0, h], width: w, height: h };
    case 5:
      return { matrix: [0, 1, 1, 0, 0, 0], width: h, height: w };
    case 6:
      return { matrix: [0, 1, -1, 0, h, 0], width: h, height: w };
    case 7:
      return { matrix: [0, -1, -1, 0, h, w], width: h, height: w };
    case 8:
      return { matrix: [0, -1, 1, 0, 0, w], width: h, height: w };
    default:
      return { matrix: [1, 0, 0, 1, 0, 0], width: w, height: h };
  }
}

export interface JpegOptions {
  quality: number;
  /** Rotate/flip by hand (decoder did not apply EXIF). Default 1. */
  orientation?: number;
}

export interface BlobOptions extends JpegOptions {
  mime?: 'image/jpeg' | 'image/png';
}

/** Draws `bitmap` (optionally upright by hand) onto a canvas and encodes it as JPEG (default) or PNG. */
export function bitmapToBlob(bitmap: ImageBitmap, opts: BlobOptions): Promise<Blob> {
  const t = orientationTransform(opts.orientation ?? 1, bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = t.width;
  canvas.height = t.height;
  const release = (): void => {
    canvas.width = 0;
    canvas.height = 0;
  };
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    release();
    return Promise.reject(new Error('No 2D canvas available'));
  }
  ctx.setTransform(...t.matrix);
  ctx.drawImage(bitmap, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        release();
        if (blob) resolve(blob);
        else reject(new Error('toBlob returned null'));
      },
      opts.mime ?? 'image/jpeg',
      opts.mime === 'image/png' ? undefined : opts.quality,
    );
  });
}

/** Draws `bitmap` (optionally upright by hand) onto a canvas and encodes it as JPEG. */
export function bitmapToJpeg(bitmap: ImageBitmap, opts: JpegOptions): Promise<Blob> {
  return bitmapToBlob(bitmap, { ...opts, mime: 'image/jpeg' });
}

/** Scales `bitmap` so its long edge is at most `longEdge` and encodes it (thumbnails). */
export function bitmapToThumbJpeg(bitmap: ImageBitmap, longEdge: number, quality = 0.8): Promise<Blob> {
  const s = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const release = (): void => {
    canvas.width = 0;
    canvas.height = 0;
  };
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    release();
    return Promise.reject(new Error('No 2D canvas available'));
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        release();
        if (blob) resolve(blob);
        else reject(new Error('toBlob returned null'));
      },
      'image/jpeg',
      quality,
    );
  });
}

/** RGBA raster of `bitmap` with its long edge at most `maxLongEdge` (detection input, design 2.8). */
export function bitmapToRaster(bitmap: ImageBitmap, maxLongEdge: number): Raster {
  const s = Math.min(1, maxLongEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D canvas available');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: img.data };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
