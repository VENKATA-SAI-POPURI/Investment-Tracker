import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { PortfolioRisk } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../../shared/icon.component';

/** Value at risk, beta, Sortino, risk contribution and a correlation heatmap of the largest holdings. */
@Component({
  selector: 'app-risk',
  standalone: true,
  imports: [RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
    @if (r(); as r) {
      @if (r.var_95) {
        <section class="kpis">
          <div class="kpi hero"><span class="label">A bad day (1 in 20)</span><span class="value">−{{ r.var_95.day | inrc }}</span>
            <span class="meta">{{ r.var_95.day_pct }}% of {{ r.total | inrc }} · a bad month −{{ r.var_95.month | inrc }} ({{ r.var_95.month_pct }}%)</span></div>
          <div class="kpi"><span class="chip blue sm"><app-icon name="scale" [size]="15" /></span><span class="label">Beta to {{ r.benchmark }}</span><span class="value">{{ r.beta ?? '—' }}</span>
            <span class="meta">correlation {{ r.correlation_index ?? '—' }} · {{ r.exposed_pct | pct: 0 : false }} market-priced</span></div>
          <div class="kpi"><span class="chip amber sm"><app-icon name="chart" [size]="15" /></span><span class="label">Volatility</span><span class="value">{{ r.volatility_pct | pct: 1 : false }}</span>
            <span class="meta">downside {{ r.downside_deviation_pct | pct: 1 : false }} · Sharpe {{ r.sharpe ?? '—' }} · Sortino {{ r.sortino ?? '—' }}</span></div>
          <div class="kpi"><span class="chip green sm"><app-icon name="layers" [size]="15" /></span><span class="label">Diversification ratio</span><span class="value">{{ r.diversification_ratio ?? '—' }}</span>
            <span class="meta">1.0 = no benefit from mixing · higher is better</span></div>
        </section>
        <div class="grid duo">
          <div class="card flush">
            <div class="card-head"><div><h2>Where the risk comes from</h2><span class="hint">share of day-to-day swings each holding causes, past {{ r.days }} trading days</span></div></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Holding</th><th class="num">Weight</th><th class="num">Volatility</th><th class="num hide-sm">Beta</th><th class="num">Risk share</th></tr></thead>
                <tbody>
                  @for (h of r.holdings; track h.id) {
                    <tr><td class="name-cell"><a [routerLink]="['/holding', h.id]">{{ h.name }}</a><div class="sub">{{ h.segment }}</div></td>
                      <td class="num">{{ h.weight_pct | pct: 1 : false }}</td><td class="num">{{ h.volatility_pct | pct: 1 : false }}</td><td class="num hide-sm">{{ h.beta ?? '—' }}</td>
                      <td class="num"><div class="row" style="justify-content:flex-end;gap:8px"><span class="progress" style="width:60px"><span [style.width.%]="h.risk_contribution_pct ?? 0" [style.background]="(h.risk_contribution_pct ?? 0) > h.weight_pct * 1.3 ? 'var(--s8)' : 'var(--s1)'"></span></span>{{ h.risk_contribution_pct | pct: 0 : false }}</div></td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
          <div class="stack">
            <div class="card">
              <div class="card-head"><h2>Read-outs</h2></div>
              @for (n of r.notes; track n) { <p class="small" style="margin:0 0 8px">{{ n }}</p> }
              <dl class="kv" style="margin-top:8px">
                <dt>Parametric 1-day VaR</dt><dd>{{ r.var_95.parametric_day_pct }}%</dd>
                <dt>Expected shortfall (tail average)</dt><dd>{{ r.var_95.expected_shortfall_day_pct }}%</dd>
                @if (r.correlation.highest) { <dt>Most alike</dt><dd class="small" style="white-space:normal">{{ r.correlation.highest.pair[0] }} & {{ r.correlation.highest.pair[1] }} ({{ r.correlation.highest.value }})</dd> }
                @if (r.correlation.lowest) { <dt>Least alike</dt><dd class="small" style="white-space:normal">{{ r.correlation.lowest.pair[0] }} & {{ r.correlation.lowest.pair[1] }} ({{ r.correlation.lowest.value }})</dd> }
              </dl>
            </div>
          </div>
        </div>
        @if (r.correlation.labels.length > 1) {
          <div class="card">
            <div class="card-head"><div><h2>How your holdings move together</h2><span class="hint">correlation of daily returns · 1 = in lockstep, 0 = unrelated, negative = opposite</span></div></div>
            <div class="table-wrap">
              <table class="heat">
                <thead><tr><th></th>@for (l of r.correlation.labels; track $index) { <th><span class="rot">{{ short(l) }}</span></th> }</tr></thead>
                <tbody>
                  @for (row of r.correlation.matrix; track $index; let i = $index) {
                    <tr><td class="lbl">{{ short(r.correlation.labels[i]) }}</td>
                      @for (v of row; track $index; let j = $index) { <td [style.background]="bg(v, i === j)" [title]="r.correlation.labels[i] + ' × ' + r.correlation.labels[j] + ': ' + (v ?? '—')">{{ v === null ? '' : i === j ? '' : v.toFixed(2) }}</td> }</tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }
      } @else {
        <div class="card"><div class="empty"><app-icon name="scale" [size]="28" /><h3>Not enough price history yet</h3>
          <p>{{ r.notes[0] }} Market-priced holdings with a ticker build up history as prices refresh.</p></div></div>
      }
    } @else if (!error()) { <div class="card"><div class="skeleton" style="height:300px"></div></div> }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; }
    .stack { display: flex; flex-direction: column; gap: 20px; }
    .heat { border-collapse: separate; border-spacing: 3px; font-size: 12px; }
    .heat th { color: var(--muted); font-weight: 500; vertical-align: bottom; padding: 0 2px 4px; height: 90px; }
    .heat .rot { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; max-height: 86px; overflow: hidden; text-overflow: ellipsis; }
    .heat td { text-align: center; min-width: 46px; height: 34px; border-radius: 4px; font-variant-numeric: tabular-nums; color: var(--text); }
    .heat td.lbl { text-align: right; color: var(--muted); padding-right: 8px; white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis; background: none; }
    @media (max-width: 900px) { .duo { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class RiskComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  r = signal<PortfolioRisk | null>(null);
  error = signal<string | null>(null);
  short = (s: string) => s.length > 18 ? s.slice(0, 17) + '…' : s;
  bg(v: number | null, diag: boolean) {
    if (diag) return 'var(--surface-2)';
    if (v === null) return 'transparent';
    const k = Math.min(Math.abs(v), 1) * 75;
    return `color-mix(in srgb, ${v >= 0 ? 'var(--s8)' : 'var(--s1)'} ${k.toFixed(0)}%, var(--surface-2))`;
  }
  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }
  async load() {
    try { this.r.set(await firstValueFrom(this.api.risk())); this.error.set(null); }
    catch (e) { this.error.set(errorMessage(e)); }
  }
}
