// Typed errors (design 2.16). DOM-free (worker-reachable); messages are plain language, never stack traces.
export class AppError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CameraError extends AppError {
  constructor(
    readonly kind: 'denied' | 'none' | 'busy' | 'insecure',
    message: string,
  ) {
    super(message);
  }
}
export class CaptureError extends AppError {
  constructor(
    readonly kind: 'frame',
    message: string,
  ) {
    super(message);
  }
}
export class IngestError extends AppError {
  constructor(
    readonly kind: 'unsupported' | 'too-large',
    message: string,
  ) {
    super(message);
  }
}
/** Raised when decoding is skipped on purpose (for example a thumbnail after a memory strike). */
export class DecodeSkippedError extends AppError {}
export class DecodeError extends AppError {}
export class OutOfMemoryError extends AppError {}
export class EngineUnavailableError extends AppError {}
/** The engine's worker died or raised an error/messageerror event. */
export class EngineCrashError extends AppError {}
/** A recoverable OpenCV exception for one input (bad Mat shape, failed assertion in a cv call). */
export class CvError extends AppError {}
export class InvalidQuadError extends AppError {}
export class DegenerateQuadError extends AppError {}
export class ExportError extends AppError {}
export class ValidationError extends AppError {}
export class StorageError extends AppError {}
export class StorageFullError extends StorageError {}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

export function isQuotaError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { name?: unknown; code?: unknown };
  return err.name === 'QuotaExceededError' || err.code === 22 || err.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Maps a raw storage failure to StorageFullError (quota) or StorageError (everything else). */
export function toStorageError(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  if (isQuotaError(e)) return new StorageFullError('Storage is full', { cause: e });
  return new StorageError('Could not save', { cause: e });
}
