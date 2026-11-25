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
import { TiltDirective } from '../../shared/v2/spatial';
import { AreaChartComponent, DonutComponent, SparkComponent } from '../../shared/v2/charts';
import { GroupSheetComponent } from '../../shared/v2/group-sheet.component';

type Range = '6M' | '1Y' | 'ALL';

/** Home: where everything stands, in one screen of cards (redesign). */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, IconComponent, AreaChartComponent, DonutComponent, SparkComponent, GroupSheetComponent, TiltDirective],
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
      <section class="v-hero" aria-label="Net worth" [vTilt]="5"><span class="lg-rim" aria-hidden="true"></span><span class="lg-sheen" aria-hidden="true"></span>
        @if (heroArea(); as ha) {
          <svg class="harea" viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="hfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient></defs>
            <path [attr.d]="ha.area" fill="url(#hfill)" /><path [attr.d]="ha.line" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="2" vector-effect="non-scaling-stroke" />
          </svg>
        }
        <div class="lbl">Net worth</div>
        @if (ov(); as o) {
          <div class="big">{{ money(o.totals.value) }}</div>
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
      <section class="v-card" vTilt>
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
      <section class="v-card" vTilt>
        <div class="v-ch"><h2>Your mix</h2><span class="hint">{{ ov()?.targets?.has_mine ? 'vs your target' : 'share of everything' }}</span></div>
        <div class="mix">
          <v-donut [parts]="donut()" [size]="128" [thickness]="19" [top]="groups().length + ' groups'" [bottom]="money(ov()?.totals?.value)" />
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
    <p class="cap">Return a year · its total gain · points above or below the same money in its market (Nifty 500, S&amp;P 500, gold, FD or EPFO rate). Tap one to see the working.</p>
    <section class="v-card tight parts">
      @for (g of groups(); track g.key) {
        <button class="v-row" (click)="explain.set(g.key)" [style.--c]="meta(g.key).color">
          <span class="v-ic"><app-icon [name]="meta(g.key).icon" [size]="17" /></span>
          <div class="grow"><div class="t">{{ g.label }}</div><div class="s">{{ money(g.value) }} · {{ money(g.gain, true) }}</div>
            <div class="v-share"><b [style.width.%]="g.pct * 100 / maxPct()"></b></div></div>
          <v-spark class="hide-xs" [values]="spark(g.key)" [color]="hex(g.key)" [w]="44" [h]="22" />
          <div class="r" style="width:104px"><b>{{ pctV(g.xirr) }}<small class="yr"> /yr</small></b>
            @if (g.bench?.verdict; as v) {
              <span class="v-pill" [class.ok]="v === 'ahead'" [class.no]="v === 'behind'" [class.eq]="v === 'same'">{{ v === 'same' ? '≈ market' : pts(g.bench!.diff) }}</span>
            }
          </div>
        </button>
      } @empty {
        @for (i of [1, 2, 3]; track i) { <div class="v-skel" style="height:44px;margin:10px 0"></div> }
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
    .cap { font-size: 12.5px; color: var(--muted); margin: -6px 4px 0; font-weight: 500; }
    .yr { font-size: 11px; color: var(--muted); font-weight: 600; }
    .v-hero { min-height: 212px; }
    .harea { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 58%; z-index: 0 !important; pointer-events: none; }
    @media (max-width: 999px) { .v-hero .glass { margin-top: 70px; } .harea { height: 62%; } }
    @media (min-width: 1000px) { .v-hero { display: flex; flex-direction: column; align-items: flex-start; } .v-hero .glass { margin-bottom: 96px; align-self: stretch; } .harea { height: 30%; } }
    .prices { position: absolute; top: 14px; right: 14px; display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 11.5px;
      font-weight: 600; color: #fff; background: rgba(255,255,255,.14); border: 0; border-radius: 99px; padding: 4px 9px; cursor: pointer; }
    .mix { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 14px; align-items: center; }
    .mixleg { min-width: 0; }
    .lg { display: flex; align-items: center; font-size: 12.5px; padding: 3px 0; font-weight: 500; white-space: nowrap; min-width: 0; }
    .lg .d { width: 9px; height: 9px; border-radius: 3px; margin-right: 8px; flex: none; }
    .lg .nm { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .lg b { margin-left: auto; padding-left: 6px; font-weight: 700; }
    .dl { font-size: 10.5px; font-weight: 700; padding: 1px 5px; border-radius: 5px; margin-left: 5px; min-width: 36px; text-align: center;
      background: var(--bg); color: var(--text-2); }
    .dl.u { background: var(--warn-soft); color: var(--warn); } .dl.k { background: var(--pos-soft); color: var(--pos); }
    .foot { display: flex; align-items: center; justify-content: space-between; background: var(--accent-soft); border: 1px solid var(--border); border-radius: 14px;
      padding: 10px 12px; margin-top: 12px; font-size: 13px; font-weight: 600; color: var(--accent); text-decoration: none; }
    .foot .go { display: inline-flex; align-items: center; gap: 2px; }
    .gain-in { margin-left: auto; font-weight: 700; }
    .gain-in::before { display: none; }
    .parts .v-row .s { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .parts .v-row .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .attention .imp { font-size: 13.5px; white-space: nowrap; }
    .attention .v-row .s { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    @media (max-width: 360px) { .hide-xs { display: none; } }
    @media (max-width: 420px) {
      .mix { grid-template-columns: 96px minmax(0, 1fr); gap: 10px; }
      .mix v-donut svg { width: 96px; height: 96px; }
      .lg { font-size: 12px; }
      .attention .v-row { flex-wrap: wrap; }
      .attention .v-row .r { width: 100%; text-align: left; padding-left: 52px; margin-top: -4px; }
    }
    @media (min-width: 760px) {
      .parts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 28px; padding: 6px 20px; }
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
