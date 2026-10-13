import { defineConfig } from '@playwright/test';

// The app is served by `vite preview` after a production build, because the service worker, the CSP meta tag and the base path
// only exist in built output. build and preview must use the same BASE_PATH (default: the GitHub Pages path).
const BASE_PATH = process.env['BASE_PATH'] ?? '/taking_poster_photos/';
// A fixed port, not Vite's default 4173, which other local projects often occupy. Override with E2E_PORT.
const PORT = Number(process.env['E2E_PORT'] ?? 4373);

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    acceptDownloads: true,
    permissions: ['camera'],
    launchOptions: {
      // a synthetic camera so the Capture screen can start without hardware
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${BASE_PATH}`,
    env: { BASE_PATH },
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
