// Maps what opencv.js throws to the app's error types. DOM-free.
import { AppError, CvError, OutOfMemoryError } from '../../app/errors.ts';
import type { CvApi } from './cv-loader.ts';

const MEMORY_RE = /out of memory|memory access|allocat|abort\(/i;

/**
 * opencv.js often throws a bare number (a pointer to a C++ exception). Memory failures become OutOfMemoryError (the engine is
 * then marked failed and the heap is discarded); other per-input exceptions become CvError (a strike, retry on the JS engine).
 * Aborts and the app's own typed errors pass through unchanged.
 */
export function toEngineError(api: CvApi | null, e: unknown): unknown {
  if (e instanceof Error) {
    if (e.name === 'AbortError' || e instanceof AppError) return e;
    if (e instanceof RangeError || MEMORY_RE.test(e.message)) return new OutOfMemoryError(e.message, { cause: e });
    return new CvError(e.message, { cause: e });
  }
  if (typeof e === 'number' && api) {
    try {
      const ex = (api as unknown as { exceptionFromPtr?: (p: number) => { msg?: string } }).exceptionFromPtr?.(e);
      if (ex?.msg) return MEMORY_RE.test(ex.msg) ? new OutOfMemoryError(ex.msg) : new CvError(ex.msg);
    } catch {
      // fall through
    }
  }
  return new CvError(`OpenCV call failed (${String(e)})`);
}
