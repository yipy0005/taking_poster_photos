// Storage quota, persistence and byte formatting helpers (design 2.10 "Quota and persistence").
import { log } from '../app/log.ts';

export interface UsageInfo {
  usage: number;
  quota: number;
  /** 0..1 */
  fraction: number;
}

export async function getUsage(): Promise<UsageInfo | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || typeof e.usage !== 'number' || typeof e.quota !== 'number' || e.quota <= 0) return null;
    return { usage: e.usage, quota: e.quota, fraction: Math.min(1, e.usage / e.quota) };
  } catch (e) {
    log.warn('storage estimate failed', e);
    return null;
  }
}

export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) === true;
  } catch {
    return false;
  }
}

/** Asks the browser not to evict our data. Failure is silent (Settings shows "Not persistent"). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) === true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}
