# Sable — Overview

> What Sable is, what it does, and why it exists.
> Version 1.0 — May 2026

---

## 1. What Sable Is

**Sable Terminal is a multi-asset quantitative operating system and wealth management infrastructure platform.**

It is not a dashboard, a reporting tool, or a portfolio tracker. It is the complete institutional infrastructure that boutique fund managers, UHNW individuals and serious alternative asset investors need to manage capital across every investable asset class — equities, property, crypto, alternatives and tax — from a single configurable environment.

Sable is delivered as a native desktop application (with web parity), built on a microservice backend, and priced as institutional SaaS.

---

## 2. The Problem Sable Solves

Institutional-grade investment infrastructure has historically required institutional-scale budgets:

| Incumbent | Annual cost | Audience |
|---|---|---|
| BlackRock Aladdin | Tens of millions | Mega-funds only |
| Bloomberg Terminal | ~£19,000 / seat | Banks, large funds |
| Limina IMS | From $39,000 / seat | Mid-tier asset managers |
| FactSet / Refinitiv | £15,000+ / seat | Banks, large funds |

Below that tier — boutique fund managers running £50M–£500M AUM, UHNW individuals, family offices, serious property investors and alternative asset specialists — there is **no equivalent**. They are forced to stitch together Excel, retail broker portals, manual spreadsheets, third-party tax tools and disconnected analytics.

**Sable is the equivalent at £999 per seat per month.**

---

## 3. What Sable Does

Sable replaces the entire stack a serious investor or boutique manager needs to operate:

### Across Five Asset Modules

| Module | What it does |
|---|---|
| **S&C (Stocks & Commodities)** | Equity holdings, EODHD market data, full quant analytics (Monte Carlo, Black-Litterman, factor analysis, VaR, backtesting), CSV import from any broker |
| **Property** | Property holdings, Land Registry valuations, AVM estimates, deal pipeline, map view, regional growth scenario analysis |
| **Crypto** | Holdings via read-only exchange API (Binance, Coinbase, Kraken, Gemini, OKX), on-chain analytics, DeFi yield modelling |
| **Alternatives** | Manual entry for vintage cars, art, wine, watches — valued by Vertex AI against live auction and dealer data |
| **Tax** | MTD compliance, CGT tracking, tax structuring — powered by the existing QuixMTD product |

Any module can be the entry point. There is no primary asset class. The user activates and pays for only the modules they need.

### A Unified Workspace

A Notion-like dockable companion panel where the user composes pages of live widgets, charts, holdings tables, notes, scripts and command outputs — all powered by live module data. The workspace stores configuration, never financial data.

### A Four-Tier Command System

Every command can target any asset (a ticker, `@portfolio`, `@watchlist`, `@property:address`, `@all`):

1. **AI Chatbot** — Claude-powered conversational assistant with read access to the user's full workspace state
2. **Natural Language Command** — Vertex AI resolves plain-English instructions into function calls
3. **Python Scripting** — In-app Python editor running in an isolated sandbox, with auto-injected market data
4. **Visual Flowchart Builder** — Drag-and-drop pipelines for users who don't write code

### A Unified Portfolio View

Sable aggregates holdings across every active module in real time and returns a single cross-asset portfolio with total value, allocation breakdown, and correlated risk metrics.

---

## 4. Unique Selling Points

### 4.1 Price–Capability Gap
The only product in the world that delivers institutional-grade multi-asset quantitative infrastructure at a price a boutique can afford. **£999/seat/month vs. Aladdin's tens of millions, Bloomberg's £19k, Limina's $39k.** This gap is not incremental — it is an entire market segment that has no software built for it.

### 4.2 True Multi-Asset, Not Multi-Asset-Bolted-On
Most platforms specialise in one asset class and bolt the others on. Sable is architected as separate, equally first-class modules — each with its own database, deployment and analytics — orchestrated by a single core. **Property, alternatives and crypto get the same quant rigour as equities**, adapted to the realities of each asset class.

### 4.3 Configurability Over Convention
There are no fixed workflows. The user defines how Sable works — which modules they activate, what their workspace looks like, which commands they wire into pipelines, which scripts they run. Sable behaves more like an operating system than an application.

### 4.4 Four-Tier Command System
No competitor offers conversational AI, natural-language commands, in-app Python and a no-code flowchart builder in a single product. **Quants get Python, analysts get the flowchart builder, principals get the chatbot — same data, same engine.**

### 4.5 Quantitative Rigour as a First-Class Citizen
A dedicated Python FastAPI quant engine (`sable-quant`) runs Monte Carlo (10,000 paths), Black-Litterman, mean-variance optimisation, walk-forward backtesting, factor attribution and VaR/CVaR. **Every calculation is mathematically correct. Every limitation is explicit.** No marketing-grade approximations.

### 4.6 Network Effects Built In
Cross-firm pipeline sharing, a property deal network, planned Sable Institute certification, and (Stage 5) Sable Light — a consumer retail platform built on the same infrastructure. **The platform becomes more valuable as more users join.**

### 4.7 Native Desktop Performance
Built in Flutter, Sable runs as a native desktop application on Mac, Windows and Linux from a single codebase. Renders to a native canvas, not a DOM — eliminating an entire class of web vulnerabilities and delivering terminal-grade responsiveness.

### 4.8 Institutional Security at SaaS Price
Three-layer API security (short-lived JWTs, HMAC request signing, certificate pinning), passive bot detection, hardware attestation, AST-validated Python execution, encrypted exchange keys in GCP Secret Manager. **Security posture that justifies enterprise procurement, at a price boutiques can sign without a procurement team.**

---

## 5. Product Philosophy

| Principle | Definition |
|---|---|
| Configurability over convention | No fixed workflows. The user defines how Sable works. |
| Rigour over impressiveness | Every calculation is mathematically correct. Every limitation is explicit. |
| Network over isolation | The platform becomes more valuable as more users join. |
| Modularity over fixed paths | Any module can be the entry point. No asset class is primary. |

---

## 6. Who Sable Is For

**Primary buyer:** Ex-institutional boutique fund managers running 2–10 person firms with £50M–£500M AUM. They left Goldman, BlackRock, AQR or Wellington to run their own book. They miss the tooling but cannot justify the cost.

**Secondary buyers:**
- UHNW individuals managing their own family wealth across asset classes
- Serious property investors with portfolios of 10+ assets
- Crypto-native treasuries and family offices
- Single-family offices (1–5 staff)
- Quant-curious wealth advisors who want a Python and flowchart layer over their book

**Not for:**
- Retail investors (that's Sable Light, Stage 5)
- Mega-funds already running Aladdin (different product entirely)
- Day traders looking for a charting tool

---

## 7. Pricing

| Tier | Price | Who |
|---|---|---|
| Any single module | £999 / seat / month | Everyone — individual or firm |
| Additional modules | Discounted add-on | Any active customer |
| Annual commitment | 2 months free | Annual subscribers |
| Founding customer rate | £799 / seat / month | First 10 firms only |
| Enterprise (10,000+ seats) | Custom ACV | Negotiated annual contract |

The £999 base rate is never discounted outside the founding customer programme. Discounts are structural, not negotiated per conversation.

---

## 8. The Wider Sable Ecosystem

Sable Terminal is the core product within a broader institutional ecosystem:

| Product | Status | Description |
|---|---|---|
| **Sable Terminal** | Building (launch August 2026) | The core platform |
| **Sable Tax** | Live (as QuixMTD) | MTD compliance for landlords and sole traders. Feeds tax data into the terminal. |
| **Sable Institute** | Planned Stage 2 | Tamper-proof, cryptographically verifiable certification. Usage hours trigger eligibility. |
| **Sable Intelligence** | Planned Stage 3 | Newsletter, magazine, 30 Under 30, Annual Summit |
| **Sable Light** | Planned Stage 5 | Consumer retail platform — Gro reborn on institutional infrastructure |

---

## 9. Go-to-Market Summary

**Phase 1 (now → August 2026):** US + UK simultaneous launch.
- Tommy: US market from Babson, Boston finance community (Fidelity, State Street, Wellington, AQR)
- Chris: UK market, London boutique fund managers
- Target: 3 paying customers before August

**Phase 2 (2027–2028):** Singapore + UAE/Dubai.

**Phase 3 (2028–2029):** Spain + EU via MiFID II passporting.

**Long-term:** Own brokerage (FCA + SEC + MAS + DFSA), Institute certification revenue, data licensing, marketplace transaction fees on the property and alternatives deal network.

---

## 10. One-Line Summary

> **Sable is the institutional investment terminal for everyone who isn't institutional.**

Aladdin-class infrastructure. Bloomberg-class breadth. Boutique-class price.

---

*Sable — Overview — May 2026 — Confidential*
