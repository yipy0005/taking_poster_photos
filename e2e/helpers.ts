import { expect, type BrowserContext, type Page } from '@playwright/test';

/** Draws a skewed bright poster on a dark wall in the page and returns it as JPEG bytes (base64). */
export async function makePosterJpegBase64(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const W = 1600;
    const H = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#30343b';
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
      g.fillStyle = color;
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
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
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
export async function uploadPoster(page: Page): Promise<void> {
  const b64 = await makePosterJpegBase64(page);
  await page.locator('input[type=file]:not([capture])').setInputFiles({ name: 'poster.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  await expect(page).toHaveURL(/#\/adjust\/[0-9a-f-]+/);
  await expect(page.locator('canvas.adjust-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rectify' })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'Looking for the poster edges' })).toHaveCount(0);
}
