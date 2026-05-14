// Top-level route mounter. Each sub-router is a factory taking the
// app-wide deps it needs, so wiring stays explicit instead of relying on
// req.app.locals for type-erased access.

import { Router } from 'express';

import type { AppConfig } from '../app.js';
import { buildAdminRouter } from './admin.js';
import { buildAuthRouter } from './auth.js';
import { buildBillingRouter } from './billing.js';
import { buildCertificationRouter } from './certification.js';
import { buildHealthRouter } from './health.js';
import { buildOnboardingRouter } from './onboarding.js';
import { buildOrgsRouter } from './orgs.js';
import { buildProxyRouter } from './proxy.js';
import { buildUsageRouter } from './usage.js';
import { buildUsersRouter } from './users.js';
import { buildVerifyRouter } from './verify.js';
import { buildWebhooksRouter } from './webhooks.js';

export function buildRouter(config: AppConfig): Router {
  const root = Router();

  // Public health probes — Cloud Run hits these on every revision swap.
  root.use(buildHealthRouter(config));

  // verify.sableterminal.com — public, no auth. Anyone can resolve a
  // certificate id to its verification view + cryptographic proof.
  root.use('/verify', buildVerifyRouter(config));

  // Public unauthenticated marketing endpoints (waitlist, enquiries,
  // referral redemption) — separate so they're easy to rate-limit and
  // exempt from auth without per-route opt-outs.
  root.use('/public', buildOnboardingRouter(config));

  // Stripe + other inbound webhooks. Auth happens via HMAC / signature
  // inside the controllers (not via session middleware).
  root.use('/webhooks', buildWebhooksRouter(config));

  // Internal HMAC-signed back-channel: module services report active
  // usage minutes that feed the certification ledger.
  root.use('/usage', buildUsageRouter(config));

  // Auth — most endpoints (login/signup) are unauthenticated; the
  // authenticated ones (/me, /sessions, …) gate themselves inside the
  // router.
  root.use('/auth', buildAuthRouter(config));

  // Authenticated user-facing endpoints. Each router applies the auth
  // chain (authenticate → setRlsContext) where appropriate.
  root.use('/users', buildUsersRouter(config));
  root.use('/orgs', buildOrgsRouter(config));
  root.use('/billing', buildBillingRouter(config));
  root.use('/certification', buildCertificationRouter(config));

  // Forward /api/{module}/* to the right downstream service over signed
  // HMAC. Module entitlement is enforced inside the proxy router.
  root.use('/api', buildProxyRouter(config));

  // Sable-internal admin console endpoints — gated by adminAccounts /
  // super-admin role inside the router.
  root.use('/admin', buildAdminRouter(config));

  return root;
}
