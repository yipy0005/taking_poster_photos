import { describe, expect, it } from 'vitest';
import {
  A_LANDSCAPE,
  A_PORTRAIT,
  GUARD_MARGIN,
  LOW_CONFIDENCE_TILT,
  SNAP_LIST,
  depthRatios,
  estimateAspect,
  focalPrior,
  snapRatio,
} from './aspect.ts';
import { addNoise, mulberry32, percentile, projectPoster } from './testing/synth.ts';

const W = 4000;
const H = 3000;
const RATIOS = [A_PORTRAIT, A_LANDSCAPE, 4 / 3, 16 / 9, 0.5, 1];
const err = (est: number, r: number): number => Math.abs(est / r - 1);
const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const sign = (rng: () => number): number => (rng() < 0.5 ? -1 : 1);
const trueF = (rng: () => number): number => (0.6 + rng() * 0.4) * W; // swept over 0.6..1.0 x long side

describe('A-series constants (finding 10)', () => {
  it('uses 1/sqrt(2) and sqrt(2) in the snap list', () => {
    expect(A_PORTRAIT).toBe(1 / Math.SQRT2);
    expect(A_LANDSCAPE).toBe(Math.SQRT2);
    const aRatios = SNAP_LIST.filter((k) => k.label === 'A-series').map((k) => k.ratio);
    expect(aRatios).toEqual([A_PORTRAIT, A_LANDSCAPE]);
  });
  it('snaps within 2.5% and reports the label', () => {
    expect(snapRatio(0.7071 * 1.02)).toEqual({ ratio: A_PORTRAIT, label: 'A-series' });
    expect(snapRatio(1.5).label).toBeNull();
    expect(snapRatio(4 / 3 / 1.01).label).toBe('4:3');
  });
});

describe('focal prior', () => {
  it('uses 0.75 x long side without EXIF and the diagonal formula with it', () => {
    expect(focalPrior(4000, 3000)).toBe(3000);
    expect(focalPrior(4000, 3000, 26)).toBeCloseTo((26 * 5000) / 43.27, 6);
    expect(focalPrior(4000, 3000, 26) / 4000).toBeCloseTo(0.751, 2);
  });
});

describe('AC-15 oracle: general pose', () => {
  it('is exact (< 1%) noiseless and p90 < 3% with 0.5 px corner noise', () => {
    const rng = mulberry32(7);
    const clean: number[] = [];
    const noisy: number[] = [];
    for (let i = 0; i < 300; i++) {
      const r = pick(rng, RATIOS);
      const q = projectPoster({
        ratio: r,
        f: trueF(rng),
        imgW: W,
        imgH: H,
        yaw: (15 + rng() * 35) * sign(rng),
        pitch: (15 + rng() * 35) * sign(rng),
        roll: (rng() - 0.5) * 10,
      });
      const e = estimateAspect(q, W, H);
      expect(e.usedPrior).toBe(false);
      expect(e.confidence).toBe('high');
      clean.push(err(e.rawRatio, r));
      noisy.push(err(estimateAspect(addNoise(q, 0.5, rng), W, H).rawRatio, r));
    }
    expect(Math.max(...clean)).toBeLessThan(0.01);
    expect(percentile(noisy, 0.9)).toBeLessThan(0.03);
  });
  it('fronto-parallel: error < 1% and the prior is used', () => {
    for (const r of RATIOS) {
      const q = projectPoster({ ratio: r, f: 3200, imgW: W, imgH: H });
      const e = estimateAspect(q, W, H);
      expect(err(e.rawRatio, r)).toBeLessThan(0.01);
      expect(e.usedPrior).toBe(true);
    }
  });
});

describe('AC-15 oracle: single-axis tilt (finding 4 envelope)', () => {
  const sample = (lo: number, hi: number, n: number, seed: number) => {
    const rng = mulberry32(seed);
    const rows: Array<{ e: number; conf: string; usedPrior: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const axis = rng() < 0.5 ? 'yaw' : 'pitch';
      const ang = (lo + rng() * (hi - lo)) * sign(rng);
      const r = pick(rng, RATIOS);
      const q = projectPoster({ ratio: r, f: trueF(rng), imgW: W, imgH: H, [axis]: ang });
      const est = estimateAspect(q, W, H);
      rows.push({ e: err(est.rawRatio, r), conf: est.confidence, usedPrior: est.usedPrior });
    }
    return rows;
  };
  it('up to 25 degrees: error below 6%', () => {
    const rows = sample(0, 25, 1500, 11);
    expect(Math.max(...rows.map((r) => r.e))).toBeLessThan(0.06);
    expect(rows.every((r) => r.usedPrior)).toBe(true);
  });
  it('25-50 degrees: p90 <= 10% (measured p90 9.7%, max 15.7%) and large errors are flagged low confidence', () => {
    const rows = sample(25, 50, 1500, 12);
    expect(percentile(rows.map((r) => r.e), 0.9)).toBeLessThanOrEqual(0.1);
    const bad = rows.filter((r) => r.e > 0.1);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.filter((r) => r.conf === 'low').length / bad.length).toBeGreaterThan(0.9);
  });
  it('the measured threshold separates trustworthy from low-confidence results', () => {
    expect(LOW_CONFIDENCE_TILT).toBe(0.2);
    const rows = sample(0, 50, 3000, 13);
    const trusted = rows.filter((r) => r.conf !== 'low').map((r) => r.e);
    expect(percentile(trusted, 0.9)).toBeLessThan(0.045);
    expect(Math.max(...trusted)).toBeLessThan(0.16); // measured 14.7%: |k-1| is a proxy for tilt, a few outliers remain
  });
});

describe('AC-15 oracle: guard zone and near-single-axis yaw', () => {
  it('takes the prior branch whenever |k-1| is below the guard margin', () => {
    const rng = mulberry32(5);
    let seen = 0;
    for (let i = 0; i < 400; i++) {
      const q = projectPoster({
        ratio: pick(rng, RATIOS),
        f: trueF(rng),
        imgW: W,
        imgH: H,
        yaw: (rng() - 0.5) * 40,
        pitch: (rng() - 0.5) * 3, // near-zero pitch => one depth ratio is near 1
      });
      const { k2, k3 } = depthRatios(q, W, H);
      const e = estimateAspect(q, W, H);
      if (Math.abs(k2 - 1) < GUARD_MARGIN || Math.abs(k3 - 1) < GUARD_MARGIN) {
        seen++;
        expect(e.usedPrior).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(50);
  });
  it('near-single-axis yaw 15-50 with pitch 0-14: tail <= 12% (measured max 11.5%)', () => {
    const rng = mulberry32(21);
    const errs: number[] = [];
    for (let i = 0; i < 400; i++) {
      const r = pick(rng, RATIOS);
      const q = projectPoster({ ratio: r, f: trueF(rng), imgW: W, imgH: H, yaw: (15 + rng() * 35) * sign(rng), pitch: rng() * 14 * sign(rng) });
      errs.push(err(estimateAspect(q, W, H).rawRatio, r));
    }
    expect(percentile(errs, 0.99)).toBeLessThanOrEqual(0.12);
    expect(percentile(errs, 0.9)).toBeLessThan(0.05);
  });
});

describe('EXIF prior', () => {
  it('an exact EXIF focal length removes the single-axis error; the default prior does not', () => {
    const f = 0.9 * W;
    const q = projectPoster({ ratio: A_PORTRAIT, f, imgW: W, imgH: H, yaw: 25 });
    const exif = (f * 43.27) / Math.hypot(W, H);
    const without = estimateAspect(q, W, H);
    const withExif = estimateAspect(q, W, H, { focal35mm: exif });
    expect(err(withExif.rawRatio, A_PORTRAIT)).toBeLessThan(0.005);
    expect(err(without.rawRatio, A_PORTRAIT)).toBeGreaterThan(err(withExif.rawRatio, A_PORTRAIT));
  });
});

describe('result shape', () => {
  it('snaps an A-series poster to exactly A_PORTRAIT and clamps to [1/3, 3]', () => {
    const q = projectPoster({ ratio: A_PORTRAIT, f: 3000, imgW: W, imgH: H, yaw: 30, pitch: 25 });
    const e = estimateAspect(q, W, H);
    expect(e.snapped).toBe('A-series');
    expect(e.ratio).toBe(A_PORTRAIT);
    const extreme = estimateAspect([[100, 100], [3900, 100], [3900, 220], [100, 220]], W, H);
    expect(extreme.ratio).toBeLessThanOrEqual(3);
  });
  it('falls back to the edge ratio with low confidence on a degenerate quad', () => {
    const e = estimateAspect([[0, 0], [10, 0], [20, 0], [0, 0]], W, H);
    expect(e.confidence).toBe('low');
    expect(e.usedPrior).toBe(true);
  });
});
