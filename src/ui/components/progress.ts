// Determinate/indeterminate progress bar with an optional cancel button.
import { el } from '../dom.ts';

export interface ProgressBar {
  el: HTMLElement;
  /** 0..1, or null for indeterminate. */
  set(fraction: number | null): void;
  setLabel(text: string): void;
}

export function createProgress(label: string, onCancel?: () => void): ProgressBar {
  const bar = el('progress', { class: 'progress-bar', attrs: { max: 100, 'aria-label': label } });
  const text = el('span', { class: 'progress-label', text: label });
  const root = el('div', { class: 'progress' }, text, bar);
  if (onCancel) {
    root.append(el('button', { class: 'btn btn-small', text: 'Cancel', attrs: { type: 'button' }, on: { click: onCancel } }));
  }
  return {
    el: root,
    set(fraction) {
      if (fraction === null) bar.removeAttribute('value');
      else bar.value = Math.max(0, Math.min(1, fraction)) * 100;
    },
    setLabel(t) {
      text.textContent = t;
      bar.setAttribute('aria-label', t);
    },
  };
}
