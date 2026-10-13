// Magnifier loupe shown while a corner handle is dragged (design 2.14, AC-10): a circular 120 px canvas at 4x (never below 3x),
// placed diagonally away from the touch point toward the quad interior, flipped when it would leave the stage, and never
// under the finger. Positioning and source-rectangle maths are pure.
import type { Pt } from '../../cv/geometry.ts';
import { el } from '../dom.ts';

export const LOUPE_SIZE = 120;
export const LOUPE_MAGNIFICATION = 4;
export const MIN_MAGNIFICATION = 3;
/** Gap between the finger contact area edge and the loupe edge, in CSS px. */
export const FINGER_CLEARANCE = 36;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of the preview shown in the loupe, in preview px. `previewPerCss` = preview pixels per CSS pixel of the stage.
 * With magnification m, the loupe shows (size / m) CSS px of the stage, so features appear m times larger.
 */
export function loupeSourceRect(center: Pt, previewPerCss: number, size: number = LOUPE_SIZE, magnification: number = LOUPE_MAGNIFICATION): Rect {
  const m = Math.max(MIN_MAGNIFICATION, magnification);
  const side = (size / m) * previewPerCss;
  return { x: center[0] - side / 2, y: center[1] - side / 2, w: side, h: side };
}

export interface Blit {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Clips the source rectangle to the image and scales the destination to match (drawImage with out-of-range sources is unsafe). */
export function clipBlit(src: Rect, imgW: number, imgH: number, canvasSize: number): Blit | null {
  const x0 = Math.max(0, src.x);
  const y0 = Math.max(0, src.y);
  const x1 = Math.min(imgW, src.x + src.w);
  const y1 = Math.min(imgH, src.y + src.h);
  if (x1 <= x0 || y1 <= y0) return null;
  const sx = canvasSize / src.w;
  const sy = canvasSize / src.h;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0, dx: (x0 - src.x) * sx, dy: (y0 - src.y) * sy, dw: (x1 - x0) * sx, dh: (y1 - y0) * sy };
}

const unit = (v: Pt): Pt => {
  const n = Math.hypot(v[0], v[1]);
  return n < 1e-9 ? [0, -1] : [v[0] / n, v[1] / n];
};

/**
 * Centre of the loupe in stage CSS px. Preference order: toward the quad interior (`inward`), the opposite side, then the two
 * perpendiculars; the first candidate that lies fully inside the stage wins. The distance to the finger is always at least
 * size/2 + clearance, so the loupe is never under the finger (when the stage is too small for any candidate, the preferred one
 * is clamped into the stage).
 */
export function placeLoupe(finger: Pt, inward: Pt, stage: { width: number; height: number }, size: number = LOUPE_SIZE, clearance: number = FINGER_CLEARANCE): Pt {
  const r = size / 2;
  const dist = r + clearance;
  const u = unit(inward);
  const dirs: Pt[] = [u, [-u[0], -u[1]], [-u[1], u[0]], [u[1], -u[0]]];
  const fits = (c: Pt): boolean => c[0] - r >= 0 && c[0] + r <= stage.width && c[1] - r >= 0 && c[1] + r <= stage.height;
  for (const d of dirs) {
    const c: Pt = [finger[0] + d[0] * dist, finger[1] + d[1] * dist];
    if (fits(c)) return c;
  }
  // Near a stage corner none of the four fits: try intermediate directions, closest to the preferred one first.
  for (let step = 1; step <= 12; step++) {
    for (const sign of [1, -1]) {
      const a = (sign * step * Math.PI) / 12;
      const d: Pt = [u[0] * Math.cos(a) - u[1] * Math.sin(a), u[0] * Math.sin(a) + u[1] * Math.cos(a)];
      const c: Pt = [finger[0] + d[0] * dist, finger[1] + d[1] * dist];
      if (fits(c)) return c;
    }
  }
  const d = dirs[0]!;
  const lo = (n: number, max: number): number => Math.min(Math.max(n, r), Math.max(r, max - r));
  return [lo(finger[0] + d[0] * dist, stage.width), lo(finger[1] + d[1] * dist, stage.height)];
}

export interface LoupeUpdate {
  bitmap: ImageBitmap;
  /** Handle position in preview px. */
  center: Pt;
  /** Finger position in stage CSS px. */
  finger: Pt;
  /** Direction from the handle toward the quad interior (any length). */
  inward: Pt;
  stage: { width: number; height: number };
  /** Preview pixels per stage CSS pixel. */
  previewPerCss: number;
}

export interface Loupe {
  el: HTMLElement;
  update(u: LoupeUpdate): void;
  hide(): void;
  dispose(): void;
}

export function createLoupe(): Loupe {
  const dpr = Math.min(2, typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
  const px = Math.round(LOUPE_SIZE * dpr);
  const canvas = el('canvas', { class: 'loupe-canvas', attrs: { width: px, height: px, 'aria-hidden': 'true' } });
  const root = el('div', { class: 'loupe', attrs: { 'aria-hidden': 'true', hidden: true } }, canvas, el('span', { class: 'loupe-cross' }));
  const ctx = canvas.getContext('2d');
  return {
    el: root,
    update(u) {
      if (!ctx) return;
      const c = placeLoupe(u.finger, u.inward, u.stage);
      root.hidden = false;
      root.style.transform = `translate(${c[0] - LOUPE_SIZE / 2}px, ${c[1] - LOUPE_SIZE / 2}px)`;
      ctx.clearRect(0, 0, px, px);
      const blit = clipBlit(loupeSourceRect(u.center, u.previewPerCss), u.bitmap.width, u.bitmap.height, px);
      if (blit) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(u.bitmap, blit.sx, blit.sy, blit.sw, blit.sh, blit.dx, blit.dy, blit.dw, blit.dh);
      }
    },
    hide() {
      root.hidden = true;
    },
    dispose() {
      canvas.width = 0;
      canvas.height = 0;
      root.remove();
    },
  };
}
