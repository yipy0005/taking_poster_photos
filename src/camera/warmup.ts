// Waits for a camera <video> to settle before the shutter is enabled: auto-exposure and white balance need several frames
// (often a few hundred ms) to converge, and the first frames are dark, on iOS often black. Never rejects.

export interface VideoWarmupLike {
  readyState: number;
  videoWidth: number;
  requestVideoFrameCallback?: (cb: () => void) => number;
}

export interface WarmupDeps {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WarmupOptions {
  minFrames?: number;
  maxMs?: number;
  /** Poll interval where requestVideoFrameCallback is missing (frames are then estimated by time). */
  pollMs?: number;
}

const realDeps: WarmupDeps = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Resolves once the video has data and `minFrames` frames were presented, or after `maxMs`, whichever comes first.
 * Without requestVideoFrameCallback a poll counts one "frame" per tick while the video reports data.
 */
export function waitForSettledVideo(video: VideoWarmupLike, opts: WarmupOptions = {}, deps: WarmupDeps = realDeps): Promise<void> {
  const minFrames = opts.minFrames ?? 5;
  const maxMs = opts.maxMs ?? 1500;
  const pollMs = opts.pollMs ?? 100;
  return new Promise<void>((resolve) => {
    let frames = 0;
    let finished = false;
    const timers: unknown[] = [];
    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const t of timers) deps.clearTimeout(t);
      resolve();
    };
    timers.push(deps.setTimeout(finish, maxMs));
    const ready = (): boolean => video.readyState >= 2 && video.videoWidth > 0;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = (): void => {
        if (finished) return;
        if (ready()) frames++;
        if (frames >= minFrames) finish();
        else video.requestVideoFrameCallback!(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    } else {
      const tick = (): void => {
        if (finished) return;
        if (ready()) frames++;
        if (frames >= minFrames) finish();
        else timers.push(deps.setTimeout(tick, pollMs));
      };
      timers.push(deps.setTimeout(tick, pollMs));
    }
  });
}
