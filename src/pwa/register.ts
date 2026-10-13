// Service worker registration (design 2.11). registerType is 'prompt': a new version waits until the user accepts the
// update toast, then SKIP_WAITING is posted and the page reloads once the new worker controls it. Any failure is logged
// and the app simply runs online-only.
import { Workbox } from 'workbox-window';
import { log } from '../app/log.ts';
import type { Toaster } from '../ui/components/toast.ts';

/** The part of workbox-window's Workbox that register.ts uses (kept narrow so tests can fake it). */
export interface WorkboxLike {
  addEventListener(type: 'waiting' | 'controlling', listener: () => void): void;
  register(): Promise<unknown>;
  messageSkipWaiting(): void;
}
export interface RegisterDeps {
  toast: Toaster;
  create?: (url: string, scope: string) => WorkboxLike;
  reload?: () => void;
  hasServiceWorker?: boolean;
  baseUrl?: string;
}

export const UPDATE_MESSAGE = 'Update available.';

/** Registers the service worker. Resolves true when registration was started, false when it was skipped or failed. */
export async function registerServiceWorker(deps: RegisterDeps): Promise<boolean> {
  const has = deps.hasServiceWorker ?? (typeof navigator !== 'undefined' && 'serviceWorker' in navigator);
  if (!has) {
    log.warn('Service workers are not supported here; the app works online only');
    return false;
  }
  const base = deps.baseUrl ?? import.meta.env.BASE_URL;
  const create = deps.create ?? ((url, scope) => new Workbox(url, { scope }) as unknown as WorkboxLike);
  const reload = deps.reload ?? (() => location.reload());
  try {
    const wb = create(`${base}sw.js`, base);
    let accepted = false;
    wb.addEventListener('waiting', () => {
      deps.toast.show(UPDATE_MESSAGE, {
        timeoutMs: 0,
        action: {
          label: 'Reload',
          onClick: () => {
            accepted = true;
            wb.messageSkipWaiting();
          },
        },
      });
    });
    // Reload only when the user asked for the update; the first install also fires 'controlling' (clientsClaim).
    wb.addEventListener('controlling', () => {
      if (accepted) reload();
    });
    await wb.register();
    return true;
  } catch (e) {
    log.warn('Service worker registration failed; continuing online-only', e);
    return false;
  }
}
