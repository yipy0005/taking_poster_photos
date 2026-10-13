// Library search: in-memory, case-insensitive substring match over small summary strings (design 2.10).
import { SEARCH_MAX_LENGTH } from '../app/config.ts';
import type { PosterSummary } from './schema.ts';

/** Fields a poster is searched on. */
function haystack(p: PosterSummary): string {
  return [p.title, p.conference ?? '', p.tags.join(' '), p.notes ?? ''].join('\n').toLowerCase();
}

/** The query is a plain substring (never a regex), truncated to 100 characters. */
export function normalizeQuery(q: string): string {
  return q.trim().slice(0, SEARCH_MAX_LENGTH).toLowerCase();
}

export function searchPosters(posters: readonly PosterSummary[], query: string): PosterSummary[] {
  const q = normalizeQuery(query);
  if (q === '') return posters.slice();
  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  return posters.filter((p) => {
    const h = haystack(p);
    return terms.every((t) => h.includes(t));
  });
}

/** Trailing-edge debounce; `cancel()` drops a pending call. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}
