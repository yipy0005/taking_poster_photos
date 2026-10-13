import { describe, expect, it } from 'vitest';
import type { Pt } from '../../cv/geometry.ts';
import { FINGER_CLEARANCE, LOUPE_MAGNIFICATION, LOUPE_SIZE, MIN_MAGNIFICATION, clipBlit, loupeSourceRect, placeLoupe } from './loupe.ts';

const STAGE = { width: 400, height: 600 };
const R = LOUPE_SIZE / 2;

describe('magnification (AC-10)', () => {
  it('defaults to at least 3x', () => {
    expect(LOUPE_MAGNIFICATION).toBeGreaterThanOrEqual(MIN_MAGNIFICATION);
  });

  it('shows size/m CSS pixels of the stage, expressed in preview pixels', () => {
    // 5 preview px per CSS px, 4x: the 120 px loupe shows a 30 css px = 150 preview px square
    const r = loupeSourceRect([1000, 800], 5);
    expect(r).toEqual({ x: 925, y: 725, w: 150, h: 150 });
  });

  it('never magnifies less than 3x even if asked to', () => {
    const r = loupeSourceRect([100, 100], 1, LOUPE_SIZE, 1.5);
    expect(r.w).toBeCloseTo(LOUPE_SIZE / 3, 10);
    expect(LOUPE_SIZE / r.w).toBeGreaterThanOrEqual(3);
  });
});

describe('placeLoupe: never under the finger and always on the stage', () => {
  const dirs: Pt[] = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0, 0],
  ];

  it('holds for fingers everywhere on the stage and every inward direction', () => {
    for (let x = 0; x <= STAGE.width; x += 20) {
      for (let y = 0; y <= STAGE.height; y += 20) {
        for (const d of dirs) {
          const c = placeLoupe([x, y], d, STAGE);
          expect(c[0] - R).toBeGreaterThanOrEqual(-1e-9);
          expect(c[0] + R).toBeLessThanOrEqual(STAGE.width + 1e-9);
          expect(c[1] - R).toBeGreaterThanOrEqual(-1e-9);
          expect(c[1] + R).toBeLessThanOrEqual(STAGE.height + 1e-9);
          expect(Math.hypot(c[0] - x, c[1] - y)).toBeGreaterThanOrEqual(R + FINGER_CLEARANCE - 1e-9);
        }
      }
    }
  });

  it('sits diagonally toward the quad interior when there is room', () => {
    const c = placeLoupe([200, 300], [1, 1], STAGE);
    expect(c[0]).toBeGreaterThan(200);
    expect(c[1]).toBeGreaterThan(300);
    expect(c[0] - 200).toBeCloseTo(c[1] - 300, 6);
  });

  it('flips to the opposite side when the preferred side would leave the stage', () => {
    // finger near the top-left corner with the interior direction pointing off-stage
    const c = placeLoupe([30, 30], [-1, -1], STAGE);
    expect(c[0]).toBeGreaterThan(30);
    expect(c[1]).toBeGreaterThan(30);
  });
});

describe('clipBlit', () => {
  it('returns the full rectangle when it is inside the image', () => {
    expect(clipBlit({ x: 10, y: 20, w: 30, h: 30 }, 100, 100, 240)).toEqual({ sx: 10, sy: 20, sw: 30, sh: 30, dx: 0, dy: 0, dw: 240, dh: 240 });
  });

  it('clips at the top-left and scales the destination to match', () => {
    const b = clipBlit({ x: -10, y: -10, w: 40, h: 40 }, 100, 100, 240)!;
    expect(b).toEqual({ sx: 0, sy: 0, sw: 30, sh: 30, dx: 60, dy: 60, dw: 180, dh: 180 });
  });

  it('clips at the bottom-right', () => {
    const b = clipBlit({ x: 80, y: 90, w: 40, h: 40 }, 100, 100, 240)!;
    expect(b).toMatchObject({ sx: 80, sy: 90, sw: 20, sh: 10, dx: 0, dy: 0, dw: 120, dh: 60 });
  });

  it('returns null when nothing is visible', () => {
    expect(clipBlit({ x: 200, y: 200, w: 10, h: 10 }, 100, 100, 240)).toBeNull();
  });
});
