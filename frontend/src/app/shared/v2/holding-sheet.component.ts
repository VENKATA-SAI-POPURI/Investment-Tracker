import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { fmtDate, inr, money, monthTicks, pctV, qty, usd } from '../../core/format';
import { groupMeta } from '../../core/groups';
import { holdingLine, initials, logoColor } from '../../core/holding-view';
import { Position, PriceHistory, Transaction } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { AddKind, TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../icon.component';
import { AreaChartComponent } from './charts';

type Tab = 'overview' | 'lots' | 'entries' | 'calc';

const KIND: Partial<Record<string, AddKind>> = { equity: 'equity', mutual_fund: 'mutual_fund', commodity: 'commodity', nps: 'nps', epf: 'epf' };
const TYPE_LABEL: Record<string, string> = { BUY: 'Buy', SELL: 'Sell', DIVIDEND: 'Dividend', INTEREST: 'Interest paid out', REPAYMENT: 'Repayment',
  MATURITY: 'Matured', FX_IN: 'Sent to US account', FX_OUT: 'Brought back', CREDIT: 'Interest credited', BONUS: 'Bonus shares', SPLIT: 'Split' };

/** One holding, in a sheet: what it's worth, its lots, its entries and how each number is worked out. */
@Component({
  selector: 'v-holding-sheet',
  standalone: true,
  imports: [IconComponent, AreaChartComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="v-dim" (click)="closed.emit()"></div>
    @if (pos(); as p) {
    <section class="v-sheet" role="dialog" aria-modal="true" [attr.aria-label]="p.name">
      <div class="grab"></div>
      <button class="close" (click)="closed.emit()" aria-label="Close"><app-icon name="close" [size]="16" /></button>
      <div class="head">
        <span class="v-logo lg" [style.--c]="color()">{{ init() }}</span>
        <div class="grow"><div class="nm">{{ p.name }}</div><div class="v-mut sub">{{ g().label }}{{ p.symbol && !p.symbol.startsWith('AMFI') ? ' · ' + p.symbol : '' }}</div></div>
      </div>
      <div class="val"><b>{{ money(p.value) }}</b>
        <span class="v-pill" [class.ok]="line().tone === 'gain'" [class.no]="line().tone === 'loss'" [class.warn]="line().tone === 'warn'" [class.eq]="line().tone === 'mut'">
          {{ p.unrealized && p.has_price ? money(p.unrealized, true) + ' · ' : '' }}{{ line().change }}</span></div>

      <div class="v-tabs" role="tablist">
        @for (t of tabs(); track t.key) { <button role="tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="tab.set(t.key)">{{ t.label }}</button> }
      </div>

      @switch (tab()) {
        @case ('overview') {
          @if (chart(); as c) {
            <v-area [a]="c.price" [b]="c.cost" [labels]="c.ticks" [h]="104" [color]="color()" [dashB]="true" label="Price against your average cost" />
            <div class="v-legend"><span [style.--c]="color()">Price</span>@if (c.cost) { <span style="--c:#c9c5d8">Your avg cost</span> }</div>
          }
          <div class="v-stats" style="margin:14px 0 12px">
            @for (s of stats(); track s.label) { <div><small>{{ s.label }}</small><b [class.v-gain]="s.tone === 'gain'" [class.v-loss]="s.tone === 'loss'">{{ s.value }}</b></div> }
          </div>
          @if (note(); as n) { <div class="v-note" [class.good]="n.tone === 'good'" [class.warn]="n.tone === 'warn'"><app-icon [name]="n.tone === 'good' ? 'circleCheck' : 'alert'" [size]="18" [stroke]="2.2" /> {{ n.text }}</div> }
          @if (auth.canWrite()) {
            <div class="btns">
              @for (b of buttons(); track b.label; let i = $index) { <button class="v-btn" [class.primary]="i === 0" (click)="b.run()">{{ b.label }}</button> }
            </div>
          }
          <a class="v-link more" [routerLink]="['/holding', p.id]" (click)="closed.emit()">All details <app-icon name="chevronRight" [size]="14" [stroke]="2.4" /></a>
        }
        @case ('lots') {
          @for (l of p.open_lots ?? []; track $index) {
            <div class="v-row"><div class="grow"><div class="t">{{ qty(l.qty) }} {{ p.asset_class === 'equity' ? 'shares' : 'units' }} · {{ fmtDate(l.date) }}</div>
              <div class="s">Cost {{ inr(l.cost) }} · held {{ l.age_days }} days</div></div>
              <div class="r"><span class="v-pill" [class.ok]="l.age_days >= ltDays()" [class.eq]="l.age_days < ltDays()">{{ l.age_days >= ltDays() ? 'Long-term' : 'Short-term' }}</span></div></div>
          } @empty { <p class="v-empty">No open lots: this kind of holding is not bought in units.</p> }
        }
        @case ('entries') {
          @for (t of txns(); track t.id) {
            <div class="v-row"><div class="grow"><div class="t">{{ typeLabel(t.type) }}</div>
              <div class="s">{{ fmtDate(t.date) }}{{ t.quantity ? ' · ' + qty(t.quantity) + (p.asset_class === 'equity' ? ' shares' : ' units') : '' }}{{ t.source !== 'manual' ? ' · ' + t.source : '' }}</div></div>
              <div class="r"><b>{{ inr(t.amount) }}</b>
                <span class="acts"><a class="v-link" routerLink="/activity" [queryParams]="{ tab: 'flow', txn: t.id }" (click)="closed.emit()">Flow</a>
                @if (auth.canWrite()) { · <button class="v-link" (click)="dialog.edit(t)">Edit</button> }</span></div></div>
          } @empty { <p class="v-empty">{{ txnsLoading() ? 'Loading…' : 'No entries.' }}</p> }
        }
        @case ('calc') {
          @for (c of calc(); track c.label) {
            <div class="calc"><div class="t">{{ c.label }}</div><div class="fx">{{ c.formula }}</div>@if (c.note) { <div class="s">{{ c.note }}</div> }</div>
          }
          <a class="v-link more" routerLink="/activity" [queryParams]="{ tab: 'flow', instrument: p.id }" (click)="closed.emit()">See how each entry flows in <app-icon name="chevronRight" [size]="14" [stroke]="2.4" /></a>
        }
      }
    </section>
    }
  `,
  styles: [`
    .head { display: flex; align-items: center; gap: 12px; padding-right: 40px; }
    .v-logo.lg { width: 46px; height: 46px; border-radius: 15px; font-size: 15px; }
    .grow { min-width: 0; flex: 1; }
    .nm { font-weight: 800; font-size: 18px; letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { font-size: 12.5px; font-weight: 600; }
    .val { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
    .val b { font-size: 26px; font-weight: 800; letter-spacing: -.03em; }
    .btns { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
    .more { margin-top: 14px; }
    .acts { font-size: 12px; color: var(--muted); }
    .acts .v-link { font-size: 12px; }
    .calc { padding: 11px 0; border-top: 1px solid var(--border); }
    .calc:first-child { border-top: 0; }
    .calc .t { font-weight: 700; font-size: 13.5px; }
    .calc .fx { display: inline-block; font-size: 12.5px; font-weight: 700; background: var(--bg); border-radius: 9px; padding: 5px 9px; margin-top: 6px; }
    .calc .s { font-size: 12px; color: var(--muted); margin-top: 4px; }
  `],
})
export class HoldingSheetComponent {
  id = input.required<number>();
  closed = output<void>();
  private api = inject(ApiService);
  private store = inject(StoreService);
  dialog = inject(TxnDialogService);
  auth = inject(AuthService);

  money = money; pctV = pctV; inr = inr; qty = qty; fmtDate = fmtDate;
  typeLabel = (t: string) => TYPE_LABEL[t] ?? t;

  tab = signal<Tab>('overview');
  hist = signal<PriceHistory | null>(null);
  txns = signal<Transaction[]>([]);
  txnsLoading = signal(false);

  pos = computed<Position | undefined>(() => this.store.positions().find(p => p.id === this.id()));
  g = computed(() => groupMeta(this.pos()?.group));
  color = computed(() => logoColor(this.pos()?.name ?? ''));
  init = computed(() => initials(this.pos()?.name ?? '?'));
  line = computed(() => holdingLine(this.pos()!));
  unitised = computed(() => ['equity', 'mutual_fund', 'commodity', 'nps'].includes(this.pos()?.asset_class ?? ''));
  ltDays = computed(() => this.pos()?.tax_class === 'equity' ? 365 : 730);
  tabs = computed(() => [
    { key: 'overview' as Tab, label: 'Overview' },
    ...(this.unitised() ? [{ key: 'lots' as Tab, label: 'Lots' }] : []),
    { key: 'entries' as Tab, label: 'Entries' },
    { key: 'calc' as Tab, label: 'Calculation' },
  ]);

  chart = computed(() => {
    const h = this.hist(), p = this.pos();
    if (!h || !p || h.points.length < 2) return null;
    const pts = h.points.slice(-260);
    const avg = p.currency === 'USD' ? p.avg_cost_fc : p.avg_cost;
    return { price: pts.map(x => x[1]), cost: avg ? pts.map(() => avg) : null, ticks: monthTicks(pts.map(x => x[0]), 3) };
  });

  stats = computed(() => {
    const p = this.pos()!;
    const s: { label: string; value: string; tone?: 'gain' | 'loss' }[] = [];
    const t = (v: number | null | undefined) => (!v ? undefined : v > 0 ? 'gain' : 'loss') as 'gain' | 'loss' | undefined;
    if (this.unitised()) {
      const usdP = p.currency === 'USD';
      s.push({ label: p.asset_class === 'equity' ? 'Shares' : 'Units', value: qty(p.quantity) },
        { label: 'Price', value: p.price ? (usdP ? usd(p.price) : inr(p.price, p.price < 1000 ? 2 : 0)) : '—' },
        { label: 'Avg cost', value: usdP && p.avg_cost_fc ? usd(p.avg_cost_fc) : p.avg_cost ? inr(p.avg_cost, p.avg_cost < 1000 ? 2 : 0) : '—' },
        { label: 'Invested', value: money(p.cost) },
        { label: 'Booked', value: money(p.realized + p.income, true), tone: t(p.realized + p.income) },
        { label: 'Return / yr', value: pctV(p.xirr) });
    } else if (p.asset_class === 'p2p') {
      s.push({ label: 'Lent', value: money(p.invested) }, { label: 'Repaid', value: money(p.principal_repaid ?? 0) },
        { label: 'Left', value: money(p.outstanding ?? 0) }, { label: 'Interest', value: money(p.interest ?? 0, true), tone: t(p.interest) },
        { label: 'Rate', value: (p.rate ?? '—') + '%' }, { label: 'Return / yr', value: pctV(p.xirr) });
    } else if (p.asset_class === 'fixed_deposit') {
      s.push({ label: 'Deposited', value: money(p.invested) }, { label: 'Interest so far', value: money(p.accrued_interest ?? 0, true), tone: 'gain' },
        { label: 'Rate', value: (p.rate ?? '—') + '%' }, { label: 'Matures', value: fmtDate(p.maturity_date, true) },
        { label: 'At maturity', value: money(p.maturity_value) }, { label: 'Days left', value: p.days_to_maturity !== null && p.days_to_maturity !== undefined ? String(p.days_to_maturity) : '—' });
    } else if (p.asset_class === 'epf') {
      s.push({ label: 'Contributed', value: money(p.invested) }, { label: 'Interest credited', value: money(p.interest_credited ?? 0, true), tone: 'gain' },
        { label: 'Interest due', value: money(p.accrued_interest ?? 0, true) }, { label: 'Rate', value: (p.rate ?? 8.25) + '%' },
        { label: 'Withdrawn', value: money(p.proceeds ?? 0) }, { label: 'Return / yr', value: pctV(p.xirr) });
    } else {
      s.push({ label: 'USD cash', value: usd(p.balance_usd ?? 0) }, { label: 'Bought at', value: '₹' + (p.avg_rate ?? 0).toFixed(2) },
        { label: 'Today', value: '₹' + (p.current_rate ?? 0).toFixed(2) });
    }
    return s;
  });

  note = computed<{ text: string; tone: 'good' | 'warn' } | null>(() => {
    const p = this.pos()!;
    if (this.unitised() && p.open_lots?.length && p.asset_class !== 'nps') {
      const lt = p.open_lots.filter(l => l.age_days >= this.ltDays());
      if (lt.length === p.open_lots.length) return { text: `All ${qty(p.quantity)} ${p.asset_class === 'equity' ? 'shares' : 'units'} are long-term (lower tax)`, tone: 'good' };
      const next = p.open_lots.filter(l => l.age_days < this.ltDays()).sort((a, b) => b.age_days - a.age_days)[0];
      return { text: `${qty(next.qty)} turn long-term in ${this.ltDays() - next.age_days} days`, tone: 'warn' };
    }
    if (p.asset_class === 'p2p' && (p.overdue_days ?? 0) > 0) return { text: `${p.overdue_days} days past the due date`, tone: 'warn' };
    if (!p.has_price && this.unitised() && p.is_open) return { text: 'No price yet: valued at cost until a ticker is added', tone: 'warn' };
    return null;
  });

  buttons = computed(() => {
    const p = this.pos()!;
    const kind = KIND[p.asset_class];
    const out: { label: string; run: () => void }[] = [];
    if (kind && this.unitised()) {
      out.push({ label: 'Buy more', run: () => this.dialog.add(kind, { instrumentId: p.id, type: 'BUY' }) });
      if (p.is_open) out.push({ label: 'Sell', run: () => this.dialog.add(kind, { instrumentId: p.id, type: 'SELL' }) });
      if (p.asset_class === 'equity' || p.asset_class === 'mutual_fund') out.push({ label: 'Dividend', run: () => this.dialog.add('dividend', { instrumentId: p.id }) });
    } else if (p.asset_class === 'p2p') {
      out.push({ label: 'Add repayment', run: () => this.dialog.add('p2p_repayment', { instrumentId: p.id }) });
    } else if (p.asset_class === 'fixed_deposit' && p.is_open) {
      out.push({ label: 'Mark matured', run: () => this.dialog.openFdMature(p.id) });
    } else if (p.asset_class === 'epf') {
      out.push({ label: 'Add contribution', run: () => this.dialog.add('epf', { instrumentId: p.id }) });
    } else if (p.asset_class === 'cash') {
      out.push({ label: 'USD transfer', run: () => this.dialog.add('forex') });
    }
    return out;
  });

  calc = computed(() => {
    const p = this.pos()!;
    const rows: { label: string; formula: string; note?: string }[] = [];
    if (this.unitised()) {
      const fx = p.currency === 'USD' ? (this.store.portfolio()?.usd_inr ?? null) : null;
      rows.push({ label: 'Value', formula: p.has_price
        ? `${qty(p.quantity)} × ${p.currency === 'USD' ? usd(p.price) : inr(p.price, 2)}${fx ? ` × ₹${fx.toFixed(2)}/$` : ''} = ${inr(p.value)}`
        : `No price: value = cost = ${inr(p.cost)}` });
      rows.push({ label: 'Cost of what you hold', formula: `${p.open_lots?.length ?? 0} open lot${(p.open_lots?.length ?? 0) === 1 ? '' : 's'} = ${inr(p.cost)}`,
        note: 'Sales use the oldest lots first (FIFO), as the tax rules do.' });
      rows.push({ label: 'Unrealised gain', formula: `${inr(p.value)} − ${inr(p.cost)} = ${inr(p.unrealized)}` });
      rows.push({ label: 'Booked gain', formula: `${inr(p.proceeds ?? 0)} sales − their lots' cost = ${inr(p.realized)}` });
      if (p.income) rows.push({ label: 'Dividends', formula: inr(p.income) });
      if (p.fx_gain !== undefined) rows.push({ label: 'Of the gain, the rupee move', formula: `${inr(p.fx_gain)} currency · ${inr(p.stock_gain ?? 0)} stock` });
    } else if (p.asset_class === 'p2p') {
      rows.push({ label: 'Left to be repaid', formula: `${inr(p.invested)} lent − ${inr(p.principal_repaid ?? 0)} principal back = ${inr(p.outstanding ?? 0)}` });
      rows.push({ label: 'Interest earned', formula: `repayments − their principal = ${inr(p.interest ?? 0)}`,
        note: 'A repayment saved without a principal split is assumed to be an equal share of the loan.' });
    } else if (p.asset_class === 'fixed_deposit') {
      rows.push({ label: 'Value today', formula: `${inr(p.invested)} × (1 + ${p.rate}% ÷ 4)^(4 × years) − payouts = ${inr(p.value)}`,
        note: 'Indian banks compound FDs every quarter.' });
    } else if (p.asset_class === 'epf') {
      rows.push({ label: 'Balance', formula: `${inr(p.invested)} in + ${inr(p.interest_credited ?? 0)} credited − ${inr(p.proceeds ?? 0)} out = ${inr((p.value ?? 0) - (p.accrued_interest ?? 0))}` });
      rows.push({ label: 'Interest not yet credited', formula: `${p.rate}% a year on the running balance = ${inr(p.accrued_interest ?? 0)}`,
        note: 'EPFO credits interest once a year; until then it is shown as due.' });
    } else {
      rows.push({ label: 'Value', formula: `${usd(p.balance_usd ?? 0)} × ₹${(p.current_rate ?? 0).toFixed(2)} = ${inr(p.value)}` });
    }
    rows.push({ label: 'Return a year (XIRR)', formula: pctV(p.xirr),
      note: 'Every rupee in (negative) and out (positive) on its date, plus today\'s value, solved for one yearly rate.' });
    return rows;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      this.store.version();
      const ready = !!this.pos();   // a deep link can open before the holdings have loaded
      if (ready) untracked(() => void this.load(id));
    });
  }

  private async load(id: number) {
    this.txnsLoading.set(true);
    const p = this.pos();
    if (p && this.unitised() && p.symbol) {
      firstValueFrom(this.api.instrumentHistory(id)).then(h => this.hist.set(h)).catch(() => this.hist.set(null));
    } else this.hist.set(null);
    try {
      const t = await firstValueFrom(this.api.transactions({ instrument_id: id }));
      this.txns.set([...t].sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)));
    } catch { this.txns.set([]); } finally { this.txnsLoading.set(false); }
  }

  @HostListener('document:keydown.escape') esc() { this.closed.emit(); }
}
