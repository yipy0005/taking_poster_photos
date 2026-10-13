import { beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { bitmapTracker } from '../app/bitmap-handle.ts';
import { ExportError } from '../app/errors.ts';
import { jpegBytes } from '../camera/testing/headers.ts';
import { PDF_MAX_PAGE_PT, buildPdf, buildPosterPdf, pdfEligible, pdfPageFor, pdfPageSize, pdfSizes } from './pdf.ts';
import { blobOf, makeDeps, makeShot } from './testing/fakes.ts';

beforeEach(() => bitmapTracker.reset());

async function load(blob: Blob): Promise<PDFDocument> {
  return PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { updateMetadata: false });
}

describe('pdfPageSize', () => {
  it('uses 150 dpi: 1500 x 1000 px is 720 x 480 pt', () => {
    expect(pdfPageSize(1500, 1000)).toEqual([720, 480]);
  });
  it('scales down so neither side exceeds 14400 pt, keeping the aspect', () => {
    const [w, h] = pdfPageSize(60000, 30000); // 28800 x 14400 pt unscaled
    expect(Math.max(w, h)).toBeCloseTo(PDF_MAX_PAGE_PT, 6);
    expect(w / h).toBeCloseTo(2, 6);
  });
});

describe('embeddable bytes (AC-30)', () => {
  it('a rectified JPEG is embedded without re-encoding (no decode, same bytes)', async () => {
    const rect = jpegBytes({ w: 30, h: 20 });
    const { deps, decodeCalls, rotateCalls } = makeDeps({ blobs: { rectified: blobOf(rect, 'image/jpeg') } });
    const page = await pdfPageFor(makeShot({ rotation: 90 }), deps);
    expect(Array.from(page.jpeg)).toEqual(Array.from(rect));
    expect(page.rotation).toBe(90);
    expect(decodeCalls).toHaveLength(0);
    expect(rotateCalls).toHaveLength(0);
  });

  it('an uncorrected JPEG with EXIF orientation 1 is embedded as-is', async () => {
    const orig = jpegBytes({ w: 30, h: 20, orientation: 1 });
    const { deps, decodeCalls } = makeDeps({ blobs: { original: blobOf(orig, 'image/jpeg') } });
    const page = await pdfPageFor(makeShot({ status: 'uncorrected', corners: null, originalExifOrientation: 1 }), deps);
    expect(Array.from(page.jpeg)).toEqual(Array.from(orig));
    expect(decodeCalls).toHaveLength(0);
  });

  it('a JPEG without any EXIF is embedded as-is', async () => {
    const orig = jpegBytes({ w: 30, h: 20 });
    const { deps, decodeCalls } = makeDeps({ blobs: { original: blobOf(orig, 'image/jpeg') } });
    await pdfPageFor(makeShot({ status: 'uncorrected', corners: null }), deps);
    expect(decodeCalls).toHaveLength(0);
  });

  it('orientation 6 is decoded (EXIF applied) and re-encoded as q0.92 through a canvas, as a gated export job', async () => {
    const orig = jpegBytes({ w: 2, h: 1, orientation: 6 });
    const upright = jpegBytes({ w: 1, h: 2 });
    const { deps, decodeCalls, rotateCalls, results } = makeDeps({ blobs: { original: blobOf(orig, 'image/jpeg') }, encoded: upright });
    const page = await pdfPageFor(makeShot({ status: 'uncorrected', corners: null, width: 1, height: 2, originalExifOrientation: 6 }), deps);
    expect(Array.from(page.jpeg)).toEqual(Array.from(upright));
    expect(decodeCalls[0]!.ctx.kind).toBe('export');
    expect(decodeCalls[0]!.opts.info).toEqual({ width: 2, height: 1, orientation: 6 });
    expect(rotateCalls[0]).toMatchObject({ rotation: 0, mime: 'image/jpeg', quality: 0.92 });
    expect(results[0]!.handle.closed).toBe(true);
  });

  it('PNG/WebP/HEIC originals are re-encoded too', async () => {
    const upright = jpegBytes({ w: 5, h: 5 });
    const { deps, decodeCalls } = makeDeps({ blobs: { original: blobOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), 'image/png') }, encoded: upright });
    await pdfPageFor(makeShot({ status: 'uncorrected', corners: null, originalMime: 'image/png' }), deps);
    expect(decodeCalls).toHaveLength(1);
  });

  it('refuses captured shots and reports missing files', async () => {
    const { deps } = makeDeps();
    await expect(pdfPageFor(makeShot({ status: 'captured' }), deps)).rejects.toBeInstanceOf(ExportError);
    await expect(pdfPageFor(makeShot(), deps)).rejects.toBeInstanceOf(ExportError);
  });
});

describe('buildPdf', () => {
  it('the page of a 2x1 JPEG tagged orientation 6 has the oriented 1:2 aspect (AC-30)', async () => {
    // a 2:1 image (400 x 200 stored) tagged orientation 6 is displayed 200 x 400, so the page must be 1:2
    const orig = jpegBytes({ w: 400, h: 200, orientation: 6 });
    const upright = jpegBytes({ w: 200, h: 400 });
    const { deps } = makeDeps({ blobs: { original: blobOf(orig, 'image/jpeg') }, encoded: upright });
    const shot = makeShot({ status: 'uncorrected', corners: null, width: 200, height: 400, originalExifOrientation: 6 });
    const pdf = await buildPosterPdf('Orientation test', [shot], deps);
    expect(pdf.type).toBe('application/pdf');
    const doc = await load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width / height).toBeCloseTo(1 / 2, 6);
  });

  it('control: embedding the raw orientation-6 bytes would give a 2:1 page (the bug the re-encode avoids)', async () => {
    const orig = jpegBytes({ w: 400, h: 200, orientation: 6 });
    const pdf = await buildPdf(1, async () => ({ jpeg: orig, rotation: 0 }), { title: 'raw' });
    const { width, height } = (await load(pdf)).getPage(0).getSize();
    expect(width / height).toBeCloseTo(2, 6);
  });

  it('one page per shot in order, stored rotation as /Rotate, title and creation date only', async () => {
    const a = jpegBytes({ w: 30, h: 20 });
    const b = jpegBytes({ w: 20, h: 30 });
    const order: number[] = [];
    const pdf = await buildPdf(
      2,
      async (i) => {
        order.push(i);
        return { jpeg: i === 0 ? a : b, rotation: i === 0 ? 0 : 90 };
      },
      { title: 'My poster', now: new Date('2024-05-06T07:08:09Z') },
    );
    expect(order).toEqual([0, 1]);
    const doc = await load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    const p0 = doc.getPage(0).getSize();
    expect(p0.width / p0.height).toBeCloseTo(30 / 20, 6);
    expect(doc.getTitle()).toBe('My poster');
    expect(doc.getCreationDate()?.toISOString()).toBe('2024-05-06T07:08:09.000Z');
    expect(doc.getProducer()).toBeUndefined();
    expect(doc.getCreator()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
  });

  it('reads and releases pages one at a time and reports progress', async () => {
    const jpeg = jpegBytes({ w: 10, h: 10 });
    let inFlight = 0;
    let maxInFlight = 0;
    const progress: Array<[number, number]> = [];
    await buildPdf(
      3,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return { jpeg, rotation: 0 };
      },
      { title: 't', onProgress: (d, t) => progress.push([d, t]) },
    );
    expect(maxInFlight).toBe(1);
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('can be cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(buildPdf(2, async () => ({ jpeg: jpegBytes({ w: 1, h: 1 }), rotation: 0 }), { title: 't', signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('poster PDF helpers', () => {
  it('captured shots are not eligible', () => {
    const shots = [makeShot({ id: 'a' }), makeShot({ id: 'b', status: 'captured' }), makeShot({ id: 'c', status: 'uncorrected' })];
    expect(pdfEligible(shots).map((s) => s.id)).toEqual(['a', 'c']);
  });
  it('sizes come from the blob that will be embedded', async () => {
    const { deps } = makeDeps({ blobs: { rectified: blobOf(new Uint8Array(10), 'image/jpeg'), original: blobOf(new Uint8Array(99), 'image/jpeg') } });
    expect(await pdfSizes([makeShot(), makeShot({ status: 'uncorrected' })], deps)).toEqual([10, 99]);
  });
});
