import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUuidV4, newId } from './id.ts';

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a v4 UUID using crypto.randomUUID when present', () => {
    expect(isUuidV4(newId())).toBe(true);
  });

  it('still returns valid, unique v4 UUIDs when crypto.randomUUID is deleted (AC-6)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: <T extends ArrayBufferView<ArrayBuffer>>(a: T) => real.getRandomValues(a),
    });
    expect((globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = newId();
      expect(isUuidV4(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(10_000);
  });

  it('rejects non-v4 strings', () => {
    expect(isUuidV4('not-a-uuid')).toBe(false);
    expect(isUuidV4('00000000-0000-1000-8000-000000000000')).toBe(false);
  });
});
