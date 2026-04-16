/**
 * Structured logger that works in both Node and Edge runtimes.
 *
 * Why not Pino? Pino uses Node worker threads internally, which aren't
 * available in Cloudflare Workers / Next.js Edge runtime (where our
 * middleware and some route handlers will run). This logger is runtime-
 * agnostic: pretty-printed in dev, JSON lines in prod, no dependencies.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info('user logged in', { userId: 'abc123' });
 *   logger.error('db query failed', { err, query: 'select ...' });
 *
 * Create a child logger with bound context:
 *   const log = logger.child({ module: 'auth' });
 *   log.info('starting sign-in');  // includes { module: 'auth' }
 *
 * @module lib/logger
 */
import { env, isProd } from "./env";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// ANSI color codes for pretty dev output. Ignored in prod (JSON lines).
const COLORS = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
  dim: "\x1b[2m",
} as const;

type LogContext = Record<string, unknown>;

/**
 * Single log entry as written to stdout/stderr.
 * In prod, this is JSON-serialized. In dev, it's formatted as text.
 */
interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  [key: string]: unknown;
}

/** Serialize an Error instance into a plain loggable object. */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined && { cause: err.cause }),
    };
  }
  return { value: err };
}

/** Replace any `Error` values in context with their serialized form. */
function normalizeContext(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function formatDev(entry: LogEntry): string {
  const { level, time, msg, ...rest } = entry;
  const color = COLORS[level];
  const timestamp = `${COLORS.dim}${time}${COLORS.reset}`;
  const levelTag = `${color}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;
  const context =
    Object.keys(rest).length > 0
      ? ` ${COLORS.dim}${JSON.stringify(rest)}${COLORS.reset}`
      : "";
  return `${timestamp} ${levelTag} ${msg}${context}`;
}

/**
 * Core write function. Respects LOG_LEVEL from env.
 * Writes to stderr for warn/error, stdout for debug/info.
 */
function write(level: LogLevel, msg: string, ctx: LogContext = {}): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[env.LOG_LEVEL as LogLevel]) {
    return;
  }

  const entry: LogEntry = {
    level,
    time: new Date().toISOString(),
    msg,
    ...normalizeContext(ctx),
  };

  const line = isProd ? JSON.stringify(entry) : formatDev(entry);
  const stream = level === "warn" || level === "error" ? "stderr" : "stdout";

  // Use console to stay runtime-agnostic. In Workers, console.log/error
  // get wired to Cloudflare's observability system automatically.
  // eslint-disable-next-line no-console
  (stream === "stderr" ? console.error : console.log)(line);
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** Create a child logger with bound context merged into every call. */
  child(bindings: LogContext): Logger;
}

/** Build a logger instance, optionally with bound context. */
function createLogger(bindings: LogContext = {}): Logger {
  const merge = (ctx: LogContext = {}): LogContext => ({ ...bindings, ...ctx });

  return {
    debug: (msg, ctx) => write("debug", msg, merge(ctx)),
    info: (msg, ctx) => write("info", msg, merge(ctx)),
    warn: (msg, ctx) => write("warn", msg, merge(ctx)),
    error: (msg, ctx) => write("error", msg, merge(ctx)),
    child: (newBindings) => createLogger({ ...bindings, ...newBindings }),
  };
}

/** Default app-wide logger. Use `logger.child({ module: '...' })` in submodules. */
export const logger = createLogger();
