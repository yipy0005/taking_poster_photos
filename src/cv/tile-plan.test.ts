import { describe, expect, it } from 'vitest';
import type { Quad } from './geometry.ts';
import { quadHomography, sigmaAt } from './homography.ts';
import { computeOutputSize } from './output-size.ts';
import { HALO_OUT_SHARPEN, initialStripHeight, planTiles, type TilePlan } from './tile-plan.ts';

const CAP = 16_777_216;

/** Rectangle covering 80% of the frame, rolled by `deg` and scaled down only if the roll would leave the frame. */
function rolledQuad(srcW: number, srcH: number, deg: number): Quad {
  const a = (deg * Math.PI) / 180;
  const hw = 0.4 * srcW;
  const hh = 0.4 * srcH;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const bw = hw * c + hh * s;
  const bh = hw * s + hh * c;
  const k = Math.min(1, (0.48 * srcW) / bw, (0.48 * srcH) / bh);
  const rot = (x: number, y: number): [number, number] => [
    srcW / 2 + k * (x * Math.cos(a) - y * Math.sin(a)),
    srcH / 2 + k * (x * Math.sin(a) + y * Math.cos(a)),
  ];
  return [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
}

function checkCoverage(plan: TilePlan, W: number, H: number): void {
  let area = 0;
  for (const t of plan.tiles) {
    expect(t.x0).toBeGreaterThanOrEqual(0);
    expect(t.y0).toBeGreaterThanOrEqual(0);
    expect(t.x1).toBeLessThanOrEqual(W);
    expect(t.y1).toBeLessThanOrEqual(H);
    expect(t.x1).toBeGreaterThan(t.x0);
    expect(t.y1).toBeGreaterThan(t.y0);
    area += (t.x1 - t.x0) * (t.y1 - t.y0);
  }
  expect(area).toBe(W * H);
  // pairwise disjoint => together with the area sum, every output pixel is covered exactly once
  for (let i = 0; i < plan.tiles.length; i++) {
    for (let j = i + 1; j < plan.tiles.length; j++) {
      const a = plan.tiles[i]!;
      const b = plan.tiles[j]!;
      const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      expect(overlap).toBe(false);
    }
  }
}

describe('AC-36 tile planning grid', () => {
  for (const [label, srcW, srcH] of [['12 MP', 4000, 3000], ['48 MP', 8000, 6000]] as const) {
    for (const roll of [0, 5, 10, 20, 45]) {
      for (const budget of [4_000_000, 3_000_000]) {
        for (const halo of [0, HALO_OUT_SHARPEN]) {
          it(`${label}, roll ${roll}, budget ${budget / 1e6} MP, halo ${halo}`, () => {
            const quad = rolledQuad(srcW, srcH, roll);
            const out = computeOutputSize(quad, 'free', { cap: CAP });
            const Hds = quadHomography(quad, out.width, out.height);
            const plan = planTiles(Hds, out.width, out.height, srcW, srcH, budget, halo);
            expect(plan.envW * plan.envH).toBeLessThanOrEqual(budget);
            checkCoverage(plan, out.width, out.height);
            expect(plan.initialStrip).toBe(Math.min(512, Math.max(16, Math.floor(budget / out.width))));
            for (const t of plan.tiles) {
              // no 1 px slivers
              expect(t.x1 - t.x0).toBeGreaterThanOrEqual(2);
              expect(t.y1 - t.y0).toBeGreaterThanOrEqual(2);
              // sigma / k < 2 at every corner of the halo-expanded tile
              for (const [x, y] of [[t.hx0, t.hy0], [t.hx1, t.hy0], [t.hx1, t.hy1], [t.hx0, t.hy1]] as const) {
                expect(sigmaAt(Hds, x, y) / t.k).toBeLessThan(2);
              }
              expect(t.rw * t.rh).toBeLessThanOrEqual(plan.envW * plan.envH);
              expect(t.sx + t.sw).toBeLessThanOrEqual(srcW);
              expect(t.sy + t.sh).toBeLessThanOrEqual(srcH);
              // halo only extends the render area
              expect(t.hx0).toBeLessThanOrEqual(t.x0);
              expect(t.hx1).toBeGreaterThanOrEqual(t.x1);
              if (halo === 0) expect([t.hx0, t.hy0, t.hx1, t.hy1]).toEqual([t.x0, t.y0, t.x1, t.y1]);
            }
          });
        }
      }
    }
  }
});

describe('initial strip', () => {
  it('equals clamp(floor(budget / W), 16, 512) and depends on the budget', () => {
    expect(initialStripHeight(8000, 4_000_000)).toBe(500);
    expect(initialStripHeight(8000, 3_000_000)).toBe(375);
    expect(initialStripHeight(1_000_000, 4_000_000)).toBe(16);
    expect(initialStripHeight(100, 4_000_000)).toBe(512);
  });
  it('a plan that needs no halving starts from that strip and rebalances it', () => {
    const quad: Quad = [[0, 0], [8000, 0], [8000, 6000], [0, 6000]];
    const Hds = quadHomography(quad, 8000, 6000);
    const plan = planTiles(Hds, 8000, 6000, 8000, 6000, 400_000_000);
    expect(plan.initialStrip).toBe(512);
    expect(plan.th).toBe(500); // 6000 rows / ceil(6000/512)=12 strips
    expect(plan.tw).toBe(8000);
  });
});

describe('balanced tiles (finding 9)', () => {
  it('a 4729-wide output never yields a 1 px column, even at tiny budgets', () => {
    const quad: Quad = [[0, 0], [4729, 0], [4729, 3546], [0, 3546]];
    const Hds = quadHomography(quad, 4729, 3546);
    for (const budget of [3_000_000, 1_000_000, 250_000, 20_000]) {
      const plan = planTiles(Hds, 4729, 3546, 4729, 3546, budget);
      const widths = new Set(plan.tiles.map((t) => t.x1 - t.x0));
      const heights = new Set(plan.tiles.map((t) => t.y1 - t.y0));
      expect(Math.min(...widths)).toBeGreaterThan(1);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      checkCoverage(plan, 4729, 3546);
    }
  });
});

describe('terminal size', () => {
  it('1x1 is the only terminal size when no tile can meet the budget', () => {
    const quad: Quad = [[0, 0], [64, 0], [64, 64], [0, 64]];
    const Hds = quadHomography(quad, 16, 16);
    const plan = planTiles(Hds, 16, 16, 64, 64, 5);
    expect(plan.tw).toBe(1);
    expect(plan.th).toBe(1);
    expect(plan.tiles).toHaveLength(256);
    checkCoverage(plan, 16, 16);
    const ok = planTiles(Hds, 16, 16, 64, 64, 1_000_000);
    expect(ok.envW * ok.envH).toBeLessThanOrEqual(1_000_000);
    expect(ok.tiles.length).toBeLessThan(256);
  });
});
