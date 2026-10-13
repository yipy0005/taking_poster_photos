import { describe, expect, it } from 'vitest';
import { NO_ENHANCEMENT } from './enhance.ts';
import { warpTile } from './js/warp-js.ts';
import { quadHomography } from './homography.ts';
import { warpWhole } from './js/warp-js.ts';
import type { RenderRequest } from './protocol.ts';
import { renderCore, type RenderDeps, type TileWarper } from './render-core.ts';
import { compareToTruth, projectiveScene } from './testing/synth.ts';
import { createMemoryIO } from './testing/memory-io.ts';

const Hts = Float64Array.of(0.8, 0.12, 60, -0.05, 0.9, 40, 0.0002, 0.0001, 1);
const OUT_W = 500;
const OUT_H = 350;
const scene = projectiveScene(OUT_W, OUT_H, 640, 480, Hts);
const jsWarper: TileWarper = { warp: (roi, H, w, h) => warpTile(roi, H, w, h) };
const original = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/jpeg' });

const request = (over: Partial<RenderRequest> = {}): RenderRequest => ({
  original,
  quad: scene.quad,
  outW: OUT_W,
  outH: OUT_H,
  enhance: { ...NO_ENHANCEMENT },
  mime: 'image/jpeg',
  quality: 0.92,
  info: { width: 640, height: 480, orientation: 1 },
  ...over,
});
const deps = (io: ReturnType<typeof createMemoryIO>, over: Partial<RenderDeps> = {}): RenderDeps => ({
  io,
  warper: jsWarper,
  env: { maxOutputPixels: 16_777_216, roiBudget: 20_000 },
  engine: 'js',
  ...over,
});
const surfaceRaster = (io: ReturnType<typeof createMemoryIO>) => io.surfaces[0]!.raster;

describe('renderCore end to end (JS warper, in-memory IO)', () => {
  it('AC-12: many small tiles still reproduce the ground truth (MAE < 1.5, within 2 levels)', async () => {
    const io = createMemoryIO(scene.source);
    const progress: number[] = [];
    const res = await renderCore(request(), deps(io, { onProgress: (p) => progress.push(p) }));
    expect(res.width).toBe(OUT_W);
    expect(res.height).toBe(OUT_H);
    expect(res.engine).toBe('js');
    expect(res.reducedSource).toBe(false);
    expect(res.blob.type).toBe('image/jpeg');
    const { mae, max } = compareToTruth(surfaceRaster(io), scene.truth);
    expect(mae).toBeLessThan(1.5);
    expect(max).toBeLessThanOrEqual(2);
    // progress starts at 0, never decreases, ends at 1
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBeCloseTo(1, 9);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    expect(progress.length).toBeGreaterThan(4); // at least once per tile
    // decoded once, tiled, scratch envelope reserved, everything released
    expect(io.opened).toHaveLength(1);
    expect(io.sources[0]!.reads.length).toBeGreaterThan(4);
    expect(io.sources[0]!.released).toBe(true);
    expect(io.surfaces[0]!.released).toBe(true);
  });

  it('tile-wise output equals one whole-image warp (>= 99.99% identical, <= 1 level elsewhere)', async () => {
    const io = createMemoryIO(scene.source);
    await renderCore(request(), deps(io));
    const whole = warpWhole(scene.source, quadHomography(scene.quad, OUT_W, OUT_H), OUT_W, OUT_H);
    const tiled = surfaceRaster(io);
    let identical = 0;
    let maxDiff = 0;
    for (let i = 0; i < whole.data.length; i++) {
      const d = Math.abs(whole.data[i]! - tiled.data[i]!);
      if (d === 0) identical++;
      maxDiff = Math.max(maxDiff, d);
    }
    expect(identical / whole.data.length).toBeGreaterThanOrEqual(0.9999);
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it('yields to the event loop after every tile (so cancel messages are delivered)', async () => {
    const io = createMemoryIO(scene.source);
    await renderCore(request(), deps(io));
    expect(io.yields).toBe(io.sources[0]!.reads.length);
  });

  it('a reduced decode scales the quad, keeps outW/outH and reports reducedSource', async () => {
    const io = createMemoryIO(scene.source);
    const res = await renderCore(request({ sourceMaxPixels: 640 * 480 * 0.25 }), deps(io, { env: { maxOutputPixels: 16_777_216, roiBudget: 4_000_000 } }));
    expect(res.reducedSource).toBe(true);
    expect([res.width, res.height]).toEqual([OUT_W, OUT_H]);
    expect(io.opened[0]!.maxPixels).toBe(640 * 480 * 0.25);
    expect(io.sources[0]!.width).toBeLessThan(640);
    // the result is the same poster, just softer: low-frequency texture still matches within a few levels
    const { mae } = compareToTruth(surfaceRaster(io), scene.truth, 6);
    expect(mae).toBeLessThan(4);
  });

  it('asserts W*H <= cap but never computes the size itself', async () => {
    const io = createMemoryIO(scene.source);
    await expect(renderCore(request(), deps(io, { env: { maxOutputPixels: 1000, roiBudget: 1e6 } }))).rejects.toThrow(/exceeds the pixel cap/);
    expect(io.opened).toHaveLength(0);
  });

  it('AbortSignal: stops between tiles with an AbortError and releases everything', async () => {
    const ac = new AbortController();
    const io = createMemoryIO(scene.source, { onYield: (n) => { if (n === 2) ac.abort(); } });
    await expect(renderCore(request(), deps(io, { signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(io.sources[0]!.released).toBe(true);
    expect(io.surfaces[0]!.released).toBe(true);
    expect(io.sources[0]!.reads.length).toBeLessThan(6);
  });

  it('releases source and surface when the warper throws', async () => {
    const io = createMemoryIO(scene.source);
    const bad: TileWarper = { warp: () => { throw new RangeError('Array buffer allocation failed'); } };
    await expect(renderCore(request(), deps(io, { warper: bad }))).rejects.toBeInstanceOf(RangeError);
    expect(io.sources[0]!.released).toBe(true);
    expect(io.surfaces[0]!.released).toBe(true);
  });
});

describe('enhancements (AC-17)', () => {
  const sha = async (b: Blob): Promise<string> => {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()));
    return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
  };
  it('defaults to all off and leaves the output equal to the plain warp', async () => {
    const a = createMemoryIO(scene.source);
    await renderCore(request(), deps(a));
    const b = createMemoryIO(scene.source);
    await renderCore(request({ enhance: { autoContrast: false, whiteBalance: false, sharpen: false } }), deps(b));
    expect(Array.from(surfaceRaster(a).data)).toEqual(Array.from(surfaceRaster(b).data));
  });
  it('turning enhancements on changes the output but never the original blob (hash compared)', async () => {
    const before = await sha(original);
    const plain = createMemoryIO(scene.source);
    await renderCore(request(), deps(plain));
    const enhanced = createMemoryIO(scene.source);
    await renderCore(request({ enhance: { autoContrast: true, whiteBalance: true, sharpen: true } }), deps(enhanced));
    expect(await sha(original)).toBe(before);
    expect(Array.from(surfaceRaster(enhanced).data)).not.toEqual(Array.from(surfaceRaster(plain).data));
    // auto-contrast widened the range
    const range = (r: Uint8ClampedArray): number => { let lo = 255, hi = 0; for (let i = 0; i < r.length; i += 4) { lo = Math.min(lo, r[i]!); hi = Math.max(hi, r[i]!); } return hi - lo; };
    expect(range(surfaceRaster(enhanced).data)).toBeGreaterThan(range(surfaceRaster(plain).data));
  });
  it('sharpen renders halo tiles that are cropped away: no seams at tile borders', async () => {
    const sharpenOnly = { autoContrast: false, whiteBalance: false, sharpen: true };
    const small = createMemoryIO(scene.source);
    await renderCore(request({ enhance: sharpenOnly }), deps(small, { env: { maxOutputPixels: 16_777_216, roiBudget: 20_000 } }));
    const big = createMemoryIO(scene.source);
    await renderCore(request({ enhance: sharpenOnly }), deps(big, { env: { maxOutputPixels: 16_777_216, roiBudget: 50_000_000 } }));
    expect(small.sources[0]!.reads.length).toBeGreaterThan(big.sources[0]!.reads.length);
    let maxDiff = 0;
    const a = surfaceRaster(small).data;
    const b = surfaceRaster(big).data;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBeLessThanOrEqual(2);
  });
});

describe('size ownership', () => {
  it('render-core and the engines never import output-size (they only assert W*H <= cap)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const f of ['render-core.ts', 'js/js-engine.worker.ts', 'js/warp-js.ts', 'js/detect-js.ts']) {
      expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/from '[^']*output-size|capSize|computeOutputSize/);
    }
  });
});
