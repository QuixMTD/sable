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
