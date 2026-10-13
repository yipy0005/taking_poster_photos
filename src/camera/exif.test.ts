import { describe, expect, it } from 'vitest';
import { injectJpegOrientation } from '../app/decode-caps.ts';
import {
  blobSource,
  bytesSource,
  injectOrientation,
  orientedDims,
  parseExifOrientation,
  readBlobHeader,
  readImageHeader,
  shotImageInfo,
} from './exif.ts';
import { blobOf, isoBytes, jpegBytes, pngBytes, webpBytes } from './testing/headers.ts';

const read = (b: Uint8Array) => readImageHeader(bytesSource(b));

describe('JPEG', () => {
  it('reads SOF dimensions and defaults the orientation to 1', async () => {
    expect(await read(jpegBytes({ w: 4032, h: 3024 }))).toEqual({ format: 'jpeg', width: 4032, height: 3024, orientation: 1 });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('reads EXIF orientation %i (big-endian)', async (o) => {
    expect((await read(jpegBytes({ w: 100, h: 50, orientation: o }))).orientation).toBe(o);
  });

  it('reads little-endian EXIF', async () => {
    expect((await read(jpegBytes({ w: 100, h: 50, orientation: 6, littleEndianExif: true }))).orientation).toBe(6);
  });

  it('has no 64 KB cap: SOF behind 300 KB of APPn segments is still found', async () => {
    const h = await read(jpegBytes({ w: 9000, h: 6000, orientation: 8, paddingBytes: 300_000 }));
    expect(h).toEqual({ format: 'jpeg', width: 9000, height: 6000, orientation: 8 });
  });

  it('finds EXIF that follows 200 KB of other segments', async () => {
    const h = await read(jpegBytes({ w: 800, h: 600, orientation: 3, paddingBytes: 200_000, exifAfterPadding: true }));
    expect(h.orientation).toBe(3);
    expect(h.width).toBe(800);
  });

  it('works through a Blob source with page reads', async () => {
    const blob = blobOf(jpegBytes({ w: 12000, h: 9000, orientation: 6, paddingBytes: 150_000 }), 'image/jpeg');
    expect(await readBlobHeader(blob)).toEqual({ format: 'jpeg', width: 12000, height: 9000, orientation: 6 });
  });

  it('survives a truncated file: unknown dimensions, not an exception', async () => {
    const full = jpegBytes({ w: 100, h: 100, orientation: 6 });
    const cut = full.subarray(0, 30);
    const h = await read(cut);
    expect(h.format).toBe('jpeg');
    expect(h.width).toBeNull();
  });

  it('treats zero dimensions as unknown', async () => {
    expect((await read(jpegBytes({ w: 0, h: 0 }))).width).toBeNull();
  });

  it('ignores an invalid orientation value', async () => {
    expect((await read(jpegBytes({ w: 10, h: 10, orientation: 9 }))).orientation).toBe(1);
  });
});

describe('PNG, WebP', () => {
  it('reads PNG IHDR', async () => {
    expect(await read(pngBytes(1920, 1080))).toEqual({ format: 'png', width: 1920, height: 1080, orientation: 1 });
  });

  it('reads WebP VP8 (lossy)', async () => {
    expect(await read(webpBytes('VP8 ', 4000, 3000))).toEqual({ format: 'webp', width: 4000, height: 3000, orientation: 1 });
  });

  it('reads WebP VP8L (lossless)', async () => {
    expect(await read(webpBytes('VP8L', 5000, 2500))).toMatchObject({ format: 'webp', width: 5000, height: 2500 });
  });

  it('reads WebP VP8X (extended)', async () => {
    expect(await read(webpBytes('VP8X', 16000, 9000))).toMatchObject({ format: 'webp', width: 16000, height: 9000 });
  });
});

describe('HEIC / AVIF', () => {
  it('reads the ispe box of a HEIC file', async () => {
    expect(await read(isoBytes({ w: 4032, h: 3024 }))).toEqual({ format: 'heic', width: 4032, height: 3024, orientation: 1 });
  });

  it('prefers the largest ispe over thumbnails and grid tiles', async () => {
    const h = await read(isoBytes({ w: 8064, h: 6048, decoys: [[320, 240], [512, 512]] }));
    expect([h.width, h.height]).toEqual([8064, 6048]);
  });

  it('applies irot to report the displayed size', async () => {
    const h = await read(isoBytes({ w: 4000, h: 3000, rot: 1 }));
    expect([h.width, h.height]).toEqual([3000, 4000]);
    const h2 = await read(isoBytes({ w: 4000, h: 3000, rot: 2 }));
    expect([h2.width, h2.height]).toEqual([4000, 3000]);
  });

  it('detects AVIF by its brand', async () => {
    expect(await read(isoBytes({ w: 2000, h: 1000, brand: 'avif' }))).toMatchObject({ format: 'avif', width: 2000, height: 1000 });
  });

  it('finds meta behind a large preceding box through a Blob source', async () => {
    const blob = blobOf(isoBytes({ w: 6000, h: 4000, paddingBytes: 500_000 }), 'image/heic');
    expect(await readBlobHeader(blob)).toMatchObject({ format: 'heic', width: 6000, height: 4000 });
  });

  it('returns unknown dimensions when there is no meta box', async () => {
    const full = isoBytes({ w: 100, h: 100 });
    const h = await read(full.subarray(0, 28)); // ftyp only
    expect(h.format).toBe('heic');
    expect(h.width).toBeNull();
  });
});

describe('unknown input', () => {
  it('does not misidentify text or tiny files', async () => {
    expect((await read(new TextEncoder().encode('hello world, this is not an image'))).format).toBe('unknown');
    expect((await read(new Uint8Array([1, 2, 3]))).format).toBe('unknown');
    expect((await read(new Uint8Array(0))).format).toBe('unknown');
  });
});

describe('helpers', () => {
  it('orientedDims swaps for 5..8 only', () => {
    expect(orientedDims(4000, 3000, 1)).toEqual({ width: 4000, height: 3000 });
    expect(orientedDims(4000, 3000, 6)).toEqual({ width: 3000, height: 4000 });
    expect(orientedDims(4000, 3000, 4)).toEqual({ width: 4000, height: 3000 });
  });

  it('shotImageInfo turns oriented record dimensions back into stored dimensions', () => {
    expect(shotImageInfo({ width: 3000, height: 4000, originalExifOrientation: 6 })).toEqual({ width: 4000, height: 3000, orientation: 6 });
    expect(shotImageInfo({ width: 4000, height: 3000, originalExifOrientation: 1 })).toEqual({ width: 4000, height: 3000, orientation: 1 });
  });

  it('injectOrientation (decode probes) produces a JPEG whose orientation the reader sees', async () => {
    expect(injectOrientation).toBe(injectJpegOrientation);
    const tagged = injectOrientation(jpegBytes({ w: 64, h: 32 }), 6);
    expect((await read(tagged)).orientation).toBe(6);
    expect(parseExifOrientation(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('blobSource returns the same bytes as the array source across page boundaries', async () => {
    const data = new Uint8Array(200_000).map((_, i) => i % 251);
    const blob = new Blob([data]);
    const a = await blobSource(blob).read(65_530, 20);
    expect(Array.from(a)).toEqual(Array.from(data.subarray(65_530, 65_550)));
    const big = await blobSource(blob).read(1000, 150_000);
    expect(big.length).toBe(150_000);
    expect(big[149_999]).toBe(data[150_999]);
    expect((await blobSource(blob).read(199_990, 100)).length).toBe(10);
  });
});
