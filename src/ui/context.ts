// Shared wiring handed to every screen. Screens are mount(el, ctx, route) => Dispose.
import type { Features } from '../app/feature-detect.ts';
import type { Route, Router } from '../app/router.ts';
import type { Dispose } from '../app/state.ts';
import type { EngineClient } from '../cv/engine-client.ts';
import type { Store } from '../storage/store.ts';
import type { Toaster } from './components/toast.ts';

export interface AppContext {
  store: Store;
  router: Router;
  toast: Toaster;
  features: Features;
  /** Detection and rectification (JS worker now; OpenCV registered in FEAT-005). Workers start lazily on first use. */
  engine: EngineClient;
  /** IndexedDB is unavailable: the store is memory-only and nothing survives a reload. */
  sessionOnly: boolean;
}

export type Screen = (el: HTMLElement, ctx: AppContext, route: Route) => Dispose;
