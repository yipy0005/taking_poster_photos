// Main-thread worker constructors. `new Worker(new URL(...), { type: 'module' })` must stay literal so Vite emits the chunk.
import type { WorkerLike } from './rpc.ts';

export function createJsWorker(): WorkerLike {
  return new Worker(new URL('./js/js-engine.worker.ts', import.meta.url), { type: 'module' });
}

export function createCvWorker(): WorkerLike {
  return new Worker(new URL('./opencv/cv-engine.worker.ts', import.meta.url), { type: 'module' });
}
