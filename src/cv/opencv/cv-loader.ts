// Worker-side OpenCV loader (design 2.8 "OpenCV engine details"). DOM-free.
// The Emscripten module can be a factory function, a promise of the module, or the module itself. Whatever it is, it is
// handed back inside a plain box `{ cv }` so that no `await` ever sees a possibly-thenable module as a resolution value.
import type * as Cv from '@techstark/opencv-js';
import { EngineUnavailableError } from '../../app/errors.ts';

export type CvApi = typeof Cv;

export const CV_LOAD_TIMEOUT_MS = 30_000;

/** Minimal shape of what the loader inspects. */
interface CvModuleLike {
  Mat?: unknown;
  onRuntimeInitialized?: () => void;
}

/** Turns whatever the script put on `globalThis.cv` into a boxed, initialised module. */
export function boxCv(g: unknown): Promise<{ cv: CvApi }> {
  return new Promise((resolve, reject) => {
    const give = (m: unknown): void => {
      const mod = m as CvModuleLike | null | undefined;
      if (!mod) {
        reject(new EngineUnavailableError('OpenCV did not provide a module'));
        return;
      }
      if (mod.Mat) {
        resolve({ cv: mod as unknown as CvApi });
        return;
      }
      // not initialised yet: wait for the runtime
      mod.onRuntimeInitialized = () => resolve({ cv: mod as unknown as CvApi });
    };
    try {
      if (typeof g === 'function') (g as () => PromiseLike<unknown>)().then(give, reject); // factory shape
      else if (g && typeof (g as PromiseLike<unknown>).then === 'function') (g as PromiseLike<unknown>).then(give, reject); // promise shape (5.x)
      else give(g); // already a module object
    } catch (e) {
      reject(e);
    }
  });
}

export interface CvLoaderDeps {
  /** `(url) => import(url)` in the worker. */
  importScript(url: string): Promise<unknown>;
  /** `() => globalThis.cv` */
  getGlobal(): unknown;
  timeoutMs?: number;
}

/** Imports the script and boxes the module. Rejects with EngineUnavailableError after `timeoutMs` (30 s). */
export async function loadCv(url: string, deps: CvLoaderDeps): Promise<CvApi> {
  const timeoutMs = deps.timeoutMs ?? CV_LOAD_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EngineUnavailableError('OpenCV did not load in time')), timeoutMs);
  });
  try {
    const box = await Promise.race([
      (async () => {
        await deps.importScript(url);
        return boxCv(deps.getGlobal());
      })(),
      timeout,
    ]);
    return box.cv;
  } catch (e) {
    if (e instanceof EngineUnavailableError) throw e;
    throw new EngineUnavailableError(`OpenCV could not be loaded: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Size of the WASM heap, or 0 when the module does not expose it. opencv-js 5.0.0-release.1 keeps HEAP8 private, so this is
 * 0 for that build; engine-client then recycles the worker after every job (design 2.7 item 10).
 */
export function readHeapBytes(cv: unknown): number {
  const m = cv as { HEAP8?: { length: number }; HEAPU8?: { length: number }; wasmMemory?: { buffer: { byteLength: number } } } | null;
  return m?.HEAPU8?.length ?? m?.HEAP8?.length ?? m?.wasmMemory?.buffer.byteLength ?? 0;
}
