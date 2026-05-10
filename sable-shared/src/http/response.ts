// Standard response envelope returned by every Sable service. Used over
// REST and WebSocket — same shape, so clients have one parser.
//
// Discriminated on `ok`: clients narrow with `if (response.ok)` and TS
// flows the `data` / `error` types correctly.

import { AppError } from '../errors/AppError.js';
import type { ErrorCode } from '../errors/codes.js';
import { redact } from '../logging/safeLog.js';

export interface SuccessResponse<T = unknown> {
  ok: true;
  /** Optional — endpoints with no payload (e.g. POST /sessions/:id/revoke) just return `{ ok: true }`. */
  data?: T;
  /** Request ID for log correlation. Set by the request-id middleware. */
  requestId?: string;
}

export interface ErrorResponse {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId?: string;
}

export type ApiResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function success(): SuccessResponse<undefined>;
export function success(requestId: string): SuccessResponse<undefined>;
export function success<T>(data: T, requestId?: string): SuccessResponse<T>;
export function success<T>(
  dataOrRequestId?: T | string,
  requestId?: string,
): SuccessResponse<T | undefined> {
  // No-arg or single-arg-string form: success() / success(requestId)
  if (arguments.length === 0) return { ok: true };
  if (arguments.length === 1 && typeof dataOrRequestId === 'string') {
    return { ok: true, requestId: dataOrRequestId };
  }
  // Standard form
  const data = dataOrRequestId as T;
  return requestId !== undefined ? { ok: true, data, requestId } : { ok: true, data };
}

/**
 * Build an error envelope. Accepts either an AppError (preferred — has the
 * code/status table) or a plain code + message for ad-hoc cases.
 */
export function failure(error: AppError, requestId?: string): ErrorResponse;
export function failure(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  requestId?: string,
): ErrorResponse;
export function failure(
  errorOrCode: AppError | ErrorCode,
  messageOrRequestId?: string,
  details?: Record<string, unknown>,
  requestId?: string,
): ErrorResponse {
  if (AppError.is(errorOrCode)) {
    const id = messageOrRequestId;
    const body = errorOrCode.toJSON();
    // Defence in depth: details is contractually client-safe, but redact at
    // the wire boundary so an accidental PII field doesn't escape.
    const safeBody =
      body.details !== undefined
        ? { ...body, details: redact(body.details) as Record<string, unknown> }
        : body;
    return id !== undefined
      ? { ok: false, error: safeBody, requestId: id }
      : { ok: false, error: safeBody };
  }
  const body: ErrorResponse['error'] = {
    code: errorOrCode,
    message: messageOrRequestId ?? '',
    ...(details !== undefined ? { details: redact(details) as Record<string, unknown> } : {}),
  };
  return requestId !== undefined ? { ok: false, error: body, requestId } : { ok: false, error: body };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isSuccess<T>(response: ApiResponse<T>): response is SuccessResponse<T> {
  return response.ok === true;
}

export function isFailure<T>(response: ApiResponse<T>): response is ErrorResponse {
  return response.ok === false;
}
