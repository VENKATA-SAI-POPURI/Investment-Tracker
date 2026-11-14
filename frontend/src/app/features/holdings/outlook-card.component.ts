import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES, inr, usd } from '../../core/format';
import { MarketOverview, Outlook } from '../../core/models';
import { readSnapshot, snapshotKey } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../../shared/icon.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { LabelledSignal, SIGNAL_HONESTY, SignalChipsComponent } from '../markets/market-parts';
import { CONE_LABEL_FALLBACK } from './holding-rules';

/**
 * The outlook as wave 6 sends it (K16): `signals` from the one vocabulary, read from the holding's own closes, and a
 * `trend` reconciled with them. Typed locally so this card compiles before W6-F2's models.ts lands; both are optional.
 */
export type OutlookWithSignals = Outlook & {
  signals?: LabelledSignal[] | null;
  trend?: NonNullable<Outlook['trend']> & { reconciled?: boolean };
};

/** The Trend badge's tooltip. When the trend was reconciled (K16), the averages and the past month point different ways. */
export function outlookTrendTitle(t: OutlookWithSignals['trend'] | null | undefined): string {
  if (!t) return '';
  return t.reconciled ? 'Long averages and the past month disagree' : 'Price against its 50- and 200-day averages';
}

/**
 * Signals for one market-priced holding (SPEC §5.5 T2, AMENDMENTS J14, K18).
 * Collapsed, it is one row: trend, 3M momentum, RSI, this month's volatility regime and the Markets signal chips.
 * The chips read the outlook's own `signals` when it carries them (K16: the same rules as Markets, on the same closes
 * as the trend, so "Uptrend" never sits beside "Momentum ↓"). An older payload without them falls back to the Markets
 * page's snapshot (`snapshotKey('markets', scope)`, its `holdings[]` row for this id); this card never fetches
 * `/markets`, so with neither there are no chips.
 * "Show all statistics" opens the full card: every momentum horizon, beta, the 52-week range, averages, and the
 * statistical cone labelled with `assumptions.cone_label` (H16), never a price prediction.
 */
@Component({
  selector: 'app-outlook-card',
  standalone: true,
  imports: [IconComponent, EstTagComponent, SignalChipsComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state() === 'loading') {
      <div class="card" aria-label="Loading signals"><div class="skeleton" style="height:18px;width:30%"></div><div class="skeleton" style="height:44px;margin-top:12px"></div></div>
    } @else if (state() === 'error') {
      <div class="card">
        <div class="card-head"><h2>Signals</h2></div>
        <div class="row wrap sig-msg"><app-icon name="alert" [size]="16" /><span>Couldn't load the price signals.</span>
          <button type="button" class="btn ghost sm" (click)="load(id())"><app-icon name="refresh" [size]="14" /> Try again</button></div>
      </div>
    } @else {
      @if (o(); as o) { @if (o.available) {
        <section class="card" aria-label="Signals">
          <div class="card-head">
            <div class="row" style="gap:10px"><span class="chip violet sm"><app-icon name="sparkle" [size]="15" /></span>
              <div><h2>Signals</h2><span class="hint">as of {{ o.as_of | dt }} · vs {{ o.benchmark }} · {{ honesty }}</span></div></div>
          </div>

          <!-- One row: what the price is doing now. Each fact carries a word, never colour alone. -->
          <div class="sig-row">
            <div class="sig"><span class="label">Trend</span>
              <span class="badge" [class.good]="o.trend!.key === 'up'" [class.bad]="o.trend!.key === 'down'" [title]="trendTitle()">
                <app-icon [name]="o.trend!.key === 'up' ? 'arrowUp' : o.trend!.key === 'down' ? 'arrowDown' : 'more'" [size]="13" /> {{ o.trend!.label }}</span></div>
            <div class="sig"><span class="label">3M momentum</span><b [class]="o.momentum?.['3M'] | sign">{{ o.momentum?.['3M'] | pct: 0 }}</b></div>
            <div class="sig"><span class="label">RSI (14)</span><b>{{ o.rsi ?? '—' }}@if (rsiNote(o.rsi); as n) { <small class="muted"> {{ n }}</small> }</b></div>
            <div class="sig"><span class="label">Volatility</span><b>{{ o.volatility?.regime ?? 'normal' }}<small class="muted"> this month</small></b></div>
            @if (chips(); as c) {
              <div class="sig"><span class="label">Markets</span><app-signal-chips [signals]="c" empty="No signal" /></div>
            }
          </div>

          <button type="button" class="btn ghost sm toggle" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" [attr.aria-controls]="'stats-' + id()">
            <app-icon [name]="expanded() ? 'arrowUp' : 'chevronDown'" [size]="14" /> {{ expanded() ? 'Hide statistics' : 'Show all statistics' }}</button>

          @if (expanded()) {
            <div class="all" [id]="'stats-' + id()">
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
              @if (o.cone && o.assumptions; as a) {
                <div class="cone">
                  <!-- The Middle column grows at the typical (median) return, so the head quotes that; the Book mean shows only as "avg" (§1.9). -->
                  <div class="cone-head"><b>Where the price could be</b><small class="muted">8 in 10 outcomes · {{ coneLabel() }} ·
                    @if (a.typical_pct !== undefined && a.typical_pct !== null) { typical {{ a.typical_pct }}% a year } @else { avg {{ a.drift_pct }}% a year }
                    ± {{ a.volatility_pct }}% <app-est [basis]="a.basis ?? null" /></small></div>
                  <div class="table-wrap">
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
                </div>
              }
              @if (o.notes?.length) { <ul class="notes">@for (n of o.notes; track n) { <li>{{ n }}</li> }</ul> }
              @if (o.disclaimer) { <p class="small muted" style="margin:10px 0 0">{{ o.disclaimer }}</p> }
            </div>
          }
        </section>
      } @else {
        <div class="card">
          <div class="card-head"><h2>Signals</h2></div>
          <p class="small muted sig-msg">{{ o.reason || 'Not enough price history yet for signals.' }}</p>
        </div>
      } }
    }`,
  styles: [`
    :host { display: block; }
    .sig-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px 26px; }
    .sig { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .sig .label { font-size: 12px; color: var(--muted); }
    .sig b { font-size: 14.5px; font-weight: 600; } .sig b small { font-size: 11.5px; font-weight: 400; }
    .toggle { margin-top: 12px; padding-left: 0; }
    .sig-msg { margin: 0; gap: 8px; color: var(--text-2); font-size: 13.5px; }
    .all { margin-top: 12px; padding-top: 14px; border-top: 1px solid var(--border); }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px 18px; margin-bottom: 16px; }
    .fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; } .fact .label { font-size: 12px; color: var(--muted); } .fact b { font-size: 14.5px; } .fact small { font-size: 11.5px; }
    .moms { display: flex; gap: 12px; } .moms span { display: flex; flex-direction: column; } .moms small { font-size: 11px; color: var(--muted); } .moms b { font-size: 13.5px; }
    .rb { position: relative; display: inline-block; width: 100%; max-width: 140px; height: 6px; border-radius: 3px; margin: 4px 0 2px; background: linear-gradient(90deg, var(--neg-soft), var(--surface-2), var(--pos-soft)); }
    .rb i { position: absolute; top: -3px; width: 4px; height: 12px; margin-left: -2px; border-radius: 2px; background: var(--ink); }
    .cone-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; } .cone-head small { font-size: 12px; }
    .small-table th, .small-table td { padding: 8px 10px; font-size: 12.5px; } .small-table th:first-child, .small-table td:first-child { padding-left: 0; } .small-table th:last-child, .small-table td:last-child { padding-right: 0; }
    .notes { margin: 14px 0 0; padding-left: 18px; font-size: 13px; color: var(--text-2); } .notes li { margin-bottom: 4px; }
    @media (max-width: 760px) { .sig-row { gap: 12px 18px; } .sig { flex: 1 1 40%; } }
  `],
})
export class OutlookCardComponent {
  id = input.required<number>();
  private api = inject(ApiService);
  private store = inject(StoreService);
  o = signal<OutlookWithSignals | null>(null);
  state = signal<'loading' | 'ok' | 'error'>('loading');
  expanded = signal(false);
  horizons = ['3M', '6M', '1Y'] as const;
  readonly honesty = SIGNAL_HONESTY;
  usd = computed(() => this.o()?.currency === 'USD');
  /** H16: the cone's own label; never the market-signal wording. */
  coneLabel = computed(() => this.o()?.assumptions?.cone_label || CONE_LABEL_FALLBACK);
  /** This holding's row in the Markets snapshot (read only; the Markets page writes it). Null when Markets was never opened. */
  market = computed(() => {
    const id = this.id();
    this.store.version();
    const snap = readSnapshot<MarketOverview>(snapshotKey('markets', this.store.scopeKey()));
    const row = snap?.holdings?.find(h => h.id === id);
    return row && (row.metrics || row.signals?.length) ? row : null;
  });
  /**
   * The chips: the outlook's own `signals` when present (an empty list means "No signal"), else today's Markets row.
   * Null hides the column. Markets' row may differ by today's live tick, which the outlook does not use (K16).
   */
  chips = computed<LabelledSignal[] | null>(() => {
    const own = this.o()?.signals;
    if (own) return own;
    return this.market()?.signals ?? null;
  });
  trendTitle = computed(() => outlookTrendTitle(this.o()?.trend));
  fmt = (v: number | null | undefined) => v === null || v === undefined ? '—' : this.usd() ? usd(v) : inr(v, v < 100 ? 2 : 0);
  rsiNote = (r: number | null | undefined) => r === null || r === undefined ? '' : r >= 70 ? 'overbought' : r <= 30 ? 'oversold' : 'neutral';

  private seq = 0;
  private loadedFor: number | null = null;

  constructor() {
    effect(() => { const id = this.id(); this.store.version(); queueMicrotask(() => this.load(id)); });
  }

  async load(id: number) {
    const seq = ++this.seq;
    // Same holding after a data change: keep the card painted while it refreshes. A different holding starts over.
    if (this.loadedFor !== id || this.state() === 'error') { this.o.set(null); this.state.set('loading'); this.expanded.set(false); }
    try {
      const o = await firstValueFrom(this.api.outlook(id));
      if (seq !== this.seq) return;
      this.o.set(o);
      this.loadedFor = id;
      this.state.set('ok');
    } catch {
      if (seq !== this.seq) return;
      this.state.set('error');
    }
  }
}
