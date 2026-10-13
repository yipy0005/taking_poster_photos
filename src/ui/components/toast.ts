// Toasts in an aria-live="polite" region (design 2.14 accessibility).
import { el } from '../dom.ts';

export interface ToastOptions {
  /** Auto-dismiss after this many ms (default 5000; 0 keeps it until dismissed). */
  timeoutMs?: number;
  action?: { label: string; onClick: () => void };
  kind?: 'info' | 'warn' | 'error';
}

export interface Toaster {
  show(message: string, options?: ToastOptions): void;
  dispose(): void;
}

export function createToaster(host: HTMLElement): Toaster {
  const region = el('div', { class: 'toast-region', attrs: { 'aria-live': 'polite', 'aria-atomic': 'false', role: 'status' } });
  host.append(region);
  const timers = new Set<ReturnType<typeof setTimeout>>();

  return {
    show(message, options = {}) {
      const item = el('div', { class: `toast toast-${options.kind ?? 'info'}` }, el('span', { class: 'toast-text', text: message }));
      const remove = (): void => item.remove();
      if (options.action) {
        const { label, onClick } = options.action;
        item.append(
          el('button', {
            class: 'btn btn-small',
            text: label,
            attrs: { type: 'button' },
            on: {
              click: () => {
                onClick();
                remove();
              },
            },
          }),
        );
      }
      item.append(el('button', { class: 'btn btn-small btn-ghost', text: 'Dismiss', attrs: { type: 'button', 'aria-label': 'Dismiss message' }, on: { click: remove } }));
      region.append(item);
      const ms = options.timeoutMs ?? 5000;
      if (ms > 0) {
        const t = setTimeout(() => {
          timers.delete(t);
          remove();
        }, ms);
        timers.add(t);
      }
    },
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      region.remove();
    },
  };
}
