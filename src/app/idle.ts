// whenIdle(): requestIdleCallback with a setTimeout fallback (Safari has no rIC). Never call rIC directly.
export function whenIdle(cb: () => void, timeoutMs = 200): () => void {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof g.requestIdleCallback === 'function') {
    const handle = g.requestIdleCallback(cb, { timeout: timeoutMs });
    return () => g.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(cb, timeoutMs);
  return () => clearTimeout(handle);
}
