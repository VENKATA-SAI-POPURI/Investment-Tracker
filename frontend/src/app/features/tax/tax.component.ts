import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { kindFor } from '../../core/action-runner.service';
import { ActionService } from '../../core/action.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, downloadCsv, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { AssetClass, Brief, Position, Status, TaxReport, Upcoming, UpcomingEvent, WhatIfSale } from '../../core/models';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { exemptionUsedUp, lossSaleQty, unitsUpTo } from '../../core/tax-lots';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { lossHarvestSaving, taxStillToSave } from '../actions/actions.component';

const TAX_LABEL: Record<string, string | undefined> = {
  equity: 'Indian equity', foreign_equity: 'Foreign equity', listed_other: 'Gold / other ETF', debt: 'Debt fund', income: 'Income',
};
const INCOME_LABEL: Record<string, string | undefined> = { dividends: 'Dividends', p2p_interest: 'P2P interest', fd_interest: 'FD interest' };

/** The page's four views (J11): two for the work surface, two for the T3 detail. */
export type TaxTab = 'save' | 'whatif' | 'gains' | 'estimate';
const TABS: ReadonlySet<string> = new Set<TaxTab>(['save', 'whatif', 'gains', 'estimate']);
/** `?fy` as the backend validates it (`analytics_api.tax`). */
const FY_RE = /^FY\d{4}-\d{2}$/;
/** D12: brokerage and the like stay out of cost. The backend notes carry it; this is for an older payload. */
export const CHARGES_NOTE = 'Brokerage, STT and stamp duty from imports are not deducted.';
/** The classes "What if I sell" offers (J11): open shares, mutual funds and commodities with units. */
const SELLABLE: ReadonlySet<AssetClass> = new Set<AssetClass>(['equity', 'mutual_fund', 'commodity']);
/** `tax.MAX_AHEAD_DAYS`: a sale can be planned at most a year ahead. */
const MAX_AHEAD_DAYS = 365;
/** `calendar.UPCOMING_DAYS`: the brief lists events this many days ahead. */
const UPCOMING_DAYS = 90;

/** The Indian FY an ISO date falls in, labelled as `domain.fy_of`: 2026-05-14 → FY2026-27. */
export function fyOf(iso: string): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `FY${start}-${String(start + 1).slice(2)}`;
}

/** Whole days from `from` to `to` (ISO dates); positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.slice(0, 10) + 'T00:00:00Z') - Date.parse(from.slice(0, 10) + 'T00:00:00Z')) / 86400000);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days left in the FY that ends on `end`, today included (so 31 March reads "1 day left"); null once it is over. */
export function daysLeftInFy(end: string | null | undefined, todayIso: string): number | null {
  if (!end) return null;
  const n = daysBetween(todayIso, end) + 1;
  return n > 0 ? n : null;
}

/**
 * The view `?tab` names (J11). A past FY has only the detail views, so `save` and `whatif` read as `gains`.
 * `?whatif=<iid>` implies `whatif` in the current FY. No value means `save` for the current FY and `gains` otherwise.
 */
export function resolveTab(raw: string | null | undefined, hasWhatif: boolean, currentFy: boolean): TaxTab {
  if (!currentFy) return raw === 'estimate' ? 'estimate' : 'gains';
  if (hasWhatif) return 'whatif';
  return raw && TABS.has(raw) ? raw as TaxTab : 'save';
}

/** May "What if I sell" offer this holding? Open shares, funds and commodities with units (J11). */
export function sellable(p: Position): boolean {
  return p.is_open && SELLABLE.has(p.asset_class) && (p.quantity ?? 0) > 0;
}

/** The first tax event in the brief's next 90 days (E20, J11); null when there is none. */
export function nextTaxEvent(up: Upcoming | null | undefined): UpcomingEvent | null {
  const ev = (up?.events ?? []).filter(e => e.kind === 'tax' && e.days >= 0 && e.days <= UPCOMING_DAYS);
  return ev.sort((a, b) => a.days - b.days || a.date.localeCompare(b.date))[0] ?? null;
}

/** Gains booked this FY by term, from the report's `summary` ({class}_{stcg|ltcg|intraday}). */
export function gainsByTerm(r: Pick<TaxReport, 'summary' | 'realized'>): { short: number; long: number; intraday: number } {
  const out = { short: 0, long: 0, intraday: 0 };
  const s = r.summary ?? {};
  const keys = Object.keys(s);
  if (keys.length) {
    for (const k of keys) {
      if (k.endsWith('_stcg')) out.short += s[k] || 0;
      else if (k.endsWith('_ltcg')) out.long += s[k] || 0;
      else if (k.endsWith('_intraday')) out.intraday += s[k] || 0;
    }
    return out;
  }
  for (const l of r.realized ?? []) {
    if (l.term === 'LTCG') out.long += l.gain; else if (l.term === 'Intraday') out.intraday += l.gain; else out.short += l.gain;
  }
  return out;
}

/** The payload's note, with D12 added when an older payload lacks it. */
export function withCharges(note: string | null | undefined): string {
  const n = (note ?? '').trim();
  return n.includes('Brokerage') ? n : `${n} ${CHARGES_NOTE}`.trim();
}

function parseId(v: string | null): number | null {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

function isReport(x: unknown): x is TaxReport {
  const r = x as TaxReport | null;
  return !!r && typeof r.fy === 'string' && !!r.estimate && !!r.equity_exemption && Array.isArray(r.years) && Array.isArray(r.realized);
}

/**
 * Tax (`/tax?fy=&tab=save|whatif|gains|estimate&whatif=<iid>`; SPEC Part 1 §5.8, P1.7, Part 2 §6.9;
 * AMENDMENTS J11, A12, A21, A22, A27, D12, D16, E20, G11, H8, the W3 and W4 review fixes).
 *
 * - Head: h1 "Tax", the FY select, Export CSV and "N days left in {fy}" (current FY only).
 * - T0: "Estimated tax {fy}" (`estimate.total`, est.) with the slab and a link to change it; the verdict
 *   "You can still save ₹X", X being Actions' figure (Σ lump impact of open and planned tax moves): good at 0,
 *   watch above it, info "FY closed" for a past FY. Tiles: tax-free LTCG left, capital gains (short · long) and the
 *   next tax deadline from `brief.upcoming` (snapshot first, else `GET /brief` without writing it, E20).
 * - T1: the `/tax` needs-attention strip, then the work surface (current FY only, A21): "Ways to save" (harvest
 *   plan, offset gains with losses, wait before selling; every row's "Plan the sale" opens the what-if modal with
 *   units a FIFO sale needs to reach the row's lots (`core/tax-lots`: harvest rows' own units, loss rows up to their
 *   newest loss lot, wait rows up to that lot) and no action id, so a sale from a page row never marks advice done) or the inline
 *   "What if I sell" form (`GET /tax/what-if`, a 400 shown inline; "Record this sale" for writers opens a plain SELL).
 * - T2: the tax-free allowance meter and "Where your tax comes from", each naming what it explains.
 * - T3 (collapsed unless asked for or a past FY): realised gains (All/STCG/LTCG/Intraday) and the full estimate.
 *
 * `?fy`, `?tab` and `?whatif` follow the query string and are written in place (replaceUrl, merge). The current
 * FY's report paints from this device's snapshot, then refreshes when the store's data moves. Every forward ₹ carries
 * an est. tag. Guests see everything that only reads, including the what-if; they cannot record a sale.
 */
@Component({
  selector: 'app-tax',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, EstTagComponent, NeedsAttentionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tax.component.html',
  styles: [`
    .head-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .head-tools .input { width: auto; height: 32px; font-size: var(--t-label); }
    .fy-left { white-space: nowrap; }
    .hero-skel { height: 150px; border-radius: 14px; }

    /* T0: hero + three tiles; phones keep the hero and two tiles, the third sits behind "More" (§1.5, H19) */
    .t-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); }
    .t-kpis .verdict-line { margin-top: 10px; font-size: var(--t-body); align-items: flex-start; flex-wrap: wrap; row-gap: 2px; }
    .t-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .t-kpis .verdict-line .vt { flex: 1 1 0; min-width: 0; }
    .t-kpis .est { color: rgba(255, 255, 255, .78); }
    .t-kpis .kpi .value.wrap { white-space: normal; overflow-wrap: anywhere; font-size: var(--t-stat); line-height: 1.3; }
    .t-kpis .kpi .value small { font-size: var(--t-label); font-weight: 500; color: rgba(255, 255, 255, .64); }
    .verdict-cta { border: 0; background: none; padding: 0; font: inherit; color: var(--gold-2); text-decoration: underline; cursor: pointer; }
    .verdict-cta:focus-visible { outline: 2px solid var(--gold-2); outline-offset: 2px; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: var(--t-label); }
    @media (max-width: 900px) {
      .t-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .t-kpis .kpi:nth-child(2) { border-left: 0; }
      .t-kpis .kpi:nth-child(3) { border-left: 1px solid rgba(255, 255, 255, .09); }
      .t-kpis .kpi.extra { grid-column: span 2; border-left: 0; }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .t-kpis .kpi.extra:not(.show) { display: none; }
    }

    /* The strip's compact cards wrap on phones through ActionCard's own ≤560px rule (W5-F8); no page copy here. */

    /* T1 work surface (A21) */
    .ws { display: flex; flex-direction: column; gap: 10px; min-width: 0; scroll-margin-top: 80px; }
    .ws .card-head { margin-bottom: 0; }
    .ws h3 { font-size: var(--t-label); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-top: 12px; }
    .ws h3 .h-meta { text-transform: none; letter-spacing: 0; font-weight: 500; margin-left: 6px; }
    .ws .table th, .ws .table td { vertical-align: middle; }
    .ws .table .sub { font-size: var(--t-label); color: var(--muted); }
    .ws-total { margin: 0; padding-top: 10px; border-top: 1px solid var(--border-strong); font-weight: 600; font-size: var(--t-body); }
    .ws-lead { font-size: var(--t-body); color: var(--text-2); margin: 0; }
    .ws-note { margin: 0; }
    .plan-btn { white-space: nowrap; }
    .only-sm { display: none; }

    .wi-form .cols.four { grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1fr)); }
    .wi-run { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .wi-result { display: flex; flex-direction: column; gap: 12px; }
    .wi-result.stale { opacity: .6; }
    .wi-answer { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: 10px; background: var(--surface-2);
      border-left: var(--stripe) solid var(--st); }
    .wi-label { font-size: var(--t-label); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .wi-big { font-size: var(--t-num); font-weight: 650; font-variant-numeric: tabular-nums; }
    .wi-line { font-size: var(--t-meta); color: var(--text-2); }
    .wi-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 16px; margin: 0; }
    .wi-facts div { min-width: 0; }
    .wi-facts dt { font-size: var(--t-label); color: var(--muted); }
    .wi-facts dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .wi-facts dd small { display: block; font-weight: 400; font-size: var(--t-label); color: var(--muted); }
    .wi-lots summary { cursor: pointer; font-size: var(--t-meta); font-weight: 600; color: var(--text-2); }
    .wi-lots .table-wrap { margin-top: 8px; }

    /* T2 */
    .explains { display: block; margin-top: 2px; }
    .tl + .tl { margin-top: 12px; }
    .meter.thin { height: 6px; margin-top: 6px; }

    /* T3 */
    .t3 { scroll-margin-top: 80px; }
    .t3 > details > summary { font-size: var(--t-body); }
    .t3-body { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
    .t3-body .tabs { margin-bottom: 2px; }

    @media (max-width: 760px) {
      .wi-form .cols.four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wi-form .cols.four .field:first-child { grid-column: span 2; }
      .wi-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ws .table th, .ws .table td { padding-left: 8px; padding-right: 8px; }
      .only-sm { display: block; }
    }
    /* Phones: the ways-to-save tables become stacked rows, each value labelled (the label carries "est." where the
       header's tag is hidden), so "Plan the sale" is never scrolled out of reach. */
    @media (max-width: 560px) {
      .ws table.stacked thead { display: none; }
      .ws table.stacked, .ws table.stacked tbody { display: block; }
      .ws table.stacked tr { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; border-bottom: 1px solid var(--border); }
      .ws table.stacked td { display: flex; justify-content: space-between; gap: 12px; padding: 0; border: 0; white-space: normal; text-align: right; }
      .ws table.stacked td[data-label]::before { content: attr(data-label); color: var(--muted); font-size: var(--t-label); text-align: left; }
      .ws table.stacked td.name-cell { display: block; max-width: none; text-align: left; overflow-wrap: anywhere; }
      .ws table.stacked td.cta { justify-content: flex-end; padding-top: 4px; }
      .ws table.stacked td.hide-sm { display: flex !important; }
      .ws table.stacked .only-sm { display: none; }
    }
  `],
})
export class TaxComponent {
  readonly store = inject(StoreService);
  readonly auth = inject(AuthService);
  private api = inject(ApiService);
  private actionSvc = inject(ActionService);
  private dialog = inject(TxnDialogService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly taxLabel = TAX_LABEL;
  readonly incomeLabel = INCOME_LABEL;
  readonly statusMeta = STATUS_META;
  readonly todayIso = today();
  readonly maxDate = addDays(this.todayIso, MAX_AHEAD_DAYS);
  readonly chargesNote = CHARGES_NOTE;

  // ── URL (J11) ────────────────────────────────────────────────
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  /** `?whatif=<iid>`, a positive whole number; null otherwise. */
  readonly whatifParam = computed(() => parseId(this.query().get('whatif')));
  /** The FY asked for, or null for the current one. `?whatif` implies the current FY; a malformed `?fy` is ignored. */
  readonly fyParam = computed(() => {
    if (this.whatifParam() !== null) return null;
    const f = this.query().get('fy');
    return f && FY_RE.test(f) ? f : null;
  });

  // ── GET /tax ─────────────────────────────────────────────────
  readonly report = signal<TaxReport | null>(null);
  readonly loading = signal(false);
  /** Why the last load failed, or null once one succeeds. */
  readonly error = signal<string | null>(null);
  /** The current FY: the label of a report loaded without `?fy`, else worked out from today. */
  readonly currentFy = signal(fyOf(this.todayIso));
  readonly isCurrentFy = computed(() => {
    const f = this.fyParam();
    return f === null || f === this.currentFy();
  });
  readonly tab = computed(() => resolveTab(this.query().get('tab'), this.whatifParam() !== null, this.isCurrentFy()));
  /** The work surface shows the what-if form on its tab, and the ways to save otherwise. */
  readonly wsView = computed<'save' | 'whatif'>(() => this.tab() === 'whatif' ? 'whatif' : 'save');
  readonly t3View = computed<'gains' | 'estimate'>(() => this.tab() === 'estimate' ? 'estimate' : 'gains');

  readonly daysLeft = computed(() => {
    const r = this.report();
    return r && this.isCurrentFy() ? daysLeftInFy(r.end, this.todayIso) : null;
  });

  // ── T0 ───────────────────────────────────────────────────────
  readonly taxToSave = computed(() => taxStillToSave(this.actionSvc.actions(), this.actionSvc.planned()));
  readonly verdict = computed<{ status: Status; text: string; amount: number | null }>(() => {
    const r = this.report();
    if (!this.isCurrentFy()) return { status: 'info', text: `${r?.fy ?? this.fyParam() ?? 'This FY'} is closed: these are the gains and tax booked in it`, amount: null };
    const known = this.actionSvc.loaded() || this.actionSvc.actions().length > 0 || this.actionSvc.planned().length > 0;
    if (!known) {
      return this.actionSvc.error()
        ? { status: 'unset', text: "Couldn't work out what you can still save just now", amount: null }
        : { status: 'unset', text: 'Working out what you can still save…', amount: null };
    }
    const x = this.taxToSave();
    return x > 0 ? { status: 'watch', text: 'You can still save', amount: x } : { status: 'good', text: 'Nothing left to save on tax this year', amount: 0 };
  });
  readonly gains = computed(() => { const r = this.report(); return r ? gainsByTerm(r) : { short: 0, long: 0, intraday: 0 }; });
  /** Phones show the hero and two tiles; the third sits behind "More" (§1.5). */
  readonly moreStats = signal(false);

  /** `brief.upcoming`: undefined until known, null when the brief has none (E20). */
  readonly upcoming = signal<Upcoming | null | undefined>(undefined);
  readonly nextDeadline = computed(() => nextTaxEvent(this.upcoming()));

  // ── Ways to save ─────────────────────────────────────────────
  readonly opp = computed(() => this.report()?.opportunities ?? null);
  readonly harvest = computed(() => {
    const hp = this.opp()?.harvest_plan;
    return { rows: hp?.rows ?? [], total_gain: hp?.total_gain ?? 0, future_tax_saved: hp?.future_tax_saved ?? 0, note: withCharges(hp?.note) };
  });
  readonly harvestBasis = "Tax saved later on gains booked now, at 12.5% LTCG before the 4% cess, from your open lots at today's prices";
  /** Each row with `sellQty`: the FIFO units that reach its newest loss lot (`lossSaleQty`), which the what-if is sent. */
  readonly lossRows = computed(() => {
    const open = this.opp()?.open_lots ?? [];
    return [...(this.opp()?.loss_harvest ?? [])]
      .sort((a, b) => (b.st_loss + b.lt_loss) - (a.st_loss + a.lt_loss))
      .map(h => ({ ...h, sellQty: lossSaleQty(h, open, this.todayIso) }));
  });
  /** A12's one floor: the empty harvest plan says the allowance is used up below it, as Actions does. */
  readonly exemptionUsedUp = exemptionUsedUp;
  readonly lossSaving = computed(() => {
    const r = this.report();
    return r ? lossHarvestSaving(r.tax_lines ?? [], r.opportunities?.loss_harvest_offsettable ?? 0) : 0;
  });
  readonly waitRows = computed(() => {
    const o = this.opp();
    if (!o) return [];
    const open = o.open_lots ?? [];
    return [...(o.upcoming_long_term ?? [])]
      .sort((a, b) => (a.lt_on ?? '').localeCompare(b.lt_on ?? '') || a.name.localeCompare(b.name))
      .map(l => ({ lot: l, sellQty: unitsUpTo(l, open) }));
  });

  // ── What if I sell (inline form) ─────────────────────────────
  readonly holdings = computed(() => this.store.positions().filter(sellable).sort((a, b) => a.name.localeCompare(b.name)));
  readonly wiId = signal<number | null>(null);
  readonly wiPos = computed<Position | null>(() => {
    const id = this.wiId();
    return id === null ? null : this.store.positions().find(p => p.id === id) ?? null;
  });
  /** Why the chosen holding cannot be planned here, or null. */
  readonly wiProblem = computed<string | null>(() => {
    const id = this.wiId(), p = this.wiPos();
    if (id === null) return null;
    if (!p) return this.store.portfolio() ? "This holding isn't in the portfolio you're viewing." : null;
    if (!sellable(p)) return `${p.name} can't be planned here: only open shares, mutual funds and commodities with units can.`;
    return null;
  });
  readonly wiUsd = computed(() => this.wiPos()?.currency === 'USD');
  readonly wiQty = signal<number | null>(null);
  readonly wiPrice = signal<number | null>(null);
  readonly wiDate = signal(this.todayIso);
  readonly wiResult = signal<WhatIfSale | null>(null);
  readonly wiLoading = signal(false);
  readonly wiError = signal<string | null>(null);
  readonly wiCanRecord = computed(() => !!this.wiPos() && !this.wiProblem() && Number(this.wiQty()) > 0 && !!this.wiDate());

  // ── T2 / T3 ──────────────────────────────────────────────────
  readonly termFilter = signal('');
  readonly lots = computed(() => (this.report()?.realized ?? []).filter(l => !this.termFilter() || l.term === this.termFilter()));
  readonly incomeRows = computed(() => Object.entries(this.report()?.income ?? {}).filter(([, v]) => v));
  /** Tax lines with a share of the largest, largest first. */
  readonly taxLines = computed(() => {
    const r = this.report();
    const term = (g: string) => g === 'LT' ? 'Long-term' : 'Short-term';
    const lines = (r?.tax_lines ?? []).filter(l => l.tax > 0).map(l => ({
      label: `${term(l.group)} ${l.slab ? 'gains, other' : 'equity gains'}`, rate: l.slab ? 'your slab' : `${l.rate}%`, tax: l.tax }));
    if (r?.estimate.income_tax) lines.push({ label: 'Dividends & interest', rate: 'your slab', tax: r.estimate.income_tax });
    const max = Math.max(...lines.map(l => l.tax), 1);
    return lines.map(l => ({ ...l, share: l.tax / max * 100 })).sort((a, b) => b.tax - a.tax);
  });
  readonly exemptionPct = computed(() => {
    const e = this.report()?.equity_exemption;
    return e && e.limit > 0 ? Math.min(100, Math.max(0, e.used / e.limit * 100)) : 0;
  });
  /** T3 is collapsed (§1.3) unless the URL asks for it or the FY is closed, where it is the page's content. */
  readonly t3Open = signal(false);
  readonly estimateBasis = computed(() => {
    const r = this.report();
    return `Tax on the gains booked and the income received in ${r?.fy ?? 'this FY'}${this.isCurrentFy() ? ' so far' : ''}, at your ${r?.slab_rate ?? ''}% slab incl. 4% cess; `
      + `surcharge and earlier years' losses are not included. ${CHARGES_NOTE}`;
  });

  private seq = 0;
  private wiSeq = 0;
  private loadedKey: string | null = null;
  private briefFor: string | null = null;
  private briefSeq = 0;
  private wiApplied: number | null = null;
  private wiHadPos = false;
  /** Scroll to the T3 detail once painted when the URL arrives asking for it. */
  private scrollT3 = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    const raw = this.route.snapshot.queryParamMap.get('tab');
    this.scrollT3 = (raw === 'gains' || raw === 'estimate') && this.isCurrentFy();
    inject(DestroyRef).onDestroy(() => this.timers.forEach(clearTimeout));

    // GET /tax for the FY on screen; a new FY or portfolio repaints (from the snapshot for the current FY).
    effect(() => {
      const fy = this.fyParam();
      this.store.version();
      const scope = this.store.scopeKey();
      untracked(() => {
        const key = `${scope}|${fy ?? ''}`;
        if (key !== this.loadedKey) {
          this.loadedKey = key;
          const snap = fy === null ? readSnapshot<unknown>(snapshotKey('tax', scope)) : null;
          this.report.set(isReport(snap) ? snap : null);
          this.error.set(null);
        }
        queueMicrotask(() => void this.load());
      });
    });

    // The next tax deadline: Home's brief snapshot, else GET /brief without since, never written back (E20).
    effect(() => {
      const scope = this.store.scopeKey();
      untracked(() => { if (scope !== this.briefFor) { this.briefFor = scope; void this.loadUpcoming(scope); } });
    });

    // ?whatif=<iid> picks the holding and resets the form; a portfolio arriving late fills it in. Leaving the tab
    // (which clears ?whatif) keeps the last choice for when the user comes back.
    effect(() => {
      const id = this.whatifParam();
      const p = id === null ? null : this.store.positions().find(x => x.id === id) ?? null;
      untracked(() => {
        if (id === null) return;
        if (id === this.wiApplied && (this.wiHadPos || !p)) return;
        this.wiApplied = id;
        this.wiHadPos = !!p;
        this.wiReset(id, p);
      });
    });

    // T3 opens when the URL asks for it or the FY is closed.
    effect(() => {
      const t = this.tab(), current = this.isCurrentFy();
      untracked(() => { if (!current || t === 'gains' || t === 'estimate') this.t3Open.set(true); });
    });

    effect(() => {
      if (!this.report() || !this.scrollT3) return;
      this.scrollT3 = false;
      untracked(() => this.scrollTo('tax-details'));
    });
  }

  /** One GET /tax for the FY on screen; a newer call supersedes an older one. A failure keeps what is painted. */
  async load(): Promise<void> {
    const fy = this.fyParam();
    const scope = this.store.scopeKey();
    const mine = ++this.seq;
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.api.tax(fy ?? undefined));
      if (mine !== this.seq) return;
      this.report.set(r);
      this.error.set(null);
      if (fy === null && r?.fy) {
        this.currentFy.set(r.fy);
        writeSnapshot(snapshotKey('tax', scope), r);
      }
    } catch (e) {
      if (mine === this.seq) this.error.set(errorMessage(e));
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }

  private async loadUpcoming(scope: string): Promise<void> {
    const mine = ++this.briefSeq;
    const snap = readSnapshot<Partial<Brief>>(snapshotKey('brief', scope));
    if (snap && snap.upcoming !== undefined) { this.upcoming.set(snap.upcoming ?? null); return; }
    try {
      const b = await firstValueFrom(this.api.brief());
      if (mine === this.briefSeq) this.upcoming.set(b?.upcoming ?? null);
    } catch {
      if (mine === this.briefSeq) this.upcoming.set(null);
    }
  }

  // ── URL writes (replaceUrl, merge) ───────────────────────────
  private write(q: Params) {
    void this.router.navigate([], { relativeTo: this.route, queryParams: q, queryParamsHandling: 'merge', replaceUrl: true });
  }

  setTab(t: TaxTab) {
    // ?whatif implies the what-if tab, so any other tab drops it; coming back restores the last holding.
    // `fy` is written as shown: a `?fy` that `?whatif` overrode must not take over once `?whatif` goes.
    this.write({ tab: t, whatif: t === 'whatif' ? this.wiId() : null, fy: this.fyParam() });
  }

  /** The current FY is written as no `?fy`. Save and what-if do not exist for a past FY; the detail views carry over. */
  setFy(fy: string) {
    if (!fy) return;
    const t = this.tab();
    this.write({ fy: fy === this.currentFy() ? null : fy, whatif: null, tab: t === 'gains' || t === 'estimate' ? t : null });
  }

  /** The holding select writes `?whatif`, which resets the form through the effect above. */
  pickHolding(v: unknown) {
    const id = parseId(String(v ?? ''));
    if (id === null) return;
    this.write({ tab: 'whatif', whatif: id, fy: null });
  }

  showWays() {
    this.setTab('save');
    this.scrollTo('ways');
  }

  onT3Toggle(e: Event) { this.t3Open.set((e.target as HTMLDetailsElement).open); }

  private scrollTo(id: string) {
    this.timers.push(setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60));
  }

  /** A row's "Plan the sale": the what-if modal with the row's units and no action id (J11, the W4 review fix). */
  planSale(instrumentId: number, qty: number | null | undefined) {
    this.dialog.openWhatIf({ instrumentId, qty: qty && qty > 0 ? qty : null });
  }

  // ── What-if form ─────────────────────────────────────────────
  private wiReset(id: number, p: Position | null) {
    this.wiSeq++;
    this.wiId.set(id);
    this.wiQty.set(p?.quantity ?? null);
    this.wiPrice.set(p?.has_price && p.price ? p.price : null);   // D16, in the holding's currency
    this.wiDate.set(this.todayIso);
    this.wiResult.set(null);
    this.wiError.set(null);
    this.wiLoading.set(false);
    if (p && sellable(p) && (p.quantity ?? 0) > 0) void this.runWhatIf();
  }

  /** GET /tax/what-if with the form's values; a 400 (more than you hold, ELSS lock-in, no price) shows inline. */
  async runWhatIf(): Promise<void> {
    const p = this.wiPos();
    if (!p || this.wiProblem()) return;
    const qty = Number(this.wiQty());
    if (!(qty > 0)) { this.wiResult.set(null); this.wiError.set('Enter how many units to sell'); return; }
    const rawPrice = this.wiPrice() as unknown;
    const price = rawPrice === null || rawPrice === undefined || rawPrice === '' ? null : Number(rawPrice);
    if (price !== null && !(price > 0)) { this.wiResult.set(null); this.wiError.set('The price must be more than 0'); return; }
    const mine = ++this.wiSeq;
    this.wiLoading.set(true);
    this.wiError.set(null);
    try {
      const r = await firstValueFrom(this.api.whatIf({ instrument_id: p.id, qty, price, date: this.wiDate() || null }));
      if (mine !== this.wiSeq) return;
      this.wiResult.set(r);
    } catch (e) {
      if (mine !== this.wiSeq) return;
      this.wiResult.set(null);
      this.wiError.set(errorMessage(e));
    } finally {
      if (mine === this.wiSeq) this.wiLoading.set(false);
    }
  }

  /** "Record this sale" (writers): a plain SELL with the instrument, units and date. No action id: see planSale. */
  recordSale() {
    const p = this.wiPos();
    if (!p || !this.wiCanRecord() || !this.auth.canWrite()) return;
    this.dialog.add(kindFor(p.asset_class, 'SELL'), { instrumentId: p.id, type: 'SELL', quantity: Number(this.wiQty()), date: this.wiDate() || this.todayIso });
  }

  /** The later sale is priced as today's (tax.what_if_sale re-runs the same price on the wait date). */
  waitBasis(r: WhatIfSale): string { return `Assumes the price is still the same on that date. ${r.note ?? ''}`.trim(); }

  termLabel(t: string): string { return t === 'LTCG' ? 'Long-term' : t === 'STCG' ? 'Short-term' : t; }

  note(r: WhatIfSale): string { return withCharges(r.note); }

  lotCount(lots: { partial: boolean }[]): string {
    const n = lots.length, part = lots.filter(l => l.partial).length;
    return `${n} lot${n === 1 ? '' : 's'}${part ? ` (${part} in part)` : ''}`;
  }

  export() {
    const r = this.report();
    if (!r) return;
    downloadCsv(`capital-gains-${r.fy}.csv`, [
      ['Name', 'Tax class', 'Bought', 'Sold', 'Days held', 'Units', 'Cost', 'Proceeds', 'Gain', 'Term', 'Rate %'],
      ...r.realized.map(l => [l.name, TAX_LABEL[l.tax_class] ?? l.tax_class, l.buy_date, l.sell_date, l.holding_days, l.qty, l.cost, l.proceeds, l.gain, l.term,
        l.rate === null ? 'slab' : (l.rate * 100).toFixed(1)]),
    ]);
  }
}
