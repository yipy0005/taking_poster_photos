import { describe, expect, it } from 'vitest';
import type { Raster } from '../geometry.ts';
import { identity, quadHomography, tileHomography } from '../homography.ts';
import { createRaster } from '../raster2d.ts';
import { compareToTruth, projectiveScene } from '../testing/synth.ts';
import { warpTile, warpWhole } from './warp-js.ts';

const Hts = Float64Array.of(0.8, 0.12, 60, -0.05, 0.9, 40, 0.0002, 0.0001, 1);
const OUT_W = 500;
const OUT_H = 350;
const SRC_W = 640;
const SRC_H = 480;

describe('AC-12 warp accuracy (JS engine, Node via Raster)', () => {
  const scene = projectiveScene(OUT_W, OUT_H, SRC_W, SRC_H, Hts);
  it('rectifies a known projective scene: MAE < 1.5 and within 2 gray levels away from edges', () => {
    const Hds = quadHomography(scene.quad, OUT_W, OUT_H);
    const out = warpWhole(scene.source, Hds, OUT_W, OUT_H);
    const { mae, max } = compareToTruth(out, scene.truth);
    expect(mae).toBeLessThan(1.5);
    expect(max).toBeLessThanOrEqual(2);
  });
  it('a checkerboard under identity is an exact copy (half-pixel convention)', () => {
    const src = createRaster(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) src.data.set([(x + y) % 2 ? 255 : 0, 10, 20, 255], (y * 16 + x) * 4);
    const out = warpTile(src, identity(), 16, 16);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});

describe('tile-wise equals whole-image warp (design 2.5)', () => {
  const scene = projectiveScene(OUT_W, OUT_H, SRC_W, SRC_H, Hts);
  const Hds = quadHomography(scene.quad, OUT_W, OUT_H);
  const whole = warpWhole(scene.source, Hds, OUT_W, OUT_H);

  it('>= 99.99% identical pixels, <= 1 level elsewhere, for arbitrary tiles with their own ROI origin', () => {
    const assembled = createRaster(OUT_W, OUT_H);
    const xs = [0, 130, 333, 500];
    const ys = [0, 77, 200, 350];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const x0 = xs[c]!, x1 = xs[c + 1]!, y0 = ys[r]!, y1 = ys[r + 1]!;
        // ROI = bounding box of the tile mapped to the source, +2 margin
        const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
          const w = Hds[6]! * x! + Hds[7]! * y! + Hds[8]!;
          return [(Hds[0]! * x! + Hds[1]! * y! + Hds[2]!) / w, (Hds[3]! * x! + Hds[4]! * y! + Hds[5]!) / w];
        });
        const sx = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]!)) - 2));
        const sy = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]!)) - 2));
        const ex = Math.min(SRC_W, Math.ceil(Math.max(...pts.map((p) => p[0]!)) + 2));
        const ey = Math.min(SRC_H, Math.ceil(Math.max(...pts.map((p) => p[1]!)) + 2));
        const roi: Raster = createRaster(ex - sx, ey - sy);
        for (let y = 0; y < roi.height; y++) {
          roi.data.set(scene.source.data.subarray(((sy + y) * SRC_W + sx) * 4, ((sy + y) * SRC_W + ex) * 4), y * roi.width * 4);
        }
        const tile = warpTile(roi, tileHomography(Hds, sx, sy, x0, y0), x1 - x0, y1 - y0);
        for (let y = 0; y < tile.height; y++) {
          assembled.data.set(tile.data.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), ((y0 + y) * OUT_W + x0) * 4);
        }
      }
    }
    let identical = 0;
    let maxDiff = 0;
    const n = OUT_W * OUT_H * 4;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(assembled.data[i]! - whole.data[i]!);
      if (d === 0) identical++;
      if (d > maxDiff) maxDiff = d;
    }
    expect(identical / n).toBeGreaterThanOrEqual(0.9999);
    expect(maxDiff).toBeLessThanOrEqual(1);
  });
});

describe('edge cases', () => {
  it('clamps to the edge outside the source and writes transparent black where w <= 0', () => {
    const src = createRaster(4, 4);
    for (let i = 0; i < 16; i++) src.data.set([200, 100, 50, 255], i * 4);
    const out = warpTile(src, Float64Array.of(1, 0, 100, 0, 1, 100, 0, 0, 1), 2, 2);
    expect(Array.from(out.data.slice(0, 4))).toEqual([200, 100, 50, 255]);
    const behind = warpTile(src, Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, -1), 2, 2);
    expect(Array.from(behind.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });
  it('handles an empty ROI', () => {
    const out = warpTile(createRaster(0, 0), identity(), 3, 3);
    expect(out.data.every((v) => v === 0)).toBe(true);
  });
});
