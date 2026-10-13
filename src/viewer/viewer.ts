// The zoomable image viewer (design 2.12): one viewport canvas, rAF with a dirty flag, pinch / double tap / pan with inertia,
// base + full bitmap through the memory gate (as a gate holder), tile-mode fallback, rotation in 90 degree steps.
import type { BitmapHandle } from '../app/bitmap-handle.ts';
import { getMaxDecodePixels } from '../app/canvas-limits.ts';
import { decodeRaw, type ImageInfo } from '../app/decode.ts';
import { decodeGuarded } from '../app/decode-guarded.ts';
import { log } from '../app/log.ts';
import { memoryGate, type MemoryGate } from '../app/memory-gate.ts';
import type { Rotation } from '../cv/geometry.ts';
import { ViewerBitmaps, VIEWER_HOLDER_ID, type DecodeRequest, type ViewerDecode } from './bitmaps.ts';
import { attachGestures } from './gestures.ts';
import { INERTIA_STOP_SPEED, speedOf, stepInertia, type Velocity } from './inertia.ts';
import { tilesForRect } from './tile-cache.ts';
import {
  CRISP_SCALE,
  OVERSHOOT,
  backingSize,
  clampScale,
  clampTranslation,
  doubleTapTarget,
  drawMatrix,
  easeInOut,
  easeOutCubic,
  fitView,
  lerpView,
  normalizeRotation,
  visibleSourceRect,
  zoomAbout,
  zoomFactor,
  zoomLimits,
  type Size,
  type View,
} from './transform.ts';

export const HIDDEN_RELEASE_MS = 30_000;
export const SPRING_MS = 200;
export const ZOOM_ANIM_MS = 250;
const MAX_TILE_REQUESTS = 24;

export interface ViewerInit {
  host: HTMLElement;
  shotId: string;
  /** The blob to show: the rectified JPEG, or the stored original of an uncorrected shot. */
  blob: Blob;
  /** Stored size and EXIF orientation of `blob` (orientation 1 for the rectified blob). */
  info: ImageInfo;
  /** Oriented pixel size of the image (rectified size, or the oriented original). */
  imageW: number;
  imageH: number;
  rotation: Rotation;
  thumb?: Blob;
  /** Called when the user rotates; the caller persists it (`updateShotParams`). */
  onRotationChange?(rotation: Rotation): void;
  onStatus?(status: ViewerStatus): void;
  gate?: MemoryGate;
}

export interface ViewerStatus {
  /** The first image (base bitmap) is not on screen yet. */
  opening: boolean;
  /** "Loading full resolution" badge. */
  loadingFull: boolean;
  /** "Detail paused while exporting" badge. */
  paused: boolean;
  /** "Shown at reduced resolution; export uses the original" notice. */
  reduced: boolean;
  tileMode: boolean;
  failed: boolean;
  /** The full bitmap can be lent out (rotated share without a second decode). */
  fullReady: boolean;
  zoom: number;
  rotation: Rotation;
}

export interface Viewer {
  readonly el: HTMLElement;
  /** Resolves when the base bitmap is on screen; rejects if the image cannot be decoded. */
  readonly opened: Promise<void>;
  status(): ViewerStatus;
  rotate(delta: 90 | -90): void;
  setRotation(rotation: Rotation): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  lendFullBitmap<T>(fn: (handle: BitmapHandle) => Promise<T>): Promise<T | null>;
  dispose(): void;
}

const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createViewer(init: ViewerInit): Viewer {
  const gate = init.gate ?? memoryGate;
  const { imageW, imageH } = init;
  let rotation: Rotation = init.rotation;
  let view: View = { scale: 1, tx: 0, ty: 0 };
  let vp: Size = { w: 1, h: 1 };
  let atFit = true;
  let dirty = true;
  let frame = 0;
  let disposed = false;
  let anim: { from: View; to: View; start: number; ms: number; ease: (t: number) => number } | null = null;
  let inertia: { v: Velocity; last: number } | null = null;
  let lastAnchor = { x: 0, y: 0 };
  let lastZoomReported = 0;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanups: Array<() => void> = [];

  const canvas = document.createElement('canvas');
  canvas.className = 'viewer-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Photo. Pinch or use plus and minus to zoom, drag or arrow keys to move.');
  const root = document.createElement('div');
  root.className = 'viewer';
  root.append(canvas);
  init.host.append(root);
  const ctx = canvas.getContext('2d', { alpha: false });

  // ---- bitmaps ----
  const decode: ViewerDecode = (req: DecodeRequest) =>
    decodeGuarded(
      init.blob,
      { info: init.info, maxPixels: req.maxPixels, maxLongEdge: req.maxLongEdge, crop: req.crop, holderId: VIEWER_HOLDER_ID, label: `viewer-${req.role}` },
      { shotId: init.shotId, kind: 'view' },
    );
  const bitmaps = new ViewerBitmaps({
    imageW,
    imageH,
    decode,
    gate,
    maxFullPixels: getMaxDecodePixels(),
    onChange: () => {
      if (disposed) return;
      relimit();
      dirty = true;
      schedule();
      report();
    },
  });

  // ---- geometry helpers ----
  const fit = (): View => fitView(imageW, imageH, rotation, vp);
  const limits = () => zoomLimits(fit().scale, bitmaps.bitmapScale);
  const clampView = (v: View): View => clampTranslation({ ...v, scale: clampScale(v.scale, limits()) }, imageW, imageH, rotation, vp);

  function relimit(): void {
    if (atFit) view = fit();
    else view = clampView(view);
  }

  function status(): ViewerStatus {
    const fitScale = fit().scale;
    return {
      opening: bitmaps.base === null && bitmaps.state !== 'failed',
      loadingFull: bitmaps.state === 'loading' && bitmaps.base !== null,
      paused: bitmaps.state === 'paused',
      reduced: bitmaps.reduced,
      tileMode: bitmaps.state === 'tile',
      failed: bitmaps.state === 'failed',
      fullReady: bitmaps.state === 'ready' && bitmaps.full !== null && !bitmaps.reduced,
      zoom: zoomFactor(view.scale, fitScale),
      rotation,
    };
  }
  function report(): void {
    lastZoomReported = zoomFactor(view.scale, fit().scale);
    init.onStatus?.(status());
  }

  // ---- animation loop ----
  function schedule(): void {
    if (frame || disposed) return;
    frame = requestAnimationFrame(tick);
  }

  function animateTo(to: View, ms: number, ease: (t: number) => number): void {
    inertia = null;
    if (prefersReducedMotion() || ms <= 0) {
      anim = null;
      setView(to, false);
      return;
    }
    anim = { from: view, to, start: performance.now(), ms, ease };
    schedule();
  }

  function setView(v: View, keepFit: boolean): void {
    view = v;
    atFit = keepFit && Math.abs(zoomFactor(v.scale, fit().scale) - 1) < 0.01;
    dirty = true;
    schedule();
  }

  function settle(): void {
    // spring back from pinch overshoot or from beyond the pan margin (200 ms ease-out)
    const target = clampView(view);
    if (Math.abs(target.scale - view.scale) > 1e-6 || Math.abs(target.tx - view.tx) > 0.5 || Math.abs(target.ty - view.ty) > 0.5) {
      const around = Math.abs(target.scale - view.scale) > 1e-6 ? clampTranslation(zoomAbout(view, target.scale, lastAnchor.x, lastAnchor.y), imageW, imageH, rotation, vp) : target;
      animateTo(around, SPRING_MS, easeOutCubic);
    }
  }

  function tick(now: number): void {
    frame = 0;
    if (disposed) return;
    if (anim) {
      const t = (now - anim.start) / anim.ms;
      const done = t >= 1;
      view = done ? anim.to : lerpView(anim.from, anim.to, anim.ease(t));
      atFit = done && Math.abs(zoomFactor(view.scale, fit().scale) - 1) < 0.01;
      if (done) anim = null;
      dirty = true;
    }
    if (inertia) {
      const dt = Math.min(now - inertia.last, 64);
      inertia.last = now;
      const s = stepInertia(inertia.v, dt);
      inertia.v = s.v;
      const next = clampTranslation({ ...view, tx: view.tx + s.dx, ty: view.ty + s.dy }, imageW, imageH, rotation, vp);
      const blocked = Math.abs(next.tx - (view.tx + s.dx)) > 0.5 && Math.abs(next.ty - (view.ty + s.dy)) > 0.5;
      view = next;
      atFit = false;
      dirty = true;
      if (s.done || blocked) inertia = null;
    }
    if (dirty) {
      dirty = false;
      draw();
      if (Math.abs(zoomFactor(view.scale, fit().scale) - lastZoomReported) > 0.02) report();
    }
    if (anim || inertia) schedule();
  }

  // ---- drawing ----
  function drawBitmap(bmp: ImageBitmap, kScale: number): void {
    if (!ctx) return;
    const m = drawMatrix(rotation, bmp.width, bmp.height, view.scale / kScale, view.tx, view.ty);
    const rect = visibleSourceRect(m, vp, bmp.width, bmp.height);
    if (!rect) return;
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.imageSmoothingEnabled = view.scale / kScale <= CRISP_SCALE;
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, rect.sx, rect.sy, rect.sw, rect.sh, rect.sx, rect.sy, rect.sw, rect.sh);
  }

  function draw(): void {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const full = bitmaps.full;
    const base = bitmaps.base;
    const baseScale = base ? base.width / imageW : 0;
    if (full && !bitmaps.fullAliased && view.scale > baseScale) {
      drawBitmap(full.handle.bitmap, full.width / imageW);
    } else if (base) {
      drawBitmap(base.handle.bitmap, baseScale);
      if (bitmaps.state === 'tile' && view.scale > baseScale) drawTiles(baseScale);
    } else if (bitmaps.thumb) {
      drawBitmap(bitmaps.thumb.handle.bitmap, bitmaps.thumb.width / imageW);
    }
  }

  function drawTiles(baseScale: number): void {
    if (!ctx) return;
    const m = drawMatrix(rotation, imageW, imageH, view.scale, view.tx, view.ty);
    const rect = visibleSourceRect(m, vp, imageW, imageH);
    if (!rect || view.scale <= baseScale) return;
    const refs = tilesForRect(rect, imageW, imageH);
    if (refs.length > MAX_TILE_REQUESTS) return; // the base bitmap is detailed enough at this zoom
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.imageSmoothingEnabled = view.scale <= CRISP_SCALE;
    for (const r of refs) {
      const t = bitmaps.tiles.get(r.key);
      if (t && !t.closed) ctx.drawImage(t.bitmap, r.x, r.y);
    }
    bitmaps.wantTiles(refs);
  }

  // ---- sizing ----
  function resize(): void {
    const rect = init.host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const size = backingSize(rect.width, rect.height, window.devicePixelRatio || 1);
    if (size.w === canvas.width && size.h === canvas.height) return;
    canvas.width = size.w;
    canvas.height = size.h;
    vp = size;
    relimit();
    dirty = true;
    schedule();
  }
  resize();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(resize);
    ro.observe(init.host);
    cleanups.push(() => ro.disconnect());
  }

  const toDevice = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    const w = r.width || 1;
    const h = r.height || 1;
    return { x: ((clientX - r.left) * canvas.width) / w, y: ((clientY - r.top) * canvas.height) / h };
  };

  // ---- interaction ----
  function zoomTo(scale: number, ax: number, ay: number, animate: boolean): void {
    const target = clampView(zoomAbout(view, clampScale(scale, limits()), ax, ay));
    if (animate) animateTo(target, ZOOM_ANIM_MS, easeInOut);
    else setView(target, true);
  }
  const center = (): { x: number; y: number } => ({ x: vp.w / 2, y: vp.h / 2 });

  cleanups.push(
    attachGestures(canvas, {
      toDevice,
      gestures: {
        onStart: () => {
          anim = null;
          inertia = null;
        },
        onPan: (dx, dy) => {
          const next = clampTranslation({ ...view, tx: view.tx + dx, ty: view.ty + dy }, imageW, imageH, rotation, vp);
          setView(next, false);
        },
        onPinch: ({ ratio, from, to }) => {
          lastAnchor = to;
          const s = clampScale(view.scale * ratio, limits(), OVERSHOOT);
          const zoomed = zoomAbout(view, s, from.x, from.y);
          setView(clampTranslation({ ...zoomed, tx: zoomed.tx + (to.x - from.x), ty: zoomed.ty + (to.y - from.y) }, imageW, imageH, rotation, vp), false);
        },
        onRelease: (v) => {
          if (speedOf(v) >= INERTIA_STOP_SPEED && !prefersReducedMotion()) {
            inertia = { v, last: performance.now() };
            schedule();
          } else {
            settle();
          }
        },
        onDoubleTap: (x, y) => {
          const f = fit();
          animateTo(doubleTapTarget(view, f, limits(), x, y, imageW, imageH, rotation, vp), ZOOM_ANIM_MS, easeInOut);
        },
      },
      wheel: {
        zoomAt: (factor, x, y) => zoomTo(view.scale * factor, x, y, false),
        panBy: (dx, dy) => setView(clampTranslation({ ...view, tx: view.tx + dx, ty: view.ty + dy }, imageW, imageH, rotation, vp), false),
      },
      keyboard: {
        zoomIn: () => zoomTo(view.scale * 1.5, center().x, center().y, true),
        zoomOut: () => zoomTo(view.scale / 1.5, center().x, center().y, true),
        fit: () => animateTo(fit(), ZOOM_ANIM_MS, easeInOut),
        pan: (dx, dy) => animateTo(clampTranslation({ ...view, tx: view.tx + dx, ty: view.ty + dy }, imageW, imageH, rotation, vp), 120, easeOutCubic),
      },
    }),
  );

  // ---- hidden tab releases the full bitmap after 30 s ----
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        void bitmaps.suspend();
      }, HIDDEN_RELEASE_MS);
    } else {
      if (hiddenTimer !== null) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      void bitmaps.resume().catch((e: unknown) => log.warn('viewer resume failed', e));
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  // ---- open ----
  relimit();
  view = fit();
  const opened = (async (): Promise<void> => {
    if (init.thumb) {
      try {
        const t = await decodeRaw(init.thumb, { label: 'viewer-thumb' });
        bitmaps.setThumb(t);
      } catch (e) {
        log.warn('viewer thumbnail could not be drawn', e);
      }
    }
    await bitmaps.open();
  })();
  opened.catch(() => {
    // the caller shows the error; the status carries `failed`
  });
  report();

  function applyRotation(r: Rotation, notify: boolean): void {
    if (r === rotation) return;
    rotation = r;
    anim = null;
    inertia = null;
    atFit = true;
    view = fit();
    dirty = true;
    schedule();
    report();
    if (notify) init.onRotationChange?.(r);
  }

  return {
    el: root,
    opened,
    status,
    rotate: (delta) => applyRotation(normalizeRotation(rotation + delta), true),
    setRotation: (r) => applyRotation(r, false),
    zoomIn: () => zoomTo(view.scale * 1.5, center().x, center().y, true),
    zoomOut: () => zoomTo(view.scale / 1.5, center().x, center().y, true),
    fit: () => animateTo(fit(), ZOOM_ANIM_MS, easeInOut),
    lendFullBitmap: (fn) => bitmaps.lendFull(fn),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      for (const c of cleanups) c();
      bitmaps.dispose();
      canvas.width = 0;
      canvas.height = 0;
      root.remove();
    },
  };
}
