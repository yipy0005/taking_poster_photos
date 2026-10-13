// SessionOverlayStore: the store the app actually uses (design 2.10). Wraps a real Backend (IndexedDB, or memory in
// degraded mode) with a copy-on-write in-memory overlay so a failed write never loses a photo in-session.
import { MAX_UNSAVED_SHOTS } from '../app/config.ts';
import { StorageError, StorageFullError } from '../app/errors.ts';
import { log } from '../app/log.ts';
import type { BlobRecord, PosterRecord, ShotRecord, Snapshot } from './schema.ts';
import { SnapshotStore, type Backend, type CommitOptions, type StorageEstimate } from './store.ts';

export interface OverlayOptions {
  /** Called when a write failed and the data went to the overlay instead (the UI shows "Storage full" once). */
  onSaveFailed?: (error: StorageError) => void;
  maxUnsavedShots?: number;
}

function mergeById<T extends { id: string }>(base: T[], overlay: Map<string, T>): T[] {
  const out = base.map((r) => overlay.get(r.id) ?? r);
  const seen = new Set(base.map((r) => r.id));
  for (const r of overlay.values()) if (!seen.has(r.id)) out.push(r);
  return out;
}

export class OverlayBackend implements Backend {
  readonly posters = new Map<string, PosterRecord>();
  readonly shots = new Map<string, ShotRecord>();
  readonly blobs = new Map<string, BlobRecord>();
  readonly unsaved = new Set<string>();

  constructor(
    private readonly base: Backend,
    private readonly opts: OverlayOptions,
  ) {}

  // ---- reads: overlay first, then the base ----
  async getPoster(id: string) {
    return this.posters.get(id) ?? (await this.base.getPoster(id));
  }
  async getShot(id: string) {
    return this.shots.get(id) ?? (await this.base.getShot(id));
  }
  async getBlobRecord(key: string) {
    return this.blobs.get(key) ?? (await this.base.getBlobRecord(key));
  }
  async listPosters() {
    return mergeById(await this.base.listPosters(), this.posters);
  }
  async listShots() {
    return mergeById(await this.base.listShots(), this.shots);
  }

  getMeta<T>(key: string) {
    return this.base.getMeta<T>(key);
  }
  setMeta<T>(key: string, value: T) {
    return this.base.setMeta(key, value);
  }
  deleteMeta(key: string) {
    return this.base.deleteMeta(key);
  }
  estimate(): Promise<StorageEstimate | null> {
    return this.base.estimate();
  }
  async clearAll() {
    this.posters.clear();
    this.shots.clear();
    this.blobs.clear();
    this.unsaved.clear();
    await this.base.clearAll();
  }

  // ---- writes ----
  private touchedIds(s: Snapshot): string[] {
    return [
      ...s.posters.map((p) => p.id),
      ...s.shots.map((x) => x.id),
      ...s.deleteShotIds,
      ...s.deletePosterIds,
    ];
  }

  private purgeShot(id: string): void {
    this.shots.delete(id);
    for (const [key, b] of this.blobs) if (b.shotId === id) this.blobs.delete(key);
    this.unsaved.delete(id);
  }

  private applyToOverlay(s: Snapshot): void {
    for (const p of s.posters) {
      this.posters.set(p.id, p);
      this.unsaved.add(p.id);
    }
    for (const sh of s.shots) {
      this.shots.set(sh.id, sh);
      this.unsaved.add(sh.id);
    }
    for (const b of s.blobs) this.blobs.set(b.key, b);
    for (const id of s.deleteShotIds) this.purgeShot(id);
    for (const key of s.deleteBlobKeys) this.blobs.delete(key);
    for (const id of s.deletePosterIds) {
      this.posters.delete(id);
      this.unsaved.delete(id);
    }
  }

  async commit(snapshot: Snapshot, copts?: CommitOptions): Promise<void> {
    const involvesUnsaved = this.touchedIds(snapshot).some((id) => this.unsaved.has(id));
    if (involvesUnsaved) {
      // Saved shots/posters deleted alongside unsaved ones still go to the base; a failure there is a real error.
      const savedShotDeletes = snapshot.deleteShotIds.filter((id) => !this.shots.has(id));
      const savedPosterDeletes = snapshot.deletePosterIds.filter((id) => !this.posters.has(id));
      if (savedShotDeletes.length > 0 || savedPosterDeletes.length > 0) {
        await this.base.commit({
          posters: [],
          shots: [],
          blobs: [],
          deleteShotIds: savedShotDeletes,
          deletePosterIds: savedPosterDeletes,
          deleteBlobKeys: [],
        });
      }
      this.applyToOverlay(snapshot);
      return;
    }

    try {
      await this.base.commit(snapshot, copts);
      return;
    } catch (e) {
      if (copts?.bestEffort) {
        log.warn('best-effort write failed (thumbnail)', e);
        return;
      }
      const err = e instanceof StorageError ? e : new StorageError('Could not save', { cause: e });
      const hasDeletes = snapshot.deleteShotIds.length > 0 || snapshot.deletePosterIds.length > 0 || snapshot.deleteBlobKeys.length > 0;
      if (hasDeletes) throw err; // nothing to keep in memory for a failed delete
      // Overlay limit: refuse new shots beyond the cap (nothing is lost; the capture path shows the message).
      const unsavedShots = Array.from(this.shots.keys()).filter((id) => this.unsaved.has(id)).length;
      let newShots = 0;
      for (const s of snapshot.shots) if (!this.shots.has(s.id) && !(await this.base.getShot(s.id))) newShots++;
      if (unsavedShots + newShots > (this.opts.maxUnsavedShots ?? MAX_UNSAVED_SHOTS)) {
        throw new StorageFullError('Storage is full. Export or delete photos first.', { cause: e });
      }
      this.applyToOverlay(snapshot);
      this.opts.onSaveFailed?.(err);
    }
  }

  // ---- unsaved API ----
  private posterOf(id: string): string | undefined {
    if (this.posters.has(id)) return id;
    return this.shots.get(id)?.posterId;
  }

  async retrySave(id?: string): Promise<{ saved: string[]; failed: string[] }> {
    const posterIds = new Set<string>();
    if (id !== undefined) {
      const pid = this.posterOf(id);
      if (pid) posterIds.add(pid);
    } else {
      for (const u of this.unsaved) {
        const pid = this.posterOf(u);
        if (pid) posterIds.add(pid);
      }
    }
    const saved: string[] = [];
    const failed: string[] = [];
    for (const pid of posterIds) {
      const shots = Array.from(this.shots.values()).filter((s) => s.posterId === pid);
      const shotIds = new Set(shots.map((s) => s.id));
      const poster = this.posters.get(pid);
      const blobs = Array.from(this.blobs.values()).filter((b) => shotIds.has(b.shotId));
      const ids = [...(poster ? [pid] : []), ...shots.map((s) => s.id)];
      try {
        await this.base.commit({
          posters: poster ? [poster] : [],
          shots,
          blobs,
          deleteShotIds: [],
          deletePosterIds: [],
          deleteBlobKeys: [],
        });
        if (poster) {
          this.posters.delete(pid);
          this.unsaved.delete(pid);
        }
        for (const s of shots) this.purgeShot(s.id);
        saved.push(...ids);
      } catch (e) {
        log.warn('retry save failed', e);
        failed.push(...ids);
      }
    }
    return { saved, failed };
  }

  async discardUnsaved(id: string): Promise<void> {
    if (this.posters.has(id) && this.unsaved.has(id)) {
      for (const s of Array.from(this.shots.values())) if (s.posterId === id) this.purgeShot(s.id);
      this.posters.delete(id);
      this.unsaved.delete(id);
      return;
    }
    const shot = this.shots.get(id);
    if (!shot) return;
    this.purgeShot(id);
    const poster = this.posters.get(shot.posterId);
    if (poster) {
      const shotIds = poster.shotIds.filter((s) => s !== id);
      const remaining = Array.from(this.shots.values()).some((s) => s.posterId === poster.id);
      const savedPoster = await this.base.getPoster(poster.id);
      if (savedPoster && !remaining) {
        // the poster existed before; nothing else of it is unsaved
        this.posters.delete(poster.id);
        this.unsaved.delete(poster.id);
      } else {
        this.posters.set(poster.id, { ...poster, shotIds, coverShotId: poster.coverShotId === id ? shotIds[0] : poster.coverShotId });
      }
    }
  }
}

export class SessionOverlayStore extends SnapshotStore {
  private readonly overlay: OverlayBackend;

  constructor(base: Backend, opts: OverlayOptions = {}) {
    const overlay = new OverlayBackend(base, opts);
    super(overlay);
    this.overlay = overlay;
  }

  override unsavedIds(): ReadonlySet<string> {
    return this.overlay.unsaved;
  }

  override async retrySave(id?: string): Promise<{ saved: string[]; failed: string[] }> {
    const result = await this.overlay.retrySave(id);
    if (result.saved.length > 0) this.emitChange();
    return result;
  }

  override async discardUnsaved(id: string): Promise<void> {
    await this.overlay.discardUnsaved(id);
    this.emitChange();
  }
}
