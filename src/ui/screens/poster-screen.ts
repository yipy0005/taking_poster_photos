// Poster gallery (AC-21, AC-24): overview first, then the details in grid order. Per-shot Adjust/Open, PDF export (with
// "Export in N parts" for posters over the device limits), metadata edit and "Add detail shot" with the next grid cell.
import { ValidationError, ExportError, isAbortError } from '../../app/errors.ts';
import { log } from '../../app/log.ts';
import { routeForShot, routeToHash, type GridKind } from '../../app/router.ts';
import { createUrlRegistry } from '../../app/url-registry.ts';
import { gridKind } from '../../camera/detail-grid.ts';
import { downloadBlob } from '../../export/download.ts';
import { pdfFilename } from '../../export/filename.ts';
import { buildPosterPdf, pdfEligible, pdfSizes } from '../../export/pdf.ts';
import { isOversizedPart, pdfLimits, planPdfParts, TOO_BIG_MESSAGE } from '../../export/pdf-parts.ts';
import { createExportDeps } from '../../export/render-export.ts';
import { canShareFiles, shareFile } from '../../export/share.ts';
import type { PosterDetail, ShotRecord } from '../../storage/schema.ts';
import { createThumbController } from '../components/thumb.ts';
import { createTopbar } from '../components/topbar.ts';
import { createUnsavedBadge } from '../components/unsaved-badge.ts';
import { createProgress } from '../components/progress.ts';
import { formDialog } from '../components/form-dialog.ts';
import { button, clear, el } from '../dom.ts';
import type { Screen } from '../context.ts';
import { planDetail } from './capture-logic.ts';
import { formatMegabytes, orderShots, partLabel, partWarning, posterMetaLine, tagsToText } from './poster-logic.ts';
import { STATUS_TEXT, shotLabel } from './shot-label.ts';

export const posterScreen: Screen = (root, ctx, route) => {
  if (route.name !== 'poster') return () => {};
  const posterId = route.id;
  const thumbs = createThumbController(createUrlRegistry());
  const exportDeps = createExportDeps(ctx.store, ctx.engine);
  const canShare = canShareFiles();
  const list = el('ul', { class: 'card-grid', attrs: { 'aria-label': 'Photos of this poster' } });
  const heading = el('h1', { class: 'topbar-title', text: 'Poster' });
  const meta = el('p', { class: 'poster-meta' });
  const notes = el('p', { class: 'poster-notes' });
  const partsHost = el('div', { class: 'parts-host' });
  const progressHost = el('div', { class: 'progress-host' });
  let disposed = false;
  let detail: PosterDetail | null = null;
  let ordered: ShotRecord[] = [];
  let abort: AbortController | null = null;
  let busy = false;

  const pdfBtn = button('Export PDF', () => void startPdf(), 'btn btn-primary');
  const detailBtn = button('Add detail shot', () => addDetail(), 'btn');
  const editBtn = button('Edit details', () => void editDetails(), 'btn');

  // ---- actions ----
  function detailPlan() {
    if (!detail) return null;
    const grid: GridKind | undefined = detail.poster.detailGrid ? gridKind(detail.poster.detailGrid) : undefined;
    return { grid: grid ?? ('2x2' as GridKind), plan: planDetail(detail.poster, detail.shots, grid, undefined) };
  }

  function addDetail(): void {
    const d = detailPlan();
    if (!d || !detail) return;
    ctx.router.navigate({ name: 'capture', poster: detail.poster.id, mode: 'detail', grid: d.grid });
  }

  function updateDetailButton(): void {
    const d = detailPlan();
    detailBtn.textContent = d?.plan.label ? `Add detail shot: ${d.plan.label}` : 'Add detail shot';
  }

  async function editDetails(): Promise<void> {
    if (!detail) return;
    const p = detail.poster;
    await formDialog({
      title: 'Edit details',
      confirmLabel: 'Save',
      fields: [
        { name: 'title', label: 'Title', value: p.title, maxLength: 120 },
        { name: 'conference', label: 'Conference', value: p.conference ?? '', maxLength: 120 },
        { name: 'tags', label: 'Tags', value: tagsToText(p.tags), hint: 'Separate with commas or spaces' },
        { name: 'notes', label: 'Notes', value: p.notes ?? '', multiline: true, maxLength: 2000 },
      ],
      submit: async (v) => {
        try {
          await ctx.store.updatePosterMeta(p.id, { title: v.title, conference: v.conference ?? '', tags: v.tags ?? '', notes: v.notes ?? '' });
          return null;
        } catch (e) {
          if (e instanceof ValidationError) return e.message;
          log.error('could not save the poster details', e);
          return "Couldn't save, try again";
        }
      },
    });
  }

  // ---- PDF ----
  function setBusy(on: boolean): void {
    busy = on;
    pdfBtn.disabled = on;
    for (const b of partsHost.querySelectorAll('button')) b.disabled = on;
  }

  async function runPdf(shots: ShotRecord[], title: string, part?: { index: number; total: number }): Promise<Blob | null> {
    if (busy) return null;
    setBusy(true);
    abort = new AbortController();
    const progress = createProgress('Building PDF...', () => abort?.abort());
    progress.set(0);
    progressHost.replaceChildren(progress.el);
    try {
      const blob = await buildPosterPdf(title, shots, exportDeps, { signal: abort.signal, onProgress: (d, t) => progress.set(d / t) });
      if (disposed) return null;
      downloadBlob(blob, pdfFilename(title, part));
      return blob;
    } catch (e) {
      if (!isAbortError(e)) {
        if (e instanceof ExportError) ctx.toast.show(e.message, { kind: 'warn' });
        else {
          log.error('pdf export failed', e);
          ctx.toast.show("Couldn't build the PDF on this device. Try exporting in parts or fewer photos.", { kind: 'error', timeoutMs: 8000 });
        }
      }
      return null;
    } finally {
      abort = null;
      progressHost.replaceChildren();
      if (!disposed) setBusy(false);
    }
  }

  async function startPdf(): Promise<void> {
    if (!detail || busy) return;
    clear(partsHost);
    const shots = pdfEligible(ordered);
    if (shots.length === 0) {
      ctx.toast.show('Adjust a photo first. PDFs contain corrected or original photos.', { kind: 'warn' });
      return;
    }
    const title = detail.poster.title;
    setBusy(true);
    let sizes: number[];
    try {
      sizes = await pdfSizes(shots, exportDeps);
    } catch (e) {
      log.error('could not size the PDF', e);
      ctx.toast.show("Couldn't prepare the PDF", { kind: 'error' });
      if (!disposed) setBusy(false);
      return;
    }
    if (disposed) return;
    setBusy(false);
    const limits = pdfLimits();
    const parts = planPdfParts(sizes, limits.maxBytes, limits.maxPages);
    if (parts.length <= 1) {
      await runPdf(shots, title);
      return;
    }
    // over the limits: never a failed export, offer N parts instead
    partsHost.append(
      el('p', { class: 'notice notice-warn', text: `${TOO_BIG_MESSAGE}. Export it in ${parts.length} parts.`, attrs: { role: 'status' } }),
    );
    const rows = el('ul', { class: 'parts-list', attrs: { 'aria-label': `Export in ${parts.length} parts` } });
    parts.forEach((part, i) => {
      const subset = part.map((idx) => shots[idx]!);
      const bytes = part.reduce((n, idx) => n + (sizes[idx] ?? 0), 0);
      const warn = partWarning(part, sizes, limits.maxBytes);
      const row = el('li', { class: 'part-row' });
      const exportPart = button(`${partLabel(i, parts.length, part)}, ${formatMegabytes(bytes)}`, () => {
        void runPdf(subset, title, { index: i + 1, total: parts.length }).then((blob) => {
          if (blob && canShare && !disposed) {
            const shareBtn = button(`Share part ${i + 1}`, () => {
              void shareFile(blob, pdfFilename(title, { index: i + 1, total: parts.length }), 'application/pdf');
            }, 'btn btn-small');
            row.append(shareBtn);
          }
        });
      }, 'btn');
      row.append(exportPart);
      if (warn || isOversizedPart(part, sizes, limits.maxBytes)) row.append(el('span', { class: 'part-warning', text: warn ?? '' }));
      rows.append(row);
    });
    partsHost.append(rows);
    partsHost.querySelector('button')?.focus();
  }

  // ---- list ----
  const load = async (): Promise<void> => {
    const d = await ctx.store.getPoster(posterId);
    if (disposed) return;
    if (!d) {
      ctx.toast.show('That item no longer exists');
      ctx.router.navigate({ name: 'library' }, { replace: true });
      return;
    }
    detail = d;
    ordered = orderShots(d.shots);
    thumbs.dispose();
    clear(list);
    heading.textContent = d.poster.title;
    meta.textContent = posterMetaLine(d.poster);
    notes.textContent = d.poster.notes ?? '';
    notes.hidden = !d.poster.notes;
    updateDetailButton();
    const unsaved = ctx.store.unsavedIds();
    ordered.forEach((s, i) => {
      const label = shotLabel(s, i);
      const host = el('div', { class: 'card-thumb' });
      thumbs.observe(host, s.thumb, i + 1, `${label} thumbnail`);
      const badges = el('div', { class: 'card-badges' }, el('span', { class: 'badge', text: STATUS_TEXT[s.status] }));
      if (unsaved.has(s.id)) badges.append(createUnsavedBadge());
      const open = s.status === 'captured' ? null : el('a', { class: 'btn btn-small', text: 'Open', attrs: { href: routeToHash({ name: 'view', id: s.id }), 'aria-label': `Open ${label}` } });
      const adjust = el('a', { class: 'btn btn-small', text: 'Adjust', attrs: { href: routeToHash({ name: 'adjust', id: s.id }), 'aria-label': `Adjust ${label}` } });
      list.append(
        el(
          'li',
          { class: 'card' },
          el('a', { class: 'card-link', attrs: { href: routeToHash(routeForShot(s)) } }, host, el('div', { class: 'card-body' }, el('h2', { class: 'card-title', text: label }), badges)),
          el('div', { class: 'card-actions' }, open, adjust),
        ),
      );
    });
  };

  const topbar = createTopbar({ title: '', backHref: routeToHash({ name: 'library' }) });
  topbar.querySelector('.topbar-title')?.replaceWith(heading);
  root.replaceChildren(
    topbar,
    el('main', { class: 'screen-body' }, meta, notes, el('div', { class: 'poster-actions', attrs: { role: 'group', 'aria-label': 'Poster actions' } }, detailBtn, pdfBtn, editBtn), progressHost, partsHost, list),
  );
  const off = ctx.store.onChange(() => void load());
  void load();

  return () => {
    disposed = true;
    abort?.abort();
    off();
    thumbs.dispose();
    root.replaceChildren();
  };
};
