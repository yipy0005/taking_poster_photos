// LRU cache of viewer tiles (tile-mode fallback, design 2.7 item 7). Evicted and cleared bitmaps are CLOSED through their
// BitmapHandle (plan.md finding 14). DOM-free.
import type { BitmapHandle } from '../app/bitmap-handle.ts';

export const TILE_SIZE = 512;
export const TILE_CACHE_CAPACITY = 24;

export class TileCache {
  private readonly map = new Map<string, BitmapHandle>();

  constructor(private readonly capacity = TILE_CACHE_CAPACITY) {}

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Returns the tile and marks it most recently used. */
  get(key: string): BitmapHandle | undefined {
    const h = this.map.get(key);
    if (!h) return undefined;
    this.map.delete(key);
    this.map.set(key, h);
    return h;
  }

  /** Adds a tile (replacing and closing an older one under the same key) and evicts the least recently used beyond capacity. */
  set(key: string, handle: BitmapHandle): void {
    const old = this.map.get(key);
    if (old && old !== handle) old.close();
    this.map.delete(key);
    this.map.set(key, handle);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const evicted = this.map.get(oldest.value);
      this.map.delete(oldest.value);
      evicted?.close();
    }
  }

  clear(): void {
    for (const h of this.map.values()) h.close();
    this.map.clear();
  }
}

export interface TileRef {
  key: string;
  /** Position and size in IMAGE pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tiles of `size` px that intersect the visible image rectangle. */
export function tilesForRect(rect: { sx: number; sy: number; sw: number; sh: number }, imgW: number, imgH: number, size = TILE_SIZE): TileRef[] {
  const c0 = Math.floor(rect.sx / size);
  const r0 = Math.floor(rect.sy / size);
  const c1 = Math.floor((rect.sx + rect.sw - 1) / size);
  const r1 = Math.floor((rect.sy + rect.sh - 1) / size);
  const out: TileRef[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = c * size;
      const y = r * size;
      if (x >= imgW || y >= imgH) continue;
      out.push({ key: `${c},${r}`, x, y, w: Math.min(size, imgW - x), h: Math.min(size, imgH - y) });
    }
  }
  return out;
}
