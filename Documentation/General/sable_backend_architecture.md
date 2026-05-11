# Sable Terminal — Backend Architecture

> Separate microservices. Each service is its own repo, its own Cloud Run container, its own database.

---

## Service Map

```
sable-gateway/        ← Express, auth, routing, access control
sable-core/           ← workspace, users, billing, Pub/Sub
sable-sc/             ← S&C module, EODHD integration
sable-re/             ← property module, maps, deal network
sable-quant/          ← Python FastAPI, Monte Carlo, Black-Litterman
sable-sandbox/        ← Python execution engine
sable-frontend/       ← Flutter, desktop + web
```

Each service:
- Its own Git repo
- Its own Cloud Run deployment
- Its own Docker container
- Its own PostgreSQL database
- Communicates via REST (sync) or GCP Pub/Sub (async)

---

## Core Decisions

| Decision | Choice |
|---|---|
| Framework | Express (Node.js + TypeScript) |
| API | REST + WebSocket |
| Repos | Separate per service |
| Deployment | GCP Cloud Run (serverless, scales to zero) |
| Database | Separate PostgreSQL per service |
| Inter-service sync | REST |
| Inter-service async | GCP Pub/Sub |
| Auth | Clerk |
| Market data | EODHD Enterprise (£2,499/month, unlimited API calls) |
| Dev data | EODHD demo key (free, 6 tickers) |
| Property data | Land Registry, ONS, EPC, Planning APIs (free) |
| Position sync | Interactive Brokers API (read-only, optional per user) |
| Frontend | Flutter (desktop + web, single codebase) |

---

## How Services Talk to Each Other

```
Flutter (desktop/web)
        ↓  REST / WebSocket
sable-gateway          ← single entry point for all client requests
    ↓ REST             ← sync calls (need immediate response)
sable-core             ← workspace, users, billing
sable-sc               ← S&C module
sable-re               ← property module
sable-quant            ← quant engine
sable-sandbox          ← Python execution
    ↓ Pub/Sub          ← async events (cross-module features)
    portfolio-updated
    tax-recalculate
    report-generate
    certification-trigger
```

---

## Python Sandbox — How It Works

### The Problem

You cannot run user Python inside Node.js. The sandbox is a **separate Cloud Run service** (`sable-sandbox`) — a Python FastAPI app. Node.js calls it via REST.

### The Flow

```
User writes Python in Flutter editor
        ↓
Flutter sends code + target to sable-gateway
        ↓
Gateway calls sable-sandbox POST /execute
        ↓
Sandbox validates → injects data → runs → returns output
        ↓
Gateway streams output back to Flutter via WebSocket
```

### What the Sandbox Does

1. Receives user code as a string
2. Validates it via AST (blocks dangerous imports)
3. Fetches the target data (stock prices, portfolio, etc.) from EODHD / database
4. Injects that data as a `data` variable the user can reference
5. Runs the code in an isolated subprocess with a 30-second timeout
6. Returns stdout, stderr, return code

### The Sandbox Service (`sable-sandbox` — Python FastAPI)

```python
from fastapi import FastAPI
import subprocess, ast, json, tempfile, os

app = FastAPI()

FORBIDDEN = {
    'os', 'subprocess', 'socket', 'sys',
    'shutil', 'importlib', 'ctypes', 'builtins', 'threading'
}

ALLOWED = {
    'pandas', 'numpy', 'scipy', 'matplotlib',
    'statsmodels', 'sklearn', 'math', 'datetime', 'json'
}

def validate(code: str):
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mod = alias.name.split('.')[0]
                if mod in FORBIDDEN:
                    raise ValueError(f"'{mod}' is not permitted")
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or '').split('.')[0]
            if mod in FORBIDDEN:
                raise ValueError(f"'{mod}' is not permitted")

@app.post("/execute")
async def execute(req: dict):
    code    = req['code']
    context = req['context']   # injected by gateway — stock data, portfolio, etc.

    validate(code)

    # Inject the data before running user code
    injected = f"data = {json.dumps(context)}\nticker = '{context.get('ticker', '')}'\n\n"
    full_code = injected + code

    with tempfile.NamedTemporaryFile(suffix='.py', mode='w', delete=False) as f:
        f.write(full_code)
        path = f.name

    try:
        result = subprocess.run(
            ['python3', path],
            capture_output=True,
            text=True,
            timeout=30,       # hard 30-second limit
            cwd='/tmp'
        )
    finally:
        os.unlink(path)

    return {
        'stdout':     result.stdout,
        'stderr':     result.stderr,
        'returncode': result.returncode
    }
```

### What the User Gets Injected Automatically

```python
# Sable pre-injects this before running user code
data = {
    'ticker':       'AAPL',
    'prices':       [...],        # OHLCV from EODHD
    'portfolio':    [...],        # user's holdings
    'fundamentals': {...}         # P/E, EV/EBITDA, margins etc.
}
ticker = 'AAPL'

# User then writes whatever they want:
import pandas as pd

df = pd.DataFrame(data['prices'])
returns = df['close'].pct_change()
annualised_vol = returns.std() * (252 ** 0.5)
print(f"Annualised volatility: {annualised_vol:.4f}")
```

### Cloud Run Security Config for Sandbox

```yaml
resources:
  limits:
    cpu: "1"
    memory: "512Mi"
timeoutSeconds: 35
maxInstances: 10

# No outbound network in sandbox container
# Read-only filesystem except /tmp
# Non-root user
```

### Node.js Gateway Call to the Sandbox

```javascript
// In sable-gateway — calling sable-sandbox
const response = await fetch(`${SANDBOX_URL}/execute`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    code: req.body.code,
    context: {
      ticker:       'AAPL',
      prices:       await getEOHDPrices('AAPL'),
      portfolio:    await getUserPortfolio(userId),
      fundamentals: await getEOHDFundamentals('AAPL')
    }
  })
})

const result = await response.json()

// Stream output back to Flutter via WebSocket
ws.send(JSON.stringify({ type: 'sandbox_output', ...result }))
```

---

## Command Execution Model

> **Status**: not yet built. This section describes the agreed shape so the schema and runtime can be implemented against a single picture.

Commands are the unit of executable work in Sable. There are four kinds, all logged to one place when they run.

| Kind | Source | Where it runs |
|---|---|---|
| `preconfigured` | platform-defined: `/montecarlo`, `/backtest`, `/risk`, `/factor`, `/blacklitterman`, `/property:value`, etc. — gated per-user by `active_modules` | gateway routes to the implementing service (sable-quant for analysis, sable-sc / sable-re / sable-crypto / sable-alt for module-specific data) |
| `pipeline` (graph) | user-built visual flowchart, stored in `core.pipelines` | sable-core walks the graph in topological order, calling each block's downstream service |
| `pipeline` (script) | user-written Python from the editor, stored in `core.pipelines` (`kind='script'`) | sable-sandbox subprocess |
| `ai_prompt` | user prose — Tier 1 chatbot turn or Tier 2 Vertex AI natural-language command | sable-core builds context, calls Claude / Vertex AI; the AI may resolve to one or more downstream command invocations as tool calls (each logged as a child of the prompt) |

**Where execution lives**: sable-core. Commands run in core's runtime but consume data from the module schemas (`sc.*`, `re.*`, `crypto.*`, `alt.*`) and identity from `gateway.*`. This is why the platform is one Postgres instance with schema-per-service — cross-schema reads from core are routine, cross-DB reads would not be.

**Run log**: every invocation, regardless of kind, writes a row to `core.command_history`. AI tool calls and pipeline-block sub-invocations link back to their parent via `parent_command_id` so the full invocation tree is reconstructible.

**Triggers**: `manual` (Cmd+K, chat send) · `scheduled` (Cloud Scheduler → `/pipelines/:id/run`) · `event` (Pub/Sub subscription, e.g. `portfolio.updated`).

**Schema deltas to apply when this is built** (deferred):
- `core.pipelines` absorbs the standalone `workspace_scripts` table via `kind text CHECK (kind IN ('graph','script'))`, with mutually-exclusive `graph jsonb` / `code text` and a CHECK that exactly one is populated. `pipeline_versions` mirrors.
- `core.command_history` becomes the unified run log: `command_kind ('preconfigured'|'pipeline'|'ai_prompt')`, `command_name` (preconfigured), `pipeline_id` (saved), `prompt_text` / `ai_model` / `ai_tier` (AI), `parent_command_id`, `trigger_source ('manual'|'cron'|'event'|'chat'|'nl_command'|'pipeline_block')`, `output jsonb`.
- Chatbot multi-turn conversation persistence is a separate decision (currently documented as session-only).

---

## Command Target Resolution

Commands can be run on any target. The `@` prefix references user-owned data. Plain text references market tickers.

| Command | Target |
|---|---|
| `/montecarlo AAPL` | Single ticker |
| `/montecarlo @portfolio` | User's full portfolio |
| `/montecarlo @holding:TSLA` | Specific holding |
| `/montecarlo @index:SP500` | An index |
| `/montecarlo @watchlist:tech` | Custom watchlist |
| `/montecarlo @property:123-main-st` | A property |
| `/montecarlo @all` | Entire book across all modules |

The gateway resolves the target before passing data to the quant engine or sandbox.

---

## User Models — Three Personas

Sable supports three user shapes. The schema must work for all three; module-level holdings tables inherit this through `portfolios`.

| Persona | `gateway.users.org_id` | Has clients? | Workspace context |
|---|---|---|---|
| **Org-firm user** | set | Yes — org-owned CRM clients | Pages can be personal, org-shared, or client-dashboard. Roles within the firm (owner/admin/analyst/trader/viewer). |
| **Independent advisor** | NULL | Yes — user-owned CRM clients | Same workspace surface as org users, but everything is personally owned. No org-shared layouts or templates unless they ever join a firm. |
| **Individual investor** | NULL | No | Personal pages tracking their own portfolios. No CRM. |

### Ownership pattern: `(org_id, user_id)` xor

Every core table whose rows can be owned by either a firm or an individual user follows the same shape:

```sql
org_id  uuid REFERENCES gateway.organisations(id) ON DELETE RESTRICT,
user_id uuid REFERENCES gateway.users(id) ON DELETE RESTRICT,
CHECK ((org_id IS NOT NULL) <> (user_id IS NOT NULL))   -- exactly one route
```

Tables using this pattern in `core`:
- `clients`
- `portfolios` *(three-way: also allows `client_id IS NULL` for the self-investor case)*
- `report_templates`
- `client_reports`

RLS for each follows the same three-policy template: a single combined `select` policy, plus separate `write_org` and `write_user` policies that gate on the populated branch.

### Deferred / known gaps

- **Parent-child `org_id` consistency** (e.g. `portfolios.org_id` must match `clients.org_id` for the same `client_id`) is not enforced by the DB. Composite foreign keys are awkward when nullable, and triggers add complexity. App-layer enforcement for now; revisit with a trigger if drift becomes a real problem.
- **`workspace_layouts`** is currently org-only. Independent advisors who want personal saved layouts use `workspace_pages` directly today. Extend with the same `(org_id, user_id)` xor when there's product demand.
- **Personal reports for individual investors** (e.g. tax summaries, HMRC reports) — `client_reports` requires `client_id NOT NULL`, so individual investors with no CRM clients have no path. Add a `personal_reports` table when the feature lands; don't generalise `client_reports` because its permissions / wire shape are CRM-centric.

### Module-level schemas (sc, re, crypto, alt)

When these are built, their holdings tables reference `core.portfolios(id)` directly. The portfolio row already encodes the access route (org / advisor / self), so module-level RLS can be a thin pass-through:

```sql
-- e.g. in sc.holdings
CREATE POLICY sc_holdings_select ON sc.holdings FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM core.portfolios p
    WHERE p.id = portfolio_id
      AND (
        (p.org_id IS NOT NULL AND p.org_id = app_org_id())
        OR p.user_id = app_user_id()
      )
  ) OR app_is_admin());
```

This keeps the persona logic in one place (`core.portfolios`) and out of every module schema.

### Module gating — not in the schema

There is no schema-level CHECK that gates writes by `active_modules`. The gateway enforces module entitlement at request time (`MODULE_NOT_ACTIVE` error code). Reasons:

- Downgrades must not break access to existing data
- Trials and admin overrides need to bypass entitlement
- The only `active_modules`-aware DB construct is the trigger preventing non-`webhook`/`system` actors from *writing* the array (so an org admin can't self-grant modules)

---

## Data Sources by Module

| Module | Source | Cost |
|---|---|---|
| S&C, Indices, Forex | EODHD Enterprise | £2,499/month |
| Crypto | EODHD Enterprise | included |
| Fundamentals | EODHD Enterprise | included |
| Property | Land Registry, ONS, EPC, Planning APIs | Free |
| Tax | HMRC APIs (existing QuixMTD) | Free |
| Position sync | IBKR read-only API (optional per user) | Free |

**Dev data:** EODHD demo key — free, covers AAPL, TSLA, VTI, AMZN, BTC-USD, EURUSD.
**Production:** Upgrade to EODHD Enterprise the day the first customer pays.

---

## Pricing Logic in the Gateway

Access control on every request:

```javascript
// sable-gateway middleware
async function checkModuleAccess(req, res, next) {
  const user = await getUser(req.userId)
  const requestedModule = req.params.module  // 'sc', 're', 'crypto', 'alt'

  if (!user.activeModules.includes(requestedModule)) {
    return res.status(403).json({ error: 'Module not activated' })
  }

  next()
}
```

Users only access modules they have paid for. The gateway enforces this before forwarding to any module service.

---

*Sable Terminal — Pre-build architecture reference — May 2026*
