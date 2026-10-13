// Pure-TS engine worker (design 2.8). Handles init / detect / render over the RPC of cv/rpc.ts.
import { setDecodeCaps } from '../../app/decode.ts';
import { abortError, serveRpc, Transferred } from '../rpc.ts';
import { fromRasterPayload, type DetectResult, type InitPayload, type InitResult, type RasterPayload, type RenderRequest, type RenderResult } from '../protocol.ts';
import { canvasRenderIO, renderCore, type RenderEnv, type TileWarper } from '../render-core.ts';
import { detectJs } from './detect-js.ts';
import { warpTile } from './warp-js.ts';

const warper: TileWarper = { warp: (roi, H, w, h) => warpTile(roi, H, w, h) };
let env: RenderEnv | null = null;

serveRpc(self, {
  init(payload: InitPayload): InitResult {
    setDecodeCaps(payload.decodeCaps);
    env = { maxOutputPixels: payload.maxOutputPixels, roiBudget: payload.roiBudget };
    return {};
  },
  detect(payload: RasterPayload, ctx): DetectResult {
    if (ctx.signal.aborted) throw abortError();
    return detectJs(fromRasterPayload(payload));
  },
  async render(req: RenderRequest, ctx): Promise<Transferred> {
    if (!env) throw new Error('JS engine was not initialised');
    const result: RenderResult = await renderCore(req, {
      io: canvasRenderIO,
      warper,
      env,
      engine: 'js',
      signal: ctx.signal,
      onProgress: ctx.progress,
    });
    return new Transferred(result, []);
  },
});
