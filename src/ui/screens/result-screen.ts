// Result screen (design 2.12 to 2.14, AC-21/22/28/29/30/37): the zoomable viewer with rotate, previous/next shot,
// "Add detail shots", "Adjust" and the export menu (JPEG, PNG, PDF, Share, Export original).
import type { BitmapHandle } from '../../app/bitmap-handle.ts';
import { VIEWER_HOLDER_ID } from '../../viewer/bitmaps.ts';
import { memoryGate } from '../../app/memory-gate.ts';
import { ExportError, isAbortError } from '../../app/errors.ts';
import { log } from '../../app/log.ts';
import { routeForShot, routeToHash, type GridKind } from '../../app/router.ts';
import { gridKind } from '../../camera/detail-grid.ts';
import { shotImageInfo } from '../../camera/exif.ts';
import { ensureDims, createIngestDeps } from '../../camera/ingest.ts';
import type { Rotation } from '../../cv/geometry.ts';
import { downloadBlob } from '../../export/download.ts';
import { exportFilename, pdfFilename } from '../../export/filename.ts';
import { buildPosterPdf } from '../../export/pdf.ts';
import { createExportDeps, exportJpeg, exportOriginal, exportPng, pngAvailability, type ExportOutput } from '../../export/render-export.ts';
import { canShareFiles, SharePreparer, shareFile } from '../../export/share.ts';
import type { PosterDetail, ShotRecord } from '../../storage/schema.ts';
import { createViewer, type Viewer, type ViewerStatus } from '../../viewer/viewer.ts';
import { confirmDialog } from '../components/dialog.ts';
import { createProgress, type ProgressBar } from '../components/progress.ts';
import { createTopbar } from '../components/topbar.ts';
import { createUnsavedBadge } from '../components/unsaved-badge.ts';
import { button, el } from '../dom.ts';
import type { Screen } from '../context.ts';
import { orderShots } from './poster-logic.ts';
import { shotLabel } from './shot-label.ts';

export const REDUCED_RESOLUTION_NOTICE = 'Shown at reduced resolution; export uses the original';
export const PAUSED_BADGE = 'Detail paused while exporting';
export const LOADING_FULL_BADGE = 'Loading full resolution';

export const resultScreen: Screen = (root, ctx, route) => {
  if (route.name !== 'view') return () => {};
  const shotId = route.id;
  const exportDeps = createExportDeps(ctx.store, ctx.engine);
  let disposed = false;
  let shot: ShotRecord | null = null;
  let detail: PosterDetail | null = null;
  let ordered: ShotRecord[] = [];
  let viewer: Viewer | null = null;
  let preparer: SharePreparer | null = null;
  let lastPrepKey = '';
  let busy = false;
  let exportAbort: AbortController | null = null;
  let reducedDismissed = false;
  const canShare = canShareFiles();

  // ---- DOM ----
  const title = el('h1', { class: 'topbar-title', text: 'Photo' });
  const prevBtn = button('\u2039', () => go(-1), 'btn btn-icon', { 'aria-label': 'Previous photo', disabled: true });
  const nextBtn = button('\u203a', () => go(1), 'btn btn-icon', { 'aria-label': 'Next photo', disabled: true });
  const topbar = createTopbar({ title: '', backHref: routeToHash({ name: 'library' }), actions: [prevBtn, nextBtn] });
  topbar.querySelector('.topbar-title')?.replaceWith(title);

  const host = el('div', { class: 'viewer-host' });
  const badgeLoading = el('span', { class: 'badge viewer-badge', text: LOADING_FULL_BADGE, attrs: { role: 'status', hidden: true } });
  const badgePaused = el('span', { class: 'badge viewer-badge', text: PAUSED_BADGE, attrs: { role: 'status', hidden: true } });
  const badgeUnsaved = createUnsavedBadge();
  badgeUnsaved.hidden = true;
  const badges = el('div', { class: 'viewer-badges' }, badgeLoading, badgePaused, badgeUnsaved);
  const stage = el('div', { class: 'viewer-stage' }, host, badges);
  const notices = el('div', { class: 'notice-list' });
  const progressHost = el('div', { class: 'progress-host' });

  const rotLeft = button('\u21ba', () => rotate(-90), 'btn btn-icon', { 'aria-label': 'Rotate left' });
  const rotRight = button('\u21bb', () => rotate(90), 'btn btn-icon', { 'aria-label': 'Rotate right' });
  const zoomOut = button('\u2212', () => viewer?.zoomOut(), 'btn btn-icon', { 'aria-label': 'Zoom out' });
  const zoomIn = button('+', () => viewer?.zoomIn(), 'btn btn-icon', { 'aria-label': 'Zoom in' });
  const fitBtn = button('Fit', () => viewer?.fit(), 'btn', { 'aria-label': 'Fit to screen' });
  const adjustBtn = button('Adjust', () => ctx.router.navigate({ name: 'adjust', id: shotId }), 'btn');
  const detailBtn = button('Add detail shots', () => addDetail(), 'btn');
  const exportBtn = button('Export', () => toggleMenu(), 'btn btn-primary', { 'aria-haspopup': 'true', 'aria-expanded': 'false' });

  const menu = el('div', { class: 'export-menu', attrs: { role: 'group', 'aria-label': 'Export', hidden: true } });
  const jpegItem = button('Download JPEG', () => void runDownload('jpeg'), 'btn');
  const pngItem = button('Download PNG', () => void runDownload('png'), 'btn');
  const pngNote = el('p', { class: 'export-note' });
  const pdfItem = button('Download PDF (this photo)', () => void runPdf(), 'btn');
  const shareItem = button('Share', () => onShare(), 'btn');
  const originalItem = button('Export original', () => void runDownload('original'), 'btn');
  menu.append(jpegItem, pngItem, pngNote, pdfItem);
  if (canShare) menu.append(shareItem);
  menu.append(originalItem);

  const actions = el(
    'div',
    { class: 'action-bar viewer-actions', attrs: { role: 'group', 'aria-label': 'Photo actions' } },
    rotLeft,
    rotRight,
    zoomOut,
    zoomIn,
    fitBtn,
    adjustBtn,
    detailBtn,
    exportBtn,
  );
  const layout = el('div', { class: 'viewer-layout screen-with-rail' }, el('div', { class: 'viewer-main' }, stage, notices, progressHost, menu), actions);
  root.replaceChildren(topbar, layout);

  const setBusy = (on: boolean): void => {
    busy = on;
    for (const b of [jpegItem, pngItem, pdfItem, originalItem]) b.disabled = on;
    refreshMenu();
  };

  function refreshMenu(): void {
    if (!shot) return;
    const png = pngAvailability(shot);
    pngItem.hidden = png.hidden;
    pngItem.disabled = busy || png.disabled;
    pngNote.hidden = !png.reason;
    pngNote.textContent = png.reason ?? '';
    updateShareButton();
  }

  function updateShareButton(): void {
    if (!preparer || !shot) return;
    const ready = preparer.take(shot.rotation);
    const rendering = preparer.status === 'rendering';
    shareItem.disabled = busy || rendering;
    shareItem.textContent = rendering ? 'Preparing share...' : ready?.viaTap ? 'Tap Share again' : 'Share';
    shareItem.setAttribute('aria-busy', String(rendering));
  }

  function toggleMenu(force?: boolean): void {
    const open = force ?? menu.hidden;
    menu.hidden = !open;
    exportBtn.setAttribute('aria-expanded', String(open));
    if (open) jpegItem.focus();
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && !menu.hidden) {
      toggleMenu(false);
      exportBtn.focus();
    }
  };
  document.addEventListener('keydown', onKey);

  const note = (text: string, kind: 'info' | 'warn' = 'info', dismissible = false): HTMLElement => {
    const n = el('p', { class: `notice notice-${kind}`, text });
    if (dismissible) n.append(' ', button('Dismiss', () => n.remove(), 'btn btn-small btn-ghost', { 'aria-label': 'Dismiss notice' }));
    notices.append(n);
    return n;
  };

  // ---- navigation among the shots of the poster ----
  function neighbours(): { prev: ShotRecord | null; next: ShotRecord | null } {
    const i = ordered.findIndex((s) => s.id === shotId);
    return { prev: i > 0 ? (ordered[i - 1] ?? null) : null, next: i >= 0 ? (ordered[i + 1] ?? null) : null };
  }
  function go(delta: -1 | 1): void {
    const n = neighbours();
    const target = delta < 0 ? n.prev : n.next;
    if (target) ctx.router.navigate(routeForShot(target));
  }
  function addDetail(): void {
    if (!detail) return;
    const grid: GridKind = detail.poster.detailGrid ? gridKind(detail.poster.detailGrid) : '2x2';
    ctx.router.navigate({ name: 'capture', poster: detail.poster.id, mode: 'detail', grid });
  }

  // ---- rotation ----
  function rotate(delta: 90 | -90): void {
    viewer?.rotate(delta);
  }
  function onRotationChange(r: Rotation): void {
    if (!shot) return;
    shot = { ...shot, rotation: r };
    refreshMenu();
    void ctx.store.updateShotParams(shotId, { rotation: r }).catch((e: unknown) => {
      log.warn('could not save the rotation', e);
      ctx.toast.show("Couldn't save the rotation", { kind: 'warn' });
    });
    prepareShare(viewer?.status());
  }

  // ---- viewer status ----
  function onStatus(s: ViewerStatus): void {
    if (disposed) return;
    badgeLoading.hidden = !s.loadingFull;
    badgePaused.hidden = !s.paused;
    if (s.reduced && !reducedDismissed && !notices.querySelector('[data-reduced]')) {
      const n = note(REDUCED_RESOLUTION_NOTICE, 'info', true);
      n.dataset.reduced = '1';
      n.querySelector('button')?.addEventListener('click', () => {
        reducedDismissed = true;
      });
    }
    if (!s.reduced) notices.querySelector('[data-reduced]')?.remove();
    prepareShare(s);
  }
  function prepareShare(s: ViewerStatus | undefined): void {
    if (!preparer || !shot || !s) return;
    const key = `${shot.rotation}:${s.fullReady}`;
    if (key === lastPrepKey) return;
    lastPrepKey = key;
    preparer.request(shot.rotation, s.fullReady);
  }

  // ---- export ----
  function nameFor(out: ExportOutput): string {
    return exportFilename(detail?.poster.title ?? 'poster', shot!, ordered.length > 0 ? ordered : [shot!], out.ext);
  }
  function deliver(out: ExportOutput): void {
    downloadBlob(out.blob, nameFor(out));
    if (out.notice) ctx.toast.show(out.notice, { kind: 'info', timeoutMs: 6000 });
  }
  function reportExportError(e: unknown): void {
    if (isAbortError(e)) return;
    if (e instanceof ExportError) ctx.toast.show(e.message, { kind: 'warn' });
    else {
      log.error('export failed', e);
      ctx.toast.show("Couldn't export this photo", { kind: 'error' });
    }
  }
  async function withProgress<T>(label: string, fn: (o: { signal: AbortSignal; progress: ProgressBar }) => Promise<T>): Promise<T | undefined> {
    if (busy || !shot) return undefined;
    setBusy(true);
    exportAbort = new AbortController();
    const progress = createProgress(label, () => exportAbort?.abort());
    progress.set(null);
    progressHost.replaceChildren(progress.el);
    try {
      return await fn({ signal: exportAbort.signal, progress });
    } catch (e) {
      reportExportError(e);
      return undefined;
    } finally {
      exportAbort = null;
      progressHost.replaceChildren();
      if (!disposed) setBusy(false);
    }
  }
  async function runDownload(kind: 'jpeg' | 'png' | 'original'): Promise<void> {
    const current = shot;
    if (!current) return;
    toggleMenu(false);
    const label = kind === 'png' ? 'Rendering PNG...' : kind === 'jpeg' ? 'Preparing JPEG...' : 'Preparing original...';
    const out = await withProgress(label, async ({ signal, progress }) => {
      if (kind === 'png') {
        return exportPng(current, exportDeps, {
          signal,
          onProgress: (p) => progress.set(p),
        });
      }
      return kind === 'jpeg' ? exportJpeg(current, exportDeps, { signal }) : exportOriginal(current, exportDeps);
    });
    if (out && !disposed) deliver(out);
  }
  async function runPdf(): Promise<void> {
    const current = shot;
    if (!current) return;
    toggleMenu(false);
    const blob = await withProgress('Building PDF...', async ({ signal, progress }) =>
      buildPosterPdf(detail?.poster.title ?? 'Poster', [current], exportDeps, { signal, onProgress: (d, t) => progress.set(d / t) }),
    );
    if (blob && !disposed) downloadBlob(blob, pdfFilename(detail?.poster.title ?? 'poster'));
  }
  function onShare(): void {
    const p = preparer;
    const current = shot;
    if (!p || !current) return;
    const ready = p.take(current.rotation);
    if (ready) {
      // synchronous call: transient user activation is still valid
      void shareFile(ready.blob, nameFor(ready), ready.mime).then((outcome) => {
        if (disposed) return;
        if (outcome === 'download-fallback') {
          deliver(ready);
          ctx.toast.show('Sharing was blocked, so the file was downloaded', { kind: 'info' });
        } else if (outcome === 'failed') {
          ctx.toast.show("Couldn't share", { kind: 'error' });
        }
      });
      return;
    }
    // two-tap fallback: the first tap renders, the label turns into "Tap Share again"
    void p.tapRender(current.rotation).then((ok) => {
      if (!ok && !disposed) ctx.toast.show("Couldn't prepare the photo for sharing", { kind: 'error' });
    });
  }

  // ---- loading ----
  const failPanel = (heading: string, text: string): void => {
    stage.hidden = true;
    notices.replaceChildren(
      el(
        'section',
        { class: 'empty-state' },
        el('h2', { text: heading }),
        el('p', { text }),
        el('div', { class: 'error-actions' }, button('Export original', () => void runDownload('original'), 'btn'), button('Delete this photo', () => void discard(), 'btn btn-danger'), el('a', { class: 'btn', text: 'Back to library', attrs: { href: routeToHash({ name: 'library' }) } })),
      ),
    );
  };
  async function discard(): Promise<void> {
    const ok = await confirmDialog({ title: 'Delete this photo?', message: 'It will be removed from this device.', confirmLabel: 'Delete', danger: true });
    if (!ok || !shot) return;
    try {
      const posterId = shot.posterId;
      await ctx.store.deleteShot(shotId);
      ctx.router.navigate({ name: 'poster', id: posterId }, { replace: true });
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
    if (record.dimsPending || record.width < 1) {
      try {
        await ensureDims(shotId, createIngestDeps(ctx.store));
        record = (await ctx.store.getShot(shotId)) ?? record;
      } catch (e) {
        log.warn('could not read the photo size', e);
      }
      if (disposed) return;
    }
    shot = record;
    detail = await ctx.store.getPoster(record.posterId);
    if (disposed) return;
    ordered = detail ? orderShots(detail.shots) : [];
    title.textContent = detail ? `${detail.poster.title} \u00b7 ${shotLabel(record, Math.max(0, ordered.findIndex((s) => s.id === shotId)))}` : shotLabel(record, 0);
    topbar.querySelector<HTMLAnchorElement>('a.btn-icon')?.setAttribute('href', routeToHash({ name: 'poster', id: record.posterId }));
    const n = neighbours();
    prevBtn.disabled = !n.prev;
    nextBtn.disabled = !n.next;
    badgeUnsaved.hidden = !ctx.store.unsavedIds().has(shotId);
    adjustBtn.textContent = record.status === 'rectified' ? 'Adjust' : 'Correct perspective';

    const rectified = record.status === 'rectified';
    const blob = await ctx.store.getBlob(shotId, rectified ? 'rectified' : 'original');
    if (disposed) return;
    const imageW = rectified ? (record.rectifiedWidth ?? record.width) : record.width;
    const imageH = rectified ? (record.rectifiedHeight ?? record.height) : record.height;
    if (!blob || imageW < 1 || imageH < 1) {
      failPanel("Can't open this photo", blob ? 'Its size could not be read. You can export the original or delete it.' : 'The image file is missing from this device.');
      return;
    }
    preparer = new SharePreparer({
      shot: () => shot!,
      deps: exportDeps,
      lend: <T>(fn: (h: BitmapHandle) => Promise<T>) => viewer?.lendFullBitmap(fn) ?? Promise.resolve(null),
      gate: memoryGate,
      holderId: VIEWER_HOLDER_ID,
      onChange: () => updateShareButton(),
    });
    refreshMenu();
    viewer = createViewer({
      host,
      shotId,
      blob,
      info: rectified ? { width: imageW, height: imageH, orientation: 1 } : shotImageInfo(record),
      imageW,
      imageH,
      rotation: record.rotation,
      thumb: record.thumb,
      onRotationChange,
      onStatus,
    });
    prepareShare(viewer.status());
    viewer.opened.catch((e: unknown) => {
      if (disposed) return;
      log.error('viewer could not decode the photo', e);
      viewer?.dispose();
      viewer = null;
      failPanel("Can't show this photo", 'This browser could not decode the image. You can still export the original.');
    });
  }

  init().catch((e: unknown) => {
    log.error('result screen failed to open', e);
    if (!disposed) failPanel("Can't open this photo", 'Something went wrong while opening the photo.');
  });

  return () => {
    disposed = true;
    document.removeEventListener('keydown', onKey);
    exportAbort?.abort();
    preparer?.dispose();
    viewer?.dispose();
    viewer = null;
    root.replaceChildren();
  };
};
