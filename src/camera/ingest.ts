// Ingest (design 2.9, 2.7 item 11; plan.md findings 2, 5, 7). Order, for every blob regardless of source:
//   1. validate from HEADERS only (type, bytes, dimensions),  2. orientation (hand-normalise only if EXIF is not honoured),
//   3. PERSIST THE ORIGINAL,  4. everything optional afterwards: dimension resolution and the thumbnail.
// No pixel decode runs before the original is stored, except the EXIF-normalisation path (rare, flagged `normalized`)
// and the user-confirmed "reduced copy" of a photo above HARD_SOURCE_PIXELS.
import { HARD_SOURCE_PIXELS, MAX_SOURCE_BYTES, THUMB_LONG_EDGE } from '../app/config.ts';
import { getMaxOutputPixels, getMaxSourcePixels } from '../app/canvas-limits.ts';
import { ensureDecodeCaps } from '../app/decode-caps.ts';
import type { DecodeCaps, DecodeResult, ImageInfo } from '../app/decode.ts';
import { MARKER_KEY, decodeGuarded, type GuardCtx, type GuardedOpts } from '../app/decode-guarded.ts';
import { DecodeSkippedError, IngestError } from '../app/errors.ts';
import { whenIdle } from '../app/idle.ts';
import { log } from '../app/log.ts';
import { appHooks } from '../app/state.ts';
import type { ExifOrientation, GridCell, NewShot, ShotKind, ShotSource } from '../storage/schema.ts';
import type { Store } from '../storage/store.ts';
import { bitmapToJpeg, bitmapToThumbJpeg, type JpegOptions } from './encode.ts';
import { orientedDims, readBlobHeader, shotImageInfo, type ImageFormat, type ImageHeader } from './exif.ts';

export const CANT_READ_MESSAGE = "Can't read this image";
/** Long edge of the user-confirmed reduced copy of a photo above HARD_SOURCE_PIXELS. */
export const REDUCED_COPY_LONG_EDGE = 8192;

export interface IngestLimits {
  maxSourcePixels: number;
  hardSourcePixels: number;
  maxSourceBytes: number;
  /** Canvas bound for the hand-normalisation path. */
  maxOutputPixels: number;
}

export interface IngestDeps {
  store: Store;
  decode(blob: Blob, opts: GuardedOpts, ctx: GuardCtx): Promise<DecodeResult>;
  getCaps(): Promise<DecodeCaps>;
  limits(): IngestLimits;
  encodeJpeg(bitmap: ImageBitmap, opts: JpegOptions): Promise<Blob>;
  encodeThumb(bitmap: ImageBitmap, longEdge: number): Promise<Blob>;
  /** Resolves in the next idle slot (low priority work). */
  idle(): Promise<void>;
  /** A photo above HARD_SOURCE_PIXELS: true = "Save a reduced copy", false = "Discard". Absent = discard. */
  confirmReduce?(info: { megapixels: number }): Promise<boolean>;
  /** A stored photo turned out to be undecodable while resolving its size; it has been removed again. */
  onUnreadable?(shotId: string): void;
}

export function createIngestDeps(store: Store, overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    store,
    decode: decodeGuarded,
    getCaps: ensureDecodeCaps,
    limits: () => ({
      maxSourcePixels: getMaxSourcePixels(),
      hardSourcePixels: HARD_SOURCE_PIXELS,
      maxSourceBytes: MAX_SOURCE_BYTES,
      maxOutputPixels: getMaxOutputPixels(),
    }),
    encodeJpeg: bitmapToJpeg,
    encodeThumb: (bitmap, longEdge) => bitmapToThumbJpeg(bitmap, longEdge, 0.8),
    idle: () => new Promise<void>((resolve) => whenIdle(resolve)),
    ...overrides,
  };
}

export interface IngestInput {
  blob: Blob;
  source: ShotSource;
  kind: ShotKind;
  /** Attach to this poster (detail shots, retakes); otherwise a new poster is created. */
  posterId?: string;
  gridCell?: GridCell;
}

export interface IngestResult {
  posterId: string;
  shotId: string;
  /** Plain-language note for the user (for example a photo that had to be reduced). */
  notice?: string;
  /** Resolves when the optional steps (dimension resolution, thumbnail) have finished. Never rejects. */
  background: Promise<void>;
}

const EXTENSION = /\.(jpe?g|png|webp|heic|heif|avif)$/i;
const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  avif: 'image/avif',
  unknown: 'application/octet-stream',
};

/** `image/*`, or an empty/generic type with a known image extension (some browsers leave HEIC untyped). */
export function isSupportedImage(blob: Blob): boolean {
  const type = blob.type.toLowerCase();
  if (type.startsWith('image/')) return true;
  if (type === '' || type === 'application/octet-stream') {
    const name = (blob as Partial<File>).name;
    return typeof name === 'string' && EXTENSION.test(name);
  }
  return false;
}

const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

interface Prepared {
  blob: Blob;
  width: number;
  height: number;
  dimsPending: boolean;
  orientation: ExifOrientation;
  normalized: boolean;
  oversize: boolean;
  mime: string;
  notice?: string;
}

/**
 * Re-encodes the photo upright and bounded (decoder-side EXIF is applied by the decoder when honoured, otherwise by hand).
 * Used by the hand-normalisation path and by the user-confirmed reduced copy.
 */
async function uprightCopy(
  blob: Blob,
  header: ImageHeader,
  caps: DecodeCaps,
  deps: IngestDeps,
  bound: { maxPixels?: number; maxLongEdge?: number },
  kind: 'normalize' | 'reduce',
  quality: number,
): Promise<{ blob: Blob; width: number; height: number; reduced: boolean }> {
  const byHand = !caps.exifHonored && header.orientation > 1;
  // When the decoder does not rotate, the target size must be computed in stored space.
  const info: ImageInfo | undefined =
    header.width && header.height ? { width: header.width, height: header.height, orientation: byHand ? 1 : header.orientation } : undefined;
  let res: DecodeResult;
  try {
    res = await deps.decode(blob, { ...bound, info, label: `ingest-${kind}` }, { shotId: null, kind });
  } catch (e) {
    log.warn('ingest decode failed', e);
    throw new IngestError('unsupported', `${CANT_READ_MESSAGE}. The original is still in your camera roll.`);
  }
  try {
    const out = await deps.encodeJpeg(res.handle.bitmap, { quality, orientation: byHand ? header.orientation : 1 });
    const dims = byHand ? orientedDims(res.width, res.height, header.orientation) : { width: res.width, height: res.height };
    return { blob: out, width: dims.width, height: dims.height, reduced: res.reduced };
  } catch (e) {
    log.warn('ingest re-encode failed', e);
    throw new IngestError('unsupported', `${CANT_READ_MESSAGE}. The original is still in your camera roll.`);
  } finally {
    res.handle.close();
  }
}

async function prepare(input: IngestInput, header: ImageHeader, deps: IngestDeps): Promise<Prepared | null> {
  const limits = deps.limits();
  const { blob } = input;
  const mime = blob.type.startsWith('image/') ? blob.type : MIME_BY_FORMAT[header.format];
  const typed = blob.type === mime ? blob : new Blob([blob], { type: mime });

  // Unknown dimensions are never a rejection: persist now, resolve in the background (finding 2).
  if (!header.width || !header.height) {
    return { blob: typed, width: 0, height: 0, dimsPending: true, orientation: header.orientation, normalized: false, oversize: false, mime };
  }

  const stored = { width: header.width, height: header.height };
  const pixels = stored.width * stored.height;

  // Above HARD_SOURCE_PIXELS: the user chooses; the photo is never dropped silently.
  if (pixels > limits.hardSourcePixels) {
    const wantsCopy = deps.confirmReduce ? await deps.confirmReduce({ megapixels: Math.round(pixels / 1e6) }) : false;
    if (!wantsCopy) return null;
    const caps = await deps.getCaps();
    const copy = await uprightCopy(blob, header, caps, deps, { maxLongEdge: REDUCED_COPY_LONG_EDGE }, 'reduce', 0.92);
    return {
      blob: copy.blob,
      width: copy.width,
      height: copy.height,
      dimsPending: false,
      orientation: 1,
      normalized: true,
      oversize: copy.width * copy.height > limits.maxSourcePixels,
      mime: 'image/jpeg',
      notice: `Saved a reduced copy (${Math.round(pixels / 1e6)} MP photo). The original is still in your camera roll.`,
    };
  }

  // EXIF orientation: only a decoder that ignores it forces a hand-normalised copy (the one decode before persistence).
  if (header.orientation > 1) {
    const caps = await deps.getCaps();
    if (!caps.exifHonored) {
      const copy = await uprightCopy(blob, header, caps, deps, { maxPixels: limits.maxOutputPixels }, 'normalize', 0.95);
      return {
        blob: copy.blob,
        width: copy.width,
        height: copy.height,
        dimsPending: false,
        orientation: 1,
        normalized: true,
        oversize: false,
        mime: 'image/jpeg',
        notice: copy.reduced ? 'This photo was reduced in size to fit this device.' : undefined,
      };
    }
  }

  const oriented = orientedDims(stored.width, stored.height, header.orientation);
  return {
    blob: typed,
    width: oriented.width,
    height: oriented.height,
    dimsPending: false,
    orientation: header.orientation,
    normalized: false,
    oversize: pixels > limits.maxSourcePixels,
    mime,
  };
}

/**
 * Validates, persists and returns. `null` means the user chose "Discard" for a photo above HARD_SOURCE_PIXELS.
 * Throws IngestError('unsupported' | 'too-large') (nothing saved) or the store's StorageError.
 */
export async function ingestImage(input: IngestInput, deps: IngestDeps): Promise<IngestResult | null> {
  const limits = deps.limits();
  const { blob } = input;
  if (!isSupportedImage(blob)) throw new IngestError('unsupported', CANT_READ_MESSAGE);
  if (blob.size > limits.maxSourceBytes) {
    throw new IngestError('too-large', `File too large (${mb(blob.size)} MB, ${mb(limits.maxSourceBytes)} MB max)`);
  }
  let header: ImageHeader;
  try {
    header = await readBlobHeader(blob);
  } catch (e) {
    log.warn('image header could not be read', e);
    throw new IngestError('unsupported', CANT_READ_MESSAGE);
  }
  if (header.format === 'unknown') throw new IngestError('unsupported', CANT_READ_MESSAGE);

  const prepared = await prepare(input, header, deps);
  if (!prepared) return null;

  const newShot: NewShot = {
    kind: input.kind,
    gridCell: input.gridCell,
    source: input.source,
    width: prepared.width,
    height: prepared.height,
    dimsPending: prepared.dimsPending || undefined,
    originalMime: prepared.mime,
    originalBytes: prepared.blob.size,
    normalized: prepared.normalized,
    originalExifOrientation: prepared.orientation,
    oversize: prepared.oversize || undefined,
  };

  // ---- persist BEFORE any optional decode (NFR-7, AC-42) ----
  let posterId: string;
  let shotId: string;
  const createdPoster = input.posterId === undefined;
  if (input.posterId !== undefined) {
    posterId = input.posterId;
    shotId = await deps.store.addShot(posterId, newShot, prepared.blob);
  } else {
    ({ posterId, shotId } = await deps.store.createPosterWithShot({}, newShot, prepared.blob));
  }

  const background = (async (): Promise<void> => {
    try {
      if (prepared.dimsPending) await ensureDims(shotId, deps);
      await deps.idle();
      await makeThumb(shotId, deps);
    } catch (e) {
      log.warn('background ingest step failed', e);
      if (prepared.dimsPending) await discardUnreadable(shotId, posterId, createdPoster, deps);
    }
  })();

  return { posterId, shotId, notice: prepared.notice, background };
}

/** A photo whose size could not be resolved cannot be decoded at all: remove it again and tell the UI. */
async function discardUnreadable(shotId: string, posterId: string, createdPoster: boolean, deps: IngestDeps): Promise<void> {
  try {
    if (createdPoster) await deps.store.deletePoster(posterId);
    else await deps.store.deleteShot(shotId);
  } catch (e) {
    log.warn('could not remove an unreadable photo', e);
  }
  deps.onUnreadable?.(shotId);
}

// ---- dimension resolution (dimsPending) ----

const dimsJobs = new Map<string, Promise<void>>();

/**
 * Resolves width/height of a shot ingested with unknown dimensions through a gated decode (kind 'normalize'),
 * then clears `dimsPending`. Concurrent callers (Adjust opening right after ingest) share one job.
 */
export function ensureDims(shotId: string, deps: IngestDeps): Promise<void> {
  const existing = dimsJobs.get(shotId);
  if (existing) return existing;
  const job = (async (): Promise<void> => {
    const shot = await deps.store.getShot(shotId);
    if (!shot || !shot.dimsPending) return;
    const blob = await deps.store.getBlob(shotId, 'original');
    if (!blob) return;
    const res = await deps.decode(blob, { label: 'dims' }, { shotId, kind: 'normalize' });
    let width = res.width;
    let height = res.height;
    res.handle.close();
    if (width < 1 || height < 1) {
      width = 1;
      height = 1;
    }
    await deps.store.updateShotParams(shotId, {
      width,
      height,
      dimsPending: false,
      oversize: width * height > deps.limits().maxSourcePixels,
    });
  })();
  dimsJobs.set(shotId, job);
  const clear = (): void => {
    if (dimsJobs.get(shotId) === job) dimsJobs.delete(shotId);
  };
  job.then(clear, clear);
  return job;
}

// ---- thumbnails ----

/** 256 px JPEG thumbnail of `blob` through the guarded decoder (kind 'thumb'). Throws DecodeSkippedError after a strike. */
export async function thumbFromBlob(blob: Blob, info: ImageInfo | undefined, shotId: string, deps: IngestDeps): Promise<Blob> {
  const res = await deps.decode(blob, { maxLongEdge: THUMB_LONG_EDGE, info, label: 'thumb' }, { shotId, kind: 'thumb' });
  try {
    return await deps.encodeThumb(res.handle.bitmap, THUMB_LONG_EDGE);
  } finally {
    res.handle.close();
  }
}

/**
 * Creates and stores the thumbnail of one shot. A rectified shot is thumbnailed from its rectified blob, everything else
 * from the original. Failure (or a strike skip) leaves the placeholder in place: a `warn` log, never a toast (AC-42).
 */
export async function makeThumb(shotId: string, deps: IngestDeps): Promise<boolean> {
  try {
    let shot = await deps.store.getShot(shotId);
    if (!shot || shot.thumb) return false;
    if (shot.dimsPending) {
      await ensureDims(shotId, deps);
      shot = await deps.store.getShot(shotId);
      if (!shot || shot.thumb) return false;
    }
    const rectified = shot.status === 'rectified' && !!shot.rectifiedWidth && !!shot.rectifiedHeight;
    const blob = await deps.store.getBlob(shotId, rectified ? 'rectified' : 'original');
    if (!blob) return false;
    const info: ImageInfo | undefined = rectified
      ? { width: shot.rectifiedWidth!, height: shot.rectifiedHeight!, orientation: 1 }
      : shot.width > 0 && shot.height > 0
        ? shotImageInfo(shot)
        : undefined;
    const thumb = await thumbFromBlob(blob, info, shotId, deps);
    await deps.store.setThumb(shotId, thumb);
    return true;
  } catch (e) {
    if (e instanceof DecodeSkippedError) log.info('thumbnail skipped', e.message);
    else log.warn('thumbnail failed; the placeholder stays', e);
    return false;
  }
}

/** Finding 7: the Adjust screen derives the thumbnail from its already-decoded preview instead of decoding again. */
export async function setThumbFromBitmap(shotId: string, bitmap: ImageBitmap, deps: IngestDeps): Promise<boolean> {
  try {
    const shot = await deps.store.getShot(shotId);
    if (!shot || shot.thumb) return false;
    await deps.store.setThumb(shotId, await deps.encodeThumb(bitmap, THUMB_LONG_EDGE));
    return true;
  } catch (e) {
    log.warn('thumbnail from preview failed', e);
    return false;
  }
}

/**
 * Lazy startup sweep (design 2.9 item 5): one shot per idle slot, newest first, stopping while a heavy-decode marker is
 * present. Repairs thumbnails lost to a tab kill between persist and the thumbnail step.
 */
export async function sweepThumbnails(deps: IngestDeps): Promise<number> {
  let made = 0;
  const ids = await deps.store.listShotsMissingThumb();
  for (const id of ids) {
    await deps.idle();
    if ((await deps.store.getMeta(MARKER_KEY)) !== undefined) break; // checked after the wait: the marker may have appeared meanwhile
    if (await makeThumb(id, deps)) made++;
  }
  return made;
}

/** main.ts runs the registered hook once after the first user interaction. */
export function registerThumbSweep(deps: IngestDeps): void {
  appHooks.thumbSweep = async () => {
    await sweepThumbnails(deps);
  };
}
