type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function emit(level: LogLevel, args: unknown[]): void {
  const ts = new Date().toISOString();
  const fn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'info'
          ? console.info
          : console.debug;
  fn(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
