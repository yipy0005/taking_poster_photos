import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmapTracker } from '../app/bitmap-handle.ts';
import type { DecodeResult } from '../app/decode.ts';
import { GATE_RESUME_DEBOUNCE_MS } from '../app/config.ts';
import { MemoryGate } from '../app/memory-gate.ts';
import { ViewerBitmaps, VIEWER_HOLDER_ID, type DecodeRequest } from './bitmaps.ts';
import { fakeHandle, fakeResult } from './testing/fakes.ts';

const IMG_W = 4000;
const IMG_H = 3000;

interface Harness {
  gate: MemoryGate;
  bitmaps: ViewerBitmaps;
  calls: DecodeRequest[];
  results: DecodeResult[];
  fail: { full: boolean };
  hold: { full: Promise<void> | null };
}

function harness(opts: { imageW?: number; imageH?: number; reducedFullWidth?: number; tileCapacity?: number } = {}): Harness {
  const imageW = opts.imageW ?? IMG_W;
  const imageH = opts.imageH ?? IMG_H;
  const gate = new MemoryGate();
  const calls: DecodeRequest[] = [];
  const results: DecodeResult[] = [];
  const fail = { full: false };
  const hold: Harness['hold'] = { full: null };
  const decode = async (req: DecodeRequest): Promise<DecodeResult> => {
    calls.push(req);
    if (req.role === 'full' && hold.full) await hold.full;
    if (req.role === 'full' && fail.full) throw new Error('out of memory');
    let res: DecodeResult;
    if (req.role === 'base') {
      const s = Math.min(1, (req.maxLongEdge ?? Infinity) / Math.max(imageW, imageH));
      res = fakeResult(Math.round(imageW * s), Math.round(imageH * s), imageW, imageH, 'base');
    } else if (req.role === 'full') {
      const w = opts.reducedFullWidth ?? imageW;
      res = fakeResult(w, Math.round((imageH * w) / imageW), imageW, imageH, 'full');
    } else {
      const c = req.crop!;
      res = fakeResult(c.sw, c.sh, imageW, imageH, 'tile');
    }
    results.push(res);
    return res;
  };
  const bitmaps = new ViewerBitmaps({ imageW, imageH, decode, gate, maxFullPixels: 25_000_000, tileCapacity: opts.tileCapacity });
  return { gate, bitmaps, calls, results, fail, hold };
}

beforeEach(() => bitmapTracker.reset());
afterEach(() => vi.useRealTimers());

describe('ViewerBitmaps open', () => {
  it('decodes the base bitmap (long edge 2048), then the full bitmap', async () => {
    const h = harness();
    await h.bitmaps.open();
    expect(h.calls.map((c) => c.role)).toEqual(['base', 'full']);
    expect(h.calls[0]).toMatchObject({ maxLongEdge: 2048 });
    expect(h.calls[1]).toMatchObject({ maxPixels: 25_000_000 });
    expect(h.bitmaps.state).toBe('ready');
    expect(h.bitmaps.base!.width).toBe(2048);
    expect(h.bitmaps.full!.width).toBe(4000);
    expect(h.bitmaps.reduced).toBe(false);
  });
  it('uses the base bitmap as the full bitmap for images up to 2048 px (one decode)', async () => {
    const h = harness({ imageW: 1500, imageH: 1000 });
    await h.bitmaps.open();
    expect(h.calls.map((c) => c.role)).toEqual(['base']);
    expect(h.bitmaps.full).toBe(h.bitmaps.base);
    expect(h.bitmaps.fullAliased).toBe(true);
    // suspending does not drop the aliased bitmap
    await h.bitmaps.suspend();
    expect(h.bitmaps.full).toBe(h.bitmaps.base);
    expect(h.bitmaps.base!.handle.closed).toBe(false);
  });
  it('marks a smaller full bitmap as reduced and measures zoom against it', async () => {
    const h = harness({ reducedFullWidth: 2500 });
    await h.bitmaps.open();
    expect(h.bitmaps.reduced).toBe(true);
    expect(h.bitmaps.bitmapScale).toBeCloseTo(2500 / 4000, 6);
  });
  it('rejects and reports failure when the base bitmap cannot be decoded', async () => {
    const gate = new MemoryGate();
    const b = new ViewerBitmaps({ imageW: 100, imageH: 100, decode: () => Promise.reject(new Error('bad image')), gate, maxFullPixels: 1e6 });
    await expect(b.open()).rejects.toThrow('bad image');
    expect(b.state).toBe('failed');
  });
  it('closes everything on dispose, including a decode that finishes late', async () => {
    const h = harness();
    let release!: () => void;
    h.hold.full = new Promise<void>((r) => (release = r));
    const opening = h.bitmaps.open();
    await vi.waitFor(() => expect(h.calls.map((c) => c.role)).toEqual(['base', 'full']));
    h.bitmaps.dispose();
    release();
    await opening;
    expect(bitmapTracker.liveCount()).toBe(0);
    expect(h.results.every((r) => r.handle.closed)).toBe(true);
  });
});

describe('gate holder semantics (AC-37)', () => {
  it('suspend() closes the full bitmap and tiles but keeps the base bitmap', async () => {
    const h = harness();
    await h.bitmaps.open();
    expect(bitmapTracker.liveFullCount()).toBe(1);
    await h.bitmaps.suspend();
    expect(h.bitmaps.state).toBe('paused');
    expect(h.bitmaps.full).toBeNull();
    expect(h.bitmaps.base).not.toBeNull();
    expect(bitmapTracker.liveFullCount()).toBe(0);
  });

  it('a gated job suspends the viewer first: at most one full-resolution bitmap is ever alive', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bitmaps.open();
    expect(bitmapTracker.liveFullCount()).toBe(1);
    expect(h.bitmaps.full).not.toBeNull();

    const ticket = await h.gate.acquire({ priority: 'normal' });
    // the gate awaited suspend() before granting
    expect(h.bitmaps.state).toBe('paused');
    const jobBitmap = fakeHandle(4000, 3000, 'export-decode');
    expect(bitmapTracker.liveFullCount()).toBe(1);
    expect(bitmapTracker.peakFull()).toBeLessThanOrEqual(1);
    jobBitmap.close();
    ticket.release();

    // resume is fire-and-forget after the 500 ms debounce, and re-decodes the full bitmap
    await vi.advanceTimersByTimeAsync(GATE_RESUME_DEBOUNCE_MS + 10);
    await vi.waitFor(() => expect(h.bitmaps.state).toBe('ready'));
    expect(h.bitmaps.full).not.toBeNull();
    expect(h.calls.filter((c) => c.role === 'full')).toHaveLength(2);
  });

  it('a new job cancels a pending resume (the viewer stays paused until the last job is done)', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bitmaps.open();
    const t1 = await h.gate.acquire();
    t1.release();
    await vi.advanceTimersByTimeAsync(100);
    const t2 = await h.gate.acquire();
    await vi.advanceTimersByTimeAsync(GATE_RESUME_DEBOUNCE_MS * 2);
    expect(h.bitmaps.state).toBe('paused');
    t2.release();
    await vi.advanceTimersByTimeAsync(GATE_RESUME_DEBOUNCE_MS + 10);
    await vi.waitFor(() => expect(h.bitmaps.state).toBe('ready'));
  });

  it('a decode that finishes after suspend() is closed, not kept', async () => {
    const h = harness();
    let release!: () => void;
    h.hold.full = new Promise<void>((r) => (release = r));
    const opening = h.bitmaps.open();
    await vi.waitFor(() => expect(h.calls.map((c) => c.role)).toEqual(['base', 'full']));
    await h.bitmaps.suspend();
    release();
    await opening;
    expect(h.bitmaps.full).toBeNull();
    expect(bitmapTracker.liveFullCount()).toBe(0);
    expect(h.bitmaps.state).toBe('paused');
  });

  it('registers as the "viewer" holder and unregisters on dispose', async () => {
    const h = harness();
    await h.bitmaps.open();
    h.bitmaps.dispose();
    // no holder left: acquiring does not touch the disposed viewer
    const t = await h.gate.acquire();
    t.release();
    expect(h.bitmaps.state).not.toBe('paused');
    expect(VIEWER_HOLDER_ID).toBe('viewer');
  });
});

describe('lendFull (rotated share without a second decode)', () => {
  it('hands out the live full bitmap', async () => {
    const h = harness();
    await h.bitmaps.open();
    const seen = await h.bitmaps.lendFull(async (handle) => handle);
    expect(seen).toBe(h.bitmaps.full!.handle);
    expect(h.calls.filter((c) => c.role === 'full')).toHaveLength(1);
  });
  it('returns null while loading, paused or reduced', async () => {
    const h = harness({ reducedFullWidth: 2000 });
    expect(await h.bitmaps.lendFull(async () => 1)).toBeNull();
    await h.bitmaps.open();
    expect(await h.bitmaps.lendFull(async () => 1)).toBeNull(); // reduced
    const h2 = harness();
    await h2.bitmaps.open();
    await h2.bitmaps.suspend();
    expect(await h2.bitmaps.lendFull(async () => 1)).toBeNull(); // paused
  });
  it('suspend() waits for the lent bitmap to be given back', async () => {
    const h = harness();
    await h.bitmaps.open();
    let finish!: () => void;
    const lending = h.bitmaps.lendFull(() => new Promise<void>((r) => (finish = r)));
    let suspended = false;
    const s = h.bitmaps.suspend().then(() => (suspended = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(suspended).toBe(false);
    expect(h.bitmaps.full).not.toBeNull();
    finish();
    await lending;
    await s;
    expect(suspended).toBe(true);
    expect(h.bitmaps.full).toBeNull();
  });
});

describe('tile-mode fallback', () => {
  it('switches to tile mode when the full bitmap cannot be created', async () => {
    const h = harness({ tileCapacity: 2 });
    h.fail.full = true;
    await h.bitmaps.open();
    expect(h.bitmaps.state).toBe('tile');
    expect(h.bitmaps.bitmapScale).toBe(1);
    expect(h.bitmaps.full).toBeNull();
  });
  it('decodes wanted tiles with crop and closes evicted ones through BitmapHandle', async () => {
    const h = harness({ tileCapacity: 2 });
    h.fail.full = true;
    await h.bitmaps.open();
    h.bitmaps.wantTiles([
      { key: '0,0', x: 0, y: 0, w: 512, h: 512 },
      { key: '1,0', x: 512, y: 0, w: 512, h: 512 },
      { key: '2,0', x: 1024, y: 0, w: 512, h: 512 },
    ]);
    await vi.waitFor(() => expect(h.calls.filter((c) => c.role === 'tile')).toHaveLength(3));
    await vi.waitFor(() => expect(h.bitmaps.tiles.size).toBe(2));
    expect(h.calls.find((c) => c.role === 'tile')!.crop).toEqual({ sx: 0, sy: 0, sw: 512, sh: 512 });
    const tiles = h.results.filter((r) => r.handle.width === 512);
    expect(tiles.filter((t) => t.handle.closed)).toHaveLength(1); // the first, evicted
    expect(h.bitmaps.tiles.has('0,0')).toBe(false);
    h.bitmaps.dispose();
    expect(bitmapTracker.liveCount()).toBe(0);
  });
  it('ignores tile requests outside tile mode', async () => {
    const h = harness();
    await h.bitmaps.open();
    h.bitmaps.wantTiles([{ key: '0,0', x: 0, y: 0, w: 512, h: 512 }]);
    expect(h.calls.filter((c) => c.role === 'tile')).toHaveLength(0);
  });
});

describe('thumbnail', () => {
  it('is replaced by the base bitmap and closed', async () => {
    const h = harness();
    const thumb = fakeResult(256, 192, IMG_W, IMG_H, 'thumb');
    h.bitmaps.setThumb(thumb);
    expect(h.bitmaps.bitmapScale).toBeCloseTo(256 / IMG_W, 6);
    await h.bitmaps.open();
    expect(thumb.handle.closed).toBe(true);
    expect(h.bitmaps.thumb).toBeNull();
  });
});
