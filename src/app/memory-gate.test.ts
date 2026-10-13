import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitmapHandle, bitmapTracker } from './bitmap-handle.ts';
import { MemoryGate, type GateHolder } from './memory-gate.ts';

function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close() {} } as unknown as ImageBitmap;
}
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('MemoryGate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bitmapTracker.reset();
  });
  afterEach(() => vi.useRealTimers());

  it('runs one heavy job at a time, FIFO', async () => {
    const gate = new MemoryGate();
    const order: string[] = [];
    const t1 = await gate.acquire();
    const p2 = gate.acquire().then((t) => {
      order.push('second');
      return t;
    });
    await flush();
    expect(order).toEqual([]);
    t1.release();
    const t2 = await p2;
    expect(order).toEqual(['second']);
    t2.release();
  });

  it('grants low priority only when no normal waiter is queued', async () => {
    const gate = new MemoryGate();
    const order: string[] = [];
    const t0 = await gate.acquire();
    const low = gate.acquire({ priority: 'low' }).then((t) => (order.push('low'), t));
    const normal = gate.acquire().then((t) => (order.push('normal'), t));
    t0.release();
    const tn = await normal;
    await flush();
    expect(order).toEqual(['normal']);
    tn.release();
    (await low).release();
    expect(order).toEqual(['normal', 'low']);
  });

  it('gateHeld re-entry returns immediately without queueing', async () => {
    const gate = new MemoryGate();
    const t = await gate.acquire();
    const inner = await gate.acquire({ gateHeld: true });
    inner.release();
    expect(gate.busy).toBe(true);
    t.release();
  });

  it('suspends holders before a job and resumes them fire-and-forget, debounced 500 ms', async () => {
    const gate = new MemoryGate();
    const calls: string[] = [];
    const holder: GateHolder = {
      id: 'viewer',
      suspend: async () => void calls.push('suspend'),
      resume: async () => void calls.push('resume'),
    };
    gate.registerHolder(holder);
    const t = await gate.acquire();
    expect(calls).toEqual(['suspend']);
    t.release();
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toEqual(['suspend']);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toEqual(['suspend', 'resume']);
  });

  it('a new job cancels a pending resume (no resume between back-to-back jobs)', async () => {
    const gate = new MemoryGate();
    const calls: string[] = [];
    gate.registerHolder({
      id: 'viewer',
      suspend: async () => void calls.push('suspend'),
      resume: async () => void calls.push('resume'),
    });
    (await gate.acquire()).release();
    await vi.advanceTimersByTimeAsync(300);
    const t2 = await gate.acquire();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual(['suspend']);
    t2.release();
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toEqual(['suspend', 'resume']);
  });

  it('does not suspend the holder that borrows or owns the job', async () => {
    const gate = new MemoryGate();
    const suspend = vi.fn(async () => {});
    gate.registerHolder({ id: 'viewer', suspend, resume: async () => {} });
    (await gate.acquire({ borrowsHolder: 'viewer' })).release();
    (await gate.acquire({ holderId: 'viewer' })).release();
    expect(suspend).not.toHaveBeenCalled();
  });

  it('a failing resume does not throw into the release path', async () => {
    const gate = new MemoryGate();
    gate.registerHolder({ id: 'v', suspend: async () => {}, resume: async () => Promise.reject(new Error('boom')) });
    (await gate.acquire()).release();
    await vi.advanceTimersByTimeAsync(600);
    expect(gate.busy).toBe(false);
  });

  it('rejects an aborted waiter with AbortError', async () => {
    const gate = new MemoryGate();
    const t = await gate.acquire();
    const ac = new AbortController();
    const p = gate.acquire({ signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    t.release();
  });

  it('AC-37 tracker: live full-resolution bitmaps never exceed 1 while a gated job runs, with a viewer holder', async () => {
    const gate = new MemoryGate();
    let viewerFull: BitmapHandle | null = new BitmapHandle(fakeBitmap(4000, 3000), 'viewer-full');
    gate.registerHolder({
      id: 'viewer',
      suspend: async () => {
        viewerFull?.close();
        viewerFull = null;
      },
      resume: async () => {
        const t = await gate.acquire({ holderId: 'viewer' });
        try {
          viewerFull = new BitmapHandle(fakeBitmap(4000, 3000), 'viewer-full');
        } finally {
          t.release();
        }
      },
    });
    expect(bitmapTracker.liveFullCount()).toBe(1);

    const t = await gate.acquire();
    const jobBitmap = new BitmapHandle(fakeBitmap(5000, 4000), 'export-decode');
    expect(bitmapTracker.liveFullCount()).toBe(1);
    jobBitmap.close();
    t.release();
    await vi.advanceTimersByTimeAsync(600);
    expect(viewerFull).not.toBeNull();
    expect(bitmapTracker.liveFullCount()).toBe(1);
    expect(bitmapTracker.peakFull()).toBeLessThanOrEqual(1);
  });
});
