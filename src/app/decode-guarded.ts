// decodeGuarded(): main-thread wrapper around decodeRaw that owns the memory gate, the heavy-decode marker
// and the strike caps (design 2.7 items 1, 8, 9; plan.md findings 1, 8, 11). Never import this from a worker.
import {
  HEAVY_DECODE_PIXELS,
  PREVIEW_STRIKE_LONG_EDGE,
  RENDER_STRIKE_MAX_PIXELS,
  readDeviceEnv,
  deviceTier,
  type StrikeGroup,
} from './config.ts';
import { decodeRaw, type DecodeOpts, type DecodeResult } from './decode.ts';
import { ensureDecodeCaps } from './decode-caps.ts';
import { DecodeSkippedError } from './errors.ts';
import { log } from './log.ts';
import { memoryGate, type GatePriority, type MemoryGate } from './memory-gate.ts';

export type DecodeKind = 'rectify' | 'view' | 'preview' | 'thumb' | 'normalize' | 'reduce' | 'export';

export interface GuardCtx {
  /** null for ingest normalise/reduce before a shot exists; the strike key is then '-:ingest'. */
  shotId: string | null;
  kind: DecodeKind;
}

export interface GuardedOpts extends DecodeOpts {
  /** Caller is already inside a gated job (engine-client.render passes true). */
  gateHeld?: boolean;
  priority?: GatePriority;
  borrowsHolder?: string;
  holderId?: string;
  signal?: AbortSignal;
}

export interface HeavyMarker {
  tabId: string;
  shotId: string | null;
  kind: DecodeKind;
  startedAt: number;
}

/** Subset of Store used here (app/ must not import storage/). */
export interface MetaStore {
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
  deleteMeta(key: string): Promise<void>;
}

export const MARKER_KEY = 'heavyDecodeInFlight';
export const STRIKES_KEY = 'memoryStrikes';
export type StrikeMap = Record<string, number>;

interface GuardDeps {
  meta: MetaStore | null;
  /** False in session-only mode: nothing could be restored after a kill, so no marker is persisted. */
  persistMarker: boolean;
  tabId: string;
  gate: MemoryGate;
  /** Override for tests; defaults to the device tier. */
  maxDecodePixels?: number;
}

let deps: GuardDeps = { meta: null, persistMarker: false, tabId: 'unconfigured', gate: memoryGate };

export function configureDecodeGuard(next: Partial<GuardDeps>): void {
  deps = { ...deps, ...next };
}

export function strikeGroup(kind: DecodeKind): StrikeGroup {
  switch (kind) {
    case 'rectify':
    case 'view':
    case 'export':
    case 'reduce':
      return 'render';
    case 'preview':
      return 'preview';
    case 'thumb':
      return 'thumb';
    case 'normalize':
      return 'ingest';
  }
}

export function strikeKey(shotId: string | null, kind: DecodeKind): string {
  const group = strikeGroup(kind);
  return `${shotId ?? '-'}:${group}`;
}

async function readStrikes(): Promise<StrikeMap> {
  if (!deps.meta) return {};
  try {
    return (await deps.meta.getMeta<StrikeMap>(STRIKES_KEY)) ?? {};
  } catch (e) {
    log.warn('could not read memory strikes', e);
    return {};
  }
}

async function writeStrikes(map: StrikeMap): Promise<void> {
  if (!deps.meta) return;
  try {
    await deps.meta.setMeta(STRIKES_KEY, map);
  } catch (e) {
    log.warn('could not write memory strikes', e);
  }
}

const clampIndex = (n: number, len: number) => Math.min(Math.max(n, 0), len - 1);

/** Applies the strike caps and tier bounds to the options. Pure. */
export function applyStrikeCaps(
  kind: DecodeKind,
  strikes: number,
  opts: DecodeOpts,
  maxDecodePixels: number,
): { opts: DecodeOpts; capped: boolean } {
  const out: DecodeOpts = { ...opts };
  let capped = false;
  const group = strikeGroup(kind);

  if (group === 'render' || group === 'ingest') {
    const strikeCap = RENDER_STRIKE_MAX_PIXELS[clampIndex(strikes, RENDER_STRIKE_MAX_PIXELS.length)] ?? Infinity;
    // normalize/reduce carry their own explicit bound (maxLongEdge 8192); the tier bound applies to everything else.
    const tierCap = kind === 'normalize' || kind === 'reduce' ? Infinity : maxDecodePixels;
    const cap = Math.min(strikeCap, tierCap);
    if (Number.isFinite(cap)) {
      const requested = out.maxPixels ?? Infinity;
      if (cap < requested) out.maxPixels = cap;
      // binding only if the source is actually larger than the strike cap (unknown size: assume it is)
      const srcPx = opts.info ? opts.info.width * opts.info.height : Infinity;
      if (strikeCap < Math.min(requested, tierCap) && srcPx > strikeCap) capped = true;
    }
  } else if (group === 'preview') {
    const cap = PREVIEW_STRIKE_LONG_EDGE[clampIndex(strikes, PREVIEW_STRIKE_LONG_EDGE.length)] ?? 2048;
    const requested = out.maxLongEdge ?? Infinity;
    if (cap < requested) out.maxLongEdge = cap;
    const srcLong = opts.info ? Math.max(opts.info.width, opts.info.height) : Infinity;
    if (strikes > 0 && cap < requested && srcLong > cap) capped = true;
    const tier = maxDecodePixels;
    if ((out.maxPixels ?? Infinity) > tier) out.maxPixels = tier;
  } else {
    // thumb
    const tier = maxDecodePixels;
    if ((out.maxPixels ?? Infinity) > tier) out.maxPixels = tier;
  }
  return { opts: out, capped };
}

/** Header pixel count above HEAVY_DECODE_PIXELS, or unknown dimensions, counts as heavy. */
export function isHeavy(opts: DecodeOpts): boolean {
  const info = opts.info;
  if (!info) return true;
  return info.width * info.height > HEAVY_DECODE_PIXELS;
}

/** Full-bitmap kinds go through the gate even at <= 12 MP (finding 8). */
function needsGate(kind: DecodeKind, heavy: boolean): boolean {
  return heavy || kind === 'view' || kind === 'rectify' || kind === 'export';
}

/**
 * Runs `fn` under the full guard: decode caps probe, strike caps, memory gate, heavy-decode marker (design 2.7 items 1, 8, 9).
 * `fn` receives the capped options (maxPixels / maxLongEdge). decodeGuarded() is this with decodeRaw as `fn`;
 * engine-client.render uses it to guard a worker job on the main thread BEFORE posting it (plan.md finding 1).
 */
export async function runGuarded<T>(ctx: GuardCtx, opts: GuardedOpts, fn: (capped: DecodeOpts) => Promise<T>): Promise<T> {
  await ensureDecodeCaps();
  const key = strikeKey(ctx.shotId, ctx.kind);
  const group = strikeGroup(ctx.kind);
  const strikeMap = await readStrikes();
  const strikes = strikeMap[key] ?? 0;
  if (group === 'thumb' && strikes >= 1) {
    throw new DecodeSkippedError('Thumbnail skipped after a memory problem');
  }
  const { gateHeld, priority, borrowsHolder, holderId, signal, ...decodeOpts } = opts;
  const { opts: capped, capped: wasCapped } = applyStrikeCaps(ctx.kind, strikes, decodeOpts, deps.maxDecodePixels ?? deviceTier(readDeviceEnv()).maxDecodePixels);
  const heavy = isHeavy(capped);
  const gated = needsGate(ctx.kind, heavy);
  const ticket = gated
    ? await deps.gate.acquire({
        priority: priority ?? (ctx.kind === 'thumb' ? 'low' : 'normal'),
        gateHeld,
        borrowsHolder,
        holderId,
        signal,
      })
    : null;
  let markerWritten = false;
  try {
    if (heavy && deps.persistMarker && deps.meta) {
      try {
        const marker: HeavyMarker = { tabId: deps.tabId, shotId: ctx.shotId, kind: ctx.kind, startedAt: Date.now() };
        await deps.meta.setMeta(MARKER_KEY, marker);
        markerWritten = true;
      } catch (e) {
        log.warn('could not write heavy-decode marker; continuing', e);
      }
    }
    const result = await fn(capped);
    // A completion that was NOT shrunk by a strike cap resets the group's counter. A capped completion keeps it,
    // otherwise the next attempt would go back to full size and crash again (plan deviation, see FEAT-001 findings).
    if (strikes > 0 && !wasCapped) {
      const fresh = await readStrikes();
      delete fresh[key];
      await writeStrikes(fresh);
    }
    return result;
  } finally {
    if (markerWritten && deps.meta) {
      try {
        await deps.meta.deleteMeta(MARKER_KEY);
      } catch (e) {
        log.warn('could not clear heavy-decode marker', e);
      }
    }
    ticket?.release();
  }
}

export function decodeGuarded(blob: Blob, opts: GuardedOpts, ctx: GuardCtx): Promise<DecodeResult> {
  return runGuarded(ctx, opts, (capped) => decodeRaw(blob, capped));
}
// ---- Tab lock and startup check (plan.md finding 11) ----

export interface LocksLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
  query(): Promise<{ held?: ReadonlyArray<{ name?: string }> }>;
}

function getLocks(): LocksLike | undefined {
  const n = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LocksLike });
  return n?.locks;
}

export const lockName = (tabId: string) => `heavy-decode-${tabId}`;

/** Holds a Web Lock for the lifetime of this tab so other tabs can tell it is alive. */
export function holdTabLock(tabId: string, locks: LocksLike | undefined = getLocks()): void {
  if (!locks) return;
  try {
    void locks.request(lockName(tabId), () => new Promise<never>(() => {})).catch((e: unknown) => log.warn('tab lock failed', e));
  } catch (e) {
    log.warn('tab lock failed', e);
  }
}

export type MarkerCheck =
  | { status: 'none' }
  | { status: 'live-tab' }
  | { status: 'struck'; key: string; marker: HeavyMarker };

/**
 * Startup: a marker means a heavy decode did not finish. If its tab still holds its lock, that tab is alive
 * (no strike, marker kept). Otherwise count a strike for `<shotId>:<group>` and clear the marker.
 */
export async function checkHeavyMarker(
  meta: MetaStore,
  locks: LocksLike | undefined = getLocks(),
): Promise<MarkerCheck> {
  const marker = await meta.getMeta<HeavyMarker>(MARKER_KEY);
  if (!marker) return { status: 'none' };
  if (marker.tabId && locks) {
    try {
      const q = await locks.query();
      if (q.held?.some((l) => l.name === lockName(marker.tabId))) return { status: 'live-tab' };
    } catch (e) {
      log.warn('could not query locks; treating marker as stale', e);
    }
  }
  const key = strikeKey(marker.shotId ?? null, marker.kind);
  const map = (await meta.getMeta<StrikeMap>(STRIKES_KEY)) ?? {};
  map[key] = (map[key] ?? 0) + 1;
  await meta.setMeta(STRIKES_KEY, map);
  await meta.deleteMeta(MARKER_KEY);
  return { status: 'struck', key, marker };
}
