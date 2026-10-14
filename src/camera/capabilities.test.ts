import { describe, expect, it } from 'vitest';
import { formatResolution, hasGrabFrame, hasImageCapture, mapTapToVideo, readCapabilities, suggestNativeCamera } from './capabilities.ts';

describe('readCapabilities (AC-7)', () => {
  it('reports nothing for missing or empty capabilities', () => {
    for (const raw of [undefined, null, {}, 'x']) {
      expect(readCapabilities(raw)).toEqual({
        torch: false,
        zoom: null,
        tapFocus: false,
        maxWidth: null,
        maxHeight: null,
        exposureModes: [],
        exposureCompensation: null,
        whiteBalanceModes: [],
      });
    }
  });

  it('reports torch, zoom and focus only when present', () => {
    const c = readCapabilities({
      torch: true,
      zoom: { min: 1, max: 8, step: 0.1 },
      focusMode: ['continuous', 'single-shot'],
      width: { min: 1, max: 4032 },
      height: { min: 1, max: 3024 },
    });
    expect(c).toEqual({
      torch: true,
      zoom: { min: 1, max: 8, step: 0.1 },
      tapFocus: true,
      maxWidth: 4032,
      maxHeight: 3024,
      exposureModes: [],
      exposureCompensation: null,
      whiteBalanceModes: [],
    });
  });

  it('reports exposure modes, exposure compensation and white-balance modes only when present', () => {
    const c = readCapabilities({
      exposureMode: ['manual', 'continuous'],
      exposureCompensation: { min: -3, max: 3, step: 0.5 },
      whiteBalanceMode: ['continuous', 'manual'],
    });
    expect(c.exposureModes).toEqual(['manual', 'continuous']);
    expect(c.exposureCompensation).toEqual({ min: -3, max: 3, step: 0.5 });
    expect(c.whiteBalanceModes).toEqual(['continuous', 'manual']);
    expect(readCapabilities({ exposureCompensation: { min: 0, max: 0, step: 1 } }).exposureCompensation).toBeNull();
  });
  it('does not offer tap-to-focus for continuous-only focus', () => {
    expect(readCapabilities({ focusMode: ['continuous'] }).tapFocus).toBe(false);
  });

  it('offers tap-to-focus when pointsOfInterest exists', () => {
    expect(readCapabilities({ pointsOfInterest: true }).tapFocus).toBe(true);
  });

  it('ignores a degenerate zoom range', () => {
    expect(readCapabilities({ zoom: { min: 1, max: 1, step: 0.1 } }).zoom).toBeNull();
    expect(readCapabilities({ torch: 'yes' }).torch).toBe(false);
  });
});

describe('feature tests', () => {
  it('do not throw where ImageCapture is undefined (AC-46a)', () => {
    expect(hasImageCapture({})).toBe(false);
    expect(hasGrabFrame({})).toBe(false);
  });
  it('detect takePhoto and grabFrame on the prototype', () => {
    class A {
      takePhoto() {}
    }
    class B {
      takePhoto() {}
      grabFrame() {}
    }
    expect(hasImageCapture({ ImageCapture: A })).toBe(true);
    expect(hasGrabFrame({ ImageCapture: A })).toBe(false);
    expect(hasGrabFrame({ ImageCapture: B })).toBe(true);
    expect(hasImageCapture({ ImageCapture: class {} })).toBe(false);
  });
});

describe('resolution readout (AC-1, AC-3)', () => {
  it('formats WxH and megapixels', () => {
    expect(formatResolution(4032, 3024)).toBe('4032x3024, 12.2 MP');
  });
  it('suggests the native camera below 8 MP only', () => {
    expect(suggestNativeCamera(1920, 1080)).toBe(true);
    expect(suggestNativeCamera(4032, 3024)).toBe(false);
    expect(suggestNativeCamera(3264, 2448)).toBe(true); // 7.99 MP is still below the limit
    expect(suggestNativeCamera(3280, 2460)).toBe(false);
    expect(suggestNativeCamera(undefined, undefined)).toBe(false);
  });
});

describe('mapTapToVideo (object-fit: cover)', () => {
  it('maps the centre of the box to the centre of the video', () => {
    expect(mapTapToVideo({ x: 200, y: 400 }, { width: 400, height: 800 }, { width: 1920, height: 1080 })).toEqual({ x: 0.5, y: 0.5 });
  });
  it('accounts for cropped sides', () => {
    // 1920x1080 video in a 400x800 portrait box: scaled to 1422x800, 511 px cropped on each side
    const p = mapTapToVideo({ x: 0, y: 0 }, { width: 400, height: 800 }, { width: 1920, height: 1080 })!;
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.x).toBeCloseTo((0 - (400 - 1422.2222) / 2) / 1422.2222, 3);
  });
  it('returns null for degenerate sizes', () => {
    expect(mapTapToVideo({ x: 1, y: 1 }, { width: 0, height: 10 }, { width: 10, height: 10 })).toBeNull();
  });
});
