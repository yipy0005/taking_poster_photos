import { describe, expect, it } from 'vitest';
import { parseHash, resolveRoute, routeForShot, routeToHash, type RouteStore } from './router.ts';

const P = '3f2504e0-4f89-4d3d-9a0c-0305e82c3301';
const S1 = '3f2504e0-4f89-4d3d-9a0c-0305e82c3302';
const S2 = '3f2504e0-4f89-4d3d-9a0c-0305e82c3303';

function store(shots: Record<string, 'captured' | 'rectified' | 'uncorrected'>, posters: string[] = [P]): RouteStore {
  return {
    exists: async (kind, id) => (kind === 'poster' ? posters.includes(id) : id in shots),
    getShot: async (id) => (shots[id] ? { id, status: shots[id]! } : null),
  };
}

describe('parseHash', () => {
  it('maps the empty hash and #/ to capture (overview)', () => {
    expect(parseHash('')).toEqual({ ok: true, route: { name: 'capture', poster: undefined, mode: 'overview' } });
    expect(parseHash('#/')).toMatchObject({ ok: true, route: { name: 'capture', mode: 'overview' } });
  });
  it('validates capture query values and falls back to overview/no grid', () => {
    expect(parseHash(`#/capture?poster=${P}&mode=detail&grid=3x3&cell=4`)).toEqual({
      ok: true,
      route: { name: 'capture', poster: P, mode: 'detail', grid: '3x3', cell: 4 },
    });
    expect(parseHash('#/capture?mode=weird&grid=9x9&cell=99')).toEqual({ ok: true, route: { name: 'capture', poster: undefined, mode: 'overview' } });
    expect(parseHash('#/capture?mode=detail&grid=2x2&cell=7')).toEqual({ ok: true, route: { name: 'capture', poster: undefined, mode: 'detail', grid: '2x2' } });
    expect(parseHash('#/capture?poster=not-a-uuid')).toEqual({ ok: true, route: { name: 'capture', poster: undefined, mode: 'overview' } });
  });
  it('parses id routes and rejects non-v4 ids', () => {
    expect(parseHash(`#/adjust/${S1}`)).toEqual({ ok: true, route: { name: 'adjust', id: S1 } });
    expect(parseHash(`#/view/${S1}`)).toEqual({ ok: true, route: { name: 'view', id: S1 } });
    expect(parseHash(`#/poster/${P}`)).toEqual({ ok: true, route: { name: 'poster', id: P } });
    expect(parseHash('#/view/123')).toEqual({ ok: false, reason: 'invalid-id' });
    expect(parseHash('#/view/')).toEqual({ ok: false, reason: 'unknown' });
    expect(parseHash('#/nope')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('round-trips through routeToHash', () => {
    for (const h of ['#/library', '#/settings', `#/adjust/${S1}`, `#/view/${S1}`, `#/poster/${P}`, `#/capture?poster=${P}&mode=detail&grid=2x2&cell=1`]) {
      const parsed = parseHash(h);
      expect(parsed.ok && routeToHash(parsed.route)).toBe(h);
    }
  });
});

describe('resolveRoute', () => {
  const s = store({ [S1]: 'captured', [S2]: 'rectified' });
  it('finding 14: #/view of a captured shot redirects to #/adjust', async () => {
    expect(await resolveRoute(`#/view/${S1}`, s)).toEqual({ route: { name: 'adjust', id: S1 }, redirectTo: `#/adjust/${S1}` });
    expect(await resolveRoute(`#/view/${S2}`, s)).toEqual({ route: { name: 'view', id: S2 } });
  });
  it('missing or invalid ids go to the library with a toast', async () => {
    const missing = '3f2504e0-4f89-4d3d-9a0c-0305e82c3399';
    for (const h of [`#/adjust/${missing}`, `#/view/${missing}`, `#/poster/${missing}`, '#/view/oops']) {
      expect(await resolveRoute(h, s)).toEqual({ route: { name: 'library' }, redirectTo: '#/library', toast: 'That item no longer exists' });
    }
  });
  it('unknown routes redirect to the library without a toast', async () => {
    expect(await resolveRoute('#/zzz', s)).toEqual({ route: { name: 'library' }, redirectTo: '#/library', toast: undefined });
  });
  it('capture with an unknown poster falls back to a new overview capture', async () => {
    const res = await resolveRoute('#/capture?poster=3f2504e0-4f89-4d3d-9a0c-0305e82c3399', s);
    expect(res.route).toEqual({ name: 'capture', mode: 'overview' });
    expect(res.toast).toBe('That item no longer exists');
  });
  it('routeForShot sends captured shots to Adjust and others to View', () => {
    expect(routeForShot({ id: S1, status: 'captured' })).toEqual({ name: 'adjust', id: S1 });
    expect(routeForShot({ id: S1, status: 'uncorrected' })).toEqual({ name: 'view', id: S1 });
  });
});
