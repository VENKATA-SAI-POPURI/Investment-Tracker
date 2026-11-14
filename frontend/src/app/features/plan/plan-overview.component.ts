import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Calibration, Goal, Plan, PlanScenario, PlanSensitivity, PlanTrackRow, Projection, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { ProbBarComponent } from '../../shared/priority/prob-bar.component';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';
import { PLAN_YEARS, ProjectionComponent } from './projection.component';
import { MAX_SAVED, PlanDetail, addSessionScenario, fmtPts, partialAgainst, pendingFocus, sameScenario, sensitivityScenario, sessionScenarios } from './scenarios.component';

const STEPS = [0, 5, 10, 15];
/** The `/forecast` API's `return` range (forecast_api.project): −10..30, rounded to 0.5 (D13, J6). */
export const RETURN_MIN = -10;
export const RETURN_MAX = 30;

/** A number typed into an input, or null when blank or not a number. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = +v;
  return isFinite(n) ? n : null;
}

/** A return in % clamped to the API's −10..30 and rounded to 0.5; null when blank or not a number. */
export function clampReturn(v: unknown): number | null {
  const n = numOrNull(v);
  if (n === null) return null;
  return Math.round(Math.max(RETURN_MIN, Math.min(RETURN_MAX, n)) * 2) / 2;
}

/** `?return=<n>` (D13): the prefilled return, or null when absent or not a number. */
export function parseReturnParam(v: string | null | undefined): number | null {
  return v === null || v === undefined || v.trim() === '' ? null : clampReturn(v);
}

/** "Home", "Home and Education", "Home, Car and Education". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One row of "Goals at a glance": a `plan.rows` entry joined to its goal (or the retirement plan). */
export interface GlanceRow {
  key: string;
  kind: 'goal' | 'retirement';
  name: string;
  /** "by 1 Mar 2031" / "at 60". */
  when: string;
  target: number | null;
  progress: number | null;
  probability: number | null;
  delta: number | null;
  status: Status;
  achieved: boolean;
  sip: number | null;
  needs: number | null;
  cta: { label: 'Fix' | 'View'; queryParams: Record<string, string>; fragment?: string; aria: string };
}

/**
 * Builds the Overview rows (J6): `plan.rows` in the backend's order (worst first), joined by id to `plan.goals` for
 * `progress_pct`, `monthly_contribution` and `required_sip`; the retirement row reads `plan.retirement`.
 * "Fix" (writers, a watch or act row) goes to `/plan?tab=goals&fix=<id>#goal-<id>` or `?tab=retirement` (J3);
 * other rows, and guests, get "View" without `fix`.
 */
export function glanceRows(plan: Plan | null | undefined, canWrite: boolean, fmtDate: (d: string) => string): GlanceRow[] {
  if (!plan) return [];
  const byId = new Map<number, Goal>((plan.goals ?? []).map(g => [g.id, g]));
  const deltas = plan.deltas ?? {};
  return (plan.rows ?? []).map((r: PlanTrackRow, i): GlanceRow => {
    const needsWork = r.status === 'act' || r.status === 'watch';
    if (r.kind === 'retirement') {
      const R = plan.retirement;
      const fix = canWrite && needsWork;
      return {
        key: 'retirement', kind: 'retirement', name: r.name,
        when: R ? `at ${R.inputs.retire_age}` : 'at retirement',
        target: r.target_amount ?? R?.corpus_needed ?? null,
        progress: R && R.corpus_needed > 0 ? Math.max(0, Math.min(100, R.current / R.corpus_needed * 100)) : null,
        probability: r.probability, delta: r.delta ?? deltas['retirement'] ?? null, status: r.status, achieved: false,
        sip: R?.inputs.monthly_sip ?? null, needs: R?.required_sip ?? null,
        cta: { label: fix ? 'Fix' : 'View', queryParams: { tab: 'retirement' }, aria: `${fix ? 'Fix' : 'View'} the retirement plan` },
      };
    }
    const g = r.id !== null ? byId.get(r.id) : undefined;
    const achieved = g?.projection?.status === 'achieved';
    const fix = canWrite && needsWork && !achieved && r.id !== null;
    const qp: Record<string, string> = { tab: 'goals' };
    if (fix) qp['fix'] = String(r.id);
    return {
      key: `goal-${r.id ?? i}`, kind: 'goal', name: r.name,
      when: r.target_date ? `by ${fmtDate(r.target_date)}` : '',
      target: r.target_amount ?? g?.target_amount ?? null,
      progress: g?.projection?.progress_pct ?? null,
      probability: r.probability, delta: r.delta ?? (r.id !== null ? deltas[String(r.id)] : null) ?? null,
      status: r.status, achieved,
      sip: g?.monthly_contribution ?? null, needs: g?.projection?.required_sip ?? null,
      cta: { label: fix ? 'Fix' : 'View', queryParams: qp, fragment: r.id !== null ? `goal-${r.id}` : undefined,
        aria: `${fix ? 'Fix' : 'View'} ${r.name}` },
    };
  });
}

/** A 1-year growth factor as a % change: 1.124 → "+12%" (`dp` decimals). */
export function growthPct(g: number | null | undefined, dp = 0): string {
  if (g === null || g === undefined || !isFinite(g)) return '—';
  const v = (g - 1) * 100;
  const r = +v.toFixed(dp);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(dp)}%`;
}

/**
 * Why a sensitivity's "Try it" is off (null when it can be tried). R7 makes the `retire` scenario the baseline itself
 * when no retirement plan is saved, and a scenario equal to today's plan would only save a copy of it.
 */
export function sensitivityUntryable(t: Pick<PlanSensitivity, 'key' | 'retirement_pts' | 'worst_goal_pts' | 'scenario'>,
  baseline: PlanScenario | null | undefined): string | null {
  if (!t.scenario) return 'Nothing to try';
  const same = !!baseline && sameScenario(t.scenario, baseline);
  if (t.key === 'retire' && (t.retirement_pts === null || same)) return 'Save a retirement plan to try this';
  if (same) return "Same as today's plan";
  // inflation moves only retirement (goal targets are nominal), so without a retirement plan there is nothing to
  // move, whatever the goals read (their delta is 0, not null)
  if (t.key === 'inflation' && t.retirement_pts === null) return 'Save a retirement plan to try this';
  if (t.retirement_pts === null && t.worst_goal_pts === null) return t.key === 'retire'
    ? 'Save a retirement plan to try this' : 'Add a goal or a retirement plan to compare';
  return null;
}

const NEEDLE_ICON: Record<string, string> ={ sip: 'coins', retire: 'calendar', returns: 'trend', inflation: 'scale' };

/** A part of the funding bar. */
interface FundPart { key: string; label: string; amount: number; pct: number; color: string; note?: string; }

const GOAL_SHADES = [88, 68, 52, 38, 26];

/**
 * Plan › Overview (SPEC §5.2, AMENDMENTS J6), below the Plan T0 that `plan.component` renders on every tab.
 *
 * - T1 work surface "Goals at a glance" (A21, J4): one `.card`, a row per `plan.rows` entry with progress, the
 *   ProbBar (▲/▼ vs the 30-day snapshot), the status badge, "SIP ₹x / needs ₹y" and Fix (J3).
 * - T2 "How it could unfold": the fan (ProjectionComponent).
 * - T2 Funding stack: one 100% bar of `funding.total` (earmarked goals, cushion, free), one warn notice per
 *   `over_allocated` row; "Couldn't work out the funding" when `funding` is null (W4 integrator).
 * - T2 Assumptions, always visible, from the drawn `/forecast` `assumptions` block.
 * - T3 Adjust (collapsed): horizon, SIP, step-up, return override, milestones and the average path.
 *   `?return=<n>` opens it and prefills the return, clamped to −10..30 and rounded to 0.5 (D13); nothing is
 *   written back to the URL.
 *
 * One `/forecast` call: while Adjust is at its defaults the fan draws `base`, the payload the shell fetched for the
 * "Typical in N yrs" tile. Any change fetches its own projection (debounced), and Reset returns to `base`.
 */
@Component({
  selector: 'app-plan-overview',
  standalone: true,
  imports: [DecimalPipe, FormsModule, RouterLink, IconComponent, EstTagComponent, ProbBarComponent, StatusBadgeComponent,
    ProjectionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- T1 work surface: Goals at a glance -->
    <div class="q-head"><app-icon name="target" [size]="14" /> Am I on track?</div>
    <section class="card flush glance" aria-labelledby="glance-title">
      <div class="card-head"><div><h2 id="glance-title">Goals at a glance</h2>
        <span class="hint">Worst first · chance of reaching each target in 1,000 simulated futures</span></div>
        @if (plan() && !plan()!.empty) { <a routerLink="/plan" [queryParams]="{ tab: 'goals' }" class="small">All goals →</a> }
      </div>
      @if (plan(); as p) {
        @if (rows().length) {
          <ul class="rows" role="list">
            @for (r of rows(); track r.key) {
              <li class="grow" [attr.data-status]="r.status">
                <div class="g-name">
                  <b class="ellipsis">{{ r.name }}</b>
                  <span class="small muted">
                    @if (r.target !== null) { <span>{{ r.target | inrc }}</span>
                      @if (r.kind === 'retirement') { <app-est basis="The corpus needed, at your plan's inflation and returns" /> } }
                    {{ r.when }}</span>
                </div>
                <div class="g-prog" [attr.aria-label]="'Progress ' + (r.progress === null ? 'not known' : (r.progress | number: '1.0-0') + '%')">
                  <span class="progress"><span [style.width.%]="r.progress ?? 0"></span></span>
                  <span class="small muted num">{{ r.progress === null ? '—' : (r.progress | number: '1.0-0') + '% there' }}</span>
                </div>
                <app-prob-bar class="g-prob" [value]="r.probability" [delta]="r.delta" [status]="r.status" [label]="'Chance of reaching ' + r.name" />
                <app-status class="g-status" [status]="r.status" [word]="r.achieved ? 'Achieved' : null" />
                <div class="g-sip small">
                  @if (r.achieved) { <span class="muted">Target reached</span> }
                  @else {
                    <span>SIP {{ r.sip === null ? '—' : (r.sip | inr) }}</span><span class="muted"> / needs </span>
                    @if (r.needs !== null) { <b>{{ r.needs | inr }}</b><app-est basis="Monthly amount that reaches the target in 75 of 100 simulated futures" /> } @else { <span class="muted">—</span> }
                  }
                </div>
                <a class="btn sm g-cta" [class.primary]="r.cta.label === 'Fix'" routerLink="/plan" [queryParams]="r.cta.queryParams"
                  [fragment]="r.cta.fragment" [attr.aria-label]="r.cta.aria">{{ r.cta.label }}</a>
              </li>
            }
          </ul>
        } @else {
          <div class="empty">
            <app-icon name="target" [size]="26" /><h3>No goals yet</h3>
            <p>Name what the money is for, and see the chance of getting there.</p>
            <div class="row gap">
              <a class="btn primary sm" routerLink="/plan" [queryParams]="{ tab: 'goals' }">Add a goal →</a>
              <a class="btn sm" routerLink="/plan" [queryParams]="{ tab: 'retirement' }">Plan retirement →</a>
            </div>
          </div>
        }
      } @else if (planError()) {
        <div class="pad"><div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /> Couldn't load your goals · {{ planError() }}</div></div>
      } @else {
        <div class="pad"><div class="skeleton" style="height:22px;width:60%"></div><div class="skeleton" style="height:120px;margin-top:12px"></div></div>
      }
    </section>

    <!-- T2: how it could unfold, where the money is, on what assumptions -->
    <div class="q-head"><app-icon name="trend" [size]="14" /> What could happen?</div>
    <app-projection [projection]="shown()" [goals]="plan()?.goals ?? []" [currentAge]="currentAge()" [today]="today()"
      [loading]="fanLoading()" [error]="fanError()" [afterTax]="afterTax()" />

    <!-- T2 (P2): what moves the needle, from GET /plan?detail=1 once T0 has loaded (R7, R15) -->
    @if (needleOn()) {
      <section class="card needle" aria-labelledby="needle-title" [class.loading-fade]="detailLoading() && !!sens()" [attr.aria-busy]="detailLoading()">
        <div class="card-head"><div><h2 id="needle-title">What moves the needle</h2>
          <span class="hint">One change at a time against today's plan · 500 simulated futures each, on the same draws · change in the chance, est.</span></div></div>
        @if (sens(); as list) {
          <div class="tiles">
            @for (t of list; track t.key) {
              <div class="tile">
                <span class="t-label"><app-icon [name]="needleIcon(t.key)" [size]="15" /> <b>{{ t.label }}</b></span>
                <span class="t-line"><span class="t-k">Retirement</span>
                  <b class="num" [class]="ptsTone(t.retirement_pts)">{{ pts(t.retirement_pts) }}</b>@if (t.retirement_pts !== null) {<app-est [basis]="needleBasis('reaching your retirement corpus')" />}</span>
                <span class="t-line"><span class="t-k ellipsis" [attr.title]="t.worst_goal?.name ?? null">{{ t.worst_goal?.name ?? 'Your goals' }}</span>
                  <b class="num" [class]="ptsTone(t.worst_goal_pts)">{{ pts(t.worst_goal_pts) }}</b>@if (t.worst_goal_pts !== null) {<app-est [basis]="needleBasis('reaching ' + (t.worst_goal?.name ?? 'your least likely goal'))" />}</span>
                @let why = untryable(t);
                @if (why) { <span class="small muted t-why">{{ why }}</span> }
                <button type="button" class="btn sm t-try" (click)="tryIt(t)" [disabled]="trying() !== null || !!why"
                  [attr.aria-label]="'Try it: ' + t.label + ', as a scenario'">
                  {{ trying() === t.key ? 'Opening…' : 'Try it →' }}</button>
              </div>
            }
          </div>
        } @else if (detailError()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't work out what moves the needle: {{ detailError() }}</span>
            <button type="button" class="btn sm" (click)="loadDetail(true)">Try again</button></div>
        } @else if (sensFailed()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>{{ sensFailed() }}</span>
            <button type="button" class="btn sm" (click)="loadDetail(true)">Try again</button></div>
        } @else {
          <p class="small muted">Working out what moves the needle…</p>
          <div class="tiles">@for (i of [1, 2, 3, 4]; track i) { <div class="skeleton tile-skel"></div> }</div>
        }
      </section>
    }

    <div class="t2-grid">
      <section class="card" aria-labelledby="fund-title">
        <div class="card-head"><div><h2 id="fund-title">Where your money is spoken for</h2>
          @if (plan()?.funding; as f) { <span class="hint">{{ f.total | inr }} across your holdings today</span> }</div></div>
        @if (plan(); as p) {
          @if (funding(); as f) {
            <div class="stack fund-bar" role="img" [attr.aria-label]="fundAria()">
              @for (part of f.parts; track part.key) { @if (part.pct > 0) { <i [style.width.%]="part.pct" [style.background]="part.color" [attr.title]="part.label + ': ' + (part.amount | inr)"></i> } }
            </div>
            <div class="stack-legend">
              @for (part of f.parts; track part.key) {
                <div><small><i class="key" [style.background]="part.color"></i>{{ part.label }}</small>
                  <b>{{ part.amount | inrc }}</b><span>{{ part.pct | number: '1.0-0' }}%@if (part.note) { <span> · {{ part.note }}</span> }</span></div>
              }
            </div>
            @for (o of f.over; track o.segment) {
              <div class="notice warn" role="status"><app-icon name="alert" [size]="16" />
                <span>{{ o.text }}. Each claim is scaled down so no rupee counts twice. <a routerLink="/plan" [queryParams]="{ tab: 'goals' }">Change the goals →</a></span></div>
            }
            @if (!p.cushion?.set) { <p class="small muted">No emergency cushion is set aside yet. <a routerLink="/settings" fragment="cushion">Set one →</a></p> }
          } @else {
            <div class="notice warn" role="status"><app-icon name="alert" [size]="16" />
              <span>Couldn't work out the funding.@if (fundNote(); as n) { {{ n }}.}</span></div>
          }
        } @else if (!planError()) { <div class="skeleton" style="height:70px"></div> }
        @else { <p class="small muted">Not available while your plan can't be loaded.</p> }
      </section>

      <section class="card" aria-labelledby="assume-title">
        <div class="card-head"><div><h2 id="assume-title">Assumptions</h2><span class="hint">Long-run assumptions, not predictions.</span></div>
          <a routerLink="/risk" fragment="profile" class="small">Change the mix →</a></div>
        @if (shown(); as s) {
          <dl class="kv">
            <dt>Return a year</dt><dd>{{ s.assumptions.return_pct }}% ± {{ s.assumptions.volatility_pct }}%@if (retVal() !== null && !atDefaults()) { <span class="badge">your override</span> }</dd>
            @if (s.assumptions.typical_pct !== undefined && s.assumptions.typical_pct !== null) { <dt>Typical year</dt><dd>{{ s.assumptions.typical_pct }}%</dd> }
            <dt>Inflation</dt><dd>{{ s.assumptions.inflation_pct }}%</dd>
            <dt>Based on</dt><dd class="wrap">your {{ s.assumptions.basis }}</dd>
          </dl>
          @if (s.assumptions.return_note) { <p class="small muted" role="note">{{ s.assumptions.return_note }}</p> }
          @if (s.assumptions.mix.length) {
            <div class="mix" aria-label="Your mix">
              @for (m of s.assumptions.mix; track m.segment) {
                <div class="mix-row"><span class="ellipsis">{{ m.segment }}</span><div class="track"><span [style.width.%]="m.weight_pct"></span></div>
                  <span class="num small">{{ m.weight_pct | number: '1.0-0' }}%</span><span class="num small muted">{{ m.return_pct }}% ± {{ m.volatility_pct }}%</span></div>
              }
            </div>
          }
          @if (s.assumptions.own; as own) { @if (own.return_pct !== null) {
            <p class="small muted">Your own record so far: {{ own.return_pct }}% a year with {{ own.volatility_pct ?? '—' }}% volatility; it pulls the long-run numbers part of the way towards what actually happened.</p>
          } }
          <p class="small muted">Long-run assumptions, not predictions.@if (hash(); as h) { <span class="hash" [attr.title]="'Assumption Book ' + h">Book #{{ h.slice(0, 8) }}</span>}</p>
        } @else if (fanError()) { <p class="small muted">Shown once the projection loads.</p> }
        @else { <div class="skeleton" style="height:120px"></div> }
      </section>
    </div>

    <!-- T3: Adjust -->
    <div class="q-head"><app-icon name="settings" [size]="14" /> Details</div>
    <details class="card adjust" id="plan-adjust" [open]="adjustOpen()" (toggle)="onToggle($event)">
      <summary><span class="sum-title">Adjust the projection</span>
        <span class="hint">{{ atDefaults() ? 'Your SIP plans over ' + baseYears() + ' years, no step-up' : 'Changed: ' + changes() }}</span></summary>
      <div class="adj-body">
        @if (fromLink() !== null && retVal() === fromLink()) {
          <div class="notice" role="status"><app-icon name="info" [size]="16" />
            <span>Trying {{ fromLink() }}% a year, from the link you followed. Clear the return to go back to the model's blend.</span></div>
        }
        <div class="controls">
          <div class="ctl"><span class="lbl" id="adj-h">Horizon</span>
            <div class="seg" role="group" aria-labelledby="adj-h">@for (y of horizons(); track y) {
              <button type="button" [class.on]="years() === y" [attr.aria-pressed]="years() === y" (click)="setHorizon(y)">{{ y }}y</button> }</div></div>
          <div class="ctl"><label for="adj-sip">Monthly SIP (₹)</label>
            <input id="adj-sip" class="input num" type="number" min="0" step="500" [ngModel]="sip()" (ngModelChange)="sip.set($event)"
              [placeholder]="sipPlaceholder()" />
            @if (sipVal() !== null) { <button type="button" class="link" (click)="sip.set(null)">Use your SIP plans</button> }
            @else { <span class="hint">Blank = your SIP plans</span> }</div>
          <div class="ctl"><span class="lbl" id="adj-s">Step-up each year</span>
            <div class="seg" role="group" aria-labelledby="adj-s">@for (s of steps; track s) {
              <button type="button" [class.on]="step() === s" [attr.aria-pressed]="step() === s" (click)="step.set(s)">{{ s }}%</button> }</div></div>
          <div class="ctl"><label for="adj-ret">Return (% a year)</label>
            <input id="adj-ret" class="input num" type="number" step="0.5" [min]="retMin" [max]="retMax" [ngModel]="ret()" (ngModelChange)="ret.set($event)"
              [placeholder]="retPlaceholder()" />
            <span class="hint">@if (retClamped()) { Used as {{ retVal() }}% (the range is {{ retMin }}% to {{ retMax }}%) } @else { Blank = the model's blend }</span></div>
          <div class="ctl"><span class="lbl">After tax</span>
            <label class="check"><input type="checkbox" [checked]="afterTax()" (change)="afterTax.set($any($event.target).checked)" /> Show after tax</label>
            <span class="hint">The end value if everything were sold then, after capital-gains tax at today's rules. The shaded ranges stay before tax.</span></div>
        </div>
        @if (!atDefaults()) { <button type="button" class="btn sm" (click)="reset()"><app-icon name="refresh" [size]="14" /> Back to your plan</button> }

        @if (shown(); as s) {
          <div class="t3-grid" [class.loading-fade]="fanLoading()">
            <div>
              <h3>Milestones <span class="hint">chance within {{ s.years }} years</span></h3>
              <table class="table compact">
                <thead><tr><th>Milestone</th><th>Around</th><th class="num">Chance</th></tr></thead>
                <tbody>
                  @for (m of s.milestones; track m.amount) {
                    <tr><td><b>{{ m.label }}</b></td><td>{{ m.median_year }}</td><td class="num">{{ m.probability | number: '1.0-0' }} of 100</td></tr>
                  } @empty { <tr><td colspan="3" class="muted small">No new round-number milestones inside this horizon.</td></tr> }
                </tbody>
              </table>
            </div>
            <dl class="kv">
              <dt [attr.title]="s.honesty.mean">Average path (pulled up by the best cases)</dt>
              <dd>{{ s.end.expected | inr }}<app-est [basis]="s.honesty.mean + '; the typical (median) outcome is lower'" /></dd>
              <dt>Typical in today's money</dt><dd>{{ s.end.real_p50 | inr }}<app-est basis="The typical outcome, deflated by inflation" /></dd>
              <dt>Futures ending below the money put in</dt><dd>{{ s.end.probability_of_loss | number: '1.0-0' }} of 100</dd>
              @if (s.typical_cagr_pct !== null) { <dt>Typical growth on what goes in</dt><dd>{{ s.typical_cagr_pct | number: '1.0-1' }}% a year</dd> }
              <dt>SIP used</dt><dd>{{ s.monthly_sip | inr }}/month{{ s.step_up_pct ? ', +' + s.step_up_pct + '% a year' : '' }}</dd>
            </dl>
          </div>
        }
      </div>
    </details>

    <!-- T3 (P3): calibration, loaded from GET /assumptions on first open (K17, R15) -->
    <details class="card adjust calib" id="plan-calibration" (toggle)="onCalibToggle($event)">
      <summary><span class="sum-title">How our ranges held up</span>
        <span class="hint">Each month's 1-year range, checked against what happened a year later</span></summary>
      <div class="adj-body">
        @if (calibLoading()) {
          <div class="skeleton" style="height:22px;width:70%"></div><div class="skeleton" style="height:120px;width:100%"></div>
        } @else if (calibError()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't load the check: {{ calibError() }}</span>
            <button type="button" class="btn sm" (click)="loadCalibration()">Try again</button></div>
        } @else if (calibLoaded()) {
          @if (calib(); as c) {
            @if (c.show) {
              <p class="calib-line"><b>{{ c.inside }} of {{ c.matured }} months</b> landed inside the 1-in-10 range ({{ c.coverage_pct ?? '—' }}%; aim {{ c.target }}%).</p>
              <p class="small muted">A range of 1-in-10 bad to 1-in-10 good should hold about 8 times in 10. Growth here is time-weighted, so new money does not count.</p>
              <div class="table-wrap calib-table">
                <table class="table compact">
                  <thead><tr><th>Month</th><th class="num">Range (1 year)</th><th class="num">What happened</th><th>Inside</th></tr></thead>
                  <tbody>
                    @for (row of c.rows; track row.date) {
                      <tr><td>{{ row.date | dt }}</td><td class="num">{{ growth(row.p10) }} to {{ growth(row.p90) }}</td><td class="num">{{ growth(row.realised, 1) }}</td>
                        <td>@if (row.inside) { <span class="pos" aria-label="Inside">✓</span> } @else { <span class="neg" aria-label="Outside">✗</span> }</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <p class="small muted">Not enough history yet: {{ c.matured }} of the 6 months this needs have had a year to play out. It appears once they have.</p>
            }
          } @else {
            <p class="small muted">Not worked out yet. It needs your full performance history, which is built when you open <a routerLink="/performance">Performance →</a></p>
          }
        }
      </div>
    </details>`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .q-head { margin: 4px 0 -10px; }
    .pad { padding: 0 22px 20px; }
    .glance .card-head { padding-bottom: 6px; }
    .rows { list-style: none; margin: 0; padding: 0; }
    .grow { display: grid; align-items: center; gap: 8px 16px; padding: 14px 22px; border-top: 1px solid var(--border);
      grid-template-columns: minmax(150px, 1.3fr) minmax(90px, .8fr) minmax(140px, 1.1fr) 104px minmax(150px, 1fr) 60px;
      grid-template-areas: 'name prog prob status sip cta'; }
    .g-name { grid-area: name; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .g-prog { grid-area: prog; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .g-prob { grid-area: prob; min-width: 0; }
    .g-status { grid-area: status; }
    .g-sip { grid-area: sip; min-width: 0; }
    .g-cta { grid-area: cta; justify-self: end; }
    .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row.gap { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    @media (max-width: 1100px) {
      .grow { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 104px;
        grid-template-areas: 'name prob status' 'prog sip cta'; }
    }
    @media (max-width: 600px) {
      .grow { padding: 14px 16px; grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas: 'name status' 'prob prob' 'prog prog' 'sip cta'; }
    }
    .t2-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; align-items: start; }
    @media (max-width: 900px) { .t2-grid { grid-template-columns: minmax(0, 1fr); } }
    .t2-grid .card { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .fund-bar { height: 14px; }
    .key { display: inline-block; width: 10px; height: 10px; border-radius: 3px; border: 1px solid var(--border-strong); }
    .kv .wrap { white-space: normal; }
    .mix { display: grid; gap: 8px; }
    .mix-row { display: grid; grid-template-columns: minmax(70px, 140px) minmax(0, 1fr) 40px 84px; gap: 10px; align-items: center; font-size: 13px; }
    .track { height: 6px; background: var(--surface-hover); border-radius: 3px; overflow: hidden; }
    .track > span { display: block; height: 100%; background: var(--s1); border-radius: 3px; }
    .hash { margin-left: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    .adjust { scroll-margin-top: 80px; }
    .adjust > summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; cursor: pointer; list-style: none; }
    .adjust > summary::-webkit-details-marker { display: none; }
    .adjust > summary .sum-title { font-size: 15px; font-weight: 600; }
    .adjust > summary .sum-title::before { content: '▸ '; color: var(--muted); }
    .adjust[open] > summary .sum-title::before { content: '▾ '; }
    .hint { font-size: 12px; color: var(--muted); font-weight: 400; }
    .adj-body { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; align-items: flex-start; }
    .adj-body > * { max-width: 100%; }
    .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px 24px; width: 100%; }
    .ctl { display: flex; flex-direction: column; gap: 6px; min-width: 0; align-items: flex-start; }
    .ctl label, .ctl .lbl { font-size: 12.5px; font-weight: 500; color: var(--text-2); }
    .ctl .input { width: 100%; max-width: 220px; }
    .link { border: 0; background: none; color: var(--primary); cursor: pointer; font-size: 12px; padding: 0; }
    .t3-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; width: 100%; align-items: start; }
    .t3-grid h3 { font-size: 14px; margin-bottom: 8px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .table.compact th, .table.compact td { padding: 8px 10px; }
    @media (max-width: 900px) { .t3-grid { grid-template-columns: minmax(0, 1fr); } }
    .needle .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .needle .tile { display: flex; flex-direction: column; gap: 6px; padding: 14px; border: 1px solid var(--border); border-radius: 12px;
      background: var(--surface-2); min-width: 0; }
    .needle .t-label { display: flex; align-items: center; gap: 6px; font-size: 13px; min-width: 0; }
    .needle .t-label b { overflow-wrap: anywhere; }
    .needle .t-line { display: flex; align-items: baseline; gap: 6px; font-size: 13px; min-width: 0; }
    .needle .t-k { color: var(--text-2); min-width: 0; }
    .needle .t-line b { margin-left: auto; white-space: nowrap; }
    .needle .t-try { align-self: flex-start; margin-top: auto; }
    .needle .t-why { margin-top: 2px; }
    .needle .tile-skel { height: 128px; border-radius: 12px; }
    @media (max-width: 1100px) { .needle .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 420px) { .needle .tiles { grid-template-columns: minmax(0, 1fr); } }
    .calib-line { font-size: 14px; margin: 0; }
    .calib-table { width: 100%; max-height: 340px; overflow: auto; }
    @media (max-width: 760px) { :host { gap: 16px; } }
  `],
})
export class PlanOverviewComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** GET /plan (null while loading or after a failed first load). */
  plan = input<Plan | null>(null);
  planError = input<string | null>(null);
  /** The shell's `/forecast` at the default horizon (J5): drawn while Adjust is at its defaults. */
  base = input<Projection | null>(null);
  baseYears = input.required<number>();
  baseLoading = input(false);
  baseError = input<string | null>(null);
  today = input.required<string>();
  /** Moves each time the shell's `/plan` and default `/forecast` have both answered: the cue to load `?detail=1`. */
  settled = input(0);

  readonly steps = STEPS;
  readonly retMin = RETURN_MIN;
  readonly retMax = RETURN_MAX;

  // Adjust state: null means "the default"
  readonly horizon = signal<number | null>(null);
  readonly sip = signal<number | null>(null);
  readonly step = signal(0);
  readonly ret = signal<number | null>(null);
  /** D5: the fan's request adds `after_tax`, and the side figures add `end.after_tax`; the bands stay pre-tax. */
  readonly afterTax = signal(false);
  readonly adjustOpen = signal(false);
  /** The return prefilled from `?return=` (D13), for the explanatory line. */
  readonly fromLink = signal<number | null>(null);
  /** `?return=` asked for the Adjust panel to be brought into view once the page has painted. */
  private readonly scrollPending = signal(false);

  readonly adjusted = signal<Projection | null>(null);
  readonly adjLoading = signal(false);
  readonly adjError = signal<string | null>(null);

  readonly years = computed(() => this.horizon() ?? this.baseYears());
  readonly sipVal = computed(() => { const n = numOrNull(this.sip()); return n === null ? null : Math.max(0, n); });
  readonly retVal = computed(() => clampReturn(this.ret()));
  readonly retClamped = computed(() => { const n = numOrNull(this.ret()); return n !== null && n !== this.retVal(); });
  readonly atDefaults = computed(() => this.years() === this.baseYears() && this.sipVal() === null && this.step() === 0 && this.retVal() === null && !this.afterTax());
  readonly horizons = computed(() => [...new Set([...PLAN_YEARS, this.baseYears()])].sort((a, b) => a - b));

  /** What the fan, the Assumptions card and the T3 figures draw. While a changed projection loads, the last one stays (faded). */
  readonly shown = computed(() => this.atDefaults() ? this.base() : this.adjusted() ?? this.base());
  readonly fanLoading = computed(() => this.atDefaults() ? this.baseLoading() : this.adjLoading());
  readonly fanError = computed(() => this.atDefaults() ? this.baseError() : this.adjusted() ? null : this.adjError() ?? this.baseError());

  readonly currentAge = computed(() => {
    const a = numOrNull(this.store.settings().retirementPlan?.['current_age']);
    return a !== null && a > 0 ? a : null;
  });
  readonly rows = computed(() => glanceRows(this.plan(), this.auth.canWrite(), d => this.fmt(d)));
  readonly hash = computed(() => this.shown()?.assumptions.hash ?? this.plan()?.assumptions?.hash ?? null);

  readonly funding = computed(() => {
    const f = this.plan()?.funding;
    if (!f) return null;
    const earmarked = f.earmarked ?? [];
    const parts: FundPart[] = earmarked.map((e, i) => ({
      key: `g${e.goal_id ?? 'x' + i}`, label: e.name ?? 'A goal', amount: Math.max(0, e.amount), pct: 0,
      color: `color-mix(in srgb, var(--accent) ${GOAL_SHADES[i % GOAL_SHADES.length]}%, var(--surface))`,
      note: e.amount <= 0 ? 'no holdings earmarked' : e.unscaled !== undefined ? 'scaled to fit' : undefined,
    }));
    const cushion = Math.max(0, f.cushion?.amount ?? 0);
    const cash = Math.max(0, f.cushion?.cash_amount ?? 0);
    parts.push({ key: 'cushion', label: 'Emergency cushion', amount: cushion, pct: 0, color: 'var(--text-2)',
      note: cash > 0 ? `plus ${this.inrText(cash)} in the bank` : undefined });
    parts.push({ key: 'free', label: 'Free money', amount: Math.max(0, f.free), pct: 0, color: 'var(--grid)', note: 'after goals and cushion' });
    const sum = parts.reduce((s, p) => s + p.amount, 0);
    const denom = Math.max(f.total, sum) || 1;
    for (const p of parts) p.pct = p.amount / denom * 100;
    const over = (f.over_allocated ?? []).map(o => ({
      segment: o.segment,
      text: `${o.segment} is claimed ${Math.round(o.claimed_pct)}% by ${joinNames(o.goals.map(g => g.name ?? 'a goal'))}`,
    }));
    return { parts, over };
  });
  readonly fundAria = computed(() => (this.funding()?.parts ?? [])
    .map(p => `${p.label} ${Math.round(p.pct)}%`).join(', '));
  /** The `/plan` note that explains a null `funding`, if one was sent. */
  readonly fundNote = computed(() => (this.plan()?.notes ?? []).find(n => /earmark|fund/i.test(n)) ?? null);

  readonly sipPlaceholder = computed(() => {
    const t = this.base()?.sip_plans_total ?? this.plan()?.sip.plans_monthly_total;
    return t !== undefined && t !== null ? `your plans: ${this.inrText(t)}` : 'your SIP plans';
  });
  readonly retPlaceholder = computed(() => {
    const r = this.base()?.assumptions.return_pct;
    return r !== undefined ? `model: ${r}%` : 'model';
  });
  readonly changes = computed(() => {
    const out: string[] = [];
    if (this.years() !== this.baseYears()) out.push(`${this.years()} years`);
    if (this.sipVal() !== null) out.push(`SIP ${this.inrText(this.sipVal()!)}`);
    if (this.step()) out.push(`+${this.step()}% a year`);
    if (this.retVal() !== null) out.push(`${this.retVal()}% return`);
    if (this.afterTax()) out.push('after tax');
    return out.join(' · ');
  });

  /* What moves the needle (R7, R15) */
  /** `GET /plan?detail=1`; null until it answers. The last answer stays (faded) while a newer one loads. */
  readonly detail = signal<PlanDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  /** The sensitivity whose "Try it" is being saved. */
  readonly trying = signal<string | null>(null);
  readonly sens = computed(() => {
    const s = this.detail()?.sensitivities;
    return Array.isArray(s) && s.length ? s : null;
  });
  /**
   * W7-B1: the server answered `sensitivities: null` because they failed; its note (or a plain line) says so.
   * An answer with no `sensitivities` key at all is an older server, and the card is left out.
   */
  readonly sensFailed = computed(() => {
    const d = this.detail();
    if (!d || d.sensitivities !== null) return null;
    return (d.notes ?? []).find(n => /needle/i.test(n)) ?? "What moves the needle couldn't be worked out right now";
  });
  /** Shown with goals or a retirement plan, unless the server answered without sensitivities (an older server). */
  readonly needleOn = computed(() => {
    const p = this.plan();
    if (!p || p.empty) return false;
    const d = this.detail();
    return !d || !!this.sens() || !!this.sensFailed();
  });
  private detailSig: string | null = null;
  private detailSeq = 0;

  /* How our ranges held up (K17, R15): GET /assumptions on first open */
  readonly calib = signal<Calibration | null>(null);
  readonly calibLoaded = signal(false);
  readonly calibLoading = signal(false);
  readonly calibError = signal<string | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    // ?return=<n> (D13): open Adjust with the return prefilled; Performance's assumptions check links here
    this.route.queryParamMap.pipe(map(q => q.get('return')), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(v => {
        const r = parseReturnParam(v);
        if (r === null) return;
        this.ret.set(r);
        this.fromLink.set(r);
        this.adjustOpen.set(true);
        this.scrollPending.set(true);
      });

    // the panel sits below the fan, the funding and the assumptions: scroll once they have painted, so it stays in view
    effect(() => {
      if (!this.scrollPending() || !this.shown() || !(this.plan() || this.planError())) return;
      this.scrollPending.set(false);
      this.scrollToAdjust();
    });

    // /plan?detail=1 waits until the shell's /plan and /forecast have answered, so it never holds up T0; it reloads
    // only when the plan itself changed (a saved scenario bumps the version but changes nothing here)
    effect(() => {
      const n = this.settled();
      if (!n) return;
      untracked(() => setTimeout(() => this.loadDetail(false)));
    });

    effect(() => {
      const k = { years: this.years(), sip: this.sipVal(), step: this.step(), return: this.retVal(), afterTax: this.afterTax() };
      const defaults = this.atDefaults();
      this.store.version();
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (defaults) {
        // the shell's payload is drawn: drop any request in flight
        this.seq++;
        this.adjLoading.set(false);
        this.adjError.set(null);
        return;
      }
      this.timer = setTimeout(() => void this.load(k), 350);
    });
    inject(DestroyRef).onDestroy(() => { if (this.timer) clearTimeout(this.timer); });
  }

  private async load(k: { years: number; sip: number | null; step: number; return: number | null; afterTax: boolean }) {
    const n = ++this.seq;
    this.adjLoading.set(true);
    try {
      const p = await firstValueFrom(this.api.forecast({ years: k.years, sip: k.sip, step: k.step, return: k.return, after_tax: k.afterTax }));
      if (n !== this.seq) return;
      this.adjusted.set(p);
      this.adjError.set(null);
    } catch (e) {
      if (n !== this.seq) return;
      this.adjError.set(errorMessage(e));
    } finally {
      if (n === this.seq) this.adjLoading.set(false);
    }
  }

  setHorizon(y: number) { this.horizon.set(y === this.baseYears() ? null : y); }

  reset() {
    this.horizon.set(null);
    this.sip.set(null);
    this.step.set(0);
    this.ret.set(null);
    this.afterTax.set(false);
    this.fromLink.set(null);
  }

  /** Loads `/plan?detail=1` when the plan changed since the last answer, or always with `force` (Try again). */
  async loadDetail(force: boolean) {
    const p = this.plan();
    if (!p || p.empty) return;
    const sig = JSON.stringify([this.store.scopeKey(), p]);
    if (!force && sig === this.detailSig && (this.detail() || this.detailLoading())) return;
    this.detailSig = sig;
    const n = ++this.detailSeq;
    this.detailLoading.set(true);
    try {
      const d = await firstValueFrom(this.api.plan({ detail: true })) as PlanDetail;
      if (n !== this.detailSeq) return;
      this.detail.set(d);
      this.detailError.set(null);
    } catch (e) {
      if (n !== this.detailSeq) return;
      this.detailError.set(errorMessage(e));
      this.detailSig = null;
    } finally {
      if (n === this.detailSeq) this.detailLoading.set(false);
    }
  }

  readonly pts = fmtPts;
  ptsTone(v: number | null | undefined): string {
    if (v === null || v === undefined || Math.round(v) === 0) return 'muted';
    return v > 0 ? 'pos' : 'neg';
  }
  needleIcon(key: string) { return NEEDLE_ICON[key] ?? 'sparkle'; }
  /** Why a tile's "Try it" is off, or null when it can be tried. */
  untryable(t: PlanSensitivity): string | null {
    return sensitivityUntryable(t, this.detail()?.baseline);
  }
  needleBasis(what: string) {
    return `Change in the chance of ${what}, from 500 simulated futures on the same draws as today's plan; an estimate, not a promise`;
  }

  /**
   * "Try it" (R15): a writer with fewer than 5 saved scenarios saves the sensitivity's scenario (named from its label)
   * to `planScenarios`; a guest, or a writer at 5, keeps it for this visit only. Then the Scenarios tab opens on it.
   */
  async tryIt(t: PlanSensitivity) {
    if (this.trying() || !t.scenario) return;
    const scen = sensitivityScenario(t);
    const scope = this.store.scopeKey();
    const saved = this.store.settings().planScenarios ?? [];
    this.trying.set(t.key);
    try {
      if (this.auth.canWrite() && saved.length < MAX_SAVED) {
        const at = saved.findIndex(s => sameScenario(s, scen));
        if (at >= 0) pendingFocus.set(`saved:${at}`);
        else {
          await this.store.saveSetting('planScenarios', [...saved, scen]);
          pendingFocus.set(`saved:${saved.length}`);
          this.toast.ok(`Saved "${scen.name}" as a scenario`);
        }
      } else {
        const inline = partialAgainst(scen, this.detail()?.baseline);
        const have = sessionScenarios().find(s => s.scope === scope && s.scenario.name === inline.name && sameScenario(s.scenario, inline));
        pendingFocus.set(`session:${have ? have.id : addSessionScenario(scope, inline)}`);
        if (!have) this.toast.info(this.auth.canWrite()
          ? `You have ${MAX_SAVED} saved scenarios, so this one is kept for this visit only`
          : 'Kept for this visit only');
      }
      await this.router.navigate(['/plan'], { queryParams: { tab: 'scenarios' } });
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.trying.set(null);
    }
  }

  onCalibToggle(ev: Event) {
    if ((ev.target as HTMLDetailsElement).open && !this.calibLoaded() && !this.calibLoading()) void this.loadCalibration();
  }

  async loadCalibration() {
    this.calibLoading.set(true);
    this.calibError.set(null);
    try {
      const a = await firstValueFrom(this.api.assumptions());
      this.calib.set(a.calibration ?? null);
      this.calibLoaded.set(true);
    } catch (e) {
      this.calibError.set(errorMessage(e));
    } finally {
      this.calibLoading.set(false);
    }
  }

  growth(g: number | null | undefined, dp = 0) { return growthPct(g, dp); }

  onToggle(ev: Event) { this.adjustOpen.set((ev.target as HTMLDetailsElement).open); }

  /** Two macrotasks after the page has painted (and after the router's own scroll), bring the panel into view. */
  private scrollToAdjust() {
    setTimeout(() => setTimeout(() => {
      const el = (this.host.nativeElement as HTMLElement).querySelector('#plan-adjust');
      // an instant jump: the panel is ~2 screens down, and a long smooth scroll is easily cut short by late paints
      el?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }));
  }

  private fmt(d: string): string {
    const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
    return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  }

  private inrText(v: number): string {
    return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
  }
}
