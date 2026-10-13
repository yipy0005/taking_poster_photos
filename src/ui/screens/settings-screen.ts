// Settings: storage usage, persistence request, advanced (OpenCV) detection controls, clear data, about.
import { log } from '../../app/log.ts';
import { routeToHash } from '../../app/router.ts';
import { isCvCached, warmCvCache } from '../../cv/opencv/warm-cache.ts';
import { formatBytes, getUsage, isPersisted, requestPersistence } from '../../storage/quota.ts';
import { confirmDialog } from '../components/dialog.ts';
import { createTopbar } from '../components/topbar.ts';
import { button, el } from '../dom.ts';
import type { Screen } from '../context.ts';

export const settingsScreen: Screen = (root, ctx) => {
  let disposed = false;

  const usageText = el('p', { class: 'setting-value', text: 'Checking\u2026' });
  const usageBar = el('progress', { class: 'progress-bar', attrs: { max: 100, value: 0, 'aria-label': 'Storage used' } });
  const persistText = el('p', { class: 'setting-value', text: 'Checking\u2026' });
  const persistBtn = button('Ask browser to keep my data', () => void askPersist(), 'btn');

  const refreshUsage = async (): Promise<void> => {
    const u = await getUsage();
    if (disposed) return;
    if (!u) {
      usageText.textContent = ctx.sessionOnly ? 'Nothing is saved in this browser (session only).' : 'Usage is not available in this browser.';
      usageBar.hidden = true;
      return;
    }
    usageBar.hidden = false;
    usageBar.value = u.fraction * 100;
    usageText.textContent = `${formatBytes(u.usage)} used of ${formatBytes(u.quota)} (${Math.round(u.fraction * 100)}%)`;
  };

  const refreshPersist = async (): Promise<void> => {
    const p = await isPersisted();
    if (disposed) return;
    persistText.textContent = p ? 'Persistent: the browser will not clear your photos to free space.' : 'Not persistent: the browser may clear photos if the device runs low on space. Export what matters.';
    persistBtn.hidden = p;
  };

  async function askPersist(): Promise<void> {
    const ok = await requestPersistence();
    ctx.toast.show(ok ? 'Your data is now persistent' : 'The browser declined. Try again after saving a photo.');
    await refreshPersist();
  }

  const clearData = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Clear all data?',
      message: 'This deletes every poster and photo stored in this browser. Photos in your camera roll are not affected. This cannot be undone.',
      confirmLabel: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.store.clearAll();
      ctx.toast.show('All data cleared');
      await refreshUsage();
    } catch {
      ctx.toast.show("Couldn't clear data, try again", { kind: 'error' });
    }
  };

  // ---- advanced detection (OpenCV) ----
  const cvText = el('p', { class: 'setting-value', attrs: { role: 'status' } });
  const downloadBtn = button('Download offline detector (13 MB)', () => void downloadDetector(), 'btn');
  const retryBtn = button('Retry advanced detection', () => retryDetector(), 'btn');
  let cached = false;
  let downloading = false;
  const refreshCv = (): void => {
    if (disposed) return;
    const state = ctx.engine.getStatus().opencv;
    downloadBtn.hidden = cached;
    downloadBtn.disabled = downloading;
    retryBtn.hidden = state !== 'failed';
    if (downloading) cvText.textContent = 'Downloading the offline detector...';
    else if (state === 'failed') cvText.textContent = 'Advanced detection could not start, so basic detection is used.';
    else if (cached) cvText.textContent = 'The offline detector is saved on this device. Open Adjust and tap Better detection to use it.';
    else cvText.textContent = 'Basic detection always works. Advanced detection finds poster edges more reliably and needs a one-time 13 MB download.';
  };
  async function downloadDetector(): Promise<void> {
    if (downloading) return;
    downloading = true;
    refreshCv();
    try {
      await warmCvCache();
      cached = true;
      ctx.toast.show('Offline detector saved');
    } catch (e) {
      log.warn('detector download failed', e);
      ctx.toast.show("Couldn't download the detector. Check your connection and try again.", { kind: 'warn' });
    } finally {
      downloading = false;
      refreshCv();
    }
  }
  function retryDetector(): void {
    ctx.engine.resetOpenCv();
    ctx.toast.show('Advanced detection will be tried again when you tap Better detection.');
    refreshCv();
  }
  const offEngine = ctx.engine.onChange(refreshCv);
  refreshCv();
  void isCvCached().then((c) => {
    cached = c;
    refreshCv();
  });
  const section = (title: string, ...children: Array<Node | null>): HTMLElement =>
    el('section', { class: 'setting' }, el('h2', { class: 'setting-title', text: title }), ...children);

  root.replaceChildren(
    createTopbar({ title: 'Settings', backHref: routeToHash({ name: 'library' }) }),
    el(
      'main',
      { class: 'screen-body' },
      section('Storage', usageText, usageBar),
      section('Persistence', persistText, persistBtn),
      section('Advanced detection', cvText, el('div', { class: 'error-actions' }, downloadBtn, retryBtn)),
      section('Clear data', el('p', { class: 'setting-value', text: 'Remove all posters and photos from this browser.' }), button('Clear all data\u2026', () => void clearData(), 'btn btn-danger')),
      section(
        'About',
        el('p', {
          class: 'setting-value',
          text: 'Poster Photos keeps every photo on this device. There are no accounts, uploads or analytics. The only way a photo leaves is when you choose Share and pick a destination.',
        }),
      ),
    ),
  );
  void refreshUsage();
  void refreshPersist();

  return () => {
    disposed = true;
    offEngine();
    root.replaceChildren();
  };
};
