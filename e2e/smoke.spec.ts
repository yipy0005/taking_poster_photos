// Smoke, offline and privacy audit against `vite preview` of the production build (AC-26 subset, AC-40, AC-18 d).
import { expect, test } from '@playwright/test';
import { startAudit, uploadPoster, waitForServiceWorkerControl } from './helpers.ts';

test('capture to viewer to export, then offline reload, with zero cross-origin requests and zero CSP violations', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const audit = await startAudit(context, page, origin);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('./');
  await expect(page.locator('input[type=file]:not([capture])')).toBeAttached();
  await waitForServiceWorkerControl(page);

  // gallery -> Adjust: the detected corners are accepted as they are
  await uploadPoster(page);
  await expect(page.locator('[aria-label^="Top-left"]')).toBeVisible();

  // Rectify -> viewer
  await page.getByRole('button', { name: 'Rectify' }).click();
  await expect(page).toHaveURL(/#\/view\/[0-9a-f-]+/, { timeout: 60_000 });
  const canvas = page.locator('canvas.viewer-canvas');
  await expect(canvas).toBeVisible();

  // zoom: the frame must change
  const before = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png').length);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png').length), { timeout: 10_000 }).not.toBe(before);

  // download the corrected JPEG
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JPEG' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.jpe?g$/i);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
  expect(bytes.length).toBeGreaterThan(5_000);

  // the library lists it
  await page.evaluate(() => (location.hash = '#/library'));
  await expect(page.locator('.card-grid > li')).toHaveCount(1);

  // Settings offers the opt-in detector download; nothing has been downloaded yet
  await page.evaluate(() => (location.hash = '#/settings'));
  await expect(page.getByRole('button', { name: 'Download offline detector (13 MB)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry advanced detection' })).toBeHidden();
  await page.evaluate(() => (location.hash = '#/library'));
  await expect(page.locator('.card-grid > li')).toHaveCount(1);

  // AC-18 d: nothing asked for the 13 MB OpenCV file without an explicit opt-in
  expect(audit.requests.filter((u) => u.includes('/assets/vendor/opencv-'))).toEqual([]);

  // AC-26 subset: offline reload after service-worker activation still opens the app and the stored poster
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.card-grid > li')).toHaveCount(1);
  await context.setOffline(false);

  expect(errors).toEqual([]);
  await audit.assertClean();
});
