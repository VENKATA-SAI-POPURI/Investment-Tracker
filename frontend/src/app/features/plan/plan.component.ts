import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, map } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Plan, Projection, Status } from '../../core/models';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../../shared/icon.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { RetirementPlannerComponent } from './retirement-planner.component';
import { GoalsComponent } from './goals.component';
import { PlanOverviewComponent } from './plan-overview.component';
import { ScenariosComponent } from './scenarios.component';
import { defaultHorizon } from './projection.component';

export type PlanTab = 'overview' | 'goals' | 'retirement' | 'scenarios';

const TABS: { key: PlanTab; label: string; icon: string; hint: string }[] = [
  { key: 'overview', label: 'Overview', icon: 'trend', hint: 'Your goals, retirement and the whole portfolio on one set of assumptions' },
  { key: 'goals', label: 'Goals', icon: 'target', hint: 'Money earmarked for what it is for, and the chance of getting there' },
  { key: 'retirement', label: 'Retirement', icon: 'lotus', hint: 'The corpus you need, your FIRE number and the year-by-year path' },
  { key: 'scenarios', label: 'Scenarios', icon: 'layers', hint: "Change one thing and compare it with today's plan on the same simulated futures" },
];

/** `?tab=` → tab. `outlook` (the old Forecast tab name), unknown values and none read as Overview (H18, R15). */
export function planTabOf(v: string | null | undefined): PlanTab {
  return v === 'goals' || v === 'retirement' || v === 'scenarios' ? v : 'overview';
}

/** localStorage key of the one-time §10.1 note ("Monthly needed now aims for a 3-in-4 chance"). */
export const SIP75_NOTE_KEY = 'plan:sip75-note';

function noteDismissed(): boolean {
  try { return localStorage.getItem(SIP75_NOTE_KEY) === 'dismissed'; } catch { return false; }
}

/** The Plan hero's verdict line: the status word, then how many rows are off track or at risk. */
export function planVerdict(plan: Pick<Plan, 'status' | 'counts' | 'empty'>): { status: Status; text: string } {
  const status: Status = plan.empty ? 'unset' : plan.status?.status ?? 'unset';
  const word = STATUS_META[status]?.word ?? '';
  if (plan.empty) return { status, text: word };
  const parts: string[] = [];
  const off = plan.counts?.off_track ?? 0, risk = plan.counts?.at_risk ?? 0;
  if (off) parts.push(`${off} off track`);
  if (risk) parts.push(`${risk} at risk`);
  return { status, text: parts.length ? `${word} · ${parts.join(', ')}` : word };
}

/**
 * Plan (`/plan`, SPEC Part 1 §5.2; AMENDMENTS J1, J3–J6, A21–A23, A27, D13, D24, H6), the shell of the hub.
 *
 * On every tab:
 * - Head: h1 "Plan" (the page's only h1, A22), the sub line, and the assumption chip from `plan.assumptions`.
 * - Navy T0 (J5): hero "Plan status" = `plan.status` (headline; the status sets the stripe and verdict icon), then
 *   "Typical in {years} yrs" (`/forecast` `end.p50` at the default horizon, max(10, years to the furthest goal) capped
 *   at 30), "Investing each month" (`sip.plans_monthly_total`, watch below `sip.needed_monthly`) and "Free money"
 *   (`funding.free`, "—" when funding is null). Phones keep the hero and two tiles; the third sits behind "More".
 * - Strip `<app-needs-attention [prefixes]="['/plan']">` (A27), then the one-time §10.1 note, dismissed for good
 *   under localStorage['plan:sip75-note'], and `plan.notes` as one muted notice.
 * - Tabs Overview | Goals | Retirement | Scenarios on `?tab=` (replaceUrl), following `queryParamMap`. Leaving Goals drops
 *   `preset`, `fix` and the fragment (J3); leaving Overview drops `return` (D13 applies there only).
 *
 * Data: paints from `snapshotKey('plan', scopeKey)` (this component is its only writer, J3) and the default-horizon
 * projection from `snapshotKey('plan-forecast', scopeKey)`, then refetches `/plan` and `/forecast` whenever the scope or
 * the store version changes. The projection is handed to the Overview, which draws it while Adjust is at its defaults,
 * so the tile and the fan share one call. Goals and Retirement fetch their own data (no inputs cross, J3).
 */
@Component({
  selector: 'app-plan',
  standalone: true,
  imports: [RouterLink, IconComponent, AssumptionChipComponent, EstTagComponent, NeedsAttentionComponent, PlanOverviewComponent,
    RetirementPlannerComponent, GoalsComponent, ScenariosComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Plan</h1><p class="sub">{{ current().hint }} · estimates, not promises</p></div>
        <app-assumption-chip [block]="plan()?.assumptions" />
      </div>

      <!-- T0: the answer, on every tab -->
      @if (plan(); as p) {
        <section class="kpis plan-kpis" aria-label="Plan at a glance">
          <div class="kpi hero" [attr.data-status]="verdict().status">
            <span class="label">Plan status</span>
            <span class="value headline">{{ p.status.headline }}</span>
            <div class="verdict-line" [attr.data-status]="verdict().status">
              <app-icon [name]="statusMeta[verdict().status].icon" [size]="16" />
              <span>{{ verdict().text }}</span>
              @if (p.empty) {
                <span class="cta-wrap"><span aria-hidden="true">·</span><a routerLink="/plan" [queryParams]="{ tab: 'goals' }">Add a goal →</a></span>
                <span class="cta-wrap"><span aria-hidden="true">·</span><a routerLink="/plan" [queryParams]="{ tab: 'retirement' }">Plan retirement →</a></span>
              }
            </div>
            <button type="button" class="more-stats" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">{{ moreStats() ? 'Less' : 'More' }}</button>
          </div>

          <div class="kpi" [class.loading-fade]="baseLoading() && !!base()">
            <span class="chip violet sm"><app-icon name="trend" [size]="15" /></span>
            <span class="label">Typical in {{ base()?.years ?? baseYears() }} yrs</span>
            @if (base(); as b) {
              <span class="value">{{ b.end.p50 | inrc }}<app-est [basis]="tileBasis()" /></span>
              <span class="meta">1-in-10 bad {{ b.end.p10 | inrc }} · good {{ b.end.p90 | inrc }}</span>
            } @else if (baseError()) {
              <span class="value">—</span><span class="meta">Couldn't project right now</span>
            } @else {
              <span class="value"><span class="skeleton tile-skel"></span></span><span class="meta">Simulating 1,000 futures…</span>
            }
          </div>

          <div class="kpi" [attr.data-status]="sipStatus()">
            <span class="chip blue sm"><app-icon name="refresh" [size]="15" /></span>
            <span class="label">Investing each month</span>
            <span class="value">{{ p.sip.plans_monthly_total | inr }}</span>
            <span class="meta">
              @if (sipStatus() === 'watch') {
                <span class="flag"><app-icon name="alert" [size]="12" /> Watch</span> needs {{ p.sip.needed_monthly | inr }}/month<app-est basis="What your goals and retirement need each month to reach their targets in 75 of 100 simulated futures" />
              } @else if (p.sip.needed_monthly > 0) {
                covers the {{ p.sip.needed_monthly | inr }}/month needed<app-est basis="What your goals and retirement need each month to reach their targets in 75 of 100 simulated futures" />
              } @else { across your SIP plans }
            </span>
          </div>

          <div class="kpi extra" [class.show]="moreStats()">
            <span class="chip green sm"><app-icon name="wallet" [size]="15" /></span>
            <span class="label">Free money</span>
            @if (p.funding; as f) {
              <span class="value">{{ f.free | inr }}</span><span class="meta">after goals and cushion</span>
            } @else {
              <span class="value">—</span><span class="meta">Couldn't work out the funding right now</span>
            }
          </div>
        </section>
      } @else if (planError()) {
        <div class="card"><div class="empty">
          <app-icon name="alert" [size]="22" /><h3>Couldn't load your plan</h3><p>{{ planError() }}</p>
          <button type="button" class="btn" (click)="reload()"><app-icon name="refresh" [size]="15" /> Try again</button>
        </div></div>
      } @else {
        <div class="skeleton hero-skel" aria-label="Loading your plan"></div>
      }

      @if (stale()) {
        <div class="notice warn" role="status"><app-icon name="alert" [size]="16" />
          <span>Couldn't refresh, so these are the last numbers this device saw · {{ stale() }}</span>
          <button type="button" class="btn ghost sm" (click)="reload()">Try again</button></div>
      }

      <!-- T1: needs attention here (A27) -->
      <app-needs-attention [prefixes]="['/plan']" />

      @if (showNote()) {
        <div class="notice" role="status"><app-icon name="info" [size]="16" />
          <span class="note-text">Monthly needed now aims for a 3-in-4 chance (was the average path).</span>
          <button type="button" class="btn ghost sm" (click)="dismissNote()" aria-label="Dismiss this note">Got it</button></div>
      }
      @if (notes(); as n) { <p class="notice muted-note" role="note"><app-icon name="info" [size]="16" /><span>{{ n }}</span></p> }

      <div class="tabs" role="tablist" aria-label="Plan" (keydown)="onTabKey($event)">
        @for (t of tabs; track t.key) {
          <button type="button" role="tab" [id]="'plan-tab-' + t.key" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key"
            [attr.tabindex]="tab() === t.key ? 0 : -1" aria-controls="plan-panel" (click)="setTab(t.key)"><app-icon [name]="t.icon" [size]="14" /> {{ t.label }}</button>
        }
      </div>
      <div id="plan-panel" class="panel" role="tabpanel" [attr.aria-labelledby]="'plan-tab-' + tab()">
        @switch (tab()) {
          @case ('goals') { <app-goals /> }
          @case ('retirement') { <app-retirement-planner /> }
          @case ('scenarios') { <app-plan-scenarios /> }
          @default {
            <app-plan-overview [plan]="plan()" [planError]="planError()" [base]="base()" [baseYears]="baseYears()"
              [baseLoading]="baseLoading()" [baseError]="baseError()" [today]="todayIso" [settled]="settled()" />
          }
        }
      </div>
    </div>`,
  styles: [`
    .hero-skel { height: 150px; border-radius: 14px; }
    .page-head app-assumption-chip { max-width: 100%; min-width: 0; }

    /* T0: hero + three tiles; phones keep the hero and two tiles, the third sits behind "More" (§1.5, J5) */
    .plan-kpis { grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); --muted: rgba(255, 255, 255, .72); }
    .plan-kpis .kpi.hero { box-shadow: inset 4px 0 0 var(--st); }
    .plan-kpis .kpi.hero .value.headline { font-size: 21px; line-height: 1.3; white-space: normal; overflow-wrap: anywhere; }
    .plan-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; flex-wrap: wrap; row-gap: 2px; }
    .plan-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .plan-kpis .verdict-line a { color: var(--gold-2); text-decoration: underline; }
    .plan-kpis .value { display: flex; align-items: baseline; gap: 2px; }
    .plan-kpis .meta { white-space: normal; }
    .plan-kpis .flag { display: inline-flex; align-items: center; gap: 3px; padding: 0 6px; border-radius: 999px;
      background: rgba(252, 211, 77, .18); color: #fcd34d; font-weight: 600; }
    .tile-skel { display: inline-block; width: 90px; height: 22px; border-radius: 6px; opacity: .25; }
    .cta-wrap { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    .more-stats:focus-visible, .plan-kpis a:focus-visible { outline: 2px solid var(--gold-2); outline-offset: 2px; }
    @media (max-width: 900px) {
      .plan-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .plan-kpis .kpi:nth-child(2) { border-left: 0; }
      .plan-kpis .kpi:nth-child(3) { border-left: 1px solid rgba(255, 255, 255, .09); }
      .plan-kpis .kpi.extra { grid-column: span 2; border-left: 0; }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .plan-kpis .kpi.extra:not(.show) { display: none; }
      .plan-kpis .kpi.hero .value.headline { font-size: 18px; }
    }

    .notice .note-text { flex: 1; min-width: 0; }
    .notice .btn { flex: none; }
    .muted-note { background: var(--surface-2); color: var(--muted); margin: 0; }
    .tabs button { display: inline-flex; align-items: center; gap: 6px; }
    /* four tabs fit a phone once their icons go */
    @media (max-width: 480px) { .tabs button app-icon { display: none; } }
    .panel { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    @media (max-width: 760px) { .panel { gap: 16px; } }
  `],
})
export class PlanComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private store = inject(StoreService);

  readonly tabs = TABS;
  readonly statusMeta = STATUS_META;
  readonly todayIso = today();
  readonly tab = toSignal(this.route.queryParamMap.pipe(map(q => planTabOf(q.get('tab')))),
    { initialValue: planTabOf(this.route.snapshot.queryParamMap.get('tab')) });
  readonly current = computed(() => TABS.find(t => t.key === this.tab())!);

  /** GET /plan; null until the first paint (snapshot or fetch). */
  readonly plan = signal<Plan | null>(null);
  /** The first load failed and there is no snapshot to show. */
  readonly planError = signal<string | null>(null);
  /** A refresh failed while a snapshot is shown. */
  readonly stale = signal<string | null>(null);
  /** `/forecast` at the default horizon (the T0 tile and the Overview fan at its defaults). */
  readonly base = signal<Projection | null>(null);
  readonly baseLoading = signal(false);
  readonly baseError = signal<string | null>(null);
  readonly moreStats = signal(false);
  /**
   * Counts finished loads (`/plan`, then the default `/forecast`) for the current scope. The Overview starts its slow
   * `/plan?detail=1` only after it moves, so What moves the needle never competes with T0 (R15).
   */
  readonly settled = signal(0);
  private readonly noteHidden = signal(noteDismissed());

  /** J5: max(10, years to the furthest goal), capped at 30. */
  readonly baseYears = computed(() => defaultHorizon(this.plan()?.goals, this.todayIso));
  readonly verdict = computed(() => {
    const p = this.plan();
    return p ? planVerdict(p) : { status: 'unset' as Status, text: '' };
  });
  readonly sipStatus = computed<Status>(() => {
    const s = this.plan()?.sip;
    if (!s) return 'unset';
    return s.plans_monthly_total < s.needed_monthly ? 'watch' : s.needed_monthly > 0 ? 'good' : 'info';
  });
  readonly tileBasis = computed(() => {
    const b = this.base();
    if (!b) return null;
    const a = b.assumptions;
    return `${b.honesty?.p50 ?? 'Typical: half of the simulated futures end higher'}. Your SIP plans (₹${Math.round(b.monthly_sip).toLocaleString('en-IN')} a month), `
      + `no step-up, at ${a.return_pct}% a year ± ${a.volatility_pct}% (${a.basis}). Not a promise.`;
  });
  readonly showNote = computed(() => !this.noteHidden() && !!this.plan() && !this.plan()!.empty);
  readonly notes = computed(() => {
    const n = (this.plan()?.notes ?? []).filter(Boolean);
    return n.length ? n.join(' · ') : null;
  });

  private paintedFor: string | null = null;
  private seq = 0;

  constructor() {
    effect(() => {
      const scope = this.store.scopeKey();
      this.store.version();
      if (!this.auth.token()) return;
      untracked(() => {
        if (scope !== this.paintedFor) {
          // a new identity or portfolio: paint what this device saw last time for it, then refresh
          this.paintedFor = scope;
          this.paint(scope);
        }
        queueMicrotask(() => void this.load(scope));
      });
    });
    inject(DestroyRef).onDestroy(() => { this.seq++; });
  }

  private paint(scope: string) {
    const p = readSnapshot<Plan>(snapshotKey('plan', scope));
    const f = readSnapshot<{ years: number; data: Projection }>(snapshotKey('plan-forecast', scope));
    this.plan.set(p && Array.isArray(p.rows) && p.sip ? p : null);
    this.base.set(f?.data && Array.isArray(f.data.path) ? f.data : null);
    this.planError.set(null);
    this.stale.set(null);
    this.baseError.set(null);
  }

  /** `/plan`, then `/forecast` at the horizon its goals set. Responses for an older scope or call are dropped. */
  async load(scope: string = this.store.scopeKey()) {
    const n = ++this.seq;
    const live = () => n === this.seq && scope === this.store.scopeKey();
    try {
      const p = await firstValueFrom(this.api.plan());
      if (!live()) return;
      this.plan.set(p);
      this.planError.set(null);
      this.stale.set(null);
      writeSnapshot(snapshotKey('plan', scope), p);
    } catch (e) {
      if (!live()) return;
      if (this.plan()) this.stale.set(errorMessage(e));
      else this.planError.set(errorMessage(e));
    }

    const years = this.baseYears();
    this.baseLoading.set(true);
    try {
      // the defaults the Overview's Adjust panel starts from: the SIP plans (sip omitted), no step-up, the model return
      const f = await firstValueFrom(this.api.forecast({ years, step: 0 }));
      if (!live()) return;
      this.base.set(f);
      this.baseError.set(null);
      writeSnapshot(snapshotKey('plan-forecast', scope), { years, data: f });
    } catch (e) {
      if (!live()) return;
      if (!this.base()) this.baseError.set(errorMessage(e));
    } finally {
      if (live()) { this.baseLoading.set(false); this.settled.update(v => v + 1); }
    }
  }

  reload() { void this.load(); }

  dismissNote() {
    this.noteHidden.set(true);
    try { localStorage.setItem(SIP75_NOTE_KEY, 'dismissed'); } catch { /* storage unavailable: hidden for this visit */ }
  }

  setTab(t: PlanTab) {
    if (t === this.tab()) return;
    const q = this.route.snapshot.queryParamMap;
    // Overview is the bare URL. `preset`, `fix` and `#goal-<id>` only mean something on Goals (J3), and `return` only on
    // Overview (D13); navigating without `fragment` drops the anchor.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        tab: t === 'overview' ? null : t,
        preset: t === 'goals' ? q.get('preset') : null,
        fix: t === 'goals' ? q.get('fix') : null,
        return: t === 'overview' ? q.get('return') : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Arrow keys, Home and End move between the tabs (WAI-ARIA tabs pattern). */
  onTabKey(ev: KeyboardEvent) {
    const i = TABS.findIndex(t => t.key === this.tab());
    let j = i;
    if (ev.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (ev.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    else if (ev.key === 'Home') j = 0;
    else if (ev.key === 'End') j = TABS.length - 1;
    else return;
    ev.preventDefault();
    this.setTab(TABS[j].key);
    setTimeout(() => document.getElementById('plan-tab-' + TABS[j].key)?.focus());
  }
}
