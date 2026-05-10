# Sable Terminal — Full System Documentation

> Version 1.0 — Pre-build reference — May 2026
> Authors: Tommy Rowe, Chris Thomson

---

## 1. What Sable Is

Sable Terminal is a multi-asset quantitative operating system and wealth management infrastructure platform. It is not a dashboard, a reporting tool, or a data viewer. It is the complete institutional infrastructure that boutique fund managers, UHNW individuals and serious alternative asset investors need to manage capital across every investable asset class from a single configurable environment.

**The core thesis:** Institutional-grade infrastructure has historically required institutional-scale budgets. Aladdin costs tens of millions per year. Bloomberg costs £19,000 per seat. Limina starts at $39,000 per year. The boutique fund manager, the UHNW individual, and the serious property investor have no equivalent. Sable is that equivalent at £999 per seat per month.

---

## 2. Product Philosophy

| Principle | Definition |
|---|---|
| Configurability over convention | No fixed workflows. The user defines how Sable works. |
| Rigour over impressiveness | Every calculation is mathematically correct. Every limitation is explicit. |
| Network over isolation | The platform becomes more valuable as more users join. |
| Modularity over fixed paths | Any module can be the entry point. No asset class is primary. |

---

## 3. Service Architecture

Each service is its own Git repo, its own Cloud Run deployment, its own Docker container and its own PostgreSQL database.

```
sable-gateway        ← Express, auth via Clerk, routing, access control
sable-core           ← workspace, clients, portfolios, billing, Pub/Sub orchestration
sable-sc             ← S&C module — equity holdings, EODHD data, quant analytics
sable-re             ← Property module — property holdings, valuations, maps, deal network
sable-crypto         ← Crypto module — holdings via exchange API, on-chain analytics
sable-alt            ← Alternatives module — manual holdings, AI valuation
sable-quant          ← Python FastAPI — quant engine (Monte Carlo, Black-Litterman etc.)
sable-sandbox        ← Python FastAPI — isolated user script execution
sable-frontend       ← Flutter — desktop and web from one codebase
```

### Service Communication

```
Flutter (desktop / web)
        ↓  REST / WebSocket
sable-gateway                ← single entry point for all client requests
    ↓ REST (sync)
sable-core / sable-sc / sable-re / sable-crypto / sable-alt / sable-quant / sable-sandbox
    ↓ GCP Pub/Sub (async)
Cross-module events:
  price.updated
  holdings.imported
  portfolio.updated
  tax.recalculate
  report.generate
  certification.trigger
```

---

## 4. Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | Flutter (Desktop + Web) | Single codebase, native desktop performance |
| Backend API | Node.js + TypeScript | Express framework |
| API Architecture | REST + WebSocket | REST for sync, WebSocket for streaming |
| Repos | Separate per service | Independent deployment and scaling |
| Deployment | GCP Cloud Run (serverless) | Scales to zero, simple start |
| Database | Separate PostgreSQL per service | Full isolation between modules |
| Inter-service sync | REST | Immediate response needed |
| Inter-service async | GCP Pub/Sub | Cross-module events and updates |
| Auth | Clerk | JWT, short-lived tokens, SSO |
| Quant engine | Python + FastAPI | Best quant ecosystem (pandas, scipy, numpy) |
| Python sandbox | Docker + restricted Python | Isolated user script execution |
| Cache | Redis (GCP Memorystore) | Market data cache, session state |
| Real-time | WebSocket (Node.js) | Live price and portfolio streaming |
| AI — terminal | Claude API (claude-sonnet-4-6) | Chatbot, command AI, report interpretation |
| AI — commands | Vertex AI (Gemini) | Natural language command resolution |
| File storage | GCS (Google Cloud Storage) | Documents, exports, report templates |
| Hosting region | GCP US East (us-east1) | Low latency to US and UK markets |
| Equity/quant data | EODHD Enterprise (£2,499/month) | All asset classes, unlimited API calls, redistribution rights |
| Dev data | EODHD demo key | Free, covers AAPL/TSLA/VTI/AMZN/BTC-USD/EURUSD |
| Property data | Land Registry + ONS + EPC + Planning Portal | UK property data, largely free |
| Position sync | IBKR Web API (read-only, optional per user) | Live position sync where user has IBKR |

---

## 5. Data Layer — Module Ownership Model

Each module owns the holdings and analytics for its asset class. sable-core owns the client/portfolio hierarchy and orchestrates aggregation.

### Ownership Table

| Data | Owner |
|---|---|
| Firm and user accounts | sable-core |
| Client records | sable-core |
| Portfolio metadata (name, type, currency) | sable-core |
| Equity holdings and prices | sable-sc |
| Property holdings and valuations | sable-re |
| Crypto holdings and prices | sable-crypto |
| Alternative asset holdings and AI valuations | sable-alt |
| Workspace pages, blocks, widgets | sable-core |
| Scripts, pipelines, notes | sable-core |
| Tax calculations and MTD data | sable-tax (Sable Tax / QuixMTD) |
| Unified portfolio view | sable-core orchestrates, modules provide |

### Client and Portfolio Hierarchy

```
Organisation (the firm using Sable)
└── Client A
│   ├── Portfolio: ISA (type: equity)
│   │   └── Holdings → owned by sable-sc
│   ├── Portfolio: SIPP (type: equity)
│   │   └── Holdings → owned by sable-sc
│   └── Portfolio: Property (type: property)
│       └── Holdings → owned by sable-re
└── Client B
    └── Portfolio: Mixed (type: mixed)
        ├── Equity holdings → sable-sc
        └── Crypto holdings → sable-crypto
```

### Unified Portfolio — How It Works

sable-core calls each active module in parallel and aggregates on the fly:

```javascript
// sable-core GET /portfolio/unified/:clientId
const [equities, properties, crypto, alternatives] = await Promise.all([
  fetch(`${SC_URL}/client/${clientId}/portfolio`),
  fetch(`${RE_URL}/client/${clientId}/portfolio`),
  fetch(`${CRYPTO_URL}/client/${clientId}/portfolio`),
  fetch(`${ALT_URL}/client/${clientId}/portfolio`)
])

return {
  total_value_gbp: equities.total + properties.total + crypto.total + alternatives.total,
  by_module: { equities, properties, crypto, alternatives },
  last_updated: new Date()
}
```

sable-core never stores holdings. It calls each module and aggregates the result.

---

## 6. Data Ingestion by Module

### S&C Module — CSV Import from Brokers

All CSVs go to sable-core first. sable-core detects the broker, normalises the rows and routes equity rows to sable-sc. Users who do not own the S&C module cannot import.

**Three-tier import system:**

```
Tier 1: Auto-detect known broker → auto-map and preview
Tier 2: Unknown broker → column mapping UI (user maps manually)
Tier 3: Save custom broker mapping → auto-detected next time
```

**Known broker formats handled:**
- Hargreaves Lansdown
- Interactive Brokers
- AJ Bell
- Vanguard
- Fidelity

**Number format handling:**
```javascript
function parseCurrency(val) {
  return parseFloat(val.toString().replace(/[£$€,\s]/g, '').trim())
}
```

**ISIN to ticker resolution:**
```javascript
async function resolveAsset(identifier) {
  if (isISIN(identifier)) return await eodhd.searchByISIN(identifier)
  return identifier
}
```

### Crypto Module — Configurable Exchange Integrations

Like Zapier. User connects exchange by entering a read-only API key. Module pulls holdings automatically.

**Supported exchanges:** Binance, Coinbase, Kraken, Gemini, OKX

Keys stored encrypted in GCP Secret Manager. Read-only permissions only. Never touches trade execution.

### Property Module — Manual Entry + Automated Valuation

User enters: address, purchase price, purchase date, improvements.

Sable estimates current value using Land Registry comparable sales data, calculates using a simple AVM (Automated Valuation Model). Estimate clearly labelled as estimate with confidence range. User can override at any time.

**Note: Valuations are periodic, not real-time. Quant finance on property uses portfolio-level scenario analysis and regional growth rate modelling rather than real-time price feeds. Approach to be finalised.**

### Alternatives Module — Manual Import + AI Valuation

User enters: asset type, description, purchase price, purchase date, condition.

Vertex AI searches recent auction results, dealer listings and market data. Returns estimated value range with sources. User confirms or overrides.

```javascript
// sable-alt — AI valuation
const result = await vertexAI.generate(prompt, {
  tools: [{ type: 'web_search' }]
})
return {
  estimated_value_low:  result.range.low,
  estimated_value_high: result.range.high,
  comparables:          result.examples,
  confidence:           result.confidence,
  sources:              result.sources,
  last_updated:         new Date()
}
```

---

## 7. Module Access Control

The gateway enforces module access before routing any request.

```javascript
// sable-gateway middleware
async function checkModuleAccess(req, res, next) {
  const user = await getUser(req.userId)
  const module = req.params.module  // 'sc', 're', 'crypto', 'alt'
  if (!user.activeModules.includes(module)) {
    return res.status(403).json({
      error: 'Module not activated',
      upgrade_url: '/billing/modules'
    })
  }
  next()
}
```

Flutter hides all module UI for inactive modules. No locked screens, no dead buttons — only what the user has paid for.

---

## 8. Pricing Architecture

| Tier | Price | Who |
|---|---|---|
| Any single module | £999/seat/month | Everyone — individual or firm |
| Additional modules | Discounted add-on | Any active customer |
| Annual commitment | 2 months free | Annual subscribers |
| Founding customer rate | £799/seat/month | First 10 firms only — structured programme |
| Enterprise (10,000+ seats) | Custom ACV | Negotiate annual contract value, not per-seat |

**Rule:** Never discount the £999 base rate outside the founding customer programme. Annual discounts and volume discounts are structural, not negotiated per conversation.

---

## 9. Application Layout

The application is split into two persistent panels:

**Module view (primary):** Always visible, always shows live data. Contains the collapsible sidebar (module switcher, screen navigation, search bar) and the active module's data screens.

**Workspace (secondary):** A dockable, detachable companion panel. Can be docked left, right, top or bottom; fullscreened; detached to a second monitor; or closed entirely. Persists across all modules and sessions.

### Sidebar Structure

```
🔍 Search
── Modules ──
📈 S&C          ← active module highlighted
🏠 Property
₿  Crypto
💎 Alternatives
🧾 Tax
── S&C Screens ──
  Portfolio
  Markets
  Research
  Risk
  Reports
[← Collapse]
```

### Module Screens

| Module | Screens |
|---|---|
| S&C | Portfolio, Markets, Research, Risk, Reports |
| Property | Map View, Deal Pipeline, Portfolio, Market Intel, Reports |
| Crypto | Portfolio, Markets, On-Chain, Reports |
| Alternatives | Portfolio, Market Data, Deal Network, Reports |
| Tax | MTD Dashboard, CGT Tracker, Structuring, Reports |

---

## 10. Workspace

The workspace is a Notion-like companion panel. It stores no financial data — only configuration (what to show and where to get it from). All financial data is fetched live from the modules when the workspace renders.

### Workspace Page Content Format

Pages are stored as block-based JSON (JSONB in sable-core PostgreSQL). Users type Markdown-style input which is converted to structured blocks on the frontend using flutter_quill.

```json
{
  "blocks": [
    { "type": "heading",        "content": "Client A — Weekly Review" },
    { "type": "paragraph",      "content": "AAPL looking strong..." },
    { "type": "chart_widget",   "config": { "source_module": "sable-sc", "ticker": "AAPL" } },
    { "type": "command_output", "command": "/montecarlo @portfolio" },
    { "type": "holdings_table", "config": { "source_module": "sable-sc", "client_id": "uuid" } }
  ]
}
```

### Workspace Features

Full feature list and build plan: see `sable_workspace_features.md`

Key features:
- Multiple pages per workspace
- Free canvas mode and grid mode per page (user switches between them)
- Full widget system (15+ widget types) — all powered by live module data
- Four-tier command system (see Section 11)
- Pipeline builder with scheduling and cross-firm sharing
- Python sandbox (runs in sable-sandbox service)
- Notion-style rich text notes
- Configurable alerts
- Client dashboard sharing (read-only links)
- Role-based access within firms

---

## 11. Four-Tier Command System

Every command can target any asset: plain ticker, `@portfolio`, `@holding:TICKER`, `@index:SP500`, `@watchlist:name`, `@property:address`, `@all`.

### Tier 1 — AI Chatbot (Conversational)

Persistent chat panel in the workspace. Has read access to the user's workspace state — holdings, portfolio, notes, command outputs, tax position.

- Backend: sable-core WebSocket endpoint
- AI: Claude API for primary chatbot
- Context injected automatically: active module, portfolio state, recent commands, notes
- Can be disabled by org admin or by user in settings
- Conversation history persists per workspace page

### Tier 2 — Vertex AI Natural Language Command

User types natural language. Vertex AI resolves the intent and executes the correct underlying function.

- GCP Vertex AI with Gemini model and function calling enabled
- Function schemas defined for every available command
- Returns: which function to call + parameters extracted from natural language
- Tight GCP integration = low latency

### Tier 3 — Python Script

In-workspace code editor (code_text_field package in Flutter). User writes Python, sable-sandbox executes it in an isolated container.

- Data auto-injected: `data`, `ticker`, `portfolio`, `fundamentals`
- Allowed libraries: pandas, numpy, scipy, matplotlib, statsmodels, sklearn
- Forbidden imports blocked via AST validation before execution
- 30-second hard timeout
- Output streamed back via WebSocket

### Tier 4 — Flowchart Builder (No-Code Visual)

Drag pre-configured blocks together to build pipelines visually.

**Pre-configured block types:**

Data blocks: Fetch prices, Fetch fundamentals, Get portfolio, Get holdings, Get property data

Analysis blocks: Monte Carlo, Black-Litterman, Factor analysis, Risk metrics, Backtest, Yield analysis

Filter blocks: If value > threshold, If date is, Filter by sector, Filter by asset type

Action blocks: Send alert, Generate report, Save to notes, Run Python script, Send email, Post to Slack

---

## 12. Quantitative Finance by Module

### S&C — Full Institutional-Grade Quant

- Monte Carlo simulation (10,000 paths, configurable)
- Mean-variance optimisation (Markowitz)
- Black-Litterman Bayesian model
- Walk-forward backtesting
- Factor analysis and risk attribution
- VaR, CVaR, Sharpe ratio, max drawdown, beta
- Technical indicators (50+ via EODHD)
- Earnings calendar and fundamental screening

### Crypto — Full Quant Finance (Same Engine, Different Data)

- All standard quant techniques apply (Monte Carlo, mean-variance, Sharpe, VaR)
- 24/7 markets, continuous price feeds
- On-chain metrics as additional factors: MVRV ratio, NVT ratio, stock-to-flow (BTC)
- Funding rates from perpetual futures as sentiment signal
- Cross-exchange price spread analysis
- DeFi yield modelling
- BTC beta correlation for altcoins
- Portfolio inclusion in cross-asset mean-variance optimisation

### Property — Adapted Quant Finance (Regional and Portfolio Level)

**Note: Specific implementation to be finalised**

Portfolio-level Monte Carlo using regional growth rate scenarios from Land Registry data. Scenario analysis in place of VaR (what if values drop 20%, rates rise 3%). Yield analytics (gross yield, net yield, ROI) are precise and calculable. Mean-variance optimisation treating each property as an asset with a return series derived from regional historical data and rental yields. Leverage and mortgage stress testing.

Standard VaR at individual property level does not apply — properties are illiquid and individually unique. All quant output on property is explicitly labelled as scenario-based estimates, not live calculations.

### Alternatives — AI-Assisted Valuation Only at This Stage

Quant finance on alternatives (vintage cars, art, wine, watches) to be approached once the module is built and data sources are established.

---

## 13. Security

### API Security (Three Layers)

**Layer 1 — Short-lived JWT tokens (15-minute expiry)**
```javascript
jwt.verify(token, process.env.JWT_SECRET)  // on every request
```

**Layer 2 — HMAC request signing**
```javascript
// Flutter signs every request
const signature = hmacSha256(APP_SECRET, `${timestamp}:${method}:${path}:${bodyHash}`)
// Gateway validates — rejects requests older than 30 seconds
```

**Layer 3 — Certificate pinning (Flutter desktop)**
```dart
httpClient.badCertificateCallback = (cert, host, port) {
  return cert.sha256 == YOUR_CERT_FINGERPRINT
}
```

### Bot Detection

- Interaction telemetry: mouse movement variance and click timing collected passively. Too-perfect patterns flag a script.
- Request timing analysis: requests faster than 50ms apart, or perfectly regular intervals, trigger suspicious flag.
- Hardware attestation: device model, CPU cores, system GUID collected on login. Known VM/headless signatures flagged.
- Session behaviour scoring: accounts active 24/7 at identical intervals or with no mouse events accumulate a suspicion score that triggers manual review.

### XSS Prevention

- Flutter renders to a native canvas, not a DOM. Standard DOM XSS does not apply to the desktop app.
- Web version: helmet.js, DOMPurify, Content Security Policy headers.
- WebViews: JavaScript disabled unless strictly required.
- flutter_quill stores Quill Delta JSON — not raw HTML. No XSS surface in the notes editor.
- All external data (EODHD news, company descriptions) stripped of HTML before rendering.

---

## 14. Data Sources

| Module | Source | Cost |
|---|---|---|
| S&C equities, indices, forex | EODHD Enterprise | £2,499/month |
| Crypto | EODHD Enterprise + exchange APIs | Included |
| Fundamentals | EODHD Enterprise | Included |
| Property UK | Land Registry, ONS, EPC, Planning Portal | Free |
| Tax / MTD | HMRC APIs (existing QuixMTD) | Free |
| Position sync | IBKR Web API read-only (optional) | Free |
| Development | EODHD demo key (AAPL/TSLA/VTI/AMZN/BTC-USD/EURUSD) | Free |

**Upgrade trigger:** Switch from demo key to EODHD Enterprise the day the first customer pays. First customer revenue (minimum 3 seats × £999 = £2,997/month) covers the cost immediately.

---

## 15. Ecosystem

Sable Terminal is one product within a broader institutional ecosystem.

| Product | Status | Description |
|---|---|---|
| Sable Terminal | Building | The core platform — this document |
| Sable Tax | Live (as QuixMTD) | MTD compliance for landlords and sole traders. Run by Fin and Ollie. Feeds tax data into the terminal. |
| Sable Institute | Planned Stage 2 | Certification programme. Tamper-proof, cryptographically verifiable. Usage hours trigger eligibility. |
| Sable Intelligence | Planned Stage 3 | Newsletter, magazine, 30 Under 30, Annual Summit |
| Sable Light | Planned Stage 5 | Consumer retail platform. Gro reborn on institutional infrastructure. |

---

## 16. Go-to-Market

**Phase 1 (Now — August 2026):** US + UK simultaneous launch

- Tommy: US market from Babson, Boston finance community (Fidelity, State Street, Wellington, AQR)
- Chris: UK market, London boutique fund managers, national partnership network
- Target: 3 paying customers before August
- Target buyer: ex-institutional boutique managers, 2-10 people, £50M-£500M AUM

**Demo strategy:**
1. Ask about their current analytical workflow (SPIN — Situation)
2. Surface the pain (Problem and Implication)
3. Let them articulate the value of solving it (Need-Payoff)
4. Demo directly against what they just told you
5. Killer feature: `/montecarlo AAPL` → full Monte Carlo output in under 10 seconds

**Phase 2 (2027-2028):** Singapore + UAE/Dubai

**Phase 3 (2028-2029):** Spain + EU via MiFID II passporting

**Future:** Own brokerage (FCA + SEC + MAS + DFSA), Sable Institute certification, data licensing to third parties, marketplace transaction fees on deal network.

---

## 17. Team

| Person | Role | Focus |
|---|---|---|
| Tommy Rowe (50%) | Co-founder, builder | Product, engineering, US market |
| Chris Thomson (50%) | Co-founder, COO | UK market, sales, operations |
| Fin | Engineer | QuixMTD / Sable Tax maintenance |
| Ollie | Sales and operations | QuixMTD / Sable Tax growth |

---

*Sable Terminal — Full system documentation — May 2026 — Confidential*
