# Sable Terminal — Workspace: Every Feature & How to Build It

> The workspace is a dockable, detachable companion panel that sits alongside the module view. It is persistent across all modules, fully user-configurable, and powered by live data from whichever modules are active.

---

## 1. Layout & Positioning

### 1.1 Dockable Panel
Dock the workspace to the left, right, top, or bottom of the module view.

**How to build:**
- Flutter: wrap the app shell in a `Row` or `Column` widget depending on dock position
- Store dock position in user preferences in `sable-core` PostgreSQL — `user_settings.workspace_dock_position` ENUM ('left', 'right', 'top', 'bottom')
- On dock change: rebuild the app shell widget tree with the new layout axis
- Persist position to database on every change via REST call to `sable-core`

### 1.2 Resize
Drag the handle between the module view and workspace to resize width or height.

**How to build:**
- Flutter: `GestureDetector` on the divider widget, listen to `onHorizontalDragUpdate` or `onVerticalDragUpdate`
- Update a `workspaceSize` value in local state (Riverpod provider)
- Clamp between min (200px) and max (80% of screen)
- Persist final size to `user_settings.workspace_size` on drag end

### 1.3 Fullscreen
Workspace takes the full application window.

**How to build:**
- Flutter: Conditional render — if `isFullscreen` is true, render workspace as the entire scaffold body
- Toggle button in workspace header updates `isFullscreen` in Riverpod state
- `isFullscreen` is session-only, not persisted

### 1.4 Detach to Second Screen
Pull the workspace out as a standalone window on a second monitor.

**How to build:**
- Desktop only (macOS, Windows)
- Use `flutter_multi_window` package or native platform channels
- On detach: spawn a new Flutter window rendering only the workspace widget tree
- Two windows communicate via Dart isolates or a shared local WebSocket on localhost
- Web: open workspace in a new browser tab at `/workspace` route, same session token

### 1.5 Close & Reopen
Hide the workspace entirely. Reopen from a toolbar button.

**How to build:**
- Flutter: `isWorkspaceVisible` bool in Riverpod state
- When false: render only the module view with a small toggle button in the module toolbar
- Toggle button updates state, workspace animates in with `AnimatedSlide`

---

## 2. Pages

### 2.1 Multiple Pages
Users create multiple named pages within the workspace, each with its own layout and widgets.

**How to build:**
- `sable-core` PostgreSQL schema:
```sql
CREATE TABLE workspace_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
- `sable-core` REST endpoints: `GET /workspace/pages`, `POST /workspace/pages`, `PATCH /workspace/pages/:id`, `DELETE /workspace/pages/:id`
- Flutter: `WorkspacePageList` widget in workspace sidebar renders all pages

### 2.2 Add, Rename, Reorder, Delete Pages

**How to build:**
- Add: POST to `/workspace/pages` with default name "Untitled"
- Rename: inline text field on double-tap, PATCH on blur
- Reorder: drag and drop in sidebar using `ReorderableListView`, PATCH positions on drop
- Delete: confirm dialog, DELETE endpoint, remove from local state

---

## 3. Canvas & Layout Modes

### 3.1 Free Canvas Mode
Freely position and resize widgets anywhere on the canvas.

**How to build:**
- Flutter: `Stack` widget with `Positioned` children
- Each widget has `x`, `y`, `width`, `height` stored in `workspace_widgets` table
- `GestureDetector` wraps each widget for drag (update x/y) and resize handle (update width/height)
- Debounce writes — save position to database 500ms after drag ends

### 3.2 Grid Mode
Structured column grid. Widgets snap to grid slots.

**How to build:**
- Flutter: `GridView` with fixed column count (default 12-column grid)
- Each widget occupies a span of columns and rows
- `col_start`, `col_span`, `row_start`, `row_span` stored in `workspace_widgets`
- On drop: snap to nearest grid cell

### 3.3 Toggle Between Modes

**How to build:**
- `layout_mode` ENUM ('canvas', 'grid') stored in `workspace_pages` table
- Toggle button in page header triggers PATCH to update mode
- Flutter: conditional render between `CanvasLayout` and `GridLayout` widgets

### 3.4 Lock Widget Positions

**How to build:**
- `is_locked` BOOL on `workspace_widgets` table, default false
- Locked widgets: `GestureDetector` disabled, no drag handles shown
- Lock toggle in each widget's context menu

---

## 4. Widget System

### 4.1 Widget Registry

**How to build:**
- PostgreSQL schema:
```sql
CREATE TABLE workspace_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES workspace_pages(id),
  widget_type TEXT NOT NULL,  -- 'chart', 'kpi', 'table', 'command_output', etc.
  config JSONB NOT NULL DEFAULT '{}',
  x FLOAT, y FLOAT,          -- canvas mode
  width FLOAT, height FLOAT,
  col_start INT, col_span INT,  -- grid mode
  row_start INT, row_span INT,
  is_locked BOOL DEFAULT false,
  position INT DEFAULT 0
);
```
- Flutter: `WidgetFactory` class maps `widget_type` string to the correct Flutter widget
- Config is type-specific JSON — e.g., chart widget config: `{"ticker": "AAPL", "chart_type": "candlestick", "timeframe": "1D"}`

### 4.2 Chart Widget
Line, bar, candlestick, area charts from any active module.

**How to build:**
- Flutter: `fl_chart` or `syncfusion_flutter_charts` package
- Config: `ticker`, `chart_type`, `timeframe`, `indicators`
- Data: WebSocket subscription to module service for live price updates
- On mount: request historical data from `sable-sc` REST endpoint
- Live updates: WebSocket message updates chart dataset and triggers redraw

### 4.3 KPI / Metric Widget
Single number with label and change indicator.

**How to build:**
- Flutter: simple stateless widget, `Text` for value, `Icon` + `Text` for change
- Config: `metric_type` (portfolio_value, sharpe, VaR etc.), `target_id` (@portfolio, ticker)
- Data: WebSocket subscription to relevant module service

### 4.4 Table Widget
Live data table from any active module.

**How to build:**
- Flutter: `DataTable` or `StickyHeaders` package
- Config: `data_source` (holdings, positions, watchlist), `columns` array, `filters`, `sort`
- Data: REST call on mount + WebSocket for live updates
- Columns configurable via column picker panel

### 4.5 Command Output Widget
Displays the output of the last command inline on the canvas.

**How to build:**
- Flutter: subscribes to a `lastCommandOutput` Riverpod provider
- When a command is executed anywhere in the workspace, this provider updates
- Widget renders markdown or structured output depending on command type

### 4.6 Watchlist Widget

**How to build:**
- Flutter: `ListView` of ticker rows with live price and change %
- Config: `watchlist_id` or inline list of tickers
- Data: WebSocket subscription to `sable-sc` for all tickers in list simultaneously

### 4.7 Portfolio Summary Widget

**How to build:**
- Data: REST call to `sable-core` for aggregated portfolio across all active modules
- Shows total value, day P&L, allocation breakdown
- WebSocket for live total value update

### 4.8 Risk Metrics Widget

**How to build:**
- REST call to `sable-quant` FastAPI endpoint `/risk` with portfolio as body
- Returns VaR, Sharpe, max drawdown, beta
- Refresh on portfolio change via Pub/Sub event from `sable-core`

### 4.9 Heatmap Widget

**How to build:**
- Flutter: custom `CustomPainter` rendering coloured cells
- Data: `sable-sc` returns holdings with day change % per position
- Colour scale: green (positive) → red (negative), size = position weight

### 4.10 News Feed Widget

**How to build:**
- EODHD news API endpoint filtered by holdings tickers
- REST call on mount, refresh every 5 minutes
- Config: `filter_by` (holdings, custom_tickers, keywords)
- Flutter: scrollable `ListView` of news cards

### 4.11 Property Map Widget (RE Module)

**How to build:**
- Flutter: `google_maps_flutter` package
- Overlay data from Land Registry + ONS APIs via `sable-re` service
- Config: centre coordinates, zoom level, overlay type (price growth, yield, planning)
- Only renders when RE module is active

### 4.12 Tax Position Widget

**How to build:**
- REST call to `sable-core` tax calculation endpoint
- Reads disposal data from all active modules via Pub/Sub aggregation
- Shows: CGT used, CGT remaining, annual allowance, MTD status from Sable Tax
- Refreshes on any portfolio change event

### 4.13 Calendar Widget

**How to build:**
- Flutter: `table_calendar` package
- Data sources: EODHD earnings calendar, user-created events, economic calendar
- REST call to `sable-sc` for earnings dates of held tickers
- User events stored in `workspace_events` table in `sable-core`

### 4.14 Widget Configuration Panel

**How to build:**
- Flutter: slide-in `Drawer` or inline settings panel per widget
- Config changes: local state update + debounced PATCH to `workspace_widgets` table
- Data source picker: dropdown of active modules + available data types per module

### 4.15 Linked Widgets
One widget filters another — e.g., clicking a holding in the table filters the chart.

**How to build:**
- Widget-to-widget event bus using Riverpod `StateNotifier`
- Widget config stores `linked_widget_id` and `link_type`
- On user interaction in source widget: publish event to bus
- Linked target widget: subscribes to bus, filters its data on event

---

## 5. Database Views

### 5.1 Table View

**How to build:**
- Flutter: `DataTable` with sortable columns
- Config: data source (holdings, deal pipeline, watchlist), visible columns, filters, sort
- Filters stored in `view_config` JSONB on `workspace_widgets`

### 5.2 Board / Kanban View (RE Module)

**How to build:**
- Flutter: `flutter_kanban` or custom horizontal `ListView` of column stacks
- Columns: Prospecting → Due Diligence → Offer Made → Exchanged → Completed
- Cards draggable between columns
- Card data stored in `sable-re` deal pipeline table

### 5.3 Calendar View

**How to build:**
- Flutter: `table_calendar` package in month view
- Events: earnings dates, review dates, user-created entries
- Click event: open detail sheet

### 5.4 Gallery View

**How to build:**
- Flutter: `GridView` of cards, each card renders a summary of the item
- Config: data source, card fields to show
- Suitable for: property portfolio cards, alternative asset cards

### 5.5 Filter, Sort, Group By

**How to build:**
- Filter/sort config stored in `view_config` JSONB
- Applied client-side for cached data, server-side for large datasets
- Flutter: filter panel widget with field selector, operator selector, value input

---

## 6. Command Interface

### 6.1 Command Bar (Cmd+K)

**How to build:**
- Flutter: `RawKeyboardListener` on the app scaffold, intercepts Cmd+K
- Opens a modal `TextField` overlay at top of workspace
- As user types: debounced call to `sable-core` autocomplete endpoint
- Returns matching commands, targets, and saved pipelines

### 6.2 Target Resolution

**How to build:**
- `sable-gateway` middleware resolves `@` prefix targets before forwarding to module:
```javascript
async function resolveTarget(target, userId) {
  if (target.startsWith('@portfolio'))   return getUserPortfolio(userId)
  if (target.startsWith('@holding:'))    return getHolding(userId, target.split(':')[1])
  if (target.startsWith('@index:'))      return getIndex(target.split(':')[1])
  if (target.startsWith('@watchlist:'))  return getWatchlist(userId, target.split(':')[1])
  if (target.startsWith('@property:'))   return getProperty(userId, target.split(':')[1])
  if (target === '@all')                 return getAllPositions(userId)
  return { type: 'ticker', value: target } // plain ticker
}
```

### 6.3 Command History

**How to build:**
- `sable-core` table:
```sql
CREATE TABLE command_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  command TEXT NOT NULL,
  target TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);
```
- REST endpoint: `GET /commands/history?limit=50`
- Flutter: searchable history list in command bar dropdown

---

## 7. Four Command Tiers

### 7.1 AI Chatbot (Tier 1 — Conversational)
Persistent chat panel with full workspace context access. Can be disabled by org admin or user.

**How to build:**
- Flutter: `ChatPanel` widget — message history `ListView` + text input at bottom
- Backend: `sable-core` `/chat` WebSocket endpoint
- On message received: build context object containing user's portfolio, active module, recent command outputs, workspace notes
- Call Claude API or Vertex AI Gemini with context as system prompt
- Stream response back via WebSocket → Flutter renders tokens as they arrive
- `user_settings.chatbot_enabled` BOOL (user toggle)
- `org_settings.chatbot_enabled` BOOL (org admin toggle, overrides user)
- Both stored in `sable-core`, checked before processing any chat message

### 7.2 AI Prompt via Vertex AI (Tier 2 — Natural Language Command)
User types natural language, Vertex AI resolves intent and executes the correct command.

**How to build:**
- GCP Vertex AI: Gemini model with function calling enabled
- Define function schemas for every available command (montecarlo, risk, backtest etc.)
- On prompt submission: send to Vertex AI with function definitions
- Vertex AI returns: which function to call + parameters extracted from natural language
- `sable-gateway` executes the resolved function call
- Returns structured output to Flutter
- Runs on GCP alongside all other Sable services — low latency

### 7.3 Python Script (Tier 3 — Code Editor)
In-workspace code editor, executes in sable-sandbox.

**How to build:**
- Flutter: `code_text_field` package or custom `TextField` with syntax highlighting
- Execution: POST user code + resolved target data to `sable-sandbox` `/execute`
- Sandbox injects data context, runs in isolated subprocess (see `sable_backend_architecture.md`)
- Output: stdout + stderr streamed back via WebSocket
- Save script: PATCH `workspace_scripts` table in `sable-core`
- Script schema:
```sql
CREATE TABLE workspace_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  default_target TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 7.4 Flowchart Builder (Tier 4 — No-Code Visual)
Drag pre-configured blocks together to build command pipelines visually.

**How to build:**
- Flutter: custom node graph editor — each block is a `Draggable` widget on a `Stack` canvas
- Connections: `CustomPainter` draws Bezier curves between block output and input ports
- Block types (pre-configured):
  - Data blocks: Fetch prices, Fetch fundamentals, Get portfolio, Get holdings, Get property data
  - Analysis blocks: Monte Carlo, Black-Litterman, Factor analysis, Risk metrics, Backtest
  - Filter blocks: If value > threshold, If date is, Filter by sector
  - Action blocks: Send alert, Generate report, Save to notes, Run Python script, Send email
- Block config: click block to open settings panel, configure parameters
- Execution engine: `sable-core` walks the graph in topological order, executes each block sequentially, passes output of each block as input to the next
- Storage:
```sql
CREATE TABLE pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  graph JSONB NOT NULL,  -- nodes + edges + configs
  trigger_type TEXT,     -- 'manual', 'scheduled', 'event'
  trigger_config JSONB,
  is_shared BOOL DEFAULT false,
  shared_with JSONB DEFAULT '[]'  -- array of org/user IDs with permissions
);
```

---

## 8. Pipeline Builder (Saving & Sharing)

**How to build:**
- Save: any command tier output can be saved as a pipeline with a name
- Cross-firm sharing: `pipeline_shares` table with `pipeline_id`, `shared_with_org_id`, `permission` ('view', 'clone', 'edit')
- Shared pipelines appear in recipient's pipeline library, read-only unless edit permission granted
- Version history: `pipeline_versions` table stores JSONB snapshot on every save
- Schedule: store `trigger_type: 'scheduled'` + cron expression in `trigger_config`, GCP Cloud Scheduler calls `sable-core` `/pipelines/:id/run` at the configured time
- Event triggers: GCP Pub/Sub subscription — `sable-core` runs pipeline when matching event received (e.g., `portfolio.updated`, `price.threshold.crossed`)

---

## 9. Notes

**How to build:**
- Flutter: `flutter_quill` package for rich text blocks (Notion-style)
- Storage:
```sql
CREATE TABLE workspace_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID REFERENCES workspace_pages(id),
  user_id UUID NOT NULL,
  content JSONB NOT NULL,  -- Quill Delta format
  linked_asset_id TEXT,    -- ticker, property ID, etc.
  linked_asset_type TEXT,  -- 'ticker', 'property', 'holding'
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```
- Attach files: upload to GCS, store URL in note content
- Search: PostgreSQL full-text search on note content
- Collaborative: `note_access` table with `note_id`, `user_id`, `permission` for multi-user firms

---

## 10. Data Import & Connections

### 10.1 CSV Holdings Import

**How to build:**
- Flutter: `file_picker` package, user selects CSV file
- Parse CSV in Flutter using `csv` package
- Detect columns: map common broker export formats to Sable schema (ticker, quantity, avg cost, currency)
- Preview: show parsed data in a confirmation table before importing
- POST parsed holdings to `sable-core` `/portfolio/import`
- `sable-core` validates, deduplicates against existing positions, inserts into `holdings` table

### 10.2 IBKR Read-Only Connection (Optional)

**How to build:**
- `sable-sc` service calls IBKR Web API with user's IBKR credentials (stored encrypted in `user_integrations` table)
- Pull: account balances, positions, P&L, trade history
- Sync: on user request or on a 15-minute schedule via Cloud Scheduler
- Merge: combine IBKR positions with any manually imported CSV positions without duplication
- Never store IBKR credentials in plaintext — encrypt with GCP Cloud KMS

### 10.3 Manual Position Entry

**How to build:**
- Flutter: form modal with ticker autocomplete (from EODHD), quantity, average cost, currency
- POST to `sable-core` `/portfolio/positions`

---

## 11. Alerts & Notifications

**How to build:**
- `sable-core` alert engine: background service polling EODHD prices every 60 seconds
- Alert schema:
```sql
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  alert_type TEXT NOT NULL,  -- 'price', 'portfolio', 'news', 'custom'
  condition JSONB NOT NULL,  -- { ticker: 'AAPL', operator: '>', value: 200 }
  delivery TEXT[] DEFAULT '{"in_app"}',  -- 'in_app', 'email'
  is_active BOOL DEFAULT true,
  triggered_at TIMESTAMPTZ
);
```
- Price alerts: compare current price from EODHD against condition, trigger if met
- Portfolio alerts: subscribe to `portfolio.updated` Pub/Sub topic, evaluate drawdown/concentration
- News alerts: EODHD news API polled every 15 minutes, match keywords against held tickers
- Custom command alerts: after pipeline execution, evaluate output against condition
- Delivery: in-app via WebSocket push to connected Flutter client, email via SendGrid

---

## 12. Sharing & Collaboration

### 12.1 Share Workspace Page with Client

**How to build:**
- `sable-core` generates a signed share token: `share_tokens` table with `token`, `page_id`, `expires_at`, `is_read_only: true`
- Flutter web renders workspace page at `/shared/:token` with all write operations disabled
- Token can be revoked by deleting from `share_tokens`

### 12.2 Cross-Firm Command & Pipeline Sharing

**How to build:**
- `pipeline_shares` table: `pipeline_id`, `shared_with_user_id` OR `shared_with_org_id`, `permission` ('view', 'clone')
- Share via: enter another Sable user's email or firm name in share dialog
- Recipient sees shared pipelines in their library under "Shared with me"
- Clone: recipient can clone a shared pipeline into their own library and edit freely

### 12.3 Role-Based Access Within a Firm

**How to build:**
- 5 default roles: Owner, Admin, Analyst, Trader, Viewer
- `org_roles` table defines permissions per role (read workspace, write workspace, run commands, manage users etc.)
- `org_members` table: `user_id`, `org_id`, `role`
- Gateway middleware checks role permissions on every request
- Custom roles: org admin can create roles in `org_roles` with custom permission sets

### 12.4 Comments on Widgets and Notes

**How to build:**
- `comments` table: `entity_id` (widget or note ID), `entity_type`, `user_id`, `content`, `created_at`
- Flutter: comment thread panel slides in from right on clicking comment icon on widget/note
- Real-time: new comments pushed via WebSocket to all firm members with that page open

---

## 13. Personalisation

**How to build:**
- All settings stored in `user_settings` JSONB column in `sable-core` users table
- REST endpoint: `PATCH /user/settings`

| Setting | Type | Default |
|---|---|---|
| `theme` | ENUM | 'dark' |
| `workspace_dock_position` | ENUM | 'right' |
| `workspace_size` | FLOAT | 320 |
| `default_layout_mode` | ENUM | 'grid' |
| `keyboard_shortcuts` | JSONB | {} |
| `notifications_email` | BOOL | true |
| `notifications_in_app` | BOOL | true |
| `chatbot_enabled` | BOOL | true |

- Firm branding (name, logo) stored in `org_settings` table
- Logo uploaded to GCS, URL stored in `org_settings.logo_url`
- Shared client dashboards render firm branding in header

---

## Service Ownership Summary

| Feature | Service | Database |
|---|---|---|
| Pages, widgets, config | sable-core | sable-core PostgreSQL |
| Notes, scripts | sable-core | sable-core PostgreSQL |
| Pipelines, alerts | sable-core | sable-core PostgreSQL |
| Share tokens, roles | sable-core | sable-core PostgreSQL |
| AI Chatbot | sable-core → Claude/Vertex AI | session only |
| Vertex AI commands | sable-core → Vertex AI | sable-core |
| Python execution | sable-sandbox | none (stateless) |
| S&C widget data | sable-sc → EODHD | sable-sc PostgreSQL |
| Property widget data | sable-re → Land Registry/ONS | sable-re PostgreSQL |
| Tax widget data | sable-tax → HMRC | sable-tax PostgreSQL |
| Quant engine | sable-quant (Python FastAPI) | none (stateless) |
| File uploads | GCS | URL in sable-core |

---

*Sable Terminal — Workspace specification — May 2026*
