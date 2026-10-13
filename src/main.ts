// Bootstrap: feature detection, storage open (with session fallback), heavy-decode marker check, router, idle work.
import './ui/styles/app.css';
import { ERROR_TOAST_INTERVAL_MS } from './app/config.ts';
import { ensureDecodeCaps } from './app/decode-caps.ts';
import { checkHeavyMarker, configureDecodeGuard, holdTabLock } from './app/decode-guarded.ts';
import { StorageFullError } from './app/errors.ts';
import { detectFeatures } from './app/feature-detect.ts';
import { newId } from './app/id.ts';
import { whenIdle } from './app/idle.ts';
import { log } from './app/log.ts';
import { createRouter, routeToHash, type Route, type Router } from './app/router.ts';
import { appHooks } from './app/state.ts';
import { createIngestDeps, registerThumbSweep } from './camera/ingest.ts';
import { createEngineClient } from './cv/engine-client.ts';
import { startAutoWarm } from './cv/opencv/warm-cache.ts';
import { IdbBackend } from './storage/idb-store.ts';
import { MemoryBackend } from './storage/memory-store.ts';
import { openPosterDb, type PosterDbHandle } from './storage/db.ts';
import { registerServiceWorker } from './pwa/register.ts';
import { requestPersistence } from './storage/quota.ts';
import { SessionOverlayStore } from './storage/session-overlay-store.ts';
import type { Backend } from './storage/store.ts';
import { createToaster } from './ui/components/toast.ts';
import type { AppContext, Screen } from './ui/context.ts';
import { el } from './ui/dom.ts';
import { adjustScreen } from './ui/screens/adjust-screen.ts';
import { captureScreen } from './ui/screens/capture-screen.ts';
import { libraryScreen } from './ui/screens/library-screen.ts';
import { posterScreen } from './ui/screens/poster-screen.ts';
import { resultScreen } from './ui/screens/result-screen.ts';
import { settingsScreen } from './ui/screens/settings-screen.ts';

const SCREENS: Record<Route['name'], Screen> = {
  capture: captureScreen,
  adjust: adjustScreen,
  view: resultScreen,
  library: libraryScreen,
  poster: posterScreen,
  settings: settingsScreen,
};

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app is missing');

  const features = detectFeatures();
  const tabId = newId();
  holdTabLock(tabId);
  const toast = createToaster(document.body);

  // Top-level safety net: log, show one generic toast per 10 s, never wipe state.
  let lastErrorToast = 0;
  const generic = (): void => {
    const now = Date.now();
    if (now - lastErrorToast < ERROR_TOAST_INTERVAL_MS) return;
    lastErrorToast = now;
    toast.show('Something went wrong. Your photos are safe.', { kind: 'error' });
  };
  window.addEventListener('error', (ev) => {
    log.error('uncaught error', ev.error ?? ev.message);
    generic();
  });
  window.addEventListener('unhandledrejection', (ev) => {
    log.error('unhandled rejection', ev.reason);
    generic();
  });

  // ---- storage ----
  let db: PosterDbHandle | undefined;
  let base: Backend;
  let sessionOnly = false;
  if (features.indexedDB) {
    try {
      db = await openPosterDb({
        onBlocking: () => {
          db?.close();
          toast.show('Update in another tab, reload', { timeoutMs: 0, kind: 'warn' });
        },
      });
      const idb = new IdbBackend(db);
      await idb.sweepOrphans().catch((e: unknown) => log.warn('orphan sweep failed', e));
      base = idb;
    } catch (e) {
      log.error('IndexedDB could not be opened; using session-only storage', e);
      sessionOnly = true;
      base = new MemoryBackend();
    }
  } else {
    log.error('IndexedDB is unavailable; using session-only storage');
    sessionOnly = true;
    base = new MemoryBackend();
  }

  let lastFullToast = 0;
  let routerRef: Router | undefined;
  const store = new SessionOverlayStore(base, {
    onSaveFailed: (err) => {
      const now = Date.now();
      if (now - lastFullToast < ERROR_TOAST_INTERVAL_MS) return;
      lastFullToast = now;
      toast.show(err instanceof StorageFullError ? 'Storage full. Your photo is kept for this session.' : "Couldn't save, try again", {
        kind: 'error',
        timeoutMs: 0,
        action: { label: 'Open library', onClick: () => routerRef?.navigate({ name: 'library' }) },
      });
    },
  });

  // ---- heavy-decode guard and crash-loop marker (2.7 item 9) ----
  configureDecodeGuard({ meta: store, persistMarker: !sessionOnly, tabId });
  if (!sessionOnly) {
    try {
      const check = await checkHeavyMarker(store);
      if (check.status === 'struck') {
        toast.show('The last attempt ran out of memory. Using a smaller size next time.', { kind: 'warn', timeoutMs: 8000 });
      }
    } catch (e) {
      log.warn('heavy-decode marker check failed', e);
    }
  }

  // Lazy thumbnail sweep (design 2.9 item 5): repairs thumbnails lost between persist and the background step.
  registerThumbSweep(createIngestDeps(store));

  // ---- shell ----
  if (sessionOnly) {
    root.append(el('div', { class: 'banner', text: "Photos can't be saved in this browser. They are kept until you close the tab.", attrs: { role: 'alert' } }));
  }
  const host = el('div', { class: 'screen-host' });
  root.append(host);

  const ctx: AppContext = {
    store,
    toast,
    features,
    engine: createEngineClient(),
    sessionOnly,
    get router(): Router {
      if (!routerRef) throw new Error('router is not ready');
      return routerRef;
    },
  };
  const router = createRouter({
    store,
    toast: (m) => toast.show(m),
    mount: (route) => SCREENS[route.name](host, ctx, route),
  });
  routerRef = router;
  if (location.hash === '') history.replaceState(null, '', routeToHash({ name: 'capture', mode: 'overview' }));
  router.start();

  // The service worker exists only in built output (devOptions.enabled is false).
  if (import.meta.env.PROD) void registerServiceWorker({ toast });
  // ---- idle work ----
  whenIdle(() => void ensureDecodeCaps().catch((e: unknown) => log.warn('decode probe failed', e)));

  const onFirstInteraction = (): void => {
    window.removeEventListener('pointerdown', onFirstInteraction, true);
    window.removeEventListener('keydown', onFirstInteraction, true);
    // Cache the OpenCV file only on Wi-Fi/ethernet, never on iOS, never while capturing (design 2.8). Fills the cache only.
    startAutoWarm();
    whenIdle(() => {
      void appHooks.thumbSweep?.().catch((e: unknown) => log.warn('thumbnail sweep failed', e));
    });
  };
  window.addEventListener('pointerdown', onFirstInteraction, true);
  window.addEventListener('keydown', onFirstInteraction, true);

  // Ask for persistent storage after the first successful save.
  if (!sessionOnly) {
    const off = store.onChange(() => {
      off();
      void requestPersistence();
    });
  }

  // Remind about unsaved photos when the user comes back to the tab.
  let hiddenWithUnsaved = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenWithUnsaved = store.unsavedIds().size > 0;
    else if (hiddenWithUnsaved) {
      hiddenWithUnsaved = false;
      toast.show('Some photos are not saved yet. Open the library to retry, export or discard them.', {
        kind: 'warn',
        timeoutMs: 8000,
        action: { label: 'Open library', onClick: () => router.navigate({ name: 'library' }) },
      });
    }
  });
}

boot().catch((e: unknown) => {
  log.error('startup failed', e);
  const root = document.getElementById('app');
  if (root) {
    root.replaceChildren(el('main', { class: 'screen-body' }, el('h1', { text: 'Poster Photos could not start' }), el('p', { text: 'Reload the page. If this keeps happening, your browser may be blocking storage.' })));
  }
});
