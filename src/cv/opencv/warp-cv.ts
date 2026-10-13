// OpenCV tile warp (design 2.8 "Half-pixel conjugation for OpenCV"). DOM-free.
// Htile is defined in pixel-EDGE coordinates (destination pixel (i, j) has its centre at (i + 0.5, j + 0.5), the source is
// sampled at H * centre - 0.5). OpenCV treats integer coordinates as pixel centres, so the matrix handed to warpPerspective is
//   M_cv = T(-0.5, -0.5) * Htile * T(+0.5, +0.5)
// with WARP_INVERSE_MAP (Htile is destination-to-source).
import type { Mat3, Raster } from '../geometry.ts';
import { mul, translation } from '../homography.ts';
import { createRaster } from '../raster2d.ts';
import type { TileWarper } from '../render-core.ts';
import type { CvApi } from './cv-loader.ts';

export function cvMatrix(H: Mat3): Mat3 {
  return mul(mul(translation(-0.5, -0.5), H), translation(0.5, 0.5));
}

/** Warps `roi` into a tileW x tileH raster. Every Mat is deleted in `finally`. */
export function warpTileCv(cv: CvApi, roi: Raster, H: Mat3, tileW: number, tileH: number): Raster {
  if (roi.width === 0 || roi.height === 0) return createRaster(tileW, tileH);
  const mats: Array<{ delete(): void }> = [];
  try {
    const src = new cv.Mat(roi.height, roi.width, cv.CV_8UC4);
    mats.push(src);
    src.data.set(roi.data);
    const dst = new cv.Mat();
    mats.push(dst);
    const m = cv.matFromArray(3, 3, cv.CV_64F, Array.from(cvMatrix(H)));
    mats.push(m);
    cv.warpPerspective(src, dst, m, new cv.Size(tileW, tileH), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE, new cv.Scalar());
    // copy out of the WASM heap before the Mat is freed
    return { width: tileW, height: tileH, data: new Uint8ClampedArray(dst.data) };
  } finally {
    for (const mat of mats) mat.delete();
  }
}

export const createCvWarper = (cv: CvApi): TileWarper => ({
  warp: (roi, H, w, h) => warpTileCv(cv, roi, H, w, h),
});
