// Camera session: getUserMedia negotiation, track lifecycle and capability-gated controls (design 2.9, 2.16).
// Owns the MediaStream; the capture screen stops it on route change and when the document is hidden.
import { CameraError } from '../app/errors.ts';
import { log } from '../app/log.ts';
import { hasImageCapture, readCapabilities, type CameraCapabilities } from './capabilities.ts';

export interface CameraEnv {
  isSecureContext: boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** ImageCapture with takePhoto exists (decides the preview resolution, design 2.9). */
  hasImageCapture: boolean;
}

export function defaultCameraEnv(): CameraEnv {
  const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  return {
    isSecureContext: typeof isSecureContext === 'boolean' ? isSecureContext : false,
    getUserMedia: md && typeof md.getUserMedia === 'function' ? (c) => md.getUserMedia(c) : undefined,
    hasImageCapture: hasImageCapture(),
  };
}

/** With takePhoto the preview can stay small (the still comes from the sensor); without it the stream must be large. */
export function buildVideoConstraints(imageCapture: boolean): MediaStreamConstraints {
  const video: MediaTrackConstraints = imageCapture
    ? { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } };
  return { video, audio: false };
}

const errName = (e: unknown): string => (typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '');

/** Maps a getUserMedia failure to the CameraError kinds of design 2.16. */
export function mapCameraError(e: unknown): CameraError {
  if (e instanceof CameraError) return e;
  switch (errName(e)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new CameraError('denied', 'Camera access is blocked');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('none', 'No camera found');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('busy', 'Camera is in use by another app');
    case 'SecurityError':
      return new CameraError('insecure', 'Camera needs HTTPS');
    default:
      return new CameraError('none', 'No camera found');
  }
}

export interface CameraSession {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly capabilities: CameraCapabilities;
  readonly stopped: boolean;
  /** Current stream size (preview resolution). */
  size(): { width: number; height: number } | null;
  setTorch(on: boolean): Promise<boolean>;
  setZoom(zoom: number): Promise<boolean>;
  /** Normalised video coordinates (0..1). Resolves true when the camera accepted the request. */
  focusAt(x: number, y: number): Promise<boolean>;
  /** Stops every track. Idempotent. */
  stop(): void;
}

const advanced = (c: Record<string, unknown>): MediaTrackConstraints => ({ advanced: [c] }) as MediaTrackConstraints;

async function startStream(env: CameraEnv): Promise<MediaStream> {
  const getUserMedia = env.getUserMedia;
  if (!getUserMedia) throw new CameraError('none', 'No camera found');
  // OverconstrainedError: retry once with a plain environment camera, then with any video (design 2.16).
  const attempts: MediaStreamConstraints[] = [
    buildVideoConstraints(env.hasImageCapture),
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false },
  ];
  let last: unknown;
  for (const constraints of attempts) {
    try {
      return await getUserMedia(constraints);
    } catch (e) {
      last = e;
      if (errName(e) !== 'OverconstrainedError') break;
      log.warn('camera constraints rejected; relaxing', e);
    }
  }
  throw mapCameraError(last);
}

/** Opens the rear camera. Throws CameraError with a kind the UI maps to an error screen. */
export async function openCamera(env: CameraEnv = defaultCameraEnv()): Promise<CameraSession> {
  if (!env.isSecureContext) throw new CameraError('insecure', 'Camera needs HTTPS');
  if (!env.getUserMedia) throw new CameraError('none', 'No camera found');
  const stream = await startStream(env);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CameraError('none', 'No camera found');
  }
  const capabilities = readCapabilities(typeof track.getCapabilities === 'function' ? track.getCapabilities() : null);

  // Without takePhoto the video frame is the still, so ask for the largest stream the track offers (ignore failure).
  if (!env.hasImageCapture) {
    const settings = track.getSettings();
    const wantW = capabilities.maxWidth;
    const wantH = capabilities.maxHeight;
    if (wantW !== null && wantH !== null && (settings.width ?? 0) < wantW) {
      try {
        await track.applyConstraints({ width: { ideal: wantW }, height: { ideal: wantH } });
      } catch (e) {
        log.warn('could not raise the preview resolution', e);
      }
    }
  }

  let stopped = false;
  return {
    stream,
    track,
    capabilities,
    get stopped() {
      return stopped;
    },
    size() {
      const s = track.getSettings();
      return s.width && s.height ? { width: s.width, height: s.height } : null;
    },
    async setTorch(on) {
      if (!capabilities.torch) return false;
      try {
        await track.applyConstraints(advanced({ torch: on }));
        return true;
      } catch (e) {
        log.warn('torch toggle failed', e);
        return false;
      }
    },
    async setZoom(zoom) {
      if (!capabilities.zoom) return false;
      try {
        await track.applyConstraints(advanced({ zoom }));
        return true;
      } catch (e) {
        log.warn('zoom failed', e);
        return false;
      }
    },
    async focusAt(x, y) {
      if (!capabilities.tapFocus) return false;
      try {
        await track.applyConstraints(advanced({ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' }));
        return true;
      } catch (e) {
        log.warn('tap to focus failed', e);
        return false;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
