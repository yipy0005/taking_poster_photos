// Camera capability helpers: feature tests, track capability normalisation, tap mapping and the resolution readout.
// Pure functions over plain objects so they can be tested without a browser.

export interface NumRange {
  min: number;
  max: number;
  step: number;
}

export interface CameraCapabilities {
  torch: boolean;
  zoom: NumRange | null;
  /** Tap-to-focus is offered only when the track reports a usable focus mode or points of interest. */
  tapFocus: boolean;
  /** Largest stream size the track advertises (used to raise the preview resolution). */
  maxWidth: number | null;
  maxHeight: number | null;
  /** Advertised `exposureMode` values (e.g. 'continuous'); empty when the browser reports none. */
  exposureModes: string[];
  /** EV range for `exposureCompensation`; null where unsupported (not Safari, not every Android camera). */
  exposureCompensation: NumRange | null;
  /** Advertised `whiteBalanceMode` values. */
  whiteBalanceModes: string[];
}

export const NO_CAPABILITIES: Readonly<CameraCapabilities> = {
  torch: false,
  zoom: null,
  tapFocus: false,
  maxWidth: null,
  maxHeight: null,
  exposureModes: [],
  exposureCompensation: null,
  whiteBalanceModes: [],
};

/** The achieved resolution below which the native camera is suggested (AC-3, AC-3b). */
export const NATIVE_HINT_MEGAPIXELS = 8;

type G = Record<string, unknown>;

/**
 * `typeof` guard: a bare `ImageCapture.prototype` throws a ReferenceError where the global is undefined (Firefox, older Safari).
 */
export function hasImageCapture(g: G = globalThis as G): boolean {
  const ic = g['ImageCapture'] as { prototype?: { takePhoto?: unknown } } | undefined;
  return typeof ic === 'function' && typeof (ic as { prototype?: { takePhoto?: unknown } }).prototype?.takePhoto === 'function';
}

export function hasGrabFrame(g: G = globalThis as G): boolean {
  const ic = g['ImageCapture'] as { prototype?: { grabFrame?: unknown } } | undefined;
  return typeof ic === 'function' && typeof (ic as { prototype?: { grabFrame?: unknown } }).prototype?.grabFrame === 'function';
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function rangeOf(raw: unknown): NumRange | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { min?: unknown; max?: unknown; step?: unknown };
  if (!isNum(r.min) || !isNum(r.max) || r.max <= r.min) return null;
  return { min: r.min, max: r.max, step: isNum(r.step) && r.step > 0 ? r.step : 0.1 };
}

const stringList = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);

/** Normalises `track.getCapabilities()` (any browser shape) into what the UI needs. Missing data means "not supported". */
export function readCapabilities(raw: unknown): CameraCapabilities {
  if (typeof raw !== 'object' || raw === null) return { ...NO_CAPABILITIES, exposureModes: [], whiteBalanceModes: [] };
  const c = raw as Record<string, unknown>;
  const focusModes = Array.isArray(c['focusMode']) ? (c['focusMode'] as unknown[]) : [];
  const width = c['width'] as { max?: unknown } | undefined;
  const height = c['height'] as { max?: unknown } | undefined;
  return {
    torch: c['torch'] === true,
    zoom: rangeOf(c['zoom']),
    tapFocus: focusModes.includes('single-shot') || focusModes.includes('manual') || 'pointsOfInterest' in c,
    maxWidth: isNum(width?.max) ? width.max : null,
    maxHeight: isNum(height?.max) ? height.max : null,
    exposureModes: stringList(c['exposureMode']),
    exposureCompensation: rangeOf(c['exposureCompensation']),
    whiteBalanceModes: stringList(c['whiteBalanceMode']),
  };
}

export const megapixels = (w: number, h: number): number => (w * h) / 1e6;

/** "4032x3024, 12.2 MP" */
export function formatResolution(w: number, h: number): string {
  return `${w}x${h}, ${megapixels(w, h).toFixed(1)} MP`;
}

/** True when the achieved resolution is known and below 8 MP. */
export function suggestNativeCamera(w: number | null | undefined, h: number | null | undefined): boolean {
  if (!w || !h) return false;
  return megapixels(w, h) < NATIVE_HINT_MEGAPIXELS;
}

/**
 * Converts a tap inside a box that shows a video with `object-fit: cover` into normalised video coordinates (0..1).
 * Returns null when the tap lies in the cropped-away part of the video.
 */
export function mapTapToVideo(
  tap: { x: number; y: number },
  box: { width: number; height: number },
  video: { width: number; height: number },
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || video.width <= 0 || video.height <= 0) return null;
  const scale = Math.max(box.width / video.width, box.height / video.height);
  const shownW = video.width * scale;
  const shownH = video.height * scale;
  const x = (tap.x - (box.width - shownW) / 2) / shownW;
  const y = (tap.y - (box.height - shownH) / 2) / shownH;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}
