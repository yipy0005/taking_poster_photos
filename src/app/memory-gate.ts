// Heavy-job semaphore (concurrency 1) with suspend/resume holders (design 2.7 item 1, plan.md finding 8).
// Main-thread only.
import { GATE_RESUME_DEBOUNCE_MS } from './config.ts';
import { log } from './log.ts';

export type GatePriority = 'normal' | 'low';

/** An object that keeps a big bitmap alive (the viewer) and can drop it while a heavy job runs. */
export interface GateHolder {
  id: string;
  suspend(): Promise<void>;
  /** Called fire-and-forget after the gate is released. The holder re-acquires the gate itself with priority 'normal'. */
  resume(): Promise<void>;
}

export interface AcquireOpts {
  priority?: GatePriority;
  /** The caller is already inside a gated job: return immediately without queueing. */
  gateHeld?: boolean;
  /** The named holder is not suspended because the job borrows its bitmap (rotated share, 2.13). */
  borrowsHolder?: string;
  /** The acquiring party is this holder (its own re-acquire): it is not suspended for its own job. */
  holderId?: string;
  signal?: AbortSignal;
}

export interface GateTicket {
  /** Idempotent. */
  release(): void;
}

interface Waiter {
  opts: AcquireOpts;
  grant: (t: GateTicket) => void;
  fail: (e: unknown) => void;
  onAbort?: () => void;
}

const NOOP_TICKET: GateTicket = { release() {} };

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export class MemoryGate {
  private running = false;
  private readonly normalQ: Waiter[] = [];
  private readonly lowQ: Waiter[] = [];
  private readonly holders = new Map<string, GateHolder>();
  private readonly suspended = new Set<string>();
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;

  registerHolder(holder: GateHolder): () => void {
    this.holders.set(holder.id, holder);
    return () => {
      this.holders.delete(holder.id);
      this.suspended.delete(holder.id);
    };
  }

  get busy(): boolean {
    return this.running;
  }
  get waiting(): number {
    return this.normalQ.length + this.lowQ.length;
  }

  acquire(opts: AcquireOpts = {}): Promise<GateTicket> {
    if (opts.gateHeld) return Promise.resolve(NOOP_TICKET);
    if (opts.signal?.aborted) return Promise.reject(abortError());
    return new Promise<GateTicket>((resolve, reject) => {
      const w: Waiter = { opts, grant: resolve, fail: reject };
      if (opts.signal) {
        w.onAbort = () => {
          const q = (opts.priority ?? 'normal') === 'low' ? this.lowQ : this.normalQ;
          const i = q.indexOf(w);
          if (i >= 0) {
            q.splice(i, 1);
            reject(abortError());
          }
        };
        opts.signal.addEventListener('abort', w.onAbort, { once: true });
      }
      ((opts.priority ?? 'normal') === 'low' ? this.lowQ : this.normalQ).push(w);
      void this.pump();
    });
  }

  private nextWaiter(): Waiter | undefined {
    // Low priority is granted only when nothing runs and no normal waiter is queued.
    return this.normalQ.shift() ?? this.lowQ.shift();
  }

  private async pump(): Promise<void> {
    if (this.running || this.pumping) return;
    const w = this.nextWaiter();
    if (!w) return;
    this.pumping = true;
    this.running = true;
    this.cancelResume();
    if (w.opts.signal && w.onAbort) w.opts.signal.removeEventListener('abort', w.onAbort);
    try {
      for (const h of Array.from(this.holders.values())) {
        if (h.id === w.opts.borrowsHolder || h.id === w.opts.holderId) continue;
        if (this.suspended.has(h.id)) continue;
        try {
          await h.suspend();
        } catch (e) {
          log.warn('holder suspend failed', h.id, e);
        }
        this.suspended.add(h.id);
      }
    } finally {
      this.pumping = false;
    }
    let released = false;
    w.grant({
      release: () => {
        if (released) return;
        released = true;
        this.running = false;
        this.scheduleResume();
        void this.pump();
      },
    });
  }

  private cancelResume(): void {
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private scheduleResume(): void {
    this.cancelResume();
    if (this.suspended.size === 0) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.running || this.waiting > 0) return; // a new job will suspend again; resume after that one
      for (const id of Array.from(this.suspended)) {
        this.suspended.delete(id);
        const h = this.holders.get(id);
        if (!h) continue;
        // fire-and-forget: the holder re-acquires the gate itself
        void h.resume().catch((e: unknown) => log.warn('holder resume failed', id, e));
      }
    }, GATE_RESUME_DEBOUNCE_MS);
  }

  /** Test hook. */
  reset(): void {
    this.cancelResume();
    this.running = false;
    this.pumping = false;
    this.normalQ.length = 0;
    this.lowQ.length = 0;
    this.holders.clear();
    this.suspended.clear();
  }
}

/** The app-wide gate. */
export const memoryGate = new MemoryGate();
