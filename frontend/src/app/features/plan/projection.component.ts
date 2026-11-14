import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { Goal, Projection } from '../../core/models';
import { LineBand, LineChartComponent, LineMarker, LineSeries } from '../../shared/charts/line-chart.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';

/** Horizons offered by the Adjust panel (§5.2); the default horizon is added when it is not one of them. */
export const PLAN_YEARS = [5, 10, 15, 20, 25, 30];
/** The default horizon never goes below this, or above PLAN_MAX_YEARS (J5). */
export const PLAN_MIN_YEARS = 10;
export const PLAN_MAX_YEARS = 30;

/** Whole months from `fromIso` to `toIso` (both YYYY-MM-DD); negative when `toIso` is earlier. */
export function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  if (!fy || !ty) return NaN;
  return (ty - fy) * 12 + ((tm || 1) - (fm || 1)) - ((td || 1) < (fd || 1) ? 1 : 0);
}

/**
 * The Plan's default horizon (J5): max(10, years to the furthest goal `target_date`), capped at 30.
 * Years are rounded up, so the furthest goal's date always sits inside the fan.
 */
export function defaultHorizon(goals: Pick<Goal, 'target_date'>[] | null | undefined, todayIso: string): number {
  let furthest = 0;
  for (const g of goals ?? []) {
    const m = g?.target_date ? monthsBetween(todayIso, g.target_date) : NaN;
    if (isFinite(m) && m > 0) furthest = Math.max(furthest, Math.ceil(m / 12));
  }
  return Math.min(PLAN_MAX_YEARS, Math.max(PLAN_MIN_YEARS, furthest));
}

/**
 * Goal diamonds on the yearly fan (§5.2, J6): one per goal whose `target_date` falls inside the horizon, at the
 * nearest year index (the path starts today, one point a year), with the goal name and `target_amount`.
 */
export function goalMarkers(goals: Goal[] | null | undefined, todayIso: string, years: number): LineMarker[] {
  const out: LineMarker[] = [];
  for (const g of goals ?? []) {
    if (!g?.target_date) continue;
    const m = monthsBetween(todayIso, g.target_date);
    if (!isFinite(m) || m < 0) continue;
    const i = Math.round(m / 12);
    if (i > years) continue;
    // a short label on the plot; the tooltip carries the full name
    const label = g.name.length > 18 ? g.name.slice(0, 17).trimEnd() + '…' : g.name;
    out.push({ i, kind: 'goal', label, name: g.name, amount: g.target_amount });
  }
  // labels closer than ~a sixth of the axis would overprint: keep the first, the others keep their diamond and tooltip
  const gap = Math.max(2, Math.ceil(years / 6));
  let last = -Infinity;
  for (const mk of out.sort((a, b) => a.i - b.i)) {
    if (mk.i - last < gap) mk.label = undefined;
    else last = mk.i;
  }
  return out;
}

/** Goals whose `target_date` lies beyond the horizon drawn (so they have no diamond). */
export function goalsBeyond(goals: Goal[] | null | undefined, todayIso: string, years: number): number {
  return (goals ?? []).filter(g => {
    const m = g?.target_date ? monthsBetween(todayIso, g.target_date) : NaN;
    return isFinite(m) && Math.round(m / 12) > years;
  }).length;
}

/** The fan's x label: "2041" or, when the age is known, "2041 · 45" (J6). Index i is i years from today. */
export function fanXLabel(label: string, i: number, currentAge: number | null | undefined): string {
  const year = (label || '').slice(0, 4);
  return currentAge !== null && currentAge !== undefined && isFinite(currentAge) && currentAge > 0
    ? `${year} · ${Math.round(currentAge + i)}` : year;
}

/**
 * "How it could unfold" (SPEC §5.2 T2, AMENDMENTS J6), moved from `features/forecast/` (W5-F1).
 *
 * Presentational: the Plan Overview owns the `/forecast` call and the Adjust panel, and passes the projection in,
 * so the Plan T0 tile and this fan share one request while Adjust is at its defaults.
 * - Bands p10–p90 ("8 in 10 futures") and p25–p75 ("the middle half"), the "Typical (median)" line and
 *   "Money put in" muted. The mean is never drawn (§1.9); the Adjust panel shows it at T3.
 * - `kind: 'goal'` markers at each goal's `target_date` (tooltip "{name} · needs ₹X"), and the age xLabel.
 * - Beside the chart: 1-in-10 bad, Typical, 1-in-10 good and Stop investing, each with an est. tag.
 * - With `afterTax` (D5, R15): the end value if everything were sold then, after capital-gains tax (`end.after_tax`
 *   p10/p50/p90 and its note). The bands and the other figures stay pre-tax.
 */
@Component({
  selector: 'app-projection',
  standalone: true,
  imports: [LineChartComponent, EstTagComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card fan" aria-labelledby="fan-title" [class.loading-fade]="loading()">
      <div class="card-head">
        <div><h2 id="fan-title">How it could unfold</h2>
          <span class="hint">{{ sims() }} simulated futures · shaded: where 8 and 5 in 10 of them land · line: the typical one</span></div>
      </div>
      @if (p(); as p) {
        <div class="fan-grid">
          <div class="chart">
            <app-line-chart [labels]="labels()" [series]="series()" [bands]="bands()" [markers]="markers()" [xLabel]="xLabel()"
              [height]="300" [yFormat]="inrc" [tipFormat]="inrFull" [zeroBased]="true"
              [ariaLabel]="'Projected portfolio value over ' + p.years + ' years'" />
            @if (beyond()) { <p class="small muted foot">{{ beyond() }} goal{{ beyond() === 1 ? '' : 's' }} fall{{ beyond() === 1 ? 's' : '' }} after {{ p.years }} years, so {{ beyond() === 1 ? 'it has' : 'they have' }} no marker here.</p> }
          </div>
          <dl class="figures" [attr.aria-label]="'In ' + p.years + ' years'">
            <div class="fig"><dt>{{ p.honesty.p10 || '1-in-10 bad case' }}</dt>
              <dd>{{ p.scenarios.bear | inrc }}<app-est [basis]="basis()" /></dd></div>
            <div class="fig typical"><dt>Typical</dt>
              <dd><b>{{ p.scenarios.base | inrc }}</b><app-est [basis]="basis()" /></dd>
              <span class="small muted">{{ p.honesty.p50 }} · {{ p.end.real_p50 | inrc }} in today's money</span></div>
            <div class="fig"><dt>{{ p.honesty.p90 || '1-in-10 good case' }}</dt>
              <dd>{{ p.scenarios.bull | inrc }}<app-est [basis]="basis()" /></dd></div>
            <div class="fig"><dt>Stop investing today</dt>
              <dd>{{ p.scenarios.no_more_investing | inrc }}<app-est [basis]="'Typical case if no more money goes in. ' + basis()" /></dd>
              <span class="small muted">typical, with no more SIPs</span></div>
            <div class="fig"><dt>Money put in</dt>
              <dd>{{ p.end.contributed | inrc }}</dd>
              <span class="small muted">{{ p.current | inrc }} today + {{ p.end.contributed - p.current | inrc }} of SIPs</span></div>
            @if (afterTax()) {
              <div class="fig after-tax">
                <dt>If sold at the end, after tax</dt>
                @if (p.end.after_tax; as t) {
                  <dd>{{ t.p50 | inrc }}<app-est [basis]="'Typical case after capital-gains tax if everything were sold then. ' + t.note" /></dd>
                  <span class="small muted">1-in-10 bad {{ t.p10 | inrc }} · good {{ t.p90 | inrc }}</span>
                  <span class="small muted">{{ t.note }}</span>
                } @else if (loading()) {
                  <dd class="muted">…</dd><span class="small muted">Working out the tax…</span>
                } @else {
                  <dd class="muted">—</dd><span class="small muted">After-tax figures aren't available for this projection.</span>
                }
              </div>
            }
          </dl>
        </div>
        @if (p.note) { <p class="small muted foot">{{ p.note }}</p> }
      } @else if (error()) {
        <div class="notice bad" role="alert">{{ error() }}</div>
      } @else {
        <div class="skeleton" style="height:300px" aria-label="Loading the projection"></div>
      }
    </section>`,
  styles: [`
    :host { display: block; min-width: 0; }
    .fan-grid { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 20px; align-items: start; }
    .chart { min-width: 0; }
    .figures { display: flex; flex-direction: column; gap: 14px; margin: 0; }
    .fig { display: flex; flex-direction: column; gap: 2px; padding-left: 12px; border-left: 3px solid var(--border); }
    .fig.typical { border-left-color: var(--s1); }
    .fig.after-tax { border-left-style: dashed; }
    .fig.after-tax .small { white-space: normal; }
    .fig dt { font-size: 12px; color: var(--muted); }
    .fig dd { margin: 0; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .fig.typical dd { font-size: 20px; }
    .foot { margin-top: 10px; }
    @media (max-width: 900px) {
      .fan-grid { grid-template-columns: minmax(0, 1fr); }
      .figures { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
    }
  `],
})
export class ProjectionComponent {
  /** The projection to draw (the Overview's shared default or its Adjust result). */
  p = input<Projection | null>(null, { alias: 'projection' });
  /** Goals for the markers (`Plan.goals`). */
  goals = input<Goal[]>([]);
  /** `settings.retirementPlan.current_age`, for "2041 · 45" labels. */
  currentAge = input<number | null>(null);
  /** Today's date (YYYY-MM-DD), the path's start. */
  today = input.required<string>();
  loading = input(false);
  error = input<string | null>(null);
  /** D5: show `end.after_tax` p10/p50/p90 and its note beside the figures. The bands always stay pre-tax. */
  afterTax = input(false);

  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);

  labels = computed(() => this.p()?.path.map(x => x.date) ?? []);
  bands = computed<LineBand[]>(() => {
    const path = this.p()?.path ?? [];
    return [
      { key: 'b80', label: '8 in 10 futures', color: 'var(--s1)', lo: path.map(x => x.p10), hi: path.map(x => x.p90), opacity: 0.12 },
      { key: 'b50', label: 'The middle half', color: 'var(--s1)', lo: path.map(x => x.p25), hi: path.map(x => x.p75), opacity: 0.2 },
    ];
  });
  series = computed<LineSeries[]>(() => {
    const path = this.p()?.path ?? [];
    return [
      // the mean (`expected`) is never drawn: the best cases pull it above the typical path (SPEC §1.9)
      { key: 'p50', label: 'Typical (median)', color: 'var(--s1)', values: path.map(x => x.p50) },
      { key: 'in', label: 'Money put in', color: 'var(--muted)', values: path.map(x => x.contributed), muted: true },
    ];
  });
  sims = computed(() => (this.p()?.sims ?? 1000).toLocaleString('en-IN'));
  markers = computed(() => goalMarkers(this.goals(), this.today(), this.p()?.years ?? 0));
  beyond = computed(() => this.p() ? goalsBeyond(this.goals(), this.today(), this.p()!.years) : 0);
  xLabel = computed(() => {
    const age = this.currentAge();
    return (label: string, i: number) => fanXLabel(label, i, age);
  });
  basis = computed(() => {
    const a = this.p()?.assumptions;
    return a ? `At ${a.return_pct}% a year ± ${a.volatility_pct}% (${a.basis}); a range of simulated futures, not a promise`
      : 'A range of simulated futures, not a promise';
  });
}
