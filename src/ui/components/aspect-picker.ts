// Aspect chips (design 2.14, AC-15/16; plan.md finding 4): Auto / A portrait / A landscape / 4:3 / 16:9 / Free.
// Auto is always presented as an ESTIMATE; a low-confidence estimate says so and offers one-tap A-series / 4:3 suggestions.
// Chip text and suggestions are pure functions so they can be tested without a DOM.
import type { AspectEstimate } from '../../cv/aspect.ts';
import type { AspectMode, Quad } from '../../cv/geometry.ts';
import { quadEdges } from '../../cv/output-size.ts';
import { el } from '../dom.ts';

export const ASPECT_CHIPS: ReadonlyArray<{ mode: AspectMode; label: string }> = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'a-portrait', label: 'A portrait' },
  { mode: 'a-landscape', label: 'A landscape' },
  { mode: '4:3', label: '4:3' },
  { mode: '16:9', label: '16:9' },
  { mode: 'free', label: 'Free' },
];

/** "Auto (est.)", "Auto (est.) ~A-series" (snapped) or "Auto (est., low confidence)". */
export function autoChipLabel(est: AspectEstimate | null): string {
  if (!est) return 'Auto (est.)';
  if (est.confidence === 'low') return 'Auto (est., low confidence)';
  return est.snapped ? `Auto (est.) ~${est.snapped}` : 'Auto (est.)';
}

export function chipLabel(mode: AspectMode, est: AspectEstimate | null): string {
  return mode === 'auto' ? autoChipLabel(est) : (ASPECT_CHIPS.find((c) => c.mode === mode)?.label ?? mode);
}

export interface Suggestion {
  label: string;
  mode: AspectMode;
}

/**
 * One-tap suggestions for a low-confidence Auto estimate. "A-series" follows the quad's orientation. "4:3" is only offered for
 * a landscape quad, because the 4:3 mode is a landscape ratio and would stretch a portrait poster.
 */
export function aspectSuggestions(est: AspectEstimate | null, quad: Quad, mode: AspectMode): Suggestion[] {
  if (mode !== 'auto' || !est || est.confidence !== 'low') return [];
  const { W0, H0 } = quadEdges(quad);
  const landscape = W0 >= H0;
  const out: Suggestion[] = [{ label: 'A-series', mode: landscape ? 'a-landscape' : 'a-portrait' }];
  if (landscape) out.push({ label: '4:3', mode: '4:3' });
  return out;
}

export interface AspectPicker {
  el: HTMLElement;
  setMode(mode: AspectMode): void;
  /** Update the Auto chip text and the suggestion row. */
  setEstimate(est: AspectEstimate | null, quad: Quad): void;
  setDisabled(disabled: boolean): void;
}

export function createAspectPicker(opts: { mode: AspectMode; onChange(mode: AspectMode): void }): AspectPicker {
  let mode = opts.mode;
  let est: AspectEstimate | null = null;
  let quad: Quad | null = null;
  let disabled = false;

  const row = el('div', { class: 'chip-row', attrs: { role: 'radiogroup', 'aria-label': 'Aspect ratio' } });
  const suggest = el('div', { class: 'chip-suggest', attrs: { 'aria-live': 'polite' } });
  const root = el('div', { class: 'aspect-picker' }, row, suggest);

  const choose = (m: AspectMode): void => {
    if (disabled || m === mode) return;
    mode = m;
    render();
    opts.onChange(m);
  };

  let lastKey = '';
  const render = (): void => {
    const s = quad ? aspectSuggestions(est, quad, mode) : [];
    // Skip identical renders: setEstimate runs on every pointer move and must not rebuild focused buttons.
    const key = [mode, autoChipLabel(est), disabled, ...s.map((x) => `${x.label}>${x.mode}`)].join('|');
    if (key === lastKey) return;
    lastKey = key;
    row.replaceChildren(
      ...ASPECT_CHIPS.map((c) =>
        el('button', {
          class: `chip${c.mode === mode ? ' is-selected' : ''}`,
          text: chipLabel(c.mode, est),
          attrs: { type: 'button', role: 'radio', 'aria-checked': String(c.mode === mode), disabled },
          on: { click: () => choose(c.mode) },
        }),
      ),
    );
    suggest.replaceChildren();
    if (s.length > 0) {
      suggest.append(el('span', { class: 'chip-suggest-text', text: 'Not sure about the shape. Try:' }));
      for (const item of s) {
        suggest.append(el('button', { class: 'chip', text: item.label, attrs: { type: 'button', disabled }, on: { click: () => choose(item.mode) } }));
      }
    }
  };

  render();
  return {
    el: root,
    setMode(m) {
      mode = m;
      render();
    },
    setEstimate(e, q) {
      est = e;
      quad = q;
      render();
    },
    setDisabled(d) {
      disabled = d;
      render();
    },
  };
}
