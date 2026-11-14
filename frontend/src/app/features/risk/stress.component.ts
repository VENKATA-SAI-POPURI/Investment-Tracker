import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FORMAT_PIPES } from '../../core/format';
import { PlanImpact, SEGMENT_COLOR, StressHolding, StressScenario, StressTest } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';

/** Scenarios worst first: the most negative `impact_pct` leads, gains (a falling rupee) come last. Stable. */
export function worstFirst(scenarios: StressScenario[]): StressScenario[] {
  return scenarios.map((s, i) => ({ s, i })).sort((a, b) => (a.s.impact_pct - b.s.impact_pct) || a.i - b.i).map(x => x.s);
}

/** "~14 months", or "more than 20 years" when the engine's 240-month cap was reached (null, K11). */
export function recoveryWords(months: number | null | undefined): string {
  return months === null || months === undefined ? 'more than 20 years' : `~${months} month${months === 1 ? '' : 's'}`;
}

/**
 * The two K11 recovery figures for a falling scenario, or null when the payload predates K11 (then the card keeps
 * the old `recovery_months` sentence) or nothing falls.
 */
export function recoveryPair(s: StressScenario): { markets: string; sips: string } | null {
  if (s.impact >= 0) return null;
  if (!('recovery_months_markets' in s) && !('recovery_months_with_sips' in s)) return null;
  return { markets: recoveryWords(s.recovery_months_markets), sips: recoveryWords(s.recovery_months_with_sips ?? s.recovery_months) };
}

/** A holding's β as the drill-down shows it: two decimals, or the 1.0 prior the engine used without one (K11). */
export function betaWords(h: Pick<StressHolding, 'beta'>): string {
  return h.beta === null || h.beta === undefined ? '1.0 (assumed)' : h.beta.toFixed(2);
}

/** Lines of a `plan_impact` worth showing: retirement when both chances are known, and each goal with both. */
export function impactLines(pi: PlanImpact | null | undefined): { label: string; before: number; after: number }[] {
  if (!pi) return [];
  const out: { label: string; before: number; after: number }[] = [];
  if (pi.retirement_before !== null && pi.retirement_after !== null && pi.retirement_before !== undefined && pi.retirement_after !== undefined) {
    out.push({ label: 'retirement', before: pi.retirement_before, after: pi.retirement_after });
  }
  for (const g of pi.goals ?? []) {
    if (g.before !== null && g.after !== null && g.before !== undefined && g.after !== undefined) out.push({ label: g.name, before: g.before, after: g.after });
  }
  return out;
}

/**
 * Risk & mix `#stress` (T2, SPEC §5.6, AMENDMENTS J8, R16): historical-style shocks applied to today's portfolio,
 * one card per scenario, worst first by `impact_pct`. Every ₹ carries est. (the basis is `honesty.estimate`), and
 * `stress.assumptions` gives the chip. The page loads `GET /forecast/stress` (its T0 reads the correction row)
 * and passes it in; `retry` asks it to load again.
 *
 * P2 (K11, R16), each drawn only when the payload carries it:
 * - recovery two ways: "Markets alone ~N months · with your SIPs ~M months" (null reads "more than 20 years");
 * - "After this shock: retirement 78% → 64%" and one line per goal, from the scenario's `plan_impact`;
 * - a collapsed "Hit by holding" drill-down of the 10 `holdings`: value, β (or "1.0 (assumed)"), shock and ₹.
 */
@Component({
  selector: 'app-stress',
  standalone: true,
  imports: [IconComponent, EstTagComponent, AssumptionChipComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = st();
    @if (error(); as e) {
      <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>Couldn't run the stress test · {{ e }}</span>
        <span class="spacer"></span><button type="button" class="btn sm" (click)="retry.emit()">Try again</button></div>
    } @else if (t) {
      @if (!t.total || !t.scenarios.length) {
        <div class="card"><div class="empty"><app-icon name="shield" [size]="28" /><h3>Nothing to stress yet</h3>
          <p>{{ t.note || 'Add investments to see how a market fall would hit them.' }}</p></div></div>
      } @else {
        <div class="st-sum">
          <p class="small text-2">{{ t.market_exposed_pct | pct: 0 : false }} of {{ t.total | inrc }} moves with markets; FDs, EPF and loans do not.
            Each card applies one shock to today's holdings.</p>
          <app-assumption-chip [block]="t.assumptions" />
        </div>
        <div class="grid grid-2">
          @for (s of sorted(); track s.key; let first = $first) {
            <article class="card st-card" [attr.aria-label]="s.label">
              <div class="card-head">
                <div><h3>{{ s.label }}@if (first && s.impact < 0) { <span class="badge bad"><app-icon name="arrowDown" [size]="12" />Worst here</span> }</h3>
                  <span class="hint">{{ s.note }}</span></div>
                <div class="impact" [class]="s.impact | sign"><b>{{ s.impact | inrc: true }}<app-est [basis]="basis()" /></b><small>{{ s.impact_pct | pct }}</small></div>
              </div>
              @if (s.rows.length) {
                <div class="rows">
                  @for (r of s.rows; track r.book_key ?? r.segment) {
                    <div class="r"><span class="ellipsis"><i class="swatch" [style.background]="color(r.segment)"></i>{{ r.segment }}</span>
                      <div class="track" aria-hidden="true"><span [style.width.%]="scale(r, s)" [style.background]="r.impact < 0 ? 'var(--s8)' : 'var(--s1)'"></span></div>
                      <span class="num small" [class]="r.impact | sign">{{ r.shock_pct | pct: 0 }}</span>
                      <span class="num small" [class]="r.impact | sign">{{ r.impact | inrc: true }}<app-est [basis]="basis()" /></span></div>
                  }
                </div>
                <div class="foot small muted">Portfolio after: <b>{{ s.after | inrc }}</b><app-est [basis]="basis()" />
                  @if (recovery(s); as rc) {
                    <span class="st-rec">Back to today's value: <b>markets alone {{ rc.markets }}</b> · <b>with your SIPs {{ rc.sips }}</b><app-est [basis]="recoveryBasis" /></span>
                  } @else if (s.recovery_months && s.impact < 0) { · back to today's value in about <b>{{ s.recovery_months }} months</b> at long-run returns with your SIPs }
                </div>
                @if (lines(s); as ls) {
                  @if (ls.length) {
                    <ul class="st-plan" aria-label="What this shock does to your plan">
                      @for (l of ls; track l.label; let i = $index) {
                        <li>
                          <app-icon [name]="l.after < l.before ? 'arrowDown' : 'target'" [size]="13" />
                          <span>@if (i === 0) {<b>After this shock:&nbsp;</b>}{{ l.label }} {{ l.before | pct: 0 : false }} → <b [class.neg]="l.after < l.before">{{ l.after | pct: 0 : false }}</b>
                            <span class="sr-only">{{ l.after < l.before ? ' (lower)' : '' }}</span><app-est [basis]="planBasis" /></span>
                        </li>
                      }
                    </ul>
                  }
                }
                @if (s.holdings?.length) {
                  <details class="more st-hold">
                    <summary>Hit by holding</summary>
                    <div class="table-wrap">
                      <table class="table st-table">
                        <caption class="sr-only">The {{ s.holdings!.length }} holdings this shock hits hardest</caption>
                        <thead><tr>
                          <th scope="col">Holding</th><th scope="col" class="num st-val">Value</th><th scope="col" class="num" title="β: how much more or less than the market it moves">Beta</th>
                          <th scope="col" class="num">Shock</th><th scope="col" class="num">Impact</th>
                        </tr></thead>
                        <tbody>
                          @for (h of s.holdings!; track h.instrument_id) {
                            <tr>
                              <td><span class="st-name" [title]="h.name + ' · ' + h.segment">{{ h.name }}</span></td>
                              <td class="num st-val">{{ h.value | inrc }}</td>
                              <td class="num st-b" [class.muted]="h.beta === null" [attr.aria-label]="'beta ' + beta(h)">
                                @if (h.beta === null) { 1.0 <span class="st-assumed">(assumed)</span> } @else { {{ beta(h) }} }</td>
                              <td class="num" [class]="h.impact | sign">{{ h.shock_pct | pct: 0 }}</td>
                              <td class="num" [class]="h.impact | sign">{{ h.impact | inrc: true }}</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                    <p class="small muted st-beta">Impacts<app-est [basis]="basis()" /> are what-if estimates. Beta (β) scales the market shock for Indian stocks, equity funds and NPS
                      (β 1.2 falls 20% more than the market); without a measured β it is taken as 1.0. Other holdings take their class's shock.</p>
                  </details>
                }
              } @else { <p class="small muted">Nothing in this portfolio is affected.</p> }
            </article>
          }
        </div>
        <p class="small muted">{{ t.note }}@if (t.honesty?.disclaimer) { {{ t.honesty!.disclaimer }} }</p>
      }
    } @else {
      <div class="grid grid-2"><div class="card"><div class="skeleton" style="height:180px"></div></div>
        <div class="card hide-sm"><div class="skeleton" style="height:180px"></div></div></div>
    }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .notice .spacer { flex: 1 1 auto; }
    .st-sum { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
    .st-sum p { flex: 1 1 280px; margin: 0; }
    .st-card { min-width: 0; }
    .st-card h3 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14.5px; font-weight: 600; }
    .impact { display: flex; flex-direction: column; align-items: flex-end; } .impact b { font-size: 18px; white-space: nowrap; }
    .impact small { font-size: 12px; color: var(--muted); }
    .rows { display: grid; gap: 8px; }
    .r { display: grid; grid-template-columns: minmax(90px, 150px) 1fr 48px 92px; gap: 10px; align-items: center; font-size: 13px; }
    .r .swatch { margin-right: 6px; vertical-align: middle; }
    .r .num { white-space: nowrap; }
    .track { height: 6px; background: var(--surface-hover); border-radius: 3px; overflow: hidden; }
    .track > span { display: block; height: 100%; border-radius: 3px; }
    .foot { margin-top: 12px; }
    .st-rec { display: block; margin-top: 4px; }
    .st-plan { list-style: none; margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); display: grid; gap: 4px; font-size: 13px; }
    .st-plan li { display: flex; align-items: baseline; gap: 6px; }
    .st-plan app-icon { flex: none; position: relative; top: 2px; color: var(--muted); }
    .st-hold { margin-top: 10px; }
    .st-hold .table-wrap { margin-top: 6px; }
    .st-table th, .st-table td { font-size: 12.5px; padding: 6px 8px; }
    .st-table td.num { white-space: nowrap; }
    .st-name { display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .st-beta { margin: 6px 0 0; }
    @media (max-width: 760px) { .r { grid-template-columns: minmax(0, 1fr) 44px 84px; } .r .track { display: none; } }
    @media (max-width: 560px) {
      .st-val { display: none; }
      .st-name { max-width: 96px; }
      .st-table th { letter-spacing: 0; }
      .st-table th, .st-table td { padding: 6px 4px; }
      .st-table th:first-child, .st-table td:first-child { padding-left: 0; }
      .st-table th:last-child, .st-table td:last-child { padding-right: 0; }
      .st-assumed { display: block; font-size: 11px; }
    }
  `],
})
export class StressComponent {
  readonly st = input<StressTest | null>(null);
  readonly error = input<string | null>(null);
  readonly retry = output<void>();

  readonly sorted = computed(() => worstFirst(this.st()?.scenarios ?? []));
  readonly basis = computed(() => this.st()?.honesty?.estimate || 'A what-if shock applied to today\'s values, not a forecast');
  readonly recoveryBasis = 'Months for the after-shock value to climb back, each class growing at its typical long-run return; the second figure adds your monthly SIPs. An estimate, not a forecast';
  readonly planBasis = 'Chance of reaching each target before and after this shock, on the same 500 simulated paths of your whole portfolio. '
    + 'Plan counts only the money set aside for each target, so its chance today can differ a little. An estimate, not a forecast';
  color = (s: string) => SEGMENT_COLOR[s] ?? 'var(--muted)';
  scale = (r: { impact: number }, s: { rows: { impact: number }[] }) => Math.abs(r.impact) / Math.max(...s.rows.map(x => Math.abs(x.impact)), 1) * 100;
  recovery = recoveryPair;
  beta = betaWords;
  lines = (s: StressScenario) => impactLines(s.plan_impact);
}
