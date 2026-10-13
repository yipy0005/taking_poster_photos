// Pure helpers of the Adjust screen: coordinate scaling, detection result handling, notices. DOM-free so they are unit-tested.
import { PREVIEW_LONG_EDGE } from '../../app/config.ts';
import { defaultInsetQuad, isValidQuad, scaleQuad, type Quad } from '../../cv/geometry.ts';
import type { OutputSize } from '../../cv/output-size.ts';
import type { CornersSource } from '../../storage/schema.ts';

export const NO_EDGES_MESSAGE = "Couldn't find edges, drag the corners";
export const PREVIEW_TOO_LARGE_MESSAGE = 'This photo is too large for this device to preview';
/** Strikes in the preview group after which the preview is at its smallest (design 2.7 item 9). */
export const PREVIEW_MAX_STRIKES = 3;

/** Scale factors from preview pixels to ORIGINAL oriented pixels (plan.md finding 13: `s = origW / previewW`). */
export interface PreviewScale {
  sx: number;
  sy: number;
}

export function previewScale(origW: number, origH: number, previewW: number, previewH: number): PreviewScale {
  return { sx: origW / previewW, sy: origH / previewH };
}

export const toOriginal = (q: Quad, s: PreviewScale): Quad => scaleQuad(q, s.sx, s.sy);
export const toPreview = (q: Quad, s: PreviewScale): Quad => scaleQuad(q, 1 / s.sx, 1 / s.sy);

/** The validity test handed to the corner editor: always evaluated in original pixels. */
export const validatorFor =
  (s: PreviewScale, origW: number, origH: number) =>
  (previewQuad: Quad): boolean =>
    isValidQuad(toOriginal(previewQuad, s), origW, origH);

export interface DetectedQuad {
  /** In ORIGINAL pixels. */
  quad: Quad;
  source: CornersSource;
  /** Shown to the user when the quad is only a default guess. */
  message: string | null;
}

/**
 * Turns an engine detection (coordinates in the raster it was given) into a quad in original pixels. When nothing credible was
 * found, or the scaled result does not validate, the 8% inset rectangle is used with the "Couldn't find edges" message (AC-9).
 */
export function fromDetection(
  outcome: { quad: Quad; found: boolean; engine: 'js' | 'opencv' },
  raster: { width: number; height: number },
  origW: number,
  origH: number,
): DetectedQuad {
  const fallback: DetectedQuad = { quad: defaultInsetQuad(origW, origH), source: 'default', message: NO_EDGES_MESSAGE };
  if (!outcome.found) return fallback;
  const scaled = scaleQuad(outcome.quad, origW / raster.width, origH / raster.height);
  if (!isValidQuad(scaled, origW, origH)) return fallback;
  return { quad: scaled, source: outcome.engine === 'opencv' ? 'auto-opencv' : 'auto-js', message: null };
}

/** "Large photo (N MP): working from a reduced copy; export uses the original" for oversize or strike-reduced previews. */
export function largePhotoNotice(opts: { oversize?: boolean; origW: number; origH: number; previewW: number; previewH: number }): string | null {
  const origLong = Math.max(opts.origW, opts.origH);
  const previewLong = Math.max(opts.previewW, opts.previewH);
  const normallyReduced = Math.min(PREVIEW_LONG_EDGE, origLong);
  const strikeReduced = previewLong < normallyReduced * 0.98;
  if (!opts.oversize && !strikeReduced) return null;
  const mp = Math.round((opts.origW * opts.origH) / 1e6);
  return `Large photo (${mp} MP): working from a reduced copy; export uses the original`;
}

export const megapixelText = (w: number, h: number): string => `${((w * h) / 1e6).toFixed(1)} MP`;

export interface OutputNote {
  text: string;
  /** "Reduced to N MP for this device" when the cap applied. */
  reduced: string | null;
}

export function describeOutput(out: OutputSize): OutputNote {
  return {
    text: `Output ${out.width} x ${out.height} px (${megapixelText(out.width, out.height)})`,
    reduced: out.downscaled ? `Reduced to ${((out.width * out.height) / 1e6).toFixed(1)} MP for this device` : null,
  };
}

export const REDUCED_COPY_NOTICE = 'Rendered from a reduced copy to fit this device';
export const SMALLER_COPY_NOTICE = 'Rendered at a smaller size to fit this device';

export function previewTooLarge(strikes: number): boolean {
  return strikes >= PREVIEW_MAX_STRIKES;
}
