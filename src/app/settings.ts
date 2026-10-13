// User settings in localStorage, parsed through a typed validator with defaults (design 2.10 validation table).
import { log } from './log.ts';

export interface Settings {
  /** User opted in to the offline OpenCV detector download (FEAT-005 wires the UI). */
  offlineDetector: boolean;
  /** Warm the OpenCV cache automatically, only on Wi-Fi/ethernet (FEAT-005). */
  warmOnWifi: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = { offlineDetector: false, warmOnWifi: false };
export const SETTINGS_KEY = 'settings.v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Unknown input -> valid Settings. Invalid fields fall back to defaults. */
export function parseSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r['offlineDetector'] === 'boolean') out.offlineDetector = r['offlineDetector'];
  if (typeof r['warmOnWifi'] === 'boolean') out.warmOnWifi = r['warmOnWifi'];
  return out;
}

export function loadSettings(storage: StorageLike | null = defaultStorage()): Settings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    return parseSettings(JSON.parse(raw));
  } catch (e) {
    log.warn('invalid settings, using defaults', e);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    log.warn('could not save settings', e);
  }
}
