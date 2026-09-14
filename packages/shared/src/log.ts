/**
 * The logger the core and the CLI both write through.
 *
 * Search is a plain Node service: this is console with a tag and a level, and
 * whoever supervises the process — systemd, a terminal, the container runtime
 * — owns the sink. It carries the shape of Studio's `@actana/logger` on
 * purpose, because every lifted module calls `createLogger(name)` and then
 * `logger.info(message, context)`; keeping the shape is what made the lift a
 * rewrite of imports rather than of call sites.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function configuredLevel(): LogLevel {
  const raw = (process.env.SEARCH_LOG_LEVEL ?? "info").toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

class TaggedLogger implements Logger {
  // A plain field and an assignment, not a constructor parameter property.
  // Node runs this package's TypeScript by *stripping* types, never by
  // compiling it, and a parameter property is the one piece of TypeScript
  // syntax that has to emit code to mean anything — so it is rejected with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX rather than stripped. `scripts/check-strip-types.mjs`
  // holds the whole tree to that rule.
  readonly #module: string;

  constructor(module: string) {
    this.#module = module;
  }

  private write(level: Exclude<LogLevel, "silent">, message: string, args: unknown[]): void {
    // Read per call rather than at construction: a logger is usually created at
    // module scope, which is before the process has finished reading its
    // environment.
    if (RANK[level] < RANK[configuredLevel()]) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} [${this.#module}] ${message}`;
    const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (args.length === 0) sink(line);
    else sink(line, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write("debug", message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.write("info", message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.write("warn", message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.write("error", message, args);
  }
}

export function createLogger(module: string): Logger {
  return new TaggedLogger(module);
}
