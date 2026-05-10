// Base error class for all Sable services.
//
// Every operational error (auth failure, validation, downstream timeout, …)
// throws an AppError with a semantic code. HTTP status is looked up from the
// codes table — same code always maps to the same status. The error
// middleware in each service formats `error.toJSON()` and sends it back.

import { ERROR_CODES, type ErrorCode } from './codes.js';

export interface AppErrorOptions {
  /** Override the default message for this code. */
  message?: string;
  /** Structured context safe to send to the client (no PII, no internals). */
  details?: Record<string, unknown>;
  /** Original error that triggered this — preserved on `error.cause`. */
  cause?: unknown;
  /** Override the default HTTP status for this code. Rarely needed. */
  statusCode?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const def = ERROR_CODES[code];
    const message = options.message ?? def.message;
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode ?? def.status;
    if (options.details !== undefined) this.details = options.details;

    // Trim our constructor frames out of the stack on V8.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * JSON-safe representation of the error body. Excludes `stack` and `cause` —
   * those are for logs, never for clients. Composed by `failure()` in
   * http/response.ts into the envelope.
   */
  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }

  /** Convenience guard so callers can `if (AppError.is(e))` without instanceof imports. */
  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}
