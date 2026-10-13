// Library (AC-24, AC-25): poster grid with placeholders, search (title / conference / tags / notes), rename, edit details,
// delete with a confirm dialog, and the "Not saved" bar with Retry save / Export / Discard.
import { SEARCH_DEBOUNCE_MS } from '../../app/config.ts';
import { ValidationError } from '../../app/errors.ts';
import { log } from '../../app/log.ts';
import { routeToHash } from '../../app/router.ts';
import { createUrlRegistry } from '../../app/url-registry.ts';
import { downloadBlob } from '../../export/download.ts';
import { exportFilename, extensionFor } from '../../export/filename.ts';
import { debounce, searchPosters } from '../../storage/search.ts';
import type { PosterSummary } from '../../storage/schema.ts';
import { confirmDialog } from '../components/dialog.ts';
import { formDialog } from '../components/form-dialog.ts';
import { createThumbController } from '../components/thumb.ts';
import { createTopbar } from '../components/topbar.ts';
import { createUnsavedBar } from '../components/unsaved-badge.ts';
import { clear, el } from '../dom.ts';
import type { AppContext, Screen } from '../context.ts';
import { orderShots, tagsToText } from './poster-logic.ts';

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Where a library card leads: a poster with one still-uncorrected photo goes straight to Adjust (plan.md finding 14). */
export function cardRoute(p: Pick<PosterSummary, 'id' | 'shotCount' | 'needsAdjustCount' | 'coverShotId'>): string {
  if (p.shotCount === 1 && p.needsAdjustCount === 1 && p.coverShotId) return routeToHash({ name: 'adjust', id: p.coverShotId });
  return routeToHash({ name: 'poster', id: p.id });
}

export const photoCount = (n: number): string => `${n} photo${n === 1 ? '' : 's'}`;

async function exportUnsaved(ctx: AppContext, posterId: string): Promise<void> {
  const detail = await ctx.store.getPoster(posterId);
  if (!detail) return;
  const shots = orderShots(detail.shots);
  let count = 0;
  for (const s of shots) {
    const blob = (s.status === 'rectified' ? await ctx.store.getBlob(s.id, 'rectified') : null) ?? (await ctx.store.getBlob(s.id, 'original'));
    if (!blob) continue;
    downloadBlob(blob, exportFilename(detail.poster.title, s, shots, extensionFor(blob.type || s.originalMime)));
    count++;
  }
  ctx.toast.show(count > 0 ? `Exported ${photoCount(count)}` : 'Nothing to export', { kind: count > 0 ? 'info' : 'warn' });
}

export const libraryScreen: Screen = (root, ctx) => {
  const thumbs = createThumbController(createUrlRegistry());
  let all: PosterSummary[] = [];
  let query = '';
  let disposed = false;

  const list = el('ul', { class: 'card-grid', attrs: { 'aria-label': 'Posters' } });
  const empty = el('section', { class: 'empty-state' });
  const search = el('input', {
    class: 'search',
    attrs: { type: 'search', placeholder: 'Search title, conference, tags, notes', 'aria-label': 'Search posters', maxlength: 100, autocomplete: 'off' },
  });

  // ---- actions on one poster ----
  const rename = (p: PosterSummary): Promise<boolean> =>
    formDialog({
      title: 'Rename poster',
      confirmLabel: 'Rename',
      fields: [{ name: 'title', label: 'Title', value: p.title, maxLength: 120 }],
      submit: async (v) => guarded(() => ctx.store.updatePosterMeta(p.id, { title: v.title ?? '' })),
    });

  const editDetails = (p: PosterSummary): Promise<boolean> =>
    formDialog({
      title: 'Edit details',
      confirmLabel: 'Save',
      fields: [
        { name: 'conference', label: 'Conference', value: p.conference ?? '', maxLength: 120 },
        { name: 'tags', label: 'Tags', value: tagsToText(p.tags), hint: 'Separate with commas or spaces' },
        { name: 'notes', label: 'Notes', value: p.notes ?? '', multiline: true, maxLength: 2000 },
      ],
      submit: async (v) => guarded(() => ctx.store.updatePosterMeta(p.id, { conference: v.conference ?? '', tags: v.tags ?? '', notes: v.notes ?? '' })),
    });

  async function guarded(fn: () => Promise<void>): Promise<string | null> {
    try {
      await fn();
      return null;
    } catch (e) {
      if (e instanceof ValidationError) return e.message;
      log.error('could not save the poster details', e);
      return "Couldn't save, try again";
    }
  }

  async function remove(p: PosterSummary): Promise<void> {
    const n = p.shotCount;
    const ok = await confirmDialog({
      title: 'Delete this poster?',
      message: `"${p.title}" and ${photoCount(n)} will be removed from this device. This cannot be undone.`,
      confirmLabel: `Delete ${photoCount(n)}`,
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.store.deletePoster(p.id);
      ctx.toast.show('Poster deleted');
    } catch (e) {
      log.error('delete failed', e);
      ctx.toast.show("Couldn't delete, try again", { kind: 'error' });
    }
  }

  async function retry(p: PosterSummary): Promise<void> {
    try {
      const r = await ctx.store.retrySave(p.id);
      if (r.failed.length === 0) ctx.toast.show('Saved');
      else ctx.toast.show('Still not saved. Free some space, or export the photos.', { kind: 'error', timeoutMs: 8000 });
    } catch (e) {
      log.error('retry save failed', e);
      ctx.toast.show("Couldn't save, try again", { kind: 'error' });
    }
  }

  async function discard(p: PosterSummary): Promise<void> {
    const ok = await confirmDialog({
      title: 'Discard unsaved photos?',
      message: `"${p.title}" was never saved to this device. Discarding removes it for good.`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.store.discardUnsaved(p.id);
    } catch (e) {
      log.error('discard failed', e);
      ctx.toast.show("Couldn't discard, try again", { kind: 'error' });
    }
  }

  function menuFor(p: PosterSummary): HTMLElement {
    const details = el('details', { class: 'card-menu' });
    const close = (): void => details.removeAttribute('open');
    const item = (label: string, fn: () => void, cls = 'btn btn-small'): HTMLButtonElement =>
      el('button', {
        class: cls,
        text: label,
        attrs: { type: 'button' },
        on: {
          click: () => {
            close();
            fn();
          },
        },
      });
    details.append(
      el('summary', { class: 'btn btn-icon btn-small', text: '\u22ef', attrs: { 'aria-label': `More actions for ${p.title}` } }),
      el('div', { class: 'card-menu-items' }, item('Rename', () => void rename(p)), item('Edit details', () => void editDetails(p)), item('Delete', () => void remove(p), 'btn btn-small btn-danger')),
    );
    return details;
  }

  // ---- rendering ----
  const render = (): void => {
    thumbs.dispose();
    clear(list);
    clear(empty);
    const unsaved = ctx.store.unsavedIds();
    const shown = searchPosters(all, query);
    empty.hidden = shown.length > 0;
    list.hidden = shown.length === 0;
    if (all.length === 0) {
      empty.append(
        el('h2', { text: 'No posters yet' }),
        el('p', { text: 'Photograph a poster and it will show up here. Everything stays on this device.' }),
        el('a', { class: 'btn btn-primary', text: 'Take a photo', attrs: { href: routeToHash({ name: 'capture', mode: 'overview' }) } }),
      );
    } else if (shown.length === 0) {
      empty.append(el('h2', { text: 'No matches' }), el('p', { text: 'Try a different search.' }));
    }
    shown.forEach((p, i) => {
      const thumbHost = el('div', { class: 'card-thumb' });
      thumbs.observe(thumbHost, p.coverThumb, i + 1, `${p.title} thumbnail`);
      const meta = [p.conference, dateFmt.format(p.createdAt), photoCount(p.shotCount)].filter(Boolean).join(' \u00b7 ');
      const badges = el('div', { class: 'card-badges' });
      if (p.needsAdjustCount > 0) badges.append(el('span', { class: 'badge', text: 'Needs adjusting' }));
      const body = el('div', { class: 'card-body' }, el('h2', { class: 'card-title', text: p.title }), el('p', { class: 'card-meta', text: meta }), badges);
      const card = el('li', { class: 'card' }, el('a', { class: 'card-link', attrs: { href: cardRoute(p) } }, thumbHost, body), menuFor(p));
      if (unsaved.has(p.id)) {
        card.append(
          createUnsavedBar({
            onRetry: () => void retry(p),
            onExport: () => void exportUnsaved(ctx, p.id).catch((e: unknown) => log.error('export failed', e)),
            onDiscard: () => void discard(p),
          }),
        );
      }
      list.append(card);
    });
  };

  const load = async (): Promise<void> => {
    const posters = await ctx.store.listPosters();
    if (disposed) return;
    all = posters;
    render();
  };

  const onSearch = debounce(() => {
    query = search.value;
    render();
  }, SEARCH_DEBOUNCE_MS);
  search.addEventListener('input', onSearch);

  const topbar = createTopbar({
    title: 'Library',
    actions: [
      el('a', { class: 'btn', text: 'Capture', attrs: { href: routeToHash({ name: 'capture', mode: 'overview' }) } }),
      el('a', { class: 'btn btn-icon', text: '\u2699', attrs: { href: routeToHash({ name: 'settings' }), 'aria-label': 'Settings' } }),
    ],
  });
  root.replaceChildren(topbar, el('main', { class: 'screen-body' }, search, empty, list));
  const off = ctx.store.onChange(() => void load());
  void load();

  return () => {
    disposed = true;
    onSearch.cancel();
    off();
    thumbs.dispose();
    root.replaceChildren();
  };
};
