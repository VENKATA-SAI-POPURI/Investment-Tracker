# Investment Tracker

A personal portfolio tracker for Indian investors: stocks (India and US), mutual funds, gold/silver ETFs, P2P loans,
fixed deposits and a USD broker wallet — with returns, risk, tax and goal analysis on top.

- **Frontend:** Angular 19 (standalone components, signals, lazy routes), deployed on Netlify. Installable as a PWA.
- **Backend:** Flask API (`backend/tracker`), deployed on Render. Data in Turso (libSQL) or a local SQLite file.

## What it does

| Area | Highlights |
|---|---|
| Overview | Net worth, today's change, unrealized / total gain, XIRR, value vs money invested, allocation vs target, top insights |
| Holdings | Per-holding quantity, FIFO cost, live price, unrealized P&L, XIRR, weight; stock vs currency gain for US shares; ELSS lock-in |
| Performance | Time-weighted and money-weighted returns, volatility, drawdown, Sharpe, monthly returns, comparison with Nifty 50 / Nifty 500 / S&P 500 / gold using your own cash flows |
| Tax | Realized STCG/LTCG per financial year on FIFO lots, loss set-off, ₹1.25L equity exemption, estimated tax, loss harvesting, tax-free LTCG harvesting, "wait N days" alerts |
| Goals | Earmark parts of the portfolio, Monte Carlo probability of success, required SIP |
| Insights | Rule-based alerts (drift, concentration, P2P overdue/defaults, FD maturities, tax, stale prices, SIP gaps, reviews), rebalancing planner, optional AI analyst |
| Imports | CSV template or Zerodha tradebook; LenDenClub order report and statement |

## Project layout

```
backend/
  app.py                 gunicorn entry point (app:app)
  manage.py              backup / migrate / verify / status commands
  tracker/
    db.py                SQLite + Turso clients (atomic batches)
    migrations.py        versioned schema migrations (incl. one-time legacy import)
    ledger.py            scoped reads, validated writes, automatic cash-flow entries
    security.py          Google sign-in, JWT sessions, roles
    prices.py            Yahoo Finance + AMFI quotes and cached daily history
    services.py          use-cases composed from the pieces above
    analytics/           portfolio (FIFO, valuation, XIRR), history, tax, goals, insights
    importers/           LenDen and CSV parsers
    api/                 Flask blueprints
  tests/                 pytest suite
frontend/src/app/
  core/                  API client, auth, store (signals), formatting
  shared/                charts, transaction form, dialogs, icons
  layout/                app shell (sidebar, top bar, mobile bottom nav)
  features/              one folder per page
```

## Data model

Everything is a **ledger**: `instruments` (a stock, fund, ETF, P2P loan, FD or the USD wallet) and `transactions`
(BUY, SELL, DIVIDEND, INTEREST, REPAYMENT, MATURITY, FX_IN, FX_OUT). `cash_movements` keeps capital flows and the
P2P escrow; entries created from a transaction are linked to it and follow edits and deletes.

The original per-asset tables (`equity`, `mutual_funds`, `p2p`, …) are copied into the ledger once by migration 2,
which checks control totals before writing and never modifies the old tables. `python manage.py verify` re-checks
those totals at any time.

## Run locally

```bash
# backend (http://localhost:5002)
cd backend
pip install -r requirements-dev.txt
cp .env.example .env          # fill in JWT_SECRET; leave TURSO_* empty to use local SQLite
python app.py

# frontend (http://localhost:4200, proxies /api to :5002)
cd frontend
npm install
npx ng serve --proxy-config proxy.conf.json
```

On Windows, `start.vbs` / `stop.vbs` start and stop both.

## Tests

```bash
cd backend && python -m pytest -q        # includes a reconciliation test against backups/turso-*.sqlite if present
cd frontend && npx ng build              # strict template type-checking
```

## Operations

```bash
python manage.py backup      # read-only copy of every table into backups/backup-<timestamp>.sqlite
python manage.py migrate     # apply pending migrations (also runs automatically at start-up)
python manage.py verify      # legacy tables vs ledger control totals
python manage.py status
```

Environment variables are listed in `backend/.env.example`. Secrets (Turso token, JWT secret, AI keys) belong in the
Render dashboard or a local `.env`, never in the repository.
