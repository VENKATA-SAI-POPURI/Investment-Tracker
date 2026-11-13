# Next-generation Investment Tracker: Specification, Part 1
## Priority rules, product tiers, information architecture and page designs

Scope of this part: the thesis and the priority rules, the P0–P3 tiers, navigation and the page list, the Dashboard from top to bottom, and every other page in priority order. Engine maths, the forecasting pipeline and the work list are in later parts. Where this part says **NEW**, it names a computation that Part 2 specifies. Field names are the existing backend and frontend names unless they are marked NEW.

Base design: **HIERARCHY**. Grafted in from the other proposals:
- **from ANALYTICS:** the Assumption Book with `book_hash`, HONESTY labels, typical-versus-average, shrunk volatility in the risk fix, calibration snapshots written early, and in P2 a factor Monte Carlo with common random numbers, sensitivities and stress-to-plan.
- **from DECISION:** a persisted `action_log` with auto-done and a follow-through score, "this month's money" with arriving money, confidence as a ranking factor, the harvest plan with the rebuy note, crash mode, the top-3 diversity rule, and "Due now" in the Add sheet.
- **Rejected:** synthetic rupee multipliers and a ranking dominated by severity. Every ₹ impact shown is a real amount.

---

## 1. Thesis and the priority rules

### 1.1 Thesis

The product answers five questions in a fixed order, and **every route, card, endpoint and pixel belongs to exactly one of them**. A question higher on the ladder is always placed higher on the screen, drawn larger, computed first and fetched first.

- **Home** renders priority and nothing else. One memoised read, `GET /brief`, ranks everything the engines already know.
- **Deep pages** repeat the same grammar: a navy answer, then status-striped verdict and action cards, then explanations, then detail.
- **Forecasts** are ranges under stated assumptions from one assumptions model. They are never price predictions.
- **No projection reaches T0/T1 until its engine bug is fixed.**

### 1.2 The question ladder

| Rung | Question | Answered by | Primary home | Computed / fetched |
|---|---|---|---|---|
| Q1 | **Am I OK?** | value, today's change, data trust, cushion, money at risk, crash context | Home T0 + vitals; class-page heroes | 1st: `/brief` (memo), store portfolio |
| Q2 | **Am I on track?** | goal and retirement probability, you vs Nifty, SIP habit | Home "Am I on track?"; `/plan` | 1st: `/brief.on_track` (market part may be `pending`) |
| Q3 | **What should I do now?** | ranked ₹-weighted actions with one-tap fixes | Home "Do this now"; `/actions`; page strips | 1st: `/brief.actions` |
| Q4 | **Why?** | attribution, drift, risk sources, stress, tax mechanics, assumptions | Home T2; `/performance`, `/risk`, Plan T2 | 2nd: after first paint (`/performance`, lazy cards) |
| Q5 | **Details** | holdings, ledger, lots, reports, settings | `/holdings/*`, `/transactions`, `/reports`, `/settings` | 3rd: on navigation or expand |

Rule: a new feature that cannot name its rung and tier goes to P3.

### 1.3 Tier grammar (applies to every page)

| Tier | Role | Surface | Contents | Fetch |
|---|---|---|---|---|
| **T0 Hero** | The page's answer. Exactly one per page, first under the page head | Navy. Home uses `.banner`; deep pages use `.kpis` with `.kpi.hero` first | 1 headline number (Home 40px/700, deep pages 28px/650), its delta pill, **one verdict sentence with a status icon**, ≤4 supporting stats (label 12px, value 18px), ≤1 context line | Same call as page data; painted from snapshot cache |
| **T1 Primary** | Verdicts, vitals, actions | White `.card` with a 4px left stripe in the status colour, status badge top-right (icon + word), one 24px number, one sentence, one CTA | `.vital`, `.verdict`, `.action-card` | Same call as T0 |
| **T2 Secondary** | Explanations: charts, breakdowns, planners | Plain `.card`, 15px h2; charts ≤290px tall; ≤2 cards per row | Each names and links the T1 verdict it explains ("Explains: Mix · watch") | After first paint; may show `.skeleton` |
| **T3 Drill-down** | Full tables, methodology, matrices, raw ledgers | `.card.flush` inside `details.more`, or its own route | Full ₹ precision | Only on expand or navigation; never auto-expanded |

### 1.4 Numeric admission thresholds (T1)

An item appears at T1 only if its status is `watch` or `act` **and** at least one of these holds:

| Condition | Threshold |
|---|---|
| Real ₹ impact | ≥ max(₹1,000, 0.25% × `totals.value`) |
| Deadline | `days` ≤ 30 (FD maturity, SIP due, tax date, goal date, ELSS unlock) |
| Plan probability | any goal or retirement whose status is `at_risk` / `off_track`, or a probability fall of ≥10 points against the snapshot from 30 days ago |
| Data trust | Data vital is `act` (always admitted) |

Below the threshold, the item goes to Actions › "Worth considering" (T2, collapsed). `positive` items are never T1; they go to "Good news".

### 1.5 Card budgets

| Surface | Budget |
|---|---|
| Home vitals | 5 fixed (Data, Cushion, Risk, Mix, Money at risk) |
| Home "Do this now" | ≤3 action cards; ≤1 per category; ≤1 `data` card unless `critical` |
| Home "Am I on track?" | exactly 3 verdict cards (plan, market, habit) |
| Home T2 | 3 rows; Home T3 = 4 link tiles |
| Deep-page "Needs attention here" | ≤2 cards, hidden when there are none |
| Hero stats | ≤4 per T0 (≤2 on phones; the rest behind "More") |
| `.btn.primary` | ≤1 per section; on Home only the top action's CTA |
| Context line | ≤1 per page |

### 1.6 Promotion and demotion rules

Any T2/T3 engine output whose status turns `act` is emitted as an Action. It then appears at T1 on Home (if it wins a slot) and on its own page's strip. When the status returns to `good`, it collapses back down: the action expires and the vital renders as a compact chip.

| Source (tier normally) | Promotes when | Becomes |
|---|---|---|
| Stress (T2, `/risk#stress`) | the `covid` scenario `impact_pct` < −2.5 × profile `target_vol_pct` | `stress:beyond-tolerance` (watch) |
| FD ladder (T3) | `days_to_maturity` ≤ 7 → now; ≤ 30 → month; < 0 with status active → act | `fd:maturing:<iid>` / `fd:matured-unrecorded:<iid>` |
| Plan row (T2) | probability ≤ snapshot −10 pts | `plan:probability-drop:<id>` |
| Data (chrome) | unpriced weight ≥ 5% or prices > 4 days old | Data vital act + `data:*` now |
| Concentration (T3) | `weight` ≥ 15% (MF ≥ 25%) | `concentration:<iid>` watch; Risk vital at least watch |
| Market (Markets page) | Nifty ≤ −10% from its 52-week high | Home context line (crash mode); never an `act` status |
| SIP schedule (T3) | due + 4 days passed and unmatched | `sip:missed:<id>:<date>` month |
| Tax (Tax T1) | Jan–Mar with `suggested_booking` > 0 | FY-window context line + `tax:ltcg-harvest` |

Demotion: snoozed, done, dismissed or expired actions leave every T1 surface at once. Unset vitals never raise the page status. They render as compact dashed chips with "Set →".

### 1.7 Action ranking (real ₹ only)

1. **Tier** decides placement:
   - `now` = critical severity, or 0 ≤ `days` ≤ 7, or a `data:*` action while the Data vital is act.
   - `month` = warning severity, or `days` ≤ 31.
   - `consider` = info.
   - `good` = positive.
2. **Within a tier**: `score = max(impact.amount, 1000) × U(days) × C(confidence)`, sorted descending, ties broken by `id`.
   - U: overdue or ≤3 days → 1.0; ≤7 → 0.85; ≤14 → 0.7; ≤31 → 0.5; ≤90 → 0.3; undated → 0.25.
   - C: `fact` 1.0 (dated ledger events, defaults, maturities); `estimate` 0.8 (tax computed from lots, drift ₹); `model` 0.6 (projection-based); `signal` 0.3 (market signals, watchlist).
3. **Impact must be a real rupee amount** taken from the data, never a multiplier:

| Category | `impact.amount` | Label |
|---|---|---|
| tax | `future_tax_saved`, what-if saving, `loss_harvest_offsettable` × top rate | "Saves ₹X tax (est.)" |
| p2p | Σ `at_risk`; Σ `outstanding` where `overdue_days` > 30 | "₹X at risk" |
| fd / cash | `maturity_value`; USD `value`; P2P principal back | "₹X to reinvest" |
| allocation | Σ\|drift\| × targeted value / 200 | "₹X off target" |
| habit | instalment `amount` | "₹X instalment" |
| goals | required_sip − monthly_contribution | "+₹X/month needed" (kind `monthly`) |
| data | Σ cost of positions in `missing_prices` | "₹X valued at cost" |
| risk | weight above 10% × value | "₹X above 10%" |
| performance, review | none | — |

`₹ at stake` = Σ impact of `now`+`month` actions whose `impact.kind = 'lump'` (monthly amounts are excluded so units never mix).

### 1.8 Status vocabulary (one, everywhere)

| Status | Word | Token | Icon |
|---|---|---|---|
| good | On track / Healthy | `--pos` | `checkCircle` |
| watch | Watch | `--warn` | `alert` |
| act | Act now | `--neg` | `alertOctagon` (NEW) |
| unset | Not set | `--border-strong` | `circleDashed` (NEW) |
| info | (neutral) | `--muted` | — |

Mappings:
- goal `achieved`/`on_track` → good, `at_risk` → watch, `off_track` → act.
- Insight severity: `critical` → act, `warning` → watch, `info` → info, `positive` → good.
- Probability: ≥75 → good, ≥40 → watch, else act (shared `STATUS_THRESHOLDS`).

Colour is never the only cue: every status badge shows its icon and word, and signed numbers carry +/−.

### 1.9 Honesty rules (copy is mandatory)

| Number | Shown as | Never shown as |
|---|---|---|
| p50 | "Typical — half of 1,000 simulated futures end higher" | "Expected", "Base" |
| p10 / p90 | "1-in-10 bad case" / "1-in-10 good case" | "Bear/Bull" at ±4% |
| mean | T3 only: "Average, pulled up by the best cases" | the dashed main line |
| probability | whole number, "72 of 100 futures" / "72% likely" | decimals, "will" |
| any forward ₹ | `est.` tag plus a tooltip naming its basis and the assumption chip | bare number |
| market signals | "price pattern, not a forecast" | targets or calls |

Every forward-looking card carries the **assumption chip** (P1), e.g. `11.0% avg · 9.6% typical · ±12.4% · 6% inflation`. It opens the Assumptions drawer and shows `book_hash`.

### 1.10 Visual rules

- **Colour**: navy only for T0; indigo `.btn.primary` per §1.5; gold only for the brand and the shell Add; green/red only for signed money and status; `--s1..--s8` only for segment identity.
- **Type scale**: 40/28/24/18/15/14/13/12.
- **Numbers**: T0 uses `inr` (0 dp) plus an `inrWords` line; T1 uses `inrc`; T3 uses full `inr`.
- **Eyebrows**: `.q-head` question eyebrows ("AM I ON TRACK?") head each ladder section on Home and Plan.

### 1.11 Compute and fetch priority

| Read | Budget | Rule |
|---|---|---|
| `/brief` | warm < 50 ms, cold < 800 ms | composes memoised context; never builds performance history (`_peek`); missing parts are listed in `pending[]` |
| `/actions`, `/plan` | warm < 50 ms | reuse `Services.context` |
| `/performance` | lazy, after paint | snapshot-cached per range |
| Monte Carlo (P2) | ≤1 s, 1,000 sims | on demand; guests capped at 500 sims |

All Home data paints first from the localStorage snapshot (`snapshotKey('brief', scopeKey)`) and is then revalidated.

### 1.12 Page template

Page head (h1 = the nav label; sub = scope · freshness) → T0 → T1 "Needs attention here" → T2 → T3.

Exceptions are the tool pages: Settings, Import and Reports have a head and content only.

---

## 2. Priority tiers

### P0: must be right and seen first (weeks 1–2)

| # | Item | Why | UI placement | Functionality |
|---|---|---|---|---|
| P0.1 | **Honest engines before promotion** | Confirmed defects:<br>- retirement shows "On track" at 37.9% and the money runs out at 84 of 85;<br>- Base and the dashed line are the mean, 13% above the median;<br>- FD interest continues after maturity, and payout-FD maturity interest is ~10× too high;<br>- dividends are double-counted;<br>- risk treats FD/EPF as 0% and zero-fills history, so a 40/60 mix gets Sharpe −0.17 and new holdings show half their volatility. | No new UI. Corrected labels on the Plan fan (§1.9); Retirement hero leads with probability. | `forecast.retirement_plan`:<br>- annuity-due in both corpus and path;<br>- path monthly, matching `projected`;<br>- stops at `life_expectancy`;<br>- status from probability;<br>- `retire_age ≤ current_age` → 400.<br><br>`project_portfolio`: scenarios = p10/p50/p90 of the same simulation; `expected` documented as the mean.<br><br>`cash_flow_forecast`:<br>- cut FD interest at `maturity_date`;<br>- payout-FD maturity interest pro-rata;<br>- start tomorrow;<br>- dividends per share × current qty.<br><br>`quant.portfolio_risk`:<br>- ballast accrues at its rate;<br>- each holding counts only from its own first close;<br>- volatility shrunk toward the segment prior;<br>- proxy rows flagged. |
| P0.2 | **One shared context, memo-safe** | `/insights`, `/pulse` and `/notifications` each recompute portfolio + tax + goals. `GET /portfolio` pops `realized_lots` from the cached dict (analytics_api.py:32). | Invisible. | `Services.context(scope, settings)` = {port, data, tax (current FY), goals, sips} memoised; read by insights, pulse, notifications, goals, tax, actions, brief, plan. `/portfolio` returns a copy without `realized_lots`. `_peek()` reads the performance memo without building it. |
| P0.3 | **Ranked actions + Actions in primary nav** | The only actionable intelligence sits on an orphaned page. Deadlines live in 4 places with no common rank. Nothing records whether advice was followed. | Nav slot 4 "Actions" with a badge. Top 3 on Home. ≤2 per page strip. Bell. | NEW `analytics/actions.py`: merges insights, calendar, cash-flow events, SIP due/missed and tax opportunities into Action {id, tier, severity, category, title, detail, impact{amount, kind, label}, due, days, confidence, cta, link, score}, ranked per §1.7.<br><br>NEW `action_log` table (statuses open/planned/snoozed/done/dismissed/expired; `first_seen`). It is written directly with `INSERT OR IGNORE`/upsert and **never calls `Ledger._bump`**. Its own `actions_rev` counter goes into the actions/brief memo keys. `dismissedInsights` is migrated into it. |
| P0.4 | **Answer-ladder Home via `/brief`** | Home opens on a value banner and an asset-class table and never answers "OK / on track / do what". `Pulse.health` is fetched but never shown. | Route `/`, §4. | NEW `GET /brief?since=` returns {status, hero, vitals[5], actions[≤5], on_track, why, allocation, upcoming, tax, deploy, freshness, pending[]}. Home stops calling `/pulse`, `/markets` and `/rebalance`. |
| P0.5 | **Priority visual grammar + honesty copy** | Every card has the same weight, and pos/neg colour is the only cue. | `styles.scss`: `.q-head .verdict[data-status] .status .vital .action-card .impact .est`; `shared/priority.ts`. | Status tokens `--st-good/watch/act/unset`. Components StatusBadge, VerdictCard, VitalChip, ActionCard. `ActionRunnerService` dispatches a CTA to a dialog, route or API. `TxnDialogState` gains `amount`, `quantity`, `date`, `notes`, `actionId`. |
| P0.6 | **Navigation by question** | Forecast is a 7-tab toolbox, performance hides under Markets, Goals and Tax sit in More, and Insights is orphaned. | §3. | New routes and redirects. Insight links are remapped in `insights.py`, with a regression test that every link is a real route. The shell renders the route title as h1. |
| P0.7 | **Data trust visible** | Every number depends on prices. Today staleness is flagged only after 4 days, and the refresh pill disappears ≤1180px. | Data vital; prices pill at every width (a coloured dot ≤1180px, tap to refresh); Home sub-line. | `brief.freshness` {last_refresh, age_minutes, missing_prices, missing_weight_pct, stale}. Data vital: good (≤26 h, nothing unpriced); watch (unpriced weight 0–5% or age 1–4 days); act (≥5% or >4 days). Headline wording blames the data, not the portfolio. |

### P1: the core hubs (weeks 3–5)

| # | Item | Why | UI placement | Functionality |
|---|---|---|---|---|
| P1.1 | **Plan hub** (Goals + Retirement + Outlook) | Three engines project the same money. Retirement uses rupees already earmarked. Segment earmarks can exceed 100%. | `/plan` Overview \| Goals \| Retirement. | NEW `GET /plan` {status, goals, retirement\|null, funding{total, cushion, earmarked[], free, over_allocated[]}, sip{plans_monthly_total, goals_monthly_contribution, needed_monthly}, deltas}. |
| P1.2 | **Assumption Book (segment level)** | Three volatility models; RISK_FREE and inflation defined twice. The Risk vital and the Plan fan must agree. | Assumption chip on every forward card; Plan Assumptions card; Settings › Profile (read-only). | NEW `analytics/assumptions.py`: ASSUMPTIONS, CORR (from `_CORR_ROWS`), RISK_FREE 6.5%, INFLATION 6%, DEBT_MF by category, `mu_sigma(weights)`, `overrides(settings)`, `book_hash`, HONESTY, `status_for`. |
| P1.3 | **Portfolio hub** | Performance is under Markets. The asset-class table takes Home's hero slot. Holdings lack XIRR/total-return columns. Empty classes can't be reached. | Tabs Holdings \| Performance \| Risk & mix; `/holdings/all` is the default. | Column chooser saved in localStorage. Empty classes greyed under "+ more". Attribution moves to Performance; Concentration moves to Risk. |
| P1.4 | **Risk & mix page** | Six places answer "is my mix right for my risk". | `/risk`, §5.6. | Merges Allocation lab, Settings targets, the Insights planner, Stress and Risk. FD/P2P rows read "Redirect maturities". |
| P1.5 | **Coming up · 90 days + arriving money** | FD maturities are listed 3 times, none with SIP dates or ₹ totals. | Home T2; Recurring "Arriving"; Cash flows future view. | NEW `calendar.upcoming()` merges calendar (minus `national`), the fixed cash-flow events, SIP `next_due` and IPO dates, with amounts; plus `inflow_90d`, `outflow_90d`. |
| P1.6 | **SIP adherence + "This month's money"** | SIP plans are intent only. The missed check is monthly-only. SIP day has no single place. | `/recurring` (Activity tab); Home habit card; "Due now" row in the Add sheet. | NEW `analytics/plans.py`: `due_dates` for all frequencies, `sip_adherence` (one BUY satisfies one plan), `next_due`. "Record instalment" opens a TxnDialog prefilled per row; the user confirms units, so no auto-write. |
| P1.7 | **Tax what-if + harvest plan** | Harvest suggestions cannot become a planned sale, and a SELL shows no tax. | Tax "Ways to save" and "What if I sell"; holding lots; Risk sell rows; Action CTAs. | NEW `GET /tax/what-if` (compute_tax with the hypothetical lots minus without them, `wait` hint). NEW `opportunities.harvest_plan` per lot, with the note "Rebuy the next trading day — a same-day rebuy is netted as intraday and books nothing." |
| P1.8 | **KPI snapshots** | Change is invisible: there are no past KPIs. Calibration needs early data. | Hero "Since {date}"; ▲/▼ on plan rows; "N new" on actions. | NEW `kpi_snapshots(owner, date, data)`, one row per day with `INSERT OR IGNORE` and no `_bump`. Data includes `projection_1y{p10, p50, p90}` (calibration later) and `action_ids`. |
| P1.9 | **Emergency cushion vital** | No INR cash class; "safe if income stops" is invisible. | Home vital; Settings › Profile & cushion; Plan funding stack. | NEW setting `emergencyFund{months_target 3–24 (6), monthly_expenses, instrument_ids}`. **Auto-suggest**: FDs maturing ≤12 months, Debt/Liquid MFs and the USD wallet are pre-ticked candidates. Unset never drags the hero status. |
| P1.10 | **Auto-done + follow-through** | It is a coach only if it knows what was done. | Actions hero tile "Follow-through"; Done section ("Auto: BUY #812 · 12 Nov", Undo). | Done rules are evaluated on read (pure): an SIP BUY within the window ≥80% of the amount; FD redeploy BUYs ≥80% within 45 days; harvest done when `remaining_exemption` < ₹1,000. Persisted as `done_via='auto'` with an upsert that doesn't bump. |
| P1.11 | **Needs-attention strips** | An action belongs where its evidence is. | Under each deep page's T0. | Client filter of the cached `/actions` by link prefix. |
| P1.12 | **Crash/correction context** | A fall is rare, but it is when users panic-sell or stop SIPs. | Home context line; Markets banner. | NEW `market_state` from `^NSEI` closes: correction ≤ −10% from the 52-week high, crash ≤ −20% or w1 ≤ −8%. Fixed calm playbook; no price calls. |

### P2: reach and depth (weeks 6–9)

| # | Item | Why | UI placement | Functionality |
|---|---|---|---|---|
| P2.1 | **Plan engine v2** | One blended μ/σ sends SIPs into an FD-diluted mix and ignores lock-ins and sequence risk. | Plan fan, goals, Retirement "Money lasts to 85". | Correlated factor Monte Carlo with common random numbers and antithetic draws. SIPs routed to their segment. FD/P2P/EPF ladders. Drawdown phase with a glide path. Before/after-tax toggle. `probability_lasts`, `depletion_age_p10`. |
| P2.2 | **What moves the needle + Scenarios** | Users can't compare "+₹10k SIP" against "retire at 55". | Plan Overview tiles; Plan › Scenarios. | 4 sensitivities: SIP +max(₹5k, 10%), retire +2 years, returns −1 pt, inflation +1 pt; reported as Δ retirement points and Δ worst-goal points. `planScenarios` (≤5) compared with common random numbers. |
| P2.3 | **Stress v2 + stress-to-plan** | All MFs are shocked as equity, beta is ignored, recovery counts SIP money. | Risk › Stress. | Shocks by MF category and beta. "Markets alone" vs "with your SIPs". "Retirement 78% → 64%". |
| P2.4 | **Notifications + daily digest** | Only market alerts are pushed. | Bell; push at 09:15 IST. | `notifications()` built from `now` actions plus events ≤7 days; `seenNotices`. `POST /jobs/daily-digest` deduped via `action_log.pushed_at`. |
| P2.5 | **Quarterly review + check-up** | "Mark review done" only stamps a date; `Pulse.health` is unused. | Actions › Review. | Steps: what changed (snapshot deltas) → mix → concentration/laggards → plan → commitments. Health components appear as the check-up breakdown. |
| P2.6 | **Per-member settings** | An admin viewing a member edits `__global__` targets. | Banner "Editing {member}'s plan". | Settings owner = `g.scope` for a member; reads fall back to `__global__`. |
| P2.7 | **Goal ↔ SIP link** | Two sources of truth for monthly money. | SIP modal "Funds goal"; goal card "Funded by 2 SIPs". | `sip_plans.goal_id`; the goal uses the linked monthly total. |
| P2.8 | **Tax-aware rebalancing** | The optimiser says "trim P2P/FD" and treats debt MFs as equity. | Risk sell rows; Deploy planner. | FD/P2P maturing-only; MF split by category; sells ordered lowest-tax first via what-if. |
| P2.9 | Dark mode + a11y | Glare; colour-only cues. | Settings › Appearance. | Tokens under `prefers-color-scheme`/`[data-theme]`; aria-sort, focus trap. |
| P2.10 | Editable assumptions | Defaults drive every headline. | Settings › Assumptions. | `assumptions` setting validated (return −5..25, vol 0..60, inflation 0..15); Reset. |
| P2.11 | Ledger scale | `/transactions` downloads everything; CSV/CAS imports can be partial. | Activity › Transactions. | `?page&size&q&sort`; atomic commits via `bulk_add`. |
| P2.12 | One signal vocabulary | A holding can read "Uptrend" and "Falling steadily". | Holding signals row; Markets chips. | One signal model; Wilder RSI. |

### P3: trust builders and breadth (backlog)

| Item | Why | UI | Functionality |
|---|---|---|---|
| Calibration display | "Last year we said ₹38–52 L; you ended at ₹47 L" builds trust | Plan › Assumptions "How our ranges held up" | Coverage of matured `projection_1y` snapshots (shown once 6 or more have matured; target 80%) |
| Net worth: bank + liabilities | Without them the hero can't say "net worth" | Hero label switches to "Net worth" | New `bank` and `liability` classes |
| Per-holding expectations | The plan is only as good as its parts | Holding "Role in your plan" card | Sleeve priors, shrunk volatility and beta, income yield, liquidity, data quality |
| Advance tax + 80C | Deadline rupees Indian filers expect | Tax › Estimate; `tax:advance` action | 15/45/75/100% instalments; 80C sum vs ₹1.5 L |
| Reports upgrades | The README promises more | `/reports` | Holding statement, unrealised gains, cash flow, XIRR by holding; small charts |
| AI on the brief | Smaller, ranked context | Actions › Ask | `build_context(brief, actions)` |
| Arrange T2 on Home | Power users | Home "⋯ Arrange" | `dashboardLayout` (T2 only; T0/T1 fixed) |
| Festival data file | Dates end after FY2026-27 | Coming up | `data/festivals.json` + an expiry test |

---

## 3. Information architecture

### 3.1 Desktop top bar (in ladder order)

| Slot | Label | Route | Icon | Also active on | Badge |
|---|---|---|---|---|---|
| 1 | Home | `/` | home | — | — |
| 2 | Portfolio | `/holdings/all` | layers | `/holdings`, `/holding/`, `/p2p`, `/fixed-deposits`, `/forex`, `/epf`, `/nps`, `/performance`, `/risk` | — |
| 3 | Plan | `/plan` | target | `/plan`, `/goals`, `/forecast` | red dot when plan status is act |
| 4 | Actions | `/actions` | bulb | `/actions`, `/insights` | `count_now + count_month`; red when `count_now` > 0 |
| 5 | Markets | `/markets` | zap | `/markets` | amber dot in crash mode |

**More** popover (TOOLS, with hints):
- Activity `/transactions` — "Transactions, cash flows, recurring plans, imports". Also active on `/cash-flows`, `/recurring`, `/import`.
- Tax `/tax` — "FY estimate, ways to save, what-if sale". Its badge "N days left" shows Jan–Mar only when tax actions exist.
- Reports `/reports`.
- Settings `/settings`.

**Right side**:
- portfolio switcher;
- prices pill at every width ("Prices · 12 min ago ⟳"; ≤1180px a dot coloured by the Data vital; tap to refresh);
- bell (Action source);
- gold Add. When SIPs are due, the Add sheet's first row is "Due now" (≤3 instalments), then the 11 kind tiles and "Import a statement".
- avatar.

Markets stays a primary destination for habit, but it is last: it answers no question about the user's own money.

### 3.2 Mobile

- **≤760px bottom bar**: Home · Portfolio · (+) FAB · Plan · Actions (badge). The header hamburger opens the drawer.
- **Drawer** (≤1000px; one shared `NavListComponent` drives the drawer, the popover and the bottom bar): Home, Portfolio, Plan, Actions, Markets, then Tools: Activity, Tax, Reports, Settings.
- **Tab rows** with more than 4 items get fade-edge overflow and scroll the active tab into view.
- **Phone rendering of the grammar**: hero shows value, pill, verdict and 2 stats; vitals as a 2-column grid sorted act → watch → unset → good; action cards full width; T2 charts 220px.

### 3.3 Secondary navigation (in-page `.tabs`, synced to `?tab=` with `replaceUrl`)

| Hub | Tabs / sections |
|---|---|
| Portfolio | Holdings \| Performance \| Risk & mix. Holdings class chips: All · Stocks · Mutual funds · Gold & silver · P2P · FDs · USD wallet · EPF · NPS (zero-value classes greyed under "+ more", each opening an empty state with "Add your first …") |
| Plan | Overview \| Goals \| Retirement \| Scenarios (P2) |
| Actions | sections Now / This month / Planned / Worth considering / Good news / Done / Snoozed; filter chips All · Money at risk · Tax · Mix · Plans & SIPs · Data · Markets (`?filter=`); Review (P2, `?tab=review`) |
| Markets | Today \| Ideas \| Watchlist & IPOs |
| Activity | Transactions \| Cash flows \| Recurring plans \| Import |
| Settings | anchor rail: Profile & cushion · Alerts · Prices & tickers · Family · Assumptions (P2) · Appearance (P2) |

### 3.4 Page list

| Route | Page | Rung | One line |
|---|---|---|---|
| `/` | Home | Q1–Q3 (+Q4 preview) | Am I OK, on track, what now, on one screen |
| `/actions` | Actions | Q3 | Full ranked list, deploy-money planner, tax moves, follow-through, review, AI |
| `/plan` | Plan | Q2 | Goals, retirement and portfolio fan on one engine; funding stack; assumptions |
| `/holdings/all`, `/holdings/:assetClass` | Portfolio › Holdings | Q1/Q5 | What I own; "all" holds the asset-class table moved from Home |
| `/p2p`, `/fixed-deposits`, `/forex`, `/epf`, `/nps` | Class pages | Q1/Q5 | Class hero chosen by what can go wrong |
| `/holding/:id` | Holding | Q1/Q4/Q5 | One holding's answer, actions, chart, signals, lots, plan-a-sale |
| `/performance` | Portfolio › Performance | Q2/Q4 | XIRR/TWR vs benchmarks, attribution, assumptions check |
| `/risk` | Portfolio › Risk & mix | Q2/Q4 | Profile → target → rebalance → stress → evidence |
| `/tax` | Tax | Q3/Q4 | FY estimate, ways to save, what-if, gains |
| `/recurring` | Activity › Recurring plans | Q3/Q5 | This month's money, SIP plans, adherence |
| `/cash-flows` | Activity › Cash flows | Q4/Q5 | Past 24 + next 12 months on one axis |
| `/transactions` | Activity › Transactions | Q5 | The ledger |
| `/import` | Activity › Import | Q5 | CAS, Kite, EPF, LenDen |
| `/markets` | Markets | context | Today, ideas, watchlist & IPOs |
| `/reports` | Reports | Q5 tool | Exportable tables |
| `/settings` | Settings | Q5 tool | Profile & cushion, alerts, tickers, family, appearance |

### 3.5 Removed or merged

| Removed | Where it goes |
|---|---|
| Forecast container (7 tabs) | Outlook/Retirement → Plan; Stress/Risk/Allocation lab → Risk & mix; Cash flow → Cash flows (future) + Home Coming up; SIP plans → Recurring |
| Goals page | Plan › Goals |
| Insights page | renamed Actions (rebalancing planner → Actions › Deploy and Risk › Get back on target) |
| Markets "Your performance" tab | `/performance` |
| Settings › Target allocation editor | Risk & mix › Target mix (Settings keeps a read-only summary link) |
| Home: Asset class summary | `/holdings/all` |
| Home: Markets today | Markets (Home keeps only the Nifty chip and crash context) |
| Home: Where to put your next money | `deploy:idle` action + Actions › Deploy + Recurring split |
| Home: Money calendar | Coming up · next 90 days |
| Home: Habits and milestones | next milestone → habit card meta; rhythm → Recurring |
| Never-rendered health score | Actions › Review check-up (P2) |
| Dead code | `StatComponent`, `ToranComponent`, overview `.alerts .pulse-grid .mem .side` CSS, duplicate STATUS badge maps, `--sidebar-w` |

### 3.6 Redirects (permanent; `ForecastRedirect` resolver maps `?tab=`)

| Old | New |
|---|---|
| `/insights` (`#rebalance`) | `/actions` (`/risk#rebalance`) |
| `/goals` | `/plan?tab=goals` |
| `/forecast` | `/plan` |
| `/forecast?tab=retirement` | `/plan?tab=retirement` |
| `/forecast?tab=cashflow` | `/cash-flows?view=future` |
| `/forecast?tab=stress` | `/risk#stress` |
| `/forecast?tab=risk` | `/risk#risk` |
| `/forecast?tab=allocation` | `/risk#profile` |
| `/forecast?tab=sips` | `/recurring` |
| `/analytics`, `/markets?tab=performance` | `/performance` |
| `/markets?tab=ipos` | `/markets?tab=watchlist` |
| `/holdings` | `/holdings/all` |
| `/admin` | `/settings#people` |

Backend link remap (in `insights.py`, `services.py`):
- `/insights#rebalance` → `/risk#rebalance`
- `/analytics#risk` → `/risk#concentration`
- `/analytics` → `/performance`
- `/forecast?tab=sips` → `/recurring`
- `/goals` → `/plan?tab=goals`
- IPO `/markets?tab=ipos` → `/markets?tab=watchlist`

`writeGuard` goes on `/import` and on routes with `?import=`.

---

## 4. Dashboard (Home `/`), top to bottom

**Data:**
- **Existing:** store portfolio.
- **NEW:** `GET /brief?since=YYYY-MM-DD`, where `since` is localStorage `lastVisit:<scopeKey>` (written on unload/after 30 s). It is snapshot-cached.
- **Lazy, after paint:** `GET /performance?range=1Y` for the sparkline and chart. When `brief.pending` contains `'market'`, it fills the vs-Nifty stat.
- **No longer called:** `/pulse`, `/markets`, `/rebalance`.

### 0. Page head (chrome)
- Eyebrow 13px "Namaste, {first name}". Visually hidden h1 "Home".
- Sub-line: `{auth.portfolioLabel()} · as of {portfolio.as_of|dt} · prices {relTime(prices.last_refresh)}`, with a Refresh icon button (POST `/prices/refresh`) at every width. In family view the sub adds "· family plan".

### 1. T0 HERO, "Am I OK?" (navy `.banner`, ~170px desktop)

| Element | Content / field |
|---|---|
| Label | "Portfolio value" (not "Net worth" until liabilities exist) |
| Headline | `totals.value` 40px/700, `inr` 0 dp, with an `inrWords` line ("₹1.23 crore") |
| Day pill | `totals.day_change` (signed) · `totals.day_change_pct` |
| Context chip | "Nifty 50 {brief.hero.nifty_d1:+0.00}%" (from NEW system value `quote:^NSEI`) |
| Verdict (16px/600 + status icon) | `brief.status.headline`, first match of:<br>1. Money-at-risk act → "₹48,200 of P2P loans are in default"<br>2. Data act → "Prices are 5 days old — values may be off"<br>3. `count_now` > 0 → "2 things need you this week · top: {actions[0].title}"<br>4. `count_month` > 0 → "3 things to look at this month"<br>5. otherwise → "All clear — nothing needs you today" |
| Context line (≤1) | Priority:<br>1. crash/correction: "Nifty is 12% below its high. You're down ₹3.4 L from your peak — smaller than the routine-correction scenario. Your SIPs are the plan; nothing needs selling. Playbook →"<br>2. FY window (1 Jan–31 Mar with open tax actions): "48 days left in FY2026-27 · ₹1.1 L tax-free gains unused · Plan the sales →"<br>3. review overdue > 90 days: "Quarterly review due · ~10 min →" |
| Stat 1 "Total gain" | `totals.total_gain`; meta "unrealised {totals.unrealized\|inrc} · realised + income {(realized+income)\|inrc}" |
| Stat 2 "Return (XIRR)" | `totals.xirr` % ("—" if null) |
| Stat 3 "vs Nifty 50" | `brief.on_track.market.excess` pts/yr; meta "₹{diff_value\|inrc} ahead/behind". Shows "…" while pending; falls back to `/performance` `benchmarks[NIFTY50].excess_xirr` |
| Stat 4 "Since {since_last.date\|dt}" | `since_last.change` signed; meta `change_pct` · "{actions_new} new". Hidden on the first visit |

Mobile: headline, pill, verdict and context line, plus stats 1 and 4; "More" reveals 2 and 3.

### 2. T1 VITALS, "Five checks" (`.vital` chips; fixed order on desktop; mobile sorted act → watch → unset → good)

| Vital | Value text | good / watch / act / unset | Fix link |
|---|---|---|---|
| Data | "Prices 12 min old · all priced" / "3 holdings at cost (6.2% of value)" | §2 P0.7 | `/settings#prices` |
| Cushion | "{months:0.0} months of expenses" vs `emergencyFund.months_target` | ≥ target / ≥3 / <3 / not set ("Mark your emergency money — we found ₹4.2 L of candidates") | `/settings#cushion` |
| Risk | "Est. volatility {vol}% · {Profile} target {target}%" (+ "Top holding {weight}%" when ≥15) | ≤ target+2 / ≤+5 or concentration / > +5 / no `riskProfile` ("Looks like {closest_profile}") | `/risk` |
| Mix | "Within 2 pts of target" / "{segment} +6.1 pts over" | max\|drift\| <2.5 / <5 / ≥5 / no `targetAllocation` | `/risk#mix` |
| Money at risk | "None" / "₹48,200 defaulted · ₹12,000 overdue · 1 FD matured unrecorded" | 0 / <1% of value / ≥1% | `/p2p?tab=defaulted` or `/fixed-deposits` |

Good chips are compact (icon, label, value). Watch, act and unset chips are wide and add a note plus "Fix →".

### 3. T1 DO THIS NOW (`.q-head` "WHAT SHOULD I DO NOW?")
- **Header**: h2 "{count_now + count_month} actions · ₹{impact_total|inrc} at stake".
- **Cards**: ≤3 `.action-card` from `brief.actions`, applying the diversity rule. Each card has:
  - a 4px status stripe;
  - a 15px/600 title;
  - a one-line detail;
  - an impact pill (§1.7 label) and a confidence tag (Fact / Estimate / Model);
  - a due chip ("in 4 days" / "by 31 Mar");
  - an owner chip in family view;
  - a CTA, plus a ⋯ menu (Plan for… / Snooze 7·30·90 / Done / Not relevant).
- **CTA examples**:
  - "Record instalment" → `TxnDialogService.add(kind, {instrumentId, type:'BUY', amount})`;
  - "Plan the sale" → what-if modal;
  - "Plan reinvestment" → `/actions#deploy?new_money=<amt>`;
  - "Rebalance" → `/risk#rebalance`;
  - "Fix tickers" → `/settings#prices`;
  - "Mark matured" → FD modal.
  Only card 1's CTA is `.btn.primary`.
- **Footer**: "All {actions_total} actions →" `/actions` · "Acted on 7 of 9 in 90 days".
- **Empty state**: a good verdict card, "Nothing needs you. Next: SIP ₹10,000 on 15 Nov · review due {lastReviewDate + 90d|dt}."

### 4. T1 AM I ON TRACK? (`.q-head`; grid-3, stacked on mobile)

| Card | Big text | Body | Status rule | CTA / unset |
|---|---|---|---|---|
| **Your plan** | "{on_track+achieved} of {n} goals on track" | ≤3 rows, worst first: "Retire at {retire_age} · {probability}% likely ▲/▼{delta}"; "{name} · ₹{target_amount\|inrc} by {target_date\|dt}", with a probability bar ticked at 40/75; assumption chip | worst of goal and retirement statuses | "Open plan →" `/plan`. Unset: 4 preset chips (Emergency fund, Child's education, Home down payment, Retirement) → `/plan?tab=goals&preset=<key>` |
| **Against the market** | "{excess:+0.0} pts a year vs Nifty 50" | "₹{diff_value\|inrc} more/less than the same money in Nifty 50 since {since\|dt}"; 2-line sparkline (you vs NIFTY50, 1Y, from `/performance?range=1Y` `series[].index`/`NIFTY50`) | ≥0 good; −3..0 watch; ≤−3 act; unset < 180 days ("Too early to judge — {days} days of history") | "Performance →" |
| **Your investing habit** | "₹{invested_month\|inrc} of ₹{planned_month\|inrc} this month" | "6-month SIP adherence {adherence_6m_pct}% · pace ₹{pace\|inrc}/mo"; "Next milestone {story.milestones.ahead[0].label} in {in}" | ≥90 good; ≥60 watch; <60 act; no plans unset ("Add your SIPs") | "Recurring plans →" `/recurring` |

### 5. T2 WHY IT MOVED (`.q-head` "WHY?"; `.main-grid`)
- **Left: "You vs the market"**. Existing `app-line-chart`, 260px:
  - Portfolio value (area);
  - Money invested (muted);
  - Same money in Nifty 50;
  - `.seg` 1M/6M/1Y/ALL, cached per range.
  - Sub-line "Assumptions check" (P1): "Last 3 years: {twr_annualised}%/yr · plan assumes {typical}% typical (range {lo}–{hi}%) — within range". It turns watch when outside the range and links `/performance#assumptions`.
- **Right: "What drove it"**. Diverging CSS bars with `.seg` Today | Since start:
  - Today = top 3 up and 3 down by `positions[].day_change`, computed client-side;
  - Since start = `brief.why.gainers`/`losers` (≤5) and a by-class list from `brief.why.segments`;
  - link "Full attribution →" `/performance#attribution`.

### 6. T2 WHERE YOUR MONEY IS
- `app-donut-chart` (180px) with slices `segments[].value` in `SEGMENT_COLOR`; centre `{value|inrc}` / "{n} classes".
- Beside it, 8 rows: `SEGMENT_META.label`, `value|inrc`, `pct`, a bar with a black target tick, and a drift pill (watch at |drift| ≥ 2.5, act at ≥ 5).
- Clicking a slice or row → `SEGMENT_META[segment].route`.
- Link "Adjust mix →" `/risk#mix`, or "Set targets →" when there is no target.

### 7. T2 COMING UP · NEXT 90 DAYS
- **Header**: "In +₹{upcoming.inflow_90d|inrc} · Out −₹{upcoming.outflow_90d|inrc}".
- **Events**: ≤8, grouped by month. Each has a date tile coloured by kind (`tax`, `fy`, `festival`, `personal`, `sip`, `fd_maturity`, `p2p_close`, `ipo`), a title, a right-aligned amount (`direction` sign) and a link. FD rows add "suggest: {segment furthest under target}".
- **Ribbon**: festival ribbon when `upcoming.theme` is set.
- **Link**: "Full cash-flow outlook →" `/cash-flows?view=future`.

### 8. T3 DETAILS (4 link tiles)
- "All holdings ({totals.open_positions})" → `/holdings/all`
- "Tax {fy}: est. ₹{brief.tax.estimate_total|inrc}" → `/tax`
- "Performance report" → `/reports?r=performance`
- "Portfolio summary" → `/reports?r=summary`

### Home states
- **Empty ledger** (`brief.empty`): a hero with "Let's add your first investment" plus onboarding actions ("Import a CAS statement", "Add your first transaction"); vitals and on-track cards are hidden.
- **Guest**: CTAs that write are replaced with "View".
- **Loading**: hero, vitals and actions paint from the snapshot; T2 shows skeletons.

---

## 5. Every other page, in priority order

Each page uses the template in §1.12. "Strip" = T1 "Needs attention here" (≤2 cards; filtered by link prefix).

### 5.1 Actions (`/actions`), Q3

**Purpose**: the full Q3 answer, with every action ranked by real ₹ and urgency, and the planners that turn advice into money moves. It replaces `/insights`.

| Tier | Section | Content |
|---|---|---|
| T0 | Hero `.kpis` | Hero tile "What needs you" = "{now} now · {month} this month", verdict "All clear" when 0. Tiles:<br>- "₹ at stake" `summary.impact_total`;<br>- "Tax you can still save" Σ impact of the tax category;<br>- "Follow-through" "Acted on {done} of {total} in 90 days · ₹{impact_realised_fy\|inrc} realised this FY";<br>- "Last review" `relTime(lastReviewDate)` + "Mark review done" (POST `/review/complete`). |
| — | Filter chips (sticky) | All · Money at risk (p2p, fd) · Tax · Mix (allocation, risk) · Plans & SIPs (goals, habit) · Data · Markets; `?filter=`; `?id=<actionId>` scrolls to and highlights a card |
| T1 | **Now** | Expanded `.action-card`s: title, detail, "why" (the insight `action` text), assumptions line for estimate/model ("Assumes 12.5% LTCG + 4% cess"), impact pill, confidence tag, due chip, owner chip, CTA, Plan for… (date → `planned`), Snooze 7/30/90, Done, Not relevant (optional reason) |
| T1 | **This month** | The same cards collapsed to one line (title · impact · due · CTA), expanding on click |
| T1 | **Planned** | Table: Action / Planned for / Amount / Days late (red when overdue) / "Do it now" / Unplan |
| T2 | **Deploy money** (`#deploy`) | Shared `RebalancePlannerComponent`. New money defaults to `brief.deploy.suggested` = USD wallet `value` + Σ FD `maturity_value` with `days_to_maturity` ≤ 30 + P2P principal due ≤30 days + `contributions.p2p_escrow_balance`. "Allow selling" toggle → `GET /rebalance?new_money&allow_sell`. Table: swatch / Value (`current`) / Now % / Target % / badge Add ₹ · Trim ₹ · Hold / After %. FD/P2P read "Redirect maturities". Footer: `money_to_fix_without_selling` · "Open Risk & mix →" |
| T2 | **Tax moves this FY** | 3 compact cards from `/tax` `opportunities`, each with "Plan the sale" (what-if modal) and a link to `/tax`:<br>- Book gains tax-free: `suggested_booking`, `future_tax_saved`;<br>- Offset gains: `loss_harvest_offsettable`;<br>- Wait before selling: Σ `upcoming_long_term.tax_saving`, next `lt_on`. |
| T2 | Worth considering / Good news | Collapsed `details.more` lists (tier consider; tier good, e.g. `perf:xirr`, `perf:vs-nifty`) |
| T2 (P2) | **Review** (`?tab=review`) | Wizard:<br>1. What changed since `lastReviewDate`: value, net invested, XIRR, Σ\|drift\|, goal and retirement probability Δ from `kpi_snapshots`, health Δ.<br>2. Mix: no-sell vs with-sell plan, with tax per trim.<br>3. Concentration, laggards (≤−20% after 180 days), winners.<br>4. Plan: required vs funded SIP.<br>5. Commitments saved as SIP edits or planned actions.<br>6. Complete.<br>The check-up card shows `Pulse.health.components` (label, score/100, note) and `focus` |
| T3 | Done | "Done on / Action / How ('Auto: BUY #812 on 12 Nov' or 'Marked done') / Amount moved / Impact / Undo" |
| T3 | Snoozed & hidden | Action / Until / Reason / Restore |
| T3 | Ask the analyst | Collapsed AI card: `GET /ai/status` gate, "Analyse my portfolio" (POST `/ai/analyze`), chat (POST `/ai/chat`), 4 suggestions, `disclaimer` |

**Data**:
- **NEW**: `GET /actions?status&category&instrument_id` → {summary{now, month, consider, good, impact_total}, actions[], planned[], done[], snoozed[], follow_through{acted_90d{done, total, pct}, on_time_pct, impact_realised_fy, sip_adherence_12m}}; `POST /actions/<id>/status` {status, until?, planned_for?, note?, reason?}; `brief.deploy.suggested`.
- **Existing**: `GET /rebalance` (rows[].{segment, current, current_pct, target_pct, action, amount, after_pct}, `money_to_fix_without_selling`, `shortfall_to_targets`), `GET /tax`, `POST /review/complete`, AI endpoints.

### 5.2 Plan (`/plan?tab=overview|goals|retirement|scenarios`), Q2

**Purpose**: the deep "Am I on track?" answer, with goals, retirement and the whole-portfolio outlook on one assumptions model. It shows honestly which rupees belong to which goal.

**T0 (every tab)**:
- Hero "Plan status" = `plan.status.headline` ("3 of 4 goals on track · retirement 72% likely"; the worst status sets the stripe).
- Tiles:
  - "Typical in {years} yrs" = `end.p50` (meta "1-in-10 bad {p10|inrc} · good {p90|inrc} · est.");
  - "Investing each month" = `sip.plans_monthly_total` vs `sip.needed_monthly` (watch if below);
  - "Free money" = `funding.free` (meta "after goals and cushion").
- Assumption chip in the page head.

**Overview**:
| Tier | Section | Content |
|---|---|---|
| T1 | Goals at a glance | Rows sorted off_track → at_risk → on_track → achieved, then `target_date`; retirement included when `retirementPlan` exists. Columns: name; "₹`target_amount` by `target_date`"; `progress_pct` bar; probability bar (ticks 40/75) with ▲/▼ vs the 30-day snapshot; status badge; "SIP ₹`monthly_contribution` / needs ₹`required_sip`". Row CTA "Fix" opens the goal modal with `monthly_contribution` = `required_sip`; retirement → Retirement tab |
| T2 | How it could unfold | Fan chart (ProjectionComponent): bands p10–p90 and p25–p75; "Typical (median)" line; "Money put in" muted; the mean line removed. NEW marker kind `goal` at each `target_date` (tooltip "{name} · needs ₹X"); x labels "2041 · 45" when age is known. Beside it: 1-in-10 bad = p10, Typical = p50, 1-in-10 good = p90, Stop investing = `scenarios.no_more_investing` |
| T2 (P2) | What moves the needle | 4 sensitivity tiles ("+₹5,000/month → retirement +6 pts, Home +9 pts"; retire +2 years; returns −1 pt; inflation +1 pt), each with "Try it" → a new scenario |
| T2 | Funding stack | One 100% bar of `totals.value`: each goal's `funding.earmarked[].amount`, the Emergency cushion `funding.cushion.amount`, and Free money `funding.free`. `.notice.warn` for `over_allocated[]`: "Mutual Funds is claimed 130% by Home and Education" |
| T2 | Assumptions (always visible) | `return_pct` ± `volatility_pct`, `basis`, `inflation_pct`, mix rows (segment, `weight_pct`, return ± vol), `book_hash` short id; "Long-run assumptions, not predictions"; "Change the mix →" `/risk#profile` |
| T3 | Adjust (collapsible) | Horizon `.seg` 5/10/15/20/25/30y (default max(10, years to the furthest goal)); monthly SIP (default `sip_plans_total`); step-up `.seg` 0/5/10/15; return override; milestones table (label, around year, probability); "Average path (pulled up by the best cases)" |
| T3 (P3) | How our ranges held up | Calibration coverage |

**Goals tab**:
- A funding strip: "Earmarked ₹X of ₹Y · Free ₹F · Goals need ₹N/month more".
- The existing goal cards sorted worst-first, each showing "Funded by 2 SIPs · ₹15,000/mo" (P2).
- Empty state: the 4 presets.
- The modal shows "already earmarked %" per segment and **blocks a save above 100%** unless confirmed.

**Retirement tab** (`RetirementPlannerComponent`, renamed):
- **Hero order**:
  1. "Chance of reaching ₹{corpus_needed|inrc}" `probability` with status (P2: "Money lasts to {life_expectancy}: {probability_lasts}% · 1-in-10 runs out at {depletion_age_p10}");
  2. Corpus needed at {retire_age};
  3. On current path (`gap`);
  4. Monthly needed (`required_sip`).
- **Chart**: x-axis labelled by age; saving and retired areas; dashed corpus needed.
- **Notice**: "Money lasts past {life_expectancy}" or "runs out around {runs_out_at}".
- **FIRE card** (existing `fire` fields).
- **Aside form** grouped as You (age, retire at, plan until), Money (expenses, other income, SIP, step-up) and Assumptions (inflation, return while saving, return after); Save → `retirementPlan`.

**Scenarios tab (P2)**: ≤5 `planScenarios`, overlaid medians on the baseline band, and a compare table (p10/p50/p90 at horizon, retirement chance, each goal's chance, monthly needed). Deltas use common random numbers.

**Data**:
- **NEW**: `GET /plan` (§2 P1.1, plus `counts`, `deltas{goal_id|'retirement': pts}`).
- **Existing**: `GET /forecast` (path[].{p10, p25, p50, p75, p90, contributed}, end.{p10, p50, p90, real_p50, probability_of_loss}, scenarios, milestones, assumptions); `GET /forecast/retirement` (fixed); `/goals` CRUD; `GET /sips` `monthly_total`; settings `retirementPlan`, `emergencyFund`.

### 5.3 Portfolio › Holdings (`/holdings/all`, `/holdings/:assetClass`), Q1/Q5

- **Head**: Portfolio tabs, then class chips (All first, held classes, empty classes greyed under "+ more"). Head buttons (T3 tools): Export CSV, Import Kite tradebook, Add.

| Tier | All | Per class (equity, mutual_fund, commodity) |
|---|---|---|
| T0 | Hero "Value" `totals.value` + day change; Invested Σ `segments.invested`; Total gain `totals.total_gain` (meta unrealised/realised/income); XIRR `totals.xirr` | Hero "Value" (segment value, % of portfolio); Unrealised (% on cost); Today; Realised + dividends |
| T1 | Strip: actions linking `/holdings/<class>` or `/holding/<id>` in scope (`concentration:`, `loser:`, `winner:`, `tax:wait-lt:`, `data:missing-prices`) | same |
| T2 | **Asset class summary** (moved from Home): Asset class / Invested / Current value / Today / Unrealised / Realised + income / XIRR / Share, drill to top 8, tfoot; **on mobile rows become cards** (class, value, today, share, XIRR). Breakdown donut; family view `.seg` By class \| By member (groups by `owner`) | **Holdings table**: search, India/US `.seg`, Closed toggle. Column chooser (Value, Return, Today, Weight, XIRR, Total return, Realised, Owner in family view; saved in localStorage). `aria-sort`. Rows → `/holding/:id`. Aside: Breakdown + Today's movers (on mobile behind a "Breakdown" disclosure) |

**Data**: existing store fields only (`segments[]`, and positions[].{name, owner, value, unrealized, unrealized_pct, day_change, weight, xirr, total_return, realized, quantity, avg_cost, has_price, sector, market_cap, category, sub_category, tax_class, is_open}); cached `/actions`.

### 5.4 Portfolio › Performance (`/performance?range&segment`), Q2/Q4

- **Head**: Portfolio tabs. Toolbar: segment select (Whole portfolio / each SEGMENT) and `.seg` 1M/3M/6M/1Y/3Y/YTD/FY/ALL.
- **T0**: hero "Your return (XIRR)" `metrics.xirr`, verdict "vs Nifty 50 {excess_xirr:+0.0} pts" (Home market rule). Tiles: Gain in period `metrics.gain`; TWR (`twr_annualised` ?? `twr`); Worst fall `current_drawdown` (meta `max_drawdown`).
- **T1**: "You vs the same money in an index" line chart with a benchmark select, plus the "Compared with" table (Index, their `xirr`, your `excess_xirr`, ₹ difference from `end_value`).
- **T2**:
  - Growth of ₹100 (TWR `index`);
  - Monthly returns heat table (cells carry ▲/▼ glyphs);
  - **Attribution** (`#attribution`): `story.attribution` gainers/losers ≤5, per-segment gains, "winners {winners} · losers {losers_count}";
  - **Assumptions check** (`#assumptions`): realised `twr_annualised` vs the Assumption Book's typical band for the same span; if the shortfall is ≥3 pts over 2+ years, link `/plan?return=<realised>`;
  - **Income** card (P2): 24-month stacked bars from `GET /income` (`dividends`, `p2p_interest`, `fd_interest`), `last_12m`, `monthly_avg`, `top_payers`.
- **T3**: methodology (PME, TWR vs XIRR), best/worst day. "Concentration & risk" moved to `/risk#concentration`.
- **Data**:
  - **existing** `GET /performance`, `GET /income`;
  - **NEW** `assumptions.typical_band(years)` (P1).

### 5.5 Holding detail (`/holding/:id`), Q1/Q4/Q5

- **Page head**:
  - "← {class label}", name;
  - badges (segment, symbol or "No ticker", sector/category, Closed/Defaulted);
  - class actions: Buy (primary)/Sell/Dividend/Bonus-split; NPS Contribution/Withdrawal; EPF Contribution/Interest/Withdrawal; P2P Repayment;
  - Edit; **Delete moved into an overflow ⋯ menu**.
- **T0**: hero "Current value" (`value`, `day_change`) with a verdict:
  - `weight` ≥15% (MF ≥25%) → watch "Large position: {weight}% of portfolio";
  - `has_price` false → act "Valued at cost — set a ticker";
  - else good.
  
  Tiles: Total return (`total_return` ₹, %); XIRR (only when held ≥365 days, else "Return on money in"); Units · avg cost. Class-specific tiles for P2P, NPS, EPF and FD stay as today.
- **T1**: strip (actions with link `/holding/{id}`: concentration, loser, winner, `tax:wait-lt`, `elss:unlocked`, `fd:maturing`). Sale CTA "Plan a sale" → what-if modal prefilled with the full `quantity`.
- **T2**:
  - Price & your trades (existing chart with buy/sell markers; P2 benchmark overlay rebased to the first point: Nifty 50 / S&P 500 in ₹ / GOLDBEES);
  - Returns `.kv` (existing);
  - **Signals**: `OutlookCardComponent` collapsed to one row (trend badge, 3M momentum, RSI, volatility regime, Markets signal chips if in Nifty 200); "Show all statistics" expands the existing card (cone with the "range if it behaves like the past, not a forecast" label, beta, 52-week range, notes, disclaimer).
- **T3**:
  - Transactions (existing);
  - **Open lots (FIFO)** with Long-term/Short-term badges, a "turns long-term on {lt_on}" column, and a per-lot "Plan a sale".
- **Data**:
  - **existing**: `/transactions?instrument_id`, `/instruments/:id/history`, `/instruments/:id/outlook`, position `open_lots`, `elss`, `fx_gain`, `stock_gain`;
  - **NEW**: `/tax/what-if`, `/tax` `opportunities.open_lots` filtered by `instrument_id`, cached `/actions`.

### 5.6 Portfolio › Risk & mix (`/risk`, anchors `#profile #mix #rebalance #stress #risk #concentration`), Q2/Q4

Order follows the decision: profile → target → gap → stress → evidence.

| Tier | Section | Content |
|---|---|---|
| T0 | Hero | "Risk vs your profile", verdict from `brief.vitals.risk` ("Balanced · est. volatility 11.4% vs 9% target"). Tiles:<br>- "Off target": max\|drift\| pts and ₹ off target (Σ\|drift\| × value/200);<br>- "A routine correction": stress `correction` impact (₹, %);<br>- "A bad day (1 in 20)": `var_95.day` ("needs 30 days of prices" otherwise). |
| T1 | Strip | `risk:above-profile`, `stress:beyond-tolerance`, `drift:*`, `concentration:*`, `targets:missing` |
| T1 | **Profile** (`#profile`) | 4 buttons Conservative/Balanced/Growth/Aggressive (`profiles[].{label, return_pct, vol_pct, note}`); `current.closest_profile` highlighted; saved `riskProfile` ticked; "Remember this profile" → PUT `/settings/riskProfile` |
| T1 | **Target mix** (`#mix`) | Drift bar per segment (`pct` vs target tick, drift pill), then the editable table moved from Settings: Segment / Now % / Target % / Suggested % (chosen profile `weights`). Buttons: "Use current mix", "Use suggested"; Save requires a sum of 100 ± 0.5 → PUT `targetAllocation`. "Preview impact": expected return and volatility of the new mix via `mu_sigma` (P1); goal/retirement Δ (P2) |
| T1 | **Get back on target** (`#rebalance`) | Shared `RebalancePlannerComponent`, default no-sell with `brief.deploy.suggested`. P1 line: "At your SIP + maturity pace this closes in ~N months". "Allow selling" shows trim rows, each with "Tax if sold" via what-if (P2: lowest-tax holdings first). FD/P2P: "Redirect maturities". |
| T2 | **Stress** (`#stress`) | 7 scenario cards worst-first (impact ₹/%, `after`, recovery months, segment rows). P2: "markets alone / with your SIPs", holding drill-down by beta, "After this shock: retirement 78% → 64%" |
| T2 | **Where the risk comes from** (`#risk`) | `holdings[]` table (Holding, Weight, Volatility (measured \| used), Beta, Risk share red when > 1.3× weight, Data own/proxy) + read-outs (parametric VaR, expected shortfall, Sharpe/Sortino with ballast, beta, diversification ratio) |
| T3 | **Concentration** (`#concentration`) | Largest holdings, stock sectors, company-size bars (moved from Performance) |
| T3 | How holdings move together (collapsed) | Correlation heat table (full names in tooltips) + frontier with profile dots and "You" (rebuilt on the shared chart in P2) |

**Data**:
- **existing**: `GET /optimizer?profile`, `GET /forecast/stress`, `GET /risk` (fixed), `GET /rebalance`, settings `targetAllocation` and `riskProfile`, segment `drift`;
- **NEW**: brief vitals risk/mix, `mu_sigma`, `/tax/what-if`, `months_to_fix`.

### 5.7 Class pages (`/p2p`, `/fixed-deposits`, `/forex`, `/epf`, `/nps`), Q1/Q5

The h1 is the class name ("P2P lending", "Fixed deposits", "USD wallet", "EPF", "NPS"), not "Holdings". Portfolio tabs and class chips follow. The hero is chosen by what can go wrong.

| Page | T0 hero (+ verdict) | Tiles | T1 strip | T2 / T3 |
|---|---|---|---|---|
| P2P | "Outstanding" Σ `outstanding`; verdict "At risk ₹{Σ at_risk} · {n} overdue" | Interest after fees; Realised XIRR vs average stated `rate`; Principal back (+ "30 days, not reinvested", P1) | `p2p:defaulted`, `p2p:overdue`, `p2p:yield`, `cash:p2p-principal` | Stack bar + lending-type cards / loans table with tabs, cohorts, LenDen import |
| FD | "Next maturity" ({name} · `days_to_maturity` days · ₹`maturity_value`); watch ≤30 days | Active deposits; Interest accrued (Σ `accrued_interest`); Value today | `fd:maturing:<iid>` ("Plan reinvestment"), `fd:matured-unrecorded:<iid>` ("Mark matured") | Maturity ladder by month (P2) / FD table with a "Redeploy ₹X" badge |
| USD wallet | "Uninvested balance" $`balance_usd` (₹ value); watch when > $50 | Avg rate (`avg_rate`) vs today (`current_rate`); Currency gain on US stocks (`fx_gain`); Gain on withdrawals | `cash:usd` → "Deploy" `/actions#deploy` | Totals kv / transfers table |
| EPF | "EPF balance" | Contributed; Interest (`interest_credited` · `accrued_interest`); XIRR | none typically | Account table / passbook import |
| NPS | "NPS value"; watch when any `price_at` is older than 30 days ("NAVs 45 days old — update") | Contributed; Gain; XIRR | `nps:nav-stale:<iid>` (inline edit) | Scheme table with inline NAV edit / CAS import |

### 5.8 Tax (`/tax?fy=&tab=save|whatif|gains|estimate&whatif=<iid>`), Q3/Q4

- **Head**: FY select, Export CSV, chip "138 days left in FY2026-27" (current FY only).
- **T0**: hero "Estimated tax {fy}" = `estimate.total` (meta "at {slab_rate}% slab · change" → `/settings#profile`), verdict "You can still save ₹X" (good when 0). Tiles:
  - Tax-free LTCG left = `equity_exemption.remaining` of `limit`;
  - Capital gains (summary short · long);
  - Next deadline (next `tax` kind event, e.g. "Advance tax 15 Dec · 32 days").
- **T1 Ways to save** (default tab for the current FY; hidden for past FYs):
  1. **Harvest plan** (P1): per instrument, Holding / Units to sell / Proceeds / Gain booked / Lots / "Plan this sale". Total "Books ₹1.08 L tax-free · saves ≈ ₹13,500 later (est.)", with the rebuy note.
  2. **Offset gains with losses**: `loss_harvest_offsettable` + holdings table.
  3. **Wait before selling**: `upcoming_long_term` with `tax_saving`, `lt_on`.

  Every row has "Plan the sale" (what-if, prefilled qty).
- **T1 What if I sell** tab: holding select (open unitised), quantity (default all), price (default `last_price`), date (default today). Result:
  - lots consumed (date, qty, term, rate, gain);
  - ST/LT gain, exemption used/left;
  - tax incl. cess, net cash, effective %;
  - `wait` ("Wait 23 days to save ₹4,100");
  - note "estimate; surcharge and carry-forward not modelled".
- **T2**: exemption meter (used/limit); "Where your tax comes from" (`tax_lines` meters).
- **T3**: Realised gains (seg All/STCG/LTCG/Intraday + table); Tax estimate (`tax_lines`, cess, `set_off`, income rows, rules text from the backend payload; P3 advance-tax rows).
- **Data**:
  - **existing** `GET /tax?fy`;
  - **NEW** `GET /tax/what-if`, `opportunities.harvest_plan`, next tax event from `brief.upcoming`.

### 5.9 Activity › Recurring plans (`/recurring`), Q3/Q5

- **T0**: hero "₹{monthly_total}/month across {n} plans", verdict "Adherence {adherence_6m_pct}% over 6 months". Tiles: "This month: ₹`invested_this_month` of ₹`planned_this_month`"; Next due (name · date).
- **T1 This month's money**:
  - **Instalments** of every active plan for the month, all frequencies: Date · Plan/holding · ₹ · status badge (Recorded / Due / Missed / Upcoming / Skipped) · "Record" (TxnDialog prefilled `{instrumentId, type:'BUY', amount, date}`; the user confirms units) · "Skip this month".
  - **Arriving**: FD maturities, P2P principal back, idle USD, with dates.
  - **Extra to invest** (₹ input; default 0) + arriving total → no-sell split by segment (`GET /rebalance?new_money&allow_sell=0`) with `after_pct` vs `target_pct`.
- **T2 Plans table**: existing columns (Plan, Amount, Every, Day, Step-up, From → to, Status, Pause/Resume, edit, delete), plus a 6-dot adherence strip (done/partial/missed/upcoming, icon and colour) and a "Funds goal" column (P2).
- **T3**: plan modal (existing); 12-month planned-vs-actual bars (P2).
- **Data**:
  - **existing**: `GET/POST/PUT/DELETE /sips`;
  - **NEW**: `GET /sips` adds `adherence{plans[].{id, months[], adherence_pct, missed_count, next_due}, planned_this_month, invested_this_month, adherence_6m_pct, next_due[]}`, plus `upcoming` arriving events.

### 5.10 Activity › Cash flows (`/cash-flows?view=past|future|both`), Q4/Q5

- **T0**: hero "Net contributed" (`contributions.net`); Deposited, Withdrawn; on the escrow `.seg`, "Escrow balance" `p2p_escrow_balance`. Future view tiles: Income due, Principal back, SIPs out (12 months, est.).
- **T1**: chart "Past 24 months + next 12": past bars = net contributions from `/cash`; future bars muted and labelled "estimate" = `/forecast/cashflow?months=12` `net`, tooltip with inflow/outflow split; a "today" divider. `?view=future` scrolls to the future half.
- **T2**: "Dates to know" (`events[]`: `fd_maturity`, `p2p_close`, `p2p_overdue`, each linking its action); "What this means" (`notes`).
- **T3**: ledger table and add-entry modal (existing).
- **Data**: existing `/cash`, fixed `/forecast/cashflow`; P2 `GET /timeline`.

### 5.11 Activity › Transactions (`/transactions`) and Import (`/import`), Q5

- **Transactions**:
  - **T0**: hero "Net put to work" (filtered); Transactions count, Money out, Money in.
  - **T2**: filters (search, class, type, from–to).
  - **T3**: table grouped by month with subtotals; CSV import modal. P2: server pagination `{rows, total}`.
- **Import**: source tiles CAS · Kite · EPF · LenDen (→ `/p2p?import=lenden`) and the existing flows. P2: one shared `DropZoneComponent`. A successful import completes any `data:import-due` action.

### 5.12 Markets (`/markets?tab=today|ideas|watchlist`), context

- **T0** (every tab, so the shape stays fixed): hero "Nifty 50" price with d1/w1/m1. Tiles: Market breadth (up/down of total); Your stocks today (value-weighted d1, count); Alerts today. A crash/correction banner appears above it when `market_state.mode` ∈ {correction, crash}, with the same calm playbook as Home.
- **T1**: strip for market-category actions (watchlist target hit, holdings past the alert threshold). Signals never rank above `signal` confidence.
- **Today** (default): "Your stocks and ETFs" table first, then `.duo` Top movers + Recent alerts, then Sector heat.
- **Ideas**: disclaimer first; Momentum and Dip & reversal lenses; "Rebalancing with the signals" links `/risk#rebalance`.
- **Watchlist & IPOs**: existing watchlist table and `app-ipos`. Head chip "→ Your performance" `/performance`.
- **Data**: existing `/markets`, `/markets/alerts`; NEW `market_state` in the payload.

### 5.13 Reports (`/reports?r=`), Q5 tool

Catalog and viewer unchanged; the default report is `summary`. P3: small charts on summary/performance, new builders (holding statement, unrealised gains, cash flow, XIRR by holding), and column types from `columns[].type` only (drop the key-name regexes).

### 5.14 Settings (`/settings`), Q5 tool

The anchor rail is sticky on desktop and a `.seg` strip on mobile.

| Anchor | Content |
|---|---|
| `#profile` Profile & cushion | `taxSlabRate` select. **Emergency cushion** (NEW): monthly expenses (prefilled from `retirementPlan.monthly_expenses`), months to keep (3–24, default 6), a checklist of eligible holdings (FDs, Debt/Liquid MFs, USD wallet) pre-ticked by auto-suggest, showing value and live coverage months; Save → PUT `/settings/emergencyFund`. Read-only summaries: "Target mix: set · Balanced →" `/risk#mix`; "Retirement plan: retire at 60 →" `/plan?tab=retirement`; `autoCapitalFlows` |
| `#alerts` Alerts | Existing `marketAlerts` and push device box; P2 "Daily action digest" toggle |
| `#prices` Prices & tickers | Existing; the Missing filter is the default when `missing_prices` is non-empty |
| `#people` Family | Admin, existing |
| `#assumptions` (P2) | Per-segment return/vol overrides, inflation, Reset; shows `book_hash` |
| `#appearance` (P2) | System / Light / Dark |

**NEW keys**: `emergencyFund` (P1); `assumptions`, `seenNotices`, `planScenarios`, `theme` (localStorage) in P2. Family view shows "Editing the family plan" until P2 per-member settings ship.


# Next-generation Investment Tracker: Specification, Part 2
## Forecasting pipeline, backend changes, action model, visual grammar, risks

Scope of this part: §6 the single assumptions model and forecasting pipeline; §7 every backend addition and change, with tests; §8 the action and follow-through model; §9 the visual grammar; §10 risks and non-goals.

Part 1's tiers (P0–P3), routes, page layouts and copy rules still apply. Every name below is an existing name unless it is marked **NEW**. Constants are written as fractions inside engines and as values ×100 in payloads (`*_pct`), which is the existing convention.

---

## 6. The forecasting pipeline: one assumptions model, end to end

### 6.0 Shape of the pipeline

```
S0 Assumption Book (assumptions.py)        → book, book_hash, HONESTY, status_for
S1 Per-holding expectations (P1 partial)   → σ shrunk to its segment, μ from the Book, data quality
S2 Portfolio projection                    → fan p10..p90, typical, milestones
   P0: fixed project_portfolio · P1: μ/σ from mu_sigma · P2: simulate.py, per segment, CRN
S3 Goals + funding (goals.py)              → probability, required_sip, funding stack
S4 Retirement (forecast.retirement_plan)   → probability, corpus, path; P2: probability_lasts
S5 Tax overlay (tax.py)                    → what-if sale, harvest plan; P2: after-tax toggle
S6 Scenarios / sensitivities / stress-to-plan (P2) → the same draws, compared as deltas
S7 Calibration (kpi_snapshots)             → written from P1, shown in P3
```

Rules that hold at every stage:

1. **One source for return, volatility and correlation numbers.** No engine keeps its own copy of μ, σ, correlation, RISK_FREE or INFLATION after P1. They all import `assumptions.py`.
2. **Every forward-looking payload carries the same block:**
   - `assumptions` = {`return_pct`, `typical_pct`, `volatility_pct`, `inflation_pct`, `basis`, `hash`};
   - `honesty` (labels from `HONESTY`);
   - `note`.
   The frontend draws the assumption chip from that block alone.
3. **The memo key carries the assumptions.** Every forecast memo key includes `book_hash`, so editing assumptions in P2 invalidates exactly the forecasts it affects.
4. **Seeds are fixed so results repeat:**
   - portfolio projection: seed 42;
   - goal: seed = `goal.id`;
   - retirement: seed 7;
   - scenarios and sensitivities: the baseline seed, so they share common random numbers (CRN).
5. **Status thresholds live in one place.** All status comes from `assumptions.status_for(p)`: p ≥ 75 → `on_track`, p ≥ 40 → `at_risk`, otherwise `off_track`, and `achieved` when current ≥ target. This matches Part 1's `STATUS_THRESHOLDS`.

### 6.1 Assumption Book (`backend/tracker/analytics/assumptions.py`, NEW, P1)

The Book is a pure module with no database access. It is the segment-level version of ANALYTICS' Book. ANALYTICS' 13 sleeves and 4 factors are not adopted; that kind of refinement is P3.

**Segment rows.** The values are today's `goals.ASSUMPTIONS`, moved here. One internal row is added, `MF_DEBT`.

| Key | Applies to | μ (arith.) | σ | Notes |
|---|---|---|---|---|
| `Equity (India)` | equity, market India | 0.12 | 0.18 | |
| `Equity (USA)` | equity USA + USD wallet | 0.11 | 0.17 | in ₹, includes FX |
| `Mutual Funds` | MF not matched as debt | 0.11 | 0.15 | |
| `MF_DEBT` (internal) | MF with `tax_class == 'debt'` or `category`/`sub_category` matching `/debt\|liquid\|gilt\|overnight\|money market\|bond\|credit\|arbitrage/i` | 0.07 | 0.03 | reported under the "Mutual Funds" segment in payloads |
| `Commodity` | gold/silver ETFs | 0.08 | 0.15 | |
| `P2P` | p2p | instrument `rate`/100 − `P2P_LOSS` (0.03); default 0.10 − 0.03 | 0.06 | |
| `Fixed Deposits` | FD | instrument `rate`/100; default 0.07 | 0.01 | |
| `EPF` | epf | instrument `rate` or 0.0825 | 0.005 | |
| `NPS` | nps | 0.10 | 0.12 | |

**Constants:**

| Name | Value / source |
|---|---|
| `RISK_FREE` | 0.065. `quant.RISK_FREE`, `optimizer.RISK_FREE` and `history.RISK_FREE` all import it |
| `INFLATION` | 0.06. `forecast.INFLATION` imports it; `retirementPlan.inflation_pct` overrides it per call |
| `P2P_LOSS` | 0.03 |
| `CORR` | 9×9 matrix: the 8×8 `optimizer._CORR_ROWS` plus a `MF_DEBT` row. Against EQ_IN, EQ_US, MF, COMM, P2P, FD, EPF, NPS, MF_DEBT the row is 0.05, 0.00, 0.10, 0.05, 0.10, 0.30, 0.20, 0.30, 1 |
| `STATUS_THRESHOLDS` | {on_track: 75, at_risk: 40} |
| `HONESTY` | Part 1 §1.9 copy, keyed: `p50`, `p10`, `p90`, `mean`, `probability`, `estimate`, `signal`, `disclaimer` |

**Functions:**

| Function | Maths / behaviour |
|---|---|
| `book_key(position) -> str` | Maps a position to a segment row. MF is split by the debt regex. Cash goes to `Equity (USA)`. |
| `effective_book(settings) -> dict` | Book merged with `settings.assumptions` (P2). The shape is {segments: {key: {return_pct, vol_pct}}, inflation_pct}. Validation is in `put_setting`. |
| `book_hash(book) -> str` | `sha1(json.dumps(book, sort_keys=True))[:10]` |
| `weights_from_positions(positions, book) -> {key: w}` | Value weights over open positions with value > 0. FD, P2P and EPF μ are the value-weighted instrument rates. |
| `mu_sigma(w, book) -> (mu, sigma)` | μ = Σ wᵢμᵢ; σ = √(Σᵢ Σⱼ wᵢwⱼρᵢⱼσᵢσⱼ), in pure Python. If Σw = 0, returns (0, 0). Unknown keys are ignored and added to `notes`. |
| `typical(mu, sigma)` | exp(ln(1+μ) − σ²/2) − 1, the median annual growth of the log-normal. This is what the "typical" label means. |
| `typical_band(mu, sigma, years)` | The annualised return over a span of T = max(years, 1) years has a log-normal distribution with mean m = ln(1+μ) − σ²/2 and standard deviation σ/√T. Returns {typical, lo = e^(m − 1.2816σ/√T) − 1, hi = e^(m + 1.2816σ/√T) − 1}, all ×100. |
| `status_for(prob, achieved=False)` | Applies the thresholds above. |
| `chip(book, w)` | {return_pct, typical_pct, volatility_pct, inflation_pct, hash, text}. Example text: `"11.0% avg · 9.6% typical · ±12.4% · 6% inflation"`. |

**Who calls the Book after P1:**

| Caller | Change |
|---|---|
| `forecast.blended_assumptions` | Replace σ = 0.7·Σwσ + 0.3·√Σ(wσ)² with `mu_sigma`. Keep the 730-day blend with the user's own record (30%) and the clamps. Add `typical_pct` and `hash` to the output. |
| `goals.project_goal` | Read μ and σ from `mu_sigma(goal allocation weights)`, which replaces the linear Σwσ. `goal.expected_return` still overrides μ. `goals.ASSUMPTIONS` stays as a re-export. |
| `optimizer._stats` | Uses `CORR` and `mu_sigma`, so `current.vol_pct` equals the brief's Risk vital by construction. |
| `quant.holding_outlook` | Cone drift = the Book μ for the holding's segment (it no longer extrapolates CAGR). σ = shrunk σ (§6.2). |
| `story.milestones` | `assumed_return` = `typical(mu, sigma)`, so the milestone timing is the median, not the mean. |
| `brief` Risk vital | est vol = `mu_sigma(current)` σ ×100, compared with `PROFILES[riskProfile].target_vol` ×100. |

**`GET /assumptions` (NEW, P1).** Returns:
- {`segments`: [{key, label, value, weight_pct, return_pct, typical_pct, volatility_pct, source ('default'|'override'|'holding rates')}], `corr`: {labels, matrix}, `portfolio`: chip, `inflation_pct`, `risk_free_pct`, `typical_bands`: [{years: 1|3|5, typical, lo, hi}], `hash`, `honesty`, `note`}.

It is memoised on (scope, book_hash, ledger version). The Plan "Assumptions" card and the drawer read it.

### 6.2 Per-holding expectations (P1: only what risk and the cone need; P3: "Role in your plan")

For each priced holding h with n daily log returns of its **own** (never zero-filled):

| Quantity | Formula |
|---|---|
| σ_own | stdev(own log returns) × √252 |
| shrink weight | w = min(n/756, 0.6); when n < 60, w = 0 |
| σ_h (used) | √(w·σ_own² + (1−w)·σ_book²), where σ_book is the σ of `book_key(h)` |
| β_h | w_b·β_own + (1−w_b)·1.0, where w_b = min(n/504, 0.7), clamped to 0..2.5 |
| μ_h | the Book μ for `book_key(h)`. Momentum is never used. |
| data_quality | `own` when n ≥ 504; `some` when 60 ≤ n < 504; `prior` when n < 60; `rate` for FD/EPF/P2P |

These live in `quant.holding_stats(points, book_key, book) -> {sigma_own, sigma_used, beta, n, data_quality}`. Two readers use it: `portfolio_risk` (the holdings table shows "Volatility (measured | used)") and `holding_outlook` (the cone). The full holding expectations in P3 add income yield, tax drag and liquidity to the same function.

### 6.3 Portfolio projection

**P0 fixes to `project_portfolio` (signature unchanged):**

| Field | Before | After |
|---|---|---|
| `scenarios.base` | deterministic mean at μ | `end.p50` |
| `scenarios.bear` / `bull` | deterministic at μ ∓ 4% | `end.p10` / `end.p90` from the same simulation |
| `scenarios.no_more_investing` | deterministic | p50 of the same shocks with sip = 0 (CRN, which costs one extra pass) |
| `expected` | unlabelled dashed line | kept and documented as the mean. The fan chart no longer draws it; T3 shows it as "Average (pulled up by the best cases)". |
| NEW `typical_cagr_pct` | — | (end.p50 / FV(current, sip at 0%))^(1/years) − 1, for the "growth on top" copy |
| `end.real_p50` | ÷ 1.06^years | ÷ (1 + inflation)^years, where inflation is `retirementPlan.inflation_pct`, otherwise the Book |
| NEW `assumptions.hash`, `honesty` | — | from the Book |

The simulation itself is unchanged. It runs monthly log-normal draws with the monthly drift ln(1+μ)/12 − σ²/24 and the monthly shock σ/√12·z.

**P1:** μ and σ come from `mu_sigma`, via `blended_assumptions`. The horizon default on Plan is max(10, years to the furthest goal).

**P2: `simulate.py` (NEW). A per-segment correlated Monte Carlo.**

The signature is `run(state, flows, book, *, horizon_months, sims=1000, seed=42, real=False, after_tax=False, shock=None, glide=None) -> Result`.

**State**
- Value and cost basis for each Book key, built from positions.
- Three keys are deterministic ladders: `Fixed Deposits`, `EPF` and `P2P`.
  - **FD:** each FD accrues at its `rate` until `maturity_date`. On that date its `maturity_value` is released to the segment furthest under target (or to `MF_DEBT` when there are no targets), and FD interest stops.
  - **P2P:** an EMI on `outstanding` over the months to `maturity_date` at `rate`, multiplied by (1 − P2P_LOSS/12) each month. Releases are re-lent up to the 10% cap; the rest is routed like FD maturities.
  - **EPF:** monthly contribution = the average of the last 12 months of BUY rows. Interest is credited each March at `rate`. The balance stays locked until `retire_age`.
- The other six keys are stochastic: EQ_IN, EQ_US, MF, MF_DEBT, COMM and NPS.

**Steps**
- Monthly for the first 24 months, quarterly up to 10 years, then yearly.
- Each step draws z ~ N(0, I₆) and correlates it as f = Lz, where L is the Cholesky factor of the 6×6 stochastic block of `CORR`. A pure-Python Cholesky runs once per call.
- The growth factor for segment s over a step of length dt is g_s = exp((ln(1+μ_s) − σ_s²/2)·dt + σ_s·f_s·√dt).
- Antithetic pairs: simulation 2j uses −z of simulation 2j−1.

**Flows**
- Each SIP plan is converted to its monthly equivalent (weekly ×52/12; quarterly and yearly on their due months, from `plans.due_dates`).
- The money goes to `book_key(plan instrument)`, or for a segment plan to the segment's key.
- Step-up applies every 12 months from `start_date`. A plan stops at `end_date` or `retire_age`.
- Within a step, flows are added at mid-step: value += flow × √g. Basis += flow.

**Options**
- `glide`: from age 45, the equity share falls by 1 point a year until a floor of 30%. At each year end, equity keys are rebalanced toward `MF_DEBT` and `Fixed Deposits`.
- `after_tax`:
  - FD and P2P accrual uses μ·(1 − slab×1.04), where slab is `taxSlabRate`.
  - Terminal values show "if sold at the horizon": tax = Σ_s max(0, value − basis − exemption_s) × rate_s. Equity is taxed at 12.5%×1.04 above ₹1.25 L. Foreign equity and commodity are taxed at 12.5%×1.04. `MF_DEBT` is taxed at slab×1.04.
  - Copy: "at today's rules; surcharge not modelled".
- `shock`: {key: pct}, applied at t = 0. Used for stress-to-plan.

**Outputs**
- per year: p10, p25, p50, p75, p90 (nominal; real = ÷(1+infl)^t), `contributed`, and the median by segment;
- `milestones` (the same ladder as today);
- `prob_below_contributed_3y`;
- the median of the maximum drawdown.

**Goals from the same draws.** A goal's value is v_g,t = Σ_s alloc_g,s × V_s,0 × G_s,t, plus the SIPs linked to that goal (P2.7) grown along their own segment path. The probability is the share of simulations with v_g,T ≥ `target_amount`. This is linear in the shared shocks, so it adds almost no cost.

**Budget:** 30 years × 1,000 simulations in ≤ 1.0 s. The test fails at more than 2.5 s. Guests are capped at 500 simulations. Only non-empty keys are updated.

### 6.4 Goals and funding (`goals.py`)

**Required SIP, P1.** `required_sip` changes meaning from "deterministic at the mean" to "the SIP that reaches 75% probability". This fixes the class of bug where you follow the advised SIP and get under 50%. The shared helper is `mc.required_sip_for(pv, months, mu, sigma, target, prob=0.75, step_up=0, seed)`:
- It draws annual-step shocks Z[sims=400][years] once.
- It bisects the SIP for 14 iterations. The upper bound starts at max(₹1,000, target/months) and doubles until the probability reaches the target.
- Each evaluation uses the same Z (CRN), so the result is monotone and stable.
- It also returns `required_sip_typical`, the SIP for 50% probability, computed deterministically at `typical(mu, sigma)`.
- Projections expose both values. The UI shows the 75% figure as "needs".

`goals.funding_summary(goals, segments, positions, emergency) -> funding` (NEW, P1). It follows Part 1 P1.1:
- Cushion holdings are taken out of segment values **before** earmarks are computed, so no rupee is counted twice.
- `earmarked[].amount` = `projection.current` computed on the cushion-free segments.
- `free` = max(0, `totals.value` − Σ earmarked − `cushion.amount`).
- `over_allocated[]` = {segment, claimed_pct = Σ goal allocation, goals[]}, listing every segment where claimed_pct > 100.

### 6.5 Retirement (`forecast.retirement_plan`)

**P0 maths. One convention everywhere: withdrawals are made at the start of each year (annuity-due).**

| Symbol | Definition |
|---|---|
| Y | `retire_age` − `current_age`. Validation: Y ≥ 1, otherwise a 400 error "Retirement age must be after your current age". |
| n | `life_expectancy` − `retire_age`. Withdrawals happen at ages `retire_age` … `life_expectancy` − 1. |
| i | `inflation_pct`/100 |
| r | `post_return_pct`/100 |
| r_real | (1+r)/(1+i) − 1 |
| W₁ | the first-year net withdrawal, computed as today: 12 × `monthly_expenses` × (1+i)^Y − 12 × `other_income_monthly` |
| `corpus_needed` | W₁ × ä_n, where ä_n = (1 − (1+r_real)^−n)/r_real × (1+r_real), and ä_n = n when \|r_real\| < 1e-9 |
| drawdown path | C_{k+1} = (C_k − W₁(1+i)^k)(1+r) for k = 0 … n−1. With C₀ = `corpus_needed`, this gives C_n = 0 to within ₹1. |
| accumulation path | the existing `_fv` at monthly resolution, sampled each year, so `path[age=retire_age].corpus` == `projected` |
| `probability` | accumulation-phase Monte Carlo (seed 7, 1,000 simulations): P(corpus at retirement ≥ `corpus_needed`) |
| `required_sip` | `mc.required_sip_for(..., prob=0.75)`. NEW `required_sip_typical` is the 50% figure. |
| `status` | `status_for(probability)`. Only when `probability` is None does it fall back to the gap. |
| `runs_out_at` | the first age at which the drawdown path is below 0 (deterministic at r) |

**P2 additions:**
- The Monte Carlo continues through the drawdown phase, using the same `simulate.run` with `glide`. Each simulated year withdraws W_k at the start of the year, then grows by the simulated retirement mix.
- Outputs added:
  - `probability_lasts`: the share of simulations with C > 0 after the last withdrawal;
  - `depletion_age_p10`: the 10th-percentile age at which the money runs out, or null;
  - `path_bands`: [{age, p10, p50, p90}].
- `status = status_for(min(probability, probability_lasts))`.
- Corpus sources for the retirement row on Plan:
  - EPF, locked;
  - NPS, where 60% is a tax-free lump sum and 40% buys an annuity at 6% that offsets expenses;
  - goal-free money (`funding.free` share).
  Money already earmarked for goals and the cushion is **excluded**. That removes the double counting.

### 6.6 Cash-flow forecast (`forecast.cash_flow_forecast`, P0)

| # | Fix | Rule |
|---|---|---|
| 1 | Window | Months start tomorrow. Any event dated ≤ today is dropped, and a dividend already received this month is not projected again. |
| 2 | FD interest | Projected `INTEREST` events are cut at `maturity_date`. |
| 3 | Payout-FD maturity interest | When the FD has any `INTEREST` rows: principal × rate/100 × (days since the last INTEREST)/365. Cumulative FDs keep `maturity_value` − principal. |
| 4 | Dividends | Per-unit dividend = DIVIDEND.amount ÷ open quantity on that date (`run_fifo` up to that date). Projected dividend = per-unit × current quantity, on the same month and day next year. Closed positions are skipped. |
| 5 | P2P without `maturity_date` | Amortised from `first_date` + `tenure_months`, not from today. Inflows are multiplied by (1 − P2P_LOSS/12) each month. |
| 6 | SIP frequency | Instalments come from `plans.due_dates`, so quarterly and yearly plans land on their real months. |
| 7 | EPF | A SIP plan on the EPF instrument is skipped when EPF contributions are averaged from the ledger, and a note says so. EPF payroll money is shown as "into EPF" (key `contributions`), not as `sip_out`. |
| 8 | Future-dated plans | Plans with `start_date` > today are excluded from `monthly_sip_total`. |

### 6.7 Risk measurement (`quant.portfolio_risk` v2, P0)

- The portfolio daily return is r_t = Σ_{i∈A_t} ŵᵢ r_{i,t} + Σ_{b∈B} ŵ_b a_b, where:
  - A_t is the set of priced holdings that have their own return on day t, or a proxy;
  - B is the ballast (FD, EPF, P2P, and NPS when priced by hand);
  - a_b = (1 + rate_b)^(1/252) − 1;
  - ŵ is today's value weight, renormalised over A_t ∪ B each day.
- **Proxy:** before a holding's first close, use its segment's index return × β_prior (= 1). The index is ^NSEI for EQ_IN, MF and NPS; ^GSPC × USDINR for US; GOLDBEES.NS for commodity. `MF_DEBT` has no proxy, so it is excluded until its first close. A proxied holding's row carries `data: 'proxy'`.
- Sharpe and Sortino use the corrected mean and `assumptions.RISK_FREE`.
- New fields:
  - `holdings[].volatility_used_pct` (the shrunk σ from §6.2) and `holdings[].data` ('own' | 'proxy' | 'prior');
  - `model` = {vol_pct (Book), var_day = 1.645·σ_model/√252 × total};
  - `measured_vs_model` = {measured_vol_pct, model_vol_pct, ratio}.

### 6.8 Stress (`forecast.stress_test`)

- **P1:** the routine-correction and covid scenarios feed the Risk & mix hero and the `stress:beyond-tolerance` rule. `MF_DEBT` holdings take the `rates` shock (−4%) instead of the equity shock in every scenario.
- **P2:**
  - Each holding's shock = segment shock × β_h (§6.2), clamped to −0.95..+1.0.
  - Recovery is reported two ways: `recovery_months_markets` (Book typical return, no SIPs) and `recovery_months_with_sips`.
  - `plan_impact` = {retirement_before, retirement_after, goals: [{id, name, before, after}]} from `simulate.run(shock=…)` with 500 simulations, CRN against the baseline.

### 6.9 Tax-aware outcomes (`tax.py`)

**`what_if_sale(port, txns, instruments, instrument_id, qty, price=None, sell_date=None, slab_rate) -> dict` (P1).**

Method:
1. Take the open lots from `run_fifo`, oldest first. Same-day buys are matched as intraday, as the ledger does.
2. Consume `qty` and build hypothetical `RealizedLot` rows with proceeds = qty × price × (`usd_inr` if the instrument is in USD).
3. Tax = `compute_tax(port + hypothetical lots, fy = fy_of(sell_date)).estimate.total` − `compute_tax(port, fy).estimate.total`. This keeps this FY's set-off and exemption use exactly as they are.
4. `wait`: if a consumed lot is short-term and turns long-term within 90 days, recompute with sell_date = the latest `lt_on` and report {date, days, tax_then, saving} when the saving is greater than 0.

Output:
- {`instrument_id`, `name`, `qty`, `price`, `currency`, `proceeds`, `cost`, `gain`, `lots`: [{date, qty, cost, proceeds, gain, term, rate_pct|null, lt_on}], `st_gain`, `lt_gain`, `exemption_used`, `exemption_left`, `tax_now`, `net_cash`, `effective_pct`, `wait`|null, `note`: "Estimate at your {slab}% slab incl. 4% cess; surcharge, carry-forward and exit loads not modelled."}

Errors (400):
- qty > open quantity → "You hold only N units";
- ELSS units still locked (`elss.locked_qty`) → names `next_unlock`;
- the asset class is not tradable;
- the price is missing and the holding has none (`has_price` false);
- `sell_date` more than 365 days ahead.

**`harvest_plan(port, instruments, remaining_exemption, today)` (P1).** Added to `opportunities`.
- Lots qualify when they are long-term equity with `tax_class == 'equity'`, gain > 0 and not locked. They are sorted by gain/value, descending.
- Whole lots are taken, then one partial lot, until the cumulative gain reaches `remaining_exemption` − ₹1,000.
- Output: `rows` [{instrument_id, name, qty, proceeds, gain, lots[]}], `total_gain`, `future_tax_saved` = total_gain × 0.125 × 1.04, and `note`: "Rebuy the next trading day — a same-day rebuy is netted as intraday and books nothing."

**P2: after-tax toggle.** See `simulate.run(after_tax=True)` in §6.3. **P2: tax-aware rebalancing.** Sell rows are ordered losses first, then long-term gains within the exemption, then everything else. Each row is costed with `what_if_sale`.

### 6.10 Scenarios and sensitivities (P2)

**Scenarios.** The `planScenarios` setting holds up to 5 entries: {name, sip, step, return, retire_age, lump_sums[]}. `POST /plan/compare` {scenarios: [index | inline] (≤4)} returns:
- {columns, rows: [{key, label, format, values[], deltas[]}], paths: [{name, p50[]}], band: {p10[], p90[]}, labels[]}.

Every scenario runs on the baseline's seed (CRN), so `compare(baseline, baseline)` gives deltas of exactly 0.

**Sensitivities** (`GET /plan?detail=1`):

| Key | Change applied |
|---|---|
| `sip` | SIP + max(₹5,000, 10% of SIP rounded to ₹1,000) |
| `retire` | `retire_age` + 2 |
| `returns` | every μ − 1 pt |
| `inflation` | i + 1 pt |

Each change is one run at 500 simulations with CRN. Each reports `retirement_pts` and `worst_goal_pts` as deltas.

### 6.11 Calibration (writes from P1, display in P3)

- `kpi_snapshots.data.projection_1y` = {p10, p50, p90}: the 1-year growth factor with no new money, taken from `project_portfolio(years=1, sip=0)`, together with `value` and `book_hash`.
- Evaluation, P3: for a snapshot dated d with d + 365 ≤ today, realised growth g = performance('ALL') `index` at d+365 ÷ `index` at d, using the nearest points. The snapshot is "inside" when p10 ≤ g ≤ p90.
- Display: coverage is shown only when at least 6 snapshots have matured, against a target of 80%. Use one snapshot per calendar month (the first of each month) so they are not autocorrelated.

### 6.12 Honesty mapping (payload field → copy)

| Field | Copy key | Rendered as |
|---|---|---|
| `end.p50`, `path[].p50` | `HONESTY.p50` | "Typical" |
| `p10` / `p90` | `HONESTY.p10` / `p90` | "1-in-10 bad case" / "1-in-10 good case" |
| `expected` | `HONESTY.mean` | T3 only |
| `probability` (any) | `HONESTY.probability` | whole number; "72 of 100 futures" |
| `cone` | `HONESTY.signal` | "range if it moves as it has; not a forecast" |
| `impact.amount` with confidence `estimate` or `model` | `HONESTY.estimate` | the `est.` tag with a tooltip giving the basis |

### 6.13 Fate of the existing engines

| Engine | P0 | P1 | P2 |
|---|---|---|---|
| `forecast.blended_assumptions` | — | uses `mu_sigma` | replaced inside `simulate` |
| `forecast.project_portfolio` | §6.3 fixes | Book μ/σ | becomes a thin wrapper over `simulate.run` (same payload shape) |
| `forecast.stress_test` | — | MF_DEBT uses the rates shock | β, recovery shown two ways, `plan_impact` |
| `forecast.retirement_plan` | §6.5 | `required_sip` at 75% | drawdown Monte Carlo and glide path |
| `forecast.cash_flow_forecast` | §6.6 | `plans.due_dates` | — |
| `quant.holding_outlook` | — | Book drift, shrunk σ | one signal model with `markets.signals_for`; Wilder RSI |
| `quant.portfolio_risk` | §6.7 | `model` block | — |
| `optimizer.suggest` | — | `CORR`/`mu_sigma`; MF_DEBT row | FD/P2P maturity-only ("let mature"), KEEP_SHARE 0.5 → 0.25, tax per trim |
| `goals.project_goal` / `rebalance_plan` | — | `mu_sigma`, `required_sip` at 75%, `funding_summary` | goal path from `simulate`, linked SIPs |
| `history.build_history` | — | read-only source for the assumptions check and calibration | — |

---

## 7. Backend additions and changes

### 7.1 Modules and functions

| Module | Function(s) (signature → output) | Tier | Notes |
|---|---|---|---|
| `analytics/assumptions.py` NEW | §6.1 | P1 | pure |
| `analytics/mc.py` NEW | `annual_shocks(seed, sims, years) -> list[list[float]]`; `required_sip_for(pv, months, mu, sigma, target, prob=0.75, step_up=0.0, seed=0) -> {sip_75, sip_typical}`; `pctl(sorted, q)` (re-export of `quant.percentile`) | P1 | goals and retirement share it |
| `analytics/plans.py` NEW | `due_dates(plan, start, end) -> list[date]`; `sip_adherence(sips, txns, instruments, today, months=6) -> Adherence`; `next_due(sips, today, horizon=90) -> list` | P1 | rules in §7.6 |
| `analytics/actions.py` NEW | `build_actions(src: ActionSources, log: dict[str, row], today) -> list[Action]`; `rank(actions, vitals) -> list`; `diversify(actions, k=3) -> list`; `auto_done(action, txns, port, tax, today) -> evidence\|None`; `follow_through(log, adherence, today) -> dict` | P0/P1 | §8 |
| `analytics/brief.py` NEW | `build_brief(ctx, actions, upcoming, plan, risk_est, stress, perf, snapshot_then, market_state, nifty_quote, settings, today) -> Brief` | P0 | pure; shape as in Part 1 P0.4 |
| `analytics/calendar.py` | NEW `upcoming(calendar, cashflow, sip_next_due, ipos, today) -> {inflow_90d, outflow_90d, theme, next_festival, events[≤30]}` | P1 | events = {date, days, kind, title, amount, direction, link, key}. `national` days are dropped. An FD maturity listed by both sources is deduplicated by (instrument_id, date), keeping the cash-flow event because it has the amount. |
| `analytics/goals.py` | `funding_summary(...)`; `project_goal` changes per §6.4 | P1 | |
| `analytics/tax.py` | `what_if_sale(...)`, `harvest_plan(...)` | P1 | §6.9 |
| `analytics/forecast.py` | fixes per §6.3, §6.5, §6.6 | P0 | |
| `analytics/quant.py` | `holding_stats(...)`; `portfolio_risk` v2 | P0 | |
| `analytics/insights.py` | link remap; new rules (§8.3) | P0/P1 | `build_insights` gains optional kwargs `cushion`, `risk_est`, `stress`, `snapshot_then`, `adherence`, `book` |
| `markets.py` | NEW `market_state(nifty_points, perf_metrics, stress, today) -> {mode, nifty{price, d1, w1, from_high_pct}, you{from_peak_pct, from_peak_inr}, comparable{key, label, impact}\|null, playbook[], since}` | P1 | crash: from_high ≤ −20 or w1 ≤ −8; correction: ≤ −10; volatile: \|d1\| ≥ 2.5; otherwise normal. `comparable` = the mildest stress scenario whose impact_pct ≤ your drawdown, otherwise `correction`. The playbook strings are fixed (Part 1 §4 context line). |
| `analytics/simulate.py` NEW | §6.3 | P2 | |
| `services.py` | `context`, `_peek`, `actions`, `brief`, `plan`, `upcoming`, `snapshot_write`, `snapshot_at`, `what_if`, `assumptions_view`; refactors of `insights`, `_pulse`, `notifications`, `goals`, `tax` | P0/P1 | §7.3 |
| `ledger.py` | `action_log(owners) -> {id: row}`; `set_action_status(owner, id, status, **fields)`; `upsert_action_seen(owner, rows)`; `actions_rev` counter; `kpi_snapshot_write(owner, date, data)`; `kpi_snapshot_at(owner, on_or_before)` | P0/P1 | none of these call `_bump` (§7.4) |
| `migrations.py` | `m005_actions_snapshots`; P2 `m006_sip_goal` | P0/P1 | §7.5 |
| `api/analytics_api.py` | routes in §7.2; `SETTING_KEYS` += `emergencyFund` (P1), `assumptions`, `seenNotices`, `planScenarios` (P2) | P0–P2 | |
| `api/forecast_api.py` | `GET /plan`, `GET /assumptions`, `POST /plan/compare` (P2); `/sips` adds adherence | P1/P2 | |
| `services.refresh_prices` | also fetches `^NSEI` in the same `fetch_quotes` call → `set_system_value('quote:^NSEI', {price, prev_close, date})` | P0 | a failure leaves the old value in place |

### 7.2 Endpoints

| Method / route | Auth | Returns (field names) | Memo key | Tier |
|---|---|---|---|---|
| `GET /brief?since=YYYY-MM-DD` | read (guest ok) | Part 1 P0.4 shape + `assumptions_check` {realised_pct, years, typical, lo, hi, verdict 'within'\|'above'\|'below'\|'too_short'} + `market_state` | ('brief', scope, settings, today, since, actions_rev, book_hash) | P0 |
| `GET /actions?status&category&instrument_id` | read | {summary{now, month, consider, good, impact_total}, actions[], planned[], done[], snoozed[], follow_through} | ('actions', scope, settings, today, actions_rev) | P0 |
| `POST /actions/<path:id>/status` | `@write_required` | the updated Action. Body {status ∈ open\|planned\|snoozed\|done\|dismissed, until?, planned_for?, note?, reason?, txn_ids?} | bumps `actions_rev` only | P0 |
| `POST /insights/<id>/dismiss` | write | alias → status `snoozed`, `until` = today + days | — | P0 |
| `GET /plan` | read | Part 1 P1.1 + `counts`, `deltas`; `?detail=1` adds `sensitivities` (P2) | ('plan', scope, settings, today, book_hash) | P1 |
| `GET /assumptions` | read | §6.1 | ('assumptions', scope, book_hash) | P1 |
| `GET /tax/what-if?instrument_id&qty&price&date` | read | §6.9 | ('whatif', scope, params) | P1 |
| `GET /tax?fy` | read | existing + `opportunities.harvest_plan` | existing | P1 |
| `GET /sips` | read | {plans, monthly_total, adherence, arriving[]} | ('sips', scope, today) | P1 |
| `GET /forecast`, `/forecast/retirement`, `/forecast/cashflow`, `/risk` | read | fixed engines + `assumptions.hash`, `honesty` | existing + book_hash | P0 |
| `GET /markets` | read | existing + `market_state` | existing | P1 |
| `GET /portfolio` | read | a **copy** without `realized_lots` (no `pop`) | — | P0 |
| `POST /plan/compare` | read; guests ≤2 scenarios × 500 simulations | §6.10 | ('compare', scope, body hash, book_hash) | P2 |
| `GET /forecast/stress` | read | + `plan_impact`, `recovery_months_markets`, `recovery_months_with_sips` | existing | P2 |
| `GET /notifications` / `POST /notifications/seen {ids}` | read / write | existing shape + `seen`, `unread` | — | P2 |
| `POST /jobs/daily-digest` | X-Job-Token (public path) | {at, owners[{owner, new, pushed}]} | — | P2 |
| `GET /transactions?page&size&q&sort` | read | {rows, total, page, size, sums} only when `page` is given | — | P2 |

All `?since`/`date` parameters are validated: malformed or future dates return 400.

### 7.3 Services composition

```python
def context(self, scope, settings):            # P0, memoised ('context', scope, settings, today)
    # → {port, data, fy, tax (current FY at taxSlabRate or DEFAULT_SLAB), goals (project_goal each), sips, adherence}
    # Docstring: RETURNED OBJECTS ARE SHARED AND READ-ONLY. Callers build new dicts.
def _peek(self, *key): ...                     # read the memo without building it; None if missing or stale
def actions(self, scope, settings): ...        # context + calendar(90) + cashflow(3) + plans.next_due + tax.opportunities
                                               #   + market_state + stress/risk_est (failures → that source skipped, notes[])
def brief(self, scope, settings, since): ...   # actions + upcoming + plan (status only) + _peek('performance', scope,'ALL',None)
                                               #   perf None → pending=['market']; then snapshot_write (try/except, outside the memo)
def plan(self, scope, settings): ...           # goals + funding_summary + retirement (only if retirementPlan saved) + deltas
```

Who reads `context` (and so stops recomputing the portfolio): `insights`, `_pulse`, `notifications`, `goals`, `tax(fy=None)`, `actions`, `brief`, `plan`.

The cold budget for `/brief` is < 800 ms on the scratchpad copy of the database. Cost breakdown:
- the existing price-free portfolio;
- tax;
- goals at 1,000 simulations each;
- retirement at 1,000 simulations + the 400-simulation bisection;
- stress;
- `mu_sigma`.

`/brief` never builds history; it only peeks. Warm `/brief` is < 50 ms.

### 7.4 Caching and write rules

| Write | Mechanism | Invalidates |
|---|---|---|
| ledger / settings / prices | `Ledger._bump()` (unchanged) | everything |
| `action_log` status POST | `Ledger.bump_actions()` → `actions_rev += 1` | memo entries keyed on `actions_rev` (actions, brief, notifications); portfolio, tax and plan memos are kept |
| `action_log` first_seen insert, auto-done upsert (done on read) | `INSERT … ON CONFLICT(owner,id) DO UPDATE … WHERE status IN ('open','planned')`, via `db.execute` | **nothing**. The computed result already reflects the change, so it is idempotent |
| `kpi_snapshots` | `INSERT OR IGNORE`, once per (owner, date) | nothing |

`snapshot owner` = scope, or `'__family__'`. **Status owner** for an action:
- `instrument.owner` when the action is tied to an instrument. So marking it done in family view is the same row as in the member's view, which fixes DECISION's '@family' split.
- Otherwise the settings owner (the user's email, or `'__global__'` for admin/guest until P2 per-member settings ship).

### 7.5 Migrations

**005 `actions_snapshots` (P0), all `CREATE TABLE IF NOT EXISTS`:**

```sql
action_log(owner TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  first_seen TEXT, tier_first TEXT, category TEXT, title TEXT, impact REAL, impact_kind TEXT, due TEXT,
  snooze_until TEXT, planned_for TEXT, done_at TEXT, done_via TEXT, evidence TEXT, reason TEXT, note TEXT,
  seen_at TEXT, pushed_at TEXT, updated_at TEXT, PRIMARY KEY (owner, id));
kpi_snapshots(owner TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, PRIMARY KEY (owner, date));
```

Data step: each `user_settings` row whose key is `dismissedInsights` becomes rows {owner: same, id, status 'snoozed', snooze_until: until, first_seen: today}. The setting is kept read-only for rollback.

**006 `sip_goal` (P2):** `ALTER TABLE sip_plans ADD COLUMN goal_id INTEGER`, guarded by `db.columns()`. `SIP_FIELDS` += `goal_id`, validated as belonging to the same owner. Deleting a goal sets `goal_id` to NULL explicitly in the ledger.

`kpi_snapshots.data` = {value, invested (net contributed), total_gain, xirr, day_change, goal_probs{id: p}, retirement_probability, vitals{key: status}, action_ids[], projection_1y{p10, p50, p90}, book_hash}.

### 7.6 SIP schedule and adherence rules (`plans.py`)

| Frequency | Due dates |
|---|---|
| monthly | `day_of_month` of each month |
| quarterly | every 3 months, counted from `start_date`'s month, on `day_of_month` |
| weekly | every 7 days from `start_date` |
| yearly | `start_date`'s month, on `day_of_month` |

All dates respect `start_date`, `end_date` and `active`.

Matching window for an instalment due on d: [d − 3, min(next due − 1, d + 20)]. Candidate BUYs are those on `instrument_id`, or in `segment_of` for plans tied to a segment. Plans are iterated by id, and each BUY's amount is consumed once across all plans.

An instalment's status:
- `done` when matched ≥ 95% of amount × the step-up factor;
- `partial` when matched > 0;
- `missed` when nothing matched and d + 4 < today;
- `upcoming` when d > today;
- `skipped` when action `sip:missed:<id>:<d>` was dismissed with reason `skipped`.

Measures:
- per-plan `adherence_pct` = (done + 0.5·partial) / due instalments;
- `adherence_6m_pct` is weighted by amount;
- EPF plans are excluded when ledger EPF BUYs come from `import:epf`.

Output: {plans[{id, name, monthly_equiv, months[{month, due, planned, invested, status}], adherence_pct, missed_count, next_due}], planned_this_month, invested_this_month, adherence_6m_pct, next_due[{date, plan_id, name, amount}]}.

### 7.7 Settings additions

| Key | Validation (400 otherwise) | Tier |
|---|---|---|
| `emergencyFund` | object; `months_target` int 3–24; `monthly_expenses` 0–1e7; `instrument_ids` ints that exist in the caller's scope (`L().instrument(id, g.scope)`) | P1 |
| `assumptions` | {segments: {key ∈ Book: {return_pct −5..25, vol_pct 0..60}}, inflation_pct 0..15}; an unknown key is rejected | P2 |
| `seenNotices` | {id: ISO date}, ≤ 500 keys, pruned oldest-first and after 60 days | P2 |
| `planScenarios` | ≤ 5 × {name ≤ 40 chars, sip ≥ 0, step 0–50, return −10..30\|null, retire_age\|null, lump_sums ≤ 10 [{date, amount ≥ 0}]} | P2 |

`emergencyFund` auto-suggest (shown in the brief Cushion note and in Settings):
- FDs with `days_to_maturity` ≤ 365;
- MFs that match `MF_DEBT`;
- the USD wallet.

Candidates are sorted by liquidity: wallet, then liquid MF, then FD by maturity.

### 7.8 Edge cases (engine-wide)

| Case | Behaviour |
|---|---|
| Empty ledger | `brief.empty = true`; onboarding actions `onboard:import` and `onboard:add`; vitals = []; plan status `unset` |
| Family scope (`g.scope = None`) | Plan and brief headlines append "· family plan". Retirement runs on the whole family's money with the `__global__` plan. Snapshots go to owner `__family__`. |
| A guest | All GETs work, and snapshot writes happen (system bookkeeping). Status POSTs return 403. Simulations are capped at 500. |
| Stress, optimizer or risk raises | That vital becomes `unset` with a note. `/brief` never returns 500. |
| Yahoo outage | The Data vital goes to act. The headline blames the data ("Prices are 5 days old — values may be off"). |
| No `retirementPlan` | `retirement = null`. No silent age-30 default anywhere on Home or Plan. The Forecast-era query defaults remain only on the retirement form's prefill. |
| Holding with < 30 closes | No cone. Risk uses the proxy or prior and flags the row. |
| Snapshot missing for the `since` date | `since_last = null`; the stat is hidden |

### 7.9 Tests that prove it (pytest, offline; validated on a scratchpad copy of the database; no real tokens)

| File | Tests |
|---|---|
| `test_assumptions.py` NEW | `mu_sigma` with 100% in one segment = that row; two segments with ρ = 1 = the linear sum; `typical` < μ for every σ > 0; the CORR 9×9 Cholesky succeeds (positive semi-definite); `book_hash` is stable when key order changes; `status_for` at 74.9 / 75 / 39.9 / 40; `optimizer.suggest().current.vol_pct` == brief Risk vital; the debt-MF regex on 'Liquid', 'Gilt', 'Corporate Bond' → MF_DEBT, while 'ELSS' does not |
| `test_forecast.py` (extend) | Retirement: `corpus_needed` drained by the path → C_n within ₹1 of 0; path at `retire_age` == `projected` ±0.5%; with SIP = `required_sip`, probability is 75 ± 3 and status is `on_track` only when probability ≥ 75; `retire_age ≤ current_age` → 400. Projection: `scenarios.base == end.p50`, bear == p10, bull == p90. Cash flow: an FD maturing in 2027-01 has no interest events after it; payout-FD maturity interest ≈ ₹1.75k (fixture); a dividend received this month is not projected; after selling 90% of shares the projected dividend is ×0.1; a quarterly SIP lands on its months; a future-start plan is excluded from `monthly_sip_total`. Risk: a 40/60 stock/FD mix has \|Sharpe − stock-only Sharpe\| < 0.1; a 70-day holding with a true σ of 32% has measured σ in 26–38%; risk contributions sum to 100 ± 0.5 |
| `test_plans.py` NEW | due dates for weekly, quarterly and yearly plans; one BUY cannot satisfy two plans; partial; a missed quarterly plan raises `sip:missed:<id>:<date>`; the EPF import exclusion |
| `test_actions.py` NEW | one test per rule in §8.3 (fires, id is stable); ranking (a critical P2P default outranks a ₹200 tax saving; an FD due in 3 days outranks an undated info item); the score uses `max(amount, 1000)`; diversity (≤1 per category, ≤1 data unless critical); FD dedupe; the CTA for each prefix; auto-done (SIP BUY in window at ≥80%; FD redeploy at ≥80% within 45 days; harvest done when remaining < ₹1,000); expiry; family status owner = instrument owner |
| `test_brief.py` NEW | the Part 1 fixtures (all good → "All clear"; 2% defaulted → at-risk act + ₹ in the headline; 6% unpriced → data act; no targets → mix unset; 2 months of cushion → act; perf None → `pending == ['market']`); `since` delta |
| `test_api.py` (extend) | `compute_portfolio` counting wrapper: /insights + /pulse + /notifications + /brief + /portfolio + /tax → 1 call, and 2 after POST /transactions; GET /tax still has realised lots after GET /portfolio; two /brief calls on one day → one snapshot row and the ledger `_version` unchanged; POST status bumps only `actions_rev` (a cached /plan is not rebuilt); guest POST → 403; `emergencyFund` with another owner's id → 400; the insight link regression (every `link` starts with a Part 1 route); `/tax/what-if` (long-term within exemption → 0; short-term ₹50k → ₹10,400; wait saving > 0; ELSS locked → 400; qty > held → 400; a USD stock uses fx) |
| `test_markets.py` (extend) | `market_state` thresholds on synthetic closes; the refresh stores `quote:^NSEI` |
| `test_simulate.py` NEW (P2) | σ = 0 → p10 = p50 = p90 = the closed-form FV within 0.5%; percentiles are monotone; the same seed gives identical output; a higher SIP raises every percentile (CRN); an FD releases in its maturity month; EPF stays locked; after-tax ≤ pre-tax; the speed test (≤ 2.5 s hard limit) |

---

## 8. Action and follow-through model

### 8.1 Action object (`actions.py`; `models.ts` `Action`)

```
{ id, kind ('state'|'event'), tier ('now'|'month'|'consider'|'good'), severity, status (log), category,
  title, detail, why (insight.action), assumptions|null,
  impact {amount, kind ('lump'|'monthly'), label}|null, due|null, days|null,
  confidence ('fact'|'estimate'|'model'|'signal'), score, owner|null, instrument_id|null,
  cta {label, type ('dialog'|'route'|'api'|'whatif'|'fd_mature'), route?, query?, fragment?,
       dialog? {kind, instrumentId, type, amount, quantity?, date?}, api? ('review_complete'|'prices_refresh'),
       whatif? {instrument_id, qty}},
  link, first_seen, is_new (id ∉ snapshot_then.action_ids), done_via|null, evidence|null, planned_for|null, snooze_until|null }
```

- **`state` actions** describe a condition (drift, concentration, data, cushion). They close when the condition clears.
- **`event` actions** have a date (maturity, instalment, tax deadline). They expire when their window passes.

### 8.2 Ranking (Part 1 §1.7, as implemented)

`score = max(impact.amount or 0, 1000) × U(days) × C(confidence)`

| Factor | Values |
|---|---|
| U | overdue or ≤3 days → 1.0; ≤7 → 0.85; ≤14 → 0.7; ≤31 → 0.5; ≤90 → 0.3; undated → 0.25 |
| C | fact 1.0; estimate 0.8; model 0.6; signal 0.3 |

- A monthly impact is scored at its 12-month amount, so it can be compared with lump sums. It is still displayed as monthly and is excluded from `impact_total`.
- Tiers come first (`now` > `month` > `consider` > `good`), then score descending, then `id`.
- T1 admission and budgets: Part 1 §1.4 and §1.5. Home uses `diversify(k=3)`.

### 8.3 Rule catalogue (sources → actions)

Abbreviations: Sev = severity (`crit`/`warn`/`info`/`pos`); Conf = confidence.

| Id | Source | Cat | Sev | Conf | Impact (₹, kind) | Due | CTA | Closes when |
|---|---|---|---|---|---|---|---|---|
| `data:missing-prices` | insight | data | warn; crit if unpriced weight ≥ 5% | fact | Σ cost of `missing_prices` | — | route `/settings#prices` | `missing_prices` is empty → done (auto) |
| `data:stale-prices` | insight | data | warn | fact | — | — | api `prices_refresh` | age ≤ 26 h |
| `nps:nav-stale:<iid>` NEW | insight | data | info | fact | value | — | route `/nps` | `price_at` ≤ 30 days old |
| `p2p:defaulted` | insight | p2p | crit | fact | Σ `at_risk` | — | `/p2p?tab=defaulted` | at_risk = 0 (or dismissed) |
| `p2p:overdue` | insight | p2p | warn | fact | Σ `outstanding` where `overdue_days` > 30 | — | `/p2p?tab=overdue` | none overdue |
| `p2p:yield` | insight | p2p | info | estimate | — | — | `/p2p` | state |
| `fd:maturing:<iid>` | insight + cashflow (deduped) | fd | warn | fact | `maturity_value` | `maturity_date` | route `/actions#deploy?new_money=` | non-FD BUYs (or a new FD) dated ≥ maturity−3 summing ≥ 80% within 45 days → done (evidence = txn ids); otherwise expired at +45 days |
| `fd:matured-unrecorded:<iid>` NEW | portfolio | fd | warn; crit after 30 days | fact | `maturity_value` | `maturity_date` (overdue) | `fd_mature` | a MATURITY row exists |
| `cash:usd` | insight | cash | info | fact | wallet `value` | — | `/actions#deploy` | `balance_usd` < 50 |
| `cash:p2p-principal:<YYYY-MM>` NEW | ledger | cash | info | fact | principal back in the last 30 days (≥ ₹10k) | — | deploy | BUYs ≥ 80% within 45 days |
| `deploy:idle` NEW | brief | allocation | info | estimate | `deploy.suggested` (> ₹10k) | — | deploy | state |
| `cushion:low` NEW | brief | cash | warn < 3 months; info < target | fact | (target − months) × `monthly_expenses` | — | `/settings#cushion` | months ≥ target |
| `drift:<segment>` | insight | allocation | warn ≥ 5; info ≥ 2.5 | estimate | \|drift\|/100 × targeted value | — | `/risk#rebalance` | \|drift\| < 2.5 |
| `targets:missing` | insight | allocation | info | fact | — | — | `/risk#mix` | setting exists |
| `concentration:<iid>` | insight | risk | warn ≥ 15 (MF 25) | fact | (weight − 10)/100 × value | — | `/holding/<iid>` | weight < 12 |
| `sector:<name>` | insight | risk | warn | fact | (share − 30)/100 × direct equity | — | `/risk#concentration` | share < 28 |
| `diversification:stocks` | insight | risk | info | fact | — | — | `/holdings/equity` | state |
| `risk:above-profile` NEW | brief | risk | warn | estimate | — | — | `/risk` | est vol ≤ target + 5 |
| `stress:beyond-tolerance` NEW | stress | risk | warn | model | (\|covid impact_pct\| − 2.5 × target_vol_pct)/100 × value | — | `/risk#stress` | within tolerance |
| `tax:ltcg-harvest:<fy>` | tax | tax | warn Jan–Mar; info otherwise | estimate | `future_tax_saved` | last trading day ≤ 31 Mar | whatif / `/tax?tab=save` | `remaining_exemption` < ₹1,000 |
| `tax:loss-harvest:<fy>` | tax | tax | info; warn Jan–Mar | estimate | `loss_harvest_offsettable` × top rate in `tax_lines` | 31 Mar | `/tax?tab=save` | offsettable falls ≥ 80% |
| `tax:wait-lt:<iid>:<lot>` | tax | tax | info | estimate | `tax_saving` | `lt_on` | whatif | expires after `lt_on` |
| `elss:unlocked:<iid>` | insight | tax | info | fact | `unlocked_value` | — | `/holding/<iid>` | dismissed |
| `sip:missed:<sid>:<due>` | plans | habit | warn | fact | instalment | due | dialog BUY {instrumentId, amount, date} | adherence status done or skipped; expires at +30 days |
| `sip:due:<sid>:<due>` NEW | plans | habit | info | fact | instalment | due (≤ 5 days ahead) | dialog | matched |
| `sip:ended:<sid>` NEW | plans | habit | info | fact | — | — | `/recurring` | plan edited or paused |
| `sip:gap:<iid>` | insight | habit | info | fact | — | — | `/holding/<iid>` | state |
| `goal:<id>` | goals | goals | warn (at_risk) / crit (off_track) | model | `required_sip` − `monthly_contribution` (monthly) | `target_date` | `/plan?tab=goals#goal-<id>` | status good |
| `retirement:gap` NEW | plan | goals | warn/crit by status | model | `required_sip` − `inputs.monthly_sip` (monthly) | — | `/plan?tab=retirement` | probability ≥ 75 |
| `plan:probability-drop:<id>` NEW | snapshots | goals | warn | model | as for the goal | — | `/plan` | drop < 10 points |
| `review:due:<YYYY-Qn>` | insight | review | info | fact | — | quarter end | api `review_complete` | `lastReviewDate` falls inside the quarter |
| `loser:<iid>` / `winner:<iid>` | insight | performance | info | fact | — | — | `/holding/<iid>` | state |
| `perf:vs-nifty`, `perf:drawdown`, `perf:xirr` | insight | performance | warn / pos | fact | — | — | `/performance` | state |
| `market:target-hit:<wid>` (P2) | market_alerts | market | info | signal | — | — | `/markets?tab=watchlist` | expires after 2 days |
| `data:import-due:<source>` (P2) | ledger | data | info | fact | — | — | `/import` | an import with that source |
| `onboard:*` | brief (empty ledger) | data | info | fact | — | — | `/import`, Add | first transaction |

Links are remapped as Part 1 §3.6 specifies. The regression test runs over this table.

### 8.4 States and transitions

| From → To | Trigger | Writes |
|---|---|---|
| (none) → open | the rule fires for the first time | `INSERT OR IGNORE` first_seen, tier_first, category, title, impact, due. No bump. |
| open → planned | user: "Plan for…" (`planned_for` ≥ today) | `bump_actions` |
| open/planned → snoozed | user: Snooze 7, 30 or 90 days (max 365) | `snooze_until` |
| snoozed → open | `snooze_until` < today, computed on read | none |
| open/planned → done (manual) | user "Done", or TxnDialog saved with `actionId` (evidence = new txn id) | `done_at`, `done_via='manual'`, evidence |
| open/planned → done (auto) | the §8.3 close rule holds (event: matching ledger evidence; state: condition cleared) | upsert `done_via='auto'`, evidence {txn_ids \| condition, date}. No bump. |
| open/planned → dismissed | user "Not relevant" (optional reason; `skipped` for SIPs) | reason |
| open/planned → expired | an event's window passes without evidence, or a state action stops firing because of something not caused by the user (for example a price move) | computed on read; persisted by the upsert |
| done → open | user Undo | clears done fields |

Planned actions whose `planned_for` < today show "Days late" and rank as `now`. Re-firing works by period: a new month, quarter or FY gets a new id, so a done item never reopens inside its period.

### 8.5 Follow-through (`follow_through(log, adherence, today)`)

| Metric | Definition |
|---|---|
| `acted_90d` {done, total, pct} | Over actions with `first_seen` ≥ today − 90 and `tier_first` ∈ {now, month}: done / (done + expired). Dismissed rows with a reason, and open or snoozed rows, are excluded. |
| `on_time_pct` | done with `done_at` ≤ due (undated: within 14 days of `first_seen`) / done |
| `impact_realised_fy` | Σ impact for done tax actions (est.) + Σ evidence BUY amounts for done fd/cash actions, within the current FY. Labelled "est." |
| `sip_adherence_12m` | `plans.sip_adherence(months=12).adherence_6m_pct`, computed over 12 months |
| `median_days_to_act` | median of (`done_at` − `first_seen`) |

### 8.6 Notifications and digest (P2)

- `notifications()` = tier-`now` actions mapped to `Notice` {id `act:<id>`, kind = category, title, body = detail, date = due, days, link = CTA route, severity}, plus upcoming events ≤ 7 days that no action covers, plus `_market_notices`.
- `POST /jobs/daily-digest` runs from cron at 03:45 UTC. For each owner with push subscriptions and the digest flag on, it pushes ≤ 3 `now` actions with `pushed_at` IS NULL, then sets `pushed_at`. A second run on the same day sends nothing.

---

## 9. Visual grammar: making priority visible

### 9.1 Tokens (`styles.scss`, P0)

```scss
:root {
  --st-good: var(--pos); --st-watch: var(--warn); --st-act: var(--neg);
  --st-unset: var(--border-strong); --st-info: var(--muted);
  --st-good-soft: color-mix(in srgb, var(--pos) 10%, transparent);   /* same for watch/act/unset */
  --t-hero: 40px; --t-hero-deep: 28px; --t-num: 24px; --t-stat: 18px; --t-h2: 15px; --t-body: 14px; --t-meta: 13px; --t-label: 12px;
  --stripe: 4px; --gap-tier: 28px;     /* vertical gap before every .q-head */
}
[data-status="good"]{--st:var(--st-good)} [data-status="watch"]{--st:var(--st-watch)}
[data-status="act"]{--st:var(--st-act)}   [data-status="unset"]{--st:var(--st-unset)} [data-status="info"]{--st:var(--st-info)}
```

The ad hoc sizes 12.5, 13.5 and 14.5px are removed from new components. Dark mode (P2) redefines the base tokens under `@media (prefers-color-scheme: dark)` with `:root:not([data-theme="light"])`, and again under `[data-theme="dark"]`. The status tokens follow automatically.

### 9.2 Classes

| Class | Spec |
|---|---|
| `.q-head` | 12px/700, uppercase, letter-spacing .08em, colour `--muted`, with a leading 14px icon. Margin `--gap-tier` 0 10px. Optional right-side link. |
| `.verdict[data-status]` | `.card` with `border-left: var(--stripe) solid var(--st)`. Grid: badge top-right; big number 24px/650; one sentence 14px; CTA row. Min-height 132px. |
| `.status` | inline-flex, gap 4px, padding 2px 8px, radius 999px, background `color-mix(in srgb, var(--st) 12%, transparent)`, colour `var(--st)`, 12px/600. **Always icon + word.** |
| `.vital` | Compact (good): height 40px, icon + label + value. Wide (watch, act, unset): adds a 12px note line and a "Fix →" link, with a 4px stripe. On desktop a row of 5 with flex-wrap; on phones a 2-column grid. Unset uses a 1px dashed `--st-unset` border. |
| `.action-card` | stripe; title 15px/600; detail 13px `--text-2`; meta row with `.impact`, `.conf`, `.due` and the owner chip; CTA on the right (`.btn.primary` only on the first card of a section). The ⋯ menu sits top-right. `.action-card.compact` is a single 44px row. |
| `.impact` | pill, 12px/600, `--surface-2`. Signed ₹ uses `--pos`/`--neg` only for money in and out. |
| `.conf` | 11px uppercase tag: Fact (no border), Estimate (dotted border), Model (dashed border), Signal (muted). |
| `.est` | 10.5px "est." with a dotted underline. The `title` and tooltip state the basis and the assumption chip text. |
| `.due` | 12px chip: "in 4 days" / "by 31 Mar". Overdue: `--st-act` text with an alert icon. |
| `.prob-bar` | 8px track, fill `var(--st)`, ticks at 40% and 75% (1px `--axis`), value at the right "72%". Delta "▲6" / "▼12" in 12px. |
| `.assumption-chip` | 12px, `--accent-soft` background, info icon; click → drawer. Shows the `hash` in a title attribute. |
| `.needs-attention` | wrapper for ≤2 compact action cards under T0; `display:none` when empty |

Hero (T0) reuses `.banner` (Home) and `.kpis` with `.kpi.hero` (deep pages). It adds `.verdict-line` (16px/600, status icon tinted `#fff` on navy, with the word, never colour alone) and `.context-line` (13px; `--gold-soft` left bar).

### 9.3 Components (`frontend/src/app/shared/priority/`, P0 unless marked)

| Component / file | Inputs → output |
|---|---|
| `priority.ts` | `type Status = 'good'\|'watch'\|'act'\|'unset'\|'info'`; `STATUS_META` {word, icon: checkCircle/alert/alertOctagon/circleDashed}; `STATUS_THRESHOLDS = {good: 75, watch: 40}`; `statusFromProbability`, `statusFromGoal`, `statusFromSeverity`, `worstStatus(list)` (act > watch > unset > good > info); `TIER_ORDER`; `CONFIDENCE_LABEL`; `VITAL_ORDER`. This replaces the two STATUS maps in goals and retirement. |
| `StatusBadgeComponent` `<app-status [status] [word]?>` | `.status` |
| `VerdictCardComponent` `<app-verdict [status] [title] [big] [sentence] [cta]>` + `<ng-content>` | `.verdict` |
| `VitalChipComponent` `<app-vital [vital]>` | `.vital`; compact when good |
| `ActionCardComponent` `<app-action-card [action] [compact] [primary]>` (outputs status changes) | `.action-card`; ⋯ menu → `ActionService.setStatus` |
| `ProbBarComponent` `<app-prob-bar [value] [delta]>` | `.prob-bar` |
| `AssumptionChipComponent` + `AssumptionsDrawerComponent` (P1) | reads `assumptions` from the payload; the drawer fetches `GET /assumptions` |
| `EstTagComponent` `<app-est [basis]>` | `.est` |
| `NeedsAttentionComponent` `<app-needs-attention [prefixes]>` (P1) | filters `ActionService.actions()` by link prefix, ≤2 |
| `core/action.service.ts` | signals `actions`, `summary`, `followThrough`; loads `/actions` (snapshot-cached by `snapshotKey('actions', scopeKey)`); reloads on `store.version()` and after status posts; optimistic `setStatus` |
| `core/action-runner.service.ts` | `run(action)`: `dialog` → `TxnDialogService.add(kind, {instrumentId, type, amount, quantity, date, notes, actionId})`; `route` → `router.navigate([route], {queryParams: query, fragment})`; `api` → `review_complete` / `prices_refresh`; `whatif` → `WhatIfSaleComponent` modal; `fd_mature` → the FD modal. After a dialog save that carries `actionId`, it posts `status:'done'` with `txn_ids`. |
| `shared/what-if-sale.component.ts` (P1) | modal with qty/price/date → `/tax/what-if` → lots table, the tax figure with an est. tag, the wait hint, "Record this sale" → TxnDialog SELL |
| Icons | add `alertOctagon` and `circleDashed` to `icon.component.ts` PATHS |
| `LineChartComponent` (P1) | marker kind `goal` (a 7px diamond plus a label above, tooltip "{name} · needs ₹X"); `xLabel` input formatter (for "2041 · 45" and age axes); the `expected` series is dropped from Plan |

### 9.4 Placement and size rules (checked in review)

| Rule | Check |
|---|---|
| Above the fold at 1280×800 on Home | page head 56 + hero 170 + vitals 64 + q-head 30 + action header 30 + 3 cards ≈ 150 → ≤ 520px |
| Phone (390×844) | hero (value, pill, verdict, 2 stats) ≤ 260px; vitals and the top action within 1.5 screens |
| One `.btn.primary` per section | lint by review; on Home only the first action card has one |
| Navy only for T0 | no other component uses `--ink` or `--hero` |
| Every forward-looking ₹ | has `<app-est>` or sits in a card with an assumption chip |
| T2 charts | ≤ 290px tall (220px on phones); each T2 card header carries "Explains: {T1 label} · {status}" |
| Colour never alone | badges carry an icon and a word; signed numbers carry +/−; heat cells carry ▲/▼ |
| Skeletons | only T2/T3 may show `.skeleton`; T0/T1 paint from the snapshot |

---

## 10. Risks and non-goals

### 10.1 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Changing `required_sip` to the 75% figure raises the "needs" numbers users have seen | A one-time note on Plan: "Monthly needed now aims for a 3-in-4 chance (was the average path)". `required_sip_typical` is shown in T3. |
| A `/brief` god-object | `/brief` only composes memoised parts; each source fails soft to `unset`; a pure fixture test pins the shape; sub-endpoints stay. |
| Writes during GETs (snapshots, first_seen, auto-done) | idempotent SQL; never `_bump`; a test checks `_version` is unchanged; the single gunicorn worker stays (cache is in-process). |
| Shared memo dicts mutated | the `/portfolio` copy fix; a "read-only" docstring on `context`; brief and actions build new dicts; a regression test. |
| Book defaults (12% equity, 3% P2P loss, debt-MF 7/3) drive every headline | one documented module; the assumptions check against the user's own record; the "returns −1 pt" sensitivity (P2); overrides (P2); calibration (P3). |
| False precision from a pure-Python Monte Carlo | whole-number probabilities; p10/p90 framed as "1-in-10"; the mean hidden; stress shown beside the fan; `MF_DEBT` and proxies flagged. |
| Simulation speed in P2 | 6 stochastic keys only; antithetic draws; coarse steps beyond 2 years; on-demand sensitivities; the guest cap; the speed test blocks merge. |
| Action fatigue (≈35 rules) | the T1 admission thresholds; diversity; `consider`/`good` collapsed; period-keyed ids; snooze. After a month, review the counts from `kpi_snapshots.action_ids`. |
| Auto-done false positives (an unrelated purchase in the same segment) | Prefer instrument matches; ≥80% thresholds; evidence is shown ("Auto: BUY #812"); one-click Undo. |
| Family-view status semantics | status owner = instrument owner, or the settings owner; "family plan" labels; P2 per-member settings. |
| Tax edges (surcharge, grandfathering, carry-forward, pre-2023 debt indexation) | every tax figure is `estimate` confidence with a note; the rules live only in `rule_for`; tests pin the FY rules. |
| Yahoo outages turn every Home to act | the headline blames stale prices; the Data vital fix link; `quote:^NSEI` failure leaves the last value. |
| Navigation churn | permanent redirects plus the `ForecastRedirect` resolver; the link regression test; existing components reused, so content stays familiar. |
| No frontend tests | logic kept in the backend engines (pytest); specs for `priority.ts`, `ActionRunnerService` and `ActionService`; `ng build` strict; manual checks at 1280/1000/760/390 px. |
| Schedule | P0 ≈ 2 weeks, P1 ≈ 3 weeks for two developers. P2 items are independent and can each be dropped. |

### 10.2 Non-goals (explicitly out)

- **No price predictions, targets or buy/sell calls.** Signals stay "price pattern, not a forecast" and never rank above `signal` confidence.
- **No automatic ledger writes from advice.** Every recorded instalment or sale goes through a TxnDialog the user confirms. DECISION's `POST /money-plan/record` with estimated units is rejected.
- **No synthetic ₹ impacts.** Actions with no real amount have `impact = null` and are scored at the ₹1,000 floor.
- **Not in this release:**
  - ANALYTICS' 13-sleeve / 4-factor Book, `goal_links`, scenarios table, funded ratio, safe-spend solver and `forecast_snapshots` table (sleeves move to P3; the rest are covered by segment rows, `planScenarios` and `kpi_snapshots`);
  - multi-process caching or more gunicorn workers;
  - new asset classes (bank cash, liabilities, PPF, SGB, bonds) — P3 backlog;
  - advance tax and 80C — P3;
  - surcharge, grandfathering FMV and loss carry-forward;
  - AI-generated advice beyond narrating the ranked brief (P3);
  - user-customisable T0/T1 layout (only T2 order, P3).
