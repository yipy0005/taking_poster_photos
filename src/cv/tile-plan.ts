// Budgeted tile planning (design 2.5 "ROI planning and the ROI budget"; plan.md finding 9: balanced tiles). DOM-free.
import { apply, sigmaAt } from './homography.ts';
import type { Mat3 } from './geometry.ts';

/** Extra source pixels around the mapped box for bilinear support. */
export const SRC_MARGIN = 2;
/** Extra output pixels rendered on each tile side when sharpening is on. */
export const HALO_OUT_SHARPEN = 2;
const MIN_STRIP = 16;
const MAX_STRIP = 512;

export interface RoiInfo {
  /** Source ROI origin and size, integer pixels of the decoded bitmap. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Worst-case (corner maximum) source-per-output-pixel scale of the halo-expanded rectangle. */
  sigma: number;
  /** Anti-alias reduction factor (1 = none). */
  k: number;
  /** Reduced ROI size, ceil(sw / k) x ceil(sh / k). */
  rw: number;
  rh: number;
}
export interface PlannedTile extends RoiInfo {
  /** Nominal tile in the output, [x0, x1) x [y0, y1). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Halo-expanded tile (clamped to the output). Equals the nominal tile when there is no halo. */
  hx0: number;
  hy0: number;
  hx1: number;
  hy1: number;
}
export interface TilePlan {
  tiles: PlannedTile[];
  /** Nominal (balanced) tile size of the final grid. */
  tw: number;
  th: number;
  /** Component-wise maxima of the reduced ROI sizes: one scratch canvas of this size serves every tile. */
  envW: number;
  envH: number;
  /** clamp(floor(budget / W), 16, 512): the first strip height tried. */
  initialStrip: number;
}

export const initialStripHeight = (W: number, budget: number): number =>
  Math.min(MAX_STRIP, Math.max(MIN_STRIP, Math.floor(budget / W)));

/**
 * Source ROI for the output rectangle [hx0, hx1) x [hy0, hy1) (pixel-edge coordinates) under the
 * destination-to-source homography `Hds`, clamped to a srcW x srcH bitmap.
 */
export function roiForRect(Hds: Mat3, hx0: number, hy0: number, hx1: number, hy1: number, srcW: number, srcH: number): RoiInfo {
  const corners: Array<[number, number]> = [
    [hx0, hy0],
    [hx1, hy0],
    [hx1, hy1],
    [hx0, hy1],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sigma = 0;
  let broken = false;
  for (const [x, y] of corners) {
    const p = apply(Hds, x, y);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      broken = true;
      break;
    }
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
    sigma = Math.max(sigma, sigmaAt(Hds, x, y));
  }
  if (broken || !Number.isFinite(sigma)) {
    // cannot happen for a validated convex quad; fall back to the whole bitmap
    minX = 0;
    minY = 0;
    maxX = srcW;
    maxY = srcH;
    sigma = 1;
  }
  let sx = Math.floor(minX - SRC_MARGIN);
  let sy = Math.floor(minY - SRC_MARGIN);
  let ex = Math.ceil(maxX + SRC_MARGIN);
  let ey = Math.ceil(maxY + SRC_MARGIN);
  sx = Math.min(Math.max(sx, 0), srcW - 1);
  sy = Math.min(Math.max(sy, 0), srcH - 1);
  ex = Math.min(Math.max(ex, sx + 1), srcW);
  ey = Math.min(Math.max(ey, sy + 1), srcH);
  const sw = ex - sx;
  const sh = ey - sy;
  const k = sigma > 1.5 ? Math.floor(sigma) : 1;
  return { sx, sy, sw, sh, sigma, k, rw: Math.ceil(sw / k), rh: Math.ceil(sh / k) };
}

/** Even partition of [0, n) into `parts` ranges whose sizes differ by at most 1 (no slivers). */
function edges(n: number, parts: number): number[] {
  const e: number[] = [];
  for (let i = 0; i <= parts; i++) e.push(Math.floor((i * n) / parts));
  return e;
}

/**
 * Plans tiles against an explicit ROI budget. Starts with full-width strips and halves the larger tile dimension until
 * the envelope of the reduced ROIs fits. `halo` = output pixels added on every tile side (sharpen: HALO_OUT_SHARPEN).
 */
export function planTiles(Hds: Mat3, W: number, H: number, srcW: number, srcH: number, budget: number, halo = 0): TilePlan {
  const initialStrip = initialStripHeight(W, budget);
  let tw = W;
  let th = initialStrip;
  for (;;) {
    const nc = Math.max(1, Math.ceil(W / tw));
    const nr = Math.max(1, Math.ceil(H / th));
    // Rebalance so the last column/row is not a sliver (finding 9); sizes differ by at most 1 pixel.
    const xs = edges(W, nc);
    const ys = edges(H, nr);
    tw = Math.ceil(W / nc);
    th = Math.ceil(H / nr);
    const tiles: PlannedTile[] = [];
    let envW = 0;
    let envH = 0;
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        const x0 = xs[c]!;
        const x1 = xs[c + 1]!;
        const y0 = ys[r]!;
        const y1 = ys[r + 1]!;
        const hx0 = Math.max(0, x0 - halo);
        const hy0 = Math.max(0, y0 - halo);
        const hx1 = Math.min(W, x1 + halo);
        const hy1 = Math.min(H, y1 + halo);
        const roi = roiForRect(Hds, hx0, hy0, hx1, hy1, srcW, srcH);
        envW = Math.max(envW, roi.rw);
        envH = Math.max(envH, roi.rh);
        tiles.push({ x0, y0, x1, y1, hx0, hy0, hx1, hy1, ...roi });
      }
    }
    if (envW * envH <= budget || (tw === 1 && th === 1)) return { tiles, tw, th, envW, envH, initialStrip };
    if (tw >= th) tw = Math.max(1, tw >> 1);
    else th = Math.max(1, th >> 1);
  }
}
