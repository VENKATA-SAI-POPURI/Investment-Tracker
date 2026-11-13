import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES, inr, usd } from '../../core/format';
import { Outlook } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../../shared/icon.component';

/** Trend, momentum, volatility and a statistical 3M/6M/1Y range for one market-priced holding. */
@Component({
  selector: 'app-outlook-card',
  standalone: true,
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (o(); as o) {
      @if (o.available) {
        <div class="card">
          <div class="card-head">
            <div class="row" style="gap:10px"><span class="chip violet sm"><app-icon name="sparkle" [size]="15" /></span><div><h2>Outlook</h2><span class="hint">as of {{ o.as_of | dt }} · vs {{ o.benchmark }}</span></div></div>
            <span class="badge" [class.good]="o.trend!.key === 'up'" [class.bad]="o.trend!.key === 'down'"><app-icon [name]="o.trend!.key === 'up' ? 'arrowUp' : o.trend!.key === 'down' ? 'arrowDown' : 'more'" [size]="13" /> {{ o.trend!.label }}</span>
          </div>
          <div class="facts">
            <div class="fact"><span class="label">Momentum</span>
              <span class="moms">@for (k of horizons; track k) { <span><small>{{ k }}</small><b [class]="o.momentum![k] | sign">{{ o.momentum![k] | pct: 0 }}</b></span> }</span></div>
            <div class="fact"><span class="label">RSI (14)</span><b>{{ o.rsi ?? '—' }}</b><small class="muted">{{ rsiNote(o.rsi) }}</small></div>
            <div class="fact"><span class="label">Volatility</span><b>{{ o.volatility!.annual_pct | pct: 0 : false }}</b><small class="muted">a year · {{ o.volatility!.regime ?? 'normal' }} this month</small></div>
            <div class="fact"><span class="label">Beta</span><b>{{ o.beta ?? '—' }}</b><small class="muted">correlation {{ o.correlation ?? '—' }}</small></div>
            <div class="fact"><span class="label">52-week range</span><b>{{ fmt(o.range_52w!.low) }} – {{ fmt(o.range_52w!.high) }}</b>
              <span class="rb"><i [style.left.%]="o.range_52w!.position_pct"></i></span><small class="muted">{{ o.range_52w!.from_high_pct | pct: 0 }} from the high</small></div>
            <div class="fact"><span class="label">Averages</span><b>{{ o.trend!.above_50 ? 'above' : 'below' }} 50d · {{ o.trend!.above_200 ? 'above' : 'below' }} 200d</b><small class="muted">50d {{ fmt(o.trend!.sma50) }} · 200d {{ fmt(o.trend!.sma200) }}</small></div>
          </div>
          <div class="cone">
            <div class="cone-head"><b>Where the price could be</b><small class="muted">8 in 10 outcomes, if the next year looks like the past one · drift {{ o.assumptions!.drift_pct }}%, volatility {{ o.assumptions!.volatility_pct }}%</small></div>
            <table class="table small-table">
              <thead><tr><th></th><th class="num">Low (10%)</th><th class="num">Middle</th><th class="num">High (90%)</th>@if (o.holding) { <th class="num hide-sm">Your {{ o.holding.quantity | qty }} units</th> }</tr></thead>
              <tbody>
                @for (k of horizons; track k) {
                  @let c = o.cone![k];
                  <tr><td>In {{ k === '1Y' ? 'a year' : k === '6M' ? 'six months' : 'three months' }}</td><td class="num neg">{{ fmt(c.p10) }}</td><td class="num"><b>{{ fmt(c.p50) }}</b></td><td class="num pos">{{ fmt(c.p90) }}</td>
                    @if (o.holding) { <td class="num hide-sm">{{ o.holding.cone[k].p10 | inrc }} – {{ o.holding.cone[k].p90 | inrc }}</td> }</tr>
                }
              </tbody>
            </table>
          </div>
          @if (o.notes?.length) { <ul class="notes">@for (n of o.notes; track n) { <li>{{ n }}</li> }</ul> }
          <p class="small muted" style="margin:10px 0 0">{{ o.disclaimer }}</p>
        </div>
      }
    }`,
  styles: [`
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px 18px; margin-bottom: 16px; }
    .fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; } .fact .label { font-size: 12px; color: var(--muted); } .fact b { font-size: 14.5px; } .fact small { font-size: 11.5px; }
    .moms { display: flex; gap: 12px; } .moms span { display: flex; flex-direction: column; } .moms small { font-size: 11px; color: var(--muted); } .moms b { font-size: 13.5px; }
    .rb { position: relative; display: inline-block; width: 100%; max-width: 140px; height: 6px; border-radius: 3px; margin: 4px 0 2px; background: linear-gradient(90deg, var(--neg-soft), var(--surface-2), var(--pos-soft)); }
    .rb i { position: absolute; top: -3px; width: 4px; height: 12px; margin-left: -2px; border-radius: 2px; background: var(--ink); }
    .cone-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; } .cone-head small { font-size: 12px; }
    .small-table th, .small-table td { padding: 8px 10px; font-size: 12.5px; } .small-table th:first-child, .small-table td:first-child { padding-left: 0; } .small-table th:last-child, .small-table td:last-child { padding-right: 0; }
    .notes { margin: 14px 0 0; padding-left: 18px; font-size: 13px; color: var(--text-2); } .notes li { margin-bottom: 4px; }
  `],
})
export class OutlookCardComponent {
  id = input.required<number>();
  private api = inject(ApiService);
  private store = inject(StoreService);
  o = signal<Outlook | null>(null);
  horizons = ['3M', '6M', '1Y'] as const;
  usd = computed(() => this.o()?.currency === 'USD');
  fmt = (v: number | null | undefined) => v === null || v === undefined ? '—' : this.usd() ? usd(v) : inr(v, v < 100 ? 2 : 0);
  rsiNote = (r: number | null | undefined) => r === null || r === undefined ? '' : r >= 70 ? 'overbought' : r <= 30 ? 'oversold' : 'neutral';

  constructor() {
    effect(() => { const id = this.id(); this.store.version(); queueMicrotask(() => this.load(id)); });
  }
  async load(id: number) {
    try { this.o.set(await firstValueFrom(this.api.outlook(id))); } catch { this.o.set(null); }
  }
}
