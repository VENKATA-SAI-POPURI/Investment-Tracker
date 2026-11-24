import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ago, money, monthTicks, pctV } from '../../core/format';
import { GROUP_HEX, groupMeta } from '../../core/groups';
import { GroupRow, Performance, Suggestion } from '../../core/models';
import { OverviewService } from '../../core/overview.service';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { AreaChartComponent, DonutComponent, SparkComponent } from '../../shared/v2/charts';

type Range = '6M' | '1Y' | 'ALL';

/** Home: where everything stands, in one screen of cards (redesign). */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, IconComponent, AreaChartComponent, DonutComponent, SparkComponent],
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
      <section class="v-hero" aria-label="Net worth">
        @if (heroSpark().length > 1) { <v-spark class="spark" [values]="heroSpark()" color="rgba(255,255,255,.9)" [w]="120" [h]="40" [stroke]="2.2" /> }
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
      <section class="v-card">
        <div class="v-ch"><h2>Growth</h2>
          <div class="v-chips" role="tablist" aria-label="Period">
            @for (r of ranges; track r) { <button role="tab" [class.on]="range() === r" [attr.aria-selected]="range() === r" (click)="range.set(r)">{{ r === 'ALL' ? 'All' : r }}</button> }
          </div>
        </div>
        <v-area [a]="growth().value" [b]="growth().invested" [labels]="growth().ticks" [h]="128" label="Value against money invested" />
        <div class="v-legend"><span style="--c:#6a46f5">Value</span><span style="--c:#c9c5d8">Money invested</span>
          @if (perf()?.metrics?.gain !== undefined && perf()?.metrics?.gain !== null) {
            <span class="gain-in" [class.v-gain]="perf()!.metrics.gain >= 0" [class.v-loss]="perf()!.metrics.gain < 0">{{ money(perf()!.metrics.gain, true) }} in this period</span>
          }
        </div>
      </section>

      <!-- mix -->
      <section class="v-card">
        <div class="v-ch"><h2>Your mix</h2><span class="hint">{{ ov()?.targets?.has_mine ? 'vs your target' : 'share of everything' }}</span></div>
        <div class="mix">
          <v-donut [parts]="donut()" [size]="128" [thickness]="19" [top]="groups().length + ' groups'" [bottom]="money(ov()?.totals?.value)" />
          <div class="legend">
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
    <section class="v-card tight parts">
      @for (g of groups(); track g.key) {
        <a class="v-row" routerLink="/portfolio" [queryParams]="{ group: g.key }" [style.--c]="meta(g.key).color">
          <span class="v-ic"><app-icon [name]="meta(g.key).icon" [size]="17" /></span>
          <div class="grow"><div class="t">{{ g.label }}</div><div class="s">{{ money(g.value) }}</div></div>
          <v-spark class="hide-xs" [values]="spark(g.key)" [color]="hex(g.key)" [w]="58" [h]="24" />
          <div class="r" style="width:96px"><b>{{ pctV(g.xirr) }}</b>
            @if (g.bench?.verdict; as v) {
              <span class="v-pill" [class.ok]="v === 'ahead'" [class.no]="v === 'behind'" [class.eq]="v === 'same'">{{ v === 'same' ? '≈ market' : pctV(g.bench!.diff, 1, true) + ' vs mkt' }}</span>
            } @else { <span class="v-pill eq">{{ money(g.gain, true) }}</span> }
          </div>
        </a>
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
  `,
  styles: [`
    .v-hero { min-height: 212px; }
    .v-hero .spark { top: 74px; right: 16px; opacity: .55; }
    .prices { position: absolute; top: 14px; right: 14px; display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 11.5px;
      font-weight: 600; color: #fff; background: rgba(255,255,255,.14); border: 0; border-radius: 99px; padding: 4px 9px; cursor: pointer; }
    .mix { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 14px; align-items: center; }
    .legend { min-width: 0; }
    .lg { display: flex; align-items: center; font-size: 12.5px; padding: 3px 0; font-weight: 500; white-space: nowrap; min-width: 0; }
    .lg .d { width: 9px; height: 9px; border-radius: 3px; margin-right: 8px; flex: none; }
    .lg .nm { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .lg b { margin-left: auto; padding-left: 6px; font-weight: 700; }
    .dl { font-size: 10.5px; font-weight: 700; padding: 1px 5px; border-radius: 5px; margin-left: 5px; min-width: 36px; text-align: center;
      background: #eef0f5; color: var(--text-2); }
    .dl.u { background: var(--warn-soft); color: var(--warn); } .dl.k { background: var(--pos-soft); color: var(--pos); }
    .foot { display: flex; align-items: center; justify-content: space-between; background: var(--accent-soft); border-radius: 14px;
      padding: 10px 12px; margin-top: 12px; font-size: 13px; font-weight: 600; color: var(--accent); text-decoration: none; }
    .foot .go { display: inline-flex; align-items: center; gap: 2px; }
    .gain-in { margin-left: auto; font-weight: 700; }
    .gain-in::before { display: none; }
    .parts .v-row .s { font-weight: 600; }
    .attention .imp { font-size: 13.5px; white-space: nowrap; }
    .attention .v-row .s { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    @media (max-width: 360px) { .hide-xs { display: none; } }
    @media (min-width: 1000px) {
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
  ov = inject(OverviewService).data;
  perf = signal<Performance | null>(null);

  empty = computed(() => {
    const p = this.store.portfolio();
    return !!p && !p.positions.length;
  });
  groups = computed<GroupRow[]>(() => (this.ov()?.groups ?? []).filter(g => g.value > 0.5 || (g.target ?? 0) > 0));
  donut = computed(() => this.groups().map(g => ({ value: g.value, color: this.hex(g.key), label: g.label })));
  offTarget = computed(() => this.groups().filter(g => g.gap !== null && Math.abs(g.gap) >= 1).length);
  attention = computed<Suggestion[]>(() => (this.ov()?.suggestions ?? []).slice(0, 3));
  pricesAge = computed(() => ago(this.store.portfolio()?.prices?.last_refresh));

  growth = computed(() => {
    const s = this.perf()?.series ?? [];
    return { value: s.map(p => p.value), invested: s.map(p => p.net_invested), ticks: monthTicks(s.map(p => p.date)) };
  });
  heroSpark = computed(() => this.growth().value.slice(-60));

  constructor() {
    effect(() => {
      const r = this.range();
      this.store.version();
      untracked(() => void this.loadPerf(r));
    });
  }

  private async loadPerf(r: Range) {
    try {
      this.perf.set(await firstValueFrom(this.api.performance(r)));
    } catch { this.perf.set(null); }
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
