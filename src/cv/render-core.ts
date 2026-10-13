// Engine-independent render pipeline (design 2.6): decode once, plan tiles against the ROI budget, read each ROI (with
// anti-alias reduction), warp it with the supplied TileWarper, apply enhancements, assemble and encode. It NEVER computes
// outW/outH (output-size.ts does) and only asserts W*H <= cap. DOM-free; talks to canvases only through RenderIO.
import { decodeRaw, type ImageInfo } from '../app/decode.ts';
import { BitmapSource, OffscreenSurface, cropRaster, type SourceImage, type Surface2D } from './raster2d.ts';
import { applyLuts, computeLuts, hasLutEnhancement, unsharp, type Luts } from './enhance.ts';
import { scaleQuad, type Mat3, type Quad, type Raster } from './geometry.ts';
import { quadHomography, reducedRoiHomography, tileHomography } from './homography.ts';
import { abortError } from './rpc.ts';
import type { RenderRequest, RenderResult } from './protocol.ts';
import { HALO_OUT_SHARPEN, planTiles, roiForRect } from './tile-plan.ts';

/** Warps one ROI raster into a tile. `H` maps tile-local output coordinates to ROI-local source coordinates. */
export interface TileWarper {
  warp(roi: Raster, H: Mat3, tileW: number, tileH: number): Raster | Promise<Raster>;
}
export interface OpenedSource {
  source: SourceImage;
  /** decoded size / oriented original size, per axis (1 = full resolution). */
  scaleX: number;
  scaleY: number;
  reduced: boolean;
}
export interface RenderIO {
  open(blob: Blob, opts: { maxPixels?: number; info: ImageInfo }): Promise<OpenedSource>;
  createSurface(w: number, h: number): Surface2D;
  /** Gives the event loop a turn (so `cancel` messages are delivered between tiles). */
  yieldNow(): Promise<void>;
}
export interface RenderEnv {
  maxOutputPixels: number;
  roiBudget: number;
}
export interface RenderDeps {
  io: RenderIO;
  warper: TileWarper;
  env: RenderEnv;
  engine: 'js' | 'opencv';
  signal?: AbortSignal;
  onProgress?(p: number): void;
}

/** Production IO: decodeRaw (the only decoder), OffscreenCanvas surfaces. */
export const canvasRenderIO: RenderIO = {
  async open(blob, opts) {
    const d = await decodeRaw(blob, { maxPixels: opts.maxPixels, info: opts.info, label: 'render' });
    return {
      source: new BitmapSource(d.handle),
      scaleX: d.width / d.sourceWidth,
      scaleY: d.height / d.sourceHeight,
      reduced: d.reduced,
    };
  },
  createSurface: (w, h) => new OffscreenSurface(w, h),
  yieldNow: () => new Promise<void>((r) => setTimeout(r, 0)),
};

const SAMPLE_EDGE = 512;

/** Global LUT parameters from a small rectified sample (long edge 512) of the poster. */
async function sampleLuts(source: SourceImage, quad: Quad, outW: number, outH: number, req: RenderRequest, warper: TileWarper): Promise<Luts | null> {
  const s = Math.min(1, SAMPLE_EDGE / Math.max(outW, outH));
  const pw = Math.max(1, Math.round(outW * s));
  const ph = Math.max(1, Math.round(outH * s));
  const Hs = quadHomography(quad, pw, ph);
  const roi = roiForRect(Hs, 0, 0, pw, ph, source.width, source.height);
  const region = source.readRegion(roi.sx, roi.sy, roi.sw, roi.sh, roi.rw, roi.rh);
  let H = tileHomography(Hs, roi.sx, roi.sy, 0, 0);
  if (roi.rw !== roi.sw || roi.rh !== roi.sh) H = reducedRoiHomography(H, roi.sw, roi.sh, roi.rw, roi.rh);
  const sample = await warper.warp(region, H, pw, ph);
  return computeLuts(sample, req.enhance);
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

export async function renderCore(req: RenderRequest, deps: RenderDeps): Promise<RenderResult> {
  const { io, warper, env, signal, onProgress } = deps;
  const { outW, outH } = req;
  if (!(outW >= 1 && outH >= 1) || outW * outH > env.maxOutputPixels) {
    // programmer error: output-size.ts guarantees W*H <= cap for validated inputs
    throw new Error(`Output ${outW}x${outH} exceeds the pixel cap ${env.maxOutputPixels}`);
  }
  throwIfAborted(signal);
  const opened = await io.open(req.original, { maxPixels: req.sourceMaxPixels, info: req.info });
  const { source } = opened;
  let surface: Surface2D | null = null;
  try {
    throwIfAborted(signal);
    const quad = opened.reduced ? scaleQuad(req.quad, opened.scaleX, opened.scaleY) : req.quad;
    const Hds = quadHomography(quad, outW, outH);
    const halo = req.enhance.sharpen ? HALO_OUT_SHARPEN : 0;
    const plan = planTiles(Hds, outW, outH, source.width, source.height, env.roiBudget, halo);
    source.reserve(plan.envW, plan.envH);
    const luts = hasLutEnhancement(req.enhance) ? await sampleLuts(source, quad, outW, outH, req, warper) : null;
    surface = io.createSurface(outW, outH);
    const total = outW * outH;
    let done = 0;
    onProgress?.(0);
    for (const t of plan.tiles) {
      throwIfAborted(signal);
      const roi = source.readRegion(t.sx, t.sy, t.sw, t.sh, t.rw, t.rh);
      let H = tileHomography(Hds, t.sx, t.sy, t.hx0, t.hy0);
      if (t.rw !== t.sw || t.rh !== t.sh) H = reducedRoiHomography(H, t.sw, t.sh, t.rw, t.rh);
      let out = await warper.warp(roi, H, t.hx1 - t.hx0, t.hy1 - t.hy0);
      if (luts) applyLuts(out, luts);
      if (req.enhance.sharpen) unsharp(out);
      if (t.hx0 !== t.x0 || t.hy0 !== t.y0 || t.hx1 !== t.x1 || t.hy1 !== t.y1) {
        out = cropRaster(out, t.x0 - t.hx0, t.y0 - t.hy0, t.x1 - t.x0, t.y1 - t.y0);
      }
      surface.putRaster(out, t.x0, t.y0);
      done += (t.x1 - t.x0) * (t.y1 - t.y0);
      onProgress?.(done / total);
      await io.yieldNow();
    }
    throwIfAborted(signal);
    const blob = await surface.encode(req.mime, req.quality);
    return { blob, width: outW, height: outH, reducedSource: opened.reduced, engine: deps.engine };
  } finally {
    surface?.release();
    source.release();
  }
}
