import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ActionRunnerService } from '../../core/action-runner.service';
import { ActionService } from '../../core/action.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fmtDate, inr, inrCompact, inrWords, relTime, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import {
  Action, AllocationRow, Brief, Contributor, HabitTrack, MarketTrack, NextDue, Performance, PerfPoint, SEGMENT_COLOR, SEGMENT_META,
  Status, UpcomingEvent, Vital, VitalKey, activeSeries,
} from '../../core/models';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { DonutChartComponent, Slice } from '../../shared/charts/donut-chart.component';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { PORTFOLIO_HOLDINGS_HOME } from '../../shared/portfolio-tabs.component';
import { ActionCardComponent } from '../../shared/priority/action-card.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { ProbBarComponent } from '../../shared/priority/prob-bar.component';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';
import { VerdictCardComponent, VerdictCta } from '../../shared/priority/verdict-card.component';
import { VitalChipComponent } from '../../shared/priority/vital-chip.component';
import { ASSUMPTIONS_CHECK_META, STATUS_META, VITAL_ORDER, byStatus, statusFromExcess, vitalOf } from '../../shared/priority/priority';

/* ── Home: the answer ladder (SPEC Part 1 §4; AMENDMENTS A16, A21–A23, A26, D4, E9, E20, H11, H17, J13) ──
 * P1 (W5-F5): the Book chip on Your plan, the habit card's adherence / pace % / next SIP / next milestone,
 * "Next: SIP … · review due …" on the all-clear card and "suggest: {class}" on FD maturities in Coming up.
 * T0  hero: am I OK?                    store portfolio + /brief (both painted from this device's snapshot)
 * T1  five checks, do this now, on track  /brief (snapshot first, then revalidated)
 * T2  why it moved, where the money is, coming up   /performance?range=ALL after paint; /brief.why, .allocation, .upcoming
 * T3  four link tiles
 * Home is the only writer of snapshotKey('brief', scopeKey) (E20).
 */

/** Ranges of the "You vs the market" chart. Each is sliced from the one ALL payload (A16). */
export type ChartRange = '1M' | '6M' | '1Y' | 'ALL';
export const CHART_RANGES: ChartRange[] = ['1M', '6M', '1Y', 'ALL'];
const RANGE_DAYS: Record<Exclude<ChartRange, 'ALL'>, number> = { '1M': 31, '6M': 183, '1Y': 366 };
/** A slice of the ALL series thinner than this fetches its own range instead. */
export const MIN_SLICE_POINTS = 8;
/** Brief vs-Nifty uses this benchmark (brief.py / story.PRIMARY_BENCH). */
const BENCH = 'NIFTY50';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How long a Home visit lasts before it counts as the last visit (§4 Data). */
const VISIT_MS = 30_000;

/** Goal presets for the unset plan card; Plan › Goals reads `preset` (§4.4). */
export const PLAN_PRESETS = [
  { key: 'emergency', label: 'Emergency fund', icon: 'shield' },
  { key: 'education', label: "Child's education", icon: 'sparkle' },
  { key: 'home', label: 'Home down payment', icon: 'home' },
  { key: 'retirement', label: 'Retirement', icon: 'lotus' },
] as const;

/** Upcoming event kinds → tile colour and icon (§4.7). */
const EVENT_KIND: Record<string, { icon: string; color: string }> = {
  tax: { icon: 'receipt', color: 'var(--accent)' },
  fy: { icon: 'calendar', color: 'var(--accent)' },
  festival: { icon: 'diya', color: 'var(--gold)' },
  personal: { icon: 'target', color: 'var(--s2)' },
  sip: { icon: 'refresh', color: 'var(--s1)' },
  fd_maturity: { icon: 'bank', color: 'var(--s6)' },
  p2p_close: { icon: 'users', color: 'var(--s5)' },
  ipo: { icon: 'zap', color: 'var(--s4)' },
};

/* ── lastVisit:<scopeKey> (E9) ── */

const lastVisitKey = (scope: string) => `lastVisit:${scope}`;

/**
 * The previous visit per portfolio, read once per app session: once Home writes today's date, later
 * revalidations in the same session must keep sending the visit before this one.
 */
const sinceByScope = new Map<string, string | null>();

export function sinceFor(scope: string): string | null {
  if (!sinceByScope.has(scope)) {
    let v: string | null = null;
    try { v = localStorage.getItem(lastVisitKey(scope)); } catch { /* storage unavailable */ }
    sinceByScope.set(scope, v && ISO_DAY.test(v) ? v : null);
  }
  return sinceByScope.get(scope) ?? null;
}

/** Stores the browser's local date; the server clamps one day ahead (E9). */
export function markVisit(scope: string): void {
  try { localStorage.setItem(lastVisitKey(scope), today()); } catch { /* storage unavailable */ }
}

/* ── pure helpers (exported for reuse and type-checking) ── */

/** ISO date `n` days before `from` (local calendar). */
export function daysBefore(from: string, n: number): string {
  const d = new Date(from + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86_400_000);
}

/** The window of the ALL series a range shows: ALL drops the near-empty start (`activeSeries`). */
export function sliceSeries(points: PerfPoint[], range: ChartRange, on = today()): PerfPoint[] {
  if (range === 'ALL') return activeSeries(points);
  const from = daysBefore(on, RANGE_DAYS[range]);
  return points.filter(p => p.date >= from);
}

/** A snapshot from an older build may lack fields: treat anything without the ladder's spine as missing. */
export function asBrief(x: unknown): Brief | null {
  const b = x as Partial<Brief> | null;
  if (!b || typeof b !== 'object' || !b.status || !b.on_track || !Array.isArray(b.vitals) || !Array.isArray(b.actions)) return null;
  return b as Brief;
}

/** Market card values, from the brief or (while it is pending) from Home's own ALL payload (A16). */
export interface MarketView {
  status: Status | 'pending';
  excess: number | null;
  diff: number | null;
  since: string | null;
  days: number | null;
  source: 'brief' | 'performance' | 'none';
}

/** The brief's market rule applied to the ALL payload: story.market_compare + brief._market_track. */
export function marketFromPerformance(perf: Performance, totalValue: number, on = today()): MarketView {
  const bench = perf.benchmarks.find(b => b.key === BENCH && b.xirr !== null);
  const since = perf.metrics?.start ?? null;
  const days = since && ISO_DAY.test(since.slice(0, 10)) ? daysBetween(since.slice(0, 10), on) : null;
  if (!bench) return { status: 'unset', excess: null, diff: null, since, days, source: 'performance' };
  return { status: statusFromExcess(bench.excess_xirr, days), excess: bench.excess_xirr,
    diff: Math.round((totalValue - bench.end_value) * 100) / 100, since, days, source: 'performance' };
}

/** Two-line sparkline paths over a shared scale (viewBox 0 0 W H). */
export function sparkPaths(a: (number | null)[], b: (number | null)[], w = 240, h = 44): { you: string; bench: string } {
  const vals = [...a, ...b].filter((v): v is number => v !== null && v !== undefined && isFinite(v));
  if (vals.length < 2) return { you: '', bench: '' };
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const n = Math.max(a.length, b.length) - 1 || 1;
  const path = (xs: (number | null)[]) => {
    let d = '', pen = false;
    xs.forEach((v, i) => {
      if (v === null || v === undefined || !isFinite(v)) { pen = false; return; }
      const x = (i / n) * w, y = 2 + (1 - (v - lo) / span) * (h - 4);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return { you: path(a), bench: path(b) };
}

/* ── P1 habit, all-clear and Coming-up lines (J13) ── */

/** "Next: Parag Parikh SIP ₹10,000 on 15 Nov" from `habit.next_due` (H11); a nameless plan reads "SIP". */
export function nextDueText(n: NextDue | null | undefined, label?: string): string | null {
  if (!n || !ISO_DAY.test(String(n.date).slice(0, 10)) || !(n.amount > 0)) return null;
  return `${label ?? (n.name || 'SIP')} ${inr(n.amount)} on ${fmtDate(String(n.date).slice(0, 10), false)}`;
}

/** "Next milestone ₹50 lakh in 2 yrs 3 mo" from `habit.milestone` (story.milestones' first `ahead` row). */
export function milestoneText(m: HabitTrack['milestone']): string | null {
  if (!m?.label) return null;
  if (m.in) return `Next milestone ${m.label} ${m.in === 'this month' ? m.in : 'in ' + m.in}`;
  if (m.when && /^\d{4}-\d{2}$/.test(m.when)) {
    const d = new Date(m.when + '-01T00:00:00');
    return `Next milestone ${m.label} by ${d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`;
  }
  return `Next milestone ${m.label}`;
}

/** The habit card's sentence: adherence, then pace as a share of this month's plan (H11: pace is a %, not ₹). */
export function habitSentenceText(h: HabitTrack | null | undefined): string {
  if (!h || !(h.planned_month > 0)) return 'Add your SIPs to see this month\'s money against your plan.';
  const bits: string[] = [];
  if (h.adherence_6m_pct !== null && h.adherence_6m_pct !== undefined) bits.push(`6-month SIP adherence ${Math.round(h.adherence_6m_pct)}%`);
  if (h.pace !== null && h.pace !== undefined) bits.push(`${Math.round(h.pace)}% of this month's plan`);
  return bits.length ? bits.join(' · ') : 'Money invested so far this month against your SIP plans.';
}

/** The all-clear card's sentence after "Nothing needs you": the next SIP and the next review (§4.3, J13; lifts E20). */
export function clearSentenceText(next: NextDue | null | undefined, reviewDue: string | null, on = today()): string {
  const parts: string[] = [];
  const sip = nextDueText(next, 'SIP');
  if (sip) parts.push(sip);
  if (reviewDue) parts.push(reviewDue < on ? `review overdue since ${fmtDate(reviewDue)}` : `review due ${fmtDate(reviewDue)}`);
  return parts.length ? `Next: ${parts.join(' · ')}.` : 'Nothing is due this week or this month.';
}

/**
 * The class an FD's maturity could top up (D4): the targeted segment with the most negative drift in
 * `brief.allocation`. Null when no target is set or nothing is under target.
 */
export function underTargetSegment(rows: AllocationRow[] | null | undefined): string | null {
  let best: AllocationRow | null = null;
  for (const r of rows ?? []) {
    if (r.target === null || r.drift === null || !(r.drift < 0)) continue;
    if (!best || r.drift < (best.drift as number)) best = r;
  }
  return best ? best.segment : null;
}

interface DriverRow { id: number; name: string; segment: string; gain: number; }

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [RouterLink, IconComponent, LineChartComponent, DonutChartComponent, ActionCardComponent, VerdictCardComponent,
    VitalChipComponent, ProbBarComponent, StatusBadgeComponent, AssumptionChipComponent, EstTagComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss',
})
export class OverviewComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  actionsSvc = inject(ActionService);
  private runner = inject(ActionRunnerService);
  private api = inject(ApiService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  readonly skeletonVitals = [1, 2, 3, 4, 5];
  readonly ranges = CHART_RANGES;
  readonly presets = PLAN_PRESETS;
  readonly holdingsHome = PORTFOLIO_HOLDINGS_HOME;
  readonly words = inrWords;
  readonly inrc = (v: number) => inrCompact(v);
  readonly inrFull = (v: number) => inr(v);
  readonly rel = relTime;
  readonly statusMeta = STATUS_META;
  readonly todayIso = today();

  /* ── data ── */
  brief = signal<Brief | null>(null);
  briefLoading = signal(false);
  briefError = signal<string | null>(null);
  /** /performance?range=ALL, fetched after paint (A16). */
  perfAll = signal<Performance | null>(null);
  perfLoading = signal(false);
  perfError = signal<string | null>(null);
  /** Other ranges, fetched only when the ALL slice is too thin to draw. */
  ranged = signal<Partial<Record<ChartRange, Performance>>>({});

  /* ── view state ── */
  range = signal<ChartRange>('1Y');
  driverView = signal<'today' | 'start'>('today');
  /** Phones show stats 1 and 4; "More" reveals 2 and 3 (§4.1). */
  moreStats = signal(false);
  phone = signal(false);
  /** Actions changed from the ⋯ menu here, hidden until the brief catches up (or the change fails). */
  private hidden = signal<ReadonlySet<string>>(new Set());

  /* ── page head ── */
  p = computed(() => this.store.portfolio());
  t = computed(() => this.p()?.totals ?? null);
  greeting = computed(() => {
    const name = (this.auth.viewAs()?.name || this.auth.user()?.name || '').split(' ')[0];
    return `Namaste${name ? ', ' + name : ''}`;
  });
  family = computed(() => this.auth.canSwitch() && !this.auth.portfolio());

  /** Empty ledger: the brief says so; before it arrives, the portfolio does. */
  isEmpty = computed(() => {
    const b = this.brief();
    if (b) return b.empty;
    const p = this.p();
    return !!p && p.positions.length === 0;
  });

  /* ── T0 hero ── */
  heroStatus = computed<Status | null>(() => this.brief()?.status.status ?? null);
  sinceLast = computed(() => this.brief()?.hero.since_last ?? null);

  /* ── T1 vitals (A23: read by key, never by index) ── */
  vitals = computed<Vital[]>(() => {
    const list = this.brief()?.vitals ?? [];
    return VITAL_ORDER.map(k => vitalOf(list, k)).filter((v): v is Vital => !!v);
  });
  /** The phone order, act → watch → unset → good (§3.2), applied with CSS `order`. */
  private phoneRank = computed(() => {
    const rank = new Map<VitalKey, number>();
    byStatus(this.vitals(), v => v.status).forEach((v, i) => rank.set(v.key, i));
    return rank;
  });
  rankOf = (key: VitalKey) => this.phoneRank().get(key) ?? 0;

  /* ── T1 do this now ── */
  topActions = computed<Action[]>(() => {
    const hidden = this.hidden();
    return (this.brief()?.actions ?? []).filter(a => !(hidden.has(a.id) && this.actionsSvc.find(a.id)?.status !== 'open')).slice(0, 3);
  });
  actionCount = computed(() => { const s = this.brief()?.status; return s ? s.count_now + s.count_month : 0; });
  /** Every visible action, once /actions has answered; otherwise the brief's now + month count. */
  actionsTotal = computed(() => this.actionsSvc.loaded()
    ? this.actionsSvc.actions().length + this.actionsSvc.planned().length : this.actionCount());
  acted = computed(() => {
    const a = this.actionsSvc.followThrough()?.acted_90d;
    return a && a.total > 0 ? a : null;
  });
  reviewDue = computed(() => {
    const last = this.store.settings().lastReviewDate;
    return last && ISO_DAY.test(last) ? daysBefore(last, -90) : null;
  });
  /** Read with the card's big text: "Nothing needs you" · "Next: SIP ₹X on {date} · review due {date}." (J13). */
  clearSentence = computed(() => clearSentenceText(this.habit()?.next_due, this.reviewDue(), this.todayIso));

  /* ── T1 am I on track ── */
  plan = computed(() => this.brief()?.on_track.plan ?? null);
  planRows = computed(() => (this.plan()?.rows ?? []).slice(0, 3));  // the brief sorts worst first
  planBig = computed(() => {
    const pl = this.plan();
    if (!pl || !pl.total) return null;
    const noun = pl.rows.every(r => r.kind === 'goal') ? (pl.total === 1 ? 'goal' : 'goals') : 'plans';
    return `${pl.on_track} of ${pl.total} ${noun} on track`;
  });
  planCta: VerdictCta = { label: 'Open plan', link: '/plan' };

  market = computed<MarketView>(() => {
    const track: MarketTrack | undefined = this.brief()?.on_track.market;
    if (track && track.status !== 'pending') {
      return { status: track.status, excess: track.excess, diff: track.diff_value, since: track.since, days: track.days, source: 'brief' };
    }
    const perf = this.perfAll(), t = this.t();
    if (perf && t) return marketFromPerformance(perf, t.value, this.todayIso);
    return { status: 'pending', excess: null, diff: null, since: null, days: null, source: 'none' };
  });
  /** The verdict card takes a Status; a pending comparison shows as neutral with its own word. */
  marketStatus = computed<Status>(() => { const s = this.market().status; return s === 'pending' ? 'info' : s; });
  marketBig = computed(() => {
    const m = this.market();
    if (m.status === 'pending') return 'Comparing with Nifty 50…';
    if (m.excess === null) return 'No comparison yet';
    if (m.status === 'unset') return 'Too early to judge';
    return `${m.excess > 0 ? '+' : m.excess < 0 ? '−' : ''}${Math.abs(m.excess).toFixed(1)} pts a year vs Nifty 50`;
  });
  marketSentence = computed(() => {
    const m = this.market();
    if (m.status === 'pending') return 'Checking your returns against the same money in the index.';
    if (m.status === 'unset') {
      return m.days !== null && m.days < 180
        ? `${m.days} days of history — the comparison needs 180.`
        : 'Nifty 50 prices are not available for your dates yet.';
    }
    if (m.diff === null) return null;
    const since = m.since ? ` since ${this.fmtDay(m.since)}` : '';
    return `${inrCompact(Math.abs(m.diff))} ${m.diff >= 0 ? 'more' : 'less'} than the same money in Nifty 50${since}.`;
  });
  marketCta: VerdictCta = { label: 'Performance', link: '/performance' };
  /** You vs the same money in Nifty 50 over the last year (A16: sliced from ALL). */
  spark = computed(() => {
    const perf = this.perfAll();
    if (!perf) return null;
    const pts = sliceSeries(perf.series, '1Y', this.todayIso);
    if (pts.length < 2 || !pts.some(p => typeof p[BENCH] === 'number')) return null;
    return sparkPaths(pts.map(p => p.value), pts.map(p => (typeof p[BENCH] === 'number' ? p[BENCH] as number : null)));
  });

  habit = computed(() => this.brief()?.on_track.habit ?? null);
  habitHasPlans = computed(() => (this.habit()?.planned_month ?? 0) > 0);
  habitStatus = computed<Status>(() => this.habitHasPlans() ? (this.habit()?.status ?? 'unset') : 'unset');
  /** Plans exist but there is no 6-month adherence yet (J13): the card says so instead of "Not set". */
  habitWord = computed(() => {
    const h = this.habit();
    return this.habitHasPlans() && (h?.adherence_6m_pct === null || h?.adherence_6m_pct === undefined) ? 'Not scored yet' : null;
  });
  habitSentence = computed(() => habitSentenceText(this.habit()));
  /** "Next: {name} ₹{amount} on {date}" (H11 `next_due`). */
  habitNext = computed(() => this.habitHasPlans() ? nextDueText(this.habit()?.next_due) : null);
  /** "Next milestone {label} {in}": a projection at the plans' monthly total, so it carries an est. tag. */
  habitMilestone = computed(() => this.habitHasPlans() ? milestoneText(this.habit()?.milestone) : null);
  habitCta = computed<VerdictCta>(() => ({ label: this.habitHasPlans() ? 'Recurring plans' : 'Add your SIPs', link: '/recurring' }));

  /* ── T2 why it moved: chart ── */
  chartHeight = computed(() => this.phone() ? 220 : 260);
  private sliced = computed(() => {
    const perf = this.perfAll();
    return perf ? sliceSeries(perf.series, this.range(), this.todayIso) : [];
  });
  /** The points on the chart: the ALL slice, or that range's own payload when the slice is too thin. */
  points = computed<PerfPoint[]>(() => {
    const r = this.range(), own = this.ranged()[r];
    if (r !== 'ALL' && this.sliced().length < MIN_SLICE_POINTS && own) return activeSeries(own.series);
    return this.sliced();
  });
  hasChart = computed(() => !!this.perfAll() || !!this.ranged()[this.range()]);
  labels = computed(() => this.points().map(p => p.date));
  hasBench = computed(() => this.points().some(p => typeof p[BENCH] === 'number'));
  series = computed<LineSeries[]>(() => {
    const s = this.points();
    return [
      { key: 'value', label: 'Portfolio value', color: 'var(--s1)', values: s.map(p => p.value), area: true },
      { key: 'net', label: 'Money invested', color: 'var(--muted)', values: s.map(p => p.net_invested), muted: true },
      ...(this.hasBench() ? [{ key: BENCH, label: 'Same money in Nifty 50', color: 'var(--s2)',
        values: s.map(p => (typeof p[BENCH] === 'number' ? p[BENCH] as number : null)) }] : []),
    ];
  });
  assumptionsCheck = computed(() => {
    const a = this.brief()?.assumptions_check;
    if (!a || a.verdict === 'too_short' || a.realised_pct === null) return null;
    // J18's verdict table, shared with Performance: above is info "Above range", below is watch "Below range"
    const meta = ASSUMPTIONS_CHECK_META[a.verdict] ?? ASSUMPTIONS_CHECK_META.too_short;
    return { ...a, status: meta.status, word: meta.word };
  });

  /* ── T2 why it moved: drivers ── */
  drivers = computed(() => {
    let rows: DriverRow[];
    if (this.driverView() === 'today') {
      const moved = this.store.openPositions().filter(p => p.day_change);
      const up = moved.filter(p => p.day_change > 0).sort((a, b) => b.day_change - a.day_change).slice(0, 3);
      const down = moved.filter(p => p.day_change < 0).sort((a, b) => a.day_change - b.day_change).slice(0, 3);
      rows = [...up, ...down.reverse()].map(p => ({ id: p.id, name: p.name, segment: p.segment, gain: p.day_change }));
    } else {
      const w = this.brief()?.why;
      const pick = (c: Contributor): DriverRow => ({ id: c.id, name: c.name, segment: c.segment, gain: c.gain });
      rows = w ? [...w.gainers.slice(0, 5).map(pick), ...w.losers.slice(0, 5).reverse().map(pick)] : [];
    }
    const max = Math.max(1, ...rows.map(r => Math.abs(r.gain)));
    return { rows, max };
  });
  whySegments = computed(() => (this.brief()?.why.segments ?? []).filter(s => s.gain)
    .map(s => ({ ...s, label: this.segLabel(s.segment), color: this.segColor(s.segment) })));
  whyNote = computed(() => {
    const w = this.brief()?.why;
    if (!w) return null;
    return { winners: w.winners, losers: w.losers_count, gains: w.gross_gains, losses: Math.abs(w.gross_losses) };
  });

  /* ── T2 where your money is ── */
  allocation = computed(() => {
    const rows = (this.brief()?.allocation ?? []).filter(a => (a.value ?? 0) > 0 || a.target !== null);
    const targeted = rows.some(a => a.target !== null);
    const view = rows.map((a: AllocationRow) => {
      // drift is measured within the classes that have a target (mix share = target + drift)
      const share = targeted && a.target !== null && a.drift !== null ? a.target + a.drift : a.pct;
      return { ...a, share, label: this.segLabel(a.segment), color: this.segColor(a.segment),
        route: SEGMENT_META[a.segment]?.route ?? PORTFOLIO_HOLDINGS_HOME };
    }).sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
    const scale = Math.max(1, ...view.map(r => Math.max(r.share ?? 0, r.target ?? 0)));
    const total = view.reduce((s, r) => s + (r.value ?? 0), 0);
    return { rows: view.slice(0, 8), scale, targeted, total, classes: view.filter(r => (r.value ?? 0) > 0).length };
  });
  slices = computed<Slice[]>(() => this.allocation().rows.filter(r => (r.value ?? 0) > 0)
    .map(r => ({ label: r.label, value: r.value, color: r.color })));
  mixVital = computed(() => vitalOf(this.brief()?.vitals, 'mix') ?? null);

  /* ── T2 coming up (P1: hidden while brief.upcoming is null) ── */
  /** D4: the class furthest under target, suggested on FD maturity rows. */
  suggestSegment = computed(() => {
    const seg = underTargetSegment(this.brief()?.allocation);
    return seg ? this.segLabel(seg) : null;
  });
  upcoming = computed(() => {
    const u = this.brief()?.upcoming;
    if (!u) return null;
    const suggest = this.suggestSegment();
    const groups: { month: string; events: (UpcomingEvent & { icon: string; color: string; amt: number; day: string; mon: string;
      suggest: string | null })[] }[] = [];
    for (const e of (u.events ?? []).slice(0, 8)) {
      const d = new Date(e.date + 'T00:00:00');
      const month = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      const k = EVENT_KIND[e.kind] ?? { icon: 'calendar', color: 'var(--muted)' };
      const row = { ...e, ...k, amt: Math.abs(e.amount ?? 0), day: String(d.getDate()), mon: d.toLocaleDateString('en-IN', { month: 'short' }),
        suggest: e.kind === 'fd_maturity' ? suggest : null };
      const last = groups[groups.length - 1];
      if (last && last.month === month) last.events.push(row); else groups.push({ month, events: [row] });
    }
    return { ...u, groups };
  });

  /* ── T3 ── */
  tax = computed(() => this.brief()?.tax ?? null);

  segLabel = (seg: string) => SEGMENT_META[seg]?.label ?? seg;
  segColor = (seg: string) => SEGMENT_COLOR[seg] ?? 'var(--s7)';
  fmtDay = (d: string) => fmtDate(d.slice(0, 10));

  constructor() {
    this.watchPhone();

    // The brief: paint this portfolio's last copy at once, then revalidate on every store version
    effect(() => {
      const v = this.store.version(), scope = this.store.scopeKey();
      if (!this.auth.token()) return;
      untracked(() => {
        if (scope !== this.shownScope) {
          this.shownScope = scope;
          this.brief.set(asBrief(readSnapshot<Brief>(snapshotKey('brief', scope))));
          this.perfAll.set(readSnapshot<Performance>(snapshotKey('perf', scope, 'ALL')));
          this.ranged.set({});
          this.hidden.set(new Set());
          this.briefError.set(null);
          this.perfError.set(null);
          this.startVisit(scope);
        }
        queueMicrotask(() => void this.loadBrief(v, scope));
      });
    });

    // A range the ALL slice can't draw (a long history downsampled thin) fetches its own payload
    effect(() => {
      const r = this.range(), all = this.perfAll(), have = this.ranged()[r];
      if (r === 'ALL' || !all || have) return;
      if (sliceSeries(all.series, r, this.todayIso).length >= MIN_SLICE_POINTS) return;
      untracked(() => void this.loadRange(r, this.store.scopeKey()));
    });

    const onLeave = () => { if (this.shownScope) markVisit(this.shownScope); };
    window.addEventListener('pagehide', onLeave);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('pagehide', onLeave);
      clearTimeout(this.visitTimer);
      clearTimeout(this.refetchTimer);
    });
  }

  private shownScope = '';
  private visitTimer: ReturnType<typeof setTimeout> | undefined;
  private refetchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Reads the previous visit (once per session), then counts this one after 30 s on Home. */
  private startVisit(scope: string) {
    sinceFor(scope);
    clearTimeout(this.visitTimer);
    this.visitTimer = setTimeout(() => markVisit(scope), VISIT_MS);
  }

  private watchPhone() {
    try {
      const mq = window.matchMedia('(max-width: 760px)');
      this.phone.set(mq.matches);
      const on = (e: MediaQueryListEvent) => this.phone.set(e.matches);
      mq.addEventListener('change', on);
      this.destroyRef.onDestroy(() => mq.removeEventListener('change', on));
    } catch { /* no matchMedia (tests, old browsers): desktop sizes */ }
  }

  private briefKey = '';
  private briefNonce = 0;

  /** GET /brief?since=lastVisit. A rejected `since` (a bad stored date) retries once without it. */
  async loadBrief(version: number, scope: string, force = false) {
    if (force) this.briefNonce++;
    const key = `${version}|${scope}|${this.briefNonce}`;
    if (key === this.briefKey) return;
    this.briefKey = key;
    this.briefLoading.set(true);
    const since = sinceFor(scope);
    try {
      let b: Brief;
      try {
        b = await firstValueFrom(this.api.brief(since));
      } catch (e) {
        if (!(since && e instanceof HttpErrorResponse && e.status === 400)) throw e;
        sinceByScope.set(scope, null);
        b = await firstValueFrom(this.api.brief(null));
      }
      if (key !== this.briefKey) return;  // a newer version or portfolio was asked for meanwhile
      const brief = asBrief(b);
      this.brief.set(brief);
      this.briefError.set(null);
      if (brief) writeSnapshot(snapshotKey('brief', scope), brief);
    } catch (e) {
      if (key === this.briefKey) this.briefError.set(errorMessage(e));
    } finally {
      if (key === this.briefKey) {
        this.briefLoading.set(false);
        // T2 after the answers have painted (A16: ALL, the memo key /brief peeks)
        if (!this.brief()?.empty) setTimeout(() => void this.loadPerf(version, scope), 0);
      }
    }
  }

  retryBrief() { void this.loadBrief(this.store.version(), this.store.scopeKey(), true); }

  private perfKey = '';
  async loadPerf(version: number, scope: string) {
    const key = `${version}|${scope}`;
    if (key === this.perfKey) return;
    this.perfKey = key;
    this.perfLoading.set(true);
    this.ranged.set({});
    try {
      const perf = await firstValueFrom(this.api.performance('ALL'));
      if (key !== this.perfKey) return;  // superseded: the newer load owns the loading flag
      this.perfAll.set(perf);
      this.perfError.set(null);
      this.perfLoading.set(false);
      writeSnapshot(snapshotKey('perf', scope, 'ALL'), perf);
    } catch (e) {
      if (key !== this.perfKey) return;
      this.perfError.set(errorMessage(e));
      this.perfLoading.set(false);
      this.perfKey = '';  // let the next revalidation (or Retry) try again
    }
  }

  retryPerf() { this.perfKey = ''; void this.loadPerf(this.store.version(), this.store.scopeKey()); }

  private rangeLoading = new Set<string>();
  private async loadRange(range: ChartRange, scope: string) {
    const tag = `${scope}|${range}`;
    if (this.rangeLoading.has(tag)) return;
    this.rangeLoading.add(tag);
    try {
      const perf = await firstValueFrom(this.api.performance(range));
      if (scope === this.store.scopeKey()) this.ranged.update(m => ({ ...m, [range]: perf }));
    } catch { /* the thin slice stays on screen */ } finally {
      this.rangeLoading.delete(tag);
    }
  }

  /** A card's ⋯ menu changed an action: hide it now and re-read the brief once the POST has landed. */
  onActionChanged(id: string) {
    this.hidden.update(s => new Set([...s, id]));
    clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => void this.loadBrief(this.store.version(), this.store.scopeKey(), true), 1500);
  }

  refreshPrices() { void this.store.refreshPrices(true); }

  /** Onboarding step: the runner opens the dialog or route; guests go to the step's page instead (§4 Home states). */
  runOnboard(a: Action) { void this.runner.run(a); }

  /** A raw link ("/tax?tab=save", "/actions#deploy"): navigateByUrl keeps `?` and `#` intact (A13, E19). */
  openLink(e: MouseEvent, link: string | null | undefined) {
    if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    void this.router.navigateByUrl(link);
  }

  /** A donut slice names its class by label: open that class's page. */
  goSegment(label: string) {
    const row = this.allocation().rows.find(r => r.label === label);
    if (row) void this.router.navigateByUrl(row.route);
  }

  /** The backend stamps prices in naive UTC (brief.py `_ts`); without a zone, `new Date()` would read local time. */
  utc(stamp: string | null | undefined): string | null {
    if (!stamp) return null;
    return /[zZ]|[+-]\d\d:?\d\d$/.test(stamp) || stamp.length <= 10 ? stamp : stamp.replace(' ', 'T') + 'Z';
  }

  /** Excess return in points, signed: "+1.2", "−0.4". */
  pts(v: number) { return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`; }
}
