import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// Content-Security-Policy, injected into the BUILT index.html only. (In `vite dev` the HMR client and
// websocket would fight a strict policy; the production build is what ships.)
// 'wasm-unsafe-eval' is deliberately absent: OpenCV runs in a worker only (plan.md finding 12).
// Add it back only if the AC-40 e2e run reports a CSP violation, and note the reason in the README.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
});

export default defineConfig(({ command, mode, isPreview }) => {
  // Build: repo subpath (override via BASE_PATH for forks / custom domains). Dev: '/'.
  const rawBase = process.env['BASE_PATH'] ?? '/taking_poster_photos/';
  if (!/^\/([^/?#\s]+\/)*$/.test(rawBase)) {
    // fail fast: a bad base breaks every asset URL
    throw new Error(`BASE_PATH must start and end with "/" (got "${rawBase}")`);
  }
  // Only these modes expose the dev server beyond localhost.
  const lan = mode === 'https' || mode === 'tunnel';
  // `vite preview` reports command 'serve'; it must serve the built app under the same base the build used.
  const appBase = command === 'build' || isPreview ? rawBase : '/';
  return {
    base: appBase,
    build: {
      target: ['es2022', 'safari16'],
      sourcemap: false,
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          // keep the 13 MB OpenCV asset on a predictable path for the SW glob ignore + runtime route
          assetFileNames: (info) =>
            /opencv/.test(info.names?.[0] ?? '')
              ? 'assets/vendor/[name]-[hash][extname]'
              : 'assets/[name]-[hash][extname]',
        },
      },
    },
    // module workers (Safari 15+); no importScripts used
    worker: { format: 'es' },
    // Default `npm run dev` binds localhost only. LAN exposure is opt-in via a mode, because the dev
    // server has no authentication and serves source and any file under the project root.
    server: lan ? { host: true, allowedHosts: true } : {},
    preview: mode === 'tunnel' ? { host: true, allowedHosts: true } : {},
    plugins: [
      ...(mode === 'https' ? [basicSsl()] : []),
      cspPlugin(),
      VitePWA({
        strategies: 'generateSW',
        registerType: 'prompt',
        // registration is done by src/pwa/register.ts (workbox-window), not by an injected script
        injectRegister: false,
        // the service worker is not used in `vite dev`; test it with `npm run build && npm run preview`
        devOptions: { enabled: false },
        manifest: {
          name: 'Poster Photo',
          short_name: 'Posters',
          description: 'Photograph scientific posters, straighten them and view them in high resolution.',
          id: appBase,
          start_url: appBase,
          scope: appBase,
          display: 'standalone',
          orientation: 'any',
          background_color: '#101114',
          theme_color: '#101114',
          icons: [
            { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
          // The 13 MB OpenCV file must never be precached (it would also fail the build, see maximumFileSizeToCacheInBytes).
          globIgnores: ['**/assets/vendor/opencv-*'],
          // Explicit (also Workbox's default). A larger precache candidate fails the build, which guards against precaching big files.
          maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
          navigateFallback: 'index.html',
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          runtimeCaching: [
            {
              // Pathname predicate (not a regex against the full URL) so it is correct under any base.
              urlPattern: ({ url }: { url: URL }) => url.pathname.includes('/assets/vendor/opencv-'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'cv-runtime',
                cacheableResponse: { statuses: [200] },
                // the entry may have been stored by cache.add() (no Origin header) and is read by a module-worker request (with one)
                matchOptions: { ignoreVary: true },
                expiration: { maxEntries: 1, purgeOnQuotaError: true },
              },
            },
          ],
        },
      }),
    ],
  };
});
