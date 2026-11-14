import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES, inr, inrCompact, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { AssumptionsCheck, Attribution, Benchmark, Brief, Contributor, Income, IncomeMonth, MarketTrack, Performance, SEGMENTS, Status, activeSeries } from '../../core/models';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { PortfolioTabsComponent } from '../../shared/portfolio-tabs.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';
import { ASSUMPTIONS_CHECK_META, STATUS_META, statusFromExcess } from '../../shared/priority/priority';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The range control, in display order. No `?range` means ALL (AMENDMENTS E20). */
export const PERF_RANGES = ['1M', '3M', '6M', '1Y', '3Y', 'YTD', 'FY', 'ALL'] as const;
export type PerfRange = typeof PERF_RANGES[number];
const DEFAULT_RANGE: PerfRange = 'ALL';
/** How long a linked section (#attribution, #assumptions) is kept aligned while late paints land. */
const SETTLE_MS = 4000;
/** The benchmark the T0 verdict and Home's market card use (story.PRIMARY_BENCH). */
const PRIMARY_BENCH = 'NIFTY50';

const RANGE_LABEL: Record<PerfRange, string> = {
  '1M': 'the last month', '3M': 'the last 3 months', '6M': 'the last 6 months', '1Y': 'the last year',
  '3Y': 'the last 3 years', 'YTD': 'this calendar year', 'FY': 'this financial year', 'ALL': 'since you started',
};

/** The T0 "vs Nifty 50" verdict: always the since-start (ALL) comparison of the whole portfolio (A16, E20). */
export interface MarketVerdict { status: Status; excess: number | null; days: number | null; since: string | null; diff: number | null; }

/** "+1.2 pts" / "−0.4 pts": signed with a real minus so the sign never relies on colour. */
export function signedPts(v: number | null | undefined): string {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} pts`;
}

/**
 * The market verdict from Home's rule (priority.ts `statusFromExcess`, mirroring brief.py `_market_track`).
 * The brief's own card wins once it is no longer pending; otherwise it is rebuilt from the whole-portfolio ALL
 * payload, with `value` (today's portfolio value) − the index's `end_value` as the ₹ difference.
 * Returns null while neither is available (the allowed "Comparing with Nifty 50…" placeholder).
 */
export function marketVerdict(market: MarketTrack | null | undefined, all: Performance | null, value: number | null, on: string): MarketVerdict | null {
  if (market && market.status !== 'pending') {
    return { status: market.status, excess: market.excess, days: market.days, since: market.since, diff: market.diff_value };
  }
  if (!all) return null;
  const since = all.metrics?.start ?? null;
  const days = since ? Math.round((Date.parse(on + 'T00:00:00Z') - Date.parse(since + 'T00:00:00Z')) / 86_400_000) : null;
  const row = (all.benchmarks ?? []).find(b => b.key === PRIMARY_BENCH && b.xirr !== null);
  if (!row) return { status: 'unset', excess: null, days, since, diff: null };
  const end = value ?? all.metrics?.end_value ?? null;
  return { status: statusFromExcess(row.excess_xirr, days), excess: row.excess_xirr, days, since,
    diff: end === null ? null : Math.round((end - row.end_value) * 100) / 100 };
}

/** Brief attribution narrowed to one segment (A26): gainers and losers filtered; per-segment gains kept for context. */
export function attributionFor(why: Attribution | null | undefined, segment: string): { gainers: Contributor[]; losers: Contributor[] } {
  if (!why) return { gainers: [], losers: [] };
  const keep = (c: Contributor) => !segment || c.segment === segment;
  return { gainers: (why.gainers ?? []).filter(keep), losers: (why.losers ?? []).filter(keep) };
}

/** One decimal with a real minus ("9.6", "−2.1"); "—" when missing. */
export function oneDp(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return `${r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)}`;
}

/** The Assumptions check as the card shows it (AMENDMENTS J18, H11). */
export interface AssumptionsView {
  status: Status;
  /** The badge word: never colour alone. */
  word: string;
  sentence: string;
  /** What it means for the plan, one line. */
  note: string;
  /** "Use 4.5% in the Plan →", split into a routerLink and its query, when `link` is set. */
  cta: { label: string; path: string; query: Record<string, string> } | null;
}

/**
 * `brief.assumptions_check` → the card: "Since you started ({years} yrs): {realised}%/yr · the plan assumes
 * {typical}% typical (range {lo}–{hi}%) — {verdict}". within → good, above → info, below → watch,
 * too_short → unset. The CTA's figure is the link's own `return` (the realised return rounded to 0.5, H11),
 * so the label always matches what the Plan receives. Null in, null out.
 */
export function assumptionsView(c: AssumptionsCheck | null | undefined): AssumptionsView | null {
  if (!c) return null;
  const meta = ASSUMPTIONS_CHECK_META[c.verdict] ?? ASSUMPTIONS_CHECK_META.too_short;
  const sentence = `Since you started (${oneDp(c.years)} yrs): ${oneDp(c.realised_pct)}%/yr · the plan assumes `
    + `${oneDp(c.typical)}% typical (range ${oneDp(c.lo)}–${oneDp(c.hi)}%) — ${meta.tail}`;
  let cta: AssumptionsView['cta'] = null;
  if (c.link) {
    const [path, qs = ''] = c.link.split('?');
    const query: Record<string, string> = {};
    new URLSearchParams(qs).forEach((v, k) => { query[k] = v; });
    const ret = query['return'] !== undefined ? Number(query['return']) : c.realised_pct;
    cta = { label: `Use ${oneDp(ret)}% in the Plan →`, path: path || '/plan', query };
  }
  return { status: meta.status, word: meta.word, sentence, note: meta.note, cta };
}

/** The income kinds, in their fixed colour order (categorical --s1, --s2, --s3; never cycled). */
export const INCOME_KINDS = [
  { key: 'dividends', label: 'Dividends', color: 'var(--s1)' },
  { key: 'p2p_interest', label: 'P2P interest', color: 'var(--s2)' },
  { key: 'fd_interest', label: 'FD interest', color: 'var(--s3)' },
] as const;
export type IncomeKind = typeof INCOME_KINDS[number]['key'];

export interface IncomeBar {
  month: string;
  /** "Mar 2025" for the readout and the table; `tick` is "Mar ’25" on every sixth bar, else ''. */
  label: string;
  tick: string;
  total: number;
  /** The stack's height as % of the tallest month. */
  h: number;
  /** Bottom-up segments with a share of the stack; zero amounts are left out so no empty gap is drawn. */
  segs: { key: IncomeKind; label: string; color: string; amount: number; share: number }[];
}

/** GET /income months → stacked bars scaled to the tallest month. A month with no income has no stack. */
export function incomeBars(months: IncomeMonth[] | null | undefined): IncomeBar[] {
  const rows = months ?? [];
  const max = Math.max(...rows.map(r => r.total || 0), 0);
  return rows.map((r, i) => {
    const [y, mo] = r.month.split('-');
    const name = MONTHS[(+mo || 1) - 1];
    const total = r.total || 0;
    const segs = INCOME_KINDS.map(k => ({ key: k.key, label: k.label, color: k.color, amount: r[k.key] || 0, share: 0 }))
      .filter(s => s.amount > 0).map(s => ({ ...s, share: total > 0 ? s.amount / total * 100 : 0 }));
    return { month: r.month, label: `${name} ${y}`, tick: i % 6 === 0 ? `${name} ’${y.slice(2)}` : '', total,
      h: max > 0 ? total / max * 100 : 0, segs };
  });
}

/**
 * Portfolio › Performance (`/performance?range&segment`), Part 1 §5.4 with AMENDMENTS A16, A21, A22, A26, A27,
 * D13, D22, E20, H11 and J18.
 *
 * - T0: your XIRR for the range, the since-start verdict against Nifty 50 (Home's market rule), and the
 *   gain, TWR and fall-from-peak tiles.
 * - T1: the page's "Needs attention here" strip, then the one work surface: you vs the same money in an
 *   index, plus the Compared-with table.
 * - T2: Growth of ₹100, the monthly heat table, Attribution (`#attribution`, from `brief.why`), the
 *   Assumptions check (`#assumptions`, from `brief.assumptions_check`, with "Use x% in the Plan →" when the
 *   brief links `/plan?return=`) and the Income card (GET /income, fetched after paint: 24 months of
 *   stacked dividends, P2P and FD interest, the last 12 months and the top payers).
 * - T3: methodology.
 *
 * Concentration lives on Risk & mix now (J8): `/performance#concentration` forwards to `/risk#concentration`
 * with `replaceUrl`, so old links still land.
 *
 * `/performance` paints from the device snapshot per range and segment, then revalidates. No `?range`
 * means ALL, the memo key `/brief` peeks, so a visit here warms Home's market card. The brief is Home's
 * snapshot, else `GET /brief` without `since`, never written back (E20).
 */
@Component({
  selector: 'app-performance',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, LineChartComponent, PortfolioTabsComponent, NeedsAttentionComponent,
    AssumptionChipComponent, StatusBadgeComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './performance.component.html',
  styleUrl: './performance.component.scss',
})
export class PerformanceComponent {
  store = inject(StoreService);
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly ranges = PERF_RANGES;
  readonly segments = SEGMENTS;
  readonly months = MONTHS;
  readonly pts = signedPts;
  readonly statusMeta = STATUS_META;

  // ── URL state: ?range&segment (replaceUrl), #attribution / #assumptions (#concentration forwards to /risk) ──
  private query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  private fragment = toSignal(this.route.fragment, { initialValue: this.route.snapshot.fragment });
  range = computed<PerfRange>(() => {
    const r = (this.query().get('range') ?? '').toUpperCase();
    return (PERF_RANGES as readonly string[]).includes(r) ? r as PerfRange : DEFAULT_RANGE;
  });
  segment = computed(() => {
    const s = this.query().get('segment') ?? '';
    return (SEGMENTS as readonly string[]).includes(s) ? s : '';
  });
  rangeLabel = computed(() => RANGE_LABEL[this.range()]);
  /** The whole-portfolio ALL view: the same payload `/brief` peeks. */
  isAll = computed(() => this.range() === 'ALL' && !this.segment());

  // ── data ──
  perf = signal<Performance | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  /** The whole-portfolio ALL payload when the page shows another range or a segment (verdict fallback only). */
  private allExtra = signal<Performance | null>(null);
  brief = signal<Partial<Brief> | null>(null);
  briefLoading = signal(false);
  briefError = signal<string | null>(null);
  bench = signal(PRIMARY_BENCH);
  moreStats = signal(false);

  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);
  idxFmt = (v: number) => (v * 100).toFixed(0);
  idxTip = (v: number) => `₹${(v * 100).toFixed(1)}`;

  m = computed(() => this.perf()?.metrics);
  /** No transactions in this view (the API returns an empty series and empty metrics). */
  empty = computed(() => { const p = this.perf(); return !!p && !(p.series?.length); });
  twr = computed(() => { const m = this.m(); return m ? (m.twr_annualised ?? m.twr) : null; });
  twrAnnual = computed(() => this.m()?.twr_annualised !== null && this.m()?.twr_annualised !== undefined);

  // ── T0 verdict: since-start, whole portfolio (A16, E20) ──
  private allPerf = computed(() => this.isAll() ? this.perf() : this.allExtra());
  verdict = computed(() => marketVerdict(this.brief()?.on_track?.market, this.allPerf(),
    this.store.portfolio()?.totals.value ?? null, today()));
  verdictMeta = computed(() => STATUS_META[this.verdict()?.status ?? 'unset']);
  verdictText = computed(() => {
    const v = this.verdict();
    if (!v) return 'Comparing with Nifty 50…';
    if (v.excess === null) return 'No Nifty 50 comparison yet';
    if (v.days !== null && v.days < 180) return `vs Nifty 50 ${signedPts(v.excess)} · too early to judge`;
    return `vs Nifty 50 ${signedPts(v.excess)}`;
  });

  // ── T1 work surface ──
  benchOptions = computed<Benchmark[]>(() => this.perf()?.benchmarks ?? []);
  activeBench = computed<Benchmark | undefined>(() => this.benchOptions().find(b => b.key === this.bench()) ?? this.benchOptions()[0]);
  points = computed(() => activeSeries(this.perf()?.series ?? []));
  labels = computed(() => this.points().map(p => p.date));
  valueSeries = computed<LineSeries[]>(() => {
    const s = this.points();
    const b = this.activeBench();
    const out: LineSeries[] = [
      { key: 'value', label: 'Your portfolio', color: 'var(--s1)', values: s.map(p => p.value), area: true },
      { key: 'net', label: 'Net invested', color: 'var(--muted)', values: s.map(p => p.net_invested), muted: true },
    ];
    if (b) out.push({ key: b.key, label: `Same money in ${b.label}`, color: 'var(--s2)', values: s.map(p => (p[b.key] as number | null) ?? null) });
    return out;
  });
  /** Compared-with rows: ₹ difference = your end value − the same flows' end value in the index. */
  compared = computed(() => {
    const end = this.m()?.end_value ?? null;
    return this.benchOptions().map(b => ({ ...b, diff: end === null || b.xirr === null ? null : end - b.end_value }));
  });

  // ── T2 ──
  indexSeries = computed<LineSeries[]>(() => [{ key: 'idx', label: 'Growth of ₹100', color: 'var(--s1)', values: this.points().map(p => p.index), area: true }]);
  heat = computed(() => {
    const rows = new Map<string, (number | null)[]>();
    for (const r of this.perf()?.monthly ?? []) {
      const [y, mo] = r.month.split('-');
      if (!rows.has(y)) rows.set(y, Array(12).fill(null));
      rows.get(y)![+mo - 1] = r.return;
    }
    return [...rows.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, vals]) => {
      const known = vals.filter((v): v is number => v !== null);
      const total = known.length ? (known.reduce((a, v) => a * (1 + v / 100), 1) - 1) * 100 : null;
      return { year, vals, total };
    });
  });
  heatBg(v: number | null): string {
    if (v === null) return 'transparent';
    const k = Math.min(Math.abs(v) / 8, 1) * 70;
    return `color-mix(in srgb, ${v >= 0 ? 'var(--s1)' : 'var(--s8)'} ${k.toFixed(0)}%, var(--div-mid))`;
  }
  /** Heat cell text: a ▲/▼ glyph so gain and loss never rely on colour alone. */
  heatCell(v: number | null, digits = 0): string {
    if (v === null) return '';
    const r = Number(v.toFixed(digits));
    return `${r > 0 ? '▲' : r < 0 ? '▼' : ''}${Math.abs(r).toFixed(digits)}`;
  }

  why = computed<Attribution | null>(() => this.brief()?.why ?? null);
  attr = computed(() => attributionFor(this.why(), this.segment()));
  attrSegments = computed(() => {
    const rows = this.why()?.segments ?? [];
    const max = Math.max(...rows.map(r => Math.abs(r.gain)), 1);
    return rows.map(r => ({ ...r, w: Math.abs(r.gain) / max * 100, on: r.segment === this.segment() }));
  });

  // ── T2: assumptions check (#assumptions): whole portfolio, since you started (J18, H11) ──
  check = computed(() => this.brief()?.assumptions_check ?? null);
  checkView = computed(() => assumptionsView(this.check()));
  /** True while the brief is re-asked because the one this page holds predates the ALL payload (see `recheckFor`). */
  rechecking = signal(false);

  // ── T2: income (GET /income, after paint, once per scope and data version) ──
  readonly incomeKinds = INCOME_KINDS;
  income = signal<Income | null>(null);
  incomeLoading = signal(false);
  incomeError = signal<string | null>(null);
  incomeBars = computed(() => incomeBars(this.income()?.months));
  /** Nothing earned in the 24 months shown. */
  incomeEmpty = computed(() => !!this.income() && !this.incomeBars().some(b => b.total > 0));
  /** Per-kind totals over the 24 months, for the legend. */
  incomeTotals = computed(() => {
    const rows = this.income()?.months ?? [];
    return INCOME_KINDS.map(k => ({ ...k, amount: rows.reduce((a, r) => a + (r[k.key] || 0), 0) }));
  });
  /** The two y gridlines: the tallest month and half of it. */
  incomeMax = computed(() => Math.max(...this.incomeBars().map(b => b.total), 0));
  topPayers = computed(() => (this.income()?.top_payers ?? []).slice(0, 5));
  /** The bar under the pointer (or tapped); the readout shows the latest month otherwise. */
  incomeHover = signal<number | null>(null);
  incomeFocus = computed(() => {
    const bars = this.incomeBars();
    if (!bars.length) return null;
    const i = this.incomeHover();
    return bars[i !== null && i < bars.length ? i : bars.length - 1];
  });
  /** The month-by-month table view, latest first (the chart's text alternative). */
  incomeRows = computed(() => [...this.incomeBars()].reverse());
  amountOf = (b: IncomeBar, k: IncomeKind) => b.segs.find(s => s.key === k)?.amount ?? 0;

  private seq = 0;
  private allSeq = 0;
  private incomeSeq = 0;
  private host = inject(ElementRef);
  private stopSettle: (() => void) | null = null;
  /** The `.page` block: the host is an inline element, which a ResizeObserver never reports on. */
  private page = (): Element => (this.host.nativeElement as HTMLElement).firstElementChild ?? this.host.nativeElement;
  private scrolledTo: string | null = null;
  private paintedScope: string | null = null;
  private briefScope: string | null = null;
  /** `scope#version` the whole-portfolio ALL payload was last fetched for. */
  private allFor: string | null = null;
  /** `scope#version` this page last fetched the whole-portfolio ALL payload over the network for. */
  private allFresh = signal<string | null>(null);
  /** `scope#version` the brief was re-asked for because its assumptions_check was null. */
  private recheckFor: string | null = null;
  /** `scope#version` GET /income was last asked for. */
  private incomeFor: string | null = null;
  /** Set when the page opened on `#concentration`: it forwards to /risk at once and loads nothing. */
  private forwarding = this.route.snapshot.fragment === 'concentration';

  constructor() {
    // Concentration moved to Risk & mix (J8, J18): old links land there, without a history entry.
    effect(() => {
      if (this.fragment() !== 'concentration') return;
      this.forwarding = true;
      untracked(() => void this.router.navigate(['/risk'], { fragment: 'concentration', replaceUrl: true }));
    });

    // The period payload: paint from this device's snapshot, then revalidate.
    effect(() => {
      const range = this.range(), segment = this.segment(), scope = this.store.scopeKey();
      this.store.version();
      untracked(() => {
        if (this.forwarding) return;
        const key = this.perfKey(scope, range, segment);
        const snap = key ? readSnapshot<Performance>(key) : null;
        // Another range or segment of the same portfolio stays on screen, faded, until the answer arrives;
        // another portfolio's numbers never do.
        if (snap) this.perf.set(snap);
        else if (scope !== this.paintedScope) this.perf.set(null);
        this.paintedScope = scope;
        queueMicrotask(() => void this.load(range, segment, scope));
      });
    });

    // The brief: Home's snapshot first; otherwise GET /brief without `since`, never written back (E20).
    effect(() => {
      const scope = this.store.scopeKey();
      this.store.version();
      untracked(() => {
        if (this.forwarding) return;
        const snap = readSnapshot<Partial<Brief>>(snapshotKey('brief', scope));
        if (snap) { this.brief.set(snap); this.briefError.set(null); }
        else {
          if (scope !== this.briefScope) this.brief.set(null);  // never another portfolio's attribution
          queueMicrotask(() => void this.loadBrief(scope));
        }
        this.briefScope = scope;
      });
    });

    // The verdict needs the whole-portfolio ALL payload only when the brief's market card cannot answer.
    effect(() => {
      const all = this.isAll(), scope = this.store.scopeKey(), market = this.brief()?.on_track?.market;
      const version = this.store.version();
      const needed = !all && (!market || market.status === 'pending');
      untracked(() => {
        const key = `${scope}#${version}`;
        if (this.forwarding || !needed || this.allFor === key) return;
        this.allFor = key;
        const snap = readSnapshot<Performance>(snapshotKey('perf', scope, 'ALL'));
        this.allExtra.set(snap);
        queueMicrotask(() => void this.loadAll(scope));
      });
    });

    // A brief built before the ALL payload was warm has no assumptions_check (H11 builds it only from a peeked
    // performance). Once this page has fetched that payload, ask GET /brief once more per scope#version: its memo
    // key carries perf_ready (A16), so the answer now has the check. Never written back (E20).
    effect(() => {
      const b = this.brief(), fresh = this.allFresh();
      const key = `${this.store.scopeKey()}#${this.store.version()}`;
      if (!b || b.empty || b.assumptions_check || fresh !== key) return;
      untracked(() => {
        if (this.recheckFor === key) return;
        this.recheckFor = key;
        queueMicrotask(() => void this.recheck(this.store.scopeKey()));
      });
    });

    // Income: T2, so only after the page has painted; once per scope and data version.
    effect(() => {
      const painted = !!this.m(), scope = this.store.scopeKey(), version = this.store.version();
      if (!painted) return;
      untracked(() => {
        const key = `${scope}#${version}`;
        if (this.incomeFor === key) return;
        if (this.incomeFor?.split('#')[0] !== scope) { this.income.set(null); this.incomeHover.set(null); }  // never another portfolio's income
        this.incomeFor = key;
        queueMicrotask(() => void this.loadIncome(scope));
      });
    });

    // Scroll to #attribution or #assumptions once its section is on the page (both read the brief).
    effect(() => {
      const f = this.fragment();
      const painted = !!this.m() && !this.empty();  // both sections live inside the painted page
      const ready = painted && (f === 'attribution' || f === 'assumptions') && (!!this.brief() || !!this.briefError());
      if (!f || !ready || this.scrolledTo === f) return;
      this.scrolledTo = f;
      untracked(() => this.settle(f));
    });

    inject(DestroyRef).onDestroy(() => { this.seq++; this.allSeq++; this.incomeSeq++; this.stopSettle?.(); });
  }

  /**
   * Bring `#id` to the top and keep it there while the page settles (as Settings and Risk & mix do). Charts,
   * the strip and the income card arrive after the section does and change the height above or below it, and
   * a smooth scroll is easily cut short by those late paints. So: an instant jump two macrotasks later (after
   * the render and the router's own anchor scroll), then a re-align on every resize of the page until the user
   * scrolls, taps or types, or SETTLE_MS passes. `scroll-margin-top` keeps the heading clear of the app bar.
   */
  private settle(id: string) {
    this.stopSettle?.();
    if (typeof window === 'undefined') return;
    const align = () => document.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => align()) : null;
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    let first: ReturnType<typeof setTimeout> = setTimeout(() => { first = setTimeout(() => { align(); ro?.observe(this.page()); }); });
    const stop = () => {
      ro?.disconnect();
      clearTimeout(first);
      clearTimeout(end);
      events.forEach(e => window.removeEventListener(e, stop));
      if (this.stopSettle === stop) this.stopSettle = null;
    };
    const end = setTimeout(stop, SETTLE_MS);
    events.forEach(e => window.addEventListener(e, stop, { passive: true }));
    this.stopSettle = stop;
  }

  /**
   * The device snapshot key: the same `perf|scope|range` Home uses for the whole portfolio. Segment views are
   * not kept (null): up to 8 × 9 payloads could overrun storage, and an overrun clears every snapshot, the brief included.
   */
  private perfKey(scope: string, range: string, segment: string): string | null {
    return segment ? null : snapshotKey('perf', scope, range);
  }

  setRange(r: PerfRange) { this.navigate({ range: r === DEFAULT_RANGE ? null : r }); }
  setSegment(s: string) { this.navigate({ segment: s || null }); }
  private navigate(queryParams: Record<string, string | null>) {
    void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
  }

  async load(range: string, segment: string, scope: string) {
    const mine = ++this.seq;
    const version = this.store.version();
    this.loading.set(true);
    try {
      const p = await firstValueFrom(this.api.performance(range, segment || null));
      if (mine !== this.seq) return;
      this.perf.set(p);
      this.error.set(null);
      const key = this.perfKey(scope, range, segment);
      if (key && p.series?.length) writeSnapshot(key, p);
      if (range === 'ALL' && !segment) { this.allExtra.set(null); this.allFresh.set(`${scope}#${version}`); }
      if (!p.benchmarks.some(b => b.key === this.bench()) && p.benchmarks.length) this.bench.set(p.benchmarks[0].key);
    } catch (e) {
      if (mine === this.seq) this.error.set(errorMessage(e));
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }

  private async loadAll(scope: string) {
    const mine = ++this.allSeq;
    const version = this.store.version();
    try {
      const p = await firstValueFrom(this.api.performance('ALL', null));
      if (mine !== this.allSeq) return;
      this.allExtra.set(p);
      this.allFresh.set(`${scope}#${version}`);
      if (p.series?.length) writeSnapshot(snapshotKey('perf', scope, 'ALL'), p);
    } catch { /* the verdict keeps its placeholder */ }
  }

  async loadBrief(scope: string) {
    this.briefLoading.set(true);
    try {
      const b = await firstValueFrom(this.api.brief());
      if (scope !== this.store.scopeKey()) return;
      this.brief.set(b);
      this.briefError.set(null);
    } catch (e) {
      if (scope === this.store.scopeKey()) this.briefError.set(errorMessage(e));
    } finally {
      this.briefLoading.set(false);
    }
  }

  /** Re-ask the brief for its assumptions_check (see the effect). A failure keeps the brief already shown. */
  private async recheck(scope: string) {
    this.rechecking.set(true);
    try {
      const b = await firstValueFrom(this.api.brief());
      if (scope === this.store.scopeKey()) { this.brief.set(b); this.briefError.set(null); }
    } catch { /* the card keeps its "not worked out yet" line */ } finally {
      this.rechecking.set(false);
    }
  }

  /** GET /income for the signed-in scope (it has no segment or range: always the last 24 months). */
  async loadIncome(scope: string) {
    const mine = ++this.incomeSeq;
    this.incomeLoading.set(true);
    try {
      const r = await firstValueFrom(this.api.income());
      if (mine !== this.incomeSeq || scope !== this.store.scopeKey()) return;
      this.income.set(r);
      this.incomeError.set(null);
    } catch (e) {
      if (mine === this.incomeSeq) this.incomeError.set(errorMessage(e));
    } finally {
      if (mine === this.incomeSeq) this.incomeLoading.set(false);
    }
  }

  retry() { void this.load(this.range(), this.segment(), this.store.scopeKey()); }
  retryBrief() { void this.loadBrief(this.store.scopeKey()); }
  retryIncome() { void this.loadIncome(this.store.scopeKey()); }
  /** Pointer or tap on a month column; leaving the chart returns the readout to the latest month. */
  hoverIncome(i: number | null) { this.incomeHover.set(i); }
}
