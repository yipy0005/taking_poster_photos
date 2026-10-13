// decodeRaw(): the only module (with decode-caps.ts) that calls createImageBitmap (design 2.7 item 5).
// Worker-safe: NO store, NO memory gate, NO marker (plan.md finding 1). The main-thread guard lives in
// decode-guarded.ts. DOM-free: only symbols present in both the DOM and WebWorker libs.
import { BitmapHandle } from './bitmap-handle.ts';
import { DecodeError } from './errors.ts';
import { log } from './log.ts';

/** Results of the one-time createImageBitmap probes (decode-caps.ts, main thread; passed to workers in `init`). */
export interface DecodeCaps {
  /** `imageOrientation: 'from-image'` is accepted. */
  fromImage: boolean;
  /** EXIF orientation is applied by the decoder. When both this and fromImage are false, ingest normalises by hand. */
  exifHonored: boolean;
  /** `resizeWidth/resizeHeight` are honoured. */
  resizeHonored: boolean;
  /** With `from-image`, the requested resize size is interpreted in oriented (displayed) space. */
  resizeAfterOrient: boolean;
}

/** Conservative defaults used until the probe has run: no exotic options, canvas fallback for any resize. */
export const DEFAULT_DECODE_CAPS: DecodeCaps = {
  fromImage: false,
  exifHonored: true,
  resizeHonored: false,
  resizeAfterOrient: false,
};

let caps: DecodeCaps = DEFAULT_DECODE_CAPS;
let capsKnown = false;

export function setDecodeCaps(next: DecodeCaps): void {
  caps = next;
  capsKnown = true;
}
export function getDecodeCaps(): DecodeCaps {
  return caps;
}
export function decodeCapsKnown(): boolean {
  return capsKnown;
}
export function resetDecodeCapsForTests(): void {
  caps = DEFAULT_DECODE_CAPS;
  capsKnown = false;
}

/** Stored dimensions and EXIF orientation as read from the file header (camera/exif.ts supplies them). */
export interface ImageInfo {
  /** Stored (un-rotated) pixel dimensions. */
  width: number;
  height: number;
  /** EXIF orientation 1..8 (1 when absent or already normalised). */
  orientation: number;
}

export interface DecodeOpts {
  /** Upper bound on decoded pixels. */
  maxPixels?: number;
  /** Upper bound on the long edge. */
  maxLongEdge?: number;
  /** Crop in oriented pixel coordinates of the full image (tile fallback; unverified on real browsers). */
  crop?: { sx: number; sy: number; sw: number; sh: number };
  /** Header-derived dimensions. Without them no resize target can be computed; bounds are then applied via a canvas. */
  info?: ImageInfo | null;
  /** Label for the live-handle tracker. */
  label?: string;
}

export interface DecodeResult {
  handle: BitmapHandle;
  /** Dimensions of the returned bitmap. */
  width: number;
  height: number;
  /** Oriented source dimensions when known, otherwise the bitmap's. */
  sourceWidth: number;
  sourceHeight: number;
  /** bitmap.width / sourceWidth (1 = full resolution). */
  scale: number;
  /** True when the bitmap is smaller than the source. */
  reduced: boolean;
}

/** Oriented dimensions for a stored size and EXIF orientation. */
export function orientedSize(info: ImageInfo): { width: number; height: number } {
  const swap = info.orientation >= 5 && info.orientation <= 8;
  return swap ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

/** Target size for the given bounds; never upscales and never exceeds `maxPixels` (floor, min 1). */
export function boundedSize(
  width: number,
  height: number,
  opts: { maxPixels?: number; maxLongEdge?: number },
): { width: number; height: number; scaled: boolean } {
  let s = 1;
  const px = width * height;
  if (opts.maxPixels !== undefined && px > opts.maxPixels) s = Math.min(s, Math.sqrt(opts.maxPixels / px));
  const long = Math.max(width, height);
  if (opts.maxLongEdge !== undefined && long > opts.maxLongEdge) s = Math.min(s, opts.maxLongEdge / long);
  if (s >= 1) return { width, height, scaled: false };
  let w = Math.max(1, Math.floor(width * s));
  let h = Math.max(1, Math.floor(height * s));
  // floor of each axis can only shrink the area, but guard the rare rounding case anyway
  while (opts.maxPixels !== undefined && w * h > opts.maxPixels && (w > 1 || h > 1)) {
    if (w >= h) w--;
    else h--;
  }
  return { width: w, height: h, scaled: true };
}

function bitmapOptions(c: DecodeCaps, extra: ImageBitmapOptions = {}): ImageBitmapOptions {
  const o: ImageBitmapOptions = { ...extra };
  if (c.fromImage) o.imageOrientation = 'from-image';
  return o;
}

/** Downscale `bmp` through an OffscreenCanvas (slow path; peak memory = source + target). Closes `bmp`. */
async function downscaleViaCanvas(bmp: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  const Off = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (!Off) {
    bmp.close();
    throw new DecodeError('No canvas available to scale the image');
  }
  const canvas = new Off(w, h);
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new DecodeError('No 2D context available to scale the image');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } finally {
    bmp.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Decodes `blob` honouring EXIF orientation and the bounds in `opts`, using only the options the
 * probes found to work. Callers on the main thread should use decodeGuarded() instead.
 */
export async function decodeRaw(blob: Blob, opts: DecodeOpts = {}): Promise<DecodeResult> {
  const c = caps;
  const info = opts.info ?? null;
  const oriented = info ? orientedSize(info) : null;
  const wantsBound = opts.maxPixels !== undefined || opts.maxLongEdge !== undefined;
  const target = oriented ? boundedSize(oriented.width, oriented.height, opts) : null;

  let bmp: ImageBitmap;
  let handled = false; // true when the decoder already produced the target size
  if (opts.crop) {
    const { sx, sy, sw, sh } = opts.crop;
    bmp = await createImageBitmap(blob, sx, sy, sw, sh, bitmapOptions(c));
    handled = true;
  } else if (target?.scaled && c.resizeHonored && oriented && info) {
    // Resize at decode time. With from-image, the size space depends on the probe result.
    const swapForStored = !c.resizeAfterOrient && info.orientation >= 5;
    const rw = swapForStored ? target.height : target.width;
    const rh = swapForStored ? target.width : target.height;
    try {
      bmp = await createImageBitmap(blob, bitmapOptions(c, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' }));
    } catch (e) {
      log.warnOnce('decode-resize-failed', 'createImageBitmap resize rejected, using canvas fallback', e);
      bmp = await createImageBitmap(blob, bitmapOptions(c));
    }
    handled = true;
  } else {
    bmp = await createImageBitmap(blob, bitmapOptions(c));
    handled = !wantsBound;
  }

  // Enforce the bounds when the decoder ignored or could not take a resize request.
  if (!handled || (target?.scaled && bmp.width * bmp.height > target.width * target.height * 1.02)) {
    const bounded = boundedSize(bmp.width, bmp.height, opts);
    if (bounded.scaled) bmp = await downscaleViaCanvas(bmp, bounded.width, bounded.height);
  }

  const handle = new BitmapHandle(bmp, opts.label ?? 'decode');
  const srcW = oriented?.width ?? handle.width;
  const srcH = oriented?.height ?? handle.height;
  const scale = opts.crop ? 1 : handle.width / srcW;
  return {
    handle,
    width: handle.width,
    height: handle.height,
    sourceWidth: srcW,
    sourceHeight: srcH,
    scale,
    reduced: !opts.crop && handle.width < srcW,
  };
}
