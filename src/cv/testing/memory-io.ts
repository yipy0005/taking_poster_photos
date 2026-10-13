// Test support (not imported by app code): in-memory RenderIO so render-core runs on Node with plain Rasters.
import type { ImageInfo } from '../../app/decode.ts';
import type { Raster } from '../geometry.ts';
import { createRaster, type SourceImage, type Surface2D } from '../raster2d.ts';
import type { OpenedSource, RenderIO } from '../render-core.ts';

/** Area-average resample of a sub-rectangle to rw x rh (exact crop when the sizes match). */
export function boxResample(src: Raster, sx: number, sy: number, sw: number, sh: number, rw: number, rh: number): Raster {
  const out = createRaster(rw, rh);
  for (let y = 0; y < rh; y++) {
    const y0 = sy + Math.floor((y * sh) / rh);
    const y1 = Math.max(y0 + 1, sy + Math.floor(((y + 1) * sh) / rh));
    for (let x = 0; x < rw; x++) {
      const x0 = sx + Math.floor((x * sw) / rw);
      const x1 = Math.max(x0 + 1, sx + Math.floor(((x + 1) * sw) / rw));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c]! += src.data[i + c]!;
          n++;
        }
      }
      const o = (y * rw + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = Math.round(acc[c]! / n);
    }
  }
  return out;
}

export class RasterSource implements SourceImage {
  released = false;
  reads: Array<{ rw: number; rh: number; sw: number; sh: number }> = [];
  reserved = { w: 0, h: 0 };
  constructor(readonly raster: Raster) {}
  get width(): number {
    return this.raster.width;
  }
  get height(): number {
    return this.raster.height;
  }
  reserve(w: number, h: number): void {
    this.reserved = { w: Math.max(this.reserved.w, w), h: Math.max(this.reserved.h, h) };
  }
  readRegion(sx: number, sy: number, sw: number, sh: number, rw: number, rh: number): Raster {
    if (this.released) throw new Error('RasterSource released');
    this.reads.push({ rw, rh, sw, sh });
    return boxResample(this.raster, sx, sy, sw, sh, rw, rh);
  }
  release(): void {
    this.released = true;
  }
}

export class MemorySurface implements Surface2D {
  released = false;
  readonly raster: Raster;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.raster = createRaster(width, height);
  }
  putRaster(r: Raster, x: number, y: number): void {
    if (this.released) throw new Error('MemorySurface released');
    for (let j = 0; j < r.height; j++) {
      this.raster.data.set(r.data.subarray(j * r.width * 4, (j + 1) * r.width * 4), ((y + j) * this.width + x) * 4);
    }
  }
  async encode(mime: 'image/jpeg' | 'image/png', _quality: number): Promise<Blob> {
    return new Blob([this.raster.data], { type: mime });
  }
  release(): void {
    this.released = true;
  }
}

export interface MemoryIO extends RenderIO {
  sources: RasterSource[];
  surfaces: MemorySurface[];
  yields: number;
  opened: Array<{ maxPixels?: number; info: ImageInfo }>;
}

/** Serves `image` as the decoded original; honours maxPixels by box-downscaling (a "reduced decode"). */
export function createMemoryIO(image: Raster, hooks: { onYield?: (n: number) => void | Promise<void> } = {}): MemoryIO {
  const io: MemoryIO = {
    sources: [],
    surfaces: [],
    yields: 0,
    opened: [],
    async open(_blob, opts): Promise<OpenedSource> {
      io.opened.push(opts);
      let raster = image;
      let reduced = false;
      if (opts.maxPixels !== undefined && image.width * image.height > opts.maxPixels) {
        const s = Math.sqrt(opts.maxPixels / (image.width * image.height));
        const w = Math.max(1, Math.floor(image.width * s));
        const h = Math.max(1, Math.floor(image.height * s));
        raster = boxResample(image, 0, 0, image.width, image.height, w, h);
        reduced = true;
      }
      const source = new RasterSource(raster);
      io.sources.push(source);
      return { source, scaleX: raster.width / image.width, scaleY: raster.height / image.height, reduced };
    },
    createSurface(w, h) {
      const s = new MemorySurface(w, h);
      io.surfaces.push(s);
      return s;
    },
    async yieldNow() {
      io.yields++;
      await hooks.onYield?.(io.yields);
    },
  };
  return io;
}
