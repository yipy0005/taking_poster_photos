// OpenCV poster detector (design 2.8 "OpenCV engine details"). DOM-free. Works on the already downscaled RGBA raster
// (long edge <= 1600): grayscale, 5x5 Gaussian blur, Canny with median-based thresholds, 3x3 dilation, contours, approxPolyDP,
// largest convex 4-vertex candidate with 15..98% of the frame. If nothing is found, one retry with an adaptive-threshold edge map.
// confidence = areaFraction * solidity (contour area / convex hull area), like the JS engine.
import { polygonArea, validateQuad, type Pt, type Quad, type Raster } from '../geometry.ts';
import type { DetectResult } from '../protocol.ts';
import { orderQuad } from '../quad-order.ts';
import type { CvApi } from './cv-loader.ts';

const MIN_AREA_FRACTION = 0.15;
const MAX_AREA_FRACTION = 0.98;
const TOP_CONTOURS = 8;

type Deletable = { delete(): void };

/** Median of an 8-bit image. */
export function medianOf(data: ArrayLike<number>): number {
  if (data.length === 0) return 128;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i++) hist[data[i]!]!++;
  let acc = 0;
  const half = data.length / 2;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= half) return v;
  }
  return 128;
}

interface Candidate {
  quad: Quad;
  area: number;
  solidity: number;
}

function findQuad(cv: CvApi, edges: InstanceType<CvApi['Mat']>, w: number, h: number, track: <T extends Deletable>(x: T) => T): Candidate | null {
  const kernel = track(cv.Mat.ones(3, 3, cv.CV_8U));
  const dilated = track(new cv.Mat());
  cv.dilate(edges, dilated, kernel);
  const contours = track(new cv.MatVector());
  const hierarchy = track(new cv.Mat());
  cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const ranked: Array<{ i: number; area: number }> = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    try {
      ranked.push({ i, area: cv.contourArea(c) });
    } finally {
      c.delete();
    }
  }
  ranked.sort((a, b) => b.area - a.area);
  const frame = w * h;
  let best: Candidate | null = null;
  for (const { i } of ranked.slice(0, TOP_CONTOURS)) {
    const cnt = contours.get(i);
    const approx = new cv.Mat();
    const hull = new cv.Mat();
    try {
      cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
      if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
      const d = approx.data32S;
      const pts: Pt[] = [
        [d[0]!, d[1]!],
        [d[2]!, d[3]!],
        [d[4]!, d[5]!],
        [d[6]!, d[7]!],
      ];
      const area = polygonArea(pts);
      const fraction = area / frame;
      if (fraction < MIN_AREA_FRACTION || fraction > MAX_AREA_FRACTION) continue;
      const quad = orderQuad(pts);
      try {
        validateQuad(quad, w, h);
      } catch {
        continue;
      }
      cv.convexHull(cnt, hull, false, true);
      const hullArea = cv.contourArea(hull);
      const solidity = hullArea > 0 ? Math.min(1, cv.contourArea(cnt) / hullArea) : 0;
      if (!best || area > best.area) best = { quad, area, solidity };
    } finally {
      cnt.delete();
      approx.delete();
      hull.delete();
    }
  }
  return best;
}

export function detectCv(cv: CvApi, img: Raster): DetectResult {
  const mats: Deletable[] = [];
  const track = <T extends Deletable>(x: T): T => {
    mats.push(x);
    return x;
  };
  try {
    const { width: w, height: h } = img;
    const src = track(new cv.Mat(h, w, cv.CV_8UC4));
    src.data.set(img.data);
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = track(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    const median = medianOf(blur.data);
    const lo = Math.max(0, Math.round(0.66 * median));
    const hi = Math.min(255, Math.max(lo + 1, Math.round(1.33 * median)));
    const edges = track(new cv.Mat());
    cv.Canny(blur, edges, lo, hi);
    let method = 'opencv-canny';
    let found = findQuad(cv, edges, w, h, track);
    if (!found) {
      const adaptive = track(new cv.Mat());
      cv.adaptiveThreshold(blur, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 10);
      method = 'opencv-adaptive';
      found = findQuad(cv, adaptive, w, h, track);
    }
    if (!found) return { quad: null, confidence: 0, method: 'opencv-none' };
    return { quad: found.quad, confidence: (found.area / (w * h)) * found.solidity, method };
  } finally {
    for (const m of mats) m.delete();
  }
}
