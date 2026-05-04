-- =============================================================================
-- INCORPORATED INTO schema.sql — KEPT AS HISTORICAL RECORD ONLY.
-- Do NOT run this on a fresh install (it will conflict with schema.sql).
-- Only useful if you need to apply just these changes to a database that
-- was bootstrapped from an earlier schema.sql snapshot.
-- =============================================================================

-- =============================================================================
-- Sable Terminal — Migration 002
-- CSV Import Support
--
-- Adds the missing infrastructure for a proper CSV import flow:
--   1. csv_format_templates    — pre-built broker format definitions
--   2. transaction_import_batches extensions — preview/confirm fields
--   3. csv_import_rows         — staging layer for preview before commit
--   4. position_import_batches — snapshot imports (current positions)
--   5. position_import_rows    — staging rows for position snapshot imports
--   6. transactions.source     — extend CHECK to allow 'position_import'
--   7. Seeded system templates — IB, Saxo, Schwab, generic
--   8. RLS policies            — match the schema.sql tenant isolation pattern
--
-- Depends on: schema.sql (for set_updated_at, current_org_id, etc.)
--
-- Reverts to filename for both batch tables (the ALTER's `raw_file_name`
-- column duplicated the existing `filename` — kept the original convention).
-- =============================================================================

SET client_min_messages = warning;
SET search_path = public;

-- =============================================================================
-- 1. csv_format_templates
-- =============================================================================

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

CREATE TRIGGER csv_format_templates_set_updated_at
  BEFORE UPDATE ON csv_format_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 2. transaction_import_batches extensions
-- =============================================================================

ALTER TABLE transaction_import_batches
  ADD COLUMN IF NOT EXISTS format_template_id UUID REFERENCES csv_format_templates(id),
  ADD COLUMN IF NOT EXISTS column_mapping JSONB,
  ADD COLUMN IF NOT EXISTS type_mapping JSONB,
  ADD COLUMN IF NOT EXISTS raw_file_url TEXT,
  ADD COLUMN IF NOT EXISTS raw_file_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS preview_row_count INTEGER,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS date_range_start DATE,
  ADD COLUMN IF NOT EXISTS date_range_end DATE,
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS import_notes TEXT;

CREATE INDEX transaction_import_batches_format_template_id_idx
  ON transaction_import_batches (format_template_id)
  WHERE format_template_id IS NOT NULL;

CREATE INDEX transaction_import_batches_unconfirmed_idx
  ON transaction_import_batches (created_at)
  WHERE confirmed_at IS NULL;

-- =============================================================================
-- 3. csv_import_rows
-- =============================================================================

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
  -- duplicate_of_transaction_id and resulting_transaction_id are soft references:
  -- transactions is partitioned with composite PK (id, executed_at), so a
  -- single-column FK is not possible.
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

CREATE TRIGGER csv_import_rows_set_updated_at
  BEFORE UPDATE ON csv_import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 4. position_import_batches
-- =============================================================================

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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'previewing', 'confirmed', 'completed', 'failed', 'cancelled'
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

CREATE TRIGGER position_import_batches_set_updated_at
  BEFORE UPDATE ON position_import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 5. position_import_rows
-- =============================================================================

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

CREATE TRIGGER position_import_rows_set_updated_at
  BEFORE UPDATE ON position_import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 6. transactions.source CHECK constraint update
-- =============================================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('manual', 'csv_import', 'position_import', 'correction'));

-- =============================================================================
-- 7. Seed system CSV format templates
--
-- Column names are best-guesses based on known broker formats and need
-- validation against real export samples before going live. Mark as verified
-- in metadata once tested.
-- =============================================================================

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

-- =============================================================================
-- 8. Row-Level Security on the new tables
--
-- Matches the patterns established in schema.sql:
--   - csv_format_templates: org-scoped + system rows (org_id IS NULL) visible
--     to all (same pattern as commands/roles).
--   - csv_import_rows / position_import_rows: scoped through their parent
--     batch table — RLS on the parent already constrains visible batches.
--   - position_import_batches: org-scoped directly via organisation_id.
-- =============================================================================

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
