import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ago, money, monthTicks, pctV } from '../../core/format';
import { GroupRow, Performance, Question, TodoItem } from '../../core/models';
import { linkPath, linkQuery, toneClass } from '../../core/links';
import { OverviewService } from '../../core/overview.service';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { AreaChartComponent, DonutComponent } from '../../shared/v2/charts';
import { GROUP_HEX, GroupKey } from '../../core/groups';
import { GroupSheetComponent } from '../../shared/v2/group-sheet.component';

type Range = '6M' | '1Y' | 'ALL';

/** Home: "How am I doing?" answered in four lines, then the jobs worth doing now (question-led redesign). */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, IconComponent, AreaChartComponent, DonutComponent, GroupSheetComponent],
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
    <div class="top">
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
          <button class="glass" type="button" (click)="explain.set('all')" aria-label="How these numbers are worked out">
            <div><small>Invested</small><b>{{ money(o.totals.put_in) }}</b></div>
            <div><small>Gain</small><b>{{ money(o.totals.gain, true) }}</b></div>
            <div><small>Return / yr <app-icon name="info" [size]="12" [stroke]="2.4" /></small><b>{{ pctV(o.totals.xirr) }}</b></div>
          </button>
        } @else {
          <div class="big" style="opacity:.6">—</div><div class="glass"><div style="height:44px"></div><div></div><div></div></div>
        }
        <button class="prices" type="button" (click)="store.refreshPrices(true)" [disabled]="store.refreshingPrices()"
          [attr.aria-label]="'Prices updated ' + pricesAge() + '. Refresh'">
          <app-icon name="refresh" [size]="12" [stroke]="2.4" /> {{ store.refreshingPrices() ? 'Updating…' : pricesAge() }}
        </button>
      </section>

      <!-- mix: where the money sits against the targets -->
      <section class="v-card mixcard">
        <div class="v-ch"><h2>Your mix</h2><span class="hint">{{ ov()?.targets?.has_mine ? 'vs your target' : 'share of everything' }}</span></div>
        <div class="mix">
          <v-donut [parts]="donut()" [size]="132" [thickness]="18" [top]="groups().length + ' groups'" [bottom]="money(ov()?.totals?.value)" label="Share of each group" />
          <div class="mixleg">
            @for (g of groups(); track g.key) {
              <a class="lg" routerLink="/portfolio" [queryParams]="{ group: g.key }"><span class="d" [style.background]="hex(g.key)"></span><span class="nm">{{ g.label }}</span><b>{{ g.pct.toFixed(0) }}%</b>
                @if (g.gap !== null) { <span class="dl" [class.u]="g.gap <= -1" [class.o]="g.gap >= 1" [class.k]="g.gap > -1 && g.gap < 1">{{ gapText(g.gap) }}</span> } @else { <span></span> }
              </a>
            } @empty { <div class="v-skel" style="height:120px"></div> }
          </div>
        </div>
        <a class="foot" routerLink="/analysis" [queryParams]="{ q: 'mix' }">
          <span>{{ ov()?.targets?.has_mine ? (offTarget() ? offTarget() + ' group' + (offTarget() > 1 ? 's are' : ' is') + ' off target' : 'On target') : 'Set your target mix' }}</span>
          <span class="go">{{ ov()?.targets?.has_mine ? (offTarget() ? 'Fix it' : 'Details') : 'Set targets' }} <app-icon name="chevronRight" [size]="16" [stroke]="2.4" /></span>
        </a>
      </section>

      <!-- growth (desktop sits beside the hero; phone shows it last) -->
      <section class="v-card growth">
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
    </div>

    <div class="cols">
      <div class="col qcol">
        <div class="v-sec"><h2>How am I doing?</h2><a class="v-link" routerLink="/analysis">All questions <app-icon name="chevronRight" [size]="15" [stroke]="2.4" /></a></div>
        <section class="v-card tight">
          @for (q of questions(); track q.id) {
            <a class="v-row v-q" [routerLink]="path(q.link)" [queryParams]="query(q.link)">
              <span class="v-tone" [class]="toneClass(q.tone)"><app-icon [name]="q.icon" [size]="20" /></span>
              <div class="grow"><div class="qq">{{ q.q }}</div><div class="qa">{{ q.answer }}</div><div class="qd">{{ q.detail }}</div></div>
              <app-icon class="chev" name="chevronRight" [size]="18" [stroke]="2.2" />
            </a>
          } @empty {
            @for (i of [1, 2, 3, 4]; track i) { <div class="v-skel" style="height:64px;margin:12px 0"></div> }
          }
        </section>
      </div>

      <div class="col tcol">
        @if (todo().length) {
          <div class="v-sec"><h2>To do</h2><span class="hint">{{ todo().length }} {{ todo().length === 1 ? 'thing' : 'things' }}</span></div>
          <section class="v-card tight">
            @for (t of todo(); track t.id) {
              <div class="v-row v-todo">
                <span class="v-tone" [class]="toneClass(t.tone)"><app-icon [name]="t.icon" [size]="20" /></span>
                <div class="grow"><div class="tt">{{ t.title }}</div>@if (t.detail) { <div class="td">{{ t.detail }}</div> }
                  @if (t.steps) { <div class="steps"><i class="d"></i>@for (i of stepsOf(t.steps); track $index) { <i></i> } <span>{{ t.steps }} steps · 2 min</span></div> }
                </div>
                <a class="v-btn sm" [class.primary]="$first" [routerLink]="path(t.link)" [queryParams]="query(t.link)">{{ t.cta }}</a>
              </div>
            }
          </section>
        } @else if (answers()) {
          <div class="v-sec"><h2>To do</h2></div>
          <section class="v-card v-empty"><span class="v-tone good"><app-icon name="checkCircle" [size]="22" /></span>
            <b>Nothing needs you right now</b><span>New jobs show up here when something is due, late or off target.</span></section>
        }
      </div>
    </div>
    }
  </div>
  @if (explain(); as k) { <v-group-sheet [key]="k" (closed)="explain.set(null)" /> }
  `,
  styles: [`
    .top { display: grid; gap: 20px; }
    @media (min-width: 1000px) {
      .top { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); }
      .top .growth { grid-column: 1 / -1; }
      .top .growth v-area { min-height: 150px; }
    }
    @media (min-width: 1500px) {
      .top { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.15fr); }
      .top .growth { grid-column: auto; }
    }
    .top > .v-card { display: flex; flex-direction: column; }
    .cols { display: grid; gap: 4px; }
    @media (min-width: 1000px) { .cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; } }
    .col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    /* phone and tablet: one column in the order hero, questions, mix, to do, growth */
    @media (max-width: 999px) {
      .v2 { display: flex; flex-direction: column; }
      .top, .cols { display: contents; }
      .v-hero { order: 1; } .qcol { order: 2; } .mixcard { order: 3; } .tcol { order: 4; } .growth { order: 5; }
    }
    .mix { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 18px; align-items: center; flex: 1; }
    .mixleg { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .lg { display: grid; grid-template-columns: 10px minmax(0, 1fr) 40px 46px; gap: 8px; align-items: center; font-size: 13.5px; padding: 4px 6px;
      margin: 0 -6px; border-radius: 8px; font-weight: 500; min-width: 0; color: inherit; text-decoration: none; transition: background .15s ease; }
    .lg:hover { background: var(--surface-2); text-decoration: none; }
    .lg .d { width: 10px; height: 10px; border-radius: 3px; }
    .lg .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
    .lg b { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
    .dl { font-size: 11px; font-weight: 700; padding: 2px 0; border-radius: 6px; text-align: center; background: var(--surface-3); color: var(--text-2); font-variant-numeric: tabular-nums; }
    .dl.u { background: var(--warn-soft); color: var(--warn); } .dl.o { background: rgba(96,165,250,.14); color: #93c5fd; } .dl.k { background: var(--pos-soft); color: var(--pos); }
    .foot { display: flex; align-items: center; justify-content: space-between; background: var(--accent-soft); border: 1px solid rgba(99,102,241,.3); border-radius: 14px;
      padding: 11px 14px; margin-top: 16px; font-size: var(--fs-small); font-weight: 700; color: var(--accent-strong); text-decoration: none; transition: background .2s ease; }
    .foot:hover { background: rgba(99,102,241,.24); text-decoration: none; }
    .foot .go { display: inline-flex; align-items: center; gap: 2px; }
    @media (max-width: 480px) {
      .mix { grid-template-columns: 108px minmax(0, 1fr); gap: 12px; }
      .mix v-donut svg { width: 108px; height: 108px; }
      .lg { grid-template-columns: 9px minmax(0, 1fr) 36px 44px; gap: 6px; font-size: 12.5px; }
    }
    .v-hero { display: flex; flex-direction: column; min-height: 240px; }
    .harea { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 46%; z-index: -1; pointer-events: none; opacity: .9; }
    .chipw { align-self: flex-start; }
    button.glass { margin-top: auto; font: inherit; color: inherit; border: 0; background: none; padding: 0; text-align: left; cursor: pointer; width: 100%; }
    button.glass small { display: inline-flex; align-items: center; gap: 4px; }
    .prices { position: absolute; top: 16px; right: 16px; display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px;
      font-weight: 700; color: #fff; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.16); border-radius: 99px; padding: 5px 11px;
      cursor: pointer; transition: background .2s ease; }
    .prices:hover { background: rgba(255,255,255,.22); }
    @media (max-width: 999px) { .v-hero { min-height: 250px; } button.glass { margin-top: 56px; } }
    .gain-in { margin-left: auto; font-weight: 700; }
    .gain-in::before { display: none; }
    .hint { font-size: var(--fs-small); color: var(--muted); font-weight: 600; }
  `],
})
export class HomeComponent {
  private api = inject(ApiService);
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);

  money = money;
  pctV = pctV;
  ranges: Range[] = ['6M', '1Y', 'ALL'];

  range = signal<Range>('1Y');
  explain = signal<string | null>(null);
  ov = inject(OverviewService).data;
  perf = signal<Performance | null>(null);

  empty = computed(() => {
    const p = this.store.portfolio();
    return !!p && !p.positions.length;
  });
  answers = inject(OverviewService).answers;
  /** Home asks the first four questions; Analysis lists them all. */
  questions = computed<Question[]>(() => (this.answers()?.questions ?? []).slice(0, 4));
  todo = computed<TodoItem[]>(() => (this.answers()?.todo ?? []).slice(0, 5));
  groups = computed<GroupRow[]>(() => (this.ov()?.groups ?? []).filter(g => g.value > 0.5 || (g.target ?? 0) > 0));
  donut = computed(() => this.groups().map(g => ({ value: g.value, color: this.hex(g.key), label: g.label })));
  offTarget = computed(() => this.groups().filter(g => g.gap !== null && Math.abs(g.gap) >= 2).length);
  hex = (k: string) => GROUP_HEX[k as GroupKey] ?? '#94a3b8';
  gapText = (gap: number) => Math.abs(gap) < 1 ? 'on' : (gap > 0 ? '+' : '−') + Math.abs(gap).toFixed(1);
  toneClass = toneClass;
  path = linkPath;
  query = linkQuery;
  stepsOf = (n: number) => Array.from({ length: Math.max(n - 1, 0) });
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
  pricesAge = computed(() => ago(this.store.portfolio()?.prices?.last_refresh));

  growth = computed(() => {
    const s = this.perf()?.series ?? [];
    return { value: s.map(p => p.value), invested: s.map(p => p.net_invested), ticks: monthTicks(s.map(p => p.date)) };
  });
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
}
