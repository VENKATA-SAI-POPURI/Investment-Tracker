import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, usd } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Action, CLASS_LABEL, OpenLotTax, PriceHistory, SEGMENT_META, Transaction, TXN_LABEL } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { InstrumentEditComponent, TAX_CLASSES } from '../../shared/instrument-edit.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { ConfirmService } from '../../shared/ui';
import { OutlookCardComponent } from './outlook-card.component';
import { XIRR_MIN_DAYS, attentionPrefixes, daysSince, holdingVerdict, isTradable, joinLots, returnOnMoneyIn } from './holding-rules';

/**
 * Holding detail (`/holding/:id`, SPEC §5.5, AMENDMENTS J14).
 * - Head: "← class", the one h1 (A22), badges with words, the class actions, Edit, and Delete inside a ⋯ menu.
 * - T0: Current value with its verdict (valued at cost → act, large position → watch, else good) and ≤3 tiles;
 *   XIRR only after a year of history, "Return on money in" before that.
 * - T1: the needs-attention strip for this holding and its what-if (G14 matching), and "Plan a sale".
 * - T2: price and trades, Returns, Signals (the collapsed Outlook card).
 * - T3: Transactions, and Open lots (FIFO) joined to `/tax`, fetched when that section opens.
 */
@Component({
  selector: 'app-holding-detail',
  standalone: true,
  imports: [RouterLink, NgTemplateOutlet, IconComponent, InstrumentEditComponent, LineChartComponent, OutlookCardComponent,
    NeedsAttentionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './holding-detail.component.html',
  styles: [`
    .hero-skel { height: 150px; border-radius: 14px; }
    .empty h1.nf { font-size: var(--t-h2, 15px); font-weight: 600; margin: 0; }
    .hd-head { align-items: flex-start; }
    .hd-head .back { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; }
    .hd-head h1 { margin-top: 4px; overflow-wrap: anywhere; }
    .hd-head .badges { margin-top: 6px; gap: 6px; }
    .hd-head .tools { flex-wrap: wrap; justify-content: flex-end; }
    .more-menu { position: relative; }
    .more-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 180px; padding: 6px; display: flex; flex-direction: column;
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-lg, 0 10px 30px rgba(15, 23, 42, .14)); }
    .more-pop button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent;
      color: var(--text); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
    .more-pop button:hover, .more-pop button:focus-visible { background: var(--surface-2); }
    .more-pop button.danger { color: var(--neg); }

    /* T0: hero + three tiles; phones keep the hero and two tiles, the third sits behind "More" (§1.5) */
    .hd-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); }
    .hd-kpis .hero-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
    .hd-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; flex-wrap: wrap; row-gap: 2px; }
    .hd-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .hd-kpis .verdict-line a { font-weight: 500; font-size: 13px; }
    .hd-kpis .verdict-line > span:not(.sr-only) { flex: 1 1 180px; min-width: 0; }
    .hd-kpis .kpi .value.wrap { white-space: normal; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .hd-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .hd-kpis .kpi.extra { grid-column: span 2; border-left: 0; border-top: 1px solid rgba(255, 255, 255, .09); }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .hd-kpis .kpi.extra:not(.show) { display: none; }
      .hd-head .tools { justify-content: flex-start; }
    }

    .sale-cta { display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; padding: 12px 16px; }
    .sale-cta p { flex: 1 1 260px; margin: 0; font-size: 13.5px; color: var(--text-2); }

    .moves { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 22px; margin: -4px 0 12px; font-size: 12.5px; color: var(--text-2); }
    .moves > span { display: inline-flex; align-items: center; gap: 6px; }
    .moves a { margin-left: auto; }
    .rb { position: relative; display: inline-block; width: 70px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, var(--neg-soft), var(--surface-2), var(--pos-soft)); }
    .rb i { position: absolute; top: -3px; width: 4px; height: 12px; margin-left: -2px; border-radius: 2px; background: var(--ink); }

    .lots > summary { padding: 6px 0; }
    .lots .card { margin-top: 8px; }
    .lots .lot-note { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 16px 0; font-size: 12.5px; color: var(--muted); }
    .lots .term { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
    .lots .term .sub { white-space: normal; }
    .lots td.cta { white-space: nowrap; }
    .show-xs { display: none; }
    @media (max-width: 760px) {
      .show-xs { display: block; }
      /* phones: date, units, term and the CTA fit without sideways scrolling; the gain is in the row's value columns on desktop */
      .lots .table th, .lots .table td { padding-left: 8px; padding-right: 8px; }
      .lots .bought .sub { display: block; }
      .lots td.cta { white-space: normal; }
      .lots td.cta .btn { white-space: normal; text-align: right; line-height: 1.2; padding: 4px 6px; }
    }
  `],
})
export class HoldingDetailComponent {
  id = input.required<string>();
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private router = inject(Router);
  private host = inject(ElementRef<HTMLElement>);
  private injector = inject(Injector);

  readonly statusMeta = STATUS_META;
  readonly txnLabel = TXN_LABEL;
  readonly classLabel = CLASS_LABEL;
  readonly attentionTiers: Action['tier'][] = ['now', 'month', 'consider'];
  readonly xirrMinDays = XIRR_MIN_DAYS;

  txns = signal<Transaction[]>([]);
  txnState = signal<'loading' | 'ok' | 'error'>('loading');
  txnError = signal<string | null>(null);
  history = signal<PriceHistory | null>(null);
  editing = signal(false);
  menuOpen = signal(false);
  moreStats = signal(false);
  private menuBtn = viewChild<ElementRef<HTMLButtonElement>>('menuBtn');

  /** Open lots: `/tax` is fetched the first time the T3 section opens (and again after a data change while open). */
  lotsOpen = signal(false);
  taxLots = signal<OpenLotTax[] | null>(null);
  taxState = signal<'idle' | 'loading' | 'ok' | 'error'>('idle');
  private taxSeq = 0;

  p = computed(() => this.store.positions().find(x => x.id === +this.id()));
  tradable = computed(() => isTradable(this.p()));
  verdict = computed(() => { const p = this.p(); return p ? holdingVerdict(p) : null; });
  /** Days since the first purchase; XIRR shows from 365. */
  heldDays = computed(() => daysSince(this.p()?.first_date) ?? 0);
  showXirr = computed(() => this.heldDays() >= XIRR_MIN_DAYS);
  moneyIn = computed(() => { const p = this.p(); return p ? returnOnMoneyIn(p) : null; });
  attention = computed(() => attentionPrefixes(+this.id()));
  /** "Plan a sale" is a read (the what-if), so guests get it too; only open units can be sold. */
  canPlanSale = computed(() => { const p = this.p(); return !!p && this.tradable() && p.is_open && (p.quantity ?? 0) > 0; });
  taxLabel = computed(() => TAX_CLASSES.find(t => t[0] === this.p()?.tax_class)?.[1] ?? this.p()?.tax_class ?? '—');
  backLink = computed(() => {
    const p = this.p();
    const ac = p?.asset_class;
    const seg = p ? SEGMENT_META[p.segment]?.route : undefined;
    if (seg) return seg;
    return ac === 'p2p' ? '/p2p' : ac === 'fixed_deposit' ? '/fixed-deposits' : ac === 'cash' ? '/forex' : ac === 'epf' ? '/epf' : ac === 'nps' ? '/nps'
      : `/holdings/${ac ?? 'all'}`;
  });

  priceFmt = (v: number) => this.history()?.currency === 'USD' ? usd(v) : inr(v, 2);
  priceAxis = (v: number) => this.history()?.currency === 'USD' ? '$' + Math.round(v) : '₹' + Math.round(v).toLocaleString('en-IN');
  hasChart = computed(() => (this.history()?.points.length ?? 0) > 1);
  /** 1-week and 1-month price change from the history already loaded for the chart (5 and 21 trading days). */
  moves = computed(() => {
    const pts = (this.history()?.points ?? []).map(p => p[1]).filter((v): v is number => v !== null && v > 0);
    if (pts.length < 6) return null;
    const last = pts[pts.length - 1];
    const chg = (n: number) => pts.length > n ? (last / pts[pts.length - 1 - n] - 1) * 100 : null;
    const month = pts.slice(-22);
    const lo = Math.min(...month), hi = Math.max(...month);
    return { w1: chg(5), m1: chg(21), low: lo, high: hi, pos: hi > lo ? (last - lo) / (hi - lo) * 100 : 50 };
  });
  hLabels = computed(() => (this.history()?.points ?? []).map(p => p[0]));
  hSeries = computed<LineSeries[]>(() => [{ key: 'px', label: 'Price', color: 'var(--s1)', values: (this.history()?.points ?? []).map(p => p[1]), area: true }]);
  hMarkers = computed(() => {
    const labels = this.hLabels();
    return (this.history()?.trades ?? []).map(t => {
      let i = labels.findIndex(d => d >= t.date);
      if (i < 0) i = labels.length - 1;
      const what = t.type === 'BUY' ? 'Bought' : 'Sold';
      return { i, kind: t.type === 'BUY' ? 'buy' as const : 'sell' as const,
        title: `${what} ${t.quantity} on ${t.date}${t.price ? ' at ' + this.priceFmt(t.price) : ''}` };
    });
  });

  /** FIFO lots, oldest first, with the tax view's term and "turns long-term" date once `/tax` has loaded. */
  lots = computed(() => {
    const p = this.p();
    if (!p) return [];
    const fx = p.currency === 'USD' ? (this.store.portfolio()?.usd_inr ?? 0) : 1;
    const unit = p.has_price && p.price ? p.price * fx : null;
    const tax = (this.taxLots() ?? []).filter(l => l.instrument_id === p.id);
    return joinLots(p.open_lots, tax, p.tax_class, unit);
  });
  lotsFromTax = computed(() => this.lots().some(l => l.fromTax));

  constructor() {
    effect(() => {
      const id = +this.id();
      this.store.version();
      untracked(() => {
        this.menuOpen.set(false);
        this.taxLots.set(null);
        this.taxState.set('idle');
        if (this.lotsOpen()) queueMicrotask(() => this.loadTax());
      });
      queueMicrotask(() => this.load(id));
    });
  }

  async load(id: number) {
    if (!this.txns().length) this.txnState.set('loading');
    try {
      const t = await firstValueFrom(this.api.transactions({ instrument_id: id }));
      if (id !== +this.id()) return;
      this.txns.set(t);
      this.txnState.set('ok');
      this.txnError.set(null);
    } catch (e) {
      if (id !== +this.id()) return;
      this.txnState.set('error');
      this.txnError.set(errorMessage(e));
    }
    try {
      const h = await firstValueFrom(this.api.instrumentHistory(id));
      if (id === +this.id()) this.history.set(h);
    } catch { if (id === +this.id()) this.history.set(null); }
  }

  /** The T3 lots section opened or closed: fetch `/tax` on first open. */
  onLotsToggle(ev: Event) {
    const open = (ev.target as HTMLDetailsElement).open;
    this.lotsOpen.set(open);
    if (open && (this.taxState() === 'idle' || this.taxState() === 'error')) void this.loadTax();
  }

  async loadTax() {
    const seq = ++this.taxSeq;
    this.taxState.set('loading');
    try {
      const t = await firstValueFrom(this.api.tax());
      if (seq !== this.taxSeq) return;
      this.taxLots.set(t.opportunities?.open_lots ?? []);
      this.taxState.set('ok');
    } catch {
      if (seq !== this.taxSeq) return;
      this.taxState.set('error');
    }
  }

  /** The what-if modal (H17), prefilled with `qty` units: the full holding, or a lot's cumulative FIFO quantity. */
  planSale(qty?: number) {
    const p = this.p();
    if (!p) return;
    this.dialog.openWhatIf({ instrumentId: p.id, qty: qty ?? p.quantity });
  }

  add(type: string) {
    const p = this.p()!;
    const kind = p.asset_class === 'p2p' ? 'p2p_repayment' : p.asset_class === 'cash' ? 'forex' : type === 'DIVIDEND' ? 'dividend' : p.asset_class;
    this.dialog.add(kind as any, { instrumentId: p.id, type });
  }
  corporateAction() { this.dialog.add('corporate_action', { instrumentId: this.p()!.id, type: 'BONUS' }); }

  toggleMenu() {
    const open = !this.menuOpen();
    this.menuOpen.set(open);
    // once the menu has rendered (event coalescing paints a frame later), move focus into it
    if (open) afterNextRender(() => (this.host.nativeElement.querySelector('.more-pop [role="menuitem"]') as HTMLElement | null)?.focus(),
      { injector: this.injector });
  }
  closeMenu(refocus = false) {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    if (refocus) this.menuBtn()?.nativeElement.focus();
  }
  @HostListener('document:keydown.escape')
  onEscape() { this.closeMenu(true); }
  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    if (!this.menuOpen()) return;
    const menu = this.host.nativeElement.querySelector('.more-menu');
    if (menu && !menu.contains(e.target as Node)) this.closeMenu();
  }

  async remove(t: Transaction) {
    if (!(await this.confirm.ask('Delete transaction?', `${TXN_LABEL[t.type]} on ${t.date} for ₹${t.amount.toLocaleString('en-IN')} will be removed, along with any capital-flow entry created from it.`, 'Delete'))) return;
    try {
      await firstValueFrom(this.api.deleteTransaction(t.id));
      this.toast.ok('Transaction deleted');
      await this.store.changed();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }

  async removeHolding() {
    this.closeMenu();
    const p = this.p()!;
    if (!(await this.confirm.ask(`Delete ${p.name}?`, `This permanently deletes the holding and all ${p.txn_count} of its transactions.`, 'Delete holding'))) return;
    try {
      await firstValueFrom(this.api.deleteInstrument(p.id));
      this.toast.ok(`${p.name} deleted`);
      const back = this.backLink();
      await this.store.changed();
      this.router.navigate([back]);
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
}
