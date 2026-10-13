// Quad ordering (design 2.5): sort by angle around the centroid (clockwise in image space, y down),
// then rotate so the first point has minimal x + y. Gives TL, TR, BR, BL for any quad rotated less than ~45 degrees.
import type { Pt, Quad } from './geometry.ts';

export function orderQuad(points: readonly Pt[]): Quad {
  if (points.length !== 4) throw new Error('orderQuad needs exactly four points');
  const cx = points.reduce((s, p) => s + p[0], 0) / 4;
  const cy = points.reduce((s, p) => s + p[1], 0) / 4;
  // In image space (y down) increasing atan2 angle runs clockwise on screen.
  const sorted = points
    .map((p) => ({ p, a: Math.atan2(p[1] - cy, p[0] - cx) }))
    .sort((u, v) => u.a - v.a)
    .map((o) => o.p);
  let start = 0;
  for (let i = 1; i < 4; i++) {
    const s = sorted[i]![0] + sorted[i]![1];
    const best = sorted[start]![0] + sorted[start]![1];
    if (s < best) start = i;
  }
  return [sorted[start]!, sorted[(start + 1) % 4]!, sorted[(start + 2) % 4]!, sorted[(start + 3) % 4]!];
}
