import { describe, expect, it } from 'vitest';
import type { Pt } from './geometry.ts';
import { orderQuad } from './quad-order.ts';

const rect: Pt[] = [[100, 100], [500, 100], [500, 400], [100, 400]]; // TL TR BR BL

describe('orderQuad', () => {
  it('returns TL, TR, BR, BL for every permutation of an axis-aligned rectangle', () => {
    const perms: number[][] = [];
    const rec = (cur: number[], rest: number[]): void => {
      if (!rest.length) perms.push(cur);
      rest.forEach((x, i) => rec([...cur, x], rest.filter((_, j) => j !== i)));
    };
    rec([], [0, 1, 2, 3]);
    expect(perms).toHaveLength(24);
    for (const p of perms) expect(orderQuad(p.map((i) => rect[i]!))).toEqual(rect);
  });
  it('handles a rectangle rotated by 30 degrees', () => {
    const a = (Math.PI * 30) / 180;
    const rot = (p: Pt): Pt => [300 + (p[0] - 300) * Math.cos(a) - (p[1] - 250) * Math.sin(a), 250 + (p[0] - 300) * Math.sin(a) + (p[1] - 250) * Math.cos(a)];
    const q = rect.map(rot);
    const shuffled = [q[2]!, q[0]!, q[3]!, q[1]!];
    expect(orderQuad(shuffled)).toEqual(q);
  });
  it('starts at the minimal x + y point', () => {
    const q = orderQuad([[10, 200], [200, 10], [400, 210], [210, 400]]);
    expect(q[0]).toEqual([10, 200]);
  });
  it('rejects the wrong number of points', () => {
    expect(() => orderQuad(rect.slice(0, 3))).toThrow();
  });
});
