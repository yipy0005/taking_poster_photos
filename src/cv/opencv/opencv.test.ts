// The real opencv.js (WASM) running in Node: Spike 0 (b) and (c), engine parity and the Mat lifecycle. Loading takes a few seconds.
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { identity, quadHomography } from '../homography.ts';
import { dist, type Quad, type Raster } from '../geometry.ts';
import { createRaster } from '../raster2d.ts';
import { warpTile } from '../js/warp-js.ts';
import { detectJs } from '../js/detect-js.ts';
import { compareToTruth, fillQuad, projectiveScene } from '../testing/synth.ts';
import { boxCv, readHeapBytes, type CvApi } from './cv-loader.ts';
import { toEngineError } from './cv-errors.ts';
import { detectCv, medianOf } from './detect-cv.ts';
import { cvMatrix, warpTileCv } from './warp-cv.ts';
import { CvError, OutOfMemoryError } from '../../app/errors.ts';

let cv: CvApi;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // module.exports is a promise of the Emscripten module (the "promise shape" of the loader)
  const exported: unknown = require('@techstark/opencv-js');
  expect(typeof (exported as { then?: unknown }).then).toBe('function');
  cv = (await boxCv(exported)).cv;
}, 120_000);

/** Mean absolute difference over the RGB channels. */
function mad(a: Raster, b: Raster, margin = 0): number {
  let sum = 0;
  let n = 0;
  for (let y = margin; y < a.height - margin; y++) {
    for (let x = margin; x < a.width - margin; x++) {
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(a.data[(y * a.width + x) * 4 + c]! - b.data[(y * a.width + x) * 4 + c]!);
        n++;
      }
    }
  }
  return sum / n;
}

describe('Spike 0 (b): the boxed loader gives a usable module', () => {
  it('has Mat and the functions the engine needs; the module is not thenable', () => {
    for (const name of ['Mat', 'MatVector', 'warpPerspective', 'Canny', 'findContours', 'approxPolyDP', 'matFromArray']) {
      expect((cv as unknown as Record<string, unknown>)[name], name).toBeTypeOf('function');
    }
    expect((cv as unknown as { then?: unknown }).then).toBeUndefined();
  });
  it('does not expose the WASM heap in this build, so readHeapBytes reports 0 (workers are recycled after every job)', () => {
    expect(readHeapBytes(cv)).toBe(0);
  });
});

describe('Spike 0 (c) / AC-12: half-pixel parity with the JS warp', () => {
  it('an identity Hds is an exact copy of the ROI', () => {
    const src = createRaster(32, 24);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) src.data.set([(x * 7 + y * 3) % 256, (x * 5) % 256, (y * 11) % 256, 255], (y * 32 + x) * 4);
    const out = warpTileCv(cv, src, identity(), 32, 24);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
  it('M_cv = T(-0.5) * H * T(+0.5)', () => {
    const H = Float64Array.of(2, 0, 10, 0, 3, 20, 0, 0, 1);
    expect(Array.from(cvMatrix(H))).toEqual([2, 0, 10 + 0.5 * 2 - 0.5, 0, 3, 20 + 0.5 * 3 - 0.5, 0, 0, 1]);
  });
  it('a 1-pixel checkerboard through a known homography matches the JS warp within 1.0 gray level (MAD)', () => {
    const src = createRaster(200, 150);
    for (let y = 0; y < 150; y++) for (let x = 0; x < 200; x++) src.data.set([(x + y) % 2 ? 230 : 25, (x + y) % 2 ? 230 : 25, (x + y) % 2 ? 230 : 25, 255], (y * 200 + x) * 4);
    const Hds = Float64Array.of(0.9, 0.08, 12, -0.04, 0.92, 9, 0.0002, 0.0001, 1);
    const js = warpTile(src, Hds, 150, 110);
    const cvOut = warpTileCv(cv, src, Hds, 150, 110);
    expect(mad(js, cvOut, 2)).toBeLessThan(1.0);
  });
  it('AC-12: a known projective scene is rectified with MAE < 1.5 (same bound as the JS engine)', () => {
    const Hts = Float64Array.of(0.8, 0.12, 60, -0.05, 0.9, 40, 0.0002, 0.0001, 1);
    const scene = projectiveScene(500, 350, 640, 480, Hts);
    const out = warpTileCv(cv, scene.source, quadHomography(scene.quad, 500, 350), 500, 350);
    expect(compareToTruth(out, scene.truth).mae).toBeLessThan(1.5);
  });
  it('frees every Mat: repeated warps do not fail and return fresh copies', () => {
    const src = createRaster(64, 64);
    src.data.fill(200);
    const a = warpTileCv(cv, src, identity(), 64, 64);
    src.data.fill(10);
    const b = warpTileCv(cv, src, identity(), 64, 64);
    expect(a.data[0]).toBe(200);
    expect(b.data[0]).toBe(10);
  });
});

describe('detect-cv', () => {
  const W = 800;
  const H = 600;
  const posterFill = (base: number) => (x: number, y: number): number => ((Math.floor(x / 23) + Math.floor(y / 31)) % 5 === 0 ? base - 90 : base);
  const QUAD: Quad = [[170, 70], [640, 110], [700, 520], [100, 480]];
  it('finds a perspective poster (bright on dark) with every corner within 3% of the diagonal', () => {
    const img = fillQuad(W, H, QUAD, 60, posterFill(215));
    const res = detectCv(cv, img);
    expect(res.quad).not.toBeNull();
    const diag = Math.hypot(W, H);
    res.quad!.forEach((p, i) => expect(dist(p, QUAD[i]!) / diag).toBeLessThan(0.03));
    expect(res.confidence).toBeGreaterThan(0.15);
    expect(res.confidence).toBeLessThanOrEqual(1);
    expect(res.method).toMatch(/^opencv-/);
  });
  it('finds a dark poster on a bright wall', () => {
    const img = fillQuad(W, H, QUAD, 205, posterFill(55));
    const res = detectCv(cv, img);
    expect(res.quad).not.toBeNull();
    const diag = Math.hypot(W, H);
    res.quad!.forEach((p, i) => expect(dist(p, QUAD[i]!) / diag).toBeLessThan(0.03));
  });
  it('returns quad null (not an exception) for a blank image', () => {
    const img = createRaster(W, H);
    img.data.fill(128);
    const res = detectCv(cv, img);
    expect(res.quad).toBeNull();
    expect(res.confidence).toBe(0);
  });
  it('agrees with the JS detector on the confidence definition (area fraction * solidity, <= 1)', () => {
    const img = fillQuad(W, H, QUAD, 60, posterFill(215));
    const a = detectCv(cv, img);
    const b = detectJs(img);
    expect(Math.abs(a.confidence - b.confidence)).toBeLessThan(0.15);
  });
  it('medianOf', () => {
    expect(medianOf(Uint8Array.of(1, 2, 3, 200, 250))).toBe(3);
    expect(medianOf(new Uint8Array(0))).toBe(128);
  });
});

describe('toEngineError', () => {
  it('maps memory failures, per-input exceptions and numeric pointers', () => {
    expect(toEngineError(cv, new RangeError('Array buffer allocation failed'))).toBeInstanceOf(OutOfMemoryError);
    expect(toEngineError(cv, new Error('abort(OOM). Build with -sASSERTIONS'))).toBeInstanceOf(OutOfMemoryError);
    expect(toEngineError(cv, new Error('bad Mat shape'))).toBeInstanceOf(CvError);
    expect(toEngineError(cv, 12345)).toBeInstanceOf(CvError);
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    expect(toEngineError(cv, abort)).toBe(abort);
    const oom = new OutOfMemoryError('x');
    expect(toEngineError(cv, oom)).toBe(oom);
  });
});
