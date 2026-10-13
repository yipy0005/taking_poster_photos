// Viewer bitmap lifecycle (design 2.7 items 5 to 7, 2.12; plan.md findings 8, 14). DOM-free so the gate/holder behaviour can be
// unit-tested (AC-37). Owns a base bitmap (long edge <= 2048), a full bitmap, an optional thumbnail and the tile cache of the
// tile-mode fallback. Every bitmap is a BitmapHandle and is closed by exactly one owner: this class.
import type { BitmapHandle } from '../app/bitmap-handle.ts';
import { PREVIEW_LONG_EDGE } from '../app/config.ts';
import type { DecodeResult } from '../app/decode.ts';
import { log } from '../app/log.ts';
import type { MemoryGate } from '../app/memory-gate.ts';
import { TileCache, type TileRef } from './tile-cache.ts';

export type BitmapRole = 'base' | 'full' | 'tile';

export interface DecodeRequest {
  role: BitmapRole;
  maxPixels?: number;
  maxLongEdge?: number;
  /** Oriented-image pixel rectangle (tile mode). */
  crop?: { sx: number; sy: number; sw: number; sh: number };
}
export type ViewerDecode = (req: DecodeRequest) => Promise<DecodeResult>;

/** loading = full bitmap being decoded; paused = closed for a gated job or while hidden; tile = tile-mode fallback. */
export type FullState = 'idle' | 'loading' | 'ready' | 'paused' | 'tile' | 'failed';

export const VIEWER_HOLDER_ID = 'viewer';

export interface BitmapsOptions {
  imageW: number;
  imageH: number;
  decode: ViewerDecode;
  gate: Pick<MemoryGate, 'registerHolder'>;
  /** Upper bound for the full bitmap (MAX_DECODE_PIXELS; the guard applies strike caps on top). */
  maxFullPixels: number;
  baseLongEdge?: number;
  holderId?: string;
  tileCapacity?: number;
  onChange?(): void;
}

export class ViewerBitmaps {
  base: DecodeResult | null = null;
  full: DecodeResult | null = null;
  thumb: DecodeResult | null = null;
  readonly tiles: TileCache;
  state: FullState = 'idle';

  private readonly imageW: number;
  private readonly imageH: number;
  private readonly decode: ViewerDecode;
  private readonly maxFullPixels: number;
  private readonly baseLongEdge: number;
  private readonly onChange: () => void;
  private readonly unregister: () => void;
  private fullAliasesBase = false;
  private epoch = 0;
  private disposed = false;
  private loading = false;
  private lending = 0;
  private lendWaiters: Array<() => void> = [];
  private wanted: TileRef[] = [];
  private tileBusy = false;

  constructor(opts: BitmapsOptions) {
    this.imageW = opts.imageW;
    this.imageH = opts.imageH;
    this.decode = opts.decode;
    this.maxFullPixels = opts.maxFullPixels;
    this.baseLongEdge = opts.baseLongEdge ?? PREVIEW_LONG_EDGE;
    this.onChange = opts.onChange ?? (() => {});
    this.tiles = new TileCache(opts.tileCapacity);
    this.unregister = opts.gate.registerHolder({
      id: opts.holderId ?? VIEWER_HOLDER_ID,
      suspend: () => this.suspend(),
      resume: () => this.resume(),
    });
  }

  // ---- derived ----
  /** The bitmap used as the full-detail source (null while loading or paused). */
  get detail(): DecodeResult | null {
    return this.full;
  }

  /** Bitmap width / image width of the best bitmap currently available: what the zoom limit (AC-22) is measured against. */
  get bitmapScale(): number {
    if (this.state === 'tile') return 1;
    const b = this.full ?? this.base ?? this.thumb;
    return b ? b.width / this.imageW : 1;
  }

  /** The full-detail bitmap is smaller than the image (strike cap, tier bound): show the reduced-resolution notice. */
  get reduced(): boolean {
    return this.full !== null && this.full.width < this.imageW;
  }

  get fullAliased(): boolean {
    return this.fullAliasesBase;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  setThumb(res: DecodeResult): void {
    if (this.disposed || this.base) {
      res.handle.close();
      return;
    }
    this.thumb?.handle.close();
    this.thumb = res;
    this.onChange();
  }

  // ---- open / load ----
  /** Decodes the base bitmap, then the full one (unless the base already shows every pixel). Rejects if the base cannot be decoded. */
  async open(): Promise<void> {
    if (this.disposed) return;
    this.state = 'loading';
    this.onChange();
    let base: DecodeResult;
    try {
      base = await this.decode({ role: 'base', maxLongEdge: this.baseLongEdge });
    } catch (e) {
      if (!this.disposed) {
        this.state = 'failed';
        this.onChange();
      }
      throw e;
    }
    if (this.disposed) {
      base.handle.close();
      return;
    }
    this.base = base;
    this.thumb?.handle.close();
    this.thumb = null;
    if (base.width >= this.imageW) {
      // the base bitmap already has every pixel: it is also the full bitmap (small images, <= 2048 long edge)
      this.full = base;
      this.fullAliasesBase = true;
      this.state = 'ready';
      this.onChange();
      return;
    }
    this.onChange();
    await this.loadFull();
  }

  private async loadFull(): Promise<void> {
    if (this.disposed || this.loading || this.fullAliasesBase || this.full) return;
    this.loading = true;
    this.state = 'loading';
    const my = this.epoch;
    this.onChange();
    try {
      const res = await this.decode({ role: 'full', maxPixels: this.maxFullPixels });
      if (my !== this.epoch || this.disposed) {
        res.handle.close();
        return;
      }
      this.full = res;
      this.state = 'ready';
    } catch (e) {
      if (my !== this.epoch || this.disposed) return;
      log.warn('full bitmap could not be created; switching to tile mode', e);
      this.state = 'tile';
      void this.pumpTiles();
    } finally {
      this.loading = false;
      if (!this.disposed) this.onChange();
    }
  }

  // ---- holder: suspend / resume (finding 8) ----
  /** Closes the full bitmap and the tile cache; keeps the base bitmap and thumbnail. Waits for a bitmap lent out for sharing. */
  async suspend(): Promise<void> {
    if (this.disposed) return;
    this.epoch++;
    this.wanted = [];
    if (this.lending > 0) await new Promise<void>((resolve) => this.lendWaiters.push(resolve));
    if (this.disposed) return;
    this.tiles.clear();
    if (!this.fullAliasesBase) {
      this.full?.handle.close();
      this.full = null;
      if (this.state !== 'failed') this.state = 'paused';
    }
    this.loading = false;
    this.onChange();
  }

  /** Re-decodes the full bitmap. Called fire-and-forget after the gate released; the decode re-acquires the gate itself. */
  async resume(): Promise<void> {
    if (this.disposed || this.state !== 'paused') return;
    await this.loadFull();
  }

  // ---- lending (rotated share, AC-37) ----
  /** Runs `fn` with the live full bitmap. Returns null when there is none to lend (suspended, reduced, tile mode, still loading). */
  async lendFull<T>(fn: (handle: BitmapHandle) => Promise<T>): Promise<T | null> {
    const full = this.full;
    if (!full || this.state !== 'ready' || this.reduced) return null;
    this.lending++;
    try {
      return await fn(full.handle);
    } finally {
      this.lending--;
      if (this.lending === 0) {
        const waiters = this.lendWaiters;
        this.lendWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  // ---- tile mode ----
  /** Tiles the current view needs; decoded one at a time. No effect outside tile mode. */
  wantTiles(refs: TileRef[]): void {
    if (this.state !== 'tile') return;
    this.wanted = refs.filter((r) => !this.tiles.has(r.key));
    void this.pumpTiles();
  }

  private async pumpTiles(): Promise<void> {
    if (this.tileBusy || this.disposed) return;
    this.tileBusy = true;
    try {
      for (;;) {
        if (this.state !== 'tile' || this.disposed) break;
        const next = this.wanted.shift();
        if (!next) break;
        if (this.tiles.has(next.key)) continue;
        const my = this.epoch;
        try {
          const res = await this.decode({ role: 'tile', crop: { sx: next.x, sy: next.y, sw: next.w, sh: next.h } });
          if (my !== this.epoch || this.disposed || this.state !== 'tile') {
            res.handle.close();
            break;
          }
          this.tiles.set(next.key, res.handle);
          this.onChange();
        } catch (e) {
          log.warn('tile decode failed', e);
          break;
        }
      }
    } finally {
      this.tileBusy = false;
    }
  }

  // ---- end of life ----
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.unregister();
    this.wanted = [];
    this.tiles.clear();
    this.full?.handle.close();
    this.base?.handle.close();
    this.thumb?.handle.close();
    this.full = null;
    this.base = null;
    this.thumb = null;
    for (const w of this.lendWaiters) w();
    this.lendWaiters = [];
  }
}
