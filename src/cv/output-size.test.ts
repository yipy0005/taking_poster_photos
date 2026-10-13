import { describe, expect, it } from 'vitest';
import { MAX_SIDE } from '../app/config.ts';
import { A_LANDSCAPE, A_PORTRAIT } from './aspect.ts';
import type { AspectMode, Quad } from './geometry.ts';
import { capSize, computeOutputSize, fixedRatio, quadEdges, scaleOutputSize } from './output-size.ts';
import { mulberry32, projectPoster } from './testing/synth.ts';

const CAPS = [8.3e6, 16.7e6, 33.5e6, 50e6];
const rect = (w: number, h: number, x = 100, y = 100): Quad => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

describe('AC-13 free mode', () => {
  it('4000x3000 source, edges 3000 x 2000 => 3000x2000', () => {
    const o = computeOutputSize(rect(3000, 2000), 'free', { cap: 50e6 });
    expect([o.width, o.height, o.downscaled, o.aspectUsed]).toEqual([3000, 2000, false, null]);
  });
  it('uses the longest of opposite edges', () => {
    const q: Quad = [[0, 0], [1000, 0], [1200, 800], [0, 700]];
    const { W0, H0 } = quadEdges(q);
    expect(W0).toBeCloseTo(Math.hypot(1200, 100), 9); // bottom edge is longer than the top
    expect(H0).toBeCloseTo(Math.hypot(200, 800), 9); // right edge is longer than the left
  });
});

describe('AC-14 cap rule', () => {
  it('8000x6000 at the iOS cap gives 4729x3546 (not 4730x3547)', () => {
    const r = capSize(8000, 6000, 16_777_216);
    expect([r.W, r.H, r.downscaled]).toEqual([4729, 3546, true]);
    expect(r.W * r.H).toBe(16_769_034);
    expect(4730 * 3547).toBeGreaterThan(16_777_216);
  });
  it('property: 10,000 random cases over caps 8.3/16.7/33.5/50 MP', () => {
    const rng = mulberry32(2024);
    for (let i = 0; i < 10_000; i++) {
      const W1 = 200 + rng() * 29_800;
      const H1 = 200 + rng() * 29_800;
      const cap = CAPS[i % CAPS.length]!;
      const { W, H } = capSize(W1, H1, cap);
      expect(W * H).toBeLessThanOrEqual(cap);
      expect(Math.max(W, H)).toBeLessThanOrEqual(MAX_SIDE);
      const landscape = W1 >= H1;
      const long = landscape ? W : H;
      const short = landscape ? H : W;
      const ideal = (long * (landscape ? H1 : W1)) / (landscape ? W1 : H1);
      expect(ideal - short).toBeGreaterThanOrEqual(-1e-9);
      expect(ideal - short).toBeLessThan(1);
    }
  });
  it('does nothing when under the cap', () => {
    const r = capSize(3000, 2000, 50e6);
    expect([r.W, r.H, r.downscaled]).toEqual([3000, 2000, false]);
  });
  it('computeOutputSize reports downscaled and respects the cap for a 48 MP quad', () => {
    const o = computeOutputSize(rect(8000, 6000, 0, 0), 'free', { cap: 16_777_216 });
    expect([o.width, o.height, o.downscaled]).toEqual([4729, 3546, true]);
  });
});

describe('AC-16 ratio modes', () => {
  const modes: AspectMode[] = ['a-portrait', 'a-landscape', '4:3', '16:9'];
  it('fixed ratio table uses exact A-series ratios', () => {
    expect(fixedRatio('a-portrait')).toBe(A_PORTRAIT);
    expect(fixedRatio('a-landscape')).toBe(A_LANDSCAPE);
    expect(fixedRatio('free')).toBeNull();
    expect(fixedRatio('auto')).toBeNull();
  });
  it('|W/H - r| <= 1/min(W,H) for every fixed mode, over random quads and caps', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 2000; i++) {
      const mode = modes[i % modes.length]!;
      const r = fixedRatio(mode)!;
      const q: Quad = [
        [rng() * 200, rng() * 200],
        [1500 + rng() * 2500, rng() * 200],
        [1500 + rng() * 2500, 1200 + rng() * 1800],
        [rng() * 200, 1200 + rng() * 1800],
      ];
      const o = computeOutputSize(q, mode, { cap: CAPS[i % 4]! });
      expect(o.width * o.height).toBeLessThanOrEqual(CAPS[i % 4]!);
      expect(Math.abs(o.width / o.height - r)).toBeLessThanOrEqual(1 / Math.min(o.width, o.height) + 1e-9);
    }
  });
  it('neither axis is smaller than the longest source edge along it (uncapped, ratio modes), within 1 px', () => {
    const o = computeOutputSize(rect(3000, 2000), 'a-portrait', { cap: 50e6 });
    expect(o.width).toBeGreaterThanOrEqual(3000 - 1);
    expect(o.height).toBeGreaterThanOrEqual(2000);
  });
  it('auto mode fits the estimated ratio and reports snapping and confidence', () => {
    const q = projectPoster({ ratio: A_PORTRAIT, f: 3000, imgW: 4000, imgH: 3000, yaw: 25, pitch: 20 });
    const o = computeOutputSize(q, 'auto', { cap: 50e6, imgW: 4000, imgH: 3000 });
    expect(o.snappedTo).toBe('A-series');
    expect(o.aspectUsed).toBe(A_PORTRAIT);
    expect(o.confidence).toBe('high');
    expect(Math.abs(o.width / o.height - A_PORTRAIT)).toBeLessThanOrEqual(1 / Math.min(o.width, o.height) + 1e-9);
    expect(() => computeOutputSize(q, 'auto', { cap: 50e6 })).toThrow();
  });
});

describe('scaleOutputSize (memory retries)', () => {
  it('scales uniformly, floors and keeps the ratio', () => {
    const s = scaleOutputSize(4729, 3546, 0.7);
    expect(s).toEqual({ width: 3310, height: 2481 });
    expect(Math.abs(s.width / s.height - 4729 / 3546)).toBeLessThan(2 / s.height);
  });
});
