import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineUnavailableError } from '../../app/errors.ts';
import { boxCv, loadCv, readHeapBytes } from './cv-loader.ts';
import { resolveCvUrl } from './cv-url.ts';

const fakeModule = (extra: Record<string, unknown> = {}) => ({ Mat: class {}, ...extra });

describe('boxCv: the three shapes of globalThis.cv', () => {
  it('factory function', async () => {
    const m = fakeModule();
    const { cv } = await boxCv(() => Promise.resolve(m));
    expect(cv).toBe(m);
  });
  it('promise of the module (5.x MODULARIZE)', async () => {
    const m = fakeModule();
    expect((await boxCv(Promise.resolve(m))).cv).toBe(m);
  });
  it('module object that is already initialised', async () => {
    const m = fakeModule();
    expect((await boxCv(m)).cv).toBe(m);
  });
  it('module object that is not initialised yet waits for onRuntimeInitialized', async () => {
    const m: { Mat?: unknown; onRuntimeInitialized?: () => void } = {};
    const p = boxCv(m);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    m.Mat = class {};
    m.onRuntimeInitialized!();
    expect((await p).cv).toBe(m);
  });
  it('never leaks the module as a thenable: the box resolves with a plain object even if the module has `then`', async () => {
    const then = vi.fn();
    const m = fakeModule({ then });
    const box = await boxCv(() => ({ then: (give: (v: unknown) => void) => give(m) }));
    expect(box.cv).toBe(m);
    expect(then).not.toHaveBeenCalled(); // `await box` did not adopt the module
  });
  it('rejects when the factory rejects, throws, or provides nothing', async () => {
    await expect(boxCv(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(
      boxCv(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(boxCv(undefined)).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});

describe('loadCv', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('imports the script from the given URL, then boxes globalThis.cv', async () => {
    const m = fakeModule();
    const importScript = vi.fn(async () => ({}));
    const cv = await loadCv('https://example.test/assets/vendor/opencv-abc.js', { importScript, getGlobal: () => Promise.resolve(m) });
    expect(cv).toBe(m);
    expect(importScript).toHaveBeenCalledWith('https://example.test/assets/vendor/opencv-abc.js');
  });
  it('a failed import becomes EngineUnavailableError', async () => {
    await expect(loadCv('u', { importScript: () => Promise.reject(new Error('404')), getGlobal: () => undefined })).rejects.toBeInstanceOf(EngineUnavailableError);
  });
  it('times out after 30 s by default', async () => {
    const p = loadCv('u', { importScript: () => new Promise(() => {}), getGlobal: () => undefined });
    const assertion = expect(p).rejects.toBeInstanceOf(EngineUnavailableError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
  it('a runtime that never initialises also times out', async () => {
    const p = loadCv('u', { importScript: async () => ({}), getGlobal: () => ({}), timeoutMs: 1000 });
    const assertion = expect(p).rejects.toBeInstanceOf(EngineUnavailableError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe('readHeapBytes', () => {
  it('reads whichever heap view the module exposes, else 0', () => {
    expect(readHeapBytes({ HEAPU8: { length: 100 } })).toBe(100);
    expect(readHeapBytes({ HEAP8: { length: 50 } })).toBe(50);
    expect(readHeapBytes({ wasmMemory: { buffer: { byteLength: 7 } } })).toBe(7);
    expect(readHeapBytes({})).toBe(0);
    expect(readHeapBytes(null)).toBe(0);
  });
});

describe('cv-url', () => {
  it('resolves against the page URL, keeping the Vite base', () => {
    expect(resolveCvUrl('/taking_poster_photos/assets/vendor/opencv-abc.js', 'https://u.github.io/taking_poster_photos/#/adjust/x')).toBe(
      'https://u.github.io/taking_poster_photos/assets/vendor/opencv-abc.js',
    );
    expect(resolveCvUrl('assets/vendor/opencv-abc.js', 'https://h.test/app/')).toBe('https://h.test/app/assets/vendor/opencv-abc.js');
    expect(resolveCvUrl('https://h.test/x.js', 'https://other.test/')).toBe('https://h.test/x.js');
  });
});
