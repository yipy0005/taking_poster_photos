import { describe, expect, it } from 'vitest';
import { DegenerateQuadError } from '../app/errors.ts';
import type { Quad } from './geometry.ts';
import { apply, det3, identity, invert, mul, quadHomography, reducedRoiHomography, sigmaAt, solveHomography, tileHomography, translation } from './homography.ts';

const Q: Quad = [[120, 80], [900, 130], [860, 700], [90, 640]];

describe('quadHomography', () => {
  it('maps the output rectangle corners to the quad and the centre inside it', () => {
    const H = quadHomography(Q, 800, 600);
    const corners = [[0, 0], [800, 0], [800, 600], [0, 600]] as const;
    corners.forEach(([x, y], i) => {
      const p = apply(H, x, y);
      expect(p[0]).toBeCloseTo(Q[i]![0], 6);
      expect(p[1]).toBeCloseTo(Q[i]![1], 6);
    });
    const c = apply(H, 400, 300);
    expect(c[0]).toBeGreaterThan(300);
    expect(c[0]).toBeLessThan(700);
  });
  it('throws DegenerateQuadError for collinear corners', () => {
    expect(() => quadHomography([[0, 0], [10, 10], [20, 20], [30, 30]], 100, 100)).toThrow(DegenerateQuadError);
  });
  it('solveHomography reproduces an arbitrary known matrix', () => {
    const Ht = Float64Array.of(0.8, 0.12, 60, -0.05, 0.9, 40, 0.0002, 0.0001, 1);
    const from = [[0, 0], [500, 0], [500, 350], [0, 350]] as const;
    const to = from.map(([x, y]) => apply(Ht, x, y));
    const solved = solveHomography(from, to);
    for (let i = 0; i < 9; i++) expect(solved[i]!).toBeCloseTo(Ht[i]!, 8);
  });
});

describe('matrix helpers', () => {
  it('invert * matrix = identity', () => {
    const H = quadHomography(Q, 800, 600);
    const I = mul(invert(H), H);
    for (let i = 0; i < 9; i++) expect(I[i]!).toBeCloseTo(identity()[i]!, 9);
    expect(det3(H)).not.toBe(0);
  });
  it('tileHomography = T(-sx,-sy) Hds T(x0,y0)', () => {
    const H = quadHomography(Q, 800, 600);
    const Ht = tileHomography(H, 50, 70, 200, 100);
    const direct = apply(H, 200 + 13, 100 + 7);
    const viaTile = apply(Ht, 13, 7);
    expect(viaTile[0] + 50).toBeCloseTo(direct[0], 9);
    expect(viaTile[1] + 70).toBeCloseTo(direct[1], 9);
    expect(mul(translation(1, 2), identity())[2]).toBe(1);
  });
  it('reducedRoiHomography scales ROI coordinates by rw/sw, rh/sh', () => {
    const H = quadHomography(Q, 800, 600);
    const Ht = tileHomography(H, 0, 0, 0, 0);
    const Hr = reducedRoiHomography(Ht, 1000, 800, 250, 200);
    const a = apply(Ht, 100, 100);
    const b = apply(Hr, 100, 100);
    expect(b[0]).toBeCloseTo(a[0] / 4, 9);
    expect(b[1]).toBeCloseTo(a[1] / 4, 9);
  });
  it('sigmaAt is the source-per-output scale', () => {
    const scale2 = quadHomography([[0, 0], [2000, 0], [2000, 1500], [0, 1500]], 1000, 750);
    expect(sigmaAt(scale2, 10, 10)).toBeCloseTo(2, 9);
    expect(sigmaAt(scale2, 900, 700)).toBeCloseTo(2, 9);
    // perspective: the near (wide) side is magnified, so sigma differs across the tile
    const persp = quadHomography([[300, 0], [700, 0], [1000, 800], [0, 800]], 800, 800);
    expect(sigmaAt(persp, 400, 10)).toBeLessThan(sigmaAt(persp, 400, 790));
  });
});
