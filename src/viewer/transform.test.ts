import { describe, expect, it } from 'vitest';
import type { Rotation } from '../cv/geometry.ts';
import {
  MAX_BACKING_PIXELS,
  axisRange,
  backingSize,
  clampScale,
  clampTranslation,
  doubleTapTarget,
  drawMatrix,
  fitScale,
  fitView,
  normalizeRotation,
  orientedSize,
  useBaseBitmap,
  viewToOriented,
  visibleSourceRect,
  zoomAbout,
  zoomFactor,
  zoomLimits,
} from './transform.ts';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

describe('backing store', () => {
  it('multiplies by dpr capped at 3', () => {
    expect(backingSize(360, 640, 2)).toEqual({ w: 720, h: 1280 });
    expect(backingSize(200, 200, 5)).toEqual({ w: 600, h: 600 });
  });
  it('never exceeds 4 MP in total', () => {
    const s = backingSize(1200, 2600, 3);
    expect(s.w * s.h).toBeLessThanOrEqual(MAX_BACKING_PIXELS);
    expect(s.w / s.h).toBeCloseTo(1200 / 2600, 2);
  });
  it('tolerates a bad dpr', () => {
    expect(backingSize(100, 100, Number.NaN)).toEqual({ w: 100, h: 100 });
    expect(backingSize(100, 100, 0)).toEqual({ w: 100, h: 100 });
  });
});

describe('fit and rotation', () => {
  it('swaps the axes for 90 and 270 degrees', () => {
    expect(orientedSize(400, 300, 90)).toEqual({ w: 300, h: 400 });
    expect(orientedSize(400, 300, 180)).toEqual({ w: 400, h: 300 });
  });
  it('fits the rotated image inside the viewport', () => {
    const vp = { w: 1000, h: 500 };
    expect(fitScale(400, 300, 0, vp)).toBeCloseTo(500 / 300, 6);
    expect(fitScale(400, 300, 90, vp)).toBeCloseTo(500 / 400, 6);
  });
  it('centers the fit view', () => {
    const v = fitView(400, 300, 0, { w: 1000, h: 500 });
    expect(v.tx).toBeCloseTo((1000 - 400 * v.scale) / 2, 6);
    expect(v.ty).toBeCloseTo(0, 6);
  });
  it('normalizes rotation to 0..270 clockwise', () => {
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(0 - 360)).toBe(0);
  });
});

describe('zoom limits against the bitmap in use (AC-22)', () => {
  const vp = { w: 1080, h: 1920 };
  it('a 12 MP rectified image reaches at least 8x relative to fit', () => {
    const fit = fitScale(4000, 3000, 0, vp);
    const l = zoomLimits(fit, 1);
    expect(l.zMax).toBeGreaterThanOrEqual(8);
    expect(l.maxScale / fit).toBeGreaterThanOrEqual(8);
    // individual source pixels are magnified at the top zoom
    expect(l.maxScale).toBeGreaterThanOrEqual(2);
  });
  it('magnifies bitmap pixels at least 2x at max zoom, up to the hard cap of 32', () => {
    for (const [w, h] of [[12000, 9000], [8000, 6000], [4000, 3000], [2000, 1500]] as const) {
      const fit = fitScale(w, h, 0, vp);
      const l = zoomLimits(fit, 1);
      expect(l.zMax).toBeLessThanOrEqual(32);
      if (l.zMax < 32) expect(l.maxScale / 1).toBeGreaterThanOrEqual(2 - 1e-9);
    }
  });
  it('is stated against a reduced bitmap: the 8x holds for it and magnification is per bitmap pixel', () => {
    const imageW = 12000;
    const bitmapW = 6000; // strike-reduced decode
    const k = bitmapW / imageW;
    const fit = fitScale(imageW, 9000, 0, vp);
    const l = zoomLimits(fit, k);
    expect(l.zMax).toBeGreaterThanOrEqual(8);
    // device pixels per BITMAP pixel at max zoom
    expect(l.maxScale / k).toBeGreaterThanOrEqual(2 - 1e-9);
  });
  it('never goes below 1x of fit and caps at 32', () => {
    const l = zoomLimits(0.001, 1);
    expect(l.zMin).toBe(1);
    expect(l.zMax).toBe(32);
    expect(clampScale(0.0001, l)).toBe(l.minScale);
    expect(clampScale(1e9, l)).toBe(l.maxScale);
  });
  it('allows a 10% overshoot while pinching', () => {
    const l = zoomLimits(1, 1);
    expect(clampScale(l.maxScale * 2, l, 0.1)).toBeCloseTo(l.maxScale * 1.1, 6);
    expect(clampScale(0.01, l, 0.1)).toBeCloseTo(0.9, 6);
  });
  it('shows the zoom factor relative to fit', () => {
    expect(zoomFactor(3, 0.5)).toBe(6);
  });
});

describe('translation clamping', () => {
  const vp = { w: 1000, h: 800 };
  it('centers an image smaller than the viewport on that axis', () => {
    expect(axisRange(400, 1000)).toEqual({ min: 300, max: 300 });
  });
  it('lets a large image leave the viewport by at most 10%', () => {
    const r = axisRange(3000, 1000);
    expect(r.max).toBe(100);
    expect(r.min).toBe(1000 - 3000 - 100);
    const c = clampTranslation({ scale: 3, tx: 500, ty: -99999 }, 1000, 800, 0, vp);
    expect(c.tx).toBe(100);
    expect(c.ty).toBe(800 - 2400 - 80);
  });
});

describe('zoom about a point', () => {
  it('keeps the image point under the anchor fixed', () => {
    const v = { scale: 1.2, tx: 40, ty: -30 };
    const before = viewToOriented(v, 300, 200);
    const z = zoomAbout(v, 4.8, 300, 200);
    const after = viewToOriented(z, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(z.scale).toBe(4.8);
  });
});

describe('double tap', () => {
  const vp = { w: 1000, h: 800 };
  const fit = fitView(4000, 3000, 0, vp);
  const l = zoomLimits(fit.scale, 1);
  it('goes from fit to about 4x centered on the tap', () => {
    const t = doubleTapTarget(fit, fit, l, 500, 400, 4000, 3000, 0, vp);
    expect(zoomFactor(t.scale, fit.scale)).toBeCloseTo(4, 6);
  });
  it('goes back to fit from a zoomed view', () => {
    const zoomed = { ...fit, scale: fit.scale * 3 };
    expect(doubleTapTarget(zoomed, fit, l, 500, 400, 4000, 3000, 0, vp)).toEqual(fit);
  });
  it('never exceeds zMax', () => {
    const tiny = { zMax: 2, minScale: fit.scale };
    const t = doubleTapTarget(fit, fit, tiny, 500, 400, 4000, 3000, 0, vp);
    expect(zoomFactor(t.scale, fit.scale)).toBeCloseTo(2, 6);
  });
});

describe('draw matrix and visible rectangle', () => {
  const apply = (m: readonly number[], x: number, y: number): [number, number] => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
  it('maps the image corners to the rotated image rectangle', () => {
    const W = 400;
    const H = 300;
    const s = 2;
    for (const r of ROTATIONS) {
      const o = orientedSize(W, H, r);
      const m = drawMatrix(r, W, H, s, 10, 20);
      const pts = [apply(m, 0, 0), apply(m, W, 0), apply(m, 0, H), apply(m, W, H)];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      expect(Math.min(...xs)).toBeCloseTo(10, 6);
      expect(Math.max(...xs)).toBeCloseTo(10 + o.w * s, 6);
      expect(Math.min(...ys)).toBeCloseTo(20, 6);
      expect(Math.max(...ys)).toBeCloseTo(20 + o.h * s, 6);
    }
  });
  it('rotates clockwise: the top-left of the image ends up top-right after 90 degrees', () => {
    const m = drawMatrix(90, 400, 300, 1, 0, 0);
    expect(apply(m, 0, 0)).toEqual([300, 0]);
    expect(apply(m, 400, 0)).toEqual([300, 400]);
  });
  it('computes the visible source rectangle and clamps it to the bitmap', () => {
    const m = drawMatrix(0, 400, 300, 2, -100, -60);
    const r = visibleSourceRect(m, { w: 200, h: 120 }, 400, 300)!;
    expect(r).toEqual({ sx: 50, sy: 30, sw: 100, sh: 60 });
    const whole = visibleSourceRect(drawMatrix(0, 400, 300, 0.5, 0, 0), { w: 1000, h: 1000 }, 400, 300)!;
    expect(whole).toEqual({ sx: 0, sy: 0, sw: 400, sh: 300 });
  });
  it('is correct for rotated views', () => {
    for (const r of ROTATIONS) {
      const m = drawMatrix(r, 400, 300, 1, 0, 0);
      const rect = visibleSourceRect(m, { w: 10000, h: 10000 }, 400, 300)!;
      expect(rect).toEqual({ sx: 0, sy: 0, sw: 400, sh: 300 });
    }
  });
  it('returns null when nothing is visible', () => {
    expect(visibleSourceRect(drawMatrix(0, 400, 300, 1, 5000, 5000), { w: 100, h: 100 }, 400, 300)).toBeNull();
  });
});

describe('source selection', () => {
  it('uses the base bitmap while it still has a pixel per device pixel, or when there is no full bitmap', () => {
    expect(useBaseBitmap(0.3, 0.5, true)).toBe(true);
    expect(useBaseBitmap(0.8, 0.5, true)).toBe(false);
    expect(useBaseBitmap(5, 0.5, false)).toBe(true);
  });
});
