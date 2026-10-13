// Test support (not imported by app code): seeded RNG, pinhole projection of a rectangle, synthetic posters.
import type { Mat3, Quad, Raster } from '../geometry.ts';
import { apply, invert } from '../homography.ts';
import { createRaster } from '../raster2d.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const rad = (d: number): number => (d * Math.PI) / 180;

export interface PoseOpts {
  /** True width / height of the poster. */
  ratio: number;
  /** True focal length in pixels. */
  f: number;
  imgW: number;
  imgH: number;
  /** Degrees. Yaw turns about the vertical axis, pitch about the horizontal axis, roll about the viewing axis. */
  yaw?: number;
  pitch?: number;
  roll?: number;
  /** Poster size relative to the short image side at fronto-parallel (default 0.65). */
  fill?: number;
  /** Offset of the poster centre as a fraction of the image size. */
  offsetX?: number;
  offsetY?: number;
}

/** Projects the rectangle's corners (TL, TR, BR, BL) with a pinhole camera, principal point at the image centre. */
export function projectPoster(o: PoseOpts): Quad {
  const w = o.ratio >= 1 ? 1 : o.ratio;
  const h = o.ratio >= 1 ? 1 / o.ratio : 1;
  const yaw = rad(o.yaw ?? 0);
  const pitch = rad(o.pitch ?? 0);
  const roll = rad(o.roll ?? 0);
  const fill = o.fill ?? 0.65;
  const d = (o.f * Math.max(w, h)) / (fill * Math.min(o.imgW, o.imgH));
  const pts: Array<[number, number]> = [];
  for (const [x, y] of [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ] as const) {
    // yaw about Y, then pitch about X, then roll about Z (all about the poster centre)
    let X = x * Math.cos(yaw);
    let Y = y;
    let Z = -x * Math.sin(yaw);
    const Y2 = Y * Math.cos(pitch) - Z * Math.sin(pitch);
    const Z2 = Y * Math.sin(pitch) + Z * Math.cos(pitch);
    Y = Y2;
    Z = Z2;
    const X3 = X * Math.cos(roll) - Y * Math.sin(roll);
    const Y3 = X * Math.sin(roll) + Y * Math.cos(roll);
    X = X3;
    Y = Y3;
    const cz = Z + d;
    pts.push([
      (o.f * X) / cz + o.imgW / 2 + (o.offsetX ?? 0) * o.imgW,
      (o.f * Y) / cz + o.imgH / 2 + (o.offsetY ?? 0) * o.imgH,
    ]);
  }
  return [pts[0]!, pts[1]!, pts[2]!, pts[3]!];
}

export function addNoise(q: Quad, sigma: number, rng: () => number): Quad {
  const n = (p: readonly [number, number]): [number, number] => [p[0] + sigma * gaussian(rng), p[1] + sigma * gaussian(rng)];
  return [n(q[0]), n(q[1]), n(q[2]), n(q[3])];
}

export function percentile(values: number[], p: number): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

/** Fills the convex quad with `fg(x, y)` (pixel centre) on a `bg` background. */
export function fillQuad(w: number, h: number, quad: Quad, bg: number, fg: (x: number, y: number) => number): Raster {
  const r = createRaster(w, h);
  const inside = (px: number, py: number): boolean => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i]!;
      const b = quad[(i + 1) % 4]!;
      const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
      if (c !== 0) {
        const s = c > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
      }
    }
    return true;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = inside(x + 0.5, y + 0.5) ? fg(x + 0.5, y + 0.5) : bg;
      const i = (y * w + x) * 4;
      r.data[i] = v;
      r.data[i + 1] = v;
      r.data[i + 2] = v;
      r.data[i + 3] = 255;
    }
  }
  return r;
}

// ---- projective ground-truth scene (AC-12) ----

/** Smooth poster texture over texture coordinates (u, v) in output pixels. Gray, 0..255. */
export function texture(u: number, v: number, outW: number, outH: number): number {
  return 128 + 50 * Math.sin(u * 0.05) * Math.cos(v * 0.04) + 40 * (u / outW - 0.5) + 25 * (v / outH - 0.5);
}

/** A known texture rectangle [0,outW]x[0,outH] seen through the texture-to-source homography `Hts`. */
export function projectiveScene(outW: number, outH: number, srcW: number, srcH: number, Hts: Mat3, bg = 30) {
  const corners = [[0, 0], [outW, 0], [outW, outH], [0, outH]] as const;
  const quad = corners.map(([x, y]) => apply(Hts, x, y)) as unknown as Quad;
  const Hst = invert(Hts);
  const source = createRaster(srcW, srcH);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const [u, v] = apply(Hst, x + 0.5, y + 0.5);
      const inside = u >= 0 && u <= outW && v >= 0 && v <= outH;
      const val = inside ? texture(u, v, outW, outH) : bg;
      const i = (y * srcW + x) * 4;
      source.data[i] = val;
      source.data[i + 1] = val;
      source.data[i + 2] = val;
      source.data[i + 3] = 255;
    }
  }
  const truth = (i: number, j: number): number => texture(i + 0.5, j + 0.5, outW, outH);
  return { quad, source, truth };
}

/** Mean absolute error and max error of a rectified gray raster against the analytic texture, ignoring a border. */
export function compareToTruth(out: Raster, truth: (i: number, j: number) => number, margin = 3): { mae: number; max: number } {
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let j = margin; j < out.height - margin; j++) {
    for (let i = margin; i < out.width - margin; i++) {
      const e = Math.abs(out.data[(j * out.width + i) * 4]! - truth(i, j));
      sum += e;
      if (e > max) max = e;
      n++;
    }
  }
  return { mae: sum / n, max };
}
