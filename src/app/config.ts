// Platform constants and the device-tier table (design 2.7). Edit numbers here only; the real-device
// gate retunes them without touching logic. Main-thread module (reads navigator); workers get values via init.

export type TierName = 'ios' | 'default' | 'mem4' | 'low';

export interface TierLimits {
  tier: TierName;
  /** Upper bound for getMaxOutputPixels() (before any canvas probe). */
  maxOutputPixels: number;
  roiBudget: number;
  maxDecodePixels: number;
  /** Soft limit: capture request clamp and the `oversize` flag threshold. Never a reason to discard a photo. */
  maxSourcePixels: number;
}

export const TIERS: Readonly<Record<TierName, TierLimits>> = {
  ios: { tier: 'ios', maxOutputPixels: 16_777_216, roiBudget: 3_000_000, maxDecodePixels: 25_000_000, maxSourcePixels: 50_000_000 },
  default: { tier: 'default', maxOutputPixels: 50_000_000, roiBudget: 4_000_000, maxDecodePixels: 64_000_000, maxSourcePixels: 64_000_000 },
  mem4: { tier: 'mem4', maxOutputPixels: 33_500_000, roiBudget: 4_000_000, maxDecodePixels: 40_000_000, maxSourcePixels: 64_000_000 },
  low: { tier: 'low', maxOutputPixels: 16_700_000, roiBudget: 3_000_000, maxDecodePixels: 25_000_000, maxSourcePixels: 64_000_000 },
};

/** Canvas probe list starts at the tier cap (plan.md finding 6). iOS never probes. */
export const PROBE_AREAS: Readonly<Record<Exclude<TierName, 'ios'>, readonly number[]>> = {
  default: [50e6, 33.5e6, 16.7e6, 8.3e6],
  mem4: [33.5e6, 16.7e6, 8.3e6],
  low: [16.7e6, 8.3e6],
};
export const PROBE_FALLBACK_AREA = 8.3e6;

export interface DeviceEnv {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  /** navigator.deviceMemory (Chromium only), GB. */
  deviceMemory?: number;
}

export function readDeviceEnv(): DeviceEnv {
  if (typeof navigator === 'undefined') return {};
  const n = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: n.userAgent,
    platform: n.platform,
    maxTouchPoints: n.maxTouchPoints,
    deviceMemory: n.deviceMemory,
  };
}

/** iOS/iPadOS WebKit: UA match, or an iPad that reports itself as a Mac. */
export function isIosWebKit(env: DeviceEnv = readDeviceEnv()): boolean {
  if (/iP(hone|ad|od)/.test(env.userAgent ?? '')) return true;
  return env.platform === 'MacIntel' && (env.maxTouchPoints ?? 0) > 1;
}

export function deviceTier(env: DeviceEnv = readDeviceEnv()): TierLimits {
  if (isIosWebKit(env)) return TIERS.ios;
  const mem = env.deviceMemory;
  if (typeof mem !== 'number' || !Number.isFinite(mem) || mem > 4) return TIERS.default;
  if (mem > 2) return TIERS.mem4;
  return TIERS.low;
}

// ---- Pixel/size constants ----
export const HEAVY_DECODE_PIXELS = 12_000_000;
export const HARD_SOURCE_PIXELS = 256_000_000;
export const MAX_SOURCE_BYTES = 120 * 1024 * 1024;
export const MAX_SIDE = 16_384;
export const PREVIEW_LONG_EDGE = 2048;
export const THUMB_LONG_EDGE = 256;
/** Unsaved-in-session shots held by the overlay store before new captures are refused. */
export const MAX_UNSAVED_SHOTS = 6;

// ---- Memory gate ----
export const GATE_RESUME_DEBOUNCE_MS = 500;

// ---- Strike caps (design 2.7 item 9) ----
export type StrikeGroup = 'render' | 'preview' | 'thumb' | 'ingest';
/** Index = strikes (clamped to the last entry). `Infinity` = no cap. */
export const RENDER_STRIKE_MAX_PIXELS: readonly number[] = [Infinity, 12_000_000, 6_000_000];
export const PREVIEW_STRIKE_LONG_EDGE: readonly number[] = [2048, 1024, 512];

// ---- Export limits (design 2.13) ----
export const PDF_LIMITS = {
  ios: { maxPages: 12, maxBytes: 60 * 1024 * 1024 },
  other: { maxPages: 40, maxBytes: 150 * 1024 * 1024 },
} as const;

// ---- Misc ----
export const SEARCH_DEBOUNCE_MS = 150;
export const SEARCH_MAX_LENGTH = 100;
export const ERROR_TOAST_INTERVAL_MS = 10_000;
