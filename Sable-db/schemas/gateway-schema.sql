-- sable-gateway — Gateway database schema
-- Source: Documentation/Sable-gateway/sable_gateway_db.md (v1.0, May 2026)
--
-- Conventions
--   PKs:        UUID DEFAULT gen_random_uuid()           (native in PG 13+)
--   🔐 columns: BYTEA, encrypted via pgp_sym_encrypt(plaintext, current_setting('app.dek'))
--               where app.dek is the per-session DEK unwrapped from GCP KMS by the gateway.
--   #️⃣ columns: BYTEA, hashed via digest(input, 'sha256').
--   password_hash: TEXT — Argon2id is computed at the app layer (not in pgcrypto).
--   RLS:        enabled per table; policies key off these per-request session vars
--                 app.user_id          uuid    authenticated user
--                 app.org_id           uuid    user's org (null if individual)
--                 app.role             text    owner|admin|analyst|trader|viewer
--                 app.actor            text    user|gateway|admin|system|webhook|public
--                 app.is_admin         bool    admin_accounts row?
--                 app.is_super_admin   bool    super_admin role?
--               Gateway sets these via `SET LOCAL` at the start of every transaction.
--
-- Partitioning: parent tables created here with one starter partition for May 2026.
-- Future partitions should be created on a rolling basis via pg_cron + pg_partman
-- (see notes at each partitioned parent).

------------------------------------------------------------------------------
-- 0. Extensions
------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- pgp_sym_encrypt / pgp_sym_decrypt / digest

------------------------------------------------------------------------------
-- 1. Crypto + RLS helper functions
------------------------------------------------------------------------------

-- Symmetric encryption with the per-session DEK
CREATE OR REPLACE FUNCTION enc(plaintext text)
RETURNS bytea LANGUAGE sql STRICT AS $$
  SELECT pgp_sym_encrypt(plaintext, current_setting('app.dek'));
$$;

CREATE OR REPLACE FUNCTION dec(ciphertext bytea)
RETURNS text LANGUAGE sql STRICT AS $$
  SELECT pgp_sym_decrypt(ciphertext, current_setting('app.dek'));
$$;

-- SHA-256 hash (32 bytes) — for token / fingerprint / api key lookups
CREATE OR REPLACE FUNCTION sha256(input text)
RETURNS bytea LANGUAGE sql STRICT AS $$
  SELECT digest(input, 'sha256');
$$;

-- RLS session-variable accessors (return NULL/false if unset, never raise)
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.role', true), '');
$$;

CREATE OR REPLACE FUNCTION app_actor() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor', true), '');
$$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false);
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_super_admin', true), '')::boolean, false);
$$;

CREATE OR REPLACE FUNCTION app_is_owner_or_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app_role() IN ('owner', 'admin');
$$;

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- active_modules guard
--
-- organisations.active_modules and users.active_modules are denormalised caches of
-- the subscriptions table — the gateway reads them on every request rather than
-- joining subscriptions per-call. They must therefore be writable ONLY by the
-- Stripe webhook (or system reconciliation), never by org owners/admins, otherwise
-- a malicious admin could grant their org modules they have not paid for.
--
-- RLS can't gate columns (it's row-level; PERMISSIVE policies OR), so a BEFORE
-- UPDATE OF active_modules trigger compares NEW vs OLD and rejects unauthorised
-- writers. UPDATE OF column_name fires only when that column appears in the SET
-- clause, so it has zero overhead for unrelated row updates.
CREATE OR REPLACE FUNCTION enforce_active_modules_actor()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_modules IS DISTINCT FROM OLD.active_modules
     AND app_actor() NOT IN ('webhook', 'system') THEN
    RAISE EXCEPTION
      'active_modules can only be modified by webhook or system actor (got %)',
      COALESCE(app_actor(), '<unset>')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

------------------------------------------------------------------------------
-- Schema: gateway
--   Helpers above (enc/dec/sha256/app_*) live in public so every service schema
--   can call them. Tables below live in `gateway`. Sibling schemas (`core`,
--   `sc`, `re`, `crypto`, `alt`) reference `gateway.users(id)` etc. explicitly.
------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path = gateway, public;

------------------------------------------------------------------------------
-- 2. organisations
------------------------------------------------------------------------------

CREATE TABLE organisations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  trading_name            text,
  company_reg             text,
  registered_address      bytea,                                            -- 🔐
  billing_email           bytea,                                            -- 🔐
  logo_url                text,
  active_modules          text[] NOT NULL DEFAULT '{}',
  seat_count              integer NOT NULL DEFAULT 0 CHECK (seat_count >= 0),
  billing_cycle           text CHECK (billing_cycle IN ('monthly', 'annual')),
  chatbot_enabled         boolean NOT NULL DEFAULT true,
  referral_code           text UNIQUE,
  joining_date            timestamptz,
  status                  text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'cancelled')),
  stripe_customer_id      text,
  stripe_subscription_id  text,
  subscription_status     text CHECK (subscription_status IN
                            ('active', 'past_due', 'cancelled', 'trialling')),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organisations_stripe_customer_id_idx
  ON organisations (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX organisations_status_idx ON organisations (status);

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;

CREATE POLICY organisations_select ON organisations FOR SELECT
  USING (id = app_org_id() OR app_is_admin());
CREATE POLICY organisations_update ON organisations FOR UPDATE
  USING (id = app_org_id() AND app_is_owner_or_admin());
CREATE POLICY organisations_insert ON organisations FOR INSERT
  WITH CHECK (app_user_id() IS NOT NULL);
CREATE POLICY organisations_delete ON organisations FOR DELETE
  USING (app_is_super_admin());

CREATE TRIGGER organisations_active_modules_guard
  BEFORE UPDATE OF active_modules ON organisations
  FOR EACH ROW EXECUTE FUNCTION enforce_active_modules_actor();

------------------------------------------------------------------------------
-- 3. admin_accounts
------------------------------------------------------------------------------

CREATE TABLE admin_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           bytea NOT NULL,                                           -- 🔐
  email_lookup    bytea NOT NULL UNIQUE,                                    -- #️⃣ digest(lower(btrim(email)), 'sha256') — login lookup; trim+lower
  name            text NOT NULL,
  admin_role      text NOT NULL
                  CHECK (admin_role IN ('super_admin', 'support', 'operations', 'sales')),
  ip_allowlist    text[] NOT NULL DEFAULT '{}',
  totp_secret     bytea NOT NULL,                                           -- 🔐
  last_login_at   timestamptz,
  last_login_ip   text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES admin_accounts(id) ON DELETE SET NULL
);

CREATE INDEX admin_accounts_role_idx ON admin_accounts (admin_role);
CREATE INDEX admin_accounts_is_active_idx ON admin_accounts (is_active);

ALTER TABLE admin_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_accounts_select ON admin_accounts FOR SELECT
  USING (app_is_admin());
CREATE POLICY admin_accounts_write ON admin_accounts FOR ALL
  USING (app_is_super_admin())
  WITH CHECK (app_is_super_admin());

------------------------------------------------------------------------------
-- 4. users
------------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid REFERENCES organisations(id) ON DELETE RESTRICT,
  email               bytea NOT NULL,                                       -- 🔐
  email_lookup        bytea NOT NULL UNIQUE,                                -- #️⃣ digest(lower(btrim(email)), 'sha256') — trim+lower so whitespace pastes don't break login
  email_verified      boolean NOT NULL DEFAULT false,
  password_hash       text NOT NULL,                                        -- Argon2id, app-layer
  phone               bytea,                                                -- 🔐
  name                text NOT NULL,
  date_of_birth       bytea,                                                -- 🔐
  role                text NOT NULL DEFAULT 'viewer'
                      CHECK (role IN ('owner', 'admin', 'analyst', 'trader', 'viewer')),
  active_modules      text[] NOT NULL DEFAULT '{}',
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  referral_code       text NOT NULL UNIQUE,
  joining_date        timestamptz NOT NULL DEFAULT now(),
  account_type        text NOT NULL DEFAULT 'user'
                      CHECK (account_type IN ('user', 'admin', 'individual')),
  stripe_customer_id  text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_org_id_idx ON users (org_id);
CREATE INDEX users_stripe_customer_id_idx ON users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX users_email_verified_idx ON users (email_verified);
CREATE INDEX users_is_active_idx ON users (is_active);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users FOR SELECT
  USING (id = app_user_id()
      OR (org_id IS NOT NULL AND org_id = app_org_id())
      OR app_is_admin());
CREATE POLICY users_update_self ON users FOR UPDATE
  USING (id = app_user_id());
CREATE POLICY users_update_admin ON users FOR UPDATE
  USING (org_id = app_org_id() AND app_is_owner_or_admin());
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (app_actor() = 'gateway');
CREATE POLICY users_delete ON users FOR DELETE
  USING (app_is_super_admin());

CREATE TRIGGER users_active_modules_guard
  BEFORE UPDATE OF active_modules ON users
  FOR EACH ROW EXECUTE FUNCTION enforce_active_modules_actor();

------------------------------------------------------------------------------
-- 5. email_verification_tokens
------------------------------------------------------------------------------

CREATE TABLE email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,                                        -- #️⃣
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_tokens_user_id_idx ON email_verification_tokens (user_id);
CREATE INDEX email_verification_tokens_expires_at_idx ON email_verification_tokens (expires_at);

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_verification_tokens_gateway ON email_verification_tokens FOR ALL
  USING (app_actor() = 'gateway') WITH CHECK (app_actor() = 'gateway');

------------------------------------------------------------------------------
-- 6. password_reset_tokens
------------------------------------------------------------------------------

CREATE TABLE password_reset_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash         bytea NOT NULL UNIQUE,                                 -- #️⃣
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  ip_requested_from  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);
CREATE INDEX password_reset_tokens_expires_at_idx ON password_reset_tokens (expires_at);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_gateway ON password_reset_tokens FOR ALL
  USING (app_actor() = 'gateway') WITH CHECK (app_actor() = 'gateway');

------------------------------------------------------------------------------
-- 7. sessions  (PARTITIONED BY RANGE (created_at) — monthly)
------------------------------------------------------------------------------

CREATE TABLE sessions (
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_token_hash       bytea NOT NULL,                                  -- #️⃣
  device_fingerprint_hash  bytea,                                           -- #️⃣
  ip_address               text NOT NULL,
  platform                 text CHECK (platform IN ('macos', 'windows', 'web')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_active_at           timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  revoked_at               timestamptz,
  revoked_by               uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  revoke_reason            text,
  PRIMARY KEY (id, created_at),
  UNIQUE (session_token_hash, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX sessions_revoked_at_idx ON sessions (revoked_at);

CREATE TABLE sessions_2026_05 PARTITION OF sessions
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- pg_cron job: monthly, create sessions_YYYY_MM partition for next month.

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_select ON sessions FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY sessions_insert ON sessions FOR INSERT
  WITH CHECK (app_actor() = 'gateway');
CREATE POLICY sessions_update ON sessions FOR UPDATE
  USING (app_actor() = 'gateway' OR app_is_admin());

------------------------------------------------------------------------------
-- 8. org_roles
------------------------------------------------------------------------------

CREATE TABLE org_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  role_name    text NOT NULL,
  permissions  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, role_name)
);

CREATE INDEX org_roles_org_id_idx ON org_roles (org_id);

ALTER TABLE org_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_roles_select ON org_roles FOR SELECT
  USING (org_id = app_org_id() OR app_is_admin());
CREATE POLICY org_roles_write ON org_roles FOR ALL
  USING (org_id = app_org_id() AND app_is_owner_or_admin())
  WITH CHECK (org_id = app_org_id() AND app_is_owner_or_admin());

------------------------------------------------------------------------------
-- 9. waitlist
------------------------------------------------------------------------------

CREATE TABLE waitlist (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  email               bytea NOT NULL,                                       -- 🔐
  email_lookup        bytea NOT NULL,                                       -- #️⃣ digest(lower(btrim(email)), 'sha256') — trim+lower
  phone               bytea,                                                -- 🔐
  firm_name           text,
  aum_range           text,
  primary_interest    text,
  source              text,
  notes               text,
  status              text NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'contacted', 'demo_booked', 'converted', 'not_interested')),
  assigned_to         uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  converted_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  invite_token        text UNIQUE,
  invite_sent_at      timestamptz,
  invite_expires_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX waitlist_email_lookup_idx ON waitlist (email_lookup);
CREATE INDEX waitlist_status_idx ON waitlist (status);
CREATE INDEX waitlist_assigned_to_idx ON waitlist (assigned_to);

CREATE TRIGGER waitlist_updated_at BEFORE UPDATE ON waitlist
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY waitlist_select ON waitlist FOR SELECT USING (app_is_admin());
CREATE POLICY waitlist_insert ON waitlist FOR INSERT WITH CHECK (true);     -- public submit
CREATE POLICY waitlist_update ON waitlist FOR UPDATE USING (app_is_admin());

------------------------------------------------------------------------------
-- 10. enquiries
------------------------------------------------------------------------------

CREATE TABLE enquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           bytea NOT NULL,                                           -- 🔐
  email_lookup    bytea NOT NULL,                                           -- #️⃣ digest(lower(btrim(email)), 'sha256') — for "have they enquired before?" checks
  phone           bytea,                                                    -- 🔐
  firm_name       text,
  enquiry_type    text NOT NULL
                  CHECK (enquiry_type IN
                    ('demo_request', 'partnership', 'press', 'support', 'complaint', 'general')),
  message         text,
  source          text,
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'contacted', 'qualified', 'demo_booked', 'converted', 'closed')),
  assigned_to     uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  internal_notes  text,
  follow_up_date  date,
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enquiries_email_lookup_idx ON enquiries (email_lookup);
CREATE INDEX enquiries_status_idx ON enquiries (status);
CREATE INDEX enquiries_assigned_to_idx ON enquiries (assigned_to);
CREATE INDEX enquiries_type_idx ON enquiries (enquiry_type);
CREATE INDEX enquiries_follow_up_date_idx ON enquiries (follow_up_date);

CREATE TRIGGER enquiries_updated_at BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;
CREATE POLICY enquiries_select ON enquiries FOR SELECT USING (app_is_admin());
CREATE POLICY enquiries_insert ON enquiries FOR INSERT WITH CHECK (true);   -- public submit
CREATE POLICY enquiries_update ON enquiries FOR UPDATE USING (app_is_admin());

------------------------------------------------------------------------------
-- 11. referral_codes
------------------------------------------------------------------------------

CREATE TABLE referral_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code        text NOT NULL UNIQUE,
  uses        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY referral_codes_select ON referral_codes FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY referral_codes_insert ON referral_codes FOR INSERT
  WITH CHECK (app_actor() IN ('gateway', 'system'));

------------------------------------------------------------------------------
-- 12. referrals
------------------------------------------------------------------------------

CREATE TABLE referrals (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  referee_email               bytea NOT NULL,                               -- 🔐
  referee_user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  referral_code               text NOT NULL,
  paypal_email                bytea,                                        -- 🔐
  status                      text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'active', 'eligible', 'paid', 'void')),
  signed_up_at                timestamptz,
  first_payment_at            timestamptz,
  eligible_at                 timestamptz,
  paid_at                     timestamptz,
  paypal_batch_id             text,
  first_month_credit_applied  boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX referrals_referrer_user_id_idx ON referrals (referrer_user_id);
CREATE INDEX referrals_status_idx ON referrals (status);
CREATE INDEX referrals_eligible_at_idx ON referrals (eligible_at);
CREATE INDEX referrals_referee_user_id_idx ON referrals (referee_user_id);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY referrals_select ON referrals FOR SELECT
  USING (referrer_user_id = app_user_id() OR app_is_admin());
CREATE POLICY referrals_write ON referrals FOR ALL
  USING (app_actor() = 'system' OR app_is_admin())
  WITH CHECK (app_actor() = 'system' OR app_is_admin());

------------------------------------------------------------------------------
-- 13. welcome_packs
------------------------------------------------------------------------------

CREATE TABLE welcome_packs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  delivery_address  bytea NOT NULL,                                         -- 🔐
  dispatch_id       text,
  tracking_number   text,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'dispatched', 'delivered', 'failed')),
  dispatched_at     timestamptz,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX welcome_packs_status_idx ON welcome_packs (status);

ALTER TABLE welcome_packs ENABLE ROW LEVEL SECURITY;
CREATE POLICY welcome_packs_select ON welcome_packs FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY welcome_packs_write ON welcome_packs FOR ALL
  USING (app_actor() = 'system' OR app_is_admin())
  WITH CHECK (app_actor() = 'system' OR app_is_admin());

------------------------------------------------------------------------------
-- 14. birthday_gifts  (PARTITIONED BY RANGE (year))
------------------------------------------------------------------------------

CREATE TABLE birthday_gifts (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  year              integer NOT NULL,
  delivery_address  bytea NOT NULL,                                         -- 🔐
  dispatch_id       text,
  tracking_number   text,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'dispatched', 'delivered', 'failed')),
  dispatched_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, year),
  UNIQUE (user_id, year)
) PARTITION BY RANGE (year);

CREATE INDEX birthday_gifts_status_idx ON birthday_gifts (status);

CREATE TABLE birthday_gifts_2026 PARTITION OF birthday_gifts
  FOR VALUES FROM (2026) TO (2027);
-- pg_cron job: yearly, create birthday_gifts_YYYY for next year.

ALTER TABLE birthday_gifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY birthday_gifts_select ON birthday_gifts FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY birthday_gifts_write ON birthday_gifts FOR ALL
  USING (app_actor() = 'system' OR app_is_admin())
  WITH CHECK (app_actor() = 'system' OR app_is_admin());

------------------------------------------------------------------------------
-- 15. anniversaries  (PARTITIONED BY RANGE (year))
------------------------------------------------------------------------------

CREATE TABLE anniversaries (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  year            integer NOT NULL,
  email_sent_at   timestamptz NOT NULL DEFAULT now(),
  template_used   text NOT NULL,
  PRIMARY KEY (id, year),
  UNIQUE (user_id, year)
) PARTITION BY RANGE (year);

CREATE TABLE anniversaries_2026 PARTITION OF anniversaries
  FOR VALUES FROM (2026) TO (2027);
-- pg_cron job: yearly, create anniversaries_YYYY for next year.

ALTER TABLE anniversaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY anniversaries_select ON anniversaries FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY anniversaries_insert ON anniversaries FOR INSERT
  WITH CHECK (app_actor() = 'system');

------------------------------------------------------------------------------
-- 16. certification_usage
------------------------------------------------------------------------------

CREATE TABLE certification_usage (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  session_hours         double precision NOT NULL DEFAULT 0,
  commands_run          integer NOT NULL DEFAULT 0,
  pipelines_built       integer NOT NULL DEFAULT 0,
  certification_level   text CHECK (certification_level IN ('associate', 'professional', 'expert')),
  eligible_at           timestamptz,
  applied_at            timestamptz,
  certified_at          timestamptz,
  credential_id         text,
  last_activity_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX certification_usage_level_idx ON certification_usage (certification_level);

ALTER TABLE certification_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY certification_usage_select ON certification_usage FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY certification_usage_update ON certification_usage FOR UPDATE
  USING (app_actor() = 'system');
CREATE POLICY certification_usage_insert ON certification_usage FOR INSERT
  WITH CHECK (app_actor() = 'system');

------------------------------------------------------------------------------
-- 17. admin_audit_log  (PARTITIONED BY RANGE (created_at) — monthly, immutable)
------------------------------------------------------------------------------

CREATE TABLE admin_audit_log (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  admin_user_id  uuid NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  action         text NOT NULL,
  target_type    text NOT NULL,
  target_id      uuid,
  before_state   jsonb,
  after_state    jsonb,
  ip_address     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX admin_audit_log_admin_idx ON admin_audit_log (admin_user_id);
CREATE INDEX admin_audit_log_target_idx ON admin_audit_log (target_id);
CREATE INDEX admin_audit_log_created_at_idx ON admin_audit_log (created_at);

CREATE TABLE admin_audit_log_2026_05 PARTITION OF admin_audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_audit_log_select ON admin_audit_log FOR SELECT USING (app_is_admin());
CREATE POLICY admin_audit_log_insert ON admin_audit_log FOR INSERT
  WITH CHECK (app_actor() = 'admin');
-- No UPDATE, no DELETE policies → immutable.

------------------------------------------------------------------------------
-- 18. subscriptions
------------------------------------------------------------------------------

CREATE TABLE subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid REFERENCES organisations(id) ON DELETE RESTRICT,
  user_id                 uuid REFERENCES users(id) ON DELETE RESTRICT,
  stripe_subscription_id  text NOT NULL UNIQUE,
  stripe_customer_id      text NOT NULL,
  module                  text NOT NULL CHECK (module IN ('sc', 're', 'crypto', 'alt', 'tax')),
  seat_count              integer NOT NULL CHECK (seat_count >= 0),
  price_per_seat_gbp      numeric(12, 2) NOT NULL,
  billing_cycle           text NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')),
  status                  text NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled', 'trialling')),
  trial_end_at            timestamptz,
  current_period_start    timestamptz NOT NULL,
  current_period_end      timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((org_id IS NOT NULL) <> (user_id IS NOT NULL))                     -- xor: org or user, not both
);

CREATE INDEX subscriptions_org_id_idx ON subscriptions (org_id);
CREATE INDEX subscriptions_user_id_idx ON subscriptions (user_id);
CREATE INDEX subscriptions_stripe_customer_idx ON subscriptions (stripe_customer_id);
CREATE INDEX subscriptions_status_idx ON subscriptions (status);
CREATE INDEX subscriptions_module_idx ON subscriptions (module);

CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT
  USING ((org_id = app_org_id() AND app_is_owner_or_admin())
      OR user_id = app_user_id()
      OR app_is_admin());
CREATE POLICY subscriptions_write ON subscriptions FOR ALL
  USING (app_actor() IN ('webhook', 'admin'))
  WITH CHECK (app_actor() IN ('webhook', 'admin'));

------------------------------------------------------------------------------
-- 19. invoices  (PARTITIONED BY RANGE (created_at) — monthly)
------------------------------------------------------------------------------

CREATE TABLE invoices (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id                 uuid REFERENCES organisations(id) ON DELETE RESTRICT,
  user_id                uuid REFERENCES users(id) ON DELETE RESTRICT,    -- individual users
  stripe_invoice_id      text NOT NULL,
  amount_gbp             numeric(14, 2) NOT NULL,
  currency               text NOT NULL DEFAULT 'GBP',
  status                 text NOT NULL CHECK (status IN ('paid', 'open', 'void')),
  module                 text,
  seats_billed           integer,
  billing_period_start   timestamptz NOT NULL,
  billing_period_end     timestamptz NOT NULL,
  paid_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  -- NOTE: this UNIQUE only enforces uniqueness within a single partition. A retry
  -- of the same Stripe invoice landing in a different month will not be caught.
  -- Idempotency must be enforced at the app layer (SELECT by stripe_invoice_id first).
  UNIQUE (stripe_invoice_id, created_at),
  CHECK ((org_id IS NOT NULL) <> (user_id IS NOT NULL))                    -- xor: org or individual
) PARTITION BY RANGE (created_at);

CREATE INDEX invoices_org_id_idx ON invoices (org_id);
CREATE INDEX invoices_user_id_idx ON invoices (user_id);
CREATE INDEX invoices_status_idx ON invoices (status);
CREATE INDEX invoices_paid_at_idx ON invoices (paid_at);

CREATE TABLE invoices_2026_05 PARTITION OF invoices
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING ((org_id = app_org_id() AND app_is_owner_or_admin())
      OR user_id = app_user_id()
      OR app_is_admin());
CREATE POLICY invoices_write ON invoices FOR ALL
  USING (app_actor() = 'webhook') WITH CHECK (app_actor() = 'webhook');

------------------------------------------------------------------------------
-- 20. api_keys
------------------------------------------------------------------------------

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid REFERENCES organisations(id) ON DELETE CASCADE,       -- null for individual-user keys
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,     -- creator (always set)
  key_hash      bytea NOT NULL UNIQUE,                                      -- #️⃣
  prefix        text NOT NULL,
  name          text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  last_used_at  timestamptz,
  expires_at    timestamptz,
  is_active     boolean NOT NULL DEFAULT true,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_org_id_idx ON api_keys (org_id);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);
CREATE INDEX api_keys_is_active_idx ON api_keys (is_active);
CREATE INDEX api_keys_expires_at_idx ON api_keys (expires_at);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_select ON api_keys FOR SELECT
  USING ((org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
      OR user_id = app_user_id()
      OR app_is_admin());
-- Org keys: only owners/admins may create/update.
-- Individual keys (org_id IS NULL): the user creates/updates their own.
CREATE POLICY api_keys_insert ON api_keys FOR INSERT
  WITH CHECK (
    (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
    OR (org_id IS NULL AND user_id = app_user_id())
  );
CREATE POLICY api_keys_update ON api_keys FOR UPDATE
  USING (
    (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
    OR (org_id IS NULL AND user_id = app_user_id())
  );

------------------------------------------------------------------------------
-- 21. rate_limit_policies
------------------------------------------------------------------------------

CREATE TABLE rate_limit_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type          text NOT NULL CHECK (entity_type IN ('org', 'user')),
  entity_id            uuid NOT NULL,
  requests_per_minute  integer NOT NULL,
  requests_per_hour    integer NOT NULL,
  requests_per_day     integer NOT NULL,
  burst_allowance      integer NOT NULL DEFAULT 0,
  reason               text,
  created_by           uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);

CREATE INDEX rate_limit_policies_expires_at_idx ON rate_limit_policies (expires_at);

ALTER TABLE rate_limit_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_policies_admin ON rate_limit_policies FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

------------------------------------------------------------------------------
-- 22. blocked_entities
------------------------------------------------------------------------------

CREATE TABLE blocked_entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL
                CHECK (entity_type IN ('ip', 'user_id', 'org_id', 'device_fingerprint')),
  entity_value  text NOT NULL,
  reason        text NOT NULL,
  block_type    text NOT NULL CHECK (block_type IN ('full', 'throttle', 'monitor')),
  blocked_by    uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  blocked_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  is_active     boolean NOT NULL DEFAULT true,
  notes         text
);

CREATE INDEX blocked_entities_lookup_idx
  ON blocked_entities (entity_type, entity_value) WHERE is_active;
CREATE INDEX blocked_entities_expires_at_idx ON blocked_entities (expires_at);

ALTER TABLE blocked_entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY blocked_entities_select ON blocked_entities FOR SELECT USING (app_is_admin());
CREATE POLICY blocked_entities_write ON blocked_entities FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());
-- No DELETE policy → immutable history.

------------------------------------------------------------------------------
-- 23. security_events  (PARTITIONED BY RANGE (created_at) — monthly, immutable)
------------------------------------------------------------------------------

CREATE TABLE security_events (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type          text NOT NULL CHECK (event_type IN
                       ('auth_failure', 'rate_limit_exceeded', 'blocked_entity_hit',
                        'hmac_failure', 'bot_detected', 'api_key_invalid', 'replay_attack')),
  user_id             uuid,
  org_id              uuid,
  ip_address          text,
  device_fingerprint  text,
  api_key_prefix      text,
  request_path        text,
  request_method      text,
  details             jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX security_events_user_id_idx ON security_events (user_id);
CREATE INDEX security_events_org_id_idx ON security_events (org_id);
CREATE INDEX security_events_ip_idx ON security_events (ip_address);
CREATE INDEX security_events_event_type_idx ON security_events (event_type);
CREATE INDEX security_events_created_at_idx ON security_events (created_at);

CREATE TABLE security_events_2026_05 PARTITION OF security_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_events_select ON security_events FOR SELECT USING (app_is_admin());
CREATE POLICY security_events_insert ON security_events FOR INSERT
  WITH CHECK (app_actor() = 'gateway');
-- Immutable: no UPDATE/DELETE policies.

------------------------------------------------------------------------------
-- 24. service_routes
------------------------------------------------------------------------------

CREATE TABLE service_routes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path_prefix      text NOT NULL,
  method           text NOT NULL CHECK (method IN ('GET', 'POST', 'PATCH', 'DELETE', 'ANY')),
  target_service   text NOT NULL,
  target_url       text NOT NULL,
  required_module  text,
  auth_required    boolean NOT NULL DEFAULT true,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path_prefix, method)
);

CREATE INDEX service_routes_path_prefix_idx ON service_routes (path_prefix) WHERE is_active;

CREATE TRIGGER service_routes_updated_at BEFORE UPDATE ON service_routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE service_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_routes_select ON service_routes FOR SELECT
  USING (app_actor() = 'gateway' OR app_is_admin());
CREATE POLICY service_routes_write ON service_routes FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

------------------------------------------------------------------------------
-- 25. request_logs  (PARTITIONED BY RANGE (created_at) — daily, 90-day retention)
------------------------------------------------------------------------------

CREATE TABLE request_logs (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id             uuid,
  org_id              uuid,
  ip_address          text,
  device_fingerprint  text,
  request_method      text NOT NULL,
  request_path        text NOT NULL,
  target_service      text,
  status_code         integer NOT NULL,
  duration_ms         integer NOT NULL,
  auth_type           text CHECK (auth_type IN ('jwt', 'api_key', 'none')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX request_logs_user_id_idx ON request_logs (user_id);
CREATE INDEX request_logs_org_id_idx ON request_logs (org_id);
CREATE INDEX request_logs_ip_idx ON request_logs (ip_address);
CREATE INDEX request_logs_status_idx ON request_logs (status_code);
CREATE INDEX request_logs_created_at_idx ON request_logs (created_at);
CREATE INDEX request_logs_target_idx ON request_logs (target_service);

CREATE TABLE request_logs_2026_05_10 PARTITION OF request_logs
  FOR VALUES FROM ('2026-05-10') TO ('2026-05-11');
-- pg_cron job: daily, create next-day partition + drop partitions older than 90 days.

ALTER TABLE request_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_logs_select ON request_logs FOR SELECT USING (app_is_admin());
CREATE POLICY request_logs_insert ON request_logs FOR INSERT
  WITH CHECK (app_actor() = 'gateway');

------------------------------------------------------------------------------
-- 26. webhook_logs  (PARTITIONED BY RANGE (created_at) — monthly, 12-month retention)
------------------------------------------------------------------------------

CREATE TABLE webhook_logs (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  provider            text NOT NULL CHECK (provider IN ('stripe')),         -- Clerk dropped — auth is custom
  event_type          text NOT NULL,
  provider_event_id   text NOT NULL,
  payload             jsonb NOT NULL,
  signature_valid     boolean NOT NULL,
  processed           boolean NOT NULL DEFAULT false,
  processed_at        timestamptz,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  -- NOTE: this UNIQUE only enforces uniqueness within a single partition. A retried
  -- webhook landing in the next month's partition will not be caught.
  -- Idempotency must be enforced at the app layer (SELECT by provider_event_id first).
  UNIQUE (provider_event_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX webhook_logs_provider_idx ON webhook_logs (provider);
CREATE INDEX webhook_logs_processed_idx ON webhook_logs (processed) WHERE NOT processed;
CREATE INDEX webhook_logs_created_at_idx ON webhook_logs (created_at);

CREATE TABLE webhook_logs_2026_05 PARTITION OF webhook_logs
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_logs_select ON webhook_logs FOR SELECT USING (app_is_admin());
CREATE POLICY webhook_logs_write ON webhook_logs FOR ALL
  USING (app_actor() = 'gateway') WITH CHECK (app_actor() = 'gateway');

------------------------------------------------------------------------------
-- 27. hmac_key_versions
------------------------------------------------------------------------------

CREATE TABLE hmac_key_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version         integer NOT NULL UNIQUE,
  key_ref         text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  activated_at    timestamptz NOT NULL DEFAULT now(),
  deprecated_at   timestamptz,
  expires_at      timestamptz
);

CREATE INDEX hmac_key_versions_active_idx ON hmac_key_versions (is_active);
CREATE INDEX hmac_key_versions_expires_at_idx ON hmac_key_versions (expires_at);

ALTER TABLE hmac_key_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY hmac_key_versions_select ON hmac_key_versions FOR SELECT
  USING (app_actor() = 'gateway' OR app_is_admin());
CREATE POLICY hmac_key_versions_write ON hmac_key_versions FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

------------------------------------------------------------------------------
-- 28. used_nonces  (PARTITIONED BY RANGE (used_at) — minutely, 30s retention)
------------------------------------------------------------------------------
-- WARNING: minute-level partitioning is high-throughput. Requires pg_cron sweeping
-- DROP PARTITION every minute and CREATE PARTITION ahead of time. Consider Redis-only
-- if the load proves untenable — used_at is also short-TTL'd in Redis.

CREATE TABLE used_nonces (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  nonce       text NOT NULL,
  user_id     uuid,
  used_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (id, used_at),
  UNIQUE (nonce, used_at)
) PARTITION BY RANGE (used_at);

CREATE INDEX used_nonces_expires_at_idx ON used_nonces (expires_at);

CREATE TABLE used_nonces_default PARTITION OF used_nonces DEFAULT;
-- Replace the default with rolling per-minute partitions in operation.

ALTER TABLE used_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY used_nonces_gateway ON used_nonces FOR ALL
  USING (app_actor() = 'gateway') WITH CHECK (app_actor() = 'gateway');

------------------------------------------------------------------------------
-- 29. device_fingerprints
------------------------------------------------------------------------------

CREATE TABLE device_fingerprints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint_hash  bytea NOT NULL,                                         -- #️⃣
  device_name       text,
  platform          text CHECK (platform IN ('macos', 'windows', 'web')),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  is_trusted        boolean NOT NULL DEFAULT false,
  trusted_at        timestamptz,
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (user_id, fingerprint_hash)
);

CREATE INDEX device_fingerprints_user_id_idx ON device_fingerprints (user_id);
CREATE INDEX device_fingerprints_is_trusted_idx ON device_fingerprints (is_trusted);

ALTER TABLE device_fingerprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY device_fingerprints_select ON device_fingerprints FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY device_fingerprints_insert ON device_fingerprints FOR INSERT
  WITH CHECK (app_actor() = 'gateway');
CREATE POLICY device_fingerprints_update ON device_fingerprints FOR UPDATE
  USING (app_actor() = 'gateway' OR app_is_admin());
CREATE POLICY device_fingerprints_delete ON device_fingerprints FOR DELETE
  USING (app_is_admin());

------------------------------------------------------------------------------
-- 30. bot_scores
------------------------------------------------------------------------------

CREATE TABLE bot_scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type       text NOT NULL CHECK (entity_type IN ('user_id', 'ip')),
  entity_value      text NOT NULL,
  score             integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons           text[] NOT NULL DEFAULT '{}',
  last_updated_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by       uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  review_notes      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_value)
);

CREATE INDEX bot_scores_score_idx ON bot_scores (score);
CREATE INDEX bot_scores_reviewed_by_idx ON bot_scores (reviewed_by);

ALTER TABLE bot_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_scores_select ON bot_scores FOR SELECT USING (app_is_admin());
CREATE POLICY bot_scores_write ON bot_scores FOR ALL
  USING (app_actor() = 'gateway' OR app_is_admin())
  WITH CHECK (app_actor() = 'gateway' OR app_is_admin());

------------------------------------------------------------------------------
-- 31. ip_whitelist
------------------------------------------------------------------------------

CREATE TABLE ip_whitelist (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address   text NOT NULL,
  entity_type  text NOT NULL CHECK (entity_type IN ('admin_account', 'org', 'global')),
  entity_id    uuid,
  reason       text NOT NULL,
  added_by     uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  expires_at   timestamptz,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ip_whitelist_ip_idx ON ip_whitelist (ip_address) WHERE is_active;
CREATE INDEX ip_whitelist_entity_idx ON ip_whitelist (entity_type, entity_id);
CREATE INDEX ip_whitelist_expires_at_idx ON ip_whitelist (expires_at);

ALTER TABLE ip_whitelist ENABLE ROW LEVEL SECURITY;
CREATE POLICY ip_whitelist_admin ON ip_whitelist FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

------------------------------------------------------------------------------
-- 32. cors_origins
------------------------------------------------------------------------------

CREATE TABLE cors_origins (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin             text NOT NULL,
  environment        text NOT NULL CHECK (environment IN ('production', 'staging', 'development')),
  allow_credentials  boolean NOT NULL DEFAULT false,
  is_active          boolean NOT NULL DEFAULT true,
  added_by           uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origin, environment)
);

CREATE INDEX cors_origins_active_idx ON cors_origins (is_active);

ALTER TABLE cors_origins ENABLE ROW LEVEL SECURITY;
CREATE POLICY cors_origins_select ON cors_origins FOR SELECT
  USING (app_actor() = 'gateway' OR app_is_admin());
CREATE POLICY cors_origins_write ON cors_origins FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

------------------------------------------------------------------------------
-- 33. service_health_log  (PARTITIONED BY RANGE (checked_at) — weekly, immutable)
------------------------------------------------------------------------------

CREATE TABLE service_health_log (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  service_name      text NOT NULL,
  status            text NOT NULL CHECK (status IN ('healthy', 'degraded', 'down')),
  response_time_ms  integer,
  error_message     text,
  checked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, checked_at)
) PARTITION BY RANGE (checked_at);

CREATE INDEX service_health_log_service_idx ON service_health_log (service_name);
CREATE INDEX service_health_log_status_idx ON service_health_log (status);
CREATE INDEX service_health_log_checked_at_idx ON service_health_log (checked_at);

CREATE TABLE service_health_log_2026_w19 PARTITION OF service_health_log
  FOR VALUES FROM ('2026-05-04') TO ('2026-05-11');
CREATE TABLE service_health_log_2026_w20 PARTITION OF service_health_log
  FOR VALUES FROM ('2026-05-11') TO ('2026-05-18');

ALTER TABLE service_health_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_health_log_select ON service_health_log FOR SELECT
  USING (app_is_admin() OR app_actor() = 'gateway');
CREATE POLICY service_health_log_insert ON service_health_log FOR INSERT
  WITH CHECK (app_actor() = 'gateway');

------------------------------------------------------------------------------
-- 34. gateway_config
------------------------------------------------------------------------------

CREATE TABLE gateway_config (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  value        text NOT NULL,
  description  text,
  updated_by   uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER gateway_config_updated_at BEFORE UPDATE ON gateway_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE gateway_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY gateway_config_select ON gateway_config FOR SELECT
  USING (app_actor() = 'gateway' OR app_is_admin());
CREATE POLICY gateway_config_write ON gateway_config FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

------------------------------------------------------------------------------
-- 35. email_logs  (PARTITIONED BY RANGE (sent_at) — monthly)
------------------------------------------------------------------------------

CREATE TABLE email_logs (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid,
  template     text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  provider_id  text,
  status       text NOT NULL CHECK (status IN ('sent', 'delivered', 'bounced', 'failed')),
  PRIMARY KEY (id, sent_at)
) PARTITION BY RANGE (sent_at);

CREATE INDEX email_logs_user_id_idx ON email_logs (user_id);
CREATE INDEX email_logs_template_idx ON email_logs (template);
CREATE INDEX email_logs_status_idx ON email_logs (status);
CREATE INDEX email_logs_sent_at_idx ON email_logs (sent_at);

CREATE TABLE email_logs_2026_05 PARTITION OF email_logs
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_logs_select ON email_logs FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY email_logs_write ON email_logs FOR ALL
  USING (app_actor() = 'system') WITH CHECK (app_actor() = 'system');

------------------------------------------------------------------------------
-- 36. migrations
------------------------------------------------------------------------------

CREATE TABLE migrations (
  id        serial PRIMARY KEY,
  filename  text NOT NULL UNIQUE,
  run_at    timestamptz NOT NULL DEFAULT now()
);

-- migrations is intentionally not RLS-protected: only the migration runner
-- (with elevated DB credentials) ever touches it.

------------------------------------------------------------------------------
-- End of schema
------------------------------------------------------------------------------
