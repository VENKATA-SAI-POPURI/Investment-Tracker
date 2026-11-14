import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ActionService } from '../../core/action.service';
import { kindFor } from '../../core/action-runner.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { AssetClass, SipHistoryMonth, SipInstalmentStatus, SipPlan, SipsResponse, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { RebalancePlannerComponent } from '../../shared/rebalance-planner.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { GoalRef, INSTALMENT_BADGE, InstalmentBadge, SipPlansComponent, instalmentBadge } from './sip-plans.component';

/** The asset class behind a segment plan (a plan with no holding), for the add dialog's kind (J10). */
export const SEGMENT_CLASS: Record<string, AssetClass> = {
  'Equity (India)': 'equity', 'Equity (USA)': 'equity', 'Mutual Funds': 'mutual_fund', 'Commodity': 'commodity',
  'P2P': 'p2p', 'Fixed Deposits': 'fixed_deposit', 'EPF': 'epf', 'NPS': 'nps',
};

/** The H11 habit thresholds: ≥ 90 good, ≥ 60 watch, below 60 act; `unset` with no score or no active plan. */
export function adherenceVerdict(pct: number | null | undefined, activePlans: number): { status: Status; text: string } {
  if (activePlans <= 0) return { status: 'unset', text: 'No active plan, so nothing to score' };
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return { status: 'unset', text: 'Adherence not scored yet' };
  const status: Status = pct >= 90 ? 'good' : pct >= 60 ? 'watch' : 'act';
  return { status, text: `Adherence ${Math.round(pct)}% over 6 months` };
}

/** One instalment of an active plan in the current month, joined to its plan (J10). */
export interface InstalmentRow {
  key: string; sid: number; plan: SipPlan | null; name: string; due: string;
  planned: number; invested: number; status: SipInstalmentStatus; badge: InstalmentBadge;
}

/**
 * "This month's money" instalments: every active plan's `adherence.plans[].months[]` rows whose `month` is the
 * current YYYY-MM, all frequencies (a weekly plan gives several), sorted by `due` then plan name.
 */
export function monthRows(r: SipsResponse | null | undefined, todayIso: string = today()): InstalmentRow[] {
  const ym = todayIso.slice(0, 7);
  const byId = new Map((r?.plans ?? []).map(p => [p.id, p] as const));
  const rows: InstalmentRow[] = [];
  for (const a of r?.adherence?.plans ?? []) {
    const plan = byId.get(a.id) ?? null;
    if (!a.active || (plan && !plan.active)) continue;
    for (const m of a.months ?? []) {
      if (m.month !== ym) continue;
      rows.push({ key: `${a.id}:${m.due}`, sid: a.id, plan, name: plan?.name || a.name || `Plan ${a.id}`, due: m.due,
        planned: m.planned, invested: m.invested, status: m.status, badge: instalmentBadge(m, todayIso) });
    }
  }
  return rows.sort((x, y) => x.due.localeCompare(y.due) || x.name.localeCompare(y.name));
}

/** The action id "Skip this month" posts to (A11): `sip:missed:` once missed, `sip:due:` otherwise. */
export function skipId(row: Pick<InstalmentRow, 'sid' | 'due' | 'status'>): string {
  return `sip:${row.status === 'missed' ? 'missed' : 'due'}:${row.sid}:${row.due}`;
}

/** The Record prefill (J10): what is still to invest, dated on the due date once it has come, else today. */
export function recordPrefill(row: Pick<InstalmentRow, 'planned' | 'invested' | 'due'>, todayIso: string = today()): { amount: number; date: string } {
  const amount = Math.max(0, Math.round((row.planned - row.invested) * 100) / 100);
  return { amount, date: row.due <= todayIso ? row.due : todayIso };
}

/** One month of T3's planned-vs-invested bars, with each bar's height as a share of the tallest month. */
export interface PvMonth extends SipHistoryMonth { label: string; current: boolean; plannedPct: number; investedPct: number; title: string; }
/** T3 (R18): the bars, where they came from, and the totals over the months shown. */
export interface PlannedVsInvested {
  source: 'history' | 'adherence'; months: PvMonth[]; planned: number; invested: number; pct: number | null;
}

/** 'YYYY-MM' plus n months (n may be negative). */
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const k = y * 12 + (m - 1) + n;
  return `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`;
}

/**
 * T3 "Planned vs invested" (R18). The source is `/sips` `history` (R3: the last 12 calendar months, oldest first).
 * Without it (absent, null or empty) it falls back to summing `adherence.plans[].months[]` by month: the 6 months the
 * adherence block covers, cut at the current month (the window can reach a week into next month) and gap-filled.
 * Amounts are recorded, not estimated. Null when there is neither, or there are no plans.
 */
export function plannedVsInvested(r: SipsResponse | null | undefined, todayIso: string = today()): PlannedVsInvested | null {
  if (!r || !(r.plans ?? []).length) return null;
  const ym = todayIso.slice(0, 7);
  let source: PlannedVsInvested['source'];
  let rows: SipHistoryMonth[];
  if (Array.isArray(r.history) && r.history.length) {
    source = 'history';
    rows = [...r.history].sort((a, b) => a.month.localeCompare(b.month))
      .map(h => ({ month: h.month, planned: Number(h.planned) || 0, invested: Number(h.invested) || 0 }));
  } else if (r.adherence) {
    source = 'adherence';
    const by = new Map<string, SipHistoryMonth>();
    for (const p of r.adherence.plans ?? []) {
      for (const m of p.months ?? []) {
        if (!m.month || m.month > ym) continue;
        const cur = by.get(m.month) ?? { month: m.month, planned: 0, invested: 0 };
        cur.planned += Number(m.planned) || 0;
        cur.invested += Number(m.invested) || 0;
        by.set(m.month, cur);
      }
    }
    const first = addMonths(ym, -5);
    rows = [];
    for (let k = first; k <= ym; k = addMonths(k, 1)) rows.push(by.get(k) ?? { month: k, planned: 0, invested: 0 });
  } else {
    return null;
  }
  const top = Math.max(0, ...rows.map(x => Math.max(x.planned, x.invested)));
  const months = rows.map(x => {
    const [y, m] = x.month.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    const current = x.month === ym;
    const name = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const tail = x.planned > 0 ? ` (${Math.round(x.invested / x.planned * 100)}%)` : '';
    return {
      ...x, current,
      label: d.toLocaleDateString('en-IN', { month: 'short' }),
      plannedPct: top > 0 ? x.planned / top * 100 : 0,
      investedPct: top > 0 ? x.invested / top * 100 : 0,
      title: `${name}${current ? ', so far' : ''}: planned ${inr(x.planned)}, invested ${inr(x.invested)}${tail}`,
    };
  });
  const planned = rows.reduce((s, x) => s + x.planned, 0);
  const invested = rows.reduce((s, x) => s + x.invested, 0);
  return { source, months, planned, invested, pct: planned > 0 ? Math.round(invested / planned * 100) : null };
}

/** Skips posted in this browser session (scope|action id), so their Undo survives leaving and coming back to the page. */
const sessionSkips = signal<ReadonlySet<string>>(new Set());

/**
 * Activity › Recurring plans (`/recurring`, SPEC §5.9; AMENDMENTS J10, A11, A15 as amended by J10, A21, A22, A27,
 * H2, H9, H11, H19; §10.2).
 * - Head: h1 "Activity" and the Activity tabs; the browser title is the route's "Recurring plans".
 * - T0: hero "₹{monthly_total}/month across {n} plans" with the adherence verdict (H11 thresholds), tiles
 *   "This month" (invested of planned) and "Next due" (`adherence.next_due[0]`).
 * - T1: the `/recurring` needs-attention strip (now, month and consider tiers), then the work surface
 *   "This month's money": the month's instalments with Record and Skip, the money arriving, and Extra to invest
 *   feeding the no-sell planner with the arriving money netted.
 * - T2: the plans table with six adherence dots and the goal each plan funds (`SipPlansComponent`); T3 its plan
 *   modal (with the "Funds goal" select) and "Planned vs invested" bars by month (R18).
 *
 * One `GET /sips` paints everything and reloads when the store's data moves; `GET /goals` loads once per scope. Nothing writes to the ledger by
 * itself: Record opens the transaction dialog and the user confirms units (§10.2). Guests get no Record, Skip,
 * Undo or plan editing.
 */
@Component({
  selector: 'app-recurring',
  standalone: true,
  imports: [RouterLink, IconComponent, EstTagComponent, NeedsAttentionComponent, RebalancePlannerComponent,
    SectionTabsComponent, SipPlansComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .hero-skel { height: 150px; border-radius: 14px; }
    /* T0: hero + two tiles; at ≤ 900 px the hero spans the row and the tiles share the next */
    .r-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(2, minmax(0, 1fr)); }
    .r-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; }
    .r-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .r-kpis .kpi .value.wrap { white-space: normal; overflow-wrap: anywhere; font-size: 18px; line-height: 1.3; }
    @media (max-width: 900px) {
      .r-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .r-kpis .kpi:last-child { grid-column: auto; border-left: 1px solid rgba(255, 255, 255, .09); }
    }

    .ws { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .ws .card-head { margin-bottom: 0; }
    .ws h3 { font-size: var(--t-label); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-top: 10px; }
    .ws h3 .h-meta { text-transform: none; letter-spacing: 0; font-weight: 500; margin-left: 6px; }

    .inst, .arr { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .inst li, .arr li { display: grid; align-items: center; gap: 6px 12px; padding: 10px 0; border-top: 1px solid var(--border); min-width: 0; }
    .inst li:first-child, .arr li:first-child { border-top: 0; }
    .inst li { grid-template-columns: 76px minmax(0, 1fr) auto 150px auto; }
    .arr li { grid-template-columns: 76px minmax(0, 1fr) auto; }
    .i-date { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 13px; }
    .i-name { min-width: 0; overflow-wrap: anywhere; }
    .i-name .sub { display: block; font-size: 12px; color: var(--muted); }
    .i-amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .i-amt .of { color: var(--muted); font-size: 12px; }
    .i-badge { justify-self: start; }
    .i-act { display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap; }
    .arr-total { display: flex; justify-content: space-between; gap: 12px; padding-top: 10px; border-top: 1px solid var(--border-strong); font-weight: 600; }

    .extra { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 16px; }
    .extra .field { width: 200px; margin: 0; }
    .x-input { position: relative; }
    .x-input .input { padding-left: 24px; }
    .x-cur { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
    .extra .sum { flex: 1 1 240px; }

    /* T3: two CSS bars per month, planned outlined and invested filled, one hue (identity is fill vs outline + legend) */
    .pv-legend { margin: 4px 0 10px; }
    .pv-key { display: inline-block; width: 12px; height: 10px; border-radius: 3px; }
    .pv-key.planned { border: 1.5px solid var(--s1); background: transparent; }
    .pv-key.invested { background: var(--s1); }
    .pv { display: grid; grid-template-columns: repeat(var(--n, 12), minmax(0, 1fr)); gap: 0 4px; height: 170px;
      border-bottom: 1px solid var(--axis); background: repeating-linear-gradient(to top, var(--grid) 0 1px, transparent 1px 25%); }
    .pv-m { position: relative; display: flex; flex-direction: column; min-width: 0; height: 100%; outline: none; border-radius: 6px; }
    .pv-m:hover, .pv-m:focus-visible { background: var(--surface-hover); }
    .pv-m:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
    .pv-bars { flex: 1; display: flex; align-items: flex-end; justify-content: center; gap: 2px; min-height: 0; padding: 0 2px; }
    .pv-bar { flex: 0 1 14px; min-width: 3px; border-radius: 4px 4px 0 0; box-sizing: border-box; }
    .pv-bar.planned { border: 1.5px solid var(--s1); border-bottom: 0; background: transparent; }
    .pv-bar.invested { background: var(--s1); }
    .pv-bar.zero { height: 0 !important; border: 0; }
    .pv-label { position: absolute; left: 0; right: 0; bottom: -20px; text-align: center; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; }
    .pv-m.current .pv-label { color: var(--text-2); font-weight: 600; }
    .pv-card .pv + p { margin-top: 30px; }
    .pv-tip { display: none; position: absolute; top: 0; left: 0; z-index: 3; width: max-content; max-width: 200px;
      padding: 6px 8px; border-radius: 6px; background: var(--ink); color: #fff; font-size: 12px; line-height: 1.35; white-space: normal; pointer-events: none; }
    .pv-m.end .pv-tip { left: auto; right: 0; }
    .pv-m:hover .pv-tip, .pv-m:focus-visible .pv-tip { display: block; }

    @media (max-width: 760px) {
      .pv { gap: 0 2px; height: 150px; }
      .pv-bars { gap: 1px; padding: 0 1px; }
      .pv-label { font-size: 10px; }
      .inst li { grid-template-columns: 60px minmax(0, 1fr) auto; }
      .inst .i-badge { grid-column: 2; }
      .inst .i-act { grid-column: 2 / -1; justify-content: flex-start; }
      .arr li { grid-template-columns: 60px minmax(0, 1fr) auto; }
      .extra .field { width: 100%; }
    }
  `],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Activity</h1><p class="sub">What you mean to invest on a schedule, and this month's money.</p></div>
      </div>
      <app-section-tabs group="activity" current="/recurring" style="margin-top:-12px" />

      @if (!data() && !error()) {
        <div class="skeleton hero-skel" aria-label="Loading your recurring plans"></div>
        <div class="card"><div class="skeleton" style="height:18px;width:40%"></div><div class="skeleton" style="height:160px;margin-top:14px"></div></div>
      } @else if (!data()) {
        <div class="card"><div class="empty">
          <app-icon name="alert" [size]="22" /><h3>Couldn't load your recurring plans</h3><p>{{ error() }}</p>
          <button type="button" class="btn" (click)="load()"><app-icon name="refresh" [size]="15" /> Try again</button>
        </div></div>
      } @else {
        @if (error()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't refresh, so these are the last numbers this page saw · {{ error() }}</span>
            <button type="button" class="btn ghost sm" (click)="load()">Try again</button></div>
        }

        <!-- T0: what you invest each month, and how faithfully -->
        <section class="kpis r-kpis" aria-label="Your recurring plans at a glance">
          <div class="kpi hero">
            <span class="label">Investing on a schedule</span>
            <span class="value">{{ monthlyTotal() | inr }}/month</span>
            <span class="meta">across {{ activeCount() }} plan{{ activeCount() === 1 ? '' : 's' }}{{ pausedCount() ? ' · ' + pausedCount() + ' paused' : '' }}</span>
            <div class="verdict-line" [attr.data-status]="verdict().status">
              <app-icon [name]="statusMeta[verdict().status].icon" [size]="16" />
              <span>{{ verdict().text }}</span><span class="sr-only">· {{ statusMeta[verdict().status].word }}</span>
            </div>
          </div>
          <div class="kpi"><span class="chip blue sm"><app-icon name="calendar" [size]="15" /></span><span class="label">This month</span>
            @if (adh(); as a) {
              <span class="value">{{ a.invested_this_month | inr }} <small>of {{ a.planned_this_month | inr }}</small></span>
              <span class="meta">{{ a.planned_this_month > 0 ? paceText() : 'Nothing planned this month' }}</span>
            } @else { <span class="value">—</span><span class="meta">Couldn't match purchases to plans</span> }
          </div>
          <div class="kpi"><span class="chip amber sm"><app-icon name="bell" [size]="15" /></span><span class="label">Next due</span>
            @if (nextDue(); as n) {
              <span class="value wrap">{{ n.name || 'Plan ' + n.plan_id }}</span>
              <span class="meta">{{ n.date | dt }} · {{ n.amount | inr }}</span>
            } @else { <span class="value">—</span><span class="meta">Nothing scheduled</span> }
          </div>
        </section>

        <!-- T1: needs attention here (A27). sip:due is info severity, so it ranks 'consider' (H19) -->
        <app-needs-attention [prefixes]="['/recurring']" [tiers]="['now', 'month', 'consider']" />

        <!-- T1 work surface (A21): this month's money -->
        <section class="card ws" aria-labelledby="rc-month">
          <div class="card-head"><div><h2 id="rc-month">This month's money</h2><span class="hint">{{ monthLabel }} · record what went out, skip what won't, and place what's arriving</span></div></div>

          <h3>Instalments</h3>
          @if (!adh()) {
            <p class="small muted">Couldn't match purchases to your plans just now, so this month's instalments aren't listed. The plans table below is current.</p>
          } @else if (rows().length) {
            <ul class="inst" aria-label="Instalments due this month">
              @for (r of rows(); track r.key) {
                @let b = badge[r.badge];
                @let uid = r.badge === 'skipped' ? undoId(r) : null;
                <li [attr.data-key]="r.key">
                  <span class="i-date">{{ r.due | dt: false }}</span>
                  <span class="i-name">
                    @if (r.plan?.instrument_id) { <a [routerLink]="['/holding', r.plan!.instrument_id]">{{ r.name }}</a> } @else { {{ r.name }} }
                    <span class="sub">{{ r.plan?.frequency || 'plan' }}{{ r.plan?.segment ? ' · ' + r.plan!.segment : '' }}</span>
                  </span>
                  <span class="i-amt">
                    @if (r.badge === 'partial') { {{ r.invested | inr }} <span class="of">of {{ r.planned | inr }}</span> }
                    @else { {{ r.planned | inr }} }
                  </span>
                  <span class="i-badge"><span class="status" [attr.data-status]="b.status"><app-icon [name]="b.icon" [size]="13" />{{ b.word }}</span></span>
                  @if (auth.canWrite()) {
                    <span class="i-act">
                      @if (r.badge !== 'done' && r.badge !== 'skipped') {
                        <button type="button" class="btn sm" [class.primary]="r.badge === 'missed' || r.badge === 'due'" (click)="record(r)"
                          [attr.aria-label]="'Record the ' + r.name + ' instalment'"><app-icon name="plus" [size]="14" /> Record</button>
                        <button type="button" class="btn ghost sm" [disabled]="busy() === r.key" (click)="skip(r)"
                          [attr.aria-label]="'Skip this month for ' + r.name">Skip this month</button>
                      } @else if (uid) {
                        <button type="button" class="btn ghost sm" [disabled]="busy() === r.key" (click)="undo(r, uid)"
                          [attr.aria-label]="'Undo the skip for ' + r.name"><app-icon name="refresh" [size]="14" /> Undo</button>
                      }
                    </span>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="small muted">{{ activeCount() ? 'No instalment of an active plan falls in ' + monthLabel + '.' : 'No active plan yet.' }}
              @if (!activeCount() && auth.canWrite()) { Add one in the table below and it shows here each month. }</p>
          }

          <h3>Arriving <span class="h-meta">money coming back to invest</span></h3>
          @if (arriving().length) {
            <ul class="arr" aria-label="Money arriving">
              @for (a of arriving(); track $index) {
                <li>
                  <span class="i-date">{{ a.date ? (a.date | dt: false) : 'now' }}</span>
                  <span class="i-name"><a [routerLink]="a.link">{{ a.label }}</a></span>
                  <span class="i-amt">{{ a.amount | inr }}</span>
                </li>
              }
            </ul>
            <div class="arr-total"><span>Arriving in all <app-est basis="FD maturity values and P2P principal back are expected amounts; repayments can slip" /></span><span class="i-amt">{{ arrivingTotal() | inr }}</span></div>
          } @else {
            <p class="small muted">Nothing is arriving to invest right now: no FD maturing soon, P2P principal back or idle USD.</p>
          }

          <h3>Extra to invest</h3>
          <div class="extra">
            <div class="field">
              <label for="rc-extra">Extra money this month</label>
              <div class="x-input"><span class="x-cur" aria-hidden="true">₹</span>
                <input id="rc-extra" class="input num" type="number" inputmode="numeric" min="0" step="1000" [value]="extra()" (input)="setExtra($any($event.target).value)" /></div>
            </div>
            <p class="small text-2 sum">Splitting <b>{{ extra() + arrivingTotal() | inr }}</b>@if (arrivingTotal() > 0) {<span> ({{ extra() | inr }} extra + {{ arrivingTotal() | inr }} arriving)</span>} across your target mix, without selling.</p>
          </div>
          <app-rebalance-planner [newMoney]="extra() + arrivingTotal()" [useNet]="arrivingTotal() > 0" [allowSell]="false" />
        </section>

        <!-- T2: the plans, with six adherence dots each and the goal each funds; T3: the plan modal -->
        <app-sip-plans [plans]="plans()" [adherence]="adh()" [goals]="goalRefs()" />

        <!-- T3 (R18): planned vs invested by month. Recorded amounts, so no est. -->
        @if (plans().length) {
          <section class="card pv-card" aria-labelledby="rc-pv">
            <div class="card-head"><div>
              <h2 id="rc-pv">Planned vs invested, {{ pv()?.source === 'adherence' ? 'last 6 months' : (pv()?.months?.length ?? 12) + ' months' }}</h2>
              @if (pv(); as v) {
                <span class="hint">{{ v.invested | inr }} invested of {{ v.planned | inr }} planned{{ v.pct !== null ? ' (' + v.pct + '%)' : '' }}@if (v.source === 'adherence') { · the 12-month record isn't available, so this shows the 6 months adherence covers}</span>
              }
            </div></div>
            @if (pv(); as v) {
              @if (v.planned <= 0 && v.invested <= 0) {
                <p class="small muted">No instalment fell due in these months.</p>
              } @else {
                <div class="legend pv-legend" aria-hidden="true">
                  <span><i class="pv-key planned"></i>Planned</span><span><i class="pv-key invested"></i>Invested</span>
                </div>
                <div class="pv" role="list" [attr.aria-label]="'Planned and invested by month'" [style.--n]="v.months.length">
                  @for (m of v.months; track m.month) {
                    <div class="pv-m" role="listitem" [class.current]="m.current" [class.end]="$index >= v.months.length / 2" [attr.aria-label]="m.title" tabindex="0">
                      <div class="pv-bars">
                        <span class="pv-bar planned" [style.height.%]="m.plannedPct" [class.zero]="m.planned <= 0"></span>
                        <span class="pv-bar invested" [style.height.%]="m.investedPct" [class.zero]="m.invested <= 0"></span>
                      </div>
                      <span class="pv-label">{{ m.label }}</span>
                      <span class="pv-tip" aria-hidden="true">{{ m.title }}</span>
                    </div>
                  }
                </div>
                <p class="small muted">Each month counts the instalments due in it and what was recorded against them; skipped instalments still count as planned. {{ v.months.at(-1)?.current ? 'This month is so far, so instalments still to come count as planned.' : '' }}</p>
              }
            } @else {
              <p class="small muted">Couldn't match purchases to your plans just now, so there's no record of past instalments to chart.</p>
            }
          </section>
        }
      }
    </div>`,
})
export class RecurringComponent {
  private api = inject(ApiService);
  private actions = inject(ActionService);
  private dialog = inject(TxnDialogService);
  private toast = inject(ToastService);
  store = inject(StoreService);
  auth = inject(AuthService);

  readonly statusMeta = STATUS_META;
  readonly badge = INSTALMENT_BADGE;
  readonly monthLabel = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  /** The last good `GET /sips` for this scope, or null before the first one. */
  readonly data = signal<SipsResponse | null>(null);
  /** Why the last load failed, or null once one succeeds. */
  readonly error = signal<string | null>(null);
  /** The instalment (row key) whose Skip or Undo is in flight. */
  readonly busy = signal<string | null>(null);
  /** "Extra to invest" in ₹, default 0. */
  readonly extra = signal(0);

  readonly plans = computed(() => this.data()?.plans ?? []);
  readonly adh = computed(() => this.data()?.adherence ?? null);
  readonly activeCount = computed(() => this.plans().filter(p => p.active).length);
  readonly pausedCount = computed(() => this.plans().length - this.activeCount());
  readonly monthlyTotal = computed(() => this.data()?.monthly_total ?? 0);
  readonly verdict = computed(() => adherenceVerdict(this.adh()?.adherence_6m_pct, this.activeCount()));
  readonly nextDue = computed(() => this.adh()?.next_due?.[0] ?? null);
  readonly paceText = computed(() => {
    const a = this.adh();
    if (!a || a.planned_this_month <= 0) return '';
    return `${Math.round(a.invested_this_month / a.planned_this_month * 100)}% of this month's plan`;
  });
  readonly rows = computed(() => monthRows(this.data()));
  readonly arriving = computed(() => this.data()?.arriving ?? []);
  readonly arrivingTotal = computed(() => {
    const t = Number(this.data()?.arriving_total ?? 0);
    return Number.isFinite(t) && t > 0 ? Math.round(t) : 0;
  });
  /** T3 (R18): planned vs invested by month, from `history` or, without it, the 6 adherence months. */
  readonly pv = computed(() => plannedVsInvested(this.data()));
  /** The scope's goals for the "Funds goal" column and select (R18); null while loading or after `/goals` failed. */
  readonly goalRefs = signal<GoalRef[] | null>(null);

  private seq = 0;
  private goalSeq = 0;
  private loadedFor: string | null = null;

  constructor() {
    effect(() => {
      this.store.version();
      const key = this.store.scopeKey();
      untracked(() => {
        if (key !== this.loadedFor) {
          this.loadedFor = key; this.data.set(null); this.error.set(null); this.goalRefs.set(null);
          queueMicrotask(() => void this.loadGoals());
        }
        queueMicrotask(() => void this.load());
      });
    });
  }

  /** One `GET /sips`; a newer call supersedes an older one. A failure keeps what is painted and says so. */
  async load(): Promise<void> {
    const mine = ++this.seq;
    try {
      const r = await firstValueFrom(this.api.sips());
      if (mine !== this.seq) return;
      this.data.set(r);
      this.error.set(null);
    } catch (e) {
      if (mine === this.seq) this.error.set(errorMessage(e));
    }
  }

  /**
   * The goals, once per page and scope (R18), not on every store bump: names only feed the table and the modal. A
   * goal deleted elsewhere already reads "—", because the server nulls its plans' `goal_id` (K3). A failure leaves
   * `goalRefs` null, so the column links "A goal" and the modal keeps only a plan's current link.
   */
  async loadGoals(): Promise<void> {
    const mine = ++this.goalSeq;
    try {
      const gs = await firstValueFrom(this.api.goals());
      if (mine !== this.goalSeq) return;
      this.goalRefs.set((gs ?? []).map(g => ({ id: g.id, name: g.name, owner: (g as { owner?: string | null }).owner ?? null })));
    } catch {
      if (mine === this.goalSeq) this.goalRefs.set(null);
    }
  }

  setExtra(v: unknown) {
    const n = Number(v);
    this.extra.set(Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1e10) : 0);
  }

  /**
   * Opens the add dialog prefilled for this instalment (J10, §10.2: the user confirms units, nothing is written here).
   * `actionId` is passed only when ActionService knows the instalment's action, so saving marks it done.
   */
  record(r: InstalmentRow) {
    const ac = r.plan?.asset_class ?? (r.plan?.segment ? SEGMENT_CLASS[r.plan.segment] : undefined);
    const { amount, date } = recordPrefill(r);
    const ids = [`sip:missed:${r.sid}:${r.due}`, `sip:due:${r.sid}:${r.due}`];
    const actionId = ids.find(id => !!this.actions.find(id));
    this.dialog.add(kindFor(ac ?? undefined, 'BUY'), {
      instrumentId: r.plan?.instrument_id ?? undefined, type: 'BUY', amount, date,
      ...(actionId ? { actionId } : {}),
    });
  }

  /** "Skip this month" (A11): dismiss the instalment's action with reason `skipped`, then reload `/sips`. */
  async skip(r: InstalmentRow) {
    const id = skipId(r);
    this.busy.set(r.key);
    try {
      const ok = await this.actions.setStatus(id, { status: 'dismissed', reason: 'skipped' });
      if (!ok) return;
      sessionSkips.update(s => new Set(s).add(this.sessionKey(id)));
      this.toast.ok(`Skipped ${r.name} for ${this.monthLabel}`);
      await this.load();
    } finally { this.busy.set(null); }
  }

  /** The id to undo for a skipped row, when this session skipped it; null otherwise (after a reload there is no Undo). */
  undoId(r: InstalmentRow): string | null {
    const s = sessionSkips();
    for (const id of [`sip:missed:${r.sid}:${r.due}`, `sip:due:${r.sid}:${r.due}`]) {
      if (s.has(this.sessionKey(id))) return id;
    }
    return null;
  }

  /** Undo a skip from this session: post `open` to the same id, then reload `/sips`. */
  async undo(r: InstalmentRow, id: string) {
    this.busy.set(r.key);
    try {
      const ok = await this.actions.setStatus(id, { status: 'open' });
      if (!ok) return;
      sessionSkips.update(s => { const n = new Set(s); n.delete(this.sessionKey(id)); return n; });
      await this.load();
    } finally { this.busy.set(null); }
  }

  private sessionKey(id: string): string { return `${this.store.scopeKey()}|${id}`; }
}
