// Human label of a shot inside a poster (shared by the poster gallery and the result screen). Pure.
import type { ShotRecord } from '../../storage/schema.ts';

export function shotLabel(s: Pick<ShotRecord, 'title' | 'kind' | 'gridCell'>, index: number): string {
  if (s.title) return s.title;
  if (s.kind === 'overview') return 'Overview';
  if (s.gridCell) return `Detail ${s.gridCell.row * s.gridCell.cols + s.gridCell.col + 1}`;
  return `Detail ${index}`;
}

export const STATUS_TEXT: Record<ShotRecord['status'], string> = {
  captured: 'Needs adjusting',
  rectified: 'Corrected',
  uncorrected: 'Original',
};
