// Security headers — wraps helmet() with Sable defaults. The defaults
// include the CSP, HSTS, X-Content-Type-Options, X-Frame-Options, and
// Referrer-Policy headers that match a JSON API + Flutter web client.

import helmet from 'helmet';

export const helmetMiddleware = helmet({
  // Flutter web doesn't need a strict CSP at the API tier — the SPA delivers
  // its own CSP via the static host. Keep frame-ancestors locked down so the
  // API can't be iframed.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'frame-ancestors': ["'none'"],
    },
  },
  hsts: {
    maxAge: 31_536_000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  // API doesn't render HTML — no need for XSS-protection legacy header.
  xXssProtection: false,
});
