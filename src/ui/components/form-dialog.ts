// Modal form dialog (rename, edit details). Focus trap, Escape to cancel, focus returns to the trigger (design 2.14).
import { el } from '../dom.ts';

export interface FormField {
  name: string;
  label: string;
  value: string;
  multiline?: boolean;
  maxLength?: number;
  hint?: string;
  placeholder?: string;
}

export interface FormDialogOptions {
  title: string;
  fields: FormField[];
  confirmLabel: string;
  /** Return an error message to keep the dialog open, or null to accept. */
  submit(values: Record<string, string>): Promise<string | null> | string | null;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
let counter = 0;

/** Resolves true when the form was accepted, false when cancelled. */
export function formDialog(options: FormDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const uid = ++counter;
    const titleId = `form-title-${uid}`;
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const error = el('p', { class: 'form-error', attrs: { role: 'alert' } });

    const finish = (ok: boolean): void => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      trigger?.focus();
      resolve(ok);
    };

    const rows = options.fields.map((f, i) => {
      const id = `form-${uid}-${i}`;
      const attrs = { id, name: f.name, maxlength: f.maxLength, placeholder: f.placeholder, autocomplete: 'off' };
      const input = f.multiline ? el('textarea', { class: 'form-input', attrs: { ...attrs, rows: 4 } }) : el('input', { class: 'form-input', attrs: { ...attrs, type: 'text' } });
      input.value = f.value;
      inputs.set(f.name, input);
      return el('div', { class: 'form-row' }, el('label', { text: f.label, attrs: { for: id } }), input, f.hint ? el('small', { class: 'form-hint', text: f.hint }) : null);
    });

    const confirmBtn = el('button', { class: 'btn btn-primary', text: options.confirmLabel, attrs: { type: 'submit' } });
    const cancelBtn = el('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => finish(false) } });
    const form = el('form', { class: 'dialog-form', attrs: { novalidate: true } }, ...rows, error, el('div', { class: 'dialog-actions' }, cancelBtn, confirmBtn));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const values: Record<string, string> = {};
      for (const [name, input] of inputs) values[name] = input.value;
      confirmBtn.disabled = true;
      error.textContent = '';
      void Promise.resolve(options.submit(values)).then(
        (message) => {
          if (message === null) finish(true);
          else {
            error.textContent = message;
            confirmBtn.disabled = false;
          }
        },
        () => {
          error.textContent = "Couldn't save, try again";
          confirmBtn.disabled = false;
        },
      );
    });

    const dialog = el('div', { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } }, el('h2', { class: 'dialog-title', text: options.title, attrs: { id: titleId } }), form);
    const backdrop = el('div', { class: 'dialog-backdrop', on: { click: (ev) => ev.target === backdrop && finish(false) } }, dialog);

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
        return;
      }
      if (ev.key !== 'Tab') return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !(n as HTMLButtonElement).disabled);
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
    inputs.values().next().value?.focus();
  });
}
