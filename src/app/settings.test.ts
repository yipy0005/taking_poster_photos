import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, parseSettings, saveSettings } from './settings.ts';

function mem(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[SETTINGS_KEY, initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('settings', () => {
  it('falls back to defaults for missing, invalid or malformed values', () => {
    expect(loadSettings(mem())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(mem('{not json'))).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ offlineDetector: 'yes', warmOnWifi: true })).toEqual({ offlineDetector: false, warmOnWifi: true });
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
  it('round-trips', () => {
    const s = mem();
    saveSettings({ offlineDetector: true, warmOnWifi: false }, s);
    expect(loadSettings(s)).toEqual({ offlineDetector: true, warmOnWifi: false });
  });
});
