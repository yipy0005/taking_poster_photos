import { describe, expect, it, vi } from 'vitest';
import type { Toaster, ToastOptions } from '../ui/components/toast.ts';
import { UPDATE_MESSAGE, registerServiceWorker, type WorkboxLike } from './register.ts';

function fakeWb(register: () => Promise<unknown> = async () => ({})) {
  const listeners: Record<string, () => void> = {};
  const wb: WorkboxLike & { skipped: number } = {
    skipped: 0,
    addEventListener: (type, fn) => void (listeners[type] = fn),
    register: vi.fn(register),
    messageSkipWaiting() {
      wb.skipped++;
    },
  };
  return { wb, listeners };
}
function fakeToast() {
  const shown: Array<{ message: string; options?: ToastOptions }> = [];
  const toast: Toaster = { show: (message, options) => void shown.push({ message, options }), dispose: () => {} };
  return { toast, shown };
}

describe('registerServiceWorker', () => {
  it('registers sw.js under the Vite base', async () => {
    const { wb } = fakeWb();
    const create = vi.fn(() => wb);
    const { toast } = fakeToast();
    await expect(registerServiceWorker({ toast, create, hasServiceWorker: true, baseUrl: '/taking_poster_photos/' })).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith('/taking_poster_photos/sw.js', '/taking_poster_photos/');
    expect(wb.register).toHaveBeenCalledOnce();
  });
  it('shows a non-blocking update toast; accepting posts SKIP_WAITING and the reload happens only after controlling', async () => {
    const { wb, listeners } = fakeWb();
    const { toast, shown } = fakeToast();
    const reload = vi.fn();
    await registerServiceWorker({ toast, create: () => wb, reload, hasServiceWorker: true, baseUrl: '/' });
    listeners['controlling']!(); // first install claims the page: no reload
    expect(reload).not.toHaveBeenCalled();
    listeners['waiting']!();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.message).toBe(UPDATE_MESSAGE);
    expect(shown[0]!.options?.timeoutMs).toBe(0);
    expect(wb.skipped).toBe(0);
    shown[0]!.options!.action!.onClick();
    expect(wb.skipped).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    listeners['controlling']!();
    expect(reload).toHaveBeenCalledOnce();
  });
  it('a failing registration is logged and the app continues online-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wb } = fakeWb(async () => {
      throw new Error('SecurityError');
    });
    const { toast } = fakeToast();
    await expect(registerServiceWorker({ toast, create: () => wb, hasServiceWorker: true, baseUrl: '/' })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('browsers without service workers are skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn();
    const { toast } = fakeToast();
    await expect(registerServiceWorker({ toast, create, hasServiceWorker: false })).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
