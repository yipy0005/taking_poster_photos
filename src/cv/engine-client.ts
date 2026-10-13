// Engine selection, worker lifecycle and failure handling (design 2.8 "Selection policy and failure handling").
// Main thread only. The JS engine is the guaranteed baseline; the OpenCV engine (createEngineClient wires its worker and URL)
// is used only when its state is `ready`, and is never loaded by the client itself (see opencv/warm-cache.ts and the UI). engine-client owns EVERY retry:
//   - OpenCV -> JS (same request, same job, progress reset to 0),
//   - memory retries (0.7x per axis, half the decode bound), and
//   - the main-thread guard (strike caps + memory gate + heavy-decode marker) around the whole job (plan.md finding 1);
//     workers only ever call decodeRaw.
import { ensureDecodeCaps } from '../app/decode-caps.ts';
import type { DecodeOpts, ImageInfo } from '../app/decode.ts';
import { orientedSize } from '../app/decode.ts';
import { runGuarded, type GuardCtx, type GuardedOpts } from '../app/decode-guarded.ts';
import { EngineCrashError, EngineUnavailableError, OutOfMemoryError, isAbortError } from '../app/errors.ts';
import { getMaxDecodePixels, getMaxOutputPixels, getRoiBudget } from '../app/canvas-limits.ts';
import { isIosWebKit } from '../app/config.ts';
import { log } from '../app/log.ts';
import type { GatePriority } from '../app/memory-gate.ts';
import type { EnhanceFlags } from './enhance.ts';
import { defaultInsetQuad, quadArea, type Quad, type Raster } from './geometry.ts';
import { scaleOutputSize } from './output-size.ts';
import {
  toRasterPayload,
  type DetectResult,
  type Engine,
  type InitPayload,
  type InitResult,
  type RenderRequest,
  type RenderResult,
} from './protocol.ts';
import { RpcClient, type WorkerLike } from './rpc.ts';
import { getCvUrl } from './opencv/cv-url.ts';
import { createCvWorker, createJsWorker } from './worker-factories.ts';

export type OpenCvState = 'idle' | 'loading' | 'ready' | 'failed';
export type EngineId = 'js' | 'opencv';

export const CV_UNAVAILABLE_NOTICE = 'Advanced detection unavailable, using basic mode';
export const SMALLER_RENDER_NOTICE = 'Not enough memory for full size. Rendering a smaller copy.';
export const NO_MEMORY_MESSAGE = 'Not enough memory to render at full resolution';

/** Worker idle timeout (design 2.7 item 10). */
export const IDLE_TERMINATE_MS = 60_000;
/** OpenCV load timeout (design 2.8). */
export const CV_LOAD_TIMEOUT_MS = 30_000;
/** Terminate the OpenCV worker after a job whose heap exceeded this many bytes. */
export const CV_HEAP_RECYCLE_BYTES = 192 * 1024 * 1024;
/** Retry scale for memory errors (per axis). */
export const MEMORY_RETRY_SCALE = 0.7;
/** Two consecutive OpenCV exceptions move the engine to `failed`. */
export const CV_STRIKE_LIMIT = 2;

export interface EngineNotice {
  id: 'cv-unavailable' | 'smaller-render';
  message: string;
}
export interface EngineStatus {
  opencv: OpenCvState;
  lastRequestedBy: 'user' | 'auto';
  /** Engine that produced the most recent result. */
  lastEngine: EngineId | null;
  cvStrikes: number;
  noticeShown: boolean;
}

export type GuardRunner = <T>(ctx: GuardCtx, opts: GuardedOpts, fn: (capped: DecodeOpts) => Promise<T>) => Promise<T>;

export interface EngineClientDeps {
  createJsWorker(): WorkerLike;
  /** Without it OpenCV stays `idle` and loadOpenCv() reports false. */
  createOpenCvWorker?: () => WorkerLike;
  cvUrl?: () => string;
  /** Platform constants for the init message (decodeCaps is filled in when absent). */
  initPayload(): Promise<InitPayload> | InitPayload;
  run: GuardRunner;
  /** Terminate the OpenCV worker after every job (iOS/iPadOS WebKit). */
  terminateCvAfterEveryJob: boolean;
  idleMs?: number;
  loadTimeoutMs?: number;
}

export interface RenderJob {
  /** null before a shot exists. */
  shotId: string | null;
  original: Blob;
  /** Stored dimensions and EXIF orientation of `original`. */
  info: ImageInfo;
  /** In oriented-original pixels. */
  quad: Quad;
  /** From output-size.ts. */
  outW: number;
  outH: number;
  enhance: EnhanceFlags;
  mime?: 'image/jpeg' | 'image/png';
  quality?: number;
  signal?: AbortSignal;
  onProgress?(p: number): void;
  /** The caller already holds the memory gate. */
  gateHeld?: boolean;
  priority?: GatePriority;
}
export interface RenderOutcome extends RenderResult {
  /** Result is smaller than requested because a memory retry was needed. */
  retriedSmaller: boolean;
  /** The OpenCV engine failed and the JS engine produced this result. */
  fellBackFromOpenCv: boolean;
}
export interface DetectOutcome {
  /** Never null: the 8% inset rectangle is substituted when nothing credible is found (AC-9). */
  quad: Quad;
  found: boolean;
  confidence: number;
  method: string;
  engine: EngineId;
}
export interface DetectOptions {
  signal?: AbortSignal;
  /** Called with OpenCV's result when it arrives later and beats the JS confidence. */
  onUpgrade?(better: DetectOutcome): void;
}

function copyRaster(r: Raster): Raster {
  return { width: r.width, height: r.height, data: r.data.slice() };
}
const isMemoryError = (e: unknown): boolean => e instanceof OutOfMemoryError || e instanceof EngineCrashError;

/** Lazily created worker + RPC + init handshake. */
class EngineSlot {
  private rpc: RpcClient | null = null;
  private starting: Promise<RpcClient> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  heapBytes = 0;
  /** Jobs in flight. A worker is never recycled or idled out from under a running job (detect and render can overlap). */
  private active = 0;
  private recycleWhenFree = false;
  constructor(
    readonly id: EngineId,
    private readonly create: () => WorkerLike,
    private readonly makeInit: () => Promise<InitPayload>,
    private readonly idleMs: number,
    private readonly loadTimeoutMs: number,
  ) {}

  get running(): boolean {
    return !!this.rpc?.alive;
  }

  ensure(): Promise<RpcClient> {
    this.clearIdle();
    if (this.rpc?.alive) return Promise.resolve(this.rpc);
    if (this.starting) return this.starting;
    const p = (async () => {
      const init = await this.makeInit();
      const rpc = new RpcClient(this.create());
      rpc.onCrash = () => {
        if (this.rpc === rpc) this.rpc = null;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          rpc.call<InitResult>('init', init),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new EngineUnavailableError(`${this.id} engine did not start in time`)), this.loadTimeoutMs);
          }),
        ]);
        this.heapBytes = res?.heapBytes ?? 0;
      } catch (e) {
        rpc.terminate();
        throw e;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      this.rpc = rpc;
      return rpc;
    })();
    this.starting = p;
    const clear = (): void => {
      if (this.starting === p) this.starting = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** Runs one job on this worker and recycles it afterwards if a recycle was requested while it was busy. */
  async track<T>(job: () => Promise<T>): Promise<T> {
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      if (this.active === 0 && this.recycleWhenFree) {
        this.recycleWhenFree = false;
        this.terminate();
      }
    }
  }
  /** Terminates the worker now, or as soon as the last running job finishes. */
  recycle(): void {
    if (this.active === 0) this.terminate();
    else this.recycleWhenFree = true;
  }

  /** Marks the worker idle; it is terminated after `idleMs` unless used again. */
  idle(): void {
    this.clearIdle();
    if (!this.rpc || this.active > 0) return;
    this.idleTimer = setTimeout(() => this.terminate(), this.idleMs);
  }
  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  terminate(): void {
    this.clearIdle();
    const rpc = this.rpc;
    this.rpc = null;
    rpc?.terminate();
  }
}

export class EngineClient {
  private readonly js: EngineSlot;
  private readonly cv: EngineSlot | null;
  private cvState: OpenCvState = 'idle';
  private cvLoad: Promise<boolean> | null = null;
  private cvStrikes = 0;
  private lastRequestedBy: 'user' | 'auto' = 'auto';
  private cvEverReady = false;
  private noticeShown = false;
  private lastEngine: EngineId | null = null;
  private readonly noticeListeners = new Set<(n: EngineNotice) => void>();
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly deps: EngineClientDeps) {
    const makeInit = (cv: boolean) => async (): Promise<InitPayload> => {
      const base = await deps.initPayload();
      return cv ? { ...base, cvUrl: deps.cvUrl?.() } : base;
    };
    const idleMs = deps.idleMs ?? IDLE_TERMINATE_MS;
    const timeout = deps.loadTimeoutMs ?? CV_LOAD_TIMEOUT_MS;
    this.js = new EngineSlot('js', deps.createJsWorker, makeInit(false), idleMs, timeout);
    this.cv = deps.createOpenCvWorker ? new EngineSlot('opencv', deps.createOpenCvWorker, makeInit(true), idleMs, timeout) : null;
  }

  // ---- observable state ----
  getStatus(): EngineStatus {
    return {
      opencv: this.cvState,
      lastRequestedBy: this.lastRequestedBy,
      lastEngine: this.lastEngine,
      cvStrikes: this.cvStrikes,
      noticeShown: this.noticeShown,
    };
  }
  onNotice(fn: (n: EngineNotice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }
  private changed(): void {
    for (const fn of this.changeListeners) fn();
  }
  private setCvState(s: OpenCvState): void {
    if (this.cvState === s) return;
    this.cvState = s;
    this.changed();
  }
  private notify(n: EngineNotice): void {
    for (const fn of this.noticeListeners) fn(n);
  }
  /** The one-time "Advanced detection unavailable" notice (AC-18): only after a user request or a previously ready engine. */
  private cvUnavailableNotice(): void {
    if (this.noticeShown) return;
    if (this.lastRequestedBy !== 'user' && !this.cvEverReady) return;
    this.noticeShown = true;
    this.notify({ id: 'cv-unavailable', message: CV_UNAVAILABLE_NOTICE });
    this.changed();
  }

  // ---- OpenCV lifecycle ----
  /** Loads the OpenCV engine (non-iOS auto, or any platform after an explicit user action). Resolves true when ready. */
  loadOpenCv(by: 'user' | 'auto'): Promise<boolean> {
    if (by === 'user') this.lastRequestedBy = 'user';
    if (!this.cv) return Promise.resolve(false);
    if (this.cvState === 'ready') return Promise.resolve(true);
    if (this.cvState === 'failed') return Promise.resolve(false);
    if (this.cvLoad) return this.cvLoad;
    this.setCvState('loading');
    const cv = this.cv;
    const p = (async () => {
      try {
        await cv.ensure();
        this.cvEverReady = true;
        this.setCvState('ready');
        cv.idle();
        return true;
      } catch (e) {
        log.warn('OpenCV engine failed to load', e);
        cv.terminate();
        this.setCvState('failed');
        this.cvUnavailableNotice();
        return false;
      } finally {
        this.cvLoad = null;
      }
    })();
    this.cvLoad = p;
    return p;
  }

  /** Settings "Retry advanced detection" (AC-45): back to `idle`, strikes cleared, nothing is downloaded. */
  resetOpenCv(): void {
    this.cv?.terminate();
    this.cvLoad = null;
    this.cvStrikes = 0;
    this.lastRequestedBy = 'user';
    this.setCvState('idle');
  }

  /** Stops all workers (tests, app teardown). */
  dispose(): void {
    this.js.terminate();
    this.cv?.terminate();
  }

  /** Engine views implementing the shared contract, for callers that want a specific engine. */
  engine(id: EngineId): Engine {
    const slot = id === 'js' ? this.js : this.cv;
    if (!slot) throw new EngineUnavailableError(`${id} engine is not available`);
    return {
      id,
      detect: (img, o) => this.callDetect(slot, img, o?.signal),
      render: (req, o) => this.callRender(slot, req, o?.signal, o?.onProgress),
      dispose: () => slot.terminate(),
    };
  }

  private afterCvJob(cv: EngineSlot): void {
    if (this.deps.terminateCvAfterEveryJob || cv.heapBytes === 0 || cv.heapBytes > CV_HEAP_RECYCLE_BYTES) {
      // The WASM heap only grows; an unknown heap size is treated as above the threshold (design 2.7 item 10).
      // Deferred while another job (for example a background detect during Rectify) is still running on this worker.
      cv.recycle();
    } else cv.idle();
  }

  // ---- low-level calls ----
  private callDetect(slot: EngineSlot, img: Raster, signal?: AbortSignal): Promise<DetectResult> {
    return slot.track(async () => {
      const rpc = await slot.ensure();
      const payload = toRasterPayload(copyRaster(img));
      const res = await rpc.call<DetectResult>('detect', payload, { signal, transfer: [payload.data] });
      if (typeof res.heapBytes === 'number') slot.heapBytes = res.heapBytes;
      return res;
    });
  }
  private callRender(slot: EngineSlot, req: RenderRequest, signal?: AbortSignal, onProgress?: (p: number) => void): Promise<RenderResult> {
    return slot.track(async () => {
      const rpc = await slot.ensure();
      const res = await rpc.call<RenderResult>('render', req, { signal, onProgress });
      if (typeof res.heapBytes === 'number') slot.heapBytes = res.heapBytes;
      return res;
    });
  }

  // ---- detect ----
  /**
   * Detects the poster outline. The JS result is returned immediately; if OpenCV is (or becomes) ready, its detector runs on the
   * same image in the background and `onUpgrade` fires when it is more confident. Background failures are silent (AC-18 c).
   */
  async detect(img: Raster, opts: DetectOptions = {}): Promise<DetectOutcome> {
    const res = await this.callDetect(this.js, img, opts.signal);
    this.js.idle();
    const outcome = this.toOutcome(res, img, 'js');
    void this.backgroundCvDetect(img, outcome, opts);
    return outcome;
  }
  private toOutcome(res: DetectResult, img: Raster, engine: EngineId): DetectOutcome {
    if (res.quad) return { quad: res.quad, found: true, confidence: res.confidence, method: res.method, engine };
    return { quad: defaultInsetQuad(img.width, img.height), found: false, confidence: 0, method: res.method, engine };
  }
  private async backgroundCvDetect(img: Raster, js: DetectOutcome, opts: DetectOptions): Promise<void> {
    const cv = this.cv;
    if (!cv) return;
    try {
      if (this.cvState === 'loading' && this.cvLoad) await this.cvLoad;
      if (this.cvState !== 'ready') return;
      const res = await this.callDetect(cv, img, opts.signal);
      this.afterCvJob(cv);
      this.cvStrikes = 0;
      if (res.quad && res.confidence > js.confidence) opts.onUpgrade?.(this.toOutcome(res, img, 'opencv'));
    } catch (e) {
      if (isAbortError(e)) return;
      this.handleCvFailure(cv, e, /* notice */ false);
    }
  }

  /** Applies the failure table for an OpenCV error. `notice` is false for background detection (silent). */
  private handleCvFailure(cv: EngineSlot, e: unknown, notice: boolean): void {
    log.warn('OpenCV engine error', e);
    const fatal = e instanceof OutOfMemoryError || e instanceof EngineCrashError || e instanceof EngineUnavailableError;
    // Terminate first so a dead 100+ MB heap never lives next to the JS retry. A per-input cv exception leaves the heap usable,
    // so there the worker is only recycled once no other job is running on it.
    if (fatal) {
      cv.terminate();
      this.setCvState('failed');
    } else {
      this.cvStrikes += 1;
      if (this.cvStrikes >= CV_STRIKE_LIMIT) {
        cv.terminate();
        this.setCvState('failed');
      } else {
        cv.recycle();
        this.changed();
      }
    }
    if (notice && this.cvState === 'failed') this.cvUnavailableNotice();
  }

  // ---- render ----
  async render(job: RenderJob): Promise<RenderOutcome> {
    const { width: srcW, height: srcH } = orientedSize(job.info);
    // Decode bound before the job (design 2.7 item 8). The guard layers the strike caps and the tier bound on top.
    const quadFraction = quadArea(job.quad) / (srcW * srcH);
    const needed = Math.ceil(((job.outW * job.outH) / Math.max(quadFraction, 0.05)) * 1.25);
    const requested = Math.min(srcW * srcH, needed);
    return this.deps.run(
      { shotId: job.shotId, kind: 'rectify' },
      { info: job.info, maxPixels: requested, signal: job.signal, gateHeld: job.gateHeld, priority: job.priority },
      async (capped) => {
        let outW = job.outW;
        let outH = job.outH;
        let sourceMaxPixels = capped.maxPixels ?? srcW * srcH;
        let retriedSmaller = false;
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await this.renderOnce(job, outW, outH, sourceMaxPixels);
            return { ...r.result, retriedSmaller, fellBackFromOpenCv: r.fellBack };
          } catch (e) {
            if (isAbortError(e) || !isMemoryError(e)) throw e;
            if (attempt >= 1) throw new OutOfMemoryError(NO_MEMORY_MESSAGE, { cause: e });
            const smaller = scaleOutputSize(outW, outH, MEMORY_RETRY_SCALE);
            outW = smaller.width;
            outH = smaller.height;
            sourceMaxPixels = Math.max(1, Math.floor(sourceMaxPixels / 2));
            retriedSmaller = true;
            this.notify({ id: 'smaller-render', message: SMALLER_RENDER_NOTICE });
            job.onProgress?.(0);
          }
        }
      },
    );
  }

  private async renderOnce(job: RenderJob, outW: number, outH: number, sourceMaxPixels: number): Promise<{ result: RenderResult; fellBack: boolean }> {
    const req: RenderRequest = {
      original: job.original,
      quad: job.quad,
      outW,
      outH,
      enhance: job.enhance,
      mime: job.mime ?? 'image/jpeg',
      quality: job.quality ?? 0.92,
      sourceMaxPixels,
      info: job.info,
    };
    const cv = this.cv;
    let fellBack = false;
    // Use OpenCV only if it is ready at the moment Rectify is pressed; never wait on the download.
    if (cv && this.cvState === 'ready') {
      try {
        const result = await this.callRender(cv, req, job.signal, job.onProgress);
        this.cvStrikes = 0;
        this.lastEngine = 'opencv';
        this.afterCvJob(cv);
        this.changed();
        return { result, fellBack: false };
      } catch (e) {
        if (isAbortError(e)) throw e; // user cancel: no retry, no notice, state unchanged
        this.handleCvFailure(cv, e, true);
        job.onProgress?.(0);
        fellBack = true;
      }
    }
    const result = await this.callRender(this.js, req, job.signal, job.onProgress);
    this.js.idle();
    this.lastEngine = 'js';
    this.changed();
    return { result, fellBack };
  }
}

/** Production wiring: real worker, device constants, and the main-thread guard. */
export function createEngineClient(overrides: Partial<EngineClientDeps> = {}): EngineClient {
  const deps: EngineClientDeps = {
    createJsWorker,
    createOpenCvWorker: createCvWorker,
    cvUrl: getCvUrl,
    initPayload: async () => ({
      isIosWebKit: isIosWebKit(),
      maxOutputPixels: getMaxOutputPixels(),
      maxDecodePixels: getMaxDecodePixels(),
      roiBudget: getRoiBudget(),
      decodeCaps: await ensureDecodeCaps(),
    }),
    run: runGuarded,
    terminateCvAfterEveryJob: isIosWebKit(),
    ...overrides,
  };
  return new EngineClient(deps);
}
