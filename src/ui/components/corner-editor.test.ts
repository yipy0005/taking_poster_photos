import { describe, expect, it } from 'vitest';
import { isValidQuad, scaleQuad, type Pt, type Quad } from '../../cv/geometry.ts';
import { clampPoint, moveCorner, nudgeCorner, nudgeStep, replaceCorner, type QuadValidator } from './corner-editor.ts';

const ORIG = { width: 4000, height: 3000 };

/** What adjust-screen does: convert preview coordinates to ORIGINAL pixels, then validate (plan.md finding 13). */
const validatorFor = (previewWidth: number): QuadValidator => {
  const s = ORIG.width / previewWidth;
  return (q) => isValidQuad(scaleQuad(q, s), ORIG.width, ORIG.height);
};

const PREVIEW = { width: 1000, height: 750 };
const QUAD: Quad = [
  [100, 100],
  [900, 100],
  [900, 650],
  [100, 650],
];
const valid = validatorFor(PREVIEW.width);

describe('moveCorner (AC-10)', () => {
  it('follows the finger while the quad stays valid', () => {
    const r = moveCorner(QUAD, 1, [950, 120], PREVIEW, valid);
    expect(r.frozen).toBe(false);
    expect(r.quad[1]).toEqual([950, 120]);
    expect(r.quad[0]).toEqual(QUAD[0]);
  });

  it('holds the LAST valid position when a move would break convexity, and resumes following when valid again', () => {
    let q = QUAD;
    const moves: Array<{ to: Pt; expectFrozen: boolean }> = [
      { to: [920, 200], expectFrozen: false },
      { to: [800, 300], expectFrozen: false }, // last valid position
      { to: [50, 700], expectFrozen: true }, // jumps across the quad: not convex
      { to: [30, 720], expectFrozen: true },
      { to: [880, 120], expectFrozen: false }, // valid again: follows the finger (no snap back to the drag start)
    ];
    const trail: Pt[] = [];
    for (const m of moves) {
      const r = moveCorner(q, 1, m.to, PREVIEW, valid);
      expect(r.frozen).toBe(m.expectFrozen);
      q = r.quad;
      trail.push(q[1]!);
    }
    expect(trail[2]).toEqual([800, 300]); // frozen at the last valid position
    expect(trail[3]).toEqual([800, 300]); // still held
    expect(trail[4]).toEqual([880, 120]); // resumes
    expect(trail[4]).not.toEqual(QUAD[1]); // did not return to where the drag began
  });

  it('never leaves the image: targets are clamped', () => {
    const r = moveCorner(QUAD, 0, [-50, -20], PREVIEW, valid);
    expect(r.quad[0]).toEqual([0, 0]);
    const r2 = moveCorner(QUAD, 2, [5000, 5000], PREVIEW, valid);
    expect(r2.quad[2]).toEqual([1000, 750]);
  });

  it('does not mutate the input quad', () => {
    const copy = JSON.stringify(QUAD);
    moveCorner(QUAD, 3, [150, 600], PREVIEW, valid);
    expect(JSON.stringify(QUAD)).toBe(copy);
  });

  it('refuses a corner that would make the area too small', () => {
    const r = moveCorner(QUAD, 2, [101, 101], PREVIEW, valid);
    expect(r.frozen).toBe(true);
    expect(r.quad).toBe(QUAD);
  });
});

describe('validity is judged in original pixels (finding 13)', () => {
  // A trapezoid whose top edge is 7 preview px: 28 px at preview scale 0.25 (4000 / 1000), 14 px at scale 0.5.
  // The minimum edge is 24 ORIGINAL pixels, so the same preview coordinates mean different things at different scales.
  const trapezoid: Quad = [
    [400, 200],
    [407, 200],
    [900, 600],
    [100, 600],
  ];

  it('preview scale 0.25 (1000 px wide): the 28 px original edge is valid, though 7 px in preview space would not be', () => {
    expect(validatorFor(1000)(trapezoid)).toBe(true);
    expect(isValidQuad(trapezoid, 1000, 750)).toBe(false); // validating in preview space gives the wrong answer
  });

  it('preview scale 0.5 (2000 px wide): the same coordinates are a 14 px original edge and are refused', () => {
    expect(validatorFor(2000)(trapezoid)).toBe(false);
  });

  it('a normal quad passes at both scales', () => {
    expect(validatorFor(1000)(QUAD)).toBe(true);
    expect(validatorFor(2000)(QUAD)).toBe(true);
  });
});

describe('keyboard nudging (AC-11)', () => {
  it('moves 1 px, or 10 px with Shift, in preview space', () => {
    expect(nudgeStep(false)).toBe(1);
    expect(nudgeStep(true)).toBe(10);
    const a = nudgeCorner(QUAD, 0, nudgeStep(false), 0, PREVIEW, valid);
    expect(a.quad[0]).toEqual([101, 100]);
    const b = nudgeCorner(QUAD, 0, 0, -nudgeStep(true), PREVIEW, valid);
    expect(b.quad[0]).toEqual([100, 90]);
  });

  it('stops at the image border', () => {
    const q = replaceCorner(QUAD, 0, [0, 0]);
    const r = nudgeCorner(q, 0, -10, -10, PREVIEW, valid);
    expect(r.quad[0]).toEqual([0, 0]);
  });

  it('refuses a nudge that would make the quad invalid', () => {
    // push BL far right across the TL-BR diagonal region until it breaks
    let q = QUAD;
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const r = nudgeCorner(q, 3, 10, -10, PREVIEW, valid);
      if (r.frozen) {
        blocked = true;
        expect(r.quad).toBe(q);
        break;
      }
      q = r.quad;
    }
    expect(blocked).toBe(true);
    expect(valid(q)).toBe(true);
  });
});

describe('clampPoint', () => {
  it('clamps to the image rectangle', () => {
    expect(clampPoint([-1, 5000], PREVIEW)).toEqual([0, 750]);
    expect(clampPoint([10, 20], PREVIEW)).toEqual([10, 20]);
  });
});
