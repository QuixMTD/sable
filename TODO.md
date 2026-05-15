# Sable — TODO

Live punch-list of everything that's not yet built. Each item is roughly
"one PR's worth of work" unless flagged as multi-week.

Status legend: `[ ]` open · `[~]` partially built (scaffold + some impl) · `[x]` done.

---

## Gateway — auth / sessions / users

- [x] signup, login, logout, /me
- [x] email verification, password reset (request + confirm)
- [x] password change, sessions list/revoke
- [x] cookie session cache (hot-path Redis, write-through DB)
- [x] module-entitlement freshness via `modules:user:{id}` cache
- [ ] **`/auth/refresh`** — issue a fresh short-lived JWT for WS upgrades from a live cookie session
- [ ] **WS JWT verifier middleware** — `Authorization: Bearer <jwt>` inbound for `/ws/*` (when WS lands)
- [ ] **email change flow** — re-verification cycle when a user changes their email
- [ ] **profile picture upload** — GCS signed URL flow

## Gateway — orgs

- [x] create, list members, remove, role update
- [x] invite / accept / list / revoke (org_invites table)
- [ ] **GET /orgs/:id**, **PATCH /orgs/:id** — currently stubbed
- [ ] **Ownership transfer** flow (current `removeMember` blocks removing the owner)
- [ ] **Seat-count reconciliation** with subscriptions (extra seat used → bump subscription quantity in Stripe)

## Gateway — billing (Stripe)

- [x] DB-side reads: list subscriptions, list invoices, cancel
- [x] Modules pricing (`/billing/modules`)
- [x] Stripe stub at `config/stripe.ts` (throws loudly)
- [ ] **Install `stripe` npm package** and complete `config/stripe.ts`
- [ ] **POST /billing/checkout** — create Stripe Checkout Session
- [ ] **POST /billing/portal** — create Stripe Customer Portal session
- [ ] **POST /webhooks/stripe** — signature verify + event dispatch:
  - `customer.subscription.{created,updated,deleted}` → upsert + `entitlement.recompute`
  - `invoice.paid` / `invoice.payment_failed` → mirror + entitlement
  - `customer.subscription.trial_will_end` → email user
- [ ] **Webhook idempotency** — use `cacheKeys.webhookDedup(...)` + `setOnce` before dispatch (column reserved)
- [ ] **Founding-customer rate enforcement** — cap £799/seat for the first 10 firms (column on org?)
- [ ] **Annual = 2-months-free** computed server-side at checkout

## Gateway — proxy / routing

- [x] `/api/{module}/*` forward with HMAC sign + module entitlement
- [x] Boot-time `service_routes` map + hot reload via version stamp
- [ ] **Admin endpoint to edit `service_routes`** (currently DB-only)
- [ ] **Admin endpoint to manage `cors_origins`** (read implemented; no write path)

## Gateway — admin tooling

- [x] HMAC key rotation (super_admin)
- [x] Active sessions list, force-revoke
- [x] Block / unblock / list
- [x] Security event listing
- [x] Audit log listing
- [x] Service-health listing
- [x] Config get/set
- [x] Enquiries list / update
- [ ] **Manual subscription edits** (refund, cancel mid-period without webhook)
- [ ] **Admin "view as user"** with audit trail

## Gateway — MFA

- [~] Service stub (`services/mfa.ts`), controllers stubbed
- [ ] **Install `otplib`**
- [ ] **POST /auth/mfa/enroll** — generate TOTP secret, return otpauth URL
- [ ] **POST /auth/mfa/verify** — confirm enrolment with a 6-digit code
- [ ] **POST /auth/mfa/disable**
- [ ] **Challenge step at login** for users with MFA enabled

## Gateway — bot detection

- [x] Sub-50ms inter-request gap detection
- [x] No-mouse-telemetry detection
- [x] Auto-block at score ≥ 80, audit + security event
- [ ] **Regular-cadence pattern detection** (`bot:pattern:{ip}:regularity`)
- [ ] **Device fingerprint trust gating** — new fingerprint → email confirm before next login
- [ ] **Admin review queue** for high-score entities below the auto-block threshold

## Gateway — onboarding / lifecycle

- [x] Waitlist, enquiries, referral redemption
- [ ] **Welcome pack dispatch** worker (`gateway.welcome_packs` exists; no writer)
- [ ] **Birthday gift cron** — daily job → create gift rows for today's DOBs
- [ ] **Anniversary cron** — yearly subscription anniversary triggers
- [ ] **Email sequences** post-signup (Resend templates exist; need triggering cron)

## Gateway — observability

- [x] Cloud Logging via stdout (`httpLogger`)
- [x] `/healthz`, `/readyz`
- [ ] **`request_logs` durable write** — sampled middleware (≈1% of requests + 100% of 5xx) → `gateway.request_logs`
- [ ] **Service-health probes** — periodic cron that pings each downstream + writes to `service_health_log`
- [ ] **Tracing** — OpenTelemetry integration once a vendor is picked

## Sable Institute

- [x] Schema (8 tables, append-only ledger, RLS + trigger)
- [x] Hours ingest via `/usage` (HMAC-signed back-channel)
- [x] Eligibility view (`/certification/me`)
- [x] Foundation MCQ exam flow (start → submit → score → cert + signed ledger entry)
- [x] Public verification (`/verify/:publicId`, `/verify/.well-known/key`)
- [x] University programme — `.edu` self-serve enrolment on signup
- [x] Ed25519 signing (env-loaded keypair)
- [x] Hash-chained, append-only ledger
- [ ] **Pick a TSA + sign a contract** — FreeTSA for dev, DigiCert / Sectigo / GlobalSign for prod
- [ ] **`anchorWithTsa()` implementation** — ASN.1 DER `TimeStampReq` POST, parse `TimeStampToken`, write back into `tsa_token` + `tsa_provider` + `tsa_anchored_at`
- [ ] **Backfill TSA tokens** for entries written before the integration
- [ ] **Foundation question bank → 200+** before any candidate sits the exam (currently 20 seeded)
- [ ] **Professional practical runner** — lives inside the terminal; gateway accepts the attempt, sable-core runs the scenario
- [ ] **Advanced case-study runner** — same pattern, longer scenario
- [ ] **Chain verifier endpoint** (`/admin/ledger/verify`) — re-walks the ledger and reproves every entry's hash
- [ ] **Ledger backup / off-site replication** — read-only mirror in a second region
- [ ] **KMS-backed Ed25519 signing** — move the private key from env to GCP KMS so it never lives in process memory
- [ ] **Exam fee charging** — wire `exam_attempts.payment_intent_id` once Stripe is live
- [ ] **Public verifier site** — `verify.sableterminal.com` static SPA that hits the gateway `/verify/*` endpoints

## Shared lib (Python)

- [x] middleware (request_id, logger, error_handler, service_auth)
- [x] errors / constants / crypto / http / log_safety
- [x] cache helpers
- [ ] **`config/database.py`** — postgres factory + `with_request_context` for whichever Python service needs DB access (none yet, but sable-quant may)

## Downstream services

- [x] **sable-sandbox** — untrusted-code jail: AST allowlist gate, subprocess
  runner with rlimits, wall-clock kill, result/figure capture, harness-failure
  envelope, service-auth + request-id + structured logging on sable-shared-py.
  Verified end-to-end (jail mechanics + FastAPI layer). Deferred: deploy-time
  hardening is documented in the Dockerfile but enforced on the Cloud Run /
  pod spec (read-only fs, deny-all egress, pid limit, drop caps).
- [x] **sable-quant** — Python FastAPI pure-compute engine. All 6 S&C quant
  aspects built + verified by mathematical property: portfolio construction
  (min-var/risk-parity/max-div/factor-tilted), risk analytics (VaR
  modes/Euler decomposition/vol/drawdown/tail/stress/liquidity), factor
  models (FF3/FF5/Carhart/custom OLS), performance attribution
  (BHB/Brinson-Fachler/active-share/tracking), backtesting (run/walk-forward/
  metrics), Monte Carlo (GBM + Merton jump-diffusion, correlated multi-asset,
  P(target)/P(ruin), CI bands), technical analysis (SMA/EMA/WMA, RSI, MACD,
  Bollinger, Stochastic, ATR, ADX, OBV, Ichimoku, Fibonacci, support/
  resistance — one /technicals workhorse). Stays asset-class-agnostic by
  design; module services feed the OHLCV. Screening/research is NOT here
  (no generic maths — pure EODHD feed joins) → lands with sable-sc.
- [ ] **sable-core** — workspace + CRM data model (schema altered to the page/dashboard node model; service not built)
- [ ] **sable-engine** — pipeline orchestration, command parsing, crons, report generation, Pub/Sub, WS streaming
- [ ] **sable-sc** — S&C module: EODHD integration, holdings CRUD, quant analytics dispatch, **technicals + screening/research** — NEXT
- [ ] **sable-re** — Property: Land Registry + ONS + EPC + Planning Portal pulls, AVM, deal pipeline
- [ ] **sable-crypto** — exchange API integrations (Binance, Coinbase, Kraken, Gemini, OKX), on-chain analytics
- [ ] **sable-alt** — Vertex AI valuation, manual entry
- [ ] **sable-frontend** — Flutter desktop + web

## Cross-service plumbing

- [x] `service_routes` table + boot loader + hot reload
- [x] HMAC service-auth (sign / verify)
- [ ] **`services/pubsub.publish`** — install `@google-cloud/pubsub`, wire the topic publishes:
  - `price.updated`
  - `holdings.imported`
  - `portfolio.updated`
  - `tax.recalculate`
  - `report.generate`
  - `entitlement.changed`
  - `certification.trigger`
- [ ] **Pub/Sub subscriber on gateway** for `certification.trigger` → call `services/usage.recordOne`

## Email (Resend)

- [x] Resend SDK wired
- [x] Templates: verification, password reset, org invite, subscription past_due / cancelled, founding customer welcome
- [x] `email_logs` audit row per send
- [ ] **Trigger founding-customer welcome email** on first paid checkout (needs Stripe webhook)
- [ ] **Trigger subscription past_due email** from webhook
- [ ] **Trigger subscription_cancelled email** from webhook
- [ ] **Bounce / failure ingest** — Resend webhooks for bounce / spam complaints

## Infrastructure / ops

- [ ] **Cloud Run deployment manifests** (one per service)
- [ ] **GitHub Actions CI** — test, lint, typecheck, build, deploy
- [ ] **Secret Manager wiring** — HMAC keys, DB password, Resend key, Ed25519 private key, Stripe key
- [ ] **Cloud Memorystore (Redis)** provisioning
- [ ] **Cloud SQL** provisioning + automated backups + cross-region replica
- [ ] **PgBouncer** in front of Cloud SQL (gateway already supports via `DB_PGBOUNCER` flag)
- [ ] **Cloud Armor** — DDoS protection + WAF rules
- [ ] **Custom domain TLS** — `api.sableterminal.com`, `verify.sableterminal.com`
- [ ] **GCS bucket** for documents / exports / report templates
- [ ] **Cloud Scheduler** crons (partition rotation, birthday gifts, service-health probes, etc.)

## Pricing / GTM

- [ ] **Pricing page** on the marketing site (driven by `/billing/modules` API)
- [ ] **Founding-customer programme tracking** (first 10 firms at £799)
- [ ] **Annual commitment discount** computed server-side
- [ ] **Referral code redemption UI** + reward attribution

## Security hardening (post-MVP)

- [ ] **HSTS preload** submission (helmet already sends the header)
- [ ] **CSP tightening** beyond the API tier (currently relies on the SPA host)
- [ ] **Penetration test** before first paying customer
- [ ] **Rate-limit policies in DB** — currently hardcoded; `rate_limit_policies` table is empty
- [ ] **`/admin/ledger/verify` chain check** scheduled daily
- [ ] **Suspicious-login email** — new device fingerprint or new country → email user
