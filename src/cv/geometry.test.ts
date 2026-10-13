import { describe, expect, it } from 'vitest';
import { InvalidQuadError } from '../app/errors.ts';
import { defaultInsetQuad, isStrictlyConvex, quadArea, scaleQuad, validateQuad, type Quad } from './geometry.ts';

const W = 4000;
const H = 3000;
const GOOD: Quad = [
  [400, 300],
  [3600, 340],
  [3550, 2700],
  [450, 2650],
];

describe('validateQuad (original pixels)', () => {
  it('accepts a normal quad and the full frame', () => {
    expect(() => validateQuad(GOOD, W, H)).not.toThrow();
    expect(() => validateQuad([[0, 0], [W, 0], [W, H], [0, H]], W, H)).not.toThrow();
  });
  it('rejects non-finite, wrong-count and out-of-frame corners', () => {
    expect(() => validateQuad([[NaN, 0], GOOD[1], GOOD[2], GOOD[3]], W, H)).toThrow(InvalidQuadError);
    expect(() => validateQuad([GOOD[0], GOOD[1], GOOD[2]] as unknown as Quad, W, H)).toThrow(InvalidQuadError);
    expect(() => validateQuad([[-1, 300], GOOD[1], GOOD[2], GOOD[3]], W, H)).toThrow(InvalidQuadError);
    expect(() => validateQuad([GOOD[0], [W + 1, 340], GOOD[2], GOOD[3]], W, H)).toThrow(InvalidQuadError);
  });
  it('rejects bow-ties and concave shapes', () => {
    expect(() => validateQuad([GOOD[0], GOOD[2], GOOD[1], GOOD[3]], W, H)).toThrow(/convex/);
    expect(() => validateQuad([[400, 300], [3600, 300], [3600, 2700], [1000, 800]], W, H)).not.toThrow(); // still convex
    expect(() => validateQuad([[400, 300], [3600, 300], [3600, 2700], [3000, 600]], W, H)).toThrow(/convex/);
    expect(isStrictlyConvex([[0, 0], [10, 0], [20, 0], [0, 10]])).toBe(false); // collinear
  });
  it('rejects areas under 1% of the frame', () => {
    const tiny: Quad = [[100, 100], [400, 100], [400, 300], [100, 300]]; // 60,000 px = 0.5%
    expect(() => validateQuad(tiny, W, H)).toThrow(/small/);
  });
  it('rejects an edge shorter than 24 px even when the area is large', () => {
    const wedge: Quad = [[1990, 100], [2010, 100], [3000, 1100], [1000, 1100]]; // top edge 20 px, area ~1.0 MP
    expect(quadArea(wedge)).toBeGreaterThan(0.01 * W * H);
    expect(() => validateQuad(wedge, W, H)).toThrow(/short/);
    const ok: Quad = [[1985, 100], [2015, 100], [3000, 1100], [1000, 1100]]; // 30 px
    expect(() => validateQuad(ok, W, H)).not.toThrow();
  });
});

describe('validateQuad runs in ORIGINAL pixels (finding 13)', () => {
  // A quad with a 30 px original top edge is valid. In preview pixels it is 15 px (scale 0.5) or 7.5 px (scale 0.25),
  // which a preview-space check would wrongly reject.
  const original: Quad = [[1985, 100], [2015, 100], [3000, 1100], [1000, 1100]];
  for (const s of [0.5, 0.25]) {
    it(`preview scale ${s}: converting with 1/s before validating accepts it, a preview-space check does not`, () => {
      const preview = scaleQuad(original, s);
      expect(() => validateQuad(preview, W * s, H * s)).toThrow(/short/);
      const back = scaleQuad(preview, 1 / s);
      expect(() => validateQuad(back, W, H)).not.toThrow();
    });
    it(`preview scale ${s}: a genuinely short edge is still rejected after conversion`, () => {
      const bad = scaleQuad(scaleQuad([[1990, 100], [2010, 100], [3000, 1100], [1000, 1100]], s), 1 / s);
      expect(() => validateQuad(bad, W, H)).toThrow(/short/);
    });
  }
});

describe('helpers', () => {
  it('defaultInsetQuad is the 8% inset rectangle', () => {
    const q = defaultInsetQuad(1000, 500);
    expect(q[0]).toEqual([80, 40]);
    expect(q[2]).toEqual([920, 460]);
    expect(() => validateQuad(q, 1000, 500)).not.toThrow();
  });
  it('scaleQuad multiplies per axis', () => {
    expect(scaleQuad(GOOD, 0.5, 2)[1]).toEqual([1800, 680]);
  });
});
