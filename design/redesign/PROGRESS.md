# Redesign progress (read this first when resuming)

The owner approved a simpler, phone-first redesign (Nov 2026). Mockups were reviewed as images; this file is the
running record of what is built, so a new session can continue without re-deriving anything.

## Decisions (from the owner)

- **Four main pages**: Home · Portfolio · Analysis · Activity, with **+ Add** in the middle of the phone tab bar.
  Tax, Reports and Settings sit under "More" (desktop sidebar / phone menu). The family switcher stays.
- **Switched off, not deleted**: Plan/Goals/Retirement, Markets, Actions inbox, Risk & mix (old), Recurring,
  Cash flows, the bell digest and AI. Their routes stay; the setting `advancedFeatures` (Settings) shows them again.
- **Seven groups** (`domain.GROUPS`): India stocks, Global stocks, Mutual funds, P2P, Commodities, EPF, Others
  (FDs, NPS). The USD broker wallet sits in Global stocks (it is that account's cash; its rupee transfers are the
  account's external flows, so returns stay correct).
- **Targets**: both the owner's own (`groupTargets`, falls back to the old `targetAllocation` summed into groups)
  and a suggested mix from risk profile + age (`overview.suggested_mix`).
- **Mostly used on a phone.** Design: violet accent (#6A46F5), Plus Jakarta Sans, rounded cards, one colour and
  icon per group, green/red only for gain/loss, amber for attention.
- Commit and push to `claude/epic-euler-9h92ln` after each phase (owner asked that finished work never be lost).
  No pull request unless asked.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Group model, overview engine + API, settings keys, golden-number tests, this file | done |
| 1 | New design tokens + font, new shell (sidebar / floating tab bar), Home | done |
| 2 | Portfolio (grouped list), holding bottom sheet, Add sheet | done |
| 3 | Analysis: Mix (+rebalance), Returns (+contributors), vs Market, Improve | done |
| 4 | Activity: Entries, Entry flow (trace), Checks, Rules | done |
| 5 | Calculation fixes (FD payouts, P2P split/defaults, unpriced/EPF history, one XIRR) + speed | done |

## Frontend map (new)

- Tokens and `.v-*` classes: end of `frontend/src/styles.scss` (violet, Plus Jakarta Sans, group colours `--g-<group>`).
- `core/groups.ts` (group colours, icons, labels), `core/format.ts` (`money`, `pctV`, `ago`, `monthTicks`).
- `shared/v2/charts.ts`: `v-area`, `v-spark`, `v-donut`. Icons added to `shared/icon.component.ts` (Lucide).
- `layout/shell.*`: sidebar (desktop), floating tab bar (phone), family switcher, bell, menu (Tax, Reports, Settings,
  classic tools when `advancedFeatures`). Route `data.shellTitle: true` makes the shell show the page title.
- `features/home/home.component.ts`: Home. The old Home lives at `/classic`.
- `core/overview.service.ts`: one shared copy of GET /overview (Home, Portfolio, Analysis).
- `features/portfolio/portfolio.component.ts`: `/portfolio?group=&holding=`; Equity card joins India + Global.
- `shared/v2/holding-sheet.component.ts`: one holding (Overview, Lots, Entries, Calculation); bottom sheet on the
  phone, right panel on desktop. `core/holding-view.ts` describes each kind of holding in one line.
- `features/analysis/analysis.component.ts`: `/analysis?tab=mix|returns|market|improve`. Mix edits `groupTargets`,
  `riskProfile` and `retirementPlan.current_age`; rebalance uses GET /overview/rebalance.
- `features/activity/activity.component.ts`: `/activity?tab=entries|flow|checks|rules&txn=&instrument=`.
- `shared/v2/add-sheet.component.ts`: the + sheet (pick a kind, then the existing transaction form opens on it).
- Approved mockups: `design/redesign/mockups/*.png`.
- Screens are checked with `backend/scripts/demo_seed.py` (fictional data, offline) + Playwright screenshots.

## Backend map (new)

- `tracker/domain.py`: `GROUPS`, `GROUP_LABELS`, `group_of`, `groups_from_segments`.
- `tracker/analytics/portfolio.py`: every position has `group`; `external_flows()` is the one flow rule.
- `tracker/analytics/overview.py`: `group_view` (totals, groups, targets, market comparison), `suggested_mix`,
  `rebalance`, `suggestions`.
- `tracker/services.py`: `bench_history`, `overview`, `group_rebalance`.
- `tracker/analytics/history.py`: `inst_value()` per holding; series rows carry `groups`; result has `contributors`.
- `overview.market.series`: the same-money-in-the-market value at each month end.
- `tracker/analytics/trace.py`: `trace_txn` (steps, each naming its code) and `data_checks`; `Ledger.cash_rules()` runs
  `_auto_cash` on samples so the Rules table always matches the code. API: `/api/trace/txn/<id>`, `/api/checks`, `/api/rules`.
- `RealizedLot.sell_txn_id` links a realized lot to its sale.
- `tracker/api/overview_api.py`: `GET /api/overview`, `GET /api/overview/rebalance?new_money=&allow_sell=1&targets=mine|suggested`.
- Settings keys added: `groupTargets`, `advancedFeatures`, `p2pDefaultRecovery`.
- Tests: `tests/demo_book.py` (sample book), `tests/test_golden.py` (frozen numbers; regenerate with
  `UPDATE_GOLDEN=1` only for intended changes), `tests/test_overview.py`.

## Calculation fixes (phase 5)

Done (golden numbers regenerated on purpose; history and portfolio now agree on value today and on XIRR):
- FD: `portfolio.fd_value` shared by both engines; payouts no longer double-counted, no growth past maturity.
- P2P: `portfolio.p2p_repaid` shared (legacy repayments estimated the same way); defaulted loans count at
  `p2pDefaultRecovery` % (default 0, written down from the due date).
- Unpriced holdings (NPS, missing history) move in a line from cost to today's price instead of jumping.
- EPF history includes interest not yet credited.
- History ALL: starts empty; the first day's money is a flow (first-day loss kept), so XIRR matches the totals.
- Today in history uses the same last prices and USD/INR as the portfolio (`build_history(usd_inr=...)`).
- `Services.peek_performance(scope)` reads the cached ALL history (key includes the recovery setting).

Not changed (owner to decide): Kite imports still leave brokerage/STT/stamp duty out of cost (the tradebook has no
charges); automatic cash rules unchanged but now shown on Activity › Rules with notes on the gaps.

## Owner review fixes (25 Nov 2026)

- Every percentage now says what it is: "a year" = XIRR on the money put in; market differences are in
  percentage points ("pts"). Group cards: market groups show gain on current cost; P2P, EPF and Others show the
  yearly return (their "gain ÷ money put in" shrinks its base with each repayment or withdrawal).
- EPF shows interest earned in rupees (credited + due since the last credit), not "% of contributions".
- P2P: EMIs on the 5th up to the maturity date; `portfolio._p2p_schedules` reads EMIs paid from principal repaid
  against the loan's own schedule, measured on the latest repayment date recorded (`data_as_of`).
- `xirr` picks the root nearest 10% (like Excel) when flows switch sign many times.
- `GET /api/overview/group/<key>` + `shared/v2/group-sheet.component.ts`: how a group's numbers are worked out.

- US stock dividends (owner has a USD wallet) are paid into the wallet: they raise its USD balance, are not an
  external cash flow, and make no "money out" cash entry; migration 007 removes the old automatic ones.
  `portfolio.usd_of()` converts US amounts without a USD figure at the owner's weighted-average deposit rate
  (`portfolio.deposit_rates`: Σ ₹ ÷ Σ $ of FX_IN; today's rate only when there are no deposits), in both engines.

- Look v2.2: colourful backdrop (violet/pink/mint/peach) with frosted-glass cards (`styles.scss` end); no plain white.
- Speed: `prices.history_fast` never blocks a read on the network for history it already has (stale symbols refresh
  in a background thread, then `ledger._bump()`); Home and Analysis draw charts from this device's last copy.

## Settings added to the Settings page (App & calculations)

- "Show the classic tools in the menu" → `advancedFeatures`.
- "Defaulted P2P loans count at N%" → `p2pDefaultRecovery` (default 0).

## Possible next steps (not started; ask the owner)

- Delete the switched-off pages for good once the owner confirms they are not missed.
- Kite tradebook: let the owner enter or estimate charges so cost includes brokerage, STT and stamp duty.
- Cash rules: decide whether stock and commodity trades, FD interest payouts and the interest part of P2P
  repayments should create cash entries (Activity › Rules shows the current behaviour).

## How to run checks

```
cd backend && python -m pytest -q          # ~1 min, offline
cd frontend && npx ng build                # strict templates
```
