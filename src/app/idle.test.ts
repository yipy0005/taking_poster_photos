import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from './idle.ts';

describe('whenIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses requestIdleCallback when it exists', () => {
    const ric = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', ric);
    const cb = vi.fn();
    whenIdle(cb);
    expect(ric).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('falls back to setTimeout when requestIdleCallback is deleted (Safari)', () => {
    // @ts-expect-error simulate a browser without rIC
    delete globalThis.requestIdleCallback;
    expect(typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback).toBe('undefined');
    const cb = vi.fn();
    whenIdle(cb, 200);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns a cancel function', () => {
    const cb = vi.fn();
    const cancel = whenIdle(cb, 50);
    cancel();
    vi.advanceTimersByTime(100);
    expect(cb).not.toHaveBeenCalled();
  });
});
