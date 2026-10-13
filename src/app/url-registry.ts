// Object-URL registry: create, revoke on dispose (design 2.10 invariants).
export interface UrlRegistry {
  create(blob: Blob): string;
  revoke(url: string): void;
  revokeAll(): void;
  readonly size: number;
}

export function createUrlRegistry(): UrlRegistry {
  const urls = new Set<string>();
  return {
    create(blob) {
      const url = URL.createObjectURL(blob);
      urls.add(url);
      return url;
    },
    revoke(url) {
      if (urls.delete(url)) URL.revokeObjectURL(url);
    },
    revokeAll() {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    },
    get size() {
      return urls.size;
    },
  };
}
