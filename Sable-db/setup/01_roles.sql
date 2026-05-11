-- Per-service Postgres roles. Each Node service connects as its own role
-- using a password from GCP Secret Manager (set via Cloud SQL admin /
-- Terraform, not in this file).
--
-- The role is the HARD wall; RLS is the soft wall on top. A service is
-- structurally incapable of touching another schema's tables because the
-- DB itself rejects the query — RLS only matters once you're past the
-- GRANT check.
--
-- Apply order: gateway-schema.sql → core-schema.sql → 01_roles.sql.
-- Roles for sc / re / crypto / alt are pre-created so passwords can be
-- provisioned in Secret Manager ahead of time; their grants are added
-- when those schemas land.

------------------------------------------------------------------------------
-- Service roles
------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_svc') THEN
    CREATE ROLE gateway_svc LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_svc') THEN
    CREATE ROLE core_svc LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sc_svc') THEN
    CREATE ROLE sc_svc LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 're_svc') THEN
    CREATE ROLE re_svc LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crypto_svc') THEN
    CREATE ROLE crypto_svc LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alt_svc') THEN
    CREATE ROLE alt_svc LOGIN;
  END IF;
END $$;

------------------------------------------------------------------------------
-- Shared: helpers in `public`
--
-- Every service needs to call enc/dec/sha256/app_* — they live in public
-- (created by gateway-schema.sql). Execute-only; nobody writes to public.
------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO gateway_svc, core_svc, sc_svc, re_svc, crypto_svc, alt_svc;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO gateway_svc, core_svc, sc_svc, re_svc, crypto_svc, alt_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO gateway_svc, core_svc, sc_svc, re_svc, crypto_svc, alt_svc;

------------------------------------------------------------------------------
-- gateway_svc — owns the gateway schema
------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA gateway TO gateway_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway TO gateway_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO gateway_svc;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA gateway TO gateway_svc;

ALTER DEFAULT PRIVILEGES IN SCHEMA gateway
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gateway_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway
  GRANT USAGE, SELECT ON SEQUENCES TO gateway_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway
  GRANT EXECUTE ON FUNCTIONS TO gateway_svc;

------------------------------------------------------------------------------
-- core_svc — owns the core schema; reads from gateway for cross-schema FKs
--           and RLS policy resolution (e.g. comments policy joins gateway.users)
------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA core TO core_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO core_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO core_svc;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO core_svc;

ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT USAGE, SELECT ON SEQUENCES TO core_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT EXECUTE ON FUNCTIONS TO core_svc;

-- Cross-schema reads — RLS still enforces row-level access on top.
GRANT USAGE ON SCHEMA gateway TO core_svc;
GRANT SELECT ON gateway.users, gateway.organisations TO core_svc;

------------------------------------------------------------------------------
-- Module services (sc / re / crypto / alt) — pre-grant the cross-schema
-- reads they'll need so when their schemas land, the only delta is
-- granting on their own schema.
--
-- Each module service reads:
--   - gateway.users / gateway.organisations  → identity for RLS
--   - core.portfolios / core.clients         → ownership chain for RLS pass-through
------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA gateway TO sc_svc, re_svc, crypto_svc, alt_svc;
GRANT SELECT ON gateway.users, gateway.organisations
  TO sc_svc, re_svc, crypto_svc, alt_svc;

GRANT USAGE ON SCHEMA core TO sc_svc, re_svc, crypto_svc, alt_svc;
GRANT SELECT ON core.portfolios, core.clients
  TO sc_svc, re_svc, crypto_svc, alt_svc;

------------------------------------------------------------------------------
-- Connection limits
--
-- Each Cloud Run instance opens up to `max` connections (sable-shared
-- defaults to 5). Cap per role so a runaway service can't exhaust the
-- Cloud SQL `max_connections` budget alone.
------------------------------------------------------------------------------

ALTER ROLE gateway_svc CONNECTION LIMIT 50;
ALTER ROLE core_svc    CONNECTION LIMIT 50;
ALTER ROLE sc_svc      CONNECTION LIMIT 30;
ALTER ROLE re_svc      CONNECTION LIMIT 30;
ALTER ROLE crypto_svc  CONNECTION LIMIT 30;
ALTER ROLE alt_svc     CONNECTION LIMIT 30;

------------------------------------------------------------------------------
-- Verification (run manually after applying)
------------------------------------------------------------------------------
-- \du+
-- SELECT grantee, table_schema, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee IN ('gateway_svc', 'core_svc', 'sc_svc', 're_svc', 'crypto_svc', 'alt_svc')
--   ORDER BY grantee, table_schema, table_name;
