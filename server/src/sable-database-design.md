# Sable Terminal — Database Design
**Version:** 1.0
**Engine:** PostgreSQL 16+
**ORM:** None — raw SQL only
**Region:** GCP US East (us-east1)
**Status:** Pre-build reference document

---

## Design Principles

**1. Scalability from day one**
Every high-volume table is partitioned before the first row is inserted. Partition now or rebuild later under load. Later is too late.

**2. No ORM**
Raw SQL only. Every query is written explicitly. No abstraction layer hiding what the database is doing. When you need performance you need to know exactly what is executing.

**3. Immutability for what matters**
The audit log and certification ledger are append-only. No updates. No deletes. Ever. Everything else supports soft deletes via deleted_at timestamps — nothing is hard deleted from the database.

**4. Data gravity**
Every piece of data belongs to either an organisation or a user. Nothing floats globally except built-in system data (built-in commands, market data cache, reference data). Every query starts with an organisation_id or user_id filter.

**5. JSONB for the right things**
JSONB is used for genuinely variable structure — command configurations, pipeline definitions, strategy parameters, dashboard layouts. It is not used as a lazy substitute for proper relational design. If a field is queried or filtered regularly it gets its own column.

**6. Indexes justify themselves**
Every index in this document exists for a specific reason — either a common query pattern, a foreign key lookup, or a uniqueness constraint. No speculative indexes. Indexes cost write performance. Every one must earn its place.

**7. Timestamps everywhere**
Every table has created_at. Every mutable table has updated_at. Every soft-deletable table has deleted_at. Timestamps are always TIMESTAMPTZ — timezone-aware. Never TIMESTAMP without timezone.

---

## Table of Contents

1. Identity and Access
2. Organisations and Users
3. Roles and Permissions
4. Strategies and Portfolios
5. Positions and Transactions
6. Commands
7. Command Runs
8. Research — Theses
9. Research — Notes
10. Research — Documents
11. Watchlists
12. Dashboards and Layouts
13. Market Data Cache
14. Risk and Alerts
15. Compliance
16. Clients and Reporting
17. Sharing and Permissions
18. Certification and Ledger
19. Usage and Hours Tracking
20. Audit Log
21. Billing
22. Marketplace
23. Admin
24. Notifications
25. Onboarding

---

## Section 1 — Identity and Access

### Table: `users`

The central identity record for every person on the platform. Created on first login via Clerk. One row per human being regardless of how many organisations they belong to.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. Generated server-side. Never exposed in URLs. |
| clerk_id | TEXT | The unique ID from Clerk auth. Used to link the auth session to this record. |
| email | TEXT | Primary email address from Clerk. Unique across the platform. |
| first_name | TEXT | User's first name. Required. Stored separately for display and personalisation. |
| last_name | TEXT | User's last name. Required. Stored separately for sorting and formal address. |
| full_name | TEXT GENERATED | Computed column: first_name \|\| ' ' \|\| last_name. Always current. Never stored manually. |
| username | TEXT | Unique platform handle. Used for cross-platform sharing by username. Chosen on signup. Immutable after 30 days. |
| avatar_url | TEXT | Profile image URL. Stored from Clerk or uploaded manually. |
| timezone | TEXT | User's timezone string (e.g. 'America/New_York'). Used for scheduling, alerts, and display. |
| locale | TEXT | User's locale (e.g. 'en-US', 'en-GB'). Used for number formatting and date display. |
| preferences | JSONB | Personal UI preferences — theme, default dashboard, notification settings, command bar behaviour. |
| onboarding_completed_at | TIMESTAMPTZ | NULL until the user completes the onboarding flow. Used to gate the main workspace. |
| last_active_at | TIMESTAMPTZ | Updated on every authenticated API request. Used for usage analytics and churn detection. |
| signed_up_at | TIMESTAMPTZ | The exact moment the user record was created. Immutable. Distinct from created_at. |
| created_at | TIMESTAMPTZ | Record creation timestamp. |
| updated_at | TIMESTAMPTZ | Last modification timestamp. |
| deleted_at | TIMESTAMPTZ | Soft delete. NULL means active. Set when a user is deactivated or requests deletion. |

**Indexes:**
- `clerk_id` — unique index. Every authenticated request looks up the user by clerk_id first. This is the hottest lookup in the entire system.
- `username` — unique index. Used for cross-platform share lookups by username.
- `email` — unique index. Used for invitation matching and search.
- `last_active_at` — for churn detection queries and admin dashboards.
- `signed_up_at` — for cohort analysis and growth reporting.
- `deleted_at` — partial index where deleted_at IS NULL for all active-user queries.

---

### Table: `user_sessions`

Tracks active sessions. Used for security, concurrent session management, and admin visibility into who is currently active.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. |
| clerk_session_id | TEXT | The session identifier from Clerk. |
| ip_address | INET | IP address at session creation. Stored for security audit. |
| user_agent | TEXT | Browser/client string. Used for device identification. |
| created_at | TIMESTAMPTZ | Session start. |
| last_seen_at | TIMESTAMPTZ | Updated on every request within this session. |
| expires_at | TIMESTAMPTZ | Session expiry. Set by Clerk. |
| revoked_at | TIMESTAMPTZ | NULL unless manually revoked by admin or user. |

**Indexes:**
- `user_id` — for listing a user's active sessions.
- `clerk_session_id` — unique. For session validation on each request.
- `expires_at` — for cleanup jobs removing expired sessions.

---

## Section 2 — Organisations and Users

### Table: `organisations`

Every firm using Sable. An individual user with no firm is still represented here as a single-user organisation. This simplifies all downstream queries — everything is always scoped to an organisation.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| name | TEXT | The firm's display name. e.g. "Meridian Capital Partners". |
| slug | TEXT | URL-safe unique identifier. e.g. "meridian-capital". Used in internal routing. |
| type | TEXT | 'individual' or 'organisation'. Individual accounts are single-user firms. |
| plan | TEXT | Current billing plan: 'trial', 'active', 'suspended', 'cancelled'. |
| seat_count | INTEGER | Current number of active seats. Derived from active user_organisation memberships but cached here for fast billing checks. |
| stripe_customer_id | TEXT | The Stripe customer ID for this organisation. Used for all billing operations. |
| stripe_subscription_id | TEXT | The active Stripe subscription ID. |
| billing_email | TEXT | The email that receives invoices. May differ from the admin's email. |
| trial_ends_at | TIMESTAMPTZ | For trial accounts. NULL for paid accounts. |
| external_sharing_policy | TEXT | 'allow', 'require_approval', or 'disallow'. Controls whether members can share resources externally. |
| settings | JSONB | Organisation-wide settings — branding, default timezone, compliance defaults, notification preferences. |
| founded_at | DATE | Optional. The year/date the firm was founded. Used in client reporting. |
| website | TEXT | Optional. The firm's website. |
| aum_range | TEXT | Optional. Assets under management range — used for internal segmentation and analytics. |
| created_at | TIMESTAMPTZ | When the organisation was created. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `slug` — unique. Used for routing and organisation lookup.
- `stripe_customer_id` — unique. For Stripe webhook processing.
- `stripe_subscription_id` — unique. For subscription status checks.
- `plan` — for filtering organisations by billing status.
- `deleted_at` — partial index where deleted_at IS NULL.

---

### Table: `organisation_members`

The join table between users and organisations. A user can belong to one organisation. This table is the source of truth for that membership.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| user_id | UUID | Foreign key to users. |
| role_id | UUID | Foreign key to roles. The role this member holds in this organisation. |
| invited_by | UUID | Foreign key to users. Who sent the invitation. NULL for the founding member. |
| invited_at | TIMESTAMPTZ | When the invitation was sent. |
| joined_at | TIMESTAMPTZ | When the user accepted and joined. NULL until accepted. |
| status | TEXT | 'invited', 'active', 'suspended', 'removed'. |
| removed_at | TIMESTAMPTZ | When the member was removed. NULL if still active. |
| removed_by | UUID | Foreign key to users. Who removed them. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `(organisation_id, user_id)` — unique composite. A user can only be a member of an organisation once.
- `organisation_id` — for listing all members of an organisation.
- `user_id` — for finding which organisation a user belongs to.
- `status` — for filtering active members.
- `role_id` — for finding all members with a specific role.

---

### Table: `organisation_invitations`

Pending invitations sent to email addresses not yet on the platform. When the invited person signs up, this record is matched and they join the organisation.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| invited_by | UUID | Foreign key to users. |
| email | TEXT | The email address invited. |
| role_id | UUID | The role they will be assigned on joining. |
| token | TEXT | A secure random token sent in the invitation email. Used to verify acceptance. |
| expires_at | TIMESTAMPTZ | Invitations expire after 7 days. |
| accepted_at | TIMESTAMPTZ | NULL until accepted. |
| revoked_at | TIMESTAMPTZ | NULL unless revoked before acceptance. |
| created_at | TIMESTAMPTZ | When the invitation was created. |

**Indexes:**
- `token` — unique. For invitation acceptance lookups.
- `email` — for checking if an email has a pending invitation.
- `organisation_id` — for listing pending invitations per organisation.
- `expires_at` — for cleanup of expired invitations.

---

## Section 3 — Roles and Permissions

### Table: `roles`

Every role available in the system. System roles (Admin, Portfolio Manager, Risk Officer, Analyst, Viewer) are seeded at startup and cannot be deleted. Custom roles are created per organisation.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. NULL for system roles which are global. |
| name | TEXT | Display name. e.g. "Senior Analyst", "Junior Quant". |
| description | TEXT | What this role is for and who should have it. |
| is_system | BOOLEAN | TRUE for built-in roles. System roles cannot be edited or deleted. |
| permissions | TEXT[] | Array of permission strings. e.g. ['commands.run', 'portfolio.view', 'research.create']. |
| created_by | UUID | Foreign key to users. NULL for system roles. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. Cannot be set for system roles. |

**Indexes:**
- `organisation_id` — for listing all roles available to an organisation (their custom roles plus system roles where organisation_id IS NULL).
- `(organisation_id, name)` — unique composite. Organisation cannot have two roles with the same name.
- `is_system` — for quickly fetching system roles.

---

### Table: `permission_definitions`

A reference table of every valid permission string in the system. Used for validation and the admin UI that shows available permissions when building a custom role.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| key | TEXT | The permission string. e.g. 'commands.create_python'. Unique. |
| category | TEXT | Grouping for the UI. e.g. 'commands', 'portfolio', 'compliance'. |
| name | TEXT | Human readable name. e.g. "Create Python Commands". |
| description | TEXT | What this permission allows. |
| created_at | TIMESTAMPTZ | Record creation. |

**Indexes:**
- `key` — unique. For permission validation.
- `category` — for grouping in the admin UI.

---

## Section 4 — Strategies and Portfolios

### Table: `strategies`

An investment strategy defines the parameters, style, and constraints for a portfolio. A firm may have multiple strategies — long/short equity, systematic macro, etc. Each portfolio belongs to a strategy.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| name | TEXT | Strategy name. e.g. "Long/Short Equity — Value". |
| type | TEXT | 'long_only', 'long_short', 'macro', 'systematic', 'multi_asset', 'fixed_income', 'custom'. |
| style | TEXT | 'value', 'growth', 'momentum', 'quality', 'blend', 'systematic', 'discretionary'. |
| horizon | TEXT | 'short_term' (under 6 months), 'medium_term' (6-24 months), 'long_term' (24+ months). |
| universe | TEXT | Description of the investment universe. e.g. "FTSE 350 ex-financials". |
| benchmark_ticker | TEXT | The benchmark index ticker. e.g. "SPY", "^FTSE". Used in attribution and reporting. |
| base_currency | TEXT | ISO 4217 currency code. e.g. 'USD', 'GBP'. Default for all portfolios under this strategy. |
| risk_config | JSONB | Strategy-level risk parameters — max position size, max sector concentration, VaR limits, factor limits. |
| description | TEXT | Free text description of the strategy for client reporting and internal reference. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing all strategies in an organisation.
- `created_by` — for finding strategies created by a specific user.
- `type` — for filtering by strategy type.
- `deleted_at` — partial index where deleted_at IS NULL.

---

### Table: `portfolios`

A portfolio is a collection of positions managed under a specific strategy. A firm may have multiple portfolios — a live fund, a paper trading portfolio, individual client accounts.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| strategy_id | UUID | Foreign key to strategies. |
| created_by | UUID | Foreign key to users. |
| name | TEXT | Portfolio display name. e.g. "Fund I — Main Book". |
| description | TEXT | Optional description. |
| base_currency | TEXT | ISO 4217 code. Overrides strategy default if set. |
| benchmark_ticker | TEXT | Overrides strategy benchmark if set. |
| inception_date | DATE | When the portfolio started. Used as the start date for all performance calculations. |
| is_paper | BOOLEAN | TRUE for paper/simulated portfolios. FALSE for real portfolios. |
| status | TEXT | 'active', 'closed', 'archived'. |
| closed_at | TIMESTAMPTZ | When the portfolio was closed. NULL if still active. |
| aum | DECIMAL(20,2) | Assets under management. Computed and cached periodically. Not the source of truth — positions are. |
| cash_balance | DECIMAL(20,8) | Current cash position in base currency. Updated on each transaction. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing all portfolios in an organisation.
- `strategy_id` — for finding all portfolios under a strategy.
- `created_by` — for user-specific portfolio listing.
- `status` — for filtering active portfolios.
- `is_paper` — for separating live and paper portfolios.
- `deleted_at` — partial index where deleted_at IS NULL.

---

## Section 5 — Positions and Transactions

### Table: `positions`

Every current or historical holding in a portfolio. A position is a security held at a specific point in time. Positions are created when a buy transaction is recorded and closed when a matching sell transaction zeroes the quantity.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| portfolio_id | UUID | Foreign key to portfolios. |
| thesis_id | UUID | Foreign key to theses. Optional link to the research thesis behind this position. |
| ticker | TEXT | The security identifier. e.g. 'AAPL', 'MSFT'. |
| isin | TEXT | International Securities Identification Number. Optional but stored when available. |
| name | TEXT | Security display name. Cached from market data at time of first purchase. |
| asset_class | TEXT | 'equity', 'fixed_income', 'fx', 'commodity', 'crypto', 'etf', 'fund', 'other'. |
| exchange | TEXT | Exchange code. e.g. 'NASDAQ', 'LSE', 'XETRA'. |
| currency | TEXT | The currency the security trades in. May differ from portfolio base currency. |
| quantity | DECIMAL(20,8) | Current quantity. Positive for long, negative for short. Updated on each transaction. |
| avg_cost | DECIMAL(20,8) | Volume-weighted average cost in position currency. Updated on each buy transaction. |
| avg_cost_base | DECIMAL(20,8) | Average cost converted to portfolio base currency at time of each purchase. |
| realised_pnl | DECIMAL(20,8) | Cumulative realised P&L from partial and full closes. In base currency. |
| opened_at | TIMESTAMPTZ | When the first transaction for this position occurred. |
| closed_at | TIMESTAMPTZ | When the position was fully closed. NULL if still open. |
| is_active | BOOLEAN | TRUE while quantity is non-zero. Updated automatically. |
| notes | TEXT | Optional notes about this specific position. |
| tags | TEXT[] | Optional tags for filtering and grouping. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `portfolio_id` — for listing all positions in a portfolio. Most common query.
- `(portfolio_id, ticker)` — unique partial where is_active = TRUE. Only one active position per security per portfolio.
- `ticker` — for cross-portfolio security lookups.
- `is_active` — partial index where is_active = TRUE for active position queries.
- `asset_class` — for filtering by asset type.
- `thesis_id` — for finding positions linked to a specific thesis.
- `opened_at` — for time-range position queries.
- `closed_at` — for finding closed positions within a period.

---

### Table: `transactions`

Every buy, sell, dividend, split, or fee event. Immutable once created. The transaction log is the source of truth — positions and P&L are derived from it. Transactions are never edited or deleted. If an error is made, a correcting transaction is entered.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| portfolio_id | UUID | Foreign key to portfolios. |
| position_id | UUID | Foreign key to positions. |
| entered_by | UUID | Foreign key to users. Who entered this transaction. |
| type | TEXT | 'buy', 'sell', 'dividend', 'split', 'spinoff', 'rights', 'fee', 'transfer_in', 'transfer_out', 'correction'. |
| ticker | TEXT | The security. |
| quantity | DECIMAL(20,8) | Quantity traded. Positive for buys/transfers in, negative for sells/transfers out. |
| price | DECIMAL(20,8) | Price per unit in transaction currency. |
| currency | TEXT | The currency of the transaction. |
| fx_rate | DECIMAL(20,8) | Exchange rate from transaction currency to portfolio base currency at time of transaction. |
| gross_amount | DECIMAL(20,8) | quantity × price in transaction currency. |
| gross_amount_base | DECIMAL(20,8) | gross_amount converted to base currency using fx_rate. |
| fees | DECIMAL(20,8) | Commission, stamp duty, and other costs in transaction currency. |
| fees_base | DECIMAL(20,8) | Fees in base currency. |
| net_amount_base | DECIMAL(20,8) | gross_amount_base ± fees_base. The total cash impact of this transaction. |
| executed_at | TIMESTAMPTZ | When the transaction actually occurred. Used for P&L calculation. |
| settlement_date | DATE | Optional. Settlement date for fixed income or when relevant. |
| source | TEXT | 'manual', 'csv_import', 'correction'. |
| import_batch_id | UUID | If imported via CSV, links to the import batch. NULL for manual entries. |
| notes | TEXT | Optional notes about this transaction. |
| created_at | TIMESTAMPTZ | When the record was entered into the system. |

**Indexes:**
- `portfolio_id` — for listing all transactions in a portfolio.
- `position_id` — for listing all transactions affecting a specific position.
- `executed_at` — for time-range P&L queries. High cardinality, frequently filtered.
- `type` — for filtering by transaction type.
- `ticker` — for cross-portfolio transaction history.
- `entered_by` — for audit — who entered which transactions.
- `import_batch_id` — for finding all transactions in a specific import.

**Partitioning:**
Partitioned by RANGE on executed_at by year. A large multi-year portfolio will have thousands of transactions. Partitioning ensures queries scoped to a specific year hit only one partition.

---

### Table: `transaction_import_batches`

Tracks CSV import sessions. Allows importing errors to be traced and correcting transactions to be grouped.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| portfolio_id | UUID | Foreign key to portfolios. |
| imported_by | UUID | Foreign key to users. |
| filename | TEXT | Original filename uploaded. |
| row_count | INTEGER | Total rows in the CSV. |
| success_count | INTEGER | Rows successfully imported. |
| error_count | INTEGER | Rows that failed. |
| errors | JSONB | Array of error details — row number, error message, raw row data. |
| status | TEXT | 'processing', 'completed', 'completed_with_errors', 'failed'. |
| created_at | TIMESTAMPTZ | Import start. |
| completed_at | TIMESTAMPTZ | Import finish. |

**Indexes:**
- `portfolio_id` — for listing import history per portfolio.
- `imported_by` — for user import history.
- `status` — for monitoring in-progress imports.

---

## Section 6 — Commands

### Table: `commands`

Every command available to a user — built-in system commands, organisation-shared commands, and personal commands. The config column contains the full definition of what the command does.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. NULL for system built-in commands. |
| created_by | UUID | Foreign key to users. NULL for system commands. |
| name | TEXT | Human-readable name. e.g. "My Momentum Signal". |
| trigger | TEXT | The slash command. e.g. '/momentum'. Must start with /. Unique per organisation. |
| description | TEXT | What this command does. Shown in the command browser. |
| type | TEXT | 'primitive', 'ai_prompt', 'python', 'pipeline'. |
| config | JSONB | The full command definition. Structure varies by type — see config schemas below. |
| is_builtin | BOOLEAN | TRUE for system commands. Cannot be edited or deleted. |
| is_org_shared | BOOLEAN | TRUE if visible to all organisation members. |
| is_locked | BOOLEAN | TRUE if implementation is hidden when shared externally. |
| is_published | BOOLEAN | TRUE if listed in the marketplace. |
| current_version | INTEGER | The current version number. Incremented on each edit. |
| tags | TEXT[] | For filtering and discovery in the command browser. |
| run_count | BIGINT | Total number of times this command has been run. Cached counter. |
| last_run_at | TIMESTAMPTZ | When this command was last executed. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Config schemas by type:**

```
primitive: {
  primitive: string,        // the primitive function name
  params: object            // default parameters
}

ai_prompt: {
  prompt: string,           // the prompt template with {{variables}}
  model: string,            // claude model identifier
  context: string[],        // which context variables to inject
  output_format: string,    // card | table | markdown | alert
  temperature: number,      // 0-1
  include_news: boolean     // auto-inject relevant news
}

python: {
  script: string,           // the Python code
  params: object,           // default parameters
  output_format: string
}

pipeline: {
  steps: [{
    id: string,
    type: string,
    config: object,
    input: string[],        // step IDs feeding this step
    output_key: string
  }]
}
```

**Indexes:**
- `organisation_id` — for listing organisation commands.
- `created_by` — for listing a user's personal commands.
- `trigger` — unique partial index per organisation_id where deleted_at IS NULL.
- `type` — for filtering by command type.
- `is_builtin` — for fetching system commands.
- `is_org_shared` — for fetching shared commands.
- `is_published` — for marketplace listings.
- `tags` — GIN index for tag-based search.
- `last_run_at` — for showing recently used commands.

---

### Table: `command_versions`

Every version of every command config. When a command is edited the old config is preserved here. Users can roll back to any previous version.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| command_id | UUID | Foreign key to commands. |
| version | INTEGER | Version number. Starts at 1. |
| config | JSONB | The full config at this version. |
| change_notes | TEXT | Optional description of what changed. |
| created_by | UUID | Foreign key to users. Who made this version. |
| created_at | TIMESTAMPTZ | When this version was created. |

**Indexes:**
- `(command_id, version)` — unique composite. For fetching a specific version.
- `command_id` — for listing all versions of a command.

---

### Table: `command_parameters`

Named parameter definitions for commands that accept runtime parameters. e.g. /momentum lookback=126. These define what parameters are valid, their types, and defaults.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| command_id | UUID | Foreign key to commands. |
| name | TEXT | Parameter name. e.g. 'lookback'. |
| type | TEXT | 'integer', 'float', 'string', 'boolean', 'enum'. |
| default_value | TEXT | Default if not provided at runtime. |
| allowed_values | TEXT[] | For enum type — the valid values. |
| description | TEXT | What this parameter does. Shown in command help. |
| is_required | BOOLEAN | Whether the parameter must be provided. |
| created_at | TIMESTAMPTZ | Record creation. |

**Indexes:**
- `command_id` — for fetching parameters for a command.

---

## Section 7 — Command Runs

### Table: `command_runs`

Every execution of every command by every user. This is the highest-volume table in the system. Partitioned by month from creation. Never updated — each execution is a new row.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| command_id | UUID | Foreign key to commands. NULL if the command was deleted after this run. |
| user_id | UUID | Foreign key to users. Who ran it. |
| organisation_id | UUID | Foreign key to organisations. Denormalised for partition pruning. |
| trigger | TEXT | The exact trigger typed. e.g. '/momentum lookback=126'. |
| context | JSONB | The full context at execution time — selected tickers, portfolio snapshot, market state, params. |
| output | JSONB | The full output returned. NULL if the run errored. |
| output_format | TEXT | The format of the output — card, table, chart, markdown, alert. |
| error | TEXT | Error message if the run failed. NULL on success. |
| duration_ms | INTEGER | Total execution time in milliseconds. |
| quant_duration_ms | INTEGER | Time spent in the Python quant engine specifically. |
| ai_duration_ms | INTEGER | Time spent waiting for Claude API response. |
| status | TEXT | 'success', 'error', 'timeout', 'cancelled'. |
| pinned_to_dashboard_id | UUID | If the output was pinned to a dashboard. NULL otherwise. |
| created_at | TIMESTAMPTZ | Execution timestamp. Used as partition key. |

**Indexes:**
- `user_id` — for listing a user's command history.
- `organisation_id` — for organisation-wide analytics.
- `command_id` — for command-specific analytics.
- `status` — for error rate monitoring.
- `created_at` — for time-range queries. The partition key.
- `duration_ms` — for performance monitoring.

**Partitioning:**
Partitioned by RANGE on created_at by month. A new partition is created automatically each month. Old partitions can be archived to cold storage.

---

## Section 8 — Research: Theses

### Table: `theses`

Structured investment theses. Connected to specific tickers or themes. The source of truth for why a position is held.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| ticker | TEXT | The security this thesis is about. NULL if it's a thematic thesis. |
| theme | TEXT | The theme or macro view. NULL if ticker-specific. |
| title | TEXT | Short title for the thesis. e.g. "AAPL — Services Transition Underappreciated". |
| thesis_statement | TEXT | The core investment argument in one or two paragraphs. |
| assumptions | JSONB | Array of assumptions: [{id, text, status: 'active'|'validated'|'invalidated'}]. |
| invalidators | JSONB | Array of conditions that would make the thesis wrong: [{id, condition, triggered: bool, triggered_at}]. |
| target_price | DECIMAL(20,8) | Price target. Optional. |
| target_currency | TEXT | Currency of the price target. |
| horizon | TEXT | Investment horizon. |
| conviction | TEXT | 'high', 'medium', 'low'. |
| status | TEXT | 'active', 'closed', 'invalidated'. |
| closed_reason | TEXT | Why the thesis was closed or invalidated. |
| return_achieved | DECIMAL(10,4) | Actual return achieved when closed. Computed from linked position. |
| tags | TEXT[] | For filtering and search. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation theses.
- `created_by` — for user's own theses.
- `ticker` — for finding theses on a specific security.
- `status` — for filtering active theses.
- `conviction` — for filtering by conviction level.
- `tags` — GIN index for tag filtering.
- Full text search index on `(title, thesis_statement)` — for searching thesis content.

---

### Table: `thesis_versions`

Complete snapshots of a thesis at each save point. Enables viewing the thesis as it was written at any historical point.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| thesis_id | UUID | Foreign key to theses. |
| version | INTEGER | Version number. |
| snapshot | JSONB | Complete thesis state at this version — all fields. |
| change_summary | TEXT | Optional note on what changed. |
| created_by | UUID | Foreign key to users. |
| created_at | TIMESTAMPTZ | When this version was saved. |

**Indexes:**
- `(thesis_id, version)` — unique composite.
- `thesis_id` — for listing version history.

---

### Table: `thesis_comments`

Comments and discussion on a thesis. Threaded. Used for collaboration within and across organisations when a thesis is shared.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| thesis_id | UUID | Foreign key to theses. |
| created_by | UUID | Foreign key to users. |
| parent_id | UUID | Foreign key to thesis_comments. NULL for top-level comments. Set for replies. |
| content | TEXT | The comment text. Rich text stored as markdown. |
| is_resolved | BOOLEAN | Whether this comment thread has been resolved. |
| resolved_by | UUID | Foreign key to users. Who resolved it. |
| resolved_at | TIMESTAMPTZ | When it was resolved. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `thesis_id` — for listing all comments on a thesis.
- `parent_id` — for fetching replies to a comment.
- `created_by` — for finding a user's comments.

---

## Section 9 — Research: Notes

### Table: `research_notes`

Freeform research notes. Can be attached to tickers, theses, portfolios, or standalone. Rich text stored as markdown.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| title | TEXT | Optional title. |
| content | TEXT | Rich text content stored as markdown. |
| tickers | TEXT[] | Securities mentioned or tagged. Multiple allowed. |
| thesis_id | UUID | Foreign key to theses. Optional link. |
| portfolio_id | UUID | Foreign key to portfolios. Optional link. |
| embedded_outputs | JSONB | Array of pinned command output references embedded in the note. |
| tags | TEXT[] | For organisation and search. |
| word_count | INTEGER | Computed and cached for display. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation notes.
- `created_by` — for user's own notes.
- `tickers` — GIN index. For finding all notes mentioning a specific ticker.
- `thesis_id` — for notes linked to a thesis.
- `tags` — GIN index for tag filtering.
- Full text search index on `(title, content)` — for searching note content. This is a heavily used search path.

---

## Section 10 — Research: Documents

### Table: `research_documents`

Uploaded research documents — broker PDFs, annual reports, presentations. Text is extracted and indexed for search.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| uploaded_by | UUID | Foreign key to users. |
| title | TEXT | Document title. May be extracted from the PDF or manually entered. |
| source | TEXT | Where this came from. e.g. "Goldman Sachs Research", "Company IR". |
| document_type | TEXT | 'broker_research', 'annual_report', 'earnings_transcript', 'presentation', 'regulatory', 'other'. |
| tickers | TEXT[] | Securities mentioned in the document. Extracted automatically and editable. |
| file_url | TEXT | GCS URL of the stored file. |
| file_size_bytes | BIGINT | File size for display. |
| page_count | INTEGER | Number of pages. Extracted from PDF. |
| content_extracted | TEXT | Full text extracted from the document. Used for full text search. |
| ai_summary | TEXT | One paragraph AI-generated summary of the document. |
| metadata | JSONB | Additional metadata — author, publication date, document date, language. |
| extraction_status | TEXT | 'pending', 'completed', 'failed'. Text extraction is async. |
| created_at | TIMESTAMPTZ | Record creation. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation documents.
- `uploaded_by` — for user's uploads.
- `tickers` — GIN index. For finding documents mentioning a specific ticker.
- `document_type` — for filtering by type.
- `extraction_status` — for processing queue monitoring.
- Full text search index on `content_extracted` — for searching document content.

---

### Table: `document_annotations`

Highlights and annotations on research documents. Connected to notes and theses.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| document_id | UUID | Foreign key to research_documents. |
| created_by | UUID | Foreign key to users. |
| page_number | INTEGER | Which page the annotation is on. |
| selected_text | TEXT | The text that was highlighted. |
| annotation | TEXT | The annotation comment. |
| highlight_position | JSONB | Coordinates of the highlight for rendering in the document viewer. |
| linked_note_id | UUID | Foreign key to research_notes. Optional. |
| linked_thesis_id | UUID | Foreign key to theses. Optional. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `document_id` — for listing annotations on a document.
- `created_by` — for a user's annotations.
- `linked_note_id` — for finding annotations linked to a note.
- `linked_thesis_id` — for finding annotations linked to a thesis.

---

## Section 11 — Watchlists

### Table: `watchlists`

User and organisation watchlists. Each watchlist is a named list of tickers with configurable display columns.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| name | TEXT | Watchlist name. e.g. "Tech Longs", "Macro Indicators". |
| tickers | TEXT[] | Ordered list of tickers in this watchlist. |
| columns | JSONB | Column definitions — [{type: 'builtin'|'command', key: string, label: string, command_id: uuid|null}]. |
| is_org_shared | BOOLEAN | Whether visible to all organisation members. |
| sort_order | JSONB | Current sort state — {column, direction}. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation watchlists.
- `created_by` — for user's watchlists.
- `tickers` — GIN index. For finding watchlists containing a specific ticker.
- `is_org_shared` — for fetching shared watchlists.

---

## Section 12 — Dashboards and Layouts

### Table: `dashboards`

Custom configurable canvases. Each dashboard contains a layout of widgets — command outputs, live data, charts, notes, embedded views.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| name | TEXT | Dashboard name. e.g. "Morning Brief", "Risk Monitor". |
| layout | JSONB | Full widget layout definition — positions, sizes, widget configs, refresh intervals. |
| is_org_shared | BOOLEAN | Whether visible to all organisation members. |
| is_default | BOOLEAN | Whether this is the user's default dashboard on login. |
| thumbnail_url | TEXT | Screenshot preview for the dashboard browser. Regenerated periodically. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation dashboards.
- `created_by` — for user's dashboards.
- `is_org_shared` — for fetching shared dashboards.
- `is_default` — partial index for fast default dashboard lookup.

---

### Table: `dashboard_widgets`

Individual widgets within a dashboard. Storing widgets separately from the dashboard layout allows widget-level operations without rewriting the entire layout JSONB.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| dashboard_id | UUID | Foreign key to dashboards. |
| type | TEXT | 'command_output', 'live_price', 'portfolio_view', 'watchlist', 'news_feed', 'note', 'chart', 'embedded_screen', 'shortcut', 'script_output'. |
| config | JSONB | Widget-specific configuration — which command, which portfolio, which tickers, refresh interval. |
| position | JSONB | Grid position — {x, y, width, height}. |
| title | TEXT | Optional custom title overriding the default. |
| refresh_interval | TEXT | 'manual', 'on_open', '1m', '5m', '15m', '1h'. |
| last_refreshed_at | TIMESTAMPTZ | When this widget's data was last refreshed. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `dashboard_id` — for fetching all widgets on a dashboard.
- `type` — for filtering widget types.

---

### Table: `workspace_layouts`

Saved workspace configurations for each user — panel positions, sizes, which panels are open, active dashboard.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. |
| name | TEXT | Layout name. e.g. "Research Mode", "Risk Focus". |
| layout | JSONB | Full panel configuration — main view state, side panel states, active dashboard, panel sizes. |
| is_default | BOOLEAN | Whether this layout is loaded on login. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `user_id` — for listing a user's saved layouts.
- `(user_id, is_default)` — for fast default layout lookup.

---

## Section 13 — Market Data Cache

### Table: `price_cache`

Cached daily OHLCV price data from Polygon.io. The canonical store of historical price data for the quant engine.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| ticker | TEXT | Security identifier. |
| date | DATE | Trading date. |
| open | DECIMAL(20,8) | Opening price. |
| high | DECIMAL(20,8) | Daily high. |
| low | DECIMAL(20,8) | Daily low. |
| close | DECIMAL(20,8) | Closing price. The primary price used in all calculations. |
| adjusted_close | DECIMAL(20,8) | Close adjusted for splits and dividends. Used in return calculations. |
| volume | BIGINT | Daily volume. |
| vwap | DECIMAL(20,8) | Volume-weighted average price. |
| currency | TEXT | Currency of the prices. |
| source | TEXT | Data source. 'polygon'. |
| fetched_at | TIMESTAMPTZ | When this record was retrieved from the API. |

**Indexes:**
- `(ticker, date)` — unique composite. The primary lookup key.
- `ticker` — for fetching all history for a security.
- `date` — for fetching all securities on a given date.

**Partitioning:**
Partitioned by RANGE on date by year. Historical data queries are almost always time-bounded. Yearly partitions ensure the query planner eliminates irrelevant years.

---

### Table: `fundamentals_cache`

Cached fundamental data — earnings, revenue, margins, valuation metrics. Refreshed periodically.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| ticker | TEXT | Security identifier. |
| period_type | TEXT | 'annual', 'quarterly', 'ttm' (trailing twelve months). |
| period_label | TEXT | e.g. 'FY2024', 'Q3_2024'. |
| period_end_date | DATE | The date the period ended. |
| data | JSONB | All fundamental metrics — revenue, earnings, margins, ratios, balance sheet items. |
| source | TEXT | Data source. 'polygon'. |
| fetched_at | TIMESTAMPTZ | When retrieved. |

**Indexes:**
- `(ticker, period_type, period_label)` — unique composite.
- `ticker` — for fetching all fundamentals for a security.
- `period_end_date` — for time-range fundamental queries.

---

### Table: `security_metadata`

Static or slowly-changing information about securities — name, exchange, sector, industry, country.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| ticker | TEXT | Security identifier. Unique. |
| isin | TEXT | ISIN. Optional. |
| name | TEXT | Full legal name. |
| short_name | TEXT | Display name. |
| exchange | TEXT | Exchange code. |
| asset_class | TEXT | Equity, ETF, index, etc. |
| currency | TEXT | Trading currency. |
| country | TEXT | Country of listing. |
| sector | TEXT | GICS sector. |
| industry | TEXT | GICS industry. |
| market_cap_category | TEXT | 'large_cap', 'mid_cap', 'small_cap', 'micro_cap'. |
| is_active | BOOLEAN | Whether the security is currently tradeable. |
| metadata | JSONB | Additional data — description, website, number of employees. |
| last_updated_at | TIMESTAMPTZ | When this record was last refreshed. |

**Indexes:**
- `ticker` — unique. Primary lookup.
- `isin` — for ISIN-based lookups.
- `name` — for name search.
- `exchange` — for filtering by exchange.
- `sector` — for sector filtering.
- `country` — for geographic filtering.
- Full text search index on `(name, short_name)` — for security search by name.

---

### Table: `news_cache`

Cached news articles from Polygon.io. Used for the news browser and AI context injection.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| external_id | TEXT | Polygon's article ID. Unique. |
| headline | TEXT | Article headline. |
| summary | TEXT | Article summary. May be from Polygon or AI-generated. |
| ai_summary | TEXT | One-sentence AI summary generated by Claude. Cached to avoid reprocessing. |
| source | TEXT | Publication name. e.g. 'Reuters', 'FT'. |
| url | TEXT | Link to the full article. |
| tickers | TEXT[] | Securities mentioned in the article. |
| sentiment | TEXT | 'positive', 'negative', 'neutral'. From Polygon's sentiment analysis. |
| sentiment_score | DECIMAL(5,4) | Numeric sentiment score. |
| published_at | TIMESTAMPTZ | When the article was published. |
| fetched_at | TIMESTAMPTZ | When retrieved from Polygon. |

**Indexes:**
- `external_id` — unique. For deduplication.
- `tickers` — GIN index. The primary lookup — find all news for a ticker.
- `published_at` — for time-range queries. News lookups are almost always "in the last N hours".
- `sentiment` — for filtering by sentiment.

---

## Section 14 — Risk and Alerts

### Table: `risk_snapshots`

Point-in-time risk calculations for portfolios. Computed periodically and on demand. Not the source of truth — positions are. But stored for historical trending and alert evaluation.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| portfolio_id | UUID | Foreign key to portfolios. |
| computed_at | TIMESTAMPTZ | When this snapshot was computed. |
| var_95 | DECIMAL(10,6) | Value at Risk at 95% confidence. Expressed as a fraction of portfolio value. |
| var_99 | DECIMAL(10,6) | Value at Risk at 99% confidence. |
| cvar_95 | DECIMAL(10,6) | Conditional VaR at 95%. |
| current_drawdown | DECIMAL(10,6) | Current drawdown from high water mark. |
| max_drawdown_30d | DECIMAL(10,6) | Maximum drawdown in last 30 days. |
| volatility_daily | DECIMAL(10,6) | Daily portfolio volatility. |
| volatility_annual | DECIMAL(10,6) | Annualised volatility. |
| sharpe_ratio | DECIMAL(10,4) | Sharpe ratio since inception or last reset. |
| factor_exposures | JSONB | Factor exposure vector — {factor_name: exposure_value}. |
| sector_concentrations | JSONB | Sector weights — {sector: weight}. |
| top_position_weight | DECIMAL(10,6) | Largest single position weight. |
| liquidity_days | DECIMAL(8,2) | Days to liquidate 95% of portfolio at 20% ADV. |
| correlation_matrix | JSONB | Pairwise correlation matrix for all positions. Stored as {ticker_a: {ticker_b: correlation}}. |

**Indexes:**
- `portfolio_id` — for fetching risk history.
- `computed_at` — for time-range risk history queries.
- `(portfolio_id, computed_at)` — composite for the most common query — latest risk snapshot for a portfolio.

**Partitioning:**
Partitioned by RANGE on computed_at by month.

---

### Table: `risk_limits`

Configurable risk limits at organisation or portfolio level. Evaluated against risk_snapshots to generate alerts.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| portfolio_id | UUID | Foreign key to portfolios. NULL if this is an org-level limit applying to all portfolios. |
| created_by | UUID | Foreign key to users. |
| name | TEXT | Limit name. e.g. "Max Single Position Size". |
| description | TEXT | What this limit is for. |
| type | TEXT | 'position_limit', 'sector_limit', 'factor_limit', 'var_limit', 'drawdown_limit', 'correlation_limit', 'liquidity_limit', 'custom'. |
| config | JSONB | Limit definition — {metric: string, operator: string, threshold: number, secondary_config: object}. |
| warning_threshold_pct | DECIMAL(5,2) | Alert at this percentage of the limit. e.g. 80 means alert when 80% of limit is reached. |
| is_org_level | BOOLEAN | TRUE if set by admin and cannot be overridden by users. |
| is_active | BOOLEAN | Whether this limit is currently being monitored. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation limits.
- `portfolio_id` — for portfolio-specific limits.
- `type` — for filtering by limit type.
- `is_org_level` — for fetching mandatory org-level limits.
- `is_active` — partial index for monitoring active limits only.

---

### Table: `alerts`

Alert configurations. Each alert monitors a specific condition and fires when triggered.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| portfolio_id | UUID | Foreign key to portfolios. NULL for market alerts not tied to a portfolio. |
| risk_limit_id | UUID | Foreign key to risk_limits. NULL for alerts not tied to a limit. |
| name | TEXT | Alert name. |
| type | TEXT | 'limit_warning', 'limit_breach', 'price_level', 'price_change', 'news', 'factor_drift', 'drawdown', 'correlation_change', 'volatility_regime'. |
| config | JSONB | Alert condition definition. Varies by type. |
| channels | TEXT[] | Delivery channels — ['in_app', 'email']. |
| is_active | BOOLEAN | Whether this alert is currently monitoring. |
| cooldown_minutes | INTEGER | Minimum time between repeat firings of this alert. Prevents spam. |
| last_triggered_at | TIMESTAMPTZ | When this alert last fired. |
| trigger_count | INTEGER | Total number of times this alert has triggered. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation alerts.
- `created_by` — for user's alerts.
- `portfolio_id` — for portfolio-specific alerts.
- `type` — for alert type filtering.
- `is_active` — partial index for monitoring active alerts only.

---

### Table: `alert_events`

Every firing of every alert. Immutable. The record of what was alerted and when.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| alert_id | UUID | Foreign key to alerts. |
| user_id | UUID | Foreign key to users. Who this event was generated for. |
| triggered_at | TIMESTAMPTZ | When the alert fired. |
| data | JSONB | What triggered it — the metric value, the threshold breached, the context. |
| message | TEXT | Human-readable alert message. e.g. "AAPL position now 8.3% of portfolio, exceeding 8% limit." |
| acknowledged_at | TIMESTAMPTZ | When the user acknowledged this alert. NULL if unread. |
| acknowledged_by | UUID | Foreign key to users. |
| dismissed | BOOLEAN | Whether the user dismissed without acknowledging. |
| created_at | TIMESTAMPTZ | Record creation. |

**Indexes:**
- `alert_id` — for listing events for an alert.
- `user_id` — for a user's alert inbox.
- `triggered_at` — for time-range event queries.
- `acknowledged_at` — partial index where acknowledged_at IS NULL for unread count queries.

---

## Section 15 — Compliance

### Table: `compliance_rules`

User-configured compliance rules. Evaluated against portfolio state to generate compliance checks.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| portfolio_id | UUID | Foreign key to portfolios. NULL if org-level rule. |
| created_by | UUID | Foreign key to users. |
| name | TEXT | Rule name. |
| description | TEXT | What this rule enforces. |
| type | TEXT | 'position_limit', 'sector_limit', 'asset_class_limit', 'factor_limit', 'geographic_limit', 'correlation_limit', 'var_limit', 'drawdown_limit', 'concentration_limit', 'liquidity_limit', 'custom_python'. |
| config | JSONB | Rule definition. For standard rules: {metric, operator, threshold}. For custom: {script: string}. |
| is_org_level | BOOLEAN | TRUE if set by admin — cannot be disabled by users. |
| severity | TEXT | 'critical', 'major', 'minor'. Determines how breaches are displayed and reported. |
| is_active | BOOLEAN | Whether this rule is being evaluated. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation compliance rules.
- `portfolio_id` — for portfolio-specific rules.
- `type` — for filtering by rule type.
- `is_org_level` — for fetching mandatory rules.
- `is_active` — partial index for active rules only.

---

### Table: `compliance_checks`

Results of compliance rule evaluations. Run on demand and on a schedule. Append-only — each check is a new row.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| portfolio_id | UUID | Foreign key to portfolios. |
| rule_id | UUID | Foreign key to compliance_rules. |
| checked_at | TIMESTAMPTZ | When this check was run. |
| status | TEXT | 'pass', 'warning', 'breach'. |
| current_value | JSONB | The actual metric value at check time. |
| threshold_value | JSONB | The limit that was checked against. |
| message | TEXT | Human-readable result. e.g. "AAPL at 8.3%, limit is 8%. Breach." |
| pct_of_limit | DECIMAL(10,4) | How close to the limit — e.g. 104.1 means 4.1% over. |

**Indexes:**
- `(portfolio_id, rule_id)` — for fetching check history per rule per portfolio.
- `portfolio_id` — for listing all compliance checks for a portfolio.
- `checked_at` — for time-range compliance history.
- `status` — for filtering breaches and warnings.

**Partitioning:**
Partitioned by RANGE on checked_at by month.

---

## Section 16 — Clients and Reporting

### Table: `clients`

Client records managed by the organisation. Each client is linked to a portfolio and has reporting preferences.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| portfolio_id | UUID | Foreign key to portfolios. The client's portfolio. |
| name | TEXT | Client name. Individual or organisation name. |
| type | TEXT | 'individual', 'family_office', 'institution', 'trust', 'other'. |
| email | TEXT | Primary contact email for report delivery. |
| phone | TEXT | Optional phone number. |
| reporting_frequency | TEXT | 'monthly', 'quarterly', 'annually', 'on_demand'. |
| reporting_preferences | JSONB | Which report sections to include, preferred format, delivery preferences. |
| aum | DECIMAL(20,2) | Assets under management for this client. Cached from portfolio. |
| inception_date | DATE | When the client relationship began. |
| relationship_manager | UUID | Foreign key to users. Who manages this relationship. |
| notes | TEXT | Internal notes about the client. Not included in reports. |
| tags | TEXT[] | For client filtering and segmentation. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation clients.
- `portfolio_id` — for finding the client linked to a portfolio.
- `relationship_manager` — for a user's client list.
- `reporting_frequency` — for scheduling report generation.
- `tags` — GIN index for client filtering.

---

### Table: `report_templates`

Reusable report templates defining structure, content, and branding.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| created_by | UUID | Foreign key to users. |
| name | TEXT | Template name. e.g. "Quarterly Client Report". |
| sections | JSONB | Ordered list of sections — [{type, title, enabled, config}]. |
| branding | JSONB | Visual config — {logo_url, primary_colour, font, header_style}. |
| page_format | TEXT | 'A4', 'Letter'. |
| default_currency | TEXT | Currency for display in reports. |
| is_default | BOOLEAN | Whether this is the default template for new reports. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |
| deleted_at | TIMESTAMPTZ | Soft delete. |

**Indexes:**
- `organisation_id` — for listing organisation templates.
- `created_by` — for user's templates.
- `is_default` — partial index for fast default template lookup.

---

### Table: `client_reports`

Generated client reports. Stores the content and tracks the delivery lifecycle.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| client_id | UUID | Foreign key to clients. |
| template_id | UUID | Foreign key to report_templates. |
| created_by | UUID | Foreign key to users. |
| period_start | DATE | Start of the reporting period. |
| period_end | DATE | End of the reporting period. |
| status | TEXT | 'draft', 'review', 'approved', 'sent'. |
| content | JSONB | Full rendered report content — all section data. |
| commentary | TEXT | Manager's written commentary. The human-authored section. |
| pdf_url | TEXT | GCS URL of generated PDF. NULL until generated. |
| docx_url | TEXT | GCS URL of generated DOCX. NULL until generated. |
| approved_by | UUID | Foreign key to users. |
| approved_at | TIMESTAMPTZ | When approved. |
| sent_at | TIMESTAMPTZ | When emailed to the client. |
| sent_to | TEXT[] | Email addresses it was sent to. |
| email_opened_at | TIMESTAMPTZ | When the client opened the email. From delivery tracking. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `organisation_id` — for listing organisation reports.
- `client_id` — for listing a client's report history.
- `status` — for filtering by report status.
- `period_end` — for date-range report queries.
- `approved_by` — for reports approved by a specific user.

---

### Table: `client_communications`

Log of all communications with clients — calls, emails, meetings, reports sent.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| client_id | UUID | Foreign key to clients. |
| logged_by | UUID | Foreign key to users. |
| type | TEXT | 'call', 'email', 'meeting', 'report_sent', 'note'. |
| subject | TEXT | Brief subject line. |
| content | TEXT | Notes or summary of the communication. |
| report_id | UUID | Foreign key to client_reports. Set if type is 'report_sent'. |
| occurred_at | TIMESTAMPTZ | When the communication occurred. |
| created_at | TIMESTAMPTZ | When logged. |

**Indexes:**
- `client_id` — for listing a client's communication history.
- `occurred_at` — for time-ordered history.
- `type` — for filtering by communication type.

---

## Section 17 — Sharing and Permissions

### Table: `resource_shares`

Every share of every resource type. One table handles all sharing — commands, pipelines, dashboards, watchlists, theses, notes, portfolios.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| resource_type | TEXT | 'command', 'dashboard', 'watchlist', 'thesis', 'note', 'portfolio', 'report_template'. |
| resource_id | UUID | The ID of the shared resource. Not a foreign key — polymorphic. |
| shared_by | UUID | Foreign key to users. Who is sharing. |
| shared_with_user | UUID | Foreign key to users. NULL if sharing with a whole organisation. |
| shared_with_org | UUID | Foreign key to organisations. NULL if sharing with a specific user. |
| permission | TEXT | 'view', 'comment', 'edit'. |
| is_locked | BOOLEAN | TRUE hides the implementation for commands and pipelines. |
| source_version | INTEGER | For commands — which version is being shared. |
| message | TEXT | Optional note from the sharer. |
| accepted_at | TIMESTAMPTZ | When the recipient accepted. NULL until accepted or if org share (auto-accepted). |
| declined_at | TIMESTAMPTZ | When the recipient declined. NULL if not declined. |
| revoked_at | TIMESTAMPTZ | When the sharer revoked access. NULL if still active. |
| expires_at | TIMESTAMPTZ | Optional expiry for time-limited shares. |
| created_at | TIMESTAMPTZ | When the share was created. |

**Indexes:**
- `(resource_type, resource_id)` — for finding all shares of a specific resource.
- `shared_by` — for listing resources a user has shared.
- `shared_with_user` — for finding resources shared with a user.
- `shared_with_org` — for finding resources shared with an organisation.
- `resource_type` — for filtering by resource type.
- `accepted_at` — partial index where accepted_at IS NULL for pending shares.
- `revoked_at` — partial index where revoked_at IS NULL for active shares.

---

### Table: `share_notifications`

Notification records for share invitations. Drives the notification inbox.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| recipient_id | UUID | Foreign key to users. |
| share_id | UUID | Foreign key to resource_shares. |
| read_at | TIMESTAMPTZ | When the user read this notification. NULL if unread. |
| created_at | TIMESTAMPTZ | Record creation. |

**Indexes:**
- `recipient_id` — for a user's notification inbox.
- `read_at` — partial index where read_at IS NULL for unread count.

---

## Section 18 — Certification and Ledger

### Table: `certifications`

Every certification earned by every user. One row per certification event. Never updated. A user can hold multiple certifications at different levels.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. |
| level | TEXT | 'foundation', 'professional', 'advanced'. |
| status | TEXT | 'active'. Certifications cannot be revoked. This field exists only for completeness. |
| hours_logged | DECIMAL(8,2) | Total verified hours at time of certification. |
| exam_score | DECIMAL(5,2) | Score achieved in the exam. Percentage. |
| exam_date | TIMESTAMPTZ | When the exam was taken. |
| issued_at | TIMESTAMPTZ | When the certification was officially issued. |
| certificate_id | TEXT | The public-facing certificate identifier. Used in verification URLs. Unique. Human-readable format. |
| institution | TEXT | University or organisation where the user completed the programme. |
| ledger_entry_id | UUID | Foreign key to certification_ledger. The immutable ledger record. |
| verification_url | TEXT | The public URL to verify this certification. |

**Indexes:**
- `user_id` — for listing a user's certifications.
- `certificate_id` — unique. For public verification lookups.
- `level` — for filtering by certification level.
- `issued_at` — for cohort and trend analysis.
- `institution` — for university programme analytics.

---

### Table: `certification_ledger`

The immutable tamper-proof ledger. Every entry is cryptographically linked to the previous. RFC 3161 timestamps provide independent legal proof of when each entry was created. This table is append-only. No row is ever updated or deleted.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| sequence | BIGINT | Global monotonic sequence number. Any gap indicates tampering. |
| entry_type | TEXT | 'certification_issued', 'hours_milestone', 'exam_attempt', 'exam_passed', 'exam_failed'. |
| user_id | UUID | The user this entry describes. |
| certification_id | UUID | Foreign key to certifications. NULL for non-certification entries. |
| payload | JSONB | The full event data — level, score, hours, institution, etc. |
| payload_hash | TEXT | SHA-256 hash of the payload field. |
| actor_id | UUID | Who or what created this entry — user, system, examiner. |
| timestamp | TIMESTAMPTZ | Server-side timestamp of entry creation. |
| rfc3161_token | TEXT | Base64-encoded RFC 3161 trusted timestamp token from a qualified trust service provider. Legal proof of existence before this moment. |
| prev_entry_hash | TEXT | SHA-256 hash of the previous ledger entry's entry_hash field. Links entries into a chain. NULL only for the very first entry. |
| entry_hash | TEXT | SHA-256 hash of the entire entry (all fields except entry_hash itself). |
| platform_signature | TEXT | Sable's private key signature of the entry_hash. Proves origin. |

**Indexes:**
- `sequence` — unique. For gap detection in tamper verification.
- `user_id` — for fetching all ledger entries for a user.
- `certification_id` — for fetching ledger entries related to a certification.
- `entry_type` — for filtering by event type.
- `timestamp` — for time-range ledger queries.
- `certificate_id` (via join with certifications) — for public verification endpoint.

**Constraints:**
- `sequence` must be strictly increasing with no gaps. Enforced by trigger.
- `prev_entry_hash` must match the entry_hash of the row with sequence - 1. Enforced by trigger.
- No UPDATE or DELETE permissions granted to the application database user. The application can only INSERT.

---

## Section 19 — Usage and Hours Tracking

### Table: `usage_sessions`

Tracks user sessions within the platform for hours certification. Every period of active use is a session. Used to compute certified hours for the certification programme.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. |
| organisation_id | UUID | Foreign key to organisations. |
| started_at | TIMESTAMPTZ | Session start. |
| ended_at | TIMESTAMPTZ | Session end. NULL for active sessions. |
| duration_minutes | DECIMAL(8,2) | Computed from ended_at - started_at. NULL until session ends. |
| activity_summary | JSONB | Summary of what was done — command count, features used, tickers analysed. |
| is_verified | BOOLEAN | Whether this session counts toward certification hours. Sessions under 10 minutes are not verified. |

**Indexes:**
- `user_id` — for computing a user's total hours.
- `started_at` — for time-range session queries.
- `is_verified` — partial index where is_verified = TRUE for certified hours calculation.

**Partitioning:**
Partitioned by RANGE on started_at by month.

---

### Table: `certification_hours`

Aggregated and verified hours per user per certification level. Updated periodically from usage_sessions. Used for the certification eligibility check.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. |
| total_verified_hours | DECIMAL(8,2) | Total verified hours. Computed from usage_sessions. |
| foundation_eligible | BOOLEAN | TRUE when total_verified_hours >= 50. |
| professional_eligible | BOOLEAN | TRUE when total_verified_hours >= 200. |
| advanced_eligible | BOOLEAN | TRUE when total_verified_hours >= 500. |
| last_computed_at | TIMESTAMPTZ | When this aggregation was last computed. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `user_id` — unique. One row per user.
- `foundation_eligible` — for finding users eligible for Foundation exam.
- `professional_eligible` — for finding users eligible for Professional exam.
- `advanced_eligible` — for finding users eligible for Advanced exam.

---

### Table: `exam_attempts`

Every attempt at a certification exam. Records the attempt, score, and outcome. A user may attempt multiple times. Each attempt is logged to the certification ledger.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. |
| level | TEXT | 'foundation', 'professional', 'advanced'. |
| attempt_number | INTEGER | Which attempt this is (1, 2, 3...). |
| started_at | TIMESTAMPTZ | When the exam was started. |
| submitted_at | TIMESTAMPTZ | When submitted. NULL if abandoned. |
| score | DECIMAL(5,2) | Percentage score. NULL until graded. |
| pass_mark | DECIMAL(5,2) | The pass mark at time of attempt. e.g. 70.00. |
| passed | BOOLEAN | Whether the attempt passed. NULL until graded. |
| certification_id | UUID | Foreign key to certifications. NULL until/unless passed. |
| ledger_entry_id | UUID | Foreign key to certification_ledger. The ledger record of this attempt. |
| payment_id | TEXT | Stripe payment ID for the exam fee. |
| amount_paid | DECIMAL(10,2) | Amount paid for this attempt. |
| currency | TEXT | Currency of payment. |
| created_at | TIMESTAMPTZ | Record creation. |

**Indexes:**
- `user_id` — for listing a user's exam history.
- `level` — for filtering by exam level.
- `passed` — partial index where passed = TRUE for certification queries.
- `submitted_at` — for exam scheduling and analytics.

---

## Section 20 — Audit Log

### Table: `audit_log`

The complete, immutable record of every action in the system. Append-only. No user or admin can modify or delete audit records. Used for compliance, security investigation, and admin oversight.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. NULL for platform-level actions. |
| user_id | UUID | Foreign key to users. NULL for system-generated actions. |
| session_id | UUID | Foreign key to user_sessions. Which session this action came from. |
| action | TEXT | The action performed. e.g. 'portfolio.position.created', 'command.created', 'share.sent'. Namespaced. |
| entity_type | TEXT | The type of entity affected. e.g. 'position', 'command', 'user'. |
| entity_id | UUID | The ID of the affected entity. |
| before_state | JSONB | The state of the entity before the action. NULL for creation events. |
| after_state | JSONB | The state of the entity after the action. NULL for deletion events. |
| metadata | JSONB | Additional context — IP address, user agent, request ID, any relevant details. |
| ip_address | INET | IP address of the request. |
| created_at | TIMESTAMPTZ | When the action occurred. This is the partition key. |

**Indexes:**
- `organisation_id` — for admin — all actions in an organisation.
- `user_id` — for all actions by a specific user.
- `action` — for filtering by action type.
- `(entity_type, entity_id)` — for all audit events on a specific entity.
- `created_at` — for time-range audit queries.

**Partitioning:**
Partitioned by RANGE on created_at by month. Audit logs accumulate indefinitely. Monthly partitions allow old partitions to be archived to cold storage after the retention period.

**Constraints:**
No UPDATE or DELETE permissions granted to the application database user on this table. Insert only.

---

## Section 21 — Billing

### Table: `billing_subscriptions`

Mirrors Stripe subscription data locally for fast access without API calls. Updated via Stripe webhooks.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| stripe_subscription_id | TEXT | Stripe subscription ID. Unique. |
| stripe_customer_id | TEXT | Stripe customer ID. |
| status | TEXT | 'trialing', 'active', 'past_due', 'cancelled', 'unpaid'. Mirrored from Stripe. |
| plan | TEXT | Current plan identifier. |
| seat_count | INTEGER | Number of seats on this subscription. |
| unit_price | DECIMAL(10,2) | Price per seat per month. |
| currency | TEXT | Billing currency. 'usd' or 'gbp'. |
| current_period_start | TIMESTAMPTZ | Start of the current billing period. |
| current_period_end | TIMESTAMPTZ | End of the current billing period. |
| trial_end | TIMESTAMPTZ | When the trial ends. NULL for non-trial subscriptions. |
| cancelled_at | TIMESTAMPTZ | When the subscription was cancelled. |
| cancel_at | TIMESTAMPTZ | When the subscription will be cancelled (for scheduled cancellations). |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification — updated on every Stripe webhook. |

**Indexes:**
- `organisation_id` — unique. One subscription per organisation.
- `stripe_subscription_id` — unique. For webhook processing.
- `status` — for monitoring subscription health.
- `current_period_end` — for renewal monitoring and dunning.

---

### Table: `billing_invoices`

Invoice records mirrored from Stripe. For admin visibility and customer billing history.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| stripe_invoice_id | TEXT | Stripe invoice ID. Unique. |
| subscription_id | UUID | Foreign key to billing_subscriptions. |
| amount | DECIMAL(10,2) | Invoice total. |
| currency | TEXT | Invoice currency. |
| status | TEXT | 'draft', 'open', 'paid', 'void', 'uncollectible'. |
| invoice_url | TEXT | Stripe-hosted invoice URL. |
| pdf_url | TEXT | Invoice PDF URL. |
| period_start | TIMESTAMPTZ | Billing period start. |
| period_end | TIMESTAMPTZ | Billing period end. |
| paid_at | TIMESTAMPTZ | When payment was received. NULL if unpaid. |
| due_date | TIMESTAMPTZ | Payment due date. |
| created_at | TIMESTAMPTZ | Record creation. |

**Indexes:**
- `organisation_id` — for billing history per organisation.
- `stripe_invoice_id` — unique. For webhook processing.
- `status` — for monitoring unpaid invoices.
- `paid_at` — for revenue reporting.

---

## Section 22 — Marketplace

### Table: `marketplace_listings`

Commands published to the marketplace. Schema complete and ready. UI deferred to a later stage.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| command_id | UUID | Foreign key to commands. The command being listed. |
| published_by_org | UUID | Foreign key to organisations. |
| published_by_user | UUID | Foreign key to users. |
| category | TEXT | 'factor_analysis', 'risk', 'portfolio_construction', 'macro', 'reporting', 'utility', 'other'. |
| name | TEXT | Marketplace display name. May differ from the command's internal name. |
| description | TEXT | Full description shown in the marketplace. |
| short_description | TEXT | One-line summary for listing cards. |
| tags | TEXT[] | For search and filtering. |
| screenshots | TEXT[] | GCS URLs of screenshot images. |
| is_free | BOOLEAN | Whether this listing is free to install. |
| price | DECIMAL(10,2) | Price if not free. NULL for free listings. |
| currency | TEXT | Price currency. |
| install_count | INTEGER | Total installs. Cached counter. |
| average_rating | DECIMAL(3,2) | Average rating 1-5. Cached and recomputed. |
| rating_count | INTEGER | Number of ratings. |
| published_at | TIMESTAMPTZ | When listed. |
| updated_at | TIMESTAMPTZ | Last content update. |
| delisted_at | TIMESTAMPTZ | When removed from the marketplace. NULL if active. |

**Indexes:**
- `published_by_org` — for an organisation's marketplace listings.
- `category` — for category browsing.
- `tags` — GIN index for tag search.
- `is_free` — for filtering free vs paid.
- `install_count` — for popular listings sorting.
- `average_rating` — for top-rated sorting.
- `published_at` — for newest listings.

---

### Table: `marketplace_installs`

Records of organisations installing marketplace commands.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| listing_id | UUID | Foreign key to marketplace_listings. |
| installed_by_org | UUID | Foreign key to organisations. |
| installed_by_user | UUID | Foreign key to users. |
| installed_at | TIMESTAMPTZ | Installation timestamp. |
| version_installed | INTEGER | Which version of the command was installed. |
| uninstalled_at | TIMESTAMPTZ | When uninstalled. NULL if still installed. |

**Indexes:**
- `listing_id` — for install count tracking.
- `installed_by_org` — for an organisation's installed marketplace commands.
- `uninstalled_at` — partial index where NULL for active installs.

---

### Table: `marketplace_ratings`

User ratings and reviews for marketplace listings.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| listing_id | UUID | Foreign key to marketplace_listings. |
| rated_by_org | UUID | Foreign key to organisations. |
| rated_by_user | UUID | Foreign key to users. |
| rating | INTEGER | 1-5. |
| review | TEXT | Optional written review. |
| created_at | TIMESTAMPTZ | When rated. |
| updated_at | TIMESTAMPTZ | Last update. |

**Indexes:**
- `listing_id` — for fetching ratings for a listing.
- `(listing_id, rated_by_org)` — unique composite. One rating per organisation per listing.

---

## Section 23 — Admin

### Table: `admin_users`

Platform-level administrators. Separate from organisation admins. Can access all organisations, billing, user management, and system configuration.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. Unique. |
| access_level | TEXT | 'read_only', 'support', 'full'. Read-only can view everything. Support can impersonate and resolve issues. Full can modify system configuration. |
| granted_by | UUID | Foreign key to users. Who granted admin access. |
| granted_at | TIMESTAMPTZ | When admin access was granted. |
| revoked_at | TIMESTAMPTZ | When revoked. NULL if still active. |

**Indexes:**
- `user_id` — unique. One admin record per user.
- `access_level` — for filtering by admin type.

---

### Table: `feature_flags`

Feature flags for staged rollouts and A/B testing. Controls which organisations see which features before general availability.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| key | TEXT | Flag identifier. e.g. 'marketplace_beta', 'advanced_monte_carlo'. Unique. |
| description | TEXT | What this flag controls. |
| is_enabled_globally | BOOLEAN | Whether the feature is enabled for all users. |
| enabled_for_orgs | UUID[] | Specific organisations where this flag is enabled even if not globally. |
| rollout_percentage | INTEGER | 0-100. Percentage of organisations to enable for. Used for gradual rollouts. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `key` — unique. For feature flag lookups.
- `is_enabled_globally` — for fetching globally enabled features.

---

### Table: `system_announcements`

Platform-wide announcements shown to users — maintenance windows, new feature announcements, important notices.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| title | TEXT | Announcement title. |
| content | TEXT | Full announcement content. Markdown. |
| type | TEXT | 'info', 'warning', 'maintenance', 'new_feature'. |
| target | TEXT | 'all', 'admins', 'specific_plans'. |
| target_plans | TEXT[] | If target is 'specific_plans' — which plans. |
| starts_at | TIMESTAMPTZ | When to start showing the announcement. |
| ends_at | TIMESTAMPTZ | When to stop showing it. NULL for permanent. |
| created_by | UUID | Foreign key to admin_users. |
| created_at | TIMESTAMPTZ | Record creation. |

**Indexes:**
- `starts_at, ends_at` — for finding currently active announcements.
- `type` — for filtering by announcement type.

---

## Section 24 — Notifications

### Table: `notifications`

In-platform notifications for users — alert events, share invitations, certification milestones, report ready, system messages.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| user_id | UUID | Foreign key to users. Who this notification is for. |
| type | TEXT | 'alert_triggered', 'share_received', 'share_accepted', 'certification_eligible', 'certification_issued', 'report_ready', 'command_updated', 'system'. |
| title | TEXT | Short notification title. |
| message | TEXT | Full notification message. |
| data | JSONB | Contextual data — links, IDs, relevant context for rendering the notification. |
| action_url | TEXT | Where to navigate when the notification is clicked. |
| is_read | BOOLEAN | Whether the user has read this notification. |
| read_at | TIMESTAMPTZ | When marked as read. |
| created_at | TIMESTAMPTZ | When created. |

**Indexes:**
- `user_id` — for a user's notification inbox.
- `(user_id, is_read)` — composite for unread count queries.
- `type` — for filtering by notification type.
- `created_at` — for chronological ordering and cleanup of old notifications.

**Partitioning:**
Partitioned by RANGE on created_at by month. Old notifications are archived after 6 months.

---

## Section 25 — Onboarding

### Table: `onboarding_sessions`

Tracks in-person and remote onboarding sessions. Used for scheduling, notes, and follow-up management.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| conducted_by | UUID | Foreign key to users. The Sable team member conducting onboarding. |
| type | TEXT | 'in_person', 'remote'. |
| status | TEXT | 'scheduled', 'completed', 'cancelled', 'rescheduled'. |
| scheduled_at | TIMESTAMPTZ | When the session is scheduled for. |
| completed_at | TIMESTAMPTZ | When it actually happened. |
| location | TEXT | For in_person — the office address. For remote — the video call platform and link. |
| attendees | JSONB | Who attended from the customer side — [{name, role, email}]. |
| notes | TEXT | Session notes — what was configured, what was discussed, outstanding items. |
| commands_configured | UUID[] | IDs of commands created or configured during the session. |
| feedback | TEXT | Customer feedback from the session. |
| follow_up_items | JSONB | Outstanding items to address after the session — [{item, owner, due_date, completed}]. |
| welcome_box_shipped | BOOLEAN | Whether the welcome box has been sent. |
| welcome_box_shipped_at | TIMESTAMPTZ | When the box was shipped. |
| welcome_box_tracking | TEXT | Shipping tracking reference. |
| created_at | TIMESTAMPTZ | Record creation. |
| updated_at | TIMESTAMPTZ | Last modification. |

**Indexes:**
- `organisation_id` — for finding onboarding sessions for an organisation.
- `conducted_by` — for a Sable team member's session schedule.
- `status` — for filtering by session status.
- `scheduled_at` — for the upcoming sessions calendar.
- `welcome_box_shipped` — partial index where FALSE for pending shipments.

---

### Table: `onboarding_checklist_items`

Tracks completion of onboarding steps for each organisation. Drives the onboarding progress view in the admin dashboard.

**Columns:**

| Column | Type | Purpose |
|---|---|---|
| id | UUID | Primary key. |
| organisation_id | UUID | Foreign key to organisations. |
| item | TEXT | The checklist item. e.g. 'first_portfolio_created', 'first_command_run', 'risk_limits_configured'. |
| completed | BOOLEAN | Whether this item is done. |
| completed_at | TIMESTAMPTZ | When completed. |
| completed_by | UUID | Foreign key to users. |

**Indexes:**
- `organisation_id` — for fetching all checklist items for an organisation.
- `(organisation_id, item)` — unique composite.
- `completed` — partial index where FALSE for finding incomplete items.

---

## Summary — Table Count

| Section | Tables |
|---|---|
| Identity and Access | users, user_sessions |
| Organisations and Users | organisations, organisation_members, organisation_invitations |
| Roles and Permissions | roles, permission_definitions |
| Strategies and Portfolios | strategies, portfolios |
| Positions and Transactions | positions, transactions, transaction_import_batches |
| Commands | commands, command_versions, command_parameters |
| Command Runs | command_runs |
| Research: Theses | theses, thesis_versions, thesis_comments |
| Research: Notes | research_notes |
| Research: Documents | research_documents, document_annotations |
| Watchlists | watchlists |
| Dashboards and Layouts | dashboards, dashboard_widgets, workspace_layouts |
| Market Data Cache | price_cache, fundamentals_cache, security_metadata, news_cache |
| Risk and Alerts | risk_snapshots, risk_limits, alerts, alert_events |
| Compliance | compliance_rules, compliance_checks |
| Clients and Reporting | clients, report_templates, client_reports, client_communications |
| Sharing and Permissions | resource_shares, share_notifications |
| Certification and Ledger | certifications, certification_ledger |
| Usage and Hours | usage_sessions, certification_hours, exam_attempts |
| Audit Log | audit_log |
| Billing | billing_subscriptions, billing_invoices |
| Marketplace | marketplace_listings, marketplace_installs, marketplace_ratings |
| Admin | admin_users, feature_flags, system_announcements |
| Notifications | notifications |
| Onboarding | onboarding_sessions, onboarding_checklist_items |
| **Total** | **56 tables** |

---

## Partitioned Tables

| Table | Partition Strategy | Reason |
|---|---|---|
| command_runs | RANGE on created_at by month | Highest volume table. 100k+ rows/day at scale. |
| audit_log | RANGE on created_at by month | Append-only, grows indefinitely. |
| price_cache | RANGE on date by year | Historical data queries are time-bounded. |
| risk_snapshots | RANGE on computed_at by month | High frequency computation results. |
| compliance_checks | RANGE on checked_at by month | Frequent writes, time-bounded queries. |
| usage_sessions | RANGE on started_at by month | High volume, time-range queries for hours calculation. |
| notifications | RANGE on created_at by month | High volume, old notifications archived. |
| transactions | RANGE on executed_at by year | Large portfolios accumulate thousands of rows. |

---

## Append-Only Tables

| Table | Reason |
|---|---|
| certification_ledger | Tamper-proof. Cryptographic chain integrity requires immutability. |
| audit_log | Legal and compliance requirement. Cannot be modified. |
| transactions | Financial record immutability. Errors corrected by new correcting transactions. |
| command_runs | Historical record. Never modified after creation. |
| compliance_checks | Point-in-time compliance record. |

---

## Full Text Search Indexes

| Table | Indexed Columns | Use Case |
|---|---|---|
| theses | title, thesis_statement | Search thesis content |
| research_notes | title, content | Search note content |
| research_documents | content_extracted | Search document text |
| security_metadata | name, short_name | Security search by name |

---

*Sable Terminal Database Design v1.0*
*56 tables · 8 partitioned · 5 append-only · Raw PostgreSQL · No ORM*
