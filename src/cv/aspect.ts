// Pinhole aspect-ratio estimate (design 2.5; Zhang and He "whiteboard scanning"), with confidence (plan.md finding 4)
// and A-series ratios that are exactly 1/sqrt(2) and sqrt(2) (finding 10). DOM-free.
import { dist, type Quad } from './geometry.ts';

/** A-series ratios, used by BOTH the ratio table and the snap list. */
export const A_PORTRAIT = 1 / Math.SQRT2;
export const A_LANDSCAPE = Math.SQRT2;

export type AspectConfidence = 'high' | 'medium' | 'low';
export interface AspectEstimate {
  /** Final ratio w/h (after snapping, clamped to [1/3, 3]). */
  ratio: number;
  /** Ratio before snapping. */
  rawRatio: number;
  confidence: AspectConfidence;
  /** Label of the known ratio the estimate was snapped to ('A-series', '4:3', ...), or null. */
  snapped: string | null;
  /** True when the focal prior was used instead of the focal length recovered from the corners. */
  usedPrior: boolean;
}

/** Known ratios the estimate may snap to (within SNAP_TOLERANCE). */
export const SNAP_LIST: ReadonlyArray<{ ratio: number; label: string }> = [
  { ratio: A_PORTRAIT, label: 'A-series' },
  { ratio: A_LANDSCAPE, label: 'A-series' },
  { ratio: 0.75, label: '3:4' },
  { ratio: 4 / 3, label: '4:3' },
  { ratio: 9 / 16, label: '9:16' },
  { ratio: 16 / 9, label: '16:9' },
  { ratio: 1, label: '1:1' },
];
export const SNAP_TOLERANCE = 0.025;
/** The recovered focal length is used only if both depth ratios differ from 1 by at least this much. */
export const GUARD_MARGIN = 0.02;
/** `high` confidence needs both depth-ratio margins at least this large. */
export const HIGH_MARGIN = 0.05;
/**
 * Prior branch + max(|k2-1|, |k3-1|) above this => 'low' confidence. MEASURED with the oracle in aspect.test.ts
 * (`measureTiltThreshold`): max(|k-1|) for a single-axis tilt of about 25 degrees. See README envelope.
 */
export const LOW_CONFIDENCE_TILT = 0.2;

type V3 = readonly [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface AspectOptions {
  /** EXIF FocalLengthIn35mmFilm in millimetres, when present. */
  focal35mm?: number | null;
}

/** Focal prior in pixels: EXIF-based (diagonal formula) or 0.75 x long side. */
export function focalPrior(imgW: number, imgH: number, focal35mm?: number | null): number {
  if (typeof focal35mm === 'number' && Number.isFinite(focal35mm) && focal35mm > 0) {
    return (focal35mm * Math.hypot(imgW, imgH)) / 43.27;
  }
  return 0.75 * Math.max(imgW, imgH);
}

const clampRatio = (r: number): number => Math.min(3, Math.max(1 / 3, r));

export function snapRatio(ratio: number): { ratio: number; label: string | null } {
  let best: { ratio: number; label: string } | null = null;
  let bestErr = Infinity;
  for (const k of SNAP_LIST) {
    const err = Math.abs(ratio / k.ratio - 1);
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  if (best && bestErr <= SNAP_TOLERANCE) return { ratio: best.ratio, label: best.label };
  return { ratio, label: null };
}

function edgeRatio(q: Quad): number {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return h > 0 ? w / h : 1;
}

/**
 * Estimates the true w/h of a rectangle photographed as `quad` (TL, TR, BR, BL in image pixels of an
 * imgW x imgH image). Principal point = image centre, square pixels.
 */
export function estimateAspect(quad: Quad, imgW: number, imgH: number, opts: AspectOptions = {}): AspectEstimate {
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  const m = (p: readonly [number, number]): V3 => [p[0] - u0, p[1] - v0, 1];
  const m1 = m(quad[0]);
  const m2 = m(quad[1]);
  const m3 = m(quad[3]);
  const m4 = m(quad[2]);
  const fPrior = focalPrior(imgW, imgH, opts.focal35mm);

  const c14 = cross(m1, m4);
  const d2 = dot(cross(m2, m4), m3);
  const d3 = dot(cross(m3, m4), m2);
  const finish = (raw: number, usedPrior: boolean, confidence: AspectConfidence): AspectEstimate => {
    const clamped = clampRatio(raw);
    const snap = snapRatio(clamped);
    return { ratio: snap.ratio, rawRatio: clamped, confidence, snapped: snap.label, usedPrior };
  };
  if (!Number.isFinite(d2) || !Number.isFinite(d3) || Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) {
    return finish(edgeRatio(quad), true, 'low');
  }
  const k2 = dot(c14, m3) / d2;
  const k3 = dot(c14, m2) / d3;
  const n2: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
  const n3: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
  const n2z = n2[2];
  const n3z = n3[2];
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2z * n3z);
  const f = Math.sqrt(f2);
  const accepted =
    Math.abs(n2z) >= GUARD_MARGIN &&
    Math.abs(n3z) >= GUARD_MARGIN &&
    Number.isFinite(f2) &&
    f2 > 0 &&
    f >= 0.5 * fPrior &&
    f <= 2 * fPrior;
  const fUsed = accepted ? f : fPrior;
  const top = Math.sqrt((n2[0] * n2[0] + n2[1] * n2[1]) / (fUsed * fUsed) + n2z * n2z);
  const left = Math.sqrt((n3[0] * n3[0] + n3[1] * n3[1]) / (fUsed * fUsed) + n3z * n3z);
  if (!(left > 0) || !Number.isFinite(top) || !Number.isFinite(left)) return finish(edgeRatio(quad), true, 'low');
  const raw = top / left;
  let confidence: AspectConfidence;
  if (accepted) confidence = Math.min(Math.abs(n2z), Math.abs(n3z)) >= HIGH_MARGIN ? 'high' : 'medium';
  else confidence = Math.max(Math.abs(k2 - 1), Math.abs(k3 - 1)) > LOW_CONFIDENCE_TILT ? 'low' : 'medium';
  return finish(raw, !accepted, confidence);
}

/** Depth ratios and margins, exposed for the oracle tests and the envelope measurement. */
export function depthRatios(quad: Quad, imgW: number, imgH: number): { k2: number; k3: number } {
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  const m = (p: readonly [number, number]): V3 => [p[0] - u0, p[1] - v0, 1];
  const m1 = m(quad[0]);
  const m2 = m(quad[1]);
  const m3 = m(quad[3]);
  const m4 = m(quad[2]);
  const c14 = cross(m1, m4);
  return { k2: dot(c14, m3) / dot(cross(m2, m4), m3), k3: dot(c14, m2) / dot(cross(m3, m4), m2) };
}
