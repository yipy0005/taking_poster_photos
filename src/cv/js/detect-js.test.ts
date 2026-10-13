import { describe, expect, it } from 'vitest';
import { defaultInsetQuad, dist, quadArea, type Quad } from '../geometry.ts';
import { createRaster } from '../raster2d.ts';
import { fillQuad, mulberry32 } from '../testing/synth.ts';
import { blur5, convexHull, detectJs, otsu, toGray } from './detect-js.ts';

const W = 800;
const H = 600;
const DIAG = Math.hypot(W, H);

/** Poster fill: base gray with dark "text" blocks so the interior is not uniform. */
const posterFill = (base: number) => (x: number, y: number): number => ((Math.floor(x / 23) + Math.floor(y / 31)) % 5 === 0 ? base - 90 : base);
const wallNoise = (seed: number) => {
  const rng = mulberry32(seed);
  return (r: ReturnType<typeof createRaster>, amount: number): void => {
    for (let i = 0; i < r.data.length; i += 4) {
      const n = (rng() - 0.5) * amount;
      for (let c = 0; c < 3; c++) r.data[i + c] = Math.min(255, Math.max(0, r.data[i + c]! + n));
    }
  };
};

const QUADS: Array<[string, Quad]> = [
  ['upright 62%', [[110, 80], [690, 80], [690, 520], [110, 520]]],
  ['perspective trapezoid', [[170, 70], [640, 110], [700, 520], [100, 480]]],
  ['rolled 8 degrees', [[150, 120], [660, 60], [700, 470], [190, 540]]],
  ['large 90%', [[30, 25], [770, 20], [775, 575], [28, 580]]],
];

function cornerErrors(found: Quad, truth: Quad): number[] {
  return found.map((p, i) => dist(p, truth[i]!) / DIAG);
}

describe('AC-8 detect-js on synthetic posters (corners within 3% of the diagonal)', () => {
  for (const [name, quad] of QUADS) {
    for (const [pol, bg, fg] of [['bright poster on dark wall', 60, 215], ['dark poster on bright wall', 205, 55]] as const) {
      it(`${name}, ${pol}`, () => {
        const img = fillQuad(W, H, quad, bg, posterFill(fg));
        wallNoise(3)(img, 10);
        const res = detectJs(img);
        expect(res.quad).not.toBeNull();
        for (const e of cornerErrors(res.quad!, quad)) expect(e).toBeLessThan(0.03);
        expect(res.confidence).toBeGreaterThan(0.3);
        expect(res.confidence).toBeLessThanOrEqual(1);
        expect(res.method).toBe('js-threshold');
      });
    }
  }
  it('works on a 1600 px long-edge image (internal downscale)', () => {
    const big = 2;
    const quad = QUADS[1]![1].map(([x, y]) => [x * big, y * big]) as unknown as Quad;
    const img = fillQuad(W * big, H * big, quad, 60, posterFill(215));
    const res = detectJs(img);
    expect(res.quad).not.toBeNull();
    for (const e of res.quad!.map((p, i) => dist(p, quad[i]!) / (DIAG * big))) expect(e).toBeLessThan(0.03);
  });
});

describe('AC-9 no quad found', () => {
  it('returns quad: null on a blank frame and on a poster that fills the whole frame', () => {
    expect(detectJs(fillQuad(W, H, [[0, 0], [1, 0], [1, 1], [0, 1]], 128, () => 128)).quad).toBeNull();
    const full = fillQuad(W, H, [[0, 0], [W, 0], [W, H], [0, H]], 20, posterFill(200));
    expect(detectJs(full).quad).toBeNull();
  });
  it('returns quad: null for a poster below 15% of the frame', () => {
    const small = fillQuad(W, H, [[300, 250], [450, 250], [450, 350], [300, 350]], 60, posterFill(215));
    expect(detectJs(small).quad).toBeNull();
  });
  it('the default inset rectangle is 8% in from every side', () => {
    const q = defaultInsetQuad(W, H);
    expect(q[0]).toEqual([W * 0.08, H * 0.08]);
    expect(q[2]).toEqual([W * 0.92, H * 0.92]);
    expect(quadArea(q)).toBeCloseTo(W * H * 0.84 * 0.84, 6);
  });
});

describe('building blocks', () => {
  it('toGray downsamples to the working edge and reports the scale', () => {
    const { gray, scale } = toGray(createRaster(1280, 640), 640);
    expect([gray.w, gray.h, scale]).toEqual([640, 320, 2]);
    expect(toGray(createRaster(100, 50), 640).scale).toBe(1);
  });
  it('otsu separates two gray levels', () => {
    const g = { w: 10, h: 10, d: new Uint8Array(100).map((_, i) => (i < 50 ? 40 : 200)) };
    const t = otsu(blur5({ w: 100, h: 1, d: g.d }));
    expect(t).toBeGreaterThan(40);
    expect(t).toBeLessThan(200);
  });
  it('convexHull drops interior points', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 3]]);
    expect(hull).toHaveLength(4);
  });
});
