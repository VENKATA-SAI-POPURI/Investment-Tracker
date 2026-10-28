import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Insight, Performance, SEGMENT_COLOR } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';

const HOLDING_ROUTE: Record<string, string> = {
  'Equity (India)': '/holdings/equity', 'Equity (USA)': '/holdings/equity', 'Mutual Funds': '/holdings/mutual_fund',
  'Commodity': '/holdings/commodity', 'P2P': '/p2p', 'Fixed Deposits': '/fixed-deposits',
};
const SEV_ICON: Record<string, string> = { critical: 'alert', warning: 'alert', info: 'info', positive: 'checkCircle' };

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [RouterLink, IconComponent, LineChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview.component.html',
  styles: [`
    .main-grid { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr); gap: 20px; }
    @media (max-width: 1000px) { .main-grid { grid-template-columns: minmax(0, 1fr); } }
    .alloc-row { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 11px 0; border-bottom: 1px solid var(--border); cursor: pointer; }
    .alloc-row:last-child { border-bottom: 0; }
    .alloc-row:hover .name { text-decoration: underline; }
    .alloc-row .name { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
    .alloc-row .pct { font-size: 13.5px; font-variant-numeric: tabular-nums; text-align: right; }
    .alloc-row .pct small { color: var(--muted); font-size: 12px; margin-left: 4px; }
    .meter { grid-column: span 2; position: relative; height: 8px; background: #eef1f8; border-radius: 999px; }
    .meter > span { position: absolute; left: 0; top: 0; height: 8px; border-radius: 999px; }
    .meter > i { position: absolute; top: -3px; width: 3px; height: 14px; background: var(--text); border-radius: 2px; box-shadow: 0 0 0 2px var(--surface); }
    .alert-row { display: flex; gap: 14px; align-items: center; padding: 13px 0; border-bottom: 1px solid var(--border); color: var(--text); text-decoration: none; }
    .alert-row:last-child { border-bottom: 0; }
    .alert-row:hover { text-decoration: none; }
    .alert-row:hover .t { text-decoration: underline; }
    .alert-row .ic { flex: none; width: 32px; height: 32px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; }
    .alert-row .ic.warning, .alert-row .ic.critical { background: var(--warn-soft); color: var(--warn); }
    .alert-row .ic.info { background: var(--accent-soft); color: var(--accent); }
    .alert-row .t { font-weight: 500; font-size: 13.5px; }
    .alert-row .d { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
    .alert-row .go { margin-left: auto; color: var(--muted); flex: none; }
  `],
})
export class OverviewComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private router = inject(Router);

  ranges = ['1M', '6M', '1Y', 'ALL'];
  range = signal('1Y');
  perf = signal<Performance | null>(null);
  perfLoading = signal(false);
  perfError = signal<string | null>(null);
  insights = signal<Insight[]>([]);
  sevIcon = SEV_ICON;
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);

  p = computed(() => this.store.portfolio());
  t = computed(() => this.p()?.totals);
  isEmpty = computed(() => !!this.p() && this.p()!.positions.length === 0);
  allocation = computed(() => (this.p()?.segments ?? []).filter(s => s.value > 0 || s.target)
    .map(s => ({ ...s, color: SEGMENT_COLOR[s.segment] ?? 'var(--s7)' })));
  greeting = computed(() => {
    const h = new Date().getHours();
    const name = (this.auth.viewAs()?.name || this.auth.user()?.name || '').split(' ')[0];
    return `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}${name ? ', ' + name : ''}`;
  });

  labels = computed(() => this.perf()?.series.map(p => p.date) ?? []);
  series = computed<LineSeries[]>(() => {
    const s = this.perf()?.series ?? [];
    return [
      { key: 'value', label: 'Value', color: 'var(--s1)', values: s.map(p => p.value), area: true },
      { key: 'net', label: 'Invested', color: 'var(--muted)', values: s.map(p => p.net_invested), muted: true },
    ];
  });

  constructor() {
    effect(() => {
      const r = this.range();
      const v = this.store.version();
      if (this.store.portfolio()) queueMicrotask(() => this.loadPerf(r, v));
    });
    effect(() => {
      const v = this.store.version();
      if (this.store.portfolio()) queueMicrotask(() => this.loadInsights(v));
    });
  }

  private perfKey = '';
  async loadPerf(range: string, version: number) {
    const key = `${range}|${version}`;
    if (key === this.perfKey) return;
    this.perfKey = key;
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

  private insightsVersion = -1;
  async loadInsights(version: number) {
    if (this.insightsVersion === version) return;
    this.insightsVersion = version;
    try {
      const r = await firstValueFrom(this.api.insights(false));
      this.insights.set(r.insights.filter(i => i.severity !== 'positive').slice(0, 3));
    } catch { /* optional on the home screen */ }
  }

  open(seg: string) { this.router.navigate([HOLDING_ROUTE[seg] ?? '/']); }
  link(i: Insight) { return (i.link ?? '/insights').split('#')[0]; }
  frag(i: Insight) { return (i.link ?? '').split('#')[1] || undefined; }
}
