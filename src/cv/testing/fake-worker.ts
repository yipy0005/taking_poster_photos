// Test support (not imported by app code): a scripted fake Worker for engine-client / rpc tests.
import type { RpcReply, RpcRequest } from '../protocol.ts';
import type { WorkerLike } from '../rpc.ts';

export interface FakeWorkerApi {
  result(id: number, payload?: unknown): void;
  progress(id: number, p: number): void;
  error(id: number, name: string, message?: string): void;
  /** Fires the worker 'error' event. */
  crash(message?: string): void;
}
export type Script = (req: RpcRequest, api: FakeWorkerApi, worker: FakeWorker) => void;

export class FakeWorker implements WorkerLike {
  sent: RpcRequest[] = [];
  terminated = false;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  readonly api: FakeWorkerApi;
  constructor(private readonly script: Script) {
    const reply = (r: RpcReply): void => {
      if (this.terminated) return;
      queueMicrotask(() => this.emit('message', { data: r }));
    };
    this.api = {
      result: (id, payload) => reply({ id, type: 'result', payload }),
      progress: (id, p) => reply({ id, type: 'progress', payload: p }),
      error: (id, name, message = name) => reply({ id, type: 'error', error: { name, message } }),
      crash: (message = 'worker crashed') => queueMicrotask(() => this.emit('error', { message })),
    };
  }
  postMessage(message: unknown): void {
    const req = message as RpcRequest;
    this.sent.push(req);
    queueMicrotask(() => {
      if (!this.terminated) this.script(req, this.api, this);
    });
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
  of(type: RpcRequest['type']): RpcRequest[] {
    return this.sent.filter((r) => r.type === type);
  }
}
