import { describe, expect, it } from 'vitest';
import { INERTIA_STOP_SPEED, INERTIA_TAU_MS, inertiaDistance, releaseVelocity, speedOf, stepInertia } from './inertia.ts';

describe('releaseVelocity', () => {
  it('uses the last samples within 100 ms', () => {
    const v = releaseVelocity([
      { t: 0, x: 0, y: 0 },
      { t: 300, x: 500, y: 0 }, // too old
      { t: 350, x: 510, y: 0 },
      { t: 400, x: 530, y: 10 },
    ]);
    // window: samples at 350 and 400 (and 300 is 100 ms before 400, inclusive)
    expect(v.vx).toBeGreaterThan(0.2);
    expect(v.vx).toBeLessThan(0.6);
    expect(v.vy).toBeGreaterThan(0);
  });
  it('is zero for a single sample, a stationary finger or a late release', () => {
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }])).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([{ t: 0, x: 5, y: 5 }, { t: 50, x: 5, y: 5 }])).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 20, x: 100, y: 0 }], 400)).toEqual({ vx: 0, vy: 0 });
  });
  it('considers at most 5 samples', () => {
    const s = Array.from({ length: 12 }, (_, i) => ({ t: i * 10, x: i < 7 ? 0 : (i - 6) * 100, y: 0 }));
    const v = releaseVelocity(s);
    expect(v.vx).toBeGreaterThan(5);
  });
});

describe('stepInertia', () => {
  it('decays velocity as exp(-dt / 325)', () => {
    const s = stepInertia({ vx: 2, vy: -1 }, 100);
    const f = Math.exp(-100 / INERTIA_TAU_MS);
    expect(s.v.vx).toBeCloseTo(2 * f, 9);
    expect(s.v.vy).toBeCloseTo(-1 * f, 9);
    expect(s.done).toBe(false);
  });
  it('integrates the displacement exactly: many small steps equal one big step', () => {
    let v = { vx: 1.5, vy: 0.5 };
    let x = 0;
    let y = 0;
    for (let i = 0; i < 100; i++) {
      const s = stepInertia(v, 10);
      v = s.v;
      x += s.dx;
      y += s.dy;
    }
    const once = stepInertia({ vx: 1.5, vy: 0.5 }, 1000);
    expect(x).toBeCloseTo(once.dx, 6);
    expect(y).toBeCloseTo(once.dy, 6);
  });
  it('never travels beyond v * tau', () => {
    const total = inertiaDistance({ vx: 2, vy: 0 });
    expect(total.dx).toBe(2 * INERTIA_TAU_MS);
    expect(stepInertia({ vx: 2, vy: 0 }, 1e6).dx).toBeCloseTo(total.dx, 6);
  });
  it('stops below 0.02 px/ms', () => {
    expect(stepInertia({ vx: 0.019, vy: 0 }, 16).done).toBe(true);
    let v = { vx: 3, vy: 0 };
    let steps = 0;
    while (!stepInertia(v, 16).done && steps < 10_000) {
      v = stepInertia(v, 16).v;
      steps++;
    }
    expect(speedOf(v)).toBeGreaterThanOrEqual(INERTIA_STOP_SPEED * 0.5);
    expect(steps).toBeGreaterThan(10);
    expect(steps).toBeLessThan(10_000);
  });
  it('does nothing for a zero time step', () => {
    expect(stepInertia({ vx: 1, vy: 1 }, 0)).toMatchObject({ dx: 0, dy: 0, done: false });
  });
});
