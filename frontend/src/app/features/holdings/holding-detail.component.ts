import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, usd } from '../../core/format';
import { errorMessage } from '../../core/http';
import { CLASS_LABEL, PriceHistory, Transaction, TXN_LABEL } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { InstrumentEditComponent, TAX_CLASSES } from '../../shared/instrument-edit.component';
import { ConfirmService } from '../../shared/ui';

@Component({
  selector: 'app-holding-detail',
  standalone: true,
  imports: [RouterLink, IconComponent, InstrumentEditComponent, LineChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './holding-detail.component.html',
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

  txns = signal<Transaction[]>([]);
  history = signal<PriceHistory | null>(null);
  priceFmt = (v: number) => this.history()?.currency === 'USD' ? usd(v) : inr(v, 2);
  priceAxis = (v: number) => this.history()?.currency === 'USD' ? '$' + Math.round(v) : '₹' + Math.round(v).toLocaleString('en-IN');
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
  editing = signal(false);
  txnLabel = TXN_LABEL;
  classLabel = CLASS_LABEL;

  p = computed(() => this.store.positions().find(x => x.id === +this.id()));
  tradable = computed(() => ['equity', 'mutual_fund', 'commodity'].includes(this.p()?.asset_class ?? ''));
  taxLabel = computed(() => TAX_CLASSES.find(t => t[0] === this.p()?.tax_class)?.[1] ?? this.p()?.tax_class ?? '—');
  backLink = computed(() => {
    const ac = this.p()?.asset_class;
    return ac === 'p2p' ? '/p2p' : ac === 'fixed_deposit' ? '/fixed-deposits' : ac === 'cash' ? '/forex' : `/holdings/${ac ?? 'equity'}`;
  });
  lotsView = computed(() => (this.p()?.open_lots ?? []).map(l => {
    const lt = this.p()?.tax_class === 'foreign_equity' ? 730 : 365;
    return { ...l, longTerm: l.age_days > lt, daysToLt: Math.max(lt + 1 - l.age_days, 0),
      value: this.p()?.has_price ? l.qty * (this.p()!.price ?? 0) * (this.p()!.currency === 'USD' ? (this.store.portfolio()?.usd_inr ?? 0) : 1) : null };
  }));

  constructor() {
    effect(() => {
      const id = +this.id();
      this.store.version();
      queueMicrotask(() => this.load(id));
    });
  }

  async load(id: number) {
    try { this.txns.set(await firstValueFrom(this.api.transactions({ instrument_id: id }))); }
    catch (e) { this.toast.error(errorMessage(e)); }
    try { this.history.set(await firstValueFrom(this.api.instrumentHistory(id))); } catch { this.history.set(null); }
  }

  add(type: string) {
    const p = this.p()!;
    const kind = p.asset_class === 'p2p' ? 'p2p_repayment' : p.asset_class === 'cash' ? 'forex' : type === 'DIVIDEND' ? 'dividend' : p.asset_class;
    this.dialog.add(kind as any, { instrumentId: p.id, type });
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
    const p = this.p()!;
    if (!(await this.confirm.ask(`Delete ${p.name}?`, `This permanently deletes the holding and all ${p.txn_count} of its transactions.`, 'Delete holding'))) return;
    try {
      await firstValueFrom(this.api.deleteInstrument(p.id));
      this.toast.ok(`${p.name} deleted`);
      await this.store.changed();
      this.router.navigate([this.backLink()]);
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
}
