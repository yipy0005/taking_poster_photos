import { describe, expect, it, vi } from 'vitest';
import { CameraError } from '../app/errors.ts';
import { buildVideoConstraints, mapCameraError, openCamera, type CameraEnv } from './camera-session.ts';

function fakeTrack(opts: { settings?: MediaTrackSettings; caps?: unknown; applyFails?: boolean } = {}) {
  const applied: MediaTrackConstraints[] = [];
  const track = {
    stop: vi.fn(),
    getSettings: () => opts.settings ?? { width: 1280, height: 720 },
    getCapabilities: () => opts.caps ?? {},
    applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
      applied.push(c);
      if (opts.applyFails) throw new Error('nope');
    }),
  };
  return { track, applied };
}
function fakeStream(track: ReturnType<typeof fakeTrack>['track'] | null): MediaStream {
  const tracks = track ? [track] : [];
  return { getVideoTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}
const domError = (name: string): Error => Object.assign(new Error(name), { name });

describe('buildVideoConstraints', () => {
  it('asks for a small preview where takePhoto exists and a large stream where it does not', () => {
    const withIc = buildVideoConstraints(true).video as MediaTrackConstraints;
    const without = buildVideoConstraints(false).video as MediaTrackConstraints;
    expect(withIc.width).toEqual({ ideal: 1920 });
    expect(without.width).toEqual({ ideal: 4096 });
    expect(without.height).toEqual({ ideal: 3072 });
    expect(without.facingMode).toEqual({ ideal: 'environment' });
  });
});

describe('mapCameraError (design 2.16)', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['NotFoundError', 'none'],
    ['DevicesNotFoundError', 'none'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['SecurityError', 'insecure'],
  ])('%s -> %s', (name, kind) => {
    expect(mapCameraError(domError(name)).kind).toBe(kind);
  });
});

describe('openCamera', () => {
  const env = (getUserMedia: CameraEnv['getUserMedia'], extra: Partial<CameraEnv> = {}): CameraEnv => ({
    isSecureContext: true,
    getUserMedia,
    hasImageCapture: false,
    ...extra,
  });

  it('refuses insecure contexts without calling getUserMedia (AC-6)', async () => {
    const gum = vi.fn();
    await expect(openCamera(env(gum, { isSecureContext: false }))).rejects.toMatchObject({ kind: 'insecure' });
    expect(gum).not.toHaveBeenCalled();
  });

  it('reports "none" when getUserMedia does not exist', async () => {
    await expect(openCamera(env(undefined))).rejects.toMatchObject({ kind: 'none' });
  });

  it('maps a permission denial', async () => {
    await expect(openCamera(env(async () => Promise.reject(domError('NotAllowedError'))))).rejects.toBeInstanceOf(CameraError);
    await expect(openCamera(env(async () => Promise.reject(domError('NotAllowedError'))))).rejects.toMatchObject({ kind: 'denied' });
  });

  it('retries OverconstrainedError with relaxed constraints', async () => {
    const { track } = fakeTrack();
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      if (gum.mock.calls.length < 3) throw domError('OverconstrainedError');
      expect(c.video).toBe(true);
      return fakeStream(track);
    });
    const s = await openCamera(env(gum));
    expect(gum).toHaveBeenCalledTimes(3);
    expect(gum.mock.calls[1]?.[0]).toEqual({ video: { facingMode: 'environment' }, audio: false });
    expect(s.track).toBe(track);
  });

  it('gives up with "none" when every constraint set fails', async () => {
    const gum = vi.fn(async () => Promise.reject(domError('OverconstrainedError')));
    await expect(openCamera(env(gum))).rejects.toMatchObject({ kind: 'none' });
    expect(gum).toHaveBeenCalledTimes(3);
  });

  it('raises the stream to the track maximum when ImageCapture is absent', async () => {
    const { track, applied } = fakeTrack({ settings: { width: 1280, height: 720 }, caps: { width: { max: 4032 }, height: { max: 3024 } } });
    await openCamera(env(async () => fakeStream(track)));
    expect(applied).toEqual([{ width: { ideal: 4032 }, height: { ideal: 3024 } }]);
  });

  it('does not touch the preview resolution when ImageCapture exists, and ignores applyConstraints failures', async () => {
    const a = fakeTrack({ caps: { width: { max: 4032 }, height: { max: 3024 } } });
    await openCamera(env(async () => fakeStream(a.track), { hasImageCapture: true }));
    expect(a.applied).toEqual([]);
    const b = fakeTrack({ caps: { width: { max: 4032 }, height: { max: 3024 } }, applyFails: true });
    await expect(openCamera(env(async () => fakeStream(b.track)))).resolves.toBeDefined();
  });

  it('shows controls only for supported capabilities and applies them via advanced constraints (AC-7)', async () => {
    const plain = fakeTrack();
    const s0 = await openCamera(env(async () => fakeStream(plain.track)));
    expect(await s0.setTorch(true)).toBe(false);
    expect(await s0.setZoom(2)).toBe(false);
    expect(await s0.focusAt(0.5, 0.5)).toBe(false);
    expect(plain.applied).toEqual([]);

    const rich = fakeTrack({ caps: { torch: true, zoom: { min: 1, max: 4, step: 0.1 }, focusMode: ['single-shot'] } });
    const s1 = await openCamera(env(async () => fakeStream(rich.track), { hasImageCapture: true }));
    expect(await s1.setTorch(true)).toBe(true);
    expect(await s1.setZoom(2)).toBe(true);
    expect(await s1.focusAt(0.25, 0.75)).toBe(true);
    expect(rich.applied).toEqual([
      { advanced: [{ torch: true }] },
      { advanced: [{ zoom: 2 }] },
      { advanced: [{ pointsOfInterest: [{ x: 0.25, y: 0.75 }], focusMode: 'single-shot' }] },
    ]);
  });

  it('stops every track once, idempotently', async () => {
    const { track } = fakeTrack();
    const s = await openCamera(env(async () => fakeStream(track)));
    s.stop();
    s.stop();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(s.stopped).toBe(true);
  });

  it('closes the stream when it has no video track', async () => {
    await expect(openCamera(env(async () => fakeStream(null)))).rejects.toMatchObject({ kind: 'none' });
  });
});
