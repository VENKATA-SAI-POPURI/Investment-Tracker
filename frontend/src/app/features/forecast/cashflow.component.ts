import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { CashFlow } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { Bar, BarChartComponent } from '../../shared/charts/bar-chart.component';
import { IconComponent } from '../../shared/icon.component';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Expected money in and out over the coming months, from patterns already in the ledger. */
@Component({
  selector: 'app-cashflow',
  standalone: true,
  imports: [RouterLink, IconComponent, BarChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar"><div class="seg">@for (m of [6, 12, 24]; track m) { <button [class.on]="months() === m" (click)="months.set(m)">{{ m }} months</button> }</div></div>
    @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
    @if (cf(); as cf) {
      <section class="kpis" [class.loading-fade]="loading()">
        <div class="kpi"><span class="chip green sm"><app-icon name="coins" [size]="15" /></span><span class="label">Passive income due</span><span class="value pos">{{ cf.totals.dividends + cf.totals.interest | inrc }}</span>
          <span class="meta">{{ cf.totals.dividends | inrc }} dividends · {{ cf.totals.interest | inrc }} interest</span></div>
        <div class="kpi"><span class="chip blue sm"><app-icon name="bank" [size]="15" /></span><span class="label">Principal coming back</span><span class="value">{{ cf.totals.principal_back | inrc }}</span><span class="meta">FD maturities and loan repayments</span></div>
        <div class="kpi"><span class="chip violet sm"><app-icon name="refresh" [size]="15" /></span><span class="label">Going out</span><span class="value">{{ cf.totals.outflow | inrc }}</span>
          <span class="meta">{{ cf.totals.sip_out | inrc }} SIPs · {{ cf.totals.contributions | inrc }} EPF</span></div>
        <div class="kpi"><span class="chip amber sm"><app-icon name="shield" [size]="15" /></span><span class="label">EPF interest</span><span class="value">{{ cf.totals.epf_interest | inrc }}</span><span class="meta">credited for the financial year, stays invested</span></div>
      </section>
      <div class="grid duo" [class.loading-fade]="loading()">
        <div class="card">
          <div class="card-head"><div><h2>Money in, month by month</h2><span class="hint">dividends + interest + principal back · hover for the split</span></div></div>
          <app-bar-chart [bars]="bars()" [height]="240" [yFormat]="inrc" [tipFormat]="inrFull" ariaLabel="Expected inflows per month" />
          <div class="table-wrap" style="margin-top:14px">
            <table class="table small-table">
              <thead><tr><th>Month</th><th class="num">Dividends</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">SIPs out</th><th class="num">Net</th></tr></thead>
              <tbody>
                @for (m of cf.months; track m.month) {
                  <tr><td>{{ label(m.month) }}</td><td class="num">{{ m.dividends ? (m.dividends | inr) : '' }}</td><td class="num">{{ m.interest ? (m.interest | inr) : '' }}</td>
                    <td class="num">{{ m.principal_back ? (m.principal_back | inr) : '' }}</td><td class="num">{{ m.outflow ? (m.outflow | inr) : '' }}</td>
                    <td class="num" [class]="m.net | sign">{{ m.net | inr: 0 : true }}</td></tr>
                }
              </tbody>
              <tfoot><tr><td>Total</td><td class="num">{{ cf.totals.dividends | inr }}</td><td class="num">{{ cf.totals.interest | inr }}</td><td class="num">{{ cf.totals.principal_back | inr }}</td>
                <td class="num">{{ cf.totals.outflow | inr }}</td><td class="num" [class]="cf.totals.net | sign">{{ cf.totals.net | inr: 0 : true }}</td></tr></tfoot>
            </table>
          </div>
        </div>
        <div class="stack">
          <div class="card flush">
            <div class="card-head"><h2>Dates to know</h2><span class="hint">maturities and loan closings</span></div>
            <table class="table">
              <tbody>
                @for (e of cf.events; track e.date + e.name) {
                  <tr><td>@if (e.instrument_id) { <a [routerLink]="['/holding', e.instrument_id]">{{ e.name }}</a> } @else { <a routerLink="/p2p">{{ e.name }}</a> }<div class="sub">{{ e.note }}</div></td>
                    <td class="num"><span class="badge" [class.warn]="e.kind === 'p2p_overdue'">{{ e.date | dt }}</span><div class="sub">{{ e.amount | inr }}</div></td></tr>
                } @empty { <tr><td class="muted small">Nothing matures in this window.</td></tr> }
              </tbody>
            </table>
          </div>
          <div class="card">
            <div class="card-head"><h2>What this means</h2></div>
            @for (n of cf.notes; track n) { <p class="small" style="margin:0 0 8px">{{ n }}</p> } @empty { <p class="small muted">Add dividends, FDs, loans or SIP plans and the calendar fills in.</p> }
            <p class="small muted" style="margin-top:10px">{{ cf.note }}</p>
          </div>
        </div>
      </div>
    } @else if (!error()) { <div class="card"><div class="skeleton" style="height:300px"></div></div> }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; }
    .toolbar { display: flex; justify-content: flex-end; }
    .stack { display: flex; flex-direction: column; gap: 20px; }
    .small-table th, .small-table td { padding: 8px 10px; font-size: 12.5px; }
    .small-table th:first-child, .small-table td:first-child { padding-left: 4px; } .small-table th:last-child, .small-table td:last-child { padding-right: 4px; }
    @media (max-width: 900px) { .duo { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class CashflowComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  months = signal(12);
  cf = signal<CashFlow | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);
  label = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(2, 4)}`;
  bars = computed<Bar[]>(() => (this.cf()?.months ?? []).map(m => ({ label: this.label(m.month), value: m.inflow,
    title: `${this.label(m.month)}: ${inr(m.dividends)} dividends · ${inr(m.interest)} interest · ${inr(m.principal_back)} principal` })));

  constructor() {
    effect(() => { const m = this.months(); this.store.version(); queueMicrotask(() => this.load(m)); });
  }
  async load(months: number) {
    this.loading.set(true);
    try { this.cf.set(await firstValueFrom(this.api.cashflow(months))); this.error.set(null); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.loading.set(false); }
  }
}
