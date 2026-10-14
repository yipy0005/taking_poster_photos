// Still capture chain (design 2.9): takePhoto -> (re-apply high-res constraints) -> grabFrame / video canvas.
// The file-input fallbacks live in the capture screen. Nothing here throws just because ImageCapture is absent (AC-46a).
import { decodeRaw, type DecodeResult } from '../app/decode.ts';
import { CaptureError } from '../app/errors.ts';
import { log } from '../app/log.ts';
import { isVeryDark, lumaStats, type LumaStats } from './brightness.ts';
import { readBlobHeader } from './exif.ts';
import { pickPhotoSize, type PhotoSizeCaps, type Range } from './photo-size.ts';

export type CaptureSource = 'camera-takephoto' | 'camera-frame';

export interface CapturedImage {
  blob: Blob;
  source: CaptureSource;
  /** Known for frame grabs; for takePhoto the real size is read from the blob header (exif.ts). */
  width?: number;
  height?: number;
  /** Brightness of the accepted frame, when a `measureLuma` was supplied and succeeded. */
  luma?: LumaStats;
  /** The best frame we could get is still very dark (see brightness.ts): the caller shows a warning but keeps the photo. */
  dark?: boolean;
}

export interface PhotoCapabilitiesLike {
  imageWidth?: Range;
  imageHeight?: Range;
  fillLightMode?: readonly string[];
  redEyeReduction?: string;
}

export interface ImageCaptureLike {
  getPhotoCapabilities?(): Promise<PhotoCapabilitiesLike>;
  takePhoto?(settings?: Record<string, unknown>): Promise<Blob>;
  grabFrame?(): Promise<ImageBitmap>;
}

export interface CaptureCanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): { drawImage(...args: unknown[]): void } | null;
  toBlob(callback: BlobCallback, type?: string, quality?: number): void;
}

export interface VideoLike {
  videoWidth: number;
  videoHeight: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

export interface CaptureDeps {
  track: Pick<MediaStreamTrack, 'applyConstraints'>;
  video: VideoLike;
  /** ImageCapture constructor, or undefined where the global is absent. Defaults to globalThis.ImageCapture. */
  ImageCaptureCtor?: (new (track: MediaStreamTrack) => ImageCaptureLike) | undefined;
  createCanvas(width: number, height: number): CaptureCanvasLike;
  /** MAX_SOURCE_PIXELS: clamp for the takePhoto request. */
  maxSourcePixels: number;
  /** getMaxOutputPixels(): clamp for canvas frame grabs. */
  maxOutputPixels: number;
  /** The user switched the torch on: do not force the flash off. */
  torchOn?: boolean;
  /** How long to wait for the video `resize` event after re-applying constraints (default 600 ms). */
  resizeWaitMs?: number;
  /**
   * Re-apply the high-resolution constraints before a frame grab (default true). Pass false when the session already raised the
   * resolution at start: a second reconfigure restarts auto-exposure right before the grab (iOS).
   */
  reapplyHighRes?: boolean;
  /**
   * Brightness probe for the dark-frame safeguard. Receives the frame source (video element or ImageBitmap) or the takePhoto Blob.
   * Return null / throw when it cannot measure: the frame is then accepted as it is.
   */
  measureLuma?: (source: unknown) => Promise<LumaStats | null>;
  /** Pause between dark-frame retries (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** Dark-frame retries: up to 5 more frames, ~200 ms apart (about 1 s), or one more takePhoto after ~400 ms. */
export const DARK_FRAME_RETRIES = 5;
export const DARK_FRAME_RETRY_MS = 200;
export const DARK_STILL_RETRY_MS = 400;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function tryMeasure(deps: CaptureDeps, source: unknown): Promise<LumaStats | undefined> {
  if (!deps.measureLuma) return undefined;
  try {
    return (await deps.measureLuma(source)) ?? undefined;
  } catch (e) {
    log.warn('could not measure the frame brightness; accepting the frame as it is', e);
    return undefined;
  }
}

/**
 * Measures a canvas-drawable source (video, ImageBitmap) or a Blob on a 64x48 canvas. The real `measureLuma` for the capture screen.
 * Frees the temporary bitmap and canvas.
 */
export async function measureSourceLuma(source: unknown, createCanvas: CaptureDeps['createCanvas']): Promise<LumaStats | null> {
  const W = 64;
  const H = 48;
  let decoded: DecodeResult | null = null;
  let canvas: CaptureCanvasLike | null = null;
  try {
    let drawable = source;
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      // the only decoder (app/decode.ts), bounded to a tiny size; the header gives the dimensions so it can resize while decoding
      const header = await readBlobHeader(source).catch(() => null);
      const info = header?.width && header.height ? { width: header.width, height: header.height, orientation: header.orientation } : null;
      decoded = await decodeRaw(source, { maxLongEdge: W, info, label: 'luma' });
      drawable = decoded.handle.bitmap;
    }
    canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d') as (CanvasRenderingContext2D & { drawImage(...a: unknown[]): void }) | null;
    if (!ctx || typeof ctx.getImageData !== 'function') return null;
    ctx.drawImage(drawable as CanvasImageSource, 0, 0, W, H);
    return lumaStats(ctx.getImageData(0, 0, W, H).data);
  } finally {
    decoded?.handle.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

const HIGH_RES = { width: { ideal: 4096 }, height: { ideal: 3072 } } as const;

function defaultCtor(): CaptureDeps['ImageCaptureCtor'] {
  const g = globalThis as { ImageCapture?: CaptureDeps['ImageCaptureCtor'] };
  return typeof g.ImageCapture === 'function' ? g.ImageCapture : undefined;
}

const hasPrototypeFn = (ctor: unknown, name: 'takePhoto' | 'grabFrame'): boolean =>
  typeof ctor === 'function' && typeof (ctor as { prototype?: Record<string, unknown> }).prototype?.[name] === 'function';

function validRange(r: Range | undefined): r is Range {
  return !!r && Number.isFinite(r.min) && Number.isFinite(r.max) && r.max > 0;
}

/** takePhoto settings: clamped size, flash off unless the torch is on, red-eye off when controllable. */
export function buildPhotoSettings(caps: PhotoCapabilitiesLike, maxSourcePixels: number, torchOn: boolean): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (validRange(caps.imageWidth) && validRange(caps.imageHeight)) {
    Object.assign(settings, pickPhotoSize(caps as PhotoSizeCaps, maxSourcePixels));
  }
  if (!torchOn && caps.fillLightMode?.includes('off')) settings['fillLightMode'] = 'off';
  if (caps.redEyeReduction === 'controllable') settings['redEyeReduction'] = false;
  return settings;
}

async function takeStill(ctor: NonNullable<CaptureDeps['ImageCaptureCtor']>, track: MediaStreamTrack, deps: CaptureDeps): Promise<Blob> {
  const ic = new ctor(track);
  if (typeof ic.takePhoto !== 'function') throw new Error('takePhoto is not available');
  let settings: Record<string, unknown> = {};
  try {
    const caps = await ic.getPhotoCapabilities?.();
    if (caps) settings = buildPhotoSettings(caps, deps.maxSourcePixels, deps.torchOn === true);
  } catch (e) {
    log.warn('getPhotoCapabilities failed; taking the photo with defaults', e);
  }
  const blob = await ic.takePhoto(settings);
  if (!blob || blob.size === 0) throw new Error('takePhoto returned an empty blob');
  return blob;
}

function waitForResize(video: VideoLike, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      video.removeEventListener('resize', done);
      resolve();
    };
    video.addEventListener('resize', done);
    timer = setTimeout(done, ms);
  });
}

function toBlob(canvas: CaptureCanvasLike, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/** Size of the frame, scaled down by sqrt(cap / pixels) when larger than the output cap. */
export function frameSize(w: number, h: number, maxPixels: number): { width: number; height: number } {
  if (w * h <= maxPixels) return { width: w, height: h };
  const s = Math.sqrt(maxPixels / (w * h));
  return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)) };
}

/** Draws one frame (video element or ImageBitmap) onto a canvas and encodes it. Always frees the bitmap and the canvas. */
async function grabOnce(ctor: CaptureDeps['ImageCaptureCtor'], track: MediaStreamTrack, deps: CaptureDeps): Promise<CapturedImage> {
  let canvas: CaptureCanvasLike | null = null;
  let bitmap: ImageBitmap | null = null;
  try {
    let srcW: number;
    let srcH: number;
    let source: unknown;
    if (ctor && hasPrototypeFn(ctor, 'grabFrame')) {
      bitmap = await new ctor(track).grabFrame!();
      srcW = bitmap.width;
      srcH = bitmap.height;
      source = bitmap;
    } else {
      srcW = deps.video.videoWidth;
      srcH = deps.video.videoHeight;
      source = deps.video;
    }
    if (!srcW || !srcH) throw new CaptureError('frame', 'Capture failed, try again');
    const { width, height } = frameSize(srcW, srcH, deps.maxOutputPixels);
    canvas = deps.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CaptureError('frame', 'Capture failed, try again');
    ctx.drawImage(source, 0, 0, width, height);
    const luma = await tryMeasure(deps, source);
    const blob = await toBlob(canvas, 0.95);
    if (!blob || blob.size === 0) throw new CaptureError('frame', 'Capture failed, try again');
    return { blob, source: 'camera-frame', width, height, luma };
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

async function grabFrame(ctor: CaptureDeps['ImageCaptureCtor'], track: MediaStreamTrack, deps: CaptureDeps): Promise<CapturedImage> {
  // Re-apply the high-resolution constraints: if we got here because takePhoto failed, the stream is still the small preview.
  // Skipped when the session already raised the resolution at start (a second reconfigure restarts auto-exposure: dark frames).
  if (deps.reapplyHighRes !== false) {
    try {
      await deps.track.applyConstraints(HIGH_RES);
    } catch (e) {
      log.warn('could not re-apply high-resolution constraints', e);
    }
    await waitForResize(deps.video, deps.resizeWaitMs ?? 600);
  }

  // Dark-frame safeguard: right after a start or reconfigure the first frames can be near black while auto-exposure converges.
  // Grab again (bounded) and keep the brightest; if it is still dark it is returned with `dark: true`, never thrown.
  const sleep = deps.sleep ?? defaultSleep;
  let best = await grabOnce(ctor, track, deps);
  for (let i = 0; i < DARK_FRAME_RETRIES && best.luma && isVeryDark(best.luma); i++) {
    await sleep(DARK_FRAME_RETRY_MS);
    const next = await grabOnce(ctor, track, deps).catch((e: unknown) => {
      log.warn('dark-frame retry failed', e);
      return null;
    });
    if (next?.luma && next.luma.mean > best.luma.mean) best = next;
    else if (!next) break;
  }
  if (best.luma && isVeryDark(best.luma)) best.dark = true;
  return best;
}

/**
 * The size takePhoto will produce (the clamped largest photo size), for the achieved-resolution readout (AC-1, AC-3b).
 * null where ImageCapture/takePhoto is absent or the capabilities are unusable: the caller then shows the stream size.
 */
export async function probeStillSize(
  track: MediaStreamTrack,
  maxSourcePixels: number,
  ctor: CaptureDeps['ImageCaptureCtor'] = defaultCtor(),
): Promise<{ width: number; height: number } | null> {
  if (!ctor || !hasPrototypeFn(ctor, 'takePhoto')) return null;
  try {
    const caps = await new ctor(track).getPhotoCapabilities?.();
    if (!caps || !validRange(caps.imageWidth) || !validRange(caps.imageHeight)) return null;
    const s = pickPhotoSize(caps as PhotoSizeCaps, maxSourcePixels);
    return { width: s.imageWidth, height: s.imageHeight };
  } catch (e) {
    log.warn('getPhotoCapabilities failed', e);
    return null;
  }
}

/**
 * Takes one still from the live track. Order: takePhoto at the largest size within the soft limit, then a frame grab at
 * the largest stream size. A takePhoto rejection is logged and falls through; only a failed frame grab throws.
 */
export async function captureStill(deps: CaptureDeps & { track: MediaStreamTrack }): Promise<CapturedImage> {
  const ctor = 'ImageCaptureCtor' in deps ? deps.ImageCaptureCtor : defaultCtor();
  if (ctor && hasPrototypeFn(ctor, 'takePhoto')) {
    try {
      let blob = await takeStill(ctor, deps.track, deps);
      let luma = await tryMeasure(deps, blob);
      if (luma && isVeryDark(luma)) {
        // one more photo after a short wait, keep the brighter one (a failure of the retry keeps the first photo)
        await (deps.sleep ?? defaultSleep)(DARK_STILL_RETRY_MS);
        try {
          const again = await takeStill(ctor, deps.track, deps);
          const againLuma = await tryMeasure(deps, again);
          if (againLuma && againLuma.mean > luma.mean) {
            blob = again;
            luma = againLuma;
          }
        } catch (e) {
          log.warn('second takePhoto failed; keeping the first photo', e);
        }
      }
      const out: CapturedImage = { blob, source: 'camera-takephoto', luma };
      if (luma && isVeryDark(luma)) out.dark = true;
      return out;
    } catch (e) {
      log.warn('takePhoto failed; falling back to a frame grab', e);
    }
  }
  return grabFrame(ctor, deps.track, deps);
}
