// Security headers — wraps helmet() with Sable defaults. The defaults
// include CSP, HSTS, X-Content-Type-Options, X-Frame-Options, and
// Referrer-Policy headers that match a JSON API + Flutter web client.
//
// `helmet` is an optional peer dep of sable-shared.

import helmet from 'helmet';

export interface HelmetConfig {
  /**
   * HSTS max-age in seconds. Defaults to 1 year. Set to 0 to disable HSTS
   * (e.g. for local dev over HTTP).
   */
  hstsMaxAge?: number;
}

export function helmetMiddleware(config: HelmetConfig = {}) {
  return helmet({
    // Flutter web doesn't need a strict CSP at the API tier — the SPA
    // delivers its own CSP via the static host. Keep frame-ancestors locked
    // down so the API can't be iframed.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'frame-ancestors': ["'none'"],
      },
    },
    hsts: {
      maxAge: config.hstsMaxAge ?? 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
    // API doesn't render HTML — no need for the legacy XSS-protection header.
    xXssProtection: false,
  });
}
