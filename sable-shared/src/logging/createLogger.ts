// Shared structured-logger factory. Every Sable Node service calls this once
// at startup and gets a pino-backed Logger that's:
//   - already wrapped with safeLog (PII redaction on every meta)
//   - emitting Cloud Logging-compatible JSON (severity, message keys)
//   - tagged with service name (and optional version) on every line
//   - level-controlled by NODE_ENV (debug in dev, info in prod) by default
//
// Use as:
//   const log = createLogger('sable-gateway', { version: pkg.version });
//   log.info('user logged in', { userId, requestId: req.requestId });

import pino, { type Logger as PinoLogger } from 'pino';

import { redact, safeLog, type Logger } from './safeLog.js';

export interface CreateLoggerOptions {
  /** Override the level. Defaults to debug in non-production, info otherwise. */
  level?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Service version, e.g. from package.json. Tagged on every log line. */
  version?: string;
  /** Disable safeLog wrapping. Off the safety rail — only for tests. */
  raw?: boolean;
  /** Override pino's destination stream. Default: stdout. */
  stream?: pino.DestinationStream;
}

export function createLogger(serviceName: string, options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

  const base: PinoLogger = pino(
    {
      name: serviceName,
      level,
      base: {
        service: serviceName,
        ...(options.version !== undefined ? { version: options.version } : {}),
      },
      // Cloud Logging severity mapping
      formatters: {
        level: (label) => ({ severity: label.toUpperCase() }),
      },
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.stream,
  );

  // Adapt pino's `(obj, msg)` to our Logger's `(msg, meta)` signature.
  // Errors get scanStrings: true so Postgres / SDK error messages with
  // inlined PII don't leak via the redactor's blind spot for string content.
  const adapter: Logger = {
    debug: (message, meta) =>
      meta === undefined ? base.debug(message) : base.debug(meta as object, message),
    info: (message, meta) =>
      meta === undefined ? base.info(message) : base.info(meta as object, message),
    warn: (message, meta) =>
      meta === undefined ? base.warn(message) : base.warn(meta as object, message),
    error: (message, meta) =>
      meta === undefined
        ? base.error(message)
        : base.error(redact(meta, { scanStrings: true }) as object, message),
  };

  return options.raw ? adapter : safeLog(adapter);
}
