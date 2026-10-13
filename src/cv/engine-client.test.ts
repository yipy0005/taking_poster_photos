import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmapTracker } from '../app/bitmap-handle.ts';
import { DEFAULT_DECODE_CAPS, resetDecodeCapsForTests, setDecodeCaps, type DecodeOpts } from '../app/decode.ts';
import { MARKER_KEY, STRIKES_KEY, configureDecodeGuard, runGuarded, type MetaStore } from '../app/decode-guarded.ts';
import { OutOfMemoryError } from '../app/errors.ts';
import { MemoryGate } from '../app/memory-gate.ts';
import {
  CV_UNAVAILABLE_NOTICE,
  EngineClient,
  NO_MEMORY_MESSAGE,
  type EngineClientDeps,
  type EngineNotice,
  type GuardRunner,
  type RenderJob,
} from './engine-client.ts';
import { createRaster } from './raster2d.ts';
import type { InitPayload, RenderRequest, RenderResult } from './protocol.ts';
import type { Quad } from './geometry.ts';
import { FakeWorker, type Script } from './testing/fake-worker.ts';

const INIT: InitPayload = {
  isIosWebKit: false,
  maxOutputPixels: 16_777_216,
  maxDecodePixels: 25_000_000,
  roiBudget: 3_000_000,
  decodeCaps: DEFAULT_DECODE_CAPS,
};
const QUAD: Quad = [[400, 300], [3600, 300], [3600, 2700], [400, 2700]]; // 3200x2400 of a 4000x3000 frame
const INFO = { width: 4000, height: 3000, orientation: 1 };
const original = new Blob(['x'], { type: 'image/jpeg' });
const JS_QUAD: Quad = [[100, 100], [700, 100], [700, 500], [100, 500]];
const img = createRaster(800, 600);

const okResult = (req: RenderRequest, engine: 'js' | 'opencv', extra: Partial<RenderResult> = {}): RenderResult => ({
  blob: new Blob(['out']),
  width: req.outW,
  height: req.outH,
  reducedSource: false,
  engine,
  ...extra,
});
/** Worker script that answers every request type successfully. */
const healthy =
  (engine: 'js' | 'opencv', detect: { quad: Quad | null; confidence: number; method: string } = { quad: JS_QUAD, confidence: 0.5, method: engine }): Script =>
  (req, api) => {
    if (req.type === 'init') api.result(req.id, { heapBytes: 50 * 1024 * 1024 });
    else if (req.type === 'detect') api.result(req.id, detect);
    else if (req.type === 'render') {
      api.progress(req.id, 0.5);
      api.result(req.id, okResult(req.payload as RenderRequest, engine, { heapBytes: 50 * 1024 * 1024 }));
    }
  };

const job = (over: Partial<RenderJob> = {}): RenderJob => ({
  shotId: 'shot-1',
  original,
  info: INFO,
  quad: QUAD,
  outW: 2000,
  outH: 1500,
  enhance: { autoContrast: false, whiteBalance: false, sharpen: false },
  ...over,
});

interface Rig {
  client: EngineClient;
  js: FakeWorker[];
  cv: FakeWorker[];
  events: string[];
  notices: EngineNotice[];
  runCalls: Array<{ ctx: unknown; opts: unknown }>;
}
function rig(opts: { js?: Script; cv?: Script | null; deps?: Partial<EngineClientDeps>; run?: GuardRunner } = {}): Rig {
  const js: FakeWorker[] = [];
  const cv: FakeWorker[] = [];
  const events: string[] = [];
  const runCalls: Rig['runCalls'] = [];
  const track = (name: string, script: Script, list: FakeWorker[]): FakeWorker => {
    const w = new FakeWorker((req, api, self) => {
      events.push(`${name}:${req.type}`);
      script(req, api, self);
    });
    const terminate = w.terminate.bind(w);
    w.terminate = () => {
      events.push(`${name}:terminate`);
      terminate();
    };
    list.push(w);
    return w;
  };
  const deps: EngineClientDeps = {
    createJsWorker: () => track('js', opts.js ?? healthy('js'), js),
    createOpenCvWorker: opts.cv === null ? undefined : () => track('cv', opts.cv ?? healthy('opencv'), cv),
    cvUrl: () => 'https://example.test/opencv.js',
    initPayload: () => INIT,
    run: opts.run ?? (async (ctx, o, fn) => {
      runCalls.push({ ctx, opts: o });
      return fn(o as DecodeOpts);
    }),
    terminateCvAfterEveryJob: false,
    idleMs: 1_000_000,
    loadTimeoutMs: 50,
    ...opts.deps,
  };
  const client = new EngineClient(deps);
  const notices: EngineNotice[] = [];
  client.onNotice((n) => notices.push(n));
  return { client, js, cv, events, notices, runCalls };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

afterEach(() => vi.useRealTimers());

describe('detect', () => {
  it('returns the JS result immediately, sends the init payload, and copies the raster instead of detaching it', async () => {
    const r = rig();
    const out = await r.client.detect(img);
    expect(out).toMatchObject({ quad: JS_QUAD, found: true, engine: 'js', confidence: 0.5 });
    expect(r.js[0]!.of('init')[0]!.payload).toEqual(INIT);
    expect(img.data.byteLength).toBe(800 * 600 * 4); // not transferred away
    expect(r.cv).toHaveLength(0); // no OpenCV worker without a request
  });
  it('AC-9: substitutes the 8% inset rectangle when nothing is found', async () => {
    const r = rig({ js: healthy('js', { quad: null, confidence: 0, method: 'js-threshold' }) });
    const out = await r.client.detect(img);
    expect(out.found).toBe(false);
    expect(out.quad[0]).toEqual([64, 48]);
    expect(out.quad[2]).toEqual([736, 552]);
  });
  it('offers the OpenCV quad as an upgrade only when it is more confident', async () => {
    const better: Quad = [[110, 105], [690, 95], [705, 510], [95, 495]];
    const r = rig({ cv: healthy('opencv', { quad: better, confidence: 0.9, method: 'cv' }) });
    await r.client.loadOpenCv('user');
    const upgrades: unknown[] = [];
    await r.client.detect(img, { onUpgrade: (u) => upgrades.push(u) });
    await flush();
    expect(upgrades).toMatchObject([{ quad: better, engine: 'opencv' }]);
    const worse = rig({ cv: healthy('opencv', { quad: better, confidence: 0.1, method: 'cv' }) });
    await worse.client.loadOpenCv('user');
    const none: unknown[] = [];
    await worse.client.detect(img, { onUpgrade: (u) => none.push(u) });
    await flush();
    expect(none).toEqual([]);
  });
  it('AC-18 c: OpenCV failing during a background detect keeps the JS quad, shows nothing, marks the engine failed', async () => {
    const crashOnDetect: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'detect') api.crash('wasm died');
    };
    const r = rig({ cv: crashOnDetect });
    await r.client.loadOpenCv('user');
    const upgrades: unknown[] = [];
    const out = await r.client.detect(img, { onUpgrade: (u) => upgrades.push(u) });
    await flush();
    expect(out.quad).toEqual(JS_QUAD);
    expect(upgrades).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.client.getStatus().opencv).toBe('failed');
    expect(r.cv[0]!.terminated).toBe(true);
  });
});

describe('render: guard and decode bound', () => {
  it('runs the main-thread guard (kind rectify, shot id, header info) and sizes the decode like design 2.7 item 8', async () => {
    const r = rig();
    const out = await r.client.render(job());
    const call = r.runCalls[0]!;
    expect(call.ctx).toEqual({ shotId: 'shot-1', kind: 'rectify' });
    // quadFraction = 7.68 MP / 12 MP = 0.64 ; needed = ceil(3e6 / 0.64 * 1.25)
    const needed = Math.ceil((3_000_000 / 0.64) * 1.25);
    expect((call.opts as { maxPixels: number }).maxPixels).toBe(needed);
    expect((call.opts as { info: unknown }).info).toEqual(INFO);
    const req = r.js[0]!.of('render')[0]!.payload as RenderRequest;
    expect(req.sourceMaxPixels).toBe(needed);
    expect(req).toMatchObject({ outW: 2000, outH: 1500, mime: 'image/jpeg', quality: 0.92, info: INFO });
    expect(out).toMatchObject({ engine: 'js', width: 2000, height: 1500, retriedSmaller: false, fellBackFromOpenCv: false });
  });
  it('never asks for more pixels than the source has, and floors quadFraction at 5%', async () => {
    const r = rig();
    await r.client.render(job({ outW: 4000, outH: 3000, quad: [[0, 0], [4000, 0], [4000, 3000], [0, 3000]] }));
    expect((r.runCalls[0]!.opts as { maxPixels: number }).maxPixels).toBe(12_000_000);
    const tiny = rig();
    await tiny.client.render(job({ quad: [[10, 10], [110, 10], [110, 110], [10, 110]], outW: 100, outH: 100 }));
    expect((tiny.runCalls[0]!.opts as { maxPixels: number }).maxPixels).toBe(Math.ceil((10_000 / 0.05) * 1.25));
  });
  it('uses the decode bound the guard returns (strike caps / tier cap)', async () => {
    const capped: GuardRunner = (_ctx, o, fn) => fn({ ...o, maxPixels: 6_000_000 } as DecodeOpts);
    const r = rig({ run: capped });
    await r.client.render(job());
    expect((r.js[0]!.of('render')[0]!.payload as RenderRequest).sourceMaxPixels).toBe(6_000_000);
  });
});

describe('render with the real guard (gate + marker + strikes)', () => {
  class Meta implements MetaStore {
    data = new Map<string, unknown>();
    log: string[] = [];
    async getMeta<T>(k: string) { return this.data.get(k) as T | undefined; }
    async setMeta<T>(k: string, v: T) { this.log.push(`set:${k}`); this.data.set(k, v); }
    async deleteMeta(k: string) { this.log.push(`del:${k}`); this.data.delete(k); }
  }
  beforeEach(() => {
    bitmapTracker.reset();
    resetDecodeCapsForTests();
    setDecodeCaps({ fromImage: true, exifHonored: true, resizeHonored: true, resizeAfterOrient: true });
  });
  it('writes the marker for a >12 MP header, clears it, serialises on the gate and applies a strike cap', async () => {
    const meta = new Meta();
    meta.data.set(STRIKES_KEY, { 'shot-1:render': 1 });
    configureDecodeGuard({ meta, persistMarker: true, tabId: 't', gate: new MemoryGate(), maxDecodePixels: 25_000_000 });
    const r = rig({ run: runGuarded });
    await r.client.render(job({ info: { width: 8000, height: 6000, orientation: 1 }, quad: [[800, 600], [7200, 600], [7200, 5400], [800, 5400]], outW: 4000, outH: 3000 }));
    const req = r.js[0]!.of('render')[0]!.payload as RenderRequest;
    expect(req.sourceMaxPixels).toBeLessThanOrEqual(12_000_000); // one strike => 12 MP
    expect(meta.log).toContain(`set:${MARKER_KEY}`);
    expect(meta.log.at(-1)).not.toBe(`set:${MARKER_KEY}`);
    expect(meta.data.has(MARKER_KEY)).toBe(false);
    expect(meta.data.get(STRIKES_KEY)).toEqual({ 'shot-1:render': 1 }); // capped success keeps the strike
  });
});

describe('progress and cancel (AC-19)', () => {
  it('forwards progress and returns the engine result', async () => {
    const r = rig();
    const seen: number[] = [];
    await r.client.render(job({ onProgress: (p) => seen.push(p) }));
    expect(seen).toEqual([0.5]);
  });
  it('cancel posts cancel with the render id, rejects with AbortError and later replies are ignored', async () => {
    const never: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
    };
    const r = rig({ js: never });
    const ac = new AbortController();
    const p = r.client.render(job({ signal: ac.signal }));
    await vi.waitFor(() => expect(r.js[0]?.of('render')).toHaveLength(1));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const renderId = r.js[0]!.of('render')[0]!.id;
    await flush();
    expect(r.js[0]!.of('cancel').map((c) => c.id)).toEqual([renderId]);
    expect(r.js[0]!.terminated).toBe(false);
  });
});

describe('AC-18 a: OpenCV out of memory during render', () => {
  const oomOnRender: Script = (req, api) => {
    if (req.type === 'init') api.result(req.id, {});
    else if (req.type === 'render') {
      api.progress(req.id, 0.4);
      api.error(req.id, 'OutOfMemoryError', 'wasm heap');
    }
  };
  it('terminates the worker BEFORE the JS retry, retries the identical request on JS with progress reset, notifies once', async () => {
    const r = rig({ cv: oomOnRender });
    await r.client.loadOpenCv('user');
    const seen: number[] = [];
    const out = await r.client.render(job({ onProgress: (p) => seen.push(p) }));
    expect(out).toMatchObject({ engine: 'js', fellBackFromOpenCv: true, retriedSmaller: false });
    expect(r.events.indexOf('cv:terminate')).toBeGreaterThan(-1);
    expect(r.events.indexOf('cv:terminate')).toBeLessThan(r.events.indexOf('js:render'));
    expect(r.cv[0]!.of('render')[0]!.payload).toEqual(r.js[0]!.of('render')[0]!.payload);
    expect(seen).toEqual([0.4, 0, 0.5]); // progress reset to 0 before the JS attempt
    expect(r.client.getStatus()).toMatchObject({ opencv: 'failed', lastEngine: 'js' });
    expect(r.notices).toEqual([{ id: 'cv-unavailable', message: CV_UNAVAILABLE_NOTICE }]);
    // a second job: JS directly, no second notice
    await r.client.render(job());
    expect(r.cv).toHaveLength(1);
    expect(r.notices).toHaveLength(1);
  });
  it('a worker crash is handled the same way', async () => {
    const crash: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'render') api.crash();
    };
    const r = rig({ cv: crash });
    await r.client.loadOpenCv('user');
    const out = await r.client.render(job());
    expect(out.engine).toBe('js');
    expect(r.client.getStatus().opencv).toBe('failed');
  });
});

describe('AC-18 b: user cancels during an OpenCV render', () => {
  it('AbortError, no JS retry, no notice, engine state unchanged', async () => {
    const slow: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
    };
    const r = rig({ cv: slow });
    await r.client.loadOpenCv('user');
    const ac = new AbortController();
    const p = r.client.render(job({ signal: ac.signal }));
    await vi.waitFor(() => expect(r.cv[0]?.of('render')).toHaveLength(1));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(r.js).toHaveLength(0);
    expect(r.notices).toEqual([]);
    expect(r.client.getStatus().opencv).toBe('ready');
    expect(r.cv[0]!.of('cancel')).toHaveLength(1);
    expect(r.cv[0]!.terminated).toBe(false);
  });
});

describe('OpenCV state machine', () => {
  it('uses OpenCV only when ready; never waits on a pending load', async () => {
    const r = rig();
    await r.client.render(job());
    expect(r.cv).toHaveLength(0);
    expect(r.client.getStatus().lastEngine).toBe('js');
    await r.client.loadOpenCv('user');
    expect(r.client.getStatus().opencv).toBe('ready');
    expect((await r.client.render(job())).engine).toBe('opencv');
    expect(r.cv[0]!.sent.find((m) => m.type === 'init')!.payload).toMatchObject({ cvUrl: 'https://example.test/opencv.js' });
  });
  it('idle -> loading -> ready is observable', async () => {
    const r = rig();
    const states: string[] = [];
    r.client.onChange(() => states.push(r.client.getStatus().opencv));
    const p = r.client.loadOpenCv('auto');
    expect(r.client.getStatus().opencv).toBe('loading');
    expect(await p).toBe(true);
    expect(states).toEqual(['loading', 'ready']);
    expect(await r.client.loadOpenCv('auto')).toBe(true);
    expect(r.cv).toHaveLength(1);
  });
  it('a silent background (auto) load failure sets failed without a notice; a user-requested one shows it once', async () => {
    const bad: Script = (req, api) => {
      if (req.type === 'init') api.error(req.id, 'EngineUnavailableError', 'wasm compile failed');
    };
    const auto = rig({ cv: bad });
    expect(await auto.client.loadOpenCv('auto')).toBe(false);
    expect(auto.client.getStatus().opencv).toBe('failed');
    expect(auto.notices).toEqual([]);
    const user = rig({ cv: bad });
    await user.client.loadOpenCv('user');
    expect(user.notices).toHaveLength(1);
    expect(await user.client.loadOpenCv('user')).toBe(false); // failed persists
    expect(user.cv).toHaveLength(1);
  });
  it('a load that never answers times out and fails', async () => {
    const r = rig({ cv: () => {} });
    expect(await r.client.loadOpenCv('auto')).toBe(false);
    expect(r.client.getStatus().opencv).toBe('failed');
    expect(r.cv[0]!.terminated).toBe(true);
  });
  it('without a registered OpenCV engine nothing loads', async () => {
    const r = rig({ cv: null });
    expect(await r.client.loadOpenCv('user')).toBe(false);
    expect(r.client.getStatus().opencv).toBe('idle');
  });
  it('a cv exception retries on JS silently; two consecutive ones fail the engine and show the notice', async () => {
    const cvErr: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'render') api.error(req.id, 'CvError', 'bad Mat');
    };
    const r = rig({ cv: cvErr });
    await r.client.loadOpenCv('user');
    const first = await r.client.render(job());
    expect(first).toMatchObject({ engine: 'js', fellBackFromOpenCv: true });
    expect(r.client.getStatus()).toMatchObject({ opencv: 'ready', cvStrikes: 1 });
    expect(r.notices).toEqual([]);
    expect(r.cv[0]!.terminated).toBe(true); // Mat state unknown: recreate lazily
    await r.client.render(job());
    expect(r.client.getStatus()).toMatchObject({ opencv: 'failed', cvStrikes: 2 });
    expect(r.notices).toHaveLength(1);
    expect(r.cv).toHaveLength(2);
  });
  it('a success resets the consecutive-strike count', async () => {
    let n = 0;
    const flaky: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'render') {
        if (n++ % 2 === 0) api.error(req.id, 'CvError', 'bad Mat');
        else api.result(req.id, okResult(req.payload as RenderRequest, 'opencv'));
      }
    };
    const r = rig({ cv: flaky });
    await r.client.loadOpenCv('user');
    await r.client.render(job());
    expect((await r.client.render(job())).engine).toBe('opencv');
    expect(r.client.getStatus()).toMatchObject({ opencv: 'ready', cvStrikes: 0 });
  });
  it('AC-45: resetOpenCv() moves failed -> idle, clears strikes and downloads nothing', async () => {
    const oom: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'render') api.error(req.id, 'OutOfMemoryError');
    };
    const r = rig({ cv: oom });
    await r.client.loadOpenCv('auto');
    await r.client.render(job());
    expect(r.client.getStatus().opencv).toBe('failed');
    const workersBefore = r.cv.length;
    r.client.resetOpenCv();
    expect(r.client.getStatus()).toMatchObject({ opencv: 'idle', cvStrikes: 0, lastRequestedBy: 'user' });
    expect(r.cv).toHaveLength(workersBefore); // no worker created, nothing downloaded
    expect(await r.client.loadOpenCv('user')).toBe(true); // next explicit request tries again
    expect(r.cv).toHaveLength(workersBefore + 1);
  });
  it('recycles the OpenCV worker after every job on iOS, and when the heap grew past 192 MB', async () => {
    const ios = rig({ deps: { terminateCvAfterEveryJob: true } });
    await ios.client.loadOpenCv('user');
    expect(ios.cv[0]!.terminated).toBe(false);
    await ios.client.render(job());
    expect(ios.cv[0]!.terminated).toBe(true);
    const fat: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, { heapBytes: 10 });
      else if (req.type === 'render') api.result(req.id, okResult(req.payload as RenderRequest, 'opencv', { heapBytes: 300 * 1024 * 1024 }));
    };
    const big = rig({ cv: fat });
    await big.client.loadOpenCv('user');
    await big.client.render(job());
    expect(big.cv[0]!.terminated).toBe(true);
    const small = rig();
    await small.client.loadOpenCv('user');
    await small.client.render(job());
    expect(small.cv[0]!.terminated).toBe(false);
    // a recycled worker is recreated lazily for the next job
    await big.client.render(job());
    expect(big.cv).toHaveLength(2);
  });
});

describe('overlapping OpenCV jobs', () => {
  it('a finishing background detect does not recycle the worker under a render that is still running', async () => {
    let finishRender: (() => void) | undefined;
    const slow: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {}); // heap unknown: recycle after every job
      else if (req.type === 'detect') api.result(req.id, { quad: JS_QUAD, confidence: 0.9, method: 'opencv' });
      else if (req.type === 'render') finishRender = () => api.result(req.id, okResult(req.payload as RenderRequest, 'opencv'));
    };
    const r = rig({ cv: slow });
    await r.client.loadOpenCv('user');
    const rendering = r.client.render(job());
    await flush();
    expect(r.cv[0]!.of('render')).toHaveLength(1);
    await r.client.detect(img); // background OpenCV detect completes while the render is running
    await flush();
    expect(r.cv[0]!.terminated).toBe(false);
    finishRender!();
    expect((await rendering).engine).toBe('opencv');
    expect(r.cv[0]!.terminated).toBe(true); // recycled once the last job finished
    expect(r.client.getStatus().opencv).toBe('ready');
  });
});
describe('memory retries (design 2.7 item 9)', () => {
  const oomTimes = (n: number): Script => {
    let seen = 0;
    return (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'render') {
        if (seen++ < n) api.error(req.id, 'OutOfMemoryError', 'canvas');
        else api.result(req.id, okResult(req.payload as RenderRequest, 'js'));
      }
    };
  };
  it('retries once at 0.7x per axis with half the decode bound and says so', async () => {
    const r = rig({ js: oomTimes(1) });
    const seen: number[] = [];
    const out = await r.client.render(job({ onProgress: (p) => seen.push(p) }));
    const [first, second] = r.js[0]!.of('render').map((m) => m.payload as RenderRequest);
    expect([second!.outW, second!.outH]).toEqual([1400, 1050]);
    expect(second!.sourceMaxPixels).toBe(Math.floor(first!.sourceMaxPixels! / 2));
    expect(out).toMatchObject({ width: 1400, height: 1050, retriedSmaller: true });
    expect(seen).toEqual([0]);
    expect(r.notices.map((n) => n.id)).toEqual(['smaller-render']);
  });
  it('a second failure surfaces "Not enough memory to render at full resolution"', async () => {
    const r = rig({ js: oomTimes(5) });
    await expect(r.client.render(job())).rejects.toThrow(NO_MEMORY_MESSAGE);
    await expect(r.client.render(job())).rejects.toBeInstanceOf(OutOfMemoryError);
  });
  it('a crashed JS worker counts as a memory failure and is recreated', async () => {
    let crashed = false;
    const crashOnce: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'render') {
        if (!crashed) {
          crashed = true;
          api.crash();
        } else api.result(req.id, okResult(req.payload as RenderRequest, 'js'));
      }
    };
    const r = rig({ js: crashOnce });
    const out = await r.client.render(job());
    expect(out.retriedSmaller).toBe(true);
    expect(r.js).toHaveLength(2);
  });
  it('other errors are not retried', async () => {
    const bad: Script = (req, api) => {
      if (req.type === 'init') api.result(req.id, {});
      else if (req.type === 'render') api.error(req.id, 'DecodeError', "Can't read this image");
    };
    const r = rig({ js: bad });
    await expect(r.client.render(job())).rejects.toThrow("Can't read this image");
    expect(r.js[0]!.of('render')).toHaveLength(1);
  });
});

describe('worker lifecycle', () => {
  it('terminates an idle worker after the idle timeout and dispose() stops everything', async () => {
    vi.useFakeTimers();
    const r = rig({ deps: { idleMs: 60_000 } });
    const p = r.client.render(job());
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(r.js[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(r.js[0]!.terminated).toBe(true);
    const p2 = r.client.render(job());
    await vi.advanceTimersByTimeAsync(10);
    await p2;
    expect(r.js).toHaveLength(2);
    r.client.dispose();
    expect(r.js[1]!.terminated).toBe(true);
  });
});
