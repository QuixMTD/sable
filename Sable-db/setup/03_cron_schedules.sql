-- pg_cron schedules. Apply after 02_partition_procs.sql.
--
-- Cloud SQL requirement: set the flag `cloudsql.enable_pg_cron=on` and
-- (if your sable DB is not the cron control DB) configure
-- `cron.database_name` to point at it. After the flag is on:
--   CREATE EXTENSION pg_cron;
--
-- All schedules run as the role that called cron.schedule() (typically
-- `postgres`). cron.unschedule(jobid) removes a job; cron.schedule_in_database
-- targets a different DB if needed. Schedules are idempotent via the
-- "delete + recreate" pattern below.
--
-- Schedule cadences chosen so partitions are always created with plenty
-- of buffer ahead of the boundary they'd otherwise hit.

------------------------------------------------------------------------------
-- Extension
------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_cron;

------------------------------------------------------------------------------
-- Helper: replace a job idempotently
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE schedule_job(
  p_name     text,
  p_schedule text,
  p_command  text
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cron.unschedule(p_name) FROM cron.job WHERE jobname = p_name;
  PERFORM cron.schedule(p_name, p_schedule, p_command);
END $$;

------------------------------------------------------------------------------
-- Monthly partition creation
--
-- Runs at 02:15 on the 25th of every month. Creates the next 2 months of
-- partitions so we always have at least 1 full month of headroom even if
-- the cron misses a fire (Cloud SQL maintenance, etc.).
------------------------------------------------------------------------------

CALL schedule_job(
  'partitions-monthly-gateway-sessions',
  '15 2 25 * *',
  $$ CALL ensure_monthly_partitions('gateway', 'sessions', 2); $$
);

CALL schedule_job(
  'partitions-monthly-gateway-admin-audit-log',
  '15 2 25 * *',
  $$ CALL ensure_monthly_partitions('gateway', 'admin_audit_log', 2); $$
);

CALL schedule_job(
  'partitions-monthly-gateway-security-events',
  '15 2 25 * *',
  $$ CALL ensure_monthly_partitions('gateway', 'security_events', 2); $$
);

CALL schedule_job(
  'partitions-monthly-gateway-invoices',
  '15 2 25 * *',
  $$ CALL ensure_monthly_partitions('gateway', 'invoices', 2); $$
);

CALL schedule_job(
  'partitions-monthly-gateway-webhook-logs',
  '15 2 25 * *',
  $$ CALL ensure_monthly_partitions('gateway', 'webhook_logs', 2); $$
);

CALL schedule_job(
  'partitions-monthly-gateway-email-logs',
  '15 2 25 * *',
  $$ CALL ensure_monthly_partitions('gateway', 'email_logs', 2); $$
);

CALL schedule_job(
  'partitions-monthly-core-command-history',
  '15 2 25 * *',
  $$ CALL ensure_monthly_partitions('core', 'command_history', 2); $$
);

------------------------------------------------------------------------------
-- Daily partition creation
--
-- request_logs partitions by day. Runs at 23:00 each day to create
-- tomorrow + the day after.
------------------------------------------------------------------------------

CALL schedule_job(
  'partitions-daily-gateway-request-logs',
  '0 23 * * *',
  $$ CALL ensure_daily_partitions('gateway', 'request_logs', 3); $$
);

------------------------------------------------------------------------------
-- Weekly partition creation
--
-- service_health_log partitions by ISO week. Runs at 02:15 every Sunday
-- (end of ISO week 6 of the day) — at that point the new Monday is
-- already next-week and 2 weeks ahead means coverage through 14 days.
------------------------------------------------------------------------------

CALL schedule_job(
  'partitions-weekly-gateway-service-health-log',
  '15 2 * * 0',
  $$ CALL ensure_weekly_partitions('gateway', 'service_health_log', 2); $$
);

------------------------------------------------------------------------------
-- Yearly (integer-bound) partition creation
--
-- birthday_gifts / anniversaries partition by integer year. Runs at 02:15
-- on December 25th — creates the upcoming year's partition with a week
-- of buffer.
------------------------------------------------------------------------------

CALL schedule_job(
  'partitions-yearly-gateway-birthday-gifts',
  '15 2 25 12 *',
  $$ CALL ensure_yearly_int_partitions('gateway', 'birthday_gifts', 1); $$
);

CALL schedule_job(
  'partitions-yearly-gateway-anniversaries',
  '15 2 25 12 *',
  $$ CALL ensure_yearly_int_partitions('gateway', 'anniversaries', 1); $$
);

------------------------------------------------------------------------------
-- Retention drops
--
-- Only the tables whose retention is documented as bounded.
-- Audit-bearing partitions (security_events, admin_audit_log,
-- command_history, invoices, sessions) are NOT dropped.
------------------------------------------------------------------------------

-- request_logs: 90 days
CALL schedule_job(
  'retention-gateway-request-logs',
  '30 3 * * *',
  $$ CALL drop_old_partitions('gateway', 'request_logs', now() - interval '90 days'); $$
);

-- webhook_logs: 12 months
CALL schedule_job(
  'retention-gateway-webhook-logs',
  '45 3 1 * *',
  $$ CALL drop_old_partitions('gateway', 'webhook_logs', now() - interval '12 months'); $$
);

-- service_health_log: 52 weeks (roughly 1 year of weekly partitions)
CALL schedule_job(
  'retention-gateway-service-health-log',
  '0 4 * * 1',
  $$ CALL drop_old_partitions('gateway', 'service_health_log', now() - interval '52 weeks'); $$
);

-- email_logs: 24 months
CALL schedule_job(
  'retention-gateway-email-logs',
  '15 4 1 * *',
  $$ CALL drop_old_partitions('gateway', 'email_logs', now() - interval '24 months'); $$
);

------------------------------------------------------------------------------
-- used_nonces sweep
--
-- Per-minute deletion of expired nonces in the default partition. Cheap
-- (deletes ~hundreds of rows per minute under load) and means the table
-- never grows past the 30-second window.
------------------------------------------------------------------------------

CALL schedule_job(
  'sweep-gateway-used-nonces',
  '* * * * *',
  $$ CALL sweep_used_nonces(); $$
);

------------------------------------------------------------------------------
-- Verification
------------------------------------------------------------------------------
-- SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobname;
-- SELECT jobid, runid, status, return_message, start_time, end_time
--   FROM cron.job_run_details
--   ORDER BY start_time DESC
--   LIMIT 50;
