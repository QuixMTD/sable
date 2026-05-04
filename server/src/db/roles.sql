-- Sable Terminal — Database Roles & Privileges
--
-- Run AFTER schema.sql against an existing role. The role is referenced via
-- the `app_role` psql variable so the same script works for dev/staging/prod:
--
--   psql -v app_role=sable_app_dev    -f roles.sql
--   psql -v app_role=sable_app_prod   -f roles.sql
--
-- The role itself (CREATE ROLE / password) is NOT managed here — that belongs
-- to your provisioning system (Terraform, Pulumi, etc.) where you can manage
-- secrets properly.

\if :{?app_role}
\else
  \echo 'ERROR: pass -v app_role=<role_name>'
  \quit
\endif

-- ----------------------------------------------------------------------------
-- Baseline grants (read + write on tables, sequences, helper functions)
-- ----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO :"app_role";

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO :"app_role";

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO :"app_role";

GRANT EXECUTE
  ON ALL FUNCTIONS IN SCHEMA public
  TO :"app_role";

-- New tables/sequences/functions added by future migrations inherit these.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"app_role";

-- ----------------------------------------------------------------------------
-- Append-only enforcement at the privilege level.
-- The triggers are defence-in-depth; this is the actual line.
-- ----------------------------------------------------------------------------

REVOKE UPDATE, DELETE ON audit_log             FROM :"app_role";
REVOKE UPDATE, DELETE ON certification_ledger  FROM :"app_role";
REVOKE UPDATE, DELETE ON command_runs          FROM :"app_role";
REVOKE UPDATE, DELETE ON compliance_checks     FROM :"app_role";
REVOKE UPDATE, DELETE ON transactions          FROM :"app_role";

-- ----------------------------------------------------------------------------
-- Reference / market data is read-only for the application — writes happen
-- through a separate ingestion pipeline with its own role.
-- (Comment out if your app writes these directly.)
-- ----------------------------------------------------------------------------

-- REVOKE INSERT, UPDATE, DELETE ON price_cache         FROM :"app_role";
-- REVOKE INSERT, UPDATE, DELETE ON fundamentals_cache  FROM :"app_role";
-- REVOKE INSERT, UPDATE, DELETE ON security_metadata   FROM :"app_role";
-- REVOKE INSERT, UPDATE, DELETE ON news_cache          FROM :"app_role";

-- ----------------------------------------------------------------------------
-- Admin tables — read OK, writes only by an admin role you provision separately.
-- ----------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE ON feature_flags         FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE ON system_announcements  FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE ON admin_users           FROM :"app_role";

-- ----------------------------------------------------------------------------
-- The app role MUST NOT have BYPASSRLS — RLS policies in schema.sql are
-- the second tenant-isolation layer. Run this defensively:
-- ----------------------------------------------------------------------------

ALTER ROLE :"app_role" NOBYPASSRLS;
