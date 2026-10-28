import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Benchmark, Performance, SEGMENTS } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

@Component({
  selector: 'app-analytics',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, LineChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './analytics.component.html',
  styles: [`
    .heat { border-collapse: separate; border-spacing: 2px; width: 100%; font-size: 12px; }
    .heat th { color: var(--muted); font-weight: 500; padding: 4px 1px; text-align: center; font-size: 11px; }
    .heat td { text-align: center; padding: 7px 1px; border-radius: 3px; font-variant-numeric: tabular-nums; color: var(--text); min-width: 26px; font-size: 11.5px; }
    .heat td.year { text-align: left; color: var(--text-2); font-weight: 600; background: none; }
    .bars { display: grid; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: minmax(80px, 150px) 1fr 50px; gap: 10px; align-items: center; font-size: 13px; }
    .track { height: 6px; background: var(--surface-hover); border-radius: 0 3px 3px 0; overflow: hidden; }
    .track > span { display: block; height: 100%; border-radius: 0 3px 3px 0; background: var(--s1); }
  `],
})
export class AnalyticsComponent {
  store = inject(StoreService);
  private api = inject(ApiService);

  ranges = ['1M', '3M', '6M', '1Y', '3Y', 'YTD', 'FY', 'ALL'];
  segments = SEGMENTS;
  range = signal('1Y');
  segment = signal('');
  bench = signal('NIFTY50');
  tab = signal<'growth' | 'returns' | 'risk'>('growth');
  perf = signal<Performance | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  months = MONTHS;
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);
  idxFmt = (v: number) => (v * 100).toFixed(0);
  idxTip = (v: number) => `₹${(v * 100).toFixed(1)}`;

  m = computed(() => this.perf()?.metrics);
  benchOptions = computed(() => this.perf()?.benchmarks ?? []);
  activeBench = computed<Benchmark | undefined>(() => this.benchOptions().find(b => b.key === this.bench()) ?? this.benchOptions()[0]);
  labels = computed(() => this.perf()?.series.map(p => p.date) ?? []);
  valueSeries = computed<LineSeries[]>(() => {
    const s = this.perf()?.series ?? [];
    const b = this.activeBench();
    const out: LineSeries[] = [
      { key: 'value', label: 'Your portfolio', color: 'var(--s1)', values: s.map(p => p.value), area: true },
      { key: 'net', label: 'Net invested', color: 'var(--muted)', values: s.map(p => p.net_invested), muted: true },
    ];
    if (b) out.push({ key: b.key, label: `Same flows in ${b.label}`, color: 'var(--s2)', values: s.map(p => (p[b.key] as number | null) ?? null) });
    return out;
  });
  indexSeries = computed<LineSeries[]>(() => [{ key: 'idx', label: 'Growth of ₹100', color: 'var(--s1)', values: (this.perf()?.series ?? []).map(p => p.index), area: true }]);

  heat = computed(() => {
    const rows = new Map<string, (number | null)[]>();
    for (const r of this.perf()?.monthly ?? []) {
      const [y, mo] = r.month.split('-');
      if (!rows.has(y)) rows.set(y, Array(12).fill(null));
      rows.get(y)![+mo - 1] = r.return;
    }
    return [...rows.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, vals]) => {
      const known = vals.filter((v): v is number => v !== null);
      const total = known.length ? (known.reduce((a, v) => a * (1 + v / 100), 1) - 1) * 100 : null;
      return { year, vals, total };
    });
  });
  heatBg(v: number | null): string {
    if (v === null) return 'transparent';
    const k = Math.min(Math.abs(v) / 8, 1) * 70;
    return `color-mix(in srgb, ${v >= 0 ? 'var(--s1)' : 'var(--s8)'} ${k.toFixed(0)}%, var(--div-mid))`;
  }

  // ── risk (from the current snapshot) ──
  open = computed(() => this.store.openPositions().filter(p => p.asset_class !== 'cash' && (!this.segment() || p.segment === this.segment())));
  total = computed(() => this.open().reduce((a, p) => a + p.value, 0) || 1);
  top = computed(() => [...this.open()].filter(p => p.asset_class !== 'p2p').sort((a, b) => b.value - a.value).slice(0, 10)
    .map(p => ({ key: p.name, id: p.id, pct: (p.value / this.total()) * 100 })));
  top5 = computed(() => this.top().slice(0, 5).reduce((a, x) => a + x.pct, 0));
  group(key: 'sector' | 'market_cap' | 'currency' | 'segment', filter?: (p: any) => boolean) {
    const rows = this.open().filter(p => !filter || filter(p));
    const tot = rows.reduce((a, p) => a + p.value, 0) || 1;
    const m = new Map<string, number>();
    for (const p of rows) m.set((p as any)[key] || 'Unclassified', (m.get((p as any)[key] || 'Unclassified') ?? 0) + p.value);
    return [...m.entries()].map(([k, v]) => ({ key: k, pct: (v / tot) * 100, value: v })).sort((a, b) => b.pct - a.pct);
  }
  sectors = computed(() => this.group('sector', p => p.asset_class === 'equity'));
  caps = computed(() => this.group('market_cap', p => p.asset_class === 'equity'));
  usdShare = computed(() => this.group('currency').find(g => g.key === 'USD')?.pct ?? 0);
  maxPct = (rows: { pct: number }[]) => Math.max(...rows.map(r => r.pct), 1);

  constructor() {
    effect(() => {
      const key = [this.range(), this.segment(), this.store.version()];
      queueMicrotask(() => this.load(key[0] as string, key[1] as string));
    });
  }

  async load(range: string, segment: string) {
    this.loading.set(true);
    try {
      const p = await firstValueFrom(this.api.performance(range, segment || null));
      this.perf.set(p);
      if (!p.benchmarks.some(b => b.key === this.bench()) && p.benchmarks.length) this.bench.set(p.benchmarks[0].key);
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
