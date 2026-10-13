// Image header readers (design 2.9, plan.md finding 2). No pixel decoding.
//  - JPEG: segment walk to SOS with NO size cap (EXIF orientation + SOF dimensions)
//  - PNG IHDR, WebP VP8 / VP8L / VP8X, HEIC / AVIF `ispe` (+ `irot`)
// Readers work on a ByteSource so a 100 MB file is never loaded just to learn its size.
import type { ImageInfo } from '../app/decode.ts';
import type { ExifOrientation } from '../storage/schema.ts';

export { injectJpegOrientation as injectOrientation } from '../app/decode-caps.ts';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'unknown';

export interface ImageHeader {
  format: ImageFormat;
  /** STORED (un-rotated) dimensions for JPEG. For HEIC/AVIF the `irot` rotation is already applied. null = unknown. */
  width: number | null;
  height: number | null;
  /** EXIF orientation of a JPEG; 1 for every other format and when absent. */
  orientation: ExifOrientation;
}

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(Math.max(0, offset), Math.min(bytes.length, Math.max(0, offset) + length));
    },
  };
}

const PAGE = 64 * 1024;
const MAX_CACHED_PAGES = 64;

/** Reads a Blob in 64 KB pages (cached), so walking many small segments does not mean many tiny reads. */
export function blobSource(blob: Blob): ByteSource {
  const pages = new Map<number, Uint8Array>();
  const page = async (n: number): Promise<Uint8Array> => {
    const hit = pages.get(n);
    if (hit) return hit;
    if (pages.size >= MAX_CACHED_PAGES) pages.clear();
    const data = new Uint8Array(await blob.slice(n * PAGE, (n + 1) * PAGE).arrayBuffer());
    pages.set(n, data);
    return data;
  };
  return {
    size: blob.size,
    async read(offset, length) {
      const start = Math.max(0, offset);
      const end = Math.min(blob.size, start + length);
      if (end <= start) return new Uint8Array(0);
      if (length > 4 * PAGE) return new Uint8Array(await blob.slice(start, end).arrayBuffer());
      const out = new Uint8Array(end - start);
      for (let p = Math.floor(start / PAGE); p * PAGE < end; p++) {
        const data = await page(p);
        const from = Math.max(start, p * PAGE);
        const to = Math.min(end, p * PAGE + data.length);
        if (to > from) out.set(data.subarray(from - p * PAGE, to - p * PAGE), from - start);
      }
      return out;
    },
  };
}

const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number): number => (((b[o] ?? 0) * 2 ** 24) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0)) >>> 0;
const u32le = (b: Uint8Array, o: number): number => (u16le(b, o) + u16le(b, o + 2) * 65536) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...Array.from(b.subarray(o, o + n)));

// ---- EXIF ----

/** Orientation tag from a TIFF structure (starting at the "II"/"MM" byte-order mark), or null. */
export function parseExifOrientation(tiff: Uint8Array): ExifOrientation | null {
  if (tiff.length < 14) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const r16 = (o: number): number => (little ? u16le(tiff, o) : u16be(tiff, o));
  const r32 = (o: number): number => (little ? u32le(tiff, o) : u32be(tiff, o));
  if (r16(2) !== 42) return null;
  const ifd = r32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return null;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? (v as ExifOrientation) : null;
    }
  }
  return null;
}

// ---- JPEG ----

const MAX_JPEG_SEGMENTS = 4096;
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

async function readJpeg(src: ByteSource): Promise<ImageHeader> {
  const out: ImageHeader = { format: 'jpeg', width: null, height: null, orientation: 1 };
  let pos = 2;
  for (let n = 0; n < MAX_JPEG_SEGMENTS && pos + 2 <= src.size; n++) {
    const head = await src.read(pos, 4);
    if (head[0] !== 0xff) break; // lost sync: keep what we have
    const marker = head[1] ?? 0;
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan: nothing more to learn
    if (head.length < 4) break;
    const length = u16be(head, 2);
    if (length < 2) break;
    if (isSof(marker)) {
      const sof = await src.read(pos + 4, 5);
      if (sof.length >= 5) {
        out.height = u16be(sof, 1);
        out.width = u16be(sof, 3);
      }
    } else if (marker === 0xe1 && length >= 10 && out.orientation === 1) {
      const body = await src.read(pos + 4, Math.min(length - 2, 65533));
      if (ascii(body, 0, 4) === 'Exif' && body[4] === 0 && body[5] === 0) {
        out.orientation = parseExifOrientation(body.subarray(6)) ?? 1;
      }
    }
    pos += 2 + length;
  }
  if (out.width === 0 || out.height === 0) {
    out.width = null;
    out.height = null;
  }
  return out;
}

// ---- PNG ----

async function readPng(src: ByteSource): Promise<ImageHeader> {
  const b = await src.read(0, 24);
  const ok = b.length >= 24 && ascii(b, 12, 4) === 'IHDR';
  const w = ok ? u32be(b, 16) : 0;
  const h = ok ? u32be(b, 20) : 0;
  return { format: 'png', width: w > 0 ? w : null, height: h > 0 ? h : null, orientation: 1 };
}

// ---- WebP ----

async function readWebp(src: ByteSource): Promise<ImageHeader> {
  const b = await src.read(0, 40);
  const out: ImageHeader = { format: 'webp', width: null, height: null, orientation: 1 };
  const chunk = ascii(b, 12, 4);
  let w = 0;
  let h = 0;
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    w = u16le(b, 26) & 0x3fff;
    h = u16le(b, 28) & 0x3fff;
  } else if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = u32le(b, 21);
    w = (bits & 0x3fff) + 1;
    h = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X' && b.length >= 30) {
    w = u24le(b, 24) + 1;
    h = u24le(b, 27) + 1;
  }
  if (w > 0 && h > 0) {
    out.width = w;
    out.height = h;
  }
  return out;
}

// ---- HEIC / AVIF (ISO base media file format) ----

const META_CAP = 8 * 1024 * 1024;
const MAX_TOP_BOXES = 256;

interface Box {
  type: string;
  /** Body start / end (exclusive) within the buffer. */
  start: number;
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos + 8 <= to) {
    let size = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return;
      size = u32be(b, pos + 8) * 2 ** 32 + u32be(b, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || pos + size > to) size = to - pos; // truncated buffer: clamp
    if (size < header) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function findBox(b: Uint8Array, from: number, to: number, type: string): Box | null {
  for (const box of boxes(b, from, to)) if (box.type === type) return box;
  return null;
}

/** Largest `ispe` (the full image, not a thumbnail or grid tile) and the first `irot` inside a `meta` body. */
function parseMeta(b: Uint8Array, start: number, end: number): { w: number; h: number; rotated: boolean } | null {
  const iprp = findBox(b, start + 4, end, 'iprp'); // meta is a full box: skip version/flags
  if (!iprp) return null;
  const ipco = findBox(b, iprp.start, iprp.end, 'ipco');
  if (!ipco) return null;
  let best: { w: number; h: number } | null = null;
  let rotated = false;
  let sawRot = false;
  for (const box of boxes(b, ipco.start, ipco.end)) {
    if (box.type === 'ispe' && box.end - box.start >= 12) {
      const w = u32be(b, box.start + 4);
      const h = u32be(b, box.start + 8);
      if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w, h };
    } else if (box.type === 'irot' && !sawRot && box.end - box.start >= 1) {
      sawRot = true;
      rotated = ((b[box.start] ?? 0) & 3) % 2 === 1;
    }
  }
  return best ? { ...best, rotated } : null;
}

async function readIso(src: ByteSource): Promise<ImageHeader> {
  const head = await src.read(0, 64);
  let format: ImageFormat = 'heic';
  const ftyp = findBox(head, 0, head.length, 'ftyp');
  if (ftyp) {
    const brands = [ascii(head, ftyp.start, 4)];
    for (let o = ftyp.start + 8; o + 4 <= Math.min(ftyp.end, head.length); o += 4) brands.push(ascii(head, o, 4));
    if (brands.includes('avif') || brands.includes('avis')) format = 'avif';
  }
  const out: ImageHeader = { format, width: null, height: null, orientation: 1 };
  let pos = 0;
  for (let n = 0; n < MAX_TOP_BOXES && pos + 8 <= src.size; n++) {
    const h = await src.read(pos, 16);
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    if (size === 1) size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
    else if (size === 0) size = src.size - pos;
    if (size < 8) break;
    if (type === 'meta') {
      const body = await src.read(pos, Math.min(size, META_CAP));
      const dims = parseMeta(body, 8, body.length);
      if (dims) {
        out.width = dims.rotated ? dims.h : dims.w;
        out.height = dims.rotated ? dims.w : dims.h;
      }
      break;
    }
    pos += size;
  }
  return out;
}

// ---- Entry point ----

/** Detects the format by signature (never by file name or MIME) and reads dimensions and orientation. */
export async function readImageHeader(src: ByteSource): Promise<ImageHeader> {
  const sig = await src.read(0, 16);
  const unknown: ImageHeader = { format: 'unknown', width: null, height: null, orientation: 1 };
  if (sig.length < 12) return unknown;
  if (sig[0] === 0xff && sig[1] === 0xd8) return readJpeg(src);
  if (sig[0] === 0x89 && ascii(sig, 1, 3) === 'PNG') return readPng(src);
  if (ascii(sig, 0, 4) === 'RIFF' && ascii(sig, 8, 4) === 'WEBP') return readWebp(src);
  if (ascii(sig, 4, 4) === 'ftyp') return readIso(src);
  return unknown;
}

export function readBlobHeader(blob: Blob): Promise<ImageHeader> {
  return readImageHeader(blobSource(blob));
}

/** Stored dimensions to oriented dimensions (EXIF orientations 5 to 8 swap the axes). */
export function orientedDims(width: number, height: number, orientation: number): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/** ImageInfo for decodeRaw from a shot record (record width/height are ORIENTED; the decoder wants STORED). */
export function shotImageInfo(shot: { width: number; height: number; originalExifOrientation: number }): ImageInfo {
  const stored = orientedDims(shot.width, shot.height, shot.originalExifOrientation); // swapping is its own inverse
  return { width: stored.width, height: stored.height, orientation: shot.originalExifOrientation };
}
