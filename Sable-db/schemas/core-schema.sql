-- sable-core — Core database schema
-- Source: Documentation/Sable-core/sable_core_features.md + sable_workspace_features.md
--
-- Conventions match gateway-schema.sql:
--   - Helpers (enc, dec, sha256, app_user_id, app_org_id, app_actor, app_role,
--     app_is_admin, app_is_super_admin, app_is_owner_or_admin, set_updated_at)
--     live in `public` (created by gateway-schema.sql). Apply gateway first.
--   - 🔐 columns: BYTEA, written via enc(plaintext).
--   - #️⃣ columns: BYTEA, written via sha256(input).
--   - RLS keyed off app.user_id / app.org_id / app.role / app.actor session vars.
--
-- Cross-schema FKs to `gateway.users(id)` and `gateway.organisations(id)` —
-- requires gateway-schema.sql applied first. ON DELETE behaviour skews to
-- RESTRICT (audit/financial parity) or SET NULL (preserves history when an
-- identity record disappears).
--
-- Holdings tables (sc.holdings, re.holdings, crypto.holdings, alt.holdings)
-- live in their own module schemas; core only stores portfolio metadata and
-- references holdings by portfolio_id.

------------------------------------------------------------------------------
-- 0. Extensions + Schema
------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram search on clients.name

CREATE SCHEMA IF NOT EXISTS core;
SET search_path = core, public;

------------------------------------------------------------------------------
-- 1. clients  — firm's CRM-side client records
------------------------------------------------------------------------------

CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES gateway.organisations(id) ON DELETE RESTRICT,
  name        text NOT NULL,                                                -- searchable, plain
  reference   text,                                                         -- firm's internal client ref
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clients_org_id_idx ON clients (org_id);
CREATE INDEX clients_name_trgm_idx ON clients USING gin (name gin_trgm_ops);   -- trigram search

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY clients_select ON clients FOR SELECT
  USING (org_id = app_org_id() OR app_is_admin());
CREATE POLICY clients_write ON clients FOR ALL
  USING (org_id = app_org_id())
  WITH CHECK (org_id = app_org_id());

------------------------------------------------------------------------------
-- 2. portfolios  — metadata only; holdings live in module schemas
------------------------------------------------------------------------------

CREATE TABLE portfolios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  type        text CHECK (type IN ('equity', 'property', 'crypto', 'alt', 'mixed')),
  currency    text NOT NULL DEFAULT 'GBP',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX portfolios_client_id_idx ON portfolios (client_id);
CREATE INDEX portfolios_type_idx ON portfolios (type);

CREATE TRIGGER portfolios_updated_at BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
-- Visible to anyone in the client's org. Joins client → org_id for the check.
CREATE POLICY portfolios_select ON portfolios FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM clients c WHERE c.id = client_id AND c.org_id = app_org_id())
    OR app_is_admin()
  );
CREATE POLICY portfolios_write ON portfolios FOR ALL
  USING (EXISTS (SELECT 1 FROM clients c WHERE c.id = client_id AND c.org_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM clients c WHERE c.id = client_id AND c.org_id = app_org_id()));

------------------------------------------------------------------------------
-- 3. user_integrations  — third-party API creds (IBKR, broker direct connect)
------------------------------------------------------------------------------

CREATE TABLE user_integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('ibkr', 'schwab', 'fidelity_api', 'coinbase', 'kraken', 'binance')),
  credentials     bytea NOT NULL,                                           -- 🔐 KMS-encrypted JSON blob
  scopes          text[] NOT NULL DEFAULT '{}',
  last_synced_at  timestamptz,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX user_integrations_user_id_idx ON user_integrations (user_id);
CREATE INDEX user_integrations_status_idx ON user_integrations (status);

CREATE TRIGGER user_integrations_updated_at BEFORE UPDATE ON user_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_integrations_select ON user_integrations FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY user_integrations_write ON user_integrations FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 4. broker_mappings  — CSV column maps for known + custom brokers
------------------------------------------------------------------------------

CREATE TABLE broker_mappings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid REFERENCES gateway.organisations(id) ON DELETE CASCADE,  -- null when global
  is_global        boolean NOT NULL DEFAULT false,
  broker_name      text NOT NULL,
  detect_columns   text[] NOT NULL,
  column_map       jsonb NOT NULL,
  created_by       uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (is_global = (org_id IS NULL))                                      -- global ⇔ no org
);

CREATE INDEX broker_mappings_org_id_idx ON broker_mappings (org_id);
CREATE INDEX broker_mappings_global_idx ON broker_mappings (is_global) WHERE is_global;

CREATE TRIGGER broker_mappings_updated_at BEFORE UPDATE ON broker_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE broker_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY broker_mappings_select ON broker_mappings FOR SELECT
  USING (is_global OR org_id = app_org_id() OR app_is_admin());
CREATE POLICY broker_mappings_write ON broker_mappings FOR ALL
  USING (NOT is_global AND org_id = app_org_id())
  WITH CHECK (NOT is_global AND org_id = app_org_id());
-- Global mappings: admin-only via app_is_admin route (insert/update by support, not org users).
CREATE POLICY broker_mappings_admin_global ON broker_mappings FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

------------------------------------------------------------------------------
-- 5. workspace_pages
------------------------------------------------------------------------------

CREATE TABLE workspace_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  icon         text,
  position     integer NOT NULL DEFAULT 0,
  layout_mode  text NOT NULL DEFAULT 'grid' CHECK (layout_mode IN ('canvas', 'grid')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_pages_user_id_idx ON workspace_pages (user_id);

CREATE TRIGGER workspace_pages_updated_at BEFORE UPDATE ON workspace_pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_pages_select ON workspace_pages FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY workspace_pages_write ON workspace_pages FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 6. workspace_widgets
------------------------------------------------------------------------------

CREATE TABLE workspace_widgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         uuid NOT NULL REFERENCES workspace_pages(id) ON DELETE CASCADE,
  widget_type     text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  view_config     jsonb NOT NULL DEFAULT '{}'::jsonb,                       -- filters/sort/group-by for view widgets
  -- canvas mode
  x               double precision,
  y               double precision,
  width           double precision,
  height          double precision,
  -- grid mode
  col_start       integer,
  col_span        integer,
  row_start       integer,
  row_span        integer,
  is_locked       boolean NOT NULL DEFAULT false,
  position        integer NOT NULL DEFAULT 0,
  linked_widget_id uuid REFERENCES workspace_widgets(id) ON DELETE SET NULL,
  link_type       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_widgets_page_id_idx ON workspace_widgets (page_id);
CREATE INDEX workspace_widgets_type_idx ON workspace_widgets (widget_type);

CREATE TRIGGER workspace_widgets_updated_at BEFORE UPDATE ON workspace_widgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_widgets ENABLE ROW LEVEL SECURITY;
-- A widget belongs to a page belongs to a user; check via page.
CREATE POLICY workspace_widgets_select ON workspace_widgets FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM workspace_pages p WHERE p.id = page_id AND p.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY workspace_widgets_write ON workspace_widgets FOR ALL
  USING (EXISTS (SELECT 1 FROM workspace_pages p WHERE p.id = page_id AND p.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspace_pages p WHERE p.id = page_id AND p.user_id = app_user_id()));

------------------------------------------------------------------------------
-- 7. workspace_notes
------------------------------------------------------------------------------

CREATE TABLE workspace_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  page_id            uuid REFERENCES workspace_pages(id) ON DELETE SET NULL,
  content            jsonb NOT NULL DEFAULT '{}'::jsonb,                    -- Quill Delta
  content_search     tsvector,                                              -- maintained by trigger
  linked_asset_id    text,
  linked_asset_type  text CHECK (linked_asset_type IN ('ticker', 'property', 'holding', 'client', 'portfolio')),
  tags               text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_notes_user_id_idx ON workspace_notes (user_id);
CREATE INDEX workspace_notes_page_id_idx ON workspace_notes (page_id);
CREATE INDEX workspace_notes_linked_idx ON workspace_notes (linked_asset_type, linked_asset_id);
CREATE INDEX workspace_notes_tags_idx ON workspace_notes USING gin (tags);
CREATE INDEX workspace_notes_search_idx ON workspace_notes USING gin (content_search);

-- Maintain content_search tsvector from Quill Delta JSONB.
-- Quill stores text in `ops[*].insert` strings; jsonb_path_query_array extracts them.
CREATE OR REPLACE FUNCTION workspace_notes_search_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_search := to_tsvector(
    'simple',
    coalesce(
      (SELECT string_agg(value::text, ' ')
       FROM jsonb_path_query(NEW.content, '$.ops[*].insert ? (@.type() == "string")') AS value),
      ''
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_notes_search_refresh
  BEFORE INSERT OR UPDATE OF content ON workspace_notes
  FOR EACH ROW EXECUTE FUNCTION workspace_notes_search_refresh();

CREATE TRIGGER workspace_notes_updated_at BEFORE UPDATE ON workspace_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_notes ENABLE ROW LEVEL SECURITY;
-- Owner sees their own; others access via note_access (defined below).
CREATE POLICY workspace_notes_select ON workspace_notes FOR SELECT
  USING (
    user_id = app_user_id()
    OR EXISTS (SELECT 1 FROM note_access na WHERE na.note_id = id AND na.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY workspace_notes_write ON workspace_notes FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 8. note_access  — collaboration grants for workspace_notes
------------------------------------------------------------------------------

CREATE TABLE note_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id     uuid NOT NULL REFERENCES workspace_notes(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission IN ('view', 'comment', 'edit')),
  granted_by  uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, user_id)
);

CREATE INDEX note_access_user_id_idx ON note_access (user_id);

ALTER TABLE note_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY note_access_select ON note_access FOR SELECT
  USING (
    user_id = app_user_id()
    OR EXISTS (SELECT 1 FROM workspace_notes n WHERE n.id = note_id AND n.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY note_access_write ON note_access FOR ALL
  USING (EXISTS (SELECT 1 FROM workspace_notes n WHERE n.id = note_id AND n.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspace_notes n WHERE n.id = note_id AND n.user_id = app_user_id()));

------------------------------------------------------------------------------
-- 9. workspace_scripts
------------------------------------------------------------------------------

CREATE TABLE workspace_scripts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  code            text NOT NULL,
  default_target  text,
  language        text NOT NULL DEFAULT 'python' CHECK (language IN ('python')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_scripts_user_id_idx ON workspace_scripts (user_id);

CREATE TRIGGER workspace_scripts_updated_at BEFORE UPDATE ON workspace_scripts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_scripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_scripts_select ON workspace_scripts FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY workspace_scripts_write ON workspace_scripts FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 10. workspace_events  — calendar entries (user-created earnings/review/etc.)
------------------------------------------------------------------------------

CREATE TABLE workspace_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  notes        text,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz,
  event_type   text NOT NULL DEFAULT 'user'
               CHECK (event_type IN ('user', 'earnings', 'economic', 'review')),
  linked_asset_id    text,
  linked_asset_type  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_events_user_starts_at_idx ON workspace_events (user_id, starts_at);

CREATE TRIGGER workspace_events_updated_at BEFORE UPDATE ON workspace_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_events_select ON workspace_events FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY workspace_events_write ON workspace_events FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 11. command_history  (PARTITIONED BY RANGE (executed_at) — monthly)
------------------------------------------------------------------------------

CREATE TABLE command_history (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  command        text NOT NULL,
  target         text,
  duration_ms    integer,
  status         text CHECK (status IN ('success', 'error', 'cancelled')),
  error_message  text,
  executed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, executed_at)
) PARTITION BY RANGE (executed_at);

CREATE INDEX command_history_user_id_idx ON command_history (user_id);
CREATE INDEX command_history_executed_at_idx ON command_history (executed_at);

CREATE TABLE command_history_2026_05 PARTITION OF command_history
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- pg_cron job: monthly, create command_history_YYYY_MM ahead of time.

ALTER TABLE command_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY command_history_select ON command_history FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY command_history_insert ON command_history FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_actor() IN ('gateway', 'system'));

------------------------------------------------------------------------------
-- 12. pipelines
------------------------------------------------------------------------------

CREATE TABLE pipelines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  description     text,
  graph           jsonb NOT NULL,                                           -- nodes + edges + per-block config
  trigger_type    text NOT NULL DEFAULT 'manual'
                  CHECK (trigger_type IN ('manual', 'scheduled', 'event')),
  trigger_config  jsonb NOT NULL DEFAULT '{}'::jsonb,                       -- { cron: '...' } or { topic: '...' }
  is_shared       boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pipelines_user_id_idx ON pipelines (user_id);
CREATE INDEX pipelines_trigger_type_idx ON pipelines (trigger_type) WHERE is_active;
CREATE INDEX pipelines_is_shared_idx ON pipelines (is_shared) WHERE is_shared;

CREATE TRIGGER pipelines_updated_at BEFORE UPDATE ON pipelines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipelines_select ON pipelines FOR SELECT
  USING (
    user_id = app_user_id()
    OR EXISTS (
      SELECT 1 FROM pipeline_shares ps
      WHERE ps.pipeline_id = id
        AND (ps.shared_with_user_id = app_user_id() OR ps.shared_with_org_id = app_org_id())
    )
    OR app_is_admin()
  );
CREATE POLICY pipelines_write ON pipelines FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 13. pipeline_versions  — snapshot on every save
------------------------------------------------------------------------------

CREATE TABLE pipeline_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id  uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  graph        jsonb NOT NULL,
  saved_by     uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, version)
);

CREATE INDEX pipeline_versions_pipeline_idx ON pipeline_versions (pipeline_id);

ALTER TABLE pipeline_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_versions_select ON pipeline_versions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY pipeline_versions_insert ON pipeline_versions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id()));

------------------------------------------------------------------------------
-- 14. pipeline_shares
------------------------------------------------------------------------------

CREATE TABLE pipeline_shares (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id           uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  shared_with_user_id   uuid REFERENCES gateway.users(id) ON DELETE CASCADE,
  shared_with_org_id    uuid REFERENCES gateway.organisations(id) ON DELETE CASCADE,
  permission            text NOT NULL DEFAULT 'view'
                        CHECK (permission IN ('view', 'clone', 'edit')),
  shared_by             uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((shared_with_user_id IS NOT NULL) <> (shared_with_org_id IS NOT NULL))   -- xor
);

CREATE INDEX pipeline_shares_pipeline_idx ON pipeline_shares (pipeline_id);
CREATE INDEX pipeline_shares_user_idx ON pipeline_shares (shared_with_user_id);
CREATE INDEX pipeline_shares_org_idx ON pipeline_shares (shared_with_org_id);

ALTER TABLE pipeline_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_shares_select ON pipeline_shares FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id())
    OR shared_with_user_id = app_user_id()
    OR shared_with_org_id = app_org_id()
    OR app_is_admin()
  );
CREATE POLICY pipeline_shares_write ON pipeline_shares FOR ALL
  USING (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id()));

------------------------------------------------------------------------------
-- 15. alerts
------------------------------------------------------------------------------

CREATE TABLE alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  alert_type     text NOT NULL CHECK (alert_type IN ('price', 'portfolio', 'news', 'custom')),
  condition      jsonb NOT NULL,
  delivery       text[] NOT NULL DEFAULT ARRAY['in_app']::text[],
  is_active      boolean NOT NULL DEFAULT true,
  triggered_at   timestamptz,
  trigger_count  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_user_id_idx ON alerts (user_id);
CREATE INDEX alerts_active_idx ON alerts (is_active) WHERE is_active;
CREATE INDEX alerts_type_idx ON alerts (alert_type);

CREATE TRIGGER alerts_updated_at BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_select ON alerts FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY alerts_write ON alerts FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 16. share_tokens  — read-only client dashboard links
------------------------------------------------------------------------------

CREATE TABLE share_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,                                      -- #️⃣ raw token only in URL
  page_id       uuid NOT NULL REFERENCES workspace_pages(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  is_read_only  boolean NOT NULL DEFAULT true,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_accessed_at  timestamptz,
  access_count  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX share_tokens_page_id_idx ON share_tokens (page_id);
CREATE INDEX share_tokens_expires_at_idx ON share_tokens (expires_at);
CREATE INDEX share_tokens_revoked_at_idx ON share_tokens (revoked_at);

ALTER TABLE share_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY share_tokens_select ON share_tokens FOR SELECT
  USING (
    created_by = app_user_id()
    OR app_actor() = 'gateway'                                              -- public-link validation
    OR app_is_admin()
  );
CREATE POLICY share_tokens_insert ON share_tokens FOR INSERT
  WITH CHECK (created_by = app_user_id());
CREATE POLICY share_tokens_update ON share_tokens FOR UPDATE
  USING (created_by = app_user_id() OR app_actor() = 'gateway');
-- DELETE intentionally not granted — use revoked_at instead.

------------------------------------------------------------------------------
-- 17. comments  — threaded comments on widgets / notes / etc.
------------------------------------------------------------------------------

CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('widget', 'note', 'pipeline', 'portfolio', 'client')),
  entity_id    uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  parent_id    uuid REFERENCES comments(id) ON DELETE CASCADE,              -- null for top-level
  content      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id);
CREATE INDEX comments_user_id_idx ON comments (user_id);
CREATE INDEX comments_parent_idx ON comments (parent_id);

CREATE TRIGGER comments_updated_at BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
-- Comment visibility piggybacks on the underlying entity's visibility, but RLS
-- can't easily traverse polymorphic FKs. Simple approach: same-org members see
-- comments on org-visible entities. Tighten later per entity_type if needed.
CREATE POLICY comments_select ON comments FOR SELECT
  USING (
    user_id = app_user_id()
    OR EXISTS (SELECT 1 FROM gateway.users u WHERE u.id = comments.user_id AND u.org_id = app_org_id())
    OR app_is_admin()
  );
CREATE POLICY comments_insert ON comments FOR INSERT
  WITH CHECK (user_id = app_user_id());
CREATE POLICY comments_update ON comments FOR UPDATE
  USING (user_id = app_user_id());
CREATE POLICY comments_delete ON comments FOR DELETE
  USING (user_id = app_user_id() OR app_is_admin());

------------------------------------------------------------------------------
-- End of schema
------------------------------------------------------------------------------
