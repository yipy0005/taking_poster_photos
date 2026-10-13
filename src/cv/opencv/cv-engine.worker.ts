// OpenCV engine worker (design 2.8). Same RPC protocol as the JS engine. Loads the self-hosted opencv.js lazily during `init`.
// Reuses render-core with an OpenCV TileWarper. Memory failures surface as OutOfMemoryError, per-input cv exceptions as CvError.
import { setDecodeCaps } from '../../app/decode.ts';
import { CvError } from '../../app/errors.ts';
import { fromRasterPayload, type DetectResult, type InitPayload, type InitResult, type RasterPayload, type RenderRequest, type RenderResult } from '../protocol.ts';
import { canvasRenderIO, renderCore, type RenderEnv } from '../render-core.ts';
import { abortError, serveRpc, Transferred } from '../rpc.ts';
import { toEngineError } from './cv-errors.ts';
import { loadCv, readHeapBytes, type CvApi } from './cv-loader.ts';
import { detectCv } from './detect-cv.ts';
import { createCvWarper } from './warp-cv.ts';

let cv: CvApi | null = null;
let env: RenderEnv | null = null;

serveRpc(self, {
  async init(payload: InitPayload): Promise<InitResult> {
    setDecodeCaps(payload.decodeCaps);
    env = { maxOutputPixels: payload.maxOutputPixels, roiBudget: payload.roiBudget };
    if (!payload.cvUrl) throw new CvError('No OpenCV URL was provided');
    cv = await loadCv(payload.cvUrl, {
      importScript: (url) => import(/* @vite-ignore */ url),
      getGlobal: () => (globalThis as unknown as { cv?: unknown }).cv,
    });
    return { heapBytes: readHeapBytes(cv) || undefined };
  },
  detect(payload: RasterPayload, ctx): DetectResult {
    if (!cv) throw new CvError('OpenCV was not initialised');
    if (ctx.signal.aborted) throw abortError();
    try {
      const res = detectCv(cv, fromRasterPayload(payload));
      return { ...res, heapBytes: readHeapBytes(cv) || undefined };
    } catch (e) {
      throw toEngineError(cv, e);
    }
  },
  async render(req: RenderRequest, ctx): Promise<Transferred> {
    if (!cv || !env) throw new CvError('OpenCV was not initialised');
    try {
      const result: RenderResult = await renderCore(req, {
        io: canvasRenderIO,
        warper: createCvWarper(cv),
        env,
        engine: 'opencv',
        signal: ctx.signal,
        onProgress: ctx.progress,
      });
      return new Transferred({ ...result, heapBytes: readHeapBytes(cv) || undefined }, []);
    } catch (e) {
      throw toEngineError(cv, e);
    }
  },
});
