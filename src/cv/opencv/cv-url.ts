// Main thread: the URL of the self-hosted OpenCV file. Vite emits the 13 MB file as a hashed asset under
// assets/vendor/ (see assetFileNames in vite.config.ts); importing it with ?url never loads or executes it.
import cvAssetUrl from '@techstark/opencv-js/dist/opencv.js?url';

/** Resolves an asset URL (possibly root-relative) to an absolute URL, which is what the worker receives. */
export function resolveCvUrl(raw: string, base: string): string {
  return new URL(raw, base).href;
}

export function getCvUrl(): string {
  return resolveCvUrl(cvAssetUrl, location.href);
}
