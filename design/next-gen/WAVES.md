# Build plan: waves

Generated with the specification in SPEC.md. Within a wave, tasks touch disjoint files and can be built in parallel. Amendments that override these tasks live in AMENDMENTS.md.

## Wave 1

P0 foundations: honest engines (P0.1), one memo-safe shared context and the action_log/kpi_snapshots persistence (P0.2, P0.3 storage), the pure action and brief engines (P0.3, P0.4), the insight link remap (P0.6 backend), and the frontend priority grammar (P0.5). No new pages yet.

### W1-B1: Shared backend core: migration 005, ledger action/snapshot store, Services.context and _peek, /portfolio copy, ^NSEI quote

**Area:** backend

**Files:** `backend/tracker/migrations.py`, `backend/tracker/ledger.py`, `backend/tracker/services.py`, `backend/tracker/api/analytics_api.py`, `backend/tracker/__init__.py`, `backend/tests/test_migration.py`, `backend/tests/test_api.py`

SHARED TASK, RUN FIRST. Implements Part 1 §2 P0.2, the storage half of P0.3, and Part 2 §7.3 (context/_peek only), §7.4, §7.5 (m005 only), and the ^NSEI row of §7.1.
1. migrations.py: add m005_actions_snapshots exactly as in §7.5 (action_log and kpi_snapshots, CREATE TABLE IF NOT EXISTS), plus the data step that copies each user_settings 'dismissedInsights' entry into action_log rows (status 'snoozed', snooze_until = until, first_seen = today). Keep the setting for rollback.
2. ledger.py (§7.1 ledger row, §7.4): action_log(owners) -> {id: row}; set_action_status(owner, id, status, **fields), which calls the NEW bump_actions() (actions_rev += 1) and never _bump; upsert_action_seen(owner, rows) using INSERT ... ON CONFLICT(owner,id) DO UPDATE ... WHERE status IN ('open','planned'), with no bump; an actions_rev property; kpi_snapshot_write(owner, date, data) with INSERT OR IGNORE; kpi_snapshot_at(owner, on_or_before). None of these may call _bump.
3. services.py: context(scope, settings), memoised on ('context', scope, settings, today), returning {port, data, fy, tax (current FY at taxSlabRate), goals, sips, adherence: None for now}, with the read-only docstring from §7.3. Add _peek(*key), which returns a memo entry without building it. Refactor insights, _pulse, notifications, goals and tax(fy=None) to read context. refresh_prices also fetches ^NSEI in the same fetch_quotes call and stores set_system_value('quote:^NSEI', {price, prev_close, date}); on failure the old value stays.
4. analytics_api.py GET /portfolio: return a shallow copy without realized_lots. Do not pop from the cached dict (currently around line 32).
Tests:
- test_migration: m005 is idempotent and the dismissedInsights rows migrate.
- test_api: a compute_portfolio counting wrapper shows that /insights + /pulse + /notifications + /portfolio + /tax make 1 call, and 2 after POST /transactions; GET /tax still has realised lots after GET /portfolio; action_log and kpi writes leave ledger _version unchanged.
Acceptance: pytest is green on a scratchpad copy of investments.db, offline.

### W1-F1: Shared frontend grammar: models, api, tokens, icons, txn-dialog prefill, priority components, ActionService, ActionRunner

**Area:** frontend

**Files:** `frontend/src/app/core/models.ts`, `frontend/src/app/core/api.service.ts`, `frontend/src/styles.scss`, `frontend/src/app/shared/icon.component.ts`, `frontend/src/app/core/txn-dialog.service.ts`, `frontend/src/app/shared/txn-form.component.ts`, `frontend/src/app/shared/txn-form.component.html`, `frontend/src/app/layout/shell.component.ts`, `frontend/src/app/shared/priority/priority.ts`, `frontend/src/app/shared/priority/status-badge.component.ts`, `frontend/src/app/shared/priority/verdict-card.component.ts`, `frontend/src/app/shared/priority/vital-chip.component.ts`, `frontend/src/app/shared/priority/action-card.component.ts`, `frontend/src/app/shared/priority/prob-bar.component.ts`, `frontend/src/app/shared/priority/est-tag.component.ts`, `frontend/src/app/shared/priority/needs-attention.component.ts`, `frontend/src/app/core/action.service.ts`, `frontend/src/app/core/action-runner.service.ts`

SHARED TASK, RUN FIRST. Implements Part 1 §2 P0.5, §1.8 and §1.9, and Part 2 §8.1, §9.1, §9.2 and §9.3 (every P0 component plus NeedsAttention).
1. models.ts: export these exact types: Status, Action (every field in §8.1), ActionCta, ActionImpact, ActionStatus ('open'|'planned'|'snoozed'|'done'|'dismissed'|'expired'), ActionsResponse (§5.1 Data: summary, actions, planned, done, snoozed, follow_through), Vital {key, status, label, value, note, link}, Freshness (§2 P0.7), and Brief (§2 P0.4 + §4 + §7.2: status{status, headline, count_now, count_month, impact_total}, hero{nifty_d1, since_last|null}, vitals, actions, on_track{plan, market, habit}, why, allocation, upcoming, tax, deploy, freshness, pending, empty, assumptions_check, market_state). Add optional fields wherever P1 fills them later.
2. api.service.ts: brief(since?), actions(params), setActionStatus(id, body). The id is URL-encoded because it contains ':'.
3. styles.scss: the §9.1 tokens and the §9.2 classes (.q-head, .verdict[data-status], .status, .vital, .action-card(.compact), .impact, .conf, .est, .due, .prob-bar, .assumption-chip, .needs-attention, .verdict-line, .context-line). Do not use 12.5, 13.5 or 14.5px in the new classes.
4. icon.component.ts: add alertOctagon and circleDashed to PATHS.
5. TxnDialogState gains amount, quantity, date, notes and actionId; txn-form prefills them. In the shell's dialog host, after a save that carries actionId, emit the new txn id so that ActionRunner can POST status 'done' with txn_ids. Only the dialog host changes in the shell; navigation waits for wave 2.
6. shared/priority: priority.ts (§9.3 row: STATUS_META, STATUS_THRESHOLDS {good:75, watch:40}, statusFromProbability/Goal/Severity, worstStatus, TIER_ORDER, CONFIDENCE_LABEL, VITAL_ORDER), StatusBadge, VerdictCard, VitalChip (compact when good; dashed when unset), ActionCard (⋯ menu: Plan for…, Snooze 7/30/90, Done, Not relevant), ProbBar (ticks at 40/75, ▲/▼ delta), EstTag, NeedsAttention ([prefixes], ≤2 compact cards, hidden when empty). All are standalone and use signals.
7. core/action.service.ts and core/action-runner.service.ts as in §9.3. ActionService paints from snapshotKey('actions', scopeKey), reloads on store.version(), and has an optimistic setStatus. ActionRunner dispatches dialog, route, api (review_complete, prices_refresh), whatif (no-op stub until P1) and fd_mature.
Acceptance: ng build passes in strict mode. Badges always show an icon and a word (§1.8). The goals and retirement STATUS maps stay as they are; the pages that own them replace them later.

### W1-B2: Forecast engine P0 fixes: retirement, projection scenarios, cash-flow forecast

**Area:** backend

**Files:** `backend/tracker/analytics/forecast.py`, `backend/tracker/api/forecast_api.py`, `backend/tests/test_forecast.py`

Implements Part 1 §2 P0.1 (forecast rows) and Part 2 §6.3 (P0 table), §6.5 (P0 maths) and §6.6 rows 1–5, 7 and 8.
- retirement_plan: annuity-due corpus_needed (W1 × ä_n), a drawdown path that drains to within ₹1 at life_expectancy, an accumulation path at monthly resolution so that path[retire_age].corpus == projected, status = status from probability (≥75 on_track, ≥40 at_risk, else off_track; until assumptions.status_for exists in wave 2, use a local helper), and runs_out_at. The probability Monte Carlo uses seed 7 and 1,000 sims. forecast_api returns 400 'Retirement age must be after your current age' when retire_age ≤ current_age. required_sip stays deterministic for now; wave 3 moves it to 75%.
- project_portfolio: scenarios.base/bear/bull = end.p50/p10/p90 from the same simulation; no_more_investing = p50 of the same shocks with sip = 0; expected is kept and documented as the mean; add typical_cagr_pct; real_p50 uses retirementPlan.inflation_pct or 6%; add an honesty block with the §1.9 labels.
- cash_flow_forecast: §6.6 rules 1–5, 7 and 8. Rule 6 (plans.due_dates) waits for wave 3.
Tests (§7.9 test_forecast rows except Risk and quarterly SIP): C_n is within ₹1 of 0; path at retire_age == projected ±0.5%; status is on_track only when probability ≥75; 400 on a bad age; base == p50, bear == p10, bull == p90; no FD interest after maturity; payout-FD maturity interest ≈ ₹1.75k fixture; a dividend received this month is not projected; selling 90% of shares gives a ×0.1 dividend; a future-start plan is excluded from monthly_sip_total.

### W1-B3: Risk engine P0: portfolio_risk v2 and holding_stats

**Area:** backend

**Files:** `backend/tracker/analytics/quant.py`, `backend/tests/test_risk.py`

Implements Part 1 §2 P0.1 (risk row) and Part 2 §6.2 (holding_stats) and §6.7.
- Add quant.holding_stats(points, book_key, book) -> {sigma_own, sigma_used, beta, n, data_quality}, with the shrinkage, beta blend and data_quality rules in §6.2. Until assumptions.py exists (wave 2), take σ_book and μ from goals.ASSUMPTIONS through a small local mapping; that is the segment prior.
- portfolio_risk v2 (§6.7):
  - ballast (FD/EPF/P2P, and hand-priced NPS) accrues a_b = (1+rate)^(1/252) − 1;
  - each holding counts only from its own first close, using the segment proxy × β_prior before that (^NSEI for EQ_IN/MF/NPS, ^GSPC×USDINR for US, GOLDBEES.NS for commodity; debt MF has no proxy);
  - weights renormalise each day;
  - Sharpe and Sortino use the corrected mean and RISK_FREE 6.5%;
  - new fields holdings[].volatility_used_pct and holdings[].data ('own'|'proxy'|'prior'), model {vol_pct, var_day} and measured_vs_model.
Tests (§7.9 test_forecast Risk rows, kept in a new file): a 40/60 stock/FD mix has |Sharpe − stock-only Sharpe| < 0.1; a 70-day holding with a true σ of 32% measures 26–38%; risk contributions sum to 100 ± 0.5; a proxy row is flagged.

### W1-B4: Insight link remap and route regression test

**Area:** backend

**Files:** `backend/tracker/analytics/insights.py`, `backend/tests/test_links.py`

Implements Part 1 §2 P0.6 (backend) and the backend link remap in §3.6.
- Remap every insight link: /insights#rebalance → /risk#rebalance, /analytics#risk → /risk#concentration, /analytics → /performance, /forecast?tab=sips → /recurring, /goals → /plan?tab=goals, /markets?tab=ipos → /markets?tab=watchlist.
- Give build_insights the optional kwargs cushion, risk_est, stress, snapshot_then, adherence and book (default None, ignored for now). Ids stay stable.
Test: build insights on a rich fixture and assert that every link starts with a route in the Part 1 §3.4 page list, using the allowed prefixes /, /actions, /plan, /holdings/, /holding/, /p2p, /fixed-deposits, /forex, /epf, /nps, /performance, /risk, /tax, /recurring, /cash-flows, /transactions, /import, /markets, /reports, /settings.

### W1-B5: actions.py: action model, rule catalogue, ranking, diversity, log overlay, auto-done, follow-through

**Area:** backend

**Files:** `backend/tracker/analytics/actions.py`, `backend/tests/test_actions.py`

NEW pure module, with no database or service imports. Implements Part 1 §1.4–§1.7 and Part 2 §8.1–§8.5 (not §8.6).
- build_actions(src: ActionSources, log, today) -> list[Action]. ActionSources is a TypedDict whose keys are all optional: insights, calendar, cashflow_events, tax (with opportunities), port, txns, sips, adherence (§7.6 shape), upcoming, plan, cushion, risk_est, stress, market_state, snapshot_then, deploy, settings.
  - Emit every §8.3 rule whose source key is present. Missing sources skip their rules, so the P1 rules light up automatically once later waves wire them.
  - Map insight ids to category, severity, confidence, impact and CTA per §8.3 and §1.7. impact is a real ₹ amount or null, never a multiplier.
  - Dedupe FD maturity insights against cash-flow events by (instrument_id, date).
  - Owner: instrument.owner if the action has an instrument, else the settings owner (§7.4).
- Overlay the log: snoozed rows with snooze_until ≥ today are hidden; snooze_until < today reopens on read; planned rows whose planned_for < today rank as now with 'days late'; done and dismissed rows are hidden. Event actions expire when their window has passed (§8.4).
- rank(actions, vitals): tiers per §1.7.1; score = max(amount, 1000) × U × C, where a monthly impact counts as ×12 for scoring only; sort by tier, then score descending, then id.
- diversify(actions, k=3): ≤1 per category, and ≤1 data action unless critical.
- auto_done(action, txns, port, tax, today) -> evidence | None, per §8.3 'Closes when' and P1.10 (SIP BUY ≥80%, FD redeploy ≥80% within 45 days, harvest when remaining_exemption < ₹1,000).
- follow_through(log, adherence, today) per §8.5.
- summary(actions) -> {now, month, consider, good, impact_total}, where impact_total counts lump impacts only.
Tests (§7.9 test_actions row, in full): one test per rule that checks it fires and keeps a stable id; a critical P2P default outranks a ₹200 tax saving; an FD due in 3 days outranks an undated info item; the ₹1,000 floor; diversity; FD dedupe; the CTA for each prefix; each auto-done rule; expiry; family status owner = instrument owner.

### W1-B6: brief.py: pure brief composer

**Area:** backend

**Files:** `backend/tracker/analytics/brief.py`, `backend/tests/test_brief.py`

NEW pure module. Implements Part 1 §2 P0.4 and P0.7, §4 (every field Home reads) and §1.4, and Part 2 §7.1 (brief row) and §7.8.
- Signature: build_brief(ctx, actions, upcoming, plan, risk_est, stress, perf, snapshot_then, market_state, nifty_quote, settings, today) -> dict. Every argument after actions may be None.
- Output keys: status {status, headline (first-match ladder in §4.1), count_now, count_month, impact_total}, hero {nifty_d1, since_last {date, change, change_pct, actions_new} | null}, vitals[5] in the order Data, Cushion, Risk, Mix, Money at risk, actions[≤5] (ranked and filtered by the §1.4 admission rules), on_track {plan, market, habit}, why {gainers, losers, segments}, allocation (segments with pct, target, drift and drift status), upcoming, tax {fy, estimate_total}, deploy {suggested} (§5.1 Deploy formula), freshness, assumptions_check, market_state, context_line (§4.1 priority), pending[], empty.
- Vital rules come from the §4.2 table. A None input gives an unset vital with a note, and that vital never raises the page status.
- perf None → pending = ['market'], with the market card status 'pending'.
- Empty ledger → empty = true, onboard:* actions and vitals = [] (§7.8).
Tests (§7.9 test_brief row): all good → 'All clear'; 2% defaulted → act with ₹ in the headline; 6% unpriced → data act and a headline that blames the data; no targets → mix unset; 2 months of cushion → act; perf None → pending == ['market']; the since delta; the empty ledger.

## Wave 2

Finish P0: serve /brief and /actions, navigation by question with data trust always visible, and the answer-ladder Home, Actions, standalone Performance and Markets pages. Also start the two pure P1 engines that need no UI (Assumption Book, MC helpers, SIP schedule), so later waves have no dependency within a wave.

### W2-B1: Shared backend wiring: services.actions/brief and the /brief and /actions endpoints

**Area:** backend

**Files:** `backend/tracker/services.py`, `backend/tracker/api/analytics_api.py`, `backend/tests/test_api.py`

SHARED TASK, RUN FIRST. Implements Part 2 §7.2 rows /brief, /actions, POST /actions/<id>/status and the /insights dismiss alias, plus §7.3 (actions, brief) and §7.4.
1. services.actions(scope, settings): build from context, calendar(90), cashflow(3), tax.opportunities and insights, memoised on ('actions', scope, settings, today, actions_rev). Call ledger.upsert_action_seen for first_seen. A source that fails is skipped and recorded in notes[].
2. services.brief(scope, settings, since): compose actions, plan status (goals only for now), risk_est (optimizer current vol), stress, _peek('performance', scope, 'ALL', None), snapshot_at(since), and quote:^NSEI. Memo key ('brief', scope, settings, today, since, actions_rev). Never build history. Afterwards, write the kpi snapshot (value, invested, total_gain, xirr, day_change, goal_probs, vitals, action_ids) inside try/except and outside the memo. Snapshot owner = scope or '__family__'.
3. Routes:
   - GET /brief?since (malformed or future date → 400);
   - GET /actions?status&category&instrument_id;
   - POST /actions/<path:id>/status with @write_required (body in §7.2; it bumps only actions_rev; guests get 403);
   - /insights/<id>/dismiss becomes an alias for snoozed.
   Status owner follows §7.4.
Tests (§7.9 test_api):
- the counting wrapper now includes /brief (still 1 call);
- two /brief calls on one day write one snapshot row and leave _version unchanged;
- a POST status does not rebuild a cached /tax;
- a guest POST returns 403;
- the cold /brief is < 800 ms and the warm one < 50 ms on the scratchpad DB copy.

### W2-F1: Shared frontend: navigation by question, routes and redirects, prices pill, nav list, portfolio tabs

**Area:** frontend

**Files:** `frontend/src/app/app.routes.ts`, `frontend/src/app/layout/shell.component.ts`, `frontend/src/app/shared/nav-list.component.ts`, `frontend/src/app/shared/portfolio-tabs.component.ts`, `frontend/src/app/core/models.ts`, `frontend/src/app/core/api.service.ts`, `frontend/src/styles.scss`

SHARED TASK, RUN FIRST. Implements Part 1 §2 P0.6 and P0.7 and §3.1–§3.3 (nav, popover, drawer and bottom bar).
1. app.routes.ts:
   - '' title Home;
   - 'actions' → ./features/actions/actions.component ActionsComponent (W2-F3 creates it);
   - 'performance' → ./features/performance/performance.component PerformanceComponent (W2-F4 moves it);
   - 'plan' → the existing ForecastComponent for now, title 'Plan';
   - redirects /insights → /actions, /analytics → /performance, /admin → /settings#people;
   - /markets?tab=performance → /performance (with a small resolver or guard);
   - writeGuard on /import;
   - keep /forecast, /goals, /holdings/:assetClass and the class pages as they are.
2. shell: the 5-slot top bar of §3.1, with icons, 'also active on' lists and badges (Actions = count_now + count_month from ActionService, red when now > 0). The Portfolio slot targets /holdings/equity until wave 4 switches it to /holdings/all.
   - More popover: Activity, Tax, Reports, Settings, with hints.
   - Prices pill at every width, shrinking to a dot coloured by the Data vital at ≤1180px; tap to refresh.
   - Bell sourced from ActionService (tier now).
   - The route title renders as h1.
   - ≤760px bottom bar: Home · Portfolio · FAB · Plan · Actions.
   - One NavListComponent drives the drawer, popover and bottom bar.
   - Tab rows with more than 4 items get fade-edge overflow.
3. portfolio-tabs.component.ts: Holdings | Performance | Risk & mix, plus class chips (§3.3), synced to ?tab= with replaceUrl.
4. Add any models and api fields the shell needs, such as brief freshness.
Acceptance: ng build passes; every §3.1 slot works at 1280, 1000, 760 and 390 px.

### W2-F2: Home page: answer ladder from /brief

**Area:** frontend

**Files:** `frontend/src/app/features/overview/overview.component.ts`, `frontend/src/app/features/overview/pulse.components.ts`, `frontend/src/app/features/overview/story.components.ts`

Rewrite Home to Part 1 §4, sections 0–8 and the Home states. It reads GET /brief?since=lastVisit:<scopeKey> (written on unload and after 30 s), snapshot-cached by snapshotKey('brief', scopeKey). It loads /performance?range=1Y lazily after paint and no longer calls /pulse, /markets or /rebalance.
- Hero: the §4.1 table and copy.
- Vitals: VitalChip ×5.
- Do this now: ≤3 ActionCards via the brief order; only card 1 is .btn.primary; footer and empty state.
- Am I on track: 3 VerdictCards with ProbBar.
- Why it moved: line chart + .seg and diverging bars.
- Where your money is: donut + drift rows.
- Coming up: render brief.upcoming when present, else hide.
- T3 link tiles.
Remove the asset-class table, Markets today, Money calendar, Where to put your next money, and Habits; drop the dead code in §3.5 (overview .alerts, .pulse-grid, .mem and .side CSS; StatComponent and ToranComponent if they are unused elsewhere). P1 fields (cushion, habit adherence, upcoming, context line) render when present and fall back to unset or hidden.
Acceptance: the 1280×800 above-the-fold budget in §9.4; the phone layout in §3.2; T0/T1 paint from the snapshot and only T2 shows skeletons.

### W2-F3: Actions page (replaces Insights) and the shared rebalance planner

**Area:** frontend

**Files:** `frontend/src/app/features/actions/actions.component.ts`, `frontend/src/app/shared/rebalance-planner.component.ts`, `frontend/src/app/features/insights/insights.component.ts`, `frontend/src/app/features/insights/insight-card.component.ts`

Create features/actions/actions.component.ts exporting ActionsComponent, following Part 1 §5.1 (P0/P1 rows; the Review tab waits for P2). Move what is reusable from insights; delete insights.component.ts and insight-card.component.ts once nothing imports them.
- T0 kpis: What needs you, ₹ at stake, Tax you can still save, Follow-through (shown when follow_through is present), Last review + 'Mark review done'.
- Sticky filter chips (?filter=); ?id= scrolls to and highlights a card.
- Sections: Now (expanded cards), This month (compact), Planned table, Deploy money (#deploy), Tax moves this FY (3 cards from /tax opportunities; 'Plan the sale' goes through ActionRunner whatif), Worth considering / Good news (details.more), Done, Snoozed & hidden, and Ask the analyst (the existing AI calls).
- shared/rebalance-planner.component.ts: inputs newMoney (default brief.deploy.suggested) and allowSell. It calls GET /rebalance; FD/P2P rows read 'Redirect maturities'. The Risk page reuses it later.
Data comes from ActionService. Status changes go through ActionCard → ActionService.setStatus.

### W2-F4: Portfolio › Performance as its own page

**Area:** frontend

**Files:** `frontend/src/app/features/performance/performance.component.ts`, `frontend/src/app/features/analytics/analytics.component.ts`

Move features/analytics/analytics.component.ts to features/performance/performance.component.ts (export PerformanceComponent), then delete the old file. Follow Part 1 §5.4:
- portfolio-tabs at the top;
- a toolbar with a segment select and a range .seg, synced to ?range&segment;
- T0 'Your return (XIRR)' with the vs-Nifty verdict (Home market rule) and the gain, TWR and worst-fall tiles;
- T1 'You vs the same money in an index' plus the Compared-with table;
- T2 Growth of ₹100, the monthly heat table with ▲/▼ glyphs, and Attribution (#attribution) from story.attribution if the payload carries it;
- T3 methodology.
Remove the Concentration & risk block (it moves to /risk#concentration in wave 5). The Assumptions check and Income card come in wave 4.

### W2-F5: Markets page: three tabs, performance tab removed

**Area:** frontend

**Files:** `frontend/src/app/features/markets/markets.component.ts`, `frontend/src/app/features/markets/market-parts.ts`, `frontend/src/app/features/markets/ipos.component.ts`

Follow Part 1 §5.12 (P0 layout):
- tabs Today | Ideas | Watchlist & IPOs; ?tab=ipos maps to watchlist;
- remove the PerformanceComponent import and its tab, and add a head chip '→ Your performance' linking /performance;
- T0 kpis on every tab: Nifty 50 price with d1/w1/m1, breadth, your stocks today, alerts today;
- T1 NeedsAttention with prefix 'market:';
- Today order: 'Your stocks and ETFs' table first, then Top movers + Recent alerts side by side (.duo), then Sector heat;
- Ideas: the disclaimer comes first.
The crash banner waits for wave 6.

### W2-B2: Assumption Book and Monte Carlo helpers (pure P1 engines)

**Area:** backend

**Files:** `backend/tracker/analytics/assumptions.py`, `backend/tracker/analytics/mc.py`, `backend/tracker/analytics/optimizer.py`, `backend/tracker/analytics/story.py`, `backend/tracker/analytics/history.py`, `backend/tests/test_assumptions.py`, `backend/tests/test_mc.py`

Implements Part 1 §2 P1.2, Part 2 §6.1 (every function, constant and the 9×9 CORR), §6.4 (mc.required_sip_for) and the §7.1 mc row. The optimizer, story and history rows of the §6.1 'Who calls the Book' table move here too.
- assumptions.py is pure: ASSUMPTIONS, CORR, RISK_FREE 0.065, INFLATION 0.06, P2P_LOSS, STATUS_THRESHOLDS, HONESTY, book_key (with the debt-MF regex), effective_book (no overrides until P2), book_hash, weights_from_positions, mu_sigma, typical, typical_band, status_for and chip.
- mc.py: annual_shocks, required_sip_for (400 sims, 14-step bisection, CRN, returns {sip_75, sip_typical}) and pctl.
- optimizer._stats uses CORR and mu_sigma (adding the MF_DEBT row). story.milestones uses typical(). history.RISK_FREE and optimizer.RISK_FREE import from assumptions.
Tests (§7.9 test_assumptions row, in full): mu_sigma identities; typical < μ; CORR Cholesky succeeds; book_hash is stable; status_for boundaries; the debt-MF regex. test_mc: required_sip_for is monotone in the target and repeats for the same seed, and the 75% SIP is ≥ the typical SIP.

### W2-B3: plans.py: SIP schedule, adherence, next due

**Area:** backend

**Files:** `backend/tracker/analytics/plans.py`, `backend/tests/test_plans.py`

NEW pure module. Implements Part 1 §2 P1.6 (engine) and Part 2 §7.6 in full: due_dates(plan, start, end) for monthly, quarterly, weekly and yearly plans (respecting start_date, end_date and active); sip_adherence(sips, txns, instruments, today, months=6), with the matching window, one-BUY-consumed-once, the done/partial/missed/upcoming/skipped statuses, amount-weighted adherence_6m_pct and the EPF import exclusion; and next_due(sips, today, horizon=90). The output shape follows §7.6.
Tests (§7.9 test_plans row): weekly, quarterly and yearly due dates; one BUY cannot satisfy two plans; partial; a missed quarterly plan; the skipped status; the EPF exclusion.

## Wave 3

P1 engines: upcoming money, market state, tax what-if and harvest plan, goals on the Book with 75% required SIP and funding stack, forecast and risk adopting the Book, new insight rules; plus the Portfolio Holdings hub, which needs only existing data.

### W3-B1: calendar.upcoming: 90-day events with inflow and outflow

**Area:** backend

**Files:** `backend/tracker/analytics/calendar.py`, `backend/tests/test_calendar.py`

Implements Part 1 §2 P1.5 and the Part 2 §7.1 calendar row: upcoming(calendar, cashflow, sip_next_due, ipos, today) -> {inflow_90d, outflow_90d, theme, next_festival, events[≤30]}. Each event is {date, days, kind, title, amount, direction, link, key}. Drop 'national' days. Dedupe FD maturities by (instrument_id, date), keeping the cash-flow event. sip_next_due has the plans.next_due shape (wave 2). Kinds are tax, fy, festival, personal, sip, fd_maturity, p2p_close and ipo.
Tests: dedupe, the totals, the 90-day cutoff and the national filter.

### W3-B2: markets.market_state: crash and correction context

**Area:** backend

**Files:** `backend/tracker/markets.py`, `backend/tests/test_markets.py`

Implements Part 1 §2 P1.12 and the Part 2 §7.1 markets row: market_state(nifty_points, perf_metrics, stress, today) -> {mode, nifty{price, d1, w1, from_high_pct}, you{from_peak_pct, from_peak_inr}, comparable|null, playbook[], since}.
- Thresholds: crash at from_high ≤ −20 or w1 ≤ −8; correction at ≤ −10; volatile at |d1| ≥ 2.5; otherwise normal.
- comparable = the mildest stress scenario with impact_pct ≤ your drawdown, else 'correction'.
- The playbook strings are fixed (§4.1 context line). No price calls.
Tests (§7.9 test_markets row): thresholds on synthetic closes. The quote:^NSEI storage test was already covered by W1-B1; add it here if it is missing.

### W3-B3: tax.py: what_if_sale and harvest_plan

**Area:** backend

**Files:** `backend/tracker/analytics/tax.py`, `backend/tests/test_tax_whatif.py`

Implements Part 1 §2 P1.7 and Part 2 §6.9 (P1 parts):
- what_if_sale: the compute_tax difference method, FIFO lots with same-day intraday matching, USD fx, the wait hint within 90 days, the output fields and note, and every 400 error in §6.9 (raised as ValueError subclasses that the API maps to 400).
- harvest_plan(port, instruments, remaining_exemption, today): qualifying long-term equity lots, sorted by gain/value, taking whole lots then one partial up to remaining − ₹1,000; output rows, total_gain, future_tax_saved and the rebuy note. Add it to opportunities as harvest_plan.
Tests (§7.9 test_api /tax/what-if items, at engine level): long-term within the exemption → 0; short-term ₹50k → ₹10,400; wait saving > 0; ELSS locked → error; qty > held → error; a USD stock uses fx; the harvest plan stops below the exemption.

### W3-B4: goals.py on the Book: mu_sigma, required SIP at 75%, funding_summary

**Area:** backend

**Files:** `backend/tracker/analytics/goals.py`, `backend/tests/test_goals.py`

Implements Part 1 §2 P1.1 (engine) and Part 2 §6.4 and the §6.13 goals row (P1).
- project_goal takes μ and σ from assumptions.mu_sigma(goal allocation weights); expected_return still overrides μ. required_sip = mc.required_sip_for(prob=0.75), and required_sip_typical is added. Status comes from assumptions.status_for. Seed = goal.id. Each goal projection carries the assumptions block (§6.0 rule 2).
- goals.ASSUMPTIONS becomes a re-export.
- NEW funding_summary(goals, segments, positions, emergency) -> {total, cushion{amount, instrument_ids}, earmarked[{goal_id, name, amount}], free, over_allocated[{segment, claimed_pct, goals[]}]}. Cushion holdings come out of segment values before earmarks.
Tests: following required_sip gives a probability of 75 ± 3; funding has no double counting; over-allocation is detected.

### W3-B5: forecast.py P1: Book μ/σ, due dates, 75% retirement SIP, debt-MF stress

**Area:** backend

**Files:** `backend/tracker/analytics/forecast.py`, `backend/tests/test_forecast.py`

Implements the P1 column of Part 2 §6.13 for forecast:
- blended_assumptions uses mu_sigma, keeping the 730-day blend and the clamps, and adds typical_pct and hash;
- INFLATION comes from assumptions;
- every forward payload (projection, retirement, cashflow, stress) carries the §6.0 rule-2 block {assumptions{return_pct, typical_pct, volatility_pct, inflation_pct, basis, hash}, honesty, note};
- retirement required_sip uses mc.required_sip_for(prob=0.75), plus required_sip_typical;
- cash_flow_forecast takes SIP instalments from plans.due_dates (§6.6 rule 6);
- stress_test gives MF_DEBT holdings the rates shock (−4%).
Tests: retirement with SIP = required_sip has probability 75 ± 3; a quarterly SIP lands on its months; a debt MF takes the rates shock; the payloads carry assumptions.hash.

### W3-B6: quant.py P1: Book prior and drift

**Area:** backend

**Files:** `backend/tracker/analytics/quant.py`, `backend/tests/test_risk.py`

Implements the quant rows of Part 2 §6.13 (P1) and §6.2.
- holding_stats uses σ_book from assumptions via book_key and drops the local mapping from W1-B3.
- holding_outlook: cone drift = the Book μ for the holding's segment, σ = sigma_used, and the cone label comes from HONESTY.signal; no cone below 30 closes (§7.8).
- portfolio_risk: the model block uses mu_sigma, and RISK_FREE is imported from assumptions.
Tests: the cone uses the Book μ (with no momentum extrapolation); the model vol equals mu_sigma σ.

### W3-B7: insights.py P1 rules

**Area:** backend

**Files:** `backend/tracker/analytics/insights.py`, `backend/tests/test_links.py`

Implements the 'insight'-sourced rows of the Part 2 §8.3 catalogue that are new or changed in P1:
- nps:nav-stale:<iid>;
- the concentration thresholds (15, MF 25; closes below 12);
- drift warn ≥5 and info ≥2.5;
- sector share > 30;
- tax:ltcg-harvest:<fy> severity warn in Jan–Mar;
- elss:unlocked;
- period-keyed review:due:<YYYY-Qn>.
Use the optional kwargs added in W1-B4 (cushion, risk_est, stress, snapshot_then, adherence, book) where a rule needs them. Ids stay stable.
Extend the link regression test to cover the new rules.

### W3-F1: Portfolio › Holdings hub (all and per class)

**Area:** frontend

**Files:** `frontend/src/app/features/holdings/holdings.component.ts`

Implements Part 1 §2 P1.3 and §5.3.
- Support assetClass 'all', which shows the asset-class summary moved from Home (columns as in §5.3, drill to the top 8, tfoot; rows become cards on mobile), the breakdown donut, and By class | By member in family view.
- Per class: the T0 kpis in §5.3, NeedsAttention (prefixes /holdings/<class> and /holding/), and the holdings table with a column chooser saved in localStorage, aria-sort, and rows linking /holding/:id. The aside (Breakdown + Today's movers) sits behind a disclosure on mobile.
- Use portfolio-tabs. Zero-value classes are greyed under '+ more', each with an empty state 'Add your first …'.
Data comes only from existing store fields.

## Wave 4

P1 integration: serve /plan, /assumptions, /tax/what-if, SIP adherence, upcoming, market state, the cushion and the full brief; build the shared P1 frontend (assumption chip and drawer, what-if modal, goal markers, new routes, all redirects); and the class and cash-flow pages.

### W4-B1: Shared backend wiring for P1: services and P1 endpoints

**Area:** backend

**Files:** `backend/tracker/services.py`, `backend/tracker/api/analytics_api.py`, `backend/tracker/api/forecast_api.py`, `backend/tracker/api/markets_api.py`, `backend/tests/test_api.py`

SHARED TASK, RUN FIRST. Implements the P1 rows of Part 2 §7.1–§7.4 and §7.7, and Part 1 §2 P1.1, P1.2, P1.5, P1.6, P1.8, P1.9, P1.10 and P1.12.
services.py:
- context gains adherence (plans.sip_adherence);
- NEW plan(scope, settings) → §5.2 Data / P1.1 shape {status, goals, retirement|null (only when retirementPlan is saved), funding (goals.funding_summary), sip, counts, deltas vs the 30-day snapshot};
- NEW upcoming() via calendar.upcoming;
- NEW assumptions_view() for the GET /assumptions shape (§6.1);
- NEW what_if();
- actions and brief now pass every P1 source (adherence, upcoming, plan, cushion, risk_est = mu_sigma σ vs PROFILES target, stress, market_state, deploy, snapshot_then). Auto-done evidence is persisted with upsert_action_seen and done_via='auto', with no bump;
- the snapshot data gains goal_probs, retirement_probability, projection_1y {p10, p50, p90} from project_portfolio(years=1, sip=0) and book_hash (§6.11, §7.5);
- the emergencyFund auto-suggest (§7.7);
- book_hash goes into the brief, plan, assumptions and forecast memo keys (§6.0 rule 3).
Routes:
- analytics_api: GET /tax/what-if (400 mapping); /tax includes opportunities.harvest_plan; SETTING_KEYS += emergencyFund with the §7.7 validation (instrument_ids must be in the caller's scope).
- forecast_api: GET /plan, GET /assumptions, and GET /sips adds adherence and arriving[].
- markets_api: GET /markets adds market_state.
Tests:
- emergencyFund with another owner's id → 400;
- the /tax/what-if API cases;
- /plan and /assumptions shapes, with the hash stable across calls;
- a POST status does not rebuild a cached /plan;
- /brief is still < 800 ms cold and makes 1 compute_portfolio call.

### W4-F1: Shared frontend P1: types, assumption chip and drawer, what-if modal, goal markers, new routes and redirects

**Area:** frontend

**Files:** `frontend/src/app/core/models.ts`, `frontend/src/app/core/api.service.ts`, `frontend/src/styles.scss`, `frontend/src/app/app.routes.ts`, `frontend/src/app/layout/shell.component.ts`, `frontend/src/app/core/action-runner.service.ts`, `frontend/src/app/shared/priority/assumption-chip.component.ts`, `frontend/src/app/shared/priority/assumptions-drawer.component.ts`, `frontend/src/app/shared/what-if-sale.component.ts`, `frontend/src/app/shared/charts/line-chart.component.ts`, `frontend/src/app/features/plan/plan.component.ts`, `frontend/src/app/features/risk/risk-mix.component.ts`, `frontend/src/app/features/recurring/recurring.component.ts`, `frontend/src/app/features/forecast/forecast.component.ts`

SHARED TASK, RUN FIRST. Implements the frontend side of Part 1 §2 P1.2 and P1.7, §3.1 badges, §3.5 and §3.6, and Part 2 §9.3 rows AssumptionChip/Drawer, what-if-sale and LineChartComponent.
1. models and api: Plan, Funding, AssumptionsView, WhatIfSale, HarvestPlan, SipAdherence, Upcoming, MarketState and EmergencyFund, with methods plan(), assumptions(), whatIf(params), and sips() including adherence.
2. AssumptionChip reads the payload's assumptions block, shows the text and has the hash in its title; clicking it opens the Drawer, which fetches GET /assumptions (§6.1 shape plus HONESTY copy).
3. what-if-sale modal: qty, price and date → /tax/what-if, showing the lots table, tax with an est tag, the wait hint, and 'Record this sale' → TxnDialog SELL. ActionRunner's whatif type now opens it.
4. line-chart: a 'goal' marker kind (7px diamond, label, tooltip '{name} · needs ₹X') and an xLabel formatter input.
5. Routes:
   - /plan → features/plan/plan.component (PlanComponent);
   - /risk → features/risk/risk-mix.component (RiskMixComponent);
   - /recurring → features/recurring/recurring.component (RecurringComponent).
   Create each as a working interim wrapper that hosts the existing components: Plan hosts ProjectionComponent, GoalsComponent and RetirementComponent (the planner in features/forecast); Risk hosts AllocationLab, Stress and Risk; Recurring hosts SipPlansComponent. Wave 5 rewrites them.
   Add every §3.6 redirect through a ForecastRedirect resolver for /forecast?tab=, plus /goals and /holdings → /holdings/all. Delete forecast.component.ts. The Portfolio slot targets /holdings/all.
6. shell: a Plan red dot when plan status is act; an amber Markets dot when market_state.mode is correction or crash; a More 'Activity' entry active on /transactions, /cash-flows, /recurring and /import; a Tax 'N days left' badge in Jan–Mar when tax actions exist; and the 'Due now' row (≤3 instalments) in the Add sheet from sips.adherence.next_due.
Acceptance: ng build passes; every old URL in §3.6 lands on its new page.

### W4-F2: Activity › Cash flows: past and future on one axis

**Area:** frontend

**Files:** `frontend/src/app/features/cash-flows/cash-flows.component.ts`, `frontend/src/app/features/forecast/cashflow.component.ts`

Implements Part 1 §5.10. Fold features/forecast/cashflow.component.ts into the page, then delete the old file.
- ?view=past|future|both.
- T0 kpis: Net contributed, Deposited, Withdrawn, Escrow on the escrow .seg; the future view shows Income due, Principal back and SIPs out (est.).
- T1: one chart of the past 24 months (from /cash) plus the next 12 (from /forecast/cashflow?months=12 net, muted and labelled 'estimate', with an inflow/outflow tooltip) and a today divider; ?view=future scrolls to the future half.
- T2: 'Dates to know' events linking their actions, and 'What this means' notes.
- T3: the ledger table and add modal (existing).
- An AssumptionChip on the forward part.

### W4-F3: P2P class page

**Area:** frontend

**Files:** `frontend/src/app/features/p2p/p2p.component.ts`

Implements the P2P row of Part 1 §5.7:
- h1 'P2P lending', with portfolio-tabs and class chips;
- T0 hero Outstanding with the verdict 'At risk ₹… · n overdue';
- tiles: Interest after fees, Realised XIRR vs average stated rate, and Principal back (+ '30 days, not reinvested');
- NeedsAttention with prefixes /p2p;
- T2 stack bar and lending-type cards; T3 the loans table, cohorts and LenDen import (?import=lenden).
Only the layout changes; existing logic is kept.

### W4-F4: Fixed deposits class page

**Area:** frontend

**Files:** `frontend/src/app/features/fixed-deposits/fixed-deposits.component.ts`

Implements the FD row of Part 1 §5.7:
- T0 hero 'Next maturity' (name · days · maturity_value), watch at ≤30 days;
- tiles: Active deposits, Interest accrued, Value today;
- NeedsAttention with prefixes fd: and /fixed-deposits. 'Mark matured' opens the FD modal, which ActionRunner fd_mature reuses, so expose it through the existing TxnDialog or a public method;
- the FD table gains a 'Redeploy ₹X' badge for FDs maturing within 30 days.
The maturity ladder is P2 and out of scope.

### W4-F5: USD wallet class page

**Area:** frontend

**Files:** `frontend/src/app/features/forex/forex.component.ts`

Implements the USD wallet row of Part 1 §5.7:
- T0 hero 'Uninvested balance' $balance_usd (₹ value), watch above $50;
- tiles: Avg rate vs today, Currency gain on US stocks (fx_gain), Gain on withdrawals;
- NeedsAttention for cash:usd with the CTA 'Deploy' → /actions#deploy;
- the totals kv and transfers table stay.

### W4-F6: EPF and NPS class pages

**Area:** frontend

**Files:** `frontend/src/app/features/retirement/retirement.component.ts`

Implements the EPF and NPS rows of Part 1 §5.7. This is the EPF/NPS component, not the retirement planner.
- EPF: hero 'EPF balance'; tiles Contributed, Interest (interest_credited · accrued_interest) and XIRR; the account table and passbook import.
- NPS: hero 'NPS value' with watch when any price_at is older than 30 days ('NAVs 45 days old — update'); tiles Contributed, Gain and XIRR; NeedsAttention for nps:nav-stale with inline NAV edit; CAS import.
- The h1 is the class name; portfolio-tabs and chips.

### W4-F7: Performance P1: assumptions check and income card

**Area:** frontend

**Files:** `frontend/src/app/features/performance/performance.component.ts`

Adds the Part 1 §5.4 T2 Assumptions check (#assumptions). It compares realised twr_annualised with the Book's typical band for the same span (the GET /assumptions typical_bands, or brief.assumptions_check), with the verdict within, above, below or too_short. When the shortfall is ≥3 pts over 2+ years, it links /plan?return=<realised>. Also add the AssumptionChip and the Income card (24-month stacked bars from the existing GET /income: dividends, p2p_interest, fd_interest; last_12m, monthly_avg, top_payers).

## Wave 5

P1 pages: Plan hub, Risk & mix, Recurring with this month's money, Tax with what-if and harvest, the full Home, Holding detail, Settings with the cushion, and Actions follow-through. All of them read the endpoints from wave 4.

### W5-F1: Plan hub: Overview, Goals and Retirement

**Area:** frontend

**Files:** `frontend/src/app/features/plan/plan.component.ts`, `frontend/src/app/features/plan/plan-overview.component.ts`, `frontend/src/app/features/plan/projection.component.ts`, `frontend/src/app/features/plan/goals.component.ts`, `frontend/src/app/features/plan/retirement-planner.component.ts`, `frontend/src/app/features/forecast/projection.component.ts`, `frontend/src/app/features/forecast/retirement.component.ts`, `frontend/src/app/features/goals/goals.component.ts`

Implements Part 1 §2 P1.1 and §5.2 (P1 rows), and §10.1 (the one-time required-SIP note).
- Move projection, retirement (renamed RetirementPlannerComponent) and goals into features/plan and delete the old files. Replace their STATUS maps with priority.ts.
- Tabs Overview | Goals | Retirement (?tab=, replaceUrl).
- T0 on every tab: Plan status plus the Typical, Investing each month and Free money tiles, with the AssumptionChip in the head.
- Overview: Goals at a glance (sorted worst-first, ProbBar with ▲/▼ deltas, Fix CTA); the fan with p10–p90 and p25–p75 bands, a 'Typical (median)' line, the mean removed, goal markers and an age xLabel; the Funding stack with the over-allocation notice; the always-visible Assumptions card; the T3 Adjust panel with 'Average path (pulled up by the best cases)'.
- Goals tab: the funding strip, cards sorted worst-first, the empty-state presets (?preset=), and a modal that shows 'already earmarked %' and blocks a save above 100% unless confirmed.
- Retirement tab: the hero order in §5.2, an age x-axis, the runs-out notice, the FIRE card, and the grouped aside form. 'Needs' is the 75% figure; required_sip_typical sits in T3.
- Copy follows §1.9.

### W5-F2: Portfolio › Risk & mix page

**Area:** frontend

**Files:** `frontend/src/app/features/risk/risk-mix.component.ts`, `frontend/src/app/features/risk/allocation-lab.component.ts`, `frontend/src/app/features/risk/stress.component.ts`, `frontend/src/app/features/risk/risk.component.ts`, `frontend/src/app/features/forecast/allocation-lab.component.ts`, `frontend/src/app/features/forecast/stress.component.ts`, `frontend/src/app/features/forecast/risk.component.ts`

Implements Part 1 §2 P1.4 and §5.6 (P1 rows). Move the three forecast components into features/risk and delete the old files.
- Anchors #profile #mix #rebalance #stress #risk #concentration, in the order profile → target → rebalance → stress → evidence.
- T0 from brief.vitals.risk, with the Off target, routine correction and VaR tiles.
- NeedsAttention prefixes: risk:, stress:, drift:, concentration:, targets:.
- Profile buttons → PUT riskProfile.
- Target mix: drift bars plus the editable table moved from Settings (Use current / Use suggested; the sum must be 100 ± 0.5) and 'Preview impact' via mu_sigma (GET /optimizer current vs proposed).
- Get back on target: the shared RebalancePlanner, defaulting to no-sell with brief.deploy.suggested. Its trim rows show 'Tax if sold' via the what-if API, and FD/P2P rows read 'Redirect maturities'.
- Stress: cards worst-first.
- 'Where the risk comes from': Volatility (measured | used), Data own/proxy, and Risk share in red when it exceeds 1.3× weight.
- T3 Concentration (moved from Performance) and correlation/frontier (collapsed).

### W5-F3: Activity › Recurring plans with this month's money

**Area:** frontend

**Files:** `frontend/src/app/features/recurring/recurring.component.ts`, `frontend/src/app/features/recurring/sip-plans.component.ts`, `frontend/src/app/features/forecast/sip-plans.component.ts`

Implements Part 1 §2 P1.6 and §5.9 (P1 rows). Move sip-plans into features/recurring and delete the old file.
- T0: '₹X/month across n plans' with the adherence verdict, plus This month and Next due tiles.
- T1 This month's money:
  - instalments for every frequency with Recorded/Due/Missed/Upcoming/Skipped badges, 'Record' (TxnDialog prefilled {instrumentId, type BUY, amount, date, actionId}; the user confirms units) and 'Skip this month' (status dismissed, reason skipped);
  - Arriving (sips.arriving);
  - Extra to invest → a no-sell split via GET /rebalance?new_money&allow_sell=0.
- T2 plans table with a 6-dot adherence strip (icon and colour).
- Activity tabs header: Transactions | Cash flows | Recurring plans | Import.

### W5-F4: Tax page: ways to save, what-if, harvest plan

**Area:** frontend

**Files:** `frontend/src/app/features/tax/tax.component.ts`

Implements Part 1 §2 P1.7 and §5.8.
- ?fy&tab=save|whatif|gains|estimate&whatif=<iid>.
- Head: the FY-days-left chip.
- T0: estimated tax with the 'You can still save ₹X' verdict, plus the exemption-left, capital gains and next-deadline tiles (from brief.upcoming tax events).
- Ways to save (default for the current FY; hidden for past FYs): the Harvest plan table with the total and rebuy note, Offset gains, and Wait before selling. Every row has 'Plan the sale' → the what-if modal.
- What if I sell tab: an inline form with the result, wait hint and note.
- T2 the exemption meter and tax_lines meters; T3 realised gains and the estimate.
- Every forward ₹ carries an est tag.

### W5-F5: Home P1: cushion, coming up, habit, context line, assumptions check

**Area:** frontend

**Files:** `frontend/src/app/features/overview/overview.component.ts`, `frontend/src/app/features/overview/pulse.components.ts`

Completes Part 1 §4 with the P1 data now served:
- the Cushion vital (unset text with the auto-suggest amount);
- the Habit card (adherence_6m_pct, pace, next milestone);
- the Plan card with probability deltas and the AssumptionChip;
- the §4.1 context-line priority: crash/correction from market_state, then the FY window, then review overdue;
- the 'Since {date}' stat with 'N new';
- the Coming up · 90 days card (§4.7), with FD rows suggesting the segment furthest under target;
- the 'Assumptions check' sub-line under 'You vs the market';
- the 'Acted on X of Y' footer from follow_through.
Check the §9.4 above-the-fold budgets again.

### W5-F6: Holding detail: verdict, strip, signals row, lots, plan a sale

**Area:** frontend

**Files:** `frontend/src/app/features/holdings/holding-detail.component.ts`, `frontend/src/app/features/holdings/outlook-card.component.ts`

Implements Part 1 §5.5 (P1 rows):
- head badges, class actions, and Delete moved into a ⋯ menu;
- the T0 verdict rules (concentration watch, valued-at-cost act);
- XIRR only when held ≥365 days;
- NeedsAttention for /holding/{id};
- 'Plan a sale' → the what-if modal with the full quantity;
- OutlookCard collapsed to one signals row with 'Show all statistics' (the cone labelled 'range if it behaves like the past, not a forecast');
- T3 Open lots (FIFO) with LT/ST badges, a 'turns long-term on' column and a per-lot 'Plan a sale' (lots from position open_lots and /tax opportunities.open_lots).
The benchmark overlay is P2 and out of scope.

### W5-F7: Settings: anchor rail, Profile & cushion, read-only target summary

**Area:** frontend

**Files:** `frontend/src/app/features/settings/settings.component.ts`

Implements Part 1 §2 P1.9 and §5.14 (P1 rows).
- Anchor rail: #profile #alerts #prices #people. It is sticky on desktop and a .seg strip on mobile.
- #profile: taxSlabRate, plus the Emergency cushion editor (monthly expenses prefilled from retirementPlan; months 3–24, default 6; a checklist of eligible holdings pre-ticked by the auto-suggest with live coverage months; save → PUT /settings/emergencyFund), plus read-only summaries linking /risk#mix and /plan?tab=retirement, and autoCapitalFlows.
- Remove the target allocation editor, which moves to Risk.
- #prices: the Missing filter is the default when missing_prices is non-empty.
- The family view shows 'Editing the family plan'.

### W5-F8: Actions P1: follow-through, auto-done evidence, harvest tax moves

**Area:** frontend

**Files:** `frontend/src/app/features/actions/actions.component.ts`

Completes Part 1 §5.1 with P1 data:
- the Follow-through hero tile (acted_90d, impact_realised_fy est.);
- the Done table showing 'Auto: BUY #812 on 12 Nov' vs 'Marked done', with Undo (status open);
- the assumptions line on estimate and model cards;
- Tax moves using harvest_plan totals and what-if CTAs;
- Deploy defaulting to brief.deploy.suggested, with arriving money listed.
The filter chips map to the categories in §3.3.

## Wave 6

P2 engines: goal↔SIP schema and paging in the ledger, the per-segment correlated simulator behind projection, retirement drawdown and stress-to-plan, tax-aware rebalancing, one signal vocabulary, and the P3 calibration and festival data. Plus the Markets crash banner (P1 leftover) with signal chips.

### W6-B1: Shared backend P2 schema: migration 006 goal_id, ledger paging and atomic bulk import

**Area:** backend

**Files:** `backend/tracker/migrations.py`, `backend/tracker/ledger.py`, `backend/tests/test_migration.py`

SHARED TASK, RUN FIRST. Implements Part 2 §7.5 (006) and the ledger side of Part 1 §2 P2.7 and P2.11.
- m006_sip_goal: ALTER TABLE sip_plans ADD COLUMN goal_id, guarded by db.columns().
- SIP_FIELDS += goal_id, validated to the same owner. Deleting a goal sets goal_id to NULL.
- ledger.transactions_page(scope, page, size, q, sort) -> {rows, total, page, size, sums}.
- bulk_add commits atomically, so a CSV or CAS import is all-or-nothing.
- action_log gets helpers for pushed_at and seen_at.
Tests: 006 is idempotent; goal delete nulls the link; paging totals; bulk_add rolls back on error.

### W6-B2: simulate.py and its forecast.py adopters

**Area:** backend

**Files:** `backend/tracker/analytics/simulate.py`, `backend/tracker/analytics/forecast.py`, `backend/tests/test_simulate.py`, `backend/tests/test_forecast.py`

Implements Part 1 §2 P2.1 and P2.3 (engine) and Part 2 §6.3 (P2 simulate in full: state, ladders, steps, CRN and antithetic draws, flows, glide, after_tax, shock, outputs, goals from the same draws, the speed budget and the guest cap), §6.5 P2 additions and §6.8 P2.
- forecast.project_portfolio becomes a thin wrapper over simulate.run with the same payload shape.
- retirement_plan adds probability_lasts, depletion_age_p10 and path_bands, with status = status_for(min(probability, probability_lasts)), and the corpus sources (EPF locked, NPS 60/40, goal-free money).
- stress_test: β-scaled holding shocks, recovery_months_markets and recovery_months_with_sips, and plan_impact via simulate.run(shock=, sims=500), using CRN.
Tests (§7.9 test_simulate row, in full, including the ≤2.5 s speed test), plus retirement probability_lasts ≤ probability for a zero-growth fixture.

### W6-B3: goals.py P2: linked SIPs and tax-aware rebalance_plan

**Area:** backend

**Files:** `backend/tracker/analytics/goals.py`, `backend/tests/test_goals.py`

Implements Part 1 §2 P2.7 and P2.8 (goals side) and the P2 goals row of Part 2 §6.13.
- A goal with linked sip_plans (goal_id) uses their monthly total as monthly_contribution and exposes linked_sips[] (for 'Funded by 2 SIPs · ₹15,000/mo').
- rebalance_plan orders sell rows as losses first, then long-term gains within the exemption, then everything else, each costed with tax.what_if_sale; FD and P2P are maturity-only.
Tests: linked totals; the sell order; no FD trims.

### W6-B4: optimizer.py P2: maturity-only FD and P2P, KEEP_SHARE, tax per trim

**Area:** backend

**Files:** `backend/tracker/analytics/optimizer.py`, `backend/tests/test_optimizer.py`

Implements the optimizer row of Part 2 §6.13 (P2): FD and P2P are 'let mature' only (never trimmed); KEEP_SHARE goes from 0.5 to 0.25; MF is split by category (debt vs equity via assumptions.book_key); each trim row carries tax_if_sold from tax.what_if_sale.
Tests: no FD/P2P sell rows; debt MF treated as MF_DEBT; tax_if_sold is present.

### W6-B5: One signal vocabulary: Wilder RSI and a shared signal model

**Area:** backend

**Files:** `backend/tracker/analytics/quant.py`, `backend/tracker/markets.py`, `backend/tests/test_markets.py`

Implements Part 1 §2 P2.12. Define one signal model in markets.signals_for and have quant.holding_outlook call it, so a holding can no longer read both 'Uptrend' and 'Falling steadily'. RSI uses Wilder smoothing. Labels stay 'price pattern, not a forecast' (HONESTY.signal). This touches two modules because the vocabulary must be single-sourced.
Tests: Wilder RSI matches a reference series; holding_outlook and the Markets signals agree on a fixture.

### W6-B6: Calibration evaluator (P3) and festivals data file

**Area:** backend

**Files:** `backend/tracker/analytics/calibration.py`, `backend/tracker/analytics/calendar.py`, `backend/tracker/data/festivals.json`, `backend/tests/test_calibration.py`, `backend/tests/test_calendar.py`

Implements Part 2 §6.11 (P3 evaluation) and the Part 1 §2 P3 festival row.
- NEW pure calibration.coverage(snapshots, perf_points, today) -> {matured, inside, coverage_pct, target 80, show (matured ≥ 6), rows[]}. It takes one snapshot per calendar month and uses the nearest index points.
- Move the festival dates in calendar.py into data/festivals.json and load them from there.
Tests: the coverage maths; show is hidden below 6; an expiry test that fails when festivals.json has no dates more than 180 days ahead.

### W6-F1: Markets: crash/correction banner and the shared signal chips

**Area:** frontend

**Files:** `frontend/src/app/features/markets/markets.component.ts`, `frontend/src/app/features/markets/market-parts.ts`

Implements Part 1 §2 P1.12 (Markets banner) and §5.12. When market_state.mode is correction or crash, show a banner above T0 with the same calm playbook and comparable scenario as Home. There are no price calls. Signal chips use the single vocabulary from W6-B5, labelled 'price pattern, not a forecast'. Signals never rank above signal confidence.

## Wave 7

P2 integration and pages: scenarios and sensitivities, stress-to-plan, notifications and daily digest, quarterly review, per-member settings, goal↔SIP link UI, ledger paging, dark mode and a11y, editable assumptions, and the calibration display. The remaining P3 items (net worth classes, per-holding role card, advance tax/80C, reports upgrades, AI on the brief, Arrange T2) stay in the backlog.

### W7-B1: Shared backend P2 wiring: compare, sensitivities, notifications, digest, per-member settings, assumptions overrides, paging route

**Area:** backend

**Files:** `backend/tracker/services.py`, `backend/tracker/api/analytics_api.py`, `backend/tracker/api/forecast_api.py`, `backend/tracker/api/ledger_api.py`, `backend/tracker/api/markets_api.py`, `backend/tracker/analytics/assumptions.py`, `backend/tracker/push.py`, `backend/tests/test_api.py`

SHARED TASK, RUN FIRST. Implements Part 1 §2 P2.2, P2.4, P2.6, P2.10 and P2.11, and Part 2 §6.10, §7.2 (P2 rows), §7.7 (P2 keys) and §8.6.
- POST /plan/compare (≤4 scenarios; guests ≤2 × 500 sims; CRN, so compare(baseline, baseline) gives zero deltas). GET /plan?detail=1 returns the 4 sensitivities.
- /assumptions adds calibration (calibration.coverage).
- /forecast/stress passes plan_impact through.
- notifications() is built from tier-now actions plus events ≤7 days plus market notices; GET /notifications adds seen and unread; POST /notifications/seen.
- POST /jobs/daily-digest (X-Job-Token, public path) pushes ≤3 now actions with pushed_at null, then stamps pushed_at, so a second run the same day sends nothing.
- Per-member settings: owner = g.scope for a member, falling back to __global__.
- SETTING_KEYS += assumptions, seenNotices and planScenarios, validated per §7.7. assumptions.effective_book applies overrides, so book_hash changes and invalidates exactly the forecasts that depend on it.
- GET /transactions?page&size&q&sort returns the paged shape only when page is given.
Tests: compare zero deltas; digest idempotency; the assumptions validation 400s; the per-member fallback; the paging shape; a guest sims cap.

### W7-F1: Shared frontend P2: types, dark mode and a11y tokens, notification bell

**Area:** frontend

**Files:** `frontend/src/app/core/models.ts`, `frontend/src/app/core/api.service.ts`, `frontend/src/styles.scss`, `frontend/src/app/layout/shell.component.ts`, `frontend/src/app/shared/ui.ts`

SHARED TASK, RUN FIRST. Implements Part 1 §2 P2.4 (bell) and P2.9, and Part 2 §9.1 (dark mode).
- Types and api: compare, sensitivities, notifications seen/unread, paged transactions, the planScenarios and assumptions settings, and the P2 fields on retirement and stress.
- Dark mode: tokens under @media (prefers-color-scheme: dark) with :root:not([data-theme="light"]), and again under [data-theme="dark"]; theme stored in localStorage (try/catch).
- a11y: aria-sort helpers and a focus trap in the modal (ui.ts).
- Shell bell: unread count, and seen on open.
- Shell banner 'Editing {member}'s plan' for an admin viewing a member.

### W7-F2: Plan P2: what moves the needle, scenarios, money lasts, calibration

**Area:** frontend

**Files:** `frontend/src/app/features/plan/plan.component.ts`, `frontend/src/app/features/plan/plan-overview.component.ts`, `frontend/src/app/features/plan/retirement-planner.component.ts`, `frontend/src/app/features/plan/goals.component.ts`, `frontend/src/app/features/plan/scenarios.component.ts`

Implements Part 1 §5.2 P2 rows.
- Overview: 4 'What moves the needle' tiles from /plan?detail=1, each with 'Try it' → a new scenario.
- Scenarios tab: ≤5 planScenarios, overlaid medians on the baseline band, and a compare table via POST /plan/compare.
- Retirement hero: 'Money lasts to {life_expectancy}: {probability_lasts}% · 1-in-10 runs out at {depletion_age_p10}', with path_bands.
- Goal cards: 'Funded by n SIPs · ₹X/mo'.
- T3 'How our ranges held up', shown only when calibration.show is true.

### W7-F3: Risk & mix P2: stress-to-plan and tax-ordered trims

**Area:** frontend

**Files:** `frontend/src/app/features/risk/risk-mix.component.ts`, `frontend/src/app/features/risk/stress.component.ts`

Implements Part 1 §5.6 P2 items.
- Stress cards show 'markets alone' vs 'with your SIPs' recovery, a drill-down by beta per holding, and 'After this shock: retirement 78% → 64%' from plan_impact.
- Get back on target lists trims lowest-tax first, with tax_if_sold.
- Target mix 'Preview impact' adds goal and retirement Δ via /plan/compare.

### W7-F4: Actions P2: quarterly review wizard and check-up

**Area:** frontend

**Files:** `frontend/src/app/features/actions/actions.component.ts`, `frontend/src/app/features/actions/review.component.ts`

Implements Part 1 §2 P2.5 and the §5.1 Review row (?tab=review). Six wizard steps:
1. What changed since lastReviewDate: GET /brief?since=<lastReviewDate> since_last, plus /plan deltas.
2. Mix: no-sell vs with-sell, with tax per trim.
3. Concentration, laggards (≤−20% after 180 days) and winners.
4. Plan: required vs funded SIP.
5. Commitments saved as SIP edits or planned actions (POST status planned).
6. Complete (POST /review/complete).
The check-up card shows Pulse.health components and focus from the existing /pulse.

### W7-F5: Recurring P2: goal link and planned-vs-actual

**Area:** frontend

**Files:** `frontend/src/app/features/recurring/recurring.component.ts`, `frontend/src/app/features/recurring/sip-plans.component.ts`

Implements Part 1 §2 P2.7 and §5.9 P2 items: a 'Funds goal' select in the SIP modal (goal_id), a 'Funds goal' column in the plans table, and 12-month planned-vs-actual bars from the adherence months.

### W7-F6: Settings P2: assumptions, appearance, digest toggle, per-member

**Area:** frontend

**Files:** `frontend/src/app/features/settings/settings.component.ts`

Implements Part 1 §5.14 P2 anchors.
- #assumptions: per-segment return/vol overrides and inflation, validated client-side to the §7.7 ranges, with Reset; shows book_hash.
- #appearance: System / Light / Dark.
- #alerts: a 'Daily action digest' toggle.
- Saves go to the member's own settings when an admin is viewing a member (P2.6).

### W7-F7: Activity › Transactions paging and Import drop zone

**Area:** frontend

**Files:** `frontend/src/app/features/transactions/transactions.component.ts`, `frontend/src/app/features/import/import.component.ts`, `frontend/src/app/features/import/epf-import.component.ts`, `frontend/src/app/features/import/tradebook-import.component.ts`, `frontend/src/app/shared/drop-zone.component.ts`

Implements Part 1 §2 P2.11 and §5.11.
- Transactions: server paging via ?page&size&q&sort, with month-grouped subtotals, the 'Net put to work' hero and the filters.
- Import: source tiles CAS · Kite · EPF · LenDen (→ /p2p?import=lenden), with one shared DropZoneComponent used by every import flow.
