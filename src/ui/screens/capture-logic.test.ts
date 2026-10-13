import { describe, expect, it } from 'vitest';
import { CameraError, IngestError, StorageError, StorageFullError } from '../../app/errors.ts';
import { gridCellFor, gridDims } from '../../camera/detail-grid.ts';
import { ACTION_LABELS, cameraErrorScreen, captureTitle, describeIngestError, lastGridShot, planDetail } from './capture-logic.ts';

describe('camera error screens (AC-5, AC-6)', () => {
  it('permission denied offers Try again, Use native camera and Choose from gallery', () => {
    const s = cameraErrorScreen('denied');
    expect(s.title).toBe('Camera access is blocked');
    expect(s.actions.map((a) => ACTION_LABELS[a]).sort()).toEqual(['Choose from gallery', 'Try again', 'Use native camera']);
  });

  it('an insecure context says Camera needs HTTPS and still offers both file paths, but no retry', () => {
    const s = cameraErrorScreen('insecure');
    expect(s.title).toBe('Camera needs HTTPS');
    expect(s.actions).toContain('native');
    expect(s.actions).toContain('gallery');
    expect(s.actions).not.toContain('retry');
  });

  it('every error kind keeps both file-input paths', () => {
    for (const kind of ['denied', 'none', 'busy', 'insecure'] as const) {
      const s = cameraErrorScreen(kind);
      expect(s.actions).toContain('native');
      expect(s.actions).toContain('gallery');
      expect(s.cause.length).toBeGreaterThan(10);
    }
    expect(cameraErrorScreen('none').title).toBe('No camera found');
    expect(cameraErrorScreen('busy').title).toBe('Camera is in use by another app');
  });

  it('CameraError kinds map one to one', () => {
    for (const kind of ['denied', 'none', 'busy', 'insecure'] as const) {
      expect(cameraErrorScreen(new CameraError(kind, 'x').kind)).toBeDefined();
    }
  });
});

describe('describeIngestError (design 2.16)', () => {
  it('shows the plain messages', () => {
    expect(describeIngestError(new IngestError('unsupported', "Can't read this image"))).toEqual({ text: "Can't read this image", persistent: false });
    expect(describeIngestError(new IngestError('too-large', 'File too large (130 MB, 120 MB max)'))).toEqual({
      text: 'File too large (130 MB, 120 MB max)',
      persistent: true,
    });
    expect(describeIngestError(new StorageFullError('full')).text).toBe('Storage is full. Export or delete photos first.');
    expect(describeIngestError(new StorageError('x')).text).toBe("Couldn't save, try again");
    expect(describeIngestError(new Error('boom')).text).toBe("Couldn't save the photo, try again");
  });
});

describe('captureTitle', () => {
  it('prefers the guided cell label', () => {
    expect(captureTitle('detail', 'Detail 3 of 9: top right')).toBe('Detail 3 of 9: top right');
    expect(captureTitle('overview', null)).toBe('Take a photo');
    expect(captureTitle('detail', null)).toBe('Detail photo');
  });
});

describe('planDetail: guided mode derived from stored data (AC-20)', () => {
  const g3 = gridDims('3x3');
  const poster = (skipped: number[] = [], withGrid = true) => ({
    id: 'p',
    detailGrid: withGrid ? { rows: 3 as const, cols: 3 as const, skipped } : undefined,
  });
  const shotIn = (i: number) => ({ gridCell: gridCellFor(g3, i) });

  it('starts at cell 0 and labels it', () => {
    const p = planDetail(poster(), [], undefined, undefined);
    expect(p.cell).toBe(0);
    expect(p.label).toBe('Detail 1 of 9: top left');
    expect(p.complete).toBe(false);
  });

  it('advances after each stored shot and survives a reload because nothing is held in memory', () => {
    const shots = [shotIn(0), shotIn(1), shotIn(2)];
    expect(planDetail(poster(), shots, undefined, undefined).cell).toBe(3);
  });

  it('skips skipped cells and completes when nothing is left', () => {
    expect(planDetail(poster([0, 1]), [], undefined, undefined).cell).toBe(2);
    const all = Array.from({ length: 9 }, (_, i) => shotIn(i));
    const done = planDetail(poster(), all, undefined, undefined);
    expect(done.complete).toBe(true);
    expect(done.cell).toBeNull();
    expect(done.label).toBeNull();
  });

  it('the route grid is used only while the poster has none; the poster grid wins afterwards', () => {
    const fresh = planDetail(poster([], false), [], '2x2', undefined);
    expect(fresh.dims).toEqual({ rows: 2, cols: 2 });
    const existing = planDetail(poster(), [], '2x2', undefined);
    expect(existing.dims).toEqual({ rows: 3, cols: 3 });
  });

  it('a Retake cell overrides the derivation', () => {
    const shots = [shotIn(0), shotIn(1), shotIn(2)];
    const p = planDetail(poster(), shots, undefined, 1);
    expect(p.cell).toBe(1);
    expect(p.explicit).toBe(true);
  });

  it('without any grid there is no current cell (free detail shot)', () => {
    const p = planDetail(poster([], false), [], undefined, undefined);
    expect(p).toMatchObject({ dims: null, cell: null, complete: false, label: null });
  });

  it('ignores shots from a different grid and out-of-range skipped values', () => {
    const other = { gridCell: gridCellFor(gridDims('2x2'), 0) };
    const p = planDetail(poster([42, -1]), [other], undefined, undefined);
    expect(p.cell).toBe(0);
    expect(p.skipped).toEqual([]);
  });
});

describe('lastGridShot', () => {
  it('finds the most recent detail shot in a cell', () => {
    const g = gridDims('3x3');
    const shots = [
      { kind: 'overview' as const, createdAt: 1 },
      { kind: 'detail' as const, createdAt: 5, gridCell: gridCellFor(g, 0) },
      { kind: 'detail' as const, createdAt: 9, gridCell: gridCellFor(g, 1) },
      { kind: 'detail' as const, createdAt: 12 },
    ];
    expect(lastGridShot(shots)?.createdAt).toBe(9);
    expect(lastGridShot([{ kind: 'overview' as const, createdAt: 1 }])).toBeNull();
  });
});
