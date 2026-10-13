// In-memory backend: degraded mode (no IndexedDB) and unit tests.
import type { BlobRecord, PosterRecord, ShotRecord, Snapshot } from './schema.ts';
import { SnapshotStore, type Backend, type StorageEstimate } from './store.ts';

export class MemoryBackend implements Backend {
  readonly posters = new Map<string, PosterRecord>();
  readonly shots = new Map<string, ShotRecord>();
  readonly blobs = new Map<string, BlobRecord>();
  readonly meta = new Map<string, unknown>();

  async getPoster(id: string) {
    return this.posters.get(id);
  }
  async getShot(id: string) {
    return this.shots.get(id);
  }
  async getBlobRecord(key: string) {
    return this.blobs.get(key);
  }
  async listPosters() {
    return Array.from(this.posters.values());
  }
  async listShots() {
    return Array.from(this.shots.values());
  }

  /** Synchronous apply, so it is atomic by construction. */
  apply(s: Snapshot): void {
    for (const p of s.posters) this.posters.set(p.id, p);
    for (const sh of s.shots) this.shots.set(sh.id, sh);
    for (const b of s.blobs) this.blobs.set(b.key, b);
    for (const id of s.deleteShotIds) {
      this.shots.delete(id);
      for (const [key, b] of this.blobs) if (b.shotId === id) this.blobs.delete(key);
    }
    for (const key of s.deleteBlobKeys) this.blobs.delete(key);
    for (const id of s.deletePosterIds) this.posters.delete(id);
  }

  async commit(snapshot: Snapshot): Promise<void> {
    this.apply(snapshot);
  }

  async getMeta<T>(key: string) {
    return this.meta.get(key) as T | undefined;
  }
  async setMeta<T>(key: string, value: T) {
    this.meta.set(key, value);
  }
  async deleteMeta(key: string) {
    this.meta.delete(key);
  }
  async estimate(): Promise<StorageEstimate | null> {
    return null;
  }
  async clearAll() {
    this.posters.clear();
    this.shots.clear();
    this.blobs.clear();
    this.meta.clear();
  }
}

export class MemoryStore extends SnapshotStore {
  readonly mem: MemoryBackend;
  constructor() {
    const backend = new MemoryBackend();
    super(backend);
    this.mem = backend;
  }
}
