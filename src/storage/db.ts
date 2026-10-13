// IndexedDB schema via idb (design 2.10). Database 'poster-photos' v1; blobs live in their own store.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, type BlobRecord, type MetaRecord, type PosterRecord, type ShotRecord } from './schema.ts';

export interface PosterDB extends DBSchema {
  posters: { key: string; value: PosterRecord; indexes: { updatedAt: number; createdAt: number } };
  shots: { key: string; value: ShotRecord; indexes: { posterId: string } };
  blobs: { key: string; value: BlobRecord; indexes: { shotId: string } };
  meta: { key: string; value: MetaRecord };
}

export type PosterDbHandle = IDBPDatabase<PosterDB>;

export interface OpenOptions {
  /** Another tab wants to upgrade/delete the database: we close our connection first. */
  onBlocking?: () => void;
  name?: string;
}

export function openPosterDb(opts: OpenOptions = {}): Promise<PosterDbHandle> {
  return openDB<PosterDB>(opts.name ?? DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Future versions add new `case` branches; upgrades never destroy data.
      switch (oldVersion) {
        case 0: {
          const posters = db.createObjectStore('posters', { keyPath: 'id' });
          posters.createIndex('updatedAt', 'updatedAt');
          posters.createIndex('createdAt', 'createdAt');
          const shots = db.createObjectStore('shots', { keyPath: 'id' });
          shots.createIndex('posterId', 'posterId');
          const blobs = db.createObjectStore('blobs', { keyPath: 'key' });
          blobs.createIndex('shotId', 'shotId');
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      }
    },
    blocking() {
      opts.onBlocking?.();
    },
  });
}
