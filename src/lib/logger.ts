/**
 * Dependency-free leveled logger.
 *
 * Deliberately tiny: one file, no transports, no plugins. Swap the
 * implementation for pino/winston later without touching call sites - every
 * module only depends on the `Logger` interface.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Fields merged into every line produced by this logger. */
  readonly bindings?: LogFields;
  /** Injection seam for tests. */
  readonly write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, bindings = {}, write } = options;
  const threshold = LEVEL_WEIGHT[level];

  const emit = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;
    const payload: LogFields = { ...bindings, ...fields };
    const line = format(entryLevel, message, payload);
    if (write) {
      write(line);
      return;
    }
    // Warnings and errors go to stderr so container log collectors can split streams.
    if (entryLevel === 'warn' || entryLevel === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ level, bindings: { ...bindings, ...fields }, ...(write ? { write } : {}) }),
  };
}

function format(entryLevel: LogLevel, message: string, fields: LogFields): string {
  const parts = [
    new Date().toISOString(),
    entryLevel.toUpperCase().padEnd(5),
    message,
  ];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${stringifyValue(value)}`);
  }

  return parts.join(' ');
}

function stringifyValue(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '"[unserialisable]"';
  }
}