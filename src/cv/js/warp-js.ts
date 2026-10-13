// Pure-TS perspective warp (design 2.5 sampling rule, 2.8 JS engine details). Inverse mapping over destination pixels,
// bilinear with integer weights 0..256, clamp-to-edge, half-pixel centres. DOM-free.
import type { Mat3, Raster } from '../geometry.ts';
import { createRaster } from '../raster2d.ts';

/**
 * Warps `roi` into a tileW x tileH raster. `H` maps tile-local destination pixel-edge coordinates to ROI-local source
 * pixel-edge coordinates (Htile of design 2.5). Destination pixel (i, j) samples the source at H*(i+0.5, j+0.5) - 0.5.
 */
export function warpTile(roi: Raster, H: Mat3, tileW: number, tileH: number): Raster {
  const out = createRaster(tileW, tileH);
  const sw = roi.width;
  const sh = roi.height;
  if (sw === 0 || sh === 0) return out;
  const src = roi.data;
  const dst = out.data;
  const h0 = H[0]!, h1 = H[1]!, h2 = H[2]!, h3 = H[3]!, h4 = H[4]!, h5 = H[5]!, h6 = H[6]!, h7 = H[7]!, h8 = H[8]!;
  const maxX = sw - 1;
  const maxY = sh - 1;
  let o = 0;
  for (let j = 0; j < tileH; j++) {
    const yc = j + 0.5;
    // per-row start, then incremental accumulation in Float64
    let X = h0 * 0.5 + h1 * yc + h2;
    let Y = h3 * 0.5 + h4 * yc + h5;
    let Wd = h6 * 0.5 + h7 * yc + h8;
    for (let i = 0; i < tileW; i++, o += 4, X += h0, Y += h3, Wd += h6) {
      if (Wd <= 1e-9) continue; // transparent black
      let xs = X / Wd - 0.5;
      let ys = Y / Wd - 0.5;
      if (!(xs >= 0)) xs = 0;
      else if (xs > maxX) xs = maxX;
      if (!(ys >= 0)) ys = 0;
      else if (ys > maxY) ys = maxY;
      const x0 = xs | 0;
      const y0 = ys | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const wx = ((xs - x0) * 256) | 0;
      const wy = ((ys - y0) * 256) | 0;
      const iwx = 256 - wx;
      const iwy = 256 - wy;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = src[a + ch]! * iwx + src[b + ch]! * wx;
        const bot = src[c + ch]! * iwx + src[d + ch]! * wx;
        dst[o + ch] = (top * iwy + bot * wy + 32768) >> 16;
      }
    }
  }
  return out;
}

/** Whole-image warp: the reference the tile-wise result is compared with. */
export function warpWhole(src: Raster, Hds: Mat3, outW: number, outH: number): Raster {
  return warpTile(src, Hds, outW, outH);
}
