import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmapTracker } from './bitmap-handle.ts';
import { boundedSize, decodeRaw, orientedSize, resetDecodeCapsForTests, setDecodeCaps, type DecodeCaps } from './decode.ts';
import { probeDecodeCaps, injectJpegOrientation, type ProbeEnv } from './decode-caps.ts';
import { createFakeDecoder, FakeOffscreenCanvas, type FakeConfig } from './testing/fake-decoder.ts';

const ALL: DecodeCaps = { fromImage: true, exifHonored: true, resizeHonored: true, resizeAfterOrient: true };

function setup(config: FakeConfig = {}) {
  const dec = createFakeDecoder(config);
  vi.stubGlobal('createImageBitmap', dec.createImageBitmap);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  return dec;
}

function probeEnv(dec: ReturnType<typeof createFakeDecoder>): ProbeEnv {
  return {
    createBitmap: (blob, opts) => dec.createImageBitmap(blob, opts),
    makeProbes: async () => ({
      plain: dec.blob({ w: 64, h: 32, orientation: 1 }),
      orient6: dec.blob({ w: 64, h: 32, orientation: 6 }),
    }),
    markerAtTopRight: (b) => (b as unknown as { markerTopRight: boolean }).markerTopRight,
  };
}

beforeEach(() => {
  bitmapTracker.reset();
  resetDecodeCapsForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe('size helpers', () => {
  it('orientedSize swaps for orientations 5..8', () => {
    expect(orientedSize({ width: 4000, height: 3000, orientation: 6 })).toEqual({ width: 3000, height: 4000 });
    expect(orientedSize({ width: 4000, height: 3000, orientation: 1 })).toEqual({ width: 4000, height: 3000 });
  });
  it('boundedSize never exceeds maxPixels and never upscales', () => {
    for (const [w, h, max] of [[8000, 6000, 12e6], [4032, 3024, 6e6], [10001, 7777, 25e6]] as const) {
      const r = boundedSize(w, h, { maxPixels: max });
      expect(r.width * r.height).toBeLessThanOrEqual(max);
      expect(r.scaled).toBe(true);
    }
    expect(boundedSize(100, 50, { maxPixels: 1e9, maxLongEdge: 1000 })).toEqual({ width: 100, height: 50, scaled: false });
    expect(boundedSize(4000, 3000, { maxLongEdge: 2048 })).toMatchObject({ width: 2048, height: 1536 });
  });
});

describe('decodeRaw', () => {
  it('resizes at decode time in oriented space when probes allow', async () => {
    const dec = setup();
    setDecodeCaps(ALL);
    const r = await decodeRaw(dec.blob({ w: 4000, h: 3000, orientation: 6 }), {
      maxLongEdge: 1000,
      info: { width: 4000, height: 3000, orientation: 6 },
    });
    expect(dec.calls[0]?.opts).toMatchObject({ imageOrientation: 'from-image', resizeWidth: 750, resizeHeight: 1000 });
    expect([r.width, r.height]).toEqual([750, 1000]);
    expect(r.reduced).toBe(true);
    expect(r.scale).toBeCloseTo(0.25, 5);
    expect(r.sourceWidth).toBe(3000);
    r.handle.close();
    expect(bitmapTracker.liveCount()).toBe(0);
  });

  it('does not resize when the image is within bounds', async () => {
    const dec = setup();
    setDecodeCaps(ALL);
    const r = await decodeRaw(dec.blob({ w: 800, h: 600, orientation: 1 }), {
      maxPixels: 1e6,
      info: { width: 800, height: 600, orientation: 1 },
    });
    expect(dec.calls[0]?.opts.resizeWidth).toBeUndefined();
    expect(r.reduced).toBe(false);
    r.handle.close();
  });

  it('AC-39: from-image rejected -> probe says fromImage=false and decode is still oriented and bounded', async () => {
    const dec = setup({ throwOnFromImage: true });
    const caps = await probeDecodeCaps(probeEnv(dec));
    expect(caps.fromImage).toBe(false);
    expect(caps.exifHonored).toBe(true);
    setDecodeCaps(caps);
    dec.calls.length = 0;
    const r = await decodeRaw(dec.blob({ w: 4000, h: 3000, orientation: 6 }), {
      maxLongEdge: 1000,
      info: { width: 4000, height: 3000, orientation: 6 },
    });
    expect(dec.calls.every((c) => c.opts.imageOrientation === undefined)).toBe(true);
    expect([r.width, r.height]).toEqual([750, 1000]);
    r.handle.close();
  });

  it('AC-39: resize ignored -> probe says resizeHonored=false and the canvas fallback bounds the result', async () => {
    const dec = setup({ ignoreResize: true });
    const caps = await probeDecodeCaps(probeEnv(dec));
    expect(caps.resizeHonored).toBe(false);
    expect(caps.resizeAfterOrient).toBe(false);
    setDecodeCaps(caps);
    dec.calls.length = 0;
    const big = dec.blob({ w: 4000, h: 3000, orientation: 6 });
    const r = await decodeRaw(big, { maxLongEdge: 1000, info: { width: 4000, height: 3000, orientation: 6 } });
    expect([r.width, r.height]).toEqual([750, 1000]);
    // the full-size bitmap was closed after being scaled through the canvas
    expect(dec.bitmaps.find((b) => b.width === 3000 && b.height === 4000)?.closed).toBe(true);
    r.handle.close();
    expect(bitmapTracker.liveCount()).toBe(0);
  });

  it('AC-39: resize applied in stored space -> resizeAfterOrient=false and decode swaps to still hit the request', async () => {
    const dec = setup({ resizeInStoredSpace: true });
    const caps = await probeDecodeCaps(probeEnv(dec));
    expect(caps).toMatchObject({ fromImage: true, resizeHonored: true, resizeAfterOrient: false });
    setDecodeCaps(caps);
    dec.calls.length = 0;
    const r = await decodeRaw(dec.blob({ w: 4000, h: 3000, orientation: 6 }), {
      maxLongEdge: 1000,
      info: { width: 4000, height: 3000, orientation: 6 },
    });
    // stored-space request is swapped (1000x750), so the oriented result is 750x1000 with long edge 1000
    expect(dec.calls[0]?.opts).toMatchObject({ resizeWidth: 1000, resizeHeight: 750 });
    expect([r.width, r.height]).toEqual([750, 1000]);
    r.handle.close();
  });

  it('probes report all true on a fully capable decoder', async () => {
    const dec = setup();
    expect(await probeDecodeCaps(probeEnv(dec))).toEqual(ALL);
  });

  it('without header info, bounds are enforced through the canvas fallback', async () => {
    const dec = setup();
    setDecodeCaps(ALL);
    const r = await decodeRaw(dec.blob({ w: 4000, h: 3000, orientation: 1 }), { maxPixels: 1e6 });
    expect(r.width * r.height).toBeLessThanOrEqual(1e6);
    r.handle.close();
  });

  it('forwards crop rectangles', async () => {
    const dec = setup();
    setDecodeCaps(ALL);
    const r = await decodeRaw(dec.blob({ w: 4000, h: 3000, orientation: 1 }), { crop: { sx: 10, sy: 20, sw: 512, sh: 512 } });
    expect(dec.calls[0]?.crop).toEqual({ sx: 10, sy: 20, sw: 512, sh: 512 });
    expect([r.width, r.height]).toEqual([512, 512]);
    r.handle.close();
  });
});

describe('injectJpegOrientation', () => {
  it('inserts an APP1 segment with the orientation right after SOI', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
    const out = injectJpegOrientation(jpeg, 6);
    expect(Array.from(out.slice(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xe1]);
    expect(out.length).toBe(jpeg.length + 36);
    expect([out[22], out[23]]).toEqual([0x01, 0x12]); // Orientation tag
    expect([out[30], out[31]]).toEqual([0x00, 6]); // value
    expect(() => injectJpegOrientation(new Uint8Array([1, 2, 3]), 6)).toThrow();
  });
});

describe('createImageBitmap is only called from app/decode.ts and app/decode-caps.ts', () => {
  it('no other source file references it', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !p.endsWith('testing/fake-decoder.ts')) {
          const rel = p.slice(root.length + 1);
          // feature-detect.ts only checks that the function exists (typeof), it never calls it
          if (['app/decode.ts', 'app/decode-caps.ts', 'app/feature-detect.ts'].includes(rel)) continue;
          if (readFileSync(p, 'utf8').includes('createImageBitmap')) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
