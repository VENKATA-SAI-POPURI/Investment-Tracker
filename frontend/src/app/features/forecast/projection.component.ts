import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Projection } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { LineBand, LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';

const YEARS = [5, 10, 15, 20, 25, 30];
const STEPS = [0, 5, 10, 15];

/** Monte Carlo fan chart of the portfolio with monthly SIPs: median, likely range, milestones and scenarios. */
@Component({
  selector: 'app-projection',
  standalone: true,
  imports: [DecimalPipe, FormsModule, RouterLink, IconComponent, LineChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card controls">
      <div class="ctl"><label>Horizon</label><div class="seg">@for (y of years; track y) { <button [class.on]="horizon() === y" (click)="horizon.set(y)">{{ y }}y</button> }</div></div>
      <div class="ctl"><label for="sip">Monthly SIP (₹)</label>
        <input id="sip" class="input num" type="number" min="0" step="500" [ngModel]="sip()" (ngModelChange)="sip.set($event)" />
        @if (p()?.sip_plans_total) { <span class="hint">Your SIP plans add up to {{ p()!.sip_plans_total | inr }}<button class="link" (click)="sip.set(null)">use that</button></span> }</div>
      <div class="ctl"><label>Step-up each year</label><div class="seg">@for (s of steps; track s) { <button [class.on]="step() === s" (click)="step.set(s)">{{ s }}%</button> }</div></div>
      <div class="ctl"><label for="ret">Expected return (% a year)</label>
        <input id="ret" class="input num" type="number" step="0.5" min="-10" max="30" [ngModel]="ret()" (ngModelChange)="ret.set($event)" [placeholder]="p() ? 'model: ' + p()!.assumptions.return_pct + '%' : 'model'" />
        <span class="hint">Leave blank to use the model's blend</span></div>
    </div>

    @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }

    @if (p(); as p) {
      <section class="kpis" [class.loading-fade]="loading()">
        <div class="kpi hero"><span class="label">Likely value in {{ p.years }} years</span><span class="value">{{ p.end.p50 | inrc }}</span>
          <span class="meta">median of {{ p.sims | number }} simulated paths · {{ p.end.real_p50 | inrc }} in today's money</span></div>
        <div class="kpi"><span class="chip violet sm"><app-icon name="layers" [size]="15" /></span><span class="label">Likely range</span><span class="value">{{ p.end.p10 | inrc }} – {{ p.end.p90 | inrc }}</span><span class="meta">8 in 10 paths land here</span></div>
        <div class="kpi"><span class="chip blue sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Money you'd put in</span><span class="value">{{ p.end.contributed | inrc }}</span>
          <span class="meta">{{ p.current | inrc }} today + {{ p.end.contributed - p.current | inrc }} of SIPs</span></div>
        <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Growth on top</span><span class="value" [class]="p.end.gain_p50 | sign">{{ p.end.gain_p50 | inrc: true }}</span>
          <span class="meta">{{ p.end.probability_of_loss }}% of paths end below what went in</span></div>
      </section>

      <div class="grid duo" [class.loading-fade]="loading()">
        <div class="card">
          <div class="card-head"><div><h2>How it could unfold</h2><span class="hint">Shaded: where 50% and 80% of paths fall · dashed: steady growth at {{ p.assumptions.return_pct }}%</span></div></div>
          <app-line-chart [labels]="labels()" [series]="series()" [bands]="bands()" [height]="320" [yFormat]="inrc" [tipFormat]="inrFull" [zeroBased]="true" ariaLabel="Projected portfolio value" />
        </div>
        <div class="stack">
          <div class="card flush">
            <div class="card-head"><h2>Milestones</h2><span class="hint">chance within {{ p.years }} years</span></div>
            <table class="table">
              <tbody>
                @for (m of p.milestones; track m.amount) {
                  <tr><td><b>{{ m.label }}</b><div class="sub">around {{ m.median_year }}</div></td>
                    <td class="num"><div class="row" style="justify-content:flex-end;gap:8px"><span class="progress" style="width:70px"><span [style.width.%]="m.probability"></span></span>{{ m.probability | pct: 0 : false }}</div></td></tr>
                } @empty { <tr><td class="muted small">No new round-number milestones inside this horizon.</td></tr> }
              </tbody>
            </table>
          </div>
          <div class="card">
            <div class="card-head"><h2>If returns differ</h2><span class="hint">steady growth, same SIP</span></div>
            <dl class="kv">
              <dt>Bear ({{ p.assumptions.return_pct - 4 | number: '1.0-1' }}% a year)</dt><dd>{{ p.scenarios.bear | inrc }}</dd>
              <dt>Base ({{ p.assumptions.return_pct }}%)</dt><dd><b>{{ p.scenarios.base | inrc }}</b></dd>
              <dt>Bull ({{ p.assumptions.return_pct + 4 | number: '1.0-1' }}%)</dt><dd>{{ p.scenarios.bull | inrc }}</dd>
              <dt>Stop investing today</dt><dd>{{ p.scenarios.no_more_investing | inrc }}</dd>
            </dl>
          </div>
        </div>
      </div>

      <section class="card" [class.loading-fade]="loading()">
        <div class="card-head"><div><h2>Assumptions</h2><span class="hint">{{ p.assumptions.return_pct }}% a year ± {{ p.assumptions.volatility_pct }}% · from your {{ p.assumptions.basis }} · inflation {{ p.assumptions.inflation_pct }}%</span></div>
          <a routerLink="/forecast" [queryParams]="{ tab: 'allocation' }" class="small">Change the mix in the Allocation lab →</a></div>
        <div class="mix">
          @for (m of p.assumptions.mix; track m.segment) {
            <div class="mix-row"><span class="ellipsis">{{ m.segment }}</span><div class="track"><span [style.width.%]="m.weight_pct"></span></div>
              <span class="num small">{{ m.weight_pct | pct: 0 : false }}</span><span class="num small muted">{{ m.return_pct }}% ± {{ m.volatility_pct }}%</span></div>
          }
        </div>
        @if (p.assumptions.own) { <p class="small muted" style="margin-top:12px">Your own record so far: {{ p.assumptions.own.return_pct }}% a year with {{ p.assumptions.own.volatility_pct }}% volatility; it pulls the long-run assumptions 30% of the way towards what actually happened.</p> }
      </section>
    } @else if (!error()) { <div class="card"><div class="skeleton" style="height:320px"></div></div> }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; }
    .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px 24px; }
    .ctl { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .ctl label { font-size: 12.5px; font-weight: 500; color: var(--text-2); }
    .ctl .hint { font-size: 12px; color: var(--muted); }
    .link { border: 0; background: none; color: var(--primary); cursor: pointer; font-size: 12px; padding: 0 4px; }
    .stack { display: flex; flex-direction: column; gap: 20px; }
    .mix { display: grid; gap: 8px; }
    .mix-row { display: grid; grid-template-columns: minmax(90px, 160px) 1fr 44px 90px; gap: 10px; align-items: center; font-size: 13px; }
    .track { height: 6px; background: var(--surface-hover); border-radius: 3px; overflow: hidden; }
    .track > span { display: block; height: 100%; background: var(--s1); border-radius: 3px; }
    @media (max-width: 900px) { .duo { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class ProjectionComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  years = YEARS;
  steps = STEPS;
  horizon = signal(10);
  sip = signal<number | null>(null);
  step = signal(10);
  ret = signal<number | null>(null);
  p = signal<Projection | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);

  labels = computed(() => this.p()?.path.map(x => x.date) ?? []);
  bands = computed<LineBand[]>(() => {
    const path = this.p()?.path ?? [];
    return [
      { key: 'b80', label: '80% of paths', color: 'var(--s1)', lo: path.map(x => x.p10), hi: path.map(x => x.p90), opacity: 0.12 },
      { key: 'b50', label: '50% of paths', color: 'var(--s1)', lo: path.map(x => x.p25), hi: path.map(x => x.p75), opacity: 0.2 },
    ];
  });
  series = computed<LineSeries[]>(() => {
    const path = this.p()?.path ?? [];
    return [
      { key: 'p50', label: 'Median path', color: 'var(--s1)', values: path.map(x => x.p50) },
      { key: 'exp', label: 'Steady growth', color: 'var(--s2)', values: path.map(x => x.expected), dashed: true, muted: true },
      { key: 'in', label: 'Money put in', color: 'var(--muted)', values: path.map(x => x.contributed), muted: true },
    ];
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor() {
    effect(() => {
      const key = { years: this.horizon(), sip: this.sip(), step: this.step(), return: this.ret(), v: this.store.version() };
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(key), this.p() ? 350 : 0);
    });
  }

  async load(k: { years: number; sip: number | null; step: number; return: number | null }) {
    this.loading.set(true);
    try {
      const sip = k.sip === null || (k.sip as unknown) === '' ? null : Math.max(+k.sip, 0);
      const ret = k.return === null || (k.return as unknown) === '' ? null : +k.return;
      this.p.set(await firstValueFrom(this.api.forecast({ years: k.years, sip, step: k.step, return: ret })));
      this.error.set(null);
    } catch (e) { this.error.set(errorMessage(e)); }
    finally { this.loading.set(false); }
  }
}
