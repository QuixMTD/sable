// Normalises any thrown thing into an AppError. Lets the error handler
// treat operational and unexpected errors with a single `instanceof
// AppError` branch. Maps the cases we care about (Postgres SQLSTATE,
// Stripe error shapes, generic `Error`) and falls back to INTERNAL_ERROR.

import { AppError } from 'sable-shared';

// Postgres error codes — only the ones we want to give a friendlier
// response for. https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';
const PG_NOT_NULL_VIOLATION = '23502';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

interface PgErrorShape {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
  table?: string;
}

interface StripeErrorShape {
  type?: string;
  raw?: { type?: string; message?: string };
  message?: string;
}

export function formatError(err: unknown): AppError {
  if (AppError.is(err)) return err;

  if (isPgError(err)) {
    switch (err.code) {
      case PG_UNIQUE_VIOLATION:
        return new AppError('ALREADY_EXISTS', {
          message: err.detail ?? 'Unique constraint violated',
          details: { constraint: err.constraint, table: err.table },
          cause: err,
        });
      case PG_FOREIGN_KEY_VIOLATION:
        return new AppError('CONFLICT', {
          message: err.detail ?? 'Foreign key violated',
          details: { constraint: err.constraint, table: err.table },
          cause: err,
        });
      case PG_CHECK_VIOLATION:
      case PG_NOT_NULL_VIOLATION:
        return new AppError('VALIDATION_FAILED', {
          message: err.message ?? 'Constraint violated',
          details: { constraint: err.constraint, table: err.table },
          cause: err,
        });
      case PG_INSUFFICIENT_PRIVILEGE:
        // RLS denial or role-grant denial. Don't leak which, treat as FORBIDDEN.
        return new AppError('FORBIDDEN', { cause: err });
    }
    return new AppError('DATABASE_ERROR', { message: err.message ?? 'Database error', cause: err });
  }

  if (isStripeError(err)) {
    return new AppError('STRIPE_FAILURE', {
      message: err.message ?? err.raw?.message ?? 'Stripe error',
      details: { stripeType: err.type ?? err.raw?.type },
      cause: err,
    });
  }

  if (err instanceof Error) {
    return new AppError('INTERNAL_ERROR', { message: err.message, cause: err });
  }

  return new AppError('INTERNAL_ERROR', {
    message: 'Unknown error',
    cause: err,
  });
}

function isPgError(err: unknown): err is PgErrorShape {
  // postgres.js / pg both attach `code` as a 5-char SQLSTATE.
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as PgErrorShape).code;
  return typeof code === 'string' && code.length === 5;
}

function isStripeError(err: unknown): err is StripeErrorShape {
  if (typeof err !== 'object' || err === null) return false;
  const type = (err as StripeErrorShape).type ?? (err as StripeErrorShape).raw?.type;
  return typeof type === 'string' && type.startsWith('Stripe');
}
