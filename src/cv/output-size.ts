// Output size from the longest quad edges (design 2.5). THE ONLY place output (W, H) is computed (render-core and the
// engines receive the numbers and only assert W*H <= cap). DOM-free.
import { MAX_SIDE } from '../app/config.ts';
import { A_LANDSCAPE, A_PORTRAIT, estimateAspect, type AspectConfidence } from './aspect.ts';
import { dist, type AspectMode, type Quad } from './geometry.ts';

/** Floor the longer side, derive the shorter by floor, then correct. Never rounds up, so it cannot exceed the cap. */
export function capSize(
  W1: number,
  H1: number,
  cap: number,
  maxSide: number = MAX_SIDE,
): { W: number; H: number; downscaled: boolean } {
  const s = Math.min(1, Math.sqrt(cap / (W1 * H1)), maxSide / Math.max(W1, H1));
  const landscape = W1 >= H1;
  const long1 = landscape ? W1 : H1;
  const short1 = landscape ? H1 : W1;
  const L = Math.max(1, Math.floor(long1 * s));
  const S = Math.max(1, Math.floor((L * short1) / long1)); // keeps the uncapped aspect ratio
  let W = landscape ? L : S;
  let H = landscape ? S : L;
  // Defensive floating-point correction; at most a few iterations, normally zero.
  while ((W * H > cap || Math.max(W, H) > maxSide) && (W > 1 || H > 1)) {
    if (W >= H) W--;
    else H--;
  }
  return { W, H, downscaled: s < 1 };
}

/** Longest horizontal / vertical edges of an ordered quad (TL, TR, BR, BL). */
export function quadEdges(q: Quad): { W0: number; H0: number } {
  return { W0: Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H0: Math.max(dist(q[0], q[3]), dist(q[1], q[2])) };
}

/** Fixed target ratios (w/h) of the non-auto, non-free modes. */
export function fixedRatio(mode: AspectMode): number | null {
  switch (mode) {
    case 'a-portrait':
      return A_PORTRAIT;
    case 'a-landscape':
      return A_LANDSCAPE;
    case '4:3':
      return 4 / 3;
    case '16:9':
      return 16 / 9;
    default:
      return null;
  }
}

export interface OutputSizeOptions {
  /** getMaxOutputPixels(). */
  cap: number;
  maxSide?: number;
  /** Original (oriented) image size, needed for aspect estimation in auto mode. */
  imgW?: number;
  imgH?: number;
  /** EXIF FocalLengthIn35mmFilm for the aspect estimate. */
  focal35mm?: number | null;
}
export interface OutputSize {
  width: number;
  height: number;
  /** True when the cap or side limit forced a reduction. */
  downscaled: boolean;
  /** Ratio the output was fitted to (null in free mode). */
  aspectUsed: number | null;
  /** Label of the known ratio the auto estimate snapped to, else null. */
  snappedTo: string | null;
  /** Confidence of the auto estimate (undefined in other modes). */
  confidence?: AspectConfidence;
  /** The auto estimate fell back to the focal prior. */
  usedPrior?: boolean;
}

export function computeOutputSize(quad: Quad, mode: AspectMode, opts: OutputSizeOptions): OutputSize {
  const { W0, H0 } = quadEdges(quad);
  let r = fixedRatio(mode);
  let snappedTo: string | null = null;
  let confidence: AspectConfidence | undefined;
  let usedPrior: boolean | undefined;
  if (mode === 'auto') {
    if (!opts.imgW || !opts.imgH) throw new Error('computeOutputSize: auto mode needs imgW and imgH');
    const est = estimateAspect(quad, opts.imgW, opts.imgH, { focal35mm: opts.focal35mm });
    r = est.ratio;
    snappedTo = est.snapped;
    confidence = est.confidence;
    usedPrior = est.usedPrior;
  }
  let W1 = W0;
  let H1 = H0;
  if (r !== null) {
    W1 = Math.max(W0, r * H0);
    H1 = W1 / r;
  }
  const capped = capSize(W1, H1, opts.cap, opts.maxSide ?? MAX_SIDE);
  let { W, H } = capped;
  // Landscape ratios: flooring the long side leaves |W/H - r| up to r/H; trimming W to floor(r*H) (never grows)
  // brings it within 1/H (AC-16). Portrait/free modes already satisfy it.
  if (r !== null && r > 1) W = Math.max(1, Math.min(W, Math.floor(r * H + 1e-9)));
  return { width: W, height: H, downscaled: capped.downscaled, aspectUsed: r, snappedTo, confidence, usedPrior };
}

/** Uniform scale of an already-capped size (memory retries). Floors; never exceeds `cap`. */
export function scaleOutputSize(W: number, H: number, factor: number, cap: number = Infinity): { width: number; height: number } {
  const s = capSize(W * factor, H * factor, cap);
  return { width: s.W, height: s.H };
}
