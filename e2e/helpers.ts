import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';

export interface PosterJpeg {
  b64: string;
  /** Mean Rec. 601 luma (0..255) of the decoded source sampled uniformly in poster space (the middle 90% of the poster). */
  sourceMeanLuma: number;
}

/**
 * Draws a skewed poster on a dark wall in the page and returns it as JPEG bytes (base64) together with the mean luma of the
 * poster area. `scale` multiplies every fill colour channel, so 1 is a well-lit poster and ~0.25 a dark one.
 */
export async function makePosterJpegWithStats(page: Page, opts: { scale?: number } = {}): Promise<PosterJpeg> {
  return page.evaluate(async (scale) => {
    const W = 1600;
    const H = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    const shade = (hex: string): string => {
      const n = parseInt(hex.slice(1), 16);
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * scale));
      return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
    };
    g.fillStyle = shade('#30343b');
    g.fillRect(0, 0, W, H);
    const quad = [
      [330, 160],
      [1180, 230],
      [1250, 980],
      [280, 900],
    ] as const;
    // bilinear map from the unit square onto the quad
    const map = (u: number, v: number): [number, number] => {
      const top = [quad[0][0] + (quad[1][0] - quad[0][0]) * u, quad[0][1] + (quad[1][1] - quad[0][1]) * u];
      const bot = [quad[3][0] + (quad[2][0] - quad[3][0]) * u, quad[3][1] + (quad[2][1] - quad[3][1]) * u];
      return [top[0]! + (bot[0]! - top[0]!) * v, top[1]! + (bot[1]! - top[1]!) * v];
    };
    const poly = (pts: Array<[number, number]>, color: string): void => {
      g.fillStyle = shade(color);
      g.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
      g.closePath();
      g.fill();
    };
    poly([map(0, 0), map(1, 0), map(1, 1), map(0, 1)], '#f4f2ea');
    poly([map(0.05, 0.05), map(0.95, 0.05), map(0.95, 0.16), map(0.05, 0.16)], '#1d4f9c');
    for (let row = 0; row < 14; row++) {
      const v = 0.22 + row * 0.052;
      const right = row % 3 === 2 ? 0.55 : 0.93;
      poly([map(0.06, v), map(right, v), map(right, v + 0.028), map(0.06, v + 0.028)], '#2b2b2b');
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.92));

    // reference luma: decode the JPEG again (so JPEG error is part of the source) and average inside the shrunk quad
    const bmp = await createImageBitmap(blob);
    g.clearRect(0, 0, W, H);
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const px = g.getImageData(0, 0, W, H).data;
    // The rectified image samples the poster uniformly in poster space, so the reference does too (a plain average over the
    // skewed quad would over-weight the near, larger side and differ from the rectified mean without any darkening).
    const STEPS = 400;
    let sum = 0;
    for (let a = 0; a < STEPS; a++) {
      for (let b = 0; b < STEPS; b++) {
        const [x, y] = map(0.05 + (0.9 * (a + 0.5)) / STEPS, 0.05 + (0.9 * (b + 0.5)) / STEPS);
        const i = (Math.round(y) * W + Math.round(x)) * 4;
        sum += 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
      }
    }
    const n = STEPS * STEPS;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { b64: btoa(bin), sourceMeanLuma: sum / n };
  }, opts.scale ?? 1);
}

/** Draws a skewed bright poster on a dark wall in the page and returns it as JPEG bytes (base64). */
export async function makePosterJpegBase64(page: Page): Promise<string> {
  return (await makePosterJpegWithStats(page)).b64;
}

/** The shot id in `#/adjust/<id>` or `#/view/<id>`. */
export function shotIdFromUrl(url: string): string {
  const m = /#\/(?:adjust|view)\/([0-9a-f-]+)/.exec(url);
  if (!m) throw new Error(`no shot id in ${url}`);
  return m[1]!;
}

/** Mean Rec. 601 luma (0..255) of a stored blob, over the image inset by `insetFraction` on every side (default 5%). */
export async function readStoredBlobMeanLuma(page: Page, kind: 'original' | 'rectified', opts: { insetFraction?: number } = {}): Promise<number> {
  const shotId = shotIdFromUrl(page.url());
  return page.evaluate(
    async ({ key, inset }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('poster-photos');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rec = await new Promise<{ blob: Blob } | undefined>((resolve, reject) => {
        const req = db.transaction('blobs', 'readonly').objectStore('blobs').get(key);
        req.onsuccess = () => resolve(req.result as { blob: Blob } | undefined);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (!rec) throw new Error(`no stored blob ${key}`);
      const bmp = await createImageBitmap(rec.blob, { imageOrientation: 'from-image' });
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const x0 = Math.floor(canvas.width * inset);
      const y0 = Math.floor(canvas.height * inset);
      const w = canvas.width - 2 * x0;
      const h = canvas.height - 2 * y0;
      const px = g.getImageData(x0, y0, w, h).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
      return sum / (px.length / 4);
    },
    { key: `${shotId}/${kind}`, inset: opts.insetFraction ?? 0.05 },
  );
}

/**
 * Writes a deterministic Y4M fake-camera file (flat luma `y`, neutral chroma) for --use-file-for-fake-video-capture and returns its
 * path. Playwright's fake camera has no auto-exposure, so this only exercises the capture plumbing.
 */
export function writeY4m(name: string, y: number, opts: { width?: number; height?: number; frames?: number } = {}): string {
  const w = opts.width ?? 320;
  const h = opts.height ?? 240;
  const frames = opts.frames ?? 10;
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`, 'latin1');
  const frame = Buffer.concat([Buffer.from('FRAME\n', 'latin1'), Buffer.alloc(w * h, y), Buffer.alloc((w / 2) * (h / 2), 128), Buffer.alloc((w / 2) * (h / 2), 128)]);
  const file = join(tmpdir(), `${name}-${process.pid}.y4m`);
  writeFileSync(file, Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]));
  return file;
}

/** Mean luma (0..255) of the current frame of the capture <video>, drawn onto a canvas. */
export async function videoMeanLuma(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('video.capture-video')!;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(v, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    return sum / (px.length / 4);
  });
}

export interface Audit {
  requests: string[];
  violations: string[];
  /** Zero cross-origin requests and zero CSP violations (AC-40). */
  assertClean(): Promise<void>;
}

/** Records every request (page and workers) and every CSP violation. */
export async function startAudit(context: BrowserContext, page: Page, origin: string): Promise<Audit> {
  const requests: string[] = [];
  const violations: string[] = [];
  context.on('request', (req) => requests.push(req.url()));
  context.on('console', (msg) => {
    if (/Content Security Policy|Refused to (load|connect|execute|apply|create)/i.test(msg.text())) violations.push(msg.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (ev) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${ev.violatedDirective} ${ev.blockedURI}`);
    });
  });
  return {
    requests,
    violations,
    async assertClean() {
      const inPage = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => []);
      violations.push(...inPage);
      const crossOrigin = requests.filter((u) => /^https?:/.test(u) && new URL(u).origin !== origin);
      expect(crossOrigin, `cross-origin requests: ${crossOrigin.join(', ')}`).toEqual([]);
      expect(violations, `CSP violations: ${violations.join(' | ')}`).toEqual([]);
    },
  };
}

/** Waits until the service worker controls the page (precache complete, offline-ready). */
export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 30_000 });
}

/** Opens the Capture screen, feeds the poster through the gallery input and waits for Adjust with corners placed. */
export async function uploadPoster(page: Page, opts: { scale?: number } = {}): Promise<number> {
  const { b64, sourceMeanLuma } = await makePosterJpegWithStats(page, opts);
  await page.locator('input[type=file]:not([capture])').setInputFiles({ name: 'poster.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  await expect(page).toHaveURL(/#\/adjust\/[0-9a-f-]+/);
  await expect(page.locator('canvas.adjust-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rectify' })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'Looking for the poster edges' })).toHaveCount(0);
  return sourceMeanLuma;
}
