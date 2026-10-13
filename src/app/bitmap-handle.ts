// BitmapHandle: single-owner ImageBitmap wrapper with idempotent close() and a live-handle tracker
// (test hook for AC-37). DOM-free: ImageBitmap exists in both the DOM and WebWorker libs.

/** Handles at or above this pixel count count as "full-resolution" in the tracker (2048 x 2048). */
export const FULL_RES_PIXELS = 2048 * 2048;

interface Live {
  pixels: number;
  label: string;
}

const live = new Map<number, Live>();
let nextId = 1;
let peakFull = 0;
let peakAll = 0;

export const bitmapTracker = {
  /** Number of handles not yet closed. */
  liveCount: (): number => live.size,
  /** Number of live handles with at least `minPixels` pixels. */
  liveFullCount: (minPixels = FULL_RES_PIXELS): number => {
    let n = 0;
    for (const h of live.values()) if (h.pixels >= minPixels) n++;
    return n;
  },
  /** Highest simultaneous count of full-resolution handles since the last reset. */
  peakFull: (): number => peakFull,
  peakAll: (): number => peakAll,
  snapshot: (): Live[] => Array.from(live.values()),
  reset(): void {
    live.clear();
    peakFull = 0;
    peakAll = 0;
  },
};

export class BitmapHandle {
  private bitmap_: ImageBitmap | null;
  private readonly id = nextId++;
  readonly width: number;
  readonly height: number;

  constructor(bitmap: ImageBitmap, label = 'bitmap') {
    this.bitmap_ = bitmap;
    this.width = bitmap.width;
    this.height = bitmap.height;
    live.set(this.id, { pixels: bitmap.width * bitmap.height, label });
    peakAll = Math.max(peakAll, live.size);
    peakFull = Math.max(peakFull, bitmapTracker.liveFullCount());
  }

  get closed(): boolean {
    return this.bitmap_ === null;
  }

  /** The underlying bitmap. Throws once closed. */
  get bitmap(): ImageBitmap {
    if (!this.bitmap_) throw new Error('BitmapHandle is closed');
    return this.bitmap_;
  }

  get pixels(): number {
    return this.width * this.height;
  }

  close(): void {
    const b = this.bitmap_;
    if (!b) return;
    this.bitmap_ = null;
    live.delete(this.id);
    try {
      b.close();
    } catch {
      // closing twice or on a detached bitmap is harmless
    }
  }
}
