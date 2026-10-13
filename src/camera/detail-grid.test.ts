import { describe, expect, it } from 'vitest';
import {
  CELL_OVERLAP,
  cellCount,
  cellIndex,
  cellLabel,
  cellName,
  cellRect,
  currentCell,
  doneCells,
  gridCellFor,
  gridDims,
  gridKind,
} from './detail-grid.ts';

const g3 = gridDims('3x3');
const g2 = gridDims('2x2');

describe('grid geometry (AC-20)', () => {
  it('knows its dimensions', () => {
    expect(g3).toEqual({ rows: 3, cols: 3 });
    expect(g2).toEqual({ rows: 2, cols: 2 });
    expect(cellCount(g3)).toBe(9);
    expect(gridKind(g2)).toBe('2x2');
  });

  it('shows nine labelled cells for a 3x3 grid', () => {
    const labels = Array.from({ length: 9 }, (_, i) => cellLabel(g3, i));
    expect(labels[0]).toBe('Detail 1 of 9: top left');
    expect(labels[2]).toBe('Detail 3 of 9: top right');
    expect(labels[4]).toBe('Detail 5 of 9: center');
    expect(labels[8]).toBe('Detail 9 of 9: bottom right');
    expect(new Set(labels).size).toBe(9);
  });

  it('names 2x2 cells', () => {
    expect([0, 1, 2, 3].map((i) => cellName(g2, i))).toEqual(['top left', 'top right', 'bottom left', 'bottom right']);
  });

  it('cell rectangles overlap by 5% per side and stay inside [0,1]', () => {
    const tl = cellRect(g3, 0);
    expect(tl.x).toBe(0);
    expect(tl.y).toBe(0);
    expect(tl.w).toBeCloseTo(1 / 3 + CELL_OVERLAP, 10);
    const mid = cellRect(g3, 4);
    expect(mid.x).toBeCloseTo(1 / 3 - 0.05, 10);
    expect(mid.w).toBeCloseTo(1 / 3 + 0.1, 10);
    for (let i = 0; i < 9; i++) {
      const r = cellRect(g3, i);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-12);
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('maps indices to grid cells and back', () => {
    for (let i = 0; i < 9; i++) expect(cellIndex(gridCellFor(g3, i))).toBe(i);
    expect(gridCellFor(g3, 5)).toEqual({ rows: 3, cols: 3, row: 1, col: 2 });
  });
});

describe('sequencing: the current cell is derived, never stored', () => {
  it('starts at the first cell and advances after each shot (row-major)', () => {
    const done: number[] = [];
    const seen: number[] = [];
    for (let n = 0; n < 9; n++) {
      const c = currentCell(g3, { done, skipped: [] })!;
      seen.push(c);
      done.push(c);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(currentCell(g3, { done, skipped: [] })).toBeNull();
  });

  it('skips skipped cells', () => {
    expect(currentCell(g3, { done: [0], skipped: [1, 2] })).toBe(3);
    expect(currentCell(g2, { done: [0, 1, 2], skipped: [3] })).toBeNull();
  });

  it('an explicit cell (Retake) overrides the derivation; invalid values are ignored', () => {
    expect(currentCell(g3, { done: [0, 1, 2], skipped: [] }, 1)).toBe(1);
    expect(currentCell(g3, { done: [], skipped: [] }, 9)).toBe(0);
    expect(currentCell(g3, { done: [], skipped: [] }, -1)).toBe(0);
    expect(currentCell(g3, { done: [], skipped: [] }, 1.5)).toBe(0);
  });

  it('derives done cells from shots with a matching grid', () => {
    const shots = [{ gridCell: gridCellFor(g3, 0) }, { gridCell: gridCellFor(g3, 4) }, { gridCell: gridCellFor(g2, 3) }, {}];
    expect(doneCells(g3, shots)).toEqual([0, 4]);
    expect(doneCells(g2, shots)).toEqual([3]);
  });
});
