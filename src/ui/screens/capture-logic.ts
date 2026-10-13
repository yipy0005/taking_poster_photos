// Pure helpers of the Capture screen: error screens, ingest error messages and the guided-detail plan. DOM-free.
import { CameraError, IngestError, StorageError, StorageFullError } from '../../app/errors.ts';
import type { GridKind } from '../../app/router.ts';
import { cellCount, cellLabel, currentCell, doneCells, gridDims, type GridDims } from '../../camera/detail-grid.ts';
import type { PosterRecord, ShotRecord } from '../../storage/schema.ts';

export type CameraErrorKind = CameraError['kind'];
export type ErrorAction = 'retry' | 'native' | 'gallery';

export interface CameraErrorScreen {
  title: string;
  cause: string;
  /** Always includes the two file-input paths; "Try again" only where trying again can help. */
  actions: ErrorAction[];
}

/** Design 2.16: title, plain-language cause, one or two actions. The file inputs are always offered (FR-1.3). */
export function cameraErrorScreen(kind: CameraErrorKind): CameraErrorScreen {
  switch (kind) {
    case 'denied':
      return {
        title: 'Camera access is blocked',
        cause: 'Allow camera access for this site in your browser settings, then try again.',
        actions: ['retry', 'native', 'gallery'],
      };
    case 'none':
      return {
        title: 'No camera found',
        cause: 'This device has no camera the browser can use. You can still take a photo with the camera app or pick one from your gallery.',
        actions: ['native', 'gallery', 'retry'],
      };
    case 'busy':
      return {
        title: 'Camera is in use by another app',
        cause: 'Close the other app that is using the camera, then try again.',
        actions: ['retry', 'native', 'gallery'],
      };
    case 'insecure':
      return {
        title: 'Camera needs HTTPS',
        cause: 'The live camera only works on a secure page (https:// or localhost). You can still take a photo with the camera app or pick one from your gallery.',
        actions: ['native', 'gallery'],
      };
  }
}

export const ACTION_LABELS: Record<ErrorAction, string> = {
  retry: 'Try again',
  native: 'Use native camera',
  gallery: 'Choose from gallery',
};

export interface IngestMessage {
  text: string;
  /** Keep on screen until dismissed. */
  persistent: boolean;
}

/** What the user sees when ingest throws (design 2.16). Nothing was saved in the unsupported and too-large cases. */
export function describeIngestError(e: unknown): IngestMessage {
  if (e instanceof IngestError) return { text: e.message, persistent: e.kind === 'too-large' };
  if (e instanceof StorageFullError) return { text: 'Storage is full. Export or delete photos first.', persistent: true };
  if (e instanceof StorageError) return { text: "Couldn't save, try again", persistent: false };
  return { text: "Couldn't save the photo, try again", persistent: false };
}

/** Title shown in the top bar. */
export function captureTitle(mode: 'overview' | 'detail', cellText: string | null): string {
  if (cellText) return cellText;
  return mode === 'detail' ? 'Detail photo' : 'Take a photo';
}

export interface DetailPlan {
  posterId: string;
  dims: GridDims | null;
  done: number[];
  skipped: number[];
  /** The cell to shoot next; null when every cell is done or skipped (or there is no grid). */
  cell: number | null;
  complete: boolean;
  label: string | null;
  /** The grid cell index the next shot is filed under (for a Retake this is the explicit route cell). */
  explicit: boolean;
}

/**
 * Guided-mode state is derived from the stored poster and its shots, never held in memory or the route (design 2.9): it survives
 * reloads. `routeGrid` is used only when the poster has no grid yet; `routeCell` (Retake) overrides the derivation once.
 */
export function planDetail(
  poster: Pick<PosterRecord, 'id' | 'detailGrid'>,
  shots: ReadonlyArray<Pick<ShotRecord, 'gridCell'>>,
  routeGrid: GridKind | undefined,
  routeCell: number | undefined,
): DetailPlan {
  const dims: GridDims | null = poster.detailGrid ? { rows: poster.detailGrid.rows, cols: poster.detailGrid.cols } : routeGrid ? gridDims(routeGrid) : null;
  if (!dims) {
    return { posterId: poster.id, dims: null, done: [], skipped: [], cell: null, complete: false, label: null, explicit: false };
  }
  const done = doneCells(dims, shots);
  const skipped = (poster.detailGrid?.skipped ?? []).filter((i) => i >= 0 && i < cellCount(dims));
  const cell = currentCell(dims, { done, skipped }, routeCell);
  return {
    posterId: poster.id,
    dims,
    done,
    skipped,
    cell,
    complete: cell === null,
    label: cell === null ? null : cellLabel(dims, cell),
    explicit: routeCell !== undefined && cell === routeCell,
  };
}

/** The most recently taken detail shot that sits in a grid cell: the one "Retake" removes. */
export function lastGridShot<T extends Pick<ShotRecord, 'gridCell' | 'createdAt' | 'kind'>>(shots: readonly T[]): T | null {
  let best: T | null = null;
  for (const s of shots) {
    if (s.kind !== 'detail' || !s.gridCell) continue;
    if (!best || s.createdAt >= best.createdAt) best = s;
  }
  return best;
}
