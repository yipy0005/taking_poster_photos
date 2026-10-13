// "Not saved" badge for items that only live in the session overlay (design 2.10 UI).
import { el } from '../dom.ts';

export interface UnsavedActions {
  onRetry?: () => void;
  onExport?: () => void;
  onDiscard?: () => void;
}

export function createUnsavedBadge(): HTMLElement {
  return el('span', { class: 'badge badge-warn', text: 'Not saved', attrs: { title: 'This photo is only kept for this session' } });
}

/** Badge plus the three actions: Retry save, Export, Discard (only the ones provided). */
export function createUnsavedBar(actions: UnsavedActions): HTMLElement {
  const bar = el('div', { class: 'unsaved-bar', attrs: { role: 'group', 'aria-label': 'Not saved' } }, createUnsavedBadge());
  const add = (label: string, fn?: () => void): void => {
    if (fn) bar.append(el('button', { class: 'btn btn-small', text: label, attrs: { type: 'button' }, on: { click: fn } }));
  };
  add('Retry save', actions.onRetry);
  add('Export', actions.onExport);
  add('Discard', actions.onDiscard);
  return bar;
}
