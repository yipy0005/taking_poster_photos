// Pure-TS poster detector (design 2.8 "JS engine details"): downscale, grayscale, 5x5 Gaussian blur, Otsu threshold (both
// polarities), 3x3 opening, largest 4-connected component, convex hull, extreme-direction corners. A best-effort
// heuristic; the user always confirms the corners. DOM-free.
import { isStrictlyConvex, polygonArea, quadArea, validateQuad, type Pt, type Quad, type Raster } from '../geometry.ts';
import type { DetectResult } from '../protocol.ts';

export const DETECT_WORK_EDGE = 640;
export const MIN_AREA_FRACTION = 0.15;
export const MAX_AREA_FRACTION = 0.98;

interface Gray {
  w: number;
  h: number;
  d: Uint8Array;
}

/** Box-average downscale to a long edge of at most `edge`; returns the gray image and the scale factor >= 1. */
export function toGray(img: Raster, edge: number = DETECT_WORK_EDGE): { gray: Gray; scale: number } {
  const long = Math.max(img.width, img.height);
  const scale = long > edge ? long / edge : 1;
  const w = Math.max(1, Math.round(img.width / scale));
  const h = Math.max(1, Math.round(img.height / scale));
  const d = new Uint8Array(w * h);
  const src = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * scale)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          sum += 0.299 * src[i]! + 0.587 * src[i + 1]! + 0.114 * src[i + 2]!;
          n++;
        }
      }
      d[y * w + x] = n > 0 ? Math.round(sum / n) : 0;
    }
  }
  return { gray: { w, h, d }, scale };
}

const K5 = [1, 4, 6, 4, 1];
export function blur5(g: Gray): Gray {
  const { w, h, d } = g;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += K5[k + 2]! * d[y * w + Math.min(w - 1, Math.max(0, x + k))]!;
      tmp[y * w + x] = s / 16;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += K5[k + 2]! * tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]!;
      out[y * w + x] = Math.round(s / 16);
    }
  }
  return { w, h, d: out };
}

export function otsu(g: Gray): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.d.length; i++) hist[g.d[i]!]!++;
  const total = g.d.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

/** Separable 3x3 min (erode) / max (dilate); neighbours outside the image are ignored. */
function morph(m: Uint8Array, w: number, h: number, dilate: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = m[y * w + x]!;
      if (x > 0) v = dilate ? Math.max(v, m[y * w + x - 1]!) : Math.min(v, m[y * w + x - 1]!);
      if (x < w - 1) v = dilate ? Math.max(v, m[y * w + x + 1]!) : Math.min(v, m[y * w + x + 1]!);
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x]!;
      if (y > 0) v = dilate ? Math.max(v, tmp[(y - 1) * w + x]!) : Math.min(v, tmp[(y - 1) * w + x]!);
      if (y < h - 1) v = dilate ? Math.max(v, tmp[(y + 1) * w + x]!) : Math.min(v, tmp[(y + 1) * w + x]!);
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Largest 4-connected component (iterative flood fill). Returns per-row extents and the pixel count. */
function largestComponent(m: Uint8Array, w: number, h: number): { area: number; rowMin: Int32Array; rowMax: Int32Array } | null {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0;
  let bestArea = 0;
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || label[s]) continue;
    next++;
    let sp = 0;
    let area = 0;
    stack[sp++] = s;
    label[s] = next;
    while (sp > 0) {
      const p = stack[--sp]!;
      area++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && m[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && m[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && m[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    if (area > bestArea) {
      bestArea = area;
      bestLabel = next;
    }
  }
  if (bestArea === 0) return null;
  const rowMin = new Int32Array(h).fill(-1);
  const rowMax = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] === bestLabel) {
        if (rowMin[y]! < 0) rowMin[y] = x;
        rowMax[y] = x;
      }
    }
  }
  return { area: bestArea, rowMin, rowMax };
}

/** Andrew's monotone chain; returns the hull in counter-clockwise order (no repeated end point). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

interface Candidate {
  quad: Quad;
  confidence: number;
  area: number;
}

function candidate(mask: Uint8Array, w: number, h: number, scale: number, imgW: number, imgH: number): Candidate | null {
  const opened = morph(morph(mask, w, h, false), w, h, true);
  const comp = largestComponent(opened, w, h);
  if (!comp) return null;
  const pts: Pt[] = [];
  for (let y = 0; y < h; y++) {
    const x0 = comp.rowMin[y]!;
    if (x0 < 0) continue;
    const x1 = comp.rowMax[y]! + 1;
    pts.push([x0, y], [x0, y + 1], [x1, y], [x1, y + 1]);
  }
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  const hullArea = polygonArea(hull);
  const solidity = hullArea > 0 ? Math.min(1, comp.area / hullArea) : 0;
  let tl = hull[0]!, tr = hull[0]!, br = hull[0]!, bl = hull[0]!;
  for (const p of hull) {
    if (p[0] + p[1] < tl[0] + tl[1]) tl = p;
    if (p[0] - p[1] > tr[0] - tr[1]) tr = p;
    if (p[0] + p[1] > br[0] + br[1]) br = p;
    if (p[0] - p[1] < bl[0] - bl[1]) bl = p;
  }
  const s = (p: Pt): Pt => [Math.min(imgW, Math.max(0, p[0] * scale)), Math.min(imgH, Math.max(0, p[1] * scale))];
  const quad: Quad = [s(tl), s(tr), s(br), s(bl)];
  if (!isStrictlyConvex(quad)) return null;
  const area = quadArea(quad);
  const frac = area / (imgW * imgH);
  if (frac < MIN_AREA_FRACTION || frac > MAX_AREA_FRACTION) return null;
  try {
    validateQuad(quad, imgW, imgH);
  } catch {
    return null;
  }
  return { quad, confidence: frac * solidity, area };
}

/** Detects the poster outline in `img`. Returns `quad: null` (not an exception) when nothing credible is found. */
export function detectJs(img: Raster): DetectResult {
  const { gray, scale } = toGray(img);
  const g = blur5(gray);
  const t = otsu(g);
  const bright = new Uint8Array(g.w * g.h);
  const dark = new Uint8Array(g.w * g.h);
  for (let i = 0; i < g.d.length; i++) {
    if (g.d[i]! > t) bright[i] = 1;
    else dark[i] = 1;
  }
  const a = candidate(bright, g.w, g.h, scale, img.width, img.height);
  const b = candidate(dark, g.w, g.h, scale, img.width, img.height);
  const best = a && b ? (a.area >= b.area ? a : b) : (a ?? b);
  if (!best) return { quad: null, confidence: 0, method: 'js-threshold' };
  return { quad: best.quad, confidence: best.confidence, method: 'js-threshold' };
}
