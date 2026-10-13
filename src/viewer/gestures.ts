// Gesture recognition for the viewer (design 2.12): one pointer pans, two pointers pinch, a quick second tap zooms.
// GestureRecognizer is pure (no DOM, coordinates and times are passed in) so it can be unit-tested; attachGestures()
// wires Pointer Events (with pointer capture), wheel and keyboard to it.
import { releaseVelocity, VELOCITY_SAMPLES, type Sample, type Velocity } from './inertia.ts';

export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DISTANCE = 30;
/** A touch that moved less than this and was shorter than DOUBLE_TAP_MS is a tap. */
export const TAP_SLOP = 10;

export interface PinchDelta {
  /** New distance / previous distance between the two pointers. */
  ratio: number;
  /** Previous midpoint: the image point under it stays under the new midpoint. */
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface GestureHandlers {
  /** A pointer went down: stop inertia and animations. */
  onStart(): void;
  onPan(dx: number, dy: number): void;
  onPinch(delta: PinchDelta): void;
  /** Every pointer is up. `velocity` is zero after a pinch or a tap. */
  onRelease(velocity: Velocity): void;
  onDoubleTap(x: number, y: number): void;
}

interface Tracked {
  x: number;
  y: number;
}

export class GestureRecognizer {
  private readonly pointers = new Map<number, Tracked>();
  private samples: Sample[] = [];
  private down: { t: number; x: number; y: number } | null = null;
  private moved = 0;
  private pinched = false;
  private lastTap: { t: number; x: number; y: number } | null = null;

  constructor(private readonly handlers: GestureHandlers) {}

  get active(): number {
    return this.pointers.size;
  }

  pointerDown(id: number, x: number, y: number, t: number): void {
    if (this.pointers.size === 0) {
      this.down = { t, x, y };
      this.moved = 0;
      this.pinched = false;
    } else {
      this.pinched = true;
    }
    this.pointers.set(id, { x, y });
    this.samples = this.pointers.size === 1 ? [{ t, x, y }] : [];
    this.handlers.onStart();
  }

  pointerMove(id: number, x: number, y: number, t: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    if (this.pointers.size === 1) {
      const dx = x - p.x;
      const dy = y - p.y;
      p.x = x;
      p.y = y;
      if (this.down) this.moved = Math.max(this.moved, Math.hypot(x - this.down.x, y - this.down.y));
      this.samples.push({ t, x, y });
      if (this.samples.length > VELOCITY_SAMPLES * 2) this.samples.splice(0, this.samples.length - VELOCITY_SAMPLES * 2);
      if (dx !== 0 || dy !== 0) this.handlers.onPan(dx, dy);
      return;
    }
    if (this.pointers.size === 2) {
      const [a, b] = Array.from(this.pointers.values()) as [Tracked, Tracked];
      const before = { dist: Math.hypot(b.x - a.x, b.y - a.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      p.x = x;
      p.y = y;
      const after = { dist: Math.hypot(b.x - a.x, b.y - a.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.moved = Infinity;
      if (before.dist > 0 && after.dist > 0) {
        this.handlers.onPinch({ ratio: after.dist / before.dist, from: { x: before.x, y: before.y }, to: { x: after.x, y: after.y } });
      }
    }
  }

  pointerUp(id: number, x: number, y: number, t: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    if (this.pointers.size > 0) {
      // one finger of a pinch lifted: the remaining finger can pan again, without a velocity from the pinch
      this.samples = [];
      const [rest] = Array.from(this.pointers.values());
      if (rest) this.samples = [{ t, x: rest.x, y: rest.y }];
      return;
    }
    const wasTap = !this.pinched && this.down !== null && this.moved < TAP_SLOP && t - this.down.t < DOUBLE_TAP_MS;
    if (wasTap) {
      const prev = this.lastTap;
      if (prev && t - prev.t <= DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_DISTANCE) {
        this.lastTap = null;
        this.handlers.onDoubleTap(x, y);
        this.handlers.onRelease({ vx: 0, vy: 0 });
        return;
      }
      this.lastTap = { t, x, y };
    } else {
      this.lastTap = null;
    }
    const v = this.pinched || wasTap ? { vx: 0, vy: 0 } : releaseVelocity([...this.samples, { t, x, y }], t);
    this.samples = [];
    this.handlers.onRelease(v);
  }

  pointerCancel(id: number): void {
    if (!this.pointers.delete(id)) return;
    this.samples = [];
    if (this.pointers.size === 0) this.handlers.onRelease({ vx: 0, vy: 0 });
  }

  reset(): void {
    this.pointers.clear();
    this.samples = [];
    this.lastTap = null;
  }
}

// ---- DOM wiring ----

export interface KeyboardHandlers {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  pan(dx: number, dy: number): void;
}

export interface WheelHandler {
  /** Exponential zoom about the cursor; `factor` > 1 zooms in. */
  zoomAt(factor: number, x: number, y: number): void;
  panBy(dx: number, dy: number): void;
}

export interface AttachOptions {
  gestures: GestureHandlers;
  keyboard: KeyboardHandlers;
  wheel: WheelHandler;
  /** Client (CSS) coordinates to device pixels of the canvas backing store. */
  toDevice(clientX: number, clientY: number): { x: number; y: number };
}

/** Binds Pointer Events, wheel and keyboard to `target`. Returns an undo function. */
export function attachGestures(target: HTMLElement, o: AttachOptions): () => void {
  const rec = new GestureRecognizer(o.gestures);
  const pt = (ev: PointerEvent) => o.toDevice(ev.clientX, ev.clientY);
  const down = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      // capture can fail for synthetic events; gestures still work while the pointer stays over the canvas
    }
    const p = pt(ev);
    rec.pointerDown(ev.pointerId, p.x, p.y, ev.timeStamp);
  };
  const move = (ev: PointerEvent): void => {
    const p = pt(ev);
    rec.pointerMove(ev.pointerId, p.x, p.y, ev.timeStamp);
  };
  const up = (ev: PointerEvent): void => {
    const p = pt(ev);
    rec.pointerUp(ev.pointerId, p.x, p.y, ev.timeStamp);
  };
  const cancel = (ev: PointerEvent): void => rec.pointerCancel(ev.pointerId);
  const wheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const p = o.toDevice(ev.clientX, ev.clientY);
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    const dy = ev.deltaY * unit;
    if (ev.ctrlKey || ev.metaKey) o.wheel.zoomAt(Math.exp(-dy * 0.01), p.x, p.y);
    else o.wheel.zoomAt(Math.exp(-dy * 0.0015), p.x, p.y);
  };
  const key = (ev: KeyboardEvent): void => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const step = 80;
    switch (ev.key) {
      case '+':
      case '=':
        o.keyboard.zoomIn();
        break;
      case '-':
      case '_':
        o.keyboard.zoomOut();
        break;
      case '0':
        o.keyboard.fit();
        break;
      case 'ArrowLeft':
        o.keyboard.pan(step, 0);
        break;
      case 'ArrowRight':
        o.keyboard.pan(-step, 0);
        break;
      case 'ArrowUp':
        o.keyboard.pan(0, step);
        break;
      case 'ArrowDown':
        o.keyboard.pan(0, -step);
        break;
      default:
        return;
    }
    ev.preventDefault();
  };
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', cancel);
  target.addEventListener('wheel', wheel, { passive: false });
  target.addEventListener('keydown', key);
  return () => {
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', cancel);
    target.removeEventListener('wheel', wheel);
    target.removeEventListener('keydown', key);
    rec.reset();
  };
}
