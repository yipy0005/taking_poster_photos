// Capture screen (design 2.9, 2.14, 2.16; AC-1..7, 20, 46): live rear camera with a rule-of-thirds and poster-frame overlay, the
// achieved-resolution readout, capability-gated controls, always-available gallery and native-camera inputs, camera error screens,
// and the guided detail mode (2x2 / 3x3). Tracks are stopped on route change and whenever the document is hidden.
import { getMaxOutputPixels, getMaxSourcePixels } from '../../app/canvas-limits.ts';
import { CameraError, CaptureError } from '../../app/errors.ts';
import { log } from '../../app/log.ts';
import { routeToHash } from '../../app/router.ts';
import {
  formatResolution,
  hasImageCapture,
  mapTapToVideo,
  suggestNativeCamera,
} from '../../camera/capabilities.ts';
import { openCamera, mapCameraError, type CameraSession } from '../../camera/camera-session.ts';
import { captureStill, probeStillSize } from '../../camera/capture.ts';
import { cellRect, gridCellFor, type NormRect } from '../../camera/detail-grid.ts';
import { orientedDims, readBlobHeader } from '../../camera/exif.ts';
import { createIngestDeps, ingestImage, type IngestDeps } from '../../camera/ingest.ts';
import type { ShotRecord, ShotSource } from '../../storage/schema.ts';
import { confirmDialog } from '../components/dialog.ts';
import { createTopbar } from '../components/topbar.ts';
import { button, clear, el } from '../dom.ts';
import type { Screen } from '../context.ts';
import {
  ACTION_LABELS,
  cameraErrorScreen,
  captureTitle,
  describeIngestError,
  lastGridShot,
  planDetail,
  type DetailPlan,
  type ErrorAction,
} from './capture-logic.ts';

/** Frame guide inset (design 2.9 overlay): 6% on every side. */
const FRAME_INSET = 0.06;

export const captureScreen: Screen = (root, ctx, route) => {
  if (route.name !== 'capture') return () => {};
  const cap = route; // narrowed to the capture route (stays narrowed inside closures)
  const mode = cap.mode;
  const posterId = cap.poster;

  // ---- state ----
  let disposed = false;
  let busy = false;
  let session: CameraSession | null = null;
  let startToken = 0;
  let errorShown = false;
  let torchOn = false;
  let plan: DetailPlan | null = null;
  let stillSize: { width: number; height: number } | null = null;
  let posterShots: ShotRecord[] = [];

  const ingestDeps: IngestDeps = createIngestDeps(ctx.store, {
    confirmReduce: ({ megapixels }) =>
      confirmDialog({
        title: 'Very large photo',
        message: `This photo is ${megapixels} MP, more than this app can work with. Save a reduced copy, or discard it? The original stays in your camera roll.`,
        confirmLabel: 'Save a reduced copy',
        cancelLabel: 'Discard',
      }),
    onUnreadable: () => ctx.toast.show("Can't read this image", { kind: 'warn' }),
  });

  // ---- DOM ----
  const backRoute = posterId ? routeToHash({ name: 'poster', id: posterId }) : routeToHash({ name: 'library' });
  const topbar = createTopbar({ title: captureTitle(mode, null), backHref: backRoute });
  const titleEl = topbar.querySelector<HTMLElement>('.topbar-title')!;
  titleEl.setAttribute('aria-live', 'polite');
  const resolutionChip = el('span', { class: 'chip-static', attrs: { 'aria-label': 'Photo resolution', hidden: true } });
  topbar.querySelector('.topbar-actions')?.append(resolutionChip);

  const video = el('video', { class: 'capture-video', attrs: { playsinline: true, muted: true, autoplay: true, 'aria-label': 'Live camera preview' } });
  video.muted = true;
  const frame = el('div', { class: 'guide-frame', attrs: { 'aria-hidden': 'true' } });
  const guides = el(
    'div',
    { class: 'guides', attrs: { 'aria-hidden': 'true' } },
    el('span', { class: 'guide-line guide-v1' }),
    el('span', { class: 'guide-line guide-v2' }),
    el('span', { class: 'guide-line guide-h1' }),
    el('span', { class: 'guide-line guide-h2' }),
    frame,
  );
  const cellsHost = el('div', { class: 'guide-cells', attrs: { 'aria-hidden': 'true' } });
  const focusRing = el('span', { class: 'focus-ring', attrs: { hidden: true, 'aria-hidden': 'true' } });
  const stage = el('div', { class: 'capture-stage' }, video, guides, cellsHost, focusRing);
  const errorHost = el('section', { class: 'capture-error', attrs: { hidden: true } });
  const status = el('p', { class: 'capture-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const nativeHint = el('div', { class: 'native-hint', attrs: { hidden: true } });
  const guidedPanel = el('div', { class: 'guided-panel', attrs: { hidden: true } });
  const zoomWrap = el('label', { class: 'zoom', attrs: { hidden: true } });
  const zoomInput = el('input', { attrs: { type: 'range', 'aria-label': 'Zoom' } });
  zoomWrap.append(el('span', { text: 'Zoom' }), zoomInput);

  const gallery = el('input', { class: 'file-input', attrs: { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: -1 } });
  const nativeInput = el('input', { class: 'file-input', attrs: { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, 'aria-hidden': 'true', tabindex: -1 } });
  const galleryBtn = button('Gallery', () => gallery.click(), 'btn', { 'aria-label': 'Choose from gallery' });
  const nativeBtn = button('Native camera', () => nativeInput.click(), 'btn', { 'aria-label': 'Use native camera' });
  const torchBtn = button('Torch', () => void toggleTorch(), 'btn', { 'aria-pressed': 'false', 'aria-label': 'Torch', hidden: true, title: 'Avoid flash on glossy posters (glare)' });
  const gridBtn = button('Grid', () => toggleGuides(), 'btn', { 'aria-pressed': 'true', 'aria-label': 'Show guides' });
  const shutter = button('', () => void shoot(), 'btn shutter', { 'aria-label': 'Take photo', disabled: true });
  shutter.append(el('span', { class: 'shutter-ring', attrs: { 'aria-hidden': 'true' } }));
  const bar = el('div', { class: 'action-bar capture-actions', attrs: { role: 'group', 'aria-label': 'Capture actions' } }, galleryBtn, nativeBtn, shutter, torchBtn, gridBtn);

  const body = el('div', { class: 'capture-body' }, stage, errorHost, status, nativeHint, guidedPanel, zoomWrap);
  root.replaceChildren(topbar, el('div', { class: 'capture-layout screen-with-rail' }, body, bar), gallery, nativeInput);

  // ---- readout and hints ----
  const achieved = (): { width: number; height: number } | null => {
    if (stillSize) return stillSize;
    const s = session?.size();
    if (s) return s;
    return video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null;
  };

  const updateReadout = (): void => {
    const a = achieved();
    resolutionChip.hidden = !a;
    if (a) resolutionChip.textContent = formatResolution(a.width, a.height);
    nativeHint.replaceChildren();
    nativeHint.hidden = !(a && suggestNativeCamera(a.width, a.height));
    if (!nativeHint.hidden) {
      nativeHint.append(
        el('p', { text: 'This preview is below 8 MP. For a sharper photo, use the camera app.' }),
        button('Native camera (full resolution)', () => nativeInput.click(), 'btn btn-primary'),
      );
    }
  };

  function toggleGuides(): void {
    const on = stage.classList.toggle('guides-off');
    gridBtn.setAttribute('aria-pressed', String(!on));
  }

  // ---- guided detail mode ----
  const renderCells = (): void => {
    clear(cellsHost);
    guidedPanel.hidden = true;
    clear(guidedPanel);
    if (mode !== 'detail' || !plan) return;
    const dims = plan.dims;
    if (dims) {
      const total = dims.rows * dims.cols;
      for (let i = 0; i < total; i++) {
        const r: NormRect = cellRect(dims, i);
        const isCurrent = i === plan.cell;
        const isDone = plan.done.includes(i);
        const cell = el(
          'div',
          { class: `guide-cell${isCurrent ? ' is-current' : ''}${isDone ? ' is-done' : ''}${plan.skipped.includes(i) ? ' is-skipped' : ''}` },
          el('span', { class: 'guide-cell-label', text: isDone ? '\u2713' : String(i + 1) }),
        );
        // positions are percentages of the poster frame, set through the CSSOM (no inline style attributes: CSP)
        cell.style.left = `${(FRAME_INSET + r.x * (1 - 2 * FRAME_INSET)) * 100}%`;
        cell.style.top = `${(FRAME_INSET + r.y * (1 - 2 * FRAME_INSET)) * 100}%`;
        cell.style.width = `${r.w * (1 - 2 * FRAME_INSET) * 100}%`;
        cell.style.height = `${r.h * (1 - 2 * FRAME_INSET) * 100}%`;
        cellsHost.append(cell);
      }
    }
    titleEl.textContent = captureTitle(mode, plan.label);

    guidedPanel.hidden = false;
    const label = plan.dims
      ? plan.complete
        ? 'All detail shots are done.'
        : (plan.label ?? '')
      : 'Detail photo (no grid)';
    guidedPanel.append(el('p', { class: 'guided-label', text: label, attrs: { 'aria-live': 'polite' } }));
    const row = el('div', { class: 'guided-actions' });
    if (plan.dims && plan.cell !== null) row.append(button('Skip', () => void skipCell(), 'btn'));
    if (plan.dims && lastGridShot(posterShots)) row.append(button('Retake previous', () => void retakePrevious(), 'btn'));
    row.append(button('Finish', () => ctx.router.navigate({ name: 'poster', id: plan!.posterId }), plan.complete ? 'btn btn-primary' : 'btn'));
    guidedPanel.append(row);
  };

  async function loadPlan(): Promise<void> {
    if (mode !== 'detail' || !posterId) return;
    const detail = await ctx.store.getPoster(posterId);
    if (disposed) return;
    if (!detail) {
      plan = null;
      return;
    }
    posterShots = detail.shots;
    if (!detail.poster.detailGrid && cap.grid) {
      const dims = planDetail(detail.poster, [], cap.grid, undefined).dims;
      if (dims) {
        try {
          await ctx.store.updatePosterMeta(posterId, { detailGrid: { rows: dims.rows, cols: dims.cols, skipped: [] } });
        } catch (e) {
          log.warn('could not remember the detail grid', e);
        }
        detail.poster.detailGrid = { rows: dims.rows, cols: dims.cols, skipped: [] };
      }
    }
    plan = planDetail(detail.poster, detail.shots, cap.grid, cap.cell);
  }

  async function skipCell(): Promise<void> {
    if (!plan?.dims || plan.cell === null || !posterId) return;
    const skipped = [...plan.skipped, plan.cell];
    try {
      await ctx.store.updatePosterMeta(posterId, { detailGrid: { rows: plan.dims.rows, cols: plan.dims.cols, skipped } });
    } catch (e) {
      log.warn('skip failed', e);
      ctx.toast.show("Couldn't save, try again", { kind: 'error' });
      return;
    }
    // an explicit Retake cell is consumed once: continue with the derived sequence
    if (cap.cell !== undefined) {
      ctx.router.navigate({ name: 'capture', poster: posterId, mode: 'detail', grid: cap.grid }, { replace: true });
      return;
    }
    await loadPlan();
    if (!disposed) renderCells();
  }

  async function retakePrevious(): Promise<void> {
    const last = lastGridShot(posterShots);
    if (!last?.gridCell || !plan?.dims || !posterId) return;
    const idx = last.gridCell.row * last.gridCell.cols + last.gridCell.col;
    const ok = await confirmDialog({
      title: 'Retake this photo?',
      message: `The photo for cell ${idx + 1} will be deleted, then you can take it again.`,
      confirmLabel: 'Delete and retake',
      danger: true,
    });
    if (!ok || disposed) return;
    try {
      await ctx.store.deleteShot(last.id);
    } catch (e) {
      log.warn('retake delete failed', e);
      ctx.toast.show("Couldn't delete, try again", { kind: 'error' });
      return;
    }
    ctx.router.navigate({ name: 'capture', poster: posterId, mode: 'detail', grid: cap.grid ?? (plan.dims.rows === 2 ? '2x2' : '3x3'), cell: idx }, { replace: true });
  }

  // ---- submit (shared by the shutter and both file inputs) ----
  async function submit(blob: Blob, source: ShotSource): Promise<void> {
    status.textContent = 'Saving photo...';
    try {
      const detail = mode === 'detail' && posterId !== undefined;
      const gridCell = detail && plan?.dims && plan.cell !== null ? gridCellFor(plan.dims, plan.cell) : undefined;
      const res = await ingestImage({ blob, source, kind: detail ? 'detail' : 'overview', posterId, gridCell }, ingestDeps);
      if (!res) {
        status.textContent = '';
        return; // the user discarded a photo above the hard limit
      }
      if (res.notice) ctx.toast.show(res.notice, { kind: 'info', timeoutMs: 7000 });
      ctx.router.navigate({ name: 'adjust', id: res.shotId });
    } catch (e) {
      status.textContent = '';
      const m = describeIngestError(e);
      log.warn('ingest failed', e);
      ctx.toast.show(m.text, { kind: 'warn', timeoutMs: m.persistent ? 0 : 6000 });
    }
  }

  async function pickFile(input: HTMLInputElement, source: ShotSource): Promise<void> {
    const file = input.files?.[0];
    input.value = ''; // allow choosing the same file again
    if (!file || busy) return;
    busy = true;
    shutter.disabled = true;
    try {
      await submit(file, source);
    } finally {
      busy = false;
      if (!disposed) shutter.disabled = !session;
    }
  }
  gallery.addEventListener('change', () => void pickFile(gallery, 'file-gallery'));
  nativeInput.addEventListener('change', () => void pickFile(nativeInput, 'file-capture'));

  async function shoot(): Promise<void> {
    if (!session || busy) return;
    busy = true;
    shutter.disabled = true;
    status.textContent = 'Taking photo...';
    try {
      const shot = await captureStill({
        track: session.track,
        video,
        createCanvas: (w, h) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          return c;
        },
        maxSourcePixels: getMaxSourcePixels(),
        maxOutputPixels: getMaxOutputPixels(),
        torchOn,
      });
      // The real size of the blob replaces the stream resolution in the readout (design 2.9 overlay).
      try {
        const h = await readBlobHeader(shot.blob);
        if (h.width && h.height) {
          stillSize = orientedDims(h.width, h.height, h.orientation);
          updateReadout();
        }
      } catch {
        // the readout simply keeps its previous value
      }
      await submit(shot.blob, shot.source);
    } catch (e) {
      status.textContent = '';
      if (e instanceof CaptureError) ctx.toast.show('Capture failed, try again', { kind: 'error' });
      else {
        log.error('capture failed', e);
        ctx.toast.show('Capture failed, try again', { kind: 'error' });
      }
    } finally {
      busy = false;
      if (!disposed) shutter.disabled = !session;
    }
  }

  // ---- camera lifecycle ----
  function stopCamera(): void {
    startToken++;
    session?.stop();
    session = null;
    video.srcObject = null;
    shutter.disabled = true;
  }

  function showError(kind: CameraError['kind']): void {
    errorShown = true;
    stage.hidden = true;
    zoomWrap.hidden = true;
    torchBtn.hidden = true;
    resolutionChip.hidden = true;
    nativeHint.hidden = true;
    status.textContent = '';
    const screen = cameraErrorScreen(kind);
    const handlers: Record<ErrorAction, () => void> = {
      retry: () => void startCamera(),
      native: () => nativeInput.click(),
      gallery: () => gallery.click(),
    };
    errorHost.hidden = false;
    errorHost.replaceChildren(
      el('h2', { text: screen.title }),
      el('p', { text: screen.cause }),
      el('div', { class: 'error-actions' }, ...screen.actions.map((a, i) => button(ACTION_LABELS[a], handlers[a], i === 0 ? 'btn btn-primary' : 'btn'))),
    );
  }

  function clearError(): void {
    errorShown = false;
    errorHost.hidden = true;
    errorHost.replaceChildren();
    stage.hidden = false;
  }

  function buildControls(s: CameraSession): void {
    const caps = s.capabilities;
    torchBtn.hidden = !caps.torch;
    torchOn = false;
    torchBtn.setAttribute('aria-pressed', 'false');
    zoomWrap.hidden = !caps.zoom;
    if (caps.zoom) {
      zoomInput.min = String(caps.zoom.min);
      zoomInput.max = String(caps.zoom.max);
      zoomInput.step = String(caps.zoom.step);
      zoomInput.value = String(caps.zoom.min);
    }
  }

  async function startCamera(): Promise<void> {
    const my = ++startToken;
    clearError();
    status.textContent = 'Starting camera...';
    shutter.disabled = true;
    try {
      const s = await openCamera();
      if (disposed || my !== startToken) {
        s.stop();
        return;
      }
      session = s;
      video.srcObject = s.stream;
      await video.play().catch((e: unknown) => log.warn('video.play() was rejected', e));
      if (disposed || my !== startToken) return;
      status.textContent = '';
      buildControls(s);
      shutter.disabled = busy;
      updateReadout();
      // With ImageCapture the still is larger than the preview: show the size takePhoto will produce.
      if (hasImageCapture()) {
        const size = await probeStillSize(s.track, getMaxSourcePixels());
        if (!disposed && my === startToken && size) {
          stillSize = size;
          updateReadout();
        }
      }
    } catch (e) {
      if (disposed || my !== startToken) return;
      const err = e instanceof CameraError ? e : mapCameraError(e);
      log.warn('camera unavailable', err.kind);
      showError(err.kind);
    }
  }

  async function toggleTorch(): Promise<void> {
    if (!session) return;
    const next = !torchOn;
    if (await session.setTorch(next)) {
      torchOn = next;
      torchBtn.setAttribute('aria-pressed', String(next));
    }
  }

  zoomInput.addEventListener('input', () => void session?.setZoom(Number(zoomInput.value)));

  // tap-to-focus: only where the track reports it; no feedback otherwise
  stage.addEventListener('pointerup', (ev) => {
    const s = session;
    if (!s || !s.capabilities.tapFocus || !video.videoWidth) return;
    const rect = video.getBoundingClientRect();
    const tap = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const norm = mapTapToVideo(tap, { width: rect.width, height: rect.height }, { width: video.videoWidth, height: video.videoHeight });
    if (!norm) return;
    void s.focusAt(norm.x, norm.y).then((ok) => {
      if (!ok || disposed) return;
      focusRing.style.left = `${tap.x}px`;
      focusRing.style.top = `${tap.y}px`;
      focusRing.hidden = false;
      focusRing.classList.remove('is-playing');
      void focusRing.getBoundingClientRect(); // restart the CSS animation
      focusRing.classList.add('is-playing');
      setTimeout(() => {
        focusRing.hidden = true;
      }, 800);
    });
  });

  video.addEventListener('loadedmetadata', updateReadout);
  video.addEventListener('resize', updateReadout);

  // Stop the camera while the page is hidden (battery, privacy indicator) and bring it back on return.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') stopCamera();
    else if (!disposed && !errorShown && !busy && !session) void startCamera();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- go ----
  void (async () => {
    try {
      await loadPlan();
    } catch (e) {
      log.warn('could not load the detail plan', e);
    }
    if (disposed) return;
    renderCells();
    await startCamera();
  })();

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    stopCamera();
    root.replaceChildren();
  };
};
