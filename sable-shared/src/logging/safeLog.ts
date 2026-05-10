// PII-stripping log wrapper. The gateway DB doc requires "no PII in any log
// field" — every service routes log writes through `safeLog` so it's
// physically impossible for a sensitive field name to leak into stdout.
//
// Two exports:
//   - redact(value)   — pure function; returns a deeply-cloned value with
//                       sensitive fields replaced by '[REDACTED]'.
//   - safeLog(logger) — wraps any compatible Logger so its meta argument is
//                       redacted on every call.

import { isSensitiveField, normaliseField } from './sensitiveFields.js';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const DEPTH_EXCEEDED = '[DEPTH_EXCEEDED]';

// Patterns scanned inside string values when `scanStrings: true`. Default
// off — these regexes have a perf cost and can false-positive in URLs or
// non-PII text. Enable explicitly for error/stack-trace logging where the
// content is opaque and may contain inlined PII (Postgres errors that quote
// the offending row, third-party SDK error messages, etc.).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function scanString(value: string): string {
  return value.replace(JWT_RE, '[JWT]').replace(EMAIL_RE, '[EMAIL]');
}

export interface RedactOptions {
  /** Extra field names to redact in addition to SENSITIVE_FIELDS. */
  extraFields?: Iterable<string>;
  /** Recursion cap. Default 10. */
  maxDepth?: number;
  /**
   * Scan inside string values for email and JWT patterns. Off by default
   * (cost + false-positive risk). Turn on for error / stack-trace logging.
   */
  scanStrings?: boolean;
}

// ---------------------------------------------------------------------------
// Core redactor
// ---------------------------------------------------------------------------

export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const extras = options.extraFields
    ? new Set(Array.from(options.extraFields, normaliseField))
    : undefined;
  const seen = new WeakSet<object>();
  return walk(value, extras, seen, 0, options.maxDepth ?? 10, options.scanStrings ?? false);
}

function walk(
  value: unknown,
  extras: ReadonlySet<string> | undefined,
  seen: WeakSet<object>,
  depth: number,
  maxDepth: number,
  scanStrings: boolean,
): unknown {
  if (depth >= maxDepth) return DEPTH_EXCEEDED;
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return scanStrings ? scanString(value as string) : value;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function' || t === 'symbol') return undefined;

  // Common opaque object types — emit a summary, never the contents.
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // Stack is allowed in logs but redacted-stripped of email-like params.
      stack: value.stack,
    };
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return `[${view.constructor.name} ${view.byteLength} bytes]`;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((v) => walk(v, extras, seen, depth + 1, maxDepth, scanStrings));
    }

    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value) {
        const key = String(k);
        out[key] = isSensitiveField(key, extras)
          ? REDACTED
          : walk(v, extras, seen, depth + 1, maxDepth, scanStrings);
      }
      return out;
    }

    if (value instanceof Set) {
      return Array.from(value, (v) => walk(v, extras, seen, depth + 1, maxDepth, scanStrings));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveField(key, extras)
        ? REDACTED
        : walk(val, extras, seen, depth + 1, maxDepth, scanStrings);
    }
    return out;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Logger wrapper
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/**
 * Wrap a Logger so every log call redacts its meta argument first. The
 * message itself is passed through unchanged — keep PII out of message
 * strings yourself; the wrapper only protects structured fields.
 */
export function safeLog(logger: Logger, options: RedactOptions = {}): Logger {
  return {
    debug: (message, meta) => logger.debug(message, meta === undefined ? meta : redact(meta, options)),
    info:  (message, meta) => logger.info(message, meta === undefined ? meta : redact(meta, options)),
    warn:  (message, meta) => logger.warn(message, meta === undefined ? meta : redact(meta, options)),
    error: (message, meta) => logger.error(message, meta === undefined ? meta : redact(meta, options)),
  };
}

