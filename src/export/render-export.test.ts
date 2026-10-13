import { beforeEach, describe, expect, it } from 'vitest';
import { bitmapTracker } from '../app/bitmap-handle.ts';
import { ExportError } from '../app/errors.ts';
import { jpegBytes } from '../camera/testing/headers.ts';
import { blobOf, makeDeps, makeShot } from './testing/fakes.ts';
import {
  JPEG_QUALITY,
  PNG_DISABLED_MESSAGE,
  PNG_MAX_PIXELS,
  REDUCED_EXPORT_NOTICE,
  exportJpeg,
  exportOriginal,
  exportPng,
  jpegNeedsNoDecode,
  originalPassesThrough,
  pngAvailability,
  rotationToOrientation,
} from './render-export.ts';

beforeEach(() => bitmapTracker.reset());

const bytesOf = async (b: Blob): Promise<number[]> => Array.from(new Uint8Array(await b.arrayBuffer()));

describe('JPEG export of a rectified shot (AC-28)', () => {
  const rectBytes = jpegBytes({ w: 30, h: 20 });
  const rect = blobOf(rectBytes, 'image/jpeg');

  it('rotation 0 returns the stored rectified blob without decoding', async () => {
    const { deps, decodeCalls } = makeDeps({ blobs: { rectified: rect } });
    const out = await exportJpeg(makeShot({ rotation: 0 }), deps);
    expect(out.blob).toBe(rect);
    expect(out.ext).toBe('jpg');
    expect(decodeCalls).toHaveLength(0);
  });

  it.each([90, 180, 270] as const)('rotation %i does one gated canvas redraw at q0.92 and closes the bitmap', async (rotation) => {
    const { deps, decodeCalls, rotateCalls, results } = makeDeps({ blobs: { rectified: rect } });
    const out = await exportJpeg(makeShot({ rotation }), deps);
    expect(out.mime).toBe('image/jpeg');
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0]!.ctx).toEqual({ shotId: 'shot-1', kind: 'export' });
    expect(decodeCalls[0]!.opts.info).toEqual({ width: 3000, height: 2000, orientation: 1 });
    expect(decodeCalls[0]!.opts.maxPixels).toBe(25_000_000);
    expect(rotateCalls).toEqual([expect.objectContaining({ rotation, mime: 'image/jpeg', quality: JPEG_QUALITY })]);
    expect(JPEG_QUALITY).toBe(0.92);
    expect(results[0]!.handle.closed).toBe(true);
    expect(bitmapTracker.liveCount()).toBe(0);
  });

  it('refuses a shot that still needs adjusting', async () => {
    const { deps } = makeDeps();
    await expect(exportJpeg(makeShot({ status: 'captured' }), deps)).rejects.toBeInstanceOf(ExportError);
  });

  it('reports a missing blob', async () => {
    const { deps } = makeDeps();
    await expect(exportJpeg(makeShot(), deps)).rejects.toThrow(/missing/);
  });
});

describe('uncorrected shots (plan.md finding 3)', () => {
  // 2x1 pixels stored, EXIF orientation 6 => displayed 1x2
  const orientation6 = jpegBytes({ w: 2, h: 1, orientation: 6 });
  const original = blobOf(orientation6, 'image/jpeg');
  const shot = (over = {}) => makeShot({ status: 'uncorrected', corners: null, width: 1, height: 2, originalExifOrientation: 6, originalMime: 'image/jpeg', ...over });

  it('orientation-6 JPEG with rotation 0 exports the stored bytes byte for byte, without decoding', async () => {
    const { deps, decodeCalls, rotateCalls } = makeDeps({ blobs: { original } });
    const out = await exportJpeg(shot(), deps);
    expect(out.blob).toBe(original);
    expect(await bytesOf(out.blob)).toEqual(Array.from(orientation6));
    expect(out.mime).toBe('image/jpeg');
    expect(decodeCalls).toHaveLength(0);
    expect(rotateCalls).toHaveLength(0);
  });

  it.each([
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ])('%s with rotation 0 is also returned untouched', async (mime, ext) => {
    const png = blobOf(new Uint8Array([9, 9, 9]), mime);
    const { deps, decodeCalls } = makeDeps({ blobs: { original: png } });
    const out = await exportJpeg(shot({ originalMime: mime, originalExifOrientation: 1 }), deps);
    expect(out.blob).toBe(png);
    expect(out.ext).toBe(ext);
    expect(decodeCalls).toHaveLength(0);
  });

  it('rotation != 0 goes through a gated export decode, canvas rotate and JPEG q0.92', async () => {
    const { deps, decodeCalls, rotateCalls } = makeDeps({ blobs: { original }, maxPixels: 16_000_000 });
    const out = await exportJpeg(shot({ rotation: 90 }), deps);
    expect(out.ext).toBe('jpg');
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0]!.ctx.kind).toBe('export');
    // the decoder gets the STORED size and orientation so it applies EXIF itself
    expect(decodeCalls[0]!.opts.info).toEqual({ width: 2, height: 1, orientation: 6 });
    expect(decodeCalls[0]!.opts.maxPixels).toBe(16_000_000);
    expect(rotateCalls[0]).toMatchObject({ rotation: 90, mime: 'image/jpeg', quality: 0.92 });
    expect(out.notice).toBeUndefined();
  });

  it('shows "Exported at reduced size" when the decode had to be bounded', async () => {
    const { deps } = makeDeps({ blobs: { original }, decodeSize: { w: 10, h: 20, reduced: true } });
    const out = await exportJpeg(shot({ rotation: 180 }), deps);
    expect(out.notice).toBe(REDUCED_EXPORT_NOTICE);
  });

  it('HEIC and other formats are decoded and re-encoded as JPEG even at rotation 0', async () => {
    const heic = blobOf(new Uint8Array([1, 2, 3]), 'image/heic');
    const { deps, decodeCalls } = makeDeps({ blobs: { original: heic } });
    const out = await exportJpeg(shot({ originalMime: 'image/heic', originalExifOrientation: 1 }), deps);
    expect(out.ext).toBe('jpg');
    expect(decodeCalls).toHaveLength(1);
  });

  it('jpegNeedsNoDecode / originalPassesThrough summarise the rules', () => {
    expect(jpegNeedsNoDecode({ status: 'rectified', rotation: 0, originalMime: 'image/heic' })).toBe(true);
    expect(jpegNeedsNoDecode({ status: 'rectified', rotation: 90, originalMime: 'image/jpeg' })).toBe(false);
    expect(jpegNeedsNoDecode({ status: 'uncorrected', rotation: 0, originalMime: 'image/png' })).toBe(true);
    expect(jpegNeedsNoDecode({ status: 'uncorrected', rotation: 0, originalMime: 'image/heic' })).toBe(false);
    expect(jpegNeedsNoDecode({ status: 'captured', rotation: 0, originalMime: 'image/jpeg' })).toBe(false);
    expect(originalPassesThrough({ originalMime: 'IMAGE/JPEG', rotation: 0 })).toBe(true);
  });
});

describe('PNG export', () => {
  it('is hidden for uncorrected and captured shots', () => {
    expect(pngAvailability({ status: 'uncorrected' }).hidden).toBe(true);
    expect(pngAvailability({ status: 'captured' }).hidden).toBe(true);
  });
  it('is disabled above 25 MP with an explanation', () => {
    const big = pngAvailability({ status: 'rectified', rectifiedWidth: 6000, rectifiedHeight: 5000 });
    expect(big).toEqual({ hidden: false, disabled: true, reason: PNG_DISABLED_MESSAGE });
    expect(PNG_DISABLED_MESSAGE).toBe('PNG is limited to 25 MP on mobile; use JPEG.');
    expect(PNG_MAX_PIXELS).toBe(25_000_000);
    expect(pngAvailability({ status: 'rectified', rectifiedWidth: 5000, rectifiedHeight: 5000 }).disabled).toBe(false);
  });
  it('re-renders from the original through the engine as PNG, with the stored quad and size', async () => {
    const original = blobOf(jpegBytes({ w: 4000, h: 3000 }), 'image/jpeg');
    const pngBlob = blobOf(new Uint8Array([7]), 'image/png');
    const calls: Array<Record<string, unknown>> = [];
    const { deps, decodeCalls } = makeDeps({ blobs: { original } });
    deps.engine = {
      render: async (job) => {
        calls.push(job as unknown as Record<string, unknown>);
        job.onProgress?.(1);
        return { blob: pngBlob, width: job.outW, height: job.outH, reducedSource: false, engine: 'js', retriedSmaller: false, fellBackFromOpenCv: false };
      },
    };
    const progress: number[] = [];
    const shot = makeShot();
    const out = await exportPng(shot, deps, { onProgress: (p) => progress.push(p) });
    expect(out.blob).toBe(pngBlob);
    expect(out.ext).toBe('png');
    expect(calls[0]).toMatchObject({ shotId: 'shot-1', outW: 3000, outH: 2000, mime: 'image/png', quad: shot.corners });
    expect(progress).toEqual([1]);
    expect(decodeCalls).toHaveLength(0); // no rotation
  });
  it('rotated PNG is re-drawn as PNG (lossless)', async () => {
    const original = blobOf(jpegBytes({ w: 4000, h: 3000 }), 'image/jpeg');
    const { deps, rotateCalls } = makeDeps({ blobs: { original } });
    deps.engine = { render: async (job) => ({ blob: blobOf(new Uint8Array([7]), 'image/png'), width: job.outW, height: job.outH, reducedSource: false, engine: 'js', retriedSmaller: false, fellBackFromOpenCv: false }) };
    const out = await exportPng(makeShot({ rotation: 270 }), deps);
    expect(out.mime).toBe('image/png');
    expect(rotateCalls[0]).toMatchObject({ rotation: 270, mime: 'image/png' });
  });
  it('refuses uncorrected shots and oversized outputs', async () => {
    const { deps } = makeDeps();
    deps.engine = { render: async () => Promise.reject(new Error('should not render')) };
    await expect(exportPng(makeShot({ status: 'uncorrected' }), deps)).rejects.toBeInstanceOf(ExportError);
    await expect(exportPng(makeShot({ rectifiedWidth: 6000, rectifiedHeight: 5000 }), deps)).rejects.toThrow(PNG_DISABLED_MESSAGE);
  });
});

describe('Export original', () => {
  it('is the stored blob, byte for byte, for any status', async () => {
    const original = blobOf(jpegBytes({ w: 2, h: 1, orientation: 6 }), 'image/jpeg');
    const { deps, decodeCalls } = makeDeps({ blobs: { original } });
    for (const status of ['captured', 'rectified', 'uncorrected'] as const) {
      const out = await exportOriginal(makeShot({ status }), deps);
      expect(out.blob).toBe(original);
    }
    expect(decodeCalls).toHaveLength(0);
  });
});

describe('rotation to EXIF orientation', () => {
  it('maps clockwise degrees to the matching orientation', () => {
    expect([0, 90, 180, 270].map((r) => rotationToOrientation(r as 0))).toEqual([1, 6, 3, 8]);
  });
});
