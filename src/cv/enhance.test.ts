import { describe, expect, it } from 'vitest';
import { applyLuts, computeLuts, hasEnhancement, NO_ENHANCEMENT, unsharp } from './enhance.ts';
import type { Raster } from './geometry.ts';
import { createRaster, cropRaster } from './raster2d.ts';

function filled(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Raster {
  const r = createRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [R, G, B] = f(x, y);
      r.data.set([R, G, B, 255], (y * w + x) * 4);
    }
  }
  return r;
}

describe('flags', () => {
  it('default is all off', () => {
    expect(hasEnhancement(NO_ENHANCEMENT)).toBe(false);
    expect(computeLuts(createRaster(2, 2), NO_ENHANCEMENT)).toBeNull();
    expect(computeLuts(createRaster(2, 2), { ...NO_ENHANCEMENT, sharpen: true })).toBeNull();
  });
});

describe('auto-contrast', () => {
  it('stretches a dull 60..180 range to the full range', () => {
    const img = filled(100, 100, (x) => {
      const v = 60 + Math.round((x / 99) * 120);
      return [v, v, v];
    });
    const luts = computeLuts(img, { ...NO_ENHANCEMENT, autoContrast: true })!;
    expect(luts[0][60]).toBe(0);
    expect(luts[0][180]).toBe(255);
    expect(luts[0][120]).toBeGreaterThan(100);
    expect(luts[0][120]).toBeLessThan(160);
    const copy = cropRaster(img, 0, 0, 100, 100);
    applyLuts(copy, luts);
    expect(copy.data[0]).toBeLessThanOrEqual(5);
  });
  it('leaves a flat image untouched', () => {
    const img = filled(10, 10, () => [100, 100, 100]);
    const luts = computeLuts(img, { ...NO_ENHANCEMENT, autoContrast: true })!;
    expect(luts[0][100]).toBe(100);
  });
});

describe('white balance (gray world)', () => {
  it('pulls a warm cast towards neutral', () => {
    const img = filled(20, 20, () => [200, 150, 100]);
    const luts = computeLuts(img, { ...NO_ENHANCEMENT, whiteBalance: true })!;
    const out = cropRaster(img, 0, 0, 20, 20);
    applyLuts(out, luts);
    expect(Math.abs(out.data[0]! - out.data[1]!)).toBeLessThanOrEqual(2);
    expect(Math.abs(out.data[1]! - out.data[2]!)).toBeLessThanOrEqual(2);
  });
});

describe('unsharp', () => {
  it('does not change a flat region', () => {
    const img = filled(9, 9, () => [120, 120, 120]);
    unsharp(img);
    expect(Array.from(img.data.slice(0, 4))).toEqual([120, 120, 120, 255]);
  });
  it('increases contrast at an edge, luma only (alpha untouched)', () => {
    const img = filled(10, 4, (x) => (x < 5 ? [80, 80, 80] : [160, 160, 160]));
    unsharp(img);
    const at = (x: number) => img.data[(1 * 10 + x) * 4]!;
    expect(at(4)).toBeLessThan(80);
    expect(at(5)).toBeGreaterThan(160);
    expect(img.data[3]).toBe(255);
  });
});
