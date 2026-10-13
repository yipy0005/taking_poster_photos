// IndexedDB backend: every mutating call is one readwrite transaction (design 2.10).
import { toStorageError } from '../app/errors.ts';
import { log } from '../app/log.ts';
import type { PosterDbHandle } from './db.ts';
import type { BlobRecord, PosterRecord, ShotRecord, Snapshot } from './schema.ts';
import { SnapshotStore, type Backend, type CommitOptions, type StorageEstimate } from './store.ts';

const noop = (): void => {};

export class IdbBackend implements Backend {
  constructor(private readonly db: PosterDbHandle) {}

  getPoster(id: string): Promise<PosterRecord | undefined> {
    return this.db.get('posters', id);
  }
  getShot(id: string): Promise<ShotRecord | undefined> {
    return this.db.get('shots', id);
  }
  getBlobRecord(key: string): Promise<BlobRecord | undefined> {
    return this.db.get('blobs', key);
  }
  listPosters(): Promise<PosterRecord[]> {
    return this.db.getAll('posters');
  }
  listShots(): Promise<ShotRecord[]> {
    return this.db.getAll('shots');
  }

  async commit(snapshot: Snapshot, _opts?: CommitOptions): Promise<void> {
    const tx = this.db.transaction(['posters', 'shots', 'blobs'], 'readwrite');
    try {
      const posters = tx.objectStore('posters');
      const shots = tx.objectStore('shots');
      const blobs = tx.objectStore('blobs');
      // If building the operations throws midway (for example DataCloneError), the transaction aborts and every
      // already-queued request rejects. Attach a no-op handler to each so none surfaces as an unhandled rejection.
      const ops: Promise<unknown>[] = [];
      const queue = (p: Promise<unknown>): void => {
        p.catch(noop);
        ops.push(p);
      };
      tx.done.catch(noop);
      for (const p of snapshot.posters) queue(posters.put(p));
      for (const s of snapshot.shots) queue(shots.put(s));
      for (const b of snapshot.blobs) queue(blobs.put(b));
      for (const id of snapshot.deleteShotIds) {
        queue(shots.delete(id));
        queue(
          (async () => {
            const keys = await blobs.index('shotId').getAllKeys(id);
            for (const k of keys) await blobs.delete(k);
          })(),
        );
      }
      for (const key of snapshot.deleteBlobKeys) queue(blobs.delete(key));
      for (const id of snapshot.deletePosterIds) queue(posters.delete(id));
      await Promise.all([...ops, tx.done]);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // already finished or aborted
      }
      throw toStorageError(e);
    }
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('meta', key))?.value as T | undefined;
  }
  async setMeta<T>(key: string, value: T): Promise<void> {
    try {
      await this.db.put('meta', { key, value });
    } catch (e) {
      throw toStorageError(e);
    }
  }
  async deleteMeta(key: string): Promise<void> {
    await this.db.delete('meta', key);
  }

  async estimate(): Promise<StorageEstimate | null> {
    try {
      const e = await navigator.storage?.estimate?.();
      if (!e || typeof e.usage !== 'number' || typeof e.quota !== 'number') return null;
      return { usage: e.usage, quota: e.quota };
    } catch {
      return null;
    }
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction(['posters', 'shots', 'blobs', 'meta'], 'readwrite');
    await Promise.all([
      tx.objectStore('posters').clear(),
      tx.objectStore('shots').clear(),
      tx.objectStore('blobs').clear(),
      tx.objectStore('meta').clear(),
      tx.done,
    ]);
  }

  /**
   * Startup orphan sweep (2.10 invariants): shots without a poster, blobs without a shot, and dangling
   * ids in poster.shotIds. One transaction. Returns the number of repaired records.
   */
  async sweepOrphans(): Promise<number> {
    const tx = this.db.transaction(['posters', 'shots', 'blobs'], 'readwrite');
    let repaired = 0;
    const [posters, shots, blobKeys] = await Promise.all([
      tx.objectStore('posters').getAll(),
      tx.objectStore('shots').getAll(),
      tx.objectStore('blobs').getAll(),
    ]);
    const posterIds = new Set(posters.map((p) => p.id));
    const liveShots = new Set<string>();
    for (const s of shots) {
      if (posterIds.has(s.posterId)) liveShots.add(s.id);
      else {
        await tx.objectStore('shots').delete(s.id);
        repaired++;
      }
    }
    for (const b of blobKeys) {
      if (!liveShots.has(b.shotId)) {
        await tx.objectStore('blobs').delete(b.key);
        repaired++;
      }
    }
    for (const p of posters) {
      const ids = p.shotIds.filter((id) => liveShots.has(id));
      if (ids.length !== p.shotIds.length) {
        const cover = p.coverShotId && ids.includes(p.coverShotId) ? p.coverShotId : ids[0];
        await tx.objectStore('posters').put({ ...p, shotIds: ids, coverShotId: cover });
        repaired++;
      }
    }
    await tx.done;
    if (repaired > 0) log.warn(`orphan sweep repaired ${repaired} record(s)`);
    return repaired;
  }
}

export class IdbStore extends SnapshotStore {
  readonly idb: IdbBackend;
  constructor(db: PosterDbHandle) {
    const backend = new IdbBackend(db);
    super(backend);
    this.idb = backend;
  }
}
