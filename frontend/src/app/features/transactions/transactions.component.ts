import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, downloadCsv } from '../../core/format';
import { errorMessage } from '../../core/http';
import { CLASS_LABEL, Transaction, TXN_LABEL } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

const TEMPLATE = 'date,type,asset_class,name,symbol,quantity,amount,amount_usd,market,sector,market_cap,category,notes\n'
  + '2026-01-15,BUY,equity,HDFC Bank,HDFCBANK.NS,10,16500,,India,Financials,Large Cap,,\n'
  + '2026-01-20,BUY,mutual_fund,Parag Parikh Flexi Cap,AMFI:122639,120.5,10000,,,,,Equity,SIP\n';

@Component({
  selector: 'app-transactions',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, SectionTabsComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './transactions.component.html',
})
export class TransactionsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  all = signal<Transaction[]>([]);
  loading = signal(true);
  q = signal('');
  cls = signal('');
  type = signal('');
  from = signal('');
  to = signal('');
  limit = signal(100);
  txnLabel = TXN_LABEL;
  classLabel = CLASS_LABEL;
  classes = Object.entries(CLASS_LABEL);
  types = Object.entries(TXN_LABEL);

  filtered = computed(() => {
    const q = this.q().toLowerCase().trim();
    return this.all().filter(t =>
      (!this.cls() || t.asset_class === this.cls()) && (!this.type() || t.type === this.type()) &&
      (!this.from() || t.date >= this.from()) && (!this.to() || t.date <= this.to()) &&
      (!q || `${t.instrument_name} ${t.notes ?? ''}`.toLowerCase().includes(q)));
  });
  shown = computed(() => this.filtered().slice(0, this.limit()));
  sums = computed(() => {
    const f = this.filtered();
    const s = (types: string[]) => f.filter(t => types.includes(t.type)).reduce((a, t) => a + t.amount, 0);
    return { out: s(['BUY', 'FX_IN']), in: s(['SELL', 'DIVIDEND', 'INTEREST', 'REPAYMENT', 'MATURITY', 'FX_OUT']) };
  });

  // import
  importing = signal(false);
  csv = '';
  preview = signal<{ format: string; rows: any[]; errors: { line: number; error: string }[] } | null>(null);
  busy = signal(false);
  importError = signal<string | null>(null);

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }

  async load() {
    try { this.all.set(await firstValueFrom(this.api.transactions())); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.loading.set(false); }
  }

  clear() { this.q.set(''); this.cls.set(''); this.type.set(''); this.from.set(''); this.to.set(''); }

  async remove(t: Transaction) {
    if (!(await this.confirm.ask('Delete transaction?', `${TXN_LABEL[t.type]} · ${t.instrument_name} · ${t.date}. Linked capital-flow entries are removed too.`, 'Delete'))) return;
    try {
      await firstValueFrom(this.api.deleteTransaction(t.id));
      this.toast.ok('Transaction deleted');
      await this.store.changed();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }

  export() {
    downloadCsv('transactions.csv', [
      ['date', 'type', 'asset_class', 'name', 'quantity', 'amount', 'amount_usd', 'principal', 'fees', 'notes', 'source'],
      ...this.filtered().map(t => [t.date, t.type, t.asset_class, t.instrument_name, t.quantity, t.amount, t.amount_fc, t.principal, t.fees, t.notes, t.source]),
    ]);
  }

  downloadTemplate() {
    const blob = new Blob([TEMPLATE], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'transactions-template.csv';
    a.click();
  }

  async onFile(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) { this.csv = await f.text(); await this.runPreview(); }
  }

  async runPreview() {
    this.busy.set(true);
    this.importError.set(null);
    try { this.preview.set(await firstValueFrom(this.api.importPreview(this.csv))); }
    catch (e) { this.importError.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }

  selectedRows() { return (this.preview()?.rows ?? []).filter(r => r.selected); }

  async commit() {
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.api.importCommit(this.selectedRows()));
      const failed = res.results.filter((r: any) => !r.ok);
      this.toast.ok(`Imported ${res.imported} transaction(s)`);
      if (failed.length) this.toast.error(`${failed.length} failed — first: ${failed[0].name}: ${failed[0].error}`);
      this.importing.set(false);
      this.preview.set(null);
      this.csv = '';
      await this.store.changed();
    } catch (e) { this.importError.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }
}
