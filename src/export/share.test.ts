import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmapTracker } from '../app/bitmap-handle.ts';
import type { DecodeResult } from '../app/decode.ts';
import { MemoryGate } from '../app/memory-gate.ts';
import { jpegBytes } from '../camera/testing/headers.ts';
import { ViewerBitmaps, VIEWER_HOLDER_ID, type DecodeRequest } from '../viewer/bitmaps.ts';
import { fakeResult } from '../viewer/testing/fakes.ts';
import { blobOf, makeDeps, makeShot } from './testing/fakes.ts';
import { SharePreparer, canShareFiles, shareFile, type ShareNavigator } from './share.ts';

beforeEach(() => bitmapTracker.reset());
afterEach(() => vi.useRealTimers());

describe('canShareFiles', () => {
  it('requires canShare and share, and asks canShare with a probe file', () => {
    let probe: ShareData | undefined;
    const nav: ShareNavigator = {
      canShare: (d) => {
        probe = d;
        return true;
      },
      share: async () => {},
    };
    expect(canShareFiles(nav)).toBe(true);
    expect(probe?.files?.[0]?.type).toBe('image/jpeg');
    expect(canShareFiles({ canShare: () => false, share: async () => {} })).toBe(false);
    expect(canShareFiles({ share: async () => {} })).toBe(false);
    expect(canShareFiles(undefined)).toBe(false);
    expect(canShareFiles({ canShare: () => { throw new Error('x'); }, share: async () => {} })).toBe(false);
  });
});

describe('shareFile outcomes (AC-29)', () => {
  const blob = new Blob([new Uint8Array([1, 2])], { type: 'image/jpeg' });
  it('calls navigator.share synchronously, before any await', () => {
    const share = vi.fn(async () => {});
    void shareFile(blob, 'a.jpg', 'image/jpeg', { share });
    expect(share).toHaveBeenCalledTimes(1);
    const arg = (share.mock.calls as unknown as Array<[ShareData]>)[0]![0];
    expect(arg.files?.[0]?.name).toBe('a.jpg');
  });
  it('returns shared on success', async () => {
    expect(await shareFile(blob, 'a.jpg', 'image/jpeg', { share: async () => {} })).toBe('shared');
  });
  it('AbortError (user cancelled) is silent', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(await shareFile(blob, 'a.jpg', 'image/jpeg', { share: () => Promise.reject(abort) })).toBe('cancelled');
  });
  it('NotAllowedError asks for a download fallback', async () => {
    const err = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    expect(await shareFile(blob, 'a.jpg', 'image/jpeg', { share: () => Promise.reject(err) })).toBe('download-fallback');
  });
  it('anything else is a failure', async () => {
    expect(await shareFile(blob, 'a.jpg', 'image/jpeg', { share: () => Promise.reject(new Error('boom')) })).toBe('failed');
    expect(await shareFile(blob, 'a.jpg', 'image/jpeg', undefined)).toBe('failed');
  });
});

describe('SharePreparer', () => {
  const rect = blobOf(jpegBytes({ w: 30, h: 20 }), 'image/jpeg');

  function setup(over: { gate?: MemoryGate } = {}) {
    const gate = over.gate ?? new MemoryGate();
    const fake = makeDeps({ blobs: { rectified: rect } });
    let shot = makeShot({ rotation: 0 });
    const lent: Array<{ lend: boolean }> = [];
    const lendHolder: { fn: <T>(f: (h: import('../app/bitmap-handle.ts').BitmapHandle) => Promise<T>) => Promise<T | null> } = { fn: async () => null };
    const preparer = new SharePreparer({
      shot: () => shot,
      deps: fake.deps,
      lend: (f) => lendHolder.fn(f),
      gate,
      holderId: VIEWER_HOLDER_ID,
    });
    return { gate, fake, preparer, setShot: (s: typeof shot) => (shot = s), lendHolder, lent };
  }

  it('rotation 0: the stored rectified blob is the payload, nothing is decoded or rendered', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.preparer.request(0, false);
    await vi.advanceTimersByTimeAsync(10);
    const p = s.preparer.take(0)!;
    expect(p.blob).toBe(rect);
    expect(p.viaTap).toBe(false);
    expect(s.fake.decodeCalls).toHaveLength(0);
    expect(s.fake.rotateCalls).toHaveLength(0);
  });

  it('rotation != 0 without a bitmap to lend needs a tap (two-tap fallback), then take() succeeds', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.setShot(makeShot({ rotation: 90 }));
    s.preparer.request(90, false);
    await vi.advanceTimersByTimeAsync(400);
    expect(s.preparer.take(90)).toBeNull();
    expect(s.preparer.needsTap).toBe(true);
    expect(await s.preparer.tapRender(90)).toBe(true);
    const p = s.preparer.take(90)!;
    expect(p.viaTap).toBe(true);
    expect(s.fake.decodeCalls).toHaveLength(1);
    expect(s.fake.rotateCalls[0]).toMatchObject({ rotation: 90 });
  });

  it('re-renders (debounced 300 ms) when the rotation changes and drops a stale payload', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.preparer.request(0, false);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.preparer.take(0)).not.toBeNull();
    s.setShot(makeShot({ rotation: 180 }));
    s.lendHolder.fn = async (f) => f({ bitmap: { width: 3, height: 2 } } as never);
    s.preparer.request(180, true);
    expect(s.preparer.take(0)).toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    expect(s.fake.rotateCalls).toHaveLength(0); // still inside the debounce
    await vi.advanceTimersByTimeAsync(100);
    expect(s.fake.rotateCalls).toHaveLength(1);
    expect(s.preparer.take(180)).not.toBeNull();
    expect(s.preparer.take(0)).toBeNull();
  });
});

describe('rotated share does not decode a second time (AC-37)', () => {
  it('opening the viewer of a rotation-90 shot and preparing Share performs exactly one full decode, rendered from the lent bitmap', async () => {
    vi.useFakeTimers();
    const IMG_W = 3000;
    const IMG_H = 2000;
    const gate = new MemoryGate();
    const decodes: DecodeRequest[] = [];
    const bitmaps = new ViewerBitmaps({
      imageW: IMG_W,
      imageH: IMG_H,
      gate,
      maxFullPixels: 25_000_000,
      decode: async (req): Promise<DecodeResult> => {
        decodes.push(req);
        return req.role === 'base' ? fakeResult(2048, 1365, IMG_W, IMG_H, 'base') : fakeResult(IMG_W, IMG_H, IMG_W, IMG_H, 'full');
      },
    });
    await bitmaps.open();
    expect(decodes.filter((d) => d.role === 'full')).toHaveLength(1);

    const fake = makeDeps({ blobs: { rectified: blobOf(jpegBytes({ w: IMG_W, h: IMG_H }), 'image/jpeg') } });
    const preparer = new SharePreparer({ shot: () => makeShot({ rotation: 90 }), deps: fake.deps, lend: (f) => bitmaps.lendFull(f), gate, holderId: VIEWER_HOLDER_ID });
    preparer.request(90, true);
    await vi.advanceTimersByTimeAsync(400);

    const payload = preparer.take(90)!;
    expect(payload).not.toBeNull();
    expect(payload.mime).toBe('image/jpeg');
    // the rotated blob came from the viewer's own bitmap
    expect(fake.rotateCalls).toHaveLength(1);
    expect(fake.rotateCalls[0]!.bitmap).toBe(bitmaps.full!.handle.bitmap);
    expect(fake.rotateCalls[0]!.rotation).toBe(90);
    // no second full-resolution decode, in the export deps or in the viewer
    expect(fake.decodeCalls).toHaveLength(0);
    expect(decodes.filter((d) => d.role === 'full')).toHaveLength(1);
    // the viewer was not suspended and the gate is free again
    expect(bitmaps.state).toBe('ready');
    expect(bitmaps.full).not.toBeNull();
    expect(gate.busy).toBe(false);
    expect(bitmapTracker.peakFull()).toBeLessThanOrEqual(1);
  });

  it('when another gated job already suspended the viewer, the lend yields nothing and the tap path is used', async () => {
    vi.useFakeTimers();
    const gate = new MemoryGate();
    const bitmaps = new ViewerBitmaps({
      imageW: 3000,
      imageH: 2000,
      gate,
      maxFullPixels: 25_000_000,
      decode: async (req) => (req.role === 'base' ? fakeResult(2048, 1365, 3000, 2000) : fakeResult(3000, 2000)),
    });
    await bitmaps.open();
    const job = await gate.acquire();
    job.release();
    expect(bitmaps.state).toBe('paused');
    const fake = makeDeps({ blobs: { rectified: blobOf(jpegBytes({ w: 30, h: 20 }), 'image/jpeg') } });
    const preparer = new SharePreparer({ shot: () => makeShot({ rotation: 270 }), deps: fake.deps, lend: (f) => bitmaps.lendFull(f), gate, holderId: VIEWER_HOLDER_ID });
    preparer.request(270, true);
    await vi.advanceTimersByTimeAsync(400);
    expect(preparer.take(270)).toBeNull();
    expect(preparer.needsTap).toBe(true);
    expect(fake.rotateCalls).toHaveLength(0);
  });
});
