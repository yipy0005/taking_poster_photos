import { describe, expect, it } from 'vitest';
import { formatMegabytes, orderShots, partLabel, partWarning, posterMetaLine, tagsToText } from './poster-logic.ts';
import { cardRoute, photoCount } from './library-screen.ts';
import { shotLabel } from './shot-label.ts';

const cell = (row: number, col: number, rows = 2, cols = 2) => ({ rows, cols, row, col });

describe('orderShots (AC-21)', () => {
  it('lists the overview first, then details in grid order, then ungridded details by age', () => {
    const shots = [
      { id: 'd4', kind: 'detail' as const, gridCell: cell(1, 1), createdAt: 1 },
      { id: 'free', kind: 'detail' as const, createdAt: 2 },
      { id: 'd2', kind: 'detail' as const, gridCell: cell(0, 1), createdAt: 3 },
      { id: 'ov', kind: 'overview' as const, createdAt: 9 },
      { id: 'd1', kind: 'detail' as const, gridCell: cell(0, 0), createdAt: 4 },
      { id: 'free2', kind: 'detail' as const, createdAt: 1.5 },
    ];
    expect(orderShots(shots).map((s) => s.id)).toEqual(['ov', 'd1', 'd2', 'd4', 'free2', 'free']);
  });
  it('does not mutate its input and is stable', () => {
    const shots = [
      { id: 'a', kind: 'detail' as const, createdAt: 1 },
      { id: 'b', kind: 'detail' as const, createdAt: 1 },
    ];
    const out = orderShots(shots);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out).not.toBe(shots);
  });
});

describe('labels', () => {
  it('names shots', () => {
    expect(shotLabel({ kind: 'overview' }, 0)).toBe('Overview');
    expect(shotLabel({ kind: 'detail', gridCell: cell(1, 0) }, 3)).toBe('Detail 3');
    expect(shotLabel({ kind: 'detail' }, 4)).toBe('Detail 4');
    expect(shotLabel({ kind: 'detail', title: 'Table 2' }, 4)).toBe('Table 2');
  });
  it('builds the meta line', () => {
    expect(posterMetaLine({ conference: 'ICML', tags: ['ml', 'nlp'] })).toBe('ICML \u00b7 #ml #nlp');
    expect(posterMetaLine({ tags: [] })).toBe('');
    expect(tagsToText(['a', 'b'])).toBe('a, b');
  });
  it('labels PDF parts', () => {
    expect(partLabel(0, 3, [0, 1, 2])).toBe('Export part 1 of 3 (pages 1 to 3)');
    expect(partLabel(2, 3, [7])).toBe('Export part 3 of 3 (page 8)');
    expect(partWarning([1], [1, 90], 60)).toBe('This photo alone is large and may fail on this device');
    expect(partWarning([0], [1, 90], 60)).toBeNull();
    expect(formatMegabytes(1536 * 1024)).toBe('1.5 MB');
    expect(formatMegabytes(61 * 1024 * 1024)).toBe('61 MB');
  });
});

describe('library card route (plan.md finding 14)', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const cover = '22222222-2222-4222-8222-222222222222';
  it('a poster with one captured shot opens Adjust, anything else opens the poster', () => {
    expect(cardRoute({ id, shotCount: 1, needsAdjustCount: 1, coverShotId: cover })).toBe(`#/adjust/${cover}`);
    expect(cardRoute({ id, shotCount: 2, needsAdjustCount: 1, coverShotId: cover })).toBe(`#/poster/${id}`);
    expect(cardRoute({ id, shotCount: 1, needsAdjustCount: 0, coverShotId: cover })).toBe(`#/poster/${id}`);
    expect(cardRoute({ id, shotCount: 1, needsAdjustCount: 1 })).toBe(`#/poster/${id}`);
  });
  it('pluralises photos', () => {
    expect(photoCount(1)).toBe('1 photo');
    expect(photoCount(4)).toBe('4 photos');
  });
});
