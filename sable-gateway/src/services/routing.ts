// Downstream routing + outbound HMAC signing.
//
// `resolve` walks the boot-loaded service_routes map and returns the
// matching row plus the path to forward downstream. `signOutbound`
// produces the X-Service-* headers the receiver's serviceAuth middleware
// expects. `forwardHeaders` builds the identity headers downstream
// services read via their context middleware.

import { randomBytes } from 'node:crypto';
import { hmacSha256Hex, sha256Hex, type SessionData } from 'sable-shared';

import type { ServiceRoute } from '../db/serviceRoutes.js';

export interface ResolveResult {
  route: ServiceRoute;
  /** Path passed downstream — matched prefix stripped from the inbound path. */
  forwardPath: string;
}

/**
 * Longest-prefix-wins match. `serviceRoutes` is sorted by
 * `length(path_prefix) DESC` at boot, so iteration order is correct.
 * Method 'ANY' on a row matches any verb.
 */
export function resolve(
  routes: ReadonlyMap<string, ServiceRoute>,
  incomingPath: string,
  method: string,
): ResolveResult | null {
  for (const route of routes.values()) {
    if (route.method !== 'ANY' && route.method !== method) continue;
    if (!incomingPath.startsWith(route.pathPrefix)) continue;
    const forwardPath = incomingPath.slice(route.pathPrefix.length) || '/';
    return { route, forwardPath };
  }
  return null;
}

// ---------------------------------------------------------------------------

export interface SignedHeaders {
  'x-service-name': string;
  'x-service-version': string;
  'x-service-nonce': string;
  'x-service-ts': string;
  'x-service-token': string;
}

export function signOutbound(
  key: Buffer,
  version: number,
  serviceName: string,
  method: string,
  path: string,
  body: Buffer | undefined,
): SignedHeaders {
  const ts = Date.now().toString();
  const nonce = randomBytes(16).toString('hex');
  const bodyHex = sha256Hex(body ?? Buffer.alloc(0));
  const message = `${ts}.${nonce}.${method}.${path}.${bodyHex}`;
  return {
    'x-service-name': serviceName,
    'x-service-version': String(version),
    'x-service-nonce': nonce,
    'x-service-ts': ts,
    'x-service-token': hmacSha256Hex(key, message),
  };
}

// ---------------------------------------------------------------------------

/**
 * Identity headers downstream services read via their context middleware
 * (e.g. sable-shared-py's ServiceAuthMiddleware propagates X-User-Id /
 * X-Org-Id / X-Role into contextvars).
 */
export function forwardHeaders(session: SessionData | undefined, requestId: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (requestId !== undefined) out['x-request-id'] = requestId;
  if (session === undefined) return out;
  out['x-user-id'] = session.userId;
  if (session.orgId !== undefined) out['x-org-id'] = session.orgId;
  out['x-role'] = session.role;
  out['x-actor'] = session.actor;
  return out;
}
