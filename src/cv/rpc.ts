// Request/reply RPC over a Worker (design 2.8): { id, type, payload } requests, { id, type: 'result' | 'progress' |
// 'error' } replies, `cancel` by id. Both sides live here. DOM-free (structural worker types).
import { AppError, CvError, DecodeError, EngineCrashError, EngineUnavailableError, OutOfMemoryError } from '../app/errors.ts';
import type { RequestType, RpcReply, RpcRequest, SerializedError } from './protocol.ts';

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (ev: any) => void): void;
}

export function abortError(message = 'Aborted'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** Marks a handler result whose buffers should be transferred rather than copied. */
export class Transferred {
  constructor(
    readonly value: unknown,
    readonly transfer: Transferable[],
  ) {}
}

/** Maps any thrown value to a serialisable error. Allocation-type failures become OutOfMemoryError. */
export function serializeError(e: unknown): SerializedError {
  const name = typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? 'Error') : 'Error';
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'AbortError') return { name, message };
  if (e instanceof AppError) return { name: e.name, message };
  if (e instanceof RangeError || /out of memory|memory|allocat/i.test(message)) return { name: 'OutOfMemoryError', message };
  return { name, message };
}

export function reviveError(s: SerializedError): Error {
  switch (s.name) {
    case 'AbortError':
      return abortError(s.message);
    case 'OutOfMemoryError':
      return new OutOfMemoryError(s.message);
    case 'EngineUnavailableError':
      return new EngineUnavailableError(s.message);
    case 'CvError':
      return new CvError(s.message);
    case 'DecodeError':
      return new DecodeError(s.message);
    case 'EngineCrashError':
      return new EngineCrashError(s.message);
    default: {
      const e = new AppError(s.message);
      e.name = s.name;
      return e;
    }
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  onProgress?: (p: number) => void;
  cleanup(): void;
}
export interface CallOpts {
  signal?: AbortSignal;
  transfer?: Transferable[];
  onProgress?: (p: number) => void;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private dead = false;
  /** Called once when the worker raises error/messageerror (not on a deliberate terminate()). */
  onCrash?: (err: Error) => void;

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', (ev: { data: unknown }) => this.onMessage(ev.data as RpcReply));
    worker.addEventListener('error', (ev: { message?: string }) => this.crash(new EngineCrashError(ev?.message || 'Worker error')));
    worker.addEventListener('messageerror', () => this.crash(new EngineCrashError('Worker message could not be read')));
  }

  get alive(): boolean {
    return !this.dead;
  }

  call<T>(type: RequestType, payload: unknown, opts: CallOpts = {}): Promise<T> {
    if (this.dead) return Promise.reject(new EngineUnavailableError('Worker is not running'));
    if (opts.signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        opts.signal?.removeEventListener('abort', onAbort);
        try {
          const cancel: RpcRequest = { id, type: 'cancel', payload: null };
          this.worker.postMessage(cancel);
        } catch {
          // worker already gone
        }
        reject(abortError());
      };
      const entry: Pending = {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress: opts.onProgress,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      };
      this.pending.set(id, entry);
      opts.signal?.addEventListener('abort', onAbort);
      try {
        const req: RpcRequest = { id, type, payload };
        this.worker.postMessage(req, opts.transfer ?? []);
      } catch (e) {
        this.pending.delete(id);
        entry.cleanup();
        reject(e);
      }
    });
  }

  private onMessage(reply: RpcReply): void {
    const p = this.pending.get(reply?.id);
    if (!p) return;
    if (reply.type === 'progress') {
      if (typeof reply.payload === 'number') p.onProgress?.(reply.payload);
      return;
    }
    this.pending.delete(reply.id);
    p.cleanup();
    if (reply.type === 'error') p.reject(reviveError(reply.error ?? { name: 'Error', message: 'Unknown error' }));
    else p.resolve(reply.payload);
  }

  private rejectAll(err: Error): void {
    const all = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of all) {
      p.cleanup();
      p.reject(err);
    }
  }

  private crash(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.worker.terminate(); // a worker that raised error/messageerror is not reused; free its heap
    } catch {
      // already gone
    }
    this.rejectAll(err);
    this.onCrash?.(err);
  }

  /** Stops the worker. Pending calls reject with EngineUnavailableError. Idempotent. */
  terminate(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.worker.terminate();
    } finally {
      this.rejectAll(new EngineUnavailableError('Worker stopped'));
    }
  }
}

// ---- worker side ----
export interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
}
export interface HandlerCtx {
  id: number;
  signal: AbortSignal;
  progress(p: number): void;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (payload: any, ctx: HandlerCtx) => Promise<unknown> | unknown;

/** Installs request handling on a worker scope. `cancel {id}` aborts the matching in-flight handler. */
export function serveRpc(scope: WorkerScopeLike, handlers: Partial<Record<Exclude<RequestType, 'cancel'>, Handler>>): void {
  const inflight = new Map<number, AbortController>();
  const reply = (r: RpcReply, transfer?: Transferable[]): void => scope.postMessage(r, transfer ?? []);
  scope.addEventListener('message', (ev) => {
    const req = ev.data as RpcRequest;
    if (!req || typeof req.id !== 'number') return;
    if (req.type === 'cancel') {
      inflight.get(req.id)?.abort();
      return;
    }
    const handler = handlers[req.type];
    if (!handler) {
      reply({ id: req.id, type: 'error', error: { name: 'EngineUnavailableError', message: `Unsupported request: ${req.type}` } });
      return;
    }
    const ac = new AbortController();
    inflight.set(req.id, ac);
    const ctx: HandlerCtx = { id: req.id, signal: ac.signal, progress: (p) => reply({ id: req.id, type: 'progress', payload: p }) };
    void (async () => {
      try {
        const out = await handler(req.payload, ctx);
        if (out instanceof Transferred) reply({ id: req.id, type: 'result', payload: out.value }, out.transfer);
        else reply({ id: req.id, type: 'result', payload: out });
      } catch (e) {
        reply({ id: req.id, type: 'error', error: serializeError(e) });
      } finally {
        inflight.delete(req.id);
      }
    })();
  });
}
