# Investment Tracker

A family portfolio tracker for Indian investors: stocks (India and US), mutual funds, gold/silver ETFs, P2P loans,
fixed deposits, EPF, NPS and a USD broker wallet. It answers, in order: **am I OK, am I on track, what should I do
now, why did it move, what exactly do I own.** Each family member signs in to their own portfolio; admins switch
between members or see the whole family.

- **Frontend:** Angular 19 (standalone components, signals, OnPush, lazy routes), deployed on Netlify. Installable as a PWA.
- **Backend:** Flask API (`backend/tracker`), deployed on Render. Data in Turso (libSQL) or a local SQLite file.

## What it does

Navigation follows the questions: **Home · Portfolio · Plan · Actions · Markets**, with Activity, Tax, Reports and
Settings under More. Every page uses one tier grammar (T0 verdict, T1 the few things that matter, T2 why, T3 detail),
one status vocabulary (good / watch / act / unset) and labels every forward-looking number as an estimate.

| Page | What it answers |
|---|---|
| **Home** `/` | The answer ladder from one `/brief` call: a status headline and value, five vitals (Data freshness, Emergency cushion, Risk vs profile, Mix vs target, Money at risk), the top ranked actions, on-track cards (plan, you vs Nifty 50 on your own cash flows, SIP habit), a context line (market correction, tax window, review due), why it moved, where the money is, money coming in and going out over the next 90 days |
| **Actions** `/actions` | Every recommendation ranked by real rupees into Now / This month / Worth considering / Good news, with Planned, Done and Snoozed. Plan, snooze, mark done or dismiss each one; SIP buys, FD redeploys and harvests are detected and marked done automatically. Deploy-money planner, tax moves, follow-through score, a six-step quarterly review (`?tab=review`) with health check-up, and an optional AI analyst |
| **Plan** `/plan` | Overview (portfolio fan chart, funding stack: cushion, earmarked goals, free money; SIP needed vs invested; what moves the needle), Goals (chance of success, SIP needed in 75 of 100 futures, linked SIPs), Retirement (corpus, chance of reaching it and of the money lasting to life expectancy, EPF/NPS as products, depletion age), Scenarios (up to five saved what-ifs compared on common random numbers) |
| **Portfolio** | **Holdings** (`/holdings/all` and one page per class, column chooser, XIRR and total return), **Performance** (TWR/XIRR vs Nifty 50 / Nifty 500 / S&P 500 / gold, attribution, assumptions check, income), **Risk & mix** `/risk` (risk profile, target mix, rebalance planner with tax-ordered sells and let-FDs-mature, stress tests by β with the effect on your plan, value at risk, correlation, concentration). Class pages for P2P, FDs, USD wallet, EPF and NPS lead with what can go wrong in that class |
| **Holding** `/holding/:id` | Verdict, its own actions, chart, one signal vocabulary (trend, momentum, Wilder RSI, labelled "price pattern, not a forecast"), statistical price range, FIFO lots with long-term dates, plan-a-sale with the tax |
| **Tax** `/tax` | FY estimate on FIFO lots (STCG/LTCG, set-off, ₹1.25 L exemption, slab and cess), ways to save (loss harvest, tax-free LTCG harvest plan, wait-for-long-term), what-if sale for any holding |
| **Activity** | Transactions (paged, searchable), Cash flows (past 24 and next 12 months on one axis), Recurring plans (this month's money, SIP adherence, planned vs actual, arriving money), Import |
| **Markets** `/markets` | Today, Ideas (Nifty 200 one-week / one-month signals), Watchlist & IPOs; a calm-playbook banner in a correction or crash; push alerts for big moves |
| **Reports** `/reports` | Portfolio summary, holdings, valuation history, performance review, XIRR, capital gains, ITR Schedule 112A, unrealised gains, income, transactions, holding statement, cash flow; Excel export and print to PDF |
| **Settings** `/settings` | Profile & emergency cushion, alerts and the daily digest, prices & tickers, family, editable assumptions (return, volatility, inflation per class). An admin editing a member's view edits that member's settings |
| **Bell and digest** | Do-now actions and events within 7 days, seen state per person; a daily push at 09:15 IST of up to three do-now actions not pushed before |
| **Imports** | CAS PDF (CAMS / KFintech, NSDL NPS, demat check) via `casparser`; Zerodha Kite tradebook; EPF passbook; CSV template; LenDenClub reports. CSV and CAS commits are atomic |

Old URLs (`/forecast?tab=…`, `/goals`, `/insights`, `/analytics`, `/admin`) redirect to their new homes.

## Project layout

```
backend/
  app.py                 gunicorn entry point (app:app)
  manage.py              backup / migrate / verify / status commands
  tracker/
    db.py                SQLite + Turso clients (atomic batches)
    migrations.py        versioned schema migrations (incl. one-time legacy import)
    ledger.py            scoped reads, validated writes, paging, atomic bulk import, action log, KPI snapshots
    security.py          Google sign-in, JWT sessions, roles
    prices.py            Yahoo Finance + AMFI quotes and cached daily history
    services.py          memoised use-cases: one shared context per scope, then brief, actions, plan, risk, tax…
    notices.py           the bell and the daily digest
    markets.py           Nifty 200 scan, market state (correction / crash)
    analytics/           pure engines (no I/O):
      portfolio, history, xirr      FIFO lots, valuation, TWR / XIRR, benchmarks
      assumptions                   the Assumption Book: return, volatility, correlation, inflation per class
      actions, brief, insights      ranked actions with follow-through; the Home brief; rule catalogue
      goals, mc, plans              goal projection and funding; Monte Carlo helpers; SIP schedule and adherence
      simulate, forecast            correlated per-class Monte Carlo; projection, retirement, cash flow, stress
      scenarios, calibration        plan compare and sensitivities; how past projection bands held up
      quant, signals, optimizer     risk v2 and holding outlook; one signal vocabulary; target mix suggestions
      tax, calendar, story, health  tax + what-if + harvest plan; 90-day upcoming; narratives; check-up score
    data/festivals.json  festival dates for the money calendar (extend before they run out; a test warns)
    reports.py           reports centre (one table shape, Excel export)
    importers/           CAS, LenDen, Kite, EPF and CSV parsers
    api/                 Flask blueprints
  tests/                 pytest suite (offline)
frontend/src/app/
  core/                  API client and models, auth, store (signals), ActionService and ActionRunner, formatting
  shared/priority/       the priority grammar: status badge, verdict card, vital chip, action card, assumption chip
  shared/                charts, transaction form, rebalance planner, what-if sale, nav list, dialogs, icons
  layout/                app shell (question navigation, portfolio switcher, prices pill, bell, mobile bottom bar)
  features/              one folder per page (overview = Home, actions, plan, holdings, performance, risk, tax, …)
design/next-gen/         SPEC.md, WAVES.md and AMENDMENTS.md (AMENDMENTS wins where they differ)
```

## Data model

Everything is a **ledger**: `instruments` (a stock, fund, ETF, P2P loan, FD, EPF, NPS or the USD wallet) and
`transactions` (BUY, SELL, DIVIDEND, INTEREST, REPAYMENT, MATURITY, FX_IN, FX_OUT, plus CREDIT for EPF interest and
BONUS / SPLIT corporate actions). `cash_movements` keeps capital flows and the P2P escrow; entries created from a
transaction are linked to it and follow edits and deletes.

Planning and follow-through tables:

- `sip_plans`: recurring investments you intend to make, each optionally linked to a goal (`goal_id`). They drive
  adherence, "due now", the forecasts and the cash-flow calendar. A plan linked to a goal funds that goal only.
- `goals` and `user_settings`: target allocation, risk profile, retirement plan, emergency cushion, assumption
  overrides, saved plan scenarios, alerts. Settings are per member, falling back to the family's.
- `action_log`: one row per action and person (open, planned, snoozed, done, dismissed, expired; first seen, evidence,
  seen and pushed stamps). It is written without bumping the ledger version, so recording what you did keeps every
  cached figure warm.
- `kpi_snapshots`: one row per person per day (status, vitals, plan chances, the one-year projection band), so Home can
  say what changed since you last looked and calibration can check old bands against what happened.

Forecasts are Monte Carlo over correlated monthly returns per asset class, with SIPs routed to their class, FD/P2P/EPF
at their own rates, lock-ins, and a glide path into retirement. Return and volatility come from one Assumption Book
(editable in Settings), blended with the portfolio's own record once it has history; every projection states its
assumptions and is an estimate, not a promise.

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
cd backend && python -m pytest -q        # offline; includes a reconciliation test against backups/turso-*.sqlite if present
cd frontend && npx ng build              # strict template type-checking
cd frontend && npm run check             # ngc over every app file, including components no route loads yet
```

For a UI check against mocked data, build with `npx ng build --configuration development`; the default build points
at the hosted API.

## Operations

```bash
python manage.py backup      # read-only copy of every table into backups/backup-<timestamp>.sqlite
python manage.py migrate     # apply pending migrations (also runs automatically at start-up)
python manage.py verify      # legacy tables vs ledger control totals
python manage.py status
python manage.py vapid-keys  # key pair for push notifications
python manage.py job-token   # secret for the scheduled jobs
```

### Scheduled jobs, price alerts and push notifications

Two GitHub workflows call the API with the job token:

- `.github/workflows/market-scan.yml` calls `POST /api/jobs/market-scan` every 30 minutes while NSE is open. It
  refreshes prices, warms the Markets page and sends price alerts.
- `.github/workflows/daily-digest.yml` calls `POST /api/jobs/daily-digest` every day at 09:15 IST. It pushes each
  person who turned the digest on up to three do-now actions they have not been pushed before (a retry sends nothing
  twice).

To turn them on:

1. On the API host, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (from `manage.py vapid-keys`) and `JOB_TOKEN`
   (from `manage.py job-token`).
2. In the GitHub repository, add the secrets `API_URL` (the API's base URL) and `JOB_TOKEN` (the same value).
3. On each phone or computer, open Settings → Alerts → Turn on notifications (and the daily digest if wanted). On an
   iPhone, add the app to the Home Screen first and open it from there.

Without the keys, alerts and actions still appear under the bell; without the secrets, nothing is scheduled.

Environment variables are listed in `backend/.env.example`. Secrets (Turso token, JWT secret, AI keys) belong in the
Render dashboard or a local `.env`, never in the repository.
