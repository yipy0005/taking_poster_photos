// Tiny console wrapper with levels. No remote logging exists. DOM-free (worker-reachable).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel: LogLevel = 'info';
const seen = new Set<string>();

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function emit(level: LogLevel, args: unknown[]): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
  fn('[poster-photos]', ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
  /** Logs a warning once per key per session (e.g. a probe fallback). */
  warnOnce(key: string, ...args: unknown[]): void {
    if (seen.has(key)) return;
    seen.add(key);
    emit('warn', args);
  },
};
