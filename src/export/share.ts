// Web Share (design 2.13, plan.md finding 3, AC-29, AC-37). The blob to share is always ready BEFORE the tap, so
// navigator.share() runs synchronously inside the click handler and transient user activation is not lost.
import type { BitmapHandle } from '../app/bitmap-handle.ts';
import { isAbortError } from '../app/errors.ts';
import { log } from '../app/log.ts';
import type { MemoryGate } from '../app/memory-gate.ts';
import type { Rotation } from '../cv/geometry.ts';
import type { ShotRecord } from '../storage/schema.ts';
import { exportJpeg, JPEG_QUALITY, jpegNeedsNoDecode, type ExportDeps, type ExportOutput } from './render-export.ts';

export interface ShareNavigator {
  canShare?(data?: ShareData): boolean;
  share?(data?: ShareData): Promise<void>;
}

const nav = (): ShareNavigator | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as ShareNavigator));

/** Feature detection with a probe file: hide the Share button when false. */
export function canShareFiles(n: ShareNavigator | undefined = nav()): boolean {
  if (!n || typeof n.canShare !== 'function' || typeof n.share !== 'function') return false;
  try {
    return n.canShare({ files: [new File([], 'x.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'download-fallback' | 'failed';

/**
 * Hands the file to the OS share sheet. Everything before the first `await` runs synchronously, so call this directly from the
 * click handler. AbortError (user cancelled) is silent; NotAllowedError asks the caller to fall back to a download.
 */
export async function shareFile(blob: Blob, filename: string, mime: string, n: ShareNavigator | undefined = nav()): Promise<ShareOutcome> {
  if (!n || typeof n.share !== 'function') return 'failed';
  try {
    const file = new File([blob], filename, { type: mime || blob.type });
    await n.share({ files: [file], title: filename });
    return 'shared';
  } catch (e) {
    if (isAbortError(e)) return 'cancelled';
    if ((e as { name?: unknown } | null)?.name === 'NotAllowedError') return 'download-fallback';
    log.error('share failed', e);
    return 'failed';
  }
}

// ---- preparing the payload ahead of the tap ----

/** Viewer.lendFullBitmap: runs the callback with the live full bitmap, or returns null when there is none to lend. */
export type LendFullBitmap = <T>(fn: (handle: BitmapHandle) => Promise<T>) => Promise<T | null>;

export type ShareStatus = 'idle' | 'rendering' | 'ready' | 'failed';

export interface PreparedShare extends ExportOutput {
  rotation: Rotation;
  /** The first tap rendered it ("Tap Share again"). */
  viaTap: boolean;
}

export interface SharePreparerOptions {
  shot: () => ShotRecord;
  deps: ExportDeps;
  lend: LendFullBitmap;
  gate: Pick<MemoryGate, 'acquire'>;
  /** Id of the viewer holder, which a lent render must not suspend. */
  holderId: string;
  debounceMs?: number;
  onChange?(): void;
}

/**
 * Keeps a share payload that matches the current rotation.
 * - nothing to decode (rotation 0 and a pass-through original, or an unrotated rectified blob): the stored blob;
 * - rotated: rendered from the viewer's own full bitmap (lent, gated with `borrowsHolder`, no second decode);
 * - no bitmap to lend (suspended, reduced, tile mode): not prepared automatically; the first tap renders (`tapRender`) and the
 *   second tap shares.
 */
export class SharePreparer {
  status: ShareStatus = 'idle';
  private prepared: PreparedShare | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;
  private disposed = false;
  /** The automatic (lent / stored) path could not produce a blob for the current rotation: a tap must render. */
  needsTap = false;

  constructor(private readonly o: SharePreparerOptions) {}

  /** The payload for `rotation`, or null when it is not ready. Call from the click handler. */
  take(rotation: Rotation): PreparedShare | null {
    return this.prepared && this.prepared.rotation === rotation ? this.prepared : null;
  }

  private set(status: ShareStatus): void {
    this.status = status;
    if (!this.disposed) this.o.onChange?.();
  }

  /** Debounced (300 ms) automatic preparation for `rotation`. `fullReady` = the viewer has a full bitmap that can be lent. */
  request(rotation: Rotation, fullReady: boolean): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.token++;
    if (this.prepared && this.prepared.rotation !== rotation) this.prepared = null;
    if (this.take(rotation)) return;
    const wait = rotation === 0 ? 0 : (this.o.debounceMs ?? 300);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.prepare(rotation, fullReady);
    }, wait);
    this.set('idle');
  }

  private async prepare(rotation: Rotation, fullReady: boolean): Promise<void> {
    const my = this.token;
    const shot = { ...this.o.shot(), rotation };
    this.needsTap = false;
    try {
      if (jpegNeedsNoDecode(shot)) {
        this.set('rendering');
        const out = await exportJpeg(shot, this.o.deps);
        if (my === this.token) {
          this.prepared = { ...out, rotation, viaTap: false };
          this.set('ready');
        }
        return;
      }
      if (!fullReady) {
        this.needsTap = true;
        this.set('idle');
        return;
      }
      this.set('rendering');
      const out = await this.renderLent(rotation);
      if (my !== this.token) return;
      if (!out) {
        this.needsTap = true;
        this.set('idle');
        return;
      }
      this.prepared = { blob: out, mime: 'image/jpeg', ext: 'jpg', rotation, viaTap: false };
      this.set('ready');
    } catch (e) {
      log.warn('share payload could not be prepared', e);
      if (my === this.token) {
        this.needsTap = true;
        this.set('failed');
      }
    }
  }

  /** Rotated JPEG from the viewer's bitmap. The gate is taken BEFORE lending so a queued job cannot deadlock with `suspend()`. */
  private async renderLent(rotation: Rotation): Promise<Blob | null> {
    const ticket = await this.o.gate.acquire({ borrowsHolder: this.o.holderId, priority: 'normal' });
    try {
      return await this.o.lend((handle) => this.o.deps.rotateEncode(handle.bitmap, rotation, 'image/jpeg', JPEG_QUALITY));
    } finally {
      ticket.release();
    }
  }

  /** Fallback two-tap path: render now with a normal gated export. The caller changes its label to "Tap Share again". */
  async tapRender(rotation: Rotation): Promise<boolean> {
    if (this.disposed) return false;
    this.token++;
    const my = this.token;
    this.set('rendering');
    try {
      const out = await exportJpeg({ ...this.o.shot(), rotation }, this.o.deps);
      if (my !== this.token || this.disposed) return false;
      this.prepared = { ...out, rotation, viaTap: true };
      this.set('ready');
      return true;
    } catch (e) {
      log.warn('share render failed', e);
      if (my === this.token) this.set('failed');
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.prepared = null;
  }
}
