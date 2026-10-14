import { describe, expect, it } from 'vitest';
import { DARK_MEAN, isVeryDark, lumaStats } from './brightness.ts';

function rgba(pixels: Array<[number, number, number, number?]>): Uint8ClampedArray {
  const d = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a = 255], i) => d.set([r, g, b, a], i * 4));
  return d;
}
const fill = (n: number, p: [number, number, number, number?]): Array<[number, number, number, number?]> => Array.from({ length: n }, () => p);

describe('lumaStats / isVeryDark', () => {
  it('flags an all-black frame', () => {
    const s = lumaStats(rgba(fill(100, [0, 0, 0])));
    expect(s).toEqual({ mean: 0, p95: 0 });
    expect(isVeryDark(s)).toBe(true);
  });
  it('flags a uniformly very dark frame', () => {
    expect(isVeryDark(lumaStats(rgba(fill(100, [20, 20, 20]))))).toBe(true);
  });
  it('does not flag mid-grey', () => {
    const s = lumaStats(rgba(fill(100, [128, 128, 128])));
    expect(s.mean).toBeCloseTo(128, 0);
    expect(isVeryDark(s)).toBe(false);
  });
  it('does not flag a bright poster with dark text', () => {
    const s = lumaStats(rgba([...fill(80, [240, 240, 235]), ...fill(20, [40, 40, 40])]));
    expect(isVeryDark(s)).toBe(false);
  });
  it('does not flag a dark-background poster with bright text (p95 term)', () => {
    const s = lumaStats(rgba([...fill(92, [20, 20, 20]), ...fill(8, [240, 240, 240])]));
    expect(s.mean).toBeLessThan(DARK_MEAN);
    expect(s.p95).toBeGreaterThanOrEqual(120);
    expect(isVeryDark(s)).toBe(false);
  });
  it('ignores fully transparent pixels', () => {
    const s = lumaStats(rgba([...fill(50, [200, 200, 200, 0]), ...fill(50, [100, 100, 100])]));
    expect(s.mean).toBeCloseTo(100, 0);
  });
  it('treats an empty sample as black', () => {
    expect(isVeryDark(lumaStats(new Uint8ClampedArray(0)))).toBe(true);
  });
});
