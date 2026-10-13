// The opt-in OpenCV engine in a real module worker (Spike 0 (b), (g)): loads from the same origin, detects and rectifies, and its
// runtime-cached copy keeps working offline. Chromium has no navigator.connection.type, so nothing is fetched until the user opts in.
import { expect, test, type Page } from '@playwright/test';
import { startAudit, uploadPoster, waitForServiceWorkerControl } from './helpers.ts';

/** Engines recorded on the stored shots, read straight from IndexedDB. */
async function storedEngines(page: Page): Promise<Array<string | null>> {
  return page.evaluate(
    () =>
      new Promise<Array<string | null>>((resolve, reject) => {
        const open = indexedDB.open('poster-photos');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('shots').objectStore('shots').getAll();
          all.onsuccess = () => resolve((all.result as Array<{ engine?: string }>).map((s) => s.engine ?? null));
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** The Adjust button reads "Better detection", then "Loading advanced detection..."; it disappears once OpenCV is ready (or has failed). */
const betterButton = (page: Page) => page.locator('.adjust-tools button', { hasText: /Better detection|Loading advanced detection/ });

test('Better detection loads OpenCV in a worker, rectifies with it, and the cached copy works offline', async ({ page, context, baseURL }) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL!).origin;
  const audit = await startAudit(context, page, origin);
  await page.goto('./');
  await waitForServiceWorkerControl(page);
  await uploadPoster(page);

  const better = betterButton(page);
  await expect(better).toBeVisible();
  expect(audit.requests.filter((u) => u.includes('/assets/vendor/opencv-'))).toEqual([]);
  await better.click();
  // ready: the button goes away (a failure would also hide it, so check the notice and the request)
  await expect(better).toBeHidden({ timeout: 120_000 });
  expect(audit.requests.filter((u) => u.includes('/assets/vendor/opencv-')).length).toBeGreaterThan(0);
  await expect(page.getByText('Advanced detection unavailable')).toHaveCount(0);

  await page.getByRole('button', { name: 'Rectify' }).click();
  await expect(page).toHaveURL(/#\/view\//, { timeout: 120_000 });
  await expect(page.locator('canvas.viewer-canvas')).toBeVisible();
  expect(await storedEngines(page)).toEqual(['opencv']);

  // the runtime route cached the file; offline, a fresh session starts it from the cache without any network
  await expect.poll(() => page.evaluate(async () => (await caches.has('cv-runtime')) && (await (await caches.open('cv-runtime')).keys()).length), { timeout: 30_000 }).toBe(1);
  await context.setOffline(true);
  await page.goto('./#/capture');
  await page.reload();
  await uploadPoster(page);
  await expect(betterButton(page)).toBeHidden({ timeout: 120_000 });
  await expect(page.getByText('Advanced detection unavailable')).toHaveCount(0);
  await context.setOffline(false);

  await audit.assertClean();
});
