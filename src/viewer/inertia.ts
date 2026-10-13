// Release velocity and exponential inertia decay (design 2.12). Pure, DOM-free. Velocities are px/ms.
export const INERTIA_TAU_MS = 325;
export const INERTIA_STOP_SPEED = 0.02;
export const VELOCITY_WINDOW_MS = 100;
export const VELOCITY_SAMPLES = 5;

export interface Sample {
  t: number;
  x: number;
  y: number;
}
export interface Velocity {
  vx: number;
  vy: number;
}

/** Velocity from the last (up to) 5 samples that lie within 100 ms of the last one. */
export function releaseVelocity(samples: readonly Sample[], now?: number): Velocity {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1]!;
  // a pointer that rested before lifting has no velocity
  if (now !== undefined && now - last.t > VELOCITY_WINDOW_MS) return { vx: 0, vy: 0 };
  const recent = samples.slice(-VELOCITY_SAMPLES).filter((s) => last.t - s.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  if (!first || first === last) return { vx: 0, vy: 0 };
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

export const speedOf = (v: Velocity): number => Math.hypot(v.vx, v.vy);

export interface InertiaStep {
  v: Velocity;
  dx: number;
  dy: number;
  done: boolean;
}

/**
 * Advances inertia by `dt` ms: velocity decays as `v *= exp(-dt / 325)` and the displacement is the exact integral over the step.
 * `done` once the speed is below 0.02 px/ms.
 */
export function stepInertia(v: Velocity, dt: number): InertiaStep {
  if (dt <= 0) return { v, dx: 0, dy: 0, done: speedOf(v) < INERTIA_STOP_SPEED };
  const decay = Math.exp(-dt / INERTIA_TAU_MS);
  const travel = INERTIA_TAU_MS * (1 - decay);
  const next = { vx: v.vx * decay, vy: v.vy * decay };
  return { v: next, dx: v.vx * travel, dy: v.vy * travel, done: speedOf(next) < INERTIA_STOP_SPEED };
}

/** Total distance an initial velocity travels before stopping (for tests and spring-back targets). */
export function inertiaDistance(v: Velocity): { dx: number; dy: number } {
  return { dx: v.vx * INERTIA_TAU_MS, dy: v.vy * INERTIA_TAU_MS };
}
