// Pure helpers of the Poster and Result screens: gallery order and text. DOM-free so they are unit-tested.
import { cellIndex } from '../../camera/detail-grid.ts';
import { isOversizedPart } from '../../export/pdf-parts.ts';
import type { PosterRecord, ShotRecord } from '../../storage/schema.ts';

type Orderable = Pick<ShotRecord, 'kind' | 'gridCell' | 'createdAt'>;

/** Gallery order (AC-21): overview first, then the detail shots in grid order; ungridded details last, oldest first. */
export function orderShots<T extends Orderable>(shots: readonly T[]): T[] {
  const rank = (s: T): number => (s.kind === 'overview' ? 0 : s.gridCell ? 1 : 2);
  return shots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = rank(a.s);
      const rb = rank(b.s);
      if (ra !== rb) return ra - rb;
      if (ra === 1) {
        const d = cellIndex(a.s.gridCell!) - cellIndex(b.s.gridCell!);
        if (d !== 0) return d;
      }
      return a.s.createdAt - b.s.createdAt || a.i - b.i;
    })
    .map((x) => x.s);
}

export function posterMetaLine(p: Pick<PosterRecord, 'conference' | 'tags'>): string {
  return [p.conference, p.tags.length ? p.tags.map((t) => `#${t}`).join(' ') : ''].filter(Boolean).join(' \u00b7 ');
}

/** "Export part 2 of 3 (pages 13 to 24)". */
export function partLabel(index: number, total: number, part: readonly number[]): string {
  const first = (part[0] ?? 0) + 1;
  const last = (part[part.length - 1] ?? 0) + 1;
  const pages = first === last ? `page ${first}` : `pages ${first} to ${last}`;
  return `Export part ${index + 1} of ${total} (${pages})`;
}

export function partWarning(part: readonly number[], sizes: readonly number[], maxBytes: number): string | null {
  return isOversizedPart(part, sizes, maxBytes) ? 'This photo alone is large and may fail on this device' : null;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** Splits free text such as "ml, vision  nlp" into the tag input the store accepts (it normalises). */
export function tagsToText(tags: readonly string[]): string {
  return tags.join(', ');
}
