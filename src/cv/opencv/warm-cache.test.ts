import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DECODE_CAPS } from '../../app/decode.ts';
import { EngineClient, type EngineClientDeps } from '../engine-client.ts';
import type { InitPayload } from '../protocol.ts';
import { createRaster } from '../raster2d.ts';
import { FakeWorker, type Script } from '../testing/fake-worker.ts';
import {
  CV_CACHE_NAME,
  autoWarm,
  isCvCached,
  scheduleAutoWarm,
  shouldAutoWarm,
  warmCvCache,
  type AutoWarmDeps,
  type CacheStorageLike,
} from './warm-cache.ts';

const URL_A = 'https://h.test/app/assets/vendor/opencv-aaa.js';
const URL_OLD = 'https://h.test/app/assets/vendor/opencv-old.js';

class FakeCaches implements CacheStorageLike {
  readonly stores = new Map<string, Map<string, string>>();
  opened: string[] = [];
  failAdd = false;
  /** Simulates a `Vary: Origin` response that a plain match() misses. */
  varyOrigin = false;
  async open(name: string) {
    this.opened.push(name);
    const store = this.stores.get(name) ?? new Map<string, string>();
    this.stores.set(name, store);
    return {
      add: async (url: string) => {
        if (this.failAdd) throw new TypeError('network error');
        store.set(url, 'body');
      },
      keys: async () => Array.from(store.keys()).map((url) => ({ url })),
      delete: async (r: string | { url: string }) => store.delete(typeof r === 'string' ? r : r.url),
      match: async (url: string, options?: { ignoreVary?: boolean }) => {
        if (this.varyOrigin && !options?.ignoreVary) return undefined;
        return store.get(url);
      },
    };
  }
}

describe('AC-18 d: shouldAutoWarm truth table (allow-list)', () => {
  const wifi = { type: 'wifi', saveData: false };
  it.each([
    ['navigator.connection undefined (Safari, Firefox)', { connection: undefined, isIosWebKit: false }, false],
    ['navigator.connection null', { connection: null, isIosWebKit: false }, false],
    ['wifi', { connection: wifi, isIosWebKit: false }, true],
    ['ethernet', { connection: { type: 'ethernet' }, isIosWebKit: false }, true],
    ['wifi with saveData', { connection: { type: 'wifi', saveData: true }, isIosWebKit: false }, false],
    ['cellular', { connection: { type: 'cellular' }, isIosWebKit: false }, false],
    ['type unknown (effectiveType only)', { connection: {}, isIosWebKit: false }, false],
    ['iOS WebKit even on wifi', { connection: wifi, isIosWebKit: true }, false],
    ['iOS WebKit without connection API', { connection: undefined, isIosWebKit: true }, false],
  ])('%s -> %s', (_name, env, expected) => {
    expect(shouldAutoWarm(env)).toBe(expected);
  });
});

describe('warm-up fills the runtime cache only', () => {
  it('cache.add(url) into cv-runtime, then removes every other key', async () => {
    const c = new FakeCaches();
    (await c.open(CV_CACHE_NAME)).add(URL_OLD);
    await warmCvCache(URL_A, c);
    expect(Array.from(c.stores.get(CV_CACHE_NAME)!.keys())).toEqual([URL_A]);
    expect(await isCvCached(URL_A, c)).toBe(true);
    expect(await isCvCached(URL_OLD, c)).toBe(false);
  });
  it('finds the entry even when the stored response varies on Origin', async () => {
    const c = new FakeCaches();
    c.varyOrigin = true;
    await warmCvCache(URL_A, c);
    expect(await isCvCached(URL_A, c)).toBe(true);
  });
  it('rejects when the download fails or the Cache API is missing, and isCvCached is false without it', async () => {
    const c = new FakeCaches();
    c.failAdd = true;
    await expect(warmCvCache(URL_A, c)).rejects.toThrow();
    await expect(warmCvCache(URL_A, undefined)).rejects.toThrow('Cache API');
    expect(await isCvCached(URL_A, undefined)).toBe(false);
  });
});

describe('autoWarm / scheduleAutoWarm', () => {
  const deps = (over: Partial<AutoWarmDeps> = {}): AutoWarmDeps & { warm: ReturnType<typeof vi.fn> } => {
    const warm = vi.fn(async () => {});
    return {
      env: () => ({ connection: { type: 'wifi' }, isIosWebKit: false }),
      isBusy: () => false,
      isCached: async () => false,
      warm,
      idle: (cb) => cb(),
      ...over,
    } as AutoWarmDeps & { warm: ReturnType<typeof vi.fn> };
  };
  it('downloads on wifi when not cached', async () => {
    const d = deps();
    expect(await autoWarm(d)).toBe('warmed');
    expect(d.warm).toHaveBeenCalledOnce();
  });
  it('does nothing without the connection API or on iOS: no cache access, no request', async () => {
    const isCached = vi.fn(async () => false);
    for (const env of [{ connection: undefined, isIosWebKit: false }, { connection: { type: 'wifi' }, isIosWebKit: true }]) {
      const d = deps({ env: () => env, isCached });
      expect(await autoWarm(d)).toBe('skipped');
      expect(d.warm).not.toHaveBeenCalled();
    }
    expect(isCached).not.toHaveBeenCalled();
  });
  it('skips when already cached and swallows download failures', async () => {
    const d1 = deps({ isCached: async () => true });
    expect(await autoWarm(d1)).toBe('cached');
    expect(d1.warm).not.toHaveBeenCalled();
    const d2 = deps();
    d2.warm.mockRejectedValue(new Error('offline'));
    expect(await autoWarm(d2)).toBe('failed');
  });
  it('waits while the app is busy (capture screen, gated job) and runs once it is free', async () => {
    let busy = true;
    const timers: Array<() => void> = [];
    const d = deps({ isBusy: () => busy, schedule: (cb) => void timers.push(cb), maxAttempts: 5 });
    scheduleAutoWarm(d);
    await Promise.resolve();
    expect(d.warm).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    busy = false;
    timers.shift()!();
    await vi.waitFor(() => expect(d.warm).toHaveBeenCalledOnce());
  });
  it('gives up after maxAttempts and can be cancelled', async () => {
    const timers: Array<() => void> = [];
    const d = deps({ isBusy: () => true, schedule: (cb) => void timers.push(cb), maxAttempts: 2 });
    scheduleAutoWarm(d);
    timers.shift()!();
    expect(timers).toHaveLength(0);
    expect(d.warm).not.toHaveBeenCalled();
    const d2 = deps({ isBusy: () => true, schedule: (cb) => void timers.push(cb) });
    const cancel = scheduleAutoWarm(d2);
    cancel();
    timers.shift()?.();
    expect(timers).toHaveLength(0);
  });
});

describe('AC-18 d: the engine client never touches OpenCV without an explicit load', () => {
  const INIT: InitPayload = { isIosWebKit: false, maxOutputPixels: 16_777_216, maxDecodePixels: 25_000_000, roiBudget: 3_000_000, decodeCaps: DEFAULT_DECODE_CAPS };
  const healthy: Script = (req, api) => {
    if (req.type === 'init') api.result(req.id, {});
    else if (req.type === 'detect') api.result(req.id, { quad: null, confidence: 0, method: 'js' });
  };
  it('detect() creates no OpenCV worker and requests no URL before loadOpenCv()', async () => {
    const created: FakeWorker[] = [];
    const cvUrl = vi.fn(() => URL_A);
    const deps: EngineClientDeps = {
      createJsWorker: () => new FakeWorker(healthy),
      createOpenCvWorker: () => {
        const w = new FakeWorker((req, api) => (req.type === 'init' ? api.result(req.id, {}) : undefined));
        created.push(w);
        return w;
      },
      cvUrl,
      initPayload: () => INIT,
      run: (_ctx, opts, fn) => fn({ maxPixels: opts.maxPixels }),
      terminateCvAfterEveryJob: false,
    };
    const client = new EngineClient(deps);
    await client.detect(createRaster(40, 30));
    expect(created).toHaveLength(0);
    expect(cvUrl).not.toHaveBeenCalled();
    expect(client.getStatus().opencv).toBe('idle');
    // explicit opt-in is what creates the worker, and then the URL goes to it in the init message
    await expect(client.loadOpenCv('user')).resolves.toBe(true);
    expect(created).toHaveLength(1);
    expect(cvUrl).toHaveBeenCalled();
    expect((created[0]!.of('init')[0]!.payload as InitPayload).cvUrl).toBe(URL_A);
    client.dispose();
  });
});
