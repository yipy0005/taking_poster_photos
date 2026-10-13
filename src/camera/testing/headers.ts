// Test support (not imported by app code): synthetic image headers. Only the parts the header readers look at are real.
const bytes = (...parts: Array<number[] | Uint8Array>): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const text = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

export interface JpegOpts {
  w: number;
  h: number;
  orientation?: number;
  /** Number of filler APP2 bytes placed BEFORE the SOF segment (to push it beyond 64 KB). */
  paddingBytes?: number;
  /** Put the EXIF segment after the padding. */
  exifAfterPadding?: boolean;
  littleEndianExif?: boolean;
}

function exifSegment(orientation: number, little: boolean): number[] {
  const u16 = little ? le16 : be16;
  const u32 = little ? le32 : be32;
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(2), ...u16(0x011a), ...u16(5), ...u32(1), ...u32(0), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const body = [...text('Exif'), 0, 0, ...tiff];
  return [0xff, 0xe1, ...be16(body.length + 2), ...body];
}

/** SOI, optional EXIF and padding, SOF0, SOS, a few scan bytes, EOI. */
export function jpegBytes(o: JpegOpts): Uint8Array<ArrayBuffer> {
  const exif = o.orientation !== undefined ? exifSegment(o.orientation, o.littleEndianExif === true) : [];
  const pad: number[] = [];
  let left = o.paddingBytes ?? 0;
  while (left > 0) {
    const chunk = Math.min(left, 60000);
    pad.push(0xff, 0xe2, ...be16(chunk + 2), ...new Array<number>(chunk).fill(0x41));
    left -= chunk;
  }
  const sof = [0xff, 0xc0, ...be16(17), 8, ...be16(o.h), ...be16(o.w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const sos = [0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0];
  return bytes([0xff, 0xd8], o.exifAfterPadding ? pad : exif, o.exifAfterPadding ? exif : pad, sof, sos, [1, 2, 3, 4], [0xff, 0xd9]);
}

export function pngBytes(w: number, h: number): Uint8Array<ArrayBuffer> {
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), text('IHDR'), be32(w), be32(h), [8, 6, 0, 0, 0], be32(0));
}

export function webpBytes(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Uint8Array<ArrayBuffer> {
  let chunk: number[];
  if (kind === 'VP8 ') {
    chunk = [...text('VP8 '), ...le32(10), 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)];
  } else if (kind === 'VP8L') {
    const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
    chunk = [...text('VP8L'), ...le32(5), 0x2f, ...le32(bits >>> 0)];
  } else {
    const l24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
    chunk = [...text('VP8X'), ...le32(10), 0, 0, 0, 0, ...l24(w - 1), ...l24(h - 1)];
  }
  return bytes(text('RIFF'), le32(4 + chunk.length), text('WEBP'), chunk);
}

const box = (type: string, ...body: Array<number[] | Uint8Array>): Uint8Array<ArrayBuffer> => {
  const inner = bytes(...body);
  return bytes(be32(8 + inner.length), text(type), inner);
};
const fullBox = (type: string, ...body: Array<number[] | Uint8Array>): Uint8Array<ArrayBuffer> => box(type, [0, 0, 0, 0], ...body);

export interface IsoOpts {
  w: number;
  h: number;
  brand?: 'heic' | 'avif';
  /** irot angle (quarter turns). */
  rot?: number;
  /** Extra smaller `ispe` entries (thumbnail, grid tile) placed BEFORE the main one. */
  decoys?: Array<[number, number]>;
  /** Bytes of filler `free` box before `meta`. */
  paddingBytes?: number;
}

/** ftyp + (free) + meta{iprp{ipco{ispe..., irot}}} + mdat. */
export function isoBytes(o: IsoOpts): Uint8Array<ArrayBuffer> {
  const brand = o.brand ?? 'heic';
  const ispe = (w: number, h: number): Uint8Array<ArrayBuffer> => fullBox('ispe', be32(w), be32(h));
  const props: Uint8Array[] = [...(o.decoys ?? []).map(([w, h]) => ispe(w, h)), ispe(o.w, o.h)];
  if (o.rot !== undefined) props.push(box('irot', [o.rot & 3]));
  const ipco = box('ipco', ...props);
  const meta = fullBox('meta', box('iprp', ipco));
  const ftyp = box('ftyp', text(brand), be32(0), text(brand === 'avif' ? 'mif1' : 'mif1'), text(brand));
  const free = o.paddingBytes ? box('free', new Uint8Array(o.paddingBytes)) : new Uint8Array(0);
  return bytes(ftyp, free, meta, box('mdat', [1, 2, 3]));
}

export const blobOf = (data: Uint8Array<ArrayBuffer>, type: string): Blob => new Blob([data], { type });
