// Adjust screen (design 2.4, 2.14; AC-8..11, 15..19, 44): preview + corner editor + loupe, aspect picker, enhancement toggles,
// Rectify with progress/cancel, and "Keep original (no correction)". Coordinates inside the editor are PREVIEW pixels; every
// validation and every call into cv/ or storage/ uses ORIGINAL pixels (plan.md finding 13).
import { getMaxOutputPixels } from '../../app/canvas-limits.ts';
import { PREVIEW_LONG_EDGE, isIosWebKit } from '../../app/config.ts';
import type { DecodeResult } from '../../app/decode.ts';
import { STRIKES_KEY, decodeGuarded, strikeKey, type StrikeMap } from '../../app/decode-guarded.ts';
import {
  DegenerateQuadError,
  EngineUnavailableError,
  InvalidQuadError,
  OutOfMemoryError,
  StorageError,
  isAbortError,
} from '../../app/errors.ts';
import { log } from '../../app/log.ts';
import { routeToHash } from '../../app/router.ts';
import { bitmapToRaster } from '../../camera/encode.ts';
import { shotImageInfo } from '../../camera/exif.ts';
import { createIngestDeps, ensureDims, makeThumb, setThumbFromBitmap, thumbFromBlob } from '../../camera/ingest.ts';
import { estimateAspect, type AspectEstimate } from '../../cv/aspect.ts';
import { NO_MEMORY_MESSAGE } from '../../cv/engine-client.ts';
import { isCvCached } from '../../cv/opencv/warm-cache.ts';
import { defaultInsetQuad, validateQuad, type AspectMode, type Quad } from '../../cv/geometry.ts';
import { computeOutputSize, scaleOutputSize, type OutputSize } from '../../cv/output-size.ts';
import type { EnhanceFlags, ShotRecord } from '../../storage/schema.ts';
import { createAspectPicker } from '../components/aspect-picker.ts';
import { createCornerEditor, type CornerEditor, type DragState } from '../components/corner-editor.ts';
import { confirmDialog } from '../components/dialog.ts';
import { createLoupe, type Loupe } from '../components/loupe.ts';
import { createProgress, type ProgressBar } from '../components/progress.ts';
import { createTopbar } from '../components/topbar.ts';
import { button, el } from '../dom.ts';
import type { Screen } from '../context.ts';
import {
  PREVIEW_TOO_LARGE_MESSAGE,
  REDUCED_COPY_NOTICE,
  describeOutput,
  fromDetection,
  largePhotoNotice,
  previewScale,
  previewTooLarge,
  toOriginal,
  toPreview,
  validatorFor,
  NO_EDGES_MESSAGE,
  type PreviewScale,
} from './adjust-logic.ts';

const DETECT_LONG_EDGE = 1600;

export const adjustScreen: Screen = (root, ctx, route) => {
  if (route.name !== 'adjust') return () => {};
  const shotId = route.id;
  const ingestDeps = createIngestDeps(ctx.store);

  // ---- state ----
  let disposed = false;
  let finished = false; // Rectify or Keep original completed: nothing more to persist on leave
  let busy = false;
  let dirty = false;
  let userEdited = false;
  let shot: ShotRecord | null = null;
  let preview: DecodeResult | null = null;
  let scale: PreviewScale = { sx: 1, sy: 1 };
  let editor: CornerEditor | null = null;
  let loupe: Loupe | null = null;
  let aspectMode: AspectMode = 'auto';
  let enhance: EnhanceFlags = { autoContrast: false, whiteBalance: false, sharpen: false };
  let cornersSource: ShotRecord['cornersSource'] = 'default';
  let displayW = 0;
  let displayH = 0;
  let renderAbort: AbortController | null = null;
  const lifetime = new AbortController();
  let detectToken = 0;

  // ---- DOM skeleton ----
  const topbar = createTopbar({ title: 'Adjust', backHref: routeToHash({ name: 'library' }) });
  const status = el('p', { class: 'adjust-status', text: 'Opening photo...', attrs: { role: 'status' } });
  const notices = el('div', { class: 'notice-list' });
  const canvas = el('canvas', { class: 'adjust-canvas', attrs: { 'aria-label': 'Photo preview with four corner handles', role: 'img' } });
  const stage = el('div', { class: 'adjust-stage', attrs: { hidden: true } }, canvas);
  const hint = el('p', { class: 'adjust-hint', text: 'Drag the corners to the corners of the poster. Arrow keys move a focused corner (Shift for 10 px).', attrs: { hidden: true } });
  const outputNote = el('p', { class: 'output-note', attrs: { 'aria-live': 'polite' } });
  const progressHost = el('div', { class: 'progress-host' });
  const controls = el('div', { class: 'adjust-controls', attrs: { hidden: true } });
  const rectifyBtn = button('Rectify', () => void rectify(1), 'btn btn-primary');
  const keepBtn = button('Keep original (no correction)', () => void keepOriginal(), 'btn');
  const redetectBtn = button('Auto-detect again', () => void detect(true), 'btn');
  const resetBtn = button('Reset', () => resetCorners(), 'btn');
  const betterBtn = button('Better detection', () => void betterDetection(), 'btn');
  betterBtn.hidden = true;
  const actions = el('div', { class: 'action-bar', attrs: { role: 'group', 'aria-label': 'Photo actions' } }, keepBtn, rectifyBtn);
  rectifyBtn.disabled = true;
  keepBtn.disabled = true;
  const body = el('main', { class: 'screen-body adjust-body' }, status, notices, stage, hint, controls, outputNote, progressHost);
  root.replaceChildren(topbar, el('div', { class: 'adjust-layout screen-with-rail' }, body, actions));

  const picker = createAspectPicker({
    mode: 'auto',
    onChange: (m) => {
      aspectMode = m;
      dirty = true;
      refresh();
    },
  });

  const addNotice = (text: string, kind: 'info' | 'warn' = 'info'): HTMLElement => {
    const n = el('p', { class: `notice notice-${kind}`, text });
    notices.append(n);
    return n;
  };
  let edgesNotice: HTMLElement | null = null;
  const setEdgesNotice = (message: string | null): void => {
    edgesNotice?.remove();
    edgesNotice = message ? addNotice(message, 'warn') : null;
  };

  // "Better detection" is offered until the OpenCV engine is ready (or has failed; Settings has "Retry advanced detection").
  const syncBetterBtn = (): void => {
    const state = ctx.engine.getStatus().opencv;
    betterBtn.hidden = state === 'ready' || state === 'failed';
    betterBtn.disabled = busy || state === 'loading';
    betterBtn.textContent = state === 'loading' ? 'Loading advanced detection...' : 'Better detection';
  };
  const offEngine = ctx.engine.onChange(syncBetterBtn);
  const offNotice = ctx.engine.onNotice((n) => ctx.toast.show(n.message, { kind: 'warn', timeoutMs: 6000 }));

  // ---- helpers ----
  const origQuad = (): Quad | null => (editor ? toOriginal(editor.getQuad(), scale) : null);

  const tryEstimate = (q: Quad): AspectEstimate | null => {
    if (!shot) return null;
    try {
      return estimateAspect(q, shot.width, shot.height);
    } catch {
      return null;
    }
  };
  const tryOutput = (q: Quad): OutputSize | null => {
    if (!shot) return null;
    try {
      return computeOutputSize(q, aspectMode, { cap: getMaxOutputPixels(), imgW: shot.width, imgH: shot.height });
    } catch {
      return null;
    }
  };

  function refresh(): void {
    const q = origQuad();
    if (!q || !shot) return;
    picker.setEstimate(tryEstimate(q), q);
    const out = tryOutput(q);
    if (out) {
      const note = describeOutput(out);
      outputNote.textContent = note.reduced ? `${note.text}. ${note.reduced}.` : `${note.text}.`;
    } else {
      outputNote.textContent = '';
    }
    rectifyBtn.disabled = busy || !out;
  }

  function setBusy(on: boolean): void {
    busy = on;
    editor?.setDisabled(on);
    picker.setDisabled(on);
    for (const b of [rectifyBtn, keepBtn, redetectBtn, resetBtn, betterBtn]) b.disabled = on;
    for (const box of controls.querySelectorAll('input')) box.disabled = on;
    if (!on) {
      refresh();
      syncBetterBtn();
    }
  }

  function applyQuad(q: Quad, source: ShotRecord['cornersSource'], message: string | null): void {
    if (!editor) return;
    editor.setQuad(toPreview(q, scale));
    cornersSource = source;
    setEdgesNotice(message);
    refresh();
  }

  // ---- detection ----
  async function detect(explicit: boolean): Promise<void> {
    if (!preview || !shot || !editor) return;
    const my = ++detectToken;
    const { width: w, height: h } = shot;
    status.textContent = 'Looking for the poster edges...';
    redetectBtn.disabled = true;
    try {
      const raster = bitmapToRaster(preview.handle.bitmap, DETECT_LONG_EDGE);
      const applyOutcome = (o: { quad: Quad; found: boolean; engine: 'js' | 'opencv' }): void => {
        const d = fromDetection(o, raster, w, h);
        applyQuad(d.quad, d.source, d.message);
        dirty = true;
      };
      const outcome = await ctx.engine.detect(raster, {
        signal: lifetime.signal,
        // OpenCV may answer later with a better quad; never override the user's own edits
        onUpgrade: (better) => {
          if (disposed || my !== detectToken || userEdited) return;
          applyOutcome(better);
        },
      });
      if (disposed || my !== detectToken) return;
      if (explicit || !userEdited) {
        userEdited = false;
        applyOutcome(outcome);
      }
    } catch (e) {
      if (isAbortError(e) || disposed) return;
      log.warn('detection failed; using the default corners', e);
      if (!userEdited) applyQuad(defaultInsetQuad(w, h), 'default', NO_EDGES_MESSAGE);
    } finally {
      if (!disposed && my === detectToken) {
        status.textContent = '';
        if (!busy) redetectBtn.disabled = false;
      }
    }
  }

  /** Explicit opt-in (any platform): loads OpenCV, then detects again; its quad replaces the JS one unless the user edited. */
  async function betterDetection(): Promise<void> {
    if (busy || !preview) return;
    const ready = await ctx.engine.loadOpenCv('user');
    if (disposed) return;
    if (ready) await detect(true);
  }
  function resetCorners(): void {
    if (!shot || !editor || busy) return;
    userEdited = false;
    dirty = true;
    applyQuad(defaultInsetQuad(shot.width, shot.height), 'default', null);
  }

  // ---- Rectify ----
  async function rectify(sizeFactor: number): Promise<void> {
    if (busy || !shot || !editor) return;
    const current = shot;
    const qo = origQuad();
    if (!qo) return;
    try {
      validateQuad(qo, current.width, current.height);
    } catch (e) {
      ctx.toast.show(e instanceof InvalidQuadError ? e.message : 'Those corners do not work', { kind: 'warn' });
      return;
    }
    const maxOut = getMaxOutputPixels();
    let out: OutputSize;
    try {
      out = computeOutputSize(qo, aspectMode, { cap: maxOut, imgW: current.width, imgH: current.height });
    } catch (e) {
      if (e instanceof DegenerateQuadError) ctx.toast.show("Those corners can't form a rectangle. Move them apart.", { kind: 'warn' });
      else ctx.toast.show('Those corners do not work', { kind: 'warn' });
      return;
    }
    let outW = out.width;
    let outH = out.height;
    if (sizeFactor !== 1) {
      const smaller = scaleOutputSize(outW, outH, sizeFactor, maxOut);
      outW = smaller.width;
      outH = smaller.height;
    }

    setBusy(true);
    renderAbort = new AbortController();
    const signal = renderAbort.signal;
    const progress: ProgressBar = createProgress('Rectifying...', () => renderAbort?.abort());
    progress.set(0);
    progressHost.replaceChildren(progress.el);
    status.textContent = '';
    try {
      const original = await ctx.store.getBlob(current.id, 'original');
      if (!original) throw new StorageError('The original photo is missing');
      const result = await ctx.engine.render({
        shotId: current.id,
        original,
        info: shotImageInfo(current),
        quad: qo,
        outW,
        outH,
        enhance,
        signal,
        onProgress: (p) => progress.set(p),
      });
      progress.setLabel('Saving...');
      progress.set(null);

      // The thumbnail of the corrected image is optional: a failure or a strike skip keeps the previous one.
      let thumb: Blob | undefined;
      try {
        thumb = await thumbFromBlob(result.blob, { width: result.width, height: result.height, orientation: 1 }, current.id, ingestDeps);
      } catch (e) {
        log.warn('thumbnail of the corrected image failed', e);
      }

      await ctx.store.saveRectification(current.id, {
        blob: result.blob,
        mime: result.blob.type || 'image/jpeg',
        width: result.width, // the ACTUAL size (a memory retry may have rendered smaller)
        height: result.height,
        thumb,
        corners: qo,
        cornersSource,
        aspectMode,
        aspectUsed: out.aspectUsed,
        snappedTo: out.snappedTo,
        enhance,
        downscaled: out.downscaled || sizeFactor !== 1 || result.retriedSmaller || undefined,
        reducedSource: result.reducedSource || undefined,
        engine: result.engine,
      });
      finished = true;
      if (out.downscaled) ctx.toast.show(describeOutput(out).reduced ?? '', { kind: 'info', timeoutMs: 6000 });
      if (result.reducedSource) ctx.toast.show(REDUCED_COPY_NOTICE, { kind: 'info', timeoutMs: 6000 });
      ctx.router.navigate({ name: 'view', id: current.id });
    } catch (e) {
      if (disposed || isAbortError(e)) {
        // Cancelled: back to Adjust without a message (AC-19)
      } else if (e instanceof OutOfMemoryError) {
        ctx.toast.show(NO_MEMORY_MESSAGE, { kind: 'error', timeoutMs: 0, action: { label: 'Render smaller', onClick: () => void rectify(0.5) } });
      } else if (e instanceof DegenerateQuadError) {
        ctx.toast.show("Those corners can't form a rectangle. Move them apart.", { kind: 'warn' });
      } else if (e instanceof InvalidQuadError) {
        ctx.toast.show(e.message, { kind: 'warn' });
      } else if (e instanceof EngineUnavailableError) {
        ctx.toast.show("Can't process in this browser", { kind: 'error', timeoutMs: 0 });
      } else if (e instanceof StorageError) {
        ctx.toast.show("Couldn't save, try again", { kind: 'error' });
      } else {
        log.error('rectify failed', e);
        ctx.toast.show("Can't process in this browser", { kind: 'error', timeoutMs: 0 });
      }
    } finally {
      renderAbort = null;
      progressHost.replaceChildren();
      if (!disposed && !finished) setBusy(false);
    }
  }

  // ---- Keep original (AC-44) ----
  async function keepOriginal(): Promise<void> {
    if (busy || !shot) return;
    if (shot.status === 'rectified') {
      const ok = await confirmDialog({
        title: 'Discard the corrected version?',
        message: 'The corrected image will be deleted. Your original photo stays.',
        confirmLabel: 'Discard corrected version',
        danger: true,
      });
      if (!ok || disposed) return;
    }
    setBusy(true);
    try {
      await ctx.store.keepUncorrected(shotId);
      finished = true;
      // keepUncorrected cleared the thumbnail: rebuild it from the already-decoded preview, else from the original
      if (!(preview && (await setThumbFromBitmap(shotId, preview.handle.bitmap, ingestDeps)))) void makeThumb(shotId, ingestDeps);
      ctx.router.navigate({ name: 'view', id: shotId });
    } catch (e) {
      log.error('keep original failed', e);
      ctx.toast.show("Couldn't save, try again", { kind: 'error' });
      if (!disposed) setBusy(false);
    }
  }

  // ---- loupe wiring ----
  const onDrag = (state: DragState | null): void => {
    if (!loupe || !preview || !editor) return;
    if (!state) {
      loupe.hide();
      return;
    }
    const k = displayW > 0 ? displayW / preview.width : 1;
    const q = editor.getQuad();
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
    const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    loupe.update({
      bitmap: preview.handle.bitmap,
      center: state.point,
      finger: [state.point[0] * k, state.point[1] * k],
      inward: [cx - state.point[0], cy - state.point[1]],
      stage: { width: displayW, height: displayH },
      previewPerCss: 1 / k,
    });
  };

  // ---- loading ----
  const failLoading = (title: string, detail: string): void => {
    status.textContent = '';
    stage.hidden = true;
    notices.replaceChildren(
      el(
        'section',
        { class: 'empty-state' },
        el('h2', { text: title }),
        el('p', { text: detail }),
        el('div', { class: 'error-actions' }, button('Delete this photo', () => void discardShot(), 'btn btn-danger'), el('a', { class: 'btn', text: 'Back to library', attrs: { href: routeToHash({ name: 'library' }) } })),
      ),
    );
    keepBtn.disabled = false;
  };
  async function discardShot(): Promise<void> {
    const ok = await confirmDialog({ title: 'Delete this photo?', message: 'It will be removed from this device.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const s = shot ?? (await ctx.store.getShot(shotId));
      await ctx.store.deleteShot(shotId);
      finished = true;
      ctx.router.navigate(s ? { name: 'poster', id: s.posterId } : { name: 'library' }, { replace: true });
    } catch (e) {
      log.error('delete failed', e);
      ctx.toast.show("Couldn't delete, try again", { kind: 'error' });
    }
  }

  async function init(): Promise<void> {
    let record = await ctx.store.getShot(shotId);
    if (disposed) return;
    if (!record) {
      ctx.toast.show('That item no longer exists');
      ctx.router.navigate({ name: 'library' }, { replace: true });
      return;
    }
    topbar.querySelector<HTMLAnchorElement>('a.btn-icon')?.setAttribute('href', routeToHash({ name: 'poster', id: record.posterId }));
    if (record.dimsPending) {
      status.textContent = 'Reading the photo...';
      try {
        await ensureDims(shotId, ingestDeps);
        record = (await ctx.store.getShot(shotId)) ?? record;
      } catch (e) {
        log.warn('could not read the photo size', e);
      }
      if (disposed) return;
    }
    if (record.width < 1 || record.height < 1) {
      failLoading("Can't read this image", 'This photo cannot be opened here. You can delete it.');
      return;
    }
    const original = await ctx.store.getBlob(shotId, 'original');
    if (disposed) return;
    if (!original) {
      failLoading('The photo file is missing', 'The original image is no longer stored on this device.');
      return;
    }
    shot = record;
    aspectMode = record.aspectMode;
    enhance = { ...record.enhance };
    picker.setMode(aspectMode);

    // Strike count of the preview group decides the "too large to preview" message (design 2.7 item 9).
    let previewStrikes = 0;
    try {
      previewStrikes = ((await ctx.store.getMeta<StrikeMap>(STRIKES_KEY)) ?? {})[strikeKey(shotId, 'preview')] ?? 0;
    } catch {
      previewStrikes = 0;
    }

    let res: DecodeResult;
    try {
      res = await decodeGuarded(original, { maxLongEdge: PREVIEW_LONG_EDGE, info: shotImageInfo(record) }, { shotId, kind: 'preview' });
    } catch (e) {
      log.error('preview decode failed', e);
      if (disposed) return;
      failLoading("Can't open this photo", 'The preview could not be created. You can keep the original as it is, or delete the photo.');
      return;
    }
    if (disposed) {
      res.handle.close();
      return;
    }
    preview = res;
    scale = previewScale(record.width, record.height, res.width, res.height);

    canvas.width = res.width;
    canvas.height = res.height;
    canvas.getContext('2d')?.drawImage(res.handle.bitmap, 0, 0);
    status.textContent = '';
    stage.hidden = false;
    hint.hidden = false;
    controls.hidden = false;

    const large = largePhotoNotice({ oversize: record.oversize, origW: record.width, origH: record.height, previewW: res.width, previewH: res.height });
    if (large) addNotice(large);
    if (previewTooLarge(previewStrikes)) addNotice(`${PREVIEW_TOO_LARGE_MESSAGE}. You can keep the original as it is.`, 'warn');

    const stored = record.corners;
    const initial: Quad = stored ?? defaultInsetQuad(record.width, record.height);
    cornersSource = stored ? record.cornersSource : 'default';
    editor = createCornerEditor({
      width: res.width,
      height: res.height,
      quad: toPreview(initial, scale),
      isValid: validatorFor(scale, record.width, record.height),
      onChange: () => {
        userEdited = true;
        dirty = true;
        cornersSource = 'manual';
        setEdgesNotice(null);
        refresh();
      },
      onDrag,
    });
    loupe = createLoupe();
    stage.append(editor.el, loupe.el);

    // keep handle sizes constant while the preview scales with the layout
    const measure = (): void => {
      const r = canvas.getBoundingClientRect();
      displayW = r.width;
      displayH = r.height;
      editor?.setDisplaySize(displayW, displayH);
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(measure);
      ro.observe(canvas);
      cleanups.push(() => ro.disconnect());
    }

    controls.append(el('fieldset', { class: 'enhance' }, el('legend', { text: 'Enhance (off by default)' }), ...enhanceToggles()), el('div', { class: 'adjust-tools' }, redetectBtn, betterBtn, resetBtn));
    syncBetterBtn();
    controls.prepend(picker.el);
    keepBtn.disabled = false;
    refresh();

    // Finding 7: the shot has no thumbnail yet -> derive it from this preview instead of decoding the original again.
    if (!record.thumb && record.status !== 'rectified') void setThumbFromBitmap(shotId, res.handle.bitmap, ingestDeps);

    // Non-iOS: when the OpenCV file is already cached, start it now (a cache read, never a download). iOS only on explicit request.
    if (!isIosWebKit() && (await isCvCached())) void ctx.engine.loadOpenCv('auto');
    if (disposed) return;
    if (!stored) await detect(false);
    else status.textContent = '';
  }

  function enhanceToggles(): HTMLElement[] {
    const defs: Array<{ key: keyof EnhanceFlags; label: string }> = [
      { key: 'autoContrast', label: 'Auto contrast' },
      { key: 'whiteBalance', label: 'White balance' },
      { key: 'sharpen', label: 'Mild sharpen' },
    ];
    return defs.map((d) => {
      const input = el('input', { attrs: { type: 'checkbox', checked: enhance[d.key] } });
      input.addEventListener('change', () => {
        enhance = { ...enhance, [d.key]: input.checked };
        dirty = true;
      });
      return el('label', { class: 'toggle' }, input, el('span', { text: d.label }));
    });
  }

  const cleanups: Array<() => void> = [];
  init().catch((e: unknown) => {
    log.error('adjust failed to open', e);
    if (!disposed) failLoading("Can't open this photo", 'Something went wrong while opening the photo.');
  });

  return () => {
    disposed = true;
    lifetime.abort();
    renderAbort?.abort();
    offNotice();
    offEngine();
    for (const c of cleanups) c();
    // Remember corner/aspect/enhancement edits of a not-yet-rectified shot (best effort).
    if (!finished && dirty && shot?.status === 'captured' && editor) {
      const q = origQuad();
      if (q) {
        void ctx.store
          .updateShotParams(shotId, { corners: q, cornersSource, aspectMode, enhance })
          .catch((e: unknown) => log.warn('could not remember the corner edits', e));
      }
    }
    editor?.dispose();
    loupe?.dispose();
    preview?.handle.close();
    preview = null;
    canvas.width = 0;
    canvas.height = 0;
    root.replaceChildren();
  };
};
