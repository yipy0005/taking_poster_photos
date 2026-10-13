import { describe, expect, it, vi } from 'vitest';
import { REVOKE_DELAY_MS, downloadBlob, type DownloadEnv } from './download.ts';
import { exportFilename, extensionFor, ordinalOf, pdfFilename, slug } from './filename.ts';

describe('slug', () => {
  it('lowercases, strips accents and collapses punctuation', () => {
    expect(slug('Résumé of Deep Learning: A Survey!')).toBe('resume-of-deep-learning-a-survey');
  });
  it('falls back to "poster" and limits the length', () => {
    expect(slug('???')).toBe('poster');
    expect(slug('')).toBe('poster');
    expect(slug('a'.repeat(100)).length).toBe(40);
    expect(slug('abc-' + 'x'.repeat(100)).endsWith('-')).toBe(false);
  });
});

describe('export file names', () => {
  const shots = [
    { id: 'o', kind: 'overview' as const },
    { id: 'd1', kind: 'detail' as const },
    { id: 'd2', kind: 'detail' as const },
  ];
  it('numbers shots per kind', () => {
    expect(ordinalOf(shots[0]!, shots)).toBe(1);
    expect(ordinalOf(shots[2]!, shots)).toBe(2);
    expect(exportFilename('My Poster', shots[0]!, shots, 'jpg')).toBe('my-poster-overview1.jpg');
    expect(exportFilename('My Poster', shots[2]!, shots, 'png')).toBe('my-poster-detail2.png');
  });
  it('names PDF parts', () => {
    expect(pdfFilename('My Poster')).toBe('my-poster.pdf');
    expect(pdfFilename('My Poster', { index: 1, total: 1 })).toBe('my-poster.pdf');
    expect(pdfFilename('My Poster', { index: 2, total: 3 })).toBe('my-poster-part-2-of-3.pdf');
  });
  it('maps MIME types to extensions', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('IMAGE/WEBP')).toBe('webp');
    expect(extensionFor('application/pdf')).toBe('pdf');
    expect(extensionFor('x/unknown')).toBe('bin');
  });
});

describe('downloadBlob', () => {
  it('clicks a download link and revokes the object URL after 60 s', () => {
    const calls: string[] = [];
    let timer: (() => void) | null = null;
    let delay = 0;
    const env: DownloadEnv = {
      createUrl: () => 'blob:abc',
      revokeUrl: (u) => calls.push(`revoke ${u}`),
      click: (u, name) => calls.push(`click ${u} ${name}`),
      setTimeout: (fn, ms) => {
        timer = fn;
        delay = ms;
        return 1;
      },
    };
    downloadBlob(new Blob(['x']), 'a.jpg', env);
    expect(calls).toEqual(['click blob:abc a.jpg']);
    expect(delay).toBe(REVOKE_DELAY_MS);
    expect(REVOKE_DELAY_MS).toBe(60_000);
    (timer as unknown as () => void)();
    expect(calls).toEqual(['click blob:abc a.jpg', 'revoke blob:abc']);
    void vi;
  });
});
