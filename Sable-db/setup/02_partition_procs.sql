-- Partition management procedures. Idempotent — safe to call repeatedly.
-- pg_cron (03_cron_schedules.sql) invokes these on a schedule so the next
-- N partitions exist ahead of time and retention drops fire on schedule.
--
-- Cadence-specific procedures exist because the bound type differs:
--   monthly / daily / weekly  → timestamptz bounds
--   yearly-int                → integer bounds (birthday_gifts, anniversaries)
--
-- All procedures live in `public` so service roles can call them via cron
-- (cron jobs run as the user who scheduled them — typically `postgres`).

------------------------------------------------------------------------------
-- ensure_monthly_partitions
--   Ensures partitions exist for the current month and the next N months.
--   Naming: <table>_YYYY_MM.
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE ensure_monthly_partitions(
  p_schema text,
  p_table  text,
  p_ahead  int DEFAULT 2
)
LANGUAGE plpgsql AS $$
DECLARE
  current_month date := date_trunc('month', current_date)::date;
  month_start   date;
  month_end     date;
  partition_name text;
  parent_fq     text := format('%I.%I', p_schema, p_table);
  i             int;
BEGIN
  FOR i IN 0..p_ahead LOOP
    month_start := current_month + make_interval(months => i);
    month_end   := month_start + interval '1 month';
    partition_name := format('%s_%s', p_table, to_char(month_start, 'YYYY_MM'));

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema AND c.relname = partition_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        p_schema, partition_name, parent_fq, month_start, month_end
      );
      RAISE NOTICE 'created partition %.%', p_schema, partition_name;
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- ensure_daily_partitions
--   request_logs is the only daily-partitioned table.
--   Naming: <table>_YYYY_MM_DD.
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE ensure_daily_partitions(
  p_schema text,
  p_table  text,
  p_ahead  int DEFAULT 3
)
LANGUAGE plpgsql AS $$
DECLARE
  day_start     date;
  day_end       date;
  partition_name text;
  parent_fq     text := format('%I.%I', p_schema, p_table);
  i             int;
BEGIN
  FOR i IN 0..p_ahead LOOP
    day_start := current_date + i;
    day_end   := day_start + 1;
    partition_name := format('%s_%s', p_table, to_char(day_start, 'YYYY_MM_DD'));

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema AND c.relname = partition_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        p_schema, partition_name, parent_fq, day_start, day_end
      );
      RAISE NOTICE 'created partition %.%', p_schema, partition_name;
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- ensure_weekly_partitions
--   service_health_log uses ISO weeks (Monday-start).
--   Naming: <table>_YYYY_wWW.
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE ensure_weekly_partitions(
  p_schema text,
  p_table  text,
  p_ahead  int DEFAULT 2
)
LANGUAGE plpgsql AS $$
DECLARE
  -- Snap to ISO Monday. date_trunc('week', d) is Monday in Postgres.
  this_week     date := date_trunc('week', current_date)::date;
  week_start    date;
  week_end      date;
  partition_name text;
  parent_fq     text := format('%I.%I', p_schema, p_table);
  i             int;
BEGIN
  FOR i IN 0..p_ahead LOOP
    week_start := this_week + (i * 7);
    week_end   := week_start + 7;
    partition_name := format('%s_%s_w%s',
      p_table,
      to_char(week_start, 'YYYY'),
      to_char(week_start, 'IW')   -- ISO week number, zero-padded
    );

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema AND c.relname = partition_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        p_schema, partition_name, parent_fq, week_start, week_end
      );
      RAISE NOTICE 'created partition %.%', p_schema, partition_name;
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- ensure_yearly_int_partitions
--   For tables partitioned by an integer `year` column
--   (birthday_gifts, anniversaries). Naming: <table>_YYYY.
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE ensure_yearly_int_partitions(
  p_schema text,
  p_table  text,
  p_ahead  int DEFAULT 1
)
LANGUAGE plpgsql AS $$
DECLARE
  year_int      int;
  partition_name text;
  parent_fq     text := format('%I.%I', p_schema, p_table);
  i             int;
BEGIN
  FOR i IN 0..p_ahead LOOP
    year_int := EXTRACT(year FROM current_date)::int + i;
    partition_name := format('%s_%s', p_table, year_int);

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema AND c.relname = partition_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%s) TO (%s)',
        p_schema, partition_name, parent_fq, year_int, year_int + 1
      );
      RAISE NOTICE 'created partition %.%', p_schema, partition_name;
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- drop_old_partitions
--   Drops any partition of <schema.table> whose UPPER bound is at or
--   before the cutoff timestamp. Reads the bound directly from the
--   partition's stored expression (`pg_get_expr(relpartbound)`).
--
--   Only call on tables where dropping old data is the policy:
--     request_logs    → 90 days
--     webhook_logs    → 12 months
--     service_health  → 52 weeks
--     email_logs      → 24 months
--   Never call on immutable audit (security_events, admin_audit_log,
--   command_history, invoices, sessions).
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE drop_old_partitions(
  p_schema text,
  p_table  text,
  p_cutoff timestamptz
)
LANGUAGE plpgsql AS $$
DECLARE
  r           record;
  upper_str   text;
  upper_bound timestamptz;
BEGIN
  FOR r IN
    SELECT c.relname AS partition_name, pg_get_expr(c.relpartbound, c.oid) AS bound_expr
    FROM pg_inherits i
    JOIN pg_class p  ON p.oid  = i.inhparent
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN pg_class c  ON c.oid  = i.inhrelid
    JOIN pg_namespace n  ON n.oid  = c.relnamespace
    WHERE pn.nspname = p_schema AND p.relname = p_table AND n.nspname = p_schema
  LOOP
    -- bound_expr looks like:  "FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00')"
    -- (or DEFAULT for the default partition — skip those)
    IF r.bound_expr LIKE 'DEFAULT%' THEN
      CONTINUE;
    END IF;

    upper_str := (regexp_match(r.bound_expr, $re$ TO \('([^']+)'\)$re$))[1];
    IF upper_str IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      upper_bound := upper_str::timestamptz;
    EXCEPTION WHEN others THEN
      -- Integer-bound (yearly) partitions go through ensure_yearly_int_partitions
      -- and aren't expected to be retention-dropped; skip silently.
      CONTINUE;
    END;

    IF upper_bound <= p_cutoff THEN
      EXECUTE format('DROP TABLE %I.%I', p_schema, r.partition_name);
      RAISE NOTICE 'dropped partition %.% (upper bound %)', p_schema, r.partition_name, upper_bound;
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- sweep_used_nonces
--   used_nonces is partition-by-minute in the schema but operationally we
--   use a default partition + a row-level sweep. Runs every minute via
--   pg_cron and clears anything past its expires_at.
--   Redis is the primary nonce store; the DB row is the durable backstop.
------------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE sweep_used_nonces()
LANGUAGE sql AS $$
  DELETE FROM gateway.used_nonces WHERE expires_at < now();
$$;
