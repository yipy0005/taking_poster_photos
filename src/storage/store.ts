// Store interface (what the UI depends on), the low-level Backend, and SnapshotStore: all mutation logic
// as "snapshot commits" (design 2.10). IdbStore, MemoryStore and SessionOverlayStore differ only in their Backend.
import { newId } from '../app/id.ts';
import { StorageError, ValidationError } from '../app/errors.ts';
import { createEmitter, type Dispose } from '../app/state.ts';
import {
  NO_ENHANCE,
  assertShotParams,
  blobKey,
  emptySnapshot,
  checkCorners,
  normalizeOptionalText,
  normalizeTags,
  normalizeTitle,
  sanitizeShot,
  LIMITS,
  type BlobKind,
  type BlobRecord,
  type NewPoster,
  type NewShot,
  type PosterDetail,
  type PosterMetaPatch,
  type PosterRecord,
  type PosterSummary,
  type RectificationResult,
  type ShotParamsPatch,
  type ShotRecord,
  type Snapshot,
} from './schema.ts';

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export interface Store {
  createPosterWithShot(p: NewPoster, s: NewShot, original: Blob): Promise<{ posterId: string; shotId: string }>;
  addShot(posterId: string, s: NewShot, original: Blob): Promise<string>;
  updatePosterMeta(id: string, patch: PosterMetaPatch): Promise<void>;
  /** Writes the rectified blob and shot fields (and thumb when given); sets status 'rectified'. */
  saveRectification(shotId: string, r: RectificationResult): Promise<void>;
  /** createPosterWithShot / addShot take no thumbnail; it arrives later through setThumb (2.9). No-op if the shot is gone. */
  setThumb(shotId: string, thumb: Blob): Promise<void>;
  /** Shot ids whose `thumb` is absent; used by the lazy startup sweep. */
  listShotsMissingThumb(): Promise<string[]>;
  /** "Keep original (no correction)": one transaction; deletes the rectified blob and clears the thumb. */
  keepUncorrected(shotId: string): Promise<void>;
  updateShotParams(shotId: string, patch: ShotParamsPatch): Promise<void>;
  listPosters(): Promise<PosterSummary[]>;
  getPoster(id: string): Promise<PosterDetail | null>;
  /** Added to the design's interface: the router and screens need a single shot. */
  getShot(shotId: string): Promise<ShotRecord | null>;
  getBlob(shotId: string, kind: BlobKind): Promise<Blob | null>;
  deletePoster(id: string): Promise<void>;
  deleteShot(shotId: string): Promise<void>;
  estimate(): Promise<StorageEstimate | null>;
  exists(kind: 'poster' | 'shot', id: string): Promise<boolean>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  /** Settings "Clear data": removes every poster, shot, blob and meta entry. */
  clearAll(): Promise<void>;
  /** Fires after every successful mutation (including setThumb). */
  onChange(listener: () => void): Dispose;
  /** Unsaved-state API, implemented by SessionOverlayStore; the others return empty/no-op. */
  unsavedIds(): ReadonlySet<string>;
  retrySave(id?: string): Promise<{ saved: string[]; failed: string[] }>;
  discardUnsaved(id: string): Promise<void>;
}

export interface CommitOptions {
  /** A failure is acceptable (thumbnail): do not escalate it into the unsaved overlay. */
  bestEffort?: boolean;
}

export interface Backend {
  getPoster(id: string): Promise<PosterRecord | undefined>;
  getShot(id: string): Promise<ShotRecord | undefined>;
  getBlobRecord(key: string): Promise<BlobRecord | undefined>;
  listPosters(): Promise<PosterRecord[]>;
  listShots(): Promise<ShotRecord[]>;
  commit(snapshot: Snapshot, opts?: CommitOptions): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  estimate(): Promise<StorageEstimate | null>;
  clearAll(): Promise<void>;
}

export const STRIKES_META_KEY = 'memoryStrikes';

const EMPTY_SET: ReadonlySet<string> = new Set();

function bytesOf(blob: Blob): number {
  return blob.size;
}

function assertDims(s: NewShot): void {
  const ok = (n: number) => Number.isFinite(n) && n >= 0;
  if (!ok(s.width) || !ok(s.height)) throw new ValidationError('Invalid image dimensions');
  if (!s.dimsPending && (s.width < 1 || s.height < 1)) throw new ValidationError('Invalid image dimensions');
}

export class SnapshotStore implements Store {
  private readonly changes = createEmitter<void>();

  constructor(protected readonly backend: Backend) {}

  // ---- reads ----
  async listPosters(): Promise<PosterSummary[]> {
    const [posters, shots] = await Promise.all([this.backend.listPosters(), this.backend.listShots()]);
    const byPoster = new Map<string, ShotRecord[]>();
    for (const s of shots) {
      const arr = byPoster.get(s.posterId);
      if (arr) arr.push(s);
      else byPoster.set(s.posterId, [s]);
    }
    const out: PosterSummary[] = posters.map((p) => {
      const own = byPoster.get(p.id) ?? [];
      const cover = own.find((s) => s.id === p.coverShotId) ?? own.find((s) => s.kind === 'overview') ?? own[0];
      return {
        id: p.id,
        title: p.title,
        conference: p.conference,
        notes: p.notes,
        tags: p.tags,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        coverShotId: p.coverShotId,
        shotCount: p.shotIds.length,
        needsAdjustCount: own.filter((s) => s.status === 'captured').length,
        coverThumb: cover?.thumb,
      };
    });
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  async getPoster(id: string): Promise<PosterDetail | null> {
    const poster = await this.backend.getPoster(id);
    if (!poster) return null;
    const shots: ShotRecord[] = [];
    for (const sid of poster.shotIds) {
      const s = await this.backend.getShot(sid);
      if (s) shots.push(sanitizeShot(s));
    }
    return { poster, shots };
  }

  async getShot(shotId: string): Promise<ShotRecord | null> {
    const s = await this.backend.getShot(shotId);
    return s ? sanitizeShot(s) : null;
  }

  async getBlob(shotId: string, kind: BlobKind): Promise<Blob | null> {
    return (await this.backend.getBlobRecord(blobKey(shotId, kind)))?.blob ?? null;
  }

  async exists(kind: 'poster' | 'shot', id: string): Promise<boolean> {
    return kind === 'poster' ? !!(await this.backend.getPoster(id)) : !!(await this.backend.getShot(id));
  }

  async listShotsMissingThumb(): Promise<string[]> {
    const shots = await this.backend.listShots();
    return shots.filter((s) => s.thumb === undefined).sort((a, b) => b.createdAt - a.createdAt).map((s) => s.id);
  }

  estimate(): Promise<StorageEstimate | null> {
    return this.backend.estimate();
  }

  getMeta<T>(key: string): Promise<T | undefined> {
    return this.backend.getMeta<T>(key);
  }
  setMeta<T>(key: string, value: T): Promise<void> {
    return this.backend.setMeta(key, value);
  }
  deleteMeta(key: string): Promise<void> {
    return this.backend.deleteMeta(key);
  }

  onChange(listener: () => void): Dispose {
    return this.changes.subscribe(listener);
  }

  protected emitChange(): void {
    this.changes.emit();
  }

  // ---- mutations ----
  protected async commit(snapshot: Snapshot, opts?: CommitOptions): Promise<void> {
    await this.backend.commit(snapshot, opts);
    this.changes.emit();
  }

  private newShotRecord(posterId: string, s: NewShot, id: string, now: number): ShotRecord {
    assertDims(s);
    return {
      id,
      posterId,
      kind: s.kind,
      gridCell: s.gridCell,
      title: normalizeOptionalText(s.title, LIMITS.title, 'Title'),
      createdAt: now,
      updatedAt: now,
      source: s.source,
      width: s.width,
      height: s.height,
      dimsPending: s.dimsPending || undefined,
      originalMime: s.originalMime,
      originalBytes: s.originalBytes,
      normalized: s.normalized ?? false,
      originalExifOrientation: s.originalExifOrientation ?? 1,
      status: 'captured',
      corners: null,
      cornersSource: 'default',
      aspectMode: s.aspectMode ?? (s.kind === 'overview' ? 'auto' : 'free'),
      aspectUsed: null,
      snappedTo: null,
      enhance: { ...NO_ENHANCE },
      rotation: 0,
      oversize: s.oversize || undefined,
      schema: 1,
    };
  }

  private originalBlob(shotId: string, blob: Blob): BlobRecord {
    return { key: blobKey(shotId, 'original'), shotId, kind: 'original', blob, mime: blob.type, bytes: bytesOf(blob) };
  }

  async createPosterWithShot(p: NewPoster, s: NewShot, original: Blob): Promise<{ posterId: string; shotId: string }> {
    const now = Date.now();
    const posterId = newId();
    const shotId = newId();
    const poster: PosterRecord = {
      id: posterId,
      title: normalizeTitle(p.title, now),
      conference: normalizeOptionalText(p.conference, LIMITS.conference, 'Conference'),
      notes: normalizeOptionalText(p.notes, LIMITS.notes, 'Notes'),
      tags: normalizeTags(p.tags),
      createdAt: now,
      updatedAt: now,
      coverShotId: shotId,
      shotIds: [shotId],
      schema: 1,
    };
    const shot = this.newShotRecord(posterId, s, shotId, now);
    await this.commit({ ...emptySnapshot(), posters: [poster], shots: [shot], blobs: [this.originalBlob(shotId, original)] });
    return { posterId, shotId };
  }

  async addShot(posterId: string, s: NewShot, original: Blob): Promise<string> {
    const poster = await this.backend.getPoster(posterId);
    if (!poster) throw new StorageError('Poster not found');
    const now = Date.now();
    const shotId = newId();
    const shot = this.newShotRecord(posterId, s, shotId, now);
    const shotIds = s.kind === 'overview' ? [shotId, ...poster.shotIds] : [...poster.shotIds, shotId];
    const next: PosterRecord = {
      ...poster,
      shotIds,
      coverShotId: poster.coverShotId ?? shotId,
      updatedAt: now,
    };
    await this.commit({ ...emptySnapshot(), posters: [next], shots: [shot], blobs: [this.originalBlob(shotId, original)] });
    return shotId;
  }

  async updatePosterMeta(id: string, patch: PosterMetaPatch): Promise<void> {
    const poster = await this.backend.getPoster(id);
    if (!poster) throw new StorageError('Poster not found');
    const next: PosterRecord = { ...poster, updatedAt: Date.now() };
    if (patch.title !== undefined) next.title = normalizeTitle(patch.title);
    if (patch.conference !== undefined) next.conference = normalizeOptionalText(patch.conference, LIMITS.conference, 'Conference');
    if (patch.notes !== undefined) next.notes = normalizeOptionalText(patch.notes, LIMITS.notes, 'Notes');
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
    if (patch.detailGrid !== undefined) next.detailGrid = patch.detailGrid ?? undefined;
    await this.commit({ ...emptySnapshot(), posters: [next] });
  }

  async saveRectification(shotId: string, r: RectificationResult): Promise<void> {
    const shot = await this.backend.getShot(shotId);
    if (!shot) throw new StorageError('Photo not found');
    checkCorners(r.corners, shot.width, shot.height);
    const now = Date.now();
    const next: ShotRecord = {
      ...shot,
      status: 'rectified',
      corners: r.corners,
      cornersSource: r.cornersSource,
      aspectMode: r.aspectMode,
      aspectUsed: r.aspectUsed,
      snappedTo: r.snappedTo,
      enhance: { ...r.enhance },
      rectifiedWidth: r.width,
      rectifiedHeight: r.height,
      downscaled: r.downscaled || undefined,
      reducedSource: r.reducedSource || undefined,
      engine: r.engine,
      thumb: r.thumb ?? shot.thumb,
      updatedAt: now,
    };
    const rect: BlobRecord = {
      key: blobKey(shotId, 'rectified'),
      shotId,
      kind: 'rectified',
      blob: r.blob,
      mime: r.mime,
      bytes: bytesOf(r.blob),
    };
    await this.commit({ ...emptySnapshot(), shots: [next], blobs: [rect] });
  }

  async setThumb(shotId: string, thumb: Blob): Promise<void> {
    const shot = await this.backend.getShot(shotId);
    if (!shot) return;
    await this.commit({ ...emptySnapshot(), shots: [{ ...shot, thumb }] }, { bestEffort: true });
  }

  async keepUncorrected(shotId: string): Promise<void> {
    const shot = await this.backend.getShot(shotId);
    if (!shot) throw new StorageError('Photo not found');
    const next: ShotRecord = {
      ...shot,
      status: 'uncorrected',
      corners: null,
      cornersSource: 'default',
      rectifiedWidth: undefined,
      rectifiedHeight: undefined,
      downscaled: undefined,
      reducedSource: undefined,
      engine: undefined,
      thumb: undefined,
      updatedAt: Date.now(),
    };
    await this.commit({ ...emptySnapshot(), shots: [next], deleteBlobKeys: [blobKey(shotId, 'rectified')] });
  }

  async updateShotParams(shotId: string, patch: ShotParamsPatch): Promise<void> {
    assertShotParams(patch);
    const shot = await this.backend.getShot(shotId);
    if (!shot) throw new StorageError('Photo not found');
    const next: ShotRecord = { ...shot, updatedAt: Date.now() };
    if (patch.corners !== undefined) next.corners = patch.corners;
    if (patch.cornersSource !== undefined) next.cornersSource = patch.cornersSource;
    if (patch.aspectMode !== undefined) next.aspectMode = patch.aspectMode;
    if (patch.aspectUsed !== undefined) next.aspectUsed = patch.aspectUsed;
    if (patch.snappedTo !== undefined) next.snappedTo = patch.snappedTo;
    if (patch.enhance !== undefined) next.enhance = { ...patch.enhance };
    if (patch.rotation !== undefined) next.rotation = patch.rotation;
    if (patch.title !== undefined) next.title = normalizeOptionalText(patch.title, LIMITS.title, 'Title');
    if (patch.width !== undefined) next.width = patch.width;
    if (patch.height !== undefined) next.height = patch.height;
    if (patch.dimsPending !== undefined) next.dimsPending = patch.dimsPending || undefined;
    if (patch.oversize !== undefined) next.oversize = patch.oversize || undefined;
    if (patch.normalized !== undefined) next.normalized = patch.normalized;
    if (patch.corners) checkCorners(patch.corners, next.width, next.height);
    await this.commit({ ...emptySnapshot(), shots: [next] });
  }

  async deleteShot(shotId: string): Promise<void> {
    const shot = await this.backend.getShot(shotId);
    if (!shot) return;
    const snap = emptySnapshot();
    snap.deleteShotIds.push(shotId);
    const poster = await this.backend.getPoster(shot.posterId);
    if (poster) {
      const shotIds = poster.shotIds.filter((id) => id !== shotId);
      let coverShotId = poster.coverShotId;
      if (coverShotId === shotId) {
        const rest = (await Promise.all(shotIds.map((id) => this.backend.getShot(id)))).filter((s): s is ShotRecord => !!s);
        coverShotId = (rest.find((s) => s.kind === 'overview') ?? rest[0])?.id;
      }
      snap.posters.push({ ...poster, shotIds, coverShotId, updatedAt: Date.now() });
    }
    await this.commit(snap);
    await this.pruneStrikes([shotId]);
  }

  async deletePoster(id: string): Promise<void> {
    const poster = await this.backend.getPoster(id);
    if (!poster) return;
    const snap = emptySnapshot();
    const shots = (await this.backend.listShots()).filter((s) => s.posterId === id);
    const shotIds = Array.from(new Set([...poster.shotIds, ...shots.map((s) => s.id)]));
    snap.deleteShotIds.push(...shotIds);
    snap.deletePosterIds.push(id);
    await this.commit(snap);
    await this.pruneStrikes(shotIds);
  }

  async clearAll(): Promise<void> {
    await this.backend.clearAll();
    this.changes.emit();
  }

  /** Removes memoryStrikes entries of deleted shots (2.10 meta keys). Best effort. */
  private async pruneStrikes(shotIds: string[]): Promise<void> {
    try {
      const map = await this.backend.getMeta<Record<string, number>>(STRIKES_META_KEY);
      if (!map) return;
      let changed = false;
      for (const key of Object.keys(map)) {
        if (shotIds.some((id) => key.startsWith(`${id}:`))) {
          delete map[key];
          changed = true;
        }
      }
      if (changed) await this.backend.setMeta(STRIKES_META_KEY, map);
    } catch {
      // meta pruning must never fail a delete
    }
  }

  // ---- unsaved-state API: only the overlay store has any ----
  unsavedIds(): ReadonlySet<string> {
    return EMPTY_SET;
  }
  async retrySave(_id?: string): Promise<{ saved: string[]; failed: string[] }> {
    return { saved: [], failed: [] };
  }
  async discardUnsaved(_id: string): Promise<void> {}
}
