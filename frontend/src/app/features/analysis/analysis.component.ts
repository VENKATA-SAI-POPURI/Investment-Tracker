import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom, map } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/http';
import { money, monthTicks, pctV } from '../../core/format';
import { GROUP_HEX, GROUPS, GroupKey, groupMeta } from '../../core/groups';
import { Contributor2, GroupRebalance, GroupRow, Performance, Suggestion } from '../../core/models';
import { OverviewService } from '../../core/overview.service';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { TiltDirective } from '../../shared/v2/spatial';
import { AreaChartComponent, DonutComponent } from '../../shared/v2/charts';
import { HoldingSheetComponent } from '../../shared/v2/holding-sheet.component';
import { GroupSheetComponent } from '../../shared/v2/group-sheet.component';

type Tab = 'mix' | 'returns' | 'market' | 'improve';
type Range = '3M' | '1Y' | '3Y' | 'ALL';
const PROFILES = [
  { key: 'conservative', label: 'Careful' }, { key: 'balanced', label: 'Balanced' },
  { key: 'growth', label: 'Growth' }, { key: 'aggressive', label: 'Bold' },
];

/** Analysis: how the money is spread, how it has done, how that compares with the market, and what to do next. */
@Component({
  selector: 'app-analysis',
  standalone: true,
  imports: [FormsModule, IconComponent, AreaChartComponent, DonutComponent, HoldingSheetComponent, GroupSheetComponent, TiltDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="v2">
    <nav class="v-seg" role="tablist" aria-label="Analysis">
      @for (t of tabs; track t.key) { <button role="tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="setTab(t.key)">{{ t.label }}</button> }
    </nav>

    @switch (tab()) {
    <!-- ══ MIX ══ -->
    @case ('mix') {
      <div class="v-grid cols-2">
      <section class="v-card">
        <div class="v-ch"><h2>Actual vs target</h2>
          @if (auth.canWrite() && !editing()) { <button class="v-link" (click)="startEdit()"><app-icon name="edit" [size]="14" /> Edit targets</button> }</div>
        @if (!editing()) {
          <div class="v-seg soft" style="margin-bottom:8px">
            <button [class.on]="targetSet() === 'mine'" (click)="targetSet.set('mine')">My targets</button>
            <button [class.on]="targetSet() === 'suggested'" (click)="targetSet.set('suggested')">Suggested · {{ profileLabel() }}</button>
          </div>
          @if (targetSet() === 'mine' && !ov()?.targets?.has_mine) {
            <div class="v-note info"><app-icon name="target2" [size]="18" /> You haven't set a target mix yet. Start from the suggested one, or set your own.</div>
          }
          @for (r of mixRows(); track r.key) {
            <div class="mrow" [style.--c]="r.hex">
              <span class="v-ic sm"><app-icon [name]="r.icon" [size]="15" /></span>
              <div class="grow"><div class="nm"><span>{{ r.label }}</span><span><b>{{ r.pct.toFixed(1) }}%</b><span class="v-mut"> / {{ r.target === null ? '—' : r.target + '%' }}</span></span></div>
                <div class="v-track"><b [style.width.%]="(r.pct / scale()) * 100"></b>@if (r.target !== null) { <i [style.left.%]="(r.target / scale()) * 100"></i> }</div></div>
              @if (r.target !== null) { <span class="gap" [class.u]="r.gap! <= -1" [class.k]="r.gap! > -1 && r.gap! < 1">{{ gapText(r.gap!) }}</span> }
            </div>
          }
          <div class="v-mut mark"><span></span>marks the target</div>
          @if (targetSet() === 'suggested') {
            <div class="how">
              <div class="v-mut">{{ ov()?.targets?.suggested?.how }}</div>
              @if (auth.canWrite()) {
                <div class="profiles">@for (p of profiles; track p.key) { <button class="v-btn sm" [class.dark]="profile() === p.key" (click)="setProfile(p.key)">{{ p.label }}</button> }</div>
                <label class="age">Your age <input class="v-input" type="number" min="18" max="90" [ngModel]="age()" (change)="setAge($any($event.target).value)" /></label>
                <button class="v-btn primary" (click)="useSuggested()" [disabled]="saving()">Use these as my targets</button>
              }
            </div>
          }
        } @else {
          <p class="v-mut" style="margin:0 0 8px;font-size:13px">Share of everything you own, per group. EPF counts too.</p>
          @for (g of groups; track g.key) {
            <label class="erow" [style.--c]="hex(g.key)"><span class="v-ic sm"><app-icon [name]="g.icon" [size]="15" /></span><span class="grow">{{ g.label }}</span>
              <input class="v-input" type="number" min="0" max="100" step="0.5" [(ngModel)]="draft[g.key]" (ngModelChange)="draftTick.set(draftTick() + 1)" /><span>%</span></label>
          }
          <div class="etotal" [class.bad]="Math.abs(draftTotal() - 100) > 0.5">Total {{ draftTotal().toFixed(1) }}% {{ Math.abs(draftTotal() - 100) > 0.5 ? '· must be 100%' : '✓' }}</div>
          <div class="row" style="gap:8px"><button class="v-btn primary" (click)="saveTargets()" [disabled]="saving() || Math.abs(draftTotal() - 100) > 0.5">Save</button>
            <button class="v-btn" (click)="editing.set(false)">Cancel</button></div>
        }
      </section>

      <section class="v-card">
        <div class="v-ch"><h2>Rebalance plan</h2><span class="v-pill" [class.ok]="!allowSell()" [class.warn]="allowSell()">{{ allowSell() ? 'With selling' : 'No selling' }}</span></div>
        <label class="money"><span class="v-mut">New money</span><span class="inp">₹<input type="number" min="0" step="1000" [style.width.ch]="String(newMoney()).length + 1.5" [ngModel]="newMoney()" (ngModelChange)="newMoney.set(+$event || 0)" aria-label="New money to invest" /></span></label>
        <div class="quick">@for (q of quick; track q) { <button class="v-btn sm" [class.dark]="newMoney() === q" (click)="newMoney.set(q)">{{ money(q) }}</button> }</div>
        @if (rebalance(); as rb) {
          @for (r of rbRows(); track r.key) {
            <div class="v-row" [style.--c]="hex(r.key)">
              <span class="v-ic"><app-icon [name]="meta(r.key).icon" [size]="17" /></span>
              <div class="grow"><div class="t">{{ r.label }}</div><div class="s">{{ r.current_pct.toFixed(1) }}% → {{ r.after_pct.toFixed(1) }}%{{ r.let_mature ? ' · left to mature' : r.locked ? ' · locked' : '' }}</div>
                @if (r.sells?.length) { <div class="s">Sell {{ sellNames(r) }}{{ r.tax ? ' · tax ≈ ' + money(r.tax) : '' }}</div> }</div>
              <span class="amt" [class.buy]="r.action === 'buy'" [class.sell]="r.action === 'sell'">{{ r.action === 'buy' ? '+ ' : '− ' }}{{ money(r.amount) }}</span>
            </div>
          } @empty { <p class="v-empty">{{ newMoney() || allowSell() ? 'Already on target.' : 'Enter an amount to see where it should go.' }}</p> }
          @if (rb.tax_total) { <div class="v-note warn" style="margin-top:8px"><app-icon name="receipt" [size]="18" /> Estimated tax on these sales: {{ money(rb.tax_total) }}</div> }
        } @else if (rbError()) { <p class="v-empty">{{ rbError() }}</p> }
        <label class="toggle"><span><b>Also sell what's over target</b><small class="v-mut">Lowest tax first; shows the tax on each sale</small></span>
          <input type="checkbox" [ngModel]="allowSell()" (ngModelChange)="allowSell.set($event)" /><span class="sw" aria-hidden="true"></span></label>
        <p class="v-mut foot">EPF can't be topped up or sold; FDs and P2P loans are left to mature.</p>
      </section>
      </div>
    }

    <!-- ══ RETURNS ══ -->
    @case ('returns') {
      <section class="v-card">
        <div class="v-ch"><h2>{{ rangeTitle() }}</h2>
          <div class="v-chips">@for (r of ranges; track r) { <button [class.on]="range() === r" (click)="range.set(r)">{{ r === 'ALL' ? 'All' : r }}</button> }</div></div>
        <div class="v-kpis">
          <div><small>Gain</small><b [class.v-gain]="(perf()?.metrics?.gain ?? 0) >= 0" [class.v-loss]="(perf()?.metrics?.gain ?? 0) < 0">{{ money(perf()?.metrics?.gain, true) }}</b></div>
          @if (range() === '3M') { <div><small>Return (3 months)</small><b>{{ pctV(perf()?.metrics?.twr) }}</b></div> }
          @else { <div><small>Return a year</small><b>{{ pctV(perf()?.metrics?.xirr) }}</b></div> }
          <div><small>Worst fall</small><b>{{ pctV(perf()?.metrics?.max_drawdown) }}</b></div>
        </div>
        <div style="margin-top:12px"><v-area [a]="growth().value" [b]="growth().invested" [labels]="growth().ticks" [h]="120" label="Value against money invested" /></div>
        <div class="v-legend"><span style="--c:var(--chart-a)">Value</span><span style="--c:var(--chart-b)">Money invested</span></div>
      </section>
      <div class="v-grid cols-3">
      <section class="v-card">
        <div class="v-ch"><h2>Return by group</h2><span class="hint">per year, since you started</span></div>
        @for (g of byReturn(); track g.key) {
          <div class="rbar" [style.--c]="hex(g.key)" (click)="explain.set(g.key)" style="cursor:pointer"><span class="v-ic sm"><app-icon [name]="meta(g.key).icon" [size]="15" /></span><span class="nm">{{ g.label }}</span>
            <div class="bb"><b [style.width.%]="barW(g.xirr)" [class.neg]="(g.xirr ?? 0) < 0"></b></div><span class="v">{{ pctV(g.xirr) }}</span></div>
        }
      </section>
      <section class="v-card">
        <div class="v-ch"><h2>Pulling ahead</h2><span class="hint">gain · {{ range() === 'ALL' ? 'all time' : range() }}</span></div>
        @for (c of ahead(); track c.id; let i = $index) {
          <button class="v-row" (click)="holding.set(c.id)"><span class="rn up">{{ i + 1 }}</span><div class="grow"><div class="t">{{ c.name }}</div><div class="s">{{ meta(c.group).label }}</div></div>
            <div class="r"><b class="v-gain">{{ money(c.gain, true) }}</b></div></button>
        } @empty { <p class="v-empty">Nothing gained in this period.</p> }
      </section>
      <section class="v-card">
        <div class="v-ch"><h2>Holding you back</h2><span class="hint">gain · {{ range() === 'ALL' ? 'all time' : range() }}</span></div>
        @for (c of behind(); track c.id; let i = $index) {
          <button class="v-row" (click)="holding.set(c.id)"><span class="rn down">{{ i + 1 }}</span><div class="grow"><div class="t">{{ c.name }}</div><div class="s">{{ meta(c.group).label }}</div></div>
            <div class="r"><b [class.v-loss]="c.gain < 0" [class.v-mut]="c.gain >= 0">{{ money(c.gain, true) }}</b></div></button>
        } @empty { <p class="v-empty">No laggards in this period.</p> }
      </section>
      </div>
    }

    <!-- ══ VS MARKET ══ -->
    @case ('market') {
      <div class="v-grid cols-2">
      <section class="v-card">
        @if (ov(); as o) {
          <div class="score">
            <v-donut [parts]="[{ value: o.market.groups_ahead, color: '#4ade80' }, { value: Math.max(o.market.groups_compared - o.market.groups_ahead, 0), color: 'rgba(255,255,255,.16)' }]"
              [size]="84" [thickness]="11" [bottom]="o.market.groups_ahead + '/' + o.market.groups_compared" [bottomSize]="19" label="Groups at or above their market" />
            <div><div class="headline">You beat {{ o.market.groups_ahead }} of {{ o.market.groups_compared }} markets</div>
              <div class="v-mut sub">Overall {{ pctV(o.totals.xirr) }} a year vs {{ pctV(o.market.xirr) }} for the same money in each part's own market</div></div>
          </div>
          @if (marketChart(); as mc) {
            <div style="margin-top:14px"><v-area [a]="mc.you" [b]="mc.market" [labels]="mc.ticks" [h]="112" colorB="#f0609e" [dashB]="true" label="Your value against the same money in the market" /></div>
            <div class="v-legend"><span style="--c:var(--chart-a)">You</span><span style="--c:#f0609e">Same money in the market</span></div>
          }
        } @else { <div class="v-skel" style="height:180px"></div> }
      </section>
      <section class="v-card">
        <div class="v-ch"><h2>Each group vs its market</h2></div>
        @for (g of compared(); track g.key) {
          <button class="v-row" (click)="explain.set(g.key)">
            <span class="res" [class.ok]="g.bench?.verdict !== 'behind'" [class.no]="g.bench?.verdict === 'behind'">
              <app-icon [name]="g.bench?.verdict === 'behind' ? 'arrowDownRight' : 'circleCheck'" [size]="15" [stroke]="2.6" /></span>
            <div class="grow"><div class="t">{{ g.label }}</div><div class="s">vs {{ g.bench?.label }}{{ g.bench?.xirr !== null ? ' · ' + pctV(g.bench?.xirr) : '' }}</div></div>
            <div class="r"><b>{{ pctV(g.xirr) }}</b>
              <span class="pct" [class.v-gain]="g.bench?.verdict === 'ahead'" [class.v-loss]="g.bench?.verdict === 'behind'" [class.v-mut]="g.bench?.verdict === 'same' || !g.bench?.verdict">
                {{ g.bench?.verdict === 'same' ? '≈ same' : g.bench?.diff !== null ? pts(g.bench?.diff) : 'no data' }}</span></div>
          </button>
        }
        <p class="v-mut foot">{{ ov()?.market?.note }} Differences are in percentage points (pts): +1 pt is 1% a year more.</p>
      </section>
      </div>
    }

    <!-- ══ IMPROVE ══ -->
    @case ('improve') {
      @if (ov(); as o) {
        <div class="v-mut lead">{{ o.suggestions.length ? o.suggestions.length + ' idea' + (o.suggestions.length > 1 ? 's' : '') + ' · most urgent and biggest first' : '' }}</div>
        <div class="v-grid cols-2">
        @for (s of o.suggestions; track s.id; let i = $index) {
          <section class="v-card sug" vTilt>
            <span class="rk">#{{ i + 1 }}</span>
            <div class="top"><span class="v-tone" [class]="s.tone"><app-icon [name]="s.icon" [size]="20" /></span>
              <div><div class="t">{{ s.title }}</div><div class="s">{{ s.detail }}</div></div></div>
            <div class="ft"><span class="imp" [class]="impactTone(s)">{{ s.impact }}</span><button class="v-btn dark sm" (click)="act(s)">{{ s.cta }}</button></div>
          </section>
        } @empty {
          <section class="v-card v-empty"><span class="v-tone good"><app-icon name="circleCheck" [size]="22" /></span><b style="color:var(--text)">Nothing needs you right now</b>
            <span>Your mix is close to target and nothing is due. Check back after your next entry.</span></section>
        }
        </div>
      } @else { <div class="v-skel" style="height:240px"></div> }
    }
    }
  </div>
  @if (holding(); as id) { <v-holding-sheet [id]="id" (closed)="holding.set(null)" /> }
  @if (explain(); as k) { <v-group-sheet [key]="k" (closed)="explain.set(null)" /> }
  `,
  styles: [`
    .mrow { display: flex; gap: 10px; align-items: center; padding: 8px 0; }
    .mrow .grow { min-width: 0; flex: 1; }
    .mrow .nm { font-size: 13.5px; font-weight: 600; display: flex; justify-content: space-between; margin-bottom: 6px; gap: 6px; }
    .mrow .nm b { font-weight: 800; }
    .gap { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 6px; min-width: 42px; text-align: center; background: var(--bg); color: var(--text-2); }
    .gap.u { background: var(--warn-soft); color: var(--warn); } .gap.k { background: var(--pos-soft); color: var(--pos); }
    .mark { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; margin-top: 4px; }
    .mark span { width: 3px; height: 12px; background: var(--ink); border-radius: 2px; }
    .how { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 13px; }
    .profiles { display: flex; gap: 6px; flex-wrap: wrap; }
    .age { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 13px; }
    .age .v-input { width: 90px; padding: 8px 10px; }
    .erow { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-weight: 600; font-size: 14px; }
    .erow .grow { flex: 1; }
    .erow .v-input { width: 86px; text-align: right; padding: 8px 10px; }
    .etotal { font-weight: 700; margin: 10px 0; color: var(--pos); } .etotal.bad { color: var(--neg); }
    .money { display: flex; align-items: center; justify-content: space-between; background: var(--bg); border-radius: 16px; padding: 10px 14px; font-weight: 600; }
    .money .inp { display: flex; align-items: center; font-size: 22px; font-weight: 800; }
    .money input { font: inherit; min-width: 3ch; max-width: 12ch; border: 0; background: none; text-align: left; outline: none; color: var(--text); margin-left: 2px; }
    .quick { display: flex; gap: 6px; margin: 10px 0 4px; flex-wrap: wrap; }
    .amt { margin-left: auto; font-weight: 800; border-radius: 10px; padding: 5px 9px; font-size: 13.5px; white-space: nowrap; }
    .amt.buy { color: var(--pos); background: var(--pos-soft); } .amt.sell { color: var(--neg); background: var(--neg-soft); }
    .toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0 4px; border-top: 1px solid var(--border); margin-top: 6px; cursor: pointer; }
    .toggle span:first-child { display: flex; flex-direction: column; } .toggle small { font-size: 12px; font-weight: 500; }
    .toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .sw { width: 44px; height: 26px; border-radius: 99px; background: var(--border-strong); position: relative; flex: none; transition: background .15s; }
    .sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); transition: left .15s; }
    .toggle input:checked + .sw { background: var(--accent); } .toggle input:checked + .sw::after { left: 21px; }
    .foot { font-size: 12px; margin: 8px 0 0; font-weight: 500; }
    .rbar { display: grid; grid-template-columns: 28px 96px minmax(0, 1fr) 52px; gap: 8px; align-items: center; padding: 5px 0; font-size: 13px; font-weight: 600; }
    .rbar .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rbar .bb b { display: block; height: 20px; border-radius: 7px; background: color-mix(in srgb, var(--c) 85%, white); min-width: 4px; }
    .rbar .bb b.neg { background: var(--neg-soft); }
    .rbar .v { text-align: right; font-weight: 800; }
    .rn { width: 26px; height: 26px; border-radius: 9px; display: grid; place-items: center; font-size: 12px; font-weight: 800; flex: none; }
    .rn.up { background: var(--pos-soft); color: var(--pos); } .rn.down { background: var(--neg-soft); color: var(--neg); }
    .score { display: flex; align-items: center; gap: 14px; }
    .headline { font-size: 18px; font-weight: 800; letter-spacing: -.02em; }
    .sub { font-size: 13px; font-weight: 500; }
    .res { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; flex: none; }
    .res.ok { background: var(--pos-soft); color: var(--pos); } .res.no { background: var(--neg-soft); color: var(--neg); }
    .pct { font-size: 12.5px; font-weight: 700; }
    .lead { font-size: 13px; font-weight: 600; margin: 0 4px; }
    .sug { position: relative; }
    .sug .rk { position: absolute; right: 14px; top: 12px; font-size: 11px; font-weight: 800; color: var(--muted); }
    .sug .top { display: flex; gap: 12px; padding-right: 22px; }
    .sug .t { font-weight: 800; font-size: 15px; letter-spacing: -.01em; }
    .sug .s { font-size: 13px; color: var(--muted); margin-top: 2px; font-weight: 500; }
    .sug .ft { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; gap: 8px; }
    .imp { font-size: 12.5px; font-weight: 800; padding: 6px 10px; border-radius: 10px; }
    .imp.good { background: var(--pos-soft); color: var(--pos); } .imp.warn { background: var(--warn-soft); color: var(--warn); }
    .imp.bad { background: var(--neg-soft); color: var(--neg); } .imp.info { background: var(--info-soft); color: var(--info); }
  `],
})
export class AnalysisComponent {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  store = inject(StoreService);
  auth = inject(AuthService);
  ov = inject(OverviewService).data;

  Math = Math; String = String; money = money; pctV = pctV; meta = groupMeta; groups = GROUPS; profiles = PROFILES;
  hex = (k: string) => GROUP_HEX[k as GroupKey] ?? '#9aa3b8';
  tabs: { key: Tab; label: string }[] = [{ key: 'mix', label: 'Mix' }, { key: 'returns', label: 'Returns' }, { key: 'market', label: 'vs Market' }, { key: 'improve', label: 'Improve' }];
  ranges: Range[] = ['3M', '1Y', '3Y', 'ALL'];
  quick = [10000, 25000, 50000, 100000];

  tab = toSignal(this.route.queryParamMap.pipe(map(q => (['mix', 'returns', 'market', 'improve'].includes(q.get('tab') ?? '') ? q.get('tab') : 'mix') as Tab)),
    { initialValue: 'mix' as Tab });
  holding = signal<number | null>(null);
  explain = signal<string | null>(null);
  pts = (v: number | null | undefined) => v === null || v === undefined ? '—' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' pts';

  // ── mix ──
  targetSet = signal<'mine' | 'suggested'>('mine');
  editing = signal(false);
  saving = signal(false);
  draft: Record<string, number> = {};
  draftTick = signal(0);
  draftTotal = computed(() => { this.draftTick(); return GROUPS.reduce((s, g) => s + (+this.draft[g.key] || 0), 0); });
  newMoney = signal(25000);
  allowSell = signal(false);
  rebalance = signal<GroupRebalance | null>(null);
  rbError = signal<string | null>(null);
  profile = computed(() => this.store.settings().riskProfile || this.ov()?.targets?.suggested?.profile || 'balanced');
  profileLabel = computed(() => PROFILES.find(p => p.key === this.profile())?.label ?? 'Balanced');
  age = computed(() => (this.store.settings().retirementPlan as Record<string, number> | undefined)?.['current_age'] ?? null);

  mixRows = computed(() => {
    const o = this.ov();
    if (!o) return [];
    const set = this.targetSet() === 'mine' ? o.targets.mine : o.targets.suggested.mix;
    return o.groups.filter(g => g.value > 0.5 || (set?.[g.key] ?? 0) > 0).map(g => {
      const target = set ? +(set[g.key] ?? 0) : null;
      return { key: g.key, label: g.label, icon: groupMeta(g.key).icon, hex: this.hex(g.key), pct: g.pct, target, gap: target === null ? null : g.pct - target };
    });
  });
  scale = computed(() => Math.max(10, ...this.mixRows().map(r => Math.max(r.pct, r.target ?? 0))) * 1.12);
  rbRows = computed(() => (this.rebalance()?.rows ?? []).filter(r => r.action !== 'hold' || r.let_mature || r.locked));

  // ── returns ──
  range = signal<Range>('1Y');
  perf = signal<Performance | null>(null);
  private allPerf = signal<Performance | null>(null);
  rangeTitle = computed(() => ({ '3M': 'Last 3 months', '1Y': 'Last 12 months', '3Y': 'Last 3 years', ALL: 'Since you started' })[this.range()]);
  growth = computed(() => {
    const s = this.perf()?.series ?? [];
    return { value: s.map(p => p.value), invested: s.map(p => p.net_invested), ticks: monthTicks(s.map(p => p.date)) };
  });
  byReturn = computed(() => [...(this.ov()?.groups ?? [])].filter(g => g.value > 0.5 && g.xirr !== null).sort((a, b) => (b.xirr ?? 0) - (a.xirr ?? 0)));
  private maxRet = computed(() => Math.max(1, ...this.byReturn().map(g => Math.abs(g.xirr ?? 0))));
  barW = (x: number | null) => (Math.abs(x ?? 0) / this.maxRet()) * 100;
  ahead = computed<Contributor2[]>(() => (this.perf()?.contributors ?? []).filter(c => c.gain > 0).slice(0, 3));
  behind = computed<Contributor2[]>(() => [...(this.perf()?.contributors ?? [])].sort((a, b) => a.gain - b.gain)
    .filter(c => !this.ahead().some(x => x.id === c.id)).slice(0, 3));

  // ── vs market ──
  compared = computed<GroupRow[]>(() => (this.ov()?.groups ?? []).filter(g => g.bench && g.value > 0.5));
  marketChart = computed(() => {
    const m = this.ov()?.market?.series ?? [];
    const s = this.allPerf()?.series ?? [];
    if (m.length < 3 || s.length < 3 || m.some(x => x.market === null)) return null;
    let j = 0;
    const you: number[] = [], market: number[] = [], dates: string[] = [];
    for (const x of m) {
      while (j + 1 < s.length && s[j + 1].date <= x.date) j++;
      if (s[j].date > x.date) continue;
      you.push(s[j].value); market.push(x.market!); dates.push(x.date);
    }
    return you.length > 2 ? { you, market, ticks: monthTicks(dates) } : null;
  });

  constructor() {
    effect(() => {
      const r = this.range();
      this.store.version();
      untracked(() => {
        const key = snapshotKey('perf', this.store.scopeKey(), r);
        const snap = readSnapshot<Performance>(key);
        if (snap) this.perf.set(snap);
        void firstValueFrom(this.api.performance(r)).then(p => { this.perf.set(p); writeSnapshot(key, p); })
          .catch(() => { if (!snap) this.perf.set(null); });
      });
    });
    effect(() => {
      if (this.tab() !== 'market') return;
      this.store.version();
      untracked(() => {
        const key = snapshotKey('perf', this.store.scopeKey(), 'ALL');
        const snap = readSnapshot<Performance>(key);
        if (snap) this.allPerf.set(snap);
        void firstValueFrom(this.api.performance('ALL')).then(p => { this.allPerf.set(p); writeSnapshot(key, p); })
          .catch(() => { if (!snap) this.allPerf.set(null); });
      });
    });
    effect(() => {
      const money = this.newMoney(), sell = this.allowSell(), set = this.targetSet();
      this.ov();
      if (this.tab() !== 'mix') return;
      const useSet = set === 'mine' && !this.ov()?.targets?.has_mine ? 'suggested' : set;
      untracked(() => void this.loadRebalance(money, sell, useSet));
    });
  }

  private rbSeq = 0;
  private async loadRebalance(money: number, sell: boolean, set: 'mine' | 'suggested') {
    const n = ++this.rbSeq;
    try {
      const r = await firstValueFrom(this.api.groupRebalance(money, sell, set));
      if (n === this.rbSeq) { this.rebalance.set(r); this.rbError.set(null); }
    } catch (e) { if (n === this.rbSeq) { this.rebalance.set(null); this.rbError.set(errorMessage(e)); } }
  }

  setTab(t: Tab) { void this.router.navigate([], { queryParams: { tab: t }, queryParamsHandling: 'merge', replaceUrl: true }); }
  gapText(gap: number) { return Math.abs(gap) < 1 ? 'on' : (gap > 0 ? '+' : '−') + Math.abs(gap).toFixed(1); }
  sellNames(r: { sells?: { name: string }[] }) { return (r.sells ?? []).map(s => s.name).slice(0, 2).join(', ') + ((r.sells?.length ?? 0) > 2 ? '…' : ''); }

  startEdit() {
    const o = this.ov();
    const base = o?.targets?.mine ?? o?.targets?.suggested?.mix ?? {};
    this.draft = Object.fromEntries(GROUPS.map(g => [g.key, +(base[g.key] ?? 0)]));
    this.draftTick.set(this.draftTick() + 1);
    this.editing.set(true);
  }

  async saveTargets(values?: Record<string, number>) {
    this.saving.set(true);
    try {
      const v = values ?? Object.fromEntries(GROUPS.map(g => [g.key, +this.draft[g.key] || 0]));
      await this.store.saveSetting('groupTargets', v);
      this.editing.set(false);
      this.targetSet.set('mine');
      this.toast.ok('Targets saved');
    } catch (e) { this.toast.error(errorMessage(e)); } finally { this.saving.set(false); }
  }

  useSuggested() { const m = this.ov()?.targets?.suggested?.mix; if (m) void this.saveTargets({ ...m }); }

  async setProfile(key: string) {
    try { await this.store.saveSetting('riskProfile', key); } catch (e) { this.toast.error(errorMessage(e)); }
  }

  async setAge(v: string) {
    const age = Math.round(+v);
    if (!age || age < 18 || age > 90) return;
    const plan = { ...((this.store.settings().retirementPlan as Record<string, number>) ?? {}), current_age: age };
    try { await this.store.saveSetting('retirementPlan', plan); } catch (e) { this.toast.error(errorMessage(e)); }
  }

  impactTone(s: Suggestion) { return s.impact.startsWith('Save') ? 'good' : s.tone; }

  act(s: Suggestion) {
    if (s.instrument_id) { this.holding.set(s.instrument_id); return; }
    if (s.link?.startsWith('/analysis')) {
      const tab = new URLSearchParams(s.link.split('?')[1] ?? '').get('tab') as Tab | null;
      this.setTab(tab ?? 'mix');
      return;
    }
    void this.router.navigateByUrl(s.link || '/');
  }
}
