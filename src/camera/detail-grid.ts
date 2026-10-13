// Guided detail mode geometry and sequencing (design 2.9 "Detail grid mode"). Pure, DOM-free.
import type { GridKind } from '../app/router.ts';
import type { GridCell } from '../storage/schema.ts';

/** Suggested overlap between neighbouring cells: 5% on each side, 10% in total. */
export const CELL_OVERLAP = 0.05;

export interface GridDims {
  rows: 2 | 3;
  cols: 2 | 3;
}

export function gridDims(kind: GridKind): GridDims {
  return kind === '2x2' ? { rows: 2, cols: 2 } : { rows: 3, cols: 3 };
}

export function gridKind(dims: { rows: number; cols: number }): GridKind {
  return dims.rows === 2 ? '2x2' : '3x3';
}

export const cellCount = (dims: { rows: number; cols: number }): number => dims.rows * dims.cols;

export const cellIndex = (c: Pick<GridCell, 'row' | 'col' | 'cols'>): number => c.row * c.cols + c.col;

export function gridCellFor(dims: { rows: number; cols: number }, index: number): GridCell {
  return { rows: dims.rows, cols: dims.cols, row: Math.floor(index / dims.cols), col: index % dims.cols };
}

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalised rectangle of cell `index` (row-major) within the poster, grown by `overlap` on each side and clamped to [0,1]. */
export function cellRect(dims: { rows: number; cols: number }, index: number, overlap: number = CELL_OVERLAP): NormRect {
  const row = Math.floor(index / dims.cols);
  const col = index % dims.cols;
  const x0 = Math.max(0, col / dims.cols - overlap);
  const y0 = Math.max(0, row / dims.rows - overlap);
  const x1 = Math.min(1, (col + 1) / dims.cols + overlap);
  const y1 = Math.min(1, (row + 1) / dims.rows + overlap);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const ROW_WORDS_3 = ['top', 'middle', 'bottom'] as const;
const COL_WORDS_3 = ['left', 'center', 'right'] as const;

/** "top right", "center", "bottom left" ... */
export function cellName(dims: { rows: number; cols: number }, index: number): string {
  const row = Math.floor(index / dims.cols);
  const col = index % dims.cols;
  if (dims.rows === 2) {
    return `${row === 0 ? 'top' : 'bottom'} ${col === 0 ? 'left' : 'right'}`;
  }
  const r = ROW_WORDS_3[row] ?? 'middle';
  const c = COL_WORDS_3[col] ?? 'center';
  if (r === 'middle' && c === 'center') return 'center';
  return `${r} ${c}`;
}

/** "Detail 3 of 9: top right" */
export function cellLabel(dims: { rows: number; cols: number }, index: number): string {
  return `Detail ${index + 1} of ${cellCount(dims)}: ${cellName(dims, index)}`;
}

export interface GridProgress {
  /** Cell indices that already have a shot. */
  done: readonly number[];
  skipped: readonly number[];
}

/**
 * The current cell is derived, never stored: the first row-major index that has no shot and is not skipped.
 * `explicit` (the `cell` route parameter, used by Retake) overrides the derivation once. null = the session is complete.
 */
export function currentCell(dims: { rows: number; cols: number }, progress: GridProgress, explicit?: number): number | null {
  const total = cellCount(dims);
  if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0 && explicit < total) return explicit;
  for (let i = 0; i < total; i++) {
    if (!progress.done.includes(i) && !progress.skipped.includes(i)) return i;
  }
  return null;
}

/** Done cell indices from the shots of a poster (detail shots with a gridCell matching these dimensions). */
export function doneCells(dims: { rows: number; cols: number }, shots: ReadonlyArray<{ gridCell?: GridCell }>): number[] {
  const out = new Set<number>();
  for (const s of shots) {
    const c = s.gridCell;
    if (c && c.rows === dims.rows && c.cols === dims.cols) out.add(cellIndex(c));
  }
  return Array.from(out).sort((a, b) => a - b);
}
