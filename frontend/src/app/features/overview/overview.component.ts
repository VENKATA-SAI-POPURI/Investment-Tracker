import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact, pct } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Insight, Performance, SEGMENT_COLOR } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { DonutChartComponent, Slice } from '../../shared/charts/donut-chart.component';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { InsightCardComponent } from '../insights/insight-card.component';

const HOLDING_ROUTE: Record<string, string> = {
  'Equity (India)': '/holdings/equity', 'Equity (USA)': '/holdings/equity', 'Mutual Funds': '/holdings/mutual_fund',
  'Commodity': '/holdings/commodity', 'P2P': '/p2p', 'Fixed Deposits': '/fixed-deposits',
};

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [RouterLink, IconComponent, LineChartComponent, DonutChartComponent, InsightCardComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview.component.html',
  styles: [`
    .hero { display: grid; grid-template-columns: minmax(0, 1.3fr) repeat(3, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
    .hero .card { display: flex; flex-direction: column; justify-content: center; }
    @media (max-width: 1100px) { .hero { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero .main { grid-column: span 2; } }
    .alloc { display: flex; gap: 20px; align-items: center; }
    @media (max-width: 560px) { .alloc { flex-direction: column; } }
    .drift { position: relative; width: 70px; height: 6px; background: var(--surface-2); border-radius: 3px; }
    .drift > span { position: absolute; top: 0; height: 6px; border-radius: 3px; }
    .drift::after { content: ''; position: absolute; left: 50%; top: -3px; width: 1px; height: 12px; background: var(--axis); }
    .mover { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .mover:last-child { border-bottom: 0; }
  `],
})
export class OverviewComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private router = inject(Router);

  ranges = ['1M', '3M', '6M', '1Y', 'ALL'];
  range = signal('1Y');
  perf = signal<Performance | null>(null);
  perfLoading = signal(false);
  perfError = signal<string | null>(null);
  insights = signal<Insight[]>([]);

  p = computed(() => this.store.portfolio());
  t = computed(() => this.p()?.totals);
  segments = computed(() => (this.p()?.segments ?? []).filter(s => s.value > 0 || s.target));
  slices = computed<Slice[]>(() => this.segments().filter(s => s.value > 0).map(s => ({ label: s.segment, value: s.value, color: SEGMENT_COLOR[s.segment] ?? 'var(--s7)' })));
  colorOf = (seg: string) => SEGMENT_COLOR[seg] ?? 'var(--s7)';
  inrc = inrCompact;
  inrFn = inr;

  chartLabels = computed(() => this.perf()?.series.map(p => p.date) ?? []);
  chartSeries = computed<LineSeries[]>(() => {
    const s = this.perf()?.series ?? [];
    return [
      { key: 'value', label: 'Portfolio value', color: 'var(--s1)', values: s.map(p => p.value), area: true },
      { key: 'net', label: 'Net invested', color: 'var(--muted)', values: s.map(p => p.net_invested), muted: true },
    ];
  });

  movers = computed(() => this.store.openPositions().filter(p => p.day_change && p.has_price)
    .sort((a, b) => Math.abs(b.day_change) - Math.abs(a.day_change)).slice(0, 5));
  ranked = computed(() => this.store.openPositions().filter(p => p.unrealized_pct !== null && p.has_price)
    .sort((a, b) => (b.unrealized_pct ?? 0) - (a.unrealized_pct ?? 0)));
  best = computed(() => this.ranked().slice(0, 3));
  worst = computed(() => this.ranked().slice(-3).reverse().filter(p => !this.best().includes(p)));
  isEmpty = computed(() => !!this.p() && this.p()!.positions.length === 0);

  constructor() {
    effect(() => {
      this.store.version();
      const r = this.range();
      if (this.store.portfolio()) queueMicrotask(() => this.loadPerf(r));
    });
    effect(() => {
      this.store.version();
      if (this.store.portfolio()) queueMicrotask(() => this.loadInsights());
    });
  }

  private loadedKey = '';
  async loadPerf(range: string) {
    const key = `${range}|${this.store.version()}`;
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    this.perfLoading.set(true);
    try {
      this.perf.set(await firstValueFrom(this.api.performance(range)));
      this.perfError.set(null);
    } catch (e) {
      this.perfError.set(errorMessage(e));
    } finally {
      this.perfLoading.set(false);
    }
  }

  private insightsKey = -1;
  async loadInsights() {
    if (this.insightsKey === this.store.version()) return;
    this.insightsKey = this.store.version();
    try {
      const r = await firstValueFrom(this.api.insights(false));
      this.insights.set(r.insights.filter(i => i.severity !== 'positive').slice(0, 4));
    } catch { /* insights are optional on the dashboard */ }
  }

  goSegment(seg: string) { this.router.navigate([HOLDING_ROUTE[seg] ?? '/']); }
  driftStyle(drift: number | null) {
    if (drift === null) return {};
    const w = Math.min(Math.abs(drift) / 10, 1) * 50;
    return drift >= 0 ? { left: '50%', width: w + '%', background: 'var(--s2)' } : { right: '50%', width: w + '%', background: 'var(--s1)' };
  }
  fmtPct = pct;
}
