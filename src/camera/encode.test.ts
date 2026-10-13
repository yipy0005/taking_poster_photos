import { describe, expect, it } from 'vitest';
import { orientationTransform } from './encode.ts';

type Pt = [number, number];
const apply = (m: readonly number[], [x, y]: Pt): Pt => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];

// Stored image 4 wide x 2 tall. Corners: TL(0,0) TR(4,0) BR(4,2) BL(0,2).
const W = 4;
const H = 2;
const corners: Record<'TL' | 'TR' | 'BR' | 'BL', Pt> = { TL: [0, 0], TR: [W, 0], BR: [W, H], BL: [0, H] };

describe('orientationTransform (EXIF 1..8)', () => {
  // Where each stored corner must land in the upright image, per the EXIF specification.
  const expected: Record<number, { size: [number, number]; TL: Pt; TR: Pt }> = {
    1: { size: [4, 2], TL: [0, 0], TR: [4, 0] },
    2: { size: [4, 2], TL: [4, 0], TR: [0, 0] }, // mirror horizontal
    3: { size: [4, 2], TL: [4, 2], TR: [0, 2] }, // rotate 180
    4: { size: [4, 2], TL: [0, 2], TR: [4, 2] }, // mirror vertical
    5: { size: [2, 4], TL: [0, 0], TR: [0, 4] }, // transpose
    6: { size: [2, 4], TL: [2, 0], TR: [2, 4] }, // rotate 90 clockwise
    7: { size: [2, 4], TL: [2, 4], TR: [2, 0] }, // transverse
    8: { size: [2, 4], TL: [0, 4], TR: [0, 0] }, // rotate 90 counter-clockwise
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('orientation %i', (o) => {
    const t = orientationTransform(o, W, H);
    const e = expected[o]!;
    expect([t.width, t.height]).toEqual(e.size);
    expect(apply(t.matrix, corners.TL)).toEqual(e.TL);
    expect(apply(t.matrix, corners.TR)).toEqual(e.TR);
    // every corner lands inside the output rectangle
    for (const p of Object.values(corners)) {
      const [x, y] = apply(t.matrix, p);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(t.width);
      expect(y).toBeLessThanOrEqual(t.height);
    }
  });

  it('treats unknown values as identity', () => {
    expect(orientationTransform(0, 5, 3)).toEqual({ matrix: [1, 0, 0, 1, 0, 0], width: 5, height: 3 });
    expect(orientationTransform(99, 5, 3).width).toBe(5);
  });
});
