-- Sable Terminal — Database Schema
-- PostgreSQL 16+
-- Source of truth: server/src/sable-database-design.md (v1.0)
--
-- 56 tables · 8 partitioned · 5 append-only · raw SQL, no ORM.
-- Order minimises forward references; circular FKs (certifications ↔ ledger)
-- are added at the end of the file.

SET client_min_messages = warning;
SET search_path = public;

-- ============================================================================
-- Helpers
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Reject UPDATE/DELETE on append-only tables. Defence-in-depth on top of
-- the privilege model — the application role should not have the grant either.
CREATE OR REPLACE FUNCTION prevent_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'modifications not permitted on append-only table %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION compute_word_count() RETURNS TRIGGER AS $$
BEGIN
  NEW.word_count = COALESCE(
    array_length(regexp_split_to_array(trim(NEW.content), '\s+'), 1),
    0
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Section 1 — Identity and Access
-- ============================================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  username TEXT NOT NULL,
  avatar_url TEXT,
  timezone TEXT,
  locale TEXT,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  onboarding_completed_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_clerk_id_key ON users (clerk_id);
CREATE UNIQUE INDEX users_username_key ON users (username);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_last_active_at_idx ON users (last_active_at);
CREATE INDEX users_signed_up_at_idx ON users (signed_up_at);
CREATE INDEX users_active_idx ON users (id) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  clerk_session_id TEXT NOT NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id);
CREATE UNIQUE INDEX user_sessions_clerk_session_id_key ON user_sessions (clerk_session_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions (expires_at);

-- ============================================================================
-- Section 2 — Organisations and Users
-- ============================================================================

CREATE TABLE organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('individual', 'organisation')),
  plan TEXT NOT NULL CHECK (plan IN ('trial', 'active', 'suspended', 'cancelled')),
  seat_count INTEGER NOT NULL DEFAULT 1,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  billing_email TEXT,
  trial_ends_at TIMESTAMPTZ,
  external_sharing_policy TEXT NOT NULL DEFAULT 'allow'
    CHECK (external_sharing_policy IN ('allow', 'require_approval', 'disallow')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  founded_at DATE,
  website TEXT,
  aum_range TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX organisations_slug_key ON organisations (slug);
CREATE UNIQUE INDEX organisations_stripe_customer_id_key ON organisations (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX organisations_stripe_subscription_id_key ON organisations (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX organisations_plan_idx ON organisations (plan);
CREATE INDEX organisations_active_idx ON organisations (id) WHERE deleted_at IS NULL;

CREATE TRIGGER organisations_set_updated_at BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 3 — Roles and Permissions (declared early; FK from organisation_members)
-- ============================================================================

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID REFERENCES organisations(id),
  name TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX roles_organisation_id_idx ON roles (organisation_id);
CREATE UNIQUE INDEX roles_org_name_key ON roles (organisation_id, name);
CREATE INDEX roles_is_system_idx ON roles (is_system);

CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE permission_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX permission_definitions_key_key ON permission_definitions (key);
CREATE INDEX permission_definitions_category_idx ON permission_definitions (category);

-- ----------------------------------------------------------------------------
-- organisation_members and invitations (Section 2 cont.)
-- ----------------------------------------------------------------------------

CREATE TABLE organisation_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role_id UUID NOT NULL REFERENCES roles(id),
  invited_by UUID REFERENCES users(id),
  invited_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  removed_at TIMESTAMPTZ,
  removed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX organisation_members_org_user_key ON organisation_members (organisation_id, user_id);
CREATE INDEX organisation_members_organisation_id_idx ON organisation_members (organisation_id);
CREATE INDEX organisation_members_user_id_idx ON organisation_members (user_id);
CREATE INDEX organisation_members_status_idx ON organisation_members (status);
CREATE INDEX organisation_members_role_id_idx ON organisation_members (role_id);

CREATE TRIGGER organisation_members_set_updated_at BEFORE UPDATE ON organisation_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE organisation_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  invited_by UUID NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id),
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX organisation_invitations_token_key ON organisation_invitations (token);
CREATE INDEX organisation_invitations_email_idx ON organisation_invitations (lower(email));
CREATE INDEX organisation_invitations_organisation_id_idx ON organisation_invitations (organisation_id);
CREATE INDEX organisation_invitations_expires_at_idx ON organisation_invitations (expires_at);

-- ============================================================================
-- Section 4 — Strategies and Portfolios
-- ============================================================================

CREATE TABLE strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'long_only', 'long_short', 'macro', 'systematic', 'multi_asset', 'fixed_income', 'custom'
  )),
  style TEXT CHECK (style IN (
    'value', 'growth', 'momentum', 'quality', 'blend', 'systematic', 'discretionary'
  )),
  horizon TEXT CHECK (horizon IN ('short_term', 'medium_term', 'long_term')),
  universe TEXT,
  benchmark_ticker TEXT,
  base_currency TEXT NOT NULL,
  risk_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX strategies_organisation_id_idx ON strategies (organisation_id);
CREATE INDEX strategies_created_by_idx ON strategies (created_by);
CREATE INDEX strategies_type_idx ON strategies (type);
CREATE INDEX strategies_active_idx ON strategies (id) WHERE deleted_at IS NULL;

CREATE TRIGGER strategies_set_updated_at BEFORE UPDATE ON strategies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  strategy_id UUID NOT NULL REFERENCES strategies(id),
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  base_currency TEXT NOT NULL,
  benchmark_ticker TEXT,
  inception_date DATE NOT NULL,
  is_paper BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
  closed_at TIMESTAMPTZ,
  aum DECIMAL(20,2),
  cash_balance DECIMAL(20,8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX portfolios_organisation_id_idx ON portfolios (organisation_id);
CREATE INDEX portfolios_strategy_id_idx ON portfolios (strategy_id);
CREATE INDEX portfolios_created_by_idx ON portfolios (created_by);
CREATE INDEX portfolios_status_idx ON portfolios (status);
CREATE INDEX portfolios_is_paper_idx ON portfolios (is_paper);
CREATE INDEX portfolios_active_idx ON portfolios (id) WHERE deleted_at IS NULL;

CREATE TRIGGER portfolios_set_updated_at BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 8 — Theses (declared early; positions FKs to it)
-- ============================================================================

CREATE TABLE theses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  ticker TEXT,
  theme TEXT,
  title TEXT NOT NULL,
  thesis_statement TEXT NOT NULL,
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  invalidators JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_price DECIMAL(20,8),
  target_currency TEXT,
  horizon TEXT,
  conviction TEXT CHECK (conviction IN ('high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'invalidated')),
  closed_reason TEXT,
  return_achieved DECIMAL(10,4),
  tags TEXT[] NOT NULL DEFAULT '{}',
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(thesis_statement, '')), 'B')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX theses_organisation_id_idx ON theses (organisation_id);
CREATE INDEX theses_created_by_idx ON theses (created_by);
CREATE INDEX theses_ticker_idx ON theses (ticker);
CREATE INDEX theses_status_idx ON theses (status);
CREATE INDEX theses_conviction_idx ON theses (conviction);
CREATE INDEX theses_tags_idx ON theses USING GIN (tags);
CREATE INDEX theses_search_idx ON theses USING GIN (search_vector);

CREATE TRIGGER theses_set_updated_at BEFORE UPDATE ON theses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 5 — Positions and Transactions
-- ============================================================================

CREATE TABLE positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  thesis_id UUID REFERENCES theses(id),
  ticker TEXT NOT NULL,
  isin TEXT,
  name TEXT,
  asset_class TEXT NOT NULL CHECK (asset_class IN (
    'equity', 'fixed_income', 'fx', 'commodity', 'crypto', 'etf', 'fund', 'other'
  )),
  exchange TEXT,
  currency TEXT NOT NULL,
  quantity DECIMAL(20,8) NOT NULL DEFAULT 0,
  avg_cost DECIMAL(20,8) NOT NULL DEFAULT 0,
  avg_cost_base DECIMAL(20,8) NOT NULL DEFAULT 0,
  realised_pnl DECIMAL(20,8) NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX positions_portfolio_id_idx ON positions (portfolio_id);
CREATE UNIQUE INDEX positions_portfolio_ticker_active_key ON positions (portfolio_id, ticker)
  WHERE is_active = TRUE;
CREATE INDEX positions_ticker_idx ON positions (ticker);
CREATE INDEX positions_active_idx ON positions (id) WHERE is_active = TRUE;
CREATE INDEX positions_asset_class_idx ON positions (asset_class);
CREATE INDEX positions_thesis_id_idx ON positions (thesis_id);
CREATE INDEX positions_opened_at_idx ON positions (opened_at);
CREATE INDEX positions_closed_at_idx ON positions (closed_at);

CREATE TRIGGER positions_set_updated_at BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- CSV format templates (declared early; transaction_import_batches and
-- position_import_batches FK to it).
-- ----------------------------------------------------------------------------

CREATE TABLE csv_format_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID REFERENCES organisations(id),
  created_by UUID REFERENCES users(id),
  name TEXT NOT NULL,
  broker TEXT,
  import_type TEXT NOT NULL CHECK (import_type IN ('transactions', 'positions')),
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  column_mapping JSONB NOT NULL,
  type_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  skip_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  amount_config JSONB NOT NULL DEFAULT '{
    "decimal_separator": ".",
    "thousands_separator": ",",
    "parentheses_negative": false,
    "strip_currency_symbols": true
  }'::jsonb,
  sample_file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX csv_format_templates_organisation_id_idx ON csv_format_templates (organisation_id);
CREATE INDEX csv_format_templates_broker_idx ON csv_format_templates (broker);
CREATE INDEX csv_format_templates_import_type_idx ON csv_format_templates (import_type);
CREATE INDEX csv_format_templates_is_system_idx ON csv_format_templates (is_system);
CREATE INDEX csv_format_templates_active_idx ON csv_format_templates (id) WHERE deleted_at IS NULL;

CREATE TRIGGER csv_format_templates_set_updated_at BEFORE UPDATE ON csv_format_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- transaction_import_batches — tracks the batch + how it was parsed +
-- preview/confirm lifecycle.
-- ----------------------------------------------------------------------------

CREATE TABLE transaction_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  imported_by UUID NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  format_template_id UUID REFERENCES csv_format_templates(id),
  column_mapping JSONB,
  type_mapping JSONB,
  raw_file_url TEXT,
  raw_file_size_bytes BIGINT,
  preview_row_count INTEGER,
  row_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  date_range_start DATE,
  date_range_end DATE,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Processing-state lifecycle. Whether the user has approved the import is
  -- tracked separately by confirmed_at (NULL = not yet confirmed).
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',                -- uploaded, not yet parsed
    'previewing',             -- staging rows created, awaiting user review
    'processing',             -- commit in progress
    'completed',              -- successfully committed
    'completed_with_errors',  -- committed with some row-level errors
    'failed',                 -- commit failed entirely
    'cancelled'               -- user cancelled before commit
  )),
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES users(id),
  import_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX transaction_import_batches_portfolio_id_idx ON transaction_import_batches (portfolio_id);
CREATE INDEX transaction_import_batches_imported_by_idx ON transaction_import_batches (imported_by);
CREATE INDEX transaction_import_batches_status_idx ON transaction_import_batches (status);
CREATE INDEX transaction_import_batches_format_template_id_idx ON transaction_import_batches (format_template_id)
  WHERE format_template_id IS NOT NULL;
CREATE INDEX transaction_import_batches_unconfirmed_idx ON transaction_import_batches (created_at)
  WHERE confirmed_at IS NULL;

CREATE TRIGGER transaction_import_batches_set_updated_at BEFORE UPDATE ON transaction_import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- csv_import_rows — staging layer: each parsed row sits here for user review
-- before commit. duplicate_of_/resulting_transaction_id are soft references
-- because transactions has a composite PK (id, executed_at) — single-column
-- FKs aren't possible.
-- ----------------------------------------------------------------------------

CREATE TABLE csv_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES transaction_import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  raw_data JSONB NOT NULL,
  mapped_type TEXT,
  mapped_ticker TEXT,
  mapped_isin TEXT,
  mapped_quantity DECIMAL(20,8),
  mapped_price DECIMAL(20,8),
  mapped_currency TEXT,
  mapped_fx_rate DECIMAL(20,8),
  mapped_fees DECIMAL(20,8),
  mapped_executed_at TIMESTAMPTZ,
  mapped_settlement_date DATE,
  mapped_exchange TEXT,
  mapped_notes TEXT,
  computed_gross_amount DECIMAL(20,8),
  computed_net_amount DECIMAL(20,8),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'valid', 'warning', 'error', 'skipped', 'duplicate', 'imported'
  )),
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  skip_reason TEXT,
  duplicate_of_transaction_id UUID,
  resulting_transaction_id UUID,
  user_override JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX csv_import_rows_import_batch_id_idx ON csv_import_rows (import_batch_id);
CREATE INDEX csv_import_rows_status_idx ON csv_import_rows (import_batch_id, status);
CREATE INDEX csv_import_rows_row_number_idx ON csv_import_rows (import_batch_id, row_number);
CREATE INDEX csv_import_rows_duplicate_idx ON csv_import_rows (duplicate_of_transaction_id)
  WHERE duplicate_of_transaction_id IS NOT NULL;

CREATE TRIGGER csv_import_rows_set_updated_at BEFORE UPDATE ON csv_import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- position_import_batches — snapshot imports (current holdings, not history).
-- reconciliation_mode controls what happens to existing positions:
--   additive   = add new, leave existing alone
--   replace    = close existing, replace with snapshot
--   reconcile  = match + flag discrepancies (broker vs Sable)
-- ----------------------------------------------------------------------------

CREATE TABLE position_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  imported_by UUID NOT NULL REFERENCES users(id),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  format_template_id UUID REFERENCES csv_format_templates(id),
  column_mapping JSONB,
  type_mapping JSONB,
  filename TEXT NOT NULL,
  raw_file_url TEXT,
  raw_file_size_bytes BIGINT,
  snapshot_date DATE NOT NULL,
  reconciliation_mode TEXT NOT NULL DEFAULT 'additive'
    CHECK (reconciliation_mode IN ('additive', 'replace', 'reconcile')),
  -- Same lifecycle as transaction_import_batches; confirmed_at tracks the user
  -- approval timestamp, status tracks the processing state.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'previewing', 'processing',
    'completed', 'completed_with_errors', 'failed', 'cancelled'
  )),
  row_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES users(id),
  import_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX position_import_batches_portfolio_id_idx ON position_import_batches (portfolio_id);
CREATE INDEX position_import_batches_imported_by_idx ON position_import_batches (imported_by);
CREATE INDEX position_import_batches_organisation_id_idx ON position_import_batches (organisation_id);
CREATE INDEX position_import_batches_status_idx ON position_import_batches (status);
CREATE INDEX position_import_batches_snapshot_date_idx ON position_import_batches (snapshot_date);

CREATE TRIGGER position_import_batches_set_updated_at BEFORE UPDATE ON position_import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- position_import_rows — staging for snapshot imports.
-- ----------------------------------------------------------------------------

CREATE TABLE position_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES position_import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  raw_data JSONB NOT NULL,
  mapped_ticker TEXT,
  mapped_isin TEXT,
  mapped_name TEXT,
  mapped_asset_class TEXT,
  mapped_exchange TEXT,
  mapped_currency TEXT,
  mapped_quantity DECIMAL(20,8),
  mapped_avg_cost DECIMAL(20,8),
  mapped_market_value DECIMAL(20,8),
  mapped_cost_basis DECIMAL(20,8),
  existing_position_id UUID REFERENCES positions(id),
  existing_quantity DECIMAL(20,8),
  quantity_difference DECIMAL(20,8),
  reconciliation_action TEXT CHECK (reconciliation_action IN (
    'none', 'create', 'update', 'close', 'skip'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'valid', 'warning', 'error', 'skipped', 'duplicate', 'imported'
  )),
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  skip_reason TEXT,
  resulting_position_id UUID,
  user_override JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX position_import_rows_import_batch_id_idx ON position_import_rows (import_batch_id);
CREATE INDEX position_import_rows_status_idx ON position_import_rows (import_batch_id, status);
CREATE INDEX position_import_rows_row_number_idx ON position_import_rows (import_batch_id, row_number);
CREATE INDEX position_import_rows_existing_position_id_idx ON position_import_rows (existing_position_id)
  WHERE existing_position_id IS NOT NULL;
CREATE INDEX position_import_rows_resulting_position_id_idx ON position_import_rows (resulting_position_id)
  WHERE resulting_position_id IS NOT NULL;

CREATE TRIGGER position_import_rows_set_updated_at BEFORE UPDATE ON position_import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- transactions (PARTITIONED BY RANGE on executed_at, yearly)
-- ----------------------------------------------------------------------------

CREATE TABLE transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  position_id UUID NOT NULL REFERENCES positions(id),
  entered_by UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'buy', 'sell', 'dividend', 'split', 'spinoff', 'rights',
    'fee', 'transfer_in', 'transfer_out', 'correction'
  )),
  ticker TEXT NOT NULL,
  quantity DECIMAL(20,8) NOT NULL,
  price DECIMAL(20,8) NOT NULL,
  currency TEXT NOT NULL,
  fx_rate DECIMAL(20,8) NOT NULL DEFAULT 1,
  gross_amount DECIMAL(20,8) NOT NULL,
  gross_amount_base DECIMAL(20,8) NOT NULL,
  fees DECIMAL(20,8) NOT NULL DEFAULT 0,
  fees_base DECIMAL(20,8) NOT NULL DEFAULT 0,
  net_amount_base DECIMAL(20,8) NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  settlement_date DATE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'csv_import', 'position_import', 'correction')),
  import_batch_id UUID REFERENCES transaction_import_batches(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, executed_at)
) PARTITION BY RANGE (executed_at);

CREATE INDEX transactions_portfolio_id_idx ON transactions (portfolio_id);
CREATE INDEX transactions_position_id_idx ON transactions (position_id);
CREATE INDEX transactions_executed_at_idx ON transactions (executed_at);
CREATE INDEX transactions_type_idx ON transactions (type);
CREATE INDEX transactions_ticker_idx ON transactions (ticker);
CREATE INDEX transactions_entered_by_idx ON transactions (entered_by);
CREATE INDEX transactions_import_batch_id_idx ON transactions (import_batch_id);

-- Append-only enforcement (corrections recorded as new rows of type='correction').
CREATE TRIGGER transactions_no_update BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE TABLE transactions_2026 PARTITION OF transactions
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE transactions_default PARTITION OF transactions DEFAULT;

-- ============================================================================
-- Section 6 — Commands
-- ============================================================================

CREATE TABLE commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID REFERENCES organisations(id),
  created_by UUID REFERENCES users(id),
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('primitive', 'ai_prompt', 'python', 'pipeline')),
  config JSONB NOT NULL,
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  is_org_shared BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  current_version INTEGER NOT NULL DEFAULT 1,
  tags TEXT[] NOT NULL DEFAULT '{}',
  run_count BIGINT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (trigger LIKE '/%')
);

CREATE INDEX commands_organisation_id_idx ON commands (organisation_id);
CREATE INDEX commands_created_by_idx ON commands (created_by);
CREATE UNIQUE INDEX commands_org_trigger_key ON commands (organisation_id, trigger)
  WHERE deleted_at IS NULL;
CREATE INDEX commands_type_idx ON commands (type);
CREATE INDEX commands_is_builtin_idx ON commands (is_builtin);
CREATE INDEX commands_is_org_shared_idx ON commands (is_org_shared);
CREATE INDEX commands_is_published_idx ON commands (is_published);
CREATE INDEX commands_tags_idx ON commands USING GIN (tags);
CREATE INDEX commands_last_run_at_idx ON commands (last_run_at);

CREATE TRIGGER commands_set_updated_at BEFORE UPDATE ON commands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE command_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL REFERENCES commands(id),
  version INTEGER NOT NULL,
  config JSONB NOT NULL,
  change_notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX command_versions_command_version_key ON command_versions (command_id, version);
CREATE INDEX command_versions_command_id_idx ON command_versions (command_id);

-- ----------------------------------------------------------------------------

CREATE TABLE command_parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL REFERENCES commands(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('integer', 'float', 'string', 'boolean', 'enum')),
  default_value TEXT,
  allowed_values TEXT[],
  description TEXT,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX command_parameters_command_id_idx ON command_parameters (command_id);

-- ============================================================================
-- Section 12 — Dashboards (declared early; command_runs FKs to it)
-- ============================================================================

CREATE TABLE dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_org_shared BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX dashboards_organisation_id_idx ON dashboards (organisation_id);
CREATE INDEX dashboards_created_by_idx ON dashboards (created_by);
CREATE INDEX dashboards_is_org_shared_idx ON dashboards (is_org_shared);
CREATE UNIQUE INDEX dashboards_is_default_idx ON dashboards (created_by) WHERE is_default = TRUE;

CREATE TRIGGER dashboards_set_updated_at BEFORE UPDATE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE dashboard_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES dashboards(id),
  type TEXT NOT NULL CHECK (type IN (
    'command_output', 'live_price', 'portfolio_view', 'watchlist',
    'news_feed', 'note', 'chart', 'embedded_screen', 'shortcut', 'script_output'
  )),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position JSONB NOT NULL,
  title TEXT,
  refresh_interval TEXT NOT NULL DEFAULT 'manual'
    CHECK (refresh_interval IN ('manual', 'on_open', '1m', '5m', '15m', '1h')),
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX dashboard_widgets_dashboard_id_idx ON dashboard_widgets (dashboard_id);
CREATE INDEX dashboard_widgets_type_idx ON dashboard_widgets (type);

CREATE TRIGGER dashboard_widgets_set_updated_at BEFORE UPDATE ON dashboard_widgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE workspace_layouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX workspace_layouts_user_id_idx ON workspace_layouts (user_id);
CREATE UNIQUE INDEX workspace_layouts_user_default_idx ON workspace_layouts (user_id) WHERE is_default = TRUE;

CREATE TRIGGER workspace_layouts_set_updated_at BEFORE UPDATE ON workspace_layouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 7 — Command Runs (PARTITIONED BY RANGE on created_at, monthly)
-- ============================================================================

CREATE TABLE command_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  command_id UUID REFERENCES commands(id),
  user_id UUID NOT NULL REFERENCES users(id),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  trigger TEXT NOT NULL,
  context JSONB,
  output JSONB,
  output_format TEXT,
  error TEXT,
  duration_ms INTEGER,
  quant_duration_ms INTEGER,
  ai_duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'cancelled')),
  pinned_to_dashboard_id UUID REFERENCES dashboards(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX command_runs_user_id_idx ON command_runs (user_id);
CREATE INDEX command_runs_organisation_id_idx ON command_runs (organisation_id);
CREATE INDEX command_runs_command_id_idx ON command_runs (command_id);
CREATE INDEX command_runs_status_idx ON command_runs (status);
CREATE INDEX command_runs_created_at_idx ON command_runs (created_at);
CREATE INDEX command_runs_duration_ms_idx ON command_runs (duration_ms);

CREATE TRIGGER command_runs_no_update BEFORE UPDATE ON command_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
CREATE TRIGGER command_runs_no_delete BEFORE DELETE ON command_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE TABLE command_runs_2026_05 PARTITION OF command_runs
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE command_runs_default PARTITION OF command_runs DEFAULT;

-- ============================================================================
-- Section 8 — Theses (rest)
-- ============================================================================

CREATE TABLE thesis_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id UUID NOT NULL REFERENCES theses(id),
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  change_summary TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX thesis_versions_thesis_version_key ON thesis_versions (thesis_id, version);
CREATE INDEX thesis_versions_thesis_id_idx ON thesis_versions (thesis_id);

-- ----------------------------------------------------------------------------

CREATE TABLE thesis_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id UUID NOT NULL REFERENCES theses(id),
  created_by UUID NOT NULL REFERENCES users(id),
  parent_id UUID REFERENCES thesis_comments(id),
  content TEXT NOT NULL,
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX thesis_comments_thesis_id_idx ON thesis_comments (thesis_id);
CREATE INDEX thesis_comments_parent_id_idx ON thesis_comments (parent_id);
CREATE INDEX thesis_comments_created_by_idx ON thesis_comments (created_by);

CREATE TRIGGER thesis_comments_set_updated_at BEFORE UPDATE ON thesis_comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 9 — Research: Notes
-- ============================================================================

CREATE TABLE research_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  title TEXT,
  content TEXT NOT NULL DEFAULT '',
  tickers TEXT[] NOT NULL DEFAULT '{}',
  thesis_id UUID REFERENCES theses(id),
  portfolio_id UUID REFERENCES portfolios(id),
  embedded_outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  word_count INTEGER NOT NULL DEFAULT 0,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX research_notes_organisation_id_idx ON research_notes (organisation_id);
CREATE INDEX research_notes_created_by_idx ON research_notes (created_by);
CREATE INDEX research_notes_tickers_idx ON research_notes USING GIN (tickers);
CREATE INDEX research_notes_thesis_id_idx ON research_notes (thesis_id);
CREATE INDEX research_notes_tags_idx ON research_notes USING GIN (tags);
CREATE INDEX research_notes_search_idx ON research_notes USING GIN (search_vector);

CREATE TRIGGER research_notes_set_updated_at BEFORE UPDATE ON research_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER research_notes_word_count
  BEFORE INSERT OR UPDATE OF content ON research_notes
  FOR EACH ROW EXECUTE FUNCTION compute_word_count();

-- ============================================================================
-- Section 10 — Research: Documents
-- ============================================================================

CREATE TABLE research_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  uploaded_by UUID NOT NULL REFERENCES users(id),
  title TEXT,
  source TEXT,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'broker_research', 'annual_report', 'earnings_transcript',
    'presentation', 'regulatory', 'other'
  )),
  tickers TEXT[] NOT NULL DEFAULT '{}',
  file_url TEXT NOT NULL,
  file_size_bytes BIGINT,
  page_count INTEGER,
  content_extracted TEXT,
  ai_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'completed', 'failed')),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content_extracted, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX research_documents_organisation_id_idx ON research_documents (organisation_id);
CREATE INDEX research_documents_uploaded_by_idx ON research_documents (uploaded_by);
CREATE INDEX research_documents_tickers_idx ON research_documents USING GIN (tickers);
CREATE INDEX research_documents_document_type_idx ON research_documents (document_type);
CREATE INDEX research_documents_extraction_status_idx ON research_documents (extraction_status);
CREATE INDEX research_documents_search_idx ON research_documents USING GIN (search_vector);

-- ----------------------------------------------------------------------------

CREATE TABLE document_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES research_documents(id),
  created_by UUID NOT NULL REFERENCES users(id),
  page_number INTEGER NOT NULL,
  selected_text TEXT NOT NULL,
  annotation TEXT,
  highlight_position JSONB NOT NULL,
  linked_note_id UUID REFERENCES research_notes(id),
  linked_thesis_id UUID REFERENCES theses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX document_annotations_document_id_idx ON document_annotations (document_id);
CREATE INDEX document_annotations_created_by_idx ON document_annotations (created_by);
CREATE INDEX document_annotations_linked_note_id_idx ON document_annotations (linked_note_id);
CREATE INDEX document_annotations_linked_thesis_id_idx ON document_annotations (linked_thesis_id);

CREATE TRIGGER document_annotations_set_updated_at BEFORE UPDATE ON document_annotations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 11 — Watchlists
-- ============================================================================

CREATE TABLE watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  tickers TEXT[] NOT NULL DEFAULT '{}',
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_org_shared BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX watchlists_organisation_id_idx ON watchlists (organisation_id);
CREATE INDEX watchlists_created_by_idx ON watchlists (created_by);
CREATE INDEX watchlists_tickers_idx ON watchlists USING GIN (tickers);
CREATE INDEX watchlists_is_org_shared_idx ON watchlists (is_org_shared);

CREATE TRIGGER watchlists_set_updated_at BEFORE UPDATE ON watchlists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 13 — Market Data Cache
-- ============================================================================

-- price_cache (PARTITIONED BY RANGE on date, yearly)
CREATE TABLE price_cache (
  ticker TEXT NOT NULL,
  date DATE NOT NULL,
  open DECIMAL(20,8),
  high DECIMAL(20,8),
  low DECIMAL(20,8),
  close DECIMAL(20,8),
  adjusted_close DECIMAL(20,8),
  volume BIGINT,
  vwap DECIMAL(20,8),
  currency TEXT,
  source TEXT NOT NULL DEFAULT 'polygon',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker, date)
) PARTITION BY RANGE (date);

CREATE INDEX price_cache_ticker_idx ON price_cache (ticker);
CREATE INDEX price_cache_date_idx ON price_cache (date);

CREATE TABLE price_cache_2026 PARTITION OF price_cache
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE price_cache_default PARTITION OF price_cache DEFAULT;

-- ----------------------------------------------------------------------------

CREATE TABLE fundamentals_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('annual', 'quarterly', 'ttm')),
  period_label TEXT NOT NULL,
  period_end_date DATE NOT NULL,
  data JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'polygon',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX fundamentals_cache_ticker_period_key
  ON fundamentals_cache (ticker, period_type, period_label);
CREATE INDEX fundamentals_cache_ticker_idx ON fundamentals_cache (ticker);
CREATE INDEX fundamentals_cache_period_end_date_idx ON fundamentals_cache (period_end_date);

-- ----------------------------------------------------------------------------

CREATE TABLE security_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  isin TEXT,
  name TEXT,
  short_name TEXT,
  exchange TEXT,
  asset_class TEXT,
  currency TEXT,
  country TEXT,
  sector TEXT,
  industry TEXT,
  market_cap_category TEXT
    CHECK (market_cap_category IN ('large_cap', 'mid_cap', 'small_cap', 'micro_cap')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(short_name, '')), 'B')
  ) STORED,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX security_metadata_ticker_key ON security_metadata (ticker);
CREATE INDEX security_metadata_isin_idx ON security_metadata (isin);
CREATE INDEX security_metadata_name_idx ON security_metadata (name);
CREATE INDEX security_metadata_exchange_idx ON security_metadata (exchange);
CREATE INDEX security_metadata_sector_idx ON security_metadata (sector);
CREATE INDEX security_metadata_country_idx ON security_metadata (country);
CREATE INDEX security_metadata_search_idx ON security_metadata USING GIN (search_vector);

-- ----------------------------------------------------------------------------

CREATE TABLE news_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT,
  ai_summary TEXT,
  source TEXT,
  url TEXT,
  tickers TEXT[] NOT NULL DEFAULT '{}',
  sentiment TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral')),
  sentiment_score DECIMAL(5,4),
  published_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX news_cache_external_id_key ON news_cache (external_id);
CREATE INDEX news_cache_tickers_idx ON news_cache USING GIN (tickers);
CREATE INDEX news_cache_published_at_idx ON news_cache (published_at);
CREATE INDEX news_cache_sentiment_idx ON news_cache (sentiment);

-- ============================================================================
-- Section 14 — Risk and Alerts
-- ============================================================================

CREATE TABLE risk_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  portfolio_id UUID REFERENCES portfolios(id),
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN (
    'position_limit', 'sector_limit', 'factor_limit', 'var_limit',
    'drawdown_limit', 'correlation_limit', 'liquidity_limit', 'custom'
  )),
  config JSONB NOT NULL,
  warning_threshold_pct DECIMAL(5,2),
  is_org_level BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX risk_limits_organisation_id_idx ON risk_limits (organisation_id);
CREATE INDEX risk_limits_portfolio_id_idx ON risk_limits (portfolio_id);
CREATE INDEX risk_limits_type_idx ON risk_limits (type);
CREATE INDEX risk_limits_is_org_level_idx ON risk_limits (is_org_level);
CREATE INDEX risk_limits_active_idx ON risk_limits (id) WHERE is_active = TRUE;

CREATE TRIGGER risk_limits_set_updated_at BEFORE UPDATE ON risk_limits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- risk_snapshots (PARTITIONED BY RANGE on computed_at, monthly)
-- ----------------------------------------------------------------------------

CREATE TABLE risk_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  computed_at TIMESTAMPTZ NOT NULL,
  var_95 DECIMAL(10,6),
  var_99 DECIMAL(10,6),
  cvar_95 DECIMAL(10,6),
  current_drawdown DECIMAL(10,6),
  max_drawdown_30d DECIMAL(10,6),
  volatility_daily DECIMAL(10,6),
  volatility_annual DECIMAL(10,6),
  sharpe_ratio DECIMAL(10,4),
  factor_exposures JSONB,
  sector_concentrations JSONB,
  top_position_weight DECIMAL(10,6),
  liquidity_days DECIMAL(8,2),
  correlation_matrix JSONB,
  PRIMARY KEY (id, computed_at)
) PARTITION BY RANGE (computed_at);

CREATE INDEX risk_snapshots_portfolio_id_idx ON risk_snapshots (portfolio_id);
CREATE INDEX risk_snapshots_computed_at_idx ON risk_snapshots (computed_at);
CREATE INDEX risk_snapshots_portfolio_computed_idx ON risk_snapshots (portfolio_id, computed_at DESC);

CREATE TABLE risk_snapshots_2026_05 PARTITION OF risk_snapshots
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE risk_snapshots_default PARTITION OF risk_snapshots DEFAULT;

-- ----------------------------------------------------------------------------

CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  portfolio_id UUID REFERENCES portfolios(id),
  risk_limit_id UUID REFERENCES risk_limits(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'limit_warning', 'limit_breach', 'price_level', 'price_change', 'news',
    'factor_drift', 'drawdown', 'correlation_change', 'volatility_regime'
  )),
  config JSONB NOT NULL,
  channels TEXT[] NOT NULL DEFAULT ARRAY['in_app'],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_minutes INTEGER NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMPTZ,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX alerts_organisation_id_idx ON alerts (organisation_id);
CREATE INDEX alerts_created_by_idx ON alerts (created_by);
CREATE INDEX alerts_portfolio_id_idx ON alerts (portfolio_id);
CREATE INDEX alerts_type_idx ON alerts (type);
CREATE INDEX alerts_active_idx ON alerts (id) WHERE is_active = TRUE;

CREATE TRIGGER alerts_set_updated_at BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES alerts(id),
  user_id UUID NOT NULL REFERENCES users(id),
  triggered_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  message TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id),
  dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX alert_events_alert_id_idx ON alert_events (alert_id);
CREATE INDEX alert_events_user_id_idx ON alert_events (user_id);
CREATE INDEX alert_events_triggered_at_idx ON alert_events (triggered_at);
CREATE INDEX alert_events_unread_idx ON alert_events (user_id) WHERE acknowledged_at IS NULL;

-- ============================================================================
-- Section 15 — Compliance
-- ============================================================================

CREATE TABLE compliance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  portfolio_id UUID REFERENCES portfolios(id),
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN (
    'position_limit', 'sector_limit', 'asset_class_limit', 'factor_limit',
    'geographic_limit', 'correlation_limit', 'var_limit', 'drawdown_limit',
    'concentration_limit', 'liquidity_limit', 'custom_python'
  )),
  config JSONB NOT NULL,
  is_org_level BOOLEAN NOT NULL DEFAULT FALSE,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'major', 'minor')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX compliance_rules_organisation_id_idx ON compliance_rules (organisation_id);
CREATE INDEX compliance_rules_portfolio_id_idx ON compliance_rules (portfolio_id);
CREATE INDEX compliance_rules_type_idx ON compliance_rules (type);
CREATE INDEX compliance_rules_is_org_level_idx ON compliance_rules (is_org_level);
CREATE INDEX compliance_rules_active_idx ON compliance_rules (id) WHERE is_active = TRUE;

CREATE TRIGGER compliance_rules_set_updated_at BEFORE UPDATE ON compliance_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- compliance_checks (PARTITIONED BY RANGE on checked_at, monthly; append-only)
-- ----------------------------------------------------------------------------

CREATE TABLE compliance_checks (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  rule_id UUID NOT NULL REFERENCES compliance_rules(id),
  checked_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'warning', 'breach')),
  current_value JSONB,
  threshold_value JSONB,
  message TEXT,
  pct_of_limit DECIMAL(10,4),
  PRIMARY KEY (id, checked_at)
) PARTITION BY RANGE (checked_at);

CREATE INDEX compliance_checks_portfolio_rule_idx ON compliance_checks (portfolio_id, rule_id);
CREATE INDEX compliance_checks_portfolio_id_idx ON compliance_checks (portfolio_id);
CREATE INDEX compliance_checks_checked_at_idx ON compliance_checks (checked_at);
CREATE INDEX compliance_checks_status_idx ON compliance_checks (status);

CREATE TRIGGER compliance_checks_no_update BEFORE UPDATE ON compliance_checks
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
CREATE TRIGGER compliance_checks_no_delete BEFORE DELETE ON compliance_checks
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE TABLE compliance_checks_2026_05 PARTITION OF compliance_checks
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE compliance_checks_default PARTITION OF compliance_checks DEFAULT;

-- ============================================================================
-- Section 16 — Clients and Reporting
-- ============================================================================

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('individual', 'family_office', 'institution', 'trust', 'other')),
  email TEXT,
  phone TEXT,
  reporting_frequency TEXT NOT NULL DEFAULT 'quarterly'
    CHECK (reporting_frequency IN ('monthly', 'quarterly', 'annually', 'on_demand')),
  reporting_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  aum DECIMAL(20,2),
  inception_date DATE,
  relationship_manager UUID REFERENCES users(id),
  notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX clients_organisation_id_idx ON clients (organisation_id);
CREATE INDEX clients_portfolio_id_idx ON clients (portfolio_id);
CREATE INDEX clients_relationship_manager_idx ON clients (relationship_manager);
CREATE INDEX clients_reporting_frequency_idx ON clients (reporting_frequency);
CREATE INDEX clients_tags_idx ON clients USING GIN (tags);

CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE report_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  page_format TEXT NOT NULL DEFAULT 'A4' CHECK (page_format IN ('A4', 'Letter')),
  default_currency TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX report_templates_organisation_id_idx ON report_templates (organisation_id);
CREATE INDEX report_templates_created_by_idx ON report_templates (created_by);
CREATE UNIQUE INDEX report_templates_default_idx ON report_templates (organisation_id) WHERE is_default = TRUE;

CREATE TRIGGER report_templates_set_updated_at BEFORE UPDATE ON report_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE client_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  template_id UUID REFERENCES report_templates(id),
  created_by UUID NOT NULL REFERENCES users(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'sent')),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  commentary TEXT,
  pdf_url TEXT,
  docx_url TEXT,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  sent_to TEXT[],
  email_opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX client_reports_organisation_id_idx ON client_reports (organisation_id);
CREATE INDEX client_reports_client_id_idx ON client_reports (client_id);
CREATE INDEX client_reports_status_idx ON client_reports (status);
CREATE INDEX client_reports_period_end_idx ON client_reports (period_end);
CREATE INDEX client_reports_approved_by_idx ON client_reports (approved_by);

CREATE TRIGGER client_reports_set_updated_at BEFORE UPDATE ON client_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE client_communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  logged_by UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'report_sent', 'note')),
  subject TEXT,
  content TEXT,
  report_id UUID REFERENCES client_reports(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX client_communications_client_id_idx ON client_communications (client_id);
CREATE INDEX client_communications_occurred_at_idx ON client_communications (occurred_at);
CREATE INDEX client_communications_type_idx ON client_communications (type);

-- ============================================================================
-- Section 17 — Sharing and Permissions
-- ============================================================================

CREATE TABLE resource_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'command', 'dashboard', 'watchlist', 'thesis', 'note', 'portfolio', 'report_template'
  )),
  resource_id UUID NOT NULL,
  shared_by UUID NOT NULL REFERENCES users(id),
  shared_with_user UUID REFERENCES users(id),
  shared_with_org UUID REFERENCES organisations(id),
  permission TEXT NOT NULL CHECK (permission IN ('view', 'comment', 'edit')),
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  source_version INTEGER,
  message TEXT,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((shared_with_user IS NOT NULL) OR (shared_with_org IS NOT NULL))
);

CREATE INDEX resource_shares_resource_idx ON resource_shares (resource_type, resource_id);
CREATE INDEX resource_shares_shared_by_idx ON resource_shares (shared_by);
CREATE INDEX resource_shares_shared_with_user_idx ON resource_shares (shared_with_user);
CREATE INDEX resource_shares_shared_with_org_idx ON resource_shares (shared_with_org);
CREATE INDEX resource_shares_resource_type_idx ON resource_shares (resource_type);
CREATE INDEX resource_shares_pending_idx ON resource_shares (shared_with_user) WHERE accepted_at IS NULL;
CREATE INDEX resource_shares_active_idx ON resource_shares (id) WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------

CREATE TABLE share_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES users(id),
  share_id UUID NOT NULL REFERENCES resource_shares(id),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX share_notifications_recipient_id_idx ON share_notifications (recipient_id);
CREATE INDEX share_notifications_unread_idx ON share_notifications (recipient_id) WHERE read_at IS NULL;

-- ============================================================================
-- Section 18 — Certification and Ledger
-- ============================================================================

-- Created without the circular FKs first; they are added at end of file.

CREATE TABLE certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  level TEXT NOT NULL CHECK (level IN ('foundation', 'professional', 'advanced')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  hours_logged DECIMAL(8,2),
  exam_score DECIMAL(5,2),
  exam_date TIMESTAMPTZ,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  certificate_id TEXT NOT NULL,
  institution TEXT,
  ledger_entry_id UUID,  -- FK added at end (circular)
  verification_url TEXT
);

CREATE INDEX certifications_user_id_idx ON certifications (user_id);
CREATE UNIQUE INDEX certifications_certificate_id_key ON certifications (certificate_id);
CREATE INDEX certifications_level_idx ON certifications (level);
CREATE INDEX certifications_issued_at_idx ON certifications (issued_at);
CREATE INDEX certifications_institution_idx ON certifications (institution);

-- ----------------------------------------------------------------------------
-- certification_ledger — append-only, hash-chained, monotonic sequence
-- ----------------------------------------------------------------------------

CREATE TABLE certification_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence BIGINT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'certification_issued', 'hours_milestone',
    'exam_attempt', 'exam_passed', 'exam_failed'
  )),
  user_id UUID NOT NULL REFERENCES users(id),
  certification_id UUID,  -- FK added at end (circular)
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  actor_id UUID REFERENCES users(id),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rfc3161_token TEXT,
  prev_entry_hash TEXT,
  entry_hash TEXT NOT NULL,
  platform_signature TEXT NOT NULL
);

CREATE UNIQUE INDEX certification_ledger_sequence_key ON certification_ledger (sequence);
CREATE INDEX certification_ledger_user_id_idx ON certification_ledger (user_id);
CREATE INDEX certification_ledger_certification_id_idx ON certification_ledger (certification_id);
CREATE INDEX certification_ledger_entry_type_idx ON certification_ledger (entry_type);
CREATE INDEX certification_ledger_timestamp_idx ON certification_ledger (timestamp);

-- Chain integrity: sequence strictly +1, prev_entry_hash matches predecessor.
-- Concurrent inserts must be serialised at the application layer (advisory lock
-- or SERIALIZABLE) — the SELECT below cannot lock the absent next row.
CREATE OR REPLACE FUNCTION certification_ledger_check_chain() RETURNS TRIGGER AS $$
DECLARE
  prev_seq BIGINT;
  prev_hash TEXT;
BEGIN
  SELECT sequence, entry_hash INTO prev_seq, prev_hash
    FROM certification_ledger
    ORDER BY sequence DESC
    LIMIT 1
    FOR UPDATE;

  IF prev_seq IS NULL THEN
    IF NEW.sequence <> 1 THEN
      RAISE EXCEPTION 'first ledger entry must have sequence=1, got %', NEW.sequence;
    END IF;
    IF NEW.prev_entry_hash IS NOT NULL THEN
      RAISE EXCEPTION 'first ledger entry must have NULL prev_entry_hash';
    END IF;
  ELSE
    IF NEW.sequence <> prev_seq + 1 THEN
      RAISE EXCEPTION 'ledger sequence gap: expected %, got %', prev_seq + 1, NEW.sequence;
    END IF;
    IF NEW.prev_entry_hash IS DISTINCT FROM prev_hash THEN
      RAISE EXCEPTION 'ledger chain broken: prev_entry_hash does not match predecessor entry_hash';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER certification_ledger_chain
  BEFORE INSERT ON certification_ledger
  FOR EACH ROW EXECUTE FUNCTION certification_ledger_check_chain();

CREATE TRIGGER certification_ledger_no_update
  BEFORE UPDATE ON certification_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
CREATE TRIGGER certification_ledger_no_delete
  BEFORE DELETE ON certification_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

-- ============================================================================
-- Section 19 — Usage and Hours Tracking
-- ============================================================================

-- usage_sessions (PARTITIONED BY RANGE on started_at, monthly)
CREATE TABLE usage_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_minutes DECIMAL(8,2),
  activity_summary JSONB,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE INDEX usage_sessions_user_id_idx ON usage_sessions (user_id);
CREATE INDEX usage_sessions_started_at_idx ON usage_sessions (started_at);
CREATE INDEX usage_sessions_verified_idx ON usage_sessions (user_id) WHERE is_verified = TRUE;

CREATE TABLE usage_sessions_2026_05 PARTITION OF usage_sessions
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE usage_sessions_default PARTITION OF usage_sessions DEFAULT;

-- ----------------------------------------------------------------------------

CREATE TABLE certification_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  total_verified_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
  foundation_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  professional_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  advanced_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX certification_hours_user_id_key ON certification_hours (user_id);
CREATE INDEX certification_hours_foundation_idx ON certification_hours (user_id) WHERE foundation_eligible = TRUE;
CREATE INDEX certification_hours_professional_idx ON certification_hours (user_id) WHERE professional_eligible = TRUE;
CREATE INDEX certification_hours_advanced_idx ON certification_hours (user_id) WHERE advanced_eligible = TRUE;

CREATE TRIGGER certification_hours_set_updated_at BEFORE UPDATE ON certification_hours
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE exam_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  level TEXT NOT NULL CHECK (level IN ('foundation', 'professional', 'advanced')),
  attempt_number INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  score DECIMAL(5,2),
  pass_mark DECIMAL(5,2) NOT NULL,
  passed BOOLEAN,
  certification_id UUID REFERENCES certifications(id),
  ledger_entry_id UUID REFERENCES certification_ledger(id),
  payment_id TEXT,
  amount_paid DECIMAL(10,2),
  currency TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX exam_attempts_user_id_idx ON exam_attempts (user_id);
CREATE INDEX exam_attempts_level_idx ON exam_attempts (level);
CREATE INDEX exam_attempts_passed_idx ON exam_attempts (id) WHERE passed = TRUE;
CREATE INDEX exam_attempts_submitted_at_idx ON exam_attempts (submitted_at);
CREATE UNIQUE INDEX exam_attempts_user_level_attempt_key ON exam_attempts (user_id, level, attempt_number);

-- ============================================================================
-- Section 20 — Audit Log (PARTITIONED BY RANGE on created_at, monthly; append-only)
-- ============================================================================

CREATE TABLE audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organisation_id UUID REFERENCES organisations(id),
  user_id UUID REFERENCES users(id),
  session_id UUID,  -- soft reference; user_sessions may be cleaned up
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX audit_log_organisation_id_idx ON audit_log (organisation_id);
CREATE INDEX audit_log_user_id_idx ON audit_log (user_id);
CREATE INDEX audit_log_action_idx ON audit_log (action);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE TABLE audit_log_2026_05 PARTITION OF audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

-- ============================================================================
-- Section 21 — Billing
-- ============================================================================

CREATE TABLE billing_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  stripe_subscription_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'unpaid')),
  plan TEXT NOT NULL,
  seat_count INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  currency TEXT NOT NULL,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  trial_end TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX billing_subscriptions_organisation_id_key ON billing_subscriptions (organisation_id);
CREATE UNIQUE INDEX billing_subscriptions_stripe_subscription_id_key ON billing_subscriptions (stripe_subscription_id);
CREATE INDEX billing_subscriptions_status_idx ON billing_subscriptions (status);
CREATE INDEX billing_subscriptions_period_end_idx ON billing_subscriptions (current_period_end);

CREATE TRIGGER billing_subscriptions_set_updated_at BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE billing_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  stripe_invoice_id TEXT NOT NULL,
  subscription_id UUID REFERENCES billing_subscriptions(id),
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  invoice_url TEXT,
  pdf_url TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX billing_invoices_organisation_id_idx ON billing_invoices (organisation_id);
CREATE UNIQUE INDEX billing_invoices_stripe_invoice_id_key ON billing_invoices (stripe_invoice_id);
CREATE INDEX billing_invoices_subscription_id_idx ON billing_invoices (subscription_id);
CREATE INDEX billing_invoices_status_idx ON billing_invoices (status);
CREATE INDEX billing_invoices_paid_at_idx ON billing_invoices (paid_at);

-- ============================================================================
-- Section 22 — Marketplace
-- ============================================================================

CREATE TABLE marketplace_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL REFERENCES commands(id),
  published_by_org UUID NOT NULL REFERENCES organisations(id),
  published_by_user UUID NOT NULL REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN (
    'factor_analysis', 'risk', 'portfolio_construction',
    'macro', 'reporting', 'utility', 'other'
  )),
  name TEXT NOT NULL,
  description TEXT,
  short_description TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  screenshots TEXT[] NOT NULL DEFAULT '{}',
  is_free BOOLEAN NOT NULL DEFAULT TRUE,
  price DECIMAL(10,2),
  currency TEXT,
  install_count INTEGER NOT NULL DEFAULT 0,
  average_rating DECIMAL(3,2),
  rating_count INTEGER NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delisted_at TIMESTAMPTZ
);

CREATE INDEX marketplace_listings_published_by_org_idx ON marketplace_listings (published_by_org);
CREATE INDEX marketplace_listings_category_idx ON marketplace_listings (category);
CREATE INDEX marketplace_listings_tags_idx ON marketplace_listings USING GIN (tags);
CREATE INDEX marketplace_listings_is_free_idx ON marketplace_listings (is_free);
CREATE INDEX marketplace_listings_install_count_idx ON marketplace_listings (install_count DESC);
CREATE INDEX marketplace_listings_average_rating_idx ON marketplace_listings (average_rating DESC NULLS LAST);
CREATE INDEX marketplace_listings_published_at_idx ON marketplace_listings (published_at DESC);

CREATE TRIGGER marketplace_listings_set_updated_at BEFORE UPDATE ON marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE marketplace_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES marketplace_listings(id),
  installed_by_org UUID NOT NULL REFERENCES organisations(id),
  installed_by_user UUID NOT NULL REFERENCES users(id),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version_installed INTEGER NOT NULL,
  uninstalled_at TIMESTAMPTZ
);

CREATE INDEX marketplace_installs_listing_id_idx ON marketplace_installs (listing_id);
CREATE INDEX marketplace_installs_installed_by_org_idx ON marketplace_installs (installed_by_org);
CREATE INDEX marketplace_installs_active_idx ON marketplace_installs (id) WHERE uninstalled_at IS NULL;

-- ----------------------------------------------------------------------------

CREATE TABLE marketplace_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES marketplace_listings(id),
  rated_by_org UUID NOT NULL REFERENCES organisations(id),
  rated_by_user UUID NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX marketplace_ratings_listing_id_idx ON marketplace_ratings (listing_id);
CREATE UNIQUE INDEX marketplace_ratings_listing_org_key ON marketplace_ratings (listing_id, rated_by_org);

CREATE TRIGGER marketplace_ratings_set_updated_at BEFORE UPDATE ON marketplace_ratings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Section 23 — Admin
-- ============================================================================

CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  access_level TEXT NOT NULL CHECK (access_level IN ('read_only', 'support', 'full')),
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX admin_users_user_id_key ON admin_users (user_id);
CREATE INDEX admin_users_access_level_idx ON admin_users (access_level);

-- ----------------------------------------------------------------------------

CREATE TABLE feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  description TEXT,
  is_enabled_globally BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_for_orgs UUID[] NOT NULL DEFAULT '{}',
  rollout_percentage INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percentage BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX feature_flags_key_key ON feature_flags (key);
CREATE INDEX feature_flags_global_idx ON feature_flags (is_enabled_globally);

CREATE TRIGGER feature_flags_set_updated_at BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE system_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('info', 'warning', 'maintenance', 'new_feature')),
  target TEXT NOT NULL DEFAULT 'all' CHECK (target IN ('all', 'admins', 'specific_plans')),
  target_plans TEXT[],
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES admin_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX system_announcements_window_idx ON system_announcements (starts_at, ends_at);
CREATE INDEX system_announcements_type_idx ON system_announcements (type);

-- ============================================================================
-- Section 24 — Notifications (PARTITIONED BY RANGE on created_at, monthly)
-- ============================================================================

CREATE TABLE notifications (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'alert_triggered', 'share_received', 'share_accepted',
    'certification_eligible', 'certification_issued',
    'report_ready', 'command_updated', 'system'
  )),
  title TEXT NOT NULL,
  message TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_url TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX notifications_user_id_idx ON notifications (user_id);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, is_read);
CREATE INDEX notifications_type_idx ON notifications (type);
CREATE INDEX notifications_created_at_idx ON notifications (created_at);

CREATE TABLE notifications_2026_05 PARTITION OF notifications
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE notifications_default PARTITION OF notifications DEFAULT;

-- ============================================================================
-- Section 25 — Onboarding
-- ============================================================================

CREATE TABLE onboarding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  conducted_by UUID REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('in_person', 'remote')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled', 'rescheduled')),
  scheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  location TEXT,
  attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  commands_configured UUID[] NOT NULL DEFAULT '{}',
  feedback TEXT,
  follow_up_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  welcome_box_shipped BOOLEAN NOT NULL DEFAULT FALSE,
  welcome_box_shipped_at TIMESTAMPTZ,
  welcome_box_tracking TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX onboarding_sessions_organisation_id_idx ON onboarding_sessions (organisation_id);
CREATE INDEX onboarding_sessions_conducted_by_idx ON onboarding_sessions (conducted_by);
CREATE INDEX onboarding_sessions_status_idx ON onboarding_sessions (status);
CREATE INDEX onboarding_sessions_scheduled_at_idx ON onboarding_sessions (scheduled_at);
CREATE INDEX onboarding_sessions_pending_box_idx ON onboarding_sessions (id) WHERE welcome_box_shipped = FALSE;

CREATE TRIGGER onboarding_sessions_set_updated_at BEFORE UPDATE ON onboarding_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------

CREATE TABLE onboarding_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  item TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id)
);

CREATE INDEX onboarding_checklist_items_organisation_id_idx ON onboarding_checklist_items (organisation_id);
CREATE UNIQUE INDEX onboarding_checklist_items_org_item_key ON onboarding_checklist_items (organisation_id, item);
CREATE INDEX onboarding_checklist_items_pending_idx ON onboarding_checklist_items (id) WHERE completed = FALSE;

-- ============================================================================
-- Circular foreign keys (certifications ↔ certification_ledger)
-- ============================================================================

ALTER TABLE certifications
  ADD CONSTRAINT certifications_ledger_entry_id_fkey
  FOREIGN KEY (ledger_entry_id) REFERENCES certification_ledger(id);

ALTER TABLE certification_ledger
  ADD CONSTRAINT certification_ledger_certification_id_fkey
  FOREIGN KEY (certification_id) REFERENCES certifications(id);

-- ============================================================================
-- Partition management
-- ============================================================================

-- Idempotent: creates the current month + next 2 months for every monthly
-- partitioned table, and the next year for every yearly partitioned table.
-- Lookahead of 2 means one missed cron run does not silently route data into
-- the default partition (where partition pruning can no longer help).
-- Each new partition gets RLS enabled (with no child policies) — see the
-- "Block direct partition access" notes below.
CREATE OR REPLACE FUNCTION create_future_partitions() RETURNS void AS $$
DECLARE
  monthly_tables TEXT[] := ARRAY[
    'command_runs', 'audit_log', 'risk_snapshots', 'compliance_checks',
    'usage_sessions', 'notifications'
  ];
  yearly_tables TEXT[] := ARRAY['transactions', 'price_cache'];
  t TEXT;
  m DATE;
  suffix TEXT;
BEGIN
  FOREACH t IN ARRAY monthly_tables LOOP
    FOR i IN 0..2 LOOP
      m := date_trunc('month', NOW() + (i || ' months')::interval)::date;
      suffix := to_char(m, 'YYYY_MM');
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        t || '_' || suffix, t, m, (m + interval '1 month')::date
      );
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t || '_' || suffix);
    END LOOP;
  END LOOP;

  FOREACH t IN ARRAY yearly_tables LOOP
    m := date_trunc('year', NOW() + interval '1 year')::date;
    suffix := to_char(m, 'YYYY');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      t || '_' || suffix, t, m, (m + interval '1 year')::date
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t || '_' || suffix);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Seed data
-- ============================================================================
--
-- System CSV format templates for the most common brokers. is_system = TRUE,
-- organisation_id IS NULL — visible to every tenant via RLS policy.
-- Column names are best-guesses; validate against real export samples before
-- letting customers rely on them.
-- ============================================================================

INSERT INTO csv_format_templates (
  organisation_id, created_by, name, broker, import_type,
  description, is_system, column_mapping, type_mapping, skip_conditions, amount_config
) VALUES

(NULL, NULL,
 'Interactive Brokers — Trade Confirmations',
 'interactive_brokers', 'transactions',
 'For the ''Trades'' section of the IB Activity Statement CSV export. '
 'Reports → Activity → Statements → CSV. Filter to rows where the first '
 'column equals ''Trades''.',
 TRUE,
 '{
   "use_header_row": true,
   "header_row_index": 0,
   "fields": {
     "ticker":      {"column": "Symbol"},
     "executed_at": {"column": "Date/Time", "format": "YYYY-MM-DD HH:mm:ss"},
     "quantity":    {"column": "Quantity"},
     "price":       {"column": "T. Price"},
     "currency":    {"column": "Currency"},
     "fees":        {"column": "Comm/Fee", "absolute_value": true},
     "exchange":    {"column": "Exchange"},
     "type":        {"column": "Action"}
   }
 }'::jsonb,
 '{
   "BUY": "buy", "SELL": "sell", "DIV": "dividend", "DIVTAX": null,
   "JNLC": null, "JNLS": null,
   "BUY (OPEN)": "buy", "SELL (CLOSE)": "sell",
   "SELL (OPEN)": "sell", "BUY (CLOSE)": "buy"
 }'::jsonb,
 '[
   {"column": "Symbol", "value": ""},
   {"column": "Symbol", "value": "Symbol"},
   {"column": "Action", "value": null}
 ]'::jsonb,
 '{"decimal_separator": ".", "thousands_separator": ",",
   "parentheses_negative": true, "strip_currency_symbols": true}'::jsonb),

(NULL, NULL,
 'Interactive Brokers — Portfolio Positions',
 'interactive_brokers', 'positions',
 'For the ''Open Positions'' section of the IB Activity Statement CSV.',
 TRUE,
 '{
   "use_header_row": true,
   "header_row_index": 0,
   "fields": {
     "ticker":       {"column": "Symbol"},
     "quantity":     {"column": "Quantity"},
     "avg_cost":     {"column": "Cost Price"},
     "market_value": {"column": "Value"},
     "cost_basis":   {"column": "Cost Basis"},
     "currency":     {"column": "Currency"},
     "asset_class":  {"column": "Asset Class", "optional": true}
   }
 }'::jsonb,
 '{}'::jsonb,
 '[
   {"column": "Symbol", "value": ""},
   {"column": "Symbol", "value": "Symbol"}
 ]'::jsonb,
 '{"decimal_separator": ".", "thousands_separator": ",",
   "parentheses_negative": true, "strip_currency_symbols": true}'::jsonb),

(NULL, NULL,
 'Saxo Bank — Trade History',
 'saxo', 'transactions',
 'Saxo TraderGO: Account → History → Transactions → Export to CSV.',
 TRUE,
 '{
   "use_header_row": true,
   "header_row_index": 0,
   "fields": {
     "ticker":      {"column": "Instrument"},
     "executed_at": {"column": "Value Date", "format": "DD/MM/YYYY"},
     "quantity":    {"column": "Amount"},
     "price":       {"column": "Price"},
     "currency":    {"column": "Currency"},
     "fees":        {"column": "Brokerage", "absolute_value": true},
     "type":        {"column": "Transaction Type"}
   }
 }'::jsonb,
 '{
   "Buy": "buy", "Sell": "sell", "Dividend": "dividend",
   "Corporate Action": null, "Cash Transfer": null, "Interest": null
 }'::jsonb,
 '[{"column": "Instrument", "value": ""}]'::jsonb,
 '{"decimal_separator": ".", "thousands_separator": ",",
   "parentheses_negative": false, "strip_currency_symbols": false}'::jsonb),

(NULL, NULL,
 'Charles Schwab — Transaction History',
 'schwab', 'transactions',
 'Schwab.com: Accounts → History → Export → CSV. Schwab includes a '
 'multi-line preamble; skip_rows_before_header handles it.',
 TRUE,
 '{
   "use_header_row": true,
   "header_row_index": 0,
   "skip_rows_before_header": 2,
   "fields": {
     "ticker":      {"column": "Symbol"},
     "executed_at": {"column": "Date", "format": "MM/DD/YYYY"},
     "quantity":    {"column": "Quantity", "absolute_value": true},
     "price":       {"column": "Price", "strip_currency_symbol": true},
     "currency":    {"column": null, "default": "USD"},
     "fees":        {"column": "Fees & Comm", "strip_currency_symbol": true,
                     "absolute_value": true},
     "type":        {"column": "Action"}
   }
 }'::jsonb,
 '{
   "Buy": "buy", "Sell": "sell",
   "Buy to Open": "buy", "Sell to Close": "sell",
   "Sell to Open": "sell", "Buy to Close": "buy",
   "Reinvest Dividend": "dividend", "Cash Dividend": "dividend",
   "Wire Sent": null, "Wire Received": null, "Journal": null,
   "Margin Interest": "fee", "Service Fee": "fee"
 }'::jsonb,
 '[
   {"column": "Symbol", "value": ""},
   {"column": "Symbol", "value": null},
   {"column": "Action", "value": ""}
 ]'::jsonb,
 '{"decimal_separator": ".", "thousands_separator": ",",
   "parentheses_negative": false, "strip_currency_symbols": true}'::jsonb),

(NULL, NULL,
 'Generic — Custom Mapping',
 NULL, 'transactions',
 'Blank template for brokers not listed. User maps columns manually.',
 TRUE,
 '{
   "use_header_row": true,
   "header_row_index": 0,
   "fields": {
     "ticker":      {"column": null},
     "executed_at": {"column": null, "format": null},
     "quantity":    {"column": null},
     "price":       {"column": null},
     "currency":    {"column": null, "default": null},
     "fees":        {"column": null, "optional": true},
     "type":        {"column": null}
   }
 }'::jsonb,
 '{}'::jsonb,
 '[]'::jsonb,
 '{"decimal_separator": ".", "thousands_separator": ",",
   "parentheses_negative": false, "strip_currency_symbols": true}'::jsonb),

(NULL, NULL,
 'Generic — Position Snapshot',
 NULL, 'positions',
 'Blank template for position snapshot imports from any broker.',
 TRUE,
 '{
   "use_header_row": true,
   "header_row_index": 0,
   "fields": {
     "ticker":       {"column": null},
     "quantity":     {"column": null},
     "avg_cost":     {"column": null},
     "currency":     {"column": null, "default": null},
     "market_value": {"column": null, "optional": true},
     "cost_basis":   {"column": null, "optional": true}
   }
 }'::jsonb,
 '{}'::jsonb,
 '[]'::jsonb,
 '{"decimal_separator": ".", "thousands_separator": ",",
   "parentheses_negative": false, "strip_currency_symbols": true}'::jsonb);

-- ============================================================================
-- Row-Level Security
-- ============================================================================
--
-- Defence-in-depth tenant isolation. The application is expected to set
-- per-connection settings on every request:
--
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.current_org_id  = '<uuid>';
--   SET LOCAL app.is_admin        = 'true' | 'false';
--
-- The helpers below read those settings; policies use them to constrain
-- visibility to the current tenant.
--
-- Tables intentionally NOT covered here (privilege model only):
--   - permission_definitions, price_cache, fundamentals_cache,
--     security_metadata, news_cache  (public reference / market data)
--   - feature_flags, system_announcements, admin_users  (admin tables)
--
-- Policies use USING + WITH CHECK so writers cannot insert rows into other
-- tenants' scope. Platform admins (is_admin=true) bypass all policies.

CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_org_id() RETURNS UUID
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION is_platform_admin() RETURNS BOOLEAN
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
$$;

-- ----------------------------------------------------------------------------
-- Identity
-- ----------------------------------------------------------------------------

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visibility ON users
  USING (
    id = current_user_id()
    OR id IN (
      SELECT user_id FROM organisation_members
      WHERE organisation_id = current_org_id()
    )
    OR is_platform_admin()
  )
  WITH CHECK (id = current_user_id() OR is_platform_admin());

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_owner ON user_sessions
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Organisations & roles
-- ----------------------------------------------------------------------------

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organisations_member ON organisations
  USING (id = current_org_id() OR is_platform_admin())
  WITH CHECK (id = current_org_id() OR is_platform_admin());

ALTER TABLE organisation_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY organisation_members_tenant ON organisation_members
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE organisation_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organisation_invitations_tenant ON organisation_invitations
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- Roles: org-scoped roles + system roles (organisation_id IS NULL) visible to all.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_visibility ON roles
  USING (organisation_id = current_org_id() OR organisation_id IS NULL OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Strategies, portfolios, positions, transactions
-- ----------------------------------------------------------------------------

ALTER TABLE strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY strategies_tenant ON strategies
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
CREATE POLICY portfolios_tenant ON portfolios
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY positions_tenant ON positions
  USING (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  )
  WITH CHECK (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  );

ALTER TABLE transaction_import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY transaction_import_batches_tenant ON transaction_import_batches
  USING (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  )
  WITH CHECK (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  );

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_tenant ON transactions
  USING (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  )
  WITH CHECK (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  );

-- ----------------------------------------------------------------------------
-- CSV / position imports
-- (csv_format_templates: org-scoped + system rows visible to all, like commands/roles)
-- ----------------------------------------------------------------------------

ALTER TABLE csv_format_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY csv_format_templates_visibility ON csv_format_templates
  USING (organisation_id = current_org_id() OR organisation_id IS NULL OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE csv_import_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY csv_import_rows_tenant ON csv_import_rows
  USING (
    import_batch_id IN (SELECT id FROM transaction_import_batches)
    OR is_platform_admin()
  )
  WITH CHECK (
    import_batch_id IN (SELECT id FROM transaction_import_batches)
    OR is_platform_admin()
  );

ALTER TABLE position_import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY position_import_batches_tenant ON position_import_batches
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE position_import_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY position_import_rows_tenant ON position_import_rows
  USING (
    import_batch_id IN (SELECT id FROM position_import_batches)
    OR is_platform_admin()
  )
  WITH CHECK (
    import_batch_id IN (SELECT id FROM position_import_batches)
    OR is_platform_admin()
  );

-- ----------------------------------------------------------------------------
-- Commands & runs
-- ----------------------------------------------------------------------------

-- Built-in commands (organisation_id IS NULL) are visible to all tenants.
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY commands_visibility ON commands
  USING (organisation_id = current_org_id() OR organisation_id IS NULL OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE command_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY command_versions_tenant ON command_versions
  USING (
    command_id IN (SELECT id FROM commands)
    OR is_platform_admin()
  )
  WITH CHECK (
    command_id IN (SELECT id FROM commands)
    OR is_platform_admin()
  );

ALTER TABLE command_parameters ENABLE ROW LEVEL SECURITY;
CREATE POLICY command_parameters_tenant ON command_parameters
  USING (
    command_id IN (SELECT id FROM commands)
    OR is_platform_admin()
  )
  WITH CHECK (
    command_id IN (SELECT id FROM commands)
    OR is_platform_admin()
  );

ALTER TABLE command_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY command_runs_tenant ON command_runs
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Research
-- ----------------------------------------------------------------------------

ALTER TABLE theses ENABLE ROW LEVEL SECURITY;
CREATE POLICY theses_tenant ON theses
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE thesis_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY thesis_versions_tenant ON thesis_versions
  USING (
    thesis_id IN (SELECT id FROM theses)
    OR is_platform_admin()
  )
  WITH CHECK (
    thesis_id IN (SELECT id FROM theses)
    OR is_platform_admin()
  );

ALTER TABLE thesis_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY thesis_comments_tenant ON thesis_comments
  USING (
    thesis_id IN (SELECT id FROM theses)
    OR is_platform_admin()
  )
  WITH CHECK (
    thesis_id IN (SELECT id FROM theses)
    OR is_platform_admin()
  );

ALTER TABLE research_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_notes_tenant ON research_notes
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE research_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_documents_tenant ON research_documents
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE document_annotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_annotations_tenant ON document_annotations
  USING (
    document_id IN (SELECT id FROM research_documents)
    OR is_platform_admin()
  )
  WITH CHECK (
    document_id IN (SELECT id FROM research_documents)
    OR is_platform_admin()
  );

-- ----------------------------------------------------------------------------
-- Watchlists, dashboards, layouts
-- ----------------------------------------------------------------------------

ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;
CREATE POLICY watchlists_tenant ON watchlists
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
CREATE POLICY dashboards_tenant ON dashboards
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY dashboard_widgets_tenant ON dashboard_widgets
  USING (
    dashboard_id IN (SELECT id FROM dashboards)
    OR is_platform_admin()
  )
  WITH CHECK (
    dashboard_id IN (SELECT id FROM dashboards)
    OR is_platform_admin()
  );

ALTER TABLE workspace_layouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_layouts_owner ON workspace_layouts
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Risk, alerts, compliance
-- ----------------------------------------------------------------------------

ALTER TABLE risk_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_limits_tenant ON risk_limits
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE risk_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_snapshots_tenant ON risk_snapshots
  USING (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  )
  WITH CHECK (
    portfolio_id IN (SELECT id FROM portfolios)
    OR is_platform_admin()
  );

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_tenant ON alerts
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE alert_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_events_recipient ON alert_events
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

ALTER TABLE compliance_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY compliance_rules_tenant ON compliance_rules
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE compliance_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY compliance_checks_tenant ON compliance_checks
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Clients & reporting
-- ----------------------------------------------------------------------------

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant ON clients
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE report_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_templates_tenant ON report_templates
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE client_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_reports_tenant ON client_reports
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE client_communications ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_communications_tenant ON client_communications
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Sharing
-- ----------------------------------------------------------------------------

-- Visible to: sharer, sharee user, or any member of sharee org.
ALTER TABLE resource_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY resource_shares_visibility ON resource_shares
  USING (
    shared_by = current_user_id()
    OR shared_with_user = current_user_id()
    OR shared_with_org = current_org_id()
    OR is_platform_admin()
  )
  WITH CHECK (
    shared_by = current_user_id() OR is_platform_admin()
  );

ALTER TABLE share_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY share_notifications_recipient ON share_notifications
  USING (recipient_id = current_user_id() OR is_platform_admin())
  WITH CHECK (recipient_id = current_user_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Certifications & exams (user-scoped)
-- ----------------------------------------------------------------------------

ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY certifications_owner ON certifications
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

ALTER TABLE certification_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY certification_ledger_owner ON certification_ledger
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

ALTER TABLE certification_hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY certification_hours_owner ON certification_hours
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

ALTER TABLE exam_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY exam_attempts_owner ON exam_attempts
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

ALTER TABLE usage_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_sessions_owner ON usage_sessions
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Audit log (org-scoped; platform-level rows have organisation_id IS NULL,
-- visible only to admins)
-- ----------------------------------------------------------------------------

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant ON audit_log
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Billing
-- ----------------------------------------------------------------------------

ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_subscriptions_tenant ON billing_subscriptions
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_invoices_tenant ON billing_invoices
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Marketplace (listings are public-read; installs/ratings are tenant-scoped)
-- ----------------------------------------------------------------------------

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY marketplace_listings_read ON marketplace_listings
  FOR SELECT USING (true);
CREATE POLICY marketplace_listings_write ON marketplace_listings
  FOR ALL TO PUBLIC
  USING (published_by_org = current_org_id() OR is_platform_admin())
  WITH CHECK (published_by_org = current_org_id() OR is_platform_admin());

ALTER TABLE marketplace_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY marketplace_installs_tenant ON marketplace_installs
  USING (installed_by_org = current_org_id() OR is_platform_admin())
  WITH CHECK (installed_by_org = current_org_id() OR is_platform_admin());

ALTER TABLE marketplace_ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY marketplace_ratings_visibility ON marketplace_ratings
  USING (true)  -- ratings are public-read
  WITH CHECK (rated_by_org = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Onboarding
-- ----------------------------------------------------------------------------

ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY onboarding_sessions_tenant ON onboarding_sessions
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

ALTER TABLE onboarding_checklist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY onboarding_checklist_items_tenant ON onboarding_checklist_items
  USING (organisation_id = current_org_id() OR is_platform_admin())
  WITH CHECK (organisation_id = current_org_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Notifications (user-scoped)
-- ----------------------------------------------------------------------------

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_owner ON notifications
  USING (user_id = current_user_id() OR is_platform_admin())
  WITH CHECK (user_id = current_user_id() OR is_platform_admin());

-- ----------------------------------------------------------------------------
-- Block direct partition access. Parent RLS does not propagate to child
-- partitions, so a query against e.g. `audit_log_2026_05` directly would
-- bypass the parent's policy. Enabling RLS on each partition (with no child
-- policies) makes direct access deny-by-default while parent-routed queries
-- continue to evaluate the parent's policies normally.
--
-- New partitions created by create_future_partitions() get the same treatment
-- automatically.
-- ----------------------------------------------------------------------------

ALTER TABLE transactions_2026          ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions_default       ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_runs_2026_05       ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_runs_default       ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_snapshots_2026_05     ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_snapshots_default     ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_checks_2026_05  ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_checks_default  ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_sessions_2026_05     ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_sessions_default     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_2026_05          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_default          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_2026_05      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_default      ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Pre-seed future partitions and schedule recurring creation
-- ============================================================================
--
-- The schema only declares one initial partition per table inline (current
-- month / current year). This call extends that to current month + next 2
-- (monthly) and next year (yearly) so a missed cron run doesn't dump data
-- into the default partition. Idempotent — safe to re-run.

SELECT create_future_partitions();

-- Schedule monthly via pg_cron if the extension is installed. If not, call
-- create_future_partitions() from your deployment pipeline / external cron.
-- '5 0 1 * *' = 00:05 on the 1st of each month.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'sable-create-future-partitions',
      '5 0 1 * *',
      'SELECT create_future_partitions()'
    );
  END IF;
END;
$$;
