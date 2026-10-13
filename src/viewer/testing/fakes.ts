// Test support (not imported by app code): fake bitmaps wrapped in real BitmapHandles so the live-handle tracker sees them.
import { BitmapHandle } from '../../app/bitmap-handle.ts';
import type { DecodeResult } from '../../app/decode.ts';

export interface FakeBitmapState {
  width: number;
  height: number;
  closed: number;
}

export function fakeBitmap(width: number, height: number): ImageBitmap & FakeBitmapState {
  const b = {
    width,
    height,
    closed: 0,
    close() {
      b.closed++;
    },
  };
  return b as unknown as ImageBitmap & FakeBitmapState;
}

export function fakeHandle(width: number, height: number, label = 'fake'): BitmapHandle {
  return new BitmapHandle(fakeBitmap(width, height), label);
}

/** A decode result of `w x h` for a source image of `srcW x srcH`. */
export function fakeResult(w: number, h: number, srcW: number = w, srcH: number = h, label = 'fake'): DecodeResult {
  return { handle: fakeHandle(w, h, label), width: w, height: h, sourceWidth: srcW, sourceHeight: srcH, scale: w / srcW, reduced: w < srcW };
}
