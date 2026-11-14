# Amendments to SPEC.md and WAVES.md

Base: commit 459d511 on `feature/next-gen`. This file resolves every item in CRITIQUE.md and records the problems found while preparing wave 1. **Where this file disagrees with SPEC.md, WAVES.md or waves.json, this file wins.** Builders read it before their task text.

How to read the references:
- **M*n*** is item *n* under "Missing" in CRITIQUE.md.
- **C*n*** is item *n* under "Contradictions".
- **N*n*** is item *n* under "Not buildable as written".
- **NEW** marks a problem the critique did not list but the code review found.

Decisions A1–A33 affect waves 1 and 2 (P0) and are final. Decisions D1–D24 cover waves 3–7. They are fixed now so later waves do not reopen them, but they are applied when those waves are prepared.

---

## Part A: Decisions for waves 1 and 2

### Build process and ownership

**A1. Engine signature changes are wired by the next wave's services owner.** Resolves M1, M2.
- Any engine change that needs new inputs from `services.py` adds **keyword-only parameters with defaults that reproduce today's behaviour**. The existing call sites keep working unchanged.
- The `services.py` owner of the **next** wave wires the new inputs:

| Engine change | Wave | Wired by |
|---|---|---|
| `forecast.project_portfolio(..., *, inflation=None)` (real_p50 uses `retirementPlan.inflation_pct`) | 1 (W1-B2) | W2-B1 |
| `quant.portfolio_risk(..., *, proxies=None)` (^GSPC and GOLDBEES.NS histories) | 1 (W1-B3) | W2-B1 |
| `build_insights(..., cushion=, risk_est=, stress=, snapshot_then=, adherence=, book=)` | 1 (W1-B4) | W2-B1 (whatever exists by then), then W4-B1 |
| `goals.project_goal(goal, segments, *, positions=None)` (MF_DEBT split, FD/EPF instrument rates) | 3 (W3-B4) | W4-B1 |
| `assumptions.book_key(position)` callers in quant/holding_outlook | 3 (W3-B6) | W4-B1 |
| `markets.market_state(nifty_points, ...)` | 3 (W3-B2) | W4-B1 (see D6) |
| `goals.rebalance_plan(..., *, txns=None, instruments=None)` and `optimizer.suggest(port, profile, *, txns=None, instruments=None)` for `tax.what_if_sale` | 6 (W6-B3, W6-B4) | W7-B1 |

- W1-B1 does **not** wire any wave-1 engine change. It keeps the existing `forecast`, `risk` and `build_insights` call sites exactly as they are, so W1-B2, W1-B3 and W1-B4 can land in any order.
- W2-B1 adds `inflation` to the `forecast` memo key when it wires it.

**A2. No task depends on a sibling in the same wave.** Resolves C21 and the within-wave dependencies found in waves 2, 4 and 7. Every wave runs fully in parallel. A task may use only files from earlier waves and its own files. To make that true, these moves apply:

| Problem | Move |
|---|---|
| W2-F1 lazy-imports `ActionsComponent` and `PerformanceComponent`, which W2-F3 and W2-F4 create | W1-F1 creates both files as small placeholder components (same paths and class names). W2-F3 and W2-F4 replace their contents. |
| W2-F4 needs `portfolio-tabs.component.ts`, which W2-F1 creates | W1-F1 creates `shared/portfolio-tabs.component.ts`. It is removed from W2-F1's file list. |
| W2-F4 deletes `features/analytics/analytics.component.ts` while `markets.component.ts` still imports it until W2-F5 runs | W2-F4 **copies** the analytics component into `features/performance/` and deletes nothing. W2-F5 removes the import from Markets. W3-F1 deletes `features/analytics/*` (added to its file list). |
| W2-F3 deletes `features/insights/*` while `app.routes.ts` still lazy-loads it until W2-F1 runs | W2-F3 deletes nothing. W3-F1 deletes `features/insights/*` (added to its file list). |
| W4-F2 and W4-F7 use `AssumptionChipComponent`, which W4-F1 creates. W4-F2 also deletes `forecast/cashflow.component.ts` while W4-F1's `forecast.component.ts` still imports it | W4-F2 and W4-F7 move to wave 5 as **W5-F9** (cash flows) and **W5-F10** (Performance P1). No wave-5 task owns their files. |
| W7-F2 to W7-F7 need the P2 types that W7-F1 adds to `models.ts` and `api.service.ts` | The types and api methods move to a new wave-6 task **W6-F2** (files: `models.ts`, `api.service.ts`). W7-F1 keeps a11y, bell and banner only. |
| W1-B1's `test_api.py` needs the `offline_prices` fixture, which lives in `test_forecast.py` (owned by W1-B2) | W1-B1 adds `offline_prices` to `tests/conftest.py`. The local copy in `test_forecast.py` shadows it harmlessly. |
| `test_portfolio_risk_var_beta_and_correlations` lives in `test_forecast.py` (W1-B2) but tests the engine W1-B3 rewrites | W1-B2 deletes that test from `test_forecast.py`. W1-B3 recreates it, with v2 expectations, in `test_risk.py`. |

Where WAVES.md says "SHARED TASK, RUN FIRST", read it as "the shared task of its wave". It does not mean ordering within the wave.

**A3. A task that owns a component also owns its template and stylesheet.** NEW. Several components keep their template in a sibling `.html` (and some a `.scss`), which WAVES.md does not list. The rule: owning `x.component.ts` includes `x.component.html` and `x.component.scss` in the same folder. This affects `layout/shell.component.{html,scss}` (W1-F1, W2-F1, W4-F1, W7-F1), `overview.component.{html,scss}` (W2-F2, W5-F5), `analytics.component.html` (W2-F4 reads it; W3-F1 deletes it), `insights.component.html` (W3-F1 deletes it), `holdings.component.html` (W3-F1), `p2p.component.html` (W4-F3), `goals.component.html` (W5-F1), `holding-detail.component.html` (W5-F6), `tax.component.html` (W5-F4), `settings.component.html` (W5-F7, W7-F6) and `transactions.component.html` (W7-F7). For wave 1, `shell.component.html` is listed in W1-F1's extra files because the dialog host lives there.

**A4. Template type-checking replaces the missing frontend test runner.** Resolves M14, N5. NEW finding: `tsconfig.app.json` compiles only files reachable from `main.ts`, so `ng build` never type-checks a new component until a route uses it.
- W1-F1 adds `frontend/tsconfig.check.json`. It extends `./tsconfig.app.json`, sets `"noEmit": true`, keeps `files: ["src/main.ts"]` and adds `include: ["src/**/*.d.ts", "src/app/**/*.ts"]` and `exclude: ["src/**/*.spec.ts"]`. W1-F1 also adds the script `"check": "ngc -p tsconfig.check.json"` to `frontend/package.json`. This was tried on the current tree and passes in about 10 s.
- From wave 1 on, every frontend task's acceptance is `cd frontend && npx ng build && npm run check`, plus the manual width checks where WAVES.md lists them.
- The promise of specs for `priority.ts`, `ActionRunnerService` and `ActionService` is **dropped** (SPEC §10.1 "No frontend tests" row). Logic that matters lives in backend engines with pytest. The TypeScript logic in `priority.ts` stays as table lookups that mirror the tested Python rules.
- There is no CI. "The speed test blocks merge" becomes "the speed test fails the local pytest run" (W6-B2).

**A5. Performance budgets are measured, not asserted.** Resolves N2.
- The budgets stay as targets: `/brief` warm < 50 ms, cold < 800 ms; `/actions` and `/plan` warm < 50 ms.
- Pytest asserts **counts**, not times: the `compute_portfolio` counting wrapper, and "a warm `/brief` makes 0 `compute_portfolio` calls".
- W2-B1 and W4-B1 each run a measurement script against a fresh copy of the scratchpad database copy. The script calls the Python modules directly (no Flask server, no tokens). The builder writes it in the scratchpad and reports the cold and warm numbers in the task report. A miss is reported with a cost breakdown, not hidden.
- The W2-B1 and W4-B1 test lines "the cold /brief is < 800 ms and the warm one < 50 ms" are replaced by this.

### Shared contracts for the parallel wave-1 engines

**A6. Contracts between `actions.py`, `brief.py`, `ledger.py` and the frontend.** NEW. W1-B1, W1-B5, W1-B6 and W1-F1 run in parallel, so these shapes are fixed here. Neither `actions.py` nor `brief.py` imports the other. Both may import `story`, `optimizer.PROFILES`, `goals` and `domain` read-only.

*Ledger (W1-B1):*
- `Ledger.action_log(owners: list[str]) -> dict[tuple[str, str], dict]`, keyed by `(owner, id)`; the row has every column.
- `set_action_status(owner, id, status, **fields)` is an **upsert**: it creates the row when it does not exist. Allowed fields: `snooze_until`, `planned_for`, `note`, `reason`, `evidence` (dict, stored as JSON), `done_at`, `done_via`. Setting `status='open'` clears `done_at`, `done_via`, `evidence`, `snooze_until` and `planned_for`. It calls `bump_actions()` and returns the row.
- `bump_actions()` increments the in-memory `actions_rev` and **does not clear `_cache`**. Memo entries keyed on `actions_rev` go stale by key; every other memo stays valid.
- `upsert_action_seen(owner, rows)`: each row has `id` plus any of `first_seen`, `tier_first`, `category`, `title`, `impact`, `impact_kind`, `due`, `status`, `done_via`, `evidence`, `done_at`. It uses `INSERT … ON CONFLICT(owner, id) DO UPDATE SET <status/done fields> WHERE action_log.status IN ('open','planned')`. `first_seen` and `tier_first` are never overwritten. No bump.
- `kpi_snapshot_write(owner, date, data)` uses `INSERT OR IGNORE`. `kpi_snapshot_at(owner, on_or_before) -> {date, data} | None`. No bump.

*`ActionSources` (W1-B5).* Every key is optional:
- `owner`: the settings owner (email, or `'__global__'`);
- `port`, `txns`, `sips`, `settings`;
- `insights` (the `build_insights` list);
- `calendar` (the `build_calendar` output);
- `cashflow_events` (`cash_flow_forecast(...)["events"]`);
- `tax` (the current-FY `compute_tax` output);
- `adherence` (None until W4-B1);
- `upcoming`, `plan`, `stress`, `market_state`, `snapshot_then`;
- `cushion`, `deploy`, `risk_est`, with the shapes below.

`Cushion = {set: bool, months: float|None, target_months: int, monthly_expenses: float|None, amount: float, cash_amount: float, instrument_ids: [int], candidates: [{instrument_id, name, kind, value}], candidates_amount: float}`

`Deploy = {suggested: float, sources: [{kind: 'usd'|'fd'|'p2p_principal'|'escrow', label, segment|None, instrument_id|None, date|None, amount, held_value}]}`, where:
- `amount` is the new money the source releases;
- `held_value` is the part of that money already counted inside `segment`. It is 0 for escrow and for P2P principal that has not been lent yet.

`RiskEst = {vol_pct: float|None, target_vol_pct: float|None, profile: str|None, closest_profile: str|None}`

*Helpers.*
- `brief.py` exports the pure helpers `cushion_state(port, settings, today) -> Cushion` and `deploy_state(port, cashflow_events, today) -> Deploy`. Services (W2-B1) calls them once and passes the results to both `build_actions` and `build_brief`.
- `actions.py` exports `ACTION_PREFIXES` (the id grammar for POST validation), `HARVEST_FLOOR`, `action_id_for_insight(insight, today, sips) -> str`, `for_home(actions, total_value, data_status, k=5) -> list[Action]` (§1.4 admission, then `diversify`) and `summary(actions)`.

*`build_brief` argument change.*
- `actions` is now `{"top": list[Action] (≤5, from actions.for_home), "summary": {now, month, consider, good, impact_total}} | None`. `None` means no actions and a zero summary.
- `build_brief` gains the keyword-only arguments `cushion=None` and `deploy=None`. When they are None, it computes them with its own helpers, and `deploy_state` leaves out P2P principal because there are no cash-flow events.

*Brief payload (W1-B6 produces it; W1-F1 types it):*
```
Brief = {
  status: {status, headline, count_now, count_month, impact_total},
  hero: {nifty_d1: number|null, since_last: {date, change, change_pct, actions_new} | null},
  vitals: Vital[],                 // [] when empty; order data, cushion, risk, mix, money_at_risk
  actions: Action[],               // ≤5
  on_track: {plan: PlanTrack, market: MarketTrack, habit: HabitTrack},
  why: story.attribution(port) + nothing else  // {total, unrealized, realized, income, gross_gains, gross_losses,
                                               //  gainers[≤5], losers[≤5], segments[], winners, losers_count}
  allocation: [{segment, value, pct, target|null, drift|null, drift_status}],
  upcoming: Upcoming|null,  tax: {fy, estimate_total},  deploy: Deploy,
  freshness: {last_refresh, age_minutes, missing_prices, missing_weight_pct, stale},
  pending: string[],  empty: boolean,  context_line: {kind, text, link}|null,
  assumptions_check: null,  market_state: null      // filled in P1
}
Vital       = {key: 'data'|'cushion'|'risk'|'mix'|'money_at_risk', status, label, value, note|null, link}
MarketTrack = {status: Status|'pending', excess: number|null, diff_value: number|null, since: string|null, days: number|null}
PlanTrack   = {status, on_track: int, total: int, rows: [{kind:'goal'|'retirement', id|null, name, probability, status, target_amount|null, target_date|null, delta|null}]}
HabitTrack  = {status, invested_month, planned_month, adherence_6m_pct: number|null, pace: number|null}
```

**A7. `link` is the evidence page and `cta` is the action.** NEW. Each Action has both fields:
- `link` is where the evidence lives. It is the remapped insight link, or the page that owns the rule (for example `fd:maturing:<iid>` → `/fixed-deposits`). NeedsAttention filters by `link` prefix, so it must stay the evidence page.
- `cta` is what to do. For an insight-sourced action, the CTA is a `route` to the insight link unless §8.3 names a non-route CTA (`api`, `dialog`, `whatif`, `fd_mature`, or a deploy CTA as in A13).
- Every `cta.route` and `link` must start with an allowed route prefix (W1-B4's list). W1-B5's tests check this with their own copy of the list.

### Action identity, persistence and owners

**A8. Insight ids are frozen; period keys exist only in action ids.** Resolves C2.
- `insights.py` never changes an existing id, in any wave. The ids stay `tax:ltcg-harvest`, `tax:loss-harvest`, `review:due`, `sip:missed:<sid>`, and so on. W1-B4 adds a test that pins them, and W3-B7 must keep it passing.
- `actions.py` derives the action id with `action_id_for_insight`:
  - `tax:ltcg-harvest` → `tax:ltcg-harvest:<FY>`;
  - `tax:loss-harvest` → `tax:loss-harvest:<FY>`;
  - `review:due` → `review:due:<YYYY-Qn>`;
  - `sip:missed:<sid>` → `sip:missed:<sid>:<due ISO date>` (A9);
  - every other insight id is unchanged.
- **Legacy alias on read:** when no `(owner, action_id)` row exists, the overlay also checks `(owner, legacy_id)`, where `legacy_id` is the period-free form. It honours that row only while `status = 'snoozed'` and `snooze_until ≥ today`, so migrated snoozes keep working and expire naturally.
- The `/insights/<id>/dismiss` alias (W2-B1) converts the insight id with `action_id_for_insight` before writing.

**A9. One `sip:missed` action per instalment.** Resolves C3.
- The single id format is `sip:missed:<sid>:<due>`, where `due` is the instalment's due date.
- When `src.adherence` is present (W4-B1 onward), the plans rule is the only source, and the `sip:missed:<sid>` insight is ignored.
- When adherence is absent (waves 1–3), `actions.py` maps the insight. It computes `due` from that plan's `day_of_month` in the current month, clamped to the month's last day, using `src.sips`.
- Dedupe is by action id. The plans source wins.

**A10. Migrated snoozes land on the right owner.** Resolves C4.
- The m005 data step copies each `dismissedInsights` entry verbatim (id, `snooze_until` = until, status `snoozed`, `first_seen` = today).
- The owner is the setting's owner, except for an entry stored under `'__global__'` whose id ends in an instrument id. Those prefixes are `concentration:`, `loser:`, `winner:`, `fd:maturing:`, `elss:unlocked:`, `sip:gap:` and `tax:wait-lt:<iid>:`. Such a row is written under that instrument's `owner` (`SELECT owner FROM instruments WHERE id = ?`). If the instrument is gone, the row is skipped.
- A user-owned entry already matches, because a user's instruments are owned by that email.
- Use `INSERT OR IGNORE` throughout, so the step is idempotent.
- Action owner (W1-B5):
  - `instrument.owner` when the action has an `instrument_id`;
  - for SIP actions, the plan's instrument owner, or `sip.owner` for a segment plan;
  - otherwise `src.owner`.
- W2-B1 reads the log with `owners = [settings owner] + every distinct instrument owner in scope` and looks rows up by `(action.owner, id)`.

**A11. Skipping an instalment.** Resolves C6.
- "Skip this month" posts `{status: 'dismissed', reason: 'skipped'}` to the id that exists for that instalment: `sip:due:<sid>:<due>` while it is upcoming, or `sip:missed:<sid>:<due>` once missed. `set_action_status` upserts (A6), so posting to an id that has never been seen creates it.
- `actions.py` treats a dismissed row of either id for the same `(sid, due)` as covering both.
- W2-B3: `plans.sip_adherence(sips, txns, instruments, today, months=6, *, skipped=None)`. `skipped` is a set of `(sid, due_iso)`. W4-B1 builds it from action-log rows that are dismissed with reason `skipped`.
- W2-B1's POST route rejects (400) an id whose prefix is not in `actions.ACTION_PREFIXES`, or that is longer than 200 characters.

**A12. Harvest uses one floor for firing and closing.** Resolves C5.
- `actions.HARVEST_FLOOR = 2000`.
- `tax:ltcg-harvest:<FY>` fires only when `remaining_exemption ≥ HARVEST_FLOOR` and `suggested_booking > 1000`.
- It auto-closes as done when `remaining_exemption < HARVEST_FLOOR`.
- `harvest_plan` (W3-B3) still stops at `remaining − ₹1,000`. A user who follows it is left with about ₹1,000, which is below the floor, so the action closes, and it does not flap.

**A13. The deploy CTA uses a query parameter and a fragment.** Resolves C7.
- The CTA is `{type: 'route', route: '/actions', query: {new_money: <amount>}, fragment: 'deploy'}`. As a string it is `/actions?new_money=<amount>#deploy`. Never put the query after `#`.
- ActionRunner navigates with `router.navigate([route], {queryParams: query, fragment})`. A `link` string is navigated with `router.navigateByUrl(link)`, which parses `?` before `#` correctly.
- W2-F3 reads `new_money` from `queryParamMap` and scrolls to `#deploy`.
- `cash:usd`, `cash:p2p-principal:*`, `deploy:idle` and `fd:maturing:*` all use this form. A bare `/actions#deploy` is allowed when there is no amount.

**A14. The cushion anchor is `#cushion`.** Resolves C8.
- The Cushion vital and `cushion:low` link to `/settings#cushion`.
- W5-F7 gives the Emergency cushion editor, which sits inside the `#profile` section, `id="cushion"`.
- Until then, the link opens Settings at the top. That is harmless, because the vital is `unset` until P1.

**A15. Deploy money is netted against the segments that hold it.** Resolves C9.
- `brief.deploy.suggested` = Σ `sources[].amount`.
- The planner must not add that money on top of segments that already contain it. W2-B1 adds `net=deploy` to `GET /rebalance`. When it is set, services subtracts each source's `held_value` from its `segment` value (in a copy of `segments`) before calling `goals.rebalance_plan`. No engine changes.
- The FD source's `amount` is `maturity_value` and its `held_value` is the FD's current `value`. The interest still to come is genuinely new money.
- `RebalancePlannerComponent` (W2-F3) sends `net=deploy` whenever its new money is the default `brief.deploy.suggested`. When the user types an amount, it sends no `net`.

### Data, routes and pages

**A16. vs-Nifty uses the ALL range everywhere.** Resolves C1, C11.
- The market card compares since-start XIRR, and `diff_value` = `totals.value` − the benchmark `end_value` (as `story.market_compare` does). Both are only meaningful on the `ALL` range.
- `/brief` peeks `('performance', scope, 'ALL', None)`. `brief.py` reads the NIFTY50 row through `story.market_compare(port, perf)`.
- Home's lazy fetch becomes **`GET /performance?range=ALL`** (not `1Y`). That is the same memo key `/brief` peeks. Home slices the last 365 days client-side for the sparkline and for the chart's default `1Y` view, and fetches other ranges only when the user picks them.
- While `on_track.market.status == 'pending'`, Home fills the card from its own lazy ALL payload with the same rule. `priority.ts` exports `statusFromExcess(excess, days)`: under 180 days → unset; ≥ 0 → good; > −3 → watch; otherwise act. It mirrors `brief.py`.
- A pending market card is an allowed T1 placeholder ("Comparing with Nifty 50…"), not a skeleton. This is the one exception to §9.4.
- W2-B1 puts `perf_ready = _peek(...) is not None` into the `/brief` memo key, so a brief built before `/performance` was warm is not served after it warms.

**A17. Remaining backend link remaps.** Resolves M3.
- `services.py` `_market_notices`: the IPO link becomes `/markets?tab=watchlist` (W1-B1). The W1-B1 test adds an IPO 2 days out and asserts the notification link.
- `story.py`: `/analytics` → `/performance`, `/goals` → `/plan?tab=goals` (W1-B4, extra file).
- `calendar.py`: `/insights#rebalance` → `/risk#rebalance`, `/goals` → `/plan?tab=goals` (W1-B4, extra file). Only link strings change, never signatures.
- `test_links.py` scans `build_insights`, `build_calendar` and `build_story` (all pure). `'/'` is allowed only as an exact match.
- `targets:missing` keeps `/settings` until W3-B7 (D11), because the target editor is still on Settings.

**A18. Interim routes so remapped links work before their pages exist.** NEW, follows from A17. W2-F1 adds redirect functions, which W4-F1 replaces:

| Interim route | Goes to |
|---|---|
| `/risk` | `#stress` → `/forecast?tab=stress`; `#risk` → `/forecast?tab=risk`; `#concentration` → `/performance#concentration`; anything else → `/forecast?tab=allocation` |
| `/recurring` | `/forecast?tab=sips` |
| `/plan` | `?tab=goals` → `/goals`; `?tab=retirement` → `/forecast?tab=retirement`; otherwise the Plan route (ForecastComponent) as in WAVES.md |

- W2-F4 therefore **keeps** the "Concentration & risk" block on Performance, as T3 collapsed with `id="concentration"`. W5-F10 removes it once W5-F2 has it on `/risk`.
- Waves 1 and 2 ship together. Wave 1 alone emits links to routes that exist only from wave 2.

**A19. A global "Mark matured" dialog.** Resolves M5.
- W1-F1 adds `shared/fd-mature-dialog.component.ts`.
- `TxnDialogService` gains `fdMature = signal<{instrumentId: number; actionId?: string} | null>`, `openFdMature(instrumentId, actionId?)` and `closeFdMature()`.
- The shell's dialog host renders the dialog. It reads the position from `StoreService` and posts the existing `api.matureFd(id, {date, amount})`.
- On success with an `actionId`, it posts `done` with `evidence: {txn_ids}` when the response has them; otherwise it posts `done` with no evidence.
- ActionRunner's `fd_mature` type calls `openFdMature`. No MATURITY kind is added to TxnDialog.
- W4-F4 replaces the page's local modal with `openFdMature`.

**A20. Guests are capped on `GET /forecast`.** Resolves M4. W1-B2 owns `forecast_api.py`:
- `sims` defaults to 1000, with a range of 200–2000 for users (400 outside it);
- guests are silently clamped to `min(sims, 500)`;
- `return` is rounded to 0.5 points and `sip` to the nearest ₹100 before the services call, so the memo key space is bounded.

The payload's existing `sims` field shows the value actually used.

**A21. The tier grammar gains a "work surface".** Resolves C10. T1 now has two kinds:
1. **T1 cards**: verdict, vital and action cards, with the stripe grammar of §1.3.
2. **T1 work surface**: at most **one** per page. It is a plain `.card` with an h2, no stripe and no status badge. It holds the page's main tool (a chart, table or form) and is painted from the page's primary call, with no skeleton longer than T0.

The work surfaces are:
- Performance: "You vs the same money in an index" chart plus the Compared-with table;
- Risk & mix: Profile → Target mix → Get back on target, as one surface with three anchors;
- Tax: "Ways to save" (or the "What if I sell" form on that tab);
- Recurring: "This month's money".

Everything else that §5 calls T1 and is not a card is T2. Page tasks follow this.

**A22. Pages own their single h1; the shell renders none.** Resolves C15.
- The shell sets `document.title` from the route's `data.title` (a `TitleStrategy` or an effect in the shell) and does not render an h1.
- Each page renders exactly one h1: the nav label, or the class name on class pages. Home's h1 is the visually hidden "Home", with the greeting as the eyebrow.
- Remove "The shell renders the route title as h1" from P0.6 and W2-F1.

**A23. `vitals` is an array.** Resolves C16.
- The keys are `data`, `cushion`, `risk`, `mix` and `money_at_risk` (A6).
- `priority.ts` exports `vitalOf(vitals, key)`. Read every SPEC reference like `brief.vitals.risk` as `vitalOf(brief.vitals, 'risk')`. `VITAL_ORDER` uses these keys.

**A24. The Risk vital and `risk:above-profile` share their thresholds.** Resolves C14. Let est. vol be `v` and the profile target be `t`:

| Condition | Vital | Action |
|---|---|---|
| v ≤ t + 2 | good | none, and an open action closes (done when the user changed the mix or profile; otherwise expired) |
| t + 2 < v ≤ t + 5 | watch | `risk:above-profile` fires with severity `warn` |
| v > t + 5 | act | `risk:above-profile` fires with severity `crit` |

- A concentration of ≥ 15% (MF ≥ 25%) lifts the vital to at least watch.
- No `riskProfile` → unset, with "Looks like {closest_profile}".

**A25. The cushion can count money held outside the tracker.** Resolves M15.
- `emergencyFund` gains `cash_amount` (0–1e8): savings or bank money the user declares.
- Cushion months = (Σ value of `instrument_ids` + `cash_amount`) / `monthly_expenses`. The cash counts toward the cushion only, never toward portfolio value.
- W1-B6 implements the formula now. Because the setting key does not exist until W4-B1, the vital is unset in P0. W4-B1 validates the key, and W5-F7 adds the field.

**A26. Performance attribution comes from `brief.why`.** Resolves M7.
- `brief.why` is `story.attribution(port)`, which brief.py calls directly. Performance's Attribution section (W2-F4) reads it from `api.brief()`, snapshot-cached under `snapshotKey('brief', scopeKey)`, which is the same cache Home uses.
- When a segment is selected, it filters `gainers` and `losers` by `segment`.
- It is labelled "since you started".

**A27. Needs-attention strips are assigned.** Resolves M6:
- W2-F4: Performance, prefixes `['/performance']`;
- W2-F5: Markets (already planned);
- W5-F1: Plan, prefixes `['/plan']`;
- W5-F3: Recurring, `['/recurring']`;
- W5-F4: Tax, `['/tax']`;
- W5-F9: Cash flows, `['/cash-flows', '/fixed-deposits']`, limited to `fd:` and `cash:` ids.

Prefix matching is on `link` (A7).

**A28. FD matured-unrecorded detection.** NEW. After maturity, `days_to_maturity` and `maturity_value` are None (portfolio.py lines 332–333). So "matured, unrecorded" means `is_open and maturity_date < today`, and its amount is `fd_accrued` at maturity, or `value` when that is missing. W1-B5 (`fd:matured-unrecorded:<iid>`) and W1-B6 (the Money at risk vital) both use this test.

**A29. Engine-level test restatements for wave 1.** NEW.
- W1-B3's "a 70-day holding with a true σ of 32% measures 26–38%" is about `sigma_own`. `sigma_used` shrinks toward the prior.
- W1-B2 does not add "probability 75 ± 3 with SIP = required_sip"; that belongs to wave 3 (D3).
- Existing tests that read insight ids (`test_missed_sip_insight`, the `sip:missed:<id>` assertion in `test_forecast_endpoints_round_trip`) stay unchanged, per A8.

**A30. `services.portfolio` is memoised.** NEW. Today every `Services.portfolio()` call recomputes `compute_portfolio`, so the "1 call" test cannot pass through `context` alone.
- W1-B1 memoises `portfolio(scope, settings)` on `('portfolio', scope, targetAllocation)`, and `context` reads it.
- `GET /portfolio` returns `{k: v for k, v in port.items() if k != 'realized_lots'}`.
- The counting wrapper patches `tracker.services.compute_portfolio`.

**A31. ^NSEI quote handling.** NEW.
- W1-B1 adds `'^NSEI'` to the same `fetch_quotes` call and pops it from `quotes` before `store_quotes`, as it already does for USDINR.
- It stores `json.dumps({price, prev_close, date})` under `quote:^NSEI` only when the quote is not None.
- `hero.nifty_d1` = (price / prev_close − 1) × 100, or null.

**A32. Correlation matrix check.** Resolves N3.
- Before W2-B2 writes the "Cholesky succeeds" test, it runs the pure-Python Cholesky on the 9×9 `CORR` with the specified MF_DEBT row. Every pivot must be > 1e-9.
- If it fails, repair by shrinking every off-diagonal by the smallest λ in steps of 0.05 (ρᵢⱼ ← (1 − λ)ρᵢⱼ) until it succeeds. Record λ in a comment and in `GET /assumptions` `corr.note`. The test then asserts the repaired matrix.

**A33. Fund picks and MF quality checks are non-goals for this release.** Resolves M16. Add to SPEC §10.2:
- Rebalance and Deploy work at segment level only: no fund or stock picks.
- No expense-ratio, direct-vs-regular or fund-overlap checks.
- The Deploy card says "by asset class; you choose the fund".

---

## Part B: Decisions for waves 3–7 (applied when those waves are prepared)

- **D1 (M2).** W7-B1 wires `txns`/`instruments` into `rebalance_plan` and `optimizer.suggest` (A1).
- **D2 (M8).** W4-B1 adds `GET /assumptions?mix=<segment>:<pct>,...`, which returns the `chip` for a proposed mix via `mu_sigma`. `/rebalance` adds `months_to_fix` = ceil(`money_to_fix_without_selling` / max(1, SIP monthly total + `inflow_90d`/3)), or null.
- **D3 (C12).** The 75% tests become two tests in W3-B4 and W3-B5:
  - (a) exact, on the helper's own draws: `mc` probability at `sip_75` is ≥ 0.75, and at `sip_75 − ₹100` it is < 0.75;
  - (b) a cross-check: the engine's 1,000-sim monthly probability at `required_sip` lies in 75 ± 8. The seeds are fixed, so this is deterministic, not flaky.
- **D4 (M9).** "suggest: {segment}" on FD rows is computed client-side in W5-F5 as the segment with the most negative drift in `brief.allocation`. No event field is added.
- **D5 (M10).** W7-B1 adds `after_tax=1` to `GET /forecast` and `GET /plan`. W7-F2 adds the toggle on the Plan fan. If W6-B2's `after_tax` misses the speed budget, the toggle is cut.
- **D6 (C19).** `market_state` reads stored ^NSEI closes with no network: W4-B1 adds `px.stored_history(db, symbol, start)` (`prices.py` goes into W4-B1's files). With fewer than 200 closes, `market_state` is null and the context line is skipped.
- **D7 (M11).** `GET /timeline` is dropped. Cash flows uses `/cash` + `/forecast/cashflow` (§5.10).
- **D8 (M12).** The holding benchmark overlay and the FD maturity ladder are out of this release (P3 backlog). The Reports default `summary` and `?r=` handling go to W3-F1 (adds `features/reports/reports.component.ts`).
- **D9 (M13).** W7-B1 adds `tracker/__init__.py` (`PUBLIC_PATHS += /api/jobs/daily-digest`) and `.github/workflows/market-scan.yml` (a 03:45 UTC call) to its files.
- **D10 (M17, N6).** Dark mode is cut from this release. W7-F1 drops the dark tokens and theme storage and keeps a11y (aria-sort, focus trap). W7-F6 drops `#appearance`. P2.9 becomes "a11y".
- **D11.** W3-B7 switches `targets:missing` to `/risk#mix`. Until W5-F2 moves the editor, W4-F1's interim Risk wrapper shows "Set targets → /settings" at `#mix`. W3-B7 keeps every insight id (A8) and does not add period keys.
- **D12 (M18).** Kite charges stay out of cost. `what_if_sale`, `harvest_plan` and the Tax page notes add "brokerage, STT and stamp duty from imports are not deducted" (W3-B3, W5-F4).
- **D13 (M19).** W5-F1 reads `?return=` on `/plan`, opens the Adjust panel and prefills the return override.
- **D14 (C13).** `planScenarios` entries gain `inflation_pct|null` (0–15) and `mix|null` ({segment: pct}, summing to 100 ± 0.5). `/plan/compare` honours both. Validation is in W7-B1; W7-F2 and W7-F3 use them.
- **D15 (C17).** "Seen" lives only in `action_log.seen_at`. The `seenNotices` setting is dropped, because a setting write would `_bump` and flush every memo. A notice that is not an action is recorded as a row with id `notice:<notice id>`, status `done` and `tier_first` NULL, so it never counts toward follow-through (W6-B1 helpers, W7-B1 route).
- **D16 (C18).** The what-if price default is `position.price` (W4-F1 modal, W5-F4 form). `what_if_sale` uses the position price when `price` is None.
- **D17 (C20).** W6-B1 adds `backend/tracker/api/ledger_api.py` and makes the CSV/CAS commit go through `bulk_add`. The claim "bulk_add commits atomically" is changed to "the import commit uses bulk_add".
- **D18 (N4).** The `simulate.run` step grid is monthly for 24 months, then quarterly, with no yearly steps:
  - flows inside a step are summed and added at mid-step;
  - the EPF March credit and FD releases apply in the step that contains them;
  - `median_months` is reported at step resolution.
  If the hard limit of 2.5 s is missed, interactive calls default to 600 sims and record it.
- **D19.** W4-F2 → W5-F9 and W4-F7 → W5-F10 (A2). Their content is unchanged.
- **D20.** The W7-F1 types move to the new W6-F2 (A2).
- **D21.** W3-F1 deletes `features/analytics/*` and `features/insights/*` (A2), and the dead code that §3.5 lists if W2-F2 left any.
- **D22.** W2-F4 keeps Concentration until W5-F10 removes it (A18).
- **D23.** W4-B1 builds `skipped` for `sip_adherence` from the action log (A11). It adds `adherence` to context and passes it to actions, which then stops mapping the `sip:missed` insight (A9).
- **D24.** Every later page task uses `vitalOf` (A23), the work-surface rule (A21) and the h1 rule (A22).

---

## Part C: Restated timeline and gates

Resolves N1, M14, N5. The old line "P0 ≈ 2 weeks, P1 ≈ 3 weeks for two developers" (§10.1) is replaced:

| Phase | Waves | Estimate (two developers) | Exit gate |
|---|---|---|---|
| P0 | 1 (≈ 1.5 weeks), 2 (≈ 2 weeks), then hardening on a copy of the scratchpad database (≈ 0.5 week) | **≈ 4 weeks** | Full backend pytest green offline. `ng build` and `npm run check` green. Manual checks at 1280/1000/760/390 px. `/brief` budgets measured and reported (A5). |
| P1 | 3 (≈ 1.5), 4 (≈ 2), 5 (≈ 2.5, now 10 frontend tasks) | **≈ 6 weeks** | The same gates. `/brief` re-measured with every P1 source. |
| P2 | 6 (≈ 2), 7 (≈ 2.5) | **≈ 4.5 weeks**; each item can be dropped | The same gates, plus the local simulate speed test. |

Total ≈ 14–15 weeks.
- There is no CI and no frontend spec runner; nothing in this plan adds them.
- Backend tests run as `cd backend && PYTHONIOENCODING=utf-8 python -m pytest -q`.
- Real-data checks use a copy of the scratchpad database copy, through the Python modules. Never use `backend/investments.db`, a running server or real tokens.

---

## Part D: Wave-1 task changes (summary)

| Task | Changes from WAVES.md | Extra files |
|---|---|---|
| W1-B1 | A1 (no engine wiring), A6 ledger contract, A10 migration owner mapping, A17 IPO link, A30 portfolio memo, A31 ^NSEI, A5. Add `offline_prices` to conftest. No actions/brief services, no `/brief` or `/actions` routes (wave 2). | `backend/tests/conftest.py` |
| W1-B2 | A1 (`inflation` kwarg, services untouched), A20 guest cap, retirement 400 through `ValueError`, A29. Delete the moved risk test. | — |
| W1-B3 | A1 (`proxies` kwarg, services untouched). Keep output keys. Recreate the moved test in `test_risk.py`. A29 (`sigma_own`). | — |
| W1-B4 | A8 (frozen ids and a pin test), A17 (story and calendar remaps, test scope). | `backend/tracker/analytics/story.py`, `backend/tracker/analytics/calendar.py` |
| W1-B5 | A6, A7, A8, A9, A10 owner rule, A11, A12, A13, A14, A24, A28; export the helpers. | — |
| W1-B6 | A6 (actions argument, helpers, shapes), A16, A23, A24, A25, A26, A28. | — |
| W1-F1 | A2 (stubs, portfolio-tabs), A3, A4 (`tsconfig.check.json`, `npm run check`, no specs), A6 types, A13 navigation, A16 `statusFromExcess`, A19 FD dialog, A23 `vitalOf`. | `layout/shell.component.html`, `shared/fd-mature-dialog.component.ts`, `shared/portfolio-tabs.component.ts`, `features/actions/actions.component.ts`, `features/performance/performance.component.ts`, `frontend/tsconfig.check.json`, `frontend/package.json` |

## Coverage: every critique item

| Item | Decision | Item | Decision | Item | Decision |
|---|---|---|---|---|---|
| M1 | A1 | C1 | A16 | C12 | D3, A29 |
| M2 | A1, D1 | C2 | A8 | C13 | D14 |
| M3 | A17, A18 | C3 | A9 | C14 | A24 |
| M4 | A20 | C4 | A10 | C15 | A22 |
| M5 | A19 | C5 | A12 | C16 | A23 |
| M6 | A27 | C6 | A11, D23 | C17 | D15 |
| M7 | A26 | C7 | A13 | C18 | D16 |
| M8 | D2 | C8 | A14 | C19 | D6 |
| M9 | D4 | C9 | A15 | C20 | D17 |
| M10 | D5 | C10 | A21 | C21 | A2 |
| M11 | D7 | C11 | A16 | N1 | Part C |
| M12 | D8 | M16 | A33 | N2 | A5 |
| M13 | D9 | M17 | D10 | N3 | A32 |
| M14 | A4, Part C | M18 | D12 | N4 | D18 |
| M15 | A25 | M19 | D13 | N5 | A4 |
| | | | | N6 | D10 |

---

## Wave 2

Prepared against the working tree after wave 1 landed (backend pytest 276 passed). Decisions E1–E20 bind wave 2 and every later wave. They add to Part A; where they differ from WAVES.md or SPEC.md, they win.

### Ownership

**E1. File lists differ from WAVES.md as follows.**
- W2-B1 also owns `backend/tracker/analytics/actions.py`, for **additive public helpers only** (E5). Existing functions keep their behaviour, and `test_actions.py` and `test_wave1_contracts.py` must stay green.
- W2-F1 no longer owns `shared/portfolio-tabs.component.ts` (A2: W1-F1 built it). It owns `layout/shell.component.{ts,html,scss}` (A3) and creates `shared/nav-list.component.ts`.
- W2-F3 owns only `features/actions/*` and `shared/rebalance-planner.component.ts`. It deletes nothing under `features/insights/` (A2; W3-F1 deletes it).
- W2-F4 owns only `features/performance/*`. It copies from `features/analytics/` and deletes nothing (A2; W3-F1 deletes it).
- `StatComponent` (`shared/ui.ts`) and `ToranComponent` (`shared/motifs.ts`) are dead, but no wave-2 task owns those files. W3-F1 removes them (D21).

**E2. Wave-2 pages do not wait for W2-F1's API additions.** A page that needs an endpoint variant calls the public `ApiService.get<T>(path, params)` with an existing model type, or with a local interface. An example is `GET /rebalance` with `net=deploy`. W2-F1 adds the typed methods and types to `api.service.ts` and `models.ts` so that later waves can switch to them:
- `rebalance(newMoney, allowSell, net?: 'deploy')`;
- the wave-1 backend fields that are not typed yet: `PortfolioRisk` holdings `volatility_used_pct`, `data_quality`, `n`, `proxy`, plus the `model`, `measured_vs_model`, `ballast`, `mean_return_pct` and `risk_free_pct` fields; `RetirementPlan` `first_year_withdrawal`, `sims`, `honesty`; `CashFlow` `monthly_sip_total`; and `ActionsResponse.notes?`.

### Backend wiring (W2-B1)

**E3. The owner comes from the request.** `Services.owner()` returns `Ledger.settings_owner(g.email, g.role)`, the same way `Services.settings()` does. Signatures:
- `actions(scope, settings, owner=None)` is memoised on `('actions', scope, owner, settings, today, actions_rev)`;
- `brief(scope, settings, since, owner=None)` is memoised on `('brief', scope, owner, settings, today, since, actions_rev, perf_ready)` (A16);
- `owner=None` means `self.owner()`.

The action log is read for `[owner] + every distinct instruments.owner in scope` (A10).

**E4. The `GET /actions` payload.** It is `{summary, actions, planned, done, snoozed, follow_through, notes}`:
- `actions`: the visible rows with status `open`. `planned`: the visible rows with status `planned`.
- `summary`: `actions.summary()` over both lists. It already carries `new` and `tax_open`; that addition to A6 is accepted.
- `done`: log rows with status `done` and `done_at` in the last 90 days, newest first, at most 50.
- `snoozed`: rows that are `snoozed` with `snooze_until ≥ today`, plus rows that are `dismissed`, newest first, at most 50.
- `done` and `snoozed` rows are mapped to the Action shape by E5.
- `notes`: one string per source that failed and was skipped.
- `?status`, `?category` and `?instrument_id` filter the memoised result. They are never part of the memo key.

**E5. The new public helper in `actions.py`.** `action_from_row(row, src=None, today=None) -> Action` turns a log row into the Action shape. It is the public form of `_stale_action`, plus the row's `status`, `done_at`, `done_via`, `evidence`, `reason` and `note`. Its `tier` is `tier_first`, or `consider` when that is missing. Nothing else in `actions.py` changes.

**E6. Writes from the actions build.** Inside the memo build only, `services.actions` calls `build_actions(..., include_closed=True)` and splits the result:
- The visible rows are upserted with `upsert_action_seen`, grouped by `a['owner']`. Each row sends `first_seen` (today, or the existing value), `tier_first` (= tier), `category`, `title`, `impact` (the amount), `impact_kind` and `due`.
- The closed rows (`done` or `expired`) are upserted with `status`, `done_via`, `evidence` and `done_at`.
- A visible action whose `first_seen` is None gets today in the memoised result.

**E7. Snapshots.**
- `/actions` passes `snapshot_then = kpi_snapshot_at(snap_owner, today − 30 days)`, which `plan:probability-drop` needs (§1.4).
- `/brief` reads the `since` snapshot for the hero. Before it calls `build_brief`, services sets `summary['new']` to the number of visible actions whose id is not in that snapshot's `action_ids`. The number is 0 when there is no snapshot. Services also sets `is_new` the same way on copies of the top actions.
- `snap_owner` is `scope`, or `'__family__'` when the scope is None.
- The write after `/brief` stores `{value, invested, total_gain, xirr, day_change, goal_probs: {str(goal id): p, 'retirement': p}, retirement_probability, vitals: {key: status}, action_ids: [every visible id]}`. The retirement probability is in both places on purpose: `brief.py` reads `goal_probs['retirement']` and `actions.py` reads `retirement_probability`. `projection_1y` and `book_hash` are added in wave 4.
- The write is skipped when `brief.empty`. Services keeps an in-process set of `(snap_owner, date)` pairs it has already written, so a warm `/brief` makes no database write.

**E8. Inputs `/actions` and `/brief` share.** Each is computed once per build and passed to both `build_actions` and `build_brief`:
- `cushion_state` and `deploy_state(port, cashflow(3)['events'], today)`.
- `risk_est = {vol_pct: optimizer(scope, settings, profile).current.vol_pct, target_vol_pct: PROFILES[riskProfile].target_vol × 100 or None, profile: settings.riskProfile or None, closest_profile: current.closest_profile}`. `profile` is the `riskProfile`, or `'balanced'` when there is none. When anything raises, `risk_est` is None and a note is added.
- `stress = services.stress(...)`.
- `plan = {goals: ctx.goals, retirement: services.retirement(...) only when settings.retirementPlan is a non-empty dict, else None}`. This follows the wave-1 integration note: the age-30 defaults must never produce `retirement:gap`.
- `perf = _peek('performance', scope, 'ALL', None)`.
- `nifty_quote` = the raw value of `quote:^NSEI`.

When the scope is None, services appends " · family plan" to the brief headline (§7.8). It does this on the dict it builds, before memoising.

**E9. Validating `since` on `GET /brief`.** A value that is not `YYYY-MM-DD` returns 400. A date more than one day after the server's today also returns 400. Exactly one day ahead is clamped to today, because the browser's local date (IST) runs ahead of a UTC server between 00:00 and 05:30. The client sends its local date.

**E10. `POST /actions/<path:id>/status`.**
- The id must start with one of `actions.ACTION_PREFIXES` and be at most 200 characters; otherwise 400.
- `status` must be one of `open`, `planned`, `snoozed`, `done` or `dismissed`; otherwise 400.
- `until` maps to `snooze_until` and must satisfy today < until ≤ today + 365.
- `planned_for` must satisfy today ≤ date ≤ today + 365.
- `txn_ids`, or `evidence.txn_ids`, become `evidence = {txn_ids}`.
- `done` sets `done_via='manual'`. `note` and `reason` are passed through.
- Owner, in order:
  1. the `owner` of the current action with that id (from the memoised `/actions`, including `planned`, `done` and `snoozed`);
  2. otherwise, an id that ends in an instrument id (A10's prefixes): that instrument's `owner`, read in scope;
  3. otherwise, a `sip:*:<sid>:…` id: that plan's instrument owner, or the plan's `owner`;
  4. otherwise, the settings owner.
- When the action exists, the route first upserts its `first_seen`, `tier_first`, `category`, `title`, `impact`, `impact_kind` and `due`, so a manual done on a never-seen row still counts toward follow-through. Then it calls `set_action_status`.
- The response is the action re-read after the bump, or, if the action is now hidden, the pre-POST action merged with the new row.
- Guests get 403 from `@write_required`.

**E11. `dismissedInsights` stops being read.**
- From wave 2, every services call to `build_insights` passes `{**settings, 'dismissedInsights': {}}`. The action log is the only place a snooze is stored.
- `/insights/<id>/dismiss` writes `set_action_status(owner, action_id_for_insight(id, today, sips), 'snoozed', snooze_until=today+days)` and keeps its response shape `{dismissed, until}`. `days` must be 1–365.
- `notifications()` keeps an insight only when its action id (`action_id_for_insight`) is among the visible actions. That way a snoozed action does not come back in the bell.

**E12. Memo keys.**
- `forecast` adds `inflation` (A1) and `date.today()`.
- `stress` and `retirement` add `date.today()`, because the SIP total depends on the date.
- `forecast` passes `inflation = retirementPlan.inflation_pct / 100` when it is set, otherwise None.
- `risk` passes `proxies = {'^GSPC': …, 'GOLDBEES.NS': …}` from the same `ensure_history` call. The lookback stays at 400 days; W3-B6/W4-B1 decide whether to lengthen it.
- `build_insights` gets `cushion=`, `risk_est=` and `stress=` only on the `services.actions` path (they are ignored until W3-B7). `services.insights` keeps its current call apart from E11. W4-B1 unifies the two.

**E13. `GET /rebalance?net=deploy`** (A15). `services.rebalance(..., net=None)`: when `net == 'deploy'`, it builds `deploy_state` exactly as `/brief` does. It then subtracts each source's `held_value` from its `segment` in a copied `segments` list, never going below 0, before it calls `goals.rebalance_plan`. Any other value of `net` returns 400.

### Engines (W2-B2, W2-B3)

**E14. The Assumption Book is a leaf module.**
- `assumptions.py` imports only `domain` and the standard library. It owns `CORR` as `{key: {key: rho}}` over the 9 keys (the 8 segments plus `MF_DEBT`).
- `optimizer._CORR_ROWS` stays as an alias derived from `CORR`, because `quant.py` imports it until W3-B6.
- `assumptions.ASSUMPTIONS` repeats today's `goals.ASSUMPTIONS` values and adds `'MF_DEBT': (0.07, 0.03)`. Until W3-B4 makes goals re-export it, a test asserts that the 8 shared rows are equal.
- `assumptions.HONESTY` holds forecast.py's strings exactly (including the `{sims}` template in `p50`) plus `disclaimer`. A test asserts equality on the shared keys, so W3-B5's swap changes nothing.
- A32 check, run while preparing this wave: the pure-Python Cholesky of the specified 9×9 matrix succeeds, with a smallest pivot of 0.186. **λ = 0**: no repair. `GET /assumptions` `corr.note` (W4-B1) reads "Positive definite as specified."

**E15. The Book's function contracts.** The shape of `book` is `{segments: {key: {return_pct, vol_pct}}, inflation_pct}`, as `effective_book(settings)` returns it (no overrides until P2).
- `rated_book(positions, book) -> book` is a new function. It returns a copy in which the FD, EPF and P2P μ are value-weighted instrument rates over open positions. P2P uses rate − `P2P_LOSS`, **capped at `P2P_MU_CAP = 0.12`**. The data copy's P2P rates are 36–48% (borrower rates), so without a cap the Book would expect about 39%. The cap is part of `chip().text` basis notes. W3-B6 applies the same constant to the quant ballast. A segment with no rated position keeps its default.
- `weights_from_positions(positions, book=None) -> {key: w}` covers open positions with value > 0 and normalises the weights to 1.
- `mu_sigma(w, book, *, notes=None) -> (mu, sigma)` appends unknown keys to `notes` when a list is passed.
- `book_key(position)` uses `tax_class == 'debt'`, or the debt regex on `category` or `sub_category`, to map an MF to `MF_DEBT`. The `name` is not used. Cash maps to `Equity (USA)`.

**E16. Optimizer.**
- `suggest(port, profile, seed)` keeps every output key and its signature.
- `current` return and volatility are `mu_sigma(weights_from_positions(port['positions']), rated_book(port['positions'], book))`. Without `positions`, as in the existing test, it uses segment weights and the default book.
- The frontier and profile mixes are still weights over segments. `_stats` splits the `Mutual Funds` weight into `Mutual Funds` and `MF_DEBT` by the portfolio's current MF debt share by value (0 without positions). The same mix therefore gets the same volatility as `current`.
- `RISK_FREE` is imported from assumptions.
- Integrator check: the brief Risk vital volatility equals `optimizer.suggest(...)['current']['vol_pct']`, because W2-B1 passes that value through (E8).

**E17. `mc.py` conventions.**
- `annual_shocks(seed, sims, years)` draws standard normals from `random.Random(seed).gauss(0, 1)`, row by row.
- `required_sip_for` uses years = ceil(months/12). Growth in year k is `exp(ln(1+μ) − σ²/2 + σ·Z)`. A year's 12 instalments go in mid-year (× √growth); this is the same convention W1-B2 used in `retirement_plan`. A final partial year scales both the instalments and the growth exponent by the fraction of the year. `step_up` raises the SIP every 12 months.
- `sip_typical` is the deterministic SIP at `typical(μ, σ)` with monthly compounding. It returns `{sip_75, sip_typical}`, rounded to ₹1. A target that is already reached returns `{0, 0}`.
- `pctl` re-exports `quant.percentile`. `mc` must not be imported by `quant`.

**E18. `plans.py` rules.**
- It imports only `domain` and the standard library. `forecast.py` will import it in W3-B5, so it must not import `forecast`.
- `SIP_PER_MONTH` is a local copy. A test asserts that it equals `forecast.SIP_PER_MONTH`.
- `sip_adherence(sips, txns, instruments, today, months=6, *, skipped=None)` (A11). Its window runs from the first day of the month `months − 1` months back to max(the end of the current month, today + 7 days). This lets `actions.py` see `sip:due` 5 days ahead across a month boundary.
- Inactive plans (`active = 0`) have no instalments.
- `months[]` lists one entry per instalment, not per month. A weekly plan has about 4 a month. Each entry is `{month, due, planned, invested, status}`. The name `months` stays, because `actions._rules_adherence` reads it.
- Status:
  - an instalment matched ≥ 95% of `planned` is `done`;
  - one matched > 0 is `partial`;
  - an unmatched one with due ≥ today − 4 is `upcoming`; the 4-day grace counts as upcoming;
  - an older unmatched one is `missed`;
  - a `(sid, due_iso)` in `skipped` is `skipped`. Skipped and upcoming are left out of the adherence denominators.
- `planned` = amount × (1 + step_up_pct/100)^(whole years from `start_date`, or `created_at`, to the due date).
- A plan without `start_date` anchors its weekly and quarterly cadence on `created_at[:10]`.
- EPF exclusion: a plan whose instrument is EPF, or whose segment is EPF, is left out of `plans[]` and every total when any BUY on an EPF instrument in scope has a `source` that starts with `import:epf`.

### Frontend (W2-F1 to W2-F5)

**E19. Interim routes (amends A18 for wave 2).**
- `/risk#rebalance` goes to **`/actions#deploy`**, where the planner lives from W2-F3. `/risk#mix` goes to **`/settings`**, where the target editor still is.
- `/plan?tab=goals` goes to `/goals` and keeps the other query parameters (`preset`).
- `/markets?tab=performance` goes to `/performance` through a `canActivate` that returns a UrlTree.
- `/insights#rebalance` goes to `/actions#deploy`, and `/insights` goes to `/actions`.
- `/analytics` goes to `/performance` and keeps `range`.
- `/admin` goes to `/settings#people` through a UrlTree.
- Redirects are `redirectTo` functions (Angular 19) or guards that return a UrlTree, all in `app.routes.ts`.
- The bell's `go(n)` uses `router.navigateByUrl(n.link)`. Splitting on `#` breaks `?tab=` links (A13).

**E20. The brief snapshot and its readers.**
- Only Home writes `snapshotKey('brief', scopeKey)`, from its `api.brief(since)` call.
- Pages that need a brief field read that snapshot first. These are Actions (`deploy.suggested`), Performance (`why`, and the T0 vs-Nifty verdict) and the shell (the Plan dot and the Data dot). When it is missing, Actions and Performance call `api.brief()` without `since` and do not write the snapshot. The shell only reads, and otherwise falls back to a client mirror of `brief._data_vital` built from `store.portfolio()` (age ≤ 26 h is good, ≤ 96 h is watch, more is act; any unpriced holding is at least watch, and ≥ 5% of value unpriced is act).
- `/performance` defaults to the **ALL** range: no `?range` means ALL, which is the memo key `/brief` peeks (A16). Visiting Performance warms the Home market card. The T0 vs-Nifty verdict always uses the ALL comparison and is labelled "since you started". The range control changes only the period tiles and charts.
- The Actions filter chips map to categories:
  - Money at risk: `p2p`, `fd`, `cash`;
  - Tax: `tax`;
  - Mix: `allocation`, `risk`;
  - Plans & SIPs: `goals`, `habit`;
  - Data: `data`;
  - Markets: `market`.

  `performance` and `review` appear only under All.
- The Home habit card has no "next milestone" line in P0, because `/pulse` is no longer called and the brief has no milestone field. Coming up stays hidden while `brief.upcoming` is null (W3-B1 fills it). The empty state omits "Next: SIP …" until `next_due` reaches the brief (W4-B1).

### Wave-2 task changes (summary)

| Task | Changes from WAVES.md | Files |
|---|---|---|
| W2-B1 | A1 wiring (inflation, proxies, insights kwargs per E12), A5 measurement, A10, A11 POST checks, A15 (`net=deploy`), A16 `perf_ready`, E3–E13; drop the timed test line (A5) | `services.py`, `api/analytics_api.py`, `tests/test_api.py`, `analytics/actions.py` (E5 only) |
| W2-B2 | A32 (done: λ = 0), E14–E17; the "vital == optimizer" test is an integrator check | as WAVES.md |
| W2-B3 | A11 `skipped`, E18 | as WAVES.md |
| W2-F1 | A2, A3, A18 + E19, A22 (no h1; `document.title`), E2, E20 shell part | `app.routes.ts`, `layout/shell.component.{ts,html,scss}`, `shared/nav-list.component.ts`, `core/models.ts`, `core/api.service.ts`, `styles.scss` |
| W2-F2 | A16 (ALL, not 1Y), A21, A22, A23, E20 | `overview.component.{ts,html,scss}`, `pulse.components.ts`, `story.components.ts` |
| W2-F3 | A2, A13, A15, A21, A33 copy, E2, E4, E20 | `features/actions/*`, `shared/rebalance-planner.component.ts` |
| W2-F4 | A2 (copy), A18/D22 (keep Concentration as collapsed T3), A21, A26, A27, E20 | `features/performance/*` |
| W2-F5 | A22, A27 (strip `prefixes=['/markets']`, `ids=['market:']`) | as WAVES.md |

### W2-B3 builder decisions (`plans.py`)

- **Anchor bounds the schedule.** A plan's first possible instalment is its anchor: `start_date`, or `created_at[:10]` when it has none. A plan without `start_date` therefore has no instalments (and no `missed`) before the day it was created. Without an anchor at all, weekly uses the window's first day and quarterly/yearly use January.
- **Matching takes amounts, capped at `planned`.** An instalment takes BUY amounts (earliest BUY first) only up to its planned amount, so the rest of a BUY stays available to later plans and instalments. `invested` therefore never exceeds `planned`.
- **Pre-roll.** Instalments due up to 24 days before the window are matched first and not reported, so the window's first instalment cannot take a BUY that belongs to the one before it.
- **Status precedence:** `done` (≥ 95%) > `skipped` > `partial` > `upcoming` > `missed`. A paid instalment stays `done` even when it is in `skipped`. `skipped` keys are compared as `(str(sid), due_iso)`, so int and string plan ids both work.
- **Totals.** `planned_this_month` / `invested_this_month` sum the instalments due in today's calendar month; a skipped instalment adds nothing to planned. `adherence_6m_pct` scores done 1, partial 0.5, missed 0, weighted by each instalment's `planned`, over every plan; percentages are 0–100 with one decimal.
- **Plan rows.** Inactive plans stay in `plans[]` with `active: false`, empty `months`, `adherence_pct` and `next_due` null. `monthly_equiv` = amount × `SIP_PER_MONTH` for a plan running today (the `forecast.monthly_sip_total` rule, no step-up), else 0. A plan's `next_due` is its first instalment on or after today that is still `upcoming` or `partial`, else the first one after the window.
- **Top-level `next_due[]`** is `next_due(kept_plans, today, 90)` minus instalments already `done` or `skipped`; `amount` includes the step-up. EPF-excluded plans are left out of it too.
- **Extra keys:** `excluded_epf` (ids of plans dropped by the EPF import rule) and `window {start, end}`. Consumers may ignore them.

### W2-B2 builder decisions (`assumptions.py`, `mc.py`, optimizer, story)

- **Book rows carry `source`.** Each `book.segments[key]` is `{return_pct, vol_pct, source}`; `source` is `default` from `effective_book` and `holding rates` for a row `rated_book` rewrote (the values `GET /assumptions` lists). A P2P row whose rate hit the cap also carries `capped: true`, and `chip().text` then ends " · P2P capped at 12%" when the mix holds P2P. Both keys are part of `book_hash`.
- **`rated_book` details.** The P2P cap applies per position (rate − P2P_LOSS, then min with P2P_MU_CAP) before value-weighting. A `defaulted` P2P loan counts at μ = 0, as `quant._ballast_rate` treats it. A rated position without a `rate` uses the segment default (FD 7%, EPF 8.25%, P2P 10% − 3%). Positions without `is_open` count as open.
- **`status_for(prob, achieved=True)` returns `achieved` even when `prob` is None.** Otherwise None when `prob` is None.
- **`mu_sigma` accepts both book shapes**: the §6.1 `{segments: {key: {return_pct, vol_pct}}}` and a plain `{key: (mu, sigma)}`. `book=None` means `effective_book(None)`.
- **`mc.required_sip_for` solves exactly instead of bisecting.** Each path's terminal value is linear in the SIP (A_i + s·B_i), so the SIP that meets the target on ceil(prob·sims) of the 400 CRN paths is that order statistic of (target − A_i)/B_i: the limit of the 14-step bisection, exactly monotone in the target. Both SIPs are rounded **up** to ₹1, and `sip_75` is never reported below `sip_typical` (the two use different contribution timing, mid-year vs month-end, which matters only when σ ≈ 0). With `months ≤ 0` and the target not reached it returns `{sip_75: None, sip_typical: None}`. A keyword-only `sims=400` is accepted.
- **Optimizer.** The frontier and profile mixes are scored with the same rated book and debt-MF share as `current`, so a mix equal to today's segment weights gets today's numbers. `_stats(w, book=None, debt_share=0.0)`; `efficient_frontier` and `_refine` gain keyword-only `book` and `debt_share`. The optimizer note now names the holding rates and the P2P cap.
- **Story copy.** The milestone takeaway reads "at a typical X% a year" (was "an assumed"); `milestones.assumed_return` keeps its name and now holds the typical return.

### W2-B1 builder decisions (services wiring, `/brief`, `/actions`)

- **Shared sources are one memo.** `services._action_inputs(scope, settings)` is memoised on `('action_inputs', scope, settings, today)` and holds everything that does not depend on the action log: cushion, deploy, risk_est, stress, plan, snapshot_then (today − 30), calendar, the cash-flow events, insights and `notes`. `/actions` (keyed on `actions_rev`) re-runs only the log overlay, so a status POST costs about 3–12 ms on the data copy. `/brief` reads the same build, so the two never disagree.
- **The actions path never reads performance.** Its `build_insights` call gets no history metrics, so `perf:*` actions do not come from `/actions` in P0. Peeking a warm performance there would make `_source_present` expire `perf:*` rows whenever it was cold. W4-B1 may revisit with `perf_ready` in the key.
- **`services.retirement(..., *, build_history=True)`.** The `/actions`/`/brief` path passes `build_history=False`: it uses the ALL performance metrics only when already warm. The memo key is `('retirement', scope, merged, today, metrics_ready)`, so the two paths never serve each other a result computed on different inputs.
- **A failed retirement source makes `plan` None** (not `{goals, retirement: None}`), so an open `retirement:gap` is not expired by a transient error; goal actions then come from the insights mapping. A missing `retirementPlan` still gives `plan.retirement = None`.
- **`services.deploy(scope, settings)`** is memoised on `('deploy', scope, settings, today)`; `/brief`, `/actions` and `/rebalance?net=deploy` share it. A failed cash-flow forecast leaves P2P principal out.
- **`/rebalance?net=deploy`** adds `net: 'deploy'` and `netted: {segment: amount}` to the payload. `net=<other>` is 400.
- **Status POST details.** `snoozed` without `until` snoozes for 30 days. `until` is stored only for `snoozed`, `planned_for` only for `planned`, and evidence (`txn_ids`, ints) only for `done`; each is still validated when sent. `note` and `reason` are text of ≤ 500 characters. The upsert of first-sight fields uses the action's current tier.
- **Dismiss alias** keeps `{dismissed, until}` and adds `action_id`. The id is not checked against `ACTION_PREFIXES` (insight ids are), only for length.
- **`GET /actions` filters.** `status` also accepts `expired`; any other unknown status is 400, as is a non-integer `instrument_id`. When a filter is present, `summary` counts the filtered open and planned rows.
- **Done / Snoozed lists.** `notice:*` rows are left out. Done is ordered by `done_at`, Snoozed by `updated_at`, newest first.
- **The family suffix " · family plan"** is added only when the brief is not empty (the onboarding headline stays as it is).
- **Persisting first sightings** skips a visible action whose log row already has every fill field, and a closed one whose row already has that status, so an unchanged rebuild writes nothing.
- **Risk proxies.** `services.risk` always adds `^GSPC` and `GOLDBEES.NS` to its one `ensure_history` call (400-day lookback unchanged) and passes the non-empty ones as `proxies`.
- **A5 measurement (data copy, 168 instruments, 332 transactions):** cold `/brief` ≈ 73 ms (78 ms with a saved retirement plan), warm ≈ 0.1 ms, warm `/actions` < 0.1 ms. The optimizer is the largest cold cost (≈ 28 ms), then `compute_portfolio` (≈ 11 ms). The script blocks `ensure_history` and `fetch_quotes`, so `/brief` provably builds no history.

### W2-F1 builder decisions (routes, shell, nav list)

- **The Data vital the shell shows.** The shell computes the E20 client mirror (`dataVitalMirror` in `shell.component.ts`, same rules and thresholds as `brief._freshness` / `_data_vital`) from `store.portfolio()` on every tick. The brief snapshot's Data vital is used only while it describes the same prices, i.e. its `freshness.last_refresh` equals the mirror's oldest stamp; then the worse of the two statuses wins (ages only grow). A snapshot from before the last refresh is out of date, and the mirror stands alone. Naive timestamps are read as UTC, as `brief._ts` does.
- **The pill's age is this portfolio's oldest price** (the mirror's stamp), not the global `prices:last_refresh`, so the pill and the Data vital always agree. The status word is in the pill's title and aria-label (never colour alone). The pill is "● Prices · 12 min ago ⟳" above 1180px and the dot alone at or below it; tapping calls `store.refreshPrices(true)`.
- **When the shell re-reads the brief snapshot:** on every NavigationEnd, on window focus, when `store.version()` moves and every 30 s. It never fetches `/brief`.
- **Bell.** Tier-now actions come first under "Do now" (stripe and icon from `actionStatus`), then reminders whose kind is not `insight` under "Coming up". The count is unseen now-actions plus unread reminders. An action is marked seen as `action:<id>:<first_seen>` inside `NotifyService.seen` when the bell closes, so a new period id or a re-fired action counts again. Action rows open `action.link` (else `/actions`) with `navigateByUrl`.
- **Tax badge** "N days left" (to 31 March) shows on the More/drawer Tax entry from January to March only, and only when `ActionsSummary.tax_open > 0`.
- **NavListComponent** (`shared/nav-list.component.ts`) also renders the desktop slots (`mode="bar"`), so all four renderings share `PRIMARY_NAV`, `TOOLS_NAV`, `navActive` and `NavBadges`. Matching uses `linkUnder`, so `/p2p` never matches `/p2pfoo`. Its host class is `nav-<mode>`: a bare `bar`/`drawer` class collides with the shell's own `.bar` and `.drawer` rules.
- **Extra interim redirect:** `/holdings` → `PORTFOLIO_HOLDINGS_HOME` (§3.6 lists `/holdings` → `/holdings/all`; W4-F1 points it at `/holdings/all` with the constant).
- **`RiskHolding.volatility_pct` is typed `number | null`** (v2 sends null under 60 days of prices), and the row's `data: 'own' | 'proxy' | 'prior'` is typed as well. `RebalancePlan` gains optional `net` and `netted` (W2-B1).
- **Known limit, not fixed here:** `ForecastComponent` reads `?tab=` only when it is created. A redirect from `/risk#…` or `/recurring` while already on `/forecast` reuses the component and keeps the old tab. It goes away when W4-F1 replaces the interim redirects with real pages.

### W2-F5 builder decisions (Markets)

- **Page order follows §1.12:** head → T0 `.kpis` → T1 `app-needs-attention` (`prefixes=['/markets']`, `ids=['market:']`) → tabs → tab content. The tabs sit under the strip, so T0 keeps one shape on every tab.
- **`?tab=`** is read by the exported `marketTab(v)`: `today | ideas | watchlist`, `ipos` → watchlist, anything else (no value, unknown, `performance`) → today. The page follows `queryParamMap`, so a bell link to `/markets?tab=watchlist` works while Markets is already open. `setTab` writes `?tab` with `replaceUrl` and drops it for Today, the default.
- **The "→ Your performance" head chip** (`.btn.ghost.sm`, `/performance`) sits in the page head on every tab. §5.12 lists it under Watchlist & IPOs, but it replaces the tab that was removed, so it stays visible everywhere.
- **T0 hero:** the label is the index name, the value is the price (0 dp), and a pill shows d1, followed by w1 and m1. The verdict line is factual only: "Up 0.4% today, 1.2% below this month's high." Within 0.5% of the high it says "near its high for the month". The icon is `arrowUp`, `arrowDown` or `info`. It makes no forecast and has no status colour, because Markets is context (§1.6: never `act`).
- **Phone budget (§1.5, ≤2 hero stats):** at ≤760px the third tile, Alerts today, hides behind a "More" toggle in the hero.
- **Alerts today** counts `market_alerts.created_at` (UTC) on the viewer's local calendar day, not the UTC day, so IST alerts between 00:00 and 05:30 count as today.
- **A failed refresh keeps saved prices** (`snapshotKey('markets', scope)`). The sub line says "couldn't refresh, showing saved prices". Only with nothing saved does the T0 slot show the error and Retry. The page repaints from the snapshot only when the scope changes, so a `store.version()` bump no longer blanks the page.
- **Honesty:** the Ideas disclaimer opens with "These are price patterns, not forecasts", and every signal chip tooltip ends with `SIGNAL_HONESTY` ("price pattern, not a forecast", exported from `market-parts.ts`). W6-F1 replaces the chips with the shared vocabulary.
- "Rebalancing with the signals" links `/risk#rebalance`, which E19 currently sends to `/actions#deploy`.

### W2-F4 builder decisions (Performance)

- **URL.** `?range` is omitted for ALL (the default, E20) and `?segment` for the whole portfolio. Both are written with `replaceUrl` and `queryParamsHandling: 'merge'`, so a range click never adds a history entry. Unknown values fall back to ALL and the whole portfolio. The range is read case-insensitively.
- **The T0 verdict is whole-portfolio and since-start, even when a segment or another range is picked.** Source order: the brief's `on_track.market` (from `snapshotKey('brief', scopeKey)`, else `api.brief()` unwritten) while it is not `pending`; else the page's own whole-portfolio ALL payload with Home's rule (`statusFromExcess`, ₹ difference = `store.portfolio().totals.value` − NIFTY50 `end_value`, as `story.market_compare`). Only when the page shows something other than whole/ALL and the brief cannot answer does it fetch `GET /performance?range=ALL` a second time (once per `scope#version`). While neither source is ready it shows "Comparing with Nifty 50…" (A16's allowed placeholder). Under 180 days the line reads "… · too early to judge" with no status word.
- **Worst-fall tile.** §5.4's tile shows `current_drawdown` under the label "Worst fall", which misreads; it is labelled **"Fall from peak"** (`current_drawdown`), with "worst fall {max_drawdown} in this period" as its meta. TWR is `twr_annualised ?? twr`, and its meta says which one it is.
- **Phone budget (§1.5).** At ≤760px the Fall-from-peak tile hides behind a "More" toggle in the hero.
- **Snapshots.** The page paints from and writes `snapshotKey('perf', scope, range)`, the same key and payload shape Home uses, for the whole portfolio only. Segment views are not cached: 8 ranges × 9 views could overrun storage, and an overrun clears every snapshot, the brief included. A range or segment switch keeps the old numbers on screen, faded, until the answer arrives; a scope change blanks them.
- **Compared-with ₹ difference** is the period's `metrics.end_value` − the benchmark `end_value` (the same flows from the period's start), shown signed; `excess_xirr` is shown as "±x.x pts".
- **Attribution** (`#attribution`) shows the brief's totals (total, unrealised, booked, income), the top five gainers and losers filtered by segment, per-segment gains (the selected one in bold) and "winners · losers" (whole portfolio). An empty filtered list says "None of your five biggest gainers are in {segment}", because the brief carries only the top five each way.
- **Fragments.** `#attribution` scrolls once the brief has answered (or failed); `#concentration` opens the collapsed block and scrolls once the period payload is painted. Each fragment scrolls once per visit.
- **Methodology** (T3, collapsed) carries the period, start and end value, net money added, best and worst day, the share of up days, volatility and Sharpe, plus the XIRR, TWR, PME and verdict rules, and "past returns, not a forecast".

### W2-F3 builder decisions (Actions page, rebalance planner)

- **"Redirect maturities" applies to FD and P2P rows that the plan would shrink.** A `Fixed Deposits` or `P2P` row reads "Redirect maturities" when its action is `sell`, or `hold` while it sits more than 0.5 pts above its target. A `buy` row keeps "Add ₹X" (opening an FD or lending more is a real move). Those classes are not sold; the money is moved as it matures.
- **`net=deploy` follows the amount, not the source.** The planner sends `net=deploy` when its amount is `brief.deploy.suggested`: no `?new_money=`, or a `?new_money=` within ₹1 of the default (the CTA rounds to whole rupees). Any other `?new_money=` (for example one FD's `maturity_value` from `fd:maturing:*`) and any typed amount send no `net`. A "Use ₹X" button restores the page's amount and its netting.
- **The deploy default is read once per scope or data change.** Actions reads `snapshotKey('brief', store.scopeKey())`; when the snapshot has no `deploy`, it calls `api.brief()` without `since` and never writes the snapshot (E20). If both fail, the planner still runs with 0 and the page says so.
- **Tax moves.** The three cards read `GET /tax` (current FY). "Book gains tax-free" shows `future_tax_saved` (est.), "Offset gains with losses" shows `loss_harvest_offsettable` × the highest `tax_lines` rate (or the offsettable amount when there is no rate), and "Wait before selling" shows Σ `upcoming_long_term[].tax_saving` with the earliest `lt_on`. "Plan the sale" runs a local `whatif` CTA through `ActionRunner` with link `/tax?tab=whatif&whatif=<iid>` (the first lot, the biggest loser, or the next lot to turn long-term); it opens that link until the P1 what-if modal lands.
- **"Tax you can still save"** = Σ `impact.amount` of open and planned actions with category `tax` and `impact.kind = 'lump'`.
- **Filter chips.** Keys are `money`, `tax`, `mix`, `plans`, `data` and `markets` (E20 categories); `all` removes `?filter`. The chip counts are now + this-month + planned actions. Deploy money shows under All, Money at risk and Mix; Tax moves under All and Tax. A `#deploy` or `?id=` that the current chip would hide resets the chip to All.
- **`?id=`** opens whatever hides the action (a This-month row, Worth considering, Good news, Done or Snoozed & hidden), scrolls to it and rings it for about 2 s. Table rows carry `id="row-<actionId>"`; cards keep ActionCard's `action-<actionId>`.
- **Phones.** The T0 shows the hero, ₹ at stake and Tax you can still save; Follow-through and Last review sit behind "More stats" (§1.5).
- **Ask the analyst** asks `/ai/status` only when its `details` is opened (T3: fetched on expand).

### W2-F2 builder decisions (Home)

- **`since` is the visit before this session's.** Home reads `lastVisit:<scopeKey>` once per portfolio per app session (a module-level map), so the 30 s write of today's date never changes the `since` later revalidations send. It writes the browser's local date after 30 s on Home and on `pagehide`; a visit shorter than 30 s that ends inside the SPA does not count. A stored value the server rejects (400) is dropped and the brief is re-read without `since`.
- **Every chart range is a slice of the ALL payload** (A16): 1M/6M/1Y keep the last 31/183/366 days. Only a slice with fewer than 8 points (a long history downsampled to ~400 points) fetches its own range; that payload is not snapshot-cached. The ALL payload is snapshot-cached under `snapshotKey('perf', scopeKey, 'ALL')`, so T2 also paints at once on later visits.
- **The market sparkline plots ₹ value against the "same money in Nifty 50" ₹ series** (`series[].value` / `series[].NIFTY50`, last 365 days of ALL). `series[].index` is the portfolio's TWR index and has no Nifty counterpart, so §4.4's "index/NIFTY50" pair is read as the two ₹ lines. While `on_track.market` is `pending`, card and Stat 3 use `story.market_compare`'s rule on the ALL payload: excess = NIFTY50 `excess_xirr`, diff = `totals.value − end_value`, since = `metrics.start`, then `statusFromExcess`.
- **A pending market card is `info` with the word "Comparing"** (VerdictCard takes a Status). The habit card with SIP plans but no adherence score (P0) is `unset` with the word "Not scored yet", so it never reads "Not set" while plans exist.
- **Do this now.** Cards come from `brief.actions` (≤3 shown). A card changed from its ⋯ menu is hidden at once while `ActionService.find(id)` is no longer open, and the brief is re-read 1.5 s later; a failed POST (the service restores it as open) brings the card back. The footer count is every visible action once `/actions` has answered (open + planned), else `count_now + count_month`. On desktop the three cards sit in a 3-column row (each card stacks its CTA under the body) to meet the §9.4 fold.
- **Onboarding steps (`onboard:*`) render as plain action-styled cards without the ⋯ menu**, because their ids are not in `ACTION_PREFIXES` and a status POST would be refused. Their button goes through `ActionRunner.run`; guests see "View".
- **Allocation rows** show the share of the targeted classes (`target + drift`, the basis drift is measured on) when any target is set, else the portfolio share, with the target tick on the same scale. Rows are sorted by value, ≤8; a donut slice opens `SEGMENT_META[segment].route`.
- **Explains lines.** You vs the market → "Against the market · {status}"; What drove it → "Portfolio value · {hero status}"; Where your money is → "Mix · {Mix vital}"; Coming up → "Do this now · {hero status}".
- **Desktop vitals keep value and note to one line each** (ellipsis) to hold the ≈64px row; phones wrap them in full. Phone order (act → watch → unset → good) is CSS `order` from `byStatus`, so the DOM and screen-reader order stays the fixed desktop order.
- **Hero.** The verdict sentence and the context line share the hero's last row. Phones hide the `inrWords` line and the Nifty chip and keep the status word for screen readers only (the icon stays), which keeps the hero ≈240px at 390px. `prices.last_refresh` is read as UTC when it has no zone, as the shell does.
- **Measured on a mocked API (synthetic data, headless Chrome):** at 1280×800 the hero is ≈180px and the head, hero, vitals, the Do-this-now header and all three action cards end at ≈690px, so T0 and T1 actions sit above the fold. The 520px sum in §9.4 assumes 150px cards; real cards with an impact, confidence and due row are ≈170px. At 390px the hero is ≈240px and the top action ends within 1.5 screens.
- **Removed:** the asset-class table, Markets today, Money calendar, Where to put your next money and Habits, with their CSS (`.alerts`, `.pulse-grid`, `.mem`, `.side`, `.summary`, `.mk-*`, `.nm-*`), and `pulse.components.ts` / `story.components.ts` (only Home imported them). Home no longer calls `/pulse`, `/markets` or `/rebalance`.

### W2 integrator decisions

- **`planGuard` keeps the fragment.** `/plan?tab=goals#goal-<id>` (actions.py `goal:*`) goes to `/goals#goal-<id>`, and `/plan?tab=retirement#x` to `/forecast?tab=retirement#x`. E19 only named the query parameters; dropping the anchor was not intended.
- **ForecastComponent follows `?tab`.** It subscribes to `queryParamMap` instead of reading the snapshot once, because the router reuses the component when an interim redirect (`/risk#stress`, `/risk#risk`, `/risk`, `/recurring`, `/plan?tab=retirement`) lands on `/forecast` while it is already open. Retired when W4-F1 replaces the interim redirects.
- **`ActionsResponse.notes` reaches the page (E4).** `ActionService.normalise` keeps `notes` (strings only) and exposes `notes()`. The Actions page shows one `notice warn` line ("Some checks were skipped this time…") under the filter chips when it is non-empty and the load did not fail. Home and the bell do not show it.
- **Integrator check E16 holds.** `test_api.py::test_brief_risk_vital_is_the_optimizer_estimate` (W2-B1) asserts the brief Risk vital shows `optimizer.suggest(...)['current']['vol_pct']`, with and without a profile; `test_assumptions.py` (W2-B2) pins that value to `mu_sigma(weights_from_positions, rated_book)`. No extra test is needed.
- **Known interim link targets** (land on a real page, but the tab or anchor arrives later): `/settings#cushion` (W5-F7), `/tax?tab=save|whatif` (W5-F4), `/p2p?tab=defaulted|overdue` (W4-F3), `/cash-flows?view=past` (W4-F2), `/actions?tab=review` from the brief context line (W7-F4; lands on Actions · All), `?preset=` on `/goals` (W5-F1).

### W2 review fixes

- **The shared action inputs are keyed on `perf_ready`.** `_action_inputs` is memoised on `('action_inputs', scope, settings, today, perf_ready)` and `/actions` on `('actions', scope, owner, settings, today, actions_rev, perf_ready, data_status)`. `plan.retirement` (built with `build_history=False`) blends in the user's own record once `/performance?range=ALL` is warm, so Home's retirement row, the Plan dot and `retirement:gap` now match the Retirement tab after it warms instead of keeping the cold estimate until the next write. This amends the W2-B1 note "The actions path never reads performance" for the retirement source only: `build_insights` still gets no history metrics, so `perf:*` rows are unaffected. The day's KPI snapshot is still written once per (owner, date) (E7), so a snapshot taken before the warm-up keeps the cold retirement probability.
- **`/actions` ranks with the Data vital (SPEC §1.7).** `_build_actions` passes `vitals=[{key: 'data', status}]` to `build_actions`, with the status from `brief._data_vital` at request time (part of the memo key, because it depends on the clock). A `data:*` action is `now` on `/actions`, the Actions page, the nav badge and the bell whenever it is `now` on Home. The brief re-ranks the same list with its own Data status, so the two never disagree.
- **Tax moves are the `tax:*` ids.** `actions.is_tax_move(a)` (and `isTaxMove` on the Actions page) = category `tax` and an id starting `tax:`. `summary.tax_open` (the Tax badge and the FY-window context line), "Tax you can still save" and "N tax moves open" count only these. `elss:unlocked:*` stays in the tax category and in ₹ at stake (unlocked principal to reinvest, like `fd:maturing`), but it is not tax saved.
- **Loss-harvest saving walks the tax lines (amends §1.7's "offsettable × top rate" and the W2-F3 note).** `actions.loss_harvest_saving(tax, offsettable)` = Σ min(remaining, line.taxable) × rate over `tax_lines`, highest rate first. It never exceeds `estimate.capital_gains_tax`, since gains already shielded by the exemption or taxed lower save nothing extra. The `tax:loss-harvest:<FY>` impact and the Actions "Offset gains with losses" card both use it; with no taxable line the card shows the offsettable amount ("of gains offset"). The close rule recovers the first-seen offsettable by inverting the walk over today's lines (`_offset_for_saving`), extending a saving larger than today's whole CG tax at the lowest rate.
- **Partial-year Monte Carlo shocks scale with √f (amends E17).** A final partial year of fraction f grows by `exp((ln(1+μ) − σ²/2)·f + σ·√f·Z)`: the mean of the log-return scales with f and its variance with f (σ²f). Scaling the whole exponent by f understated the last year's risk, so the "75%" SIP cleared the target in only about 70–73% of independent futures. Instalments are unchanged (12·f, mid-year, × √growth).
- **Est. basis for "Book gains tax-free"** reads "at 12.5% LTCG before the 4% cess": `future_tax_saved` (and the `tax:ltcg-harvest` impact) is harvestable × 12.5% with no cess. The numbers are unchanged.
- **`planGuard` and `marketsGuard` run on query-only navigations.** The `plan` and `markets` routes set `runGuardsAndResolvers: 'pathParamsOrQueryParamsChange'`, so `/plan?tab=goals#goal-<id>` from the bell redirects to `/goals` even while `/plan` is open, and `/markets?tab=performance` reaches `/performance` from Markets.
- **The Actions page planner has no "Open Risk & mix →" link** (`[riskLink]="false"`) until `/risk` is a page (W4-F1/W5), because E19 sends `/risk#rebalance` back to `/actions#deploy`.
- **Colour is never the only cue in the shell (§1.8).** The prices pill shows the Data vital's status icon (`checkCircle` / `alert` / `alertOctagon`, `circleDashed` when unknown) in the vital's colour at every width. The Actions nav count reads "N!" when some are tier now, and every rendering of it (the bottom bar included) carries the aria-label "N to do, some now". The bottom-bar Plan dot has the same label as the others.
- **A failed `/actions` refresh says so.** `ActionService.error()` holds the last load's error and clears on success or on a scope change. While it is set and lists from earlier are on screen, the Actions page shows a `notice warn` ("Showing your last copy · couldn't refresh…") with Retry, as Home, Performance and Markets do.

---

## Wave 3

Prepared against the working tree after wave 2 landed (backend pytest 370 passed). Decisions G1–G16 bind wave 3 and every later wave. They add to Parts A and B and to E1–E20; where they differ from WAVES.md or SPEC.md, they win.

### Ownership and parallel safety

**G1. File lists differ from WAVES.md as follows.**
- W3-B7 also creates `backend/tests/test_insights.py` for the threshold and rule tests. `test_links.py` keeps the link and id pins.
- W3-F1 owns `features/holdings/holdings.component.{ts,html}` (A3). It also owns:
  - `shared/portfolio-tabs.component.ts`, to flip the Holdings home (G14);
  - `shared/ui.ts` and `shared/motifs.ts`, to remove `StatComponent` and `ToranComponent` (E1, D21);
  - `frontend/src/styles.scss`, only to remove dead rules such as `--sidebar-w` (§3.5);
  - `features/reports/reports.component.ts` (D8).
  It deletes `features/analytics/*` and `features/insights/*` (A2, D21).
- No wave-3 task owns any of these:
  - `services.py`, any `api/*.py`, `actions.py`, `brief.py`, `optimizer.py`, `mc.py`, `plans.py`, `assumptions.py` or `story.py`;
  - `test_api.py`, `test_actions.py`, `test_brief.py`, `test_assumptions.py`, `test_mc.py`, `test_plans.py`, `test_wave1_contracts.py` or `test_analytics.py`.

  These tests must stay green. A builder whose change breaks one fixes the cause in its own files. If that is impossible, it reports the failure. It never edits a file it does not own.

**G2. Every engine change is additive or keyword-only (A1). W4-B1 wires all of them.** The new or changed entry points:

| Entry point | Task | W4-B1 passes |
|---|---|---|
| `goals.project_goal(goal, segments, today=None, sims=1000, *, positions=None)` | W3-B4 | `positions=port['positions']` |
| `goals.funding_summary(goals, segments, positions, emergency)` | W3-B4 | `settings.emergencyFund` (or None) |
| `quant.holding_outlook(points, bench_points=None, segment=None, today=None, *, book_key=None, book=None)` | W3-B6 | `assumptions.book_key(position)`, `rated_book(port['positions'])` |
| `markets.market_state(nifty_points, perf_metrics, stress, today)`, `markets.context_line(state)` | W3-B2 | stored ^NSEI closes (D6), ALL metrics, `services.stress` |
| `calendar.upcoming(calendar, cashflow, sip_next_due, ipos, today)` | W3-B1 | `build_calendar(..., horizon_days=90)`, `cashflow(4)` (G13), `plans.next_due(sips, today, 90)` and the scope's `ipos` rows |
| `tax.what_if_sale(...)`, `opportunities.harvest_plan` | W3-B3 | the `GET /tax/what-if` route (ValueError → 400) |
| `build_insights(..., *, open_ids=None)` | W3-B7 | ids of the open or planned `concentration:`/`sector:` rows in the action log |

The forecast payload blocks (G5) need no services change: `project_portfolio`, `retirement_plan` and `stress_test` read `port['positions']`, and `cash_flow_forecast` already has `positions`.

**G3. No import cycle, whatever order the siblings land in.**
- Today `quant.py` imports `goals` at module top. A `goals.py` that imported `mc` at module top would close the cycle goals → mc → quant → goals, and `quant` would read `goals.ASSUMPTIONS` before it exists. So `goals.py` imports `mc` **inside the functions** that use it, with a comment that points here.
- `forecast.py` may import `assumptions`, `mc` and `plans` at module top, and it stops importing `goals`.
- After W3-B6, `quant.py` imports only `domain` and `assumptions` from the package (no `goals`, `optimizer` or `mc`).
- `mc.py` is unchanged. The integrator checks that each of `goals`, `quant`, `mc` and `forecast` imports cleanly on its own, in a fresh interpreter.

**G4. Re-exports keep the unowned tests green.**
- `goals.ASSUMPTIONS = {k: assumptions.ASSUMPTIONS[k] for k in d.SEGMENTS}`: the 8 segment rows, without `MF_DEBT` (`test_assumptions`).
- `forecast.HONESTY = assumptions.HONESTY` (the `{sims}` template is formatted per payload, as today), plus `forecast.INFLATION`, `forecast.P2P_LOSS` and `forecast.SIP_PER_MONTH = plans.SIP_PER_MONTH` (`test_plans`).
- `quant.RISK_FREE` comes from `assumptions`, and `quant.percentile` stays in `quant` (`test_mc`).
- `optimizer._CORR_ROWS` stays. W6-B4, which owns `optimizer.py`, drops it together with the alias test in `test_assumptions.py`.

### Engines

**G5. The forward block (§6.0 rule 2).**
- Every forward payload (goal projection, portfolio projection, retirement, cash-flow forecast and stress) carries:
  - `assumptions` = {`return_pct`, `typical_pct`, `volatility_pct`, `inflation_pct`, `basis`, `hash`};
  - `honesty` (from `assumptions.HONESTY`, with `p50` formatted for the sims used);
  - `note`.
- `hash` = `assumptions.book_hash(book)`, where `book` is the one the numbers came from: `rated_book(positions)` when the payload had positions, otherwise `effective_book(None)`.
- `typical_pct` = `typical(μ, σ) × 100`.
- Existing keys stay. These include projection `assumptions.mix` and `own`, and retirement `inputs.return_pct` and `volatility_pct`. When a payload already has a top-level `assumptions` dict, the block's keys are added to it.
- The cash-flow and stress blocks describe the portfolio's own Book mix. Their `basis` names what that payload assumed, for example "P2P repayments net of a 3% a year expected loss" or "shocks on today's values; recovery at long-run returns".
- Wherever a payload lists rows by segment for display, `MF_DEBT` is reported under `Mutual Funds`. The row's return and volatility are then the value-weighted mean of the two keys. μ and σ themselves always come from `mu_sigma` over Book keys. Stress is the one exception (G8).

**G6. Goals on the Book (W3-B4).**
- **Weights.** Without `positions`, the weights are each allocated segment's value × pct (as today), or the pct alone when those values are 0. With `positions`, each allocated segment's share is split over Book keys by its open positions, so a debt fund lands on `MF_DEBT`. The weights are normalised to 1.
- **μ and σ.** `book = rated_book(positions)` (or `effective_book(None)`), and `(μ, σ) = mu_sigma(w, book)`. `expected_return` overrides μ only.
- **Required SIP.** `required_sip = mc.required_sip_for(current, months, μ, σ, target, 0.75, seed=goal id or 7)['sip_75']`, and the new `required_sip_typical` is the helper's `sip_typical`. With `months ≤ 0`, `required_sip` stays None.
- **Status.** `status = assumptions.status_for(probability, achieved=current ≥ target)`.
- **Unchanged.** The monthly Monte Carlo (seed = goal id, `sims`), and `projected`, `shortfall` and `path` at μ.
- **Tests (D3).** (a) Exact on the helper's own draws: the probability at `sip_75` is ≥ 0.75, and at `sip_75 − ₹100` it is < 0.75. (b) The engine's probability at `monthly_contribution = required_sip` lies in 75 ± 8.

**G7. `funding_summary(goals, segments, positions, emergency)` (W3-B4).**
- **Cushion.** The cushion is the open positions whose id is in `emergency.instrument_ids`, and `cushion.amount` = Σ their value. `emergency.cash_amount` (A25) is reported as `cushion.cash_amount` but never subtracted, because it is not in the portfolio. With `emergency` None, the cushion is 0 with no ids.
- **Cushion-free values.** A segment's cushion-free value = max(0, segment value − Σ cushion position value in that segment). Every earmark is computed on these.
- **Earmarks.** `earmarked[].amount` = Σ over the goal's segments of cushion-free value × pct/100. In an over-allocated segment (Σ pct > 100), each goal's share is scaled by 100/Σ pct, so no rupee is counted twice. Such a row also carries `unscaled`.
- **Totals.** `total` = Σ segment values, and `free` = max(0, total − Σ earmarked − cushion.amount).
- **Over-allocation.** `over_allocated` = [{`segment`, `claimed_pct`, `goals`: [{`goal_id`, `name`, `pct`}]}] for every segment with `claimed_pct` > 100.

**G8. Forecast on the Book (W3-B5).**
- **`blended_assumptions(segments, perf_metrics, *, positions=None)`.** μ and σ come from `mu_sigma`, over `weights_from_positions(positions)` with `rated_book(positions)`, or over the segment value weights with the default book. The 730-day blend and its clamps stay as they are, and so does the σ floor of 0.02. The result adds `typical_pct`, `hash` and `book`. `project_portfolio` and `retirement_plan` pass `port.get('positions')`.
- **Retirement.** `required_sip` = `mc.required_sip_for(current, years × 12, μ, σ, corpus_needed, 0.75, step_up, seed=7)['sip_75']`, and the new `required_sip_typical` = its `sip_typical`. Status comes from `assumptions.status_for`, with the gap fallback only when the probability is None. Tests follow D3: (a) is exact on the helper's draws, and (b) the engine's probability with `monthly_sip = required_sip` lies in 75 ± 8.
- **Cash flow (§6.6 rule 6).** SIP rows come from `plans.due_dates(plan, tomorrow, end of the last month)`, each instalment at `plans.planned_amount(plan, due)`. Rule 7 (the EPF exclusion) and `monthly_sip_total` are unchanged.
- **Stress.** `MF_DEBT` holdings (`assumptions.book_key`) never take the equity MF shock. They take the rates shock of **−4% in the `rates`, `covid` and `gfc` scenarios** (rates or credit stress), and 0 in `correction`, `rupee`, `gold` and `p2p`. SPEC §6.8 says "−4% in every scenario", but read literally that puts a debt-fund loss into a gold-only or rupee-only shock.
  - They appear as their own row: `segment: 'Mutual Funds (debt)'`, `book_key: 'MF_DEBT'`.
  - They are left out of `market_exposed_pct`.
  - Recovery uses the Book μ of each key, `MF_DEBT` included. `RECOVERY_RATE`'s numbers already equal the Book's.
  - A port without `positions` (the test fixtures) is not split.

**G9. Risk on the Book (W3-B6).**
- **Book access.** `book_key`, `CORR`, `effective_book`, `mu_sigma`, `rated_book`, `RISK_FREE` and `P2P_LOSS` come from `assumptions`. The local `DEFAULT_BOOK`, `_book_key`, `_DEBT_MF`, `_MF_DEBT_CORR`, `_corr`, `model_volatility` and `DRIFT_PRIOR` go. `holding_stats(points, book_key, book=None, *, bench_points=None)`, with `book=None` meaning `effective_book(None)`.
- **The cone (`holding_outlook`).**
  - The key is `book_key` (default: the `segment` argument), and μ is that key's Book μ.
  - σ = `holding_stats(points, key, book, bench_points=bench_points)['sigma_used']`.
  - The cone's continuous drift is ln(1 + μ), so its median after one year equals `typical(μ, σ)`. The 3-year CAGR and momentum are never used for the cone; `cagr_3y_pct` and `momentum` stay as descriptive fields.
  - The payload's `assumptions` keeps `drift_pct` (Book μ) and `volatility_pct` (σ used), and adds `basis`, `data_quality`, `hash` and `cone_label = HONESTY.signal`.
  - Under 30 closes the result is still None (§7.8).
- **The model block.** `model.vol_pct` = `mu_sigma(weights_from_positions(held), rated_book(held))` σ: the same number `optimizer.suggest()['current']['vol_pct']` gives for those positions, and so the same as the brief's Risk vital.
- **Ballast.** P2P accrues min(rate − `P2P_LOSS`, `P2P_MU_CAP`) per position (E15), and a defaulted loan accrues 0. FD, EPF and NPS default to the Book's rates.
- **Not decided here.** The 400-day risk lookback lives in `services.py`. W4-B1 decides whether to lengthen it (E12).

**G10. Insight rules (W3-B7).**
- **Ids stay frozen (A8, D11).** No period keys are added; `review:due` keeps its rule and its id.
- **Concentration.** It fires only at weight ≥ 15 (MF ≥ 25), severity `warning`; the old 10–15 info band goes.
- **Sector.** It fires at share > 30, severity `warning`. `amount` stays the sector's value, which `actions.py` reads.
- **Hysteresis ("closes below 12 / 28").** It needs the action log, which a pure insight engine does not have. So `build_insights` gains `*, open_ids=None`. When `concentration:<iid>` is in `open_ids`, it keeps firing while weight ≥ limit − 3 (12, MF 22). When `sector:<name>` is in `open_ids`, it keeps firing while share ≥ 28. With `open_ids=None` there is no hysteresis. W4-B1 passes the ids of the open or planned rows (G2).
- **Drift and harvest.** Drift (warn ≥ 5, info ≥ 2.5) and `tax:ltcg-harvest` (warning in Jan–Mar) are already right; they get pinning tests. `tax:ltcg-harvest` now also needs `remaining_exemption ≥ actions.HARVEST_FLOOR` (A12; `insights` imports the constant, and `actions` imports nothing from `insights`).
- **`nps:nav-stale:<iid>` (new).**
  - It fires for an open NPS position with value > 0, no `symbol` (hand-priced) and a `price_at` more than 30 days before `today`.
  - Severity `info`, category `data`, link `/nps`, amount = the position's value.
  - Hand-priced NPS positions leave `data:stale-prices`.
- **`elss:unlocked:<iid>`.** It exists already and gets a test.
- **Links.**
  - `targets:missing` → `/risk#mix` (D11; E19 still sends that to `/settings`).
  - `data:stale-prices` → `/settings#prices`, matching the Data vital (the wave-1 open issue).
  - `diversification:stocks` → `/holdings/equity`, matching §8.3 and `actions.py`.
  - `goal:<id>` → `/plan?tab=goals#goal-<id>` (`planGuard` keeps the fragment).
- **The reserved kwargs** (`cushion`, `risk_est`, `stress`, `snapshot_then`, `adherence`, `book`) stay accepted and ignored. Every §8.3 row that reads them is an `actions.py` source.

**G11. Tax what-if and harvest plan (W3-B3).**
- **Signature.** `what_if_sale(port, txns, instruments, instrument_id, qty, price=None, sell_date=None, slab_rate=0.30, *, today=None)`. SPEC's order put a required argument after the defaults.
- **Errors.** Errors are `WhatIfError(ValueError)` with the §6.9 messages:
  - no such holding in scope;
  - not tradable;
  - qty ≤ 0, or qty > the open quantity ("You hold only N units");
  - ELSS units still locked on `sell_date`: they name `next_unlock`, and the check is qty > the units unlocked by `sell_date`;
  - no price;
  - `sell_date` before today, or more than 365 days ahead.
- **Price.** It defaults to `position.price` (D16). In USD, proceeds = qty × price × `port.usd_inr`, and `amount_fc` = qty × price.
- **Lots.** They come from `run_fifo` on the instrument's transactions plus one synthetic SELL on `sell_date`, so same-day buys match as intraday exactly as the ledger does. The hypothetical realised lots are the ones the synthetic sell creates.
- **Tax.** Tax = `compute_tax(port + lots, fy_of(sell_date)).estimate.total` − `compute_tax(port, that fy).estimate.total`.
- **Wait hint.** When a consumed lot is short-term and turns long-term within 90 days, the sale is recomputed on the latest such `lt_on`.
- **The note** adds D12: "Brokerage, STT and stamp duty from imports are not deducted."
- **`harvest_plan`** (§6.9) goes into `opportunities` only for the current FY. Otherwise it is `{rows: [], total_gain: 0, future_tax_saved: 0, note}`.
  - It stops at `remaining_exemption − ₹1,000`.
  - `future_tax_saved` = total_gain × 12.5% **without cess**, the same basis as `ltcg_harvest.future_tax_saved` and the "before the 4% cess" label (W2 review fixes). §6.9's ×1.04 is dropped so the two figures never disagree.
  - The existing `ltcg_harvest` keys are unchanged.

**G12. Market state (W3-B2).**
- **Short history.** With fewer than 200 closes it returns None (D6).
- **The Nifty figures.**
  - `price` is the last close;
  - `d1` = last ÷ previous − 1;
  - `w1` = last ÷ the close 5 trading days earlier − 1;
  - `from_high_pct` = last ÷ the maximum of the last 252 closes − 1.
- **Mode**, checked in this order: crash (from_high ≤ −20 or w1 ≤ −8), correction (from_high ≤ −10), volatile (|d1| ≥ 2.5), otherwise normal.
- **You.** `you.from_peak_pct` = `perf_metrics.current_drawdown` (the TWR drawdown, so new money is not counted as a loss). `you.from_peak_inr` = −`end_value` × |dd| ÷ (1 − |dd|). Both are None without metrics.
- **Comparable.** `comparable` = the mildest stress scenario whose `impact_pct` ≤ your drawdown. When none qualifies, or `stress` is None, it is the `correction` scenario (label "Market correction" if `stress` is missing). It adds `smaller: bool`, which is true when your fall is smaller than that scenario. It is null when `you` is unknown.
- **`since`** is the date of the 52-week high in correction or crash, and otherwise the last close's date. `as_of` is also added.
- **Playbook.** `playbook` is a fixed list of calm lines in correction and crash, and `[]` otherwise.
- **`context_line(state)`** returns the §4.1 sentence as {`kind: 'market'`, `text`, `link: '/markets'`}, or None outside correction and crash. Rupees use a local lakh/crore formatter.

**G13. Upcoming money (W3-B1).**
- **Events kept.** Calendar events except `national`; cash-flow events of kind `fd_maturity` and `p2p_close`; `sip_next_due` (the `plans.next_due` shape); and IPO open, close, allotment and listing dates. Only dates in [today, today + 90] count; `p2p_overdue` and anything dated in the past are dropped.
- **Event shape.** Each event is {`date`, `days`, `kind`, `title`, `amount`, `direction` ('in' | 'out' | null), `link`, `key`} plus an optional `note`.
- **Mapping.**
  - SIP: kind `sip`, out, `/recurring`, key `sip:<plan_id>:<date>`.
  - FD maturity: kind `fd_maturity`, in, `/fixed-deposits`, key `fd:<iid>`.
  - P2P close: kind `p2p_close`, in, `/p2p`.
  - IPO: kind `ipo`, `/markets?tab=watchlist`, key `ipo:<id>:<field>`, no amount.
  - Calendar `personal` FD events become `fd_maturity` with amount None. Other calendar events keep their kind, link and key, with no amount.
- **Dedupe.** FD maturities are deduped by (instrument_id, date), keeping the cash-flow event.
- **Order and cap.** Sorted by date, then by kind in the order tax, fy, fd_maturity, p2p_close, sip, ipo, festival, personal; at most 30.
- **Totals.** `inflow_90d` and `outflow_90d` are Σ `inflow` and Σ `outflow` of `cashflow.months` rows inside the window. The month that holds today + 90 counts pro rata by its days inside the window. W4-B1 passes `cashflow(4)` so the rows cover the whole window. That way the header includes EMIs, dividends and interest, which have no single event.
- **Pass-through.** `theme` and `next_festival` come from the calendar. `build_calendar` stays exactly as it is (`test_links.py` pins its keys and links); W4-B1 calls it with `horizon_days=90`.

### Frontend

**G14. The Holdings hub (W3-F1).**
- **Holdings home.** `PORTFOLIO_HOLDINGS_HOME` becomes `'/holdings/all'` and `withAll` defaults to true. This applies the W1-F1 follow-up a wave early, because the page now exists. The `/holdings` redirect, the nav Portfolio slot and Home's fallback links follow the constant. `app.routes.ts` is not touched: `holdings/:assetClass` already matches `all`.
- **Unknown or dedicated classes.** An unknown `assetClass` goes to `/holdings/all`. A class with its own page (`p2p`, `fixed_deposit`, `cash`, `epf`, `nps`) goes to that page. Both use `replaceUrl`.
- **h1.** It reads "Holdings" on `all` and the class label on a class page (A22).
- **Needs attention.** The strip is filtered by link only (A7):
  - on `all`: `['/holdings', '/holding/']`;
  - on a class page: `['/holdings/<class>', '/holding/<id>' and '/tax?tab=whatif&whatif=<id>' for that class's positions]`. `linkUnder` keeps `/holding/1` from matching `/holding/12`.
  - `data:missing-prices` stays on Home and Settings.
- **Column chooser.** It is saved under `localStorage['holdings:cols:<class>']`, and every read and write is wrapped in try/catch.
- **Family view** is `auth.canSwitch() && !auth.portfolio()`. Its By-member grouping uses `positions[].owner`, named from `auth.members()`.
- **Deletions.** It deletes `features/analytics/*` and `features/insights/*`, `StatComponent` and `ToranComponent`, and `--sidebar-w`, after a grep shows nothing uses them.
- **Left for W5-F1.** The duplicate `STATUS` maps in `goals.component.ts` and `forecast/retirement.component.ts` belong to the Plan rewrite.
- **Reports** follows `queryParamMap` for `?r=` (D8), so `/reports?r=summary` works while Reports is open.

### Follow-ups recorded for the wave-4 preparation

**G15.**
- **`brief.py` has no owner in WAVES.md wave 4**, but P1 needs it:
  - the market context line (use `markets.context_line`);
  - `assumptions_check`;
  - `upcoming` and `market_state` passed through;
  - the local debt-MF regex replaced by `assumptions.book_key`.

  The wave-4 lead should add `brief.py` and `test_brief.py` to W4-B1.
- **W4-B1 wires G2**, plus everything it already has: `skipped` (D23), the `book_hash` memo keys, and `/tax/what-if`.
- **W6-B4 drops `optimizer._CORR_ROWS`** (G4).

**G16. Integrator checks for wave 3.**
1. Full backend pytest, `ng build` and `npm run check`.
2. Fresh-interpreter imports of `goals`, `quant`, `mc` and `forecast`, each on its own (G3).
3. On a fresh copy of the scratchpad database, through the Python modules:
   - a forecast and a retirement payload carry `assumptions.hash`;
   - `quant.portfolio_risk(...)['model']['vol_pct']` equals `optimizer.suggest(...)['current']['vol_pct']`;
   - `calendar.upcoming` built as G2 describes, with its totals;
   - `market_state` on the stored ^NSEI closes, or None when there are fewer than 200;
   - `what_if_sale` on a real holding;
   - `harvest_plan`.
4. Every wave-3 link passes `test_links.route_ok`.
5. `/holdings`, `/holdings/all` and a class page build and navigate. The manual width checks still need a safe test login.

### W3-B1 builder decisions (`calendar.upcoming`)

- **Keys.** These add to G13:
  - A P2P close with an `instrument_id` is keyed `p2p:<iid>`. A folded one (no instrument) is keyed `p2p:<YYYY-MM>`, the month of its date.
  - The IPO `<field>` in `ipo:<id>:<field>` is the column name: `open_date`, `close_date`, `allotment_date` or `listing_date`.
- **Titles.** The titles are:
  - `SIP · <name>` for a SIP;
  - `FD matures · <name>` for an FD (the calendar's own wording);
  - `<n> P2P loans finish repaying` for folded P2P closes, and `<name> is fully repaid` for one loan;
  - `<name> IPO opens|closes|allotment|lists` for an IPO.

  The cash-flow events keep their `note`. An IPO close the user has not applied to gets the note "Last day to apply.". An applied allotment gets "You applied: check whether you were allotted shares.".
- **Direction of a calendar-only FD.** A calendar `fd:<id>` event that has no cash-flow counterpart becomes `fd_maturity` with `direction: 'in'` and `amount: None`. FD maturities are deduplicated on (instrument id, date) only. If the two sources disagree on the date, both rows stay.
- **Ties and unknown kinds.** Ties after (date, kind order) are broken by `key`, so the order is deterministic. A kind outside the G13 order sorts last on its day.
- **Totals are `None` when `cashflow` is None** (unknown, not ₹0). Otherwise they are the sum of whatever rows fall in the window, rounded to 2 places. The first month (today's) counts in full because the cash-flow engine already drops anything dated on or before today. If the rows do not reach the end of the window, only the rows that exist are summed.
- **Inputs are defensive.** Any input may be None. Dates may be ISO timestamps, and only the first 10 characters are read. An unreadable date drops that event.
- **Constants.** `UPCOMING_DAYS = 90`, `UPCOMING_CAP = 30` and `UPCOMING_KIND_ORDER` are module constants. `build_calendar` is unchanged and still defaults to 75 days.

### W3-B2 builder decisions (`markets.market_state`, `markets.context_line`)

- **Input.** `nifty_points` may be (date, close) pairs (what `px.ensure_history` returns and what W4-B1's `px.stored_history` should return) or {date, close|value|price} dicts, in any order. Closes that are non-positive, unreadable or dated after `today` are dropped, and one close per day is kept, before the 200-close check. `today` may be a date, an ISO string or None (the real today).
- **Rounding.** `d1`, `w1` and `from_high_pct` are rounded to 2 dp, and the thresholds are tested on those rounded figures, so the payload never shows −10.00 with mode `normal`.
- **Extra keys.** `nifty` also carries `high` and `high_date` (the latest day the 52-week high was set). `since` equals `high_date` in correction and crash. `as_of` is the last close's date, not `today`.
- **Comparable.** Only scenarios with `impact_pct < 0` count, so the rupee and zero-impact scenarios are never "comparable". On a tie the first scenario in stress order wins. Equal impact is not `smaller`. Its shape is {`key`, `label`, `impact`, `impact_pct`, `smaller`}.
  - When stress is None, or has no `correction` row, the fallback is a stand-in {key 'correction', label 'Market correction', impact None, impact_pct None}. Its `smaller` is measured against a nominal −10%, the correction scenario's Indian-equity shock.
- **You.** `from_peak_inr` needs both `current_drawdown` and `end_value`. With a drawdown but no end value, `from_peak_pct` and `comparable` are still filled.
- **Playbook.** `markets.PLAYBOOK` holds five fixed lines. Each state gets its own copy.
- **Context line wording.**
  - It opens with "Nifty is N% below its high." A crash set off by the week adds ", after an N% fall this week".
  - The comparison reads "smaller than", "about the size of" (not smaller and within 1 pt) or "deeper than". Then comes "the routine-correction scenario" for key `correction`, otherwise "the <label> scenario".
  - With no rupee figure it says "You're N% below your peak.", and at a 0% drawdown "Your portfolio is at its peak.". When `you` is unknown it drops the sentence.
  - It always ends "Your SIPs are the plan; nothing needs selling.". It has no "Playbook →" suffix, because the other context lines in `brief` leave their arrow to the UI too.
  - Rupees use `markets._inr_compact` (₹1.23 Cr, ₹3.4 L, else Indian grouping), the same format as `brief._inrc`.
- **Real data.** On a DB copy, the 896 stored ^NSEI closes give mode `normal` (−4.9% from the 2 Jan high, as of 6 Nov) and no context line.

### W3-B4 builder decisions (`goals.project_goal`, `goals.funding_summary`)

- **Imports (G3).** `goals.py` imports `assumptions` at the top and `mc` inside `project_goal` only. `test_goals.py` checks that `goals` and `quant` each import cleanly in a fresh interpreter, and that `mc` is not a top-level import.
- **Weights.** Unknown keys (a segment the Book does not know) are dropped before the weights are normalised, so they never dilute μ. A segment with no open position keeps its own key when `positions` are passed. Positions are matched to a segment by `position.segment`, else `domain.segment_of`.
- **A goal with no allocation.** Its weights are the whole portfolio's mix: `weights_from_positions(positions)`, else the segment values. With an empty portfolio it is assumed to be a diversified mutual fund (the Book's `Mutual Funds` row). This replaces the old local fallback of (10%, 12%), which would have been a second copy of the numbers (§6.0 rule 1). `current` stays 0.
- **Required SIP.** Both `required_sip` and `required_sip_typical` are the helper's whole rupees (rounded up), returned as floats. They are 0 when the target is already met, and both are None when no months are left, even for an achieved goal (as before).
- **Status input.** `status_for` gets the rounded percentage (`probability`), so the label always agrees with the number shown.
- **The block.** `assumptions.basis` names the source: "the goal's allocation, by value" (or "the goal's allocation" when the values are 0), plus ", split by your holdings" when positions split a segment. With `expected_return` it reads "your expected return of N%; volatility from …". `honesty` is `assumptions.HONESTY` with `p50` formatted for `sims`, as in `forecast`. `note` ends with `HONESTY.disclaimer`. The block has no `mix` key.
- **Hash.** It is `book_hash(rated_book(positions))` when positions are passed, else `book_hash(effective_book(None))`. With no FD, EPF or P2P holding the two hashes are equal, which is right: the numbers are the same.
- **Funding.**
  - `emergency` may be the `emergencyFund` setting or the brief's `Cushion`: only `instrument_ids` and `cash_amount` are read.
  - `cushion.instrument_ids` lists the ids that matched an open position with value > 0, in position order. Ids of closed, zero-value or unknown instruments are left out, so the list explains `amount`.
  - Scaling applies when `claimed_pct > 100`, with a 1e-9 tolerance. `unscaled` appears on a goal's row when any of its segments was scaled.
  - `over_allocated` is ordered by `domain.SEGMENTS` and lists each claiming goal with its pct. `free` is computed from the rounded earmarks, so `Σ earmarked + cushion.amount + free = total` to the paisa (when nothing is over-claimed beyond the total).
  - Goal allocations may be JSON strings or dicts (`parse_allocation`).
- **Real data.** On a DB copy (no saved goals), synthetic goals over the real portfolio give probabilities of 77.8% and 72.6% when the SIP equals `required_sip`. Funding detects a 130% claim on Equity (India), with Σ earmarked + cushion ≤ total.

### W3-B3 builder decisions (`tax.what_if_sale`, `tax.harvest_plan`)

- **Interface.** `what_if_sale(port, txns, instruments, instrument_id, qty, price=None, sell_date=None, slab_rate=0.30, *, today=None)` as G11. `today` defaults to `port['as_of']`, else `date.today()`. `sell_date` accepts a `date` or an ISO string. Every error is `tax.WhatIfError(ValueError)`, which W4-B1 maps to 400. Beyond the G11 list it also rejects a non-numeric or non-positive `price` or `qty`, an unparseable `sell_date`, and a USD holding when `port.usd_inr` is missing.
- **FIFO input.** `run_fifo` runs on the holding's txns dated ≤ `sell_date` plus one synthetic SELL (id 10¹⁵, so it sorts last on its day). The hypothetical lots are the realised lots after the base run's. The open quantity is the same FIFO run's, so "You hold only N units" and the lots always agree.
- **ELSS.** The check is qty > units unlocked by `sell_date`, naming the next unlock (G11). A same-day ELSS buy that the intraday rule would match first is also rejected. A 29 February purchase unlocks on 1 March (`tax._elss_unlock`). `open_lot_view.locked_until` uses the same helper, so it no longer raises on a leap-day lot.
- **Output.** It has the §6.9 fields plus `sell_date`, `fy`, and `amount_fc` and `usd_inr` for USD. `rate_pct` is null for slab-rate lots (intraday, foreign short-term and debt), and `lt_on` is null for intraday lots and slab-only classes. Intraday gains count in `st_gain`. `exemption_used` = after.used − before.used, and `exemption_left` = after.remaining. `effective_pct` = tax_now ÷ gain × 100, or null when gain ≤ 0.
- **Losses.** `tax_now` can be negative when a loss offsets gains already booked this FY. That is the tax saved, and `net_cash` = proceeds − tax_now then includes it. The UI should label a negative `tax_now` "saves ₹N".
- **Wait.** The recompute uses the same price on the latest qualifying `lt_on`, and the 365-day limit does not apply to it. `days` counts from `sell_date`. `wait` is reported only when the saving is above ₹0.005.
- **`compute_tax(..., *, with_opportunities=True)`.** A new keyword. `what_if_sale` passes False (then `opportunities` is None) so its two or four tax runs skip the harvesting scan. Existing callers are unchanged.
- **Harvest plan and FIFO.** A sale is matched FIFO, so a plan cannot sell a newer lot before an older one. Each holding offers its open lots oldest first and stops at the first lot that does not qualify (short-term, a loss, or ELSS-locked). The greedy order by gain/value runs over each holding's next lot. A ratio tie goes to the lower instrument id.
- **Partial lot.** It is rounded down: to whole shares for `asset_class == equity`, to 0.001 units otherwise. So `total_gain` ≤ remaining − ₹1,000. When the rounded quantity is 0 the plan stops without a partial. Rows keep the pick order, and each lot carries `partial: bool`.
- **The note** for both functions is the D12 sentence, joined after the slab note (what-if) or the rebuy note (harvest plan). Outside the current FY the plan is `{rows: [], total_gain: 0.0, future_tax_saved: 0.0, note}`.
- **Real data.** On a DB copy: 28 open tradable holdings, 26 priced. One ELSS fund is rejected because it is partly locked (next unlock is named) and one fund has no price. The current-FY harvest plan books ₹2,234 from one fund (9 whole lots), with ₹125,000 of exemption remaining.

### W3-B7 builder decisions (`insights.py` P1 rules)

- **Ids.** Every pinned id is unchanged (A8). The only new id is `nps:nav-stale:<iid>`. `review:due` keeps its id and its "no review, or more than 90 days ago" rule; `actions.py` makes `review:due:<YYYY-Qn>`.
- **Thresholds are module constants.** `CONCENTRATION_LIMIT = 15`, `CONCENTRATION_LIMIT_MF = 25`, `CONCENTRATION_HYSTERESIS = 3`, `SECTOR_LIMIT = 30` (strictly above), `SECTOR_CLOSE = 28` (at or above), `DRIFT_WARN = 5`, `DRIFT_INFO = 2.5` and `NPS_NAV_STALE_DAYS = 30`. Concentration and sector rows are always `warning`; the old info bands (concentration 10–15, sector 30–40) are gone.
- **Sector share is rounded to 6 dp before the test,** so ₹300 of ₹1,000 counts as 30% (and does not fire) instead of 30.000000000000004%.
- **`open_ids`** accepts any iterable of ids (it is read once into a set). Only `concentration:` and `sector:` ids change anything; an id for a row that is not in the open set gets the open line. `None` and an empty iterable both mean no hysteresis. The concentration exclusions (P2P, FD, cash, closed positions) and the `Unclassified` sector exclusion apply whatever `open_ids` holds.
- **Harvest.** `tax:ltcg-harvest` fires when `suggested_booking > 1000` and `remaining_exemption ≥ actions.HARVEST_FLOOR`. A missing `remaining_exemption` counts as 0, so it does not fire.
- **`nps:nav-stale:<iid>`.**
  - Hand-priced means an NPS position with no `symbol`. Such a position never enters `data:stale-prices`, fresh or not.
  - The age is `today − date(price_at)`, by calendar date (the first 10 characters of `price_at`), against the `today` argument. It fires at more than 30 days, so 31 fires and 30 does not.
  - An unreadable `price_at`, a missing one, `value ≤ 0` or a closed position does not fire.
  - Title "<name> NAV is N days old"; detail and action point to updating the NAV from the latest statement.
- **`data:stale-prices` keeps its wall-clock age (> 4 days against `datetime.now`)** and its `info` severity. Only its link changes (`/settings#prices`). `actions.py` already raises it to `warn` and gives it the `prices_refresh` CTA.
- **Reserved kwargs** stay accepted and ignored, as G10 says. `test_links.test_build_insights_accepts_the_reserved_kwargs_and_ignores_them` still pins that.
- **Tests.** `test_links.py` adds a hand-priced NPS position (NAV 40 days old) to the rich fixture and pins `nps:nav-stale:8 → /nps`, plus the four new links. `test_calendar_links_are_page_list_routes` is unchanged and still passes with the extra position. `test_insights.py` pins the thresholds above.
- **Real data.** On a DB copy, `Services.insights` (no performance) gives 11 rows with valid links: `targets:missing → /risk#mix`, `data:stale-prices → /settings#prices`, and `tax:ltcg-harvest` at ₹2,234 with ₹125,000 remaining. The ledger has no NPS position and no concentration or sector row, so `open_ids` adds nothing there.

### W3-B6 builder decisions (`quant.py` on the Book)

- **Imports (G3).** `quant.py` imports `domain` and `assumptions` (as `A`, plus the re-exported constants `HONESTY`, `MF_DEBT`, `P2P_LOSS`, `P2P_MU_CAP`, `RATE_KEYS` and `RISK_FREE`) and nothing else from the package. Functions are called as `A.book_key(...)` at call time, so the `book_key` parameter names of `holding_stats` and `holding_outlook` never shadow the Book's function, and a test can spy on `assumptions.book_key`. Gone: `DEFAULT_BOOK`, `_book_key`, `_DEBT_MF`, `_MF_DEBT_CORR`, `_corr`, `model_volatility`, `DRIFT_PRIOR` and `BALLAST_DEFAULT_RATE`. `GSPC`, `GOLDBEES`, `NSEI` and `percentile` stay. `test_risk.py` checks the import set with `ast`.
- **Book rows.** `_book_row(book, key)` reads both book shapes, as before. A key missing from a passed book reads the default Book's row. A key the Book does not know (or None) reads the `Mutual Funds` row (`quant.FALLBACK_KEY`), the same "diversified fund" fallback goals uses (W3-B4). It replaces the old local (10%, 12%).
- **The cone.**
  - The drift is ln(1 + μ). The 1Y horizon is exactly 252 trading days, so the 1Y p50 is price × (1 + `typical(μ, σ)`).
  - σ is `sigma_used` with no separate floor. Shrinkage already keeps it at least √0.4 × σ_book.
  - `assumptions` also carries `typical_pct`, the cone's median annual return, alongside the G9 keys.
  - `basis` reads "<label> long-run return of N% a year from the Assumption Book, not its recent trend; volatility N%, <mostly from its own N years of prices | its own prices blended with the <label> average | the <label> average (too few prices of its own yet)>." `MF_DEBT` is labelled "Mutual Funds (debt)".
  - `hash` is `book_hash(book)` of the book the cone used.
  - `DISCLAIMER` now names the class's long-run return and the holding's own volatility, not "the past year's volatility".
  - `beta` and `correlation` in the outlook stay the one-year descriptive figures. The cone does not use β.
- **`portfolio_risk(..., *, book=None)`.** A new keyword-only base book (None = `effective_book(None)`). It feeds the ballast defaults, `holding_stats` and `rated_book(held, book)`. Existing callers are unchanged.
- **Ballast.** The rate is read the way `rated_book` reads it: a missing or 0 `rate` means the Book default. P2P is min(rate − `P2P_LOSS`, `P2P_MU_CAP`); without a rate it uses the Book's net 7%, also capped. A defaulted loan accrues 0, and so does USD cash. The key comes from `assumptions.book_key`.
- **Not changed.** The 400-day lookback (W4-B1, E12) and every output key.
- **Follow-up for the frontend owner.** `outlook-card.component.ts` still says "8 in 10 outcomes, if the next year looks like the past one". It should render `assumptions.cone_label`, with `basis` as the `est.` tooltip (§6.12), and type the new keys in `models.ts`.
- **Real data.** On a DB copy, `portfolio_risk(...)['model']['vol_pct']` = 12.7 = `optimizer.suggest(port, 'balanced')['current']['vol_pct']`. The ballast rate is 11.96%: the 100 open P2P loans are at 36–42% borrower rates, accrue 12% and 0 when defaulted. Measured vs model volatility is 12.9 / 12.7. The cones sit at 12% (India) and 11% (US) drift for every holding, whatever its 3-year CAGR (for example Apollo +83.8% and KEC −20%).

### W3-B5 builder decisions (`forecast.py` on the Book)

- **Imports and re-exports (G3, G4).** `forecast.py` imports `assumptions` (as `A`, plus `book_hash`, `book_key`, `effective_book`, `mu_sigma`, `rated_book`, `status_for`, `typical` and `weights_from_positions`), `mc` and `plans` at module top, and no longer imports `goals`. `INFLATION`, `P2P_LOSS` and `HONESTY` are the `assumptions` objects, and `SIP_PER_MONTH` is `plans.SIP_PER_MONTH`. `_status_for` and the local `STATUS_THRESHOLDS` are gone, so callers use `assumptions.status_for`. `RECOVERY_RATE` stays as a name, built from the Book's μ over the new `MARKET_KEYS`.
- **Weights (`_book_weights`).** With open, valued positions, the weights are `weights_from_positions` against `rated_book(positions)`, with basis "holdings mix". Otherwise they are the segment value weights against the default Book, with basis "segment mix". A key the Book does not know is dropped before the weights are normalised, as in W3-B4. With no holdings at all, μ and σ are the Book's `Mutual Funds` row (basis "diversified mutual fund (no holdings yet)"). That replaces the old local (10%, 12%), as goals and quant do. The record blend appends " blended with your record" to the basis.
- **`blended_assumptions` result.** It also returns `weights` (Book keys), `rows` (the display rows) and, as G8 asks, `typical_pct`, `hash` and `book`. `mix` stays as a {segment: weight} map, with MF_DEBT folded into `Mutual Funds`.
- **The block (G5).**
  - The projection's `assumptions` is the block plus `own` and `mix` (the folded rows). Its `basis` stays the short phrase the page renders after "from your …".
  - Retirement gains a top-level `assumptions`. A `return_pct` input makes its basis read "your return of N%; volatility from your <basis>". `inputs.return_basis` is unchanged.
  - Every block's `typical_pct` is `typical(μ, σ)` for the μ actually used, so a return override moves it. The hash stays the Book's.
- **Honesty.** Projection and retirement carry all of `HONESTY`, with p50 formatted for the sims used. Retirement used to carry only `probability` and `estimate`. Cash flow and stress have no simulated distribution, so they carry only `estimate` and `disclaimer` (`forecast.HONESTY_POINT`). A p50 label there would name a simulation that never ran. The projection gains a `note` that ends with `HONESTY.disclaimer`.
- **Retirement status input.** `status_for` gets the rounded `probability`, as in W3-B4, so the label always agrees with the number shown. `required_sip` and `required_sip_typical` are the helper's whole rupees, returned as floats.
- **Stress.**
  - Every row now carries `book_key`, not only the debt row.
  - The debt split subtracts Σ MF_DEBT position value from the `Mutual Funds` segment value, so `total` is unchanged.
  - Recovery reads μ per key from the payload's Book. This is `rated_book(positions)` when there are positions, so FD, EPF and P2P recover at their holding rates. EPF now uses its Book 8.25% where `RECOVERY_RATE.get(…, 0.07)` gave 7%.
  - The `rates` note adds "debt funds −4%".
- **Cash flow (rule 6).**
  - The window is `plans.due_dates(plan, tomorrow, the last day of the last month)`, each instalment at `plans.planned_amount`, so the step-up counts whole years from the plan's anchor.
  - Plans with amount ≤ 0 are skipped.
  - An instalment earlier in the current month than tomorrow is gone: the first row no longer holds a whole month's SIP.
- **Unowned test broken by rule 6 (reported, not edited).** `test_calendar.py::test_totals_from_a_real_cash_flow_include_money_without_events` (W3-B1) pins the old even spread: "outflow is the two SIPs spread per month", 8,000 × (3 + 12/28). Under rule 6, November holds only the plan due on the 20th, because the one due on the 5th is already past. The total is then 3,000 + 2 × 8,000 + 8,000 × 12/28 = 22,428.57, which is what the engine now returns. The W3-B1 owner or the integrator should change the expectation to that figure. The engine should not go back to the even spread.
- **Tests.** D3 (a) and (b) are parametrised over step-up 0 and 10%. At `monthly_sip = required_sip` the engine gives 76.9 and 76.5, inside 75 ± 8 and even the ± 3 that waves.json once named. The round-trip `sip_out` check now compares with Σ `planned_amount` over `due_dates`, which is 5 or 6 instalments depending on the day of the month.
- **Real data.** On a DB copy (168 positions, no SIP plans):
  - all four payloads carry hash `4ce39bcfbc`, which equals `book_hash(rated_book(positions))`;
  - μ 11.25%, typical 10.35% and σ 12.7%, with σ equal to the Risk model's 12.7;
  - the P2P row is at the 12% cap;
  - a 30→55 retirement plan needs `required_sip` ₹84,123 (typical ₹59,572), and at that SIP the probability is 76.4 (`on_track`);
  - there are no debt funds in this data, so stress has no MF_DEBT row.


### W3-F1 builder decisions (Holdings hub, Reports `?r=`, dead code)

- **Hero verdict (both views).** §1.3 needs one verdict sentence in T0 and §5.3 names none, so the hero says how much of the value rests on a market price: open equity, mutual-fund and commodity holdings without a price are "valued at cost". All priced → good ("All N holdings have a market price"); some → watch; ≥ 5% of the view's value → act (the Data vital's unpriced threshold, P0.7). Price age stays with the shell pill and the Data vital. The status word is in a `sr-only` span beside the icon. T2 cards carry "Explains: Value · {word}".
- **"Invested" means `invested` everywhere on `/holdings/all`.** The hero (Σ `segments.invested`), the summary column and the tfoot all show money put in, all time. The old Home table showed `cost` under that header. The Unrealised % is still on cost (`unrealized_pct`).
- **Summary rows** are every segment with value, money put in, or realised/income history, sorted by value. A fully sold class shows "No open holdings" when expanded. The tfoot reads `totals` (value, today, unrealised, realised + income, XIRR), so the rows add up to it. A row expands to its top 8 open holdings, with "Open {class} →" (or "All N in {class} →") to `SEGMENT_META.route`. Each row has a real button with `aria-expanded`. On phones (≤ 760px) the table is replaced by cards (class, value, today, share, XIRR), with a total line.
- **By class | By member** switches the Breakdown donut and its legend only. The summary table always stays by class, because the backend computes XIRR per segment and not per member. Members are coloured with indigo shades, because `--s1..--s8` are reserved for asset classes (§1.10). A class slice opens its page; a member slice does nothing.
- **Phones keep the hero and two tiles.** The third tile (XIRR on all; Realised + dividends on a class) sits behind "More" (§1.5), as Performance does. The per-class tiles keep their content; only the first one becomes `.kpi.hero`.
- **Column chooser.** Optional columns: Value, Return, Today, Weight, XIRR, Total return, Realised (realised + an income sub-line), and Owner in family view. The default is the first four. The choice is saved as a JSON array under `holdings:cols:<class>`; unknown keys are dropped, and every read and write is wrapped in try/catch. At least one column must stay beside Name. Phones show the first two chosen columns. Sortable headers are buttons inside `th[aria-sort]`. The name is a real link to `/holding/:id`; the row click does the same.
- **Filters reset per class.** Search, India/US, Closed, the group-by and the phone "Breakdown" disclosure are `linkedSignal`s on the view, because the router reuses the component between classes. The class hero is computed from all the class's holdings, never the filtered rows.
- **h1** is `CLASS_LABEL` on a class page, so commodity reads "Commodities" while its chip reads "Gold & silver". An empty class shows "No {label} yet" with "Add your first {noun}" (the chip nouns), plus Import.
- **Redirects** run in an effect, `navigateByUrl(..., {replaceUrl: true})`. The page renders nothing while it forwards.
- **Reports** subscribes to `queryParamMap`. When `?r=` changes (missing = `summary`), it resets the filters and loads that report. `open()` still writes `?r=` with `replaceUrl`.
- **Dead code removed** after a grep found no users: `features/analytics/*`, `features/insights/*`, `StatComponent`, `ToranComponent`, `--sidebar-w`, the `.stat` rules (used only by StatComponent), and `.fill` / `.card.fill > .push` (used only by `pulse.components.ts`, which W2-F2 deleted). `.grid-4` and `.topbar` were never used, but they are not dead code from the removed features, so they stay.
- **Checked on a mocked API** (synthetic data, a mock token, headless Chrome; never the real server or database): `/holdings/all` and `/holdings/equity` at 1280px and in a 390px frame have no horizontal page scroll. Phones narrow the holdings table's padding and hide the avatar, so Name plus two columns fit. `/holdings` and `/holdings/foo` → `/holdings/all`; `/holdings/p2p` → `/p2p`; `/holdings/cash` → `/forex`. The class strip shows `/tax?tab=whatif&whatif=2` and never `/holding/12`. The family view shows By class | By member.

### W3 integrator decisions

- **SIP outflow in the 90-day totals follows the due dates (§6.6 rule 6).** `test_calendar.py::test_totals_from_a_real_cash_flow_include_money_without_events` was written against the old even per-month spread. Under W3-B5's cash flow, November holds only the plan due on the 20th (the one on the 5th is past), so the expected outflow is 3,000 + 2 × 8,000 + 8,000 × 12/28 = 22,428.57. The test now says so; `calendar.upcoming` is unchanged.
- **One ELSS unlock rule.** `portfolio.elss_unlock(buy_date)` (three years on; a 29 February purchase unlocks on 1 March) is used by the holding's `elss` block in `portfolio._tradable_position` and by `tax._elss_unlock`, which now delegates to it. The old `date.replace(year + 3)` in portfolio.py raised on a leap-day lot. Pinned by `test_tax_whatif.py::test_leap_day_elss_lot_unlocks_on_1_march_in_portfolio_and_what_if`.
- **Frontend types follow the wave-3 payloads (additive, all optional).** `models.ts` gains `ForwardAssumptions` (the G5 block), `PointHonesty` (cash flow and stress: `estimate` and `disclaimer` only), `HarvestPlan`/`HarvestPlanLot` (`TaxReport.opportunities.harvest_plan`), `GoalProjection.required_sip_typical/assumptions/honesty/note`, `RetirementPlan.required_sip_typical/assumptions` (its `honesty` is now the full copy), `Projection.assumptions.typical_pct/hash` and `note`, `StressTest.assumptions/honesty` and `rows[].book_key`, `CashFlow.assumptions/honesty`, and `Outlook.assumptions.typical_pct/basis/data_quality/hash/cone_label`. `Upcoming.inflow_90d/outflow_90d` are `number | null` (W3-B1: null when no cash flow was passed), `UpcomingEvent.note` is optional and `Upcoming.next_festival` is a `CalendarEvent` (passed through from `build_calendar`). `MarketState` gains `nifty.high/high_date`, `comparable.impact_pct/smaller` (`impact` may be null for the stand-in) and `as_of`. W4-F1 still adds `WhatIfSale`, `Plan`, `Funding` and `AssumptionsView` with their endpoints.
- **Home's Coming up header** shows "In +₹X · Out −₹Y" only when both totals are numbers, and "Dates ahead" otherwise, so a null total never renders as "+—".
- **The holding Outlook cone is labelled honestly (G9).** The cone head reads "8 in 10 outcomes · {assumptions.cone_label} · {drift}% a year ± {σ}%" with an `app-est` tag whose tooltip is `assumptions.basis`. The old "if the next year looks like the past one" was wrong once the drift came from the Book rather than the holding's own trend.
- **Goal cards carry `id="goal-<id>"`**, so the insight and action link `/plan?tab=goals#goal-<id>` (kept by `planGuard`) lands on that goal's card. W5-F1 keeps the id when it redesigns the page.
- **G16 checks** passed on a fresh DB copy (`w3int.db`, script `w3int_check.py` in the scratchpad): all four forecast payloads carry `assumptions.hash` 4ce39bcfbc = `book_hash(rated_book(positions))`; risk model vol 12.7 = optimizer current vol 12.7; `calendar.upcoming` gives 4 events (in ₹22,002.45, out ₹0, no SIP plans in the copy) and every link passes `route_ok`; `market_state` on the 896 stored ^NSEI closes is `normal` (−4.93% from the high) with no context line; `what_if_sale` priced 26 of 28 open tradable holdings (an ELSS fund refused as partly locked, one fund without a price); `harvest_plan` books ₹2,234.40 from one fund. `goals`, `quant`, `mc` and `forecast` each import cleanly in a fresh interpreter.
- **Left for W4-B1 (G2), not wired here:** `positions=` to `project_goal`, `book_key`/`book` to `holding_outlook` (a debt fund's cone still uses the Mutual Funds row until then), `open_ids` to `build_insights`, `market_state`/`context_line`, `upcoming`, `funding_summary`, `GET /tax/what-if` and the Book hash in the forecast memo keys.

### W3 review fixes

- **A P2P close in Coming up is a date, not a payment (amends G13 and the W3-B1 titles).** `calendar.upcoming` gives `p2p_close` events `amount: None` (direction stays `in`). The cash-flow event's amount is the loans' whole outstanding principal, but that money comes back as EMIs over the months before the close date, and those EMIs are already in `inflow_90d`. Shown as "+₹X" on the close date, it could exceed the whole 90-day inflow. The note now says the repayments are counted month by month. Titles use the folded `count`: "1 P2P loan finishes repaying", "<n> P2P loans finish repaying" (the count is read from the name when `count` is missing), and "<name> is fully repaid" for an event with an `instrument_id`. `cash_flow_forecast`'s own event keeps its amount, which `brief`'s deploy rule reads. Pinned in `test_calendar.py`, which also checks Σ event amounts in the window ≤ `inflow_90d`.
- **An EPF contribution already recorded this month is not projected again (§6.6 rule 1).** `cash_flow_forecast` skips the averaged contribution in today's month row when an EPF BUY is dated in this month on or before today, as dividends do with `paid_this_month`. That makes the W3-B1 premise true: today's month counts in full in `_window_totals` because nothing on or before today is in it. Pinned in `test_calendar.py`.
- **One harvest figure everywhere (amends G11's "keys unchanged" to "keys unchanged, values from the plan").** In the current FY, `ltcg_harvest.suggested_booking` and `future_tax_saved` are `harvest_plan.total_gain` and `future_tax_saved` (FIFO, whole shares, ₹1,000 below the exemption). They were min(gain, remaining) before. The Tax page, the Actions planner, the `tax:ltcg-harvest` insight and action, the brief's FY-window gate and the calendar's FY-end note all use what the plan behind "See the harvest plan" books. A past FY stays at 0. One edge case: with exactly ₹2,000 of exemption remaining, the plan books ₹1,000, which is not more than `HARVEST_MIN_BOOKING`, so the action does not fire. Pinned in `test_tax_whatif.py`.
- **The Outlook cone head quotes the typical return.** It reads "… · typical {typical_pct}% a year ± {σ}%, at its asset class's long-run return, not its recent trend", which is the rate the Middle column grows at. The Book mean shows only as "avg" when `typical_pct` is missing (§1.9). **For the wave-4 lead:** `HONESTY.signal` ("range if it moves as it has; not a forecast") is pinned by SPEC §6.12 and is shared with the market-signal copy, so it was not changed here. The cone needs its own wording, for example "statistical range at the asset class's long-run return; not a forecast". That needs either a new HONESTY key (`test_assumptions` pins the key set) or a `cone_label` that is not `HONESTY.signal` (`test_risk` pins it).
- **The column chooser keeps a column beside Name on load as well.** `chosenCols` falls back to the default when none of the saved keys is offered in the current view (an Owner-only choice saved in family view).
- **Class chips carry `aria-current="page"`**, like the tabs. This covers All, the held classes and the greyed empty classes.

---

## Wave 4

Prepared against the working tree after wave 3 landed (backend pytest 510 passed). Decisions H1–H20 bind wave 4 and every later wave. They add to Parts A and B, E1–E20 and G1–G16. Where they differ from WAVES.md, waves.json or SPEC.md, they win.

### Ownership and parallel safety

**H1. The wave-4 task list differs from WAVES.md as follows.**
- **W4-F2 and W4-F7 are not in this wave.** A2/D19 moved them to wave 5 as W5-F9 (Cash flows) and W5-F10 (Performance P1). No wave-4 task touches `features/performance/*` or `features/forecast/cashflow.component.ts`.
- **W4-F1 is split in two.** WAVES.md's W4-F1 mixes the shared P1 components with every route and hub change, and is too large for one builder. Neither half needs a file the other creates.
  - **W4-F1** keeps the shared P1 frontend: types and API methods, the AssumptionChip and its drawer, the what-if modal and its global host, the line-chart goal marker, ActionRunner, and the shell and nav badges. It also owns the Add sheet's "Due now" row.
  - **W4-F8 (new)** owns navigation: `app.routes.ts` with every §3.6 redirect, the interim Plan, Risk & mix and Recurring pages, the deletion of `forecast.component.ts`, the Activity tabs, an interim future section on Cash flows, and an `embedded` input on Goals.
- **W4-B1 gains `brief.py` and `test_brief.py` (G15), `prices.py` (D6) and `test_markets.py`.** It may also create `backend/tests/test_p1_api.py`, so `test_api.py` does not grow past 1,000 lines.
- **W4-B2 (new)** is a small backend task for two wave-3 review items: the cone's own honesty label, and the EPF monthly average. Its files are `assumptions.py`, `quant.py`, `forecast.py`, `test_assumptions.py`, `test_risk.py` and `test_forecast.py`.
- File lists:

| Task | Files |
|---|---|
| W4-B1 | `backend/tracker/services.py`, `api/analytics_api.py`, `api/forecast_api.py`, `api/markets_api.py`, `prices.py`, `analytics/brief.py`, `tests/test_api.py`, `tests/test_brief.py`, `tests/test_markets.py`, new `tests/test_p1_api.py` |
| W4-B2 | `analytics/assumptions.py`, `analytics/quant.py`, `analytics/forecast.py`, `tests/test_assumptions.py`, `tests/test_risk.py`, `tests/test_forecast.py` |
| W4-F1 | `core/models.ts`, `core/api.service.ts`, `core/action-runner.service.ts`, `core/txn-dialog.service.ts`, `src/styles.scss`, `layout/shell.component.{ts,html,scss}`, `shared/nav-list.component.ts`, `shared/txn-form.component.{ts,html}`, new `shared/priority/assumption-chip.component.ts`, new `shared/priority/assumptions-drawer.component.ts`, new `shared/what-if-sale.component.ts`, `shared/charts/line-chart.component.ts` |
| W4-F8 | `app.routes.ts`, new `features/plan/plan.component.ts`, new `features/risk/risk-mix.component.ts`, new `features/recurring/recurring.component.ts`, `features/forecast/forecast.component.ts` (deleted), `shared/section-tabs.component.ts`, `features/cash-flows/cash-flows.component.ts`, `features/goals/goals.component.{ts,html}` |
| W4-F3 | `features/p2p/p2p.component.{ts,html}` |
| W4-F4 | `features/fixed-deposits/fixed-deposits.component.ts` |
| W4-F5 | `features/forex/forex.component.ts` |
| W4-F6 | `features/retirement/retirement.component.ts` (EPF/NPS, not the planner) |

- No wave-4 task owns any of these: `actions.py`, `insights.py`, `goals.py`, `plans.py`, `mc.py`, `calendar.py`, `tax.py`, `optimizer.py`, `story.py`, `portfolio.py`, `markets.py`, `ledger.py`; `test_actions.py`, `test_insights.py`, `test_links.py`, `test_goals.py`, `test_plans.py`, `test_mc.py`, `test_calendar.py`, `test_tax_whatif.py`, `test_wave1_contracts.py`; every page under `features/` not listed above; `shared/priority/*` other than the two new files; `core/action.service.ts`.
  - These must stay green and compile. G1's rule applies: a builder whose change breaks one fixes the cause in its own files, or reports the failure. It never edits a file it does not own.
- **A task's acceptance never depends on a sibling.** The backend contracts below (H2–H12) are what W4-F1 types against. W4-F8 and the class pages use only existing services and components.

### Backend wiring (W4-B1)

**H2. SIP adherence lives outside `context`, because it reads the action log.**
- `skipped` (A11, D23) comes from action-log rows. A status POST bumps only `actions_rev` (A6), and the `context` memo is not keyed on it. So `Services.context()` keeps `adherence: None`, and its docstring points here.
- New method: `Services.adherence(scope, settings, owner=None, months=6)`.
  - It is memoised on `('adherence', scope, owner, today, actions_rev, months)`.
  - It returns `plans.sip_adherence(ctx.sips, txns, instruments, today, months, skipped=…)`.
  - `skipped` = {(sid, due)} for every log row (owners as `_log_owners`) whose status is `dismissed`, whose `reason` is `skipped` and whose id matches `sip:(due|missed):<sid>:<YYYY-MM-DD>`.
- The `/actions` build (`_build_actions`, already keyed on `actions_rev`) sets `src['adherence'] = adherence(…)`. The insight `sip:missed` mapping then switches off by itself (A9).
- `follow_through` gets `adherence(…, months=12)` (§8.5, `sip_adherence_12m`).
- `build_brief` reads adherence from `ctx['adherence']`. Services passes a **shallow copy** `{**ctx, 'adherence': adh}` and never assigns into the memoised context.
- A failure in adherence leaves it None and adds a note (new `SOURCE_NOTE['adherence']`).
- `_action_inputs` stays independent of the action log. It never holds adherence or upcoming.

**H3. Upcoming.**
- `Services.upcoming(scope, settings, owner=None)` is memoised on `('upcoming', scope, owner, settings, today, actions_rev)`.
- It returns `calendar.upcoming(build_calendar(port, tax, goals, horizon_days=90), cashflow(scope, settings, 4), adherence(…)['next_due'], ipos, today)`.
  - `ipos` = the scope's `ipos` rows (the `_market_notices` query without the date filter).
  - It uses adherence's `next_due[]`, not `plans.next_due` (amends G2). Adherence's list already drops instalments that are paid or skipped, and plans dropped by the EPF import rule, so an early-paid SIP is not shown as money still to go out.
- `/brief` passes it as `upcoming` and `/actions` as `src['upcoming']`. A failure gives None plus a note.

**H4. Market state (D6, G12).**
- `prices.stored_history(db, symbol, start) -> [(iso_date, close)]` reads `price_history` only: no network, no `price_meta` write.
- `Services.market_state(scope, settings)` is memoised on `('market_state', scope, today, perf_ready)`. It returns `markets.market_state(stored_history(db, '^NSEI', today − 400 days), peeked ALL metrics or None, stress(scope, settings), today)`, and None with fewer than 200 closes.
- `_action_inputs` reads it (`market_state`), so `/actions` and `/brief` share it. `GET /markets` returns `{**cached overview, 'market_state': S().market_state(...)}` outside its `L()._cached` entry.
- **/brief still never builds history.** `stored_history` is a read.

**H5. The Book hash goes into the memo keys (§6.0 rule 3).**
- `Services.book(scope, settings)` is memoised on `('book', scope, settings.get('assumptions'), today)`. It returns `{book: rated_book(port.positions, effective_book(settings)), hash: book_hash(that)}`.
- `hash` is added to the memo keys of `forecast`, `retirement`, `stress`, `cashflow`, `plan`, `assumptions` and `brief`. Nothing else changes. The payloads already carry `assumptions.hash` (G5), which must equal this hash.

**H6. `GET /plan` (P1.1, §5.2 Data).** `Services.plan(scope, settings)` is memoised on `('plan', scope, settings, today, hash, perf_ready)`. It is **not** keyed on `actions_rev`, so a status POST never rebuilds it. It never builds history. The payload:
```
Plan = {
  status: {status: Status, headline: str},
  rows: PlanTrackRow[],              // brief.plan_track rows, worst first (deltas vs the 30-day snapshot)
  goals: Goal[],                     // ctx.goals, each projected with positions (H14)
  retirement: RetirementPlan | null, // only when settings.retirementPlan is a non-empty dict; build_history=False
  funding: goals.funding_summary(goals, port.segments, port.positions, settings.emergencyFund),
  cushion: Cushion,                  // brief.cushion_state (A6 shape, with candidates)
  sip: {plans_monthly_total, goals_monthly_contribution, needed_monthly, gap_monthly},
  counts: {on_track, at_risk, off_track, achieved, unknown, total},   // engine statuses, goals + retirement
  deltas: {[goal id as string | 'retirement']: pts},                   // only non-null deltas
  assumptions: ChipBlock,            // H11, the whole portfolio's Book chip
  empty: bool,                       // no goals and no retirement
  notes: string[]
}
```
- **One rule for Home and Plan.** `brief.py` exports `plan_track(ctx, plan, snap)` (the former `_plan_track`) and `plan_headline(track)`. `/plan` uses both with `kpi_snapshot_at(snap_owner, today − 30)`, so the shell's Plan dot (brief) and `/plan` agree.
- **Headline.** "N of M goals on track" when there are goals, joined with " · retirement P% likely" when a retirement row exists. "No goals yet" when empty, with status `unset`. " · family plan" is appended for `scope None` (§7.8).
- **The `sip` block.** These sums skip achieved goals and a `required_sip` of None:
  - `plans_monthly_total` = `monthly_sip_total(sips)`;
  - `goals_monthly_contribution` = Σ `monthly_contribution`;
  - `needed_monthly` = Σ goal `required_sip` + retirement `required_sip`;
  - `gap_monthly` = Σ max(0, `required_sip` − `monthly_contribution`) + max(0, retirement `required_sip` − `inputs.monthly_sip`).
- A failed retirement build leaves `retirement` None and adds a note. It never returns 500.

**H7. `GET /assumptions` (§6.1, D2).** It is memoised on `('assumptions', scope, hash, mix)`.
```
{segments: [{key, label, value, weight_pct, return_pct, typical_pct, volatility_pct, source, capped?}],  // all 9 Book keys; MF_DEBT labelled "Mutual Funds (debt)"
 corr: {keys, labels, matrix (2 dp), note: CORR_NOTE},
 portfolio: ChipBlock, inflation_pct, risk_free_pct,
 typical_bands: [{years: 1|3|5, typical, lo, hi}],   // typical_band(μ, σ, years) of the portfolio mix
 hash, honesty: HONESTY with p50 formatted for 1,000 sims, note: "Long-run assumptions, not predictions.",
 proposed?: ChipBlock}                                // only with ?mix=
```
- `?mix=<segment>:<pct>,...`: every name must be a `domain.SEGMENTS` name and every pct must lie in 0–100, summing to 100 ± 0.5; anything else is 400.
- The `Mutual Funds` weight is split into `MF_DEBT` by the portfolio's current debt share of MF value, as `optimizer._stats` does (E16). `proposed` = `chip(book, those weights)`.
- Tests must not pin the HONESTY key set, because W4-B2 adds `cone`.

**H8. `GET /tax/what-if` (§6.9, G11).**
- Parameters:
  - `instrument_id`: an int, required;
  - `qty`: a number > 0, required;
  - `price`: optional, a number > 0;
  - `date`: optional, YYYY-MM-DD.
  A bad value is 400.
- It returns `tax.what_if_sale(port, txns, instruments, iid, qty, price, date, slab, today=today)` unchanged. `tax.WhatIfError` (a `ValueError`) is 400 with `str(e)`.
- It is memoised on `('whatif', scope, slab, iid, qty, price, date, today)`. Guests may call it, because it is a read.
- `GET /tax` already carries `opportunities.harvest_plan` (W3-B3). Only a test is added.

**H9. `GET /sips`.**
```
{plans, monthly_total,
 adherence: SipAdherence | null,     // Services.adherence(months=6), H2
 arriving: [{kind, label, date, amount, instrument_id, link}],
 arriving_total: number}
```
- `arriving` is `Services.deploy(...).sources`: the same money as `brief.deploy`. `arriving_total` equals `brief.deploy.suggested`, so Recurring's "Extra to invest" can send `net=deploy` exactly as Actions does (A15).
- `link` by kind: `usd` → `/forex`, `fd` → `/fixed-deposits`, `p2p_principal` → `/p2p`, `escrow` → `/cash-flows`.
- This is a deliberate reading of §5.9's "Arriving: FD maturities, P2P principal back, idle USD". It shows one deployable total everywhere.

**H10. The `emergencyFund` setting (§7.7, A25).**
- `SETTING_KEYS` gains `emergencyFund`. The value must be an object:
  - `months_target`: an int 3–24, default 6;
  - `monthly_expenses`: a number 0–1e7, or null;
  - `instrument_ids`: a list of ints, each of which must pass `L().instrument(id, g.scope)` (a NotFound becomes a 400 "Instrument … is not in this portfolio");
  - `cash_amount`: a number 0–1e8, default 0.
  Unknown keys are dropped.
- **Auto-suggest.** `GET /settings` adds a read-only `emergencyFundSuggest = {candidates, candidates_amount, monthly_expenses_hint}`.
  - `candidates` and `candidates_amount` come from `brief.cushion_state(port, settings, today)`.
  - `monthly_expenses_hint` is `retirementPlan.monthly_expenses` or null.
  - The suggestion is for the request's scope. W5-F7 reads it.

**H11. The brief gains its P1 fields (`brief.py`, G15, W1-B6 follow-ups).**
- **Pass-throughs.** `upcoming` (H3) and `market_state` (H4). `cushion` and `risk_est` are passed through too, so the optional fields W1-F1 typed are filled.
- **Context line priority (§4.1).** It is `markets.context_line(market_state)` first, then the FY window, then the review. Import `context_line` from `..markets` inside `brief.py`; `markets` imports only `domain` and `prices`, so there is no cycle.
- **`assumptions_check`** (A6 shape, plus `link`). It is built only when `perf` is not None, otherwise null.
  - `years` = (metrics.end − metrics.start) / 365.25, and `realised_pct` = `metrics.twr_annualised`.
  - μ and σ come from `mu_sigma(weights_from_positions(positions), rated_book(positions, effective_book(settings)))`.
  - `years` < 1 gives verdict `too_short`, with the band computed for 1 year. Otherwise the band is `typical_band(μ, σ, years)` and the verdict is `within`, `above` or `below`.
  - `link` = `/plan?return=<realised rounded to 0.5>` only when the verdict is `below`, typical − realised ≥ 3 and years ≥ 2. Otherwise null.
- **`assumptions` (ChipBlock).** It is `assumptions.chip(book, weights)` plus `basis`, which gives `{return_pct, typical_pct, volatility_pct, inflation_pct, hash, text, basis}`, plus **`chip` = `text`**. Home's P0 template reads `bb.assumptions.chip`, so the alias keeps it working until W5-F5.
- **Habit (W1-B6 follow-up).**
  - `adherence_6m_pct` comes from adherence.
  - `pace` = `invested_this_month / planned_this_month × 100`, or null when planned is 0.
  - `next_due` is adherence `next_due[0]`, or null. This is what E20's "Next: SIP …" waits for.
  - `milestone` is the first `ahead` row of `story.milestones(port, monthly_sip_total)` ({label, when, in}), or null.
  - Status: no plans, or `adherence_6m_pct` null, gives `unset`. ≥ 90 is `good`, ≥ 60 is `watch`, below 60 is `act`.
  - `invested_month` and `planned_month` keep their P0 meaning.
- **Cushion candidates use `assumptions.book_key(p) == MF_DEBT`** instead of the local `_DEBT_MF` regex (G15, E15). The `name` is no longer read. The liquid ordering still uses the liquid regex on `category`/`sub_category`/`name`.
- The memo key gains `hash` (H5). Everything else in E3/E7 and the W2 review fixes stands.

**H12. Snapshot additions (§6.11, §7.5, E7).**
- The day's KPI snapshot adds two fields:
  - `book_hash` (H5);
  - `projection_1y = {p10, p50, p90}`. These are growth factors, each `end.pX / totals.value`, rounded to 4 dp. They come from `forecast.project_portfolio(port, peeked ALL metrics or None, years=1, monthly_sip=0, step_up=0, sims=1000)` (seed 42).
- Both are computed **in `_write_snapshot`, only when the write will happen** (the `(owner, date)` pair is not in `_snap_written`), and never in the brief memo build. A cold `/brief` therefore pays for the projection once per process-day, and a warm one never does.
- When `totals.value` ≤ 0 or the projection raises, the row is written without `projection_1y`.

**H13. One insight build for `/insights`, the bell and `/actions` (E12 unification, G2, G10).**
- `_action_inputs` reads the action log once for `open_ids`: the ids of rows with status `open` or `planned` that start with `concentration:` or `sector:`. It passes `open_ids`, `cushion`, `risk_est`, `stress`, `snapshot_then` and `book` to `build_insights`. Adherence is not passed, because it would key the inputs on `actions_rev`.
- `services.insights(scope, settings, with_performance=False)` returns the action path's list (`_action_inputs(...)['insights']`), so the bell and `/actions` can never disagree.
- With performance it builds once more with the same kwargs plus the history metrics, for `/insights` and the AI context.
- **`perf:*` stay out of `/actions` in P1.** The W2-B1 rule stands. Feeding a peeked performance into the action path would expire `perf:*` rows on every cold process and corrupt follow-through's done/expired ratio. Performance shows those facts itself.

**H14. The rest of G2, and two open choices.**
- `_project_goals` passes `positions=port['positions']`.
- `services.outlook` passes `book_key=assumptions.book_key(position or instrument)` and `book=Services.book(...)['book']`, so a debt fund's cone uses MF_DEBT (7%).
- **The risk lookback grows** from 400 days to `int(3.2 × 365)` days, the same start `services.outlook` already fetches. `price_meta` coverage is then shared, and `holding_stats` reaches `own` data quality for holdings held about 3 years (W1-B3 follow-up). `portfolio_risk(lookback_days=365)` is unchanged, so the measured volatility window stays one year.
- **D2 `months_to_fix`.** `/rebalance` adds `months_to_fix = ceil(money_to_fix_without_selling / max(1, monthly_sip_total + inflow_90d/3))`, with `inflow_90d` from `Services.upcoming` (null counts as 0). It is 0 when `money_to_fix_without_selling` ≤ 0, and null when the plan has an `error`.
- **Unchanged after review: the brief's deploy rule** that counts cash-flow `p2p_close` amounts within 30 days (the W3 review question). The folded event's amount is today's outstanding principal of loans that finish within the month. For a close date ≤ 30 days away, that principal does come back inside the window, so nothing is overstated. The Coming-up problem was the 90-day window, where earlier EMIs are already counted.

**H15. Tests and measurement (W4-B1).**
- The test lines in WAVES.md stand, with A5 applied: counts are asserted and times are measured.
  - A cold `/brief` with every P1 source present makes **1** `compute_portfolio` call: a saved `retirementPlan`, a goal, an SIP plan, an `emergencyFund`, ≥ 200 stored `^NSEI` closes inserted into `price_history`, and a warm ALL performance.
  - A warm `/brief` makes **0** calls.
  - `/plan` right after `/brief` makes 0 calls.
- Also tested:
  - a status POST does not rebuild a cached `/plan` (spy on `goals.funding_summary` or `project_goal`);
  - the `/plan` and `/assumptions` shapes, and their `hash` is stable across calls and equals the forecast payload's `assumptions.hash`;
  - the `/tax/what-if` cases in §7.9;
  - an `emergencyFund` with another owner's id is 400;
  - `/sips` `arriving_total == brief.deploy.suggested`;
  - `/markets` has `market_state` (None under 200 closes);
  - skipping an instalment (dismissed, reason `skipped`) shows it as `skipped` in `/sips` after the POST, with no ledger bump.
- **A5:** re-run the W2-B1 measurement script on a fresh copy of the scratchpad database, with every P1 source present. Report cold and warm times for `/brief`, `/actions` and `/plan`, with a cost breakdown, in the task report.

### Engines (W4-B2)

**H16. The cone gets its own honesty label, and EPF averages by month.**
- `assumptions.HONESTY` gains `cone`: "statistical range at the asset class's long-run return; not a forecast". `signal` is unchanged, because §6.12 pins it for market signals.
  - `quant.holding_outlook` sets `assumptions.cone_label = HONESTY['cone']`.
  - The key-set pin in `test_assumptions.py` and the `cone_label` pin in `test_risk.py` follow.
  - `forecast.HONESTY` is the same object, so projection and retirement `honesty` gain the key. That is additive.
  - W5-F6 renders `cone_label` and drops WAVES' "range if it behaves like the past" wording.
- **EPF contribution (§6.6 rule 1, the W3 review item).** `cash_flow_forecast` averages the EPF contribution **per calendar month**: Σ the BUYs of each of the last (up to) three months with an EPF BUY in the last 120 days, divided by the number of those months. A passbook import that writes employee and employer shares as separate rows is no longer halved. Rule 1's "already paid this month" skip is unchanged. `test_calendar.py`, which no wave-4 task owns, must stay green.

### Frontend contracts (W4-F1, W4-F8)

**H17. Shared P1 components (W4-F1).**
- **Types** follow H2–H12 exactly:
  - `Plan`, `PlanSip`, `PlanCounts`, `Funding`, `Cushion` (exists);
  - `ChipBlock` = `Pick<ForwardAssumptions, 'return_pct' | 'volatility_pct' | 'inflation_pct' | 'hash'> & {typical_pct?, basis?, text?, chip?}`;
  - `AssumptionsView`, `WhatIfSale` (read `tax.what_if_sale` and `_price_sale` for the lot keys), `SipAdherence`, `SipAdherencePlan`, `SipInstalment`, `NextDue`, `ArrivingMoney`, `SipsResponse`;
  - `EmergencyFund`, `EmergencyFundSuggest`;
  - `Settings.emergencyFund` and `emergencyFundSuggest`, `MarketOverview.market_state?`, `RebalancePlan.months_to_fix?`;
  - `Brief.assumptions?: ChipBlock | null` (replacing `{hash, chip}`, which stays compatible through `chip`), `AssumptionsCheck.link?`, and `HabitTrack.next_due?` / `milestone?`.
  - New fields are optional where a P0 payload lacks them.
- **API methods:** `plan()`, `assumptions(mix?: Record<string, number>)`, `whatIf({instrument_id, qty, price?, date?})`, `sips(): SipsResponse`.
- **What-if host (as A19 for the FD dialog).**
  - `TxnDialogService` gains `whatIf = signal<WhatIfState | null>`, `openWhatIf(s)` and `closeWhatIf()`, where `WhatIfState = {instrumentId, qty?, price?, date?, actionId?}`. The shell's dialog host renders `<app-what-if-sale>`.
  - The modal has qty (default the held quantity), price (default `position.price`, D16) and date (default today).
  - It shows the lots table, tax with `<app-est>`, and a negative `tax_now` as "saves ₹N" (W3-B3). It also shows the `wait` hint, the note, and the 400 message inline.
  - "Record this sale" opens `TxnDialog` SELL, prefilled with instrument, quantity and date plus the `actionId`. It is hidden for guests.
  - ActionRunner's `whatif` CTA opens it with `cta.whatif.instrument_id ?? action.instrument_id`, and falls back to the link without one. What-if is a read, so guests may open it.
- **`<app-assumption-chip [block]>`** shows `block.text`, or composes "R% avg · T% typical · ±V% · I% inflation". Its title carries the basis and `#hash`, and it never relies on colour alone.
  - Clicking it opens `<app-assumptions-drawer>` (rendered by the chip, as a modal or side sheet). The drawer fetches `api.assumptions()` once per open.
  - The drawer shows the segment rows, the portfolio chip, the typical bands, the correlation note (matrix collapsed), the honesty copy, "Long-run assumptions, not predictions" and "Change the mix → /risk#profile".
- **Line chart:** a `goal` marker kind (a 7 px diamond with the label above, tooltip "{name} · needs ₹X") and an `xLabel` formatter input. Existing markers and callers are unchanged.
- **Shell:**
  - `NavBadges` gains `markets: 'correction' | 'crash' | null` from the brief snapshot's `market_state.mode` (E20: the shell only reads). Every rendering shows an amber dot with an aria-label/title naming the mode.
  - The Plan dot, the Tax badge and the Activity entry already exist; they are unchanged.
- **"Due now" in the Add sheet (amends WAVES "from sips.adherence.next_due").** The kind chooser in `txn-form` opens with up to 3 rows taken from `ActionService`: the visible actions whose id starts `sip:due:` or `sip:missed:`, earliest due first. Each row runs `ActionRunner.run(action)`. These actions are built from adherence and already carry the prefill and `actionId`, so saving marks them done and no extra `/sips` call is needed. The builder must make sure the form switches to the prefilled kind when the dialog state changes while it is open.

**H18. Navigation (W4-F8).**
- **Routes:**

| URL | Goes to |
|---|---|
| `/plan` | `PlanComponent` (interim). `?tab=overview\|goals\|retirement`; `outlook` and unknown values read as overview. It follows `queryParamMap`. |
| `/goals` | `/plan?tab=goals`, keeping every other query parameter (`preset`) and the fragment |
| `/forecast` | the `ForecastRedirect` function, by `?tab`: `retirement` → `/plan?tab=retirement`; `cashflow` → `/cash-flows?view=future`; `stress` → `/risk#stress`; `risk` → `/risk#risk`; `allocation` → `/risk#profile`; `sips` → `/recurring`; anything else → `/plan` |
| `/risk` | `RiskMixComponent` (interim), with `riskGuard`: fragment `concentration` → `/performance#concentration` until W5-F2/W5-F10 move it; `runGuardsAndResolvers: 'always'`, so a fragment-only navigation is checked too |
| `/recurring` | `RecurringComponent` (interim) |
| `/insights` | `#rebalance` → `/risk#rebalance` (§3.6; E19 is retired); otherwise `/actions` |
| `/analytics`, `/markets?tab=performance`, `/admin`, `/holdings` | unchanged |

  `planGuard`, `RISK_INTERIM` and `forecast.component.ts` are deleted. Every redirect builds a UrlTree (E19).
- **Interim pages.** Each has one h1 (A22) and hosts existing components only. W5 rewrites them.
  - **Plan** (h1 "Plan"): Overview hosts `ProjectionComponent`, Goals hosts `<app-goals [embedded]="true">`, and Retirement hosts the planner `forecast/retirement.component`.
  - **Risk & mix** (h1 "Risk & mix", `<app-portfolio-tabs />`) has sections `#profile`, `#mix`, `#rebalance`, `#stress` and `#risk`, in §5.6 order:
    - `#profile` holds AllocationLab;
    - `#mix` holds D11's notice "Targets are still edited in Settings" with a link to `/settings`;
    - `#rebalance` holds `<app-rebalance-planner [riskLink]="false">`, with `newMoney` = the brief snapshot's `deploy.suggested` and `useNet` true when that is used, else 0 with no net;
    - `#stress` holds Stress;
    - `#risk` holds Risk.
  - **Recurring** (h1 "Activity", Activity section tabs) hosts `SipPlansComponent`.
- **`GoalsComponent` gains `embedded = input(false)`.** When it is true, it drops the `.page` wrapper and shows its title as an h2, keeping its Add button. It also scrolls to `#goal-<id>` once its goals have rendered when the route fragment names one (the W3 anchor-timing issue).
- **The Activity tabs** (`section-tabs` group `activity`) are Transactions · Cash flows · Recurring plans · Import (§3.3). Import is hidden when `!auth.canWrite()`.
- **Interim Cash flows future view.**
  - `?view=past|future|both` is read from `queryParamMap`; no value means past.
  - For future or both, the page renders `<section id="future">` "Next 12 months · estimate", which hosts the existing `CashflowComponent` unchanged. With `view=future` it scrolls there after render.
  - The past view adds the link "Next 12 months →" (`?view=both`).
  - W5-F9 replaces all of this and deletes `forecast/cashflow.component.ts`.

**H19. Class pages (W4-F3 to W4-F6, §5.7, D24).**
- **Common to all four:**
  - The h1 is the class name: "P2P lending", "Fixed deposits", "USD wallet", "EPF", "NPS".
  - `<app-portfolio-tabs />` replaces `<app-section-tabs group="holdings">`.
  - T0 follows W3-F1's class-page pattern: the first tile is `.kpi.hero`, with `.verdict-line[data-status]`, an icon and an sr-only status word; the third tile goes behind "More" at ≤ 760 px.
  - Then comes `<app-needs-attention>` under T0, then the existing content. Existing logic is kept.
  - **Info-severity actions rank `consider` (`actions.tier_of`).** So a strip that must show `cash:usd`, `nps:nav-stale:*` or `p2p:yield` passes `[tiers]="['now','month','consider']"`.
- **P2P (W4-F3):**
  - Strip `prefixes=['/p2p','/cash-flows']`, `ids=['p2p:','cash:p2p-principal:']`.
  - The hero is Σ `outstanding` of open loans. Its verdict is "At risk ₹{Σ at_risk} · {n} overdue", where n = open loans with `overdue_days` > 30 (the Money-at-risk vital's rule).
  - Status: `act` when Σ at_risk + Σ outstanding overdue > 30 days ≥ 1% of `totals.value` (`MONEY_AT_RISK_ACT_PCT`); `watch` when > 0; else `good`.
  - Realised XIRR is compared with the outstanding-weighted average `rate` of open loans.
  - The Principal back tile's "30 days, not reinvested" uses the visible `cash:p2p-principal:*` action's `impact.amount` when there is one.
  - `?tab=active|overdue|closed|defaulted|all` follows `queryParamMap`, and a tab click writes it with `replaceUrl`. This makes the action links `/p2p?tab=defaulted|overdue` work. `?import=lenden` stays.
- **FD (W4-F4):**
  - Strip `prefixes=['/fixed-deposits']`, `ids=['fd:']`.
  - The hero is the open FD with the smallest `days_to_maturity` ≥ 0: "{name} · {days} days · ₹{maturity_value}".
  - Status: `act` when an open FD has `maturity_date` < today (A28), with verdict "N matured FD not recorded · Mark matured"; `watch` at ≤ 30 days; else `good`.
  - The local mature modal is deleted. "Mark matured" calls `dialog.openFdMature(id, actionId)`, where `actionId` is the visible `fd:matured-unrecorded:<id>` action when one exists (A19).
  - "Redeploy ₹X" is a badge link on open FDs with 0 ≤ `days_to_maturity` ≤ 30, to `/actions?new_money=<round(maturity_value)>#deploy` (A13).
- **USD wallet (W4-F5):**
  - Strip `prefixes=['/forex']`, `ids=['cash:usd']`, tiers including `consider`.
  - Status: `watch` when `balance_usd` > 50, with verdict "${x} idle · deploy it"; `good` otherwise; `unset` with no wallet.
- **EPF/NPS (W4-F6):**
  - The EPF hero's status is `info`, with a factual verdict (credited · accruing · declared rate). No strip is expected (`prefixes=['/epf']`).
  - The NPS hero is `watch` when an open NPS position with no `symbol` and value > 0 has a `price_at` more than 30 calendar days old (G10's `nps:nav-stale` rule). The verdict is "NAVs N days old — update", with N = the oldest. Otherwise it is `good`.
  - The NPS strip is `prefixes=['/nps']`, `ids=['nps:nav-stale:']`, tiers including `consider`. Stale rows carry a watch badge beside the existing inline NAV editor.

### Carried forward

**H20. For the wave-5 lead, and checks for the wave-4 integrator.**
- **Wave 5:**
  - W5-F8 turns the Actions planner's `[riskLink]` back on, now that `/risk` is a page.
  - W5-F1, W5-F2 and W5-F3 replace the interim Plan, Risk & mix and Recurring pages, and keep or replace `riskGuard` (W5-F2/W5-F10 move Concentration).
  - W5-F1 removes `GoalsComponent.embedded` when it moves Goals into `features/plan`.
  - W5-F9 replaces the interim future section and deletes `forecast/cashflow.component.ts`.
  - W5-F5 switches Home from `assumptions.chip` to `<app-assumption-chip>`.
  - W5-F7 reads `emergencyFundSuggest`.
  - W5-F3 uses `/sips` `arriving`, `arriving_total` and `adherence`.
  - W5-F10 reads `brief.assumptions_check` (with its `link`) or `/assumptions` `typical_bands`.
- **Backlog, not in P1:** `forecast`'s P2P EMI survival factor and the global `prices:last_refresh` stamp (wave-1 notes).
- **Integrator checks for wave 4:**
  1. Full backend pytest, `ng build` and `npm run check`.
  2. A5 numbers from W4-B1, re-run once on a fresh copy of the scratchpad database.
  3. On a fresh database copy, through the Python modules, with synthetic goals, SIP plans, an `emergencyFund` and a `retirementPlan` added to the copy:
     - `/plan`, `/assumptions`, `/sips` and `/tax/what-if` payloads;
     - `hash` equal across forecast, retirement, `/plan`, `/assumptions` and the brief chip;
     - the brief's `on_track.plan.status` equal to `/plan` `status.status`;
     - `arriving_total == brief.deploy.suggested`;
     - `market_state` on the stored `^NSEI` closes;
     - a debt-fund outlook cone at MF_DEBT's 7%.
  4. Every §3.6 old URL lands on its new page: each `/forecast?tab=*`, `/goals?preset=x#goal-1`, `/insights#rebalance`, `/risk#concentration` (also while `/risk` is open), `/holdings`, `/plan?tab=retirement`.
  5. On a mocked API (never the real server or tokens), check:
     - an Actions tax CTA opens the what-if modal;
     - the Add sheet shows "Due now";
     - a brief snapshot with `market_state.mode = 'correction'` shows the Markets dot;
     - the class pages and the interim hubs fit at 1280 and 390 px.

### W4-B2 builder decisions (cone label, EPF monthly average)

- **`HONESTY['cone']`** = "statistical range at the asset class's long-run return; not a forecast", inserted after `signal` (dict order only matters for display). `signal` is unchanged. `forecast.HONESTY is assumptions.HONESTY` (G4) is now asserted in `test_assumptions.py`, so projection, retirement and goal projections carry `cone` in `honesty` too. That is additive. `HONESTY_POINT` (cash flow and stress) still carries only `estimate` and `disclaimer`.
- **`quant.holding_outlook`** sets `assumptions.cone_label = HONESTY['cone']`. The import set is unchanged (domain and assumptions only).
- **EPF monthly contribution (§6.6 rule 1, H16).**
  - The window is the BUYs dated `today − 120 days ≤ date ≤ today`.
  - The upper bound is new. The old filter had none, but a future-dated row is not "in the last 120 days", and rule 1's `paid_this_month` already stops at today.
  - The rows are summed per calendar month (`YYYY-MM`). The months are sorted, so ledger order no longer matters, and the last (up to) three are averaged: Σ amounts / number of months.
  - `paid_this_month` and `epf_averaged` are unchanged. A month already paid is still skipped in the projection but still counts in the average.
  - The `cash_flow_forecast` docstring gains this as part of rule 7.
- **Real-data check:** the scratchpad copy has no EPF instruments, so the change has no real-data effect to measure there. It is covered by `test_cash_flow_epf_averages_per_calendar_month`, which checks two rows a month, a month outside 120 days, the fourth-oldest month, the paid-this-month skip and a future-dated row.

### W4-F1 builder decisions (shared P1 frontend)

- **Types.** They follow H6–H11 and H17, with every P1 field optional on a P0 payload.
  - `ChipBlock` is the H17 `Pick<…> & {typical_pct?, basis?, text?, chip?}`. `Brief.assumptions` uses it, and Home still reads `.chip` and `.hash`.
  - `AssumptionsView.honesty` is `Partial<ProjectionHonesty> & Record<string, string>`, so W4-B2's `cone` and any later key type without a change.
  - `WhatIfLot.term` is `'STCG' | 'LTCG' | 'Intraday'`, as `tax.classify` returns.
  - Two helper types are added: `FundingEarmark` and `FundingOverAllocated` (`goals.funding_summary` rows), and `WhatIfParams` (the API argument).
  - `api.assumptions(mix)` sends `mix=<segment>:<pct>,…`.
- **What-if host.** `TxnDialogService.whatIf` and `WhatIfState` are as H17, and the shell renders `<app-what-if-sale>` after the FD dialog.
  - The modal reacts to a new state while open (another holding), so it does not depend on being recreated.
  - It works the tax out on open when the default quantity is above 0. The price field defaults to `position.price` only when `has_price`. A USD holding's price is asked in dollars, and its proceeds are shown in ₹ with the `amount_fc` line.
  - The tax line has a status stripe (`watch` when tax is above 0, `good` otherwise) with a word label ("Tax on this sale" or "This sale saves"), so it is never colour alone.
  - A negative `tax_now` reads "saves ₹N", and 0 reads "No tax". The est. tag's basis is the payload `note`.
  - The lots table is a `<details>`, open when there are 4 lots or fewer. The D12 sentence is appended to the note only when an older payload lacks it.
  - "Record this sale" needs a quantity and a date, not a result. It uses the form's current values.
- **ActionRunner `whatif`.** It passes `actionId` only when `ActionService.find(action.id)` knows the action.
  - Page-made placeholders, such as the Actions page's `tax:plan:*` "Plan the sale", open the modal without one. Otherwise a save would POST a status for an id the server never ranked.
  - `kindFor` is exported for the modal's SELL kind.
- **Assumption chip and drawer.** The chip is a `<button>` with an info icon and words. Its text is `text`, then `chip`, then one composed from the numbers.
  - The drawer is a right-hand side sheet (`--drawer-w`), and a bottom sheet at 560 px or less.
  - It fetches once per open, with a Retry on error, and paints skeleton blocks while loading.
  - When the chip's `hash` differs from the Book's current `hash`, it says the card was worked out on the older Book.
  - Segment rows with no weight are muted, not hidden, because H7 lists all 9 keys.
- **Line chart.** `LineMarker` is exported. A goal marker uses `amount`, then `value`, then the first series for its y, and widens the y extent so the target stays in view.
  - Its label sits above the diamond, below it near the top, and is anchored inward near either edge. The hover tooltip adds a "{name} · needs ₹X" row at that index.
  - The old `xLabel(i)` method is renamed `xTick(i)` to free the name for the new input `xLabel: (label, i) => string`. That input formats ticks, the tooltip title and the table's first column.
- **Markets dot.** It uses `--status-warning` (amber, visible on navy and white), and its aria-label/title is "Markets: in a correction (or crash) — see what it means for you". It renders in the bar, the drawer and the bottom-bar tab template. The bottom bar has no Markets slot today, so that tab template only keeps it ready.
- **"Due now".**
  - `dueNow(actions, planned)` is exported from `txn-form.component.ts`. It dedupes by id, keeps statuses open and planned, sorts by `due` (none last, then id) and keeps 3.
  - A row whose CTA is not `dialog` (a segment plan's route) closes the sheet first.
  - The form refills when `state` changes while it is open. The one exception is the shell's post-save `{…s, actionId: undefined}`, so "Save & add another" keeps its values.
  - An overdue row carries the alert icon and "N days overdue", never colour alone.
- **Styles.** Only the chip and drawer tokens (`--chip-bg`, `--chip-fg`, `--drawer-w`, `--drawer-scrim`) and a `:focus-visible` ring on `.assumption-chip` are added. No navy is used.
- **Not done here:** the "Import a statement" tile in the Add sheet (§3.1) and every chip placement (W5 pages and W5-F5 on Home).

### W4-B1 builder decisions (services wiring, P1 endpoints, brief P1 fields)

- **The brief's `assumptions`, `cushion` and `risk_est` are merged by services, not returned by `build_brief`.** `test_wave1_contracts.py` (unowned, must stay green) pins `set(build_brief(...)) == ` the A6 key set. So `brief.p1_fields(port, settings, cushion, risk_est, empty)` builds them and `services._build_brief` merges them into the payload before memoising. `GET /brief` therefore has the A6 keys plus these three; `assumptions` is None for an empty ledger. The rule lives in `brief.py`, as H11 asks.
- **`assumptions_check`** is None without `perf`, without `metrics.start` and `metrics.end`, or with no valued holding. A missing `twr_annualised` (the history engine gives none under 365 days) is `too_short` with the 1-year band, like `years` < 1. `realised_pct` is then null.
- **`brief.assumptions_block(port, settings)`** is the ChipBlock used everywhere: the brief's `assumptions`, `/plan` `assumptions` and `/assumptions` `portfolio`. Its `basis` is "holdings mix" (forecast's wording) and `chip` = `text`. `/assumptions` `proposed` has the same shape with basis "proposed mix".
- **`plan_track(ctx, plan, snap)`** accepts either the snapshot's data dict or the `{date, data}` row `kpi_snapshot_at` returns. `_plan_track` stays as an alias. **`plan_headline`** says "1 of 1 goal on track" (singular), "Retirement P% likely" when there is a retirement row and no goal, and "retirement not scored yet" when its probability is None.
- **Habit.** "No plans" means no plan in `adherence.plans` with `active` true. `milestone` is computed even without adherence (it needs only the portfolio and `planned_month`), so P0 payloads now carry it; `status` stays `unset` until there is a score.
- **`/plan`.** A failed `funding_summary` or `cushion_state` is None plus a note (new `SOURCE_NOTE['funding']`), like retirement, so `/plan` never returns 500. `deltas` keys are `str(goal id)` and `'retirement'`. `/plan` reads its own 30-day snapshot (it does not use the action inputs, so a cold `/plan` never builds the optimizer or the insights).
- **`open_ids` owners.** `_action_inputs` is not keyed on the request's owner, so `open_ids` reads the log for every owner such a row can have in the scope: the instruments' owners, the scope itself and `'__global__'`. As H13 accepts, the list is read once per inputs build: a status POST on a concentration or sector row changes the hysteresis only from the next ledger write or day.
- **`insights(with_performance=False)` returns the very list object of the action path.** With performance it rebuilds with the same keyword sources (`_insight_kwargs`), so `/insights` and `/pulse` now also build the action inputs (memoised; still one `compute_portfolio`).
- **Upcoming.** When adherence fails inside `Services.upcoming`, the SIP rows fall back to `plans.next_due(sips, today, 90)` rather than dropping SIP dates.
- **Market state.** `stored_history` reads 400 days. Writes to `price_history` do not bump the ledger, so a newer stored close reaches `market_state` at the next ledger write or price refresh, or when the memo's 10-minute TTL ends.
- **`/tax/what-if` validation.** `qty` and `price` must be finite and above 0, and `date` must be a 10-character ISO date; each failure is a 400 before the engine runs. Every `ValueError` from the engine is a 400 with its message.
- **`emergencyFund`.** `months_target` accepts 6.0 but not 6.5. `instrument_ids` must be JSON integers (strings and booleans are rejected), and duplicates are dropped, keeping the first. `monthly_expenses` may be null. `GET /settings` `emergencyFundSuggest` is None when the portfolio cannot be read, so Settings still loads.
- **`/sips` `arriving[].link`** falls back to `/actions` for a kind H9 does not name.
- **`months_to_fix`** reads `Services.upcoming` with the request's owner. Outside a request, for example in a script, the owner is unknown and the inflow counts as 0.
- **Snapshot extras (H12)** are computed outside the snapshot lock. Two simultaneous first briefs may both run the projection; `INSERT OR IGNORE` keeps one row.
- **The longer risk lookback** makes the first cold `/risk` after deploy fetch about 3.2 years of history for the held symbols, once. After that, `price_meta` coverage is shared with the outlook.
- **The perf:* decision (W2-B1) and the deploy `p2p_close` rule (W3 review) are unchanged.** `test_p1_api.py` asserts that no `perf:*` id reaches `/actions`.
- **A5 (fresh copy `w4b1_measure.db`, 168 instruments, 332 transactions, plus 2 goals, 2 SIP plans, an emergencyFund with ₹1 L cash, a retirementPlan and 265 stored ^NSEI closes; script `w4b1_measure.py` in the scratchpad):**

| Call | perf cold: cold / warm | perf warm: cold / warm |
|---|---|---|
| `/brief` | 137.5 ms / 0.1 ms | 114.5 ms / 0.1 ms |
| `/actions` | 107.9 ms / 0.1 ms | 102.2 ms / 0.1 ms |
| `/plan` | 62.8 ms / 0.0 ms | 59.8 ms / 0.1 ms |

  - Every budget holds. A cold `/brief` makes 1 `compute_portfolio` call, and `/plan` right after it makes 0 and takes 2.5–9 ms. A status POST costs `/brief` 8.6 ms and leaves `/plan` cached (`funding_summary` is not called again).
  - The cold `/brief` cost, inclusive: goal projections 28–31 ms (2 goals), optimizer 26–28 ms, `compute_portfolio` 11 ms, retirement 10.6 ms, the snapshot's 1-year projection 8.8 ms (once per process-day), action-log reads 5–12 ms, `ledger.sips` about 6 ms (5 reads), cash flow 2 ms, and `stored_history` 1.2 ms. History and quotes were blocked throughout.
  - Checks on the same copy all passed:
    - the hash is `4ce39bcfbc` for the brief, `/plan`, `/assumptions`, forecast and retirement;
    - the brief's Plan status equals `/plan` (`act`);
    - `/sips` `arriving_total` = `brief.deploy.suggested` = ₹22,250.06;
    - `market_state` is `normal`, 4.93% below the high, as of 6 Nov;
    - Coming up has 10 events (in ₹22,002, out ₹46,429);
    - the snapshot carries `book_hash` and `projection_1y` {0.9323, 1.1029, 1.2882}.

    The copy has no debt fund, so the MF_DEBT cone is covered only by `test_p1_api.py::test_outlook_cone_uses_the_debt_fund_book_row`.

### W4-F8 builder decisions (routes, interim Plan, Risk & mix and Recurring pages)

- **Names.** SPEC's `ForecastRedirect` is the exported `forecastRedirect` (a `RedirectFunction`), driven by the exported `FORECAST_TABS` table in `app.routes.ts`; any other `?tab=` value, or none, opens `/plan` without a tab. `riskGuard` and `marketsGuard` are exported guards. `planGuard`, `RISK_INTERIM` and `features/forecast/forecast.component.ts` are gone, and nothing imports them.
- **`/goals` keeps every query parameter**, with `tab=goals` added, and the fragment: `/goals?preset=home#goal-1` lands on `/plan?preset=home&tab=goals#goal-1`. GoalsComponent does not read `preset` yet (W5-F1 does).
- **`/risk#concentration` lands on `/performance#concentration`**, both on a cold load and as a fragment-only navigation while Risk & mix is open (`runGuardsAndResolvers: 'always'`). Risk & mix also has a "Concentration … is on Performance for now" line at the bottom.
- **`/recurring` has the browser title "Recurring plans"** and the page h1 "Activity", as the Activity tabs pages do. `/risk` has the title "Risk & mix".
- **Plan tabs.**
  - Overview writes no `tab` (the bare `/plan`). Goals and Retirement write `?tab=` with `replaceUrl`.
  - Leaving Goals drops `preset` and the fragment, so the old anchor does not follow the user to another tab.
  - The panel is `role="tabpanel"`, labelled by the selected tab.
  - Plan has no T0 of its own here. ProjectionComponent leads Overview, as it led Forecast › Outlook (W5-F1).
- **Anchors and the sticky app bar.** The router's anchor scroll calls `window.scrollTo` and ignores `scroll-margin`, so a linked heading lands under the 62 px app bar. It also runs before async sections have their height.
  - **Risk & mix** keeps the linked section in view. Two macrotasks after the fragment changes (so after the router's own scroll), it aligns the section with `scrollIntoView` (sections carry `scroll-margin-top: 80px`). A ResizeObserver on the host then re-aligns it while the Allocation lab, planner and stress cards load. This stops at the user's first wheel, touch, key or pointer, or after 4 s.
  - **The "On this page" chips** re-run that alignment when the user clicks the anchor already in the URL (the router ignores a same-URL click).
  - **Goals** (`#goal-<id>`, `.goal { scroll-margin-top: 80px }`) and **Cash flows** (`#future`) scroll once, two macrotasks after their data has rendered. They use smooth scrolling unless the user prefers reduced motion.
  - The same app-bar overlap affects Performance's `#concentration` and other pages using the router's scroll. That is left for the shell or app config owner (for example `ViewportScroller.setOffset`); W4-F8 owns neither file.
- **Risk & mix `#rebalance`.**
  - The page reads `deploy.suggested` from Home's brief snapshot only (E20: it never fetches or writes `/brief`). Any finite number ≥ 0 counts as used, with `useNet` true.
  - With no snapshot, the planner starts at ₹0, has no net, and shows the line "Type an amount… Opening Home first starts this from the money ready to deploy".
  - The planner keeps `[allowSell]="false"` and `[riskLink]="false"`.
- **Risk & mix `#mix`.** The D11 notice links to `/settings`. The link reads "Set targets in Settings →" when no target is above 0, "Edit targets in Settings →" otherwise, and "See targets in Settings →" for guests. A bold "No targets are set yet." is added when none are set.
- **Section headings.** Each Risk & mix section has an `h2.q-head` (Risk profile · Target mix · Get back on target · Stress test · Where the risk comes from), so the hosted components' own h2 cards sit under a named section. The single h1 is "Risk & mix" (A22). `<app-portfolio-tabs />` comes first, as on Holdings.
- **Cash flows `?view=`.**
  - The interim section is placed last, after the ledger, so the past view is unchanged above it.
  - "Next 12 months →" links to `?view=both#future` with `replaceUrl` and scrolls to the section. In the future and both views, "Hide the forecast" sets `view` back to null.
  - Both `view=future` and `#future` scroll there once the ledger has loaded.
  - The page gained a first-load state: "Loading…" in the table and a faded KPI row. It also gained an inline error with "Try again" when the first `/cash` load fails. A later refresh failure keeps the last list and shows a toast, as before.
- **Section tabs.** Activity is Transactions · Cash flows · Recurring plans · Import, and Import is filtered out when `!auth.canWrite()`. Tabs carry `aria-current="page"`. The holdings group is unchanged.
- **Goals `embedded`.** When it is true, the wrapper drops `.page` for an `.embedded` flex column with the same gaps, and the title is an h2 (keeping the sub line and the "New goal" button). Nothing else in Goals changed, apart from the anchor scroll and `scroll-margin` above.
- **Checks run.** `ng build` and `npm run check` pass. A mocked API (a static server for a development build, with a fake token string and no real backend) loaded every §3.6 old URL in headless Chrome at 1280 and 390 px. All 25 cases landed on the expected URL with one h1 and no horizontal overflow, including `/risk#concentration` reached by a hash change while `/risk` was open, and `/goals?preset=home#goal-4`.

### W4-F5 builder decisions (USD wallet)

- **Verdict rule.** `walletVerdict(w)` is exported from `forex.component.ts` with `IDLE_USD = 50`. No cash position → `unset` ("No USD wallet yet · record a transfer to start"). `balance_usd` > 50 → `watch` ("$1,235 idle · deploy it", dollars to 0 decimals). Otherwise → `good` ("Fully invested"), including a balance at or below 0. The verdict line carries the icon and an sr-only status word, as on the Holdings class pages.
- **Hero.** It shows `balance_usd` in dollars, with "₹X at today's rate" (the position `value`) as its meta. With no wallet, the value is "—" and the meta reads "Nothing sent to the US yet".
- **"Average rate vs today".** The value is `avg_rate`. The meta is "today ₹R", where R is `current_rate`, falling back to `portfolio.usd_inr`. When both rates exist, it adds "· ±P% vs yours", where P = today / average − 1 and the sign is coloured.
- **The Deploy CTA's label is the backend's.** `cash:usd` carries `deploy_cta(amt)`, whose label is "Plan where it goes", not "Deploy". ActionCard renders that label and runs the `/actions?new_money=…#deploy` route. No backend edit was in scope, so the page does not relabel it.
- **Strip.** `<app-needs-attention [prefixes]="['/forex']" [ids]="['cash:usd']" [tiers]="['now','month','consider']">` sits between T0 and the Totals and Transfers cards. Those cards are unchanged.
- **States.** These follow the Holdings pattern:
  - a hero skeleton while nothing is cached;
  - "Couldn't load your USD wallet" with Try again when the portfolio fails and nothing is cached;
  - a "last numbers this device saw" notice when a refresh fails over cached data.

  The Transfers table also gained "Loading…" on the first load and an inline error with Try again. Before, a failure showed as "No transfers recorded". Loads are sequenced, so an older response cannot overwrite a newer one.
- **Layout.** The `.w-kpis` grid copies Holdings' `.h-kpis`: a hero and three tiles, then 2 columns at ≤ 900 px. At ≤ 760 px, "Gain on withdrawals" sits behind "More".
- **Checks run.** `ng build` and `npm run check` pass. A mocked API was used: a static server over a development build, a fake token and synthetic data, with no real backend, database or token. Four modes were loaded at 1280, 820, 760 and 390 px:
  - idle $1,234.56: `watch`, the strip shows `cash:usd` with its CTA;
  - $12.30: `good`, empty strip;
  - no wallet: `unset`, "No transfers recorded";
  - portfolio and transactions failing: the error card.

  Every load had one h1 ("USD wallet"), the portfolio tabs and no horizontal overflow. The third tile was hidden at 760 and 390 px.


### W4-F6 builder decisions (EPF and NPS class pages)

- **Scope.** Only `features/retirement/retirement.component.ts` (`/epf`, `/nps`; `kind` from route data). The planner in `features/forecast` is untouched. No backend, model or API edits.
- **Head.** `<app-portfolio-tabs />` comes first (as on Holdings), then the h1 "EPF" or "NPS" (A22, H19) with the sub line "Employees' Provident Fund · N accounts" / "National Pension System · N schemes". The passbook import, "Interest credited", "Contribution" and "Import NSDL CAS" buttons are kept for writers.
- **EPF T0.** Hero "EPF balance" (Σ value), status `info`, verdict "{₹ credited} credited · {₹ accruing} accruing · {rate}% declared" (compact rupees; the rate is the largest account's `rate`, 8.25 when missing, as before). Tiles: Contributed (`invested`, meta withdrawn or "employee + employer"), Interest (`interest_credited` + `accrued_interest`, meta "credited · accruing"), Return (XIRR) from the EPF segment. The strip is `prefixes=['/epf']` with the default tiers; it is normally empty.
- **NPS stale rule (G10/G15 mirrored).** Exported pure helpers `navAgeDays(priceAt, asOf)` and `npsStaleDays(position, asOf)` with `NPS_NAV_STALE_DAYS = 30`: an open NPS position with value > 0, no `symbol` and a `price_at` whose first 10 characters are more than 30 calendar days before the browser's local `today()`. 31 fires, 30 does not; a missing or unreadable `price_at` never fires; a market-priced scheme (with `symbol`) never fires, however old.
- **NPS T0.** Hero "NPS value". Status:
  - any stale scheme: `watch`, "NAVs N days old — update", N = the oldest stale age;
  - otherwise, with at least one NAV date: `good`, "NAVs as of {oldest NAV date of open schemes with value}", plus " · K valued at cost" when some schemes have no NAV;
  - no NAV ever entered on any open scheme: `unset`, "No NAV entered yet · valued at cost" (new: "good" with no date would claim freshness the data does not have; it raises no action, matching G15);
  - rows but nothing open: `info`, "All schemes closed · nothing held now".
  Tiles: Contributed (`cost`), Gain (value − cost, % on cost), Return (XIRR) with "NAVs as of …" meta.
- **NPS T1.** `<app-needs-attention [prefixes]="['/nps']" [ids]="['nps:nav-stale:']" [tiers]="['now','month','consider']">`; checked that a `data:stale-prices` row linked to `/nps` does not show.
- **Stale rows.** The NAV cell keeps the inline editor (`startNav`/`saveNav` → `updateInstrument(last_price)`; Escape now cancels) and adds `<app-status status="watch" word="{n} days old">` under the price and Update button, with an sr-only "Watch: NAV is" prefix. The badge wrapper is `position: relative` so the sr-only span cannot escape the table's scroll box and widen the page (it did, by 35 px, at 390 px before).
- **Phones (≤ 760 px).** The XIRR tile sits behind "More" (W3-F1 pattern, `.r-kpis` copies `.h-kpis`). The NPS table hides Units, Avg cost, Invested and XIRR; the EPF table hides Withdrawn, Accruing, Rate and XIRR. Names wrap and cells tighten; the table scrolls inside its card, never the page.
- **States.** First load with no snapshot: hero and table skeletons. Failed with nothing to show: "Couldn't load your EPF accounts / NPS schemes" with Try again. Failed refresh over a snapshot: the warn notice. Empty class: the existing "Track your …" start card with Add and Import.
- **Checked on a mocked API** (synthetic positions, fake token, headless Chrome, never the real server or database; scripts `w4f6/mock.py` and `w4f6/check.py` in the scratchpad), scenarios stale (31 and exactly 30 days, plus a 60-day market-priced scheme), fresh, no NAV, empty and error, `/epf` and `/nps` at 1280 and 390 px: one h1 each, no horizontal page overflow, only the 31-day scheme badged, the hero `watch` "NAVs 31 days old — update", the strip showing only `nps:nav-stale:21`. The copy database has no NPS position, so W3-B7's rule is still unverified on real data.

### W4-F4 builder decisions (Fixed deposits)

- **Page order.** `<app-portfolio-tabs />` first, then the page head (h1 "Fixed deposits", a "{n} open · {m} closed" sub line, and "New FD" for writers), as on Holdings. `<app-section-tabs group="holdings">` is gone.
- **T0 hero "Next maturity".**
  - The value is "{name} · {days} · ₹{payout}". It reads "today" for 0 days and "1 day" for 1. It wraps (22 px, 19 px on phones) instead of ellipsing, so a long bank name stays readable.
  - **Payout** = `maturity_value`, else `value`, the same fallback as actions' `fd:maturing`. The meta line keeps it honest: "on {date} · at {rate}% a year", or "value today; no rate to work out maturity" when `maturity_value` is null.
  - With no FD ≥ 0 days out, the value is "—" with "No maturity date ahead", or "No open deposits" when nothing is open.
- **Status.**
  - `act`: open FDs with `maturity_date` < today, using the local ISO date as `core/format.today()` returns it (A28). The verdict is "N matured FD(s) not recorded", followed by a "Mark matured" button for writers. The button opens the oldest matured FD; the table has a button on each row. Guests see the verdict without the button.
  - `watch`: the next maturity is ≤ 30 days away. The verdict is "Matures within 30 days · plan where the money goes", or "Matures today · …".
  - `good`: "Nothing matures in the next 30 days".
  - **New:** `info` with "No open deposits" when only closed FDs exist. "On track" would claim something there is nothing to judge.
- **Tiles.** Active deposits (Σ `invested` of open FDs, "{n} FD(s)"), Interest accrued (Σ `accrued_interest`, "on open FDs, not yet paid out") and Value today. At ≤ 760 px Value today goes behind "More". `.fd-kpis` copies `.h-kpis`, with border fixes for the 2-column grid at ≤ 900 px.
- **Mark matured (A19).**
  - The local modal and its state (`maturing`, `mDate`, `mAmount`, `error`, `mature()`) are deleted. The page no longer injects ApiService or ToastService.
  - The hero button and every row button call `dialog.openFdMature(p.id, actionService.find('fd:matured-unrecorded:' + p.id)?.id)`. An early closure of an FD that has not matured has no such action and passes no id.
- **Table.**
  - **Matured, unrecorded:** a `bad` badge "Matured, not recorded" with an alert icon, so the state is never shown by colour alone.
  - **Open, 0–30 days:** the existing days badge stays ("today" / "Nd"). Beside it is an `a.badge.info` "Redeploy ₹X" (`routerLink="/actions"`, `queryParams {new_money: round(payout)}`, `fragment="deploy"`), whose aria-label names the FD.
  - **Phones:** Started and Rate are `hide-sm`, as At maturity already was. The table scrolls inside its card.
- **States.**
  - First load: hero and table skeletons.
  - Failed with no portfolio: "Couldn't load your fixed deposits" with Try again.
  - Failed refresh: the warn notice over the last numbers.
  - Empty: the existing "No fixed deposits yet" text, now as a card with "Add your first FD" for writers, and no hero.
- **Helpers** `FD_SOON_DAYS`, `fdPayout`, `maturedUnrecorded` and `maturingSoon` are exported from the component file for reuse by W5-F9's Cash flows strip.
- **Checks.**
  - `ng build` and `npm run check` pass.
  - Tested on a mocked API with synthetic FDs, a fake token, and never the real server or database (scripts `w4f4_mock.py` and `w4f4_check.py` in the scratchpad). Modes: matured, soon, calm, none, fail and guest.
  - At 1280 and at a true 390 px (a 390 px same-origin iframe, because headless Chrome will not size a window below 504 px), every mode had one h1, the portfolio tabs and no horizontal page overflow.
  - Verdicts were `act`/`watch`/`good` as expected. The third tile was hidden at 390 px. Redeploy links went to `/actions?new_money=320712#deploy`. The strip showed only `fd:` rows.
  - A scripted click on the hero's "Mark matured" opened the shell's global dialog for the matured FD.

### W4-F3 builder decisions (P2P class page)

- **Order and h1.** `<app-portfolio-tabs />` comes first, then the page head with the single h1 "P2P lending" (A22) and a sub line "N active loans of M · as of {date}". This is the order on Holdings and Risk & mix, so the tabs and class chips stay in place when the user moves from `/holdings/equity` to `/p2p`. The Import, Repayment and Loan buttons stay in the head for writers.
- **Hero "Outstanding"** is Σ `outstanding` of loans with `status = 'active'` (the existing `stats().outstanding`, and the "Still outstanding" segment of the stack bar). A defaulted loan is `is_open` in the portfolio engine, but its outstanding is its `at_risk`, which the verdict names. Counting it in the hero as well would count the same money twice. Meta: "N active loans · ₹X lent in all".
- **Verdict (H19)** comes from the exported pure function `p2pRisk(loans, totals.value)`, which mirrors `brief._money_at_risk` for P2P:
  - a loan with `at_risk` > 0 adds its `at_risk`;
  - any other `is_open` loan with `overdue_days` > 30 adds its `outstanding` and counts towards n;
  - `act` at ≥ 1% of `totals.value`, or when there is no value to compare with (as the vital does); `watch` above 0; else `good`.
  - Text: "At risk ₹X · n overdue 30+ days". "30+ days" is added because the Overdue tab counts loans more than 7 days late, so a bare "n overdue" would disagree with the tab's count. With nothing at risk the verdict reads "Nothing at risk · no loan over 30 days late". A second meta line under the verdict gives "{pct}% of your portfolio" (or "Under 0.1%"), plus "₹Y still out on late loans" when there is any. The verdict has an icon and an sr-only status word.
- **Tiles.**
  - Interest after fees: Σ `interest` (already net), with "₹F paid in platform fees" as meta.
  - Realised XIRR: `segments[P2P].xirr`, shown "vs R% stated". R is the exported `weightedRate(loans)`: the outstanding-weighted `rate` of active loans with outstanding > 0. When no open loan has a rate, R falls back to the old plain average across all loans. The basis is in the `title`. When XIRR is more than 1 point below R, the meta adds "· defaults and fees explain the gap".
  - Principal back: Σ `principal_repaid`. Its meta is "₹X in 30 days, not reinvested" from the first visible (`ActionService.actions()`) `cash:p2p-principal:*` action's `impact.amount`; without one, it is "P% of what you lent". This is the third tile, so it goes behind "More" at ≤ 760 px.
  - The `.h-kpis`/`.more-stats` rules are copied into the component's styles, because W3-F1's rules are scoped to HoldingsComponent and `styles.scss` is not this task's file. A later shared-styles task may lift them into `styles.scss`.
- **T1 strip:** `prefixes=['/p2p','/cash-flows']`, `ids=['p2p:','cash:p2p-principal:']`, `tiers=['now','month','consider']`. So `p2p:yield` and the info-severity principal action both show (max 2, as the component defaults). An `fd:` action whose link is not under these prefixes never shows.
- **`?tab=`.** `tab` is computed from `queryParamMap` (`toSignal`). An unknown or missing value reads as `active`. A click calls `router.navigate([], {queryParams: {tab}, queryParamsHandling: 'merge', replaceUrl: true})`, so other parameters are kept and Back leaves the page. `P2P_TABS` is exported.
- **`?import=lenden`** opens the import dialog only when `auth.canWrite()`. The Import page that links here sits behind `writeGuard`, but a guest typing the URL used to get the dialog. Closing the dialog, or a successful commit, drops `import` from the URL with `replaceUrl`, so a reload does not reopen it. The import flow itself is unchanged.
- **States.**
  - Loading (no portfolio and no error): a hero skeleton and a card skeleton.
  - First-load failure: "Couldn't load your P2P loans" with Try again (`store.reload()`).
  - A later refresh failure: the stale-numbers notice, as on Holdings.
  - No loans: "No P2P loans yet", with "Add your first P2P loan" and "Import LenDen reports" for writers.
  - The T2 card carries "Explains: Outstanding · {status word}".
- **Kept as is:** the stack bar, the lending-type cards, the loan table (sorting, the lending-type filter, search, the 7-day "Overdue" badge and tab rule), the cohorts, and the whole LenDen import.
  - Tab and filter buttons gained `type="button"` and `aria-pressed`, and the search field gained an aria-label.
  - On phones the search field takes a full row.
- **Checked on a mocked API** (synthetic loans, a fake token, headless Chrome; never the real server, database or tokens; scripts `w4f3_mock.py` and `w4f3_check.py` in the scratchpad). Phone widths were measured inside a 390 px iframe, because headless Chrome's minimum window is wider than 390 px.
  - Mode risk: one defaulted loan, one 45 days late, and an `fd:` action that must not show.
    - At 1280 px and at 390 px, the page has one h1 and no horizontal overflow, and the verdict is `act` "At risk ₹9,000 · 1 overdue 30+ days".
    - The strip shows `p2p:defaulted` and `cash:p2p-principal:2026-10`, and the Principal back meta reads "₹15,400 in 30 days, not reinvested".
    - The third tile is hidden at 390 px.
    - `?tab=overdue`, `?tab=defaulted` and `?tab=bogus` select Overdue, Defaulted and Active.
    - A tab click wrote `?tab=closed` while keeping the other parameters, and `history.length` did not change.
    - `?import=lenden` opens the dialog.
  - Mode clean: the verdict is `good` and the strip shows `p2p:yield` (consider tier).
  - Modes empty and fail show their states.
  - Mode guest: `?import=lenden` opens no dialog, and `?tab=defaulted` still works.
  - `ng build` and `npm run check` pass.

### W4 integrator decisions

- **Contracts checked against real payloads.** The full P1 fixture (`test_p1_api.full_p1`: synthetic users, temp DB, offline prices) was used to dump `/plan`, `/assumptions` (with and without `?mix=`), `/sips`, `/settings`, `/markets`, `/brief`, `/actions`, `/rebalance`, `/tax/what-if`, `/forecast` and `/instruments/<id>/outlook`. Every key W4-F1 typed from H6–H11 is present with the typed shape. Guests may call `/tax/what-if`, and a holding with no price is a 400 with "enter a sale price", which the modal shows inline.
- **`Plan.funding` and `Plan.cushion` are `| null`** in models.ts. W4-B1 returns them as null, with a `notes` line, when their engine fails, so `/plan` never returns 500. This supersedes H6's non-null typing. W5-F1 must handle the null case.
- **`ProjectionHonesty.cone?`** is added for W4-B2's `HONESTY['cone']`. It is optional, so payloads from before W4-B2 still type.
- **`cash:usd` CTA label is "Deploy"** (SPEC §5.7, WAVES W4-F5): `deploy_cta(amt, "Deploy")`. This supersedes the W4-F5 note that the label is "Plan where it goes". The route is unchanged (`/actions?new_money=<n>#deploy`), and `test_actions.py` pins the label.
- **Router anchor offset.** The shell calls `ViewportScroller.setOffset([0, 80])`, so the router's anchor scroll (`withInMemoryScrolling`) lands below the sticky app bar on every page: `/performance#concentration`, `/settings#prices`, `/settings#people`, `/actions#deploy`. 80 px matches the pages' own `scroll-margin-top`. Pages that align with `scrollIntoView` (Risk & mix, Goals, Cash flows) are unaffected.
- **The projection's "Change the mix" link** goes straight to `/risk#profile`, not through the `/forecast?tab=allocation` redirect.
- **Route audit.** Every API path in `api.service.ts` (and the planner's direct `/rebalance` call) is served by a backend route. Every in-app link in the frontend sources, and every backend `link`/`route` string, starts with a routed segment. No link targets a retired URL except through the §3.6 redirects. The interim anchors and tabs still to come are those listed under "Known interim link targets": `/settings#cushion` (W5-F7), `/tax?tab=save|whatif` (W5-F4), `?return=` on `/plan` (W5-F1, D13) and `/actions?tab=review` (W7-F4).

### W4 review fixes

- **Advice to hold is never marked done by a sale (amends H17 "plus the `actionId`").** `tax:wait-lt` ("Hold <name> N more days") is the only ranked action with a `whatif` CTA. ActionRunner's `whatif` case passes `actionId` only for a ranked action that is not hold advice (`holdAdvice(id)`: ids starting `tax:wait-lt:`), so "Record this sale" from it opens a plain SELL. The advice is followed when the lot turns long-term (`CLEARED_IS_DONE`). As a backstop, `actions.follow_through` leaves a `tax:wait-lt` row done with `evidence.txn_ids` out of `acted_90d`, on-time and lag, and adds none of its impact to `impact_realised_fy` (`_sold_instead_of_waiting`). Pinned in `test_actions.py`.
- **Market state has a freshness bound (amends H4/D6).** `markets.market_state` returns None when its newest close is more than `STATE_MAX_AGE_DAYS = 5` calendar days before `today` (a long weekend plus a holiday still passes). ^NSEI closes are stored only when performance, risk, an outlook or Markets runs, and the payload speaks in the present tense, so stale closes give no Home market context line and no Markets dot. Pinned in `test_p1_api.py`.
- **A page carries out an action that points at itself (amends A7/A27 for T1 strips).** `ActionCard` takes `localRun: (a) => (() => void) | null`, the host page's in-place handler, which `NeedsAttention` passes on. Without one, the card hides a `route` CTA whose path is the page already shown (no query or fragment to apply) and a View link to it. The page path is read from the card's `ActivatedRoute`. On `/nps`, `nps:nav-stale` opens that scheme's NAV editor, scrolled into view and focused. On `/p2p`, `p2p:yield` ("Open P2P") shows no CTA. On Home and Actions, both still navigate.
- **`/assumptions` honesty has no raw templates.** `assumptions.honesty_view(sims)` formats `p50` and describes `probability` as "Chances are given as N of 100 simulated futures". The drawer also leaves out any label still holding `{` or `}`. `HONESTY` itself is unchanged, since forecast and goals format `{n}` per figure. Pinned in `test_p1_api.py`.
- **With nothing valued, the portfolio chip and the bands are the forecast's diversified mutual fund.** `assumptions.NO_HOLDINGS_MIX = {Mutual Funds: 1}` and `NO_HOLDINGS_BASIS` ("diversified mutual fund (no holdings yet)", which forecast already used). `brief.assumptions_block` uses them when `weights_from_positions` is empty, and `/assumptions` computes its `typical_bands` from them. The segment rows still show 0% held. `assumptions_check` still returns None with nothing held. Pinned in `test_p1_api.py`.
- **The what-if wait hint names its price assumption.** It reads "sold on <date> at the same price (<price>), the tax is …", and its est. basis starts "Assumes the price is still the same on that date." That is what `tax.what_if_sale` prices the later sale at.

---

## Wave 5

Prepared against the working tree after wave 4 landed (backend pytest 555 passed; `ng build` and `npm run check` green). Decisions J1–J20 bind wave 5 and every later wave. They add to Parts A and B, E1–E20, G1–G16 and H1–H20. Where they differ from WAVES.md, waves.json or SPEC.md, they win.

### Ownership and parallel safety

**J1. The wave-5 task list differs from WAVES.md as follows.**
- **W5-F9 (Cash flows, the old W4-F2) and W5-F10 (Performance P1, the old W4-F7) are in this wave** (A2, D19, H1).
- **W5-F1 is split in two.** WAVES' W5-F1 is three pages (Overview, Goals, Retirement) behind one shell, too much for one builder.
  - **W5-F1** keeps the Plan hub: the shell (T0 on every tab, tabs, strip, chip, the one-time note) and the Overview tab, and moves the projection into `features/plan/`.
  - **W5-F11 (new)** rewrites the Goals tab and the Retirement tab **in place**, at their current paths, class names and selectors (J3). The move into `features/plan/` is done by the integrator after both land.
- **No backend task.** Every endpoint wave 5 reads exists (H6–H11, H14, `/income`, `/forecast*`, `/risk`, `/optimizer`, `/rebalance`). No wave-5 task edits any backend file. A builder who finds a backend gap reports it and works around it in its own files.
- **File lists:**

| Task | Files |
|---|---|
| W5-F1 | `features/plan/plan.component.ts`, new `features/plan/plan-overview.component.ts`, new `features/plan/projection.component.ts` (moved), `features/forecast/projection.component.ts` (deleted) |
| W5-F11 | `features/goals/goals.component.{ts,html}`, `features/forecast/retirement.component.ts` (all rewritten in place) |
| W5-F2 | `app.routes.ts`, `features/risk/risk-mix.component.ts`, new `features/risk/allocation-lab.component.ts`, new `features/risk/stress.component.ts`, new `features/risk/risk.component.ts`, `features/forecast/{allocation-lab,stress,risk}.component.ts` (deleted), `shared/rebalance-planner.component.ts` |
| W5-F3 | `features/recurring/recurring.component.ts`, new `features/recurring/sip-plans.component.ts` (moved), `features/forecast/sip-plans.component.ts` (deleted) |
| W5-F4 | `features/tax/tax.component.{ts,html}` |
| W5-F5 | `features/overview/overview.component.{ts,html,scss}` (`pulse.components.ts` no longer exists; W2-F2 deleted it) |
| W5-F6 | `features/holdings/holding-detail.component.{ts,html}`, `features/holdings/outlook-card.component.ts` |
| W5-F7 | `features/settings/settings.component.{ts,html}` |
| W5-F8 | `features/actions/actions.component.{ts,html,scss}`, `shared/priority/action-card.component.ts` |
| W5-F9 | `features/cash-flows/cash-flows.component.ts`, `features/forecast/cashflow.component.ts` (deleted), `shared/charts/bar-chart.component.ts` |
| W5-F10 | `features/performance/performance.component.{ts,html,scss}` |

- **New files.** A task may add new files only inside a folder that no other wave-5 task owns: `features/plan/` (W5-F1), `features/risk/` (W5-F2), `features/recurring/` (W5-F3), `features/tax/` (W5-F4), `features/cash-flows/` (W5-F9), `features/performance/` (W5-F10), `features/overview/` (W5-F5), `features/settings/` (W5-F7), `features/actions/` (W5-F8). W5-F6 may add files named `features/holdings/holding-*.ts`. W5-F11 adds none. A new file belongs to the task that creates it.
- **Owned by no wave-5 task** (must keep compiling; never edited): `core/*` (including `models.ts`, `api.service.ts`, `action.service.ts`, `action-runner.service.ts`, `txn-dialog.service.ts`, `store.service.ts`), `styles.scss`, `layout/*`, `shared/*` except the three files listed above, `features/{holdings/holdings,p2p,fixed-deposits,forex,retirement,markets,transactions,import,reports,login}/*`, and the whole backend.
  - **Every type and API method wave 5 needs already exists** (W4-F1). A missing field is typed by a local interface in the task's own file, and a missing endpoint variant goes through `ApiService.get<T>()` (E2).
  - **Global styles are not edited.** A page that needs a class-page hero rule copies it into its own styles, as the W4 class pages did (H19). Lifting the copies into `styles.scss` moves to W7-F1, which owns that file.
- **A task's acceptance never depends on a sibling.** Each is `cd frontend && npx ng build && npm run check`, plus its manual checks on a mocked API (development build, a fake token, synthetic data; never the real server, database or tokens).

**J2. What a task may use from a sibling's file, and what that sibling must keep.** Only things that exist now:
- `RebalancePlannerComponent` (W5-F2's file) is used by W5-F3 and W5-F8 with its current inputs `newMoney`, `allowSell`, `useNet` and `riskLink`. W5-F2 may add optional inputs with defaults that keep today's behaviour. It must not rename, remove or retype these four.
- `features/actions/actions.component.ts` (W5-F8) keeps its exports `inFilter`, `isTaxMove` and `lossHarvestSaving` unchanged. W5-F4 may import `isTaxMove` and `lossHarvestSaving`.
- `features/overview/overview.component.ts` (W5-F5) keeps `PLAN_PRESETS` exported with the keys `emergency`, `education`, `home` and `retirement`. W5-F11 copies the keys rather than importing them.
- Read-only imports from unowned files are fine: `fixed-deposits.component.ts` helpers (`FD_SOON_DAYS`, `fdPayout`, `maturedUnrecorded`, `maturingSoon`) for W5-F9, `markets/market-parts.ts` (`SignalChipsComponent`, `SIGNAL_HONESTY`) for W5-F6, and `kindFor` / `holdAdvice` from `action-runner.service.ts` for anyone.

### Plan (W5-F1, W5-F11)

**J3. How the Plan split stays parallel.**
- **W5-F11 rewrites in place:**
  - `features/goals/goals.component.{ts,html}` keeps class `GoalsComponent` and selector `app-goals`.
  - `features/forecast/retirement.component.ts` keeps class `RetirementComponent` and selector `app-retirement`.
  - Both render **the tab body only**: no `.page` wrapper, no h1, no navy T0 and no page head (Plan owns them, A22). Section titles are h2.
  - `GoalsComponent` keeps an optional `embedded = input(false)` that no longer changes anything, because the wave-4 `plan.component.ts` still binds `[embedded]="true"` until W5-F1 lands. Mark it deprecated in a comment.
- **W5-F1's `plan.component.ts`** imports them from those same paths and names. It renders `<app-goals />` with no `[embedded]` binding, and `<app-retirement />`.
- **No inputs cross the boundary.** Each tab fetches its own data:
  - Goals uses `api.plan()` (funding, `sip`, `deltas`, the projected goals) plus the goals CRUD.
  - Retirement uses `api.retirement(params)` as today, plus `store.settings().retirementPlan`.
  - `/plan` is memoised (warm < 50 ms, H6), so the second GET is cheap.
  - **W5-F1 is the only writer of `snapshotKey('plan', scopeKey)`.** Goals may read it to paint first, and never writes it.
- **The URL contract:**
  - `?tab=goals|retirement`; Overview is the bare `/plan`.
  - `preset=emergency|education|home|retirement` and `fix=<goalId>` apply only on Goals. The fragment is `goal-<id>`.
  - When the user leaves Goals, W5-F1 drops `preset`, `fix` and the fragment, as the wave-4 page does with `preset`.
  - **"Fix" on an Overview goal row** navigates to `/plan?tab=goals&fix=<id>#goal-<id>`. Goals opens that goal's edit modal with `monthly_contribution` = `projection.required_sip` rounded up to ₹100, then removes `fix` with `replaceUrl`. A retirement row's Fix goes to `/plan?tab=retirement`.
  - **`preset=retirement`** makes Goals navigate to `?tab=retirement` (`replaceUrl`, `preset` dropped). Retirement is planned on its own tab, not as a goal, so the money is not counted twice in the funding stack. The other three presets open the add modal prefilled. Emergency is 6 × monthly expenses when `emergencyFund.monthly_expenses` or `retirementPlan.monthly_expenses` is set, else ₹3 L.
- **After both land, the integrator moves the files** (pure moves, no behaviour change; this completes WAVES' "move into features/plan"):
  - `goals.component.{ts,html}` → `features/plan/goals.component.{ts,html}`;
  - `forecast/retirement.component.ts` → `features/plan/retirement-planner.component.ts`, as class `RetirementPlannerComponent` with selector `app-retirement-planner`;
  - fixes the two imports and the tag in `plan.component.ts`;
  - deletes the `embedded` input and the then-empty `features/goals/` and `features/forecast/` folders.

**J4. One navy T0 per page on Plan.**
- `plan.component.ts` renders the T0 for every tab (§5.2).
- **The Retirement tab's §5.2 "hero order"** is a T1 verdict card, not a second navy hero: `app-verdict` "Chance of reaching ₹{corpus_needed}", whose big text is the probability ("72 of 100 futures"), with status `statusFromGoal(status)`. A plain stats row follows: Corpus needed at {retire_age}; On current path (`projected`, with `gap`); Monthly needed (`required_sip`, the 75% figure, worded "needs", est.).
- The Goals tab's funding strip is a plain line, not a hero.
- **A21 gains Plan's work surface:** "Goals at a glance" on Overview, one `.card` whose rows each carry a status badge.

**J5. The Plan T0 and head (W5-F1).**
- **Hero "Plan status"** = `plan.status.headline`, with `plan.status.status` setting the stripe and the verdict icon. The backend already appends " · family plan".
- **Tiles:**
  - **"Typical in {years} yrs"** = `/forecast` `end.p50` at the default horizon: max(10, years to the furthest goal `target_date`), capped at 30. Meta "1-in-10 bad {p10|inrc} · good {p90|inrc}" with `<app-est>`. The tile keeps the default horizon whatever the Adjust panel says. Overview reuses that payload while Adjust is at its defaults, so there is one `/forecast` call.
  - **"Investing each month"** = `sip.plans_monthly_total`. It is `watch` when below `sip.needed_monthly`, with meta "needs ₹{needed_monthly}/month".
  - **"Free money"** = `funding.free`, meta "after goals and cushion". It shows "—" when `funding` is null (the W4 integrator decision), with the `notes` line.
  - Phones keep the hero and two tiles; the third goes behind "More" (§1.5).
- **Head:** h1 "Plan", the sub line, and `<app-assumption-chip [block]="plan.assumptions">`.
- **Strip** `<app-needs-attention [prefixes]="['/plan']">` under T0, on every tab (A27).
- **The one-time note (§10.1):** "Monthly needed now aims for a 3-in-4 chance (was the average path)." It sits under the strip on every tab until dismissed, under `localStorage['plan:sip75-note']`, with every read and write in try/catch.
- **States:** paint from `snapshotKey('plan', scopeKey)`. Non-empty `plan.notes` show as one muted notice. `plan.empty` gives an unset hero, "No goals yet", with "Add a goal →" and "Plan retirement →".

**J6. Plan Overview (W5-F1).**
- **Goals at a glance:**
  - The rows are `plan.rows` in the backend's order (worst first), joined to `plan.goals` by id for `progress_pct`, `monthly_contribution` and `required_sip`; the retirement row uses `plan.retirement`.
  - Each row shows: name, "₹{target_amount} by {target_date}", a progress bar, `<app-prob-bar [value] [delta]>`, the status badge, "SIP ₹{monthly_contribution} / needs ₹{required_sip}", and Fix (J3).
- **How it could unfold (T2):** the moved ProjectionComponent.
  - It draws the p10–p90 and p25–p75 bands, the "Typical (median)" line and "Money put in" muted. There is no mean line.
  - It adds `kind: 'goal'` markers at each goal's `target_date`, with the goal name and `target_amount`.
  - The `xLabel` reads "2041 · 45" when `settings.retirementPlan.current_age` is known.
  - Beside the chart: 1-in-10 bad, Typical, 1-in-10 good, and Stop investing (`scenarios.no_more_investing`).
- **Funding stack (T2):**
  - One 100% bar of `funding.total`: each `earmarked[]` row, `cushion.amount` and `free`.
  - One `.notice.warn` per `over_allocated[]`: "{segment} is claimed {claimed_pct}% by {goal names}".
  - When `funding` is null it shows "Couldn't work out the funding" and the note.
- **Assumptions (T2, always visible):** from the `/forecast` `assumptions` block: `return_pct` ± `volatility_pct`, `typical_pct`, `basis`, `inflation_pct`, the `mix` rows and the short hash. It adds "Long-run assumptions, not predictions." and "Change the mix →" `/risk#profile`.
- **Adjust (T3, collapsed):**
  - Horizon `.seg` 5/10/15/20/25/30; monthly SIP (default `sip_plans_total`); step-up `.seg` 0/5/10/15; return override; the milestones table.
  - "Average path (pulled up by the best cases)" = `end.expected`, labelled with `honesty.mean`.
  - **`?return=<n>` (D13)** opens Adjust and prefills the return. The value is clamped to the API's −10..30 and rounded to 0.5. Nothing is written back to the URL.

**J7. The Goals and Retirement tabs (W5-F11).**
- **Both:** delete the local `STATUS` maps and use `priority.ts` (`statusFromGoal`, `statusFromProbability`, `STATUS_META`, `<app-status>`). Copy follows §1.9: "72 of 100 futures", "needs", est. tags on every forward ₹, never "will".
- **Goals:**
  - **Funding strip:** "Earmarked ₹X of ₹Y · Free ₹F · Goals need ₹N/month more". X = Σ `funding.earmarked[].amount`, Y = `funding.total`, F = `funding.free` and N = `plan.sip.gap_monthly`; the last clause is omitted when N is 0. With `funding` null, only the SIP clause is shown.
  - **Cards** are sorted act → watch → good → achieved, then by `target_date`. They keep `id="goal-<id>"`, the anchor scroll and `scroll-margin` (W3 integrator, W4-F8). Each card shows the ProbBar with `plan.deltas[id]`, and "needs ₹{required_sip}/month". `required_sip_typical` sits in a collapsed T3 line: "At the typical return: ₹X/month".
  - **Empty state:** the three goal presets plus a Retirement card that opens the Retirement tab.
  - **Modal:**
    - Each allocation input shows "already earmarked {p}%" (the other goals' share of that segment).
    - If any segment would exceed 100%, Save asks through `ConfirmService` ("Mutual Funds would be claimed 130% by Home and Education. Save anyway?"). Cancel keeps the modal open.
  - **`?preset=`, `?fix=` and the fragment** work as in J3.
- **Retirement:**
  - The verdict and stats row follow J4. `required_sip_typical` sits in a collapsed T3 line.
  - The chart's x-axis is labelled by age (the line chart's `xLabel`, from `path[].age`). It draws saving and retired areas and the dashed corpus needed.
  - Notice: "Money lasts past {life_expectancy}" when `runs_out_at` is null, else "Runs out around {runs_out_at}".
  - The FIRE card stays.
  - The aside form is grouped as You (age, retire at, plan until), Money (expenses, other income, SIP, step-up) and Assumptions (inflation, return while saving, return after). Save → `store.saveSetting('retirementPlan', …)`. Guests see it read-only.
  - A 400 (`retire_age ≤ current_age`) shows inline.

### Risk & mix (W5-F2)

**J8. The page.**
- **Order:** `<app-portfolio-tabs />`, then the head (h1 "Risk & mix"), T0, strip, then the work surface. The work surface (A21) is one `.card` containing `#profile` → `#mix` → `#rebalance`, each with its own h2. Then `#stress` and `#risk` (T2), then `#concentration` and "How holdings move together" (T3, collapsed). The W4-F8 anchor alignment (scroll-margin, ResizeObserver, re-aligning the same-URL chip) is kept.
- **T0 "Risk vs your profile":** the verdict is `vitalOf(brief.vitals, 'risk')`'s status and value. The brief is read per E20: `snapshotKey('brief', scopeKey)` first, else `api.brief()` without `since`, never written.
  - **Tiles:**
    - "Off target": max|drift| pts and ₹ Σ|drift| × targeted value / 200, from `brief.allocation` (targeted value: Σ `value` of the rows with a target; W5 review fix).
    - "A routine correction": the stress `correction` row's `impact` and `impact_pct`, est.
    - "A bad day (1 in 20)": `/risk` `var_95.day`, or "needs 30 days of prices".
  - The hero reads `unset` "Set a risk profile" when the vital is unset.
- **Strip:** `<app-needs-attention [prefixes]="['/risk','/holding/']" [ids]="['risk:above-profile','stress:','drift:','concentration:','sector:','targets:missing']">`. `concentration:<iid>` links to `/holding/<id>`, so the id filter is what keeps `loser:` and `winner:` off this page.
- **Profile:**
  - Four buttons from `GET /optimizer` `profiles`. `current.closest_profile` is highlighted, and the saved `riskProfile` carries a tick icon and the word "Saved".
  - "Remember this profile" → `store.saveSetting('riskProfile', key)`. Guests see it read-only.
- **Target mix:** the editor moves here from Settings (W5-F7 removes it there).
  - Drift bars per segment come first.
  - The table is Segment / Now % / Target % / Suggested % (the chosen profile's `weights`).
  - "Use current mix" and "Use suggested" round to 0.5 and put the remainder on the largest row, so the sum is exactly 100.
  - Save is enabled when |sum − 100| ≤ 0.5 (the backend rule) → `store.saveSetting('targetAllocation', …)`.
  - **"Preview impact"** calls `api.assumptions(mix)` (H7) with the edited table, debounced and only while the sum is valid. It shows `portfolio` against `proposed` (return, typical, volatility) with est. tags and the chip. A 400 shows inline. Goal and retirement Δ are P2.
- **Get back on target:**
  - `<app-rebalance-planner [riskLink]="false">`, defaulting to no-sell with `brief.deploy.suggested` and `useNet` true when that default is used (A15, W4-F8).
  - The planner gains the `months_to_fix` line and "Tax if sold" (J9).
- **Stress:** the moved StressComponent. Cards are worst-first by `impact_pct`, every ₹ carries est., and `stress.assumptions` gives the chip.
- **Where the risk comes from:** the moved RiskComponent.
  - Columns: Holding / Weight / Volatility `volatility_pct | volatility_used_pct` (headed "measured | used") / Beta / Risk share / Data. Data is `own`, or `proxy` with the proxy name.
  - A risk share above 1.3 × weight is red **and** carries an ▲ glyph and the word "high", never colour alone.
  - Then the read-outs.
- **Concentration (`#concentration`, T3):** largest holdings (the top 10 by weight), stock sectors and company size, built from `store.positions()`. Port Performance's `group()` code; W5-F10 deletes it there. The block opens and scrolls when the fragment is `concentration`.
- **How holdings move together (T3):** the `/risk` correlation heat table (full names in `title`) and the frontier chart (`app-frontier-chart`, moved with AllocationLab).
- **`app.routes.ts`:** delete `riskGuard` and the `/risk` route's `canActivate` and `runGuardsAndResolvers`. `/risk#concentration` now lands on this page. Update the comment block. Nothing else in the routes changes.

**J9. The planner's P1 lines (`shared/rebalance-planner.component.ts`).** These show on every page that hosts the planner.
- **`months_to_fix`** (H14), while selling is off and the value is not null:
  - 0 → "Nothing to fix without selling";
  - N → "At your SIP + maturity pace this closes in ~N months", with est.
- **"Tax if sold" on a `sell` row.** FD and P2P rows read "Redirect maturities" and are excluded.
  - It is a button. On click it prices one sale: the segment's open holding with a price and the largest value (`store.positions()`, matched on `segment`, `has_price`, `quantity` > 0).
  - qty = min(`quantity`, row `amount` / (`value` / `quantity`)), rounded up to whole units for equity and commodity and to 0.001 for funds.
  - It calls `api.whatIf({instrument_id, qty})` and shows "≈ ₹{tax_now} tax selling {qty} of {name}" (est.). A negative value reads "saves ₹N".
  - "Plan the sale →" opens `dialog.openWhatIf({instrumentId, qty})`.
  - A 400 (an ELSS lock, or no price) shows its message. The result is cached per (segment, amount).
  - Ordering sells by lowest tax is P2 (W7-F3).
- The planner's inputs stay as J2 says.

### Recurring, Tax and Cash flows

**J10. Recurring (W5-F3, §5.9).**
- **Head:** h1 "Activity" and the Activity section tabs (W4-F8, A22). The browser title is the route's "Recurring plans".
- **T0:**
  - The hero is "₹{monthly_total}/month across {n} plans".
  - The verdict is "Adherence {adherence_6m_pct}% over 6 months", with the H11 habit thresholds: ≥ 90 good, ≥ 60 watch, below 60 act, and `unset` with no score or no active plan.
  - Tiles: "This month: ₹{invested_this_month} of ₹{planned_this_month}", and Next due (`adherence.next_due[0]`: name · date · amount).
- **Strip:** `prefixes=['/recurring']`, tiers `['now','month','consider']`.
- **Work surface "This month's money":**
  - **Instalments** are every active plan's `adherence.plans[].months[]` rows whose `month` is the current YYYY-MM, all frequencies (weekly gives several), sorted by `due`. Badges, each with an icon and a word:
    - `done` → Recorded (good);
    - `partial` → Partly recorded (watch);
    - `skipped` → Skipped (info);
    - `missed` → Missed (act);
    - `upcoming` with `due` ≤ today → Due (watch; still inside the E18 grace);
    - `upcoming` with `due` > today → Upcoming (info).
  - **"Record"** (writers; not on done or skipped rows) opens `TxnDialogService.add(kind, …)` with `{instrumentId, type: 'BUY', amount: planned − invested, date, actionId}`.
    - `kind` is `kindFor(asset_class, 'BUY')`, using the plan's `asset_class`, or the segment's class for a segment plan.
    - `date` is `due` when `due` ≤ today, else today.
    - `actionId` is `sip:missed:<sid>:<due>` or `sip:due:<sid>:<due>`, only when `ActionService.find` knows that id.
    - The user confirms units (§10.2).
  - **"Skip this month"** (writers; due, upcoming, missed or partial rows) calls `ActionService.setStatus(id, {status: 'dismissed', reason: 'skipped'})`. The id is `sip:missed:<sid>:<due>` for a missed row and `sip:due:<sid>:<due>` otherwise (A11). Then `/sips` is reloaded.
    - An "Undo" stays on that row for the session and posts `open` to the same id. After a reload there is no Undo; review is P2.
- **Arriving:** `sips.arriving` rows (label, date, amount, a link per H9), plus `arriving_total`.
- **Extra to invest:**
  - A ₹ input, default 0, then `<app-rebalance-planner [newMoney]="extra + arriving_total" [useNet]="arriving_total > 0" [allowSell]="false">`.
  - **This amends A15 for this page:** the arriving money is still netted against the segments that hold it, and the extra is genuinely new money, so netting stays right when the user adds to it. An amount typed inside the planner itself still drops the netting (W2-F3).
- **Plans table (T2):** the moved SipPlansComponent, plus a 6-dot adherence strip from that plan's last 6 `months[]`. Each dot has an icon, colour and `title`, never colour alone.
- **Guests** get no Record, Skip, Pause, Edit or Delete.

**J11. Tax (W5-F4, §5.8).**
- **URL:**
  - `?fy`, `?tab=save|whatif|gains|estimate` and `?whatif=<iid>` follow `queryParamMap` and are written with `replaceUrl` and merge.
  - The default tab is `save` for the current FY and `gains` for a past FY.
  - `save` on a past FY reads as `gains`.
  - `whatif` exists for the current FY only. `?whatif=<iid>` implies `tab=whatif` and the current FY. This is what the action links `/tax?tab=whatif&whatif=<id>` (W3-F1, actions.py) and `/tax?tab=save` expect.
- **Head:** the FY select, Export CSV, and the chip "N days left in {fy}" (current FY only).
- **T0:**
  - The hero is "Estimated tax {fy}" = `estimate.total`, meta "at {slab_rate}% slab · change" → `/settings#profile`.
  - **The verdict "You can still save ₹X":** X is the same number as Actions' "Tax you can still save": Σ lump `impact.amount` of the open and planned tax moves (`isTaxMove`, J2) in `ActionService`. One figure everywhere. Status is `good` at 0 and `watch` above it. A past FY reads `info` "FY closed".
  - **Tiles:**
    - Tax-free LTCG left: `equity_exemption.remaining` of `limit`.
    - Capital gains: summary short · long.
    - Next deadline: the first `brief.upcoming.events[]` with kind `tax`, read per E20; "—" when there is none in 90 days.
- **Strip** `prefixes=['/tax']`.
- **Work surface "Ways to save"** (current FY):
  1. **Harvest plan:** `opportunities.harvest_plan.rows` (Holding / Units to sell / Proceeds / Gain booked / Lots / Plan this sale). The total "Books ₹{total_gain} tax-free · saves ≈ ₹{future_tax_saved} later" carries est., followed by `harvest_plan.note` (the rebuy note) and the D12 sentence.
  2. **Offset gains with losses:** `loss_harvest` rows, `loss_harvest_offsettable`, and the saving from `lossHarvestSaving` (est.).
  3. **Wait before selling:** `upcoming_long_term` with `tax_saving` and `lt_on`.

  Every row's "Plan the sale" is `dialog.openWhatIf({instrumentId, qty})` (the row's units) **with no `actionId`**. A page row is not the ranked action, so a sale recorded from it never marks harvest or wait advice done (W4 review fix).
- **"What if I sell" tab:**
  - An inline form: the holding select (open equity, mutual-fund and commodity positions with `quantity` > 0), qty (default all), price (default `position.price`, D16; dollars for USD holdings) and date (default today).
  - It calls `api.whatIf` and shows the lots, ST/LT gain, exemption used and left, tax incl. cess with est., net cash, effective %, the `wait` hint, the note and any 400 inline.
  - "Record this sale" (writers) → `TxnDialogService.add` SELL prefilled with the instrument, qty and date.
- **T2:** the exemption meter and the `tax_lines` meters, each with "Explains: …".
- **T3:** realised gains (`.seg` All/STCG/LTCG/Intraday and the table), and the estimate (`tax_lines`, cess, `set_off`, income rows).

**J12. Cash flows (W5-F9, §5.10).**
- **Head:** h1 "Activity" and the Activity tabs.
- **`?view=past|future|both`** follows `queryParamMap`. **No value now means `both`** (amends H18's interim "no value means past"): the chart always shows both halves.
  - `past` hides the future tiles and the future dates.
  - `future` shows the future tiles and scrolls to the future half (`#future`).
  - `/cash-flows?view=past` (`actions.py`) and `?view=future` (§3.6) both keep working.
- **T0:**
  - The hero is "Net contributed" (`contributions.net`), with Deposited and Withdrawn. On the escrow `.seg` it shows "Escrow balance".
  - The future tiles (12 months, est.) are Income due (dividends + interest + EPF interest), Principal back and SIPs out, from `/forecast/cashflow?months=12` `totals`.
- **Strip:** `prefixes=['/cash-flows','/fixed-deposits']`, `ids=['fd:','cash:']`, tiers `['now','month','consider']` (A27, H19).
- **T1 chart (the page's work surface):**
  - Past bars are net contributions per month for the last 24 months, from `/cash`.
  - Future bars are `net` for the next 12 months, muted and labelled "estimate", with an inflow/outflow tooltip.
  - A "today" divider separates them.
  - `<app-assumption-chip [block]="cashflow.assumptions">` sits on the future part.
  - **`shared/charts/bar-chart.component.ts` gains additive inputs only:** a per-bar `muted?` on `Bar`, a divider index with a label, and extra tooltip rows. Today's callers are unchanged.
- **T2 "Dates to know":** `events[]` (`fd_maturity` → `/fixed-deposits`, `p2p_close` → `/p2p`, `p2p_overdue` → `/p2p?tab=overdue`). A row with a visible matching action (`fd:maturing:<iid>`, `fd:matured-unrecorded:<iid>`) runs it through `ActionRunner`. "What this means" shows `notes` and the honesty disclaimer.
- **T3:** the ledger table and the add-entry modal (existing).
- `forecast/cashflow.component.ts` is deleted. The FD helpers are imported from `fixed-deposits.component.ts` (J2).

### Home, holding, Settings, Actions, Performance

**J13. Home P1 (W5-F5).**
- **The chip:** `<app-assumption-chip [block]="bb.assumptions">` replaces the `.assumption-chip` span (H20).
- **The habit card's `pace` is a percentage** (H11: invested ÷ planned × 100). Home prints it as "pace ₹X/mo", which is a bug. It reads "{pace}% of this month's plan".
  - The sentence adds "Next: {name} ₹{amount} on {date}" from `habit.next_due`, and "Next milestone {label} {in}" from `habit.milestone`.
  - "Not scored yet" stays only while `adherence_6m_pct` is null.
- **The all-clear sentence** becomes "Nothing needs you. Next: SIP ₹{amount} on {date} · review due {date}". This lifts E20's P0 omission, now that `next_due` is in the brief.
- **Coming up:** an `fd_maturity` row adds "suggest: {segment}". The segment is the one with the most negative `drift` in `brief.allocation` (D4), and the suggestion shows only when some target exists and that drift is below 0.
- **Context line:** a `market` line keeps its `/markets` link. The FY-window and review lines are unchanged (the backend builds all three, H11).
- **Unchanged and to verify:** the cushion vital's unset text (the brief writes it), the Since stat with "N new", plan deltas, the assumptions-check sub-line (`/performance#assumptions`) and the "Acted on" footer.
- **Re-check the §9.4 fold and phone budgets** on a mocked API.
- **`PLAN_PRESETS` stays exported (J2).**

**J14. Holding detail (W5-F6, §5.5).**
- **Head:**
  - "← {class label}" to the class page (`SEGMENT_META[segment].route`, or `/holdings/<class>`), then the h1 name.
  - Badges with words: segment, the symbol or "No ticker", sector/category, Closed/Defaulted.
  - The class actions and Edit stay. **Delete moves into a ⋯ menu** (a button with `aria-haspopup`, and Escape closes it).
- **T0 verdict:**
  - act: "Valued at cost — set a ticker" (link `/settings#prices`) when an open equity, mutual-fund or commodity holding has `has_price` false;
  - else watch: "Large position: {weight}% of portfolio" when `weight` ≥ 15 (MF ≥ 25);
  - else good.
- **Tiles:** XIRR only when `first_date` is ≥ 365 days ago; otherwise "Return on money in" = `total_return` / `invested`. The class-specific tiles are unchanged.
- **Strip:** `prefixes=['/holding/<id>', '/tax?tab=whatif&whatif=<id>']` (G14's matching), tiers `['now','month','consider']`.
- **"Plan a sale"** is on open equity, mutual-fund and commodity holdings with `quantity` > 0. It calls `dialog.openWhatIf({instrumentId, qty: quantity})`. Guests may use it (a read).
- **Signals:**
  - The OutlookCard collapses to one signals row: trend badge, 3M momentum, RSI, volatility regime, and the Markets signal chips. The chips come from the `snapshotKey('markets', scope)` snapshot's `holdings[]` row for this id, rendered with `SignalChipsComponent`. Never fetch `/markets` for them; with no snapshot there are no chips.
  - "Show all statistics" expands the existing card.
  - The cone label is `assumptions.cone_label`, falling back to `HONESTY.cone`'s text: "statistical range at the asset class's long-run return; not a forecast". WAVES' "range if it behaves like the past" and the old `signal` fallback are not used (H16).
- **Open lots (FIFO, T3):** `position.open_lots`, joined to `/tax` `opportunities.open_lots` for this `instrument_id`. `/tax` is fetched when the T3 section opens.
  - Each lot shows a term badge with a word (Long-term/Short-term) and "turns long-term on {lt_on}".
  - **The per-lot "Plan a sale" prefills the cumulative FIFO quantity up to and including that lot**, labelled "Sell up to here", because a sale always consumes the older lots first.

**J15. Settings (W5-F7, §5.14).**
- **Anchor rail:** Profile & cushion · Alerts · Prices & tickers · Family (admins only). It is sticky under the app bar on desktop and a `.seg` strip on phones. It is a tool page: head and content, no T0 and no strip (§1.12).
- **`#profile`:**
  - `taxSlabRate`, `autoCapitalFlows`.
  - **The Emergency cushion editor, `id="cushion"` (A14):**
    - `monthly_expenses`, prefilled with the saved value, else `emergencyFundSuggest.monthly_expenses_hint`.
    - `months_target` 3–24, default 6.
    - A checklist of `emergencyFundSuggest.candidates` together with any saved `instrument_ids` (named from `store.positions()`). The saved ids are pre-ticked when `emergencyFund` is set; every candidate is pre-ticked when it is not.
    - `cash_amount` (A25): "Bank or savings money outside the tracker".
    - Live coverage: (Σ ticked values + cash) / expenses months, against the target.
    - Save → `store.saveSetting('emergencyFund', {months_target, monthly_expenses, instrument_ids, cash_amount})`. A 400 shows inline.
    - With `emergencyFundSuggest` null, the editor still works from the saved ids.
  - **Read-only summaries:** "Target mix: set · {profile label} →" (or "not set") to `/risk#mix`, and "Retirement plan: retire at {retire_age} →" (or "not set") to `/plan?tab=retirement`.
- **The target allocation editor is removed** (it moves to Risk & mix, J8).
- **`#prices`:** the Missing filter is the default only when a tradable open holding has no price; otherwise All.
- **Family view** (`auth.canSwitch() && !auth.portfolio()`) shows the banner "Editing the family plan". Guests see everything read-only.

**J16. Actions P1 (W5-F8, §5.1).**
- **The planner's `[riskLink]` is turned on** (the binding is removed), because `/risk` is a page now (H20).
- **Follow-through tile:**
  - "Acted on {done} of {total} in 90 days" and "₹{impact_realised_fy} realised this FY" with `<app-est>`.
  - `on_time_pct` and `sip_adherence_12m` go in the meta or the title when present.
- **Done "How":**
  - "Marked done" when `done_via` is manual.
  - Auto with `evidence.txn_ids` reads "Auto: {TYPE} #{first id}" (+N more) "on {done_at}". TYPE is MATURITY for `fd:matured-unrecorded:`, "trade" for `drift:`, `concentration:`, `sector:` and `risk:`, and BUY otherwise (the evidence rules in `actions.auto_done`).
  - Auto without ids reads "Auto: {condition}".
  - Undo (status `open`) is unchanged.
- **Tax moves:** "Book gains tax-free" uses `harvest_plan`. Its "Plan the sale" opens the what-if for `harvest_plan.rows[0]` (`instrument_id`, `qty`), and the sentence is "Books ₹{total_gain} across N holdings · see the harvest plan →" (`/tax?tab=save`). Offset and Wait are as today.
- **Deploy** lists every `deploy.sources` row (label, date, amount, a link by kind as H9) above the planner.
- **ActionCard for guests (J17).** Keep the J2 exports.

**J17. Guests and action CTAs (`shared/priority/action-card.component.ts`, W5-F8).** This amends the W1 card rule. Following §4 "Guest: CTAs that write are replaced with View":
- **`route` and `whatif` CTAs are reads**, so guests see them. The same-page hiding rules (`ctaHere`, `localRun`) still apply. ActionRunner already lets guests run both.
- **`dialog`, `fd_mature` and `api: review_complete` stay writer-only.** A guest sees "View" to `link`. When there is no link, the guest sees "View" to `/actions?id=<id>`, except on `/actions` itself.
- The ⋯ menu stays writer-only. Inputs and outputs are unchanged.

**J18. Performance P1 (W5-F10, §5.4).**
- **The "Concentration & risk" block and its `group()` code are removed** (D22; J8 moves it). A visit to `/performance#concentration` navigates to `/risk#concentration` with `replaceUrl`, so old links still land.
- **Assumptions check (`#assumptions`, T2):**
  - It reads `brief.assumptions_check` (E20: snapshot, else `api.brief()`, never written). It is whole-portfolio and since start, and says so when a segment is selected.
  - Text: "Since you started ({years} yrs): {realised}%/yr · the plan assumes {typical}% typical (range {lo}–{hi}%) — {verdict}".
  - Verdicts:
    - `within` → good;
    - `above` → info, "above the typical range";
    - `below` → watch;
    - `too_short` → unset, "Too early to judge".
  - "Use {realised}% in the Plan →" appears when `link` is set (`/plan?return=…`, D13).
  - The card carries `<app-assumption-chip [block]="brief.assumptions">` and "Explains: …".
  - Home's `/performance#assumptions` scrolls there once painted.
- **Income (T2, after paint):**
  - `GET /income` once per scope and data version: 24 months of stacked bars (dividends, P2P interest, FD interest), `last_12m`, `monthly_avg` and `top_payers` (≤ 5, linking `/holding/<id>`).
  - The bars are CSS or inline SVG in this component, because the shared bar chart does not stack and W5-F9 owns it.
  - Past income is fact, so it carries no est. tag. The legend shows labels as well as colours.

### Carried forward and integration

**J19. Not in wave 5, recorded so nothing is lost.**
- The §3.1 "Import a statement" tile in the Add sheet (W4-F1 left it) goes to **W7-F7**, which owns Import.
- Lifting the copied class-page hero styles (`.h-kpis`, `.more-stats`, `.kpi.extra`) into `styles.scss` goes to **W7-F1**.
- **Backlog, no owner yet:**
  - P2P's Overdue tab counts loans more than 7 days late, while the verdict and the Money-at-risk vital use 30 (W4-F3);
  - refreshing `market_state` when a new ^NSEI close is stored (W4-B1);
  - passing `ctx['sips']` through on a cold `/brief` (W4-B1, optional);
  - `forecast`'s P2P EMI survival factor and the global `prices:last_refresh` stamp (H20).
- **Still unverified on real data,** because the copy has none of these: the EPF monthly average (W4-B2), `nps:nav-stale` (W3-B7), and the MF_DEBT cone (W4-B1).
- **Known interim link targets after wave 5:** only `/actions?tab=review` (W7-F4). `/settings#cushion` (J15), `/tax?tab=save|whatif` (J11), `/plan?return=` (J6) and `/risk#concentration` (J8) are real from this wave.

**J20. Integrator checks for wave 5.**
1. Full backend pytest (unchanged at 555, since no wave-5 task touches the backend), then `ng build` and `npm run check`.
2. **The J3 moves:** Goals and the Retirement planner into `features/plan/`, the `embedded` input removed, and `features/goals/` and `features/forecast/` gone. Then `ng build` and `npm run check` again. Grep for `features/forecast` and `features/goals` imports: none.
3. **On a mocked API** (development build, fake token, synthetic payloads; never the real server, database or tokens), at 1280 and in a 390 px frame:
   - one h1 per page;
   - no horizontal page overflow;
   - T0 first.
   
   Run this on `/plan` (all tabs, `?preset=retirement`, `?fix=<id>`, `?return=4.5`, `#goal-<id>`), `/risk` (each anchor, including `#concentration` from Performance and from Home), `/recurring` (Record, Skip and Undo), `/tax` (`?tab=whatif&whatif=<id>`, a past FY), `/cash-flows` (`?view=past|future`, none), `/holding/<id>` (Plan a sale, lots, the ⋯ menu), `/settings#cushion`, `/actions` (the Open Risk & mix link) and `/performance#assumptions`.
4. **Cross-page agreement:**
   - Tax T0 "You can still save" equals Actions' "Tax you can still save".
   - Recurring's arriving total equals Actions' Deploy default, and both plans net the same `netted` map.
   - The Risk T0 status equals Home's Risk vital.
   - A target mix saved on Risk shows on Settings' read-only summary and on Home's Mix vital after a reload.
   - A guest sees route and what-if CTAs on cards and "View" for dialog CTAs.
5. **The §9.4 fold re-check on Home**, with the habit, Coming up and chip changes.

### W5-F3 builder decisions (Recurring plans)

- **One `GET /sips` per page.** `RecurringComponent` owns the call. It reloads on `store.version()` and scope changes, and a call that finishes late is dropped if a newer one has started. The moved `features/recurring/sip-plans.component.ts` (`SipPlansComponent`, selector `app-sip-plans`) no longer fetches anything. Its inputs are `plans`, `adherence` and `loading`. Its CRUD still ends in `store.changed()`, which makes the page reload. `features/forecast/sip-plans.component.ts` is deleted.
- **States.**
  - First load: a hero skeleton.
  - First load fails: an error card with "Try again".
  - A later refresh fails: the page keeps the last data and shows a `.notice.warn`.
  - `adherence` is null: the This month tile shows "—", and Instalments shows a muted line. The plans table and Arriving still render.
  - No plans: the hero reads ₹0/month across 0 plans with an `unset` verdict, "No active plan, so nothing to score". With plans but no score, it reads "Adherence not scored yet". The plans table keeps its own empty state.
- **T0** is the hero plus exactly two tiles (This month, Next due). It has no "More" button, because the phone budget is already met. `n` counts active plans, and the meta adds "· N paused" when some are paused. The This month meta is "{invested ÷ planned}% of this month's plan".
- **Badges** use the global `.status[data-status]` pill with their own icon:
  - Recorded: checkCircle (good)
  - Partly recorded: alert (watch)
  - Skipped: chevronRight (info)
  - Missed: alertOctagon (act)
  - Due: bell (watch)
  - Upcoming: calendar (info)
- **The six dots** use the same map. Each dot has `title` and `aria-label` = "{date}: {word} ₹…".
  - The dots are the plan's last six `months[]` entries by `due`. For a weekly plan these include this month's upcoming ones.
  - An `excluded_epf` plan reads "From passbook". A plan with no instalments reads "Paused" or "None yet".
- **Record's `actionId`** looks up `sip:missed:<sid>:<due>` first, then `sip:due:<sid>:<due>`. `kind` comes from `kindFor(plan.asset_class ?? SEGMENT_CLASS[segment], 'BUY')`. `SEGMENT_CLASS` is exported from `recurring.component.ts`. A segment plan opens the dialog with no `instrumentId`.
- **Undo for the session.** Skips this page posts are kept in a module-level signal keyed by `scopeKey|actionId`, so Undo survives moving between pages inside the app, and is gone after a browser reload.
- **Arriving** shows each source's date (or "now"), its label linking to `link`, and its amount. "Arriving in all" carries `<app-est>`, because P2P principal and maturities are expected amounts.
- **Extra to invest.** A sentence above the planner states the split: "Splitting ₹X (₹extra extra + ₹arriving arriving) across your target mix, without selling". The planner's own netted note says what was netted. `riskLink` keeps its default (on), because `/risk` is a page in wave 5.
- **Pure helpers exported for later tests:** `adherenceVerdict`, `monthRows`, `skipId`, `recordPrefill` (in `recurring.component.ts`), and `instalmentBadge`, `adherenceDots`, `INSTALMENT_BADGE` (in `sip-plans.component.ts`).

### W5-F1 builder decisions (Plan hub shell and Overview)

- **Who owns what.**
  - `plan.component.ts` (`PlanComponent`, `app-plan`) owns the head, the T0, the strip, the notes, the tabs and both calls the T0 needs: `/plan` and the default `/forecast`.
  - `plan-overview.component.ts` (`PlanOverviewComponent`, `app-plan-overview`) owns the Overview body and the Adjust state. Its inputs are `plan`, `planError`, `base`, `baseYears`, `baseLoading`, `baseError` and `today`.
  - The moved `features/plan/projection.component.ts` keeps `ProjectionComponent` and `app-projection`, but it is now **presentational**: the fan card only, with inputs `projection`, `goals`, `currentAge`, `today`, `loading` and `error`. The Overview owns the controls and the call. `features/forecast/projection.component.ts` is deleted.
  - Goals and Retirement get no inputs (J3). They are imported by today's names, `GoalsComponent` and `RetirementComponent`, with no alias.
- **The defaults of the Adjust panel, and so of the T0 tile, are the SIP plans (`sip` omitted), no step-up (`step=0`) and the model return.** The wave-4 projection defaulted to a 10% step-up. A headline that assumes raises nobody committed to overstates the typical outcome, and goal `required_sip` assumes none. The tile's est. tooltip says "no step-up".
- **Default horizon.** The years to each goal's `target_date` are rounded **up**, so the furthest goal's date is inside the fan. Then max(10, that), capped at 30 (`defaultHorizon`). Every goal counts, achieved ones included. When the result is not 5/10/15/…/30, it is added to the horizon `.seg`. The tile's label uses the payload's `years`, so it always matches the number shown.
- **Snapshots.** `snapshotKey('plan', scopeKey)` holds the raw `Plan` payload, written only here, so Goals can paint from it. The default projection is cached under `snapshotKey('plan-forecast', scopeKey)` as `{years, data}`. Both repaint on a scope change. Both refetch on every `store.version()` bump, so saving a goal on the Goals tab refreshes the T0.
- **States.**
  - First load: a hero skeleton.
  - `/plan` fails with no snapshot: an error card with "Try again" where the T0 goes. The tabs still work, and Overview still draws the fan from `/forecast` at the 10-year horizon.
  - A later refresh fails: the snapshot stays, under a `.notice.warn`.
  - The tile shows "Simulating 1,000 futures…" while loading, and "—" with "Couldn't project right now" when `/forecast` fails.
- **Hero verdict line:** the status word, then "· N off track, M at risk" from `counts`. The stripe is an inset left edge in `var(--st)`. With `empty`, the line is "Not set · Add a goal → · Plan retirement →".
- **"Investing each month"** is `watch` below `needed_monthly`. It shows an amber "Watch" flag with an icon, so colour is not the only cue, then "needs ₹X/month" with est. At or above that amount it reads "covers the ₹X/month needed".
- **The §10.1 note** shows on every tab once `/plan` is loaded and not `empty`, because "Monthly needed" means nothing without goals. "Got it" stores `'dismissed'` under `plan:sip75-note`. With storage blocked, it stays hidden for that visit only.
- **Tabs.**
  - Leaving Goals drops `preset`, `fix` and the fragment (J3).
  - **Leaving Overview drops `return`.** D13 applies to Overview only, and a `return` left in the URL would re-prefill Adjust on the way back.
  - Arrow keys, Home and End move between tabs (roving `tabindex`).
- **`?return=`** is read from `queryParamMap` and applied when its value changes. It is clamped to −10..30 and rounded to 0.5, so `?return=99` reads 30. It opens Adjust and, once the page has painted, jumps the panel into view two macrotasks later. The jump is instant, because the panel sits about two screens down and headless Chrome never finished a smooth scroll that long. It then shows "Trying N% a year, from the link you followed". The Assumptions card marks the return as "your override". "Back to your plan" resets every control.
- **Goals at a glance.**
  - **Fix** is shown only to writers, and only on `watch`/`act` rows that are not achieved.
  - Every other row, and every row for a guest, shows **View**, which goes to `?tab=goals#goal-<id>` or `?tab=retirement` without `fix`. "Fix" opens an edit modal, which a guest cannot use.
  - The retirement row's progress is `current / corpus_needed`. Its target carries est., because the corpus needed is itself a projection.
  - An achieved goal shows "Achieved" on its badge and "Target reached" in place of the SIP line.
- **The fan's legend** reads "8 in 10 futures" (p10–p90), "The middle half" (p25–p75), "Typical (median)" and "Money put in". Goals after the horizon get the line "N goals fall after Y years, so they have no marker here". The side figures add "Money put in" (no est., because it is the input plan) under the four §5.2 figures.
- **Funding stack colours.** Goals are shades of `--accent`, the cushion is `--text-2` and free money is `--grid`. `--s1..--s8` are kept for segments (§1.10). The legend gives each part's name, ₹ and % (colour is never the only cue). A goal with no allocation reads "no holdings earmarked". A scaled claim reads "scaled to fit". The bank `cash_amount` shows as "plus ₹X in the bank" and is never added to the bar. "Set one →" (`/settings#cushion`) appears when `plan.cushion.set` is false.
- **The Assumptions card** reads the projection being drawn, so a return override shows there. `own` is shown when the record exists. The hash is shown as "Book #" plus its first 8 characters, with the full hash in `title`.
- **Checks run.** `ng build` and `npm run check` pass for these files. The failures `npm run check` reported were in W5-F2's mid-edit `features/risk/*`. On a mocked API (a development build, a fake token, synthetic payloads; no real server, database or token), checked at 1280 and 390 px:
  - `/plan`, `?return=4.5`, `?return=99`, funding null, empty, `/plan` failing, and the tab round trip from `?tab=goals&preset=home&fix=2#goal-2`;
  - one h1 and no horizontal overflow on each;
  - one `/forecast` call (`years=14&step=0`) shared by the tile and the fan.

### W5-F11 builder decisions (Goals and Retirement tabs)

- **`preset` and `fix` leave the URL once applied.** Goals removes both with `replaceUrl` (keeping `tab` and the fragment) after it opens the modal, so a reload or Back does not reopen it. A guest, an unknown preset or a `fix` id that is not in `/plan` just clears the parameter. They wait for the first `/plan` answer, so `fix` never opens a stale goal from the snapshot.
- **Goal writes bump `store.version`.** After a save or delete, Goals patches its own `plan.goals` from the CRUD reply and bumps `store.version`, so it and the Plan shell refetch `/plan` (funding, SIP gap, status). It still never writes `snapshotKey('plan', ...)`.
- **Card order within a status** is `target_date`, then id. Achieved sits after every other good goal. A goal with an unknown status sorts between watch and good.
- **The over-100% confirm** names the goals in card order, the edited goal first: "Mutual Funds would be claimed 130% by Wedding, Child's education and Home down payment." Escape on the confirm, like Cancel, keeps the goal modal open.
- **Per-goal T3 (collapsed "Details")** holds "At the typical return: ₹X/month", Typical and the 1-in-10 bad · good outcomes, the assumed return and the projected-path chart. The chart labels its line "At {expected_return}% a year (est.)", not "Projected". Each card's footer carries the goal's assumption chip.
- **Retirement.** A 400 keeps the last good result on screen, faded, with a warn notice. It shows the message inline under the You group and disables Save. A blank field's placeholder shows the value the model used. The x-axis and tooltip read "Age 45 · 2041". The local class is `.r-body`, not `.stack`: the global `.stack` is the 12 px stacked share bar, and reusing that name clips the content.

### W5-F2 builder decisions (Risk & mix, planner P1 lines)

- **The page owns the data; the moved components take inputs.** `risk-mix.component.ts` loads `/optimizer`, `/forecast/stress` and `/risk` once per scope and data version (T0 needs all three) and passes them to `AllocationLabComponent`, `StressComponent` and `RiskComponent`, which no longer fetch. Each takes an `error` input and emits `retry`. `/optimizer` is called without `profile`: the four `profiles[].weights` already carry every mix, so choosing a profile button refetches nothing.
- **File layout in `features/risk/`.**
  - `allocation-lab.component.ts`: `FrontierChartComponent` (unchanged), `AllocationLabComponent` (renders both `#profile` and `#mix`, because the Suggested % column follows the chosen profile), and the pure helpers `mixSum`, `mixValid`, `roundMix`, `MIX_TOLERANCE`, `driftStatus`.
  - `risk.component.ts`: `RiskComponent` (`#risk`) and `CorrelationHeatComponent` (T3), plus `riskShareHigh` and `dataLabel`.
  - `stress.component.ts`: `StressComponent` and `worstFirst`.
  - The old Allocation lab's "From here to …" trade table and its "Use as target allocation" confirm are gone. "Use suggested" fills the editable table, and Save writes it. The old Stress and Risk navy `.kpis` heroes are gone too, because a page has one T0. Their figures moved into T0 (correction, bad day) or the read-outs.
- **Three profile states, each said in words.** *Chosen* (`aria-pressed`, primary ring) drives Suggested % and the frontier. It starts at the saved `riskProfile`, else `closest_profile`. *Closest* has an accent background and "Closest to your mix today". *Saved* has a tick and "Saved". "Remember this profile" saves the chosen one and is disabled when that is already saved.
- **The T0 hero.**
  - The big number is the est. volatility (`brief.risk_est.vol_pct`, else `optimizer.current.vol_pct`) with est.
  - The meta is the vital's `value`. The verdict line is the vital's status with its `note`, or "Within your {profile} profile" when good.
  - Unset with no saved profile: "Set a risk profile", a verdict of the vital's note ("Looks like Growth") and "Pick one below" → `#profile`.
  - Unset with a saved profile: "Risk estimate unavailable right now", not "Set a risk profile".
- **E20, with one addition.** The page reads Home's brief snapshot first and otherwise calls `api.brief()` without `since`; it never writes the snapshot. After this page saves `targetAllocation` or `riskProfile`, the snapshot predates the write, so from then on the page calls `api.brief()` itself (still never writing). Otherwise Off target and the Risk verdict would stay stale until Home is opened.
- **Off target** uses `brief.allocation`. When the brief has none (an older snapshot), it uses `allocationFromSegments(store.portfolio().segments)`, which mirrors `brief._allocation` (drift thresholds 2.5/5). Its value is Σ `allocation[].value` over the rows with a target (amended by the W5 review fixes; it was every row).
- **Drift bars** draw `pct` (share of the whole portfolio) against the target tick (superseded by the W5 review fixes: targeted rows draw `target + drift`). The pill is the brief's drift (measured within the targeted classes, "+6.5 pts over"), with its status icon and words. A short legend says so.
- **Target mix editor.**
  - The table lists all eight `SEGMENTS`, like the Settings editor it replaces. Inputs step 0.5.
  - Guests get disabled inputs, no Use/Save buttons, and can still preview.
  - "Use current mix" scales `segments[].pct` to 100 before `roundMix`.
  - Only positive rows are saved and sent as `?mix=`.
  - Save is the section's one `.btn.primary` and needs the table to have changed.
- **Preview impact.**
  - It opens with the button and follows the table: debounced 400 ms, and no call while the sum is outside 100 ± 0.5. That state shows "The preview needs targets that add up to 100%".
  - It shows Average return / Typical year / Volatility for `portfolio` against `proposed`, with est. on each proposed figure, and the chip of `proposed`.
- **`/risk#concentration`** opens the block and settles there like the other anchors. The jump chips add Concentration. "How holdings move together" is `id="together"` and renders only while open.
- **Concentration** ports Performance's `group()` as the exported pure `groupBy(rows, key)`. The rest is as there: top 10 of open non-cash, non-P2P holdings by value, stock sectors, company size, top-5 share and USD share.
- **Where the risk comes from.**
  - Volatility reads "measured | used", with `volatility_used_pct` falling back to `volatility_pct`.
  - Data reads `own`, `proxy · {index}`, or `own · short` for `data: 'prior'`. Its title gives days and data quality.
  - Beta is hidden under 760 px.
  - The read-outs carry a bad month (est.), parametric VaR, expected shortfall, measured vs model volatility, Sharpe · Sortino, beta, diversification ratio, the steady-money ballast, and the most and least alike pairs.
- **Stress.** Each card's impact, each segment row and "Portfolio after" carry est., with `honesty.estimate` as the tooltip. The worst card says "Worst here" in words. `market_exposed_pct` is a plain line beside the chip.
- **Planner (J9), additive only.** The four J2 inputs are unchanged, and no input was added.
  - With selling off: `months_to_fix` 0 reads "Nothing to fix without selling: new money simply follows the target mix."; N > 0 adds "At your SIP + maturity pace this closes in ~N months" with est.; null keeps the old sentence.
  - "Tax if sold" shows on a Trim row only when the segment holds an open, priced equity, mutual-fund or commodity holding with `quantity` > 0. EPF and NPS trims get no button, because the what-if API cannot price them. FD and P2P read "Redirect maturities", as before.
  - The result sits in a row under the trim: "≈ ₹X tax est. selling {qty} of {name} · Plan the sale →", or "≈ saves ₹N tax" when it is negative. On phones the row is sticky-left and wraps.
  - A 400 shows its message with "Try again".
  - The cache key is `segment|round(amount)`. It is cleared when `store.version` moves.
  - Fund units are rounded up to 0.001 and shown to 3 decimals.
  - "Set targets →" in the planner's no-target notice now goes to `/risk#mix`, because the editor lives there now (W5-F7 removes it from Settings).
- **On Risk & mix, the planner renders once the brief is known.** It then starts at `deploy.suggested` with `net=deploy` (or ₹0 without a brief) and makes no throwaway ₹0 `/rebalance` call first.
- **Checks run.** `ng build` and `npm run check` pass. On a mocked API (development build, fake token, synthetic payloads; `scratchpad/w5f2_mock.py`, `w5f2_check.py`), at 1280 px and in a 390 px frame:
  - one h1, no horizontal overflow, and T0 → strip → work surface order;
  - every anchor lands at 80 px under the app bar, including `#concentration` (opened) and a same-URL chip click (0 → 80);
  - the strip keeps `concentration:3` and `risk:above-profile` and drops `loser:1` (`/holding/1`);
  - preview impact sends the rounded current mix (Σ = 100) and blocks at Σ = 170.5;
  - Tax if sold priced 8 Apple (⌈7.03⌉), 312.516 fund units and a commodity 400 inline, "saves ₹1,500" on a negative tax, and "Plan the sale →" opens `{instrumentId: 3, qty: 8}`;
  - `months_to_fix` reads 4 and 0;
  - saves PUT `targetAllocation` (Σ 100) and `riskProfile`, and the Saved tick moves;
  - the snapshot-only brief makes no `/brief` call and starts the planner at the snapshot's ₹99,000;
  - the guest, unset, empty and outage states.
- **Left for others.** `/performance#concentration` → `/risk#concentration` is W5-F10's redirect (J18). Settings' editor removal and its read-only summary are W5-F7.

### W5-F5 builder decisions (Home P1)

- **The all-clear card keeps its big text "Nothing needs you".** Its sentence is "Next: SIP ₹{amount} on {date} · review due {date}.", so the card reads J13's sentence without saying "Nothing needs you" twice. The SIP part comes from `habit.next_due` and always says "SIP". A review date already past reads "review overdue since {date}". With neither part, the sentence stays "Nothing is due this week or this month."
- **The habit card.** The sentence is "6-month SIP adherence {n}% · {pace}% of this month's plan", with both numbers rounded to whole percents. The next SIP and the next milestone sit under it as two icon lines rather than inside the sentence:
  - "Next: {name or 'SIP'} ₹{amount} on {d MMM}";
  - "Next milestone {label} in {in}" ("this month" as is). When `in` is null it reads "by {Mon YYYY}" from `when`, and otherwise just the label. The line carries `<app-est>`, because it is a projection at the plans' monthly total.

  Both lines show only while SIP plans exist (`planned_month` > 0). "Not scored yet" shows only while plans exist and `adherence_6m_pct` is null.
- **"suggest: {class}" is a second, muted line under the FD row's title** in Coming up. The class is `underTargetSegment(brief.allocation)` (D4), labelled with `SEGMENT_META`. The row is already a link to the FD, so the suggestion is text, not a nested link.
- **The chip** is `<app-assumption-chip [block]="bb.assumptions">` with no wrapper. It renders nothing without a block. Home's styles only keep it from stretching (`align-self: flex-start` through `::ng-deep`).
- **Fold, re-measured** on a mocked API (development build, fake token, synthetic payloads; `scratchpad/w5f5_mock.py` and `w5f5_check.py`). The worst case has a correction context line, three action cards with an impact, a confidence and a due row, and a two-line Cushion vital.
  - **1280 px:** the head ends at 131, the hero is 248 px tall and ends at 401, and the vitals are 74 px. The three action cards end at **757 px**, inside the 800 px fold. The all-clear card ends at 717.
  - W2-F2's 690 px had a short review context line, which shares the verdict's row. The long market line takes its own row (+30 px), and the two-line Cushion note adds 10 px.
  - **390 px:** the hero is 277 px with a three-line correction context line. That is about 210 px without the context line, which the §9.4 hero list does not include. The top action ends at 1,033 px, within 1.5 screens (1,266). Stat meta, including "N new", stays hidden on phones, as W2-F2 decided.

### W5-F7 builder decisions (Settings)

- **The desktop rail is a vertical side rail**, sticky at `top: 80px` in a 200 px left column. A horizontal bar under the app bar would cover every anchor that the shell's 80 px offset lands on. On phones (≤ 760 px) it becomes a `.seg` strip at the top of the content. That strip is not sticky, for the same reason. A tap scrolls to the section and writes the fragment with `Location.replaceState`, with no router navigation, so a second tap on the same item still scrolls. The active item follows the scroll. Sections and `#cushion` have `scroll-margin-top: 80px`. As on Risk & mix, the page re-aligns a known fragment while the page height settles (1.5 s, or until the user scrolls, taps or types).
- **`#profile` layout.** The left column holds the Emergency cushion card (`id="cushion"`), because it is the section's T1. The right column holds Tax, "Your plans" (the two read-only summaries) and Capital flows (`autoCapitalFlows`). Below 1100 px they stack in that order.
- **Cushion editor.**
  - **Checklist order:** suggested candidates (in `emergencyFundSuggest` order), then saved ids, then holdings the user adds.
  - **Row values:** a row's value is its open position's live `value` from `store.positions()`, or else the candidate's value. A closed holding counts 0, and an id that is not in the portfolio counts 0 and is struck through. This matches `brief.cushion_state`, which counts only open positions.
  - **"Add another holding…"** (writers only) lists open holdings with value that are not on the checklist yet. Without it, the cushion could never hold an FD maturing after 12 months or an equity fund.
  - **Expenses:** the saved `monthly_expenses` when it is > 0, else `monthly_expenses_hint`. The hint says "From your retirement plan".
  - **Months** is a 3–24 select, so it can never be invalid. Expenses (0–1e7) and cash (0–1e8) are checked before Save, and Save is disabled while either is out of range. A server 400 shows inline as "Couldn't save the cushion: {error}", and the draft is kept.
  - **Coverage** uses the Cushion vital's bands: good at or above the target, watch at 3 months or more, else act. The words are "Covered", "Below target" and "Too thin", with "Not set" when there are no expenses. Coverage is a fact at today's values, not a forecast, so it carries no est. tag.
  - **When the draft reseeds:** the draft follows the store until the user edits it. It reseeds after a save, and on a portfolio switch even when there are unsaved edits. Edits show "Unsaved changes · Discard".
  - **The empty-expenses case:** saving with empty expenses sends `monthly_expenses: null`, which the backend accepts. The vital then stays unset.
- **Summaries.** "Target mix: set · {Profile}" (the profile is left out when no `riskProfile` is saved) or "not set" → `/risk#mix`. "Retirement plan: retire at {age}", "set" (a plan with no `retire_age`) or "not set" → `/plan?tab=retirement`. The right-hand link word is "Risk & mix →" / "Plan →", or "Set it →" for a writer when the item is not set.
- **Family banner for guests.** Writers see "Editing the family plan". A guest, who cannot edit, sees "The family plan · … Guests can look but not change them." For a guest with no saved cushion, the page says that the ticks are only a suggestion.
- **Prices default.** The filter is computed: Missing when an open equity, mutual fund or commodity holding has `has_price` false, else All. The user's own choice wins from then on. The Missing button shows the count. The empty text depends on the filter.
- **Verified** on a mocked API (development build, fake token, synthetic payloads; `scratchpad/w5f7_mock.py` and `w5f7_check.py`) at 1280 px and in a 390 px frame. The checks cover set, unset, null suggest, the family view, guest and a 400 on save. `/settings#cushion` lands with the card's top at 80 px in every case. The PUT bodies were checked. There is one h1 and no horizontal overflow.

### W5-F6 builder decisions (Holding detail)

- **Rules live in `features/holdings/holding-rules.ts`** (new, pure functions): `holdingVerdict`, `concentrationLimit`, `daysSince`, `returnOnMoneyIn`, `attentionPrefixes`, `longTermDays` and `joinLots`, plus `CONE_LABEL_FALLBACK` (the `HONESTY.cone` text). The page and the Outlook card only render them.
- **T0 verdict** follows J14's order: act before watch, so an unpriced 30% fund reads "Valued at cost — set a ticker". The watch mirrors `insights.py`: open holdings only, and no rule for cash, P2P or FDs (they never get a `concentration:` action). The frontend has no hysteresis, so a holding between 12% and 15% whose action is still open reads good while the strip may still show the action. The watch links "See concentration →" to `/risk#concentration`. The good sentence names the weight and the 15% (MF 25%) guide. Closed and defaulted holdings get their own good sentence.
- **Tiles (tradable and cash):** Total return, then XIRR (≥ 365 days since `first_date`) or "Return on money in", then "Units · avg cost" (the third tile is behind "More" on phones, §1.5). Before a year, the Total return tile's meta shows the unrealised and income split instead of the %, so the % is not repeated. The old Price and Unrealised tiles move into the hero meta and the Returns card. The Returns `.kv` keeps XIRR for P2P and FDs at any age, because an interest-bearing loan's annualised rate is the meaningful figure; the class tiles are unchanged (J14).
- **"Plan a sale"** is a one-line T1 card under the strip, not a head button. The head is writer-only, and guests may plan a sale. It uses a plain `.btn`, because Buy is the head's primary.
- **⋯ menu:** writer-only. It holds only "Delete holding". Opening it moves focus to the first item (after the next render, because of event coalescing). Escape closes it and returns focus to the button, and an outside click closes it.
- **Open lots** are a collapsed `details.more` (T3), so `/tax` (current FY) is fetched the first time it opens, and again after a data change while it is open. Position lots are joined to the tax view's lots by date and units, not by index alone. Until `/tax` answers, when it fails ("Couldn't load the tax view…", with Try again), or for an unpriced holding (`open_lot_view` skips it), the term and date follow `tax.rule_for`'s holding periods: 365 days for equity and listed_other, 730 for foreign_equity, and slab classes never turn long-term. Slab lots get a "Slab rate" badge. ELSS lots show "ELSS locked until {date}". On phones the Cost, Value and Gain columns are hidden, and "turns long-term on" moves under the badge.
- **Signals card states:** a skeleton while loading, "Couldn't load the price signals" with Try again, and the payload's `reason` when `available` is false (earlier the card disappeared). It refreshes in place after a data change. Markets chips render only when the snapshot row has `metrics` or `signals`. A covered holding with no signal shows "No signal", and the chip tooltips carry `SIGNAL_HONESTY`. The card hint reads "price pattern, not a forecast". The cone head drops the old trailing "at its asset class's long-run return, not its recent trend", because `cone_label` now says it.
- **Not-found and error states** render an h1 ("Holding not found", "Couldn't load this holding"), and the loading state renders a visually hidden h1 "Holding", so every state keeps one h1 (A22).
- **For W5-F8 (J17):** on a guest, the `tax:wait-lt` card in this strip still shows "View" in place of its `whatif` CTA, because `action-card.component.ts` has not applied J17 yet.
- **Verified** on a mocked API (development build in a scratchpad copy, fake token, synthetic payloads; `scratchpad/w5f6_mock.py`, `w5f6_check.py`, `w5f6_rules_test.js`) at 1280 px and in a 390 px frame. The checks cover a priced stock (good, chips, strip with the what-if action and none of `/holding/210`'s), an unpriced fund (act → `/settings#prices`), a 20.4% stock (watch; its own `route` CTA hidden on its own page), a 20% fund (good under 25%), a 120-day holding ("Return on money in", the unavailable-signals reason), the ⋯ menu (focus in, Escape, focus back), Plan a sale (what-if qty 100), "Sell up to here" on lot 2 (qty 75 = 40 + 35), a failing `/tax`, a guest (no tools or menu, Plan a sale works), and an unknown id. `/markets` was never requested, and `/tax` only when the lots opened. There was no horizontal overflow at either width.

### W5-F4 builder decisions (Tax)

- **Layout keeps every tier on screen at once, instead of four exclusive tabs.** `?tab` picks a view inside its tier: `save`/`whatif` switch the T1 work surface (a `.seg` in its card head, h2 "Ways to save" or "What if I sell?"), and `gains`/`estimate` switch the T3 detail (`.tabs` inside a collapsed `details.more`, `id="tax-details"`). T2 (the allowance meter and "Where your tax comes from") always sits between them, so the order is T0 → strip → T1 → T2 → T3 on every tab. The T3 block opens, and is scrolled to once painted, when `?tab=gains|estimate` arrives, and it is open for a past FY (where it is the page's content).
- **URL rules beyond J11.**
  - The current FY is written as no `?fy` (the select writes `fy: null` for it). Changing the FY drops `?whatif`, keeps `gains`/`estimate` and drops `save`/`whatif`.
  - A tab click writes `fy` as shown, so a `?fy` that `?whatif` overrode does not take over once a tab click removes `?whatif`. Any tab other than `whatif` drops `?whatif`; coming back to `whatif` restores the last holding chosen in this visit.
  - The holding select writes `?tab=whatif&whatif=<iid>`; the form resets from `?whatif` (held quantity, `position.price` when `has_price`, today) and works the tax out at once. A store reload after a save does not reset it.
  - `?whatif` naming a holding outside the scope, or one that is not an open equity/MF/commodity with units (an FD), shows an inline notice and disables the form. A malformed `?fy` is ignored (current FY).
- **"Current FY"** is the `fy` of the last `GET /tax` made without `?fy`, falling back to `fy_of(today)` worked out in the browser. The current FY's report paints from `snapshotKey('tax', scopeKey)` and is rewritten after each load; past FYs are not cached.
- **T0 verdict states.** Watch "You can still save ₹X (est.)" with a "See how" link when the work surface shows the what-if; good "Nothing left to save on tax this year" at 0; info "{fy} is closed: …" for a past FY. Before ActionService has answered once (and has nothing painted from its snapshot) the verdict is `unset` "Working out what you can still save…", or "Couldn't work out …" when `/actions` failed, so a 0 is never shown before the figure is known.
- **Days left** counts today: 31 March reads "1 day left". Next deadline uses the first `brief.upcoming.events[]` with kind `tax` and 0 ≤ days ≤ 90; the brief is read only per scope, and a snapshot whose `upcoming` key is missing (not null) counts as no snapshot.
- **Capital gains tile** sums `summary` keys by suffix (`_stcg` short, `_ltcg` long, `_intraday` shown separately when non-zero), falling back to the realised lots by `term`.
- **"Wait before selling" rows plan a sale "up to this lot".** A sale is matched FIFO, so the lot's own units would sell older lots instead. The row's "Plan the sale" prefills the cumulative open-lot quantity of that holding up to and including the lot (`opportunities.open_lots`, oldest first; the lot's own units when it is not listed), as J14's "Sell up to here". Harvest rows prefill the row's `qty` (already FIFO from the oldest lot); loss rows prefill the units up to their newest loss lot (W5 review fixes). No row passes an `actionId` (J11, W4 review fix).
- **Est. tags.** Hero (basis: gains and income so far at the slab incl. cess, surcharge and carry-forward not included, plus D12), verdict ₹X, the harvest total line, the Proceeds/Gain booked/Loss/Saves-by-waiting column heads (on phones the stacked row labels read "(est.)"), the offset saving, the what-if tax, net cash and wait figure, and the estimate totals in T2/T3. Realised gains are facts and carry none.
- **D12** follows `harvest_plan.note` and the what-if note only when the payload lacks it, and is added to the T3 rules text.
- **Phones (≤ 560 px):** the three Ways-to-save tables become labelled stacked rows, so "Plan the sale" never scrolls out of reach. The strip's compact action cards wrap their title onto its own line on this page (a page-scoped `::ng-deep`), because the shared one-row card with "See the harvest plan" and a ₹ pill overflowed a 390 px screen by 39 px.
- **For W5-F8 / W7-F1 (not fixed here):** `.action-card.compact` keeps title, impact pill, CTA and ⋯ on one unwrapping row (`.ac-cta { flex: none }`), so any compact card with a long CTA label overflows a phone. The shared what-if modal prints "FY FY2026-27" (its `fy` already starts with "FY"). The global `.stack` meter class collides with any table or list named `stack`.
- **Verified** on a mocked API (development build in a scratchpad copy, fake token, synthetic payloads; `scratchpad/w5f4_mock.py`, `w5f4_check.py`, `w5f4_tall.py`) at 1280 px and in a 390 px frame: current FY (verdict ₹17,475 = Σ lump impact of the open and planned `tax:*` moves; harvest, offset and wait rows; Plan the sale opens the modal with the row's units and no action id, the wait row with 25 = 12 + 8 + 5), a past FY (info verdict, no work surface, T3 open, `?tab=save` reads gains), `?tab=whatif&whatif=12` (wait hint), a USD holding (`$` price, ₹ proceeds with the `amount_fc` line, `?fy` overridden), an ELSS 400 and a "You hold only 25 units" 400 inline, a no-price holding's 400, an FD id (notice), Record this sale (a plain SELL, no action id), the holding select writing `?whatif`, `?tab=gains|estimate` (T3 open and scrolled to), a tab click dropping `?whatif`, the FY select, a guest (no "change", no Record, the strip shows View), and a failing `/tax` (error card with Try again). One h1 and no horizontal overflow in every case.

### W5-F10 builder decisions (Performance P1)

- **Concentration forwards before anything loads.** When the page opens on `#concentration` it calls `router.navigate(['/risk'], {fragment: 'concentration', replaceUrl: true})` and skips its own `/performance`, `/brief` and verdict fetches; a fragment-only navigation to `#concentration` later forwards the same way. `group()`, the top-holdings, sectors, caps and USD-share code and `concOpen` are gone.
- **A null `assumptions_check` is re-asked once, never computed here.** H11 builds the check only from a peeked ALL performance, so a brief built before this page warmed `/performance?range=ALL` has `assumptions_check: null`. Once the page has fetched the whole-portfolio ALL payload over the network (as its own view, or as the verdict fallback) and the brief it holds is not `empty` and has no check, it calls `api.brief()` once more per `scope#version` (the memo key carries `perf_ready`, A16) and never writes the snapshot (E20). It does not rebuild the band from `/assumptions` `typical_bands`, so the verdict rule stays in `brief.py`. Still null after that: "Not worked out yet", with a "Show the whole portfolio since you started" button when another range or a segment is picked. An empty brief says the check starts after a year of history.
- **The check's copy.** The sentence is J18's, with every figure to one decimal and a real minus (`range −2.6–23.4%`); `years` prints as "3.2 yrs". Badge words: Within range (good), Above range (info), Below range (watch), Too early to judge (unset). A one-line note under the sentence says what the verdict means for the plan. The CTA's figure is the link's own `return` value (realised rounded to 0.5, H11), so "Use 4.5% in the Plan →" always matches what `/plan` receives; the link is split into `routerLink` + `queryParams`. The hint reads "whole portfolio, since you started, not {segment} alone" when a segment is picked. "Explains: Plan status".
- **Income.** `GET /income` has no segment or range, so it is fetched once per `scope#version` after the period payload has painted, and a scope change blanks it. With a segment picked the hint adds "whole portfolio". The stacked columns are CSS (fixed order `--s1` dividends, `--s2` P2P interest, `--s3` FD interest, never cycled; 2 px gaps between segments; zero segments not drawn), with two dashed gridlines (the tallest month and half of it), a tick every sixth month, a readout line (the hovered or tapped month, else the latest), a legend with labels and 24-month totals, and a "Month by month" table as the text alternative (`--s3` is under 3:1 on white, so the table and labels carry identity). `top_payers` is sliced to 5 (the API sends up to 6) and labelled "dividends, last 12 months", because the backend counts dividends only. States: skeleton, error with Try again, stale-with-notice on a failed refresh, "No income in the last 24 months", "No dividends in the last 12 months". No est. tag.
- **Linked sections settle instead of smooth-scrolling.** `#attribution` and `#assumptions` use the Settings/Risk pattern: an instant `scrollIntoView` two macrotasks after the section can render, then a re-align on every resize of the `.page` block until the user scrolls, taps or types, or 4 s pass. A smooth scroll was cut short by the charts and the income card painting later. `#attribution, #assumptions, #income` get `scroll-margin-top: 80px`.
- **Observed, not changed:** a cold visit calls `/brief` and `/performance` twice, once per store version (the W2-F4 effects key on `store.version()`, which bumps after the first portfolio load). The re-ask above adds at most one `/brief` per version.
- **Verified** on a mocked API (development build in the scratchpad, fake token, synthetic payloads; `scratchpad/w5f10_mock.py`, `w5f10_check.py`) at 1280 px and in a 390 px frame: each verdict (within, above, below with and without `link`, too_short), a null check (re-asked once, then "Not worked out yet"), a null check that the re-ask fills, a failing brief, a segment, `#assumptions` landing 40–120 px from the top, the income card loaded, empty, without payers, failing and still loading, one `/income` call per visit, and `/performance#concentration` ending on `/risk#concentration` with no history entry and no Performance fetches. One h1 and no horizontal overflow in every case.

### W5-F9 builder decisions (Cash flows)

- **Future bars use the same sign as the past bars (amends J12's "future bars are `net`").** Past bars are net contributions: money put into investments is +. The forecast's `net` is `inflow − outflow`, money coming back to you minus SIPs going in, so it has the opposite sign. Plotted raw, an FD maturity would look like a deposit. The future bar is therefore `outflow − inflow` (`expectedAdded`), "Net added", which is −`net`. The tooltip splits it into "Going in (SIPs, EPF)" = `outflow` and "Coming back (income, principal)" = `inflow`, and the month-by-month table uses the same convention.
- **T0 keeps ≤ 4 tiles (§1.5).**
  - `view=past`: hero plus the Deposited and Withdrawn tiles.
  - `both` and `future`: the three forecast tiles (Income due = dividends + interest + EPF interest, Principal back, SIPs out, each with `app-est` and "next 12 months") take the tile slots. Deposited and Withdrawn move to the hero's meta line, so their numbers stay on screen.
  - At ≤ 760 px SIPs out goes behind "More".
  - The hero verdict is factual, with status `info`: "₹X added in the last 12 months", or on the escrow seg "₹X waiting in escrow, not lent out yet".
- **The chart always shows the contributions account.** The forecast is about money going into and out of investments, so mixing it with escrow history would mislead. The escrow `.seg` changes the hero ("Escrow balance", from `/cash` rows by the same rule as `contributions.p2p_escrow_balance`), the past tiles and the ledger.
- **Every view shows the whole chart** (J12: the chart always has both halves). `past` hides only the forecast tiles and "Dates to know". "What this means" stays because it explains the estimate half of the chart. `#future` is the work-surface card, and `view=future` (or `#future`) scrolls it into view once `/cash` has painted.
- **A view `.seg`** (Past · Past + next 12 · Next 12 months) writes `?view=` with `replaceUrl` and merge. `both` clears the parameter, since no value now means `both`. Unknown values read as `both`.
- **The current month appears on both sides of the divider:** the past bar is that month "so far", and the first forecast bar is "Rest of {month}", because the forecast window starts tomorrow (§6.6 rule 1). Bars carry a unique `key`, so a repeated label does not break tracking.
- **Dates to know** = the forecast's `events[]` plus every open FD that matured with no maturity recorded (`maturedUnrecorded`, A28). The forecast drops past dates, so the FD case would otherwise never show a row for `fd:matured-unrecorded`.
  - FD rows show "+₹X" (`fdPayout` for the matured case) and a "Within 30 days" badge from `maturingSoon`. They run the visible `fd:matured-unrecorded:<iid>` or `fd:maturing:<iid>` action through `ActionRunner`, with the CTA's own label.
  - P2P close rows show no amount and say the repayments are counted month by month (W3 review rule). Titles use `count` as `calendar.upcoming` does.
  - `p2p_overdue` rows show "₹X outstanding" (not signed money in) with an Overdue badge, linking `/p2p?tab=overdue`.
- **Bar chart additions (all optional; with none set it renders as before):** `Bar.muted` (45% fill, dashed outline), `Bar.key`, `Bar.tip` (extra tooltip rows), `divider: {index, label, before?, after?}` (a dashed rule with "today" and side captions shown only when they fit), and `labelGap` (px per x label, default 48; Cash flows passes 60 so "Nov 26" labels do not collide at 390 px). The top padding grows from 10 to 26 px only when a divider is set.
- **States:**
  - First load: hero and card skeletons.
  - `/cash` failing with nothing loaded: "Couldn't load your cash flows" with Try again.
  - A failed refresh: the stale-numbers notice.
  - The forecast failing: the past bars and T0 still paint, the forecast tiles read "—" / "Couldn't estimate", and the card shows a Try again notice.
  - No entries: "No contributions recorded yet", with the chart showing only the estimate.
  - A scope change clears both payloads before reloading.
- **Verified** on a mocked API (development build, fake token, synthetic payloads; `scratchpad/w5f9_mock.py`, `w5f9_check.py`) at 1280 px and in a 390 px frame, with modes full, matured, guest, empty, fail and cffail. Every case had one h1 and no horizontal overflow.
  - No view, `both` and `bogus` show the forecast tiles and dates; `past` shows Deposited/Withdrawn and no dates; `future` scrolls `#future` to 80 px from the top (at 390 px with reduced motion, because headless virtual time stalls a smooth scroll inside a frame).
  - The escrow seg reads "Escrow balance = ₹30,000".
  - The strip shows `fd:maturing:5` and `cash:p2p-principal:2026-10`, and never `p2p:yield` or `sip:due`.
  - The chart has 36 bars, 12 of them muted, and a divider labelled today / past 24 months / estimate. The future tooltip reads "+₹22,900 · August 2027 · estimate · Going in ₹25,000 · Coming back ₹2,100".
  - "Mark matured" on a Dates row opens the shell's FD dialog with `{instrumentId: 6, actionId: 'fd:matured-unrecorded:6'}`.

### W5-F8 builder decisions (Actions P1, ActionCard for guests)

- **Guest CTAs (J17).** `action-card.component.ts` exports `readCta(cta)`: true only for `route` and `whatif`. Every other CTA stays writer-only for guests, including `api: prices_refresh` (it posts a refresh), which J17 did not name. A guest's "View" goes to `link` (hidden when it is the page shown); with no link, and a CTA hidden because it writes, to `/actions?id=<id>` (URL-encoded), except on `/actions`. A writer with no CTA and no link still gets nothing.
  - **A page's `localRun` is used for writers only.** In-place handlers open editors (the NPS NAV editor), so for a guest a same-page `route` CTA stays hidden under `ctaHere`, as before.
  - The Actions Planned table follows the same rule: a writer sees "Do it now"; a guest sees the CTA's own label for a read, "View" for a write with a link, and nothing otherwise.
- **Compact cards on phones (W5-F4's note).** At 560 px or less, `.action-card.compact` wraps: the title takes the first line, and the impact, CTA and ⋯ sit right-aligned on a second line. A CTA label longer than the card ellipsises (its full text is the button's title). The rule sits in the card's own styles, so every compact card gets it. The Tax strip's own wrap rule is compatible with it.
- **Follow-through tile.** It reads "Follow-through / Acted on **7 of 9** / in 90 days · 86% on time · SIPs 92% kept (12 mo) / ₹41K realised this FY est.". "Acted on" is set smaller in front of the number so the tile fits a fifth of the row at 1280 px. The whole J16 sentence, with the on-time and SIP measures written out, is the tile's `title`. When `acted_90d.total` is 0 the value is "—" with "Nothing was due in the last 90 days". The realised line shows whenever `impact_realised_fy` is a number (₹0 included). Its est. basis names tax saved by tax moves plus money reinvested from maturing FDs, P2P principal and cash, within this FY.
- **Done "How".** `howDone` and `evidenceType` are exported from `actions.component.ts`.
  - With ids: "Auto: {TYPE} #{first} (+N more) on {date}". The date is `done_at`, then `evidence.date`.
  - Without ids: "Auto: {condition}" with no date (the Done on column has it), or "Auto: condition cleared" when there is no condition.
  - Auto rows carry a `zap` icon and manual rows a `check` icon. The words still say which is which.
  - On phones, the How cell wraps (min 150 px).
- **Book gains tax-free.** It uses `harvest_plan` when the payload has one. The amount is `future_tax_saved` (est.; the basis appends the plan's `note`). The sentence is "Books ₹X across N holdings · see the harvest plan →" (`/tax?tab=save`), and the card's own "Open Tax →" is dropped because it would be the same link twice. An empty plan reads "This year's long-term exemption is used up." when `remaining_exemption` < `HARVEST_FLOOR` (₹2,000; W5 review fixes, it was ≤ ₹1,000), otherwise "No long-term equity gains to book yet." A payload with no `harvest_plan` keeps the W2-F3 `ltcg_harvest` card.
- **Money arriving.** Every `deploy.sources` row is listed above the planner, whatever amount the planner is using. Each row shows its label, its date (or "now"), its amount and "Open →" by kind (`DEPLOY_SOURCE_LINK`, H9); an unknown kind has no link. When a CTA's own `?new_money=` is planned, the line above says the money arriving is not included.
- **Layout fixes in this page's styles.** `.table-wrap` is `position: relative`, so the header cells' absolutely placed `.sr-only` labels stay inside the scroller. `.card.ai` uses `overflow-x: clip`: at 390 px, headless Chrome sometimes laid the closed analyst card out about 45 px wider than its box.
- **Verified** on a mocked API (development build, fake token, synthetic payloads; `scratchpad/w5f8_mock.py`, `w5f8_check.py`, which takes Home's brief from `w5f5_mock.py`). The checks ran at 1280 px, in a 390 px frame and in a tall 390 px frame, as a writer and as a guest. There was no horizontal overflow in any case.
  - The planner footer shows "Open Risk & mix →" to `/risk#rebalance`.
  - The Done rows read "Marked done", "Auto: BUY #812 on 20 Oct", "Auto: BUY #901 (+2 more) on 4 Nov", "Auto: MATURITY #455 on 8 Nov", "Auto: trade #1001 (+1 more) on 10 Nov", "Auto: exemption used", "Auto: every holding is priced" and "Auto: condition cleared".
  - The Book card's "Plan the sale" sets the shell's `whatIf` to `{instrumentId: 11, qty: 512.345}` (`rows[0]`).
  - Guest cards on `/actions`:
    - `tax:wait-lt` shows "Plan the sale", which opens the what-if with no `actionId`;
    - `drift:` shows "Rebalance", which navigates to `/risk#rebalance`;
    - `cash:usd` shows "Invest ₹88,400";
    - the `sip:due` dialog card shows "View" to `/recurring`;
    - `fd:matured-unrecorded` (`fd_mature`, no link) and `review:due` (`review_complete`) show nothing, and no card has a ⋯ menu.
  - On Home, the guest's `fd:matured-unrecorded` card shows "View" to `/actions?id=fd%3Amatured-unrecorded%3A15`.

### W5 integrator decisions

- **J3 moves done.** `features/goals/goals.component.{ts,html}` → `features/plan/goals.component.{ts,html}` (class `GoalsComponent`, selector `app-goals`); `features/forecast/retirement.component.ts` → `features/plan/retirement-planner.component.ts` as `RetirementPlannerComponent`, selector `app-retirement-planner`. `plan.component.ts` imports both from `./` and renders `<app-retirement-planner />`. The deprecated `GoalsComponent.embedded` input is deleted. `features/goals/` and `features/forecast/` no longer exist; no source imports either path. The EPF/NPS class page keeps `RetirementComponent` / `app-retirement` in `features/retirement/`, so the two no longer share a name.
- **One formula for "Tax you can still save" (J11, J20.4).** `taxStillToSave(actions, planned)` is exported from `features/actions/actions.component.ts` beside `isTaxMove` and `lossHarvestSaving`. Actions' tile and the Tax T0 verdict both call it, so the two figures cannot drift. Tax imports it from Actions; Actions never imports from Tax (no import cycle). Tax no longer exports its own copy.
- **Compact action cards on phones** wrap through ActionCard's own ≤560px rule (W5-F8). The Tax page's page-scoped `::ng-deep` copy (W5-F4) is removed.
- **What-if modal FY label.** `shared/what-if-sale.component.ts` prints `{{ r.fy }}` with no "FY " prefix, because `tax.what_if_sale` already sends `FY2026-27`. The EPF import preview keeps its prefix: its `fy` is a bare `2024-25`.
- **Recurring's planner nets with Extra > 0.** `[useNet]="arriving_total > 0"` while the amount is `extra + arriving_total` (J10) is correct. `net=deploy` removes the arriving money from the segments that already hold it, and the extra is new money on top. A15's "a typed amount sends no net" applies to a planner whose whole amount is typed, as on Actions and Risk & mix.
- **Contracts checked on a DB copy** (synthetic goals, SIP plans, cushion, retirement plan and target mix; Python modules only, no server or tokens). Dumped: `/plan`, `/brief`, `/actions`, `/sips`, `/tax`, `/forecast`, `/forecast/retirement`, `/forecast/cashflow`, `/forecast/stress`, `/risk`, `/optimizer`, `/assumptions?mix=`, `/income`, `/rebalance?net=deploy`. Every field the wave-5 pages read is present where they read it: `goals[].projection.progress_pct|required_sip|required_sip_typical`, `rows[].kind` with a null retirement `id`, `sips.adherence.plans[].months[]`, `adherence.next_due[]`, `adherence_6m_pct`, `brief.on_track.habit.next_due|milestone`, `brief.upcoming.events[].kind == 'tax'`, `brief.assumptions_check`, `brief.deploy.sources[]`, `actions.follow_through.*`, `tax.opportunities.harvest_plan.*` and `rebalance.months_to_fix`. `sips.arriving_total` equals `brief.deploy.suggested` on the copy (J20.4).
- **Route audit.** Every `api.service.ts` path and the planner's direct `/rebalance` call is served by a Flask rule. Every frontend and backend in-app link starts with a routed segment, and every fragment they name exists on its page: `/risk#profile|mix|rebalance|stress|risk|concentration`, `/settings#profile|cushion|alerts|prices|people`, `/performance#assumptions|attribution` (`#concentration` forwards to Risk & mix), `/actions#deploy` and `/plan?tab=goals#goal-<id>`. The only interim target left is `/actions?tab=review` (W7-F4).
- **Carried to W7-F1 (`styles.scss`):** the global `.stack` meter class (12px, `overflow: hidden`) clips any element named `stack` (W5-F4 and W5-F11 renamed their own); consider `.stack-bar`. Also: let `.assumption-chip` wrap on narrow cards (W5-F5, W5-F9), and the bar chart's last x-label can clip at the right edge (W5-F9).

### W5 review fixes

- **Risk & mix re-reads `/brief` after its own save (amends the W5-F2 E20 note).** `AllocationLab` emits `wrote` only after `store.saveSetting` resolves, and `saveSetting` → `changed()` bumps `version` before it awaits the reload. The page's load effect therefore re-ran while the snapshot was still trusted and painted Home's pre-save brief again. `onWrote()` now sets `snapshotStale` and calls `loadBrief(scopeKey)` itself, so Off target, the drift bars and the Risk verdict follow the new targets or profile at once. Still never written.
- **Off target is priced on the targeted value (amends J8 and the W5-F2 note).** `offTarget` sums `value` only over the rows with a target: ₹ = Σ|drift| × targeted value / 200 (SPEC §5.6 row "allocation"). Drift is measured within those classes (`portfolio.py` `mix_value`), so an untargeted EPF or NPS balance no longer inflates the figure, and it equals the over-weight side's `drift:` amounts (|drift| / 100 × targeted value). Pinned in `test_insights.py` (EPF ₹11.5L outside a ₹10L 50/50 mix: ₹2,00,000, not ₹4,30,423).
- **Drift bars measure one mix (amends the W5-F2 "Drift bars" note).** `driftShare(r)` (exported from `allocation-lab.component.ts`) is `target + drift` for a targeted row (its `mix_pct`) and `pct` otherwise, as Home's allocation card draws it. Bar width, number ("70.0% / 50%"), tick and scale all use it, so an over-weight class's bar always ends right of its tick. The legend reads "Bar: share of the classes you target (a class without a target: share of the whole portfolio) · line: your target", or "Bar: share of the portfolio now" with no targets.
- **Prefilled sale units reach the lots they name (amends W5-F4's row prefill and W5-F8's cards).** `what_if_sale` sells FIFO, so the pure helpers live in `core/tax-lots.ts` (Tax and Actions both import it; the Tax → Actions import direction is unchanged):
  - `unitsUpTo(lot, open_lots)` (moved from Tax): the cumulative units up to and including the lot. Tax's wait rows used it already; Actions' "Wait before selling" card now does too (it sent the lot's own units, which sold the older long-term lot and showed ₹0 with no wait hint).
  - `lossSaleQty(row, open_lots, today)`: an "Offset gains with losses" row's `qty` sums only the lots below cost (`tax.harvesting`) wherever they sit, so it sent the oldest lots, often in gain. The prefill is now the cumulative units up to the newest unlocked loss lot (the row's `qty` when its lots are not listed). The Tax row says "a sale takes N, oldest first" under its units when that is more, with a title that older lots in gain go too; Actions' Offset card uses the same helper for its largest loser.
  - Pinned in `test_tax_whatif.py`, which mirrors both helpers (no frontend runner, A4): the loss lot's own 10 units book a ₹5,000 long-term gain and no loss, the 20 up to it book the ₹3,000 loss; a wait lot's own 10 units give no hint, the 20 up to it give the ₹624 wait saving.
- **One Assumptions-check table (amends Home's sub-line to match J18).** `ASSUMPTIONS_CHECK_META` moved from Performance to `shared/priority/priority.ts`. Home's "Assumptions check" sub-line takes its status and word from it: within → good "Within range", above → info "Above range", below → watch "Below range". It read every non-within verdict as watch "Outside range".
- **One harvest floor for "used up" (amends W5-F4's empty-plan line and W5-F8).** `core/tax-lots.ts` exports `HARVEST_FLOOR = 2000` (mirrors `actions.HARVEST_FLOOR`, A12) and `exemptionUsedUp(remaining)` (`remaining < HARVEST_FLOOR`). Tax's empty harvest plan and Actions' empty "Book gains tax-free" card both use it, so with ₹1,000–₹2,000 left and no plan rows both say the allowance is used up, matching `tax:ltcg-harvest` closing below the floor. The T2 meter's hint ("room to book" while anything remains) is a literal reading of the meter and is unchanged.

## Wave 6

Prepared against the working tree after wave 5 landed (backend pytest 559 passed; `npx ng build` and `npm run check` green). Decisions K1–K22 bind wave 6 and every later wave. They add to Parts A–D, E1–E20, G1–G16, H1–H20 and J1–J20. Where they differ from WAVES.md, waves.json or SPEC.md, they win.

### Ownership and parallel safety

**K1. The wave-6 task list differs from WAVES.md as follows.**
- **W6-B4 is merged into W6-B3.** Tax-aware sell ordering is one rule that both `goals.rebalance_plan` and `optimizer.suggest` need (§6.9 P2, §6.13). Two parallel builders would each write a copy, and neither may import a sibling's new helper (A2). W6-B3 therefore owns `goals.py`, `optimizer.py` and the one shared helper in `tax.py` (K12). The id W6-B4 is retired.
- **W6-B1 gains `api/ledger_api.py`** (D17: the CSV and CAS commits go through `bulk_add`). It also gets the paged `GET /transactions` route, moved here from W7-B1: W6-B1 owns the file and the helper, so W7-B1 no longer lists it. It adds a new test file for the ledger work.
- **W6-B5 gains a new pure module `analytics/signals.py`** (K16). The one signal model cannot live in `markets.py`: `quant` may import only `domain` and `assumptions` from the package (G3), and `markets.py` imports the network module `prices`.
- **W6-F1 gains `features/holdings/outlook-card.component.ts`.** That card shows the holding's trend next to its Markets chips, which is exactly the "Uptrend" + "Falling steadily" clash P2.12 removes.
- **New W6-F2** (A2, D20) owns `core/models.ts` and `core/api.service.ts`. It adds the P2 types and API methods for wave 6's payloads and for wave 7's routes (K19), so W7-F2 to W7-F7 do not depend on W7-F1.
- **File lists (disjoint):**

| Task | Files |
|---|---|
| W6-B1 | `backend/tracker/migrations.py`, `backend/tracker/ledger.py`, `backend/tracker/api/ledger_api.py`, `backend/tests/test_migration.py`, new `backend/tests/test_ledger_p2.py` |
| W6-B2 | new `backend/tracker/analytics/simulate.py`, `backend/tracker/analytics/forecast.py`, new `backend/tests/test_simulate.py`, `backend/tests/test_forecast.py` |
| W6-B3 | `backend/tracker/analytics/goals.py`, `backend/tracker/analytics/optimizer.py`, `backend/tracker/analytics/tax.py`, `backend/tests/test_goals.py`, new `backend/tests/test_optimizer.py`, `backend/tests/test_assumptions.py` |
| W6-B5 | new `backend/tracker/analytics/signals.py`, `backend/tracker/analytics/quant.py`, `backend/tracker/markets.py`, `backend/tests/test_markets.py` |
| W6-B6 | new `backend/tracker/analytics/calibration.py`, `backend/tracker/analytics/calendar.py`, new `backend/tracker/data/festivals.json`, new `backend/tests/test_calibration.py`, `backend/tests/test_calendar.py` |
| W6-F1 | `frontend/src/app/features/markets/markets.component.ts`, `frontend/src/app/features/markets/market-parts.ts`, `frontend/src/app/features/holdings/outlook-card.component.ts` |
| W6-F2 | `frontend/src/app/core/models.ts`, `frontend/src/app/core/api.service.ts` |

- **Owned by no wave-6 task** (must keep passing or compiling; never edited): `services.py`, every `api/*.py` except `ledger_api.py`, `assumptions.py`, `actions.py`, `brief.py`, `insights.py`, `plans.py`, `mc.py`, `history.py`, `portfolio.py`, `story.py`, `prices.py`, `push.py`, `__init__.py`, and every test file not listed above (`test_api.py`, `test_p1_api.py`, `test_brief.py`, `test_actions.py`, `test_risk.py`, `test_wave1_contracts.py`, `test_analytics.py`, `test_tax_whatif.py`, `test_plans.py`, `test_mc.py`, `test_links.py`, `test_insights.py`, `test_epf_import.py`). On the frontend, everything except W6-F1's and W6-F2's files.
- **One A2 test move.** `test_forecast.py::test_optimizer_respects_caps_floors_and_locked_segments` tests the optimizer, but it sits in W6-B2's file and pins KEEP_SHARE 0.5 ("an aggressive mix still keeps at least half"). **W6-B2 deletes it. W6-B3 recreates it in `test_optimizer.py`** with the K14 expectations (FD ≥ a quarter of its weight). W6-B3's acceptance is the full suite green apart from that one test, until W6-B2's deletion lands.
- **Acceptance never depends on a sibling.** Backend: `cd backend && PYTHONIOENCODING=utf-8 python -m pytest -q` (the full suite) plus the task's own tests. Frontend: `cd frontend && npx ng build && npm run check`, plus manual checks on a mocked API (development build, fake token, synthetic payloads; never the real server, database or tokens). Cross-task checks are the integrator's (K22).

**K2. Engine changes in wave 6 and who wires them (A1).**
- New inputs are **keyword-only with defaults**. `services.py` and the API files are untouched in wave 6, so every existing call site keeps working.
- **Two exceptions are the point of P2.1 and P2.3, not regressions:** `forecast.project_portfolio` and `forecast.retirement_plan` switch engine to `simulate.run`, and `stress_test` recovery moves to the typical return (K11). With the defaults, their numbers change but their payload keys only grow. Every unowned test must stay green. A builder whose engine change breaks an unowned test reports it and adjusts the engine, never the test.
- **W7-B1 wires:**
  - `project_portfolio(..., *, sips=, txns=, instruments=, targets=, after_tax=, slab_rate=)` (K9);
  - `retirement_plan(..., *, funding=, txns=, instruments=, sips=)` (K10);
  - `stress_test(..., *, betas=, plan=, sips=, txns=, instruments=)` (K11);
  - `goals.project_goal(..., *, linked_sips=)` (K15);
  - `goals.rebalance_plan(..., *, port=, txns=, instruments=, slab_rate=, today=)` (K13) and `optimizer.suggest(..., *, txns=, instruments=, slab_rate=, today=)` (K14), which is D1;
  - `calibration.coverage(...)` into `/assumptions` (K17);
  - the `action_log` seen/pushed helpers into the notification routes and the digest (K7).
- `calendar.py` loads `festivals.json` by itself, and `holding_outlook` calls the signal model itself. These two need no wiring.

### Ledger (W6-B1)

**K3. Migration 006 and the goal ↔ SIP link (§7.5, P2.7).**
- `m006_sip_goal(db)` returns `[("ALTER TABLE sip_plans ADD COLUMN goal_id INTEGER", None)]` only when `"goal_id" not in db.columns("sip_plans")`, and `[]` otherwise. `MIGRATIONS` gains `(6, "sip_goal", m006_sip_goal)`. A fresh database (m004 creates `sip_plans` without the column) and a legacy import both end with the column. Re-running is a no-op.
- `SIP_FIELDS += ("goal_id",)`. In `save_sip`:
  - `goal_id` of `None` or `""` stores NULL;
  - otherwise it must be an integer id of a goal whose `owner` equals the plan's owner: the `owner` argument on create, the stored row's owner on update. Anything else raises `ValidationError("That goal isn't one of this portfolio's goals")`.
  - The `instrument_id` path is unchanged.
- `delete_goal` runs `UPDATE sip_plans SET goal_id = NULL WHERE goal_id = ?` and the `DELETE` in one `db.batch`, then `_bump()`.
- `ledger.sips()` already returns `s.*`, so `goal_id` appears on every plan row with no query change.
- **Tests:** 006 idempotent; `test_m005…` now expects `[5, 6]` after the 4-migration prefix; the legacy test expects `[1, 2, 3, 4, 5, 6]`; another owner's goal is refused; deleting a goal nulls its plans' `goal_id` and leaves the plans.

**K4. Ledger paging (P2.11).**
- `Ledger.transactions_page(scope, page=1, size=50, q=None, sort="-date", *, filters=None) -> {rows, total, page, size, pages, sums, months}`.
  - `rows` have the exact shape of today's `GET /transactions` items: the transaction plus `instrument_name`, `asset_class`, `segment`, `currency`.
  - `filters` keys are `asset_class`, `instrument_id`, `type`, `from` and `to`, the same semantics as today's query parameters.
  - `q` is case-insensitive, trimmed and at most 100 characters. It matches `instrument_name`, the instrument's `symbol`, the transaction `type` and `notes`.
  - `sort` is one of `date`, `-date`, `amount`, `-amount`, `name` or `-name`, with `id` as the tie-break in the same direction. Anything else raises `ValidationError`.
  - `size` is clamped to 10–200 and `page` to ≥ 1. A page past the end returns `rows: []` with the true `total`.
  - `sums` and `months` cover **every filtered row, not just the page**:
    - `sums` = {`count`, `out`, `in`, `net` = out − in}, where `out` counts `BUY` and `FX_IN` amounts and `in` counts `SELL`, `DIVIDEND`, `INTEREST`, `REPAYMENT`, `MATURITY` and `FX_OUT` (the lists the Transactions page uses today);
    - `months` = [{`month` 'YYYY-MM', `count`, `out`, `in`}], newest first.
  - It filters in Python over `load(scope)` (memoised), like today's route. SQL paging is not needed at this ledger size.
- **Route (moved from W7-B1):** `GET /transactions` returns the paged object **only when `page` is present**. Without it, the response is the unchanged list. Bad `page`, `size` or `sort` → 400.

**K5. Atomic import commits (D17, P2.11).**
- **`bulk_add` without a `ref`.** When a `new_instrument` has no `ref`, the later statements find it by `(owner, asset_class, LOWER(name))`, newest first: the same identity `find_or_create_instrument` uses. With a `ref`, the lookup is unchanged.
- **CSV commit** (`POST /transactions/import/commit`) is all-or-nothing:
  1. Resolve each row to an existing instrument or a planned new one (one per `(asset_class, lower(name))`).
  2. Validate every row (`_validate_txn` with `check_holdings=False`).
  3. Check the end state per instrument with `run_fifo(existing + new rows)`, as the CAS path already does: units never go negative, BUYs before SELLs on a day.
  4. Write everything in **one** `bulk_add(..., check_holdings=False)`.
  - Success: 200 `{imported, results}` (results as today, all ok).
  - Any failure: **nothing is written**, and the response is 400 `{error: "Nothing was imported: N row(s) need fixing", results: [{name, date, ok, error?}]}`.
- **CAS commit** (`POST /import/cas/commit`) is all-or-nothing the same way, across all funds and NPS rows, in one `bulk_add`:
  - new funds as `new_instrument` (with `symbol` `AMFI:<code>` when known);
  - an NPS NAV update as a `field_updates` entry;
  - new NPS schemes as `new_instrument` with `ref` = PRAN, plus their opening BUY.
  - Success keeps today's `{imported, results}`. Any failure → 400 with `results`, nothing written.
- The Kite, EPF and LenDen commits already make one `bulk_add` call each and are unchanged.
- **Tests:** a CSV whose second row is invalid writes nothing (transaction and instrument counts unchanged), and the same CSV fixed writes both rows; a CAS with one bad fund writes nothing; `test_api.py::test_csv_import_preview_and_commit` stays green.

**K6. Who calls the import commits.** The frontend's two callers (`transactions.component.ts`, `import.component.ts`) already show `errorMessage(e)` on a failed POST, so a 400 shows its `error` line. W7-F7 renders `results` from the 400 body. No wave-6 frontend task touches them.

**K7. Action-log helpers and snapshot reads (D15, §8.6, §6.11).** None of these bump `_version` or `actions_rev`: they are bookkeeping, and W7-B1 reads `seen_at`/`pushed_at` outside any memo.
- `mark_seen(owner, ids, at=None) -> int`. `at` defaults to `now_iso()`. For each id:
  - an existing row with `seen_at IS NULL` gets `seen_at = at`;
  - a missing id that starts with `notice:` is inserted as `(owner, id, status 'done', first_seen today, tier_first NULL, done_via 'seen', seen_at)`. It never counts toward follow-through, because `tier_first` is NULL (§8.5);
  - any other missing id is inserted as status `open` with `seen_at`.
  - Returns how many rows were set.
- `mark_pushed(owner, ids, at=None) -> int`: the same, on `pushed_at`. A missing id is inserted as status `open`.
- `kpi_snapshots(owner, since=None, until=None) -> [{date, data}]`, ascending by date, with `data` decoded. Malformed rows are skipped. Calibration reads this (W7-B1 → K17).
- W7-B1 maps notice ids to rows: `act:<action id>` → row `<action id>`; every other notice id → row `notice:<notice id>`.

### Simulation (W6-B2)

**K8. `simulate.py`: the contract.** Pure, with no database or network. It imports `assumptions`, `plans` and `domain` only, never `forecast`, `goals`, `quant` or `mc`.
- **Entry points.**
  - `build_state(positions, *, book, today, txns=None, instruments=None, targets=None) -> dict`;
  - `flows_from_sips(sips, *, state, today, horizon_months, stop_month=None) -> list`;
  - `lump_flow(monthly, *, state, step_up_pct=0.0, today, horizon_months, stop_month=None) -> list`;
  - `run(state, flows, book, *, horizon_months, sims=1000, seed=42, real=False, inflation=None, after_tax=False, slab_rate=0.30, shock=None, glide=None, withdrawals=None, goals=None, milestones=None, sample_months=None) -> dict`.
  - The §6.3 signature is kept, and the extra keyword arguments are what the adopters (K9–K11) and W7-B1's compare and sensitivities need.
- **Keys.**
  - Stochastic: `Equity (India)`, `Equity (USA)`, `Mutual Funds`, `MF_DEBT`, `Commodity` and `NPS`, each from `assumptions.book_key(position)`. The USD wallet maps to `Equity (USA)` as the Book says.
  - Deterministic ladders: `Fixed Deposits`, `P2P` and `EPF`, as §6.3 describes, with the amendments below.
  - μ and σ per key come from `book` (`rated_book(positions)` by default, so FD, EPF and P2P use the holding rates and P2P is capped). Only keys with value or flows are stepped.
- **Ladder rules.**
  - **FD:** each open FD accrues at its `rate` and releases `maturity_value` (else the accrued value) in the step that contains `maturity_date`. A matured-but-unrecorded FD (A28) releases at step 0.
  - **P2P:** EMIs on the outstanding over the months left at `rate`, with each month × (1 − P2P_LOSS/12). A defaulted loan earns 0 and releases nothing.
  - **EPF:** the monthly contribution is **the same per-calendar-month average `cash_flow_forecast` uses (H16/W4-B2)**, extracted into one shared helper in `forecast.py`, not "the last 12 months" (this amends §6.3). Without `txns` it is 0. Interest is credited each March, and the balance is locked (never withdrawn or routed) until `glide`/`withdrawals` say retirement has started.
- **Routing is decided once, on the deterministic path.** This is the main amendment to §6.3 and resolves the N4 cost concern. FD releases, P2P receipts not re-lent and the money to re-lend are routed on the no-shock path at each key's μ:
  - with `targets` ({segment: pct}), to the segment furthest under target (its key; `Mutual Funds` → `Mutual Funds`);
  - otherwise to `MF_DEBT`;
  - P2P receipts are re-lent while P2P is under 10% of the deterministic total.
  - Every simulation then moves the same rupees to the same key at the same step. The result is **linear in the flows on every path**. Two things follow: CRN deltas are exact, and a required SIP is an order statistic, not a bisection (K10).
- **Steps (D18).** Monthly for the first 24 months, then quarterly to the horizon (the last step may be shorter). After `withdrawals.start_month` the steps are **yearly** (amends D18 for the drawdown phase only): withdrawals are annual and annuity-due, and no SIP flows remain. Flows inside a step are summed and added at mid-step (`value += flow × √g`; `basis += flow`).
- **Draws (CRN and antithetic).**
  - Every step draws the full 6-vector z ~ N(0, I₆), whichever keys are empty, and correlates it as f = Lz. L is the pure-Python Cholesky factor of the 6×6 stochastic block of `assumptions.CORR`, computed once per call.
  - Simulation pair j uses `random.Random(seed * 1_000_003 + j)`. Simulation 2j+1 uses −z of 2j.
  - So CRN holds **across different horizons, key sets and flows**: retire +2 years, a new mix or a higher SIP only append or reweight. `sims` is rounded up to even.
- **Growth.** g_s = exp((ln(1+μ_s) − σ_s²/2)·dt + σ_s·f_s·√dt), as §6.3 says.
- **`glide`** = {`current_age`, `start_age` 45, `floor` 0.30, `step` 0.01}.
  - At each year end from `start_age`, the target equity share (`Equity (India)` + `Equity (USA)` + `Mutual Funds`) is max(floor, e₀ − step × years since `start_age`), where e₀ is the share at the start.
  - Any excess moves half to `MF_DEBT` and half to a deterministic FD pool at the Book's `Fixed Deposits` μ. The glide never buys equity.
- **`withdrawals`** = {`start_month`, `annual`, `growth`, `until_month`, `annuity`?}.
  - At `start_month` the EPF balance and any outstanding ladders are released to `MF_DEBT`.
  - At the start of each year, W_k = annual × (1+growth)^k, less the NPS annuity income when `annuity` is given (K10), is taken pro rata by value from every key.
  - A path that cannot pay W_k is **depleted**: its value becomes 0 and its depletion month is recorded.
- **`after_tax`.**
  - FD and P2P accrual uses rate × (1 − slab × 1.04).
  - The horizon value "if sold" subtracts: equity (`Equity (India)` + `Mutual Funds`) 12.5% × 1.04 on gains above ₹1.25 L, used once; `Equity (USA)` and `Commodity` 12.5% × 1.04 on gains; `MF_DEBT` slab × 1.04 on gains; nothing on NPS and EPF. Basis is tracked per key.
  - Note: "at today's rules; surcharge not modelled".
- **`shock`** = {key: fraction} applied to values at t = 0, before any growth.
- **`goals`** = [{`id`, `alloc` {key: share of that key's starting value}, `target`, `month`, `flows` [indices into `flows`]}]. Value = Σ alloc × V_k,0 × G_k,t plus the listed flows grown along their keys (§6.3 "goals from the same draws"). Output {`id`, `probability` (share ≥ target, %, 1 dp), `p10`, `p50`, `p90`}.
- **Result keys:**
  - `years` [{`year` (index from 0), `p10`, `p25`, `p50`, `p75`, `p90`, `contributed`, `by_key_p50` {key: median}}];
  - `expected` [one deterministic value per year at μ: the mean];
  - `no_flow_p50` per year (the state-only component, tracked alongside by linearity, so no second pass is needed);
  - `milestones` [{`amount`, `probability`, `median_months`}] at step resolution;
  - `prob_below_contributed_3y`;
  - `max_drawdown_p50`;
  - `at` {month: sorted list of path values} for each requested `sample_months`;
  - `depletion` {`lasts_pct`, `ages`: sorted depletion months, or `null` for paths that last} (with `withdrawals` only);
  - `goals`;
  - `after_tax` {`p10`, `p50`, `p90`} at the horizon (with `after_tax` only);
  - `sims`, `seed`, `steps`, `notes`.
  - `real=True` deflates by (1+inflation)^(t/12), with `inflation` defaulting to `assumptions.INFLATION`.
- **Budget (A4, D18).** `test_simulate.py` times one `run` with all six stochastic keys non-empty, 2 FDs, 1 P2P loan, EPF, 3 SIP plans (monthly, quarterly, weekly), `horizon_months=360`, `sims=1000`, `after_tax=False`, using `time.perf_counter`.
  - The test fails above 2.5 s. The builder reports the measured time (target ≤ 1.0 s), and the same with `after_tax=True`.
  - A lead prototype of the core loop measured about 0.6 s for six keys on this machine.
  - If 2.5 s is missed, the interactive default drops to 600 sims and the report says so. If `after_tax=True` alone misses it, D5 cuts the toggle.
- **The §7.9 tests in full:**
  - σ = 0 → p10 = p50 = p90 = the closed-form FV within 0.5%;
  - percentiles monotone;
  - the same seed → identical output;
  - a higher SIP raises every percentile (CRN);
  - an FD releases in its maturity month;
  - EPF stays locked;
  - after-tax ≤ pre-tax;
  - the speed test;
  - plus: linearity, where run(flows × 2) − run(flows) equals run(flows) − run(0) per path to within ₹1;
  - plus: CRN across horizons, where the first 120 months of a 360-month run equal a 120-month run.

**K9. `project_portfolio` becomes a thin wrapper (§6.13).**
- **Signature:** `project_portfolio(port, perf_metrics, years=10, monthly_sip=0.0, step_up_pct=0.0, sims=2000, today=None, return_override=None, *, inflation=None, sips=None, txns=None, instruments=None, targets=None, after_tax=False, slab_rate=0.30)`. `test_p1_api.py` pins the snapshot call (`years=1, monthly_sip=0, sims=1000`), so the positional order stays.
- **Payload keys only grow.** Every existing key keeps its meaning: `scenarios.base/bear/bull` are `end.p50/p10/p90`; `no_more_investing` is the `no_flow_p50` at the horizon; `expected` is the mean path; `typical_cagr_pct`, `real_p50`, `assumptions` (+ `own`, `mix`), `honesty` and `note` are as before.
  - New: `engine: 'simulate'`, `by_key` (horizon medians by segment, `MF_DEBT` folded into "Mutual Funds" as `_fold` does), `prob_below_contributed_3y`, `max_drawdown_p50`, `flows_basis` ('plans' | 'mix'), and `end.after_tax` {p10, p50, p90, note} only when `after_tax`.
- **Calibrating to the blended (μ*, σ*).** `blended_assumptions` stays the source of the headline μ and σ, with the own-record blend and `return_override`. Let (μ_mix, σ_mix) = `mu_sigma` of the Book mix and w_s the stochastic share:
  - every stochastic key gets μ_k + δ, where δ = (μ* − μ_mix)/w_s, clamped to ±0.05 (0 when w_s < 0.05);
  - every stochastic key gets σ_k × s, where s = σ*/σ_mix, clamped to 0.5–2 (1 when σ_mix = 0).
  - Ladders keep their rates.
  - With no override and no record blend, δ = 0 and s = 1 (unless the σ floor bites), so the default projection is the Book's.
  - This is how the existing tests that the record blend and `?return=` move the result keep passing (`test_api.py::test_brief_retirement_picks_up_a_warm_performance`).
  - The `assumptions` block still reports (μ*, σ*).
- **Flows:**
  - with `sips` and `monthly_sip` None (W7-B1's default), each plan is routed to its key (`flows_basis: 'plans'`);
  - otherwise `monthly_sip` is one lump flow with `step_up_pct`, split by the plans' monthly equivalents when `sips` is given, else pro rata over the current stochastic value (`Mutual Funds` when there is none) (`flows_basis: 'mix'`).
- `sims` keeps its 200–5000 clamp. The guest cap stays in `forecast_api.py` (A20).

**K10. Retirement P2 (§6.5).**
- **Signature:** `retirement_plan(port, perf_metrics, params, today=None, sims=1000, *, funding=None, txns=None, instruments=None, sips=None)`.
- **The deterministic P0 outputs are unchanged:** `corpus_needed`, `projected`, `gap`, `path`, `runs_out_at`, `fire`, `first_year_withdrawal` and the 400 rule.
- **The Monte Carlo parts come from one `simulate.run`** (seed 7, `sims`, `glide` from `current_age`, `withdrawals` from `retire_age` to `life_expectancy` with W₁ and inflation):
  - `probability` = share of paths with value at the retirement month ≥ `corpus_needed`;
  - `probability_lasts` = `depletion.lasts_pct`;
  - `depletion_age_p10` = the 10th-percentile depletion age when at least 10% of paths deplete, else null;
  - `path_bands` [{age, p10, p50, p90}], one per age from `current_age` to `life_expectancy`.
- **`status`** = `status_for(min(probability, probability_lasts))`. Either one alone when the other is None. The gap only when both are None.
- **`required_sip` is exact on the same draws (amends G8 for retirement).** The accumulation is linear (K8). For each path, A_i is the value at retirement with no SIP and B_i is the value from ₹1/month (same routing and step-up). The path's need is (corpus_needed − A_i)/B_i, floored at 0.
  - `required_sip` = the 75th percentile, rounded up to ₹1. `required_sip_typical` = the 50th percentile.
  - The probability at `required_sip` is therefore ≥ 75 by construction, and < 75 at `required_sip` − ₹100 unless the need is 0.
  - Goals keep `mc.required_sip_for` (K15).
- **EPF and NPS are product facts in the simulation, whatever `funding` is:**
  - EPF is locked until retirement and joins the corpus there.
  - At retirement 60% of the NPS value joins the corpus, and 40% buys an annuity at 6% whose income offsets each year's withdrawal.
  - `corpus_needed` itself stays the P0 formula. `note` says the annuity offset and the post-retirement growth (the Book mix with the glide, not `post_return_pct`) apply only to the probabilities.
- **`funding`** (W7-B1 passes `/plan`'s funding) makes the starting money the goal-free money: EPF + NPS + `funding.free`, spread pro rata over the other keys. Money earmarked for goals or the cushion is excluded, which ends the double count.
  - The output gains `sources` {`epf`, `nps`, `free`, `excluded`}, and `current` is the money used.
  - Without `funding`, the whole portfolio is used as today, and `sources` is null.
- **Brief cost.** `/brief` calls `services.retirement` cold. W6-B2 reports the retirement call's time on a copy of the scratchpad database with a saved plan, for the K22 A5 re-measure.
- **Tests:**
  - with zero growth (σ = 0, μ = 0), `probability_lasts` ≤ `probability`;
  - a corpus far above the need lasts 100%;
  - a tiny corpus depletes with `depletion_age_p10` set;
  - `status` follows the minimum;
  - the exact `required_sip` checks (≥ 75 at it, < 75 at −₹100);
  - the D3(b) 75 ± 8 cross-check is replaced by that exact check.

**K11. Stress v2 (§6.8 P2, P2.3).**
- **Signature:** `stress_test(port, monthly_sip=0.0, *, betas=None, plan=None, sips=None, txns=None, instruments=None)`.
- **β-scaled shocks.**
  - With `betas` ({instrument_id: β}), each holding in `Equity (India)`, equity `Mutual Funds` or `NPS` takes segment shock × β, clamped to −0.95..+1.0.
  - Holdings without a β, and every other key, take the segment shock (β prior 1.0). β against the Nifty means nothing for US stocks, gold or debt.
  - `MF_DEBT` keeps G8 (−4% in rates, covid and gfc).
  - Segment rows are the sums of their holdings. Each scenario gains `holdings` [{instrument_id, name, segment, value, beta, shock_pct, impact}], the 10 largest |impact| only (the copy has 168 instruments).
- **Recovery two ways.**
  - `recovery_months_markets`: months for the after-shock value, each key growing at its Book **typical** return with no SIPs, to regain `total`, capped at 240 (null beyond).
  - `recovery_months_with_sips`: the same plus `monthly_sip`.
  - `recovery_months` stays as an alias of `recovery_months_with_sips`. Its basis moves from μ to typical, so the figures lengthen slightly.
- **`plan_impact` (only when `plan` is given).** `plan` = {`retirement`: merged retirement params | None, `goals`: [goal rows with id, name, allocation, target_amount, target_date]}.
  - For every scenario with `impact` < 0, one baseline and one shocked `simulate.run` (seed 7, 500 sims, CRN; horizon = the latest of retirement and the goal dates; goals from the same draws).
  - The scenario gains `plan_impact` {`retirement_before`, `retirement_after`, `goals` [{id, name, before, after}]}, where the retirement figures are accumulation probabilities.
  - The top-level `plan_impact` is the `worst` scenario's.
  - Without `plan`, both are null.
- **Cost rule for W7-B1.** `plan_impact` costs up to 7 runs of 500 sims. It is computed only for `GET /forecast/stress`, under its own memo key that includes the plan's hash. The `services.stress` the brief, actions, market_state and Risk paths use never passes `plan`. `betas` come only from a **warm** risk memo (`_peek`), never from building history.
- **Tests:** β 1.5 deepens and β 0.5 softens an equity holding's shock; debt funds unchanged; recovery with SIPs ≤ markets alone; `plan_impact` after ≤ before under a falling scenario; no `plan` → null.

### Rebalancing (W6-B3, with W6-B4 merged in)

**K12. One sale-planning helper in `tax.py`.**
- **Signature:** `tax.plan_sales(port, txns, instruments, legs, *, slab_rate, today=None, max_per_leg=5) -> {legs, tax_total, exemption_used, note}`. Each leg is {`segment`, `amount`}.
- **Candidates per leg.** Open positions in that segment with value > 0, `asset_class` in TRADABLE, priced, and with sellable units after the ELSS lock.
- **Classification and order.** A candidate is classified by the FIFO sale of min(amount still to free, its sellable value), from its oldest open lots (`open_lot_view`):
  - `loss` (gain < 0) first, most negative first;
  - `lt_exempt` (all consumed lots long-term, `tax_class` equity, gain ≥ 0, and the exemption still left across the legs so far covers it) next, lowest gain/proceeds first;
  - `other` last, long-term before short-term, then lowest gain/proceeds.
  - Candidates are taken greedily until the leg is covered or `max_per_leg` is reached.
  - Units are rounded down to whole shares, or to 0.001 units for funds, as W3-B3 does.
- **Costing.** Each sell gets `tax` from `what_if_sale` alone. Each leg's `tax` is marginal in leg order: compute_tax with every synthetic sale up to that leg minus compute_tax up to the previous leg. `tax_total` = all sales together minus none, so **the exemption is used once across all legs**. A candidate that raises `WhatIfError` is skipped.
- **Output.** Each leg = {`segment`, `amount`, `covered`, `sells` [{instrument_id, name, qty, proceeds, gain, st_gain, lt_gain, tax, order}], `tax`}. `note` = "Sales costed together, so the ₹1.25 L exemption is used once. Estimate at your {slab}% slab incl. 4% cess; surcharge and exit loads not modelled. " + `CHARGES_NOTE`.
- **Cost:** at most legs + 1 compute_tax pairs plus ≤ 5 `what_if_sale` calls per leg. Existing `tax.py` functions are unchanged, and `test_tax_whatif.py` stays green.

**K13. `goals.rebalance_plan` P2 (P2.8).**
- **Signature:** `rebalance_plan(segments, targets, new_money=0.0, allow_sell=False, *, port=None, txns=None, instruments=None, slab_rate=None, today=None)`.
- **The no-sell plan is unchanged.**
- **With `allow_sell`, whatever the keyword arguments:**
  - **FD and P2P are maturity-only.** A row that would sell becomes `action: 'hold'`, `amount: 0` and `let_mature` = the amount it is over.
  - **EPF and NPS are locked.** `action: 'hold'`, `amount: 0`, `locked: true`.
  - **Buys are scaled** by (Σ allowed sells + new_money) / Σ buys when that factor is < 1, so the plan never spends money it does not free.
  - `after_pct` and the totals are recomputed on the scaled plan. The plan gains `not_sold` = Σ `let_mature` + locked excess.
  - The rebalance planner already reads an over-target FD/P2P `hold` row as "Redirect maturities". W7-F3 shows `let_mature`.
- **With `allow_sell` and `port`, `txns` and `instruments`:** the sell rows become `tax.plan_sales` legs, largest first. Each sell row gains `sells` and `tax_if_sold` (the leg's marginal tax), and the plan gains `tax_total` and `tax_note`. Without them, those keys are absent.
- **Tests:** no FD/P2P/EPF/NPS sell rows; buys scaled when FD cannot fund them; the sell order (a loss holding before a long-term gain inside the exemption before a short-term gain); `tax_total` equals one combined compute_tax delta; the no-sell plan is byte-identical to today on the `test_analytics.py` fixtures.

**K14. `optimizer.suggest` P2 (§6.13).**
- **Signature:** `suggest(port, profile="balanced", seed=11, *, txns=None, instruments=None, slab_rate=None, today=None)`.
- `KEEP_SHARE = 0.25`. `floors_for`'s docstring and the `note` say "a quarter".
- **FD and P2P rows** whose suggested weight is below current get `action: 'let_mature'`, never `'trim'`, and are left out of `turnover`. The `note` says "FD and P2P are left to mature, never sold". Locked EPF/NPS are unchanged.
- **The MF split stays E16** (the Mutual Funds weight split by the current debt share via `assumptions.book_key`). That is the P2 "MF split by category". The optimizer does **not** gain a ninth decision variable, because targets are by segment and `MF_DEBT` must never reach `targetAllocation`. A test pins that a debt-only fund portfolio's `current.vol_pct` uses the MF_DEBT σ and that no row or profile names `MF_DEBT`.
- **Every `trim` row carries `tax_if_sold`:** `tax.plan_sales` over the trim legs when `txns` and `instruments` are given, else `None`. With the inputs, the row also carries `sells`, and the result `tax_total`.
- `_CORR_ROWS` and its `__all__` entry are dropped, with `test_assumptions.py::test_optimizer_corr_rows_alias_is_derived_from_corr` (G4).
- The brief Risk vital still equals `current.vol_pct` (`test_risk.py`, `test_assumptions.py`): floors do not touch `current`.

**K15. Goal-linked SIPs (P2.7) and what stays on `project_goal`.**
- **Signature:** `project_goal(goal, segments, today=None, sims=1000, *, positions=None, linked_sips=None)`. `linked_sips` = the plan rows with `goal_id == goal.id`; W7-B1 filters them from `ledger.sips`.
- When their monthly total is > 0, it replaces `goal.monthly_contribution`. The total is Σ amount × `plans.SIP_PER_MONTH[frequency]` over plans that are active, started (`start_date ≤ today`) and not ended, with no step-up (the `monthly_sip_total` rule).
- **Projection gains:** `linked_sips` [{id, name, amount, frequency, monthly_equiv}], `linked_monthly`, and `contribution_source` ('linked' | 'goal'). With no linked plans, `contribution_source` is 'goal' and nothing else changes.
- **"Goal path from simulate" (§6.13 P2 goals row) is moved to the backlog.** Goal cards keep `mc` and `mu_sigma`. The goal-from-same-draws output of `simulate.run` serves only compare and sensitivities (W7-B1), whose table shows its own baseline column, so the two methods never sit side by side.

### Signals and calibration (W6-B5, W6-B6)

**K16. One signal vocabulary (P2.12).** New pure `analytics/signals.py`, which imports nothing from the package. It holds:
- **Constants, moved from `markets.py`:** `WEEK = 5`, `MONTH = 21`, `RULES`, `SIGNAL_TEXT`, and the new `SIGNAL_LABEL = "price pattern, not a forecast"`.
- **`windows(vals) -> {w1, m1}`**, the exact rule `markets.metrics` uses: w1 is the change over 5 closes, m1 over 21, 2 dp. `markets.metrics` calls it, so the two cannot drift.
- **`signals_for(m)` and `describe(sig, m)`**, moved unchanged. `describe` adds `label: SIGNAL_LABEL`. Its other keys are kept, and the four keys and titles do not change.
- **`rsi(vals, n=14)` with Wilder smoothing.**
  - The first average gain and loss are the simple means of the first n changes. After that, avg = (prev × (n−1) + current)/n over every close.
  - It returns 100 when the average loss is 0, and None with n or fewer changes.
  - Test against the published StockCharts RSI example (first value 70.53, then 66.32, …) to within 0.05, and against a second, plain implementation written in the test.
- **`trend(vals, sigs) -> {key, label}`.**
  - The SMA rule `holding_outlook` uses today (price vs SMA50 and SMA200), then reconciled with the signals: `up` with `momentum_sell` → `mixed`; `down` with `momentum_buy` → `mixed`.
  - Labels: Uptrend, Downtrend, No clear trend.
  - It returns `reconciled: true` when it changed the key.
- **`read(vals) -> {w1, m1, signals: [described], trend, rsi}`.**
- **`markets.py`** re-exports `RULES`, `SIGNAL_TEXT`, `signals_for` and `describe` from `signals`, so `test_markets.py`'s existing calls keep working, and stops defining them.
- **`quant.py`:**
  - `quant.rsi` becomes `signals.rsi` (Wilder).
  - `holding_outlook` computes `trend` through `signals.trend` and adds `signals` (described, from its own closes via `signals.read`).
  - Its notes follow the reconciled trend. When `reconciled`: "Above its long averages but falling over the past month: no clear trend.", or the mirror for down.
  - Importing `signals` keeps G3 (it is a leaf).
- **The agreement test.** On one closes fixture, with no live quote, `holding_outlook(points)['signals']` equals `[describe(s, metrics(points)) for s in signals_for(metrics(points))]`, and the trend is never `up` while `momentum_sell` is present.
- Markets' own rows may still differ from the outlook by today's live tick, which the outlook does not use. That is noted, not fixed.
- **`HONESTY.signal` in `assumptions.py` is unchanged.** `test_assumptions.py` pins it, and it is not wave 6's file. W7-B1 may align it to `SIGNAL_LABEL`.

**K17. Calibration and the festivals file (§6.11, P3).**
- **`calibration.coverage(snapshots, perf_points, today) -> {matured, inside, coverage_pct, target, show, rows}`.** Pure.
  - Inputs:
    - `snapshots`: [{date, data}] rows (`ledger.kpi_snapshots`), using `data.projection_1y` {p10, p50, p90} (H12 growth factors);
    - `perf_points`: [(date, index)], or the `/performance` ALL `series` rows {date, index}.
  - **One snapshot per calendar month:** the earliest dated one that has a `projection_1y`.
  - **Matured** when date + 365 ≤ today and both index points exist. A point is the nearest index point within 7 calendar days of the date, ties to the earlier one.
  - Realised g = index(d+365) / index(d). **Inside** when p10 ≤ g ≤ p90.
  - `coverage_pct` = inside/matured × 100 to 1 dp, or null at 0 matured. `target` is 80. `show` = matured ≥ 6.
  - `rows` [{date, p10, p50, p90, realised, inside}], newest first.
  - Index is TWR, so new money does not count as growth, which matches the no-SIP projection.
- **`data/festivals.json`:** `{"version": 1, "source": "...", "festivals": [{"date", "key", "name", "kind", "source"}]}`.
  - `calendar.py` loads it once at import into the same module-level `FESTIVALS` list of `(date, key, name, kind)` tuples, so `build_calendar`, `FESTIVE_WINDOWS` and `test_links.py` are untouched.
  - A missing or malformed file gives `[]` and a printed warning, never an import error.
  - The file keeps the three current dates and adds Dhanteras and Diwali (Lakshmi Puja) for 2027 and 2028, and Akshaya Tritiya for 2028, from a published panchang. Each entry gets a `source`, and any date the builder could not cross-check is named in the report.
- **The expiry test fails when no festival is more than 180 days after `date.today()`.** It is a deliberate yearly reminder. On 2026-11-14 the current file fails it, because Akshaya Tritiya 2027-05-09 is only 176 days away.

### Frontend (W6-F1, W6-F2)

**K18. Markets P1.12 banner and the shared chips (W6-F1).**
- **The banner.** When `data().market_state?.mode` is `correction` or `crash`, a banner sits **above T0** (§5.12): a `.verdict-card`-style block striped `watch` for both modes (§1.6: the market is never `act`), `role="status"`, icon and word. No price call: it reads only the `/markets` payload already loaded.
  - Line 1, built by a pure exported `marketBannerText(state)` in `market-parts.ts` that mirrors `markets.context_line` word for word: "Nifty is {|from_high| rounded}% below its high[, after a {|w1|}% fall this week]." then the comparable sentence (smaller than / about the size of / deeper than {the routine-correction scenario | the {label} scenario}), or "Your portfolio is at its peak.", then "Your SIPs are the plan; nothing needs selling."
  - Then the `playbook` lines as a list, and a muted "From stored Nifty closes as of {as_of} · since the high on {since}".
  - No link to itself. A "Your performance →" link goes to `/performance`.
- **Signal chips.** `SignalChipsComponent` keeps its selector and inputs and stays keyed by the four `SignalKey`s. The tooltip ends with `s.label ?? SIGNAL_HONESTY`. `SIGNAL_HONESTY` stays exported and equal to `"price pattern, not a forecast"` (W5-F6's card imports it). The Ideas disclaimer is unchanged.
- **The outlook card.** The Markets chips read `o.signals` when the outlook carries them (K16) and fall back to today's `market()` row. The Trend badge reads `o.trend` (now reconciled). When `o.trend.reconciled` is true, the badge's title says "Long averages and the past month disagree".
  - Types W6-F2 adds are used through a local `Outlook & { signals?: Signal[]; trend?: …; }` so the card compiles alone.
- The strip stays `market:`-only. No signal is ever promoted above `signal` confidence.
- **Manual checks on a mocked API:** `/markets` with `market_state` `normal`, `correction`, `crash` and null; `/holding/<id>` with and without `signals`; at 1280 and in a 390 px frame (one h1, no horizontal overflow, banner above T0).

**K19. W6-F2: P2 types and API methods, and the wave-7 route shapes they fix.** Everything is additive and optional, so every current consumer compiles. Dark mode is cut (D10): no theme types.
- **Wave-6 payloads:**
  - `SipPlan.goal_id: number | null`;
  - `GoalProjection.linked_sips?`, `linked_monthly?`, `contribution_source?`;
  - `RetirementPlan.probability_lasts?`, `depletion_age_p10?`, `path_bands?: {age, p10, p50, p90}[]`, `sources?`;
  - `StressScenario.recovery_months_markets?`, `recovery_months_with_sips?`, `holdings?`, `plan_impact?`, plus `StressTest.plan_impact?`. `PlanImpact` = {retirement_before, retirement_after, goals: {id, name, before, after}[]};
  - `Projection.engine?`, `by_key?`, `prob_below_contributed_3y?`, `max_drawdown_p50?`, `flows_basis?`, `end.after_tax?`;
  - `RebalanceRow.let_mature?`, `locked?`, `sells?: SaleLeg[]`, `tax_if_sold?`, plus `RebalancePlan.not_sold?`, `tax_total?`, `tax_note?`;
  - `OptimizerRow.action` gains `'let_mature'`, `tax_if_sold?: number | null`, `sells?`, plus `OptimizerResult.tax_total?`;
  - `Signal.label?`;
  - `Outlook.signals?: Signal[]` and `trend.reconciled?`;
  - `TransactionsPage` (K4) and `AssumptionsView.calibration?: Calibration | null` (K17).
- **Wave-7 routes (W7-B1 implements exactly these):**
  - `GET /notifications` → `{items: Notice[], unread: number}`. `Notice` gains `seen?: boolean`. Action notices have ids `act:<action id>`.
  - `POST /notifications/seen {ids}` → `{unread}`.
  - `PlanScenario` (D14) = {name, sip, step, return: number | null, retire_age: number | null, lump_sums: {date, amount}[], inflation_pct: number | null, mix: Record<string, number> | null}.
  - `POST /plan/compare {scenarios: (number | PlanScenario)[]}` (≤ 4; guests ≤ 2 × 500 sims) → `PlanCompare` {columns: string[] (column 0 is the baseline), rows: {key, label, format: 'inr' | 'pct' | 'pts' | 'age', values: (number | null)[], deltas: (number | null)[]}[], paths: {name, p50: number[]}[], band: {p10: number[], p90: number[]}, labels: string[], sims, assumptions: ForwardAssumptions, honesty}.
  - `GET /plan?detail=1` adds `sensitivities` {key: 'sip' | 'retire' | 'returns' | 'inflation', label, change, retirement_pts: number | null, worst_goal_pts: number | null, scenario: PlanScenario}[]; `scenario` feeds "Try it".
  - `GET /forecast?after_tax=1` fills `end.after_tax`.
  - `Settings` gains `planScenarios?`, `assumptions?: {segments?: Record<string, {return_pct, vol_pct}>, inflation_pct?}`, and read-only `settings_owner?: string` and `inherited?: string[]` (P2.6: the keys read from `__global__` for a member). The banner reads `settings_owner`.
  - **The digest flag is `marketAlerts.digest: boolean`** (default false). It extends the existing alerts setting rather than adding a key, and W7-B1 validates it.
- **API methods:**
  - `transactionsPage(p)`;
  - `notifications()` typed with `unread?`;
  - `notificationsSeen(ids)`;
  - `planCompare(body)`;
  - `plan(p?: {detail?: boolean})`, where the existing `plan()` calls stay valid;
  - `forecast(...)`, accepting `after_tax?: boolean`.
- `npm run check` must stay green with no consumer edited.

### Carried forward and integration

**K20. Critique items this wave resolves, and carry-overs.**
- **M2 / D1:** the tax-aware keyword arguments on `rebalance_plan` and `suggest` (K13, K14), wired by W7-B1.
- **N4 / D18:** routing on the deterministic path, the step grid, and the measured speed test (K8).
- **C17 / D15:** `seen_at` helpers and notice rows (K7).
- **C20 / D17:** the atomic commits in `ledger_api.py` (K5).
- **M10 / D5:** `after_tax` in the engine with its own timing (K8). W7-B1 and W7-F2 cut the toggle if it misses.
- **C21 / A2 / D20:** W6-F2 (K19).
- **N3:** the 6×6 stochastic block of the PD 9×9 `CORR` is PD, so `simulate`'s Cholesky needs no repair. W6-B2 asserts the smallest pivot is > 0.
- **Carried into this wave:**
  - W2-F5 → W6-F1: the banner and shared vocabulary, keeping `SIGNAL_HONESTY` (K18).
  - G4 → W6-B3: drop `_CORR_ROWS` (K14).
  - W3/W4 → W6-B5: the cone label stays `HONESTY.cone`; signals get `SIGNAL_LABEL` (K16).
- **Backlog, no owner:**
  - goal path from `simulate` (K15);
  - a ninth optimizer variable for MF_DEBT (K14);
  - `forecast`'s P2P EMI survival factor and the global `prices:last_refresh` stamp (H20);
  - refreshing `market_state` on a new ^NSEI close and passing `ctx['sips']` on a cold `/brief` (W4-B1);
  - P2P Overdue at 7 vs 30 days (W4-F3).

**K21. Notes for W7-B1 (fixed now so wave 7 does not reopen them).**
- `GET /transactions?page` already exists (K4).
- `plan_impact` only on `/forecast/stress`, under its own memo key, with `betas` only from a warm risk memo (K11).
- Retirement's `funding` comes from the same `funding_summary` `/plan` shows, so the Plan funding stack and the retirement corpus agree.
- Every simulate-backed memo key carries the Book hash (H5) and the flows' inputs.
- The digest pushes ≤ 3 `now` actions whose `pushed_at` is null, then `mark_pushed` (K7).
- `calibration.coverage(ledger.kpi_snapshots(owner), performance('ALL').series, today)` goes into `/assumptions` only when ALL performance is warm (peek), else `calibration: null`.

**K22. Integrator checks for wave 6.**
1. Full backend pytest, then `npx ng build` and `npm run check`. Confirm the K1 test move landed: the optimizer test is gone from `test_forecast.py` and present in `test_optimizer.py`.
2. Import `simulate`, `forecast`, `goals`, `quant`, `mc`, `signals` and `markets` each in a fresh interpreter (no cycles; G3 holds).
3. **On a fresh copy of the scratchpad database, through the Python modules only:**
   - `project_portfolio` (default and with synthetic SIP plans);
   - `retirement_plan` with a synthetic saved plan: report its time and the new `probability_lasts`, `depletion_age_p10` and status;
   - `stress_test` with β from `quant.portfolio_risk` holdings and a synthetic `plan`;
   - `rebalance_plan` and `suggest` with `txns`/`instruments` on real holdings: the sell order and `tax_total`;
   - `holding_outlook` vs Markets signals on a real symbol with stored history;
   - `calibration.coverage` on synthetic monthly snapshots.
4. **A5 re-measure:** cold and warm `/brief`, `/actions` and `/plan` via the W4-B1 script on a fresh copy, now that retirement runs `simulate`. Report against the 800 ms / 50 ms budgets, with a cost breakdown.
5. **Speed:** `test_simulate`'s timing and the `after_tax` timing as measured. Apply D5 or D18's fallback if missed.
6. **Ledger:** on a copy, 006 applies once; a failing CSV and a failing CAS commit write nothing (counts before and after).
7. **The `/markets` banner** on the mocked API for correction and crash; its sentence matches `markets.context_line` for the same `market_state`.

### W6-B5 builder decisions (one signal vocabulary)

- **RSI warm-up (amends K16's "None with n or fewer changes").** `signals.rsi` returns None with **n or fewer closes** (fewer than n changes), the rule the old `quant.rsi` used. The published StockCharts worksheet reads its first RSI (70.53) on the 15th close, from exactly 14 changes, so K16's wording and its own acceptance example could not both hold; the example wins. The worksheet's closes are the 4-dp ones (44.3389, 44.0902, …); with the 2-dp closes the first value is 70.46, outside 0.05. `test_markets.py` pins all 19 published values within 0.05 and a plain second implementation to 1e-9.
- **`quant` imports `signals` by its absolute name** (`from tracker.analytics import signals as sg`). `test_risk.py::test_quant_imports_only_domain_and_assumptions_from_the_package` (no wave-6 owner) still pins quant's *relative* imports to `{domain, assumptions}`, and K1 says the engine adjusts, never the test. G3's intent (no cycle) holds: `signals` imports nothing from the package. `test_markets.py` pins the full picture: relative `{domain, assumptions}` plus absolute `{tracker.analytics.signals}`, and `signals` with no package imports at all. **W7-B1 or the integrator** should add `signals` to the `test_risk.py` pin and switch quant to `from . import signals as sg`.
- **`signals.trend` returns the whole outlook trend block:** `{key, label, reconciled, sma50, sma200, above_50, above_200}` (SMAs to 4 dp, as before). `reconciled` is always present (False when the averages and the signals agree), so W6-F1 can read it without a null check. `holding_outlook['trend']` is that dict. It accepts signal keys or described signals.
- **Notes when reconciled:** "Above its long averages but falling over the past month: no clear trend." (the averages said up, `above_50` true) or "Below its long averages but rising over the past month: no clear trend." It replaces the up/down note; the RSI, 52-week, regime and beta notes are unchanged.
- **`signals.pct_text`** is the moved `markets._pct` (describe needs it); `markets._pct` is now an alias, so `holding_alerts` is unchanged. `markets` also re-exports `WEEK` and `MONTH` (used by `market_state` and `metrics`). `markets.metrics` takes `w1`/`m1` from `signals.windows(series)` after the live-quote overlay.
- **`read(vals)['rsi']`** is rounded to 1 dp (payload-ready). `holding_outlook` keeps thresholding its RSI notes on the unrounded value, as before.
- **Checked on a DB copy** (Python modules only): every one of 231 stored price series with ≥ 30 closes gives outlook signals equal to the Markets signals from `metrics`, 2 have a reconciled trend, and none reads up while `momentum_sell` fires.

### W6-B1 builder decisions (ledger P2)

- **Paging parameters.** `page` and `size` that are not whole numbers (`"x"`, `1.5`) raise `ValidationError` (400 on the route); whole numbers out of range are clamped (size 10–200, page ≥ 1) as K4 says. An empty `?page=` means page 1. `pages` is `max(1, ceil(total / size))`, so an empty list is "page 1 of 1". `sums.count` and `months[].count` count every filtered row, including types on neither K4 list (BONUS, SPLIT); only out and in amounts are summed by the K4 lists. Money is rounded to 2 dp.
- **`Ledger.transaction_rows(scope, filters)`** is the one builder of today's `GET /transactions` items (newest first). The unpaged route and `transactions_page` both use it, so the two shapes cannot drift. `instrument_id` filters compare as strings, so an int or a query string both work.
- **`bulk_add` additions (all additive).** A `new_instrument` gets `price_source` from its `symbol` as `create_instrument` does (`amfi` for `AMFI:`, else `yahoo`), and a missing name raises `ValidationError` instead of `KeyError`. Bulk instrument writes (`new_instrument` and `field_updates`) may also set `last_price_at` (`BULK_INSTRUMENT_FIELDS`), so an NPS NAV from a CAS is stamped exactly as `update_instrument` stamps a hand-typed price (`price_source` `manual`). `"txns": []` adds an instrument with no transaction (a new NPS scheme with no units).
- **CSV end-state check is relative to what is stored.** An existing holding that is already short (legacy data) does not block an import that leaves it no worse; the import fails only when it adds unmatched units. The failing row is the first new sale (in date order, BUYs first on a day) at which the unmatched units rise. The CAS check keeps today's absolute rule, counting what the same import already plans for that holding.
- **CSV results keep `id`.** After the single write, the new transaction ids are read back (`id >` the max before, owner, `source = 'import:csv'`) and attached in statement order when the counts match; otherwise `id` is left out.
- **CAS details.** A matched NPS row without a NAV is reported ok with nothing updated (it used to null the price). A fund planned as new with no new transactions no longer creates an empty holding. Two funds in one CAS that resolve to the same holding share one plan, so the second is deduplicated against the first.
- **A pushed notice that is later seen is closed.** `mark_pushed` inserts any missing id as `open` (K7). `mark_seen` on a `notice:` row that a push created (status `open`, `seen_at` NULL) also sets status `done` and `done_via 'seen'`, so every seen notice row ends `done` with `tier_first` NULL. Neither helper touches `updated_at` on an existing row.
- **`kpi_snapshots`** skips rows whose `data` is not a JSON object (undecodable text or a list), as well as malformed JSON.

### W6-B3 builder decisions (tax-aware rebalancing, linked SIPs)

- **`plan_sales` picks one at a time.** Before each pick, every remaining candidate is reclassified by the FIFO sale of min(amount still to free, its sellable value), so a holding that would be a loss or an exempt long-term gain for a smaller sale is ranked on the sale it would actually make. A holding is sold in one leg at most. "Sellable" is the FIFO prefix of open lots before the first ELSS-locked lot, the same rule `harvest_plan` uses. When the whole sellable value is needed, the exact units are sold with no rounding. Otherwise units are rounded down (whole shares for `asset_class == equity`, including US stocks; 0.001 units for the rest).
- **Minimum tail sale.** After a leg's first sell, the leg stops when less than ₹500 is left to free (`tax.PLAN_MIN_SELL`), so whole-share rounding never adds a token sale of another holding. The first sell of a leg has no minimum. `covered` reports what the sells free.
- **`order` on a sell is its class** (`loss`, `lt_exempt` or `other`). The list order is the pick order. The exemption still left across legs starts at compute_tax's remaining exemption and drops by each sell's own `exemption_used` (from `what_if_sale`).
- **`plan_sales` note.** The exemption figure comes from `exemption_for(fy)` (₹1.25 L from FY2024-25, ₹1 L before). `tax_total` can be negative when losses offset gains already booked this FY. As with `what_if_sale`, that is tax saved.
- **`rebalance_plan` locks EPF and NPS only where they would sell.** An over-target EPF or NPS row becomes `hold`, `amount` 0, `locked: true`. An under-target one keeps its `buy` (contributions are how those grow), and the no-sell plan already buys them. FD and P2P under target also keep `buy`.
- **Buys are funded by what is actually freed.** With the tax inputs, the money freed is Σ `covered` (what `plan_sales` could really sell, after rounding, ELSS locks and unpriced holdings), not Σ sell `amount`. Without them, it is Σ sell `amount`. The sell row keeps `amount` (the trim toward target) and gains `covered`. `after_pct` uses `covered`. A buy scaled to ₹0.50 or less becomes `hold`. `not_sold` is always present on an allow_sell plan (0 when nothing is held back).
- **Missing `slab_rate`.** `rebalance_plan` and `suggest` default it to 30%, `what_if_sale`'s default, when the ledger is passed without a slab. W7-B1 passes `taxSlabRate`.
- **`suggest`.** `let_mature` replaces only what would have been `trim`: an FD or P2P row inside the 1.5-point hold band stays `hold`. `turnover` keeps its formula (Σ |delta| / 2) over rows that are neither locked nor `let_mature`. `tax_if_sold` sits only on `trim` rows. Trim legs go to `plan_sales` largest first. The note's last clause reads "trims carry an estimated tax if sold, lowest tax first; exit loads are not included." when the ledger is passed, and "taxes and exit loads are not included." otherwise. `KEEP_SHARE` and `MATURITY_ONLY` join `__all__`; `_CORR_ROWS` and the unused `CORR` import are gone.
- **`project_goal` linked SIPs** reuse `plans._monthly_equiv` and `plans._freq`, the exact `monthly_sip_total` rule, and are exposed as `goals.linked_contribution`. Every linked plan is listed, and one that is not running has `monthly_equiv` 0. `linked_sips: []`, `linked_monthly: 0` and `contribution_source: 'goal'` are always present, so the payload shape does not depend on links. `goals.py` imports `plans` and `tax` at module top (both import only `domain`/`portfolio`, so no cycle), and still imports `mc` only inside `project_goal` (G3).
- **Checked on a DB copy** (Python modules only, synthetic equal targets): the allow_sell plan sells 4 loss-making Indian stocks before one small short-term gain, 3 US losses and 1 fund loss. The US leg covers ₹7,387 of ₹9,144 because the remaining US stocks are worth more than the rest of the leg in whole shares. `tax_total` is −₹4,135 (losses against this FY's booked gains), and buys are scaled to the ₹67,573 freed. `rebalance_plan` takes 4 ms and `suggest` with the ledger 36 ms. `current.vol_pct` is the same with and without the tax inputs.

### W6-B2 builder decisions (simulate, projection, retirement and stress on the plan engine)

- **Routing and the glide are decided on the deterministic path of each layer, not of the whole.** A run has a state layer (positions and ladders) and a flows layer (SIPs). FD and P2P routing (targets, the 10% re-lend cap) is decided on the state layer's no-shock path. The glide's yearly trim is a *fraction* of each equity key, fixed on each layer's own no-shock path, and each layer glides from its own starting equity share. The fraction is scale-invariant, so doubling the flows doubles their layer exactly. That is what makes K8's linearity test hold with ladders, targets and the glide on, and what makes K10's required SIP exact: the probability at `required_sip` is ≥ 75 on a re-run, and < 75 at ₹100 less (tested). Cost: the glide does not see that a SIP-heavy plan raises the state's equity share; each layer is trimmed only by its own excess. After withdrawals start, the same fractions apply. Pro-rata withdrawals leave the shares unchanged, so the no-shock fractions stay valid.
- **The EPF helper lives in `simulate.py`.** K8 puts "one shared helper in `forecast.py`", but `simulate` may not import `forecast` (K8). `simulate.epf_monthly_average(txns, today)` is the extracted H16 rule. `cash_flow_forecast` calls it, and `forecast.epf_monthly_average` re-exports the same object (tested), so the two still cannot differ.
- **Three keyword arguments beyond the K8 contract,** all keyword-only and defaulted:
  - `lump_flow(..., weights=None)`: K9's split "by the plans' monthly equivalents".
  - `run(..., keep_paths=False)` returns `paths` {month: {total, state[, probe]}} in simulation order. The linearity test and K10's per-path A_i/B_i need pairing that sorted `at` lists lose.
  - `run(..., probe=None)`: ₹1-a-month flows grown on the same draws, never in the totals, tracked only up to the last sample month. Retirement reads B_i from it instead of a second run (about 190 ms saved).
  - Flows may also carry `goal_only: True` (goal value only, not the totals). `stress_test` also takes keyword-only `today=None` so `plan_impact`'s goal months are testable.
- **Step resolution (D18).** Goal months, sample months and glide year-ends that fall between boundaries are read at the first boundary at or after them. The grid is never bent to them, so CRN across horizons and key sets holds.
- **Ladders, filling gaps the spec leaves.**
  - A segment-only port (no positions) becomes one pseudo-position per segment. Its FD accrues at the Book rate with no maturity; P2P without a schedule is a pool at the Book's net P2P μ.
  - P2P money re-lent under the cap joins that pool.
  - Flows into FD, P2P or EPF go to deterministic pools at those rates.
  - The A28 matured-unrecorded FD moves at t = 0 to the target destination, or MF_DEBT when that destination would be a ladder.
  - A defaulted loan is held at its value until withdrawals start, then written off: it is never released, and a retiree cannot spend it.
  - EPF interest is accrued monthly and credited in March. The reported value is balance + accrued, so the credit is a book entry. EPF is never netted for tax.
  - At `start_month` the 60% NPS lump sum joins MF_DEBT, like EPF.
- **`probability` is measured before the NPS carve-out.** It compares the money at the retirement month (EPF included, NPS whole) with `corpus_needed`, so it is the same linear quantity the required SIP inverts. The annuity offset affects only `probability_lasts`. A 6% annuity bought out of a corpus that typically earns about 8% can deplete sooner than keeping the money invested. That is real, and the tests pin the offset against a carve-out with no income, not against no annuity.
- **`funding` (K10).** `funding.free` already counts EPF and NPS when no goal claims them. So the free share of the other money is free − EPF − NPS, floored at 0 and capped at the other money. `sources.excluded` is the rest. Every non-EPF/NPS position (value, cost, invested, outstanding, maturity value) is scaled by that share. With `sims=0`, `required_sip` falls back to `mc.required_sip_for`, so the Plan SIP block keeps a figure.
- **Calibration (K9) in retirement and the empty case.** Retirement applies the same δ/s calibration to its (μ*, σ*), which is how the record blend and `return_pct` still move its probabilities (`test_api::test_brief_retirement_picks_up_a_warm_performance` stays green). An empty portfolio calibrates against `NO_HOLDINGS_MIX` (all Mutual Funds), so a return override still applies to its flows. The projection payload adds `calibration` {delta_pct, vol_scale}. `max_drawdown_p50` is a positive percent, the typical worst fall from a peak at step boundaries, flows included.
- **Stress (K11).**
  - Recovery compounds each key at its own Book typical return. The SIP compounds at the after-shock mix's blended typical rate and is added at month end.
  - A holding whose β the risk payload keys as a string still matches.
  - `plan_impact` reads the goal rows' `monthly_contribution` as goal-only flows when no SIP is linked (`goal_id`). Otherwise a goal's "before" would ignore the money it is promised and disagree with the Goals page.
  - The baseline run is shared by every falling scenario: 1 + up to 6 runs of 500.
- **Measured** (this machine, Python 3.12):
  - `test_simulate` budget fixture (136 steps × 1,000 sims, six keys, 2 FDs, P2P, EPF, 3 plans): 0.33–0.36 s, and 0.33–0.37 s with `after_tax`. Both are inside the 1.0 s target, so neither D18's 600-sim fallback nor D5's cut applies.
  - On a fresh copy of the scratchpad DB (168 positions, synthetic saved plan 35→55, ₹80k a month): cold `Services.retirement` (the `/brief` path, incl. the portfolio build) took 346 ms, warm 1.5 ms, and the engine alone 325 ms. Probability is 0.0, `probability_lasts` 0.0, `depletion_age_p10` 55 and status off_track. `required_sip` is ₹1,43,863 (typical ₹1,07,252), and the probability at it is 75.0, against 74.9 at ₹100 less.
  - `project_portfolio`: 102 ms default, 117 ms with synthetic plans. `stress_test` with 28 β and a synthetic plan: 793 ms, against 1 ms without a plan.
  - For K22's A5 re-measure: retirement now costs about 0.3 s of the 800 ms cold `/brief` budget.
- **Tests.** The K1 move is done: `test_forecast.py::test_optimizer_respects_caps_floors_and_locked_segments` is deleted. The D3 (a) and (b) retirement tests are replaced by the exact K10 check, parametrised over step-up and a zero SIP. Stress recovery now expects per-key typical compounding. The full backend suite passed (628) at the time of writing.

### W6-B6 builder decisions (calibration evaluator, festivals file)
- **`calibration.coverage` rows hold matured snapshots only.** A month whose snapshot has not matured, or lacks an index point within 7 days of d or d + 365, is left out of `rows`, `matured` and `inside` alike, so `rows` is the evaluation table and `matured == len(rows)`. `realised` is rounded to 4 dp for display; `inside` compares the unrounded ratio. A projection_1y with a missing, non-numeric or non-positive pX counts as no projection (that month falls back to its next snapshot). Index points ≤ 0 are dropped; on a duplicate date the first given is kept. `today` may be a date or ISO string; anything else raises `ValueError`.
- **Festivals loader is all-or-nothing.** `calendar.load_festivals(path=FESTIVALS_FILE)` returns `[]` with a printed warning for a missing file, bad JSON, a wrong shape, or any entry without an ISO date and non-empty key, name and kind strings. One bad row empties the list rather than silently dropping a date; the yearly expiry test then fails loudly. The list is sorted by date.
- **One line in `build_calendar` changed (the festive theme).** It used `next(...)`, the first listed occurrence of each festival key, which with several years in the file would only ever see 2026's Diwali. It now tests every occurrence with `any(...)`. With one date per key this is the same result, and `test_calendar.py::test_build_calendar_unchanged_by_the_file` pins that the loaded file gives exactly the old output wherever the new dates are out of reach. Event keys, kinds, titles, notes and links are unchanged (`test_links.py` untouched).
- **Dates added** (New Delhi, Drik Panchang, cross-checked against Dekho Panchang, and Shreekundli for 2028 Dhanteras): Dhanteras 2027-10-27, Diwali 2027-10-29, Akshaya Tritiya 2028-04-27, Dhanteras 2028-10-15, Diwali 2028-10-17. The three earlier dates are kept unchanged. The test now expires in the second half of April 2028 (180 days before 2028-10-17).

### W6-F2 builder decisions (P2 frontend types and API methods)

- **Everything is optional, including `SipPlan.goal_id`.** K19 writes `goal_id: number | null`; it is typed `goal_id?: number | null`, because a wave-5 server and any `Partial<SipPlan>` literal must still type. `NotificationsResponse.unread` is optional for the same reason (W7-B1 always sends it). No consumer was edited; `npx ng build` and `npm run check` are green.
- **`SaleLeg` is one sale inside a leg**, the `tax.plan_sales` sell item {instrument_id, name, qty, proceeds, gain, st_gain, lt_gain, tax, order: 'loss' | 'lt_exempt' | 'other'}, which is what `RebalanceRow.sells` and `OptimizerRow.sells` carry.
- **Fields the wave-6 engines send beyond the K19 list are typed too (optional):** `RebalanceRow.covered` (W6-B3), `Projection.calibration` {delta_pct, vol_scale}, and `RetirementPlan.annuity` {share, rate, income_p50?} and `engine` (W6-B2). `StressHolding` and `RetirementSources` are named types.
- **`PlanSensitivity.change` is a number (binding for W7-B1):** the change in the key's own unit, ₹ a month for `sip`, years for `retire`, points for `returns` and `inflation` (so −1 for returns). `label` carries the words ("SIP +₹5,000/month").
- **`PlanCompare.honesty`** is typed like `AssumptionsView.honesty` (`Partial<ProjectionHonesty> & Record<string, string>`), and `PlanCompareRequest` = {scenarios: (number | PlanScenario)[]}.
- **Booleans go on the wire as `1`.** `forecast({..., after_tax: true})` sends `after_tax=1` and `plan({detail: true})` sends `detail=1`; false or absent sends nothing, so `plan()` and every existing `forecast(...)` call make the same request as before. `transactionsPage(p)` always sends `page`, trims `q` and drops empty filters.
- **`Settings.assumptions`** is `AssumptionOverrides` {segments?: {key: {return_pct, vol_pct}}, inflation_pct?}. No `seenNotices` (D15) and no theme types (D10).
- **`OptimizerRow.action` gains `'let_mature'`.** No consumer switches on it today (only the type is referenced); `RebalanceRow.action` is unchanged.
- Mocked-UI checks of these shapes still need `npx ng build --configuration development` (the default build points at the hosted API).

### W6-F1 builder decisions (Markets banner, shared chips, outlook card)

- **Banner shape.** `section.card.verdict.mkt-banner[data-status=watch][role=status]#market-state`, reusing the global `.verdict` stripe; the extra rules live in the component (H19, `styles.scss` untouched). Head: h2 "The market is in a correction" / "The market has fallen sharply" plus `app-status` watch ("Watch"). Then line 1, the playbook `ul`, and a foot with the muted source line and "Your performance →" (`/performance`). It renders only when the payload is on screen, so the loading, error and stale states are unchanged; a stale snapshot shows its own `as_of`.
- **Phones (§1.5).** At ≤ 760 px the five playbook lines wait behind one toggle ("The calm playbook · 5 steps", `aria-expanded`), so T0 starts within the first screen (the banner is ~264 px tall at 390 px). Desktop always shows the list.
- **Parity helpers in `market-parts.ts`:** `marketBannerMode(state)`, `marketBannerText(state)`, `marketInr(v)` (= `markets._inr_compact`) and `marketBannerSource(state)`. Python's `:.0f`/`:.1f`/`:.2f` round an exact binary tie half to even while `toFixed` rounds it up (12.5 → "12" vs "13"; ₹3.25 L → "3.2" vs "3.3"), so a private `pyFixed` sends ties to the even neighbour. Checked against `markets.context_line` on 419 synthetic states (every comparison word, the peak, unknown `you`, the stand-in comparable, ties, normal/volatile/null): 0 mismatches. The parity script lives in the builder's scratchpad; the repo has no frontend spec runner (`npm run check` excludes `*.spec.ts`).
- **Line 1 breaks where the backend's text has spaces** ("₹24.5 / L" can wrap at 390 px). No non-breaking space is inserted, because the banner must equal `context_line` byte for byte (K22.7).
- **Hero class collision fixed.** The Markets T0 verdict span was `class="meta verdict"`, which now picks up the global T1 `.verdict` rule (4 px stripe, 132 px min-height) and stretched the hero. It is renamed `.hero-verdict`; no other change to T0.
- **Outlook card.** `OutlookWithSignals = Outlook & {signals?: LabelledSignal[] | null; trend?: … & {reconciled?: boolean}}` and `LabelledSignal = Signal & {label?: string}` (exported from `market-parts.ts`) stand in until W6-F2's types are used; both are compatible with them. `o.signals` present (even `[]`, shown as "No signal") wins over the Markets snapshot row. The Trend badge always has a title: "Long averages and the past month disagree" when `reconciled`, else "Price against its 50- and 200-day averages" (pure `outlookTrendTitle`).

---

### W6 integrator decisions

These bind wave 7 like K1–K22.

- **L1. quant imports `signals` relatively.** `quant.py` uses `from . import signals as sg`. The G3 pin in `test_risk.py::test_quant_imports_only_domain_and_assumptions_from_the_package` now expects exactly `{domain, assumptions, signals}`, and `test_markets.py::test_signals_is_a_leaf_and_quant_reaches_only_it` expects that same relative set plus no absolute `tracker.*` imports. `signals` stays a leaf that imports nothing from the package, so G3's no-cycle rule holds. This replaces W6-B5's interim absolute import.
- **L2. A refused import names its first bad row.** The CSV and CAS commits now return 400 `{error, results}` (K5). Until W7-F7 shows the whole results list, the shared `errorMessage` (`core/http.ts`) adds the first row with `ok: false` to the text: "{error}. First: {name} ({date}): {row error}". This applies to any 400 whose body carries `results`; no other route sends one.
- **L3. The Redirect maturities badge reads `let_mature`.** Under K13 an over-target FD or P2P row comes as `hold` with `let_mature` instead of `sell`. `rebalance-planner.component.ts` treats `let_mature > 0` as "Redirect maturities". Its older checks stay as fallbacks: `sell`, or `hold` more than 0.5 points over target.
- **Wave-7 routes the frontend already types.** `api.notificationsSeen` (POST `/notifications/seen`) and `api.planCompare` (POST `/plan/compare`) have no backend route yet. Nothing calls them; W7-B1 adds both routes (K19). Every other method in `api.service.ts` has a served route with the same HTTP method.

### W6 review fixes

These bind wave 7 like K1–K22 and L1–L3.

- **L4. The return reported is the return simulated (amends K9 "the `assumptions` block still reports (μ*, σ*)" and K10's `inputs.return_pct`).** δ's ±5-point cap (and δ = 0 when under 5% of the money is market-linked) means a higher return override, or a strong record blend, can stop moving the simulation. `forecast._simulated_mu` gives μ_sim = `mu_sigma(weights, cal_book)`, the mix's return over the calibrated Book. It equals μ* whenever the calibration reaches it (to 0.005 points).
  - `project_portfolio`: `assumptions.return_pct` and `typical_pct` use μ_sim; σ is still σ*. The block gains `requested_return_pct` (μ*) and `return_note` (null unless the two differ: "Your 20% a year was limited to 12.00% for the simulation: …", or "The X% a year your record points to …" without an override).
  - `retirement_plan`: one μ for the whole payload. `projected`, `gap`, `path`, `runs_out_at`, `fire`, the coast amount and the `sims=0` required-SIP fallback all use μ_sim, so the deterministic figures and the chances describe the same assumption. `inputs` and `assumptions` gain the same two fields, and the block basis reads "your return of 20% (limited); …".
  - The Plan Overview Assumptions card shows `return_note` under the list. The retirement planner's verdict sentence appends it. Both are typed as optional in `models.ts`.
  - The `/plan` and `/assumptions` chips still show the blended μ*, so they can differ from a forecast block only when `return_note` is set, and the note says why. Pinned in `test_forecast.py::test_a_capped_return_is_reported_as_the_return_simulated`. `test_projection_is_a_thin_wrapper_over_simulate` now expects 13.75 (requested 14).
- **L5. One SIP basis per payload (K9's rule, now also retirement's and `plan_impact`'s).** `retirement_plan(..., sips=)` uses the plans (each on its own dates and class) only when `params` has no `monthly_sip` (absent, None or ""). Otherwise it uses `monthly_sip` with `step_up_pct`, as one lump split by the plans' monthly equivalents when `sips` is given, so `sips=[]` no longer zeroes a typed SIP in the simulation alone.
  - With the plans, the deterministic `projected`, `gap`, `path` and `fire` compound `monthly_sip_total(sips, today)` with the params' step-up. Plans' own step-ups and not-yet-started plans move only the simulation; that approximation is the same one the projection's reported `monthly_sip` makes.
  - The payload adds `flows_basis` ('plans' | 'input'), and `inputs.monthly_sip` is the amount used.
  - `stress_test`'s `plan_impact` follows the same rule on `plan.retirement.monthly_sip`. With no retirement plan, or one without a SIP, it uses the plans when `sips` is given, else `monthly_sip`.
  - **Binding for W7-B1:** pass the saved `retirementPlan` params *unmerged* (not filled from `RETIREMENT_DEFAULTS`) to `retirement_plan` and as `plan.retirement`, together with `sips=ledger.sips`. A merged `monthly_sip: 0.0` would always beat the plans. A user who wants the plans leaves the planner's SIP field blank.
  - Pinned in `test_retirement_uses_one_sip_basis_for_the_whole_payload` and `test_stress_plan_impact_lets_a_typed_retirement_sip_win_over_the_plans`.
- **The bulk_add rollback test fails inside `db.batch`.** `test_ledger_p2.py::test_bulk_add_rolls_back_when_sql_fails_partway_through_the_batch` adds a SQLite trigger that aborts the batch's last statement, an instrument status update. By then the batch has already run a delete, an update, a new instrument, a transaction into it, a transaction for an existing instrument and a field update. The test asserts that the transactions, instruments and cash movements are unchanged, row for row. With `SqliteDatabase.batch` forced non-atomic, the test fails, while the earlier pre-batch validation test still passes.

---

## Wave 7

Prepared against the working tree after wave 6 landed (backend pytest 650 passed; `npx ng build` and `npm run check` green). Decisions R1–R24 bind wave 7. They add to Parts A–D, E1–E20, G1–G16, H1–H20, J1–J20, K1–K22 and L1–L5. Where they differ from WAVES.md, waves.json or SPEC.md, they win. (The letter R is used because M, N, P and Q already name critique items, priority tiers and ladder questions.)

### Ownership and parallel safety

**R1. The wave-7 task list differs from WAVES.md as follows.**
- **W7-B1 is split in two.** WAVES' W7-B1 was too big for one builder, and its pieces meet in `services.py` and `analytics_api.py`. The split runs along those files, so the two halves never call each other's new code.
  - **W7-B1** (plan wiring) owns `services.py`, `forecast_api.py` and the engines it has to wire (`forecast.py`, `goals.py`, `optimizer.py`), plus a new pure `analytics/scenarios.py`. It does all of K2 (A1), L5, compare and sensitivities, calibration in `/assumptions`, `after_tax`, `/sips` history, the base Book through the engines, and the per-member *read* path.
  - **New W7-B2** (settings, notifications and digest) owns `analytics_api.py`, `markets_api.py`, `ledger.py`, `push.py`, `__init__.py`, `assumptions.py`, `signals.py`, a new composition module `tracker/notices.py` and a new workflow file. It does the notification routes, the daily digest, the P2 settings validation, `effective_book` overrides, the per-member *write* path and `GET /settings` meta.
- **W7-F1 keeps a11y, the bell and the banner** (A2, D10, D20). It also owns `core/notify.service.ts`, which the bell needs, and it takes the `styles.scss` carry-overs from J19 and the W5 integrator. The types and API methods were built by W6-F2. W7-F1 may still add *optional* fields to `models.ts` (R20), but no sibling may depend on them.
- **W7-F2 also owns `features/plan/projection.component.ts`** (the D5 after-tax toggle sits on the Plan fan) and `goals.component.html` (A3).
- **W7-F3 also owns `features/risk/allocation-lab.component.ts`**, where the target-mix editor and "Preview impact" live, and `shared/rebalance-planner.component.ts`, where the tax-ordered trims are drawn. W7-F4 and W7-F5 use the planner unchanged.
- **W7-F7 also owns `shared/txn-form.component.{ts,html}`**, which is the Add sheet. J19's "Import a statement" tile lands there.
- **Dark mode stays cut (D10).** There is no theme storage, no dark tokens and no `#appearance`. P2.9 is "a11y" only.
- **File lists (disjoint):**

| Task | Files |
|---|---|
| W7-B1 | `backend/tracker/services.py`, `backend/tracker/api/forecast_api.py`, `backend/tracker/analytics/forecast.py`, `backend/tracker/analytics/goals.py`, `backend/tracker/analytics/optimizer.py`, new `backend/tracker/analytics/scenarios.py`, new `backend/tests/test_scenarios.py`, new `backend/tests/test_p2_api.py`, `backend/tests/test_forecast.py`, `backend/tests/test_goals.py`, `backend/tests/test_optimizer.py`, `backend/tests/test_p1_api.py`, `backend/tests/test_risk.py` |
| W7-B2 | `backend/tracker/api/analytics_api.py`, `backend/tracker/api/markets_api.py`, new `backend/tracker/notices.py`, `backend/tracker/ledger.py`, `backend/tracker/push.py`, `backend/tracker/__init__.py`, `backend/tracker/analytics/assumptions.py`, `backend/tracker/analytics/signals.py`, new `.github/workflows/daily-digest.yml`, `backend/tests/test_api.py`, `backend/tests/test_assumptions.py`, `backend/tests/test_markets.py`, new `backend/tests/test_notifications.py`, new `backend/tests/test_settings_p2.py` |
| W7-F1 | `frontend/src/app/core/models.ts`, `frontend/src/app/core/api.service.ts`, `frontend/src/app/core/notify.service.ts`, `frontend/src/styles.scss`, `frontend/src/app/layout/shell.component.{ts,html,scss}`, `frontend/src/app/shared/ui.ts` |
| W7-F2 | `frontend/src/app/features/plan/plan.component.ts`, `plan-overview.component.ts`, `retirement-planner.component.ts`, `goals.component.{ts,html}`, `projection.component.ts`, new `scenarios.component.ts` (all under `features/plan/`) |
| W7-F3 | `frontend/src/app/features/risk/risk-mix.component.ts`, `stress.component.ts`, `allocation-lab.component.ts`, `frontend/src/app/shared/rebalance-planner.component.ts` |
| W7-F4 | `frontend/src/app/features/actions/actions.component.{ts,html,scss}`, new `frontend/src/app/features/actions/review.component.ts` |
| W7-F5 | `frontend/src/app/features/recurring/recurring.component.ts`, `frontend/src/app/features/recurring/sip-plans.component.ts` |
| W7-F6 | `frontend/src/app/features/settings/settings.component.{ts,html}` |
| W7-F7 | `frontend/src/app/features/transactions/transactions.component.{ts,html}`, `frontend/src/app/features/import/import.component.ts`, `epf-import.component.ts`, `tradebook-import.component.ts`, new `frontend/src/app/shared/drop-zone.component.ts`, `frontend/src/app/shared/txn-form.component.{ts,html}` |

- **Owned by no wave-7 task** (must keep passing or compiling; never edited):
  - Backend: `actions.py`, `brief.py`, `insights.py`, `plans.py`, `mc.py`, `quant.py`, `simulate.py`, `calibration.py`, `calendar.py`, `tax.py`, `markets.py`, `prices.py`, `history.py`, `portfolio.py`, `story.py`, `migrations.py`, `security.py`, `api/ledger_api.py`, and every test file not listed above (`test_brief.py`, `test_actions.py`, `test_wave1_contracts.py`, `test_simulate.py`, `test_ledger_p2.py`, `test_calendar.py`, `test_calibration.py`, `test_links.py`, `test_insights.py`, `test_plans.py`, `test_mc.py`, `test_tax_whatif.py`, `test_analytics.py`, `test_epf_import.py`, `test_migration.py`).
  - Frontend: everything not listed above. That includes `line-chart`, `bar-chart`, `action-card`, `assumption-chip`, `what-if-sale`, `core/action.service.ts`, `core/store.service.ts` and `core/http.ts`.
- **Acceptance never depends on a sibling (A2).**
  - Backend: `cd backend && PYTHONIOENCODING=utf-8 python -m pytest -q` (the full suite) plus the task's own tests.
  - Frontend: `cd frontend && npx ng build && npm run check`, plus manual checks on a mocked API. Use a development build (`--configuration development`), a fake token and synthetic payloads in the R-shapes below. Never use the real server, database or tokens.
  - A frontend page reads any field a sibling adds through a local intersection type (the W6-F1 pattern), or sends a body through the public `api.get/post` (E2). It never waits for W7-F1's `models.ts` edits.
  - Cross-task checks are the integrator's (R24).

**R2. Two rules exist twice during the build; the integrator merges them.**
- **The per-member settings rule (R11).** W7-B1 writes it as `Services.settings_who()`. W7-B2 writes the same three lines as `_settings_who()` in `analytics_api.py`, because it cannot call W7-B1's method.
- **The scenario validation (R5).** W7-B1 writes `scenarios.validate_scenario(raw, *, partial=False)`. W7-B2 writes `_plan_scenarios(value)` in `analytics_api.py`.
- Both pairs follow the R5 and R11 text exactly and are tested on the fixtures listed there.
- **After both land, the integrator:**
  - replaces `_settings_who()` with `S().settings_who()`;
  - makes `_plan_scenarios` call `scenarios.validate_scenario` for each entry;
  - deletes the now-unused `Services.notifications` (R14).

### Plan wiring (W7-B1)

**R3. K2 wiring, all of it (A1, D1, K21, L5).**
- **Forecast.** `Services.forecast` passes `sips=ledger.sips`, `txns`, `instruments`, `targets=settings.targetAllocation`, `after_tax`, `slab_rate=_slab(settings)` and `book` (R4) to `project_portfolio`.
  - When the request names no `sip`, it passes `monthly_sip=None`, so the plans route by class (K9 `flows_basis: 'plans'`). `sip_plans_total` stays in the payload.
  - The memo key adds `after_tax` and the slab, alongside the H5 hash and the flow inputs (K21).
  - `GET /forecast?after_tax=1` fills `end.after_tax` (D5). W6 measured `after_tax` inside budget, so the toggle ships. `GET /plan` takes no `after_tax`: it carries no projection (this narrows D5; K19 already typed only `/forecast`).
- **Retirement (L5, K10, K21).**
  - `Services.retirement` merges the planner's query params over the saved `retirementPlan` and **no longer fills `monthly_sip`**.
  - It passes `sips=ledger.sips`, `txns`, `instruments`, `book`, and `funding` = the same `goals.funding_summary(goals, segments, positions, emergencyFund)` that `/plan` shows.
  - When neither the params nor the saved plan name `inflation_pct`, it passes the Book's `inflation_pct` (R4). With no override this is the 6% default, so results do not change.
  - The memo key adds `emergencyFund` and the plans' monthly total.
  - Every caller uses this one path: `/brief` and `/actions` (`build_history=False`), `/plan`, and `GET /forecast/retirement`. So the Plan row, the brief and the planner page show one probability.
- **Stress (K11).**
  - `Services.stress` (used by brief, actions, market_state and Risk T0) passes `betas` only when the risk memo is warm (`_peek('risk', scope, today, hash)`), with `risk_ready` in its memo key, the same pattern as perf_ready. It never passes `plan`.
  - New `Services.stress_detail(scope, settings)` serves `GET /forecast/stress`. It adds `plan` = {`retirement`: the saved params unmerged, or None; `goals`: the context goal rows}, plus `sips`, `txns`, `instruments` and `today`. Its memo key includes the plan's hash (retirementPlan, goal ids, targets, dates and monthly contributions, and the plans' total).
  - `betas` = {`id`: `beta`} from `risk.holdings[]` (the rows carry `id`, not `instrument_id`). They are never built here.
- **Goals (K15).** `_project_goals` passes `linked_sips` = the plan rows with `goal_id == goal.id`, plus `book` (R4).
- **Rebalance (K13).** `Services.rebalance` passes `port`, `txns`, `instruments`, `slab_rate`, `today` and the saved targets. It does this only when `allow_sell`; the no-sell plan stays byte-identical. `net=deploy` netting is unchanged and is applied before the tax legs.
- **Optimizer (K14).** `Services.optimizer` passes `txns`, `instruments`, `slab_rate`, `today` and `book`. Its memo key becomes ('optimizer', scope, profile, slab, today, hash). The risk memo key gains the hash, and so does the outlook memo key.
- **Calibration (K17, K21).** `assumptions_view` adds `calibration`. It is `calibration.coverage(ledger.kpi_snapshots(snapshot_owner), performance ALL series, today)` only when the ALL performance is warm (`_peek`), else null. `perf_ready` joins its memo key.
- **`/sips` history (new).** `GET /sips` adds `history` = [{`month` 'YYYY-MM', `planned`, `invested`}] for the last 12 calendar months, oldest first. It is the sum over plans of `plans.sip_adherence(months=12)`'s instalments due in that month. `adherence` stays the 6-month block, so the Recurring T0 keeps its "6 months" label. If history fails, it is null.
- **The rule for a broken unowned test:** report it and adjust the wiring, never the test. In particular, `test_api.py::test_brief_retirement_picks_up_a_warm_performance` and the family-switcher test must stay green unedited.

**R4. Editable assumptions through the engines (P2.10; W7-B1 for the engines and wiring, W7-B2 for the Book).**
- **The base Book.** The engines gain keyword-only `book=None`. With None they use today's `effective_book(None)`, so every existing call and test is unchanged. The functions are:
  - `forecast.blended_assumptions`, `project_portfolio`, `retirement_plan`, `stress_test` and `cash_flow_forecast`. `_book_weights` and `_calibrate` read the base Book in place of `effective_book(None)`. `_plan_impact` passes it through.
  - `goals.project_goal`. `funding_summary` reads no μ and is unchanged.
  - `optimizer.suggest`, whose `_DEFAULT_BOOK` is replaced by the argument.
  - `quant.portfolio_risk` and `holding_outlook` already take `book=`.
- **Wiring.** Services passes `book=A.effective_book(settings)` everywhere. Each engine applies `rated_book(positions, book)` itself, as now. `services.book()`'s hash then equals every payload's `assumptions.hash` (H5).
  - That function exists today and ignores its argument, so W7-B1's wiring needs nothing from W7-B2.
  - W7-B1 proves the wiring by monkeypatching `A.effective_book` in its own tests: an overridden Equity (India) μ moves `/forecast` p50, `/plan` goal probability and `/optimizer` `current.return_pct`, and the forecast's `assumptions.hash` equals `/assumptions` `hash`.
- **Inflation.** The Book's `inflation_pct` is the default inflation wherever the user named none: the projection's `real_p50` (`Services._inflation` falls back to it) and retirement (R3).
- **`effective_book(settings)` (W7-B2).** It reads `settings['assumptions']` in the §7.7 shape {`segments`: {key: {`return_pct`, `vol_pct`}}, `inflation_pct`}.
  - Each listed key's row takes both numbers, with `source: 'override'` (the value `models.ts` `AssumptionSegment.source` already documents). `inflation_pct` replaces the default.
  - A missing, null or `{}` value, and any shape without `segments`/`inflation_pct`, means "no overrides". So `test_assumptions.py::test_effective_book_shape_and_hash`'s wrong-shape call still returns the default Book.
  - A P2P `return_pct` is taken as the net return, the same meaning as the Book row.
  - `rated_book` keeps replacing the FD, EPF and P2P **return** with holding rates when such positions exist (`source: 'holding rates'`). An override's `vol_pct` for those keys still applies. W7-F6 shows those return inputs as "from your holdings".
- **Validation (W7-B2).** `assumptions.validate_overrides(value) -> dict | None` raises `ValueError`.
  - `segments` keys must be in `A.KEYS`, `MF_DEBT` included. Each row needs both `return_pct` in −5..25 and `vol_pct` in 0..60, as finite numbers.
  - `inflation_pct` must be in 0..15. Unknown top-level keys are rejected.
  - None or `{}` clears the overrides (stored as `{}`).
  - `PUT /settings/assumptions` turns the ValueError into a 400.
- `HONESTY.signal` is **not** aligned to `SIGNAL_LABEL` (K16 allowed it). `test_assumptions.py` pins the copy, and the two labels name different things: a range versus a pattern.

**R5. Scenarios: the `PlanScenario` contract (§6.10, D14, K19).**
- **Shape:** {`name`, `sip`, `step`, `return`, `retire_age`, `lump_sums`, `inflation_pct`, `mix`}.
- **Saved (`planScenarios`, W7-B2 validates):**
  - a list of ≤ 5;
  - `name`: a trimmed string, 1–40 characters;
  - `sip`: 0–1e8;
  - `step`: 0–50;
  - `return`: null or −10..30;
  - `retire_age`: null or an integer in 15–110;
  - `lump_sums`: ≤ 10 items of {`date` ISO, `amount` 0–1e9};
  - `inflation_pct`: null or 0..15;
  - `mix`: null or {segment ∈ `domain.SEGMENTS`: 0–100}, summing to 100 ± 0.5.
  - Unknown keys are dropped. A wrong type or range is a 400 that names the scenario's index and the field.
- **Inline (in `POST /plan/compare`, W7-B1 validates):** the same rules, but every field is optional, and null or absent means "the baseline's value" (`partial=True`). A missing `name` reads "Scenario {n}".
- **Shared fixtures that both validators must agree on:**
  - accept {`name`: "Retire at 55", `sip`: 60000, `step`: 10, `return`: null, `retire_age`: 55, `lump_sums`: [{`date`: "2030-01-01", `amount`: 500000}], `inflation_pct`: 7, `mix`: null};
  - reject `name` "" or 41 characters, `sip` −1, `step` 51, `return` 31, `retire_age` 14.5, 11 lump sums, a lump amount −1, `inflation_pct` 16, `mix` summing to 99, and `mix` {"Gold": 100};
  - reject 6 saved scenarios.
- **The baseline.** The server builds it from today's plan:
  - `name` "Today's plan";
  - `sip` = the saved `retirementPlan.monthly_sip` when set, else the plans' `monthly_sip_total`;
  - `step` = saved `step_up_pct` or 0;
  - `return` null, `retire_age` = the saved value or null, `lump_sums` [], `inflation_pct` null, `mix` null.
- **A resolved field equal to the baseline's value is "unchanged".** When `sip` and `step` are both unchanged, the column's money flows exactly as the baseline's (the plans, or the typed SIP, by L5). Otherwise the column uses `sip` with `step` as one monthly amount, split by the plans' monthly equivalents (K9 'mix' basis).
  - So `compare([baseline])` and an all-null inline scenario give deltas of exactly 0.

**R6. `POST /plan/compare` (W7-B1; §6.10, §7.2, K19).**
- **Body:** {`scenarios`: (index | inline)[]}. An index is 0-based into `planScenarios`. Out of range, or not an int, is a 400.
- **Limits:** ≤ 4 scenarios, or ≤ 2 for guests, else 400 ("Guests can compare up to 2 scenarios"). Every column runs at 1,000 sims, or 500 for guests. Only the read guard applies; it is not `write_required`.
- **Horizon** H (years) = clamp(max(10, years to the latest `retire_age` across columns when a retirement plan is saved, years to the furthest goal), 1, 40). It is shared by every column.
- **Per column**, all on the baseline's seeds (CRN):
  1. **The projection** is `project_portfolio(years=H, …)` with the column's flows, `return_override` = `return`, the lump sums as extra flows, and `book`, `sips`, `txns`, `instruments` and `targets` as in R3. That gives end p10/p50/p90 and the per-year p50 path.
  2. **Retirement** (only when `retirementPlan` is saved) is `retirement_plan(...)` with the column's `monthly_sip`/`step_up_pct` (or the plans when unchanged), `retire_age`, `inflation_pct`, `return_pct`, lump sums, `funding` and `book`. That gives `probability`, `probability_lasts` and `required_sip`.
  3. **Goals** come from one `simulate.run` with `goals=` specs built as `forecast._plan_impact` builds them (allocation share of each key's starting value; linked SIP flows, else `monthly_contribution` as goal-only flows). When the baseline SIP is > 0, each goal's flows are scaled by column `sip` / baseline `sip`. Return override and mix apply; inflation does not (goal targets are nominal); achieved goals are left out.
- **`mix`.** Today's positions are scaled per segment by mix% / current% (value, cost, invested, outstanding and maturity value, as `forecast._funded_positions` scales). A segment held at 0 with mix > 0 gets one Book-rate pseudo-position. The column's SIP is split by the mix (Mutual Funds split by the current debt share, E16) instead of the plans' weights.
- **Extra engine arguments.** `project_portfolio` and `retirement_plan` gain keyword-only `extra_flows=None` ([{date, amount}]: one-off flows routed like the column's SIP; dates past the horizon are ignored). That is additive, and W7-B1 owns both.
- **Response** (`PlanCompare`, K19, plus two keys):
  - `columns` [baseline name, …];
  - `rows`, in this order, each with `values`/`deltas`; deltas are value − baseline, null where either side is null, 0 in column 0:
    - `p10`, `p50`, `p90` (`inr`, labelled "1-in-10 bad case in {H} yrs", "Typical in {H} yrs", "1-in-10 good case in {H} yrs");
    - then, when retirement is saved: `retire_age` (`age`), `retirement` (`pct`, "Chance of reaching the corpus"), `lasts` (`pct`, "Money lasts to {life_expectancy}") and `needed` (`inr`, "Monthly needed for retirement");
    - then `goal:<id>` (`pct`, the goal name), worst baseline first.
  - `paths` [{name, p50 per year}] and `band` {p10, p90} from the baseline per year; `labels` are the calendar years.
  - `sims`, `assumptions` (the baseline projection's block) and `honesty` (`HONESTY` with p50 formatted).
  - New: **`baseline`** (the resolved PlanScenario) and **`scenarios`** (each column's resolved PlanScenario).
- **Memo key:** ('compare', scope, settings, resolved scenarios, sims, today, hash, perf_ready).
- **Measured, not asserted (A5).** Report the cold and warm time for 4 scenarios on the scratchpad copy with a synthetic saved retirement plan and two goals. The target is ≤ 3 s cold. If it is missed, report the per-step costs; do not cut sims silently.
- **Tests:**
  - compare(baseline) and compare(baseline, all-null inline) give deltas of exactly 0;
  - a higher `sip` gives every `pct` and `inr` row a delta ≥ 0 (CRN);
  - a later `retire_age` gives a retirement delta ≥ 0;
  - a guest is refused 3 scenarios and gets `sims` 500;
  - a bad index gives 400;
  - `mix` equal to the current mix gives deltas of 0 within ₹1 and 0.1 points.

**R7. `GET /plan?detail=1` sensitivities (W7-B1; §6.10, K19, W6-F2).**
- **One compare at 500 sims** (every role) over the baseline plus four inline scenarios:
  - `sip`: `sip` + max(5000, round(0.10 × sip, −3)); `change` is that ₹ figure;
  - `retire`: `retire_age` + 2 (`change` 2). Only with a saved retirement plan; otherwise its `retirement_pts` is null and its scenario is the baseline;
  - `returns`: `return` = the baseline projection's requested return (μ*, `assumptions.requested_return_pct`) − 1, rounded to 0.1 (`change` −1);
  - `inflation`: `inflation_pct` = (saved inflation or the Book's) + 1 (`change` 1).
- **This amends §6.10's "every μ − 1 pt".** The returns change goes through the K9 calibration like any return override: market-linked classes absorb it and ladders keep their rates. So the tile and its "Try it" scenario are the same computation.
- **Each item:** {`key`, `label` ("SIP +₹5,000/month", "Retire 2 years later", "Returns 1 point lower", "Inflation 1 point higher"), `change`, `retirement_pts` (Δ `retirement` row), `worst_goal_pts` (Δ of the goal with the lowest baseline probability; null without goals), `scenario`}.
  - `scenario` is the full resolved PlanScenario, ready to save or compare.
- **Payload.** `/plan?detail=1` = the `/plan` payload plus `sensitivities` and `baseline`. It is memoised separately from `/plan` (which is unchanged), so `/plan` stays fast. Report its cold time.

### Settings, notifications and digest (W7-B2)

**R8. P2 setting keys (§7.7, D14, D15, K19).**
- **Changes to `SETTING_KEYS`:** add `assumptions` (R4) and `planScenarios` (R5). `seenNotices` is **not** added (D15).
- **`marketAlerts`** keeps its rebuilt object and adds `digest: bool` (default false). A PUT without `digest` stores false, so W7-F6 always sends the whole alerts object.
- **`GET /settings`** adds read-only `settings_owner` (the R11 owner) and `inherited`: the setting keys whose value comes from `__global__` because the owner has no row of its own (sorted; [] when the owner is `__global__`). It reads `L().get_settings(*_settings_who())` directly, so W7-B2's tests do not need W7-B1's `Services.settings`.

**R9. Notifications (§8.6, K7, K19, D15; W7-B2 in `tracker/notices.py`).**
- **The function.** `notices.notifications(svc, scope, settings, owner, today=None) -> {items, unread}`.
  - It composes existing `Services` methods only: `actions`, `upcoming`, `_market_notices` and the context.
  - It reads seen state live from `action_log`, so it is not memoised (K7).
  - `GET /notifications` returns its result.
- **Action notices.** The visible tier-`now` actions, in rank order, become `Notice` {`id` `act:<action id>`, `kind` = category, `title`, `body` = detail, `date` = due, `days` = due − today or null, `link` = `actions.cta_href(cta)` or `link` or `/actions?id=<id>`, `severity`}. Severity maps crit → critical, warn → warning, and info/pos → info.
- **Events.** `upcoming.events` with `days` ≤ 7 that no visible action covers become {`id` `cal:<key>:<date>`, `kind`, `title`, `body` = note or "", `date`, `days`, `link`, `severity` 'warning' for kind `tax`, else 'info'}.
  - An event is **covered** when:
    - `fd:<iid>` or `p2p:<iid>` names the `instrument_id` of any visible action (any tier);
    - `sip:<pid>:<date>` matches a visible `sip:due:<pid>:<date>` or `sip:missed:<pid>:<date>`.
  - Kind `ipo` events are dropped, because `_market_notices` already lists IPO dates.
- **Market notices.** `_market_notices` is kept unchanged (`mkt:`/`ipo:` ids), so `test_markets.py`'s notification checks hold.
- **Removed.** The insight items (`ins:*`) and the 30-day calendar horizon are gone. `test_api.py::test_notifications_drop_insights_whose_action_is_hidden` becomes the same check on `act:data:missing-prices` (W7-B2 owns that file).
- **Order.** By severity (critical, warning, info), then `days`, as today.
- **Seen and unread.** Each notice's log row is:
  - for `act:<aid>`: (the action's `owner`, else the settings owner; `aid`);
  - for every other notice: (settings owner, `notice:<id>`).
  - `seen` is `seen_at IS NOT NULL` on that row, and `unread` counts the unseen. W7-B2 may add a bulk read to `ledger.py`.
- **`POST /notifications/seen`** {`ids`: ≤ 100 strings, each ≤ 200 characters} is `write_required`.
  - Guests get a 403. A guest shares `__global__` with the admin, so a guest marking seen would clear the admin's bell.
  - It maps ids to rows as above, calls `mark_seen` per owner, and returns {`unread`} recounted.
  - Unknown ids are recorded as K7 says. A non-list body, or a non-string id, is a 400.
- **Owner.** `owner` is `S().owner()`. Once W7-B1 lands it follows R11.

**R10. The daily digest (§8.6, D9 amended, K7, K21).**
- **Route.** `POST /api/jobs/daily-digest` is in `markets_api.py` beside the market scan. It checks the same `X-Job-Token` with `hmac.compare_digest` (403 otherwise). `__init__.PUBLIC_PATHS` gains `/api/jobs/daily-digest`. There is no market-hours gate.
- **Owners** are `SELECT DISTINCT owner FROM push_subscriptions`. For each:
  - its role comes from the directory; an owner with no role is skipped;
  - settings = `L().get_settings(owner, role)`. If `marketAlerts.digest` is not true: {`owner`, `skipped`: "digest off"};
  - scope = owner for a user, None for an admin or guest (the view their Home shows); the log owner = `settings_owner(owner, role)`;
  - candidates = `S().actions(scope, settings, owner=log owner)['actions']` with `tier == 'now'`, in rank order, whose log row (the action's `owner` or the log owner) has `pushed_at IS NULL`. At most 3 are taken.
- **The push.** One candidate: {`title`, `body` = detail, `url` = the R9 link, `tag` 'digest'}. More: {`title` "{n} things need you today", `body` = titles joined with " · ", `url` '/actions', `tag` 'digest'}. Then `push.send`.
  - Only when `sent > 0` does it call `mark_pushed` for those rows. A run with push off, or no device, stamps nothing, so a later run can still deliver.
- **Response:** {`at`, `owners`: [{`owner`, `new` (candidates), `pushed` (devices)}]}.
- **Tests (push.send monkeypatched to return 1):**
  - a second run the same day reports `new: 0`;
  - digest off is skipped;
  - a bad token gives 403;
  - with push disabled nothing is stamped.
- **Workflow (amends D9).** A new `.github/workflows/daily-digest.yml` runs on cron `45 3 * * *` (09:15 IST, every day including weekends; tax and FD dates do not stop on Saturdays). It uses the same `API_URL`/`JOB_TOKEN` secrets and the curl-and-retry shape. `market-scan.yml` is untouched.

**R11. Per-member settings (P2.6, §7.4).**
- **The rule.** `settings_who()` = (`g.scope`, `"user"`) when `g.role` is admin or guest and `g.scope` is set; otherwise (`g.email`, `g.role`).
  - `Ledger.get_settings(email, "user")` already returns that member's rows over `__global__`, and `set_setting(email, "user", …)` writes the member's row. So the rule needs no ledger signature change.
  - An admin who picks themselves in the switcher edits their own row, not the family plan.
- **W7-B1 (read path).**
  - `Services.settings()` = `ledger.get_settings(*settings_who())`. Every compute endpoint then uses the member's targets, plan and assumptions, and its memo keys follow automatically.
  - `Services.owner()` = `ledger.settings_owner(*settings_who())`. So a non-instrument action's status owner in an admin's member view is the member, as §7.4 says for P2.
  - **Data note:** admin snoozes made in member view before this wave sit under `__global__` and stop applying there. Family view is unchanged.
  - Test (own file): with targets saved for OTHER, an admin viewing OTHER gets OTHER's targets in `/rebalance`, and family view gets the global ones.
- **W7-B2 (write path).**
  - `PUT /settings/<key>` and `POST /review/complete` write with `L().set_setting(*_settings_who(), …)`.
  - `GET /settings` adds the R8 meta.
  - Tests:
    - an admin viewing OTHER writes OTHER's `targetAllocation`;
    - OTHER then reads it;
    - keys OTHER never set come from `__global__` and are listed in `inherited`;
    - family view still writes `__global__`.
- Kpi snapshot owners are unchanged.

**R12. The signal note wording (W6 integrator carry-over; W7-B2).** `SIGNAL_TEXT` notes read the month figure without its sign after "Up"/"Down": "Down 14.5% this month, +2.0% this week", not "Down -14.5%". The week figure keeps its sign. `test_markets.py`'s pinned texts change with it. Keys, titles and `SIGNAL_LABEL` are unchanged.

### Frontend (W7-F1 to W7-F7)

**R13. W7-F1: the bell, the banner, a11y and global styles.**
- **The bell reads the server.**
  - `NotifyService.load()` stores `items` and `unread`. When `unread` is present (a W7-B2 server), the badge is `unread`.
  - Items with `act:` ids list under "Do now"; the rest under "Coming up".
  - The shell stops merging `ActionService.now` into the bell. The nav badge still comes from ActionService.
  - Opening the bell posts the shown unread ids to `/notifications/seen` (writers only) and sets `unread` from the reply.
  - **Guests**, and a server without `unread`, keep today's local seen list (`seen_notices`, try/catch).
- **The banner.** When `auth.realRole() === 'admin'`, no `viewAs`, and `auth.portfolio()` is set: a slim `role="status"` bar under the app bar reading "Editing {portfolioLabel}'s plan · changes save to their settings".
  - "your own plan" replaces the name when the member is the signed-in admin.
  - When `store.settings().settings_owner` is present and differs from the member's email, the bar reads "Editing the family plan" instead.
  - Guests viewing a member see "Viewing {name}'s plan".
- **a11y (D10).**
  - `SortState.ariaSort(key)` returns 'ascending' | 'descending' | 'none'.
  - `ModalComponent` traps Tab and Shift+Tab inside the dialog and returns focus to the element focused before it opened.
  - Pages adopting `ariaSort` is backlog (their tables belong to others this wave).
- **`styles.scss` carry-overs (J19 and the W5 integrator).**
  - **Toast fix:** the toast container in `ui.ts` is renamed `.toast-stack`. The global `.stack` meter (12 px, `overflow: hidden`) clips it today.
  - `.stack-bar` is added as an alias of `.stack`; existing consumers keep `.stack`.
  - `.assumption-chip` wraps on narrow cards (`white-space: normal` at ≤ 560 px).
  - The class-page hero rules (`.h-kpis`, `.more-stats`, `.kpi.extra`) are lifted into `styles.scss` exactly as the pages copy them. The pages' own copies stay until their owners remove them.
- **Optional types (R20)** may be added. No sibling waits on them.

**R14. Notices and old code.** After W7-B2, `Services.notifications` has no caller. W7-B1 leaves it; the integrator deletes it (R2). The bell's insight filter (`kind !== 'insight'`) becomes dead and W7-F1 removes it.

**R15. W7-F2: Plan P2 (§5.2).**
- **Tabs** add `scenarios` ("Scenarios") to `TABS` and `planTabOf`. `?tab=scenarios` opens it. Unknown values still read Overview.
- **Overview, "What moves the needle" (T2, after the fan).**
  - It loads `api.plan({detail: true})` lazily, after `/plan` has painted, and never blocks T0.
  - It shows 4 tiles, one per sensitivity: label, "Retirement {±pts} pts" and "{worst goal name} {±pts} pts", with est. tags. Nulls read "—".
  - **"Try it":**
    - A writer with fewer than 5 saved scenarios appends `sensitivity.scenario` (named from its label) to `planScenarios` through `store.saveSetting`, then opens `?tab=scenarios`.
    - A guest, or a writer at 5, puts it in a session-only module-level list of inline scenarios (the W5-F3 Undo pattern) and opens the tab.
- **Scenarios tab (new `scenarios.component.ts`).**
  - It lists the saved scenarios plus the session ones. Selected scenarios (≤ 4, ≤ 2 for guests) are compared with `api.planCompare` (or `api.post` with inline partial bodies, R5).
  - The chart (shared line chart) draws the baseline p10–p90 `band` plus one p50 line per `paths` entry. The legend names each column.
  - The table: `rows` × `columns`, values formatted by `format`, and deltas under each value. A `pct` row's delta is formatted as points (`pts`), and ▲/▼ is coloured by sign.
  - Writers get an editor (name, SIP, step-up, return, retire at, inflation, lump sums; prefilled from `baseline`), Save (≤ 5) and Delete. Mix is edited only on Risk & mix.
  - States: loading, error with retry, empty ("Try a change from What moves the needle, or add one"). There is one h1 (the page's).
- **Retirement hero.**
  - Under the probability: "Money lasts to {life_expectancy}: {probability_lasts}% · 1-in-10 runs out at {depletion_age_p10}". The second clause appears only when `depletion_age_p10` is set. Est. tag.
  - The chart's `path_bands` p10–p90 band is drawn over the age axis behind the existing path.
  - `sources` (when present): "Counts EPF ₹a + NPS ₹b + free money ₹c; ₹d earmarked for goals is left out".
- **Goal cards.** When `projection.contribution_source === 'linked'`: "Funded by {n} SIP{s} · ₹{linked_monthly}/mo". When it is `'goal'` and plans exist: a writer hint "Link a SIP on Recurring →" (`/recurring`).
- **After tax (D5).** The Adjust panel gains "Show after tax" (off by default). On, the fan's request sends `after_tax: true` and the side figures show `end.after_tax` p10/p50/p90 with its `note`. The fan bands stay pre-tax.
- **Calibration (T3, collapsed "How our ranges held up").** It appears only when `calibration?.show`, read from `api.assumptions()` (lazily, on open). Text: "{inside} of {matured} months landed inside the 1-in-10 range ({coverage_pct}%; aim 80%)", plus the rows table (date, range, realised, inside ✓/✗).

**R16. W7-F3: Risk & mix P2 (§5.6, P2.3, P2.8).**
- **Load order.** `/risk` is requested before `/forecast/stress` (R3: β comes only from a warm risk memo). If the stress payload arrives with every `holdings[].beta` null and `/risk` has since resolved, stress is fetched once more.
- **Stress cards.**
  - Two recovery figures: "Markets alone ~{recovery_months_markets} months · with your SIPs ~{recovery_months_with_sips} months". Null reads "more than 20 years".
  - A collapsed "Hit by holding" drill-down: the 10 `holdings` with value, β (or "1.0 (assumed)"), shock % and ₹ impact.
  - When `plan_impact` is present: "After this shock: retirement {before}% → {after}%" and one line per goal, with est. tags.
  - T0's "A routine correction" tile keeps reading the `correction` scenario.
- **Rebalance planner (Allow selling).**
  - Sell rows show `tax_if_sold` ("tax ₹X" or "saves ₹X" when negative) and a collapsed list of `sells` in their pick order, with `order` worded "loss" / "tax-free long-term gain" / "other". `tax_total` and `tax_note` go in the footer.
  - `let_mature` rows read "Let it mature" with the amount (L3 keeps "Redirect maturities" as the badge). `locked` rows read "Locked (EPF/NPS)". `not_sold` > 0: "₹X left in maturity-only or locked money".
  - When the row carries `tax_if_sold`, J9's per-row what-if call is skipped.
  - Every new input is optional with today's default, so Actions and Recurring render as before.
- **Allocation lab.**
  - The optimizer's `let_mature` rows read "Let mature", and trim rows show `tax_if_sold`.
  - "Preview impact" adds, under the H7 chip, the Δ retirement and goal points from `POST /plan/compare` with one inline scenario {`name`: "Proposed mix", `mix`: draft targets}. It is debounced like the chip and only runs while the sum is valid. Rows `retirement` and `goal:*` are read from column 1's deltas. Guests may use it (1 scenario).

**R17. W7-F4: the quarterly review (P2.5, §5.1 Review row).**
- **The tab.** `?tab=review` on `/actions` opens `review.component.ts` in place of the action lists, keeping the head and T0. The filter chips are hidden while reviewing. A "Start the quarterly review" button in the Last review tile, and the brief link `/actions?tab=review` (the last interim link), open it. Closing drops `?tab` (replaceUrl).
- **The six steps** have a step indicator (`aria-current="step"`), Back/Next, and per-step state that lasts for the session only.
  1. **What changed since {lastReviewDate}.**
     - `api.brief(lastReviewDate)` `hero.since_last` gives the value change and %, and new actions.
     - `settings.reviewSnapshot` against the current segment % gives the mix moves (> 1 point).
     - `/plan` `deltas` gives goal and retirement change, labelled "last 30 days" (the snapshot window).
     - With no `lastReviewDate`: "First review: here is where you stand". **The review never writes the Home brief snapshot (E20).**
  2. **Mix.** The shared planner twice, no-sell then Allow selling. The R16 tax lines appear wherever the planner already shows them; the review adds no planner inputs.
  3. **Concentration, laggards and winners**, from store positions, mirroring `insights.py`:
     - concentration: weight > 12% (stocks and funds);
     - laggards: `unrealized_pct` ≤ −20 and held ≥ 180 days since `first_date`;
     - winners: `unrealized_pct` ≥ 50 and weight ≥ 5%;
     - each row links `/holding/<id>`.
  4. **Plan.** `/plan` `sip`: "You invest ₹{plans_monthly_total}/month; your goals and retirement need ₹{needed_monthly}" plus the gap, with a link to Plan.
  5. **Commitments.**
     - For each of the step-2/3 items the user ticks: "Plan for…" (date) posts status `planned` with `planned_for` through ActionService, when a matching action id exists.
     - "Edit SIPs on Recurring →" (`/recurring`); no SIP editor is embedded.
     - Guests see this step read-only.
  6. **Complete.** `api.completeReview()`, then `store.changed()`, a toast, and the tab closes. Under R11 it writes the member's `lastReviewDate`.
- **The check-up card** (on the review tab only; it lazily fetches `/pulse`): `health.score`/grade, then `components` (label, score/100, note) as meters, then `focus`. A failed `/pulse` hides the card with a one-line notice.

**R18. W7-F5: Recurring P2 (P2.7, §5.9).**
- **The SIP modal** gets a "Funds goal" select: "No goal" plus the goals from `api.goals()` (loaded once with the page). It sends `goal_id` (null for none) on create and update. A 400 from K3 ("That goal isn't one of this portfolio's goals") shows inline.
- **The plans table** gets a "Funds goal" column with the goal name or "—", linking `/plan?tab=goals#goal-<id>`. A deleted goal reads "—", because the server nulls it.
- **T3, "Planned vs invested, 12 months":** two CSS bars per month (planned outlined, invested filled). Est. is not needed; these are recorded amounts.
  - The source is `/sips` `history` (R3) through `api.get('/sips', …)` or a local intersection type.
  - Without `history`, it falls back to summing `adherence.plans[].months` (6 months) and says "last 6 months".
  - It does **not** edit `bar-chart` (unowned).

**R19. W7-F6: Settings P2 (§5.14).**
- **The `#assumptions` section** (rail order profile, alerts, prices, people, assumptions; `SECTIONS` gains it). It loads `api.assumptions()` and shows one row per Book key, MF_DEBT labelled "Mutual Funds (debt)":
  - the default or current return and volatility;
  - inputs pre-filled from `settings.assumptions`;
  - client-side ranges (R4) with an inline error per field;
  - FD, EPF and P2P returns shown read-only as "from your holdings" when the row's `source` is 'holding rates'.
  - An inflation input (0–15).
  - "Save" sends only the changed rows plus inflation. "Reset to defaults" sends `null` after a confirm.
  - It shows `hash` ("Assumptions id {hash}"), and after a save the new hash with "Every forecast now uses these".
  - Guests see it read-only.
- **`#alerts`** gets a "Daily action digest (09:15)" toggle bound to `marketAlerts.digest`, saved with the whole alerts object. When push is not on for this device, the hint reads "Needs alerts on this device".
- **Per-member.**
  - When `settings_owner` is a member email: "Saving to {member}'s plan".
  - Each section showing an `inherited` key is marked "From the family plan until you change it".
  - Family view keeps "Editing the family plan".
- **No `#appearance` (D10).**

**R20. Optional types W7-F1 may add (additive; nobody waits on them):**
- `Plan.sensitivities?` and `Plan.baseline?: PlanScenario`;
- `PlanCompare.baseline?` and `scenarios?`;
- `PlanCompareRequest.scenarios: (number | Partial<PlanScenario>)[]`;
- `SipsResponse.history?: {month: string; planned: number; invested: number}[] | null`;
- the `AssumptionSegment.source` comment already lists 'override', so it needs no change;
- `Settings.marketAlerts.digest` (already typed).

**R21. W7-F7: Transactions paging and Import (P2.11, §5.11, K6, J19).**
- **Transactions** uses `api.transactionsPage` (size 50).
  - Inputs: `q` (debounced 300 ms), sort headers (`date`/`amount`/`name`, both directions) with `aria-sort` written in the component, and filters for class, type and from–to. All are kept in the query string with replaceUrl.
  - Rows are grouped by month. Each month header shows that month's subtotal from the server's `months` (all filtered rows, not just the page).
  - T0 hero "Net put to work" = `sums.net`, with tiles for Transactions (`count`), Money out and Money in.
  - A pager shows "Page {page} of {pages}". After an edit, delete, add or import it refetches the current page.
  - A 400 from a bad parameter resets to page 1 with the error shown.
- **The CSV import modal** and the CAS flow render the 400 `results` list (K5/K6) as a table: row name, date, error. The L2 one-line message stays as the toast.
- **`shared/drop-zone.component.ts`** (`app-drop-zone`):
  - inputs `accept`, `multiple`, `disabled`, `label`, `hint`; output `files: File[]`;
  - drag and drop, click and keyboard (Enter/Space) on a focusable zone, `aria-describedby` on the hint, and a visible focus ring;
  - a file whose type does not match `accept` is refused with a message.
  - It replaces the `<label class="drop">` file inputs in CAS (`import.component`), EPF, Kite and the Transactions CSV modal. LenDen's dialog on `/p2p` is not ours and keeps its own input.
- **Import page:** source tiles CAS · Kite · EPF · LenDen. LenDen links `/p2p?import=lenden`; the other three scroll to their flow.
- **The Add sheet** (`txn-form`) gains an "Import a statement" tile (writers only) that closes the dialog and goes to `/import`.

### Carried forward and integration

**R22. Critique items this wave resolves, and carry-overs.**
- **M10 / D5:** the after-tax toggle (R3, R15).
- **M13 / D9:** the digest route, PUBLIC_PATHS and its own workflow (R10).
- **C13 / D14:** `inflation_pct` and `mix` in scenarios (R5, R6).
- **C17 / D15:** seen lives in `action_log` only (R9).
- **M17, N6 / D10:** dark mode cut; a11y kept (R13).
- **M2 / D1:** the tax-aware rebalance and optimizer wiring (R3).
- **M4:** the guest cap on compare (R6), next to the existing `/forecast` cap.
- **Carried into this wave:**
  - L5 → W7-B1 (R3);
  - K11 / K21 → W7-B1 (R3);
  - K17 → W7-B1 (R3), W7-F2 (R15);
  - W6-B2's frontend list → W7-F2 and W7-F3;
  - W6-B3's display list → W7-F3;
  - W6-F2's after_tax/detail parameters → W7-F2;
  - the W6 integrator's signal wording → W7-B2 (R12);
  - the W5 integrator's `styles.scss` items and J19's hero lift → W7-F1;
  - J19's Import tile → W7-F7;
  - the last interim link `/actions?tab=review` → W7-F4.

**R23. Backlog after wave 7 (no owner):**
- adopting `SortState.ariaSort` on Holdings and P2P;
- removing the pages' copied hero rules;
- the bar chart's last-label clip;
- the duplicate compact-card rule on Tax;
- optimizer `turnover` (W6-B3);
- festival dates for 2029 (before April 2028);
- the `LabelledSignal`/`OutlookWithSignals` cleanup;
- the mu_sim / FD-release modelling gap and σ* reporting (W6 review);
- the K20 backlog items;
- goal markers bunching on large portfolios;
- the holding page's Transactions table at 390 px;
- Performance's double fetch;
- the P3 items WAVES lists.

**R24. Integrator checks for wave 7.**
1. Full backend pytest, then `npx ng build` and `npm run check`. Then the R2 merges (`settings_who`, scenario validation, delete `Services.notifications`), and pytest plus both builds again.
2. **On a fresh copy of the scratchpad database, through the Python modules and a Flask test client on that copy** (never the real database; never a real token; a test-client header from `issue_token` on the copy only):
   - **Overrides:** save an Equity (India) override, and check that `/forecast`, `/plan`, `/optimizer`, `/assumptions` and `/brief` move together and their hashes are equal. Reset, and they return.
   - **Compare:** compare(baseline) gives 0 deltas. Report the 4-scenario cold and warm time and the `/plan?detail=1` cold time.
   - **Stress:** `/forecast/stress` with a warm `/risk` carries β and `plan_impact`. `/brief` carries none of `plan_impact`.
   - **Rebalance:** `/rebalance?allow_sell=1` carries `tax_total` and the sells order.
   - **Notifications:** the bell's `act:` items equal `/actions` tier now. POST seen lowers `unread`. A guest POST gives 403.
   - **Digest:** with `push.send` patched, the digest runs, then a second run sends nothing.
   - **Per-member:** an admin viewing a member writes and reads the member's targets, and family view is unchanged.
3. **A5 re-measure.** Cold and warm `/brief`, `/actions` and `/plan` on the copy, now that retirement gets `funding` and the plans. Report against the 800 ms and 50 ms budgets.
4. **Mocked UI at 1280 and 390 px** (one h1, no horizontal overflow):
   - Plan's Scenarios tab and What moves the needle;
   - Retirement's lasts line;
   - Risk's stress drill-down, plan impact and tax-ordered trims;
   - Actions `?tab=review` through all six steps;
   - Recurring's goal column and 12-month bars;
   - Settings `#assumptions` and the digest toggle;
   - Transactions paging and the Import drop zones;
   - the bell's unread and seen, the member banner, and the modal focus trap.
5. **Route audit.** No interim link targets remain: `/actions?tab=review` now opens the review. Every `api.service.ts` path, including `/plan/compare`, `/notifications/seen` and `/jobs/daily-digest` (job only), has a Flask rule.

### W7-B2 build notes (settings, notifications and digest)

These close small gaps that R4, R5 and R8 to R12 leave open. They bind the integrator's R2 merge and W7-F1/W7-F6.
- **Saved scenarios (R5).** `name`, `sip` and `step` are required in a saved scenario. `return`, `retire_age`, `inflation_pct` and `mix` may be null or absent, and `lump_sums` absent or null stores []. Numbers must be JSON numbers (a string "60000" is a 400). A lump `date` must be exactly `YYYY-MM-DD`. The 400 text is "Scenario {n}: {field} …" with n **1-based** (the person's count), and the field path is `lump_sums[j].date` / `lump_sums[j].amount` for one lump. `null` stores []. When the integrator swaps in `scenarios.validate_scenario`, these messages and the required trio must hold, because `test_settings_p2.py` pins them.
- **Overrides (R4).** `validate_overrides` drops extra keys inside a row (such as `source`) and drops an empty `segments`. `effective_book` skips a stored row that is still malformed (unknown key, missing or non-finite number) instead of trusting it.
- **Notifications (R9).** The visible actions are `actions` + `planned` from `/actions`, so a planned tier-now action stays in the bell. A failing source (actions, Coming up or market notices) is printed and left out, so the bell still answers. `POST /notifications/seen` drops duplicate ids and rejects empty strings. `act:<id>` maps to an action row only when `<id>` carries a known action prefix; anything else is a `notice:` row.
- **Digest (R10).** An owner with no directory role reads {`owner`, `skipped`: "not a member"}. One owner's failure reads {`owner`, `error`: "digest failed"} and the run goes on. A member with no `marketAlerts` row of their own inherits the family's `digest` flag (R11's fall-through).
- **Ledger and push helpers.** `Ledger.setting_keys(owner)` (the keys with a row of their own; used for `inherited`), `Ledger.log_stamps(pairs)` (the bulk seen/pushed read), and `push.owners(db)` (distinct subscribed owners).

### W7-F1 builder decisions (bell, member banner, a11y, global styles)

- **Two records of "read" (R13).** `NotifyService.serverMode` = the server sent a numeric `unread` **and** `auth.canWrite()`. In server mode the badge is the server's `unread`, each item's dot is `seen !== true`, and opening the bell posts the shown unread ids (deduplicated, non-empty, ≤ 200 characters, ≤ 100) to `/notifications/seen` and takes `unread` from the reply. The post is optimistic: the badge drops at once and exactly the flipped ids go back if it fails (unless a newer load already replaced the list). Items that arrive while the bell is open are posted on close. Guests (who would get a 403 and share `__global__` with the admin) and a wave-6 server with no `unread` keep the local `seen_notices` list (try/catch, newest 300 ids), marked when the bell closes; the close button reads "Mark all read" there and "Done" in server mode.
- **Ids stay new while the bell is open.** The ids unread at opening keep their dot (and a screen-reader "New:") until the bell closes, so marking them seen does not visually erase what the user is reading.
- **The welcome pop-up** (once per browser session) opens through the same `show()`, so in server mode it also posts the shown ids.
- **Bell sections.** `act:` ids are "Do now" (status stripe from `statusFromSeverity`, plus an "All actions" link); everything else is "Coming up". `ActionService.now` is no longer merged and the `kind !== 'insight'` filter is gone (R14). The nav badge still reads `ActionService.summary()`.
- **Banner wording.** The self case reads "Editing your own plan · changes save to your settings" (R13's literal swap would say "their settings" about the reader). "Self" is the signed-in email or the member row with `self: true`. The guest banner is `kind=view` ("Viewing {name}'s plan"); a `user` role and any `viewAs` show no banner (view-as keeps its own gold bar).
- **Stale settings never drive the banner.** Right after a switch the store can still hold the previous scope's settings (no snapshot yet), whose `settings_owner` is `__global__`. The shell records the store `scopeKey` at which the current settings object arrived and reads `settings_owner` only when it equals today's `scopeKey`; until then the banner shows the member wording.
- **Modal focus trap.** Tab from the last tabbable control (or from outside the dialog) goes to the first; Shift+Tab from the first (or the dialog itself) to the last; a dialog with no tabbable control keeps focus on itself. Only the top dialog of a stack answers Tab and Esc, the body scroll lock lifts when the last one closes, and focus returns to the opener unless another dialog is still open and the opener sits outside it. `focusableIn(root)` is exported.
- **styles.scss.** `.stack, .stack-bar` share one rule. The toast container is `.toast-stack`. `.assumption-chip` wraps at ≤ 560 px (`white-space: normal`, 12 px radius). The hero lift copies the Holdings rules, with `.more-stats` scoped as `.kpis .more-stats` so Actions' light-ground "More stats" button (outside the navy strip) keeps its look.
- **R20 types** are added as optional fields only (`Plan.sensitivities/baseline`, `PlanCompare.baseline/scenarios`, `PlanCompareRequest.scenarios: (number | Partial<PlanScenario>)[]`, `SipsResponse.history` as `SipHistoryMonth[] | null`).
- **Checked on a mocked API** (development build, fake token, synthetic payloads, headless Chrome at 1280 px and in a 390 px iframe; one h1 and 0 px horizontal overflow in every case): writer with `unread` (badge 2, opening posts the two unread ids and the badge clears from the reply); wave-6 shape and guest (local list, no post); the welcome pop-up; the banner for member, old server, family owner, self, guest, family view, view-as and user; Tab/Shift+Tab wrap, Tab from outside, Esc closes and focus returns to the Add button; the toast is fully in view and hit-testable.

### W7-F5 builder decisions (Recurring P2: goal link and planned vs invested)

- **Who loads the goals.** `RecurringComponent` calls `api.goals()` once per page and scope (not on `store.version()` bumps; a newer call supersedes an older one) and hands `SipPlansComponent` a new input `goals: GoalRef[] | null` ({id, name, owner}). `null` means still loading or `/goals` failed. The page still owns the single `GET /sips`; the J10 netting, the planner and the session Undo are unchanged.
- **"Funds goal" column** (after "From → to", `hide-sm`): the goal's name linking `/plan?tab=goals#goal-<id>`, or "—". On phones the column is hidden and the plan cell gets a "Funds {goal}" line with the same link. A `goal_id` the loaded list does not hold reads "—" (R18: the server nulls a deleted goal's links). While the names are unknown (`/goals` failed) a linked plan reads "A goal" with the link kept, so a failure never hides a link. `goalCell` is exported.
- **The modal's select** sits above Notes: "No goal" plus the goals. Editing a plan lists only goals whose `owner` equals the plan's `owner` when the rows carry it (K3 would refuse the rest); a new plan lists them all. A plan's current goal that is not in the list stays selectable ("Current goal" / "Current goal (not in this view)"), so saving another field never unlinks it. The body always carries `goal_id` (null for none) on create and update. A 400 whose message names a goal (`isGoalRefusal`) shows under the select with `role="alert"` and `aria-invalid`, and the modal stays open; any other error keeps the existing `.notice.bad`. Hints: no goals → "Add one on Plan → Goals"; goals failed → "only the plan's current link is offered".
- **T3 "Planned vs invested"** is a card after the plans table, shown only when there are plans. `plannedVsInvested(sips)` (exported) reads `history` when it is a non-empty array (title "…, N months", 12 from the server), else sums `adherence.plans[].months[]` by `month`, cut at the current month (the adherence window can reach a week into next month) and gap-filled to 6 months (title "…, last 6 months", with the hint "the 12-month record isn't available"). Neither → a muted line. The hint states the total "₹X invested of ₹Y planned (Z%)". No est.: these are recorded amounts.
- **The bars** are plain CSS: one hue (`--s1`), planned outlined and invested filled, so identity is fill vs outline plus a legend; 2 px gap, 4 px rounded tops, recessive quarter gridlines. Each month is a focusable list item with an `aria-label` ("November 2026, so far: planned ₹…, invested ₹… (n%)") and a hover/focus tooltip anchored inward (left half from the left edge, right half from the right) so it never pushes the page wide at 390 px. The current month is bold and "so far"; the footnote says instalments still to come and skipped ones count as planned. `bar-chart` is not touched. The T0 verdict keeps "over 6 months".
- **Checked on a mocked API** (development build of a scratch copy of the tree, fake token, synthetic payloads; `scratchpad/w7f5_mock.py`, `w7f5_check.py`) at 1280 px and in a 390 px iframe: history present (12 bars), history absent and null (6 bars, "last 6 months"), plans with and without `goal_id`, a goal id the list lacks, `/goals` failing, guest (no buttons, column shown), no plans (no T3 card), K3's 400 on save (inline under the select, modal open), unlink (sends `goal_id: null`), relink, and create with a goal. One h1 and 0 px horizontal overflow in every case.

### W7-F4 builder decisions (Actions P2: quarterly review and check-up)

- **The tab.** `reviewOpen` is `?tab=review` exactly. Other values show the lists. While the review is open, the head, T0, "More stats" and the actions notices stay, and the filter chips and every list are replaced by `<app-review>`. The Last review tile shows "Start the quarterly review" to every role, because guests can read the review. It reads "Reviewing below" (disabled) while the review is open. "Mark review done" stays for writers and is hidden while reviewing. Opening adds a history entry (`queryParams {tab: 'review', id: null}`), so the browser's Back closes the review. Closing and completing drop `?tab` with replaceUrl and keep `?filter`. A guest's tile no longer repeats the date when the value is already a date (61+ days).
- **Planner inputs.** `[newMoney]` is `deploy.suggested ?? 0`, and `[useNet]` is `suggested !== null`, as Actions already reads them (E20). Nothing else is passed (R1/R16). The two planners are stacked: "Without selling", then "Allow selling". Side by side at 1280 px, the tables did not fit in half the width.
- **Step 1.** `api.brief(lastReviewDate)` is the only brief call. Its value is never written to any snapshot (E20). Without a review date there is no brief call: "First review: here is where you stand" shows the store's value, unrealised gain, XIRR and action counts, plus today's mix against its targets. Mix moves: `mixMoves(reviewSnapshot, segments)`. A segment missing on one side counts as 0, and only moves where |Δ| > 1 are listed. A missing or empty `reviewSnapshot` says the last review saved none. The value change says "includes money you added", because `since_last.change` is the change in value, not in return. `/plan` rows show probability (est.) and their `deltas` labelled "last 30 days".
- **Step 3 classes (deviation in wording only).** R17 says "stocks and funds" for concentration. The rule is `asset_class` ∈ {equity, mutual_fund, commodity} with weight > 12, so EPF, NPS, FD, P2P and cash are not flagged. Laggards and winners follow `insights.py`: open and non-cash; a laggard has ≤ −20% and ≥ 180 days since `first_date`; otherwise ("elif") a winner has ≥ 50% and weight ≥ 5. `reviewHoldings` and `mixMoves` are exported pure functions. The ids are the catalogue's `concentration:<iid>`, `loser:<iid>` and `winner:<iid>`. Step 2's tickable items are the open or planned `drift:<segment>` actions.
- **Step 5.** A ticked item is plannable when its id is in `ActionService.actions()` or `planned()`. Snoozed or done items are not re-planned. The date defaults to the current `planned_for`, else today + 30 days. The button posts `{status: 'planned', planned_for}` through `ActionService.setStatus` and toasts. A ticked item with no matching action reads "Not on your action list, so there's nothing to plan" and keeps its holding link. Guests see no tick boxes. Step 5 tells them they can't save commitments and lists `svc.planned()` read-only. Step 6 counts the actions planned in this session.
- **Session state.** It lives in a module-level map keyed by `store.scopeKey()` and holds the step, the ticks and the picked dates. It survives closing and reopening the tab, but not a reload. Completing the review clears it. Changing step moves focus to the step's h3 (`tabindex=-1`) and scrolls it into view only when it is off screen.
- **Complete.** The order is `api.completeReview()` → `await store.changed()` → toast "Review complete · next reminder in 90 days" → `closed`. A failure toasts and keeps the review open. Guests see "Only the portfolio's owner can complete the review." and a Close button.
- **Check-up.** `/pulse` is fetched once, after the wizard's first render (`afterNextRender`), and never refetched per step. Scores use the shared status colours: ≥ 70 good, ≥ 55 watch, else act. These are the same cut-offs as the `health.py` grades Good and Fair. Each meter is a `role="meter"` track with the label, the rounded score/100 and the note. The focus line follows. A failed /pulse, or one with no `health.score`, hides the card and shows one muted line: "The check-up couldn't load, so it's hidden. The review still works." The score is a heuristic of past data, not a forecast, so it carries no est. tag. The SIP need in step 4 and the goal chances in step 1 carry one.
- **Phones.** At 760 px or less, the step indicator shows numbers only, past steps show a check, and the current step keeps its label (ellipsised). The meters drop to one column.
- **Verified** on a mocked API: a development build, a fake token and synthetic payloads (`scratchpad/w7f4_mock.py`, `w7f4_check.py`, which reuse `w5f8_mock.py`). The checks ran at 1280 px and in a 390 px frame, for a writer with and without `lastReviewDate`, a guest, and a writer with `/pulse` returning 500. All six steps were driven through Next/Back and the indicator. Ticks posted `drift:Equity (India)`, `concentration:101` and `loser:103` as planned for today + 30. After that, step 6 read "You planned 3 actions". Complete posted `/review/complete`, dropped `?tab`, and the tile read "Today". Close kept `?filter=tax`. Every case had one h1, no filter chips while reviewing, and 0 px horizontal overflow. The planner's own table scrolls inside its own wrapper at 390 px.

### W7-F3 builder decisions (Risk & mix P2: stress-to-plan, tax-ordered trims, plan preview)

- **No new planner inputs.** Every R16 planner line is drawn from fields that only an `allow_sell` payload carries (`tax_if_sold`, `sells`, `covered`, `let_mature`, `locked`, `not_sold`, `tax_total`, `tax_note`). So the no-sell plan on Actions, Recurring and Risk & mix renders exactly as before. The R16 lines appear on every host once the user ticks Allow selling, which is what R17's review step needs. The four J2 inputs are unchanged.
- **Planner, sell rows.**
  - A sell row with a numeric `tax_if_sold` shows "tax ₹X" (or "saves ₹X" when negative), with est., beside the Trim badge, and skips J9's what-if button and call. A sell row without it (no ledger on the server) keeps J9 as it was.
  - Its `sells` go in a collapsed sub-row: "{n} sales in {segment}, lowest tax first". When `covered` falls more than ₹1 short of `amount`, it adds "· frees ₹covered of ₹amount". The list is in pick order. Each sale shows name, units (whole units, or funds to 3 decimals), proceeds, its `order` worded "loss" / "tax-free long-term gain" / "other" (the first two as a green badge), and its own tax.
  - Rows keep the server's order, and the sells keep their pick order. This is R16's "pick order"; WAVES' "trims lowest-tax first" is met inside each leg, and segment rows are not re-sorted.
- **Planner, other rows.**
  - `locked` comes first in `badge()`: "Locked (EPF/NPS)" with a shield icon.
  - `let_mature > 0` keeps the L3 "Redirect maturities" badge and adds "Let it mature ₹X".
  - Footer, on allow_sell plans only: "All these sales together: tax ₹X" (est.), then `tax_note`, then "₹X left in maturity-only or locked money" when `not_sold` > 0.
  - The sales sub-row is sticky-left with `max-width: calc(100vw − 104px)` at ≤ 760 px, so it stays inside the visible part of the sideways-scrolling table. The J9 `.rp-tax` row is left as it was.
- **Load order and the β refetch (R16).** `loadRisk()` is now called before `loadStress()`. `stressMissingBeta(stress, risk)` (exported, pure) is true when some scenario lists holdings, every listed `beta` is null, and `/risk` has at least one numeric holding β. It is checked after either answer lands, whichever is last. Stress is then refetched once per load cycle (the data-version effect resets the flag). A server that never sends β gets exactly one extra call, never a loop.
- **Stress cards.**
  - Recovery reads "Back to today's value: markets alone ~N months · with your SIPs ~M months" (est.). A null reads "more than 20 years", and `recovery_months_with_sips` falls back to `recovery_months`. It shows only for falling scenarios. A payload without either K11 key keeps the old one-figure sentence.
  - `plan_impact` reads "After this shock: retirement 78% → 64%", then one line per goal ("{name} 82% → 72%"). Each has an ▼ icon and a screen-reader "(lower)" when the chance drops, plus est. A side with a null chance is left out.
  - "Hit by holding" is a `details.more` table: Holding / Value / Beta / Shock / Impact. The header says "Beta" because the table's uppercase turns "β" into "Β". A null β reads "1.0 (assumed)". Value is hidden at ≤ 560 px. One est. sits in the footnote, which also explains β.
  - T0's correction tile is unchanged.
- **Allocation lab moves (K14).**
  - The page fetches `GET /optimizer?profile=k` once per chosen profile and data version (`optBy`), seeded with the profile-less answer, which is the saved profile. This changes W5-F2's "choosing a profile refetches nothing". Without it, "Let mature" and the trim tax would only ever describe the saved profile while the Suggested % column follows the chosen one. Profiles, current mix and frontier are the same in every answer, so only the rows are used, and only when `moves.profile` is the profile on screen. A failed fetch just leaves the moves out.
  - In the Suggested % cell, `let_mature` reads "Let mature" and a `trim` with a numeric `tax_if_sold` reads "Trim · tax ₹X" / "Trim · saves ₹X" (est.). The rows' `suggested_pct` are the profile's `weights` (`optimizer.suggest`), so the annotation and the number agree.
  - One line under the table: "Moving to the {profile} mix: the trims cost about ₹X in tax together, lowest tax first; FD and P2P are left to mature, never sold." It uses `tax_total` when there are trims.
- **Preview impact on the plan (R16).**
  - The same 400 ms debounce and validity rule as the H7 chip. Both requests fire from the one timer, with separate sequence numbers, so a slow compare never blocks the chip.
  - The body is `api.post('/plan/compare', {scenarios: [{name: 'Proposed mix', mix: <positive draft rows>}]})` (`mixScenario`).
  - `mixPlanDeltas` reads the `retirement` and `goal:*` rows: label ("Retirement" or the goal name), `values[0]` → `values[1]`, and `deltas[1]` as "+2.2 pts" / "−1.5 pts" / "no change" (|Δ| < 0.05), with ▲/▼ and est. The est. basis names the `sims`.
  - With neither row, it says "Save a retirement plan or add a goal on Plan to see how this mix moves them." A 400 shows inline. Guests run it like writers.
  - The old "Goal and retirement effects come later." is removed. At ≤ 760 px the H7 table's row headers wrap, so it no longer scrolls sideways.
- **Verified** with `ng build`, `npm run check` and a mocked API: a development build, a fake token, and `scratchpad/w7f3_mock.py` / `w7f3_check.py` / `w7f3_shot.py` from the W5-F2 harness, on ports 47320+ because a sibling's mock held 4790. There were 41 cases at 1280 px and in a 390 px frame.
  - Every case had one h1 and 0 px overflow. Every anchor still landed at 80 px, except `#concentration` at 1280 px: it sits at the page's end and stops at 319 px with the page scrolled to its maximum, the same figure as W5-F2's run.
  - Stress: holdings with and without β, two recoveries including a null, and `plan_impact`. The `nobeta` mode (β only after `/risk` finishes) made 3 stress calls, and the third, with β, was rendered. The `stale` mode stopped at one refetch.
  - `/rebalance?allow_sell=1` showed sells with every `order`, `covered` short, `let_mature`, `locked`, `tax_total` (also negative), `tax_note` and `not_sold`. A row without `tax_if_sold` still priced through J9, including its 400.
  - `/optimizer` moves for Balanced (trims ±, two let_mature) and for Growth after a profile click.
  - `/plan/compare`: the body was the rounded draft. It was checked with deltas, without plan rows, with a 400, and for a guest (500 sims).
  - The W5-F2 states (guest, unset, snapshot, empty, outage, save) are unchanged.

### W7-F7 builder decisions (Transactions paging, Import drop zones, Add-sheet tile)

- **Query string.** Transactions keeps `q`, `class`, `type`, `from`, `to`, `sort` (only when not `-date`) and `page` (only when > 1) in the URL with `replaceUrl` and `queryParamsHandling: 'merge'`; `import=1` stays while the CSV modal is open. Values read from the URL are checked on the client first (a known class or type, a `YYYY-MM-DD` date, one of the six sorts, a whole page ≥ 1); anything else falls back to its default instead of reaching the server.
- **Month groups follow the date sort only.** Under `date`/`-date` the page's rows sit under month headers ("{Month YYYY} · N transactions · out ₹ · in ₹ · net ₹", all from the server's `months`, so they cover every filtered row, not just the page). Under an amount or name sort the rows are one flat list, because month headers would break the order the user asked for. The sortable headers are Date, Holding (`name`) and Amount; a header's first press is newest, largest or A–Z first, the next flips it. `aria-sort` is written by the component (`ariaSortOf`), not `SortState`.
- **400 handling.** A 400 on the paged GET shows its message above the table ("{error} · showing page 1"), moves to page 1, and if it was already on page 1 resets a non-default sort. The message stays until the user changes an input. Other failures keep the last page on screen with a "Couldn't refresh" notice and Try again; with nothing loaded yet they show the error card.
- **Phones (≤ 760 px).** The ledger fits 390 px without sideways scrolling inside the card. Type folds into the holding's sub line ("Stocks · Buy") and its column hides. The date reads "10 Nov" with the year beneath, holding names wrap, cells pad 8 px, and edit and delete stack. Month headers wrap. The empty and no-match states render outside the table, so they centre on the card. The date range takes a full row.
- **A page past the end** (an old link, or deleting the last row of the last page) moves to the last page instead of showing an empty table. Every write still refetches through the store version, as before.
- **Export** now walks every filtered page at size 200 in the current sort, so it exports all filtered rows, as the old client-side export did.
- **The drop zone** (`shared/drop-zone.component.ts`) is a `role="button"` div (tabindex 0, or -1 when disabled) wrapping a hidden file input. Enter or Space opens the picker; the input's own click does not bubble back. Refusals read "{names} was/were not added: only {PDF | XLSX or CSV | CSV} files go here." and are tied in through `aria-describedby` with the hint. A single-file zone keeps the first file of a multi-file drop and says so. Extension tokens match case-insensitively, so `pb-2024.PDF` and a `.xlsx` with an empty MIME type are accepted. The zone does not remember a chosen file; each parent's `label` names it.
- **Shared import helpers live in the drop-zone module:** `refusedRows(e)` (the K5 400 `{error, results}` → the refused rows), `showRefusal(id)` and `completeImportDue(actions)`. The last one is §5.11's "a successful import completes any `data:import-due` action". No backend rule raises that action yet, so today it is a no-op.
- **Refused imports.** The CSV modal shows the server's `error` and a table (row, date, what to fix) above the preview, and the CAS flow a card titled with the `error` above its preview. The preview stays so the user can untick rows and commit again. The L2 one-line `errorMessage` is the toast in both.
- **Import tiles.** The CAS, Kite and EPF tiles still open one flow at a time, as before. They now also write `?source=` (replaceUrl), scroll the flow into view and move focus to it, which matters on phones, where the flow sits below four stacked tiles. The LenDen tile reads "LenDen P2P reports · opens on P2P" and links `/p2p?import=lenden`. The Transactions CSV modal links its Kite hint to `/import?source=kite`.
- **Add sheet.** The "Import a statement" tile spans both columns with a dashed border after the 11 kind tiles. It shows only to writers and never on an edit. It closes the sheet (`done`) and navigates to `/import`.
- **Checked on a mocked API** (development build, fake token, synthetic 137-row ledger; `scratchpad/w7f7_mock.py`, `w7f7_boot.js`, `w7f7_check.py`) at 1280 px and in a 390 px iframe. The checks covered paging, the debounced search (one request for four keystrokes), both sort directions with `aria-sort`, four filters in one request, a page past the end, a bad `from` (400), the empty ledger, guests, a CSV 400 table plus toast, a CAS 400 table plus toast, a wrong file type, the drag-over state, Enter and Space on every zone (CSV, CAS, Kite and EPF), multi-file drops reaching the Kite and EPF previews, the tiles and URL, and the Add-sheet tile for writers and its absence for guests. One h1 and no horizontal overflow throughout.
- **Harness note for later mocks:** other builders' mock servers listen on 4790–4793, so pick another port range.

### W7-B1 builder decisions (plan wiring, compare, sensitivities, per-member read)

These close gaps R3 to R7 and R11 leave open. They bind the integrator's R2 merge and W7-F2.
- **Validator messages (R5).** `scenarios.validate_scenario` raises `ScenarioError` (a `ValueError`) with `.field` and the message "{field} {problem}". `validate_saved(value)` wraps an entry's error as "Scenario {n}: {field} {problem}" with n 1-based, and it requires `name`, `sip` and `step`, matching the W7-B2 build notes. `POST /plan/compare` words its 400s the same way ("Scenario 2: sip must be between 0 and 1e+08", "Scenario 1: no saved scenario at index 0"). JSON numbers only; a lump `date` is exactly `YYYY-MM-DD`. When it makes `_plan_scenarios` call `validate_scenario`, the integrator keeps W7-B2's message text where `test_settings_p2.py` pins it.
- **A mix with unchanged flows (R5 over R6).** When `sip` and `step` both equal the baseline's, the money flows exactly as the baseline's, even when `mix` is set: the mix scales the positions only. A changed SIP is split by the mix. This is what makes "mix = today's gives 0 deltas" hold exactly. The split goes through a new keyword-only `sip_weights` ({Book key: share}) on `project_portfolio` and `retirement_plan`, beside `extra_flows`. It is additive, and None keeps every existing call unchanged.
- **Column memo, in three parts.** A column is `scenarios.run_projection`, `run_retirement` and `run_goals`. Each part is memoised on only the fields it reads: the projection on `sip`, `step`, `return`, `lump_sums` and `mix` (plus H); retirement on every field; goals on `sip`, `return` and `mix`. Each key also holds the baseline, sims, today, hash and perf_ready. The projection's own inflation feeds only `real_p50` and its assumptions block, and compare reads neither outside column 0, so a column runs the projection at the plan's default inflation. The baseline's parts are shared by every compare and by `/plan?detail=1` on the same day. "Retire 2 years later" and "Inflation 1 point higher" re-run only retirement, and the sims are never cut (A5). The whole compare keeps R6's key on top. Retirement runs first, so bad ages fail before anything else is simulated.
- **Compare reads warm history only.** Like `/plan`, compare and sensitivities use the ALL metrics only when already warm (`perf_ready` in every key). They never build market history.
- **Payload extras.** `PlanCompare` also carries `years` (H). Achieved goals are left out of the goal rows. Ties in the "worst baseline first" order break by goal name. A column whose `retire_age` is not after `current_age` is a 400 naming the problem.
- **Sensitivities.** `returns` reads μ* from `blended_assumptions` with the base Book, which is the baseline projection's `requested_return_pct`. `retire` caps at 110. Without goals, `worst_goal_pts` is null. If the sensitivities fail, `/plan?detail=1` still answers, with `sensitivities: null` and the note "What moves the needle couldn't be worked out right now".
- **`/sips` history.** A skipped instalment adds nothing to `planned` (as `planned_this_month`), and what was invested still counts.
- **`stress_detail` plan hash** also holds the SIP-to-goal links, because a link moves a goal's flows in `plan_impact`.
- **`optimizer._DEFAULT_BOOK`** stays as the `book=None` fallback, so existing calls keep their numbers. A given `book` always wins.

### W7-F2 builder decisions (Plan P2: what moves the needle, scenarios, money lasts, calibration)

- **Tabs.** `scenarios` ("Scenarios", icon `layers`) joins `TABS` and `planTabOf`. Every other value, `outlook` included, still reads Overview. With four tabs, the tab icons hide at ≤ 480 px so the row fits a phone.
- **When `/plan?detail=1` loads.** The shell counts settled loads in a `settled` signal, bumped after `/plan` and then the default `/forecast` have both answered for the current scope. Overview loads `?detail=1` on the macrotask after `settled` moves, so it never competes with T0. It refetches only when the `/plan` payload or the scope changed since the last answer. Saving a scenario bumps the store version, but the plan is unchanged, so it does not refetch. While a newer answer loads, the last one stays on screen, faded.
- **The card's states.** Skeleton tiles while loading. An error shows a notice with Try again. If the server sends `sensitivities: null` (W7-B1's failure path), the card shows its note ("What moves the needle couldn't be worked out right now") with Try again. An answer with no `sensitivities` key (a wave-6 server) or an empty list leaves the card out. An empty plan has no card.
- **Tiles.** Each tile shows the label, "Retirement ±n pts" and "{worst goal} ±n pts". Points are whole numbers ("+6 pts", "−4 pts", "±0 pts"), coloured by sign, with est. on any non-null value. Null reads "—" with no est. The worst goal is named on the client: the goal that is not yet achieved, with the lowest `projection.probability`, and ties broken by name (W7-B1's order). With no such goal the line reads "Your goals".
- **"Try it".** It is off, with a one-line reason, when the scenario equals the resolved `baseline`. That covers R7's `retire` without a saved retirement plan ("Save a retirement plan to try this") and anything else identical to today's plan. It is also off when both point values are null: "Save a retirement plan to try this" for `inflation` and `retire`, because inflation moves only retirement (goal targets are nominal), and "Add a goal or a retirement plan to compare" otherwise. Otherwise:
  - A writer with fewer than 5 saved scenarios saves `{...scenario, name: label}` (cut to 40 characters). If an identical scenario is already saved, nothing is written and that one is focused.
  - A guest, or a writer at 5, gets a session entry. It lives in a module-level signal in `scenarios.component.ts`, is keyed by `store.scopeKey()`, and lasts until a reload. Fields equal to the baseline are sent as null (`partialAgainst`), so the entry follows later changes to today's plan. An identical session entry is reused.
  - Either way, `pendingFocus` makes the Scenarios tab open with only that scenario ticked, and the page navigates to `/plan?tab=scenarios`.
- **Scenarios: selection and requests.**
  - Until the user picks, the first `limit` items are ticked (4, or 2 for guests; saved scenarios first, then session ones). The picks are remembered per scope for the session.
  - Saved scenarios go by index. Session scenarios go inline. When any inline body leaves `sip`, `step` or `lump_sums` to the baseline, the request goes through `api.post('/plan/compare')`; otherwise it uses `api.planCompare`.
  - The first compare runs at once. Later changes are debounced 300 ms, and a store-version bump re-runs the compare. A failure with an earlier result keeps that result and shows a "Showing the last one" notice with Try again. A failure with nothing to show gets the error card.
  - The empty state reads "Try a change from What moves the needle, or add one", with a link to Overview and, for writers, "Add a scenario".
- **The table.**
  - `inr` values are compact ₹, `pct` values are whole %, `age` values are years, and `pts` values are points. Each delta sits under its value. A `pct` or `pts` delta reads as whole points, an `inr` delta under ₹1 reads "no change", and an age delta reads in years.
  - Colour: ▲/▼ is positive when the delta is good. A lower `needed` is good. `retire_age` is a choice, not an outcome, so its delta stays neutral.
  - The row header is sticky, so the table scrolls sideways inside its own wrapper at 390 px. The `inr` rows carry est., and the footer repeats the server's p50 honesty line.
- **The chart** draws the baseline band (`band.p10`–`band.p90`, labelled "{column 0}: 8 in 10 futures") and one p50 line per `paths` entry. Column 0 shares the band's colour, and the others take `--s2`, `--s7`, `--s3` and `--s5`.
- **The editor (writers).**
  - Name, SIP and step-up are required; name must be 1–40 characters (R5, W7-B2's required trio). Return, retire at and inflation may be blank, which keeps today's value. There are up to 10 lump sums of {date, amount}. The client checks every R5 range before saving.
  - "New" is prefilled from the baseline: the server's once a compare has answered, else `localBaseline(settings, the plan snapshot)` built by R5's rule. "Edit" fills a saved scenario's nulls from the baseline. A session entry can be saved for good with "Save", which swaps its tick to the new saved index.
  - `mix` is carried unchanged, with a link to Risk & mix. Delete asks first and remaps the ticked saved indexes. Add and Save are off at 5 saved.
- **Retirement.**
  - The lasts line sits inside the verdict card, right under the probability, and is coloured by `statusFromProbability(probability_lasts)`. The card's sentence follows it.
  - `path_bands` are matched to `path[]` by age. The chart draws the band only when at least one age matches, and the card hint and aria label mention it only then.
  - The `sources` line reads "…; ₹d earmarked for goals and the cushion is left out", because K10's `excluded` covers both (R15's wording names only goals). With `excluded` 0 the clause is dropped.
- **Goal cards.**
  - "Funded by n SIP(s) · ₹X/mo" counts the running linked plans (`monthly_equiv > 0`; all of them when none run) and adds their names when there are 1–3. The card's "SIP now" figure and the short-of-target check use `linked_monthly` when the source is `linked`.
  - A linked goal that falls short offers "Raise a linked SIP on Recurring →" instead of editing the goal's own `monthly_contribution`, which no longer drives its projection.
  - The link hint shows only to writers, only for `contribution_source: 'goal'` goals not yet achieved, and only when `sip.plans_monthly_total > 0`.
- **After tax.** "Show after tax" lives in Adjust (off by default) and counts as a change from the defaults. So the shell's T0 tile keeps its pre-tax default call, and the fan fetches its own `after_tax=1` projection, which Reset turns off. The side panel adds "If sold at the end, after tax": p50 with est., then p10 and p90, then `note`. A payload without `end.after_tax` reads "After-tax figures aren't available for this projection." The bands and the other figures stay pre-tax.
- **Calibration (a deviation in wording only).** R15 says the section "appears only when `calibration?.show`", but that flag is known only after the lazy `/assumptions` call. So the collapsed "How our ranges held up" summary is always there, and opening it loads `/assumptions` once. The coverage line and the rows table (month, range, what happened, ✓/✗) show only when `show` is true. When `show` is false the panel says how many of the 6 needed months have matured. When `calibration` is null (performance not warm) it says the check needs the performance history and links Performance. A failed load shows Try again. Ranges and realised growth are factors shown as % changes.
- **Checked on a mocked API** with a development build, a fake token and synthetic payloads (`scratchpad/w7f2/mock.py`, `boot.js`, `check.py`, ports 4891+). Each case ran at 1280 px and in a 390 px iframe:
  - Overview as a writer with 1 saved and with 5 saved, and as a guest. This covered the tiles, the request order (`detail` after `/plan` and `/forecast`), the after-tax request and figures, calibration with `show` true, false and null, and Try it, which saved for a writer and kept the scenario for this visit for a guest or a writer at 5.
  - The Scenarios tab: writer, guest (2 compared, 500 sims), empty for writer and guest, the editor (validation, save with a lump sum, delete with re-indexing), and a 500 followed by Try again.
  - Retirement with and without `depletion_age_p10`, plus sources and bands. Goals, linked and unlinked, for writer and guest. An unknown `?tab`, no retirement plan (Try it off for `retire`), and `sensitivities: null`.
  - Every case had one h1 and 0 px horizontal overflow.

### W7-F6 builder decisions (Settings P2: assumptions, digest toggle, per-member)

- **"Only the changed rows" keeps the other saved overrides.** `PUT /settings/assumptions` replaces the whole setting, so sending only the edited rows would silently drop every other saved override. The body is: the rows changed here, plus every saved override that was not dropped (including a saved key the view did not list), and never an untouched default row, because sending it would freeze today's default as an override. Each sent row carries both `return_pct` and `vol_pct` (R4).
- **Inflation is sent when it was saved before or now differs from the Book's value.** Always sending it would turn the default 6% into an override, and the footer would then wrongly say "inflation changed from the defaults". An emptied inflation input drops the saved override (it falls back to the default); empty is not an error, but out of 0–15 is.
- **Per-row "Use default".** A row with a saved override has a "Use default" button that marks it to be dropped on the next save ("Goes back to the default when you save", with "Keep mine" to undo). "Reset to defaults" sends `null` after a confirm and clears everything.
- **Holding-rate rows.** When the row's `source` is 'holding rates' and its key is Fixed Deposits, EPF or P2P, the return reads "{rate}% · from your holdings" and its volatility stays editable. When only the volatility changes on such a row, the row is sent with the saved return, or else today's rate in use, clamped to −5..25. The engines ignore that return while those holdings exist (R4). A saved override on a rated row also shows a "Your volatility" badge.
- **Hash.** The card head shows "Assumptions id {hash}" from `/assumptions`. After a save or reset, the page announces the hash from the first `/assumptions` load that starts after the save (the save bumps `store.version`, which reloads the Book): "Saved · Assumptions id {hash} · Every forecast now uses these." Any new edit clears the announcement. A 400 shows inline as "Couldn't save the assumptions: {error}", and the draft is kept. A failed first load shows Try again. A failed reload keeps the last Book with a warning.
- **Draft lifetime.** A portfolio switch drops the assumptions draft and the announcement, because the draft belonged to the other settings owner.
- **Digest.** "Daily action digest (09:15)" is independent of "Watch my holdings" (it is never disabled by it). It is saved with the whole alerts object, `digest` always present as a boolean. "Needs alerts on this device." shows whenever `push.subscribed()` is false.
- **Per-member meta follows the W7-F1 staleness rule.** The page records the store `scopeKey` at which each settings object arrived. It reads `settings_owner` and `inherited` only when that equals today's `scopeKey`, so the previous scope's settings never drive a banner or a marker right after a switch.
- **Banners.**
  - "Editing the family plan" shows in the family view, and also in a member view whose `settings_owner` is `__global__` (a server that still writes the family plan).
  - "Saving to {member}'s plan" shows when `settings_owner` is a member email (or "your own plan" for the signed-in admin). The name comes from `auth.members()`. Guests see "Viewing {member}'s plan".
  - The shell's banner (W7-F1) also shows. The two agree in wording.
- **Inherited markers** are per card, via a key→card map: cushion `emergencyFund`; Tax `taxSlabRate`; Your plans `targetAllocation`/`riskProfile`/`retirementPlan`; Capital flows `autoCapitalFlows`; Alerts `marketAlerts`; Assumptions `assumptions`. Prices and Family carry no setting keys.
- **Guests** see the rows with no inputs or buttons, the inflation as "{x}% · your setting|default", and "Read-only for guests."
- **Checked on a mocked API** with a development build, a fake token and synthetic payloads (`scratchpad/w7f6_mock.py`, `w7f6_check.py`) at 1280 px and in a 390 px iframe. The cases were: writer (holding-rate rows, an out-of-range error that disables Save, then a save whose PUT body was checked and the new hash shown), overrides (Use default → PUT keeps the other row), reset (confirm → PUT null), digest on and off (whole alerts object), guest, an admin viewing a member with inherited keys (PUT carries `X-Portfolio`), a member view on a `__global__` owner, the family view, a 400 on save, and a 500 on `/assumptions`. All 22 passed, each with one h1, 0 px horizontal overflow and `#assumptions` landing at 70–90 px.

### W7 integrator decisions

- **One scenario validator (R2).** `analytics_api._plan_scenarios` now calls `scenarios.validate_saved` and turns its `ScenarioError` into a 400 with the same text, so a saved scenario and an inline compare scenario are checked by one function. W7-B2's duplicate `_plan_scenario` and its `SCENARIO_*` bounds are gone. The pinned messages hold ("Scenario {n}: {field} {problem}", n 1-based; `name`, `sip` and `step` required). A list over 5 now reads "planScenarios can hold up to 5 scenarios".
- **One settings_who (R2, R11).** `analytics_api._settings_who()` is deleted. GET/PUT `/settings`, and `POST /review/complete`, use `Services.settings_who()`, the same rule every engine reads.
- **`Services.notifications` deleted (R14).** `notices.notifications` serves the bell; `Services._market_notices` stays because `notices.py` calls it.
- **`taxSlabRate` PUT.** A value that is not a finite number is now a 400 ("Slab rate must be a number") instead of a 500. The range message is unchanged.
- **Plan types (R20).** `Plan.sensitivities`, `Plan.baseline`, `PlanCompare.baseline` and `PlanCompare.scenarios` are typed `| null` in `models.ts` (the W7-B1 failure path sends `sensitivities: null`). `PlanCompare.years` is added. W7-F2's `PlanDetail` and `PlanCompareResult` are now plain aliases of `Plan` and `PlanCompare`.
- **CSV refusal table.** The first column reads "Holding", since it shows the row's holding name (the server sorts rows by date before checking them, so a row index would not match the preview).
- **Checked against real payloads (R24).** Done on fresh copies of the scratchpad databases (`copy.db`, and W7-B1's `w7b1_measure.db` as an admin viewing the member who has the saved retirement plan), calling the view functions directly with stored prices only and no tokens. `/plan?detail=1`, `/plan/compare` (an inline SIP scenario and an inline `Proposed mix`), `/sips` (`history`: 12 months, oldest first), `/forecast/stress` (holdings with `beta`, `plan_impact`), `/rebalance?allow_sell=1` (`sells`, `covered`, `tax_if_sold`, `tax_total`, `tax_note`, `not_sold`), `/optimizer?profile=`, `/notifications`, `/settings` (`settings_owner`, `inherited`), `/assumptions`, `/pulse`, `/brief?since=` and `/transactions?page=` all return the keys their frontend types read. The bell's `act:` ids equal `/actions` tier now exactly. Every frontend API call site matches a Flask route, and every in-app link goes to a route in `app.routes.ts`.
- **Known gap, left open: two goal-probability engines.** The compare goal rows and stress `plan_impact` use the joint `simulate.run` goal specs (R6 item 3, K11). The Goals tab and `/plan` goal cards use `goals.project_goal`. On the measured copy, one goal reads 5.6% on Goals and 0.8% in the Scenarios baseline column. Both follow their spec, but the same goal shows two chances on two tabs. Aligning them changes an engine, so it needs a decision.


### W7 review fixes

- **A changed SIP over the plans keeps their shape (amends R5).** When today's plan runs on the SIP plans (no typed `retirementPlan.monthly_sip`) and a column changes `sip` or `step`, the column no longer becomes one flat monthly amount. Every plan instalment is scaled by sip / baseline sip and by (1 + step) / (1 + baseline step) for each whole year from today. So each plan keeps its own step-up, end date and future start, and the goal flows already scale the same way in `run_goals`. It is `scenarios.plans_adjust`, carried by the new keyword-only `plans_scale` / `plans_step_pct` on `forecast.project_portfolio` and `forecast.retirement_plan` (`simulate.adjust_flows`). The defaults (1, 0) change nothing.
  - With a `mix`, `sip_weights` now also re-splits each month's plan total on the plans basis, which keeps R6's "a changed SIP is split by the mix". On the plans basis without `sip_weights`, the lump sums still follow the plans' split.
  - A typed SIP (L5), and a baseline with no plan running today (sip 0, nothing to scale), keep R5's one-amount rule.
  - The old rule dropped a 10% plan step-up, so "SIP +₹5,000" read −2.2 retirement points and −₹2.39 Cr typical on the measured copy. After the fix it reads +2.4 points and +₹78.8 L.
- **A SIP within ₹1 of the baseline's is unchanged (R5).** `flows_unchanged` tolerates a difference under ₹1 (`SIP_TOLERANCE`), and `run_goals` then scales by 1. The client's `localBaseline` rounds the SIP to the paisa, as the server does, so a weekly plan's ₹4,333.33 is no longer prefilled as ₹4,333 and saved as a changed SIP.
- **`/plan` `sip` with linked goals (H6, K15).** A goal whose projection has `contribution_source` 'linked' contributes its `linked_monthly`, in both `goals_monthly_contribution` and the per-goal gap. Its own `monthly_contribution` no longer counts. The Goals strip and review step 4 show the real shortfall.
- **Sensitivities name their goal (R7).** Each item carries `worst_goal` {id, name}, the compare goal row its `worst_goal_pts` reads (null without goals). The needle tile shows that name. The client-side `worstGoalName` guess, from `goals.project_goal`, is gone: that engine can order the goals differently from the compare's joint run.
- **Inflation needs a retirement plan to try (R7, W7-F2).** "Inflation 1 point higher" is untryable whenever `retirement_pts` is null ("Save a retirement plan to try this"), even when the goal delta is 0. Goal targets are nominal, so the goal delta is 0 rather than null.
- **Review concentration follows `insights.py` (amends R17's 12%).** Step 3 lists a stock or commodity at ≥ 15% of the portfolio and a mutual fund at ≥ 25%. When the action list already holds that `concentration:<id>` open or planned, the lines drop to 12% and 22%. Every concentration row the review lists therefore has an action that step 5 can plan. The classes stay W7-F4's {equity, mutual_fund, commodity}.
- **Known gap, left open: retirement probability on the stress card.** `forecast._plan_impact`'s retirement "before" is an accumulation probability on the whole portfolio. Plan, the brief and the Retirement tab use `retirement_plan`, which funds retirement from EPF, NPS and free money only, with the glide. On a measured copy, Plan read 50.3% and the stress card's "before" read 54.0%. This is the same issue as the two goal-probability engines above, and it needs the same decision. Until then, the stress card's est. basis says the figures cover the whole portfolio and may differ a little from Plan's. Applying a cross-engine delta to Plan's number was rejected, because points do not carry over between engines (for example 0.8% → 0.3% against 5.6%).


## Final pass

- **A plan linked to a goal does not fund retirement (amends K10/L5; closes the W7 review note on `_plan_sip`).** When `forecast.retirement_plan` is given `funding` (the earmarked money is already left out), it also leaves out every SIP plan with a `goal_id`, both from the simulated flows and from the deterministic monthly figure (`inputs.monthly_sip`). This is the same rule stress `plan_impact` already applies with `goal_only` flows. Before, one ₹10,000 plan linked to a goal was subtracted twice in `/plan` `sip.gap_monthly` (once as the goal's `linked_monthly`, once as retirement's `inputs.monthly_sip`), and retirement's projection counted money the goal also counted. Without `funding` (the whole-portfolio fallback), every plan still counts. On a synthetic plan over the copy database, `gap_monthly` moves from ₹1,40,826 to ₹1,43,199 (correct: ₹34,220 + ₹23,799 − ₹10,000 + ₹95,180). In compare, `plans_scale` still scales every plan in proportion, so a linked plan's share of a changed SIP reaches its goal (as `run_goals` scales it) and only the unlinked share reaches retirement. When every plan is linked, "SIP +₹5,000" moves the goals and leaves retirement where it was. Pinned by `test_retirement_with_funding_leaves_out_plans_linked_to_a_goal`.
- **`review:due` opens the review (amends G-wave "review:due unchanged").** The insight's link, and the action's fallback link, is now `/actions?tab=review` (W7-F4's wizard) instead of `/risk#rebalance`, so the action, the brief's context line and the bell lead to the same place. The id, the 90-day rule and the "Mark review done" CTA are unchanged. `test_insights` and `test_links` pin the new link.
