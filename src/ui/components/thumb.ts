// Thumbnail tile: lazy object URL (IntersectionObserver) or a neutral placeholder (design 2.9 item 5).
import type { UrlRegistry } from '../../app/url-registry.ts';
import { el, svgEl } from '../dom.ts';

export function placeholderThumb(ordinal: number): SVGSVGElement {
  const svg = svgEl(
    'svg',
    { viewBox: '0 0 64 64', class: 'thumb-placeholder', role: 'img', 'aria-label': 'Thumbnail not available' },
    svgEl('rect', { x: 4, y: 4, width: 56, height: 56, rx: 6, class: 'thumb-ph-bg' }),
  );
  const t = svgEl('text', { x: 32, y: 40, 'text-anchor': 'middle', class: 'thumb-ph-text' });
  t.textContent = String(ordinal);
  svg.append(t);
  return svg;
}

export interface ThumbController {
  observe(host: HTMLElement, blob: Blob | undefined, ordinal: number, alt: string): void;
  dispose(): void;
}

/** One controller per screen: creates URLs only when tiles scroll near the viewport and revokes them on dispose. */
export function createThumbController(urls: UrlRegistry): ThumbController {
  const pending = new Map<Element, { blob: Blob; alt: string }>();
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const job = pending.get(entry.target);
              if (!job) continue;
              pending.delete(entry.target);
              io?.unobserve(entry.target);
              (entry.target as HTMLElement).replaceChildren(el('img', { class: 'thumb-img', attrs: { src: urls.create(job.blob), alt: job.alt, decoding: 'async' } }));
            }
          },
          { rootMargin: '200px' },
        )
      : null;

  return {
    observe(host, blob, ordinal, alt) {
      if (!blob) {
        host.replaceChildren(placeholderThumb(ordinal));
        return;
      }
      host.replaceChildren(placeholderThumb(ordinal));
      if (io) {
        pending.set(host, { blob, alt });
        io.observe(host);
      } else {
        host.replaceChildren(el('img', { class: 'thumb-img', attrs: { src: urls.create(blob), alt, decoding: 'async' } }));
      }
    },
    dispose() {
      io?.disconnect();
      pending.clear();
      urls.revokeAll();
    },
  };
}
