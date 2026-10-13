// Corner editor: SVG overlay with four draggable, keyboard-operable handles (design 2.14, AC-10, AC-11).
// Works in PREVIEW pixel space. The caller supplies `isValid`, which converts to ORIGINAL pixels before validateQuad
// (plan.md finding 13). The drag semantics are pure functions below so they can be tested without a DOM.
import type { Pt, Quad } from '../../cv/geometry.ts';
import { svgEl } from '../dom.ts';

export const CORNER_LABELS = ['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner'] as const;
/** Visible dot radius and hit radius in CSS px (a 56 px hit area around a 14 px dot). */
export const DOT_RADIUS = 7;
export const HIT_RADIUS = 28;

export interface Bounds {
  width: number;
  height: number;
}
export type QuadValidator = (quad: Quad) => boolean;

export function clampPoint(p: Pt, b: Bounds): Pt {
  return [Math.min(b.width, Math.max(0, p[0])), Math.min(b.height, Math.max(0, p[1]))];
}

export function replaceCorner(q: Quad, index: number, p: Pt): Quad {
  const next = [q[0], q[1], q[2], q[3]] as [Pt, Pt, Pt, Pt];
  next[index] = p;
  return next;
}

export interface MoveResult {
  quad: Quad;
  /** The proposed position was invalid; the handle stays where it was last valid. */
  frozen: boolean;
}

/**
 * One pointer move. The target is clamped to the image; if the resulting quad is invalid the handle FREEZES at its last valid
 * position (it neither snaps back to where the drag began nor slides along a boundary) and follows the finger again as soon as
 * a later target gives a valid quad. Stateless on purpose: "last valid" is simply the current quad.
 */
export function moveCorner(quad: Quad, index: number, target: Pt, bounds: Bounds, isValid: QuadValidator): MoveResult {
  const candidate = replaceCorner(quad, index, clampPoint(target, bounds));
  return isValid(candidate) ? { quad: candidate, frozen: false } : { quad, frozen: true };
}

/** Arrow-key nudge in preview pixels (1 px, 10 px with Shift). */
export function nudgeCorner(quad: Quad, index: number, dx: number, dy: number, bounds: Bounds, isValid: QuadValidator): MoveResult {
  const cur = quad[index]!;
  return moveCorner(quad, index, [cur[0] + dx, cur[1] + dy], bounds, isValid);
}

export const nudgeStep = (shift: boolean): number => (shift ? 10 : 1);

export interface DragState {
  index: number;
  /** Handle position in preview px. */
  point: Pt;
  frozen: boolean;
}

export interface CornerEditorOptions {
  /** Preview bitmap size in px (the coordinate space of the quad). */
  width: number;
  height: number;
  quad: Quad;
  isValid: QuadValidator;
  onChange(quad: Quad, via: 'drag' | 'key'): void;
  /** Fires while a handle is held (null when released). Drives the loupe. */
  onDrag?(state: DragState | null): void;
}

export interface CornerEditor {
  el: SVGSVGElement;
  setQuad(q: Quad): void;
  getQuad(): Quad;
  /** Size of the element on screen in CSS px (keeps handle sizes constant while the preview scales). */
  setDisplaySize(w: number, h: number): void;
  setDisabled(disabled: boolean): void;
  dispose(): void;
}

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function createCornerEditor(opts: CornerEditorOptions): CornerEditor {
  const bounds: Bounds = { width: opts.width, height: opts.height };
  let quad: Quad = opts.quad;
  let dw = opts.width;
  let dh = opts.height;
  let disabled = false;

  const svg = svgEl('svg', { class: 'corner-editor', viewBox: `0 0 ${dw} ${dh}`, role: 'group', 'aria-label': 'Poster corners' });
  const poly = svgEl('polygon', { class: 'corner-poly' });
  svg.append(poly);

  interface Handle {
    g: SVGGElement;
  }
  const handles: Handle[] = CORNER_LABELS.map((label) => {
    const g = svgEl(
      'g',
      { class: 'corner-handle', tabindex: 0, role: 'button', 'aria-label': label },
      svgEl('circle', { class: 'corner-hit', r: HIT_RADIUS }),
      svgEl('circle', { class: 'corner-dot', r: DOT_RADIUS }),
    );
    svg.append(g);
    return { g };
  });

  const k = (): number => dw / opts.width;
  const render = (): void => {
    const s = k();
    poly.setAttribute('points', quad.map((p) => `${p[0] * s},${p[1] * s}`).join(' '));
    handles.forEach((h, i) => h.g.setAttribute('transform', `translate(${quad[i]![0] * s} ${quad[i]![1] * s})`));
  };
  const setFrozen = (index: number, frozen: boolean): void => {
    handles[index]?.g.classList.toggle('is-frozen', frozen);
  };

  const toPreview = (ev: PointerEvent): Pt => {
    const r = svg.getBoundingClientRect();
    const sx = r.width > 0 ? opts.width / r.width : 1;
    const sy = r.height > 0 ? opts.height / r.height : 1;
    return [(ev.clientX - r.left) * sx, (ev.clientY - r.top) * sy];
  };

  let drag: { index: number; pointerId: number; offset: Pt } | null = null;
  const cleanups: Array<() => void> = [];
  const listen = <K extends keyof SVGElementEventMap>(node: SVGElement, type: K, fn: (ev: SVGElementEventMap[K]) => void): void => {
    node.addEventListener(type, fn as EventListener);
    cleanups.push(() => node.removeEventListener(type, fn as EventListener));
  };

  handles.forEach((h, index) => {
    listen(h.g, 'pointerdown', (ev) => {
      if (disabled) return;
      ev.preventDefault();
      const p = toPreview(ev);
      const cur = quad[index]!;
      // keep the grabbed offset so the handle does not jump under the finger
      drag = { index, pointerId: ev.pointerId, offset: [cur[0] - p[0], cur[1] - p[1]] };
      try {
        h.g.setPointerCapture(ev.pointerId);
      } catch {
        // synthetic events without an active pointer cannot be captured
      }
      h.g.classList.add('is-active');
      h.g.focus({ preventScroll: true });
      opts.onDrag?.({ index, point: cur, frozen: false });
    });
    listen(h.g, 'pointermove', (ev) => {
      if (!drag || drag.pointerId !== ev.pointerId || drag.index !== index) return;
      ev.preventDefault();
      const p = toPreview(ev);
      const res = moveCorner(quad, index, [p[0] + drag.offset[0], p[1] + drag.offset[1]], bounds, opts.isValid);
      setFrozen(index, res.frozen);
      if (res.quad !== quad) {
        quad = res.quad;
        render();
        opts.onChange(quad, 'drag');
      }
      opts.onDrag?.({ index, point: quad[index]!, frozen: res.frozen });
    });
    const end = (ev: PointerEvent): void => {
      if (!drag || drag.pointerId !== ev.pointerId) return;
      drag = null;
      h.g.classList.remove('is-active');
      setFrozen(index, false);
      opts.onDrag?.(null);
    };
    listen(h.g, 'pointerup', end);
    listen(h.g, 'pointercancel', end);
    listen(h.g, 'keydown', (ev) => {
      if (disabled) return;
      const dir = ARROWS[ev.key];
      if (!dir) return;
      ev.preventDefault();
      const step = nudgeStep(ev.shiftKey);
      const res = nudgeCorner(quad, index, dir[0] * step, dir[1] * step, bounds, opts.isValid);
      setFrozen(index, res.frozen);
      if (res.quad !== quad) {
        quad = res.quad;
        render();
        opts.onChange(quad, 'key');
      }
    });
    listen(h.g, 'keyup', () => setFrozen(index, false));
    listen(h.g, 'blur', () => setFrozen(index, false));
  });

  render();
  return {
    el: svg,
    setQuad(q) {
      quad = q;
      render();
    },
    getQuad: () => quad,
    setDisplaySize(w, h) {
      if (w <= 0 || h <= 0) return;
      dw = w;
      dh = h;
      svg.setAttribute('viewBox', `0 0 ${dw} ${dh}`);
      render();
    },
    setDisabled(d) {
      disabled = d;
      svg.classList.toggle('is-disabled', d);
      handles.forEach((h) => h.g.setAttribute('tabindex', d ? '-1' : '0'));
    },
    dispose() {
      for (const c of cleanups) c();
      cleanups.length = 0;
      svg.remove();
    },
  };
}
