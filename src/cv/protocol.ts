// Engine contract and worker message types (design 2.8). DOM-free: imported by workers and the main thread.
import type { DecodeCaps, ImageInfo } from '../app/decode.ts';
import type { EnhanceFlags } from './enhance.ts';
import type { Quad, Raster } from './geometry.ts';

/** Message ids are unique per client; replies echo the id. */
export type RequestType = 'init' | 'detect' | 'render' | 'cancel';
export interface RpcRequest<P = unknown> {
  id: number;
  type: RequestType;
  payload: P;
}
export type ReplyType = 'result' | 'progress' | 'error';
export interface SerializedError {
  name: string;
  message: string;
}
export interface RpcReply<P = unknown> {
  id: number;
  type: ReplyType;
  payload?: P;
  error?: SerializedError;
}

/** Platform constants workers cannot compute themselves (config.ts / canvas-limits.ts are main-thread). */
export interface InitPayload {
  isIosWebKit: boolean;
  maxOutputPixels: number;
  maxDecodePixels: number;
  roiBudget: number;
  decodeCaps: DecodeCaps;
  /** OpenCV engine only: absolute URL of the self-hosted opencv.js. */
  cvUrl?: string;
}
export interface InitResult {
  /** OpenCV only: WASM heap size after initialisation. */
  heapBytes?: number;
}

/** Wire form of a Raster (the buffer is transferred). */
export interface RasterPayload {
  width: number;
  height: number;
  data: ArrayBuffer;
}
export const toRasterPayload = (r: Raster): RasterPayload => ({ width: r.width, height: r.height, data: r.data.buffer });
export const fromRasterPayload = (p: RasterPayload): Raster => ({ width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) });

/** confidence = areaFraction * solidity, defined identically for both engines. */
export interface DetectResult {
  quad: Quad | null;
  confidence: number;
  method: string;
  /** OpenCV only: WASM heap size after the job, when the module exposes it. */
  heapBytes?: number;
}

/** Note: no aspect field. Sizes are decided on the main thread (output-size.ts), never inside an engine. */
export interface RenderRequest {
  original: Blob;
  /** Quad in oriented-original pixels. */
  quad: Quad;
  outW: number;
  outH: number;
  enhance: EnhanceFlags;
  mime: 'image/jpeg' | 'image/png';
  quality: number;
  /** Decode bound chosen by engine-client (design 2.7 item 8). */
  sourceMaxPixels?: number;
  /** Stored dimensions and EXIF orientation from the file header (camera/exif.ts). Needed to scale the quad when the decode is reduced. */
  info: ImageInfo;
}
export interface RenderResult {
  blob: Blob;
  width: number;
  height: number;
  reducedSource: boolean;
  engine: 'opencv' | 'js';
  heapBytes?: number;
}

export interface EngineCallOpts {
  signal?: AbortSignal;
}
export interface RenderCallOpts extends EngineCallOpts {
  onProgress?(p: number): void;
}
export interface Engine {
  readonly id: 'opencv' | 'js';
  /** Detect the poster outline in a *downscaled* image (long edge <= 1600). Coordinates are in that image. */
  detect(img: Raster, opts?: EngineCallOpts): Promise<DetectResult>;
  /** Decode `original`, rectify to exactly outW x outH, return an encoded blob. */
  render(req: RenderRequest, opts?: RenderCallOpts): Promise<RenderResult>;
  dispose(): void;
}
