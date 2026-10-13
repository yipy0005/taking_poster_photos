// Raster helpers and the canvas-backed surfaces render-core writes to and reads from (design 2.6 steps 4-6).
// DOM-free: only OffscreenCanvas/ImageData/ImageBitmap, which exist in both the DOM and WebWorker libs.
import type { BitmapHandle } from '../app/bitmap-handle.ts';
import { OutOfMemoryError } from '../app/errors.ts';
import type { Raster } from './geometry.ts';

export function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Copy of the sub-rectangle [x, x+w) x [y, y+h). */
export function cropRaster(r: Raster, x: number, y: number, w: number, h: number): Raster {
  const out = createRaster(w, h);
  for (let j = 0; j < h; j++) {
    const s = ((y + j) * r.width + x) * 4;
    out.data.set(r.data.subarray(s, s + w * 4), j * w * 4);
  }
  return out;
}

/** Output surface the tiles are assembled into and encoded from. */
export interface Surface2D {
  readonly width: number;
  readonly height: number;
  putRaster(r: Raster, x: number, y: number): void;
  encode(mime: 'image/jpeg' | 'image/png', quality: number): Promise<Blob>;
  /** Frees the backing store (canvas width = height = 0). Idempotent. */
  release(): void;
}

/** Decoded source the tiles are read from, one ROI at a time. */
export interface SourceImage {
  readonly width: number;
  readonly height: number;
  /** Pre-allocates the scratch storage for ROIs up to w x h (the plan envelope). */
  reserve(w: number, h: number): void;
  /** Reads the source rectangle (sx, sy, sw, sh), reduced to rw x rh with high-quality smoothing. */
  readRegion(sx: number, sy: number, sw: number, sh: number, rw: number, rh: number): Raster;
  /** Frees scratch storage and closes the underlying bitmap. Idempotent. */
  release(): void;
}

type OffCtx = OffscreenCanvasRenderingContext2D;
function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffCtx } {
  const Off = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (!Off) throw new OutOfMemoryError('No canvas is available in this browser');
  let canvas: OffscreenCanvas;
  try {
    canvas = new Off(Math.max(1, w), Math.max(1, h));
  } catch (e) {
    throw new OutOfMemoryError('Could not allocate a canvas', { cause: e });
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    canvas.width = 0;
    canvas.height = 0;
    throw new OutOfMemoryError('Could not allocate a canvas context');
  }
  return { canvas, ctx };
}

export class OffscreenSurface implements Surface2D {
  private canvas: OffscreenCanvas | null;
  private readonly ctx: OffCtx;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const c = makeCanvas(width, height);
    this.canvas = c.canvas;
    this.ctx = c.ctx;
  }
  putRaster(r: Raster, x: number, y: number): void {
    if (!this.canvas) throw new Error('Surface is released');
    this.ctx.putImageData(new ImageData(r.data, r.width, r.height), x, y);
  }
  async encode(mime: 'image/jpeg' | 'image/png', quality: number): Promise<Blob> {
    if (!this.canvas) throw new Error('Surface is released');
    return this.canvas.convertToBlob({ type: mime, quality });
  }
  release(): void {
    if (!this.canvas) return;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas = null;
  }
}

/** ROI reader over a decoded bitmap. One scratch canvas, grown only if a read needs more room. */
export class BitmapSource implements SourceImage {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffCtx | null = null;
  constructor(private readonly handle: BitmapHandle) {}
  get width(): number {
    return this.handle.width;
  }
  get height(): number {
    return this.handle.height;
  }
  reserve(w: number, h: number): void {
    if (!this.canvas || !this.ctx) {
      const c = makeCanvas(w, h);
      this.canvas = c.canvas;
      this.ctx = c.ctx;
    } else if (w > this.canvas.width || h > this.canvas.height) {
      this.canvas.width = Math.max(w, this.canvas.width);
      this.canvas.height = Math.max(h, this.canvas.height);
    }
  }
  readRegion(sx: number, sy: number, sw: number, sh: number, rw: number, rh: number): Raster {
    this.reserve(rw, rh);
    const ctx = this.ctx!;
    ctx.clearRect(0, 0, rw, rh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.handle.bitmap, sx, sy, sw, sh, 0, 0, rw, rh);
    const img = ctx.getImageData(0, 0, rw, rh);
    return { width: rw, height: rh, data: img.data };
  }
  release(): void {
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.ctx = null;
    this.handle.close();
  }
}
