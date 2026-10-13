// Platform pixel limits (design 2.7 item 3, plan.md finding 6). Main-thread module.
import {
  PROBE_AREAS,
  PROBE_FALLBACK_AREA,
  MAX_SIDE,
  deviceTier,
  readDeviceEnv,
  type DeviceEnv,
  type TierLimits,
} from './config.ts';
import { log } from './log.ts';

export const CANVAS_PROBE_GUARD_KEY = 'canvasProbe';
export const CANVAS_PROBE_CACHE_KEY = 'canvasProbeCache';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimal canvas surface the probe needs (real canvas on the main thread, fake in tests). */
export interface ProbeCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): {
    fillStyle: unknown;
    fillRect(x: number, y: number, w: number, h: number): void;
    getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
  } | null;
}

export interface ProbeEnv {
  device: DeviceEnv;
  storage: KeyValueStorage | null;
  createCanvas: () => ProbeCanvas;
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // access can throw in locked-down browsers
  }
}

function defaultEnv(): ProbeEnv {
  return {
    device: readDeviceEnv(),
    storage: defaultStorage(),
    createCanvas: () => document.createElement('canvas'),
  };
}

function release(c: ProbeCanvas): void {
  c.width = 0;
  c.height = 0;
}

/** Passes if the last pixel of a roughly square canvas of `area` pixels can be written and read back. */
function probeArea(area: number, createCanvas: () => ProbeCanvas): boolean {
  const w = Math.floor(Math.sqrt(area));
  const h = Math.ceil(area / w);
  const c = createCanvas();
  try {
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#000';
    ctx.fillRect(w - 1, h - 1, 1, 1);
    return ctx.getImageData(w - 1, h - 1, 1, 1).data[3] === 255;
  } catch {
    return false;
  } finally {
    release(c);
  }
}

interface Cached {
  ua: string;
  value: number;
}

function readCache(storage: KeyValueStorage | null, uaHash: string): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CANVAS_PROBE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cached>;
    return parsed.ua === uaHash && typeof parsed.value === 'number' && parsed.value > 0 ? parsed.value : null;
  } catch {
    return null;
  }
}

function writeCache(storage: KeyValueStorage | null, uaHash: string, value: number): void {
  try {
    storage?.setItem(CANVAS_PROBE_CACHE_KEY, JSON.stringify({ ua: uaHash, value } satisfies Cached));
  } catch {
    // storage may be full or blocked; the probe simply runs again next session
  }
}

/**
 * Largest canvas area (pixels) that works on this device, never above the tier cap.
 * - iOS: constant, no probing (probing large canvases can itself kill the tab).
 * - Elsewhere: cached by UA hash; otherwise probe top-down starting at the tier cap.
 * - Crash guard: localStorage['canvasProbe'] = 'running' is set before the first allocation and cleared after.
 *   If found 'running' (the previous probe killed the tab) the probe is skipped and the cached value or 8.3 MP is used.
 */
export function probeCanvasLimit(env: ProbeEnv = defaultEnv()): number {
  const tier = deviceTier(env.device);
  if (tier.tier === 'ios') return tier.maxOutputPixels;
  const uaHash = hashString(env.device.userAgent ?? '');
  const storage = env.storage;
  const cached = readCache(storage, uaHash);

  let guard: string | null = null;
  try {
    guard = storage?.getItem(CANVAS_PROBE_GUARD_KEY) ?? null;
  } catch {
    guard = null;
  }
  if (guard === 'running') {
    log.warn('canvas probe crashed last time; skipping it');
    const value = Math.min(cached ?? PROBE_FALLBACK_AREA, tier.maxOutputPixels);
    try {
      storage?.removeItem(CANVAS_PROBE_GUARD_KEY);
    } catch {
      /* ignore */
    }
    writeCache(storage, uaHash, value);
    return value;
  }
  if (cached !== null) return Math.min(cached, tier.maxOutputPixels);

  const areas = PROBE_AREAS[tier.tier];
  let result = PROBE_FALLBACK_AREA;
  try {
    storage?.setItem(CANVAS_PROBE_GUARD_KEY, 'running');
  } catch {
    /* no guard available: probe anyway */
  }
  try {
    for (const area of areas) {
      if (probeArea(area, env.createCanvas)) {
        result = area;
        break;
      }
    }
  } finally {
    try {
      storage?.removeItem(CANVAS_PROBE_GUARD_KEY);
    } catch {
      /* ignore */
    }
  }
  writeCache(storage, uaHash, result);
  return result;
}

let memo: number | null = null;

/** min(tier cap, probed). Probed once per session, cached in localStorage per UA. */
export function getMaxOutputPixels(): number {
  if (memo === null) memo = probeCanvasLimit();
  return memo;
}

export function getTierLimits(device: DeviceEnv = readDeviceEnv()): TierLimits {
  return deviceTier(device);
}

export function getMaxDecodePixels(): number {
  return deviceTier().maxDecodePixels;
}

export function getRoiBudget(): number {
  return deviceTier().roiBudget;
}

export function getMaxSourcePixels(): number {
  return deviceTier().maxSourcePixels;
}

export function resetCanvasLimitsForTests(): void {
  memo = null;
}

export { MAX_SIDE };
/** Values for the current device, resolved at load time. Use the getters when the environment can change (tests). */
export const MAX_DECODE_PIXELS = getMaxDecodePixels();
export const ROI_BUDGET = getRoiBudget();
