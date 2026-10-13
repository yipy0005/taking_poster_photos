// Download mechanics (design 2.13): object URL, programmatic <a download> click, revoke after 60 s.
// On iOS Safari this opens the system save/preview flow (README documents it).

export const REVOKE_DELAY_MS = 60_000;

export interface DownloadEnv {
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  click(url: string, filename: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

const browserEnv = (): DownloadEnv => ({
  createUrl: (b) => URL.createObjectURL(b),
  revokeUrl: (u) => URL.revokeObjectURL(u),
  click: (url, filename) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
});

export function downloadBlob(blob: Blob, filename: string, env: DownloadEnv = browserEnv()): void {
  const url = env.createUrl(blob);
  env.click(url, filename);
  env.setTimeout(() => env.revokeUrl(url), REVOKE_DELAY_MS);
}
