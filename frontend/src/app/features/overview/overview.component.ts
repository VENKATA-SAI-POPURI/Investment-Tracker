import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact, inrWords } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Insight, Performance, Pulse, SEGMENT_COLOR, SEGMENT_META } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { DonutChartComponent, Slice } from '../../shared/charts/donut-chart.component';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { MandalaComponent } from '../../shared/motifs';
import { FestivalStripComponent, HealthCardComponent, MoneyCalendarComponent } from './pulse.components';
import { DriversComponent, MarketComponent, MilestonesComponent, RhythmComponent, TakeawaysComponent } from './story.components';

const SEV_ICON: Record<string, string> = { critical: 'alert', warning: 'alert', info: 'bulb', positive: 'checkCircle' };

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [RouterLink, IconComponent, LineChartComponent, DonutChartComponent, MandalaComponent, FestivalStripComponent, HealthCardComponent, MoneyCalendarComponent,
    TakeawaysComponent, DriversComponent, MarketComponent, RhythmComponent, MilestonesComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss',
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
  pulse = signal<Pulse | null>(null);
  story = computed(() => this.pulse()?.story ?? null);
  compare = signal(false);
  words = inrWords;
  sevIcon = SEV_ICON;
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);

  p = computed(() => this.store.portfolio());
  t = computed(() => this.p()?.totals);
  isEmpty = computed(() => !!this.p() && this.p()!.positions.length === 0);
  greeting = computed(() => {
    const name = (this.auth.viewAs()?.name || this.auth.user()?.name || '').split(' ')[0];
    return `Namaste${name ? ', ' + name : ''}`;
  });
  festival = computed(() => {
    const c = this.pulse()?.calendar;
    const f = c?.next_festival;
    return f && (f.days <= 21 || c?.theme) ? f : null;
  });
  gainPct = computed(() => {
    const t = this.t();
    return t && t.cost ? (t.total_gain / t.cost) * 100 : null;
  });

  /** One card per asset class that holds money. */
  assets = computed(() => (this.p()?.segments ?? []).filter(s => s.value > 0).map(s => ({
    ...s, ...(SEGMENT_META[s.segment] ?? { label: s.segment, icon: 'layers', route: '/' }),
    color: SEGMENT_COLOR[s.segment] ?? 'var(--s7)',
  })));
  slices = computed<Slice[]>(() => this.assets().map(a => ({ label: a.label, value: a.value, color: a.color })));
  hasTargets = computed(() => this.assets().some(a => a.target !== null));

  hasBench = computed(() => !!this.perf()?.benchmarks.some(b => b.key === 'NIFTY50'));
  labels = computed(() => this.perf()?.series.map(p => p.date) ?? []);
  series = computed<LineSeries[]>(() => {
    const s = this.perf()?.series ?? [];
    return [
      { key: 'value', label: 'Portfolio value', color: 'var(--s1)', values: s.map(p => p.value), area: true },
      { key: 'net', label: 'Money invested', color: 'var(--muted)', values: s.map(p => p.net_invested), muted: true },
      ...(this.compare() && this.hasBench()
        ? [{ key: 'NIFTY50', label: 'Same money in Nifty 50', color: 'var(--s2)', values: s.map(p => p['NIFTY50'] as number | null) }]
        : []),
    ];
  });

  /** White sparkline for the hero banner (last points of the loaded range). */
  spark = computed(() => {
    const vals = (this.perf()?.series ?? []).map(p => p.value).slice(-90);
    if (vals.length < 2) return null;
    const w = 240, h = 64, lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 4 - ((v - lo) / span) * (h - 8)] as const);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    return { line, area: `${line}L${w},${h}L0,${h}Z`, end: pts[pts.length - 1] };
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
    try {
      this.pulse.set(await firstValueFrom(this.api.pulse()));
    } catch { /* optional on the home screen */ }
  }

  go(route: string) { this.router.navigate([route]); }
  link(i: Insight) { return (i.link ?? '/insights').split('#')[0]; }
  frag(i: Insight) { return (i.link ?? '').split('#')[1] || undefined; }
}
