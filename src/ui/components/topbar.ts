// Top bar: optional back link, title, and trailing actions. Respects safe-area insets via CSS.
import { el } from '../dom.ts';

export interface TopbarOptions {
  title: string;
  /** Hash (for example '#/library') the back arrow points to. */
  backHref?: string;
  actions?: Array<HTMLElement | null>;
}

export function createTopbar(options: TopbarOptions): HTMLElement {
  const bar = el('header', { class: 'topbar' });
  if (options.backHref) {
    bar.append(el('a', { class: 'btn btn-icon', text: '\u2190', attrs: { href: options.backHref, 'aria-label': 'Back' } }));
  }
  bar.append(el('h1', { class: 'topbar-title', text: options.title }));
  const actions = el('div', { class: 'topbar-actions' });
  for (const a of options.actions ?? []) if (a) actions.append(a);
  bar.append(actions);
  return bar;
}
