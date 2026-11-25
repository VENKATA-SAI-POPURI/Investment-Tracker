import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, map } from 'rxjs';
import { ActionService } from '../../core/action.service';
import { ActionRunnerService } from '../../core/action-runner.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Action, CashFlow, CashFlowEvent, CashFlowMonth, CashMovement, Position, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { Bar, BarChartComponent, BarDivider } from '../../shared/charts/bar-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';
import { FD_SOON_DAYS, fdPayout, maturedUnrecorded, maturingSoon } from '../fixed-deposits/fixed-deposits.component';

const CATEGORIES = ['Equity/Commodity', 'Equity USA', 'Mutual Funds', 'P2P', 'Fixed Deposits', 'Other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** How many months of the ledger the chart shows, and how many months of forecast follow them (§5.10). */
export const PAST_MONTHS = 24;
export const FUTURE_MONTHS = 12;

/**
 * `?view=` (SPEC §5.10, AMENDMENTS J12): `past` hides the forecast tiles and dates, `future` shows them and scrolls
 * to the future half, `both` shows everything. No value (or an unknown one) is `both`: J12 amends H18's "past".
 */
export type CashView = 'past' | 'future' | 'both';
export const cashViewOf = (v: string | null | undefined): CashView => (v === 'past' || v === 'future' ? v : 'both');

/** "2026-11" moved by `n` months. */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const shortLabel = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;
const longLabel = (ym: string) => `${MONTHS_LONG[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

/** One recorded month of an account: money put in, money taken out, and the difference. */
export interface PastMonth { month: string; in: number; out: number; net: number; }

/**
 * The recorded months the chart shows: every calendar month from the first entry (at most `months` back) up to and
 * including today's month, with empty months as zero so the axis has no gaps. Empty when there are no entries.
 */
export function pastMonths(rows: CashMovement[], todayIso: string = today(), months = PAST_MONTHS): PastMonth[] {
  if (!rows.length) return [];
  const cur = todayIso.slice(0, 7);
  const sums = new Map<string, { in: number; out: number }>();
  for (const c of rows) {
    const k = c.date.slice(0, 7);
    const s = sums.get(k) ?? { in: 0, out: 0 };
    if (c.direction === 'in') s.in += c.amount; else s.out += c.amount;
    sums.set(k, s);
  }
  const first = [...sums.keys()].sort()[0];
  let start = addMonths(cur, -(months - 1));
  if (first > start) start = first;
  if (start > cur) return [];
  const out: PastMonth[] = [];
  for (let k = start; k <= cur; k = addMonths(k, 1)) {
    const s = sums.get(k) ?? { in: 0, out: 0 };
    out.push({ month: k, in: s.in, out: s.out, net: s.in - s.out });
  }
  return out;
}

/**
 * The forecast month on the chart's axis. The past bars count money put in as +, so a forecast month is drawn the
 * same way: SIPs and EPF going in (`outflow`) minus income and principal coming back (`inflow`), which is −`net`.
 */
export const expectedAdded = (m: Pick<CashFlowMonth, 'inflow' | 'outflow'>) => Math.round(m.outflow - m.inflow);

/** The chart's bars: recorded months (solid) then the forecast months (muted, "estimate"), with tooltips. */
export function chartBars(past: PastMonth[], future: CashFlowMonth[], todayIso: string = today()): Bar[] {
  const cur = todayIso.slice(0, 7);
  const fmt = (v: number) => inr(v);
  return [
    ...past.map(p => ({
      key: 'p:' + p.month, label: shortLabel(p.month), value: Math.round(p.net),
      title: longLabel(p.month) + (p.month === cur ? ' · so far' : ''),
      tip: [{ label: 'Put in', value: fmt(p.in) }, { label: 'Taken out', value: fmt(p.out) }],
    })),
    ...future.map(m => ({
      key: 'f:' + m.month, label: shortLabel(m.month), value: expectedAdded(m), muted: true,
      title: (m.month === cur ? 'Rest of ' : '') + longLabel(m.month) + ' · estimate',
      tip: [{ label: 'Going in (SIPs, EPF)', value: fmt(m.outflow) }, { label: 'Coming back (income, principal)', value: fmt(m.inflow) }],
    })),
  ];
}

/** One row of "Dates to know" (J12): a dated event, where it is explained, and the action that handles it. */
export interface DateRow {
  key: string;
  date: string;
  days: number;
  kind: CashFlowEvent['kind'] | 'fd_matured';
  title: string;
  sub: string;
  /** Money in on that date; null when the date is not a payment (a P2P close, W3 review rule) or is money owed. */
  amount: number | null;
  /** A non-payment amount to show plainly ("₹X outstanding"). */
  owed: number | null;
  link: string;
  query: Record<string, string> | null;
  badge: { status: Status; word: string } | null;
  action: Action | null;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(a + 'T00:00:00') - Date.parse(b + 'T00:00:00')) / 86400000);

/**
 * "Dates to know": the forecast's `events[]` plus any open FD that matured with no maturity recorded (A28; the
 * forecast drops past dates, so those come from the positions). FD rows carry the visible `fd:maturing:<iid>` or
 * `fd:matured-unrecorded:<iid>` action when one is ranked. A P2P close is a date, not a payment: its principal comes
 * back as the monthly repayments already in the chart, so it shows no amount (W3 review fix). Sorted by date.
 */
export function datesToKnow(events: CashFlowEvent[], positions: Position[], visible: Action[], todayIso: string = today()): DateRow[] {
  const byId = new Map(visible.map(a => [a.id, a] as const));
  const pos = new Map(positions.map(p => [p.id, p] as const));
  const fdAction = (iid: number | null) => iid === null ? null
    : byId.get(`fd:matured-unrecorded:${iid}`) ?? byId.get(`fd:maturing:${iid}`) ?? null;
  const rows: DateRow[] = [];
  const seenFd = new Set<number>();

  for (const p of positions) {
    if (p.asset_class !== 'fixed_deposit' || !maturedUnrecorded(p, todayIso)) continue;
    seenFd.add(p.id);
    rows.push({
      key: 'fdm:' + p.id, date: p.maturity_date!, days: dayDiff(p.maturity_date!, todayIso), kind: 'fd_matured',
      title: `FD at ${p.name} matured`, sub: 'No maturity is recorded yet, so it still counts as a deposit',
      amount: fdPayout(p), owed: null, link: '/fixed-deposits', query: null,
      badge: { status: 'act', word: 'Not recorded' }, action: fdAction(p.id),
    });
  }
  events.forEach((e, i) => {
    const days = dayDiff(e.date, todayIso);
    if (e.kind === 'fd_maturity') {
      if (e.instrument_id !== null && seenFd.has(e.instrument_id)) return;
      const p = e.instrument_id !== null ? pos.get(e.instrument_id) : undefined;
      const soon = p ? maturingSoon(p) : days >= 0 && days <= FD_SOON_DAYS;
      rows.push({
        key: `fd:${e.instrument_id ?? i}:${e.date}`, date: e.date, days, kind: e.kind, title: `FD at ${e.name} matures`,
        sub: e.note || 'Maturity value comes back', amount: e.amount, owed: null, link: '/fixed-deposits', query: null,
        badge: soon ? { status: 'watch', word: `Within ${FD_SOON_DAYS} days` } : null, action: fdAction(e.instrument_id),
      });
    } else if (e.kind === 'p2p_close') {
      const n = e.count ?? (parseInt(e.name, 10) || 1);
      const title = e.instrument_id !== null ? `${e.name} is fully repaid`
        : n === 1 ? '1 P2P loan finishes repaying' : `${n} P2P loans finish repaying`;
      rows.push({
        key: `p2pc:${e.date}:${i}`, date: e.date, days, kind: e.kind, title,
        sub: 'Its repayments are counted month by month in the chart, not on this date',
        amount: null, owed: null, link: '/p2p', query: null, badge: null, action: null,
      });
    } else {
      const n = e.count ?? (parseInt(e.name, 10) || 1);
      const title = e.instrument_id !== null ? `${e.name} is past maturity`
        : n === 1 ? '1 P2P loan past maturity' : `${n} P2P loans past maturity`;
      rows.push({
        key: `p2po:${e.date}:${i}`, date: e.date, days, kind: e.kind, title, sub: 'Still being repaid after its end date',
        amount: null, owed: e.amount, link: '/p2p', query: { tab: 'overdue' }, badge: { status: 'watch', word: 'Overdue' }, action: null,
      });
    }
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** "in 12 days", "today", "3 days ago". */
export function whenText(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 0) return `in ${days} days`;
  return days === -1 ? 'yesterday' : `${-days} days ago`;
}

/**
 * Activity › Cash flows (`/cash-flows?view=past|future|both`; SPEC §5.10; AMENDMENTS J12, A21, A22, A27, D7, G13, H18,
 * H19 and the W3 review rule on P2P closes).
 *
 * - Head: h1 "Activity" and the Activity tabs; the account `.seg` (Contributions / P2P escrow) and the view `.seg`.
 * - T0: hero "Net contributed" (or "Escrow balance" on the escrow seg) with a factual verdict; Deposited and
 *   Withdrawn. Outside `view=past`, the 12-month forecast tiles (Income due, Principal back, SIPs out, each est.)
 *   take the tile slots and Deposited/Withdrawn move to the hero's meta line, so T0 keeps ≤ 4 tiles (§1.5).
 * - T1: the `fd:`/`cash:` needs-attention strip, then the work surface (A21): one chart of the last 24 months of net
 *   contributions from `/cash` and the next 12 months from `/forecast/cashflow?months=12`, muted and labelled
 *   "estimate", split by a "today" divider, with the assumption chip on the estimate.
 * - T2: "Dates to know" (events linking their pages; FD rows run their ranked action through ActionRunner) and
 *   "What this means" (the forecast notes and the honesty disclaimer).
 * - T3: the ledger table and the add/edit modal.
 *
 * Two reads, `/cash` and `/forecast/cashflow?months=12`, both reloaded when the store's data or scope moves. D7: no
 * `/timeline`.
 */
@Component({
  selector: 'app-cash-flows',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, SectionTabsComponent, ModalComponent, BarChartComponent, AssumptionChipComponent,
    EstTagComponent, NeedsAttentionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cf-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; }
    .hero-skel { height: 150px; border-radius: 14px; }
    .notice .spacer { flex: 1 1 auto; }
    .notice { flex-wrap: wrap; align-items: center; }

    /* T0: hero + two tiles (past) or hero + three forecast tiles; ≤ 760 px keeps two, the third behind "More" */
    .cf-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(var(--cf-tiles, 2), minmax(0, 1fr)); }
    .cf-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; flex-wrap: wrap; row-gap: 2px; }
    .cf-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .cf-kpis .est { color: rgba(255, 255, 255, .78); }
    .cf-kpis .tile-tag { font-size: 11px; color: rgba(255, 255, 255, .6); }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .cf-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cf-kpis .kpi:nth-child(2) { border-left: 0; }
      .cf-kpis .kpi:nth-child(3) { border-left: 1px solid rgba(255, 255, 255, .09); }
      .cf-kpis .kpi.extra { grid-column: span 2; border-left: 0; }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .cf-kpis .kpi.extra:not(.show) { display: none; }
    }

    /* T1 work surface */
    .ws { scroll-margin-top: 80px; min-width: 0; }
    .ws .card-head { margin-bottom: 6px; }
    .cf-legend { margin: 0 0 10px; }
    .sw { display: inline-block; width: 11px; height: 11px; border-radius: 3px; background: var(--s1); flex: none; }
    .sw.est { background: color-mix(in srgb, var(--s1) 45%, transparent); border: 1px dashed var(--s1); }
    .cf-legend .chip-wrap { display: inline-flex; min-width: 0; max-width: 100%; }
    .cf-status { margin: 4px 0 0; }
    .mbm { margin-top: 12px; }
    .mbm .table th, .mbm .table td { padding: 8px 10px; font-size: var(--t-label); }

    /* T2 */
    .dates { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .dates li { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; gap: 4px 12px; align-items: start; padding: 11px 0; border-top: 1px solid var(--border); min-width: 0; }
    .dates li:first-child { border-top: 0; }
    .d-date { font-variant-numeric: tabular-nums; font-size: var(--t-meta); color: var(--text-2); }
    .d-date .sub { display: block; font-size: var(--t-label); color: var(--muted); }
    .d-main { min-width: 0; overflow-wrap: anywhere; }
    .d-main .sub { display: block; font-size: var(--t-label); color: var(--muted); }
    .d-main .status { margin-top: 4px; }
    .d-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; text-align: right; }
    .d-amt { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
    .d-amt.owed { font-weight: 500; color: var(--text-2); }
    .means p { margin: 0 0 8px; }
    @media (max-width: 760px) {
      .dates li { grid-template-columns: 84px minmax(0, 1fr); }
      .d-side { grid-column: 2; align-items: flex-start; text-align: left; flex-direction: row; flex-wrap: wrap; align-items: center; }
    }
  `],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Activity</h1><p class="sub">Money you put in and took out, and what the next {{ futureMonths }} months may bring.</p></div>
        @if (auth.canWrite()) { <button type="button" class="btn sm" (click)="startAdd()"><app-icon name="plus" [size]="15" /> Add entry</button> }
      </div>
      <app-section-tabs group="activity" current="/cash-flows" style="margin-top:-12px" />
      <div class="cf-bar">
        <div class="seg" role="group" aria-label="Account">
          <button type="button" [class.on]="account() === 'capital'" [attr.aria-pressed]="account() === 'capital'" (click)="account.set('capital')">Contributions</button>
          <button type="button" [class.on]="account() === 'p2p_escrow'" [attr.aria-pressed]="account() === 'p2p_escrow'" (click)="account.set('p2p_escrow')">P2P escrow</button>
        </div>
        <div class="seg" role="group" aria-label="Time">
          @for (v of views; track v.key) {
            <button type="button" [class.on]="view() === v.key" [attr.aria-pressed]="view() === v.key" (click)="setView(v.key)">{{ v.label }}</button>
          }
        </div>
      </div>

      @if (!loaded()) {
        <div class="skeleton hero-skel" aria-label="Loading your cash flows"></div>
        <div class="card"><div class="skeleton" style="height:18px;width:40%"></div><div class="skeleton" style="height:240px;margin-top:14px"></div></div>
      } @else if (failed()) {
        <div class="card"><div class="empty">
          <app-icon name="alert" [size]="22" /><h3>Couldn't load your cash flows</h3><p>{{ loadError() }}</p>
          <button type="button" class="btn" (click)="load()"><app-icon name="refresh" [size]="15" /> Try again</button>
        </div></div>
      } @else {
        @if (loadError(); as e) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't refresh, so these are the last entries this page saw · {{ e }}</span>
            <span class="spacer"></span><button type="button" class="btn ghost sm" (click)="load()">Try again</button></div>
        }

        <!-- T0: the answer -->
        <section class="kpis cf-kpis" [style.--cf-tiles]="showFuture() ? 3 : 2" aria-label="Your cash flows at a glance">
          <div class="kpi hero">
            <span class="label">{{ escrow() ? 'Escrow balance' : 'Net contributed' }}</span>
            <span class="value">{{ sums().in - sums().out | inr }}</span>
            @if (showFuture()) {
              <span class="meta">{{ sums().in | inr }} {{ escrow() ? 'paid in' : 'deposited' }} · {{ sums().out | inr }} {{ escrow() ? 'taken out' : 'withdrawn' }}</span>
            } @else {
              <span class="meta">{{ escrow() ? 'paid into P2P escrow, less what left it' : 'deposited, less what you withdrew' }}</span>
            }
            <div class="verdict-line" data-status="info">
              <app-icon [name]="statusMeta.info.icon" [size]="16" />
              <span>{{ verdict() }}</span><span class="sr-only">· {{ statusMeta.info.word }}</span>
            </div>
            @if (showFuture()) {
              <button type="button" class="more-stats" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">{{ moreStats() ? 'Less' : 'More' }}</button>
            }
          </div>
          @if (!showFuture()) {
            <div class="kpi"><span class="chip blue sm"><app-icon name="arrowDown" [size]="15" /></span><span class="label">{{ escrow() ? 'Paid in' : 'Deposited' }}</span>
              <span class="value">{{ sums().in | inr }}</span><span class="meta">{{ sums().inCount }} entr{{ sums().inCount === 1 ? 'y' : 'ies' }}</span></div>
            <div class="kpi"><span class="chip violet sm"><app-icon name="arrowUp" [size]="15" /></span><span class="label">{{ escrow() ? 'Taken out' : 'Withdrawn' }}</span>
              <span class="value">{{ sums().out | inr }}</span><span class="meta">{{ escrow() ? 'lent out or withdrawn' : 'sales, maturities, repayments, dividends' }}</span></div>
          } @else {
            <div class="kpi"><span class="chip green sm"><app-icon name="coins" [size]="15" /></span>
              <span class="label">Income due <app-est [basis]="estBasis()" /></span>
              @if (cf(); as c) {
                <span class="value pos">{{ incomeDue(c) | inr }}</span>
                <span class="meta">{{ c.totals.dividends | inrc }} dividends · {{ c.totals.interest | inrc }} interest{{ c.totals.epf_interest ? ' · ' + inrc(c.totals.epf_interest) + ' EPF interest' : '' }}</span>
              } @else { <span class="value">—</span><span class="meta">{{ cfError() ? "Couldn't estimate" : 'Estimating…' }}</span> }
              <span class="tile-tag">next {{ futureMonths }} months</span>
            </div>
            <div class="kpi"><span class="chip blue sm"><app-icon name="bank" [size]="15" /></span>
              <span class="label">Principal back <app-est [basis]="estBasis()" /></span>
              @if (cf(); as c) {
                <span class="value">{{ c.totals.principal_back | inr }}</span><span class="meta">FD maturities and loan repayments</span>
              } @else { <span class="value">—</span><span class="meta">{{ cfError() ? "Couldn't estimate" : 'Estimating…' }}</span> }
              <span class="tile-tag">next {{ futureMonths }} months</span>
            </div>
            <div class="kpi extra" [class.show]="moreStats()"><span class="chip violet sm"><app-icon name="refresh" [size]="15" /></span>
              <span class="label">SIPs out <app-est [basis]="estBasis()" /></span>
              @if (cf(); as c) {
                <span class="value">{{ c.totals.sip_out | inr }}</span>
                <span class="meta">{{ c.totals.contributions ? '+ ' + inrc(c.totals.contributions) + ' into EPF' : 'on your plans’ due dates' }}</span>
              } @else { <span class="value">—</span><span class="meta">{{ cfError() ? "Couldn't estimate" : 'Estimating…' }}</span> }
              <span class="tile-tag">next {{ futureMonths }} months</span>
            </div>
          }
        </section>

        <!-- T1: needs attention here (A27; info-severity cash: actions rank 'consider', H19) -->
        <app-needs-attention [prefixes]="['/cash-flows', '/fixed-deposits']" [ids]="['fd:', 'cash:']" [tiers]="['now', 'month', 'consider']" />

        <!-- T1 work surface (A21): past and future on one axis -->
        <section id="future" class="card ws" aria-labelledby="cf-chart-h">
          <div class="card-head"><div>
            <h2 id="cf-chart-h">Past {{ pastMonthCount() || pastMonths }} months + next {{ futureMonths }}</h2>
            <span class="hint">Net money put in each month: above the line you added money, below it more came back than went in</span>
          </div></div>
          <div class="legend cf-legend">
            <span><i class="sw" aria-hidden="true"></i> Recorded</span>
            <span><i class="sw est" aria-hidden="true"></i> Estimate, next {{ futureMonths }} months <app-est [basis]="estBasis()" /></span>
            @if (cf()?.assumptions; as a) { <span class="chip-wrap"><app-assumption-chip [block]="a" /></span> }
          </div>
          @if (bars().length) {
            <app-bar-chart [bars]="bars()" [height]="240" [yFormat]="inrc" [tipFormat]="inrSigned" [divider]="divider()" [labelGap]="60"
              [ariaLabel]="chartLabel()" />
          } @else {
            <p class="small muted">{{ cfLoading() ? 'Working out the next ' + futureMonths + ' months…' : 'No money in or out yet. Add a deposit, or record a purchase, and the months fill in.' }}</p>
          }
          @if (cfError(); as e) {
            <div class="notice warn cf-status" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't estimate the next {{ futureMonths }} months · {{ e }}</span>
              <span class="spacer"></span><button type="button" class="btn ghost sm" (click)="loadForecast()">Try again</button></div>
          } @else if (cfLoading() && bars().length) {
            <p class="small muted cf-status" role="status">Working out the next {{ futureMonths }} months…</p>
          }
          @if (cf(); as c) {
            @if (c.months.length) {
              <details class="more mbm">
                <summary>Next {{ futureMonths }} months, month by month</summary>
                <div class="table-wrap">
                  <table class="table">
                    <caption class="sr-only">Expected money in and out per month, an estimate</caption>
                    <thead><tr><th scope="col">Month</th><th scope="col" class="num">Dividends</th><th scope="col" class="num">Interest</th>
                      <th scope="col" class="num">Principal back</th><th scope="col" class="num">Going in</th><th scope="col" class="num">Net added</th></tr></thead>
                    <tbody>
                      @for (m of c.months; track m.month) {
                        <tr><td>{{ monthLabel(m.month) }}</td>
                          <td class="num">{{ m.dividends ? (m.dividends | inr) : '' }}</td><td class="num">{{ m.interest ? (m.interest | inr) : '' }}</td>
                          <td class="num">{{ m.principal_back ? (m.principal_back | inr) : '' }}</td><td class="num">{{ m.outflow ? (m.outflow | inr) : '' }}</td>
                          <td class="num">{{ added(m) | inr: 0 : true }}</td></tr>
                      }
                    </tbody>
                    <tfoot><tr><td>Total</td><td class="num">{{ c.totals.dividends | inr }}</td><td class="num">{{ c.totals.interest | inr }}</td>
                      <td class="num">{{ c.totals.principal_back | inr }}</td><td class="num">{{ c.totals.outflow | inr }}</td>
                      <td class="num">{{ added(c.totals) | inr: 0 : true }}</td></tr></tfoot>
                  </table>
                </div>
                <p class="small muted" style="margin:8px 0 0">"Net added" is what goes in less what comes back, the same way the recorded bars count it. EPF interest stays in the account and is not in these rows.</p>
              </details>
            }
          }
        </section>

        <!-- T2: explanations -->
        <div class="grid" [class.grid-2]="showFuture()">
          @if (showFuture()) {
            <section class="card" aria-labelledby="cf-dates-h">
              <div class="card-head"><div><h2 id="cf-dates-h">Dates to know</h2>
                <span class="hint">Explains: the estimate · maturities and loan dates <app-est [basis]="estBasis()" /></span></div></div>
              @if (cf() || dates().length) {
                @if (dates().length) {
                  <ul class="dates">
                    @for (d of dates(); track d.key) {
                      <li>
                        <span class="d-date">{{ d.date | dt }}<span class="sub">{{ when(d.days) }}</span></span>
                        <span class="d-main">
                          <a [routerLink]="d.link" [queryParams]="d.query">{{ d.title }}</a>
                          <span class="sub">{{ d.sub }}</span>
                          @if (d.badge; as b) {
                            <span class="status" [attr.data-status]="b.status"><app-icon [name]="statusMeta[b.status].icon" [size]="13" />{{ b.word }}</span>
                          }
                        </span>
                        <span class="d-side">
                          @if (d.amount !== null) { <span class="d-amt">+{{ d.amount | inr }}</span> }
                          @else if (d.owed !== null) { <span class="d-amt owed">{{ d.owed | inr }} outstanding</span> }
                          @if (d.action; as a) {
                            <button type="button" class="btn sm" (click)="run(a)" [attr.aria-label]="(a.cta?.label || 'Open') + ': ' + d.title">{{ a.cta?.label || 'Open' }}</button>
                          }
                        </span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="small muted">Nothing matures and no loan finishes in the next {{ futureMonths }} months.</p>
                }
              } @else if (cfError()) {
                <p class="small muted">Dates show once the estimate loads.</p>
              } @else {
                <div class="skeleton" style="height:120px"></div>
              }
            </section>
          }
          <section class="card means" aria-labelledby="cf-means-h">
            <div class="card-head"><div><h2 id="cf-means-h">What this means</h2><span class="hint">Explains: the estimate</span></div></div>
            @if (cf(); as c) {
              @for (n of c.notes; track n) { <p class="small">{{ n }}</p> }
              @empty { <p class="small muted">Add dividends, FDs, loans or SIP plans and the estimate fills in.</p> }
              <p class="small muted">{{ c.note }}</p>
              <p class="small muted">{{ c.honesty?.disclaimer || disclaimer }}</p>
            } @else if (cfError()) {
              <p class="small muted">The notes show once the estimate loads. {{ disclaimer }}</p>
            } @else {
              <div class="skeleton" style="height:80px"></div>
            }
          </section>
        </div>

        <!-- T3: every entry -->
        <section class="card flush" aria-label="Entries">
          <div class="card-head"><h2>{{ escrow() ? 'P2P escrow entries' : 'Contributions' }}</h2><span class="hint">{{ rows().length }} entr{{ rows().length === 1 ? 'y' : 'ies' }}</span></div>
          <div class="table-wrap" style="max-height:600px">
            <table class="table">
              <thead><tr><th scope="col">Date</th><th scope="col">Category</th><th scope="col">Type</th><th scope="col" class="num">Amount</th>
                <th scope="col" class="hide-sm">Notes</th><th scope="col" class="hide-sm">Source</th>@if (auth.canWrite()) { <th scope="col"><span class="sr-only">Actions</span></th> }</tr></thead>
              <tbody>
                @for (c of rows(); track c.id) {
                  <tr>
                    <td class="nowrap">{{ c.date | dt }}</td><td>{{ c.category || '—' }}</td><td>{{ c.kind }}</td>
                    <td class="num" [class]="c.direction === 'in' ? '' : 'muted'">{{ c.direction === 'in' ? '+' : '−' }}{{ c.amount | inr: 2 }}</td>
                    <td class="hide-sm small muted ellipsis" style="max-width:260px" [title]="c.notes ?? ''">{{ c.notes }}</td>
                    <td class="hide-sm">@if (c.transaction_id) { <span class="badge info">from transaction</span> } @else { <span class="small muted">{{ c.source }}</span> }</td>
                    @if (auth.canWrite()) {
                      <td class="right nowrap">
                        @if (!(c.transaction_id && c.source === 'auto')) { <button type="button" class="btn ghost icon sm" (click)="startEdit(c)" aria-label="Edit"><app-icon name="edit" [size]="15" /></button> }
                        <button type="button" class="btn ghost icon sm danger" (click)="remove(c)" aria-label="Delete"><app-icon name="trash" [size]="15" /></button>
                      </td>
                    }
                  </tr>
                } @empty { <tr><td colspan="7" class="muted">No entries yet.</td></tr> }
              </tbody>
            </table>
          </div>
        </section>
        <p class="small muted">Mutual fund, FD, P2P, forex and dividend entries are created automatically from transactions. Add broker deposits and withdrawals for stocks yourself.</p>
      }
    </div>
    @if (editing(); as e) {
      <app-modal [title]="e.id ? 'Edit entry' : 'Add entry'" [width]="480" (close)="editing.set(null)">
        <form class="form" (ngSubmit)="save()">
          <div class="field"><label>Direction</label>
            <div class="seg"><button type="button" [class.on]="f.direction === 'in'" (click)="f.direction = 'in'">Money in</button>
              <button type="button" [class.on]="f.direction === 'out'" (click)="f.direction = 'out'">Money out</button></div></div>
          <div class="cols">
            <div class="field"><label for="cf-date">Date</label><input id="cf-date" class="input" type="date" name="date" [(ngModel)]="f.date" /></div>
            <div class="field"><label for="cf-amt">Amount (₹)</label><input id="cf-amt" class="input num" type="number" step="0.01" name="amount" [(ngModel)]="f.amount" /></div>
            <div class="field"><label for="cf-cat">Category</label>
              <select id="cf-cat" class="input" name="category" [(ngModel)]="f.category">@for (c of categories; track c) { <option>{{ c }}</option> }</select></div>
            @if (account() === 'capital') {
              <div class="field"><label for="cf-kind">Kind</label>
                <select id="cf-kind" class="input" name="kind" [(ngModel)]="f.kind"><option>Deposit</option><option>Withdrawal</option><option>Profit Withdrawal</option></select></div>
            }
          </div>
          <div class="field"><label for="cf-notes">Notes</label><input id="cf-notes" class="input" name="notes" [(ngModel)]="f.notes" /></div>
          @if (error()) { <div class="notice bad">{{ error() }}</div> }
          <div class="form-actions"><button type="button" class="btn" (click)="editing.set(null)">Cancel</button><button class="btn primary" type="submit">Save</button></div>
        </form>
      </app-modal>
    }`,
})
export class CashFlowsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private actions = inject(ActionService);
  private runner = inject(ActionRunnerService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly statusMeta = STATUS_META;
  readonly pastMonths = PAST_MONTHS;
  readonly futureMonths = FUTURE_MONTHS;
  readonly disclaimer = 'Estimates from long-run assumptions, not predictions or advice. Real returns will differ.';
  readonly views: { key: CashView; label: string }[] = [
    { key: 'past', label: 'Past' }, { key: 'both', label: 'Past + next 12' }, { key: 'future', label: 'Next 12 months' },
  ];

  account = signal<'capital' | 'p2p_escrow'>(this.route.snapshot.queryParamMap.get('account') === 'p2p_escrow' ? 'p2p_escrow' : 'capital');
  all = signal<CashMovement[]>([]);
  editing = signal<Partial<CashMovement> | null>(null);
  error = signal<string | null>(null);
  /** The first `/cash` read has finished (either way). */
  loaded = signal(false);
  /** A `/cash` read has succeeded for this scope, so there are entries (maybe none) to show. */
  private okOnce = signal(false);
  loadError = signal<string | null>(null);
  cf = signal<CashFlow | null>(null);
  cfLoading = signal(false);
  cfError = signal<string | null>(null);
  moreStats = signal(false);

  readonly view = toSignal(this.route.queryParamMap.pipe(map(q => cashViewOf(q.get('view')))),
    { initialValue: cashViewOf(this.route.snapshot.queryParamMap.get('view')) });
  private fragment = toSignal(this.route.fragment, { initialValue: this.route.snapshot.fragment });
  private scrolledFor: string | null = null;
  private loadedFor: string | null = null;
  private seq = 0;
  private cfSeq = 0;
  f: any = {};
  categories = CATEGORIES;
  inrc = (v: number) => inrCompact(v);
  inrSigned = (v: number) => inr(v, 0, true);
  when = whenText;
  monthLabel = longLabel;
  added = expectedAdded;
  incomeDue = (c: CashFlow) => c.totals.dividends + c.totals.interest + c.totals.epf_interest;

  escrow = computed(() => this.account() === 'p2p_escrow');
  failed = computed(() => !!this.loadError() && !this.okOnce());
  showFuture = computed(() => this.view() !== 'past');
  rows = computed(() => this.all().filter(c => c.account === this.account()));
  sums = computed(() => {
    let i = 0, o = 0, inCount = 0;
    for (const c of this.rows()) { if (c.direction === 'in') { i += c.amount; inCount++; } else o += c.amount; }
    return { in: i, out: o, inCount };
  });

  /** The hero's factual verdict (status info): the last 12 months of the contributions, or what waits in escrow. */
  verdict = computed(() => {
    if (this.escrow()) {
      const bal = this.sums().in - this.sums().out;
      return bal > 0.5 ? `${inr(bal)} waiting in escrow, not lent out yet` : 'Nothing waiting in escrow';
    }
    if (!this.rows().length) return 'No contributions recorded yet';
    const from = addMonths(today().slice(0, 7), -11);
    const net = pastMonths(this.rows()).filter(m => m.month >= from).reduce((a, m) => a + m.net, 0);
    if (Math.abs(net) < 0.5) return 'Nothing added in the last 12 months';
    return net > 0 ? `${inr(net)} added in the last 12 months` : `${inr(-net)} more taken out than put in over the last 12 months`;
  });

  /** The chart always shows the contributions account: the forecast is about money going into and out of investments. */
  private past = computed(() => pastMonths(this.all().filter(c => c.account === 'capital')));
  pastMonthCount = computed(() => this.past().length);
  bars = computed<Bar[]>(() => chartBars(this.past(), this.cf()?.months ?? []));
  divider = computed<BarDivider | null>(() => {
    const n = this.past().length, f = this.cf()?.months.length ?? 0;
    if (!f) return null;
    return { index: n, label: 'today', before: n ? `past ${n} month${n === 1 ? '' : 's'}` : undefined, after: 'estimate' };
  });
  chartLabel = computed(() => {
    const n = this.past().length, f = this.cf()?.months.length ?? 0;
    return `Net money put in per month: ${n} recorded month${n === 1 ? '' : 's'}`
      + (f ? `, then ${f} estimated months after today` : '') + '. The month by month estimate is in the table below the chart.';
  });
  estBasis = computed(() => {
    const c = this.cf();
    const basis = c?.assumptions?.basis;
    return basis ? `An estimate: ${basis}. ${c?.honesty?.disclaimer ?? this.disclaimer}` : `An estimate from the patterns in your ledger. ${this.disclaimer}`;
  });
  dates = computed(() => datesToKnow(this.cf()?.events ?? [], this.store.positions(), this.actions.actions()));

  constructor() {
    effect(() => {
      this.store.version();
      const key = this.store.scopeKey();
      untracked(() => {
        if (key !== this.loadedFor) {
          // another person or portfolio: never show the last one's entries while the new ones load
          this.loadedFor = key;
          this.all.set([]); this.cf.set(null); this.okOnce.set(false); this.loaded.set(false);
          this.loadError.set(null); this.cfError.set(null);
        }
        queueMicrotask(() => this.load());
      });
    });

    // `view=future` or `#future`: scroll to the chart's card once the entries above it have painted (the router's own
    // anchor scroll runs before they arrive). Once per arrival, so the user's own scrolling wins.
    let timer: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const v = this.view(), f = this.fragment(), ready = this.loaded() && !this.failed();
      const want = v === 'future' || f === 'future';
      const key = want ? `${v}#${f ?? ''}` : null;
      if (!key) { this.scrolledFor = null; return; }
      if (!ready || key === this.scrolledFor) return;
      this.scrolledFor = key;
      untracked(() => {
        if (timer) clearTimeout(timer);
        // two macrotasks later: after the card renders and after the router's own anchor scroll (queued behind the first)
        timer = setTimeout(() => { timer = setTimeout(() => {
          const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
          document.getElementById('future')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        }); });
      });
    });
    inject(DestroyRef).onDestroy(() => { if (timer) clearTimeout(timer); });
  }

  /** Reads `/cash` and, alongside it, the 12-month forecast. A read that finishes after a newer one is dropped. */
  async load() {
    const mine = ++this.seq;
    void this.loadForecast();
    try {
      const rows = await firstValueFrom(this.api.cash());
      if (mine !== this.seq) return;
      this.all.set(rows);
      this.okOnce.set(true);
      this.loadError.set(null);
    } catch (e) {
      if (mine !== this.seq) return;
      // keep the last good list on a refresh; the page says the numbers are stale
      this.loadError.set(errorMessage(e));
    } finally {
      if (mine === this.seq) this.loaded.set(true);
    }
  }

  async loadForecast() {
    const mine = ++this.cfSeq;
    this.cfLoading.set(true);
    try {
      const c = await firstValueFrom(this.api.cashflow(FUTURE_MONTHS));
      if (mine !== this.cfSeq) return;
      this.cf.set(c);
      this.cfError.set(null);
    } catch (e) {
      if (mine !== this.cfSeq) return;
      this.cfError.set(errorMessage(e));
    } finally {
      if (mine === this.cfSeq) this.cfLoading.set(false);
    }
  }

  /** Writes `?view=` in place (no history entry); `both` is the default, so it clears the parameter. */
  setView(v: CashView) {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { view: v === 'both' ? null : v },
      queryParamsHandling: 'merge', replaceUrl: true });
  }

  run(a: Action) { void this.runner.run(a); }

  startAdd() {
    this.f = { direction: 'in', date: today(), amount: null, category: this.account() === 'capital' ? 'Equity/Commodity' : 'LenDen', kind: 'Deposit', notes: '' };
    this.error.set(null);
    this.editing.set({});
  }
  startEdit(c: CashMovement) {
    this.f = { ...c };
    this.error.set(null);
    this.editing.set(c);
  }
  async save() {
    const body = { ...this.f, account: this.account() };
    if (this.account() === 'p2p_escrow') body.kind = body.direction === 'in' ? 'Deposit' : 'Withdrawal';
    try {
      const e = this.editing()!;
      if (e.id) await firstValueFrom(this.api.updateCash(e.id, body));
      else await firstValueFrom(this.api.addCash(body));
      this.toast.ok('Saved');
      this.editing.set(null);
      await this.store.changed();
    } catch (err) { this.error.set(errorMessage(err)); }
  }
  async remove(c: CashMovement) {
    const linked = c.transaction_id ? ' It was created from a transaction; the transaction itself stays.' : '';
    if (!(await this.confirm.ask('Delete entry?', `${c.kind} of ₹${c.amount.toLocaleString('en-IN')} on ${c.date}.${linked}`, 'Delete'))) return;
    try { await firstValueFrom(this.api.deleteCash(c.id)); this.toast.ok('Deleted'); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
