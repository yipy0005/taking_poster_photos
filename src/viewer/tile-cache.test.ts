import { beforeEach, describe, expect, it } from 'vitest';
import { bitmapTracker } from '../app/bitmap-handle.ts';
import { fakeHandle } from './testing/fakes.ts';
import { TILE_CACHE_CAPACITY, TILE_SIZE, TileCache, tilesForRect } from './tile-cache.ts';

beforeEach(() => bitmapTracker.reset());

describe('TileCache (LRU, evicted bitmaps are closed through BitmapHandle)', () => {
  it('holds at most 24 tiles by default', () => {
    expect(TILE_CACHE_CAPACITY).toBe(24);
    const c = new TileCache();
    const handles = Array.from({ length: 30 }, (_, i) => fakeHandle(512, 512, `t${i}`));
    handles.forEach((h, i) => c.set(`k${i}`, h));
    expect(c.size).toBe(24);
    expect(handles.slice(0, 6).every((h) => h.closed)).toBe(true);
    expect(handles.slice(6).every((h) => !h.closed)).toBe(true);
    expect(bitmapTracker.liveCount()).toBe(24);
  });
  it('evicts the least recently used tile; get() refreshes recency', () => {
    const c = new TileCache(3);
    const [a, b, d, e] = [fakeHandle(8, 8), fakeHandle(8, 8), fakeHandle(8, 8), fakeHandle(8, 8)] as const;
    c.set('a', a);
    c.set('b', b);
    c.set('d', d);
    expect(c.get('a')).toBe(a); // a is now newest
    c.set('e', e);
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
  });
  it('closes the old bitmap when a key is replaced', () => {
    const c = new TileCache(3);
    const old = fakeHandle(8, 8);
    const fresh = fakeHandle(8, 8);
    c.set('a', old);
    c.set('a', fresh);
    expect(old.closed).toBe(true);
    expect(fresh.closed).toBe(false);
    expect(c.size).toBe(1);
    // re-setting the same handle does not close it
    c.set('a', fresh);
    expect(fresh.closed).toBe(false);
  });
  it('clear() closes everything', () => {
    const c = new TileCache();
    const hs = [fakeHandle(8, 8), fakeHandle(8, 8)];
    hs.forEach((h, i) => c.set(String(i), h));
    c.clear();
    expect(hs.every((h) => h.closed)).toBe(true);
    expect(c.size).toBe(0);
    expect(bitmapTracker.liveCount()).toBe(0);
  });
});

describe('tilesForRect', () => {
  it('lists the 512 px tiles that intersect the rectangle and clips the last ones', () => {
    const t = tilesForRect({ sx: 500, sy: 0, sw: 600, sh: 100 }, 1100, 700);
    expect(t.map((x) => x.key)).toEqual(['0,0', '1,0', '2,0']);
    expect(t[2]).toMatchObject({ x: 1024, y: 0, w: 76, h: 512 });
    expect(TILE_SIZE).toBe(512);
  });
  it('skips tiles outside the image', () => {
    expect(tilesForRect({ sx: 0, sy: 0, sw: 2000, sh: 2000 }, 512, 512)).toHaveLength(1);
  });
});
