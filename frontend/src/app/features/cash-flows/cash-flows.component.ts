import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { CashMovement } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { Bar, BarChartComponent } from '../../shared/charts/bar-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

const CATEGORIES = ['Equity/Commodity', 'Equity USA', 'Mutual Funds', 'P2P', 'Fixed Deposits', 'Other'];

@Component({
  selector: 'app-cash-flows',
  standalone: true,
  imports: [FormsModule, IconComponent, SectionTabsComponent, ModalComponent, BarChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Activity</h1>
        @if (auth.canWrite()) { <button class="btn sm" (click)="startAdd()"><app-icon name="plus" [size]="15" /> Add entry</button> }
      </div>
      <app-section-tabs group="activity" current="/cash-flows" style="margin-top:-12px" />
      <div class="seg" style="align-self:flex-start">
        <button [class.on]="account() === 'capital'" (click)="account.set('capital')">Contributions</button>
        <button [class.on]="account() === 'p2p_escrow'" (click)="account.set('p2p_escrow')">P2P escrow</button>
      </div>
      <section class="kpis" style="--kpi-cols:3">
        <div class="kpi"><span class="label">{{ account() === 'capital' ? 'Deposited' : 'In' }}</span><span class="value">{{ sums().in | inr }}</span></div>
        <div class="kpi"><span class="label">{{ account() === 'capital' ? 'Withdrawn' : 'Out' }}</span><span class="value">{{ sums().out | inr }}</span></div>
        <div class="kpi"><span class="label">{{ account() === 'capital' ? 'Net contributed' : 'Balance' }}</span><span class="value">{{ sums().in - sums().out | inr }}</span></div>
      </section>
      @if (bars().length > 1) {
        <section class="card">
          <div class="card-head"><h2>Net {{ account() === 'capital' ? 'contributions' : 'flow' }} by month</h2><span class="hint">Positive = money added</span></div>
          <app-bar-chart [bars]="bars()" [height]="200" [yFormat]="inrc" [tipFormat]="inrFull" ariaLabel="Net contributions by month" />
        </section>
      }
      <section class="card flush">
        <div class="table-wrap" style="max-height:600px">
          <table class="table">
            <thead><tr><th>Date</th><th>Category</th><th>Type</th><th class="num">Amount</th><th class="hide-sm">Notes</th><th class="hide-sm">Source</th>@if (auth.canWrite()) { <th></th> }</tr></thead>
            <tbody>
              @for (c of rows(); track c.id) {
                <tr>
                  <td class="nowrap">{{ c.date | dt }}</td><td>{{ c.category || '—' }}</td><td>{{ c.kind }}</td>
                  <td class="num" [class]="c.direction === 'in' ? '' : 'muted'">{{ c.direction === 'in' ? '+' : '−' }}{{ c.amount | inr: 2 }}</td>
                  <td class="hide-sm small muted ellipsis" style="max-width:260px" [title]="c.notes ?? ''">{{ c.notes }}</td>
                  <td class="hide-sm">@if (c.transaction_id) { <span class="badge info">from transaction</span> } @else { <span class="small muted">{{ c.source }}</span> }</td>
                  @if (auth.canWrite()) {
                    <td class="right nowrap">
                      @if (!(c.transaction_id && c.source === 'auto')) { <button class="btn ghost icon sm" (click)="startEdit(c)" aria-label="Edit"><app-icon name="edit" [size]="15" /></button> }
                      <button class="btn ghost icon sm danger" (click)="remove(c)" aria-label="Delete"><app-icon name="trash" [size]="15" /></button>
                    </td>
                  }
                </tr>
              } @empty { <tr><td colspan="7" class="muted">No entries.</td></tr> }
            </tbody>
          </table>
        </div>
      </section>
      <p class="small muted">Mutual fund, FD, P2P, forex and dividend entries are created automatically from transactions. Add broker deposits and withdrawals for stocks yourself.</p>
    </div>
    @if (editing(); as e) {
      <app-modal [title]="e.id ? 'Edit entry' : 'Add entry'" [width]="480" (close)="editing.set(null)">
        <form class="form" (ngSubmit)="save()">
          <div class="field"><label>Direction</label>
            <div class="seg"><button type="button" [class.on]="f.direction === 'in'" (click)="f.direction = 'in'">Money in</button>
              <button type="button" [class.on]="f.direction === 'out'" (click)="f.direction = 'out'">Money out</button></div></div>
          <div class="cols">
            <div class="field"><label for="cf-date">Date</label><input id="cf-date" class="input" type="date" name="date" [(ngModel)]="f.date" /></div>
            <div class="field"><label for="cf-amt">Amount (₹)</label><input id="cf-amt" class="input num" type="number" step="0.01" name="amount" [(ngModel)]="f.amount" /></div>
            <div class="field"><label for="cf-cat">Category</label>
              <select id="cf-cat" class="input" name="category" [(ngModel)]="f.category">@for (c of categories; track c) { <option>{{ c }}</option> }</select></div>
            @if (account() === 'capital') {
              <div class="field"><label for="cf-kind">Kind</label>
                <select id="cf-kind" class="input" name="kind" [(ngModel)]="f.kind"><option>Deposit</option><option>Withdrawal</option><option>Profit Withdrawal</option></select></div>
            }
          </div>
          <div class="field"><label for="cf-notes">Notes</label><input id="cf-notes" class="input" name="notes" [(ngModel)]="f.notes" /></div>
          @if (error()) { <div class="notice bad">{{ error() }}</div> }
          <div class="form-actions"><button type="button" class="btn" (click)="editing.set(null)">Cancel</button><button class="btn primary" type="submit">Save</button></div>
        </form>
      </app-modal>
    }`,
})
export class CashFlowsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  account = signal<'capital' | 'p2p_escrow'>('capital');
  all = signal<CashMovement[]>([]);
  editing = signal<Partial<CashMovement> | null>(null);
  error = signal<string | null>(null);
  f: any = {};
  categories = CATEGORIES;
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v, 0, true);

  rows = computed(() => this.all().filter(c => c.account === this.account()));
  sums = computed(() => ({
    in: this.rows().filter(c => c.direction === 'in').reduce((a, c) => a + c.amount, 0),
    out: this.rows().filter(c => c.direction === 'out').reduce((a, c) => a + c.amount, 0),
  }));
  bars = computed<Bar[]>(() => {
    const m = new Map<string, number>();
    for (const c of this.rows()) m.set(c.date.slice(0, 7), (m.get(c.date.slice(0, 7)) ?? 0) + (c.direction === 'in' ? c.amount : -c.amount));
    return [...m.entries()].sort().slice(-24).map(([k, v]) => {
      const d = new Date(k + '-01T00:00:00');
      return { label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }), value: Math.round(v),
        title: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) };
    });
  });

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }
  async load() {
    try { this.all.set(await firstValueFrom(this.api.cash())); } catch (e) { this.toast.error(errorMessage(e)); }
  }

  startAdd() {
    this.f = { direction: 'in', date: today(), amount: null, category: this.account() === 'capital' ? 'Equity/Commodity' : 'LenDen', kind: 'Deposit', notes: '' };
    this.error.set(null);
    this.editing.set({});
  }
  startEdit(c: CashMovement) {
    this.f = { ...c };
    this.error.set(null);
    this.editing.set(c);
  }
  async save() {
    const body = { ...this.f, account: this.account() };
    if (this.account() === 'p2p_escrow') body.kind = body.direction === 'in' ? 'Deposit' : 'Withdrawal';
    try {
      const e = this.editing()!;
      if (e.id) await firstValueFrom(this.api.updateCash(e.id, body));
      else await firstValueFrom(this.api.addCash(body));
      this.toast.ok('Saved');
      this.editing.set(null);
      await this.store.changed();
    } catch (err) { this.error.set(errorMessage(err)); }
  }
  async remove(c: CashMovement) {
    const linked = c.transaction_id ? ' It was created from a transaction; the transaction itself stays.' : '';
    if (!(await this.confirm.ask('Delete entry?', `${c.kind} of ₹${c.amount.toLocaleString('en-IN')} on ${c.date}.${linked}`, 'Delete'))) return;
    try { await firstValueFrom(this.api.deleteCash(c.id)); this.toast.ok('Deleted'); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
