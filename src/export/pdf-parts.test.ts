import { describe, expect, it } from 'vitest';
import { PDF_LIMITS } from '../app/config.ts';
import { isOversizedPart, pdfLimits, planPdfParts, totalBytes } from './pdf-parts.ts';

const MB = 1024 * 1024;

describe('planPdfParts', () => {
  it('keeps a small poster in one part', () => {
    expect(planPdfParts([MB, MB, MB], 60 * MB, 12)).toEqual([[0, 1, 2]]);
  });
  it('splits at the page limit', () => {
    const parts = planPdfParts(new Array<number>(30).fill(MB), 150 * MB, 12);
    expect(parts.map((p) => p.length)).toEqual([12, 12, 6]);
    expect(parts.flat()).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });
  it('splits at the byte limit, greedily and in order', () => {
    const parts = planPdfParts([30 * MB, 25 * MB, 10 * MB, 50 * MB, 5 * MB], 60 * MB, 40);
    expect(parts).toEqual([[0, 1], [2, 3], [4]]);
  });
  it('puts a single shot larger than the limit into its own part', () => {
    const sizes = [10 * MB, 90 * MB, 10 * MB, 10 * MB];
    const parts = planPdfParts(sizes, 60 * MB, 12);
    expect(parts).toEqual([[0], [1], [2, 3]]);
    expect(isOversizedPart(parts[1]!, sizes, 60 * MB)).toBe(true);
    expect(isOversizedPart(parts[0]!, sizes, 60 * MB)).toBe(false);
    expect(isOversizedPart(parts[2]!, sizes, 60 * MB)).toBe(false);
  });
  it('every part respects both limits (property over random sizes)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (const limits of [PDF_LIMITS.ios, PDF_LIMITS.other]) {
      for (let run = 0; run < 200; run++) {
        const n = 1 + Math.floor(rnd() * 60);
        const sizes = Array.from({ length: n }, () => Math.floor(rnd() * 40 * MB));
        const parts = planPdfParts(sizes, limits.maxBytes, limits.maxPages);
        expect(parts.flat()).toEqual(sizes.map((_, i) => i));
        for (const p of parts) {
          expect(p.length).toBeLessThanOrEqual(limits.maxPages);
          const bytes = p.reduce((a, i) => a + sizes[i]!, 0);
          if (p.length > 1) expect(bytes).toBeLessThanOrEqual(limits.maxBytes);
        }
      }
    }
  });
  it('returns nothing for no shots', () => {
    expect(planPdfParts([], MB, 5)).toEqual([]);
    expect(totalBytes([1, 2, 3])).toBe(6);
  });
});

describe('platform limits (config.ts)', () => {
  it('iOS: 12 pages / 60 MB; elsewhere 40 pages / 150 MB', () => {
    expect(pdfLimits(true)).toEqual({ maxPages: 12, maxBytes: 60 * MB });
    expect(pdfLimits(false)).toEqual({ maxPages: 40, maxBytes: 150 * MB });
  });
});
