// Optional enhancements (design 2.6 steps 3-5): global per-channel LUTs (auto-contrast, gray-world white balance) and a
// luma-only 3x3 unsharp mask. All off by default; they never touch the stored original. DOM-free.
import type { Raster } from './geometry.ts';

export interface EnhanceFlags {
  autoContrast: boolean;
  whiteBalance: boolean;
  sharpen: boolean;
}
export const NO_ENHANCEMENT: Readonly<EnhanceFlags> = { autoContrast: false, whiteBalance: false, sharpen: false };
export const hasLutEnhancement = (f: EnhanceFlags): boolean => f.autoContrast || f.whiteBalance;
export const hasEnhancement = (f: EnhanceFlags): boolean => f.autoContrast || f.whiteBalance || f.sharpen;

/** Three 256-entry tables (R, G, B). */
export type Luts = readonly [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray];

const LOW_PCT = 0.01;
const HIGH_PCT = 0.99;
const MIN_SPREAD = 8;
const GAIN_MIN = 0.25;
const GAIN_MAX = 4;

function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= target) return v;
  }
  return 255;
}

/** Computes the LUTs from a (small) sample of the poster. Returns null when no LUT enhancement is requested. */
export function computeLuts(sample: Raster, flags: EnhanceFlags): Luts | null {
  if (!hasLutEnhancement(flags)) return null;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sum = [0, 0, 0];
  let n = 0;
  const d = sample.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const v = d[i + c]!;
      hist[c]![v]!++;
      sum[c]! += v;
    }
    n++;
  }
  const luts: Uint8ClampedArray[] = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  const mean = n > 0 ? sum.map((s) => s / n) : [128, 128, 128];
  const gray = (mean[0]! + mean[1]! + mean[2]!) / 3;
  for (let c = 0; c < 3; c++) {
    const gain = flags.whiteBalance && mean[c]! > 0 ? Math.min(GAIN_MAX, Math.max(GAIN_MIN, gray / mean[c]!)) : 1;
    let lo = 0;
    let hi = 255;
    if (flags.autoContrast && n > 0) {
      const plo = percentile(hist[c]!, n, LOW_PCT) * gain;
      const phi = percentile(hist[c]!, n, HIGH_PCT) * gain;
      if (phi - plo >= MIN_SPREAD) {
        lo = plo;
        hi = phi;
      }
    }
    const span = hi - lo;
    for (let v = 0; v < 256; v++) luts[c]![v] = Math.round(((v * gain - lo) / span) * 255);
  }
  return [luts[0]!, luts[1]!, luts[2]!];
}

/** Applies the LUTs in place (tile-safe: per-pixel). */
export function applyLuts(r: Raster, luts: Luts): void {
  const d = r.data;
  const [lr, lg, lb] = luts;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lr[d[i]!]!;
    d[i + 1] = lg[d[i + 1]!]!;
    d[i + 2] = lb[d[i + 2]!]!;
  }
}

/** Luma-only 3x3 unsharp mask in place (gaussian kernel 1-2-1, amount 0.5). Borders clamp to the edge. */
export function unsharp(r: Raster, amount = 0.5): void {
  const { width: w, height: h, data: d } = r;
  if (w === 0 || h === 0) return;
  const luma = new Float32Array(w * h);
  for (let p = 0, i = 0; p < luma.length; p++, i += 4) luma[p] = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  const at = (x: number, y: number): number => luma[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const blur =
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) + 2 * at(x - 1, y) + 4 * at(x, y) + 2 * at(x + 1, y) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) /
        16;
      const delta = amount * (luma[y * w + x]! - blur);
      const i = (y * w + x) * 4;
      d[i] = d[i]! + delta;
      d[i + 1] = d[i + 1]! + delta;
      d[i + 2] = d[i + 2]! + delta;
    }
  }
}
