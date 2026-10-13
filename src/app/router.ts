// Hash router (design 2.4). Pure parsing/resolution plus a small controller that mounts screens.
import { isUuidV4 } from './id.ts';
import type { Dispose } from './state.ts';

export type CaptureMode = 'overview' | 'detail';
export type GridKind = '2x2' | '3x3';

export type Route =
  | { name: 'capture'; poster?: string; mode: CaptureMode; grid?: GridKind; cell?: number }
  | { name: 'adjust'; id: string }
  | { name: 'view'; id: string }
  | { name: 'library' }
  | { name: 'poster'; id: string }
  | { name: 'settings' };

export type RouteName = Route['name'];

/** Subset of Store the router needs (the effective, overlay-aware store). */
export interface RouteStore {
  exists(kind: 'poster' | 'shot', id: string): Promise<boolean>;
  getShot(shotId: string): Promise<{ id: string; status: 'captured' | 'rectified' | 'uncorrected' } | null>;
}

export const MAX_GRID_CELL = 8;

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'capture': {
      const q = new URLSearchParams();
      if (route.poster) q.set('poster', route.poster);
      if (route.mode !== 'overview') q.set('mode', route.mode);
      if (route.grid) q.set('grid', route.grid);
      if (route.cell !== undefined) q.set('cell', String(route.cell));
      const s = q.toString();
      return s ? `#/capture?${s}` : '#/';
    }
    case 'adjust':
      return `#/adjust/${route.id}`;
    case 'view':
      return `#/view/${route.id}`;
    case 'library':
      return '#/library';
    case 'poster':
      return `#/poster/${route.id}`;
    case 'settings':
      return '#/settings';
  }
}

/** Where a tap on a shot card goes: captured shots still need adjusting (plan.md finding 14). */
export function routeForShot(shot: { id: string; status: 'captured' | 'rectified' | 'uncorrected' }): Route {
  return shot.status === 'captured' ? { name: 'adjust', id: shot.id } : { name: 'view', id: shot.id };
}

export type ParsedRoute = { ok: true; route: Route } | { ok: false; reason: 'invalid-id' | 'unknown' };

function parseCapture(query: URLSearchParams): Route {
  const poster = query.get('poster');
  const modeRaw = query.get('mode');
  const gridRaw = query.get('grid');
  const cellRaw = query.get('cell');
  const validPoster = poster !== null && isUuidV4(poster) ? poster : undefined;
  const mode: CaptureMode = modeRaw === 'detail' ? 'detail' : 'overview';
  const grid: GridKind | undefined = gridRaw === '2x2' || gridRaw === '3x3' ? gridRaw : undefined;
  let cell: number | undefined;
  if (grid && cellRaw !== null && /^\d+$/.test(cellRaw)) {
    const n = Number(cellRaw);
    const max = grid === '2x2' ? 3 : MAX_GRID_CELL;
    if (n >= 0 && n <= max) cell = n;
  }
  // grid/cell only make sense in detail mode; unknown values fall back to overview, no grid
  if (mode === 'overview') return { name: 'capture', poster: validPoster, mode: 'overview' };
  const route: Route = { name: 'capture', poster: validPoster, mode, grid };
  if (cell !== undefined) route.cell = cell;
  return route;
}

export function parseHash(hash: string): ParsedRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPart = '', queryPart = ''] = raw.split('?', 2);
  const path = pathPart === '' ? '/' : pathPart;
  const parts = path.split('/').filter((p) => p.length > 0);
  const [head, id] = parts;
  if (parts.length === 0 || head === 'capture') {
    if (parts.length > 1) return { ok: false, reason: 'unknown' };
    return { ok: true, route: parseCapture(new URLSearchParams(queryPart)) };
  }
  if (head === 'library' && parts.length === 1) return { ok: true, route: { name: 'library' } };
  if (head === 'settings' && parts.length === 1) return { ok: true, route: { name: 'settings' } };
  if ((head === 'adjust' || head === 'view' || head === 'poster') && parts.length === 2) {
    if (!id || !isUuidV4(id)) return { ok: false, reason: 'invalid-id' };
    return { ok: true, route: { name: head, id } };
  }
  return { ok: false, reason: 'unknown' };
}

export interface Resolution {
  route: Route;
  /** Set when the hash should be replaced. */
  redirectTo?: string;
  /** Toast to show, if any. */
  toast?: string;
}

export const MISSING_TOAST = 'That item no longer exists';

/**
 * Validates ids against the effective store and applies the redirect rules:
 * invalid/missing ids go to the Library with a toast; '#/view/<id>' of a captured shot goes to '#/adjust/<id>'.
 */
export async function resolveRoute(hash: string, store: RouteStore): Promise<Resolution> {
  const library: Route = { name: 'library' };
  const parsed = parseHash(hash);
  if (!parsed.ok) {
    return { route: library, redirectTo: routeToHash(library), toast: parsed.reason === 'invalid-id' ? MISSING_TOAST : undefined };
  }
  const route = parsed.route;
  const missing = (): Resolution => ({ route: library, redirectTo: routeToHash(library), toast: MISSING_TOAST });
  switch (route.name) {
    case 'poster':
      return (await store.exists('poster', route.id)) ? { route } : missing();
    case 'adjust':
      return (await store.exists('shot', route.id)) ? { route } : missing();
    case 'view': {
      const shot = await store.getShot(route.id);
      if (!shot) return missing();
      if (shot.status === 'captured') {
        const target: Route = { name: 'adjust', id: route.id };
        return { route: target, redirectTo: routeToHash(target) };
      }
      return { route };
    }
    case 'capture': {
      if (route.poster && !(await store.exists('poster', route.poster))) {
        const fallback: Route = { name: 'capture', mode: 'overview' };
        return { route: fallback, redirectTo: routeToHash(fallback), toast: MISSING_TOAST };
      }
      return { route };
    }
    default:
      return { route };
  }
}

export interface RouterOptions {
  store: RouteStore;
  /** Mounts the screen for `route` and returns its dispose function. */
  mount(route: Route): Dispose;
  toast(message: string): void;
}

export interface Router {
  start(): void;
  navigate(route: Route, opts?: { replace?: boolean }): void;
  dispose(): void;
}

export function createRouter(opts: RouterOptions): Router {
  let dispose: Dispose | null = null;
  let token = 0;
  let started = false;

  const render = async (): Promise<void> => {
    const my = ++token;
    const res = await resolveRoute(location.hash, opts.store);
    if (my !== token) return; // a newer navigation superseded this one
    if (res.toast) opts.toast(res.toast);
    if (res.redirectTo !== undefined && res.redirectTo !== location.hash) {
      history.replaceState(null, '', res.redirectTo);
    }
    dispose?.();
    dispose = null;
    dispose = opts.mount(res.route);
  };

  const onHashChange = (): void => {
    void render();
  };

  return {
    start() {
      if (started) return;
      started = true;
      window.addEventListener('hashchange', onHashChange);
      void render();
    },
    navigate(route, o) {
      const hash = routeToHash(route);
      if (o?.replace) {
        history.replaceState(null, '', hash);
        void render();
      } else if (location.hash === hash) {
        void render();
      } else {
        location.hash = hash;
      }
    },
    dispose() {
      started = false;
      token++;
      window.removeEventListener('hashchange', onHashChange);
      dispose?.();
      dispose = null;
    },
  };
}
