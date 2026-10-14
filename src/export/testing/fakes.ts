// Test support (not imported by app code): export dependencies with spies, and shot records.
import type { DecodeResult } from '../../app/decode.ts';
import type { GuardCtx, GuardedOpts } from '../../app/decode-guarded.ts';
import type { Rotation } from '../../cv/geometry.ts';
import type { BlobKind, ShotRecord } from '../../storage/schema.ts';
import { fakeResult } from '../../viewer/testing/fakes.ts';
import type { ExportDeps, ExportMime } from '../render-export.ts';

export function makeShot(over: Partial<ShotRecord> = {}): ShotRecord {
  return {
    id: 'shot-1',
    posterId: 'poster-1',
    kind: 'overview',
    createdAt: 1,
    updatedAt: 1,
    source: 'file-gallery',
    width: 4000,
    height: 3000,
    originalMime: 'image/jpeg',
    originalBytes: 1000,
    normalized: false,
    originalExifOrientation: 1,
    status: 'rectified',
    corners: [
      [300, 200],
      [3700, 220],
      [3650, 2800],
      [280, 2780],
    ],
    cornersSource: 'auto-js',
    aspectMode: 'auto',
    aspectUsed: null,
    snappedTo: null,
    enhance: { autoContrast: false, whiteBalance: false, sharpen: false, brighten: false },
    rotation: 0,
    rectifiedWidth: 3000,
    rectifiedHeight: 2000,
    schema: 1,
    ...over,
  };
}

export interface DecodeCall {
  blob: Blob;
  opts: GuardedOpts;
  ctx: GuardCtx;
}
export interface RotateCall {
  bitmap: ImageBitmap;
  rotation: Rotation;
  mime: ExportMime;
  quality: number;
}

export interface FakeDepsOptions {
  blobs?: Partial<Record<BlobKind, Blob>>;
  /** Size the fake decoder returns (oriented). Default: the info's oriented size. */
  decodeSize?: { w: number; h: number; reduced?: boolean };
  maxPixels?: number;
  /** Bytes produced by rotateEncode. */
  encoded?: Uint8Array<ArrayBuffer>;
}

export function makeDeps(o: FakeDepsOptions = {}) {
  const decodeCalls: DecodeCall[] = [];
  const rotateCalls: RotateCall[] = [];
  const results: DecodeResult[] = [];
  const deps: ExportDeps = {
    getBlob: async (_id, kind) => o.blobs?.[kind] ?? null,
    decode: async (blob, opts, ctx) => {
      decodeCalls.push({ blob, opts, ctx });
      const info = opts.info;
      const swap = info && info.orientation >= 5;
      const srcW = info ? (swap ? info.height : info.width) : 100;
      const srcH = info ? (swap ? info.width : info.height) : 100;
      const w = o.decodeSize?.w ?? srcW;
      const h = o.decodeSize?.h ?? srcH;
      const r = fakeResult(w, h, o.decodeSize?.reduced ? w * 2 : srcW, o.decodeSize?.reduced ? h * 2 : srcH, 'export');
      results.push(r);
      return r;
    },
    rotateEncode: async (bitmap, rotation, mime, quality) => {
      rotateCalls.push({ bitmap, rotation, mime, quality });
      return new Blob([o.encoded ?? new Uint8Array([1, 2, 3])], { type: mime });
    },
    maxPixels: () => o.maxPixels ?? 25_000_000,
  };
  return { deps, decodeCalls, rotateCalls, results };
}

export const blobOf = (bytes: Uint8Array<ArrayBuffer>, type: string): Blob => new Blob([bytes], { type });
