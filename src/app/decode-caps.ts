// One-time createImageBitmap probes (design 2.7 item 5, AC-39). Main thread: the probe images are built with a canvas.
// Results are handed to workers in their `init` message (decode.ts setDecodeCaps).
import { DEFAULT_DECODE_CAPS, decodeCapsKnown, getDecodeCaps, setDecodeCaps, type DecodeCaps } from './decode.ts';
import { log } from './log.ts';

/** Inserts an APP1/EXIF segment carrying only the orientation tag right after SOI. Pure. */
export function injectJpegOrientation(jpeg: Uint8Array, orientation: number): Uint8Array<ArrayBuffer> {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
  const seg = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, // APP1, length 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // TIFF header, big-endian, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00, // Orientation SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

export interface ProbeEnv {
  createBitmap(blob: Blob, opts: ImageBitmapOptions): Promise<ImageBitmap>;
  /** A 64x32 JPEG with a dark marker block in its stored top-left, plus the same image tagged EXIF orientation 6. */
  makeProbes(): Promise<{ plain: Blob; orient6: Blob }>;
  /** True when the dark marker of the orientation-6 probe sits in the bitmap's top-right corner. */
  markerAtTopRight(bmp: ImageBitmap): boolean;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/jpeg', 0.95);
  });
}

function defaultEnv(): ProbeEnv {
  return {
    createBitmap: (blob, opts) => createImageBitmap(blob, opts),
    async makeProbes() {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 64, 32);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 16, 16);
      const plain = await canvasToJpeg(canvas);
      canvas.width = 0;
      canvas.height = 0;
      const bytes = new Uint8Array(await plain.arrayBuffer());
      return { plain, orient6: new Blob([injectJpegOrientation(bytes, 6)], { type: 'image/jpeg' }) };
    },
    markerAtTopRight(bmp) {
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(Math.max(0, bmp.width - 3), 2, 1, 1).data;
        const bl = ctx.getImageData(2, Math.max(0, bmp.height - 3), 1, 1).data;
        // dark at the top-right, light at the bottom-left
        return (px[0] ?? 255) < 100 && (bl[0] ?? 0) > 150;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  };
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Runs every probe in its own try/catch; an exception means "unsupported". */
export async function probeDecodeCaps(env: ProbeEnv = defaultEnv()): Promise<DecodeCaps> {
  let probes: { plain: Blob; orient6: Blob };
  try {
    probes = await env.makeProbes();
  } catch (e) {
    log.warn('decode probes could not be built; using conservative defaults', e);
    return DEFAULT_DECODE_CAPS;
  }
  const { plain, orient6 } = probes;

  const from = await attempt(async () => {
    const b = await env.createBitmap(plain, { imageOrientation: 'from-image' });
    b.close();
    return true;
  });
  const fromImage = from === true;
  const orientOpts: ImageBitmapOptions = fromImage ? { imageOrientation: 'from-image' } : {};

  const exifHonored =
    (await attempt(async () => {
      const b = await env.createBitmap(orient6, orientOpts);
      const ok = b.width === 32 && b.height === 64;
      b.close();
      return ok;
    })) === true;

  const resizeHonored =
    (await attempt(async () => {
      const b = await env.createBitmap(plain, { ...orientOpts, resizeWidth: 32, resizeHeight: 16, resizeQuality: 'high' });
      const ok = b.width === 32 && b.height === 16;
      b.close();
      return ok;
    })) === true;

  let resizeAfterOrient = false;
  if (resizeHonored && (fromImage || exifHonored)) {
    resizeAfterOrient =
      (await attempt(async () => {
        const b = await env.createBitmap(orient6, { ...orientOpts, resizeWidth: 16, resizeHeight: 32, resizeQuality: 'high' });
        let ok = b.width === 16 && b.height === 32;
        if (ok) ok = env.markerAtTopRight(b);
        b.close();
        return ok;
      })) === true;
  }

  const caps: DecodeCaps = { fromImage, exifHonored, resizeHonored, resizeAfterOrient };
  if (!fromImage) log.warnOnce('decode-caps-from-image', 'imageOrientation "from-image" unsupported');
  if (!resizeHonored) log.warnOnce('decode-caps-resize', 'createImageBitmap resize options not honoured; using canvas fallback');
  return caps;
}

let pending: Promise<DecodeCaps> | null = null;

/** Probes once per session (memoised) and publishes the result to decode.ts. */
export function ensureDecodeCaps(env?: ProbeEnv): Promise<DecodeCaps> {
  if (decodeCapsKnown()) return Promise.resolve(getDecodeCaps());
  pending ??= probeDecodeCaps(env).then((caps) => {
    setDecodeCaps(caps);
    return caps;
  });
  return pending;
}

export function resetDecodeCapsProbeForTests(): void {
  pending = null;
}
