import { describe, expect, it } from 'vitest';
import { CvError, EngineCrashError, EngineUnavailableError, OutOfMemoryError } from '../app/errors.ts';
import { RpcClient, Transferred, serializeError, serveRpc, type WorkerLike, type WorkerScopeLike } from './rpc.ts';

/** Client <-> serveRpc connected in-process; delivery is asynchronous like a real worker. */
class Loopback implements WorkerLike {
  private scopeListeners: Array<(ev: { data: unknown }) => void> = [];
  private clientListeners: Record<string, Array<(ev: unknown) => void>> = {};
  terminated = false;
  readonly scope: WorkerScopeLike = {
    postMessage: (m) => queueMicrotask(() => this.clientListeners['message']?.forEach((l) => l({ data: m }))),
    addEventListener: (_t, l) => void this.scopeListeners.push(l),
  };
  postMessage(m: unknown): void {
    queueMicrotask(() => this.scopeListeners.forEach((l) => l({ data: m })));
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, l: (ev: unknown) => void): void {
    (this.clientListeners[type] ??= []).push(l);
  }
  fire(type: string, ev: unknown): void {
    this.clientListeners[type]?.forEach((l) => l(ev));
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('RpcClient + serveRpc', () => {
  it('returns results and forwards progress', async () => {
    const w = new Loopback();
    serveRpc(w.scope, {
      render: async (p: { n: number }, ctx) => {
        ctx.progress(0.5);
        return { doubled: p.n * 2 };
      },
    });
    const c = new RpcClient(w);
    const seen: number[] = [];
    await expect(c.call('render', { n: 21 }, { onProgress: (p) => seen.push(p) })).resolves.toEqual({ doubled: 42 });
    expect(seen).toEqual([0.5]);
  });

  it('revives typed errors and maps allocation failures to OutOfMemoryError', async () => {
    const w = new Loopback();
    serveRpc(w.scope, {
      detect: () => {
        throw new CvError('assertion failed');
      },
      render: () => {
        throw new RangeError('Array buffer allocation failed');
      },
    });
    const c = new RpcClient(w);
    await expect(c.call('detect', null)).rejects.toBeInstanceOf(CvError);
    await expect(c.call('render', null)).rejects.toBeInstanceOf(OutOfMemoryError);
    await expect(c.call('init', null)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(serializeError(new Error('Out of memory in wasm'))).toEqual({ name: 'OutOfMemoryError', message: 'Out of memory in wasm' });
  });

  it('abort sends cancel with the same id, aborts the handler signal and rejects with AbortError at once', async () => {
    const w = new Loopback();
    let handlerSignal: AbortSignal | undefined;
    let seenId = 0;
    serveRpc(w.scope, {
      render: (_p, ctx) => {
        handlerSignal = ctx.signal;
        seenId = ctx.id;
        return new Promise(() => {});
      },
    });
    const c = new RpcClient(w);
    const ac = new AbortController();
    const p = c.call('render', null, { signal: ac.signal });
    await tick();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(handlerSignal?.aborted).toBe(true);
    expect(seenId).toBeGreaterThan(0);
    // an already aborted signal never posts
    await expect(c.call('render', null, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('transfers buffers via Transferred', async () => {
    const w = new Loopback();
    const sent: Transferable[][] = [];
    const scope: WorkerScopeLike = { ...w.scope, postMessage: (m, t) => { sent.push(t ?? []); w.scope.postMessage(m, t); } };
    serveRpc(scope, { detect: () => new Transferred({ ok: true }, [new ArrayBuffer(8)]) });
    await new RpcClient(w).call('detect', null);
    expect(sent.at(-1)).toHaveLength(1);
  });

  it('a worker error event rejects pending calls with EngineCrashError and calls onCrash once', async () => {
    const w = new Loopback();
    const c = new RpcClient(w);
    let crashes = 0;
    c.onCrash = () => crashes++;
    const p = c.call('render', null);
    w.fire('error', { message: 'boom' });
    w.fire('messageerror', {});
    await expect(p).rejects.toBeInstanceOf(EngineCrashError);
    expect(crashes).toBe(1);
    expect(c.alive).toBe(false);
    await expect(c.call('render', null)).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it('terminate() stops the worker and rejects pending calls', async () => {
    const w = new Loopback();
    const c = new RpcClient(w);
    const p = c.call('render', null);
    c.terminate();
    c.terminate();
    await expect(p).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(w.terminated).toBe(true);
  });
});
