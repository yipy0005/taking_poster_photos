// Domain types and quad geometry shared by storage, camera and cv (design 2.5). DOM-free: reachable from workers.
import { InvalidQuadError } from '../app/errors.ts';

export type Pt = readonly [x: number, y: number];
/** Source-image pixel coordinates of the *oriented* original. Order: TL, TR, BR, BL. */
export type Quad = readonly [Pt, Pt, Pt, Pt];
export type AspectMode = 'auto' | 'free' | 'a-portrait' | 'a-landscape' | '4:3' | '16:9';
export type Rotation = 0 | 90 | 180 | 270;
/** RGBA raster, structural, no DOM ImageData. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}
/** Row-major 3x3. */
export type Mat3 = Float64Array;

/** validateQuad limits (original pixels, plan.md finding 13). */
export const MIN_QUAD_EDGE = 24;
export const MIN_QUAD_AREA_FRACTION = 0.01;
const MIN_ABS_CROSS = 1e-6;
/** Default corner inset when no poster outline is found (AC-9). */
export const DEFAULT_INSET = 0.08;

export const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Shoelace area of the polygon (absolute value). */
export function polygonArea(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
export const quadArea = (q: Quad): number => polygonArea(q);

/** Cross products of consecutive edges (b-a) x (c-b) for each vertex. */
function edgeCrosses(q: Quad): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    out.push((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]));
  }
  return out;
}
/** Strictly convex: all four consecutive-edge cross products share a sign and exceed 1e-6 in magnitude. */
export function isStrictlyConvex(q: Quad): boolean {
  const c = edgeCrosses(q);
  return c.every((v) => v > MIN_ABS_CROSS) || c.every((v) => v < -MIN_ABS_CROSS);
}

/**
 * Throws InvalidQuadError unless the quad is usable for rectification. ALWAYS call with ORIGINAL-pixel
 * coordinates and the original's oriented size; convert preview coordinates first (`s = origW / previewW`).
 */
export function validateQuad(q: Quad, imgW: number, imgH: number): void {
  if (!Array.isArray(q) || q.length !== 4) throw new InvalidQuadError('A quad needs four corners');
  for (const p of q) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new InvalidQuadError('Corner coordinates must be finite numbers');
    }
    if (p[0] < 0 || p[0] > imgW || p[1] < 0 || p[1] > imgH) throw new InvalidQuadError('Corner is outside the image');
  }
  if (!isStrictlyConvex(q)) throw new InvalidQuadError('Corners must form a convex shape');
  if (quadArea(q) < MIN_QUAD_AREA_FRACTION * imgW * imgH) throw new InvalidQuadError('The selected area is too small');
  for (let i = 0; i < 4; i++) {
    if (dist(q[i]!, q[(i + 1) % 4]!) < MIN_QUAD_EDGE) throw new InvalidQuadError('The selected area has an edge that is too short');
  }
}
export function isValidQuad(q: Quad, imgW: number, imgH: number): boolean {
  try {
    validateQuad(q, imgW, imgH);
    return true;
  } catch {
    return false;
  }
}

/** Multiplies every coordinate (use to convert preview coordinates to original pixels and back). */
export function scaleQuad(q: Quad, sx: number, sy: number = sx): Quad {
  return [
    [q[0][0] * sx, q[0][1] * sy],
    [q[1][0] * sx, q[1][1] * sy],
    [q[2][0] * sx, q[2][1] * sy],
    [q[3][0] * sx, q[3][1] * sy],
  ];
}

/** Axis-aligned rectangle inset by `inset` of each dimension (TL, TR, BR, BL). */
export function defaultInsetQuad(w: number, h: number, inset: number = DEFAULT_INSET): Quad {
  const x0 = w * inset;
  const y0 = h * inset;
  const x1 = w * (1 - inset);
  const y1 = h * (1 - inset);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

export function boundingBox(pts: readonly Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}
