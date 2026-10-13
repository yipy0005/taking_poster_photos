import 'fake-indexeddb/auto'; // installs the IDB* globals that idb relies on
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageFullError, StorageError, ValidationError } from '../app/errors.ts';
import type { Quad } from '../cv/geometry.ts';
import { openPosterDb, type PosterDbHandle } from './db.ts';
import { IdbBackend, IdbStore } from './idb-store.ts';
import { MemoryStore } from './memory-store.ts';
import { emptySnapshot, type NewShot, type RectificationResult, type Snapshot } from './schema.ts';
import { SessionOverlayStore } from './session-overlay-store.ts';
import { searchPosters } from './search.ts';
import { SnapshotStore, type Backend, type CommitOptions, type Store } from './store.ts';

const QUAD: Quad = [
  [300, 200],
  [2700, 220],
  [2650, 1800],
  [280, 1780],
];

const blob = (text: string, type = 'image/jpeg') => new Blob([text], { type });
const text = async (b: Blob | null) => (b ? await b.text() : null);

function newShot(over: Partial<NewShot> = {}): NewShot {
  return {
    kind: 'overview',
    source: 'file-gallery',
    width: 4000,
    height: 3000,
    originalMime: 'image/jpeg',
    originalBytes: 8,
    ...over,
  };
}

function rectification(over: Partial<RectificationResult> = {}): RectificationResult {
  return {
    blob: blob('RECT'),
    mime: 'image/jpeg',
    width: 3000,
    height: 2000,
    thumb: blob('THUMB2'),
    corners: QUAD,
    cornersSource: 'manual',
    aspectMode: 'auto',
    aspectUsed: 1.5,
    snappedTo: null,
    enhance: { autoContrast: false, whiteBalance: false, sharpen: false },
    engine: 'js',
    ...over,
  };
}

/** Fails commits on demand with a QuotaExceededError (or a generic abort). */
class FaultyBackend implements Backend {
  fault: 'none' | 'quota' | 'abort' = 'none';
  constructor(readonly inner: IdbBackend) {}
  getPoster = (id: string) => this.inner.getPoster(id);
  getShot = (id: string) => this.inner.getShot(id);
  getBlobRecord = (k: string) => this.inner.getBlobRecord(k);
  listPosters = () => this.inner.listPosters();
  listShots = () => this.inner.listShots();
  getMeta = <T>(k: string) => this.inner.getMeta<T>(k);
  setMeta = <T>(k: string, v: T) => this.inner.setMeta(k, v);
  deleteMeta = (k: string) => this.inner.deleteMeta(k);
  estimate = () => this.inner.estimate();
  clearAll = () => this.inner.clearAll();
  async commit(s: Snapshot, o?: CommitOptions): Promise<void> {
    if (this.fault === 'quota') throw new StorageFullError('Storage is full', { cause: new DOMException('quota', 'QuotaExceededError') });
    if (this.fault === 'abort') throw new StorageError('Could not save');
    return this.inner.commit(s, o);
  }
}

async function freshDb(): Promise<PosterDbHandle> {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  return openPosterDb();
}

/** Same behavioural contract for the IDB-backed and memory-backed stores. */
function contract(name: string, make: () => Promise<Store>) {
  describe(`${name}: store contract`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await make();
    });

    it('creates a poster with its overview shot: status captured, auto aspect, no thumb, original stored', async () => {
      const { posterId, shotId } = await store.createPosterWithShot({ title: '  My poster  ', tags: ['B', 'a', 'b'] }, newShot(), blob('ORIG'));
      const detail = await store.getPoster(posterId);
      expect(detail?.poster).toMatchObject({ title: 'My poster', tags: ['b', 'a'], shotIds: [shotId], coverShotId: shotId });
      const shot = detail!.shots[0]!;
      expect(shot).toMatchObject({ status: 'captured', corners: null, aspectMode: 'auto', rotation: 0, kind: 'overview' });
      expect(shot.thumb).toBeUndefined();
      expect(await text(await store.getBlob(shotId, 'original'))).toBe('ORIG');
      expect(await store.getBlob(shotId, 'rectified')).toBeNull();
      expect(await store.exists('poster', posterId)).toBe(true);
      expect(await store.exists('shot', shotId)).toBe(true);
      expect(await store.exists('shot', 'nope')).toBe(false);
    });

    it('uses a default title and rejects invalid metadata', async () => {
      const { posterId } = await store.createPosterWithShot({}, newShot(), blob('x'));
      expect((await store.getPoster(posterId))!.poster.title).toMatch(/^Poster \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      await expect(store.updatePosterMeta(posterId, { title: 'x'.repeat(121) })).rejects.toBeInstanceOf(ValidationError);
      await expect(store.updatePosterMeta(posterId, { notes: 'x'.repeat(2001) })).rejects.toBeInstanceOf(ValidationError);
      await expect(store.updatePosterMeta(posterId, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).rejects.toThrow('Up to 20 tags');
      await store.updatePosterMeta(posterId, { title: 'Renamed', conference: ' ACS ', tags: 'Alpha, beta  alpha', notes: 'n' });
      const p = (await store.getPoster(posterId))!.poster;
      expect(p).toMatchObject({ title: 'Renamed', conference: 'ACS', tags: ['alpha', 'beta'], notes: 'n' });
      await store.updatePosterMeta(posterId, { conference: null });
      expect((await store.getPoster(posterId))!.poster.conference).toBeUndefined();
    });

    it('addShot keeps overview first and detail aspect defaults to free', async () => {
      const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('o'));
      const d1 = await store.addShot(posterId, newShot({ kind: 'detail', gridCell: { rows: 2, cols: 2, row: 0, col: 1 } }), blob('d1'));
      const d2 = await store.addShot(posterId, newShot({ kind: 'detail' }), blob('d2'));
      const detail = (await store.getPoster(posterId))!;
      expect(detail.poster.shotIds).toEqual([shotId, d1, d2]);
      expect(detail.shots[1]).toMatchObject({ kind: 'detail', aspectMode: 'free', gridCell: { row: 0, col: 1 } });
      await expect(store.addShot('missing', newShot(), blob('x'))).rejects.toBeInstanceOf(StorageError);
    });

    it('stores dimsPending and oversize flags', async () => {
      const { shotId } = await store.createPosterWithShot({}, newShot({ width: 0, height: 0, dimsPending: true, oversize: true }), blob('x'));
      expect(await store.getShot(shotId)).toMatchObject({ width: 0, height: 0, dimsPending: true, oversize: true });
      await store.updateShotParams(shotId, { width: 5000, height: 4000, dimsPending: false });
      const s = (await store.getShot(shotId))!;
      expect(s).toMatchObject({ width: 5000, height: 4000 });
      expect(s.dimsPending).toBeUndefined();
    });

    it('listShotsMissingThumb and setThumb', async () => {
      const a = await store.createPosterWithShot({}, newShot(), blob('a'));
      const b = await store.createPosterWithShot({}, newShot(), blob('b'));
      expect((await store.listShotsMissingThumb()).sort()).toEqual([a.shotId, b.shotId].sort());
      const changed = vi.fn();
      const off = store.onChange(changed);
      await store.setThumb(a.shotId, blob('T'));
      expect(changed).toHaveBeenCalledTimes(1);
      off();
      expect(await store.listShotsMissingThumb()).toEqual([b.shotId]);
      await store.setThumb('gone', blob('T')); // no-op, no throw
      const summaries = await store.listPosters();
      expect(await text(summaries.find((p) => p.id === a.posterId)!.coverThumb ?? null)).toBe('T');
    });

    it('updateShotParams validates and persists corners, aspect, enhance and rotation', async () => {
      const { shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
      await store.updateShotParams(shotId, {
        corners: QUAD,
        cornersSource: 'manual',
        aspectMode: '4:3',
        enhance: { autoContrast: true, whiteBalance: false, sharpen: false },
        rotation: 90,
      });
      expect(await store.getShot(shotId)).toMatchObject({ corners: QUAD, aspectMode: '4:3', rotation: 90, enhance: { autoContrast: true } });
      const bad = [[0, 0], [1, 0], [Number.NaN, 1], [0, 1]] as unknown as Quad;
      await expect(store.updateShotParams(shotId, { corners: bad })).rejects.toBeInstanceOf(ValidationError);
      await expect(store.updateShotParams(shotId, { rotation: 45 as never })).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects corners that are structurally fine but invalid in original pixels (outside, too small, bow-tie)', async () => {
      const { shotId } = await store.createPosterWithShot({}, newShot(), blob('x')); // 4000x3000
      const outside: Quad = [[300, 200], [4100, 220], [2650, 1800], [280, 1780]];
      const tiny: Quad = [[10, 10], [90, 12], [88, 70], [8, 68]];
      const bowTie: Quad = [[300, 200], [2650, 1800], [2700, 220], [280, 1780]];
      for (const corners of [outside, tiny, bowTie]) {
        await expect(store.updateShotParams(shotId, { corners })).rejects.toBeInstanceOf(ValidationError);
      }
      expect((await store.getShot(shotId))?.corners).toBeNull();
    });
    it('AC-44: captured -> uncorrected -> rectified -> uncorrected keeps one untouched original and no rectified blob', async () => {
      const { shotId } = await store.createPosterWithShot({}, newShot(), blob('ORIGINAL-BYTES'));
      const originalHash = await text(await store.getBlob(shotId, 'original'));

      await store.keepUncorrected(shotId);
      expect(await store.getShot(shotId)).toMatchObject({ status: 'uncorrected', corners: null });

      await store.saveRectification(shotId, rectification());
      let shot = (await store.getShot(shotId))!;
      expect(shot).toMatchObject({ status: 'rectified', rectifiedWidth: 3000, rectifiedHeight: 2000, engine: 'js' });
      expect(await text(shot.thumb ?? null)).toBe('THUMB2');
      expect(await text(await store.getBlob(shotId, 'rectified'))).toBe('RECT');

      await store.keepUncorrected(shotId);
      shot = (await store.getShot(shotId))!;
      expect(shot).toMatchObject({ status: 'uncorrected', corners: null, cornersSource: 'default' });
      expect(shot.thumb).toBeUndefined();
      expect(shot.rectifiedWidth).toBeUndefined();
      expect(shot.engine).toBeUndefined();
      expect(await store.getBlob(shotId, 'rectified')).toBeNull();
      expect(await text(await store.getBlob(shotId, 'original'))).toBe(originalHash);
    });

    it('saveRectification rejects malformed corners and unknown shots', async () => {
      const { shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
      await expect(store.saveRectification(shotId, rectification({ corners: [[0, 0]] as never }))).rejects.toBeInstanceOf(ValidationError);
      await expect(store.saveRectification('missing', rectification())).rejects.toBeInstanceOf(StorageError);
    });

    it('deleteShot removes the shot, its blobs and its poster reference, and fixes the cover', async () => {
      const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('o'));
      const d = await store.addShot(posterId, newShot({ kind: 'detail' }), blob('d'));
      await store.saveRectification(shotId, rectification());
      await store.deleteShot(shotId);
      expect(await store.exists('shot', shotId)).toBe(false);
      expect(await store.getBlob(shotId, 'original')).toBeNull();
      expect(await store.getBlob(shotId, 'rectified')).toBeNull();
      const detail = (await store.getPoster(posterId))!;
      expect(detail.poster).toMatchObject({ shotIds: [d], coverShotId: d });
    });

    it('deletePoster removes everything of the poster and prunes its memory strikes', async () => {
      const a = await store.createPosterWithShot({}, newShot(), blob('a'));
      const dA = await store.addShot(a.posterId, newShot({ kind: 'detail' }), blob('da'));
      const b = await store.createPosterWithShot({}, newShot(), blob('b'));
      await store.setMeta('memoryStrikes', { [`${a.shotId}:render`]: 1, [`${b.shotId}:render`]: 2 });
      await store.deletePoster(a.posterId);
      for (const id of [a.shotId, dA]) {
        expect(await store.exists('shot', id)).toBe(false);
        expect(await store.getBlob(id, 'original')).toBeNull();
      }
      expect(await store.exists('poster', a.posterId)).toBe(false);
      expect(await store.exists('poster', b.posterId)).toBe(true);
      expect(await store.getMeta('memoryStrikes')).toEqual({ [`${b.shotId}:render`]: 2 });
    });

    it('listPosters summaries: sorted by recency, shot counts and needsAdjust', async () => {
      const a = await store.createPosterWithShot({ title: 'A' }, newShot(), blob('a'));
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.createPosterWithShot({ title: 'B' }, newShot(), blob('b'));
      await store.saveRectification(b.shotId, rectification());
      const list = await store.listPosters();
      expect(list.map((p) => p.title)).toEqual(['B', 'A']);
      expect(list.find((p) => p.id === a.posterId)).toMatchObject({ shotCount: 1, needsAdjustCount: 1 });
      expect(list.find((p) => p.id === b.posterId)).toMatchObject({ shotCount: 1, needsAdjustCount: 0 });
    });

    it('meta store round-trips and clearAll wipes everything', async () => {
      await store.setMeta('lastConference', { v: 'ACS' });
      expect(await store.getMeta('lastConference')).toEqual({ v: 'ACS' });
      await store.deleteMeta('lastConference');
      expect(await store.getMeta('lastConference')).toBeUndefined();
      const { shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
      await store.clearAll();
      expect(await store.listPosters()).toEqual([]);
      expect(await store.getBlob(shotId, 'original')).toBeNull();
    });
  });
}

contract('IdbStore', async () => new IdbStore(await freshDb()));
contract('MemoryStore', async () => new MemoryStore());
contract('SessionOverlayStore over IdbStore', async () => new SessionOverlayStore(new IdbBackend(await freshDb())));

describe('stored quads are validated against the image size on read', () => {
  it('resets an invalid stored quad to null (getShot and getPoster)', async () => {
    const store = new MemoryStore();
    const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
    const shot = (await store.getShot(shotId))!;
    const snap = emptySnapshot();
    snap.shots.push({ ...shot, corners: [[0, 0], [5, 0], [5, 5], [0, 5]], cornersSource: 'manual' });
    await store.mem.commit(snap);
    expect(await store.getShot(shotId)).toMatchObject({ corners: null, cornersSource: 'default' });
    expect((await store.getPoster(posterId))?.shots[0]).toMatchObject({ corners: null });
    snap.shots[0] = { ...shot, corners: QUAD, cornersSource: 'manual' };
    await store.mem.commit(snap);
    expect((await store.getShot(shotId))?.corners).toEqual(QUAD);
  });
});
describe('AC-24: deletes are atomic', () => {
  it('deletePoster uses exactly one transaction over posters, shots and blobs', async () => {
    const db = await freshDb();
    let transactions = 0;
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...args: Parameters<PosterDbHandle['transaction']>) => {
            transactions++;
            return target.transaction(...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const store = new IdbStore(counting);
    const { posterId } = await store.createPosterWithShot({}, newShot(), blob('a'));
    await store.addShot(posterId, newShot({ kind: 'detail' }), blob('b'));
    await store.addShot(posterId, newShot({ kind: 'detail' }), blob('c'));
    transactions = 0;
    await store.deletePoster(posterId);
    expect(transactions).toBe(1);
    expect(await db.count('posters')).toBe(0);
    expect(await db.count('shots')).toBe(0);
    expect(await db.count('blobs')).toBe(0);
  });

  it('a failing transaction leaves no partial records', async () => {
    const db = await freshDb();
    const store = new IdbStore(db);
    // a function cannot be structured-cloned: the blob put throws after the poster and shot puts were queued
    await expect(store.createPosterWithShot({}, newShot(), (() => {}) as unknown as Blob)).rejects.toBeInstanceOf(StorageError);
    expect(await db.count('posters')).toBe(0);
    expect(await db.count('shots')).toBe(0);
    expect(await db.count('blobs')).toBe(0);
  });
});

describe('AC-31: storage full keeps the photo usable through the session overlay', () => {
  let faulty: FaultyBackend;
  let store: SessionOverlayStore;
  let failures: StorageError[];

  beforeEach(async () => {
    failures = [];
    faulty = new FaultyBackend(new IdbBackend(await freshDb()));
    store = new SessionOverlayStore(faulty, { onSaveFailed: (e) => failures.push(e) });
  });

  it('a quota error on createPosterWithShot leaves IndexedDB empty but the item fully usable and marked unsaved', async () => {
    faulty.fault = 'quota';
    const { posterId, shotId } = await store.createPosterWithShot({ title: 'Big' }, newShot(), blob('ORIG'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(StorageFullError);
    expect(await faulty.inner.listPosters()).toEqual([]);
    expect(await faulty.inner.listShots()).toEqual([]);

    // router existence check, reads and list see the unsaved item
    expect(await store.exists('shot', shotId)).toBe(true);
    expect(await store.exists('poster', posterId)).toBe(true);
    expect((await store.listPosters()).map((p) => p.title)).toEqual(['Big']);
    expect(await text(await store.getBlob(shotId, 'original'))).toBe('ORIG');
    expect(store.unsavedIds().has(shotId)).toBe(true);
    expect(store.unsavedIds().has(posterId)).toBe(true);

    // Adjust / rectify / View all work against the overlay
    await store.updateShotParams(shotId, { corners: QUAD, cornersSource: 'manual' });
    await store.saveRectification(shotId, rectification());
    expect(await store.getShot(shotId)).toMatchObject({ status: 'rectified' });
    expect(await text(await store.getBlob(shotId, 'rectified'))).toBe('RECT');
    expect(await faulty.inner.listShots()).toEqual([]);

    // Retry fails while the fault persists and keeps the data
    expect(await store.retrySave(shotId)).toEqual({ saved: [], failed: expect.arrayContaining([posterId, shotId]) });
    expect(store.unsavedIds().size).toBe(2);

    // Space is available again: retry persists everything in IndexedDB and empties the overlay
    faulty.fault = 'none';
    const res = await store.retrySave(shotId);
    expect(res.failed).toEqual([]);
    expect(res.saved).toEqual(expect.arrayContaining([posterId, shotId]));
    expect(store.unsavedIds().size).toBe(0);
    expect(await faulty.inner.listShots()).toHaveLength(1);
    expect(await text((await faulty.inner.getBlobRecord(`${shotId}/rectified`))?.blob ?? null)).toBe('RECT');
    expect(await faulty.inner.getShot(shotId)).toMatchObject({ status: 'rectified' });
  });

  it('a generic write failure behaves the same (StorageError)', async () => {
    faulty.fault = 'abort';
    const { shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
    expect(failures[0]).toBeInstanceOf(StorageError);
    expect(store.unsavedIds().has(shotId)).toBe(true);
  });

  it('a failed write on an already saved shot is copy-on-write: the saved record is untouched until retry', async () => {
    const { shotId } = await store.createPosterWithShot({}, newShot(), blob('ORIG'));
    faulty.fault = 'quota';
    await store.saveRectification(shotId, rectification());
    expect((await faulty.inner.getShot(shotId))!.status).toBe('captured');
    expect((await store.getShot(shotId))!.status).toBe('rectified');
    expect(store.unsavedIds().has(shotId)).toBe(true);
    faulty.fault = 'none';
    await store.retrySave();
    expect((await faulty.inner.getShot(shotId))!.status).toBe('rectified');
    expect(await text(await store.getBlob(shotId, 'original'))).toBe('ORIG');
    expect(store.unsavedIds().size).toBe(0);
  });

  it('a failed thumbnail write is swallowed and does not mark a saved shot unsaved', async () => {
    const { shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
    faulty.fault = 'quota';
    await store.setThumb(shotId, blob('T'));
    expect(store.unsavedIds().size).toBe(0);
    expect(failures).toEqual([]);
  });

  it('refuses new shots beyond the unsaved limit without losing earlier ones', async () => {
    faulty.fault = 'quota';
    const small = new SessionOverlayStore(faulty, { maxUnsavedShots: 2 });
    await small.createPosterWithShot({}, newShot(), blob('1'));
    await small.createPosterWithShot({}, newShot(), blob('2'));
    await expect(small.createPosterWithShot({}, newShot(), blob('3'))).rejects.toBeInstanceOf(StorageFullError);
    expect((await small.listPosters()).length).toBe(2);
  });

  it('discardUnsaved drops an unsaved poster with its shots and blobs', async () => {
    faulty.fault = 'quota';
    const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
    await store.discardUnsaved(posterId);
    expect(await store.exists('poster', posterId)).toBe(false);
    expect(await store.getBlob(shotId, 'original')).toBeNull();
    expect(store.unsavedIds().size).toBe(0);
  });

  it('discardUnsaved of one unsaved shot keeps the saved poster and its saved shots', async () => {
    const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('o'));
    faulty.fault = 'quota';
    const d = await store.addShot(posterId, newShot({ kind: 'detail' }), blob('d'));
    expect((await store.getPoster(posterId))!.poster.shotIds).toEqual([shotId, d]);
    await store.discardUnsaved(d);
    expect((await store.getPoster(posterId))!.poster.shotIds).toEqual([shotId]);
    expect(store.unsavedIds().size).toBe(0);
    expect(await store.exists('shot', d)).toBe(false);
  });

  it('deleting an unsaved shot removes it from the overlay only', async () => {
    faulty.fault = 'quota';
    const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('x'));
    await store.deletePoster(posterId);
    expect(await store.exists('shot', shotId)).toBe(false);
    expect(store.unsavedIds().size).toBe(0);
  });
});

describe('AC-32: IndexedDB unavailable -> session-only mode', () => {
  it('MemoryStore behind the overlay works for a full capture-to-rectify flow', async () => {
    const store = new SessionOverlayStore(new MemoryStore().mem);
    const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('ORIG'));
    await store.saveRectification(shotId, rectification());
    expect((await store.listPosters())[0]).toMatchObject({ id: posterId, shotCount: 1 });
    expect(store.unsavedIds().size).toBe(0); // no per-item badge in degraded mode
    expect(await store.estimate()).toBeNull();
  });
});

describe('startup orphan sweep', () => {
  it('removes shots without a poster, blobs without a shot and dangling shot ids', async () => {
    const db = await freshDb();
    const store = new IdbStore(db);
    const { posterId, shotId } = await store.createPosterWithShot({}, newShot(), blob('keep'));
    await db.put('shots', { ...(await db.get('shots', shotId))!, id: 'orphan-shot', posterId: 'missing-poster' });
    await db.put('blobs', { key: 'orphan-shot/original', shotId: 'orphan-shot', kind: 'original', blob: blob('o'), mime: '', bytes: 1 });
    await db.put('blobs', { key: 'ghost/original', shotId: 'ghost', kind: 'original', blob: blob('g'), mime: '', bytes: 1 });
    const poster = (await db.get('posters', posterId))!;
    await db.put('posters', { ...poster, shotIds: [...poster.shotIds, 'ghost-shot'] });
    expect(await store.idb.sweepOrphans()).toBe(4);
    expect(await db.count('shots')).toBe(1);
    expect(await db.count('blobs')).toBe(1);
    expect((await db.get('posters', posterId))!.shotIds).toEqual([shotId]);
    expect(await store.idb.sweepOrphans()).toBe(0);
  });
});

describe('persistence across reopen', () => {
  it('data written through one connection is visible after reopening the database', async () => {
    const db = await freshDb();
    const { shotId } = await new IdbStore(db).createPosterWithShot({ title: 'Persist' }, newShot(), blob('ORIG'));
    db.close();
    const again = new IdbStore(await openPosterDb());
    expect((await again.listPosters())[0]?.title).toBe('Persist');
    expect(await text(await again.getBlob(shotId, 'original'))).toBe('ORIG');
  });
});

describe('AC-25: search', () => {
  it('filters by title, conference, tags and notes case-insensitively, 500 posters in < 150 ms', async () => {
    const store: SnapshotStore = new MemoryStore();
    for (let i = 0; i < 500; i++) {
      await store.createPosterWithShot(
        { title: `Poster ${i}`, conference: i % 50 === 0 ? 'Gordon Research Conference' : 'ACS Fall', tags: [i % 7 === 0 ? 'Proteomics' : 'chem'], notes: i === 321 ? 'Needle in a haystack' : '' },
        newShot(),
        blob('x'),
      );
    }
    const all = await store.listPosters();
    expect(all).toHaveLength(500);

    const t0 = performance.now();
    const byConf = searchPosters(all, 'gordon');
    const byTag = searchPosters(all, 'PROTEOMICS');
    const byNotes = searchPosters(all, 'haystack');
    const byTitle = searchPosters(all, 'poster 499');
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(150);
    expect(byConf).toHaveLength(10);
    expect(byTag.length).toBe(Math.ceil(500 / 7));
    expect(byNotes).toHaveLength(1);
    expect(byTitle.map((p) => p.title)).toEqual(['Poster 499']);
    expect(searchPosters(all, '   ')).toHaveLength(500);
    expect(searchPosters(all, '.*')).toHaveLength(0); // plain substring, never a regex
    expect(searchPosters(all, 'a'.repeat(300))).toHaveLength(0); // truncated to 100 chars, still no match
  });
});
