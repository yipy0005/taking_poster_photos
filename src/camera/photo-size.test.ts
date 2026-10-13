import { describe, expect, it } from 'vitest';
import { pickPhotoSize, type PhotoSizeCaps } from './photo-size.ts';

const caps = (w: [number, number, number], h: [number, number, number]): PhotoSizeCaps => ({
  imageWidth: { min: w[0], max: w[1], step: w[2] },
  imageHeight: { min: h[0], max: h[1], step: h[2] },
});

describe('pickPhotoSize (AC-2)', () => {
  const sensor108 = caps([1, 12000, 1], [1, 9000, 1]);

  it('clamps a 12000x9000 (108 MP) sensor to 9237x6928 at the 64 MP limit', () => {
    const s = pickPhotoSize(sensor108, 64e6);
    expect(s).toEqual({ imageWidth: 9237, imageHeight: 6928 });
    expect(s.imageWidth * s.imageHeight).toBe(63_993_936);
  });

  it('clamps the same sensor to 8164x6123 at the 50 MP (iOS) limit', () => {
    const s = pickPhotoSize(sensor108, 50e6);
    expect(s).toEqual({ imageWidth: 8164, imageHeight: 6123 });
    expect(s.imageWidth * s.imageHeight).toBe(49_988_172);
  });

  it('asks a camera within the budget for exactly its maximum', () => {
    expect(pickPhotoSize(caps([64, 4032, 1], [64, 3024, 1]), 64e6)).toEqual({ imageWidth: 4032, imageHeight: 3024 });
  });

  it('rounds down onto the advertised step grid above min', () => {
    const c = caps([16, 8000, 16], [16, 6000, 16]);
    const s = pickPhotoSize(c, 30e6);
    expect((s.imageWidth - 16) % 16).toBe(0);
    expect((s.imageHeight - 16) % 16).toBe(0);
    expect(s.imageWidth * s.imageHeight).toBeLessThanOrEqual(30e6);
    expect(s).toEqual({ imageWidth: 6320, imageHeight: 4736 });
  });

  it('keeps an in-budget maximum on a stepped grid untouched', () => {
    expect(pickPhotoSize(caps([16, 8000, 16], [16, 6000, 16]), 64e6)).toEqual({ imageWidth: 8000, imageHeight: 6000 });
  });

  it('treats a step of 0 as 1', () => {
    const s = pickPhotoSize(caps([0, 12000, 0], [0, 9000, 0]), 64e6);
    expect(s).toEqual({ imageWidth: 9237, imageHeight: 6928 });
  });

  it('uses the camera minimum when min is larger than the clamped size', () => {
    const s = pickPhotoSize(caps([4000, 12000, 1], [3000, 9000, 1]), 1e6);
    expect(s).toEqual({ imageWidth: 4000, imageHeight: 3000 });
  });

  it('never exceeds max after snapping', () => {
    const s = pickPhotoSize(caps([10, 100, 7], [10, 100, 7]), 1e12);
    expect(s).toEqual({ imageWidth: 100, imageHeight: 100 });
  });
});
