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
| 2 | Portfolio (grouped list), holding bottom sheet, Add sheet | pending |
| 3 | Analysis: Mix (+rebalance), Returns (+contributors), vs Market, Improve | pending |
| 4 | Activity: Entries, Entry flow (trace), Checks, Rules | pending |
| 5 | Calculation fixes (FD payouts, P2P split/defaults, unpriced/EPF history, one XIRR) + speed | pending |

## Frontend map (new)

- Tokens and `.v-*` classes: end of `frontend/src/styles.scss` (violet, Plus Jakarta Sans, group colours `--g-<group>`).
- `core/groups.ts` (group colours, icons, labels), `core/format.ts` (`money`, `pctV`, `ago`, `monthTicks`).
- `shared/v2/charts.ts`: `v-area`, `v-spark`, `v-donut`. Icons added to `shared/icon.component.ts` (Lucide).
- `layout/shell.*`: sidebar (desktop), floating tab bar (phone), family switcher, bell, menu (Tax, Reports, Settings,
  classic tools when `advancedFeatures`). Route `data.shellTitle: true` makes the shell show the page title.
- `features/home/home.component.ts`: Home. The old Home lives at `/classic`.
- Approved mockups: `design/redesign/mockups/*.png`.
- Screens are checked with `backend/scripts/demo_seed.py` (fictional data, offline) + Playwright screenshots.

## Backend map (new)

- `tracker/domain.py`: `GROUPS`, `GROUP_LABELS`, `group_of`, `groups_from_segments`.
- `tracker/analytics/portfolio.py`: every position has `group`; `external_flows()` is the one flow rule.
- `tracker/analytics/overview.py`: `group_view` (totals, groups, targets, market comparison), `suggested_mix`,
  `rebalance`, `suggestions`.
- `tracker/services.py`: `bench_history`, `overview`, `group_rebalance`.
- `tracker/api/overview_api.py`: `GET /api/overview`, `GET /api/overview/rebalance?new_money=&allow_sell=1&targets=mine|suggested`.
- Settings keys added: `groupTargets`, `advancedFeatures`, `p2pDefaultRecovery`.
- Tests: `tests/demo_book.py` (sample book), `tests/test_golden.py` (frozen numbers; regenerate with
  `UPDATE_GOLDEN=1` only for intended changes), `tests/test_overview.py`.

## Known calculation issues (Phase 5 will fix; golden file shows them)

- Totals XIRR (7.36%) ≠ history ALL XIRR (7.69%) on the sample book: valuations differ between the two engines.
- FD interest payouts double-counted in history; history keeps compounding past maturity.
- P2P legacy repayments (no principal split) count as 0 principal in history; defaulted loans at full value.
- Unpriced holdings (NPS) and EPF accrual jump onto the last day of history.

## How to run checks

```
cd backend && python -m pytest -q          # ~1 min, offline
cd frontend && npx ng build                # strict templates
```
