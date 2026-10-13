// Modal dialog with focus trap, Escape to cancel and focus return (design 2.14 accessibility).
import { el } from '../dom.ts';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Resolves true on confirm, false on cancel/Escape/backdrop. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return openDialog(options, true);
}

/** Single-button information dialog. */
export function alertDialog(options: Omit<ConfirmOptions, 'cancelLabel' | 'danger'>): Promise<void> {
  return openDialog({ ...options }, false).then(() => undefined);
}

function openDialog(options: ConfirmOptions, withCancel: boolean): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const titleId = `dlg-title-${Math.random().toString(36).slice(2, 8)}`;
    const descId = `dlg-desc-${Math.random().toString(36).slice(2, 8)}`;

    const done = (value: boolean): void => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      trigger?.focus();
      resolve(value);
    };

    const confirmBtn = el('button', {
      class: options.danger ? 'btn btn-danger' : 'btn btn-primary',
      text: options.confirmLabel,
      attrs: { type: 'button' },
      on: { click: () => done(true) },
    });
    const cancelBtn = withCancel
      ? el('button', { class: 'btn', text: options.cancelLabel ?? 'Cancel', attrs: { type: 'button' }, on: { click: () => done(false) } })
      : null;

    const dialog = el(
      'div',
      { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': descId } },
      el('h2', { class: 'dialog-title', text: options.title, attrs: { id: titleId } }),
      el('p', { class: 'dialog-body', text: options.message, attrs: { id: descId } }),
      el('div', { class: 'dialog-actions' }, cancelBtn, confirmBtn),
    );
    const backdrop = el('div', { class: 'dialog-backdrop', on: { click: (ev) => ev.target === backdrop && done(false) } }, dialog);

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        done(false);
        return;
      }
      if (ev.key !== 'Tab') return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    (cancelBtn ?? confirmBtn).focus();
  });
}
