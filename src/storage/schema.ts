// Records, patches and validators (design 2.10). DOM-free.
import { SEARCH_MAX_LENGTH } from '../app/config.ts';
import { ValidationError } from '../app/errors.ts';
import { InvalidQuadError } from '../app/errors.ts';
import { validateQuad, type AspectMode, type Quad, type Rotation } from '../cv/geometry.ts';

export const DB_NAME = 'poster-photos';
export const DB_VERSION = 1;

export type ShotStatus = 'captured' | 'rectified' | 'uncorrected';
export type ShotKind = 'overview' | 'detail';
export type ShotSource = 'camera-takephoto' | 'camera-frame' | 'file-capture' | 'file-gallery';
export type CornersSource = 'auto-opencv' | 'auto-js' | 'manual' | 'default';
export type BlobKind = 'original' | 'rectified';
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface EnhanceFlags {
  autoContrast: boolean;
  whiteBalance: boolean;
  sharpen: boolean;
}
export const NO_ENHANCE: Readonly<EnhanceFlags> = { autoContrast: false, whiteBalance: false, sharpen: false };

export interface GridCell {
  rows: number;
  cols: number;
  row: number;
  col: number;
}

export interface PosterRecord {
  id: string;
  title: string;
  conference?: string;
  notes?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  coverShotId?: string;
  /** Display order: overview first, then details. */
  shotIds: string[];
  detailGrid?: { rows: 2 | 3; cols: 2 | 3; skipped: number[] };
  schema: 1;
}

export interface ShotRecord {
  id: string;
  posterId: string;
  kind: ShotKind;
  gridCell?: GridCell;
  title?: string;
  createdAt: number;
  updatedAt: number;
  source: ShotSource;
  /** Oriented original, px. 0 while `dimsPending`. */
  width: number;
  height: number;
  /** Dimensions could not be read from the header; resolved later by a gated background decode. */
  dimsPending?: boolean;
  originalMime: string;
  originalBytes: number;
  normalized: boolean;
  originalExifOrientation: ExifOrientation;
  status: ShotStatus;
  corners: Quad | null;
  cornersSource: CornersSource;
  aspectMode: AspectMode;
  aspectUsed: number | null;
  snappedTo: string | null;
  enhance: EnhanceFlags;
  rotation: Rotation;
  rectifiedWidth?: number;
  rectifiedHeight?: number;
  downscaled?: boolean;
  reducedSource?: boolean;
  oversize?: boolean;
  engine?: 'opencv' | 'js';
  /** JPEG, long edge 256. Optional: absent between persist and the background thumbnail step. */
  thumb?: Blob;
  schema: 1;
}

export interface BlobRecord {
  /** `${shotId}/original` | `${shotId}/rectified` */
  key: string;
  shotId: string;
  kind: BlobKind;
  blob: Blob;
  mime: string;
  bytes: number;
}

export const blobKey = (shotId: string, kind: BlobKind): string => `${shotId}/${kind}`;

export interface MetaRecord {
  key: string;
  value: unknown;
}

// ---- Inputs ----
export interface NewPoster {
  title?: string;
  conference?: string;
  notes?: string;
  tags?: string[];
}

export interface NewShot {
  kind: ShotKind;
  gridCell?: GridCell;
  title?: string;
  source: ShotSource;
  width: number;
  height: number;
  dimsPending?: boolean;
  originalMime: string;
  originalBytes: number;
  normalized?: boolean;
  originalExifOrientation?: ExifOrientation;
  oversize?: boolean;
  /** Defaults: 'auto' for overview, 'free' for detail (decision A-8). */
  aspectMode?: AspectMode;
}

export interface PosterMetaPatch {
  title?: string;
  conference?: string | null;
  notes?: string | null;
  /** Array, or comma/space separated text from the UI. */
  tags?: string | string[];
  detailGrid?: PosterRecord['detailGrid'] | null;
}

export interface ShotParamsPatch {
  corners?: Quad | null;
  cornersSource?: CornersSource;
  aspectMode?: AspectMode;
  aspectUsed?: number | null;
  snappedTo?: string | null;
  enhance?: EnhanceFlags;
  rotation?: Rotation;
  title?: string;
  /** Dimension resolution after `dimsPending`. */
  width?: number;
  height?: number;
  dimsPending?: boolean;
  oversize?: boolean;
  normalized?: boolean;
}

export interface RectificationResult {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  thumb?: Blob;
  corners: Quad;
  cornersSource: CornersSource;
  aspectMode: AspectMode;
  aspectUsed: number | null;
  snappedTo: string | null;
  enhance: EnhanceFlags;
  downscaled?: boolean;
  reducedSource?: boolean;
  engine?: 'opencv' | 'js';
}

export interface PosterSummary {
  id: string;
  title: string;
  conference?: string;
  notes?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  coverShotId?: string;
  shotCount: number;
  /** Number of shots still in status 'captured' ("Needs adjusting"). */
  needsAdjustCount: number;
  /** Thumbnail of the cover shot, if it has one. */
  coverThumb?: Blob;
}

export interface PosterDetail {
  poster: PosterRecord;
  /** In `poster.shotIds` order. */
  shots: ShotRecord[];
}

/** Everything committed in one transaction. */
export interface Snapshot {
  posters: PosterRecord[];
  shots: ShotRecord[];
  blobs: BlobRecord[];
  deleteShotIds: string[];
  deletePosterIds: string[];
  /** Explicit blob keys to delete (in addition to all blobs of deleted shots). */
  deleteBlobKeys: string[];
}

export const emptySnapshot = (): Snapshot => ({
  posters: [],
  shots: [],
  blobs: [],
  deleteShotIds: [],
  deletePosterIds: [],
  deleteBlobKeys: [],
});

// ---- Validators ----
export const LIMITS = { title: 120, conference: 120, notes: 2000, tags: 20, tag: 32 } as const;

export function defaultPosterTitle(now: number = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `Poster ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function normalizeTitle(raw: string | undefined, now?: number): string {
  const t = (raw ?? '').trim();
  if (t === '') return defaultPosterTitle(now);
  if (t.length > LIMITS.title) throw new ValidationError(`Title must be at most ${LIMITS.title} characters`);
  return t;
}

export function normalizeOptionalText(raw: string | null | undefined, max: number, label: string): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const t = raw.trim();
  if (t === '') return undefined;
  if (t.length > max) throw new ValidationError(`${label} must be at most ${max} characters`);
  return t;
}

/** Comma/space separated input or an array. Lowercased, trimmed, unique. */
export function normalizeTags(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(/[,\s]+/);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim().toLowerCase();
    if (t === '' || out.includes(t)) continue;
    if (t.length > LIMITS.tag) throw new ValidationError(`Each tag must be at most ${LIMITS.tag} characters`);
    out.push(t);
  }
  if (out.length > LIMITS.tags) throw new ValidationError('Up to 20 tags');
  return out;
}

export function clampSearchQuery(q: string): string {
  return q.slice(0, SEARCH_MAX_LENGTH);
}

const isFinitePt = (p: unknown): boolean =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Structural check only (4 finite points); the full rules need the image size, see checkCorners/sanitizeCorners. */
export function isWellFormedQuad(q: unknown): q is Quad {
  return Array.isArray(q) && q.length === 4 && q.every(isFinitePt);
}

/**
 * Full quad validation (inside the image, convex, >= 1% area, edges >= 24 px) in ORIGINAL pixels. Skipped while the
 * image size is unknown (`dimsPending`, width/height 0), where only the structural check applies.
 */
export function checkCorners(corners: Quad, width: number, height: number): void {
  if (!isWellFormedQuad(corners)) throw new ValidationError('Corners must be four finite points');
  if (width < 1 || height < 1) return;
  try {
    validateQuad(corners, width, height);
  } catch (e) {
    if (e instanceof InvalidQuadError) throw new ValidationError(e.message, { cause: e });
    throw e;
  }
}
/** Reads: a stored quad that no longer validates (older version, bad write) is reset to null instead of failing the screen. */
export function sanitizeShot(shot: ShotRecord): ShotRecord {
  if (!shot.corners) return shot;
  try {
    checkCorners(shot.corners, shot.width, shot.height);
    return shot;
  } catch {
    return { ...shot, corners: null, cornersSource: 'default' };
  }
}
export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
export const isRotation = (r: unknown): r is Rotation => ROTATIONS.includes(r as Rotation);

export function assertShotParams(patch: ShotParamsPatch): void {
  if (patch.corners !== undefined && patch.corners !== null && !isWellFormedQuad(patch.corners)) {
    throw new ValidationError('Corners must be four finite points');
  }
  if (patch.rotation !== undefined && !isRotation(patch.rotation)) throw new ValidationError('Invalid rotation');
}
