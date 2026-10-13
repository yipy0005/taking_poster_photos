// Homography maths (design 2.5). Row-major Float64Array(9). Pixel-edge coordinates: pixel (i, j) has its centre at
// (i + 0.5, j + 0.5). DOM-free.
import { DegenerateQuadError } from '../app/errors.ts';
import type { Mat3, Pt, Quad } from './geometry.ts';

export const identity = (): Mat3 => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
export const translation = (tx: number, ty: number): Mat3 => Float64Array.of(1, 0, tx, 0, 1, ty, 0, 0, 1);
export const scaling = (sx: number, sy: number): Mat3 => Float64Array.of(sx, 0, 0, 0, sy, 0, 0, 0, 1);

/** a * b (apply b first). */
export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return o;
}

export function det3(m: Mat3): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}

export function invert(m: Mat3): Mat3 {
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) throw new DegenerateQuadError('Matrix is not invertible');
  const a = m[0]!, b = m[1]!, c = m[2]!, e = m[3]!, f = m[4]!, g = m[5]!, h = m[6]!, i = m[7]!, j = m[8]!;
  return Float64Array.of(
    (f * j - g * i) / d, (c * i - b * j) / d, (b * g - c * f) / d,
    (g * h - e * j) / d, (a * j - c * h) / d, (c * e - a * g) / d,
    (e * i - f * h) / d, (b * h - a * i) / d, (a * f - b * e) / d,
  );
}

/** Applies the homography to a point (perspective divide). Returns [NaN, NaN] when w is ~0. */
export function apply(m: Mat3, x: number, y: number): Pt {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w];
}

/** Homogeneous w component at (x, y). */
export const wAt = (m: Mat3, x: number, y: number): number => m[6]! * x + m[7]! * y + m[8]!;

/**
 * Local source-per-destination pixel scale sqrt(|det J|) of the projective map at (x, y). Uses det J = det(H) / w^3.
 */
export function sigmaAt(m: Mat3, x: number, y: number): number {
  const w = wAt(m, x, y);
  if (Math.abs(w) < 1e-12) return Infinity;
  return Math.sqrt(Math.abs(det3(m) / (w * w * w)));
}

/**
 * Solves the homography mapping each `from[i]` to `to[i]` (h33 = 1) by Gaussian elimination with partial pivoting in
 * Float64. Throws DegenerateQuadError if a pivot is below 1e-12 * maxAbs(A).
 */
export function solveHomography(from: readonly Pt[], to: readonly Pt[]): Mat3 {
  const n = 8;
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!;
    const [u, v] = to[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  let maxAbs = 0;
  for (const row of A) for (let c = 0; c < n; c++) maxAbs = Math.max(maxAbs, Math.abs(row[c]!));
  const tol = 1e-12 * maxAbs;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    if (!(Math.abs(A[piv]![col]!) > tol)) throw new DegenerateQuadError('The corners do not define a valid perspective');
    if (piv !== col) {
      const t = A[col]!;
      A[col] = A[piv]!;
      A[piv] = t;
    }
    const pr = A[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = A[r]!;
      const f = row[col]! / pr[col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c] = row[c]! - f * pr[c]!;
    }
  }
  const h = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= A[r]![c]! * h[c]!;
    h[r] = s / A[r]![r]!;
  }
  const out = Float64Array.of(h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1);
  for (const v of out) if (!Number.isFinite(v)) throw new DegenerateQuadError('The corners do not define a valid perspective');
  return out;
}

/** Destination-to-source homography Hds: output rectangle [0,W]x[0,H] (pixel-edge coords) to the ordered source quad. */
export function quadHomography(quad: Quad, outW: number, outH: number): Mat3 {
  const D: Pt[] = [
    [0, 0],
    [outW, 0],
    [outW, outH],
    [0, outH],
  ];
  return solveHomography(D, quad);
}

/**
 * Tile homography Htile = T(-sx, -sy) * Hds * T(x0, y0): maps tile-local destination coordinates to coordinates local to
 * a source ROI whose origin is (sx, sy). (x0, y0) is the (halo-expanded) tile origin in the output.
 */
export function tileHomography(Hds: Mat3, sx: number, sy: number, x0: number, y0: number): Mat3 {
  return mul(translation(-sx, -sy), mul(Hds, translation(x0, y0)));
}

/** Htile' = Scale(rw/sw, rh/sh) * Htile for an ROI drawn reduced from sw x sh to rw x rh. */
export function reducedRoiHomography(Htile: Mat3, sw: number, sh: number, rw: number, rh: number): Mat3 {
  return mul(scaling(rw / sw, rh / sh), Htile);
}
