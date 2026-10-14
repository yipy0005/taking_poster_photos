import { describe, expect, it, vi } from 'vitest';
import { waitForSettledVideo, type WarmupDeps } from './warmup.ts';

/** Manual timers so the tests control time. */
function fakeTimers(): WarmupDeps & { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

describe('waitForSettledVideo', () => {
  it('resolves after N presented frames (requestVideoFrameCallback)', async () => {
    const timers = fakeTimers();
    const callbacks: Array<() => void> = [];
    const video = { readyState: 4, videoWidth: 640, requestVideoFrameCallback: (cb: () => void) => callbacks.push(cb) };
    const done = vi.fn();
    void waitForSettledVideo(video, { minFrames: 3 }, timers).then(done);
    for (let i = 0; i < 2; i++) callbacks.shift()!();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    callbacks.shift()!();
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('resolves at maxMs when no frame ever arrives', async () => {
    const timers = fakeTimers();
    const video = { readyState: 0, videoWidth: 0, requestVideoFrameCallback: () => 1 };
    const done = vi.fn();
    void waitForSettledVideo(video, { minFrames: 5, maxMs: 1500 }, timers).then(done);
    timers.advance(1499);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    timers.advance(2);
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('works without requestVideoFrameCallback (poll)', async () => {
    const timers = fakeTimers();
    const video = { readyState: 4, videoWidth: 640 };
    const done = vi.fn();
    void waitForSettledVideo(video, { minFrames: 3, pollMs: 100, maxMs: 5000 }, timers).then(done);
    timers.advance(250);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    timers.advance(100);
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('does not count polls while the video has no data, then falls back to maxMs', async () => {
    const timers = fakeTimers();
    const video = { readyState: 1, videoWidth: 0 };
    const done = vi.fn();
    void waitForSettledVideo(video, { minFrames: 2, pollMs: 100, maxMs: 1000 }, timers).then(done);
    timers.advance(900);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    timers.advance(100);
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
