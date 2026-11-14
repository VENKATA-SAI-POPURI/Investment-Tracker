import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, usd } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Position, Status, Transaction } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { PortfolioTabsComponent } from '../../shared/portfolio-tabs.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { ConfirmService } from '../../shared/ui';

/** Dollars above which the wallet counts as idle money (H19; the backend's `cash:usd` insight fires on the same idea). */
export const IDLE_USD = 50;

export interface WalletVerdict { status: Status; text: string; }

/**
 * The USD wallet's T0 verdict (H19): `unset` with no wallet, `watch` when more than $50 sits uninvested,
 * else `good`. Pure, so the rule is readable apart from the template.
 */
export function walletVerdict(w: Pick<Position, 'balance_usd'> | null | undefined): WalletVerdict {
  if (!w) return { status: 'unset', text: 'No USD wallet yet · record a transfer to start' };
  const bal = Number(w.balance_usd ?? 0);
  if (Number.isFinite(bal) && bal > IDLE_USD) return { status: 'watch', text: `${usd(bal, 0)} idle · deploy it` };
  return { status: 'good', text: 'Fully invested' };
}

/**
 * USD wallet class page (SPEC Part 1 §5.7; AMENDMENTS H19, A22, D24).
 * - T0: hero "Uninvested balance" ($ with the ₹ value) and its verdict line; tiles average rate vs today,
 *   currency gain on US stocks (`fx_gain`) and gain on withdrawals (behind "More" at ≤ 760 px).
 * - T1: Needs attention, showing `cash:usd` (info severity, so it ranks `consider`) with its Deploy CTA.
 * - T3: the Totals kv and the Transfers table, unchanged.
 * Reads the store's portfolio, the cached `/actions` through NeedsAttention, and `/transactions?asset_class=cash`.
 */
@Component({
  selector: 'app-forex',
  standalone: true,
  imports: [RouterLink, IconComponent, PortfolioTabsComponent, NeedsAttentionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .hero-skel { height: 150px; border-radius: 14px; }
    /* T0: hero + three tiles; phones keep the hero and two tiles, the last sits behind "More" (§1.5) */
    .w-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); }
    .w-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; }
    .w-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .w-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .w-kpis .kpi.extra { grid-column: span 2; border-left: 0; border-top: 1px solid rgba(255, 255, 255, .09); }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .w-kpis .kpi.extra:not(.show) { display: none; }
    }
  `],
  template: `
    <div class="page">
      <app-portfolio-tabs />
      <div class="page-head">
        <h1>USD wallet</h1>
        @if (auth.canWrite()) { <button class="btn sm" (click)="dialog.add('forex')"><app-icon name="plus" [size]="15" /> Transfer</button> }
      </div>

      @if (loading()) {
        <div class="skeleton hero-skel" aria-label="Loading your USD wallet"></div>
      } @else if (failed()) {
        <div class="card"><div class="empty">
          <app-icon name="alert" [size]="22" /><h3>Couldn't load your USD wallet</h3><p>{{ store.error() }}</p>
          <button type="button" class="btn" (click)="store.reload()"><app-icon name="refresh" [size]="15" /> Try again</button>
        </div></div>
      } @else {
        @if (store.error()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't refresh, so these are the last numbers this device saw · {{ store.error() }}</span>
            <button type="button" class="btn ghost sm" (click)="store.reload()">Try again</button></div>
        }

        <!-- T0: how much is sitting in dollars, and whether that needs doing something about -->
        <section class="kpis w-kpis" aria-label="Your USD wallet at a glance">
          <div class="kpi hero">
            <span class="label">Uninvested balance</span>
            <span class="value">{{ w() ? (w()!.balance_usd | usd) : '—' }}</span>
            <span class="meta">@if (w(); as wl) { {{ wl.value | inr }} at today's rate } @else { Nothing sent to the US yet }</span>
            <div class="verdict-line" [attr.data-status]="verdict().status">
              <app-icon [name]="statusMeta[verdict().status].icon" [size]="16" />
              <span>{{ verdict().text }}</span><span class="sr-only">· {{ statusMeta[verdict().status].word }}</span>
            </div>
            <button type="button" class="more-stats" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">{{ moreStats() ? 'Less' : 'More' }}</button>
          </div>
          <div class="kpi"><span class="chip violet sm"><app-icon name="scale" [size]="15" /></span><span class="label">Average rate vs today</span>
            <span class="value">{{ rate().avg ? '₹' + rate().avg!.toFixed(2) : '—' }}</span>
            <span class="meta">today {{ rate().now ? '₹' + rate().now!.toFixed(2) : '—' }}@if (rate().diffPct !== null) { · <span [class]="rate().diffPct! | sign">{{ rate().diffPct! | pct }}</span> vs yours }</span></div>
          <div class="kpi"><span class="chip green sm"><app-icon name="globe" [size]="15" /></span><span class="label">Currency gain on US stocks</span><span class="value" [class]="us().fx | sign">{{ us().fx | inr: 0 : true }}</span>
            <span class="meta">stock move {{ us().stock | inr: 0 : true }}</span></div>
          <div class="kpi extra" [class.show]="moreStats()"><span class="chip amber sm"><app-icon name="coins" [size]="15" /></span><span class="label">Gain on withdrawals</span><span class="value" [class]="w()?.realized | sign">{{ w()?.realized | inr: 0 : true }}</span>
            <span class="meta">vs your average deposit rate</span></div>
        </section>

        <!-- T1: needs attention here (H19). cash:usd is info severity, so it ranks 'consider' -->
        <app-needs-attention [prefixes]="['/forex']" [ids]="['cash:usd']" [tiers]="['now', 'month', 'consider']" />

        <!-- T3: totals and the transfer ledger -->
        <section class="grid grid-3 top">
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
          <div class="card flush span-2">
            <div class="card-head"><h2>Transfers</h2></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Date</th><th>Direction</th><th class="num">₹</th><th class="num">$</th><th class="num">Rate</th>@if (auth.canWrite()) { <th></th> }</tr></thead>
                <tbody>
                  @if (txLoading() && !txns().length) {
                    <tr><td colspan="6" class="muted">Loading…</td></tr>
                  } @else if (txError() && !txns().length) {
                    <tr><td colspan="6" class="muted">Couldn't load your transfers · {{ txError() }}
                      <button type="button" class="btn ghost sm" (click)="load()">Try again</button></td></tr>
                  } @else {
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
                  }
                </tbody>
              </table>
            </div>
          </div>
        </section>
      }
    </div>`,
})
export class ForexComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  readonly statusMeta = STATUS_META;
  txns = signal<Transaction[]>([]);
  txLoading = signal(false);
  txError = signal<string | null>(null);
  /** Phones: the third tile sits behind "More" (§1.5). */
  moreStats = signal(false);
  private loadSeq = 0;

  /** Nothing cached yet and the first load is still running. */
  loading = computed(() => !this.store.portfolio() && !this.store.error());
  /** The portfolio could not load and nothing is cached. */
  failed = computed(() => !this.store.portfolio() && !!this.store.error());

  w = computed(() => this.store.positions().find(p => p.asset_class === 'cash'));
  verdict = computed(() => walletVerdict(this.w()));
  rate = computed(() => {
    const avg = this.w()?.avg_rate || null;
    const now = this.w()?.current_rate || this.store.portfolio()?.usd_inr || null;
    return { avg, now, diffPct: avg && now ? (now / avg - 1) * 100 : null };
  });
  us = computed(() => {
    const us = this.store.openPositions().filter(p => p.asset_class === 'equity' && p.currency === 'USD');
    return { value: us.reduce((a, p) => a + p.value, 0), cost: us.reduce((a, p) => a + p.cost, 0),
      fx: us.reduce((a, p) => a + (p.fx_gain ?? 0), 0), stock: us.reduce((a, p) => a + (p.stock_gain ?? 0), 0) };
  });

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }
  async load() {
    const mine = ++this.loadSeq;
    this.txLoading.set(true);
    try {
      const rows = await firstValueFrom(this.api.transactions({ asset_class: 'cash' }));
      if (mine !== this.loadSeq) return;
      this.txns.set(rows);
      this.txError.set(null);
    } catch (e) {
      if (mine === this.loadSeq) this.txError.set(errorMessage(e));
    } finally {
      if (mine === this.loadSeq) this.txLoading.set(false);
    }
  }
  async remove(t: Transaction) {
    if (!(await this.confirm.ask('Delete transfer?', `The ${t.date} transfer and its capital-flow entry will be removed.`, 'Delete'))) return;
    try { await firstValueFrom(this.api.deleteTransaction(t.id)); this.toast.ok('Deleted'); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
