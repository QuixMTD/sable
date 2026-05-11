-- sable-core — Core database schema
-- Same Postgres instance as gateway-schema.sql. Apply gateway first.
-- Helpers (enc/dec/sha256/app_*/set_updated_at) live in `public`, created
-- by gateway-schema.sql. Do not redefine them here.

CREATE SCHEMA IF NOT EXISTS core;
SET search_path = core, public;

------------------------------------------------------------------------------
-- 1. clients  — firm's CRM-side client records
------------------------------------------------------------------------------

-- A client belongs to EITHER a firm (org route) OR an individual user (advisor
-- route — independent advisors managing their own clients).
CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES gateway.organisations(id) ON DELETE RESTRICT,
  user_id     uuid REFERENCES gateway.users(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  reference   text,
  created_by  uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((org_id IS NOT NULL) <> (user_id IS NOT NULL))                     -- xor
);

CREATE INDEX clients_org_id_idx ON clients (org_id);
CREATE INDEX clients_user_id_idx ON clients (user_id);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY clients_select ON clients FOR SELECT
  USING (
    (org_id IS NOT NULL AND org_id = app_org_id())
    OR user_id = app_user_id()
    OR app_is_admin()
  );
CREATE POLICY clients_write_org ON clients FOR ALL
  USING (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
  WITH CHECK (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin());
CREATE POLICY clients_write_user ON clients FOR ALL
  USING (user_id = app_user_id() AND org_id IS NULL)
  WITH CHECK (user_id = app_user_id() AND org_id IS NULL);

------------------------------------------------------------------------------
-- 2. portfolios  — metadata only; holdings live in module schemas
------------------------------------------------------------------------------

-- A portfolio is owned by EITHER an org (managing a CRM client) OR a user
-- (managing their own client as an advisor, or investing for themselves).
-- Three valid shapes:
--   1. Org-firm route:     org_id set, client_id set, user_id null
--   2. Independent advisor: user_id set, client_id set, org_id null
--   3. Self-investor:      user_id set, client_id null, org_id null
CREATE TABLE portfolios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid REFERENCES clients(id) ON DELETE RESTRICT,                -- set when portfolio is for a CRM client
  user_id     uuid REFERENCES gateway.users(id) ON DELETE RESTRICT,          -- set on advisor + self routes
  org_id      uuid REFERENCES gateway.organisations(id) ON DELETE RESTRICT,  -- set on org route (denormalised for RLS)
  name        text NOT NULL,
  type        text CHECK (type IN ('equity', 'property', 'crypto', 'alt', 'mixed')),
  currency    text NOT NULL DEFAULT 'GBP',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (org_id IS NOT NULL AND client_id IS NOT NULL AND user_id IS NULL)
    OR (org_id IS NULL AND user_id IS NOT NULL)
  )
);

CREATE INDEX portfolios_client_id_idx ON portfolios (client_id);
CREATE INDEX portfolios_user_id_idx ON portfolios (user_id);
CREATE INDEX portfolios_org_id_idx ON portfolios (org_id);

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

CREATE POLICY portfolios_select ON portfolios FOR SELECT
  USING (
    (org_id IS NOT NULL AND org_id = app_org_id())
    OR user_id = app_user_id()
    OR app_is_admin()
  );
CREATE POLICY portfolios_write_org ON portfolios FOR ALL
  USING (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
  WITH CHECK (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin());
-- Covers both the independent-advisor (user_id + client_id) and self-investor
-- (user_id only) cases — they share the same write policy.
CREATE POLICY portfolios_write_user ON portfolios FOR ALL
  USING (user_id = app_user_id() AND org_id IS NULL)
  WITH CHECK (user_id = app_user_id() AND org_id IS NULL);

------------------------------------------------------------------------------
-- 3. workspace_layouts  — org-level layout templates
------------------------------------------------------------------------------

CREATE TABLE workspace_layouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES gateway.organisations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  layout_mode   text NOT NULL DEFAULT 'grid' CHECK (layout_mode IN ('canvas', 'grid')),
  grid_columns  integer NOT NULL DEFAULT 12,
  is_default    boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_layouts_org_id_idx ON workspace_layouts (org_id);
CREATE INDEX workspace_layouts_is_default_idx ON workspace_layouts (is_default) WHERE is_default;

ALTER TABLE workspace_layouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_layouts_select ON workspace_layouts FOR SELECT
  USING (org_id = app_org_id() OR app_is_admin());
CREATE POLICY workspace_layouts_write ON workspace_layouts FOR ALL
  USING (org_id = app_org_id() AND app_is_owner_or_admin())
  WITH CHECK (org_id = app_org_id() AND app_is_owner_or_admin());

------------------------------------------------------------------------------
-- 4. workspace_pages  — personal pages, org pages, or client-dashboard pages
------------------------------------------------------------------------------

CREATE TABLE workspace_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES gateway.users(id) ON DELETE RESTRICT,
  org_id          uuid REFERENCES gateway.organisations(id) ON DELETE RESTRICT,
  client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
  parent_page_id  uuid REFERENCES workspace_pages(id) ON DELETE CASCADE,   -- sub-page hierarchy (Notion-style)
  name            text NOT NULL,
  icon            text,
  position        integer NOT NULL DEFAULT 0,
  layout_mode     text NOT NULL DEFAULT 'grid' CHECK (layout_mode IN ('canvas', 'grid')),
  grid_columns    integer NOT NULL DEFAULT 12,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A page belongs to exactly one owner: a user (personal) or an org (shared).
  -- XOR matches the shape of write_personal vs write_org policies — a hybrid
  -- row would pass the loose `OR` form but no policy could write to it.
  CHECK ((user_id IS NOT NULL) <> (org_id IS NOT NULL))
);

CREATE INDEX workspace_pages_user_id_idx ON workspace_pages (user_id);
CREATE INDEX workspace_pages_org_id_idx ON workspace_pages (org_id);
CREATE INDEX workspace_pages_client_id_idx ON workspace_pages (client_id);
CREATE INDEX workspace_pages_parent_page_id_idx ON workspace_pages (parent_page_id);

-- Notion-style permission inheritance: a page is visible to the current
-- session if it (or ANY of its ancestors via parent_page_id) is owned by the
-- session's user or org. SECURITY DEFINER bypasses RLS on the inner SELECT —
-- otherwise the policy would recurse into itself. Search_path locked to
-- core+public so the function can't be hijacked by a malicious caller's
-- search_path. Depth-capped at 50 as a cycle / runaway guard.
--
-- Inheritance applies to SELECT only. Writes still require direct ownership
-- of the row — a user's personal sub-page under an org parent stays writable
-- only by the owner, even though org members can read it.
CREATE OR REPLACE FUNCTION page_visible_to_current_session(p_page_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, public
AS $$
  WITH RECURSIVE ancestors AS (
    SELECT id, user_id, org_id, parent_page_id, 0 AS depth
    FROM core.workspace_pages
    WHERE id = p_page_id

    UNION ALL

    SELECT p.id, p.user_id, p.org_id, p.parent_page_id, a.depth + 1
    FROM core.workspace_pages p
    JOIN ancestors a ON a.parent_page_id = p.id
    WHERE a.depth < 50
  )
  SELECT EXISTS (
    SELECT 1 FROM ancestors
    WHERE user_id = app_user_id()
       OR (org_id IS NOT NULL AND org_id = app_org_id())
  );
$$;

ALTER TABLE workspace_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_pages_select ON workspace_pages FOR SELECT
  USING (page_visible_to_current_session(id) OR app_is_admin());
CREATE POLICY workspace_pages_write_personal ON workspace_pages FOR ALL
  USING (user_id = app_user_id() AND org_id IS NULL)
  WITH CHECK (user_id = app_user_id() AND org_id IS NULL);
CREATE POLICY workspace_pages_write_org ON workspace_pages FOR ALL
  USING (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
  WITH CHECK (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin());

------------------------------------------------------------------------------
-- 5. workspace_widgets  — belongs to a page OR a layout template
------------------------------------------------------------------------------

CREATE TABLE workspace_widgets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id           uuid REFERENCES workspace_pages(id) ON DELETE CASCADE,
  layout_id         uuid REFERENCES workspace_layouts(id) ON DELETE CASCADE,
  widget_type       text NOT NULL,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  x                 double precision,
  y                 double precision,
  width             double precision,
  height            double precision,
  col_start         integer,
  col_span          integer,
  row_start         integer,
  row_span          integer,
  is_locked         boolean NOT NULL DEFAULT false,
  position          integer NOT NULL DEFAULT 0,
  linked_widget_id  uuid REFERENCES workspace_widgets(id) ON DELETE SET NULL,
  link_type         text CHECK (link_type IN ('filter', 'highlight', 'drill')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- A widget sits on exactly one container — either a workspace page or a
  -- layout template. XOR mirrors the same pattern as workspace_pages.
  CHECK ((page_id IS NOT NULL) <> (layout_id IS NOT NULL))
);

CREATE INDEX workspace_widgets_page_id_idx ON workspace_widgets (page_id);
CREATE INDEX workspace_widgets_layout_id_idx ON workspace_widgets (layout_id);
CREATE INDEX workspace_widgets_linked_widget_id_idx ON workspace_widgets (linked_widget_id);

ALTER TABLE workspace_widgets ENABLE ROW LEVEL SECURITY;

-- Widget reads inherit via the page (and the page's ancestors). Writes still
-- check direct ownership of the parent page / layout below.
CREATE POLICY workspace_widgets_select ON workspace_widgets FOR SELECT
  USING (
    (page_id IS NOT NULL AND page_visible_to_current_session(page_id))
    OR EXISTS (
      SELECT 1 FROM workspace_layouts l
      WHERE l.id = layout_id AND l.org_id = app_org_id()
    )
    OR app_is_admin()
  );
CREATE POLICY workspace_widgets_write ON workspace_widgets FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM workspace_pages p
      WHERE p.id = page_id
        AND ((p.user_id = app_user_id() AND p.org_id IS NULL)
          OR (p.org_id = app_org_id() AND app_is_owner_or_admin()))
    )
    OR EXISTS (
      SELECT 1 FROM workspace_layouts l
      WHERE l.id = layout_id AND l.org_id = app_org_id() AND app_is_owner_or_admin()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspace_pages p
      WHERE p.id = page_id
        AND ((p.user_id = app_user_id() AND p.org_id IS NULL)
          OR (p.org_id = app_org_id() AND app_is_owner_or_admin()))
    )
    OR EXISTS (
      SELECT 1 FROM workspace_layouts l
      WHERE l.id = layout_id AND l.org_id = app_org_id() AND app_is_owner_or_admin()
    )
  );

------------------------------------------------------------------------------
-- 6. workspace_notes
------------------------------------------------------------------------------

CREATE TABLE workspace_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL (not CASCADE) so user-authored research survives a page delete.
  -- Matches workspace_events.page_id. Orphaned notes become "general" notes
  -- the user can re-categorise.
  page_id            uuid REFERENCES workspace_pages(id) ON DELETE SET NULL,
  user_id            uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  content            jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_asset_id    text,
  linked_asset_type  text CHECK (linked_asset_type IN ('ticker', 'property', 'holding', 'crypto')),
  tags               text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_notes_page_id_idx ON workspace_notes (page_id);
CREATE INDEX workspace_notes_user_id_idx ON workspace_notes (user_id);
CREATE INDEX workspace_notes_tags_idx ON workspace_notes USING gin (tags);

CREATE TRIGGER workspace_notes_updated_at BEFORE UPDATE ON workspace_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_notes_write ON workspace_notes FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());
-- workspace_notes_select is defined after note_access — it references that
-- table and Postgres validates table refs at CREATE POLICY time.

------------------------------------------------------------------------------
-- 7. note_access  — collaboration grants for notes
------------------------------------------------------------------------------

-- Note grants — same shape as pipeline_shares / script_shares so the
-- vocabulary across the codebase is consistent. A note can be shared with
-- any user or any org on the platform (cross-firm).
CREATE TABLE note_access (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id               uuid NOT NULL REFERENCES workspace_notes(id) ON DELETE CASCADE,
  shared_with_user_id   uuid REFERENCES gateway.users(id) ON DELETE CASCADE,
  shared_with_org_id    uuid REFERENCES gateway.organisations(id) ON DELETE CASCADE,
  permission            text NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit')),
  granted_by            uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((shared_with_user_id IS NOT NULL) <> (shared_with_org_id IS NOT NULL)),
  -- Two conditional UNIQUEs — NULLs aren't equal in unique constraints so
  -- this enforces "one grant per (note, user)" and "one grant per (note, org)"
  -- independently.
  UNIQUE (note_id, shared_with_user_id),
  UNIQUE (note_id, shared_with_org_id)
);

CREATE INDEX note_access_note_id_idx ON note_access (note_id);
CREATE INDEX note_access_shared_with_user_id_idx ON note_access (shared_with_user_id);
CREATE INDEX note_access_shared_with_org_id_idx ON note_access (shared_with_org_id);

ALTER TABLE note_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY note_access_select ON note_access FOR SELECT
  USING (
    shared_with_user_id = app_user_id()
    OR shared_with_org_id = app_org_id()
    OR EXISTS (SELECT 1 FROM workspace_notes n WHERE n.id = note_id AND n.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY note_access_write ON note_access FOR ALL
  USING (EXISTS (SELECT 1 FROM workspace_notes n WHERE n.id = note_id AND n.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspace_notes n WHERE n.id = note_id AND n.user_id = app_user_id()));

-- Deferred from section 6 — needs note_access to exist before validation.
-- A note is visible if any of:
--   - the current user owns it
--   - it lives on a page the current user can see (page-inheritance via
--     page_visible_to_current_session — walks parent_page_id, so a note on
--     an org-shared page is visible to every org member)
--   - the current user has an explicit note_access grant
-- Writes still require direct ownership; org members can read inherited notes
-- but only the owner can edit.
CREATE POLICY workspace_notes_select ON workspace_notes FOR SELECT
  USING (
    user_id = app_user_id()
    OR (page_id IS NOT NULL AND page_visible_to_current_session(page_id))
    OR EXISTS (
      SELECT 1 FROM note_access na
      WHERE na.note_id = id
        AND (na.shared_with_user_id = app_user_id() OR na.shared_with_org_id = app_org_id())
    )
    OR app_is_admin()
  );

------------------------------------------------------------------------------
-- 8. workspace_scripts
------------------------------------------------------------------------------

CREATE TABLE workspace_scripts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  code            text NOT NULL,
  default_target  text,
  is_shared       boolean NOT NULL DEFAULT false,                            -- denormalised cache; true iff any script_shares row exists
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_scripts_user_id_idx ON workspace_scripts (user_id);
CREATE INDEX workspace_scripts_is_shared_idx ON workspace_scripts (is_shared) WHERE is_shared;

CREATE TRIGGER workspace_scripts_updated_at BEFORE UPDATE ON workspace_scripts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_scripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_scripts_write ON workspace_scripts FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());
-- workspace_scripts_select is defined after script_shares — it references
-- that table and Postgres validates table refs at CREATE POLICY time.

------------------------------------------------------------------------------
-- 9. workspace_events
------------------------------------------------------------------------------

CREATE TABLE workspace_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  page_id            uuid REFERENCES workspace_pages(id) ON DELETE SET NULL,
  title              text NOT NULL,
  description        text,
  start_at           timestamptz NOT NULL,
  end_at             timestamptz,
  all_day            boolean NOT NULL DEFAULT false,
  linked_asset_id    text,
  linked_asset_type  text CHECK (linked_asset_type IN ('ticker', 'property', 'holding', 'crypto')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_events_user_id_idx ON workspace_events (user_id);
CREATE INDEX workspace_events_start_at_idx ON workspace_events (start_at);
CREATE INDEX workspace_events_page_id_idx ON workspace_events (page_id);

CREATE TRIGGER workspace_events_updated_at BEFORE UPDATE ON workspace_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_events ENABLE ROW LEVEL SECURITY;

-- Events on org-shared pages inherit visibility, same pattern as widgets and
-- notes. Writes still require direct ownership.
CREATE POLICY workspace_events_select ON workspace_events FOR SELECT
  USING (
    user_id = app_user_id()
    OR (page_id IS NOT NULL AND page_visible_to_current_session(page_id))
    OR app_is_admin()
  );
CREATE POLICY workspace_events_write ON workspace_events FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 10. pipelines
------------------------------------------------------------------------------

CREATE TABLE pipelines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  graph           jsonb NOT NULL,
  trigger_type    text CHECK (trigger_type IN ('manual', 'scheduled', 'event')),
  trigger_config  jsonb,
  is_shared       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pipelines_user_id_idx ON pipelines (user_id);
CREATE INDEX pipelines_is_shared_idx ON pipelines (is_shared) WHERE is_shared;

CREATE TRIGGER pipelines_updated_at BEFORE UPDATE ON pipelines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipelines_write ON pipelines FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());
-- pipelines_select is defined after pipeline_shares — it references that
-- table and Postgres validates table refs at CREATE POLICY time.

------------------------------------------------------------------------------
-- 11. pipeline_shares
------------------------------------------------------------------------------

CREATE TABLE pipeline_shares (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id           uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  shared_with_org_id    uuid REFERENCES gateway.organisations(id) ON DELETE CASCADE,
  shared_with_user_id   uuid REFERENCES gateway.users(id) ON DELETE CASCADE,
  permission            text NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'clone', 'edit')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((shared_with_org_id IS NOT NULL) <> (shared_with_user_id IS NOT NULL))
);

CREATE INDEX pipeline_shares_pipeline_id_idx ON pipeline_shares (pipeline_id);
CREATE INDEX pipeline_shares_shared_with_org_id_idx ON pipeline_shares (shared_with_org_id);
CREATE INDEX pipeline_shares_shared_with_user_id_idx ON pipeline_shares (shared_with_user_id);

ALTER TABLE pipeline_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipeline_shares_select ON pipeline_shares FOR SELECT
  USING (
    shared_with_user_id = app_user_id()
    OR shared_with_org_id = app_org_id()
    OR EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY pipeline_shares_write ON pipeline_shares FOR ALL
  USING (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id()));

-- Keep pipelines.is_shared in sync with the existence of any share row.
-- AFTER trigger so the row is already present when we recompute.
CREATE OR REPLACE FUNCTION pipeline_shares_refresh_is_shared()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE pipelines SET is_shared = true WHERE id = NEW.pipeline_id AND is_shared = false;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE pipelines
       SET is_shared = EXISTS (SELECT 1 FROM pipeline_shares WHERE pipeline_id = OLD.pipeline_id)
     WHERE id = OLD.pipeline_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER pipeline_shares_refresh_is_shared
  AFTER INSERT OR DELETE ON pipeline_shares
  FOR EACH ROW EXECUTE FUNCTION pipeline_shares_refresh_is_shared();

-- Deferred from section 10 — needs pipeline_shares to exist before validation.
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

------------------------------------------------------------------------------
-- 11a. script_shares  — cross-platform sharing of workspace_scripts
------------------------------------------------------------------------------

-- Same shape as pipeline_shares. A user can share a script with any other
-- user or any other org on the platform — not restricted to same-firm.
CREATE TABLE script_shares (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id             uuid NOT NULL REFERENCES workspace_scripts(id) ON DELETE CASCADE,
  shared_with_org_id    uuid REFERENCES gateway.organisations(id) ON DELETE CASCADE,
  shared_with_user_id   uuid REFERENCES gateway.users(id) ON DELETE CASCADE,
  permission            text NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'clone', 'edit')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((shared_with_org_id IS NOT NULL) <> (shared_with_user_id IS NOT NULL))
);

CREATE INDEX script_shares_script_id_idx ON script_shares (script_id);
CREATE INDEX script_shares_shared_with_org_id_idx ON script_shares (shared_with_org_id);
CREATE INDEX script_shares_shared_with_user_id_idx ON script_shares (shared_with_user_id);

ALTER TABLE script_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY script_shares_select ON script_shares FOR SELECT
  USING (
    shared_with_user_id = app_user_id()
    OR shared_with_org_id = app_org_id()
    OR EXISTS (SELECT 1 FROM workspace_scripts s WHERE s.id = script_id AND s.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY script_shares_write ON script_shares FOR ALL
  USING (EXISTS (SELECT 1 FROM workspace_scripts s WHERE s.id = script_id AND s.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspace_scripts s WHERE s.id = script_id AND s.user_id = app_user_id()));

-- Keep workspace_scripts.is_shared in sync — same pattern as pipelines.
CREATE OR REPLACE FUNCTION script_shares_refresh_is_shared()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE workspace_scripts SET is_shared = true WHERE id = NEW.script_id AND is_shared = false;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE workspace_scripts
       SET is_shared = EXISTS (SELECT 1 FROM script_shares WHERE script_id = OLD.script_id)
     WHERE id = OLD.script_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER script_shares_refresh_is_shared
  AFTER INSERT OR DELETE ON script_shares
  FOR EACH ROW EXECUTE FUNCTION script_shares_refresh_is_shared();

-- Deferred from section 8 — needs script_shares to exist before validation.
CREATE POLICY workspace_scripts_select ON workspace_scripts FOR SELECT
  USING (
    user_id = app_user_id()
    OR EXISTS (
      SELECT 1 FROM script_shares ss
      WHERE ss.script_id = id
        AND (ss.shared_with_user_id = app_user_id() OR ss.shared_with_org_id = app_org_id())
    )
    OR app_is_admin()
  );

------------------------------------------------------------------------------
-- 12. pipeline_versions  — immutable snapshots
------------------------------------------------------------------------------

CREATE TABLE pipeline_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id  uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  graph        jsonb NOT NULL,
  created_by   uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pipeline_versions_pipeline_id_idx ON pipeline_versions (pipeline_id);
CREATE INDEX pipeline_versions_created_at_idx ON pipeline_versions (created_at);

ALTER TABLE pipeline_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipeline_versions_select ON pipeline_versions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id())
    OR app_is_admin()
  );
CREATE POLICY pipeline_versions_insert ON pipeline_versions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND p.user_id = app_user_id()));
-- No UPDATE/DELETE policies → immutable.

------------------------------------------------------------------------------
-- 13. alerts
------------------------------------------------------------------------------

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  alert_type    text NOT NULL CHECK (alert_type IN ('price', 'portfolio', 'news', 'custom')),
  condition     jsonb NOT NULL,
  delivery      text[] NOT NULL DEFAULT ARRAY['in_app']::text[],
  is_active     boolean NOT NULL DEFAULT true,
  triggered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_user_id_idx ON alerts (user_id);
CREATE INDEX alerts_is_active_idx ON alerts (is_active) WHERE is_active;
CREATE INDEX alerts_alert_type_idx ON alerts (alert_type);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY alerts_select ON alerts FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY alerts_write ON alerts FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

------------------------------------------------------------------------------
-- 14. share_tokens  — read-only client dashboard links
------------------------------------------------------------------------------

CREATE TABLE share_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,                                      -- #️⃣
  page_id       uuid NOT NULL REFERENCES workspace_pages(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  expires_at    timestamptz,
  is_read_only  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX share_tokens_token_hash_idx ON share_tokens (token_hash);
CREATE INDEX share_tokens_page_id_idx ON share_tokens (page_id);
CREATE INDEX share_tokens_expires_at_idx ON share_tokens (expires_at);

ALTER TABLE share_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY share_tokens_select ON share_tokens FOR SELECT
  USING (created_by = app_user_id() OR app_actor() = 'gateway' OR app_is_admin());
CREATE POLICY share_tokens_insert ON share_tokens FOR INSERT
  WITH CHECK (created_by = app_user_id());
CREATE POLICY share_tokens_update ON share_tokens FOR UPDATE
  USING (created_by = app_user_id() OR app_actor() = 'gateway');

------------------------------------------------------------------------------
-- 15. command_history  (PARTITIONED BY RANGE (executed_at) — monthly, immutable)
------------------------------------------------------------------------------

CREATE TABLE command_history (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  command      text NOT NULL,
  target       text,
  executed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, executed_at)
) PARTITION BY RANGE (executed_at);

CREATE INDEX command_history_user_id_idx ON command_history (user_id);
CREATE INDEX command_history_executed_at_idx ON command_history (executed_at);

CREATE TABLE command_history_2026_05 PARTITION OF command_history
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

ALTER TABLE command_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY command_history_select ON command_history FOR SELECT
  USING (user_id = app_user_id() OR app_is_admin());
CREATE POLICY command_history_insert ON command_history FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_actor() IN ('gateway', 'system'));
-- No UPDATE/DELETE policies → immutable log.

------------------------------------------------------------------------------
-- 16. comments
------------------------------------------------------------------------------

CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    uuid NOT NULL,
  entity_type  text NOT NULL CHECK (entity_type IN ('widget', 'note', 'pipeline', 'script', 'report')),
  user_id      uuid NOT NULL REFERENCES gateway.users(id) ON DELETE RESTRICT,
  content      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX comments_entity_idx ON comments (entity_id, entity_type);
CREATE INDEX comments_user_id_idx ON comments (user_id);

CREATE TRIGGER comments_updated_at BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

-- Polymorphic visibility: a comment is visible iff the viewer can see the
-- entity it's on. Dispatches by entity_type to the appropriate table's
-- visibility rules. SECURITY DEFINER bypasses RLS on the inner reads so the
-- function can resolve the entity without recursing into its own policy.
CREATE OR REPLACE FUNCTION comment_target_visible_to_current_session(
  p_entity_type text,
  p_entity_id   uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = core, public
AS $$
DECLARE
  visible boolean := false;
BEGIN
  IF p_entity_type = 'widget' THEN
    SELECT EXISTS (
      SELECT 1 FROM core.workspace_widgets w
      WHERE w.id = p_entity_id
        AND (
          (w.page_id IS NOT NULL AND page_visible_to_current_session(w.page_id))
          OR EXISTS (
            SELECT 1 FROM core.workspace_layouts l
            WHERE l.id = w.layout_id AND l.org_id = app_org_id()
          )
        )
    ) INTO visible;

  ELSIF p_entity_type = 'note' THEN
    SELECT EXISTS (
      SELECT 1 FROM core.workspace_notes n
      WHERE n.id = p_entity_id
        AND (
          n.user_id = app_user_id()
          OR (n.page_id IS NOT NULL AND page_visible_to_current_session(n.page_id))
          OR EXISTS (
            SELECT 1 FROM core.note_access na
            WHERE na.note_id = n.id
              AND (na.shared_with_user_id = app_user_id() OR na.shared_with_org_id = app_org_id())
          )
        )
    ) INTO visible;

  ELSIF p_entity_type = 'pipeline' THEN
    SELECT EXISTS (
      SELECT 1 FROM core.pipelines p
      WHERE p.id = p_entity_id
        AND (
          p.user_id = app_user_id()
          OR EXISTS (
            SELECT 1 FROM core.pipeline_shares ps
            WHERE ps.pipeline_id = p.id
              AND (ps.shared_with_user_id = app_user_id() OR ps.shared_with_org_id = app_org_id())
          )
        )
    ) INTO visible;

  ELSIF p_entity_type = 'script' THEN
    SELECT EXISTS (
      SELECT 1 FROM core.workspace_scripts s
      WHERE s.id = p_entity_id
        AND (
          s.user_id = app_user_id()
          OR EXISTS (
            SELECT 1 FROM core.script_shares ss
            WHERE ss.script_id = s.id
              AND (ss.shared_with_user_id = app_user_id() OR ss.shared_with_org_id = app_org_id())
          )
        )
    ) INTO visible;

  ELSIF p_entity_type = 'report' THEN
    SELECT EXISTS (
      SELECT 1 FROM core.client_reports r
      WHERE r.id = p_entity_id
        AND (
          (r.org_id IS NOT NULL AND r.org_id = app_org_id())
          OR r.user_id = app_user_id()
        )
    ) INTO visible;
  END IF;

  RETURN visible;
END;
$$;

CREATE POLICY comments_select ON comments FOR SELECT
  USING (
    user_id = app_user_id()
    OR comment_target_visible_to_current_session(entity_type, entity_id)
    OR app_is_admin()
  );
-- Inserting requires owning the comment AND being able to see the entity —
-- prevents commenting on entities you can't see (e.g. guessing UUIDs).
CREATE POLICY comments_insert ON comments FOR INSERT
  WITH CHECK (
    user_id = app_user_id()
    AND comment_target_visible_to_current_session(entity_type, entity_id)
  );
CREATE POLICY comments_update ON comments FOR UPDATE
  USING (user_id = app_user_id());
CREATE POLICY comments_delete ON comments FOR DELETE
  USING (user_id = app_user_id() OR app_is_admin());

------------------------------------------------------------------------------
-- 17. user_crons  — user-defined scheduled tasks
------------------------------------------------------------------------------

CREATE TABLE user_crons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES gateway.users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  cron_expression   text NOT NULL,
  timezone          text NOT NULL DEFAULT 'UTC',
  action_type       text NOT NULL CHECK (action_type IN ('script', 'pipeline', 'command', 'report')),
  action_id         uuid,
  action_config     jsonb,
  is_active         boolean NOT NULL DEFAULT true,
  last_run_at       timestamptz,
  next_run_at       timestamptz,
  last_run_status   text CHECK (last_run_status IN ('success', 'failed', 'running')),
  last_run_error    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_crons_user_id_idx ON user_crons (user_id);
CREATE INDEX user_crons_scheduler_idx ON user_crons (next_run_at, is_active);
CREATE INDEX user_crons_is_active_idx ON user_crons (is_active);

CREATE TRIGGER user_crons_updated_at BEFORE UPDATE ON user_crons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE user_crons ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_crons_select ON user_crons FOR SELECT
  USING (user_id = app_user_id() OR app_actor() = 'system' OR app_is_admin());
CREATE POLICY user_crons_write ON user_crons FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());
CREATE POLICY user_crons_system_update ON user_crons FOR UPDATE
  USING (app_actor() = 'system');

------------------------------------------------------------------------------
-- 18. report_templates  — org-defined report layouts
------------------------------------------------------------------------------

-- Templates belong to EITHER a firm (org-shared) OR a single user (an
-- independent advisor's personal template library).
CREATE TABLE report_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid REFERENCES gateway.organisations(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES gateway.users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text,
  layout            jsonb NOT NULL,                                         -- sections + blocks + data-source bindings
  required_modules  text[] NOT NULL DEFAULT '{}',                           -- modules the template pulls from (sc, re, …)
  is_default        boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((org_id IS NOT NULL) <> (user_id IS NOT NULL))                     -- xor
);

CREATE INDEX report_templates_org_id_idx ON report_templates (org_id);
CREATE INDEX report_templates_user_id_idx ON report_templates (user_id);
CREATE INDEX report_templates_is_default_idx ON report_templates (is_default) WHERE is_default;

CREATE TRIGGER report_templates_updated_at BEFORE UPDATE ON report_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE report_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY report_templates_select ON report_templates FOR SELECT
  USING (
    (org_id IS NOT NULL AND org_id = app_org_id())
    OR user_id = app_user_id()
    OR app_is_admin()
  );
-- DB enforces ownership; gateway enforces the granular
-- `clients.manage_templates` permission from gateway.org_roles.permissions
-- for the org route. The user route is always self-managed.
CREATE POLICY report_templates_write_org ON report_templates FOR ALL
  USING (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
  WITH CHECK (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin());
CREATE POLICY report_templates_write_user ON report_templates FOR ALL
  USING (user_id = app_user_id() AND org_id IS NULL)
  WITH CHECK (user_id = app_user_id() AND org_id IS NULL);

------------------------------------------------------------------------------
-- 19. client_reports  — generated report records, PDF in GCS
------------------------------------------------------------------------------

-- Generated reports for a CRM client. The client itself is either org-owned
-- (firm route) or user-owned (independent advisor route). Mirror the same
-- xor on this table so RLS doesn't have to JOIN clients on every read.
CREATE TABLE client_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT (not CASCADE) so deleting a CRM client doesn't silently wipe
  -- their generated report history. Regulators (FCA, HMRC) typically require
  -- multi-year retention. Forces explicit migration / archival before client
  -- deletion. Matches org_id and user_id RESTRICT below.
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  template_id    uuid REFERENCES report_templates(id) ON DELETE SET NULL,   -- template may be deleted; report still exists
  org_id         uuid REFERENCES gateway.organisations(id) ON DELETE RESTRICT, -- set on firm route (denormalised for RLS)
  user_id        uuid REFERENCES gateway.users(id) ON DELETE RESTRICT,        -- set on advisor route
  name           text NOT NULL,
  period_start   date,
  period_end     date,
  status         text NOT NULL DEFAULT 'generating'
                 CHECK (status IN ('generating', 'ready', 'failed', 'sent')),
  pdf_gcs_url    text,                                                      -- gs://bucket/path.pdf
  error_message  text,
  recipients     bytea,                                                     -- 🔐 JSON array of email addresses (audit snapshot)
  generated_by   uuid REFERENCES gateway.users(id) ON DELETE SET NULL,
  generated_at   timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((org_id IS NOT NULL) <> (user_id IS NOT NULL))                     -- xor
);

CREATE INDEX client_reports_client_id_idx ON client_reports (client_id);
CREATE INDEX client_reports_org_id_idx ON client_reports (org_id);
CREATE INDEX client_reports_user_id_idx ON client_reports (user_id);
CREATE INDEX client_reports_template_id_idx ON client_reports (template_id);
CREATE INDEX client_reports_status_idx ON client_reports (status);
CREATE INDEX client_reports_generated_at_idx ON client_reports (generated_at);

ALTER TABLE client_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_reports_select ON client_reports FOR SELECT
  USING (
    (org_id IS NOT NULL AND org_id = app_org_id())
    OR user_id = app_user_id()
    OR app_is_admin()
  );
-- Granular `clients.create_reports` / `clients.send_reports` permissions are
-- checked by the gateway against gateway.org_roles.permissions for the org
-- route. Advisor route is always self-managed.
CREATE POLICY client_reports_write_org ON client_reports FOR ALL
  USING (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin())
  WITH CHECK (org_id IS NOT NULL AND org_id = app_org_id() AND app_is_owner_or_admin());
CREATE POLICY client_reports_write_user ON client_reports FOR ALL
  USING (user_id = app_user_id() AND org_id IS NULL)
  WITH CHECK (user_id = app_user_id() AND org_id IS NULL);
-- Generation worker / sender uses the `system` actor to update status,
-- pdf_gcs_url, sent_at without being an org admin or the owning user.
CREATE POLICY client_reports_system_update ON client_reports FOR UPDATE
  USING (app_actor() = 'system')
  WITH CHECK (app_actor() = 'system');

------------------------------------------------------------------------------
-- End of schema
------------------------------------------------------------------------------
