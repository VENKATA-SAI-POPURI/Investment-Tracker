# Completeness critique of SPEC.md and WAVES.md

**Verdict:** REVISE BEFORE BUILD. The spec meets the brief: the priority ladder, tiers, real-₹ ranking, honesty copy, and engine fixes confirmed against the maps. Field names largely match the maps, and no two tasks in the same wave list the same file. But it should not run as written. Blocking fixes: (1) give one owner per wave the services.py wiring for every engine signature change (W1-B2/B3, W3-B4/B6, W6-B3/B4). (2) Make /brief peek or warm the same performance key Home fetches, or compute vs-Nifty in /brief. (3) Settle insight id stability against the period-keyed ids, the sip:missed dedupe, and dismissedInsights owner mapping. (4) Fix the deploy.suggested double-counting, the harvest auto-done threshold, the '/actions#deploy?new_money' URL and the missing #cushion anchor. (5) Add a global FD-mature dialog, the remaining link remaps (services, story, calendar), and the guest sims cap on /forecast. (6) Either reclassify the T1 sections on Risk, Tax, Performance and Recurring as T2, or redefine T1. (7) Drop or scope the frontend spec, CI and dark-mode promises, and restate the P0 timeline. After these, the plan is buildable.

## Missing

1. Wiring for engine signature changes has no owner. W1-B3 (portfolio_risk proxies need ^GSPC/GOLDBEES/USDINR histories plus ballast rates), W1-B2 (real_p50 needs retirementPlan.inflation_pct), W3-B4 (project_goal(goal, segments) has no positions, so it cannot split out MF_DEBT or use FD/EPF instrument rates for mu_sigma) and W3-B6 (book_key needs the position) all change what services.py must pass in. No task in those waves edits services.py, and W4-B1 does not list these changes.
2. W6-B3 and W6-B4 make goals.rebalance_plan and optimizer.suggest(port, profile) call tax.what_if_sale, which needs txns and instruments. No task changes the services or API callers.
3. The link remap only covers insights.py (W1-B4). Old routes are still emitted from services.py:292 (IPO notice '/markets?tab=ipos'), story.py:156/181 ('/analytics', '/goals') and calendar.py event links. §3.6 says services.py is remapped, and the link regression test only scans insights.
4. Nothing caps guest Monte Carlo on the existing GET /forecast (sims 200–5000 plus a free 'return' memo key, 4.4 s per run). §1.11 promises the cap, but only /plan/compare gets it, in W7.
5. The FD 'Mark matured' CTA (fd_mature) has no global dialog. The modal is local to fixed-deposits.component, TxnDialog has no MATURITY kind, and W4-F4 does not include action-runner.service.ts. As a result the Home and Actions CTAs cannot open it.
6. No task builds the §1.12 'Needs attention' strip for Plan (/plan, goal:, retirement:), Tax (tax:), Performance (perf:), Recurring (sip:) or Cash flows. The template says every deep page has one.
7. Performance Attribution reads story.attribution, but /performance does not carry story and Home no longer calls /pulse. The section has no data source.
8. Risk 'Preview impact' (W5-F2) needs mu_sigma of an arbitrary proposed mix. GET /optimizer only takes a profile and GET /assumptions only covers the current mix, so no endpoint exists. 'months_to_fix' (§5.6 Data NEW) is produced by no backend task.
9. Home Coming up 'suggest: {segment furthest under target}' has no field in the upcoming event schema {date, days, kind, title, amount, direction, link, key}.
10. P2.1 'Before/after-tax toggle': simulate has after_tax, but there is no /forecast or /plan parameter and no UI task in W7-F2.
11. GET /timeline (§5.10 P2) is not defined in §7.2 and no task builds it.
12. Holding-detail benchmark overlay (§5.5 P2) and the FD maturity ladder (§5.7 P2) have no task. The Reports default of 'summary' (§5.13) has no task.
13. Daily digest: no task edits .github/workflows/market-scan.yml to call /jobs/daily-digest at 03:45 UTC. W7-B1 also omits __init__.py, where public paths are allowlisted, so the job token route returns 401.
14. §10.1 promises specs for priority.ts, ActionRunnerService and ActionService, and 'the speed test blocks merge'. There are 0 spec files, no frontend test runner is configured and no CI test workflow exists, and no task creates any of them.
15. Cushion (a P1 T1 vital) has no INR bank or savings class, so most Indians' real emergency money cannot be ticked. Either P3 net worth has to move up, or a manual 'cash' balance is needed.
16. Rebalance and Deploy work at segment level only. Nothing suggests which holding or fund to buy, which investors expect from 'Plan reinvestment'. MF-specific checks investors expect (expense ratio, direct vs regular, fund overlap) are neither covered nor listed as non-goals.
17. P2.6/P2.10: the dark-mode task (W7-F1) touches only styles.scss, the shell and ui.ts. The frontend map lists hex literals in chips, badge[data-type], kpi pos/neg and chart markers, and no task tokenises them.
18. Kite imports leave brokerage, STT and stamp duty out of cost. Tax what-if, harvest plans and auto-done ₹ figures inherit the inflated gains, and nothing fixes this or labels it.
19. §5.13: the Plan page never handles the ?return= query param that the Performance 'assumptions check' link sends.

## Contradictions

1. Home vs Nifty and the assumptions check never resolve. /brief only _peek's ('performance', scope, 'ALL', None), but Home lazily fetches /performance?range=1Y, which warms a different memo key. The market card stays 'pending' unless someone opens Performance on ALL, and the fallback mixes ranges: a 1Y excess beside an ALL-based diff_value.
2. Insight ids: W1-B4 and W3-B7 say 'ids stay stable', but §8.3 changes the existing 'tax:ltcg-harvest', 'review:due' and 'sip:missed:<sid>' to 'tax:ltcg-harvest:<fy>', 'review:due:<YYYY-Qn>' and 'sip:missed:<sid>:<due>'. Migrated dismissedInsights rows then stop matching.
3. Two sources emit sip:missed: the existing insights rule (monthly-only, id sip:missed:<sid>) and the new plans rule (sip:missed:<sid>:<due>). No dedupe rule is specified.
4. dismissedInsights migration: admin/guest rows are owned by '__global__', but §7.4 sets the status owner to instrument.owner for instrument actions. Migrated snoozes on concentration:<iid>, loser:<iid> and similar never apply.
5. Harvest auto-done can never fire. harvest_plan books gains up to remaining_exemption − ₹1,000, so a user who follows it exactly is left with remaining ≈ ₹1,000. The done rule requires remaining < ₹1,000.
6. Skipping a SIP: plans.sip_adherence(sips, txns, instruments, today, months) has no action-log input, yet 'skipped' is defined by action_log state. 'Skip this month' on an upcoming instalment posts a status for sip:missed:<id>:<d>, which does not exist yet (only sip:due exists). Whether set_action_status creates rows is undefined.
7. CTA URL '/actions#deploy?new_money=<amt>' (§4.3, §8.3) puts the query after the fragment, so Angular reads new_money as part of the fragment.
8. '/settings#cushion' is used by the Cushion vital and by cushion:low, but the Settings anchors are #profile #alerts #prices #people #assumptions #appearance.
9. deploy.suggested adds the USD wallet value and the maturity_value of FDs maturing within 30 days as new_money to rebalance_plan. That money is already counted in the Equity (USA) and Fixed Deposits segment values, so the total is double-counted and the 'after %' figures are wrong. The source segments must be netted.
10. §1.3 says T1 = striped verdict, vital and action cards, each with one number and one CTA, and charts and tables are T2. Yet Performance T1 is a line chart plus a table, Risk T1 is the profile buttons, the editable target table and the rebalance planner, Tax T1 is the harvest tables and the what-if form, and Recurring T1 is an instalment table. The tier grammar is not applied.
11. The Home 'Against the market' card is T1, which per §1.3 should be fetched in the same call and painted from the snapshot. Its status and sparkline depend on the lazy /performance (Q4 fetch), which contradicts §9.4.
12. BUY-matching windows differ. §6.5/W1-B2 retirement status needs ≥75% from the monthly MC (seed 7, 1000 sims), while required_sip_for uses 400 annual-step sims. The test 'probability 75 ± 3 with SIP = required_sip' is outside the combined sampling and discretisation error, so it is likely flaky. The same applies to goals in W3-B4.
13. Scenario schema {name, sip, step, return, retire_age, lump_sums} has no inflation or mix field. Yet W7-F2 'Try it' for the inflation +1 sensitivity and W7-F3 'Preview impact' of a target mix via /plan/compare both need them.
14. Vitals vs actions: the Risk vital is 'act' at est. vol > target+5, but risk:above-profile is severity warn, which maps to watch. Its close rule (≤ target+5) also leaves no action for the watch band (+2..+5).
15. §2 P0.6 has the shell render the route title as h1, while Home has its own hidden h1 and class pages set h1 = class name. That gives two h1s on every page.
16. 'brief.vitals.risk' (§5.6) is object access, but vitals is specified as an array of Vital {key, …}.
17. Notification 'seen' is defined twice: the seenNotices setting (§7.7) and action_log.seen_at plus POST /notifications/seen (§7.2, W6-B1).
18. Tax what-if price defaults to 'last_price', but positions expose 'price'. last_price exists only on the instrument row.
19. §1.11 and §7.3 say /brief 'never builds history', yet market_state needs ^NSEI daily closes for the 52-week high. Neither the source of nifty_points on the /brief path nor its cold cost is specified.
20. W6-B1 claims 'bulk_add commits atomically so CSV/CAS is all-or-nothing', but bulk_add is already atomic. The non-atomic row-by-row inserts are in ledger_api.py CSV/CAS commit, which W6-B1 does not edit.
21. Within-wave build dependencies on shared tasks marked 'RUN FIRST': W2-F1 routes lazy-import ActionsComponent and PerformanceComponent, which W2-F3 and W2-F4 create, so W2-F1's 'ng build passes' acceptance cannot pass on its own. W2-F4 deletes features/analytics/analytics.component.ts, which markets.component.ts still imports until W2-F5 runs.

## Not buildable as written

1. The schedule is not credible: 'P0 ≈ 2 weeks for two developers' covers waves 1–2, which means 6 new or rewritten backend engines, the /brief and /actions services, new navigation, and rewrites of Home, Actions, Performance and Markets, all with no frontend test harness.
2. Cold /brief < 800 ms in pure Python on Turso (HTTP per query) is optimistic. It needs portfolio, tax, goals at 1,000 sims each plus a 400×14 bisection per goal, retirement at 1,000 + 400 bisection, stress, optimizer current vol, a W4 projection_1y simulation for the snapshot, and an action_log upsert. Budget it as measured, not asserted.
3. Assert the 9×9 CORR with a hand-picked MF_DEBT row is positive definite before writing the 'Cholesky succeeds' test. Otherwise specify nearest-PD repair.
4. simulate.run, 30 years × 1,000 sims in ≤1.0 s in pure Python, is unlikely once per-sim FD/P2P release routing ('to the segment furthest under target' is path-dependent), after-tax, goals from the same draws and glide rebalancing are added. Quarterly and yearly steps also conflict with monthly SIP flows, March EPF credits and month-level milestone median_months.
5. The frontend specs and the 'speed test blocks merge' claim need a test runner (Karma or Jest) and CI that the repo does not have, and no task adds them.
6. Full dark mode (P2.9) cannot be delivered from styles.scss alone while component-level hex literals remain.
