// Pixel-pipeline regression for the "super dark photos" report: with Enhance off, the rectified output must be as bright as
// the poster area of the source (it must never be darker).
import { expect, test } from '@playwright/test';
import { readStoredBlobMeanLuma, uploadPoster } from './helpers.ts';

/** Tolerance of the mean-luma comparison. The dark-photo bug is a loss of more than 20%, so this stays tight. */
const TOLERANCE = 0.03;

test('rectified output is not darker than the source (enhance off)', async ({ page }) => {
  await page.goto('./');
  const sourceMean = await uploadPoster(page);
  for (const name of ['Auto contrast', 'White balance', 'Mild sharpen']) {
    await expect(page.getByRole('checkbox', { name })).not.toBeChecked();
  }
  await page.getByRole('button', { name: 'Rectify' }).click();
  await expect(page).toHaveURL(/#\/view\/[0-9a-f-]+/, { timeout: 60_000 });
  const rectifiedMean = await readStoredBlobMeanLuma(page, 'rectified');
  const ratio = rectifiedMean / sourceMean;
  console.log(`exposure: source mean luma ${sourceMean.toFixed(2)}, rectified mean luma ${rectifiedMean.toFixed(2)}, ratio ${ratio.toFixed(4)}`);
  expect(Math.abs(rectifiedMean - sourceMean) / sourceMean).toBeLessThanOrEqual(TOLERANCE);
});

test.describe('dark poster', () => {
  test('Brighten is suggested, off by default (never darker), and lifts only the rectified output when on', async ({ page }) => {
    await page.goto('./');
    const sourceMean = await uploadPoster(page, { scale: 0.25 });
    await expect(page.getByText('This photo looks dark. Try Brighten under Enhance.')).toBeVisible();
    const brighten = page.getByRole('checkbox', { name: 'Brighten' });
    await expect(brighten).not.toBeChecked();
    const originalBefore = await readStoredBlobMeanLuma(page, 'original', { insetFraction: 0 });

    // Brighten OFF: not darker than the source
    await page.getByRole('button', { name: 'Rectify' }).click();
    await expect(page).toHaveURL(/#\/view\/[0-9a-f-]+/, { timeout: 60_000 });
    const plainMean = await readStoredBlobMeanLuma(page, 'rectified');
    console.log(`brighten off: source mean luma ${sourceMean.toFixed(2)}, rectified ${plainMean.toFixed(2)}`);
    expect(Math.abs(plainMean - sourceMean) / sourceMean).toBeLessThanOrEqual(TOLERANCE);

    // Brighten ON: at least 1.3x the source (re-open Adjust on the same shot)
    await page.evaluate(() => (location.hash = location.hash.replace('#/view/', '#/adjust/')));
    await expect(page.locator('canvas.adjust-canvas')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rectify' })).toBeEnabled();
    await page.getByRole('checkbox', { name: 'Brighten' }).check();
    await page.getByRole('button', { name: 'Rectify' }).click();
    await expect(page).toHaveURL(/#\/view\/[0-9a-f-]+/, { timeout: 60_000 });
    const brightMean = await readStoredBlobMeanLuma(page, 'rectified');
    console.log(`brighten on: rectified ${brightMean.toFixed(2)} (${(brightMean / sourceMean).toFixed(2)}x source)`);
    expect(brightMean).toBeGreaterThanOrEqual(sourceMean * 1.3);

    // the stored original is untouched
    const originalAfter = await readStoredBlobMeanLuma(page, 'original', { insetFraction: 0 });
    expect(originalAfter).toBe(originalBefore);
  });
});
