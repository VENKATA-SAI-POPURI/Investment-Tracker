import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact, inrWords } from '../../core/format';
import { errorMessage } from '../../core/http';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { Performance, Pulse, SEGMENT_COLOR, SEGMENT_META, activeSeries, MarketOverview } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { DonutChartComponent, Slice } from '../../shared/charts/donut-chart.component';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { MandalaComponent } from '../../shared/motifs';
import { FestivalStripComponent, MoneyCalendarComponent } from './pulse.components';
import { TakeawaysComponent } from './story.components';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [RouterLink, DecimalPipe, IconComponent, LineChartComponent, DonutChartComponent, MandalaComponent, FestivalStripComponent, MoneyCalendarComponent,
    TakeawaysComponent, ...FORMAT_PIPES],
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
  expanded = signal<string | null>(null);
  pulse = signal<Pulse | null>(null);
  market = signal<MarketOverview | null>(null);
  /** Value-weighted move of the stocks and ETFs tracked on the Markets page. */
  marketMine = computed(() => {
    const h = (this.market()?.holdings ?? []).filter(x => x.metrics?.d1 !== null && x.metrics?.d1 !== undefined);
    const tot = h.reduce((a, x) => a + x.value, 0);
    return { d1: tot ? h.reduce((a, x) => a + x.metrics!.d1! * x.value, 0) / tot : null };
  });
  /** Holdings with a price signal first, then the biggest movers today. */
  marketWatch = computed(() => [...(this.market()?.holdings ?? [])]
    .sort((a, b) => (b.signals.length - a.signals.length) || Math.abs(b.metrics?.d1 ?? 0) - Math.abs(a.metrics?.d1 ?? 0)).slice(0, 4));
  signalTone(k: string) { return ({ momentum_buy: 'good', momentum_sell: 'bad', dip_buy: 'info', profit_book: 'warn' } as Record<string, string>)[k]; }
  story = computed(() => this.pulse()?.story ?? null);
  compare = signal(false);
  words = inrWords;
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
  scopeTitle = computed(() => {
    const l = this.auth.portfolioLabel();
    return l === 'Family' ? 'Family portfolio' : `${l}'s portfolio`;
  });
  /** Family view only: one line per member who holds something. */
  showMember = computed(() => this.auth.canSwitch() && !this.auth.portfolio());
  members = computed(() => {
    if (!this.showMember()) return [];
    const total = this.t()?.value || 1;
    return this.auth.members().map(m => {
      const mine = this.store.positions().filter(p => p.owner.toLowerCase() === m.email.toLowerCase());
      const value = mine.reduce((a, p) => a + p.value, 0);
      const gain = mine.reduce((a, p) => a + p.total_return, 0);
      return { ...m, value, gain, count: mine.filter(p => p.is_open).length, share: value / total * 100 };
    }).sort((a, b) => b.value - a.value);
  });
  memberName = (owner: string) => this.auth.members().find(m => m.email.toLowerCase() === owner.toLowerCase())?.name ?? owner.split('@')[0];
  holdingsOf = (segment: string) => this.store.positions().filter(p => p.segment === segment && p.is_open)
    .sort((a, b) => b.value - a.value).slice(0, 8);
  toggle(segment: string) { this.expanded.set(this.expanded() === segment ? null : segment); }

  /** One card per asset class that holds money. */
  assets = computed(() => (this.p()?.segments ?? []).filter(s => s.value > 0).map(s => ({
    ...s, ...(SEGMENT_META[s.segment] ?? { label: s.segment, icon: 'layers', route: '/' }),
    color: SEGMENT_COLOR[s.segment] ?? 'var(--s7)',
  })));
  slices = computed<Slice[]>(() => this.assets().map(a => ({ label: a.label, value: a.value, color: a.color })));
  hasTargets = computed(() => this.assets().some(a => a.target !== null));

  hasBench = computed(() => !!this.perf()?.benchmarks.some(b => b.key === 'NIFTY50'));
  points = computed(() => activeSeries(this.perf()?.series ?? []));
  labels = computed(() => this.points().map(p => p.date));
  series = computed<LineSeries[]>(() => {
    const s = this.points();
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
    // Both start as soon as someone is signed in, in parallel with the portfolio, and begin from this
    // device's last copy so the page doesn't assemble itself piece by piece
    effect(() => {
      const r = this.range(), v = this.store.version(), scope = this.store.scopeKey();
      if (!this.auth.token()) return;
      if (`${scope}|${r}` !== this.perfShown) {  // another portfolio or range: show its own last copy, if any
        this.perfShown = `${scope}|${r}`;
        const snap = readSnapshot<Performance>(snapshotKey('perf', scope, r));
        if (snap || scope !== this.perfScope) this.perf.set(snap);
        this.perfScope = scope;
      }
      queueMicrotask(() => this.loadPerf(r, v, scope));
    });
    effect(() => {
      const v = this.store.version(), scope = this.store.scopeKey();
      if (!this.auth.token()) return;
      if (scope !== this.pulseScope) {
        this.pulseScope = scope;
        this.pulse.set(readSnapshot<Pulse>(snapshotKey('pulse', scope)));
        this.market.set(readSnapshot<MarketOverview>(snapshotKey('markets', scope)));
      }
      queueMicrotask(() => this.loadInsights(v, scope));
    });
  }

  private perfKey = '';
  private perfShown = '';
  private perfScope = '';
  private pulseScope = '';
  async loadPerf(range: string, version: number, scope: string) {
    const key = `${range}|${version}|${scope}`;
    if (key === this.perfKey) return;
    this.perfKey = key;
    this.perfLoading.set(true);
    try {
      const perf = await firstValueFrom(this.api.performance(range));
      if (key !== this.perfKey) return;  // a newer range or portfolio was asked for meanwhile
      this.perf.set(perf);
      this.perfError.set(null);
      writeSnapshot(snapshotKey('perf', scope, range), perf);
    } catch (e) {
      this.perfError.set(errorMessage(e));
    } finally {
      this.perfLoading.set(false);
    }
  }

  private insightsKey = '';
  async loadInsights(version: number, scope: string) {
    const key = `${version}|${scope}`;
    if (this.insightsKey === key) return;
    this.insightsKey = key;
    try {
      const pulse = await firstValueFrom(this.api.pulse());
      if (key !== this.insightsKey) return;
      this.pulse.set(pulse);
      writeSnapshot(snapshotKey('pulse', scope), pulse);
    } catch { /* optional on the home screen */ }
    try {  // after the rest of the page: the first market scan of the day takes a few seconds
      const market = await firstValueFrom(this.api.markets());
      if (key !== this.insightsKey) return;
      this.market.set(market);
      writeSnapshot(snapshotKey('markets', scope), market);
    } catch { /* optional on the home screen */ }
  }

  go(route: string) { this.router.navigate([route]); }
}
