import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { AllocationRow, Brief, OptimizerResult, PortfolioRisk, Position, RiskProfileKey, SegmentSummary, Status, StressTest } from '../../core/models';
import { readSnapshot, snapshotKey } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../../shared/icon.component';
import { PortfolioTabsComponent } from '../../shared/portfolio-tabs.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META, vitalOf } from '../../shared/priority/priority';
import { RebalancePlannerComponent } from '../../shared/rebalance-planner.component';
import { AllocationLabComponent, FrontierChartComponent, driftStatus } from './allocation-lab.component';
import { CorrelationHeatComponent, RiskComponent } from './risk.component';
import { StressComponent } from './stress.component';

/** The page's anchors, in SPEC §5.6 order (profile → target → gap → stress → evidence → detail). */
export const RISK_SECTIONS: { id: string; label: string }[] = [
  { id: 'profile', label: 'Risk profile' },
  { id: 'mix', label: 'Target mix' },
  { id: 'rebalance', label: 'Get back on target' },
  { id: 'stress', label: 'Stress test' },
  { id: 'risk', label: 'Where the risk comes from' },
  { id: 'concentration', label: 'Concentration' },
];
const IDS = new Set(RISK_SECTIONS.map(s => s.id));

/** How long the page keeps a linked section in view while the sections above it are still loading. */
const SETTLE_MS = 4000;

const PROFILE_KEYS: RiskProfileKey[] = ['conservative', 'balanced', 'growth', 'aggressive'];
const PROFILE_LABEL: Record<string, string> = { conservative: 'Conservative', balanced: 'Balanced', growth: 'Growth', aggressive: 'Aggressive' };

/** The page's own mirror of `brief._allocation`, for when the brief (or its snapshot) has no `allocation`. */
export function allocationFromSegments(segments: SegmentSummary[] | null | undefined): AllocationRow[] {
  return (segments ?? []).filter(s => s.value > 0 || s.target !== null).map(s => ({
    segment: s.segment, value: s.value, pct: s.pct, target: s.target, drift: s.drift, drift_status: driftStatus(s.target, s.drift),
  }));
}

/**
 * T0 "Off target": the largest |drift| in points, and ₹ off target = Σ|drift| × targeted value / 200 (SPEC §5.6
 * row "allocation"). Drift is measured within the classes that have a target (`portfolio.py` `mix_value`), so the
 * value is theirs alone, not the whole portfolio's: an untargeted EPF balance moves nothing. Each class's share of
 * it matches its `drift:` action (|drift| / 100 × targeted value).
 */
export function offTarget(rows: AllocationRow[]): { pts: number; inr: number; segment: string } | null {
  const set = rows.filter(r => r.target !== null && r.drift !== null);
  if (!set.length) return null;
  const worst = set.reduce((a, b) => (Math.abs(b.drift!) > Math.abs(a.drift!) ? b : a));
  const value = rows.filter(r => r.target !== null).reduce((a, r) => a + Math.max(0, r.value ?? 0), 0);
  const inr = set.reduce((a, r) => a + Math.abs(r.drift!), 0) * value / 200;
  return { pts: Math.abs(worst.drift!), inr, segment: worst.segment };
}

/**
 * R16: the stress payload came back without any β although `/risk` has β to give, so it was built before the risk
 * memo was warm (K11 reads β only from a warm memo). True when some scenario lists holdings, every listed holding's
 * `beta` is null, and the risk payload has at least one holding with a β.
 */
export function stressMissingBeta(s: StressTest | null, r: PortfolioRisk | null): boolean {
  if (!s || !r) return false;
  const hs = s.scenarios.flatMap(x => x.holdings ?? []);
  if (!hs.length || hs.some(h => h.beta !== null && h.beta !== undefined)) return false;
  return (r.holdings ?? []).some(h => typeof h.beta === 'number');
}

type Group = { key: string; pct: number; value: number };

/** Concentration bars from the open positions: Σ value by `key`, as a share of those rows (ported from Performance). */
export function groupBy(rows: Position[], key: 'sector' | 'market_cap' | 'currency'): Group[] {
  const tot = rows.reduce((a, p) => a + p.value, 0) || 1;
  const m = new Map<string, number>();
  for (const p of rows) { const k = p[key] || 'Unclassified'; m.set(k, (m.get(k) ?? 0) + p.value); }
  return [...m.entries()].map(([k, v]) => ({ key: k, pct: (v / tot) * 100, value: v })).sort((a, b) => b.pct - a.pct);
}

/**
 * Portfolio › Risk & mix (`/risk`, SPEC §5.6, AMENDMENTS J8).
 *
 * Order: portfolio tabs → head (h1) → T0 "Risk vs your profile" → strip → the work surface (one `.card`, A21:
 * `#profile` → `#mix` → `#rebalance`) → `#stress` and `#risk` (T2) → `#concentration` and "How holdings move
 * together" (T3, collapsed).
 *
 * Data:
 * - the brief per E20: Home's `snapshotKey('brief', scopeKey)` first, else `api.brief()` without `since`; never
 *   written. After this page saves a setting the snapshot predates it, so the page then reads `api.brief()` itself
 *   (still without writing). T0's verdict is `vitalOf(brief.vitals, 'risk')`; Off target reads `brief.allocation`;
 *   the planner starts from `brief.deploy.suggested` with `net=deploy` (A15).
 * - `GET /optimizer` (profiles, closest profile, frontier), `GET /forecast/stress` (T0's correction tile, #stress)
 *   and `GET /risk` (T0's bad day, #risk, the correlation table), each reloaded when the store's data moves.
 *   `/risk` is requested before `/forecast/stress` (R16), and stress is fetched once more when it came back with
 *   no β although `/risk` has some (`stressMissingBeta`). `GET /optimizer?profile=` is fetched once per chosen
 *   profile for its moves (`moves`: "Let mature", trims with `tax_if_sold`).
 * - Concentration is built from `store.positions()`.
 *
 * Anchors: the router scrolls to the fragment once; `settle` keeps it in view while the sections above load, and a
 * click on the chip already in the URL re-aligns by hand (W4-F8). `#concentration` also opens its block.
 */
@Component({
  selector: 'app-risk-mix',
  standalone: true,
  imports: [RouterLink, IconComponent, PortfolioTabsComponent, NeedsAttentionComponent, EstTagComponent, RebalancePlannerComponent,
    AllocationLabComponent, FrontierChartComponent, StressComponent, RiskComponent, CorrelationHeatComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-portfolio-tabs />
      <div class="page-head">
        <div><h1>Risk &amp; mix</h1><p class="sub">How much risk you carry, the mix you aim for and how to get back to it. Estimates from past prices and long-run assumptions, not promises.</p></div>
      </div>

      @if (empty()) {
        <div class="card"><div class="empty">
          <app-icon name="scale" [size]="28" /><h3>Nothing to measure yet</h3>
          <p>Add your investments to see how much risk you carry and whether your mix matches the profile you want.</p>
          <a class="btn" routerLink="/holdings/all">Go to Holdings</a>
        </div></div>
      } @else {
        <!-- T0: the answer -->
        <section class="kpis rm-kpis" aria-label="Risk vs your profile">
          <div class="kpi hero">
            <span class="label">Risk vs your profile</span>
            @if (!briefReady()) {
              <span class="skeleton rm-skel" style="width:60%"></span><span class="skeleton rm-skel" style="width:85%;height:14px"></span>
            } @else {
              @let h = hero();
              <span class="value" [class.words]="h.words">{{ h.big }}@if (h.est) {<app-est [basis]="volBasis" />}</span>
              @if (h.meta) { <span class="meta">{{ h.meta }}</span> }
              <div class="verdict-line" [attr.data-status]="h.status">
                <app-icon [name]="statusMeta[h.status].icon" [size]="16" />
                <span>{{ h.verdict }}</span>
                @if (h.status === 'unset' && !savedProfile()) {
                  <span class="cta-wrap"><span aria-hidden="true">·</span><a routerLink="/risk" fragment="profile" (click)="jump('profile')">Pick one below</a></span>
                }
                <span class="sr-only">· {{ statusMeta[h.status].word }}</span>
              </div>
            }
            <button type="button" class="more-stats" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">{{ moreStats() ? 'Less' : 'More' }}</button>
          </div>
          <div class="kpi"><span class="chip amber sm"><app-icon name="target" [size]="15" /></span><span class="label">Off target</span>
            @if (off(); as o) {
              <span class="value">{{ o.pts.toFixed(1) }} pts</span>
              <span class="meta">≈ {{ o.inr | inrc }} to move · most in {{ o.segment }}</span>
            } @else if (briefReady()) {
              <span class="value">—</span><span class="meta">No target mix yet · <a routerLink="/risk" fragment="mix" (click)="jump('mix')">set one</a></span>
            } @else { <span class="skeleton rm-skel"></span> }
          </div>
          <div class="kpi"><span class="chip violet sm"><app-icon name="shield" [size]="15" /></span><span class="label">A routine correction</span>
            @if (correction(); as c) {
              <span class="value" [class]="c.impact | sign">{{ c.impact | inrc: true }}<app-est [basis]="stressBasis()" /></span>
              <span class="meta">{{ c.impact_pct | pct }} · most years bring one</span>
            } @else if (stressError() || stress()) {
              <span class="value">—</span><span class="meta">{{ stressError() ? "Couldn't run the stress test" : 'Nothing that moves with markets' }}</span>
            } @else { <span class="skeleton rm-skel"></span> }
          </div>
          <div class="kpi extra" [class.show]="moreStats()"><span class="chip red sm"><app-icon name="arrowDown" [size]="15" /></span><span class="label">A bad day (1 in 20)</span>
            @if (risk(); as r) {
              @if (r.var_95; as v) {
                <span class="value">−{{ v.day | inrc }}<app-est [basis]="varBasis" /></span>
                <span class="meta">{{ v.day_pct }}% of {{ r.total | inrc }} · 1 trading day in 20 could lose more</span>
              } @else { <span class="value">—</span><span class="meta">needs 30 days of prices</span> }
            } @else if (riskError()) {
              <span class="value">—</span><span class="meta">Couldn't measure the risk</span>
            } @else { <span class="skeleton rm-skel"></span> }
          </div>
        </section>

        <!-- T1: needs attention here (J8) -->
        <app-needs-attention [prefixes]="['/risk', '/holding/']"
          [ids]="['risk:above-profile', 'stress:', 'drift:', 'concentration:', 'sector:', 'targets:missing']" />

        <nav class="jump" aria-label="On this page">
          @for (s of sections; track s.id) {
            <a routerLink="/risk" [fragment]="s.id" [class.on]="fragment() === s.id" [attr.aria-current]="fragment() === s.id ? 'location' : null" (click)="jump(s.id)">{{ s.label }}</a>
          }
        </nav>

        <!-- T1 work surface (A21): profile → target mix → get back on target -->
        <div class="card rm-work">
          <app-allocation-lab [opt]="opt()" [error]="optError()" [allocation]="allocation()" [moves]="moves()"
            [profile]="profile()" (profileChange)="pick($event)" (wrote)="onWrote()" (retry)="loadOptimizer()" />

          <section id="rebalance" class="rm-sub" aria-labelledby="rm-rebalance">
            <div class="rm-sub-head">
              <h2 id="rm-rebalance"><app-icon name="scale" [size]="15" /> Get back on target</h2>
              <span class="hint">
                @if (deploy() !== null) {
                  Starts from <b>{{ deploy() | inr }}</b>, the money ready to deploy, without selling. Change the amount or allow selling to plan anything else.
                } @else {
                  Type an amount of new money to see where it should go. Allow selling to see trims and the tax they could cost.
                }
              </span>
            </div>
            @if (briefReady()) {
              <app-rebalance-planner [newMoney]="deploy() ?? 0" [allowSell]="false" [useNet]="deploy() !== null" [riskLink]="false" />
            } @else { <div class="skeleton" style="height:180px" aria-label="Loading the plan"></div> }
          </section>
        </div>

        <!-- T2: explanations -->
        <section id="stress" class="rm-sec" aria-labelledby="rm-stress">
          <div class="rm-sec-head">
            <h2 class="q-head" id="rm-stress"><app-icon name="shield" [size]="14" /> Stress test</h2>
            <span class="explains small muted">Explains: A routine correction</span>
          </div>
          <app-stress [st]="stress()" [error]="stressError()" (retry)="loadStress()" />
        </section>

        <section id="risk" class="rm-sec" aria-labelledby="rm-risk">
          <div class="rm-sec-head">
            <h2 class="q-head" id="rm-risk"><app-icon name="chart" [size]="14" /> Where the risk comes from</h2>
            @if (briefReady()) { <span class="explains small muted">Explains: Risk vs your profile · {{ statusMeta[hero().status].word }}</span> }
          </div>
          <app-risk [r]="risk()" [error]="riskError()" (retry)="loadRisk()" />
        </section>

        <!-- T3: drill-down, collapsed -->
        <details class="more rm-sec" id="concentration" [open]="concOpen()" (toggle)="onToggle($event, 'conc')">
          <summary>Concentration: largest holdings, stock sectors and company size</summary>
          @if (concOpen()) {
            <p class="muted small conc-line">Top 5 holdings {{ top5() | pct: 0 : false }} of what you hold · {{ usdShare() | pct: 0 : false }} in US dollars</p>
            <div class="grid grid-3">
              <div class="card">
                <div class="card-head"><h3>Largest holdings</h3></div>
                <div class="bars">
                  @for (r of top(); track r.id) {
                    <a class="bar-row" [routerLink]="['/holding', r.id]"><span class="ellipsis">{{ r.key }}</span>
                      <span class="track" aria-hidden="true"><span [style.width.%]="r.pct / maxPct(top()) * 100"></span></span><span class="num right">{{ r.pct | pct: 1 : false }}</span></a>
                  } @empty { <p class="muted small">No open holdings.</p> }
                </div>
              </div>
              <div class="card">
                <div class="card-head"><h3>Stock sectors</h3></div>
                <div class="bars">
                  @for (r of sectors(); track r.key) {
                    <div class="bar-row" [title]="(r.value | inr)"><span class="ellipsis">{{ r.key }}</span><span class="track" aria-hidden="true"><span [style.width.%]="r.pct / maxPct(sectors()) * 100"></span></span><span class="num right">{{ r.pct | pct: 0 : false }}</span></div>
                  } @empty { <p class="muted small">No stocks.</p> }
                </div>
              </div>
              <div class="card">
                <div class="card-head"><h3>Company size</h3></div>
                <div class="bars">
                  @for (r of caps(); track r.key) {
                    <div class="bar-row" [title]="(r.value | inr)"><span class="ellipsis">{{ r.key }}</span><span class="track" aria-hidden="true"><span [style.width.%]="r.pct / maxPct(caps()) * 100"></span></span><span class="num right">{{ r.pct | pct: 0 : false }}</span></div>
                  } @empty { <p class="muted small">No stocks.</p> }
                </div>
              </div>
            </div>
          }
        </details>

        <details class="more rm-sec" id="together" [open]="togetherOpen()" (toggle)="onToggle($event, 'together')">
          <summary>How holdings move together</summary>
          @if (togetherOpen()) {
            <div class="grid grid-2">
              <div class="card">
                <div class="card-head"><div><h3>Correlation of your largest holdings</h3><span class="hint">daily returns over the past year</span></div></div>
                @if (risk(); as r) { <app-correlation-heat [r]="r" /> }
                @else if (riskError()) { <p class="small muted">Couldn't measure the risk.</p> }
                @else { <div class="skeleton" style="height:180px"></div> }
              </div>
              <div class="card">
                <div class="card-head"><div><h3>Risk against return</h3><span class="hint">the line is the best return available at each level of risk · long-run assumptions</span></div></div>
                @if (opt(); as o) {
                  @if (o.frontier.length) {
                    <app-frontier-chart [frontier]="o.frontier" [profiles]="o.profiles" [current]="o.current" [selected]="profile()" />
                    <div class="legend"><span><i class="swatch" style="background:var(--s4);border-radius:50%"></i>You today</span>
                      <span><i class="swatch" style="background:var(--s2);border-radius:50%"></i>Profiles ({{ label(profile()) }} filled)</span>
                      <span><i class="line-key" style="background:var(--s1)"></i>Best mixes</span></div>
                  } @else { <p class="small muted">{{ o.note }}</p> }
                } @else if (optError()) { <p class="small muted">Couldn't load the profiles.</p> }
                @else { <div class="skeleton" style="height:200px"></div> }
              </div>
            </div>
          }
        </details>
      }
    </div>`,
  styles: [`
    :host { display: block; }
    .rm-skel { display: block; height: 22px; width: 70%; margin-top: 6px; border-radius: 6px; opacity: .35; }

    /* T0: hero + three tiles; phones keep the hero and two tiles, the third sits behind "More" (§1.5, H19) */
    .rm-kpis { grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); }
    .rm-kpis .kpi.hero .value.words { font-size: 22px; line-height: 1.25; white-space: normal; }
    .rm-kpis .kpi .meta { white-space: normal; }
    .rm-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; flex-wrap: wrap; row-gap: 2px; }
    .rm-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .rm-kpis .cta-wrap { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
    .rm-kpis ::ng-deep .est { color: rgba(255, 255, 255, .75); font-size: 11px; vertical-align: middle; letter-spacing: 0; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .rm-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .rm-kpis .kpi:nth-child(2) { border-left: 0; }
      .rm-kpis .kpi:nth-child(3) { border-left: 1px solid rgba(255, 255, 255, .09); }
      .rm-kpis .kpi.extra { grid-column: span 2; border-left: 0; }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .rm-kpis .kpi.extra:not(.show) { display: none; }
      .rm-kpis .kpi.hero .value.words { font-size: 19px; }
    }

    .jump { display: flex; gap: 6px; flex-wrap: wrap; }
    .jump a { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text-2); font-size: 13px; font-weight: 500; text-decoration: none; white-space: nowrap; }
    .jump a:hover { border-color: var(--border-strong); color: var(--text); }
    .jump a.on { border-color: var(--primary); color: var(--text); font-weight: 600; }

    .rm-work { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .rm-sub { display: flex; flex-direction: column; gap: 14px; min-width: 0; scroll-margin-top: 80px; border-top: 1px solid var(--border); padding-top: 22px; }
    .rm-sub-head { display: flex; flex-direction: column; gap: 2px; }
    .rm-sub-head h2 { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
    .rm-sub-head .hint { color: var(--muted); font-size: 12.5px; }

    .rm-sec { display: flex; flex-direction: column; gap: 14px; min-width: 0; scroll-margin-top: 80px; }
    .rm-sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap; margin-bottom: -4px; }
    .rm-sec-head .q-head { margin: 6px 0 0; }
    details.rm-sec { display: block; }
    details.rm-sec > .grid, details.rm-sec > .conc-line { margin-top: 10px; }
    h3 { font-size: 14.5px; font-weight: 600; }

    /* concentration bars (ported from Performance with its group() code, D22) */
    .bars { display: grid; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: minmax(80px, 150px) 1fr 64px; gap: 10px; align-items: center; font-size: 13px; color: var(--text); text-decoration: none; }
    a.bar-row:hover { text-decoration: none; color: var(--primary); }
    .bar-row .track { height: 6px; background: var(--surface-hover); border-radius: 0 3px 3px 0; overflow: hidden; }
    .bar-row .track > span { display: block; height: 100%; border-radius: 0 3px 3px 0; background: var(--s1); }
    .legend { margin-top: 10px; }

    @media (max-width: 760px) {
      .jump { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
      .bar-row { grid-template-columns: minmax(70px, 110px) 1fr 60px; }
      .rm-sub { padding-top: 18px; }
    }
  `],
})
export class RiskMixComponent {
  readonly auth = inject(AuthService);
  readonly store = inject(StoreService);
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly sections = RISK_SECTIONS;
  readonly statusMeta = STATUS_META;
  readonly fragment = toSignal(this.route.fragment, { initialValue: this.route.snapshot.fragment });
  readonly moreStats = signal(false);

  readonly volBasis = 'Estimated yearly swings of your mix from the long-run assumptions and each holding\'s own price history. Not a forecast';
  readonly varBasis = 'From the last year of daily price moves: about 1 trading day in 20 could lose more. Past swings, not a forecast';

  // ── Data ──
  readonly brief = signal<Partial<Brief> | null>(null);
  readonly briefReady = signal(false);
  readonly opt = signal<OptimizerResult | null>(null);
  readonly optError = signal<string | null>(null);
  readonly stress = signal<StressTest | null>(null);
  readonly stressError = signal<string | null>(null);
  readonly risk = signal<PortfolioRisk | null>(null);
  readonly riskError = signal<string | null>(null);

  /**
   * `GET /optimizer?profile=` per profile, for the chosen profile's moves (K14: "Let mature", trims with
   * `tax_if_sold`). `/optimizer` without a profile answers for the saved one and seeds this; the profiles, current
   * mix and frontier are the same in every answer, so only the rows differ. Cleared when the data moves.
   */
  readonly optBy = signal<Partial<Record<RiskProfileKey, OptimizerResult>>>({});
  readonly moves = computed(() => this.optBy()[this.profile()] ?? null);
  private movesPending = new Set<string>();

  /** This page saved a setting, so Home's brief snapshot predates it: read `/brief` itself from now on (still never writing it). */
  private snapshotStale = false;
  /** R16: stress has been fetched once more for β in this load cycle. */
  private stressRetried = false;
  private seq: Record<'brief' | 'opt' | 'stress' | 'risk' | 'moves', number> = { brief: 0, opt: 0, stress: 0, risk: 0, moves: 0 };

  readonly empty = computed(() => {
    const p = this.store.portfolio();
    return !!p && !p.positions.length;
  });

  // ── T0 ──
  readonly savedProfile = computed(() => (this.store.settings().riskProfile as string | undefined) || null);
  readonly vital = computed(() => vitalOf(this.brief()?.vitals, 'risk'));
  readonly hero = computed<{ status: Status; big: string; words: boolean; est: boolean; meta: string | null; verdict: string }>(() => {
    const v = this.vital();
    const vol = this.brief()?.risk_est?.vol_pct ?? this.opt()?.current?.vol_pct ?? null;
    const volText = vol !== null && vol !== undefined ? `${vol.toFixed(1)}%` : null;
    if (!this.brief()) {
      return { status: 'unset', big: volText ?? '—', words: false, est: !!volText, meta: null, verdict: "Couldn't load the risk check" };
    }
    if (!v || v.status === 'unset') {
      if (!this.savedProfile()) {
        const looks = this.opt()?.current?.closest_profile;
        return { status: 'unset', big: 'Set a risk profile', words: true, est: false,
          meta: v?.value && v.value !== '—' ? v.value : null,
          verdict: v?.note || (looks ? `Looks like ${this.label(looks)}` : 'Pick the swings you can live with') };
      }
      return { status: 'unset', big: volText ?? '—', words: false, est: !!volText, meta: v?.value && v.value !== '—' ? v.value : null,
        verdict: v?.note || 'Risk estimate unavailable right now' };
    }
    const label = this.label(this.savedProfile());
    return { status: v.status, big: volText ?? '—', words: false, est: !!volText, meta: v.value,
      verdict: v.note || (v.status === 'good' ? `Within your ${label} profile` : v.value) };
  });

  /** `brief.allocation`, or the same rows built from the portfolio's segments when the brief has none. */
  readonly allocation = computed<AllocationRow[]>(() => {
    const rows = this.brief()?.allocation;
    return rows && rows.length ? rows : allocationFromSegments(this.store.portfolio()?.segments);
  });
  readonly off = computed(() => offTarget(this.allocation()));
  readonly correction = computed(() => this.stress()?.scenarios.find(s => s.key === 'correction') ?? null);
  readonly stressBasis = computed(() => this.stress()?.honesty?.estimate || 'A what-if shock applied to today\'s values, not a forecast');

  /** Home's `deploy.suggested` (A15): the planner's default, netted; null when the brief has none. */
  readonly deploy = computed<number | null>(() => {
    const v = this.brief()?.deploy?.suggested;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  });

  // ── Work surface ──
  readonly profile = signal<RiskProfileKey>('balanced');
  private picked = false;

  // ── T3: concentration (from the current snapshot; ported from Performance, D22/J8) ──
  readonly concOpen = signal(false);
  readonly togetherOpen = signal(false);
  private open = computed(() => this.store.openPositions().filter(p => p.asset_class !== 'cash'));
  private openTotal = computed(() => this.open().reduce((a, p) => a + p.value, 0) || 1);
  readonly top = computed(() => [...this.open()].filter(p => p.asset_class !== 'p2p').sort((a, b) => b.value - a.value).slice(0, 10)
    .map(p => ({ key: p.name, id: p.id, pct: (p.value / this.openTotal()) * 100 })));
  readonly top5 = computed(() => this.top().slice(0, 5).reduce((a, x) => a + x.pct, 0));
  readonly sectors = computed(() => groupBy(this.open().filter(p => p.asset_class === 'equity'), 'sector'));
  readonly caps = computed(() => groupBy(this.open().filter(p => p.asset_class === 'equity'), 'market_cap'));
  readonly usdShare = computed(() => groupBy(this.open(), 'currency').find(g => g.key === 'USD')?.pct ?? 0);
  maxPct = (rows: { pct: number }[]) => Math.max(...rows.map(r => r.pct), 1);

  private stopSettle: (() => void) | null = null;

  constructor() {
    // everything follows the portfolio on screen and its data version
    effect(() => {
      const scope = this.store.scopeKey();
      this.store.version();
      untracked(() => {
        void this.loadBrief(scope);
        void this.loadOptimizer();
        // R16: /risk goes first, because /forecast/stress takes β only from a warm risk memo (K11)
        this.stressRetried = false;
        void this.loadRisk();
        void this.loadStress();
      });
    });
    // the chosen profile's moves (Let mature, trims with their tax), fetched once per profile and data version
    effect(() => {
      const k = this.profile(), have = this.optBy();
      untracked(() => { if (this.opt() && !have[k]) void this.loadMoves(k); });
    });
    // the profile on screen starts at the saved one, else the one nearest today's mix, until the user picks
    effect(() => {
      const saved = this.savedProfile(), closest = this.opt()?.current?.closest_profile;
      untracked(() => {
        if (this.picked) return;
        const k = (saved && PROFILE_KEYS.includes(saved as RiskProfileKey) ? saved : closest) as RiskProfileKey | undefined;
        if (k) this.profile.set(k);
      });
    });
    effect(() => {
      const f = this.fragment();
      untracked(() => {
        if (f === 'concentration') this.concOpen.set(true);
        this.settle(f);
      });
    });
    this.destroyRef.onDestroy(() => {
      this.stopSettle?.();
      this.seq = { brief: this.seq.brief + 1, opt: this.seq.opt + 1, stress: this.seq.stress + 1, risk: this.seq.risk + 1, moves: this.seq.moves + 1 };
    });
  }

  label(k: string | null | undefined): string { return (k && PROFILE_LABEL[k]) || k || ''; }

  pick(k: RiskProfileKey) {
    this.picked = true;
    this.profile.set(k);
  }

  /**
   * A setting was saved. `wrote` fires only after `store.saveSetting` resolves, and by then the version bump inside
   * it has already re-run the loads, with the brief read from Home's pre-save snapshot. So mark the snapshot stale
   * and fetch `/brief` here (W5 review fix), or Off target, the drift bars and the Risk verdict stay stale.
   */
  onWrote() {
    this.snapshotStale = true;
    this.picked = false;  // a saved profile is now the starting point again
    void this.loadBrief(this.store.scopeKey());
  }

  onToggle(e: Event, which: 'conc' | 'together') {
    const open = (e.target as HTMLDetailsElement).open;
    (which === 'conc' ? this.concOpen : this.togetherOpen).set(open);
  }

  /** A click on the anchor already in the URL is not a navigation (same URL): scroll by hand. */
  jump(id: string) {
    if (this.fragment() !== id) return;
    if (id === 'concentration') this.concOpen.set(true);
    this.settle(id);
  }

  // ── Loads (each guarded by a sequence number so a slow, older answer never overwrites a newer one) ──

  private async loadBrief(scope: string) {
    const mine = ++this.seq.brief;
    const snap = this.snapshotStale ? null : readSnapshot<Partial<Brief>>(snapshotKey('brief', scope));
    if (snap && Array.isArray(snap.vitals)) {
      this.brief.set(snap);
      this.briefReady.set(true);
      return;
    }
    try {
      const b = await firstValueFrom(this.api.brief());
      if (mine !== this.seq.brief) return;
      this.brief.set(b);
    } catch {
      // keep whatever brief is on screen; with none, T0 reads "Couldn't load the risk check"
    } finally {
      if (mine === this.seq.brief) this.briefReady.set(true);
    }
  }

  async loadOptimizer() {
    const mine = ++this.seq.opt;
    try {
      const o = await firstValueFrom(this.api.optimizer());
      if (mine !== this.seq.opt) return;
      this.seq.moves++;
      this.movesPending.clear();
      this.opt.set(o);
      this.optBy.set({ [o.profile]: o });
      this.optError.set(null);
    } catch (e) {
      if (mine !== this.seq.opt) return;
      this.optError.set(errorMessage(e));
    }
  }

  /** The rows for one profile (`GET /optimizer?profile=`). A failure leaves the moves out; the table still works. */
  private async loadMoves(k: RiskProfileKey) {
    if (this.movesPending.has(k)) return;
    this.movesPending.add(k);
    const mine = this.seq.moves;
    try {
      const o = await firstValueFrom(this.api.optimizer(k));
      if (mine !== this.seq.moves) return;
      this.optBy.update(m => ({ ...m, [k]: o }));
    } catch {
      // no moves for this profile; the Suggested % column still reads from `profiles[].weights`
    } finally {
      if (mine === this.seq.moves) this.movesPending.delete(k);
    }
  }

  async loadStress() {
    const mine = ++this.seq.stress;
    try {
      const s = await firstValueFrom(this.api.stress());
      if (mine !== this.seq.stress) return;
      this.stress.set(s);
      this.stressError.set(null);
      this.betaRetry();
    } catch (e) {
      if (mine !== this.seq.stress) return;
      this.stressError.set(errorMessage(e));
    }
  }

  async loadRisk() {
    const mine = ++this.seq.risk;
    try {
      const r = await firstValueFrom(this.api.risk());
      if (mine !== this.seq.risk) return;
      this.risk.set(r);
      this.riskError.set(null);
      this.betaRetry();
    } catch (e) {
      if (mine !== this.seq.risk) return;
      this.riskError.set(errorMessage(e));
    }
  }

  /**
   * R16: when the stress answer has no β at all but `/risk` has resolved with β, the stress was built before the
   * risk memo warmed: fetch it once more (once per load cycle). Runs after either answer lands, whichever is last.
   * The cards on screen stay until the new answer replaces them.
   */
  private betaRetry() {
    if (this.stressRetried || !stressMissingBeta(this.stress(), this.risk())) return;
    this.stressRetried = true;
    void this.loadStress();
  }

  /**
   * Keep `#id` in view while the sections above it load. The router scrolls to the anchor once, right after
   * navigation; the profiles, planner and stress cards then arrive and push it down. Until the user scrolls,
   * taps or types (or SETTLE_MS passes), re-align it whenever the page's height changes.
   */
  private settle(id: string | null | undefined) {
    this.stopSettle?.();
    this.stopSettle = null;
    if (!id || !IDS.has(id) || typeof window === 'undefined') return;
    const align = () => document.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => align()) : null;
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    const stop = () => {
      ro?.disconnect();
      clearTimeout(first);
      clearTimeout(end);
      events.forEach(e => window.removeEventListener(e, stop));
      if (this.stopSettle === stop) this.stopSettle = null;
    };
    // Two macrotasks later: after this navigation's render and after the router's own anchor scroll (queued behind
    // the first), which ignores scroll-margin and would leave the heading under the sticky app bar.
    let first = setTimeout(() => { first = setTimeout(() => { align(); ro?.observe(this.host.nativeElement); }); });
    const end = setTimeout(stop, SETTLE_MS);
    events.forEach(e => window.addEventListener(e, stop, { passive: true }));
    this.stopSettle = stop;
  }
}
