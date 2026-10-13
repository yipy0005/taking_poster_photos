// Viewer geometry (design 2.12). Pure, DOM-free.
// `scale` is DEVICE pixels per IMAGE pixel (image = the shot's own pixel grid, before rotation). `tx`/`ty` place the top-left
// of the ROTATED image in device pixels relative to the viewport's top-left. Rotation is clockwise degrees.
import type { Rotation } from '../cv/geometry.ts';

export interface View {
  scale: number;
  tx: number;
  ty: number;
}
export interface Size {
  w: number;
  h: number;
}

export const HARD_ZOOM_CAP = 32;
export const MIN_ZOOM_TARGET = 8;
/** Zoom reached by a double tap from fit (design 2.12). */
export const DOUBLE_TAP_ZOOM = 4;
/** Pinch may overshoot the limits by 10% and springs back. */
export const OVERSHOOT = 0.1;
/** The image may leave the viewport by this fraction of the viewport. */
export const PAN_MARGIN = 0.1;
/** Backing store of the viewport canvas, in pixels. */
export const MAX_BACKING_PIXELS = 4_000_000;
export const MAX_DPR = 3;
/** Above this many device px per source px smoothing is turned off (pixels stay crisp). */
export const CRISP_SCALE = 3;

export const normalizeRotation = (deg: number): Rotation => ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;

/** Size of the image after rotating it by `rotation`. */
export function orientedSize(imgW: number, imgH: number, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { w: imgH, h: imgW } : { w: imgW, h: imgH };
}

/** Backing-store size: CSS size times min(dpr, 3), shrunk to at most 4 MP in total. */
export function backingSize(cssW: number, cssH: number, dpr: number): Size {
  const d = Math.max(1, Math.min(Number.isFinite(dpr) ? dpr : 1, MAX_DPR));
  let w = cssW * d;
  let h = cssH * d;
  if (w * h > MAX_BACKING_PIXELS) {
    const f = Math.sqrt(MAX_BACKING_PIXELS / (w * h));
    w *= f;
    h *= f;
  }
  return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
}

/** Scale at which the rotated image just fits (contain) in the viewport. */
export function fitScale(imgW: number, imgH: number, rotation: Rotation, vp: Size): number {
  const o = orientedSize(imgW, imgH, rotation);
  if (o.w <= 0 || o.h <= 0) return 1;
  return Math.min(vp.w / o.w, vp.h / o.h);
}

/**
 * Zoom limits against the bitmap actually in use (AC-22). `bitmapScale` = bitmap width / image width (1 for a full-resolution bitmap,
 * below 1 when the viewer shows a reduced one). One bitmap pixel equals one device pixel at `scale = bitmapScale`, so
 * `zMax = max(8, 2 * bitmapScale / fit)` magnifies individual bitmap pixels at least 2x at the top, capped at 32.
 */
export function zoomLimits(fit: number, bitmapScale: number): { zMin: number; zMax: number; maxScale: number; minScale: number } {
  const f = fit > 0 ? fit : 1;
  const k = bitmapScale > 0 ? bitmapScale : 1;
  const zMax = Math.min(HARD_ZOOM_CAP, Math.max(MIN_ZOOM_TARGET, (2 * k) / f));
  return { zMin: 1, zMax, minScale: f, maxScale: f * zMax };
}

/** Zoom factor relative to fit, as shown to the user. */
export const zoomFactor = (scale: number, fit: number): number => (fit > 0 ? scale / fit : 1);

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Clamps the scale to [min, max], optionally with an overshoot allowance (pinch in progress). */
export function clampScale(scale: number, limits: { minScale: number; maxScale: number }, overshoot = 0): number {
  return clamp(scale, limits.minScale * (1 - overshoot), limits.maxScale * (1 + overshoot));
}

/** Valid range of one translation axis: centered when the content is smaller than the viewport, else at most `margin` of it off-screen. */
export function axisRange(content: number, viewport: number, margin = PAN_MARGIN): { min: number; max: number } {
  if (content <= viewport) {
    const c = (viewport - content) / 2;
    return { min: c, max: c };
  }
  const m = viewport * margin;
  return { min: viewport - content - m, max: m };
}

export function clampTranslation(view: View, imgW: number, imgH: number, rotation: Rotation, vp: Size, margin = PAN_MARGIN): View {
  const o = orientedSize(imgW, imgH, rotation);
  const rx = axisRange(o.w * view.scale, vp.w, margin);
  const ry = axisRange(o.h * view.scale, vp.h, margin);
  return { scale: view.scale, tx: clamp(view.tx, rx.min, rx.max), ty: clamp(view.ty, ry.min, ry.max) };
}

/** The view that shows the whole image, centered. */
export function fitView(imgW: number, imgH: number, rotation: Rotation, vp: Size): View {
  const s = fitScale(imgW, imgH, rotation, vp);
  const o = orientedSize(imgW, imgH, rotation);
  return { scale: s, tx: (vp.w - o.w * s) / 2, ty: (vp.h - o.h * s) / 2 };
}

/** Changes the scale keeping the image point under (ax, ay) fixed. */
export function zoomAbout(view: View, newScale: number, ax: number, ay: number): View {
  const r = view.scale > 0 ? newScale / view.scale : 1;
  return { scale: newScale, tx: ax - (ax - view.tx) * r, ty: ay - (ay - view.ty) * r };
}

/** Viewport point to a point of the rotated image (image-pixel units). */
export function viewToOriented(view: View, x: number, y: number): { x: number; y: number } {
  return { x: (x - view.tx) / view.scale, y: (y - view.ty) / view.scale };
}

/** The zoomed view a double tap at (x, y) animates to; from a zoomed view it returns to fit. */
export function doubleTapTarget(view: View, fit: View, limits: { zMax: number; minScale: number }, x: number, y: number, imgW: number, imgH: number, rotation: Rotation, vp: Size): View {
  const z = zoomFactor(view.scale, fit.scale);
  if (z > 1.2) return fit;
  const target = fit.scale * Math.min(DOUBLE_TAP_ZOOM, limits.zMax);
  return clampTranslation(zoomAbout(view, target, x, y), imgW, imgH, rotation, vp);
}

/**
 * Canvas matrix [a, b, c, d, e, f] mapping SOURCE bitmap coordinates to device pixels. The bitmap is `srcW x srcH`
 * (the unrotated image, possibly at reduced resolution, so `view.scale / bitmapScale` device px per bitmap px).
 */
export function drawMatrix(rotation: Rotation, srcW: number, srcH: number, scalePerSrcPx: number, tx: number, ty: number): [number, number, number, number, number, number] {
  const s = scalePerSrcPx;
  switch (rotation) {
    case 90:
      return [0, s, -s, 0, s * srcH + tx, ty];
    case 180:
      return [-s, 0, 0, -s, s * srcW + tx, s * srcH + ty];
    case 270:
      return [0, -s, s, 0, tx, s * srcW + ty];
    default:
      return [s, 0, 0, s, tx, ty];
  }
}

/** Visible part of the source bitmap (integer pixel rect, clamped to the bitmap) for the given matrix and viewport. */
export function visibleSourceRect(m: readonly number[], vp: Size, srcW: number, srcH: number): { sx: number; sy: number; sw: number; sh: number } | null {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const det = a * d - b * c;
  if (!det) return null;
  const inv = (x: number, y: number): [number, number] => [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
  const pts = [inv(0, 0), inv(vp.w, 0), inv(0, vp.h), inv(vp.w, vp.h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = clamp(Math.floor(Math.min(...xs)), 0, srcW);
  const y0 = clamp(Math.floor(Math.min(...ys)), 0, srcH);
  const x1 = clamp(Math.ceil(Math.max(...xs)), 0, srcW);
  const y1 = clamp(Math.ceil(Math.max(...ys)), 0, srcH);
  if (x1 <= x0 || y1 <= y0) return null;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

/** Which bitmap to draw from: the base one while it still has at least a device pixel per source pixel (design 2.12). */
export function useBaseBitmap(scale: number, baseScale: number, hasFull: boolean): boolean {
  return !hasFull || scale <= baseScale;
}

// ---- Easing ----
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOut = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
};
export function lerpView(a: View, b: View, t: number): View {
  return { scale: a.scale + (b.scale - a.scale) * t, tx: a.tx + (b.tx - a.tx) * t, ty: a.ty + (b.ty - a.ty) * t };
}
