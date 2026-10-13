import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmapTracker } from './bitmap-handle.ts';
import { resetDecodeCapsForTests, setDecodeCaps, type ImageInfo } from './decode.ts';
import {
  MARKER_KEY,
  STRIKES_KEY,
  applyStrikeCaps,
  checkHeavyMarker,
  configureDecodeGuard,
  decodeGuarded,
  holdTabLock,
  lockName,
  strikeKey,
  type HeavyMarker,
  type LocksLike,
  type MetaStore,
  type StrikeMap,
} from './decode-guarded.ts';
import { DecodeSkippedError } from './errors.ts';
import { MemoryGate } from './memory-gate.ts';
import { createFakeDecoder, FakeOffscreenCanvas } from './testing/fake-decoder.ts';

const TIER_DECODE = 25_000_000; // iOS column
const SHOT = '11111111-1111-4111-8111-111111111111';

class FakeMeta implements MetaStore {
  data = new Map<string, unknown>();
  writes: Array<[string, unknown]> = [];
  failSet = false;
  async getMeta<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async setMeta<T>(key: string, value: T) {
    if (this.failSet && key === MARKER_KEY) throw new Error('quota');
    this.writes.push([key, value]);
    this.data.set(key, value);
  }
  async deleteMeta(key: string) {
    this.data.delete(key);
  }
}

const info = (w: number, h: number, orientation = 1): ImageInfo => ({ width: w, height: h, orientation });
const area = (b: { width: number; height: number }) => b.width * b.height;

let meta: FakeMeta;
let dec: ReturnType<typeof createFakeDecoder>;

beforeEach(() => {
  bitmapTracker.reset();
  resetDecodeCapsForTests();
  setDecodeCaps({ fromImage: true, exifHonored: true, resizeHonored: true, resizeAfterOrient: true });
  meta = new FakeMeta();
  dec = createFakeDecoder();
  vi.stubGlobal('createImageBitmap', dec.createImageBitmap);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  configureDecodeGuard({ meta, persistMarker: true, tabId: 'tab-A', gate: new MemoryGate(), maxDecodePixels: TIER_DECODE });
});
afterEach(() => vi.unstubAllGlobals());

/** Starts a decode that never finishes (the process "dies"), waits until its marker is written. */
async function crashDuringDecode(opts: Parameters<typeof decodeGuarded>[1], ctx: Parameters<typeof decodeGuarded>[2]) {
  const hang = createFakeDecoder();
  vi.stubGlobal('createImageBitmap', () => new Promise(() => {}));
  const blob = hang.blob({ w: 8000, h: 6000, orientation: 1 });
  void decodeGuarded(blob, opts, ctx).catch(() => {});
  await vi.waitFor(() => expect(meta.data.has(MARKER_KEY)).toBe(true));
  // "tab killed": a fresh session reads the marker; the old gate/guard state is gone
  configureDecodeGuard({ gate: new MemoryGate(), tabId: 'tab-B' });
  vi.stubGlobal('createImageBitmap', dec.createImageBitmap);
  const check = await checkHeavyMarker(meta, undefined);
  expect(check.status).toBe('struck');
}

describe('strike caps (pure)', () => {
  it('render group: none, 12 MP, 6 MP, 6 MP', () => {
    const caps = [0, 1, 2, 5].map((n) => applyStrikeCaps('rectify', n, {}, 64e6).opts.maxPixels);
    expect(caps).toEqual([64e6, 12e6, 6e6, 6e6]);
  });
  it('preview group: 2048, 1024, 512, 512', () => {
    const caps = [0, 1, 2, 3].map((n) => applyStrikeCaps('preview', n, { maxLongEdge: 4096 }, 64e6).opts.maxLongEdge);
    expect(caps).toEqual([2048, 1024, 512, 512]);
  });
  it('strike keys: shot id, and -:ingest when no shot exists', () => {
    expect(strikeKey(SHOT, 'view')).toBe(`${SHOT}:render`);
    expect(strikeKey(SHOT, 'rectify')).toBe(`${SHOT}:render`);
    expect(strikeKey(SHOT, 'preview')).toBe(`${SHOT}:preview`);
    expect(strikeKey(SHOT, 'thumb')).toBe(`${SHOT}:thumb`);
    expect(strikeKey(null, 'normalize')).toBe('-:ingest');
  });
});

describe('AC-38 crash-loop protection', () => {
  it('(a) rectify: requests shrink 25 MP -> 12 MP -> 6 MP across simulated crashes', async () => {
    const blob = dec.blob({ w: 8000, h: 6000, orientation: 1 });
    const ctx = { shotId: SHOT, kind: 'rectify' } as const;
    const o = { info: info(8000, 6000), maxPixels: 64e6 };

    let r = await decodeGuarded(blob, o, ctx);
    expect(area(r)).toBeLessThanOrEqual(25e6);
    expect(area(r)).toBeGreaterThan(12e6);
    r.handle.close();

    await crashDuringDecode(o, ctx);
    expect((meta.data.get(STRIKES_KEY) as StrikeMap)[`${SHOT}:render`]).toBe(1);
    r = await decodeGuarded(blob, o, ctx);
    expect(area(r)).toBeLessThanOrEqual(12e6);
    expect(area(r)).toBeGreaterThan(6e6);
    r.handle.close();

    await crashDuringDecode(o, ctx);
    r = await decodeGuarded(blob, o, ctx);
    expect(area(r)).toBeLessThanOrEqual(6e6);
    r.handle.close();
  });

  it('(b) viewer on an uncorrected 48 MP original: MAX_DECODE_PIXELS, then <= 12 MP, then <= 6 MP, flagged reduced', async () => {
    const blob = dec.blob({ w: 8000, h: 6000, orientation: 1 });
    const ctx = { shotId: SHOT, kind: 'view' } as const;
    const o = { info: info(8000, 6000), maxPixels: TIER_DECODE };
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (i > 0) await crashDuringDecode(o, ctx);
      const r = await decodeGuarded(blob, o, ctx);
      expect(r.reduced).toBe(true);
      sizes.push(area(r));
      r.handle.close();
    }
    expect(sizes[0]).toBeLessThanOrEqual(25e6);
    expect(sizes[1]).toBeLessThanOrEqual(12e6);
    expect(sizes[2]).toBeLessThanOrEqual(6e6);
  });

  it('the guard enforces the tier bound even if the caller forgot to pass it', async () => {
    const r = await decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000) }, { shotId: SHOT, kind: 'view' });
    expect(area(r)).toBeLessThanOrEqual(TIER_DECODE);
    r.handle.close();
  });

  it('(c) Adjust preview of a 48 MP header: maxLongEdge 2048, then 1024, then 512', async () => {
    const blob = dec.blob({ w: 8000, h: 6000, orientation: 1 });
    const ctx = { shotId: SHOT, kind: 'preview' } as const;
    const o = { info: info(8000, 6000) };
    const edges: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (i > 0) await crashDuringDecode(o, ctx);
      const r = await decodeGuarded(blob, o, ctx);
      edges.push(Math.max(r.width, r.height));
      r.handle.close();
    }
    expect(edges).toEqual([2048, 1024, 512]);
  });

  it('(d) a 12 MP header never sets the marker', async () => {
    const r = await decodeGuarded(dec.blob({ w: 4000, h: 3000, orientation: 1 }), { info: info(4000, 3000) }, { shotId: SHOT, kind: 'view' });
    r.handle.close();
    expect(meta.writes.filter(([k]) => k === MARKER_KEY)).toEqual([]);
  });

  it('(d2) above 12 MP the marker is set before the decode and cleared after', async () => {
    const seen: Array<unknown> = [];
    vi.stubGlobal('createImageBitmap', (...a: unknown[]) => {
      seen.push(meta.data.get(MARKER_KEY));
      return (dec.createImageBitmap as (...x: unknown[]) => Promise<ImageBitmap>)(...a);
    });
    const r = await decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000) }, { shotId: SHOT, kind: 'preview' });
    r.handle.close();
    const m = seen[0] as HeavyMarker;
    expect(m).toMatchObject({ tabId: 'tab-A', shotId: SHOT, kind: 'preview' });
    expect(typeof m.startedAt).toBe('number');
    expect(meta.data.has(MARKER_KEY)).toBe(false);
  });

  it('clears the marker on failure and on cancel', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('decode failed');
    });
    await expect(
      decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000) }, { shotId: SHOT, kind: 'rectify' }),
    ).rejects.toThrow('decode failed');
    expect(meta.data.has(MARKER_KEY)).toBe(false);
  });

  it('unknown dimensions count as heavy (marker is written)', async () => {
    const r = await decodeGuarded(dec.blob({ w: 1000, h: 800, orientation: 1 }), {}, { shotId: SHOT, kind: 'preview' });
    r.handle.close();
    expect(meta.writes.some(([k]) => k === MARKER_KEY)).toBe(true);
  });

  it('a marker write failure is logged and the decode still runs', async () => {
    meta.failSet = true;
    const r = await decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000) }, { shotId: SHOT, kind: 'view' });
    expect(r.width).toBeGreaterThan(0);
    r.handle.close();
  });

  it('session-only mode does not persist a marker', async () => {
    configureDecodeGuard({ persistMarker: false });
    const r = await decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000) }, { shotId: SHOT, kind: 'view' });
    r.handle.close();
    expect(meta.writes).toEqual([]);
  });

  it('(e) a completion not shrunk by a strike cap resets the counter; a capped one keeps it', async () => {
    meta.data.set(STRIKES_KEY, { [`${SHOT}:render`]: 1 } satisfies StrikeMap);
    // capped: 8000x6000 gets reduced by the 12 MP strike cap -> counter stays
    let r = await decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000) }, { shotId: SHOT, kind: 'view' });
    r.handle.close();
    expect((meta.data.get(STRIKES_KEY) as StrikeMap)[`${SHOT}:render`]).toBe(1);
    // a source already under the cap -> counter resets
    r = await decodeGuarded(dec.blob({ w: 2000, h: 1500, orientation: 1 }), { info: info(2000, 1500) }, { shotId: SHOT, kind: 'view' });
    r.handle.close();
    expect((meta.data.get(STRIKES_KEY) as StrikeMap)[`${SHOT}:render`]).toBeUndefined();
  });

  it('thumbnails are skipped after one strike', async () => {
    meta.data.set(STRIKES_KEY, { [`${SHOT}:thumb`]: 1 } satisfies StrikeMap);
    await expect(
      decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000), maxLongEdge: 256 }, { shotId: SHOT, kind: 'thumb' }),
    ).rejects.toBeInstanceOf(DecodeSkippedError);
    expect(dec.calls.length).toBe(0);
  });

  it('ingest normalise with shotId null uses the -:ingest strike group', async () => {
    const ctx = { shotId: null, kind: 'normalize' } as const;
    const o = { info: info(8000, 6000), maxLongEdge: 8192 };
    await crashDuringDecode(o, ctx);
    expect((meta.data.get(STRIKES_KEY) as StrikeMap)['-:ingest']).toBe(1);
    const r = await decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), o, ctx);
    expect(area(r)).toBeLessThanOrEqual(12e6);
    r.handle.close();
  });
});

describe('memory gate integration', () => {
  it('every full-bitmap decode takes the gate, even at <= 12 MP; gateHeld skips it', async () => {
    const gate = new MemoryGate();
    const acquire = vi.spyOn(gate, 'acquire');
    configureDecodeGuard({ gate });
    const blob = dec.blob({ w: 4000, h: 3000, orientation: 1 });
    (await decodeGuarded(blob, { info: info(4000, 3000) }, { shotId: SHOT, kind: 'view' })).handle.close();
    expect(acquire).toHaveBeenCalledTimes(1);
    (await decodeGuarded(blob, { info: info(4000, 3000), gateHeld: true }, { shotId: SHOT, kind: 'rectify' })).handle.close();
    expect(acquire).toHaveBeenLastCalledWith(expect.objectContaining({ gateHeld: true }));
    // small preview/thumb of a <= 12 MP source stay out of the gate
    (await decodeGuarded(blob, { info: info(4000, 3000), maxLongEdge: 256 }, { shotId: SHOT, kind: 'thumb' })).handle.close();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(gate.busy).toBe(false);
  });

  it('thumbnails of heavy sources are queued with low priority', async () => {
    const gate = new MemoryGate();
    const acquire = vi.spyOn(gate, 'acquire');
    configureDecodeGuard({ gate });
    (await decodeGuarded(dec.blob({ w: 8000, h: 6000, orientation: 1 }), { info: info(8000, 6000), maxLongEdge: 256 }, { shotId: SHOT, kind: 'thumb' })).handle.close();
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ priority: 'low' }));
  });
});

describe('plan finding 11: tab lock and live-tab markers', () => {
  const marker: HeavyMarker = { tabId: 'tab-OTHER', shotId: SHOT, kind: 'rectify', startedAt: 1 };

  function fakeLocks(held: string[]): LocksLike & { requested: string[] } {
    return {
      requested: [],
      request(name) {
        this.requested.push(name);
        return new Promise(() => {});
      },
      async query() {
        return { held: held.map((name) => ({ name })) };
      },
    };
  }

  it('a marker whose tab still holds its lock is a live tab: no strike, marker kept', async () => {
    meta.data.set(MARKER_KEY, marker);
    const res = await checkHeavyMarker(meta, fakeLocks([lockName('tab-OTHER')]));
    expect(res.status).toBe('live-tab');
    expect(meta.data.get(MARKER_KEY)).toEqual(marker);
    expect(meta.data.get(STRIKES_KEY)).toBeUndefined();
  });

  it('a marker whose lock is gone is stale: strike counted, marker cleared', async () => {
    meta.data.set(MARKER_KEY, marker);
    const res = await checkHeavyMarker(meta, fakeLocks([lockName('someone-else')]));
    expect(res).toMatchObject({ status: 'struck', key: `${SHOT}:render` });
    expect((meta.data.get(STRIKES_KEY) as StrikeMap)[`${SHOT}:render`]).toBe(1);
    expect(meta.data.has(MARKER_KEY)).toBe(false);
  });

  it('without navigator.locks the marker is treated as stale', async () => {
    meta.data.set(MARKER_KEY, marker);
    expect((await checkHeavyMarker(meta, undefined)).status).toBe('struck');
  });

  it('no marker -> none', async () => {
    expect((await checkHeavyMarker(meta, undefined)).status).toBe('none');
  });

  it('strikes accumulate across startups', async () => {
    for (let i = 0; i < 2; i++) {
      meta.data.set(MARKER_KEY, marker);
      await checkHeavyMarker(meta, undefined);
    }
    expect((meta.data.get(STRIKES_KEY) as StrikeMap)[`${SHOT}:render`]).toBe(2);
  });

  it('holdTabLock requests heavy-decode-<tabId> and never releases it', () => {
    const locks = fakeLocks([]);
    holdTabLock('tab-A', locks);
    expect(locks.requested).toEqual(['heavy-decode-tab-A']);
    holdTabLock('tab-A', undefined); // no locks API: no throw
  });
});
