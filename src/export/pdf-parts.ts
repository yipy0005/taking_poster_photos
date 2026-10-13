// Splitting a poster into PDF parts that stay within the page and byte limits (design 2.13). Pure.
import { PDF_LIMITS, isIosWebKit } from '../app/config.ts';

export interface PdfLimits {
  maxPages: number;
  maxBytes: number;
}

/** iOS/iPadOS WebKit: 12 pages / 60 MB. Elsewhere: 40 pages / 150 MB (limits live in config.ts). */
export function pdfLimits(ios: boolean = isIosWebKit()): PdfLimits {
  return ios ? { ...PDF_LIMITS.ios } : { ...PDF_LIMITS.other };
}

/**
 * Groups consecutive shots greedily into parts of at most `maxPages` pages and `maxBytes` bytes. A single shot larger than
 * `maxBytes` becomes its own part (see `isOversizedPart`). Returns indices into `sizes`.
 */
export function planPdfParts(sizes: readonly number[], maxBytes: number, maxPages: number): number[][] {
  const parts: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  const pageLimit = Math.max(1, Math.floor(maxPages));
  sizes.forEach((size, i) => {
    if (size > maxBytes) {
      if (current.length > 0) parts.push(current);
      parts.push([i]);
      current = [];
      bytes = 0;
      return;
    }
    if (current.length > 0 && (current.length + 1 > pageLimit || bytes + size > maxBytes)) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(i);
    bytes += size;
  });
  if (current.length > 0) parts.push(current);
  return parts;
}

/** A part made of one shot that alone exceeds the byte limit: "may fail on this device". */
export function isOversizedPart(part: readonly number[], sizes: readonly number[], maxBytes: number): boolean {
  return part.length === 1 && (sizes[part[0] ?? -1] ?? 0) > maxBytes;
}

export function totalBytes(sizes: readonly number[]): number {
  return sizes.reduce((a, b) => a + b, 0);
}

export const TOO_BIG_MESSAGE = 'This poster is too big for one PDF on this device';
