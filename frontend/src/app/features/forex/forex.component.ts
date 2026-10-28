import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Transaction } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ConfirmService } from '../../shared/ui';

@Component({
  selector: 'app-forex',
  standalone: true,
  imports: [RouterLink, IconComponent, SectionTabsComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Holdings</h1>
        @if (auth.canWrite()) { <button class="btn sm" (click)="dialog.add('forex')"><app-icon name="plus" [size]="15" /> Transfer</button> }
      </div>
      <app-section-tabs group="holdings" current="/forex" style="margin-top:-12px" />
      <section class="kpis">
        <div class="kpi"><span class="label">Uninvested balance</span><span class="value">{{ w()?.balance_usd | usd }}</span><span class="meta">{{ w()?.value | inr }}</span></div>
        <div class="kpi"><span class="label">Your average rate</span><span class="value">{{ w()?.avg_rate ? '₹' + w()!.avg_rate!.toFixed(2) : '—' }}</span>
          <span class="meta">today ₹{{ (store.portfolio()?.usd_inr ?? 0).toFixed(2) }}</span></div>
        <div class="kpi"><span class="label">Currency gain on US stocks</span><span class="value" [class]="us().fx | sign">{{ us().fx | inr: 0 : true }}</span>
          <span class="meta">stock move {{ us().stock | inr: 0 : true }}</span></div>
        <div class="kpi"><span class="label">Gain on withdrawals</span><span class="value" [class]="w()?.realized | sign">{{ w()?.realized | inr: 0 : true }}</span>
          <span class="meta">vs your average deposit rate</span></div>
      </section>
      <section class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>Totals</h2></div>
          <dl class="kv">
            <dt>Sent to US</dt><dd>{{ w()?.invested | inr }} → {{ w()?.deposited_usd | usd }}</dd>
            <dt>Brought back</dt><dd>{{ w()?.proceeds | inr }} ← {{ w()?.withdrawn_usd | usd }}</dd>
            <dt>US stocks (value)</dt><dd>{{ us().value | inr }}</dd>
            <dt>US stocks (cost)</dt><dd>{{ us().cost | inr }}</dd>
            <dt>US unrealized</dt><dd [class]="us().value - us().cost | sign">{{ us().value - us().cost | inr: 0 : true }}</dd>
          </dl>
          <p class="small muted" style="margin-top:12px">The currency gain is how much more your US cost basis is worth in rupees today than when you paid for it.
            <a routerLink="/holdings/equity">See US holdings →</a></p>
        </div>
        <div class="card flush">
          <div class="card-head"><h2>Transfers</h2></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Date</th><th>Direction</th><th class="num">₹</th><th class="num">$</th><th class="num">Rate</th>@if (auth.canWrite()) { <th></th> }</tr></thead>
              <tbody>
                @for (t of txns(); track t.id) {
                  <tr>
                    <td>{{ t.date | dt }}</td><td>{{ t.type === 'FX_IN' ? 'To USD' : 'To INR' }}</td>
                    <td class="num">{{ t.amount | inr: 2 }}</td><td class="num">{{ t.amount_fc | usd }}</td>
                    <td class="num">{{ t.amount_fc ? (t.amount / t.amount_fc).toFixed(2) : '—' }}</td>
                    @if (auth.canWrite()) { <td class="right nowrap">
                      <button class="btn ghost icon sm" (click)="dialog.edit(t)" aria-label="Edit"><app-icon name="edit" [size]="15" /></button>
                      <button class="btn ghost icon sm danger" (click)="remove(t)" aria-label="Delete"><app-icon name="trash" [size]="15" /></button></td> }
                  </tr>
                } @empty { <tr><td colspan="6" class="muted">No transfers recorded.</td></tr> }
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>`,
})
export class ForexComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  txns = signal<Transaction[]>([]);

  w = computed(() => this.store.positions().find(p => p.asset_class === 'cash'));
  us = computed(() => {
    const us = this.store.openPositions().filter(p => p.asset_class === 'equity' && p.currency === 'USD');
    return { value: us.reduce((a, p) => a + p.value, 0), cost: us.reduce((a, p) => a + p.cost, 0),
      fx: us.reduce((a, p) => a + (p.fx_gain ?? 0), 0), stock: us.reduce((a, p) => a + (p.stock_gain ?? 0), 0) };
  });

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }
  async load() {
    try { this.txns.set(await firstValueFrom(this.api.transactions({ asset_class: 'cash' }))); } catch { /* shown as empty */ }
  }
  async remove(t: Transaction) {
    if (!(await this.confirm.ask('Delete transfer?', `The ${t.date} transfer and its capital-flow entry will be removed.`, 'Delete'))) return;
    try { await firstValueFrom(this.api.deleteTransaction(t.id)); this.toast.ok('Deleted'); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
