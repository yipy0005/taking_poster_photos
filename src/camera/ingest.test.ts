import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BitmapHandle, bitmapTracker } from '../app/bitmap-handle.ts';
import { resetDecodeCapsForTests, setDecodeCaps, type DecodeCaps, type DecodeResult } from '../app/decode.ts';
import { MARKER_KEY, configureDecodeGuard, decodeGuarded, type GuardCtx, type GuardedOpts } from '../app/decode-guarded.ts';
import { DecodeError, DecodeSkippedError, IngestError } from '../app/errors.ts';
import { MemoryGate } from '../app/memory-gate.ts';
import { appHooks } from '../app/state.ts';
import { MemoryBackend } from '../storage/memory-store.ts';
import type { NewShot, RectificationResult } from '../storage/schema.ts';
import { SnapshotStore, type Store } from '../storage/store.ts';
import {
  ensureDims,
  ingestImage,
  isSupportedImage,
  makeThumb,
  registerThumbSweep,
  setThumbFromBitmap,
  sweepThumbnails,
  thumbFromBlob,
  type IngestDeps,
  type IngestInput,
} from './ingest.ts';
import { shotImageInfo } from './exif.ts';
import { blobOf, isoBytes, jpegBytes, pngBytes, webpBytes } from './testing/headers.ts';

const CAPS_OK: DecodeCaps = { fromImage: true, exifHonored: true, resizeHonored: true, resizeAfterOrient: true };
const THUMB = () => new Blob(['THUMB'], { type: 'image/jpeg' });

type Decoder = (blob: Blob, opts: GuardedOpts, ctx: GuardCtx) => Promise<DecodeResult>;

function result(width: number, height: number, reduced = false): DecodeResult {
  const bmp = { width, height, close() {} } as unknown as ImageBitmap;
  return { handle: new BitmapHandle(bmp, 'test'), width, height, sourceWidth: width, sourceHeight: height, scale: 1, reduced };
}

/** Wraps a store so the order of persist-type calls can be compared with decode calls. */
function recording(store: Store, events: string[]): Store {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'createPosterWithShot' || prop === 'addShot' || prop === 'setThumb') events.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

interface Rig {
  backend: MemoryBackend;
  store: Store;
  events: string[];
  deps: IngestDeps;
  decode: Mock<Decoder>;
  releaseIdle(): void;
}

function rig(over: { decode?: Decoder; caps?: DecodeCaps; deps?: Partial<IngestDeps>; idle?: 'manual' | 'now' } = {}): Rig {
  const backend = new MemoryBackend();
  const events: string[] = [];
  const store = recording(new SnapshotStore(backend), events);
  const decode = vi.fn<Decoder>(
    over.decode ??
      (async () => result(256, 192)),
  );
  const waiting: Array<() => void> = [];
  const manual = over.idle === 'manual';
  const deps: IngestDeps = {
    store,
    decode: (b, o, c) => {
      events.push(`decode:${c.kind}`);
      return decode(b, o, c);
    },
    getCaps: async () => over.caps ?? CAPS_OK,
    limits: () => ({ maxSourcePixels: 50_000_000, hardSourcePixels: 256_000_000, maxSourceBytes: 120 * 1024 * 1024, maxOutputPixels: 16_777_216 }),
    encodeJpeg: async () => new Blob(['UPRIGHT'], { type: 'image/jpeg' }),
    encodeThumb: async () => THUMB(),
    idle: () => (manual ? new Promise<void>((r) => waiting.push(r)) : Promise.resolve()),
    ...over.deps,
  };
  return { backend, store, events, deps, decode, releaseIdle: () => waiting.splice(0).forEach((r) => r()) };
}

const jpegInput = (over: Partial<IngestInput> & { w?: number; h?: number; orientation?: number } = {}): IngestInput => ({
  blob: blobOf(jpegBytes({ w: over.w ?? 4000, h: over.h ?? 3000, orientation: over.orientation }), 'image/jpeg'),
  source: 'file-gallery',
  kind: 'overview',
  ...over,
});

async function shotOf(r: Rig, id: string) {
  const s = await r.store.getShot(id);
  if (!s) throw new Error('shot missing');
  return s;
}

beforeEach(() => {
  bitmapTracker.reset();
  appHooks.thumbSweep = null;
});

describe('type and header validation (AC-4)', () => {
  it('accepts image/* and untyped files with an image extension only', () => {
    expect(isSupportedImage(new Blob([], { type: 'image/heic' }))).toBe(true);
    expect(isSupportedImage(Object.assign(new Blob([]), { name: 'IMG_1.HEIC' }))).toBe(true);
    expect(isSupportedImage(Object.assign(new Blob([]), { name: 'notes.txt' }))).toBe(false);
    expect(isSupportedImage(new Blob([], { type: 'application/pdf' }))).toBe(false);
  });

  it('rejects a non-image type and saves nothing', async () => {
    const r = rig();
    await expect(ingestImage({ blob: new Blob(['x'], { type: 'text/plain' }), source: 'file-gallery', kind: 'overview' }, r.deps)).rejects.toMatchObject({
      kind: 'unsupported',
      message: "Can't read this image",
    });
    expect(await r.store.listPosters()).toEqual([]);
  });

  it('rejects bytes that are not an image even when typed image/jpeg', async () => {
    const r = rig();
    const bad = new Blob([new TextEncoder().encode('definitely not an image at all')], { type: 'image/jpeg' });
    await expect(ingestImage({ blob: bad, source: 'file-gallery', kind: 'overview' }, r.deps)).rejects.toBeInstanceOf(IngestError);
    expect(await r.store.listPosters()).toEqual([]);
    expect(r.decode).not.toHaveBeenCalled();
  });

  it('accepts JPEG and PNG from the gallery', async () => {
    const r = rig();
    const a = await ingestImage(jpegInput(), r.deps);
    const b = await ingestImage({ blob: blobOf(pngBytes(1200, 800), 'image/png'), source: 'file-gallery', kind: 'overview' }, r.deps);
    expect((await shotOf(r, a!.shotId)).originalMime).toBe('image/jpeg');
    expect(await shotOf(r, b!.shotId)).toMatchObject({ width: 1200, height: 800, originalMime: 'image/png' });
  });

  it('refuses only files above MAX_SOURCE_BYTES, with a message (AC-43)', async () => {
    const r = rig({ deps: { limits: () => ({ maxSourcePixels: 50e6, hardSourcePixels: 256e6, maxSourceBytes: 5 * 1024 * 1024, maxOutputPixels: 16_777_216 }) } });
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(jpegBytes({ w: 100, h: 100 }));
    await expect(ingestImage({ blob: new Blob([big], { type: 'image/jpeg' }), source: 'file-gallery', kind: 'overview' }, r.deps)).rejects.toMatchObject({
      kind: 'too-large',
      message: 'File too large (6 MB, 5 MB max)',
    });
    expect(await r.store.listPosters()).toEqual([]);
  });
});

describe('persist first (AC-42, NFR-7)', () => {
  it('stores a 48 MP header BEFORE the first decode, with no thumbnail yet', async () => {
    const r = rig({ idle: 'manual' });
    const res = await ingestImage(jpegInput({ w: 8000, h: 6000 }), r.deps);
    expect(res).not.toBeNull();
    expect(r.events).toEqual(['createPosterWithShot']);
    expect(r.decode).not.toHaveBeenCalled();
    const shot = await shotOf(r, res!.shotId);
    expect(shot.thumb).toBeUndefined();
    expect(shot).toMatchObject({ status: 'captured', width: 8000, height: 6000, aspectMode: 'auto' });
    expect(await r.store.getBlob(shot.id, 'original')).not.toBeNull();

    r.releaseIdle();
    await res!.background;
    expect(r.events).toEqual(['createPosterWithShot', 'decode:thumb', 'setThumb']);
    expect((await shotOf(r, res!.shotId)).thumb).toBeDefined();
  });

  it('leaves the shot and original intact when the thumbnail decode rejects, and raises nothing', async () => {
    const r = rig({
      decode: async () => {
        throw new DecodeError('boom');
      },
    });
    const res = await ingestImage(jpegInput({ w: 8000, h: 6000 }), r.deps);
    await expect(res!.background).resolves.toBeUndefined();
    const shot = await shotOf(r, res!.shotId);
    expect(shot.thumb).toBeUndefined();
    expect(await r.store.getBlob(shot.id, 'original')).not.toBeNull();
    expect(await r.store.listShotsMissingThumb()).toEqual([shot.id]);
  });

  it('a strike skip (DecodeSkippedError) is not an error either', async () => {
    const r = rig({
      decode: async () => {
        throw new DecodeSkippedError('skipped');
      },
    });
    const res = await ingestImage(jpegInput(), r.deps);
    await expect(res!.background).resolves.toBeUndefined();
    expect((await shotOf(r, res!.shotId)).thumb).toBeUndefined();
  });

  it('survives a process stop between persist and thumbnail: the next start sweeps it and the store emits a change', async () => {
    const first = rig({ idle: 'manual' });
    const res = await ingestImage(jpegInput(), first.deps);
    // "kill" the process: the thumbnail step never runs
    expect((await shotOf(first, res!.shotId)).thumb).toBeUndefined();

    const reopened = new SnapshotStore(first.backend);
    const second = rig({ deps: { store: reopened } });
    const changes = vi.fn();
    reopened.onChange(changes);
    expect(await reopened.listShotsMissingThumb()).toEqual([res!.shotId]);
    expect(await sweepThumbnails(second.deps)).toBe(1);
    expect(changes).toHaveBeenCalled();
    expect((await reopened.getShot(res!.shotId))?.thumb).toBeDefined();
  });

  it('the sweep goes one shot per idle slot and stops while a heavy-decode marker is present', async () => {
    const r = rig({ idle: 'manual' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await ingestImage(jpegInput({ w: 4000 + i }), r.deps);
      ids.push(res!.shotId);
    }
    await vi.waitFor(() => {
      r.releaseIdle(); // let the per-ingest background steps finish first
      return expect(r.decode).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(async () => expect(await r.store.listShotsMissingThumb()).toEqual([]));
    for (const id of ids) {
      await r.backend.commit({ posters: [], shots: [{ ...(await shotOf(r, id)), thumb: undefined }], blobs: [], deleteShotIds: [], deletePosterIds: [], deleteBlobKeys: [] });
    }

    r.decode.mockClear();
    const sweep = sweepThumbnails(r.deps);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.decode).not.toHaveBeenCalled(); // waiting for an idle slot
    r.releaseIdle();
    await vi.waitFor(() => expect(r.decode).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await r.store.listShotsMissingThumb()).length).toBe(2));
    // a marker appears while the sweep waits for the next slot: it stops
    await r.store.setMeta(MARKER_KEY, { tabId: 'x', shotId: null, kind: 'view', startedAt: 1 });
    await vi.waitFor(() => r.releaseIdle());
    await expect(sweep).resolves.toBe(1);
    expect(r.decode).toHaveBeenCalledTimes(1);
  });

  it('registers the sweep as the app hook main.ts runs after the first interaction', async () => {
    const r = rig();
    registerThumbSweep(r.deps);
    await ingestImage(jpegInput(), { ...r.deps, idle: () => new Promise<void>(() => {}) });
    expect(appHooks.thumbSweep).toBeTypeOf('function');
    await appHooks.thumbSweep!();
    expect(await r.store.listShotsMissingThumb()).toEqual([]);
  });

  it('makeThumb leaves an existing thumbnail alone', async () => {
    const r = rig();
    const res = await ingestImage(jpegInput(), r.deps);
    await res!.background;
    expect(await makeThumb(res!.shotId, r.deps)).toBe(false); // already has one
  });
});

describe('never reject for pixel count (AC-43)', () => {
  it('stores a 108 MP photo byte-identical with oversize: true', async () => {
    const r = rig();
    const input = jpegInput({ w: 12000, h: 9000, source: 'file-capture' });
    const original = new Uint8Array(await input.blob.arrayBuffer());
    const res = await ingestImage(input, r.deps);
    const shot = await shotOf(r, res!.shotId);
    expect(shot).toMatchObject({ oversize: true, width: 12000, height: 9000, source: 'file-capture', normalized: false });
    const stored = new Uint8Array(await (await r.store.getBlob(shot.id, 'original'))!.arrayBuffer());
    expect(Array.from(stored)).toEqual(Array.from(original));
  });

  it('does not flag a photo at or below MAX_SOURCE_PIXELS', async () => {
    const r = rig();
    const res = await ingestImage(jpegInput({ w: 8000, h: 6000 }), r.deps);
    expect((await shotOf(r, res!.shotId)).oversize).toBeUndefined();
  });

  describe('every later decode of an oversize photo is bounded by MAX_DECODE_PIXELS', () => {
    const calls: ImageBitmapOptions[] = [];
    beforeEach(() => {
      calls.length = 0;
      resetDecodeCapsForTests();
      setDecodeCaps(CAPS_OK);
      vi.stubGlobal('createImageBitmap', async (_b: Blob, opts: ImageBitmapOptions = {}) => {
        calls.push(opts);
        return { width: opts.resizeWidth ?? 12000, height: opts.resizeHeight ?? 9000, close() {} };
      });
      configureDecodeGuard({ meta: null, persistMarker: false, tabId: 't', gate: new MemoryGate(), maxDecodePixels: 25_000_000 });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      resetDecodeCapsForTests();
    });

    it('view and preview decodes request at most the tier bound', async () => {
      const r = rig();
      const res = await ingestImage(jpegInput({ w: 12000, h: 9000 }), r.deps);
      const shot = await shotOf(r, res!.shotId);
      const blob = (await r.store.getBlob(shot.id, 'original'))!;
      const info = shotImageInfo(shot);
      const view = await decodeGuarded(blob, { info }, { shotId: shot.id, kind: 'view' });
      view.handle.close();
      expect(calls[0]!.resizeWidth! * calls[0]!.resizeHeight!).toBeLessThanOrEqual(25_000_000);
      const prev = await decodeGuarded(blob, { info, maxLongEdge: 2048 }, { shotId: shot.id, kind: 'preview' });
      prev.handle.close();
      expect(Math.max(calls[1]!.resizeWidth!, calls[1]!.resizeHeight!)).toBeLessThanOrEqual(2048);
    });
  });

  it('above HARD_SOURCE_PIXELS asks the user and never decides alone: Discard saves nothing', async () => {
    const confirmReduce = vi.fn(async () => false);
    const r = rig({ deps: { confirmReduce } });
    const res = await ingestImage(jpegInput({ w: 20000, h: 15000 }), r.deps); // 300 MP
    expect(res).toBeNull();
    expect(confirmReduce).toHaveBeenCalledWith({ megapixels: 300 });
    expect(await r.store.listPosters()).toEqual([]);
    expect(r.decode).not.toHaveBeenCalled();
  });

  it('with no dialog available a 300 MP photo is not saved or reduced silently', async () => {
    const r = rig();
    expect(await ingestImage(jpegInput({ w: 20000, h: 15000 }), r.deps)).toBeNull();
    expect(r.decode).not.toHaveBeenCalled();
  });

  it('"Save a reduced copy" decodes under the memory guard (kind reduce, long edge 8192) and flags normalized', async () => {
    const r = rig({
      deps: { confirmReduce: async () => true },
      decode: async () => result(8192, 6144, true),
    });
    const res = await ingestImage(jpegInput({ w: 20000, h: 15000, orientation: 1 }), r.deps);
    const shot = await shotOf(r, res!.shotId);
    expect(shot).toMatchObject({ normalized: true, width: 8192, height: 6144, originalExifOrientation: 1, originalMime: 'image/jpeg' });
    expect(r.decode.mock.calls[0]![1]).toMatchObject({ maxLongEdge: 8192 });
    expect(r.decode.mock.calls[0]![2]).toEqual({ shotId: null, kind: 'reduce' });
    expect((await r.store.getBlob(shot.id, 'original'))!.size).toBeGreaterThan(0);
    expect(res!.notice).toMatch(/reduced copy/);
    expect(r.decode.mock.calls[0]![1].info).toEqual({ width: 20000, height: 15000, orientation: 1 });
  });

  it('a failed reduced copy says the image cannot be read and saves nothing', async () => {
    const r = rig({
      deps: { confirmReduce: async () => true },
      decode: async () => {
        throw new DecodeError('oom');
      },
    });
    await expect(ingestImage(jpegInput({ w: 20000, h: 15000 }), r.deps)).rejects.toMatchObject({ kind: 'unsupported' });
    expect(await r.store.listPosters()).toEqual([]);
  });
});

describe('header formats (finding 2)', () => {
  it('stores a WebP with its VP8X dimensions', async () => {
    const r = rig();
    const res = await ingestImage({ blob: blobOf(webpBytes('VP8X', 4000, 3000), 'image/webp'), source: 'file-gallery', kind: 'overview' }, r.deps);
    expect(await shotOf(r, res!.shotId)).toMatchObject({ width: 4000, height: 3000, dimsPending: undefined, originalMime: 'image/webp' });
  });

  it('stores a HEIC and an AVIF with their ispe dimensions and no decode before persistence', async () => {
    const r = rig({ idle: 'manual' });
    const heic = await ingestImage({ blob: blobOf(isoBytes({ w: 4032, h: 3024, rot: 1 }), 'image/heic'), source: 'file-gallery', kind: 'overview' }, r.deps);
    const avif = await ingestImage({ blob: blobOf(isoBytes({ w: 2000, h: 1000, brand: 'avif' }), 'image/avif'), source: 'file-gallery', kind: 'overview' }, r.deps);
    expect(await shotOf(r, heic!.shotId)).toMatchObject({ width: 3024, height: 4032 });
    expect(await shotOf(r, avif!.shotId)).toMatchObject({ width: 2000, height: 1000 });
    expect(r.decode).not.toHaveBeenCalled();
  });

  it('an untyped HEIC from a file picker is accepted by extension and typed on the way in', async () => {
    const r = rig();
    const file = Object.assign(new Blob([isoBytes({ w: 3000, h: 2000 })]), { name: 'IMG_0001.HEIC' });
    const res = await ingestImage({ blob: file, source: 'file-gallery', kind: 'overview' }, r.deps);
    expect((await shotOf(r, res!.shotId)).originalMime).toBe('image/heic');
  });

  it('unknown dimensions: persists width 0 / height 0 with dimsPending, then resolves them through a gated normalize decode', async () => {
    let finishDims!: () => void;
    const dimsGate = new Promise<void>((resolve) => (finishDims = resolve));
    const r = rig({
      decode: async (_b, _o, ctx) => {
        if (ctx.kind !== 'normalize') return result(256, 171);
        await dimsGate;
        return result(6000, 4000);
      },
    });
    const noMeta = isoBytes({ w: 100, h: 100 }).subarray(0, 28); // ftyp only: dimensions unreadable
    const res = await ingestImage({ blob: blobOf(new Uint8Array(noMeta), 'image/heic'), source: 'file-gallery', kind: 'overview' }, r.deps);
    const before = await shotOf(r, res!.shotId);
    expect(before).toMatchObject({ width: 0, height: 0, dimsPending: true });
    expect(r.events[0]).toBe('createPosterWithShot');
    await vi.waitFor(() => expect(r.decode).toHaveBeenCalled());
    expect(r.decode.mock.calls[0]![2]).toEqual({ shotId: res!.shotId, kind: 'normalize' });
    finishDims();
    await res!.background;
    const after = await shotOf(r, res!.shotId);
    expect(after).toMatchObject({ width: 6000, height: 4000 });
    expect(after.dimsPending).toBeUndefined();
    expect(after.thumb).toBeDefined();
  });

  it('ensureDims is shared by concurrent callers (Adjust opening right after ingest)', async () => {
    let n = 0;
    const r = rig({
      idle: 'manual',
      decode: async (_b, _o, ctx) => {
        if (ctx.kind === 'normalize') n++;
        return result(900, 600);
      },
    });
    const blob = blobOf(new Uint8Array(isoBytes({ w: 1, h: 1 }).subarray(0, 28)), 'image/heic');
    const res = await ingestImage({ blob, source: 'file-gallery', kind: 'overview' }, r.deps);
    await Promise.all([ensureDims(res!.shotId, r.deps), ensureDims(res!.shotId, r.deps)]);
    expect(n).toBe(1);
    expect(await shotOf(r, res!.shotId)).toMatchObject({ width: 900, height: 600 });
  });

  it('a photo that cannot be decoded at all is removed again and reported (nothing stays saved, AC-4)', async () => {
    const onUnreadable = vi.fn();
    const r = rig({
      deps: { onUnreadable },
      decode: async () => {
        throw new DecodeError('cannot decode');
      },
    });
    const blob = blobOf(new Uint8Array(isoBytes({ w: 1, h: 1 }).subarray(0, 28)), 'image/heic');
    const res = await ingestImage({ blob, source: 'file-gallery', kind: 'overview' }, r.deps);
    await res!.background;
    expect(onUnreadable).toHaveBeenCalledWith(res!.shotId);
    expect(await r.store.listPosters()).toEqual([]);
  });
});

describe('EXIF orientation', () => {
  it('honoured by the decoder: the original is stored untouched with oriented dimensions and the tag recorded', async () => {
    const r = rig({ idle: 'manual' });
    const res = await ingestImage(jpegInput({ w: 4000, h: 3000, orientation: 6 }), r.deps);
    const shot = await shotOf(r, res!.shotId);
    expect(shot).toMatchObject({ width: 3000, height: 4000, originalExifOrientation: 6, normalized: false });
    expect(r.decode).not.toHaveBeenCalled();
    expect(shotImageInfo(shot)).toEqual({ width: 4000, height: 3000, orientation: 6 });
  });

  it('not honoured: the one allowed decode before persistence normalises by hand and flags the record', async () => {
    const encode = vi.fn(async () => new Blob(['UPRIGHT'], { type: 'image/jpeg' }));
    const r = rig({
      caps: { fromImage: false, exifHonored: false, resizeHonored: true, resizeAfterOrient: false },
      deps: { encodeJpeg: encode },
      decode: async () => result(4000, 3000),
    });
    const res = await ingestImage(jpegInput({ w: 4000, h: 3000, orientation: 6 }), r.deps);
    expect(r.events.slice(0, 2)).toEqual(['decode:normalize', 'createPosterWithShot']);
    expect(encode).toHaveBeenCalledWith(expect.anything(), { quality: 0.95, orientation: 6 });
    // decoded in stored space (orientation 1 for the decoder), rotated by hand, recorded upright
    expect(r.decode.mock.calls[0]![1].info).toEqual({ width: 4000, height: 3000, orientation: 1 });
    const shot = await shotOf(r, res!.shotId);
    expect(shot).toMatchObject({ normalized: true, width: 3000, height: 4000, originalExifOrientation: 1 });
    expect(await (await r.store.getBlob(shot.id, 'original'))!.text()).toBe('UPRIGHT');
  });

  it('orientation 1 never takes the normalisation path even when EXIF is not honoured', async () => {
    const r = rig({ caps: { fromImage: false, exifHonored: false, resizeHonored: false, resizeAfterOrient: false } });
    await ingestImage(jpegInput(), r.deps);
    expect(r.events[0]).toBe('createPosterWithShot');
  });
});

describe('poster attachment', () => {
  it('a detail shot is added to the existing poster with its grid cell and a free aspect default', async () => {
    const r = rig();
    const first = await ingestImage(jpegInput(), r.deps);
    const cell = { rows: 3 as const, cols: 3 as const, row: 1, col: 2 };
    const second = await ingestImage({ ...jpegInput(), kind: 'detail', posterId: first!.posterId, gridCell: cell }, r.deps);
    expect(second!.posterId).toBe(first!.posterId);
    const detail = await r.store.getPoster(first!.posterId);
    expect(detail!.shots.map((s) => s.kind)).toEqual(['overview', 'detail']);
    expect(await shotOf(r, second!.shotId)).toMatchObject({ gridCell: cell, aspectMode: 'free' });
  });
});

describe('thumbnails', () => {
  it('thumbFromBlob asks for a 256 px long edge', async () => {
    const r = rig();
    await thumbFromBlob(new Blob(['x']), { width: 4000, height: 3000, orientation: 1 }, 'id', r.deps);
    expect(r.decode.mock.calls[0]![1]).toMatchObject({ maxLongEdge: 256 });
    expect(r.decode.mock.calls[0]![2]).toEqual({ shotId: 'id', kind: 'thumb' });
    expect(bitmapTracker.liveCount()).toBe(0);
  });

  it('derives the thumbnail from a decoded preview exactly once (finding 7)', async () => {
    const r = rig();
    const res = await ingestImage(jpegInput(), { ...r.deps, idle: () => new Promise<void>(() => {}) });
    const bmp = { width: 2048, height: 1536, close() {} } as unknown as ImageBitmap;
    expect(await setThumbFromBitmap(res!.shotId, bmp, r.deps)).toBe(true);
    expect(r.decode).not.toHaveBeenCalled();
    expect(await setThumbFromBitmap(res!.shotId, bmp, r.deps)).toBe(false);
    expect(await setThumbFromBitmap('missing', bmp, r.deps)).toBe(false);
  });

  it('thumbnails a rectified shot from the rectified blob and an uncorrected one from the original', async () => {
    const r = rig();
    const res = await ingestImage(jpegInput({ w: 4000, h: 3000, orientation: 6 }), { ...r.deps, idle: () => new Promise<void>(() => {}) });
    const id = res!.shotId;
    const rect: RectificationResult = {
      blob: new Blob(['RECT'], { type: 'image/jpeg' }),
      mime: 'image/jpeg',
      width: 2400,
      height: 1800,
      corners: [[300, 300], [2700, 300], [2700, 3700], [300, 3700]],
      cornersSource: 'manual',
      aspectMode: 'free',
      aspectUsed: null,
      snappedTo: null,
      enhance: { autoContrast: false, whiteBalance: false, sharpen: false },
      engine: 'js',
    };
    await r.store.saveRectification(id, rect);
    expect(await makeThumb(id, r.deps)).toBe(true);
    expect(r.decode.mock.calls[0]![1].info).toEqual({ width: 2400, height: 1800, orientation: 1 });

    await r.store.keepUncorrected(id);
    expect((await shotOf(r, id)).thumb).toBeUndefined();
    expect(await makeThumb(id, r.deps)).toBe(true);
    expect(r.decode.mock.calls[1]![1].info).toEqual({ width: 4000, height: 3000, orientation: 6 });
  });

  it('keeps one original blob through captured -> uncorrected -> rectified -> uncorrected (AC-44)', async () => {
    const r = rig();
    const input = jpegInput();
    const bytes = new Uint8Array(await input.blob.arrayBuffer());
    const res = await ingestImage(input, { ...r.deps, idle: () => new Promise<void>(() => {}) });
    const id = res!.shotId;
    const hash = async () => Array.from(new Uint8Array(await (await r.store.getBlob(id, 'original'))!.arrayBuffer())).join(',');
    const original = Array.from(bytes).join(',');
    expect(await hash()).toBe(original);

    await r.store.keepUncorrected(id);
    expect((await shotOf(r, id)).status).toBe('uncorrected');
    expect((await shotOf(r, id)).corners).toBeNull();

    await r.store.saveRectification(id, {
      blob: new Blob(['R'], { type: 'image/jpeg' }),
      mime: 'image/jpeg',
      width: 3000,
      height: 2000,
      corners: [[300, 200], [2700, 220], [2650, 1800], [280, 1780]],
      cornersSource: 'manual',
      aspectMode: 'auto',
      aspectUsed: 1.5,
      snappedTo: null,
      enhance: { autoContrast: false, whiteBalance: false, sharpen: false },
    });
    expect((await shotOf(r, id)).status).toBe('rectified');

    await r.store.keepUncorrected(id);
    expect((await shotOf(r, id)).status).toBe('uncorrected');
    expect(await r.store.getBlob(id, 'rectified')).toBeNull();
    expect(await hash()).toBe(original);
    expect(await makeThumb(id, r.deps)).toBe(true);
    expect((await shotOf(r, id)).thumb).toBeDefined();
  });
});

describe('new shot defaults', () => {
  it('records the source label', async () => {
    const r = rig();
    const sources: NewShot['source'][] = ['camera-takephoto', 'camera-frame', 'file-capture', 'file-gallery'];
    for (const source of sources) {
      const res = await ingestImage(jpegInput({ source }), r.deps);
      expect((await shotOf(r, res!.shotId)).source).toBe(source);
    }
  });
});
