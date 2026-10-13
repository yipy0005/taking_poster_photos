// PDF export (design 2.13, plan.md finding 3, AC-30). pdf-lib is imported dynamically so it is a separate chunk (NFR-3).
// One page per shot, read and released one at a time so the document is the only large live structure.
import { ExportError } from '../app/errors.ts';
import { readBlobHeader, shotImageInfo } from '../camera/exif.ts';
import type { Rotation } from '../cv/geometry.ts';
import type { ShotRecord } from '../storage/schema.ts';
import { JPEG_QUALITY, type ExportDeps } from './render-export.ts';

/** Page size comes from the oriented pixel size at 150 dpi nominal. */
export const PDF_DPI = 150;
export const PDF_MAX_PAGE_PT = 14_400;

export interface PdfPage {
  /** Embeddable JPEG bytes (no EXIF orientation other than 1). */
  jpeg: Uint8Array;
  /** Stored clockwise rotation: becomes the page /Rotate. */
  rotation: Rotation;
}

/** Page size in points for an image of `wPx x hPx` pixels: 150 dpi, neither side above 14400 pt, aspect preserved. */
export function pdfPageSize(wPx: number, hPx: number): [number, number] {
  let w = (wPx * 72) / PDF_DPI;
  let h = (hPx * 72) / PDF_DPI;
  const longest = Math.max(w, h);
  if (longest > PDF_MAX_PAGE_PT) {
    const f = PDF_MAX_PAGE_PT / longest;
    w *= f;
    h *= f;
  }
  return [Math.max(1, w), Math.max(1, h)];
}

export interface PdfBuildOptions {
  title: string;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
  now?: Date;
}

const abortError = (): Error => {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
};

/** Builds the PDF page by page; `loadPage(i)` is called for one page at a time and its bytes are dropped before the next. */
export async function buildPdf(count: number, loadPage: (index: number) => Promise<PdfPage>, o: PdfBuildOptions): Promise<Blob> {
  const { PDFDocument, degrees } = await import('pdf-lib');
  // updateMetadata: false keeps pdf-lib's default producer/creator out; only the title and creation date are set
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(o.title);
  doc.setCreationDate(o.now ?? new Date());
  for (let i = 0; i < count; i++) {
    if (o.signal?.aborted) throw abortError();
    let page: PdfPage | null = await loadPage(i);
    const image = await doc.embedJpg(page.jpeg);
    const [w, h] = pdfPageSize(image.width, image.height);
    const p = doc.addPage([w, h]);
    p.drawImage(image, { x: 0, y: 0, width: w, height: h });
    if (page.rotation !== 0) p.setRotation(degrees(page.rotation));
    page = null;
    o.onProgress?.(i + 1, count);
  }
  const bytes = await doc.save();
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Embeddable JPEG bytes for one shot.
 * - rectified: the stored blob, unchanged (produced by a canvas encode, so it has no EXIF);
 * - uncorrected JPEG with EXIF orientation 1 or absent: the stored original, unchanged;
 * - anything else (orientation 2..8, PNG/WebP/HEIC): decoded (EXIF applied) and re-encoded to JPEG q0.92 as a gated job, because
 *   pdf-lib's embedJpg ignores EXIF and would draw an orientation-6 photo sideways.
 */
export async function pdfPageFor(shot: ShotRecord, deps: ExportDeps, o: { signal?: AbortSignal } = {}): Promise<PdfPage> {
  if (shot.status === 'captured') throw new ExportError('Adjust this photo first');
  const kind = shot.status === 'rectified' ? 'rectified' : 'original';
  const blob = await deps.getBlob(shot.id, kind);
  if (!blob) throw new ExportError('A photo file is missing');
  const header = await readBlobHeader(blob);
  const asIs =
    header.format === 'jpeg' && header.orientation === 1 && (kind === 'rectified' || shot.originalExifOrientation === 1);
  if (asIs) return { jpeg: await bytesOf(blob), rotation: shot.rotation };

  const info = kind === 'rectified' ? { width: shot.rectifiedWidth ?? shot.width, height: shot.rectifiedHeight ?? shot.height, orientation: 1 } : shotImageInfo(shot);
  const res = await deps.decode(blob, { info, maxPixels: deps.maxPixels(), signal: o.signal }, { shotId: shot.id, kind: 'export' });
  try {
    const jpeg = await deps.rotateEncode(res.handle.bitmap, 0, 'image/jpeg', JPEG_QUALITY);
    return { jpeg: await bytesOf(jpeg), rotation: shot.rotation };
  } finally {
    res.handle.close();
  }
}

/** Shots that can go into a PDF (everything except still-`captured` ones), in poster order. */
export function pdfEligible<T extends Pick<ShotRecord, 'status'>>(shots: readonly T[]): T[] {
  return shots.filter((s) => s.status !== 'captured');
}

/** Byte size of what each shot will contribute (blob sizes; used to plan parts without reading the bytes). */
export async function pdfSizes(shots: readonly ShotRecord[], deps: Pick<ExportDeps, 'getBlob'>): Promise<number[]> {
  const sizes: number[] = [];
  for (const s of shots) {
    const blob = await deps.getBlob(s.id, s.status === 'rectified' ? 'rectified' : 'original');
    sizes.push(blob?.size ?? 0);
  }
  return sizes;
}

/** Builds one PDF from `shots` (already the part's shots, in order). */
export function buildPosterPdf(
  title: string,
  shots: readonly ShotRecord[],
  deps: ExportDeps,
  o: { onProgress?(done: number, total: number): void; signal?: AbortSignal } = {},
): Promise<Blob> {
  return buildPdf(shots.length, (i) => pdfPageFor(shots[i]!, deps, { signal: o.signal }), { title, onProgress: o.onProgress, signal: o.signal });
}
