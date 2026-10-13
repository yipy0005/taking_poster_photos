import { describe, expect, it, vi } from 'vitest';
import { CaptureError } from '../app/errors.ts';
import {
  buildPhotoSettings,
  captureStill,
  frameSize,
  probeStillSize,
  type CaptureCanvasLike,
  type CaptureDeps,
  type ImageCaptureLike,
  type PhotoCapabilitiesLike,
} from './capture.ts';

const JPEG = new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3])], { type: 'image/jpeg' });
const SENSOR: PhotoCapabilitiesLike = {
  imageWidth: { min: 1, max: 12000, step: 1 },
  imageHeight: { min: 1, max: 9000, step: 1 },
  fillLightMode: ['auto', 'off', 'flash'],
  redEyeReduction: 'controllable',
};

function fakeVideo(w = 1920, h = 1080) {
  const listeners = new Set<() => void>();
  return {
    videoWidth: w,
    videoHeight: h,
    addEventListener: (_t: 'resize', l: () => void) => listeners.add(l),
    removeEventListener: (_t: 'resize', l: () => void) => listeners.delete(l),
    fire: () => listeners.forEach((l) => l()),
    listeners,
  };
}

function fakeCanvas(blob: Blob | null = JPEG) {
  const drawn: unknown[][] = [];
  const canvas: CaptureCanvasLike & { drawn: unknown[][]; toBlobArgs: unknown[][] } = {
    width: 0,
    height: 0,
    drawn,
    toBlobArgs: [],
    getContext: () => ({ drawImage: (...a: unknown[]) => void drawn.push(a) }),
    toBlob(cb, type, quality) {
      canvas.toBlobArgs.push([type, quality, canvas.width, canvas.height]);
      cb(blob);
    },
  };
  return canvas;
}

/** A fake ImageCapture whose methods live on the prototype, like the real one (the feature test looks there). */
function fakeIC(impl: ImageCaptureLike): CaptureDeps['ImageCaptureCtor'] {
  class FakeIC {
    constructor(_track: unknown) {}
  }
  Object.assign(FakeIC.prototype, impl);
  return FakeIC as unknown as CaptureDeps['ImageCaptureCtor'];
}

interface Harness {
  deps: CaptureDeps & { track: MediaStreamTrack };
  applyConstraints: ReturnType<typeof vi.fn>;
  canvas: ReturnType<typeof fakeCanvas>;
  video: ReturnType<typeof fakeVideo>;
}

function harness(ctor: CaptureDeps['ImageCaptureCtor'], extra: Partial<Omit<CaptureDeps, 'track'>> = {}, canvas = fakeCanvas()): Harness {
  const applyConstraints = vi.fn(async () => {});
  const video = fakeVideo();
  const track = { applyConstraints } as unknown as MediaStreamTrack;
  return {
    deps: {
      track,
      video,
      ImageCaptureCtor: ctor,
      createCanvas: (w, h) => {
        canvas.width = w;
        canvas.height = h;
        return canvas;
      },
      maxSourcePixels: 64e6,
      maxOutputPixels: 16_777_216,
      resizeWaitMs: 0,
      ...extra,
    },
    applyConstraints,
    canvas,
    video,
  };
}

describe('buildPhotoSettings', () => {
  it('clamps the size and forces the flash off unless the torch is on', () => {
    expect(buildPhotoSettings(SENSOR, 64e6, false)).toEqual({ imageWidth: 9237, imageHeight: 6928, fillLightMode: 'off', redEyeReduction: false });
    expect(buildPhotoSettings(SENSOR, 64e6, true)).toEqual({ imageWidth: 9237, imageHeight: 6928, redEyeReduction: false });
  });
  it('omits fields the camera does not advertise', () => {
    expect(buildPhotoSettings({ imageWidth: { min: 1, max: 4032, step: 1 }, imageHeight: { min: 1, max: 3024, step: 1 } }, 64e6, false)).toEqual({
      imageWidth: 4032,
      imageHeight: 3024,
    });
    expect(buildPhotoSettings({}, 64e6, false)).toEqual({});
    expect(buildPhotoSettings({ redEyeReduction: 'never' }, 64e6, false)).toEqual({});
  });
});

describe('capture chain (AC-3b, AC-46)', () => {
  it('takePhoto: requests the clamped largest size and returns the sensor blob', async () => {
    const takePhoto = vi.fn(async () => JPEG);
    const h = harness(fakeIC({ getPhotoCapabilities: async () => SENSOR, takePhoto }));
    const out = await captureStill(h.deps);
    expect(out.source).toBe('camera-takephoto');
    expect(out.blob).toBe(JPEG);
    expect(takePhoto).toHaveBeenCalledWith({ imageWidth: 9237, imageHeight: 6928, fillLightMode: 'off', redEyeReduction: false });
    expect(h.applyConstraints).not.toHaveBeenCalled();
  });

  it('(a) with ImageCapture absent: does not throw and grabs a video frame', async () => {
    const h = harness(undefined);
    const out = await captureStill(h.deps);
    expect(out.source).toBe('camera-frame');
    expect(out.blob).toBe(JPEG);
    expect(h.canvas.drawn[0]?.[0]).toBe(h.video);
    expect(h.canvas.toBlobArgs[0]?.slice(0, 2)).toEqual(['image/jpeg', 0.95]);
  });

  it('(a) works with the real global deleted', async () => {
    const saved = (globalThis as { ImageCapture?: unknown }).ImageCapture;
    delete (globalThis as { ImageCapture?: unknown }).ImageCapture;
    try {
      const h = harness(undefined);
      // no ImageCaptureCtor key at all: the default lookup of the (deleted) global is used
      const { ImageCaptureCtor: _unused, ...rest } = h.deps;
      const out = await captureStill(rest);
      expect(out.source).toBe('camera-frame');
    } finally {
      if (saved !== undefined) (globalThis as { ImageCapture?: unknown }).ImageCapture = saved;
    }
  });

  it('(b) takePhoto rejects while the stream is 1920x1080: high-res constraints are applied BEFORE the frame grab', async () => {
    const order: string[] = [];
    const h = harness(
      fakeIC({
        getPhotoCapabilities: async () => SENSOR,
        takePhoto: async () => {
          order.push('takePhoto');
          throw new Error('NotSupportedError');
        },
        grabFrame: async () => {
          order.push('grabFrame');
          return { width: 4000, height: 3000, close: vi.fn() } as unknown as ImageBitmap;
        },
      }),
    );
    h.applyConstraints.mockImplementation(async () => {
      order.push('applyConstraints');
    });
    const out = await captureStill(h.deps);
    expect(order).toEqual(['takePhoto', 'applyConstraints', 'grabFrame']);
    expect(h.applyConstraints).toHaveBeenCalledWith({ width: { ideal: 4096 }, height: { ideal: 3072 } });
    expect(out.source).toBe('camera-frame');
  });

  it('(b) waits for the video resize event after re-applying constraints, but only up to the timeout', async () => {
    const h = harness(undefined, { resizeWaitMs: 5000 });
    const p = captureStill(h.deps);
    await vi.waitFor(() => expect(h.video.listeners.size).toBe(1));
    h.video.fire();
    await expect(p).resolves.toMatchObject({ source: 'camera-frame' });
    expect(h.video.listeners.size).toBe(0);
  });

  it('(c) grabFrame returns an ImageBitmap: blob comes from canvas.toBlob, the bitmap is closed and the canvas zeroed', async () => {
    const close = vi.fn();
    const bitmap = { width: 6000, height: 4000, close } as unknown as ImageBitmap;
    const h = harness(fakeIC({ grabFrame: async () => bitmap }));
    const out = await captureStill(h.deps);
    expect(out.blob).toBe(JPEG);
    expect(h.canvas.drawn[0]?.[0]).toBe(bitmap);
    // 24 MP frame is scaled to the 16.7 MP output cap
    expect(out.width! * out.height!).toBeLessThanOrEqual(16_777_216);
    expect(h.canvas.toBlobArgs[0]?.[2]).toBe(out.width);
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.canvas.width).toBe(0);
    expect(h.canvas.height).toBe(0);
  });

  it('closes the bitmap and zeroes the canvas even when toBlob fails', async () => {
    const close = vi.fn();
    const h = harness(fakeIC({ grabFrame: async () => ({ width: 800, height: 600, close }) as unknown as ImageBitmap }), {}, fakeCanvas(null));
    await expect(captureStill(h.deps)).rejects.toBeInstanceOf(CaptureError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.canvas.width).toBe(0);
  });

  it('rejects a zero-size video frame as a frame error', async () => {
    const h = harness(undefined);
    h.video.videoWidth = 0;
    await expect(captureStill(h.deps)).rejects.toMatchObject({ kind: 'frame' });
  });

  it('keeps going when applyConstraints throws', async () => {
    const h = harness(undefined);
    h.applyConstraints.mockRejectedValue(new Error('overconstrained'));
    await expect(captureStill(h.deps)).resolves.toMatchObject({ source: 'camera-frame' });
  });

  it('still calls takePhoto (with default settings) when getPhotoCapabilities fails', async () => {
    const takePhoto = vi.fn(async () => JPEG);
    const out = await captureStill(
      harness(
        fakeIC({
          getPhotoCapabilities: async () => {
            throw new Error('nope');
          },
          takePhoto,
        }),
      ).deps,
    );
    expect(takePhoto).toHaveBeenCalledWith({});
    expect(out.source).toBe('camera-takephoto');
  });

  it('treats an empty takePhoto blob as a failure and falls through to the frame grab', async () => {
    const out = await captureStill(harness(fakeIC({ getPhotoCapabilities: async () => SENSOR, takePhoto: async () => new Blob([]) })).deps);
    expect(out.source).toBe('camera-frame');
  });
});

describe('probeStillSize (achieved-resolution readout)', () => {
  const track = {} as MediaStreamTrack;
  it('reports the clamped photo size takePhoto will produce', async () => {
    const ctor = fakeIC({ getPhotoCapabilities: async () => SENSOR, takePhoto: async () => JPEG });
    expect(await probeStillSize(track, 50e6, ctor)).toEqual({ width: 8164, height: 6123 });
  });
  it('is null without ImageCapture or with unusable capabilities', async () => {
    expect(await probeStillSize(track, 50e6, undefined)).toBeNull();
    expect(await probeStillSize(track, 50e6, fakeIC({ getPhotoCapabilities: async () => ({}), takePhoto: async () => JPEG }))).toBeNull();
    expect(
      await probeStillSize(
        track,
        50e6,
        fakeIC({
          getPhotoCapabilities: async () => {
            throw new Error('x');
          },
          takePhoto: async () => JPEG,
        }),
      ),
    ).toBeNull();
  });
});

describe('frameSize', () => {
  it('leaves frames within the cap alone and scales larger ones down', () => {
    expect(frameSize(4000, 3000, 16_777_216)).toEqual({ width: 4000, height: 3000 });
    const s = frameSize(8000, 6000, 16_777_216);
    expect(s.width * s.height).toBeLessThanOrEqual(16_777_216);
    expect(s.width / s.height).toBeCloseTo(4 / 3, 2);
  });
});
