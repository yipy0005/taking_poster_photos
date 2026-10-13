// File names for downloads (design 2.13): `{slug(title)}-{kind}{n}.jpg`, PDFs `title-part-1-of-N.pdf`. Pure.
import type { ShotRecord } from '../storage/schema.ts';

const MAX_SLUG = 40;

/** Lowercase ASCII slug of a title; "poster" when nothing usable is left. */
export function slug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return s === '' ? 'poster' : s;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

export function extensionFor(mime: string): string {
  return EXT[mime.toLowerCase()] ?? 'bin';
}

/** 1-based position of `shot` among the shots of its kind (overview 1, detail 1..n), in poster order. */
export function ordinalOf(shot: Pick<ShotRecord, 'id' | 'kind'>, shots: ReadonlyArray<Pick<ShotRecord, 'id' | 'kind'>>): number {
  let n = 0;
  for (const s of shots) {
    if (s.kind === shot.kind) n++;
    if (s.id === shot.id) return Math.max(1, n);
  }
  return 1;
}

export function exportFilename(posterTitle: string, shot: Pick<ShotRecord, 'id' | 'kind'>, shots: ReadonlyArray<Pick<ShotRecord, 'id' | 'kind'>>, ext: string): string {
  return `${slug(posterTitle)}-${shot.kind}${ordinalOf(shot, shots)}.${ext}`;
}

export function pdfFilename(posterTitle: string, part?: { index: number; total: number }): string {
  if (!part || part.total <= 1) return `${slug(posterTitle)}.pdf`;
  return `${slug(posterTitle)}-part-${part.index}-of-${part.total}.pdf`;
}
