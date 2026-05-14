// Cursor-based pagination — opaque base64 cursor that encodes the last
// row's sort key(s). Stable under inserts (unlike OFFSET) and works with
// the per-request RLS filtering since we're just narrowing a WHERE clause.
//
// The cursor is opaque to the client: { v: 1, k: [ts, id] } base64url-encoded.
// `v` is a schema version so we can change the shape later without breaking
// existing clients still holding old cursors.

import { AppError } from '../errors/AppError.js';

const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface CursorPayload {
  /** The sort-key tuple of the last row in the previous page. */
  keys: (string | number | null)[];
}

export interface PaginationInput {
  cursor?: string;
  limit?: number;
}

export interface PaginationResult<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function encodeCursor(keys: CursorPayload['keys']): string {
  const json = JSON.stringify({ v: CURSOR_VERSION, k: keys });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload['keys'] {
  let parsed: { v?: number; k?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: number;
      k?: unknown;
    };
  } catch {
    throw new AppError('VALIDATION_FAILED', { message: 'Invalid cursor', details: { cursor } });
  }
  if (parsed.v !== CURSOR_VERSION || !Array.isArray(parsed.k)) {
    throw new AppError('VALIDATION_FAILED', { message: 'Unsupported cursor version' });
  }
  return parsed.k as CursorPayload['keys'];
}

/** Clamp the limit to a sane range and apply the default. */
export function resolveLimit(input?: number): number {
  if (input === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(input) || input < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(input), MAX_LIMIT);
}

/**
 * Build a paginated result envelope. Pass `limit + 1` rows to the query —
 * if you get back exactly `limit + 1`, more pages exist; trim the extra
 * row and emit a cursor pointing at the last kept row.
 */
export function buildPage<T>(
  fetched: T[],
  limit: number,
  cursorFrom: (row: T) => CursorPayload['keys'],
): PaginationResult<T> {
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const nextCursor = hasMore && rows.length > 0 ? encodeCursor(cursorFrom(rows[rows.length - 1]!)) : null;
  return { rows, nextCursor, hasMore };
}
