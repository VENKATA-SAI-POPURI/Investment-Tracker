import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, downloadCsv, inrCompact, inrWords } from '../../core/format';
import { AssetClass, CLASS_COLOR, CLASS_LABEL, Position, SEGMENT_COLOR, SEGMENT_META, SegmentSummary, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { DonutChartComponent, Slice } from '../../shared/charts/donut-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { PORTFOLIO_HOLDINGS_HOME, PortfolioTabsComponent } from '../../shared/portfolio-tabs.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { SortState } from '../../shared/ui';

/** The route parameter: one asset class, or 'all' for the asset-class summary (G14). */
export type HoldingsView = AssetClass | 'all';

/** Classes this page lists as a holdings table. */
const TABLE_CLASSES: readonly AssetClass[] = ['equity', 'mutual_fund', 'commodity'];
/** Classes with a page of their own; /holdings/<class> forwards there (G14). */
const OWN_PAGE: Partial<Record<AssetClass, string>> = {
  p2p: '/p2p', fixed_deposit: '/fixed-deposits', cash: '/forex', epf: '/epf', nps: '/nps',
};
/** Classes whose value comes from a market price; the hero verdict counts the ones still at cost. */
const MARKET_PRICED: ReadonlySet<string> = new Set(['equity', 'mutual_fund', 'commodity']);
/** Unpriced share of value at which the hero verdict turns act (the Data vital's threshold, P0.7). */
const UNPRICED_ACT_PCT = 5;
/** "Add your first …" nouns, as the class chips name them. */
const NOUN: Partial<Record<AssetClass, string>> = { equity: 'stock', mutual_fund: 'mutual fund', commodity: 'gold or silver holding' };

/** The holdings table's optional columns (Part 1 §5.3). Name is always shown. */
export type ColKey = 'value' | 'return' | 'today' | 'weight' | 'xirr' | 'total_return' | 'realized' | 'owner';
interface ColDef { key: ColKey; label: string; sort: string; num: boolean; family?: boolean; }
const COLS: readonly ColDef[] = [
  { key: 'value', label: 'Value', sort: 'value', num: true },
  { key: 'return', label: 'Return', sort: 'unrealized_pct', num: true },
  { key: 'today', label: 'Today', sort: 'day_change', num: true },
  { key: 'weight', label: 'Weight', sort: 'weight', num: true },
  { key: 'xirr', label: 'XIRR', sort: 'xirr', num: true },
  { key: 'total_return', label: 'Total return', sort: 'total_return', num: true },
  { key: 'realized', label: 'Realised', sort: 'realized', num: true },
  { key: 'owner', label: 'Owner', sort: 'ownerName', num: false, family: true },
];
const COL_KEYS = new Set<string>(COLS.map(c => c.key));
const DEFAULT_COLS: readonly ColKey[] = ['value', 'return', 'today', 'weight'];
/** How many chosen columns stay visible on a phone; the rest hide below 760px. */
const PHONE_COLS = 2;

const colsKey = (cls: string) => `holdings:cols:${cls}`;
/** The saved column choice for a class, or null. Storage may be missing or throw (private mode): never fatal (G14). */
function readCols(cls: string): ColKey[] | null {
  try {
    const raw = localStorage.getItem(colsKey(cls));
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const ok = v.filter((k): k is ColKey => typeof k === 'string' && COL_KEYS.has(k));
    return ok.length ? ok : null;
  } catch {
    return null;
  }
}
function writeCols(cls: string, cols: ColKey[]) {
  try { localStorage.setItem(colsKey(cls), JSON.stringify(cols)); } catch { /* storage unavailable: the choice lasts this visit */ }
}

/** A finite number, else 0: every sum guards against a partial payload. */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** A finite number, else null. */
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface Group { key: string; value: number; pct: number; count: number; }
/** One asset-class row of the summary (T2 on /holdings/all). */
export interface ClassRow {
  segment: string; label: string; icon: string; route: string; color: string;
  invested: number; value: number; day: number; unrealized: number; unrealizedPct: number | null;
  realizedIncome: number; xirr: number | null; share: number; open: number;
}
/** The T0 verdict: how much of the value rests on a market price (Q1 "Am I OK?"; colour is never the only cue). */
export interface PricedVerdict { status: Status; text: string; }

/** Shades of the brand indigo for family members: `--s1..--s8` stay reserved for asset classes (§1.10). */
const MEMBER_SHADES = [100, 72, 52, 38, 26, 18];

/**
 * Portfolio › Holdings (Part 1 §5.3, P1.3; AMENDMENTS G14).
 *
 * `/holdings/all`:
 * - T0: hero Value (`totals.value`, today's change) with a priced-at-market verdict; Invested (Σ `segments.invested`),
 *   Total gain (`totals.total_gain`: unrealised / realised / income) and XIRR (`totals.xirr`).
 * - T1: Needs attention, links under `/holdings` and `/holding/`.
 * - T2: the asset-class summary moved from Home (drill to the top 8, tfoot; cards on phones) and the breakdown
 *   donut, which in family view switches By class | By member (`positions[].owner`, named from `auth.members()`).
 *
 * `/holdings/<equity|mutual_fund|commodity>`:
 * - T0: Value (share of the portfolio), Unrealised, Today, Realised + dividends.
 * - T1: Needs attention, links under `/holdings/<class>`, `/holding/<id>` and `/tax?tab=whatif&whatif=<id>`.
 * - T2: the holdings table (search, India/US, Closed, a column chooser saved per class, aria-sort, rows open
 *   `/holding/:id`) and an aside (Breakdown + Today's movers) that phones keep behind a "Breakdown" disclosure.
 *
 * Classes with their own page forward there and unknown classes go to `/holdings/all`, both with `replaceUrl`.
 * Reads only the store's portfolio (segments, totals, positions) and the cached `/actions` through NeedsAttention.
 */
@Component({
  selector: 'app-holdings',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, RouterLink, IconComponent, PortfolioTabsComponent, NeedsAttentionComponent, DonutChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './holdings.component.html',
  styles: [`
    .head-actions { flex-wrap: wrap; }
    .hero-skel { height: 150px; border-radius: 14px; }

    /* T0: hero + three tiles; phones keep the hero and two tiles, the last sits behind "More" (§1.5) */
    .h-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); }
    .h-kpis .words { margin-top: 0; }
    .h-kpis .hero-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .h-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; }
    .h-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .h-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .h-kpis .kpi.extra { grid-column: span 2; border-left: 0; border-top: 1px solid rgba(255, 255, 255, .09); }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .h-kpis .kpi.extra:not(.show) { display: none; }
      .h-kpis .words { display: none; }
    }

    .explains { display: block; }

    /* T2 asset-class summary (moved from Home) */
    .summary td { vertical-align: middle; }
    .summary tr.open > td { background: var(--surface-2); }
    .ac { display: flex; align-items: center; gap: 10px; border: 0; background: none; padding: 0; cursor: pointer; text-align: left; color: inherit; font: inherit; }
    .ac > span:nth-child(2) { display: flex; flex-direction: column; line-height: 1.25; }
    .ac b { font-weight: 600; font-size: var(--t-body); }
    .ac small { color: var(--muted); font-size: var(--t-label); }
    .ac-ic { flex: none; display: inline-flex; width: 28px; height: 28px; border-radius: 8px; align-items: center; justify-content: center; color: #fff; }
    .caret { color: var(--muted); transition: transform .15s; }
    .open .caret, [aria-expanded="true"] .caret { transform: rotate(180deg); }
    .share { display: inline-block; width: 46px; height: 5px; border-radius: 999px; background: var(--grid); margin-right: 8px; vertical-align: middle; overflow: hidden; }
    .share > i { display: block; height: 100%; border-radius: 999px; }
    .drill > td { padding: 0 !important; background: var(--surface-2); }
    .drill-list { display: flex; flex-direction: column; padding: 4px 22px 10px 60px; }
    .dh { display: grid; grid-template-columns: minmax(0, 1fr) 110px 100px 70px; gap: 12px; align-items: center; padding: 7px 0;
      border-bottom: 1px solid var(--border); color: var(--text); font-size: var(--t-meta); text-decoration: none; }
    .dh:hover { text-decoration: none; color: var(--primary); }
    .dh small { color: var(--muted); }
    .dh .chg { justify-self: end; }
    .dh.more { display: block; border-bottom: 0; color: var(--primary); font-weight: 500; padding-top: 9px; }
    .ac-cards { display: none; }
    @media (max-width: 760px) {
      .summary-table { display: none; }
      .ac-cards { display: flex; flex-direction: column; }
      .acc { border-bottom: 1px solid var(--border); }
      .acc:last-child { border-bottom: 0; }
      .acc-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; width: 100%; padding: 12px 16px;
        border: 0; background: none; text-align: left; cursor: pointer; color: inherit; font: inherit; }
      .acc.open .acc-head { background: var(--surface-2); }
      .acc-head .ac { pointer-events: none; }
      .acc-val { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
      .acc-meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--t-label); color: var(--muted); padding-left: 38px; }
      .acc-meta b { font-weight: 600; font-variant-numeric: tabular-nums; }
      .acc .drill-list { padding: 0 16px 10px 16px; background: var(--surface-2); }
      .dh { grid-template-columns: minmax(0, 1fr) 90px 60px; }
      .dh > span:nth-child(3) { display: none; }
      .acc-total { display: flex; justify-content: space-between; gap: 12px; padding: 12px 16px; font-weight: 600; background: var(--surface-2);
        border-top: 1px solid var(--border-strong); font-size: var(--t-meta); }
    }

    /* T2 breakdown donut */
    .bd { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 24px; align-items: center; }
    .bd-list { display: flex; flex-direction: column; min-width: 0; max-width: 560px; }
    .bd-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 56px; gap: 12px; align-items: center; padding: 8px 0;
      border-bottom: 1px solid var(--border); color: var(--text); font-size: var(--t-meta); text-decoration: none; }
    .bd-row:last-child { border-bottom: 0; }
    a.bd-row:hover { text-decoration: none; color: var(--primary); }
    .bd-row .nm { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .bd-row small { color: var(--muted); }
    @media (max-width: 760px) { .bd { grid-template-columns: minmax(0, 1fr); justify-items: center; } .bd-list { width: 100%; } }

    /* per-class table */
    .tbl-tools { padding-bottom: 14px; }
    .tbl-tools .search { max-width: 260px; }
    .th-btn { border: 0; background: none; padding: 0; font: inherit; color: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; }
    .th-btn:hover { color: var(--primary); }
    .cols { position: relative; }
    .cols > summary { list-style: none; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .cols > summary::-webkit-details-marker { display: none; }
    .cols-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 190px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-pop); font-size: var(--t-meta); }
    .cols-menu .hint { color: var(--muted); font-size: var(--t-label); }
    .name-link { color: var(--text); font-weight: 500; }
    @media (max-width: 760px) {
      /* Name plus two columns fit 390px without scrolling the table */
      .holdings-table th, .holdings-table td { padding: 10px 8px; }
      .holdings-table th:first-child, .holdings-table td:first-child { padding-left: 14px; }
      .holdings-table th:last-child, .holdings-table td:last-child { padding-right: 14px; }
      .holdings-table .name-cell { max-width: 150px; }
      .holdings-table .avatar-letter { display: none; }
      .tbl-tools .search { max-width: none; }
    }
    .name-link:hover { color: var(--primary); text-decoration: none; }

    .bars { display: grid; gap: 12px; }
    .bar-row { display: grid; gap: 5px; font-size: var(--t-meta); }
    .bl { display: flex; justify-content: space-between; gap: 10px; }
    .bl .num { font-weight: 600; }
    .track { height: 6px; background: var(--grid); border-radius: 999px; overflow: hidden; }
    .track > span { display: block; height: 100%; background: var(--primary); border-radius: 999px; }
    .mv { display: grid; grid-template-columns: minmax(0, 1fr) auto 62px; gap: 10px; align-items: center; width: 100%; padding: 9px 0;
      border: 0; border-bottom: 1px solid var(--border); background: none; cursor: pointer; text-align: left; font-size: var(--t-meta); color: var(--text); }
    .mv:last-child { border-bottom: 0; }
    .mv:hover .ellipsis { color: var(--primary); }
    .mv .num { font-weight: 600; font-size: var(--t-label); }
    .pill { text-align: center; font-size: var(--t-label); font-weight: 600; padding: 2px 0; border-radius: 6px; background: var(--surface-2); color: var(--muted); }
    .pill.up { background: var(--pos-soft); color: var(--pos); }
    .pill.down { background: var(--neg-soft); color: var(--neg); }

    /* the aside sits behind a "Breakdown" disclosure on phones */
    .aside-toggle { display: none; }
    @media (max-width: 760px) {
      .aside-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; }
      .aside-body:not(.open) { display: none; }
    }
    .aside-body { display: flex; flex-direction: column; gap: 20px; }
  `],
})
export class HoldingsComponent {
  /** `/holdings/:assetClass` (route input binding). */
  assetClass = input.required<HoldingsView>();
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private router = inject(Router);

  readonly statusMeta = STATUS_META;
  readonly allCols = COLS;
  words = inrWords;
  inrc = (v: number) => inrCompact(v);

  constructor() {
    // Dedicated pages and unknown classes leave this page without a history entry (G14)
    effect(() => {
      const c = this.assetClass();
      const target = this.redirectFor(c);
      if (target) untracked(() => void this.router.navigateByUrl(target, { replaceUrl: true }));
    });
  }

  /** Where `/holdings/<c>` must go instead, or null when this page shows it. */
  redirectFor(c: string | null | undefined): string | null {
    if (c === 'all' || TABLE_CLASSES.includes(c as AssetClass)) return null;
    return OWN_PAGE[c as AssetClass] ?? PORTFOLIO_HOLDINGS_HOME;
  }

  /** The view this page renders, or null while it forwards elsewhere. */
  view = computed<HoldingsView | null>(() => (this.redirectFor(this.assetClass()) ? null : this.assetClass()));
  isAll = computed(() => this.view() === 'all');
  cls = computed<AssetClass | null>(() => { const v = this.view(); return v && v !== 'all' ? v : null; });
  /** h1: "Holdings" on all, the class name on a class page (A22). */
  title = computed(() => { const c = this.cls(); return c ? CLASS_LABEL[c] : 'Holdings'; });
  noun = computed(() => { const c = this.cls(); return c ? NOUN[c] ?? 'holding' : 'investment'; });
  accent = computed(() => { const c = this.cls(); return c ? CLASS_COLOR[c] : 'var(--primary)'; });

  port = computed(() => this.store.portfolio());
  /** First load with nothing cached: skeletons. */
  loading = computed(() => !this.port() && !this.store.error());
  /** The portfolio could not load and nothing is cached. */
  failed = computed(() => !this.port() && !!this.store.error());
  positions = computed<Position[]>(() => (Array.isArray(this.port()?.positions) ? this.port()!.positions : []).filter(p => !!p && typeof p === 'object'));
  segments = computed<SegmentSummary[]>(() => (Array.isArray(this.port()?.segments) ? this.port()!.segments : []).filter(s => !!s && typeof s === 'object'));

  /** Family view: label holdings with their owner and offer By member (G14). */
  showMember = computed(() => this.auth.canSwitch() && !this.auth.portfolio());
  memberName = (owner: string | null | undefined) => {
    const o = (owner ?? '').toLowerCase();
    return this.auth.members().find(m => (m.email ?? '').toLowerCase() === o)?.name ?? (owner ?? '').split('@')[0] ?? '';
  };
  scopeLabel = computed(() => { const l = this.auth.portfolioLabel(); return l === 'Family' ? 'Family portfolio' : `${l}'s portfolio`; });

  /** NeedsAttention link prefixes (A7, G14); `linkUnder` keeps /holding/1 from matching /holding/12. */
  attention = computed<string[]>(() => {
    const v = this.view();
    if (!v) return [];
    if (v === 'all') return ['/holdings', '/holding/'];
    const ids = this.all().map(p => p.id).filter(id => id !== null && id !== undefined);
    return [`/holdings/${v}`, ...ids.map(id => `/holding/${id}`), ...ids.map(id => `/tax?tab=whatif&whatif=${id}`)];
  });

  /** The T0 verdict for the holdings in view: does the value rest on market prices? */
  priced = computed<PricedVerdict>(() => {
    const c = this.cls();
    const open = this.positions().filter(p => p.is_open && (!c || p.asset_class === c));
    const market = open.filter(p => MARKET_PRICED.has(p.asset_class));
    if (!open.length) return { status: 'unset', text: 'Nothing held here yet' };
    if (!market.length) return { status: 'good', text: 'Valued from your records; nothing here needs a market price' };
    const unpriced = market.filter(p => !p.has_price);
    if (!unpriced.length) return { status: 'good', text: `All ${market.length} holding${market.length === 1 ? ' has' : 's have'} a market price` };
    const total = open.reduce((a, p) => a + num(p.value), 0);
    const share = total > 0 ? (unpriced.reduce((a, p) => a + num(p.value), 0) / total) * 100 : 0;
    const n = unpriced.length;
    return {
      status: share >= UNPRICED_ACT_PCT ? 'act' : 'watch',
      text: `${n} holding${n === 1 ? '' : 's'} valued at cost (${share.toFixed(1)}% of value) · set a ticker to price ${n === 1 ? 'it' : 'them'}`,
    };
  });
  /** On phones the hero keeps two tiles; the rest open with "More" (§1.5). */
  moreStats = linkedSignal({ source: this.view, computation: () => false });

  // ── /holdings/all ────────────────────────────────────────────────

  /** T0 figures; every field is guarded so a partial payload never throws. */
  hero = computed(() => {
    const t = this.port()?.totals;
    const segs = this.segments();
    return {
      value: num(t?.value),
      day: num(t?.day_change),
      dayPct: numOrNull(t?.day_change_pct),
      invested: segs.reduce((a, s) => a + num(s.invested), 0),
      gain: num(t?.total_gain),
      unrealized: num(t?.unrealized),
      realized: num(t?.realized),
      income: num(t?.income),
      xirr: numOrNull(t?.xirr),
      open: num(t?.open_positions) || this.positions().filter(p => p.is_open).length,
      cost: num(t?.cost),
    };
  });
  isEmpty = computed(() => !!this.port() && this.positions().length === 0);

  /** Asset-class rows: every class with money in it or a past (realised) history, by value. */
  classRows = computed<ClassRow[]>(() => this.segments()
    .filter(s => num(s.value) > 0 || num(s.invested) > 0 || num(s.realized) !== 0 || num(s.income) !== 0)
    .map(s => {
      const meta = SEGMENT_META[s.segment] ?? { label: s.segment ?? '—', icon: 'layers', route: PORTFOLIO_HOLDINGS_HOME };
      return {
        segment: s.segment, label: meta.label, icon: meta.icon, route: meta.route, color: SEGMENT_COLOR[s.segment] ?? 'var(--s7)',
        invested: num(s.invested), value: num(s.value), day: num(s.day_change), unrealized: num(s.unrealized),
        unrealizedPct: numOrNull(s.unrealized_pct), realizedIncome: num(s.realized) + num(s.income), xirr: numOrNull(s.xirr),
        share: num(s.pct), open: num(s.open_count),
      };
    })
    .sort((a, b) => b.value - a.value));
  expanded = signal<string | null>(null);
  toggle(segment: string) { this.expanded.set(this.expanded() === segment ? null : segment); }
  /** The top 8 open holdings of a class, by value. */
  topOf = (segment: string) => this.positions().filter(p => p.segment === segment && p.is_open)
    .sort((a, b) => num(b.value) - num(a.value)).slice(0, 8);
  countOf = (segment: string) => this.positions().filter(p => p.segment === segment && p.is_open).length;

  /** Breakdown donut: By class, or By member in family view. */
  breakdownBy = signal<'class' | 'member'>('class');
  byMember = computed(() => this.showMember() && this.breakdownBy() === 'member');
  breakdown = computed(() => {
    if (this.byMember()) {
      const map = new Map<string, { key: string; label: string; value: number; count: number }>();
      for (const p of this.positions()) {
        if (!p.is_open) continue;
        const k = (p.owner ?? '').toLowerCase();
        const g = map.get(k) ?? { key: k, label: this.memberName(p.owner) || 'Unknown', value: 0, count: 0 };
        g.value += num(p.value); g.count++;
        map.set(k, g);
      }
      const rows = [...map.values()].filter(g => g.value > 0).sort((a, b) => b.value - a.value);
      const total = rows.reduce((a, g) => a + g.value, 0);
      return {
        total,
        rows: rows.map((g, i) => ({
          key: g.key, label: g.label, value: g.value, share: total > 0 ? (g.value / total) * 100 : 0, route: null as string | null,
          note: `${g.count} holding${g.count === 1 ? '' : 's'}`,
          color: `color-mix(in srgb, var(--primary) ${MEMBER_SHADES[i % MEMBER_SHADES.length]}%, var(--surface))`,
        })),
      };
    }
    const rows = this.classRows().filter(r => r.value > 0);
    const total = rows.reduce((a, r) => a + r.value, 0);
    return {
      total,
      rows: rows.map(r => ({ key: r.segment, label: r.label, value: r.value, share: total > 0 ? (r.value / total) * 100 : 0,
        route: r.route as string | null, note: `${r.open} holding${r.open === 1 ? '' : 's'}`, color: r.color })),
    };
  });
  slices = computed<Slice[]>(() => this.breakdown().rows.map(r => ({ label: r.label, value: r.value, color: r.color })));
  /** A donut slice opens its class page (By class only). */
  pickSlice(label: string) {
    const r = this.breakdown().rows.find(x => x.label === label);
    if (r?.route) void this.router.navigateByUrl(r.route);
  }

  // ── /holdings/<class> ────────────────────────────────────────────

  /** Filters reset when the class changes (the router reuses this component across classes). */
  q = linkedSignal({ source: this.view, computation: () => '' });
  showClosed = linkedSignal({ source: this.view, computation: () => false });
  market = linkedSignal<HoldingsView | null, 'all' | 'India' | 'USA'>({ source: this.view, computation: () => 'all' });
  asideOpen = linkedSignal({ source: this.view, computation: () => false });
  sort = new SortState<Position>('value');

  groupOptions = computed<[string, string][]>(() => this.cls() === 'equity'
    ? [['sector', 'Sector'], ['market_cap', 'Market cap'], ['market', 'Market']]
    : this.cls() === 'mutual_fund' ? [['category', 'Category'], ['sub_category', 'SIP / lump sum'], ['tax_class', 'Tax treatment']]
    : [['category', 'Commodity']]);
  groupBy = linkedSignal({ source: this.groupOptions, computation: opts => opts[0][0] });

  all = computed(() => { const c = this.cls(); return c ? this.positions().filter(p => p.asset_class === c) : []; });
  rows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const rows = this.all().filter(p =>
      (this.showClosed() || p.is_open) &&
      (this.market() === 'all' || (p.market ?? 'India') === this.market()) &&
      (!q || (p.name ?? '').toLowerCase().includes(q) || (p.symbol ?? '').toLowerCase().includes(q) || (p.sector ?? '').toLowerCase().includes(q)
        || (this.showMember() && this.memberName(p.owner).toLowerCase().includes(q))));
    return this.sort.apply(rows.map(p => (this.showMember() ? { ...p, ownerName: this.memberName(p.owner) } : p)) as Position[]);
  });
  filtered = computed(() => this.q().trim() !== '' || this.market() !== 'all');
  open = computed(() => this.rows().filter(p => p.is_open));
  /** Open holdings in the head's sub-line: the class's (never the filtered rows), or the portfolio's on all. */
  openCount = computed(() => (this.cls() ? this.all().filter(p => p.is_open).length : this.hero().open));
  /** Class T0 from the class's own holdings (not the filtered rows), so the hero never changes with a search. */
  totals = computed(() => {
    const all = this.all();
    const r = all.filter(p => p.is_open);
    const sum = (k: keyof Position) => r.reduce((a, p) => a + num(p[k]), 0);
    const cost = sum('cost'), unreal = sum('unrealized');
    return { value: sum('value'), cost, unrealized: unreal, unrealizedPct: cost ? (unreal / cost) * 100 : null,
      day: sum('day_change'), realized: all.reduce((a, p) => a + num(p.realized) + num(p.income), 0), weight: sum('weight') };
  });
  groups = computed<Group[]>(() => {
    const key = this.groupBy() as keyof Position;
    const map = new Map<string, Group>();
    const total = this.open().reduce((a, p) => a + num(p.value), 0) || 1;
    for (const p of this.open()) {
      const k = (p[key] as string) || 'Unclassified';
      const g = map.get(k) ?? { key: k, value: 0, pct: 0, count: 0 };
      g.value += num(p.value); g.count++;
      map.set(k, g);
    }
    return [...map.values()].map(g => ({ ...g, pct: (g.value / total) * 100 })).sort((a, b) => b.value - a.value);
  });
  groupLabel = computed(() => (this.groupOptions().find(o => o[0] === this.groupBy())?.[1] ?? '').toLowerCase());
  /** Groups with a stable colour: slot by alphabetical position, so a colour follows its group, not its rank. */
  coloured = computed(() => {
    const slots = [...this.groups().map(g => g.key)].sort();
    return this.groups().map(g => ({ ...g, color: `var(--s${(slots.indexOf(g.key) % 8) + 1})` }));
  });
  maxGroup = computed(() => Math.max(...this.groups().map(g => g.pct), 1));
  maxWeight = computed(() => Math.max(...this.rows().map(p => num(p.weight)), 0.01));
  /** Three biggest risers and fallers today, by rupee change. */
  movers = computed(() => {
    const moved = this.open().filter(p => num(p.day_change)).map(p => {
      const prev = num(p.value) - num(p.day_change);
      return { ...p, dayPct: prev ? (num(p.day_change) / prev) * 100 : 0 };
    });
    const up = moved.filter(p => p.day_change > 0).sort((a, b) => b.day_change - a.day_change).slice(0, 3);
    const down = moved.filter(p => p.day_change < 0).sort((a, b) => a.day_change - b.day_change).slice(0, 3);
    return [...up, ...down];
  });
  hasUsd = computed(() => this.all().some(p => p.market === 'USA'));
  hasAside = computed(() => this.groups().length > 1 || this.movers().length > 0);
  /** A held position under a year old: its XIRR is annualised from a short span. */
  young = (p: Position) => !!p.first_date && (Date.now() - new Date(p.first_date).getTime()) < 365 * 864e5;

  // column chooser (saved per class under localStorage['holdings:cols:<class>'], G14)
  private chosen = signal<Record<string, ColKey[]>>({});
  chosenCols = computed<ColKey[]>(() => {
    const c = this.cls();
    if (!c) return [...DEFAULT_COLS];
    const saved = this.chosen()[c] ?? readCols(c);
    // At least one column beside Name (G14), on load too: a choice saved in family view as only Owner
    // offers nothing once the view is not family, so it falls back to the default.
    const offered = new Set(this.offeredCols().map(o => o.key));
    return saved && saved.some(k => offered.has(k)) ? saved : [...DEFAULT_COLS];
  });
  /** Columns offered: Owner only in family view. */
  offeredCols = computed(() => COLS.filter(c => !c.family || this.showMember()));
  /** Visible columns in their fixed order; the first two stay on phones. */
  cols = computed(() => {
    const on = new Set(this.chosenCols());
    const vis = this.offeredCols().filter(c => on.has(c.key));
    return vis.map((c, i) => ({ ...c, phone: i < PHONE_COLS }));
  });
  colOn = (k: ColKey) => this.chosenCols().includes(k);
  toggleCol(k: ColKey, ev?: Event) {
    const c = this.cls();
    if (!c) return;
    const cur = this.chosenCols();
    const next = cur.includes(k) ? cur.filter(x => x !== k) : COLS.map(x => x.key).filter(x => x === k || cur.includes(x));
    if (!next.some(x => this.offeredCols().some(o => o.key === x))) {
      // keep at least one column beside Name: undo the box the browser already unticked
      const box = ev?.target as HTMLInputElement | null;
      if (box) box.checked = true;
      return;
    }
    this.chosen.update(m => ({ ...m, [c]: next }));
    writeCols(c, next);
  }
  resetCols() {
    const c = this.cls();
    if (!c) return;
    this.chosen.update(m => ({ ...m, [c]: [...DEFAULT_COLS] }));
    writeCols(c, [...DEFAULT_COLS]);
  }
  /** `aria-sort` for a sortable header. */
  ariaSort(key: string): 'ascending' | 'descending' | 'none' {
    return this.sort.key() === key ? (this.sort.dir() === 1 ? 'ascending' : 'descending') : 'none';
  }

  color = (seg: string) => SEGMENT_COLOR[seg] ?? 'var(--s7)';
  tint = (seg: string) => `color-mix(in srgb, ${this.color(seg)} 14%, white)`;

  /** A row opens its holding; a click on the name link has already navigated. */
  openRow(p: Position, ev?: Event) {
    if ((ev?.target as HTMLElement | null)?.closest?.('a')) return;
    void this.router.navigate(['/holding', p.id]);
  }
  add() {
    const c = this.cls();
    this.dialog.add(c === 'equity' || c === 'mutual_fund' || c === 'commodity' ? c : undefined);
  }
  clearFilters() { this.q.set(''); this.market.set('all'); }

  export() {
    const c = this.cls();
    const list = c ? this.rows() : this.positions();
    downloadCsv(`${c ?? 'all'}-holdings.csv`, [
      ['Name', 'Asset class', 'Owner', 'Symbol', 'Market', 'Sector/Category', 'Quantity', 'Avg cost', 'Price', 'Value', 'Cost', 'Unrealized',
        'Unrealized %', 'Realized', 'Income', 'Total return', 'XIRR %', 'Weight %', 'Open'],
      ...list.map(p => [p.name, CLASS_LABEL[p.asset_class] ?? p.asset_class, this.memberName(p.owner), p.symbol, p.market, p.sector ?? p.category,
        p.quantity, p.avg_cost, p.price, p.value, p.cost, p.unrealized, p.unrealized_pct, p.realized, p.income, p.total_return, p.xirr, p.weight,
        p.is_open ? 'yes' : 'no']),
    ]);
  }
}
