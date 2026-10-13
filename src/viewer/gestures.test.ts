import { describe, expect, it } from 'vitest';
import { GestureRecognizer, type GestureHandlers, type PinchDelta } from './gestures.ts';
import type { Velocity } from './inertia.ts';

function setup() {
  const log = { starts: 0, pans: [] as Array<[number, number]>, pinches: [] as PinchDelta[], releases: [] as Velocity[], taps: [] as Array<[number, number]> };
  const handlers: GestureHandlers = {
    onStart: () => void log.starts++,
    onPan: (dx, dy) => void log.pans.push([dx, dy]),
    onPinch: (d) => void log.pinches.push(d),
    onRelease: (v) => void log.releases.push(v),
    onDoubleTap: (x, y) => void log.taps.push([x, y]),
  };
  return { g: new GestureRecognizer(handlers), log };
}

describe('GestureRecognizer', () => {
  it('pans with one pointer and releases with a velocity', () => {
    const { g, log } = setup();
    g.pointerDown(1, 100, 100, 0);
    g.pointerMove(1, 120, 100, 20);
    g.pointerMove(1, 160, 100, 40);
    g.pointerUp(1, 200, 100, 60);
    expect(log.pans).toEqual([[20, 0], [40, 0]]);
    expect(log.releases).toHaveLength(1);
    expect(log.releases[0]!.vx).toBeGreaterThan(1);
  });
  it('pinches with two pointers: ratio and midpoint', () => {
    const { g, log } = setup();
    g.pointerDown(1, 100, 100, 0);
    g.pointerDown(2, 200, 100, 5);
    g.pointerMove(2, 300, 100, 10);
    expect(log.pinches).toHaveLength(1);
    expect(log.pinches[0]!.ratio).toBeCloseTo(2, 6);
    expect(log.pinches[0]!.from).toEqual({ x: 150, y: 100 });
    expect(log.pinches[0]!.to).toEqual({ x: 200, y: 100 });
    g.pointerUp(2, 300, 100, 20);
    g.pointerUp(1, 100, 100, 25);
    expect(log.releases.at(-1)).toEqual({ vx: 0, vy: 0 });
  });
  it('a second tap within 300 ms and 30 px is a double tap', () => {
    const { g, log } = setup();
    g.pointerDown(1, 100, 100, 0);
    g.pointerUp(1, 100, 100, 50);
    g.pointerDown(1, 110, 105, 150);
    g.pointerUp(1, 110, 105, 200);
    expect(log.taps).toEqual([[110, 105]]);
  });
  it('slow or distant second taps are not double taps', () => {
    const { g, log } = setup();
    g.pointerDown(1, 100, 100, 0);
    g.pointerUp(1, 100, 100, 50);
    g.pointerDown(1, 100, 100, 500);
    g.pointerUp(1, 100, 100, 550);
    g.pointerDown(1, 300, 300, 600);
    g.pointerUp(1, 300, 300, 640);
    expect(log.taps).toEqual([]);
  });
  it('a drag is not a tap', () => {
    const { g, log } = setup();
    g.pointerDown(1, 100, 100, 0);
    g.pointerMove(1, 160, 100, 30);
    g.pointerUp(1, 160, 100, 60);
    g.pointerDown(1, 160, 100, 120);
    g.pointerUp(1, 160, 100, 150);
    expect(log.taps).toEqual([]);
  });
  it('a new pointer down always notifies so inertia can stop', () => {
    const { g, log } = setup();
    g.pointerDown(1, 0, 0, 0);
    g.pointerDown(2, 10, 10, 1);
    expect(log.starts).toBe(2);
  });
  it('cancel releases without velocity', () => {
    const { g, log } = setup();
    g.pointerDown(1, 0, 0, 0);
    g.pointerCancel(1);
    expect(log.releases).toEqual([{ vx: 0, vy: 0 }]);
  });
});
