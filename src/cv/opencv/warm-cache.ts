// Fills the 'cv-runtime' cache with the 13 MB OpenCV file (design 2.8 "Offline availability and the load policy"). Main thread.
// Warming only fills the cache; it never instantiates the WASM. The service worker's CacheFirst route reads the same cache.
import { isIosWebKit } from '../../app/config.ts';
import { whenIdle } from '../../app/idle.ts';
import { log } from '../../app/log.ts';
import { memoryGate } from '../../app/memory-gate.ts';
import { getCvUrl } from './cv-url.ts';

export const CV_CACHE_NAME = 'cv-runtime';

export interface ConnectionInfo {
  type?: string;
  saveData?: boolean;
}
export interface WarmEnv {
  connection?: ConnectionInfo | null;
  isIosWebKit: boolean;
}

/**
 * Allow-list, not deny-list: automatic warm-up happens only when the browser says it is on Wi-Fi or ethernet, data saver is not
 * on, and the platform is not iOS WebKit. A missing `navigator.connection` (Safari, Firefox) means "do not auto-download".
 */
export function shouldAutoWarm(env: WarmEnv): boolean {
  if (env.isIosWebKit) return false;
  const c = env.connection;
  if (!c) return false;
  if (c.saveData === true) return false;
  return c.type === 'wifi' || c.type === 'ethernet';
}

export function readWarmEnv(): WarmEnv {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: ConnectionInfo });
  return { connection: nav?.connection ?? null, isIosWebKit: isIosWebKit() };
}

/** The slice of CacheStorage used here (so tests can fake it). */
export interface CacheStorageLike {
  open(name: string): Promise<{
    add(url: string): Promise<void>;
    keys(): Promise<ReadonlyArray<{ url: string }>>;
    delete(request: string | { url: string }): Promise<boolean>;
    match(url: string, options?: { ignoreVary?: boolean }): Promise<unknown>;
  }>;
}
const defaultCaches = (): CacheStorageLike | undefined => (typeof caches === 'undefined' ? undefined : (caches as unknown as CacheStorageLike));

/** True when the OpenCV file is already in the runtime cache. Never touches the network. */
export async function isCvCached(url: string = getCvUrl(), storage: CacheStorageLike | undefined = defaultCaches()): Promise<boolean> {
  if (!storage) return false;
  try {
    const cache = await storage.open(CV_CACHE_NAME);
    // ignoreVary: a server that sends `Vary: Origin` would otherwise hide an entry stored by a module-worker request (it carries Origin)
    return !!(await cache.match(url, { ignoreVary: true }));
  } catch {
    return false;
  }
}

/**
 * Downloads the file into the cache with `cache.add(url)` (so the entry exists even before the page is controlled by the service
 * worker, which a plain fetch() would miss) and then removes every other key, because manual puts bypass the expiration plugin.
 */
export async function warmCvCache(url: string = getCvUrl(), storage: CacheStorageLike | undefined = defaultCaches()): Promise<void> {
  if (!storage) throw new Error('The Cache API is not available in this browser');
  const cache = await storage.open(CV_CACHE_NAME);
  await cache.add(url);
  for (const key of await cache.keys()) {
    if (key.url !== url) await cache.delete(key);
  }
}

export interface AutoWarmDeps {
  env(): WarmEnv;
  /** True while the Capture screen is mounted, a gated job runs, or the page is hidden. */
  isBusy(): boolean;
  isCached(): Promise<boolean>;
  warm(): Promise<void>;
  idle(cb: () => void): void;
  /** Retry delay while busy. */
  retryMs?: number;
  maxAttempts?: number;
  schedule?: (cb: () => void, ms: number) => void;
}

/** Runs one auto-warm cycle. Resolves true when the cache was filled. Silent on failure. */
export async function autoWarm(deps: AutoWarmDeps): Promise<'warmed' | 'skipped' | 'cached' | 'failed'> {
  if (!shouldAutoWarm(deps.env())) return 'skipped';
  if (await deps.isCached()) return 'cached';
  try {
    await deps.warm();
    return 'warmed';
  } catch (e) {
    log.debug('OpenCV cache warm-up failed', e);
    return 'failed';
  }
}

/** Schedules auto-warm in an idle slot, backing off while the app is busy. Returns a cancel function. */
export function scheduleAutoWarm(deps: AutoWarmDeps): () => void {
  let cancelled = false;
  let attempts = 0;
  const schedule = deps.schedule ?? ((cb, ms) => void setTimeout(cb, ms));
  const attempt = (): void => {
    if (cancelled) return;
    deps.idle(() => {
      if (cancelled) return;
      if (!shouldAutoWarm(deps.env())) return; // nothing to do, and nothing will change that soon
      if (deps.isBusy()) {
        if (++attempts < (deps.maxAttempts ?? 30)) schedule(attempt, deps.retryMs ?? 10_000);
        return;
      }
      void autoWarm(deps);
    });
  };
  attempt();
  return () => {
    cancelled = true;
  };
}

/** Production wiring, started from main.ts after the first user interaction. */
export function startAutoWarm(): () => void {
  return scheduleAutoWarm({
    env: readWarmEnv,
    isBusy: () => location.hash.startsWith('#/capture') || memoryGate.busy || document.visibilityState !== 'visible',
    isCached: () => isCvCached(),
    warm: () => warmCvCache(),
    idle: (cb) => void whenIdle(cb),
  });
}
