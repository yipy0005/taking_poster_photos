// Brightness statistics of a small RGBA sample, used to detect a "very dark" capture (design: dark-photo safeguard).
// Pure and DOM-free. Luma is Rec. 601 (0..255).

/** "Very dark" = mean below DARK_MEAN AND the 95th percentile below DARK_P95 (a dark poster with bright text is not flagged). */
export const DARK_MEAN = 45;
export const DARK_P95 = 120;
export const DARK_PHOTO_WARNING = 'Photo looks very dark - try the Native camera button or add light';

export interface LumaStats {
  mean: number;
  p95: number;
}

/** Mean and 95th-percentile luma of RGBA pixels. Fully transparent pixels are skipped. An empty sample counts as black. */
export function lumaStats(data: ArrayLike<number>, stride = 4): LumaStats {
  const hist = new Uint32Array(256);
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += stride) {
    if (data[i + 3] === 0) continue;
    const y = Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
    hist[Math.min(255, y)]!++;
    sum += y;
    n++;
  }
  if (n === 0) return { mean: 0, p95: 0 };
  const target = n * 0.95;
  let acc = 0;
  let p95 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= target) {
      p95 = v;
      break;
    }
  }
  return { mean: sum / n, p95 };
}

export const isVeryDark = (s: LumaStats): boolean => s.mean < DARK_MEAN && s.p95 < DARK_P95;
