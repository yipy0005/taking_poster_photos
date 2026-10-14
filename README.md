# Poster Photos

A mobile-first web app for photographing scientific posters at conferences. Open it in your phone's browser, take a photo from wherever you can stand, mark the poster's four corners, and the app straightens it into a flat, front-on image that you can zoom into at full detail. No account, no server, no upload.

## What it does

- **Capture.** A live camera view with a grid and an achieved-resolution readout. Where the browser allows it the app asks for the largest still photo the camera offers. A "Native camera" button hands over to the phone's own camera app, which gives the full-resolution photo on every platform. You can also pick photos from your gallery.
- **Straighten.** The app looks for the poster's edges and places four corner handles. Drag them (a magnifier shows the spot under your finger), choose the shape (Auto, A-series, 4:3, 16:9, free) and tap Rectify. The result is a front-on image at the highest size your device can safely produce. Large images are rendered in tiles so that phones do not run out of memory.
- **Look closely.** A viewer with pinch zoom, double-tap, pan with inertia, and 90 degree rotation. Zoom reaches at least 8x (more when the image has the pixels for it), well past the screen resolution, so small print on the poster stays readable.
- **Detail shots.** For a poster too big or too far away for one sharp photo, take one overview and then close-ups in a guided 2x2 or 3x3 grid. Each detail shot is straightened and viewed the same way. (Stitching them into one image is not built yet, see Future work.)
- **Library.** Posters are stored on the device with a name, conference, tags and notes, and can be searched.
- **Export.** Download or share a JPEG or PNG, a PDF of one photo or of the whole poster, or the untouched original.
- **Works offline** once installed or opened once, because the app is a Progressive Web App.

## Privacy

Everything stays on your device. There is no backend, no account, no analytics, and no third-party script, font or request. Photos live in your browser's own storage (IndexedDB). The built page carries a Content-Security-Policy that only allows connections to its own origin, and the end-to-end tests record every network request and fail on any cross-origin one.

The one exception is the Web Share button. It hands a file to your phone's share sheet. That only happens when you tap Share and pick a destination yourself, and the destination is yours to choose.

## Run it

You need Node.js 22.12 or newer.

```sh
npm install
npm run dev          # http://localhost:5173, this computer only
npm run typecheck    # tsc -b (app, worker, node and test projects)
npm test             # unit tests (vitest)
npm run build        # production build into dist/ (BASE_PATH=/taking_poster_photos/ by default)
npm run preview      # serve dist/ at http://localhost:4173/taking_poster_photos/
npm run test:e2e     # Playwright smoke, offline and privacy-audit tests against a fresh build
npm run icons        # regenerate the PNG icons from public/icons/icon.svg
```

The first time you run the end-to-end tests, install the browser with `npx playwright install chromium`. They serve the build on port 4373 (override with `E2E_PORT`). `BASE_PATH` must be the same for the build and the preview.

The service worker only exists in built output. To try offline behaviour or installation, use `npm run build && npm run preview`, not `npm run dev`.

## Trying it on a phone

The camera needs a secure context: **HTTPS or localhost**. A phone that opens `http://192.168.x.x:5173` has no camera access and no service worker. (Choosing photos from the gallery or the Native camera button still works there.) Options:

1. **Self-signed HTTPS on your Wi-Fi.** Run `npm run dev:https`, then open `https://<your-computer-ip>:5173` on the phone and accept the certificate warning. iOS Safari asks again each session. The service worker does not register with an untrusted certificate, so PWA install and offline behaviour cannot be tested this way.
2. **A tunnel with a trusted certificate.** Run `npm run dev:tunnel` (or, to test the production build and the service worker, `npm run build && npm run preview:tunnel`) and point a tunnel at the port, for example `ngrok http 5173` or `cloudflared tunnel --url http://localhost:5173` (use port 4173 for the preview). The tunnel gives you a real HTTPS URL.
3. **Deploy to GitHub Pages** (below) and open the Pages URL.

Plain `npm run dev` and `npm run preview` listen on this computer only. `dev:https`, `dev:tunnel` and `preview:tunnel` listen on every network interface and turn off Vite's host check, so anyone on the same network can reach the dev server, which has no login and serves your source files. Use them only on networks you trust.

Remote debugging: Android Chrome through `chrome://inspect`; iOS Safari through the Develop menu of Safari on a Mac.

## Install on your phone

Open the deployed site in the browser, then:

- **Android (Chrome):** menu, **Install app** (or **Add to Home screen**).
- **iPhone and iPad (Safari):** Share button, **Add to Home Screen**.

Installed, the app opens full screen and works offline. When a new version is available a message offers a reload.

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to `main` (and on manual run). One-time setup in the repository: **Settings, Pages, Source = GitHub Actions**. The workflow type-checks, runs the unit tests, builds, and deploys. The Vite base path comes from the repository name through `scripts/compute-base-path.sh` (`/<repo>/`, or `/` for a repository called `<owner>.github.io`). To build by hand for another location, set `BASE_PATH`, for example `BASE_PATH=/ npm run build` for a custom domain. It must start and end with a slash.

## Tips for good poster photos

- Stand as square-on as you can. The app corrects perspective, but a photo taken straight on keeps the most detail in the corners.
- Leave a little margin around the poster so all four corners are in the frame.
- Avoid the flash on glossy posters; it leaves a hot spot. Step sideways to move reflections off the text.
- Hold still, tap the poster to focus and set exposure if your camera supports it, and let the shot settle before pressing the shutter. The shutter stays disabled for a moment after the camera starts so auto-exposure can settle.
- **On iPhone, use "Native camera" for full resolution.** Safari cannot ask the camera for its largest photo; the live-view capture is limited to video resolution there.
- For a big or detailed poster, take one overview and then detail shots, and look at each one in the viewer.

### Dark photos
Not verified on real phone hardware: the steps below come from reading the camera specifications and from tests with a fake camera.
- **On iPhone, use the Native camera button.** The system camera does its own exposure and HDR; the live-view capture does not.
- Add light, and avoid shooting with a bright window or lamp behind or next to the poster.
- Tap the poster to focus and set exposure. A bright white poster can come out grey and dark when the camera meters for mid-grey.
- Where the camera offers it (mostly Android Chrome), use the Brightness slider on the Capture screen.
- Give the camera a second after it starts before pressing the shutter.
- If a photo is very dark, the app still saves it and shows "Photo looks very dark - try the Native camera button or add light". The Adjust screen then suggests **Brighten**.
- **Brighten** (Adjust screen, under Enhance, off by default) lifts the corrected image only. The original photo is never changed.

## Browser support

- **iOS and iPadOS: Safari 16.4 or newer.** Older versions are not supported. There is no fallback that runs the processing on the main thread.
- **Android: current Chrome.** Other current Chromium browsers and Firefox work for the gallery and Native camera paths. Camera features such as torch, focus and zoom appear only where the browser offers them.
- iOS does not implement `ImageCapture` before iOS 18.4, so before that the live view only reaches video resolution. The Native camera input (the system camera app) is the full-resolution path on iOS.

## Known limitations

- **Pixel caps.** Browsers limit canvas size and memory, so the output size is capped by device: 16.8 megapixels on iPhone and iPad, up to 50 megapixels elsewhere, reduced when the device reports little memory or a probe finds a lower limit. When a poster is rendered smaller than the corners would allow, the app says so. Very large source photos are decoded at a reduced size or in pieces. The first photo that crashes a tab makes the next attempt smaller.
- **PDF limits.** A PDF is built in memory. On iOS the app limits one file to 12 pages or 60 MB, elsewhere 40 pages or 150 MB. A bigger poster is offered as "Export in parts".
- **iOS storage eviction.** Safari may clear a website's data after a period of non-use, or when storage is low, unless the site is installed to the Home Screen and the browser grants persistent storage (Settings has a button for this). Export what matters. Photos in your camera roll are never touched.
- **Advanced detection (OpenCV) is opt-in on iOS.** The basic detector always works and needs no download. A stronger detector, built from OpenCV, is a one-time 13 MB download. On Android and desktop it is cached automatically, but only on Wi-Fi or ethernet with data saver off. On iPhone and iPad it is never loaded unless you tap **Better detection** on the Adjust screen or **Download offline detector** in Settings, because it uses much memory. If it fails, Settings has **Retry advanced detection**. Without it, expect more manual corner adjustment on low-contrast posters.
- **Auto shape is an estimate.** The "Auto" aspect ratio is estimated from the four corners. It is accurate to a few percent for most views and can be off by more than 10% for a poster seen from a steep single-axis angle; then the chip says "low confidence" and offers A-series and 4:3 in one tap. See Technical notes for the measured numbers.
- **Not saved badge.** If the browser refuses to store a photo (storage full or blocked), the photo stays usable in the open tab and the library marks it "Not saved" with Retry, Export and Discard. Closing the tab loses it. At most six such photos are kept before new captures are refused.
- **Share depends on the browser.** The Share button appears only where the browser can share files.

## Future work

- **Stitching** the detail shots of one poster into a single large image is deferred. The grid capture and per-shot straightening are in place for it.
- **Backup and export of the whole library** in one archive.
- **OCR / searchable text** from the straightened images.

## License

Apache License 2.0, see [LICENSE](LICENSE).

## Technical notes

Spike 0 results, recorded while scaffolding (Node v26.10.0, npm 11.19.1, Vite 8.3.4, TypeScript 6.0.3). Items marked "not measured" need a real device and are listed again at the end.

### Toolchain

- All pins in `package.json` installed as written; no pin had to change. `npm install` reported 0 vulnerabilities.
- `build.target: ['es2022', 'safari16']` is accepted by Vite 8 without warnings.
- `assetFileNames` with the function form and `info.names` is honoured: an asset whose name contains `opencv` is emitted to `assets/vendor/`, others to `assets/`. (Assets under 4 KB are inlined by Vite, so a real OpenCV file is unaffected.)
- `vite preview --mode tunnel` honours the mode: it prints Network URLs and listens on all interfaces; plain `vite preview` stays on localhost. The `TUNNEL=1` fallback in the design is not needed.
- `@vitejs/plugin-basic-ssl` covers `vite preview --mode https` as well as `vite --mode https` (the preview server answered over HTTPS on localhost and on the LAN address).
- `vite preview` reports `command === 'serve'`, so the base path must also be applied when `isPreview` is true. Without it, a build made for `/taking_poster_photos/` is served at `/` and every asset 404s. `vite.config.ts` uses `command === 'build' || isPreview`. The same `BASE_PATH` has to be set for `build` and `preview` when it is overridden.
- `BASE_PATH` validation (`^/([^/?#\s]+/)*$`) throws at config load for a bad value.
- The CSP `<meta>` is injected into the built `index.html` only and contains `connect-src 'self'`. `'wasm-unsafe-eval'` is omitted (OpenCV runs in a worker only); the AC-40 end-to-end run, including the OpenCV worker, reported no violation, so it stays out.

### TypeScript projects

- `tsc -b` passes with `skipLibCheck: true` (explicit in all four projects). With `skipLibCheck: false` every error (29) is inside third-party declaration files and none is in `src/`: `@techstark/opencv-js` types refer to DOM names (`HTMLElement`, `Range`) that the worker project does not have, and `workbox-core`, `unconfig` and `sharp-ico` have their own gaps. That is why `skipLibCheck: true` is stated explicitly (design 2.17). Re-checked once the OpenCV types were imported.
- Negative control: a reference to `document` placed in `src/app/bitmap-handle.ts` (reachable from the worker project's `*.worker.ts` entry; the original type-check anchor was replaced by the real `src/cv/js/js-engine.worker.ts`) fails with TS2584 in the worker project, as intended. The change was reverted.
- TypeScript 6 types typed arrays as `Uint8Array<ArrayBufferLike>`; where a `BlobPart` or `getRandomValues` argument is needed, use `Uint8Array<ArrayBuffer>`.

### Geometry and rectification core (`src/cv`)
- `output-size.ts` is the only place output `W x H` is computed (floor rule, `MAX_SIDE` 16384). 8000x6000 at the iOS cap of 16,777,216 px gives 4729x3546; round-to-nearest would give 4730x3547, which is 94 px over. For landscape ratio modes the width is trimmed to `floor(r * H)` after the cap rule so that `|W/H - r| <= 1/min(W, H)` (AC-16); trimming never grows the image and costs at most a few pixels.
- Tiles are planned against the ROI budget with an even partition (sizes differ by at most 1 px), so a 4729-wide output never gets a 1 px column.
- Aspect "Auto" accuracy, measured with the pinhole oracle (`src/cv/aspect.test.ts`; 4000x3000 frame, true focal length swept over 0.6..1.0 x the long side, prior 0.75 x long side, poster ratios A-series, 4:3, 16:9, 1:2, 1:1). Results are the envelope to quote instead of "up to about 5%":
  - General pose (yaw and pitch both 15..50 degrees): exact when noiseless (< 1e-12); with 0.5 px corner noise p90 0.25%, max 0.65%. Confidence `high`.
  - Fronto-parallel: error < 1%.
  - Single-axis tilt (pure yaw or pitch) below 25 degrees: max error 4.5%, p90 2.2%. Between 25 and 50 degrees: p90 9.7%, max 15.7%.
  - Near-single-axis yaw 15..50 degrees with pitch 0..14 degrees (guard zone): p90 2.9%, p99 below 12%, max 11.5%.
  - The prior branch is taken whenever either depth ratio is within 0.02 of 1. Confidence is `low` when the prior branch is used and `max(|k2-1|, |k3-1|) > 0.2` (`LOW_CONFIDENCE_TILT`), which is roughly a 15 to 20 degree single-axis tilt. Among single-axis samples, results rated `medium` or `high` have p90 error 3.0%; results rated `low` have p90 9.4%, and more than 90% of errors above 10% are rated `low`. `|k-1|` is a proxy for tilt, so some outliers (max 14.7%) remain among non-`low` results.
  - An exact EXIF focal length removes the single-axis error (below 0.5% in the test).
- JS engine on synthetic data (Node, `Raster` only): known-homography scene MAE below 1.5 and every pixel within 2 gray levels away from the edge; tile-wise output equals the whole-image warp in at least 99.99% of samples and differs by at most 1 level elsewhere.
- `detect-js` finds synthetic posters (bright-on-dark and dark-on-bright; upright, perspective, 8 degrees roll, 90% of the frame) with all corners within 3% of the diagonal. Known weakness (unchanged from the design): a poster rotated near 45 degrees in the frame, and low-contrast posters.
- The canvas-backed pieces (`OffscreenSurface`, `BitmapSource`, `decodeRaw` inside the worker) are type-checked under the WebWorker lib but were not run in a real browser here (see below).

### Capture, ingest and Adjust (`src/camera`, `src/ui/screens`)
- Ingest validates from headers only and persists the original before any optional decode. The header readers (`src/camera/exif.ts`) walk JPEG segments to SOS with no size cap, read PNG IHDR, WebP VP8/VP8L/VP8X and HEIC/AVIF `ispe` (plus `irot`, so the stored size is the displayed size). When no size can be read the shot is stored with `width`/`height` 0 and `dimsPending`, and the size is resolved by a gated background decode (`ensureDims`); if that decode fails, the shot (and a poster created by it) is removed again and the user is told "Can't read this image".
- Only a decoder that ignores EXIF orientation (`exifHonored` false) makes ingest re-encode a JPEG by hand (flagged `normalized`); otherwise the original blob is stored untouched, with the tag recorded in `originalExifOrientation` and oriented dimensions in `width`/`height`. A photo above `HARD_SOURCE_PIXELS` (256 MP) opens a dialog (Save a reduced copy / Discard); a photo between the soft and hard limit is stored as-is with `oversize`.
- The Adjust preview is derived through `decodeGuarded(kind 'preview')`, so strike caps and the heavy-decode marker apply. The corner editor works in preview pixels; `validateQuad` always runs after scaling to original pixels (`s = origW / previewW`).
- "Low confidence" Auto offers one-tap suggestions. "A-series" follows the quad orientation; "4:3" is only offered for a landscape quad because the 4:3 mode is a landscape ratio.
- Verified with the Vite dev server on localhost in headless Chromium (fake camera device): live preview and the achieved-resolution readout, shutter and gallery input to Adjust (four handles, loupe while dragging, arrow-key nudge), Rectify to a stored rectified blob and thumbnail, Keep original, guided 3x3 detail mode with skip, and the "Camera access is blocked" screen. Not run on real phones (see below).
### PWA, OpenCV engine and end-to-end tests (`vite.config.ts`, `src/pwa`, `src/cv/opencv`, `e2e`)
- **Service worker (Spike 0 e, AC-49).** `vite-plugin-pwa` 2.0.0 `generateSW`, `registerType: 'prompt'`, `devOptions.enabled: false` all work as written. `BASE_PATH=/taking_poster_photos/ npm run build` precaches 18 entries (635.85 KiB): the app shell, icons, manifest, the two worker chunks and the pdf-lib chunk. The OpenCV file is not in the precache; it is served by the runtime `CacheFirst` route (cache `cv-runtime`, pathname predicate, one entry). Emitted sizes: app chunk 164 kB (56 kB gzip), pdf-lib chunk 420 kB (176 kB gzip), each worker 18 kB, CSS 14 kB, OpenCV 13,298,869 bytes. A 3 MiB `.png` placed in `public/` makes the build fail (checked), so an accidental large precache entry cannot ship. The pdf-lib chunk stayed far below 2 MiB, so the limit was not raised.
- The runtime route sets `matchOptions: { ignoreVary: true }`, and `isCvCached()` does the same: a server that sends `Vary: Origin` (as `vite preview` does) otherwise hides an entry that was stored by `cache.add()` from a module-worker request, which carries an Origin header.
- **Icons.** `npm run icons` (`pwa-assets-generator --preset minimal-2023`) writes `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png` and `favicon.ico` next to `public/icons/icon.svg`. The file names are the generator's, not the shorter ones in the design. The preset pads the maskable and Apple icons with white, so the artwork uses a light background.
- **OpenCV in a module worker (Spike 0 b, g).** `import cvUrl from '@techstark/opencv-js/dist/opencv.js?url'` emits one hashed file under `assets/vendor/`. In the worker, `await import(url)` runs the UMD wrapper, which puts a promise of the module on `globalThis.cv`; the boxed loader turns that into `{ cv }` and the module comes up with `Mat`, `warpPerspective`, `Canny` and the rest. The module is not thenable. It does not expose `HEAP8`/`HEAPU8` (they are private variables in this build), so the heap size is unknown: the engine client therefore recycles the OpenCV worker after every job, on all platforms. Load time was not measured, in Chromium or on a phone.
- **CSP (AC-40).** The Playwright run records every request of the page and its workers and every `securitypolicyviolation`. With the OpenCV worker loaded, there were zero cross-origin requests and zero violations, so `'wasm-unsafe-eval'` was not added: the page's meta CSP does not apply to the worker that compiles the WASM.
- **Half-pixel parity (Spike 0 c, AC-12) with the real WASM in Node.** An identity homography copies the ROI exactly. A 1-pixel checkerboard through a perspective homography differs from the JS warp by a mean of 0.30 gray levels (maximum 2), inside the 1.0 contract. The known projective scene has MAE below 1.5 as for the JS engine.
- **Detector comparison** on the same synthetic perspective poster: OpenCV corners are within 1.4 px of the truth in 24 ms, the JS detector within 12.5 px in 48 ms (Node, 800x600). Confidence is `areaFraction * solidity` in both.
- **A race found and fixed.** A background OpenCV detect that finished while Rectify was running terminated the worker under the render (the recycle-after-every-job rule), so the render silently fell back to JS. Workers now count jobs in flight and recycle only when the last one is done; covered by a unit test and by the OpenCV end-to-end test, which checks that the stored shot says `engine: 'opencv'`.
- **End-to-end tests** (`npm run test:e2e`, Chromium, fake camera device, against `vite preview` of a fresh build on port 4373): `smoke.spec.ts` draws a skewed poster in the page, feeds it through the gallery input, accepts the detected corners, rectifies, zooms, downloads the JPEG, finds the poster in the library, opens Settings, reloads offline after the service worker took control, and audits requests and CSP violations. `exposure.spec.ts` checks that the corrected image is not darker than the source with Enhance off, and that Brighten lifts only the corrected image. `shutter.spec.ts` feeds the in-page shutter well-lit and very dark Y4M fake-camera videos, with and without `ImageCapture`, and checks the stored frame and the dark-photo warning. `opencv.spec.ts` taps Better detection, rectifies with OpenCV, then starts a fresh offline page that loads OpenCV from the runtime cache. CI runs unit tests only (backlog B-3).
### Browser behaviour

- Safari has no `requestIdleCallback`. All idle work goes through `whenIdle()` (`src/app/idle.ts`), which falls back to `setTimeout`. This is taken from MDN compatibility data and covered by a unit test that deletes `requestIdleCallback`; it was not observed on a real Safari here.

### Not yet measured (need real devices)
- Dark-photo handling: the +0.5 EV exposure bias, the continuous exposure and white-balance constraints, tap-to-expose, the start-up wait and the "very dark" thresholds (mean below 45 and 95th percentile below 120) were set from the specifications and have not been verified on real phone hardware. Chromium's fake camera has no auto-exposure, so the end-to-end tests guard the plumbing only.
- JS engine worker in a real browser: `OffscreenCanvas` ROI reads (`getImageData` after `drawImage` with `imageSmoothingQuality = 'high'`), `convertToBlob` encoding, and cancel latency between tiles.

- iPhone 48 MP photo: decode memory, `MAX_DECODE_PIXELS`, `MAX_SOURCE_PIXELS`, whether `resizeWidth` lowers peak decode memory (A-17).
- Chrome Android `ImageCapture.takePhoto` photo sizes; iOS 18.4 `takePhoto`. The capture chain, `pickPhotoSize` and the readout are unit-tested against fakes only; headless Chromium with a fake camera exercised the `takePhoto`/frame-grab path once.
- Touch dragging, the loupe position under a real finger, and the iOS native-camera input (which can reload the page); drag and loupe were exercised with a mouse only.
- `createImageBitmap` probe results on real Safari/Chrome/Firefox (`fromImage`, `exifHonored`, `resizeHonored`, `resizeAfterOrient`). The probe logic is unit-tested against stubs only.
- Canvas area limits on real devices (`getMaxOutputPixels` probe).
- OpenCV memory and speed on a real phone (the heap is not observable, see below), and PDF byte/page limits on iOS.
