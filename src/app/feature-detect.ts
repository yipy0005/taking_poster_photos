// Feature detection (main thread). Everything is a plain boolean so the UI can branch without try/catch.
import { isIosWebKit } from './config.ts';

export interface Features {
  indexedDB: boolean;
  serviceWorker: boolean;
  createImageBitmap: boolean;
  offscreenCanvas: boolean;
  secureContext: boolean;
  getUserMedia: boolean;
  imageCapture: boolean;
  webShare: boolean;
  webLocks: boolean;
  isIosWebKit: boolean;
}

export function detectFeatures(): Features {
  const g = globalThis as Record<string, unknown>;
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & Record<string, unknown>);
  return {
    indexedDB: typeof g['indexedDB'] !== 'undefined' && g['indexedDB'] !== null,
    serviceWorker: !!nav && 'serviceWorker' in nav,
    createImageBitmap: typeof g['createImageBitmap'] === 'function',
    offscreenCanvas: typeof g['OffscreenCanvas'] === 'function',
    secureContext: g['isSecureContext'] === true,
    getUserMedia: !!nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function',
    imageCapture: typeof g['ImageCapture'] === 'function',
    webShare: !!nav && typeof nav['share'] === 'function',
    webLocks: !!nav && typeof nav['locks'] === 'object' && nav['locks'] !== null,
    isIosWebKit: isIosWebKit(),
  };
}
