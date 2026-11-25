import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ago, money, monthTicks, pctV } from '../../core/format';
import { GROUP_HEX, groupMeta } from '../../core/groups';
import { GroupRow, Performance, Suggestion } from '../../core/models';
import { OverviewService } from '../../core/overview.service';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { AreaChartComponent, DonutComponent, SparkComponent } from '../../shared/v2/charts';
import { GroupSheetComponent } from '../../shared/v2/group-sheet.component';

type Range = '6M' | '1Y' | 'ALL';

/** Home: where everything stands, in one screen of cards (redesign). */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, IconComponent, AreaChartComponent, DonutComponent, SparkComponent, GroupSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="v2">
    @if (empty()) {
      <div class="v-card v-empty">
        <span class="v-tone brand"><app-icon name="sparkles" [size]="22" /></span>
        <b style="color:var(--text);font-size:16px">Let's add your first investment</b>
        <span>Add an entry, or import a statement from CAMS, Kite, EPFO or LenDenClub.</span>
        @if (auth.canWrite()) {
          <div class="row"><button class="v-btn primary" (click)="dialog.add()"><app-icon name="plus" [size]="16" /> Add entry</button>
            <a class="v-btn" routerLink="/import">Import</a></div>
        }
      </div>
    } @else {
    <div class="v-grid hero-row">
      <!-- hero -->
      <section class="v-hero" aria-label="Net worth"><span class="lg-rim" aria-hidden="true"></span>
        @if (heroArea(); as ha) {
          <svg class="harea" viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="hfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient></defs>
            <path [attr.d]="ha.area" fill="url(#hfill)" /><path [attr.d]="ha.line" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="2" vector-effect="non-scaling-stroke" />
          </svg>
        }
        <div class="lbl">Net worth</div>
        @if (ov(); as o) {
          <div class="big">{{ money(shownValue()) }}</div>
          <span class="chipw"><app-icon [name]="o.totals.day_change < 0 ? 'arrowDownRight' : 'arrowUpRight'" [size]="14" [stroke]="2.6" />
            {{ money(o.totals.day_change) }} · {{ pctV(o.totals.day_change_pct, 2) }} today</span>
          <div class="glass">
            <div><small>Invested</small><b>{{ money(o.totals.put_in) }}</b></div>
            <div><small>Gain</small><b>{{ money(o.totals.gain, true) }}</b></div>
            <div><small>Return / yr</small><b>{{ pctV(o.totals.xirr) }}</b></div>
          </div>
        } @else {
          <div class="big" style="opacity:.6">—</div><div class="glass"><div style="height:44px"></div><div></div><div></div></div>
        }
        <button class="prices" type="button" (click)="store.refreshPrices(true)" [disabled]="store.refreshingPrices()"
          [attr.aria-label]="'Prices updated ' + pricesAge() + '. Refresh'">
          <app-icon name="refresh" [size]="12" [stroke]="2.4" /> {{ store.refreshingPrices() ? 'Updating…' : pricesAge() }}
        </button>
      </section>

      <!-- growth -->
      <section class="v-card">
        <div class="v-ch"><h2>Growth</h2>
          <div class="v-chips" role="tablist" aria-label="Period">
            @for (r of ranges; track r) { <button role="tab" [class.on]="range() === r" [attr.aria-selected]="range() === r" (click)="range.set(r)">{{ r === 'ALL' ? 'All' : r }}</button> }
          </div>
        </div>
        <v-area class="fill" [a]="growth().value" [b]="growth().invested" [labels]="growth().ticks" [h]="128" label="Value against money invested" />
        <div class="v-legend"><span style="--c:var(--chart-a)">Value</span><span style="--c:var(--chart-b)">Money invested</span>
          @if (perf()?.metrics?.gain !== undefined && perf()?.metrics?.gain !== null) {
            <span class="gain-in" [class.v-gain]="perf()!.metrics.gain >= 0" [class.v-loss]="perf()!.metrics.gain < 0">{{ money(perf()!.metrics.gain, true) }} in this period</span>
          }
        </div>
      </section>

      <!-- mix -->
      <section class="v-card">
        <div class="v-ch"><h2>Your mix</h2><span class="hint">{{ ov()?.targets?.has_mine ? 'vs your target' : 'share of everything' }}</span></div>
        <div class="mix">
          <v-donut [parts]="donut()" [size]="136" [thickness]="18" [top]="groups().length + ' groups'" [bottom]="money(ov()?.totals?.value)" />
          <div class="mixleg">
            @for (g of groups(); track g.key) {
              <div class="lg"><span class="d" [style.background]="hex(g.key)"></span><span class="nm">{{ g.label }}</span><b>{{ g.pct.toFixed(0) }}%</b>
                @if (g.gap !== null) { <span class="dl" [class.u]="g.gap <= -1" [class.k]="g.gap > -1 && g.gap < 1">{{ gapText(g.gap) }}</span> }
              </div>
            }
          </div>
        </div>
        <a class="foot" routerLink="/analysis" [queryParams]="{ tab: 'mix' }">
          <span>{{ ov()?.targets?.has_mine ? (offTarget() ? offTarget() + ' group' + (offTarget() > 1 ? 's are' : ' is') + ' off target' : 'On target') : 'Set your target mix' }}</span>
          <span class="go">{{ ov()?.targets?.has_mine ? 'Rebalance' : 'Set targets' }} <app-icon name="chevronRight" [size]="16" [stroke]="2.4" /></span>
        </a>
      </section>
    </div>

    <!-- each part -->
    <div class="v-sec"><h2>How each part is doing</h2><a class="v-link" routerLink="/analysis" [queryParams]="{ tab: 'market' }">Details <app-icon name="chevronRight" [size]="15" [stroke]="2.4" /></a></div>
    <p class="cap">Yearly return, total gain, and how far ahead or behind the same money in its market. Tap one for the working.</p>
    <section class="v-card tight parts">
      @for (g of groups(); track g.key) {
        <button class="v-row prow" (click)="explain.set(g.key)" [style.--c]="meta(g.key).color">
          <span class="v-ic"><app-icon [name]="meta(g.key).icon" [size]="19" /></span>
          <div class="nm"><div class="t">{{ g.label }}</div><div class="s">{{ money(g.value) }} · <span [class.v-gain]="g.gain > 0" [class.v-loss]="g.gain < 0">{{ money(g.gain, true) }}</span></div>
            <div class="v-share"><b [style.width.%]="g.pct * 100 / maxPct()"></b></div></div>
          <v-spark class="sp" [values]="spark(g.key)" [color]="hex(g.key)" [w]="64" [h]="26" />
          <div class="rv"><b>{{ pctV(g.xirr) }}<small class="yr"> /yr</small></b>
            @if (g.bench?.verdict; as v) {
              <span class="v-pill" [class.ok]="v === 'ahead'" [class.no]="v === 'behind'" [class.eq]="v === 'same'">{{ v === 'same' ? '≈ market' : pts(g.bench!.diff) }}</span>
            }
          </div>
        </button>
      } @empty {
        @for (i of [1, 2, 3]; track i) { <div class="v-skel" style="height:52px;margin:12px 0"></div> }
      }
    </section>

    <!-- attention -->
    @if (attention().length) {
      <div class="v-sec"><h2>Needs attention</h2><a class="v-link" routerLink="/analysis" [queryParams]="{ tab: 'improve' }">All {{ ov()?.suggestions?.length }} <app-icon name="chevronRight" [size]="15" [stroke]="2.4" /></a></div>
      <section class="v-card tight attention">
        @for (s of attention(); track s.id) {
          <button class="v-row" (click)="go(s)">
            <span class="v-tone" [class]="s.tone"><app-icon [name]="s.icon" [size]="19" /></span>
            <div class="grow"><div class="t">{{ s.title }}</div><div class="s">{{ s.detail }}</div></div>
            <div class="r"><b class="imp" [class.v-warn]="s.tone === 'warn'" [class.v-loss]="s.tone === 'bad'" [class.v-gain]="s.tone === 'good'">{{ s.impact }}</b></div>
          </button>
        }
      </section>
    }
    }
  </div>
  @if (explain(); as k) { <v-group-sheet [key]="k" (closed)="explain.set(null)" /> }
  `,
  styles: [`
    .cap { font-size: var(--fs-small); color: var(--muted); margin: 0 2px; font-weight: 500; }
    .yr { font-size: 12px; color: var(--muted); font-weight: 600; }
    .v-hero { display: flex; flex-direction: column; min-height: 240px; }
    .v-hero .glass { margin-top: auto; }
    .harea { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 46%; z-index: -1; pointer-events: none; opacity: .9; }
    .chipw { align-self: flex-start; }
    .prices { position: absolute; top: 16px; right: 16px; display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px;
      font-weight: 700; color: #fff; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.16); border-radius: 99px; padding: 5px 11px;
      cursor: pointer; transition: background .2s ease; }
    .prices:hover { background: rgba(255,255,255,.22); }
    @media (max-width: 999px) { .v-hero { min-height: 260px; } .v-hero .glass { margin-top: 64px; } }
    .mix { display: grid; grid-template-columns: 136px minmax(0, 1fr); gap: 18px; align-items: center; flex: 1; }
    .mixleg { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .lg { display: grid; grid-template-columns: 10px minmax(0, 1fr) 44px 48px; gap: 8px; align-items: center; font-size: 13.5px; padding: 4px 0; font-weight: 500; min-width: 0; }
    .lg .d { width: 10px; height: 10px; border-radius: 3px; }
    .lg .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
    .lg b { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
    .dl { font-size: 11px; font-weight: 700; padding: 2px 0; border-radius: 6px; text-align: center; background: var(--surface-3); color: var(--text-2); font-variant-numeric: tabular-nums; }
    .dl.u { background: var(--warn-soft); color: var(--warn); } .dl.k { background: var(--pos-soft); color: var(--pos); }
    .foot { display: flex; align-items: center; justify-content: space-between; background: var(--accent-soft); border: 1px solid rgba(99,102,241,.3); border-radius: 14px;
      padding: 11px 14px; margin-top: 16px; font-size: var(--fs-small); font-weight: 700; color: var(--accent-strong); text-decoration: none; transition: background .2s ease; }
    .foot:hover { background: rgba(99,102,241,.24); text-decoration: none; }
    .foot .go { display: inline-flex; align-items: center; gap: 2px; }
    .gain-in { margin-left: auto; font-weight: 700; }
    .gain-in::before { display: none; }
    /* group rows: one grid, so names, trend lines and numbers line up in columns */
    .prow { display: grid; grid-template-columns: 40px minmax(0, 1fr) 64px 112px; column-gap: 14px; }
    .prow .nm { min-width: 0; }
    .prow .t, .prow .s { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .prow .s { font-weight: 600; }
    .prow .rv { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .prow .rv b { font-size: 17px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .attention .imp { font-size: 14px; white-space: nowrap; }
    .attention .v-row .s { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    @media (max-width: 480px) {
      .prow { grid-template-columns: 40px minmax(0, 1fr) 100px; } .prow .sp { display: none; }
      .mix { grid-template-columns: 104px minmax(0, 1fr); gap: 12px; }
      .mix v-donut svg { width: 104px; height: 104px; }
      .lg { grid-template-columns: 9px minmax(0, 1fr) 38px 44px; gap: 6px; font-size: 12.5px; }
      .attention .v-row { flex-wrap: wrap; }
      .attention .v-row .r { width: 100%; text-align: left; padding-left: 58px; margin-top: -6px; }
    }
    @media (min-width: 760px) {
      .parts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 32px; }
      .parts .v-row:nth-child(2) { border-top: 0; }
    }
  `],
})
export class HomeComponent {
  private api = inject(ApiService);
  private router = inject(Router);
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);

  money = money;
  pctV = pctV;
  meta = groupMeta;
  hex = (k: string) => GROUP_HEX[k as keyof typeof GROUP_HEX] ?? '#9aa3b8';
  ranges: Range[] = ['6M', '1Y', 'ALL'];

  range = signal<Range>('1Y');
  explain = signal<string | null>(null);
  pts = (v: number | null) => v === null ? '—' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' pts';
  short = (label: string) => label.replace(' in ₹', '').replace(' mix', '').replace('EPFO rate', 'EPFO').replace('FD rate', 'FD');
  ov = inject(OverviewService).data;
  perf = signal<Performance | null>(null);

  empty = computed(() => {
    const p = this.store.portfolio();
    return !!p && !p.positions.length;
  });
  groups = computed<GroupRow[]>(() => (this.ov()?.groups ?? []).filter(g => g.value > 0.5 || (g.target ?? 0) > 0));
  donut = computed(() => this.groups().map(g => ({ value: g.value, color: this.hex(g.key), label: g.label })));
  offTarget = computed(() => this.groups().filter(g => g.gap !== null && Math.abs(g.gap) >= 1).length);
  maxPct = computed(() => Math.max(1, ...this.groups().map(g => g.pct)));
  /** The net worth as shown: counts up to the new value whenever it changes (0.8 s, eased). */
  shownValue = signal(0);
  private countFrom = 0;
  private countRaf = 0;
  private countUp(to: number) {
    cancelAnimationFrame(this.countRaf);
    const from = this.countFrom || to * 0.92, start = performance.now(), dur = 800;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.shownValue.set(to); this.countFrom = to; return; }
    const step = (now: number) => {
      const k = Math.min((now - start) / dur, 1), e = 1 - Math.pow(1 - k, 3);
      this.shownValue.set(from + (to - from) * e);
      if (k < 1) this.countRaf = requestAnimationFrame(step); else this.countFrom = to;
    };
    this.countRaf = requestAnimationFrame(step);
  }
  attention = computed<Suggestion[]>(() => (this.ov()?.suggestions ?? []).slice(0, 3));
  pricesAge = computed(() => ago(this.store.portfolio()?.prices?.last_refresh));

  growth = computed(() => {
    const s = this.perf()?.series ?? [];
    return { value: s.map(p => p.value), invested: s.map(p => p.net_invested), ticks: monthTicks(s.map(p => p.date)) };
  });
  heroSpark = computed(() => this.growth().value.slice(-60));
  /** The year's value as a soft filled curve along the bottom of the hero (decorative; the Growth card has the real chart). */
  heroArea = computed(() => {
    const v = this.growth().value;
    if (v.length < 2) return null;
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((x, i) => [(i / (v.length - 1)) * 400, 92 - ((x - lo) / span) * 62]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return { line, area: `${line} L400,100 L0,100 Z` };
  });

  constructor() {
    effect(() => { const v = this.ov()?.totals.value; if (v !== undefined) untracked(() => this.countUp(v)); });
    effect(() => {
      const r = this.range();
      this.store.version();
      untracked(() => void this.loadPerf(r));
    });
  }

  private async loadPerf(r: Range) {
    const key = snapshotKey('perf', this.store.scopeKey(), r);
    const snap = readSnapshot<Performance>(key);
    if (snap) this.perf.set(snap);          // draw at once from this device's last copy
    try {
      const p = await firstValueFrom(this.api.performance(r));
      this.perf.set(p);
      writeSnapshot(key, p);
    } catch { if (!snap) this.perf.set(null); }
  }

  spark(key: string): number[] {
    const s = this.perf()?.series ?? [];
    return s.slice(-40).map(p => p.groups?.[key] ?? 0);
  }

  gapText(gap: number): string {
    if (Math.abs(gap) < 1) return 'on';
    return (gap > 0 ? '+' : '−') + Math.abs(gap).toFixed(1);
  }

  go(s: Suggestion) {
    void this.router.navigateByUrl(s.link || '/analysis?tab=improve');
  }
}
