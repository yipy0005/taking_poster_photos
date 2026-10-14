import { describe, expect, it } from 'vitest';
import type { Quad } from '../../cv/geometry.ts';
import { computeOutputSize } from '../../cv/output-size.ts';
import {
  NO_EDGES_MESSAGE,
  describeOutput,
  shouldSuggestBrighten,
  fromDetection,
  largePhotoNotice,
  previewScale,
  previewTooLarge,
  toOriginal,
  toPreview,
  validatorFor,
} from './adjust-logic.ts';

const ORIG = { w: 4000, h: 3000 };

describe('preview <-> original scaling (finding 13)', () => {
  it('uses s = origW / previewW per axis', () => {
    const s = previewScale(4000, 3000, 2048, 1536);
    expect(s.sx).toBeCloseTo(4000 / 2048, 10);
    expect(s.sy).toBeCloseTo(3000 / 1536, 10);
  });

  it('round-trips a quad', () => {
    const s = previewScale(ORIG.w, ORIG.h, 1000, 750);
    const q: Quad = [[100, 100], [900, 110], [880, 650], [120, 640]];
    const back = toPreview(toOriginal(q, s), s);
    back.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(q[i]![0], 9);
      expect(p[1]).toBeCloseTo(q[i]![1], 9);
    });
  });

  it('the validator judges the original-pixel quad at two preview scales (0.5 and 0.25)', () => {
    const q: Quad = [[200, 200], [800, 200], [800, 560], [200, 560]];
    for (const previewW of [2000, 1000]) {
      const s = previewScale(ORIG.w, ORIG.h, previewW, (previewW * ORIG.h) / ORIG.w);
      expect(validatorFor(s, ORIG.w, ORIG.h)(q)).toBe(true);
    }
  });
});

describe('fromDetection (AC-8, AC-9)', () => {
  const raster = { width: 1600, height: 1200 };

  it('scales a detected quad from the detection raster to original pixels', () => {
    const detected: Quad = [[160, 120], [1440, 130], [1430, 1080], [170, 1070]];
    const d = fromDetection({ quad: detected, found: true, engine: 'js' }, raster, ORIG.w, ORIG.h);
    expect(d.source).toBe('auto-js');
    expect(d.message).toBeNull();
    expect(d.quad[0][0]).toBeCloseTo(400, 6);
    expect(d.quad[2][1]).toBeCloseTo(2700, 6);
  });

  it('reports the OpenCV source', () => {
    const detected: Quad = [[160, 120], [1440, 130], [1430, 1080], [170, 1070]];
    expect(fromDetection({ quad: detected, found: true, engine: 'opencv' }, raster, ORIG.w, ORIG.h).source).toBe('auto-opencv');
  });

  it('falls back to the 8% inset rectangle with the "Couldn\'t find edges" message when nothing was found', () => {
    const d = fromDetection({ quad: [[0, 0], [1, 0], [1, 1], [0, 1]], found: false, engine: 'js' }, raster, ORIG.w, ORIG.h);
    expect(d.message).toBe(NO_EDGES_MESSAGE);
    expect(d.message).toBe("Couldn't find edges, drag the corners");
    expect(d.source).toBe('default');
    expect(d.quad).toEqual([[320, 240], [3680, 240], [3680, 2760], [320, 2760]]);
  });

  it('also falls back when the scaled quad does not validate', () => {
    const tiny: Quad = [[10, 10], [20, 10], [20, 20], [10, 20]];
    expect(fromDetection({ quad: tiny, found: true, engine: 'js' }, raster, ORIG.w, ORIG.h).source).toBe('default');
  });
});

describe('notices', () => {
  it('flags oversize photos and strike-reduced previews, but not a normal 2048 preview', () => {
    expect(largePhotoNotice({ oversize: true, origW: 12000, origH: 9000, previewW: 2048, previewH: 1536 })).toBe(
      'Large photo (108 MP): working from a reduced copy; export uses the original',
    );
    expect(largePhotoNotice({ origW: 4000, origH: 3000, previewW: 2048, previewH: 1536 })).toBeNull();
    expect(largePhotoNotice({ origW: 4000, origH: 3000, previewW: 1024, previewH: 768 })).toMatch(/^Large photo \(12 MP\)/);
    expect(largePhotoNotice({ origW: 1000, origH: 800, previewW: 1000, previewH: 800 })).toBeNull();
  });

  it('too-large-to-preview starts at three strikes', () => {
    expect(previewTooLarge(2)).toBe(false);
    expect(previewTooLarge(3)).toBe(true);
  });

  it('describes the output and the "Reduced to N MP" cap notice', () => {
    const q: Quad = [[0, 0], [8000, 0], [8000, 6000], [0, 6000]];
    const capped = describeOutput(computeOutputSize(q, 'free', { cap: 16_777_216 }));
    expect(capped.text).toBe('Output 4729 x 3546 px (16.8 MP)');
    expect(capped.reduced).toBe('Reduced to 16.8 MP for this device');
    const plain = describeOutput(computeOutputSize(q, 'free', { cap: 50_000_000 }));
    expect(plain.reduced).toBeNull();
  });
});
describe('shouldSuggestBrighten', () => {
  it('suggests Brighten only for very dark photos', () => {
    expect(shouldSuggestBrighten({ mean: 12, p95: 30 })).toBe(true);
    expect(shouldSuggestBrighten({ mean: 120, p95: 230 })).toBe(false);
    expect(shouldSuggestBrighten({ mean: 30, p95: 200 })).toBe(false);
    expect(shouldSuggestBrighten(null)).toBe(false);
  });
});
