// /api/{module}/* forwarder.
//
//   1. resolves the inbound (method, path) against the cached
//      service_routes table.
//   2. enforces module entitlement when route.requiredModule is set.
//   3. signs the outbound HMAC headers.
//   4. forwards method + body + identity headers and writes the
//      downstream response back to the caller.

import type { RequestHandler } from 'express';
import { AppError, success } from 'sable-shared';

import type { AppConfig } from '../app.js';
import {
  forwardHeaders,
  resolve,
  signOutbound,
} from '../services/routing.js';

const PASS_THROUGH_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
]);

const PASS_THROUGH_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'location',
]);

const SERVICE_NAME = 'sable-gateway';

export function forward(config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!req.session) return next(new AppError('AUTH_FAILED'));

      const resolved = resolve(config.serviceRoutes(), req.path, req.method);
      if (resolved === null) return next(new AppError('NOT_FOUND', { message: `No route for ${req.method} ${req.path}` }));

      const { route, forwardPath } = resolved;

      if (route.requiredModule !== null && !req.session.activeModules.includes(route.requiredModule)) {
        return next(
          new AppError('MODULE_NOT_ACTIVE', {
            message: `Module '${route.requiredModule}' is not active for this user`,
            details: { module: route.requiredModule },
          }),
        );
      }

      const version = config.currentHmacVersion();
      const key = config.hmacKeys().get(version);
      if (key === undefined) {
        return next(new AppError('INTERNAL_ERROR', { message: 'No active HMAC key — refusing to sign' }));
      }

      const body = req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : (req.rawBody ?? Buffer.alloc(0));

      const signed = signOutbound(key, version, SERVICE_NAME, req.method, forwardPath, body);
      const identity = forwardHeaders(req.session, req.requestId);

      // Pass through a conservative allowlist of inbound headers; the
      // identity + service-auth headers are appended last so they can't
      // be overridden by a malicious client.
      const outboundHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && PASS_THROUGH_REQUEST_HEADERS.has(name.toLowerCase())) {
          outboundHeaders[name] = value;
        }
      }
      Object.assign(outboundHeaders, identity, signed);

      const url = joinUrl(route.targetUrl, forwardPath, req.url);
      const upstream = await fetch(url, {
        method: req.method,
        headers: outboundHeaders,
        body,
        // Node fetch supports duplex when piping a stream; here we send a
        // buffered body so no duplex flag is needed.
      });

      // Surface a subset of upstream headers, then write the body.
      upstream.headers.forEach((value, name) => {
        if (PASS_THROUGH_RESPONSE_HEADERS.has(name.toLowerCase())) {
          res.setHeader(name, value);
        }
      });
      res.status(upstream.status);

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (err) {
      next(err);
    }
  };
}

/** Build the downstream URL preserving the query string of the inbound request. */
function joinUrl(targetUrl: string, forwardPath: string, inboundUrl: string): string {
  const queryIdx = inboundUrl.indexOf('?');
  const query = queryIdx === -1 ? '' : inboundUrl.slice(queryIdx);
  const base = targetUrl.replace(/\/+$/, '');
  const path = forwardPath.startsWith('/') ? forwardPath : `/${forwardPath}`;
  return `${base}${path}${query}`;
}

// Re-export `success` so the controller file uses it (proxy responses
// flow through to the caller raw, so the envelope helper isn't used —
// keeping the import paths consistent across controllers).
void success;
