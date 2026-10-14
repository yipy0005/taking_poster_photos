// In-page shutter against Chromium's fake camera fed from deterministic Y4M files (a well-lit and a very dark scene).
// Each case runs twice: with takePhoto (default Chromium) and without ImageCapture (the iPhone Safari frame-grab path).
// The fake camera has no auto-exposure, so these tests guard the capture plumbing (warm-up, frame brightness, dark-frame
// warning); exposure behaviour itself is "fixed by inspection, unverified on hardware".
import { rmSync } from 'node:fs';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readStoredBlobMeanLuma, videoMeanLuma, writeY4m } from './helpers.ts';

const DARK_WARNING = 'Photo looks very dark - try the Native camera button or add light';
const files: Record<'lit' | 'dark', string> = { lit: '', dark: '' };
test.beforeAll(() => {
  files.lit = writeY4m('poster-lit', 180);
  files.dark = writeY4m('poster-dark', 22);
});
test.afterAll(() => {
  for (const f of Object.values(files)) rmSync(f, { force: true });
});

const PATHS = [
  { name: 'takePhoto path', withoutImageCapture: false },
  { name: 'frame-grab path (no ImageCapture)', withoutImageCapture: true },
];

/** A page whose fake camera plays the given Y4M file (launchOptions cannot be changed per describe block, so launch here). */
async function withFakeCamera(
  baseURL: string,
  file: string,
  withoutImageCapture: boolean,
  run: (page: Page, context: BrowserContext) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`],
  });
  try {
    const context = await browser.newContext({ baseURL, permissions: ['camera'] });
    const page = await context.newPage();
    if (withoutImageCapture) await page.addInitScript(() => Object.defineProperty(window, 'ImageCapture', { value: undefined }));
    await run(page, context);
  } finally {
    await browser.close();
  }
}

/** Loads the app and returns how long the shutter took to become enabled. */
async function openCapture(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 10_000 });
  return Date.now() - t0;
}

test.describe('well-lit scene', () => {
  for (const p of PATHS) {
    test(`${p.name}: the shutter right after camera start gives a bright, non-black photo`, async ({ baseURL }) => {
      await withFakeCamera(baseURL!, files.lit, p.withoutImageCapture, async (page) => {
        const readyMs = await openCapture(page);
        expect(readyMs).toBeLessThan(5_000);
        const reference = await videoMeanLuma(page);
        await page.getByRole('button', { name: 'Take photo' }).click();
        await expect(page).toHaveURL(/#\/adjust\/[0-9a-f-]+/, { timeout: 30_000 });
        const stored = await readStoredBlobMeanLuma(page, 'original', { insetFraction: 0 });
        console.log(`shutter[${p.name}]: ready after ${readyMs} ms, video mean luma ${reference.toFixed(1)}, stored original mean luma ${stored.toFixed(1)}`);
        expect(stored).toBeGreaterThan(20);
        expect(Math.abs(stored - reference) / reference).toBeLessThanOrEqual(0.15);
        await expect(page.getByText(DARK_WARNING)).toHaveCount(0);
      });
    });
  }
});

test.describe('very dark scene', () => {
  for (const p of PATHS) {
    test(`${p.name}: the photo is saved, with a visible dark-photo warning`, async ({ baseURL }) => {
      await withFakeCamera(baseURL!, files.dark, p.withoutImageCapture, async (page) => {
        await openCapture(page);
        await page.getByRole('button', { name: 'Take photo' }).click();
        await expect(page).toHaveURL(/#\/adjust\/[0-9a-f-]+/, { timeout: 30_000 });
        const stored = await readStoredBlobMeanLuma(page, 'original', { insetFraction: 0 });
        console.log(`shutter dark[${p.name}]: stored original mean luma ${stored.toFixed(1)}`);
        await expect(page.getByText(DARK_WARNING)).toBeVisible();
        await expect(page.getByText('This photo looks dark. Try Brighten under Enhance.')).toBeVisible();
      });
    });
  }
});
