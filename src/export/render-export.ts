// Producing the files the user exports (design 2.13, plan.md finding 3). All heavy decodes go through decodeGuarded
// (memory gate + marker + strike caps). The functions take their collaborators as `ExportDeps` so they run in Node tests.
import { getMaxOutputPixels, MAX_DECODE_PIXELS } from '../app/canvas-limits.ts';
import type { DecodeResult } from '../app/decode.ts';
import { decodeGuarded, type GuardCtx, type GuardedOpts } from '../app/decode-guarded.ts';
import { ExportError } from '../app/errors.ts';
import { bitmapToBlob } from '../camera/encode.ts';
import { shotImageInfo } from '../camera/exif.ts';
import type { EngineClient } from '../cv/engine-client.ts';
import type { Rotation } from '../cv/geometry.ts';
import type { BlobKind, ShotRecord } from '../storage/schema.ts';
import { extensionFor } from './filename.ts';

export const JPEG_QUALITY = 0.92;
/** PNG is re-rendered losslessly from the original, which is expensive: disabled above 25 MP. */
export const PNG_MAX_PIXELS = 25_000_000;
export const PNG_DISABLED_MESSAGE = 'PNG is limited to 25 MP on mobile; use JPEG.';
export const REDUCED_EXPORT_NOTICE = 'Exported at reduced size';

export type ExportMime = 'image/jpeg' | 'image/png';

/** Canvas redraw of an upright bitmap, rotated clockwise by `rotation`, encoded as JPEG or PNG. */
export type RotateEncode = (bitmap: ImageBitmap, rotation: Rotation, mime: ExportMime, quality: number) => Promise<Blob>;

export interface ExportDeps {
  getBlob(shotId: string, kind: BlobKind): Promise<Blob | null>;
  decode(blob: Blob, opts: GuardedOpts, ctx: GuardCtx): Promise<DecodeResult>;
  rotateEncode: RotateEncode;
  engine?: Pick<EngineClient, 'render'>;
  /** Largest bitmap the exporter may create. */
  maxPixels(): number;
}

export interface ExportOutput {
  blob: Blob;
  mime: string;
  ext: string;
  /** Shown to the user, for example "Exported at reduced size". */
  notice?: string;
}

/** Clockwise degrees to the EXIF orientation that draws an image the same way (6 = 90 CW, 3 = 180, 8 = 270 CW). */
export function rotationToOrientation(rotation: Rotation): number {
  return rotation === 90 ? 6 : rotation === 180 ? 3 : rotation === 270 ? 8 : 1;
}

export function createExportDeps(store: { getBlob(shotId: string, kind: BlobKind): Promise<Blob | null> }, engine?: Pick<EngineClient, 'render'>): ExportDeps {
  return {
    getBlob: (id, kind) => store.getBlob(id, kind),
    decode: decodeGuarded,
    rotateEncode: (bitmap, rotation, mime, quality) => bitmapToBlob(bitmap, { mime, quality, orientation: rotationToOrientation(rotation) }),
    engine,
    maxPixels: () => Math.min(getMaxOutputPixels(), MAX_DECODE_PIXELS),
  };
}

const PASS_THROUGH_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** The stored original can be handed out untouched when no rotation is needed and the browser/OS reads its format everywhere. */
export function originalPassesThrough(shot: Pick<ShotRecord, 'originalMime' | 'rotation'>): boolean {
  return shot.rotation === 0 && PASS_THROUGH_MIMES.has(shot.originalMime.toLowerCase());
}

/** Whether a JPEG export (or share) of this shot needs no decode at all. */
export function jpegNeedsNoDecode(shot: Pick<ShotRecord, 'status' | 'rotation' | 'originalMime'>): boolean {
  if (shot.status === 'rectified') return shot.rotation === 0;
  if (shot.status === 'uncorrected') return originalPassesThrough(shot);
  return false;
}

export interface PngAvailability {
  /** The PNG option is not offered at all (uncorrected and captured shots). */
  hidden: boolean;
  disabled: boolean;
  reason?: string;
}

export function pngAvailability(shot: Pick<ShotRecord, 'status' | 'rectifiedWidth' | 'rectifiedHeight'>): PngAvailability {
  if (shot.status !== 'rectified') return { hidden: true, disabled: true };
  const px = (shot.rectifiedWidth ?? 0) * (shot.rectifiedHeight ?? 0);
  if (px > PNG_MAX_PIXELS) return { hidden: false, disabled: true, reason: PNG_DISABLED_MESSAGE };
  return { hidden: false, disabled: false };
}

function mimeOf(blob: Blob, fallback: string): string {
  return blob.type || fallback;
}

async function requireBlob(deps: ExportDeps, shotId: string, kind: BlobKind): Promise<Blob> {
  const blob = await deps.getBlob(shotId, kind);
  if (!blob) throw new ExportError(kind === 'original' ? 'The original photo is missing' : 'The corrected photo is missing');
  return blob;
}

/** Decodes under the gate, redraws rotated and encodes; always closes the bitmap. */
async function redraw(
  deps: ExportDeps,
  blob: Blob,
  shotId: string,
  info: GuardedOpts['info'],
  rotation: Rotation,
  mime: ExportMime,
  signal?: AbortSignal,
): Promise<{ blob: Blob; reduced: boolean }> {
  const res = await deps.decode(blob, { info, maxPixels: deps.maxPixels(), signal }, { shotId, kind: 'export' });
  try {
    const out = await deps.rotateEncode(res.handle.bitmap, rotation, mime, JPEG_QUALITY);
    return { blob: out, reduced: res.reduced };
  } finally {
    res.handle.close();
  }
}

/**
 * JPEG download / share payload.
 * - rectified, rotation 0: the stored blob (no decode);
 * - rectified, rotation != 0: one gated canvas redraw (AC-28);
 * - uncorrected, rotation 0, original jpeg/png/webp: the stored original, untouched (no decode, even with EXIF orientation 6);
 * - uncorrected otherwise: gated decode + rotate + JPEG q0.92, with a "reduced size" notice when the bitmap was bounded.
 */
export async function exportJpeg(shot: ShotRecord, deps: ExportDeps, o: { signal?: AbortSignal } = {}): Promise<ExportOutput> {
  if (shot.status === 'captured') throw new ExportError('Adjust this photo first');
  if (shot.status === 'rectified') {
    const rect = await requireBlob(deps, shot.id, 'rectified');
    if (shot.rotation === 0) return { blob: rect, mime: mimeOf(rect, 'image/jpeg'), ext: extensionFor(mimeOf(rect, 'image/jpeg')) };
    const info = { width: shot.rectifiedWidth ?? shot.width, height: shot.rectifiedHeight ?? shot.height, orientation: 1 };
    const out = await redraw(deps, rect, shot.id, info, shot.rotation, 'image/jpeg', o.signal);
    return { blob: out.blob, mime: 'image/jpeg', ext: 'jpg', notice: out.reduced ? REDUCED_EXPORT_NOTICE : undefined };
  }
  const original = await requireBlob(deps, shot.id, 'original');
  if (originalPassesThrough(shot)) {
    const mime = mimeOf(original, shot.originalMime);
    return { blob: original, mime, ext: extensionFor(mime) };
  }
  const out = await redraw(deps, original, shot.id, shotImageInfo(shot), shot.rotation, 'image/jpeg', o.signal);
  return { blob: out.blob, mime: 'image/jpeg', ext: 'jpg', notice: out.reduced ? REDUCED_EXPORT_NOTICE : undefined };
}

/** PNG: re-rendered from the original through the pipeline (lossless warp), then rotated when needed. Rectified shots only. */
export async function exportPng(shot: ShotRecord, deps: ExportDeps, o: { signal?: AbortSignal; onProgress?(p: number): void } = {}): Promise<ExportOutput> {
  const availability = pngAvailability(shot);
  if (availability.hidden) throw new ExportError('PNG is only available for corrected photos');
  if (availability.disabled) throw new ExportError(availability.reason ?? PNG_DISABLED_MESSAGE);
  if (!deps.engine) throw new ExportError("Can't render in this browser");
  if (!shot.corners) throw new ExportError('The corners of this photo are missing');
  const original = await requireBlob(deps, shot.id, 'original');
  const outW = shot.rectifiedWidth ?? 0;
  const outH = shot.rectifiedHeight ?? 0;
  const result = await deps.engine.render({
    shotId: shot.id,
    original,
    info: shotImageInfo(shot),
    quad: shot.corners,
    outW,
    outH,
    enhance: shot.enhance,
    mime: 'image/png',
    signal: o.signal,
    onProgress: o.onProgress,
  });
  if (shot.rotation === 0) return { blob: result.blob, mime: 'image/png', ext: 'png' };
  const out = await redraw(deps, result.blob, shot.id, { width: result.width, height: result.height, orientation: 1 }, shot.rotation, 'image/png', o.signal);
  return { blob: out.blob, mime: 'image/png', ext: 'png', notice: out.reduced ? REDUCED_EXPORT_NOTICE : undefined };
}

/** "Export original": the stored blob, byte for byte. */
export async function exportOriginal(shot: ShotRecord, deps: ExportDeps): Promise<ExportOutput> {
  const original = await requireBlob(deps, shot.id, 'original');
  const mime = mimeOf(original, shot.originalMime);
  return { blob: original, mime, ext: extensionFor(mime) };
}
