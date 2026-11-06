import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact, inrWords } from '../../core/format';
import { errorMessage } from '../../core/http';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { Performance, Pulse, SEGMENT_COLOR, SEGMENT_META, activeSeries, MarketOverview, RebalancePlan } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { MoneyCalendarComponent } from './pulse.components';
import { TakeawaysComponent } from './story.components';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [FormsModule, RouterLink, DecimalPipe, IconComponent, LineChartComponent, MoneyCalendarComponent,
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
  /** Market comparison, biggest driver and drag have their own charts above; keep what they don't show. */
  takeaways = computed(() => (this.story()?.takeaways ?? []).filter(t => !['market', 'driver', 'drag'].includes(t.key)));
  compare = signal(true);
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
  scopeTitle = computed(() => {
    const l = this.auth.portfolioLabel();
    return l === 'Family' ? 'Family portfolio' : `${l}'s portfolio`;
  });
  /** Family view: label holdings with their owner. */
  showMember = computed(() => this.auth.canSwitch() && !this.auth.portfolio());
  memberName = (owner: string) => this.auth.members().find(m => m.email.toLowerCase() === owner.toLowerCase())?.name ?? owner.split('@')[0];
  holdingsOf = (segment: string) => this.store.positions().filter(p => p.segment === segment && p.is_open)
    .sort((a, b) => b.value - a.value).slice(0, 8);
  toggle(segment: string) { this.expanded.set(this.expanded() === segment ? null : segment); }

  /** One card per asset class that holds money. */
  assets = computed(() => (this.p()?.segments ?? []).filter(s => s.value > 0).map(s => ({
    ...s, ...(SEGMENT_META[s.segment] ?? { label: s.segment, icon: 'layers', route: '/' }),
    color: SEGMENT_COLOR[s.segment] ?? 'var(--s7)',
  })));
  hasTargets = computed(() => this.assets().some(a => a.target !== null));

  /** Your money against the same deposits and withdrawals put into the Nifty 50, over the chart's range. */
  vsNifty = computed(() => {
    const pf = this.perf();
    const b = pf?.benchmarks.find(x => x.key === 'NIFTY50');
    if (!pf || !b) return null;
    const diff = pf.metrics.end_value - b.end_value;
    return { you: pf.metrics.end_value, nifty: b.end_value, diff, ahead: diff >= 0, youXirr: pf.metrics.xirr, niftyXirr: b.xirr };
  });

  /** Current share against target per asset class, with the rupees it is over or under. */
  allocation = computed(() => {
    const total = this.t()?.value || 0;
    const rows = this.assets().map(a => ({ segment: a.segment, label: a.label, color: a.color, pct: a.pct, target: a.target,
      drift: a.drift, gap: a.drift !== null ? a.drift / 100 * total : null }));
    const scale = Math.max(1, ...rows.map(r => Math.max(r.pct, r.target ?? 0)));
    return { rows: rows.sort((x, y) => Math.abs(y.drift ?? 0) - Math.abs(x.drift ?? 0)), scale };
  });

  /** Holdings that added or took away the most, for a diverging bar. */
  drivers = computed(() => {
    const a = this.story()?.attribution;
    if (!a) return null;
    const rows = [...a.gainers.slice(0, 5), ...a.losers.slice(0, 5).reverse()];
    const max = Math.max(1, ...rows.map(r => Math.abs(r.gain)));
    return { rows, max, gains: a.gross_gains, losses: a.gross_losses, winners: a.winners, losers: a.losers_count };
  });

  /** Where the next sum should go to move toward the targets without selling. */
  nextMoney = signal<number | null>(null);
  plan = signal<RebalancePlan | null>(null);
  planRows = computed(() => (this.plan()?.rows ?? []).filter(r => r.action === 'buy' && r.amount >= 1).sort((a, b) => b.amount - a.amount));
  planMax = computed(() => Math.max(1, ...this.planRows().map(r => r.amount)));
  segLabel = (seg: string) => SEGMENT_META[seg]?.label ?? seg;
  segColor = (seg: string) => SEGMENT_COLOR[seg] ?? 'var(--s7)';
  ideas = computed(() => {
    const i = this.market()?.ideas;
    if (!i) return [];
    return [...i.momentum_buy, ...i.dip_buy].filter(x => !x.held).sort((a, b) => b.score - a.score).slice(0, 4);
  });
  trims = computed(() => (this.market()?.rebalance.trim ?? []).slice(0, 3));
  private planTimer: ReturnType<typeof setTimeout> | undefined;
  setNextMoney(v: number | null) {
    this.nextMoney.set(v);
    clearTimeout(this.planTimer);
    this.planTimer = setTimeout(() => this.loadPlan(), 400);
  }
  async loadPlan() {
    const amt = Math.max(0, Math.round(this.nextMoney() ?? 0));
    if (!this.hasTargets() || !amt) { this.plan.set(null); return; }
    try { this.plan.set(await firstValueFrom(this.api.rebalance(amt, false))); } catch { this.plan.set(null); }
  }

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
      if (this.nextMoney() === null) this.nextMoney.set(Math.max(10000, Math.round((pulse.story.rhythm.pace || 0) / 1000) * 1000));
      void this.loadPlan();
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
