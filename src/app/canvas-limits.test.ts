import { describe, expect, it } from 'vitest';
import { deviceTier, isIosWebKit, TIERS } from './config.ts';
import {
  CANVAS_PROBE_CACHE_KEY,
  CANVAS_PROBE_GUARD_KEY,
  probeCanvasLimit,
  type KeyValueStorage,
  type ProbeCanvas,
  type ProbeEnv,
} from './canvas-limits.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';

describe('deviceTier (AC-47)', () => {
  it('returns the default column for deviceMemory undefined and 8', () => {
    expect(deviceTier({ userAgent: ANDROID })).toBe(TIERS.default);
    expect(deviceTier({ userAgent: ANDROID, deviceMemory: 8 })).toBe(TIERS.default);
    expect(TIERS.default).toMatchObject({ maxOutputPixels: 50_000_000, roiBudget: 4_000_000, maxDecodePixels: 64_000_000 });
  });
  it('returns the 4 GB column for deviceMemory 4', () => {
    expect(deviceTier({ userAgent: ANDROID, deviceMemory: 4 })).toMatchObject({
      tier: 'mem4',
      maxOutputPixels: 33_500_000,
      roiBudget: 4_000_000,
      maxDecodePixels: 40_000_000,
    });
  });
  it('returns the low-memory column for deviceMemory 2 and 0.5', () => {
    for (const mem of [2, 0.5]) {
      expect(deviceTier({ userAgent: ANDROID, deviceMemory: mem })).toMatchObject({
        tier: 'low',
        maxOutputPixels: 16_700_000,
        roiBudget: 3_000_000,
        maxDecodePixels: 25_000_000,
      });
    }
  });
  it('returns the iOS column regardless of deviceMemory, including iPadOS reporting MacIntel', () => {
    expect(deviceTier({ userAgent: IPHONE, deviceMemory: 8 })).toMatchObject({
      tier: 'ios',
      maxOutputPixels: 16_777_216,
      roiBudget: 3_000_000,
      maxDecodePixels: 25_000_000,
      maxSourcePixels: 50_000_000,
    });
    const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
    expect(isIosWebKit(ipad)).toBe(true);
    expect(isIosWebKit({ ...ipad, maxTouchPoints: 0 })).toBe(false);
  });
});

function memStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** Canvas fake: allocations above `maxArea` fail (alpha stays 0). Records every requested area. */
function fakeCanvasFactory(maxArea: number, log: number[], onAlloc?: () => void): () => ProbeCanvas {
  return () => {
    const c: ProbeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect() {},
        getImageData: () => ({ data: [0, 0, 0, c.width * c.height <= maxArea ? 255 : 0] }),
      }),
    };
    return new Proxy(c, {
      set(target, prop, value) {
        (target as unknown as Record<string, unknown>)[prop as string] = value;
        if (prop === 'height' && value > 0) {
          log.push(target.width * value);
          onAlloc?.();
        }
        return true;
      },
    });
  };
}

describe('probeCanvasLimit (finding 6, AC-47)', () => {
  it('does not probe on iOS and returns the constant', () => {
    const log: number[] = [];
    const env: ProbeEnv = { device: { userAgent: IPHONE }, storage: memStorage(), createCanvas: fakeCanvasFactory(1e9, log) };
    expect(probeCanvasLimit(env)).toBe(16_777_216);
    expect(log).toEqual([]);
  });

  it('starts at the tier cap: first allocation is 16.7e6 for deviceMemory <= 2, 33.5e6 for 4, 50e6 otherwise', () => {
    const cases: Array<[number | undefined, number]> = [
      [2, 16.7e6],
      [4, 33.5e6],
      [undefined, 50e6],
    ];
    for (const [mem, first] of cases) {
      const log: number[] = [];
      const env: ProbeEnv = {
        device: { userAgent: ANDROID, deviceMemory: mem },
        storage: memStorage(),
        createCanvas: fakeCanvasFactory(1e12, log),
      };
      const result = probeCanvasLimit(env);
      expect(result).toBe(first);
      expect(log.length).toBe(1);
      expect(Math.abs((log[0] ?? 0) - first) / first).toBeLessThan(0.001);
    }
  });

  it('steps down when large canvases fail and caches the answer', () => {
    const log: number[] = [];
    const storage = memStorage();
    const env: ProbeEnv = { device: { userAgent: ANDROID }, storage, createCanvas: fakeCanvasFactory(20e6, log) };
    expect(probeCanvasLimit(env)).toBe(16.7e6);
    expect(log.length).toBe(3); // 50e6, 33.5e6, 16.7e6
    expect(storage.data[CANVAS_PROBE_GUARD_KEY]).toBeUndefined();
    expect(storage.data[CANVAS_PROBE_CACHE_KEY]).toBeDefined();
    const before = log.length;
    expect(probeCanvasLimit(env)).toBe(16.7e6); // cached
    expect(log.length).toBe(before);
  });

  it('sets the crash guard before the first allocation and clears it afterwards', () => {
    const storage = memStorage();
    let guardDuringAlloc: string | undefined;
    const env: ProbeEnv = {
      device: { userAgent: ANDROID },
      storage,
      createCanvas: fakeCanvasFactory(1e12, [], () => {
        guardDuringAlloc ??= storage.data[CANVAS_PROBE_GUARD_KEY];
      }),
    };
    probeCanvasLimit(env);
    expect(guardDuringAlloc).toBe('running');
    expect(storage.data[CANVAS_PROBE_GUARD_KEY]).toBeUndefined();
  });

  it('skips probing when the guard is still "running" and uses 8.3 MP without a cache', () => {
    const log: number[] = [];
    const storage = memStorage({ [CANVAS_PROBE_GUARD_KEY]: 'running' });
    const env: ProbeEnv = { device: { userAgent: ANDROID }, storage, createCanvas: fakeCanvasFactory(1e12, log) };
    expect(probeCanvasLimit(env)).toBe(8.3e6);
    expect(log).toEqual([]);
  });

  it('skips probing when the guard is "running" and uses the cached value when there is one', () => {
    const log: number[] = [];
    const first = memStorage();
    const env1: ProbeEnv = { device: { userAgent: ANDROID }, storage: first, createCanvas: fakeCanvasFactory(20e6, []) };
    expect(probeCanvasLimit(env1)).toBe(16.7e6);
    first.data[CANVAS_PROBE_GUARD_KEY] = 'running';
    const env2: ProbeEnv = { device: { userAgent: ANDROID }, storage: first, createCanvas: fakeCanvasFactory(1e12, log) };
    expect(probeCanvasLimit(env2)).toBe(16.7e6);
    expect(log).toEqual([]);
  });

  it('falls back to 8.3 MP when every probe fails', () => {
    const env: ProbeEnv = { device: { userAgent: ANDROID }, storage: memStorage(), createCanvas: fakeCanvasFactory(1, []) };
    expect(probeCanvasLimit(env)).toBe(8.3e6);
  });
});
