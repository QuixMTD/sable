# sable-core — Service Feature Specification

> The central orchestration service. sable-core owns the client hierarchy, workspace, billing, cross-module aggregation and all shared infrastructure. It never stores financial holdings — those live in each module. It orchestrates everything else.

---

## What sable-core Owns

| Data | Owned by sable-core |
|---|---|
| Organisations and firm accounts | ✅ |
| Users and user settings | ✅ |
| Client records (firm's clients) | ✅ |
| Portfolio metadata (name, type, currency) | ✅ |
| Workspace pages and blocks | ✅ |
| Widget configurations | ✅ |
| Scripts, pipelines, notes | ✅ |
| Alerts and notification settings | ✅ |
| Share tokens and permissions | ✅ |
| Broker CSV mappings | ✅ |
| Certification tracker | ✅ |
| Billing and module subscriptions | ✅ |
| Equity holdings | ❌ sable-sc |
| Property holdings | ❌ sable-re |
| Crypto holdings | ❌ sable-crypto |
| Alt holdings | ❌ sable-alt |
| Quant calculations | ❌ sable-quant |
| Script execution | ❌ sable-sandbox |

---

## 1. Organisation and User Management

```sql
CREATE TABLE organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  logo_url TEXT,
  chatbot_enabled BOOL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id),
  clerk_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'analyst',  -- owner, admin, analyst, trader, viewer
  active_modules TEXT[] DEFAULT '{"sc"}',
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**User settings JSONB schema:**
```json
{
  "theme": "dark",
  "workspace_dock_position": "right",
  "workspace_size": 320,
  "default_layout_mode": "grid",
  "keyboard_shortcuts": {},
  "notifications_email": true,
  "notifications_in_app": true,
  "chatbot_enabled": true
}
```

---

## 2. Client and Portfolio Hierarchy

```sql
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL,
  reference TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  type TEXT,        -- 'equity', 'property', 'crypto', 'alt', 'mixed'
  currency TEXT DEFAULT 'GBP',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Portfolios contain metadata only. Holdings live in each module's own database, referenced by `portfolio_id`.

---

## 3. Unified Portfolio Endpoint

sable-core calls each active module in parallel and aggregates on the fly. No holdings are stored here.

```javascript
// GET /portfolio/unified/:clientId
async function getUnifiedPortfolio(clientId) {
  const user = await getUser(req.userId)
  const calls = []

  if (user.activeModules.includes('sc'))     calls.push(fetch(`${SC_URL}/client/${clientId}/portfolio`))
  if (user.activeModules.includes('re'))     calls.push(fetch(`${RE_URL}/client/${clientId}/portfolio`))
  if (user.activeModules.includes('crypto')) calls.push(fetch(`${CRYPTO_URL}/client/${clientId}/portfolio`))
  if (user.activeModules.includes('alt'))    calls.push(fetch(`${ALT_URL}/client/${clientId}/portfolio`))

  const results = await Promise.all(calls)

  return {
    total_value_gbp: results.reduce((sum, r) => sum + r.total, 0),
    by_module:       results,
    last_updated:    new Date()
  }
}
```

---

## 4. CSV Import — Broker Detection and Routing

All broker CSV files land in sable-core first. sable-core detects the broker, normalises and routes to the correct module.

### Broker Detection

```javascript
const KNOWN_BROKERS = {
  hargreaves_lansdown: {
    detect: (h) => h.includes('Stock') && h.includes('Units'),
    map: { ticker: 'Stock', quantity: 'Units', current_value: 'Value (£)', currency: () => 'GBP', asset_type: () => 'equity' }
  },
  interactive_brokers: {
    detect: (h) => h.includes('Symbol') && h.includes('Mult'),
    map: { ticker: 'Symbol', quantity: 'Quantity', current_value: 'Value in GBP', currency: 'Currency', asset_type: () => 'equity' }
  },
  ajbell: {
    detect: (h) => h.includes('Security') && h.includes('Book Cost'),
    map: { ticker: 'Security', quantity: 'Quantity', current_value: 'Market Value', avg_cost: 'Book Cost', currency: () => 'GBP', asset_type: () => 'equity' }
  },
  vanguard: {
    detect: (h) => h.includes('Investment Name') && h.includes('Shares'),
    map: { ticker: 'Symbol', quantity: 'Shares', current_value: 'Total Value', avg_cost: 'Cost Basis', currency: () => 'GBP', asset_type: () => 'equity' }
  },
  fidelity: {
    detect: (h) => h.includes('Symbol') && h.includes('Cost Basis'),
    map: { ticker: 'Symbol', quantity: 'Quantity', current_value: 'Current Value', avg_cost: 'Cost Basis Per Share', currency: 'Currency', asset_type: () => 'equity' }
  }
}
```

### Custom Broker Mappings (User-Defined)

```sql
CREATE TABLE broker_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id),
  is_global BOOL DEFAULT false,
  broker_name TEXT NOT NULL,
  detect_columns TEXT[],
  column_map JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Unknown brokers trigger a column mapping UI in Flutter. Once mapped and named, saved to `broker_mappings` for auto-detection next time.

### CSV Routing

```javascript
async function routeCSV(normalisedRows, clientId, portfolioId) {
  const equities = normalisedRows.filter(r => r.asset_type === 'equity')
  const property = normalisedRows.filter(r => r.asset_type === 'property')
  const crypto   = normalisedRows.filter(r => r.asset_type === 'crypto')
  const alt      = normalisedRows.filter(r => r.asset_type === 'alt')

  await Promise.all([
    equities.length && fetch(`${SC_URL}/client/${clientId}/holdings/import`,     { body: equities }),
    property.length && fetch(`${RE_URL}/client/${clientId}/holdings/import`,     { body: property }),
    crypto.length   && fetch(`${CRYPTO_URL}/client/${clientId}/holdings/import`, { body: crypto }),
    alt.length      && fetch(`${ALT_URL}/client/${clientId}/holdings/import`,    { body: alt })
  ])
}
```

---

## 5. Workspace — Pages and Blocks

```sql
CREATE TABLE workspace_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  layout_mode TEXT DEFAULT 'grid',  -- 'canvas' or 'grid'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workspace_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES workspace_pages(id),
  widget_type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  x FLOAT, y FLOAT,
  width FLOAT, height FLOAT,
  col_start INT, col_span INT,
  row_start INT, row_span INT,
  is_locked BOOL DEFAULT false,
  position INT DEFAULT 0
);
```

Widget config stores only what data to fetch and how to display it — not the data itself.

**Example widget config:**
```json
{
  "widget_type": "holdings_table",
  "config": {
    "source_module": "sable-sc",
    "client_id": "uuid-client-a",
    "data_type": "equity_holdings",
    "columns": ["ticker", "quantity", "current_value", "pnl_pct"]
  }
}
```

---

## 6. Scripts, Pipelines and Notes

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

CREATE TABLE pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  graph JSONB NOT NULL,       -- nodes, edges, configs for flowchart builder
  trigger_type TEXT,          -- 'manual', 'scheduled', 'event'
  trigger_config JSONB,       -- cron expression or event topic
  is_shared BOOL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pipeline_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id),
  shared_with_org_id UUID REFERENCES organisations(id),
  permission TEXT DEFAULT 'view'  -- 'view', 'clone', 'edit'
);

CREATE TABLE pipeline_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id),
  graph JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workspace_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID REFERENCES workspace_pages(id),
  user_id UUID NOT NULL,
  content JSONB NOT NULL,       -- Quill Delta format
  linked_asset_id TEXT,
  linked_asset_type TEXT,       -- 'ticker', 'property', 'holding'
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 7. Command History

```sql
CREATE TABLE command_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  command TEXT NOT NULL,
  target TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);
```

REST endpoint: `GET /commands/history?limit=50`

---

## 8. AI Chatbot

```javascript
// sable-core POST /chat (WebSocket)
async function handleChatMessage(userId, message) {
  const user    = await getUser(userId)
  const org     = await getOrg(user.org_id)

  // Check both org and user toggles
  if (!org.chatbot_enabled || !user.settings.chatbot_enabled) {
    return { error: 'Chatbot disabled' }
  }

  // Build context from workspace state
  const context = {
    active_module: user.active_module,
    portfolio_summary: await getUnifiedPortfolio(userId),
    recent_commands: await getRecentCommands(userId, 5),
    recent_notes: await getRecentNotes(userId, 3)
  }

  // Call Claude API with context as system prompt
  const response = await claudeAPI.message({
    system: buildSystemPrompt(context),
    messages: [{ role: 'user', content: message }]
  })

  // Stream tokens back via WebSocket
  return streamResponse(response)
}
```

Chatbot access controls:
- `org_settings.chatbot_enabled` — org admin disables for all users
- `user_settings.chatbot_enabled` — individual user disables for themselves
- Org setting overrides user setting

---

## 9. Alerts

```sql
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  alert_type TEXT NOT NULL,     -- 'price', 'portfolio', 'news', 'custom'
  condition JSONB NOT NULL,     -- { ticker: 'AAPL', operator: '>', value: 200 }
  delivery TEXT[] DEFAULT '{"in_app"}',
  is_active BOOL DEFAULT true,
  triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Alert engine: background service polling EODHD prices every 60 seconds, subscribing to `portfolio.updated` Pub/Sub topic.

Delivery:
- In-app: WebSocket push to connected Flutter client
- Email: SendGrid

---

## 10. Sharing and Permissions

```sql
-- Read-only client dashboard links
CREATE TABLE share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  page_id UUID REFERENCES workspace_pages(id),
  expires_at TIMESTAMPTZ,
  is_read_only BOOL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Role-based access within firms
CREATE TABLE org_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id),
  role_name TEXT NOT NULL,
  permissions JSONB NOT NULL  -- { read_workspace: true, run_commands: true, manage_users: false }
);
```

**Default roles:** Owner, Admin, Analyst, Trader, Viewer

Org admins can create custom roles with any permission combination.

---

## 11. Certification Tracker

```sql
CREATE TABLE certification_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  session_hours FLOAT DEFAULT 0,
  commands_run INTEGER DEFAULT 0,
  pipelines_built INTEGER DEFAULT 0,
  certification_level TEXT,   -- 'associate', 'professional', 'expert'
  eligible_at TIMESTAMPTZ,
  certified_at TIMESTAMPTZ
);
```

Usage hours logged on every command execution and session activity. Thresholds trigger certification eligibility notification. Certification records written to tamper-proof ledger (Sable Institute — Stage 2).

---

## 12. GCP Pub/Sub Topics Owned by sable-core

| Topic | Publisher | Subscribers |
|---|---|---|
| `holdings.imported` | sable-core (after CSV routing) | sable-sc, sable-re, sable-crypto, sable-alt |
| `portfolio.updated` | Each module | sable-core (triggers unified view refresh) |
| `price.updated` | sable-sc, sable-crypto | sable-core (updates alert engine) |
| `tax.recalculate` | sable-core | sable-tax |
| `report.generate` | sable-core | All modules (gather data for report) |
| `certification.trigger` | sable-core | sable-core (log certification event) |

---

## 13. REST API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | /portfolio/unified/:clientId | Aggregate portfolio from all active modules |
| GET | /clients | List all clients for org |
| POST | /clients | Create client |
| GET | /clients/:id/portfolios | List portfolios for client |
| POST | /csv/import | Upload and route CSV |
| POST | /chat | AI chatbot WebSocket endpoint |
| GET | /workspace/pages | List workspace pages |
| POST | /workspace/pages | Create page |
| PATCH | /workspace/pages/:id | Update page |
| GET | /workspace/widgets/:pageId | List widgets for page |
| POST | /workspace/widgets | Create widget |
| PATCH | /workspace/widgets/:id | Update widget config |
| GET | /pipelines | List user pipelines |
| POST | /pipelines/:id/run | Execute pipeline |
| GET | /commands/history | Command history |
| POST | /alerts | Create alert |
| POST | /share | Generate share token |
| GET | /user/settings | Get user settings |
| PATCH | /user/settings | Update user settings |
| GET | /certification | Get certification status |

---

*sable-core service specification — May 2026*
