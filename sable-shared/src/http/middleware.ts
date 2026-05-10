// Shared middleware types. Sable services run on Express but the types here
// are framework-agnostic (structurally compatible with Express's Request /
// Response / NextFunction) so sable-shared doesn't carry an Express runtime
// dep. Services declare the merge in their own type-roots:
//
//   declare global {
//     namespace Express {
//       interface Request extends SableRequest {}
//     }
//   }

import type { RequestContext } from '../config/database.js';
import type { ActorType } from '../constants/actors.js';
import type { UserRole } from '../constants/roles.js';

// ---------------------------------------------------------------------------
// Request augmentation
// ---------------------------------------------------------------------------

/**
 * Properties Sable middleware attaches to the incoming request. Populated by
 * the gateway's auth chain in this order:
 *
 *   1. request-id middleware  → sets `requestId`
 *   2. auth middleware        → sets `session` (or rejects)
 *   3. context-builder        → sets `context` from the session for RLS
 */
export interface SableRequest {
  /** Per-request correlation ID. Surfaces in logs and the response envelope. */
  requestId?: string;
  /** Decoded session — only present after auth has resolved. */
  session?: SessionData;
  /**
   * RLS context derived from the session. Pass to `withRequestContext` when
   * opening a transaction so policies see the right identity.
   */
  context?: RequestContext;
}

export interface SessionData {
  sessionId: string;
  userId: string;
  /** Null for individual users (no org). */
  orgId?: string;
  role: UserRole;
  actor: ActorType;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** Active modules at the time of session validation — copy from the gateway cache. */
  activeModules: string[];
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Middleware function signatures
// ---------------------------------------------------------------------------

/**
 * Generic middleware — structurally compatible with Express's
 * `RequestHandler`. Default `Req`/`Res` of `unknown` keeps sable-shared free
 * of an `@types/express` dependency; services pass their own Request/Response
 * types when they want full inference.
 */
export type Middleware<Req = unknown, Res = unknown> = (
  req: Req,
  res: Res,
  next: NextFunction,
) => void | Promise<void>;

/**
 * Error-handling middleware (the 4-argument variant). Express recognises this
 * by arity, so the type must keep four parameters even when typing.
 */
export type ErrorMiddleware<Req = unknown, Res = unknown> = (
  err: unknown,
  req: Req,
  res: Res,
  next: NextFunction,
) => void | Promise<void>;

export type NextFunction = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isAuthenticated<R extends SableRequest>(
  req: R,
): req is R & { session: SessionData; context: RequestContext } {
  return req.session !== undefined && req.context !== undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a RequestContext from a validated session, plus the per-session DEK
 * (only set when the request will touch encrypted columns). Single source of
 * truth — middleware doesn't have to know which RequestContext fields exist.
 */
export function buildContext(session: SessionData, dek?: string): RequestContext {
  return {
    userId: session.userId,
    orgId: session.orgId,
    role: session.role,
    actor: session.actor,
    isAdmin: session.isAdmin,
    isSuperAdmin: session.isSuperAdmin,
    dek,
  };
}
