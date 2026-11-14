import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { RetirementPlan } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { LineBand, LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { statusFromGoal, statusFromProbability } from '../../shared/priority/priority';
import { VerdictCardComponent } from '../../shared/priority/verdict-card.component';

type Field = { key: string; label: string; step?: number; min?: number; max?: number; hint?: string };
type Group = { key: 'you' | 'money' | 'assumptions'; label: string; fields: Field[] };

/** The aside form, grouped as You / Money / Assumptions (SPEC §5.2, AMENDMENTS J7). */
const GROUPS: Group[] = [
  { key: 'you', label: 'You', fields: [
    { key: 'current_age', label: 'Your age', min: 15, max: 100 },
    { key: 'retire_age', label: 'Retire at', min: 15, max: 100 },
    { key: 'life_expectancy', label: 'Plan until age', min: 50, max: 110 },
  ] },
  { key: 'money', label: 'Money', fields: [
    { key: 'monthly_expenses', label: 'Monthly expenses today (₹)', step: 1000, min: 0 },
    { key: 'other_income_monthly', label: 'Other income in retirement (₹/month, today)', step: 1000, min: 0, hint: 'pension, rent' },
    { key: 'monthly_sip', label: 'Monthly investing (₹)', step: 1000, min: 0, hint: 'blank = your SIP plans' },
    { key: 'step_up_pct', label: 'Step-up each year (%)', step: 1, min: 0, max: 50 },
  ] },
  { key: 'assumptions', label: 'Assumptions', fields: [
    { key: 'inflation_pct', label: 'Inflation (%)', step: 0.5, min: 0, max: 15 },
    { key: 'return_pct', label: 'Return while saving (%)', step: 0.5, min: -10, max: 30, hint: 'blank = your mix' },
    { key: 'post_return_pct', label: 'Return after retiring (%)', step: 0.5, min: 0, max: 20 },
  ] },
];

/** Drop blanks, so the saved setting and the query carry only what the user set. */
export function cleanPlan(f: Record<string, number | null | undefined>): Record<string, number> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== undefined && !isNaN(v as number))) as Record<string, number>;
}

/**
 * Plan › Retirement (SPEC §5.2 Retirement tab; AMENDMENTS J3, J4, J7). The tab body only: Plan owns the page, its h1
 * and the one navy T0, so the answer here is a T1 verdict card, then a plain stats row.
 *
 * Data: `GET /forecast/retirement` with the form's values (debounced), seeded from `settings.retirementPlan`.
 * Save writes `retirementPlan` through the store. Guests see the form read-only. A 400 (retire age not after the
 * current age) shows inline beside the ages, and the last good result stays on screen, faded.
 *
 * P2 (K10, R15): under the probability, "Money lasts to {life_expectancy}: {probability_lasts}%" (plus "· 1-in-10 runs
 * out at {depletion_age_p10}" when set), est.; the chart draws `path_bands` p10–p90 behind the path; and `sources`
 * says which money is counted and how much earmarked money is left out.
 */
@Component({
  selector: 'app-retirement-planner',
  standalone: true,
  imports: [FormsModule, IconComponent, LineChartComponent, VerdictCardComponent, EstTagComponent, AssumptionChipComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="main-aside">
      <div class="col">
        @if (error(); as err) {
          <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>Couldn't work out the plan: {{ err }}</span>
            <button class="btn sm" style="margin-left:auto" (click)="load(form())">Try again</button></div>
        }
        @if (invalid() && r()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>{{ invalid() }}. Showing the last plan that worked.</span></div>
        }
        @if (r(); as r) {
          <div class="r-body" [class.loading-fade]="loading() || !!invalid()">
            <app-verdict [status]="status()" [title]="'Chance of reaching ' + inrc(r.corpus_needed)"
              [big]="r.probability === null ? '—' : round(r.probability) + ' of 100 futures'" [sentence]="lasts() ? null : sentence()">
              <!-- the lasts line sits right under the probability, so the sentence follows it here -->
              @if (lasts(); as l) {
                <p class="lasts" [attr.data-status]="l.status">{{ l.text }}<app-est [basis]="lastsBasis()" /></p>
                @if (sentence(); as sn) { <p class="v-sentence">{{ sn }}</p> }
              }
              <div class="v-meta">
                <span class="small text-2">Retiring at {{ r.inputs.retire_age }}, with money lasting to {{ r.inputs.life_expectancy }}<app-est [basis]="estBasis()" /></span>
                @if (r.assumptions) { <app-assumption-chip [block]="r.assumptions" /> }
              </div>
            </app-verdict>

            <section class="card stats" aria-label="Retirement numbers">
              <div class="stat">
                <span class="k">Corpus needed at {{ r.inputs.retire_age }}</span>
                <span class="v">{{ r.corpus_needed | inrc }}<app-est [basis]="estBasis()" /></span>
                <span class="m">funds {{ r.monthly_expenses_at_retirement | inrc }} a month for {{ r.retirement_years }} years, rising with inflation</span>
              </div>
              <div class="stat">
                <span class="k">On current path</span>
                <span class="v">{{ r.projected | inrc }}<app-est [basis]="estBasis()" /></span>
                <span class="m" [class.neg]="r.gap > 0" [class.pos]="r.gap <= 0">{{ r.gap > 0 ? '−' + (r.gap | inrc) + ' short' : '+' + (-r.gap | inrc) + ' to spare' }}</span>
              </div>
              <div class="stat">
                <span class="k">Monthly needed</span>
                <span class="v">{{ r.required_sip | inr }}<app-est basis="The monthly investing that reaches the corpus in 75 of 100 simulated futures" /></span>
                <span class="m">needs this for a 3-in-4 chance · now {{ r.inputs.monthly_sip | inr }}{{ r.inputs.step_up_pct ? ', stepping up ' + r.inputs.step_up_pct + '% a year' : '' }}</span>
              </div>
              @if (sourcesLine(); as src) { <p class="small muted sources">{{ src }}</p> }
              @if (r.required_sip_typical !== null && r.required_sip_typical !== undefined) {
                <details class="more typical">
                  <summary>At the typical return</summary>
                  <p class="small text-2">At the typical return: <b>{{ r.required_sip_typical | inr }}/month</b><app-est basis="Reaches the corpus if returns follow the typical (median) path: about a 1-in-2 chance" />.
                    The monthly needed above aims higher, for 75 of 100 futures.</p>
                </details>
              }
            </section>

            <section class="card">
              <div class="card-head">
                <div><h2>Your money through life</h2>
                  <span class="hint">Saving until {{ r.inputs.retire_age }}, then drawing {{ r.monthly_expenses_at_retirement | inrc }} a month (growing {{ r.inputs.inflation_pct }}% a year). Estimates at {{ r.inputs.return_pct }}% a year, not a promise.@if (bands().length) { Shaded: where 8 in 10 simulated futures land. }</span></div>
              </div>
              <app-line-chart [labels]="labels()" [series]="series()" [bands]="bands()" [height]="300" [yFormat]="inrc" [tipFormat]="inrFull" [zeroBased]="true"
                [xLabel]="ageLabel" [ariaLabel]="bands().length ? 'Corpus by age: saving, then retired, against the corpus needed, over the range where 8 in 10 simulated futures land (estimates)' : 'Corpus by age: saving, then retired, against the corpus needed (estimates)'" />
              @if (r.runs_out_at === null) {
                <div class="notice" style="margin-top:14px"><app-icon name="checkCircle" [size]="16" />
                  <span>Money lasts past {{ r.inputs.life_expectancy }}@if (lastCorpus() !== null) {, leaving about {{ lastCorpus()! | inrc }}<app-est [basis]="estBasis()" /> }.</span></div>
              } @else {
                <div class="notice warn" style="margin-top:14px"><app-icon name="alert" [size]="16" />
                  <span>Runs out around {{ r.runs_out_at }}, {{ r.inputs.life_expectancy - r.runs_out_at }} years before {{ r.inputs.life_expectancy }}.
                    It needs {{ r.required_sip | inr }}/month<app-est basis="The monthly investing that reaches the corpus in 75 of 100 simulated futures" /> to close the gap.</span></div>
              }
            </section>

            <div class="grid grid-2">
              <section class="card">
                <div class="card-head"><div><h2>Financial independence</h2><span class="hint">The corpus that funds today's expenses for good at a 3.5% real withdrawal</span></div></div>
                <div class="fire"><span class="big">{{ r.fire.number | inrc }}<app-est [basis]="estBasis()" /></span>
                  <span class="small muted">FIRE number · you have {{ r.current | inrc }}@if (r.fire.progress_pct !== null) { ({{ r.fire.progress_pct | pct: 0 : false }}) }</span></div>
                <div class="progress" style="margin:10px 0 14px"><span [style.width.%]="fireBar()"></span></div>
                <dl class="kv">
                  <dt>Independent by</dt><dd>@if (r.fire.fi_age !== null) { around age <b>{{ r.fire.fi_age }}</b> ({{ r.fire.years_to_fi }} years) } @else { beyond 40 years at this pace }</dd>
                  <dt>Coast FIRE</dt><dd>@if (r.fire.coasting) { <span class="pos">Already coasting</span> } @else { needs {{ r.fire.coast_amount_now | inrc }} today<app-est [basis]="estBasis()" /> }</dd>
                </dl>
                <p class="small muted" style="margin-top:12px">Coast FIRE: with {{ r.fire.coast_amount_now | inrc }} invested today and no further saving, growth at the assumed return would reach the retirement corpus by {{ r.inputs.retire_age }}.</p>
              </section>
              <section class="card">
                <div class="card-head"><h2>The numbers</h2></div>
                <dl class="kv">
                  <dt>Years until retirement</dt><dd>{{ r.years_to_retire }}</dd>
                  <dt>Years in retirement</dt><dd>{{ r.retirement_years }}</dd>
                  <dt>Expenses then (per month)</dt><dd>{{ r.monthly_expenses_at_retirement | inr }}<app-est [basis]="'Today\\'s expenses grown at ' + r.inputs.inflation_pct + '% inflation'" /></dd>
                  <dt>Corpus at retirement</dt><dd>{{ r.projected | inr }}<app-est [basis]="estBasis()" /></dd>
                  <dt>Corpus needed</dt><dd>{{ r.corpus_needed | inr }}<app-est [basis]="estBasis()" /></dd>
                  <dt>Gap</dt><dd [class.neg]="r.gap > 0" [class.pos]="r.gap <= 0">{{ r.gap > 0 ? (r.gap | inr) + ' short' : (-r.gap | inr) + ' to spare' }}</dd>
                </dl>
                <p class="small muted" style="margin-top:12px">{{ r.note }}</p>
              </section>
            </div>
          </div>
        } @else if (invalid()) {
          <div class="notice warn" role="alert"><app-icon name="alert" [size]="16" /><span>{{ invalid() }}. Fix the ages to see your plan.</span></div>
        } @else if (!error()) {
          <div class="card" aria-busy="true"><div class="skeleton" style="height:132px"></div></div>
          <div class="card" aria-busy="true"><div class="skeleton" style="height:300px"></div></div>
        }
      </div>

      <aside>
        <section class="card">
          <div class="card-head">
            <div><h2>Your plan</h2>
              @if (!saved()) { <span class="hint">{{ auth.canWrite() ? 'Not saved yet: these start from defaults' : 'No plan saved for this portfolio' }}</span> }
              @else if (dirty()) { <span class="hint">Changed: a what-if until you save</span> }</div>
            @if (auth.canWrite()) {
              <button class="btn sm primary" (click)="save()" [disabled]="saving() || !!invalid() || (!dirty() && !!saved())">Save</button>
            }
          </div>
          <div class="form">
            @for (g of groups; track g.key) {
              <div class="group" role="group" [attr.aria-labelledby]="'rt-g-' + g.key">
                <h3 class="g-label" [id]="'rt-g-' + g.key">{{ g.label }}</h3>
                @for (f of g.fields; track f.key) {
                  <div class="field"><label [for]="'rt-' + f.key">{{ f.label }}</label>
                    <input [id]="'rt-' + f.key" class="input num" type="number" [step]="f.step ?? 1" [min]="f.min ?? null" [max]="f.max ?? null"
                      [ngModel]="form()[f.key]" (ngModelChange)="set(f.key, $event)" [placeholder]="used(f.key)" [readonly]="!auth.canWrite()"
                      [attr.aria-invalid]="g.key === 'you' && !!invalid() ? true : null" [attr.aria-describedby]="g.key === 'you' && invalid() ? 'rt-invalid' : null" />
                    @if (f.hint) { <span class="hint">{{ f.hint }}</span> }</div>
                }
                @if (g.key === 'you' && invalid()) {
                  <div id="rt-invalid" class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>{{ invalid() }}</span></div>
                }
              </div>
            }
          </div>
        </section>
      </aside>
    </div>`,
  styles: [`
    :host { display: block; min-width: 0; }
    .col, .r-body { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .v-meta { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 22px; }
    .stat { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .stat + .stat { border-left: 1px solid var(--border); padding-left: 22px; }
    .stat .k { font-size: var(--t-label); color: var(--muted); font-weight: 500; }
    .stat .v { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .stat .m { font-size: var(--t-label); color: var(--text-2); }
    .stat .m.neg { color: var(--neg); } .stat .m.pos { color: var(--pos); }
    .stats .typical, .stats .sources { grid-column: 1 / -1; }
    .sources { margin: 0; }
    .lasts { display: block; margin: 0 0 8px; font-size: var(--t-body, 14px); font-weight: 600; color: var(--text); }
    .fire { display: flex; flex-direction: column; gap: 2px; }
    .fire .big { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; }
    .group { display: grid; gap: 12px; min-width: 0; }
    .group + .group { border-top: 1px solid var(--border); padding-top: 14px; }
    .group .g-label { font-size: var(--t-label); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
    @media (max-width: 1000px) { .main-aside { grid-template-columns: minmax(0, 1fr); } .main-aside > aside { position: static; } }
    @media (max-width: 760px) {
      .col, .r-body { gap: 16px; }
      .stats { grid-template-columns: minmax(0, 1fr); }
      .stat + .stat { border-left: 0; padding-left: 0; border-top: 1px solid var(--border); padding-top: 12px; }
    }
  `],
})
export class RetirementPlannerComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  auth = inject(AuthService);
  readonly groups = GROUPS;
  form = signal<Record<string, number | null>>({});
  r = signal<RetirementPlan | null>(null);
  loading = signal(false);
  saving = signal(false);
  /** A failure other than a 400. */
  error = signal<string | null>(null);
  /** The 400 message (retire age not after the current age, an age out of range), shown inline. */
  invalid = signal<string | null>(null);
  readonly inrc = (v: number) => inrCompact(v);
  readonly inrFull = (v: number) => inr(v);
  readonly round = Math.round;

  saved = computed(() => this.store.settings().retirementPlan ?? null);
  dirty = computed(() => {
    const a = cleanPlan(this.form()), b = cleanPlan(this.saved() ?? {});
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].some(k => a[k] !== b[k]);
  });
  status = computed(() => statusFromGoal(this.r()?.status));
  estBasis = computed(() => {
    const i = this.r()?.inputs;
    return i ? `At ${i.return_pct}% a year ± ${i.volatility_pct}% (${i.return_basis}) and ${i.inflation_pct}% inflation; an estimate, not a promise` : null;
  });
  sentence = computed(() => {
    const r = this.r();
    if (!r) return null;
    if (r.probability === null) return 'There is not enough to simulate the chance yet; the numbers below follow the assumed return.';
    const capped = r.inputs.return_note ? ` ${r.inputs.return_note}` : '';
    return `Out of ${(r.sims ?? 1000).toLocaleString('en-IN')} simulated futures at ${r.inputs.return_pct}% ± ${r.inputs.volatility_pct}% a year.${capped} An estimate, not a promise.`;
  });
  lastCorpus = computed(() => {
    const p = this.r()?.path ?? [];
    return p.length ? p[p.length - 1].corpus : null;
  });
  /**
   * P2 (K10, R15): "Money lasts to {life_expectancy}: {probability_lasts}% · 1-in-10 runs out at {depletion_age_p10}";
   * the second clause only when that age is set. Null without `probability_lasts` (an older server).
   */
  lasts = computed(() => {
    const r = this.r();
    const p = r?.probability_lasts;
    if (!r || p === null || p === undefined) return null;
    const age = r.depletion_age_p10;
    const tail = age !== null && age !== undefined ? ` · 1-in-10 runs out at ${age}` : '';
    return { text: `Money lasts to ${r.inputs.life_expectancy}: ${Math.round(p)}%${tail}`, status: statusFromProbability(p) };
  });
  lastsBasis = computed(() => {
    const r = this.r();
    return r ? `Share of ${(r.sims ?? 1000).toLocaleString('en-IN')} simulated futures whose money pays every withdrawal to age ${r.inputs.life_expectancy}, `
      + 'with the NPS annuity offsetting withdrawals; an estimate, not a promise' : null;
  });
  /** K10 `sources`: the goal-free money retirement counts, and what it leaves out so nothing is counted twice. */
  sourcesLine = computed(() => {
    const s = this.r()?.sources;
    if (!s) return null;
    const c = (v: number) => inrCompact(v);
    const out = `Counts EPF ${c(s.epf)} + NPS ${c(s.nps)} + free money ${c(s.free)}`;
    return s.excluded > 0 ? `${out}; ${c(s.excluded)} earmarked for goals and the cushion is left out` : `${out}.`;
  });
  fireBar = computed(() => Math.max(0, Math.min(100, this.r()?.fire.progress_pct ?? 0)));

  labels = computed(() => this.r()?.path.map(p => `${p.year}-01-01`) ?? []);
  /** The x-axis and tooltip read by age (`path[].age`). */
  ageLabel = (_label: string, i: number) => {
    const p = this.r()?.path[i];
    return p ? `Age ${p.age} · ${p.year}` : _label;
  };
  /** `path_bands` p10–p90 by age, aligned to the path's ages, drawn behind the path (K10, R15). */
  bands = computed<LineBand[]>(() => {
    const r = this.r();
    const pb = r?.path_bands;
    if (!r || !Array.isArray(pb) || !pb.length) return [];
    const byAge = new Map(pb.map(b => [b.age, b]));
    const lo = r.path.map(p => byAge.get(p.age)?.p10 ?? null);
    const hi = r.path.map(p => byAge.get(p.age)?.p90 ?? null);
    if (!lo.some(v => v !== null)) return [];
    return [{ key: 'b80', label: '8 in 10 futures (est.)', color: 'var(--s1)', lo, hi, opacity: 0.12 }];
  });
  series = computed<LineSeries[]>(() => {
    const r = this.r();
    const path = r?.path ?? [];
    return [
      { key: 'save', label: 'While saving (est.)', color: 'var(--s1)', values: path.map(p => p.phase === 'saving' ? p.corpus : null), area: true },
      { key: 'ret', label: 'In retirement (est.)', color: 'var(--s4)', values: path.map((p, i) => p.phase === 'retired' || path[i + 1]?.phase === 'retired' ? p.corpus : null), area: true },
      { key: 'need', label: 'Corpus needed', color: 'var(--s2)', values: path.map(() => r?.corpus_needed ?? null), dashed: true, muted: true },
    ];
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seeded = false;
  private seq = 0;
  constructor() {
    effect(() => {
      const saved = this.store.settings().retirementPlan;
      if (!this.seeded && saved) { this.seeded = true; this.form.set({ ...saved }); }
    });
    effect(() => {
      const f = this.form(); this.store.version();
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(f), this.r() ? 400 : 0);
    });
    inject(DestroyRef).onDestroy(() => { if (this.timer) clearTimeout(this.timer); });
  }
  /** A blank field's placeholder: the value the model used for it (e.g. inflation 6), else the field's hint. */
  used(key: string): string {
    const v = (this.r()?.inputs as unknown as Record<string, unknown> | undefined)?.[key];
    const hint = GROUPS.flatMap(g => g.fields).find(f => f.key === key)?.hint;
    return typeof v === 'number' ? `${v}${hint ? ' · ' + hint : ''}` : hint ?? '';
  }
  set(key: string, v: unknown) {
    if (!this.auth.canWrite()) return;
    this.form.update(f => ({ ...f, [key]: v === '' || v === null || v === undefined ? null : +(v as number) }));
  }
  async load(f: Record<string, number | null>) {
    const n = ++this.seq;
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.api.retirement(f));
      if (n !== this.seq) return;
      this.r.set(r);
      if (!Object.keys(this.form()).length) {  // first load with nothing saved: show the defaults the model used
        const i = r.inputs;
        this.form.set({ current_age: i.current_age, retire_age: i.retire_age, life_expectancy: i.life_expectancy, monthly_expenses: i.monthly_expenses,
          other_income_monthly: i.other_income_monthly || null, monthly_sip: null, step_up_pct: i.step_up_pct || null, inflation_pct: i.inflation_pct,
          return_pct: null, post_return_pct: i.post_return_pct });
      }
      this.error.set(null);
      this.invalid.set(null);
    } catch (e) {
      if (n !== this.seq) return;
      if (e instanceof HttpErrorResponse && e.status === 400) { this.invalid.set(errorMessage(e)); this.error.set(null); }
      else { this.error.set(errorMessage(e)); this.invalid.set(null); }
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }
  async save() {
    if (!this.auth.canWrite() || this.invalid()) return;
    this.saving.set(true);
    try {
      await this.store.saveSetting('retirementPlan', cleanPlan(this.form()));
      this.toast.ok('Retirement plan saved');
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 400) this.invalid.set(errorMessage(e));
      else this.toast.error(errorMessage(e));
    } finally { this.saving.set(false); }
  }
}
