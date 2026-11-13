import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { RetirementPlan } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';

type Field = { key: string; label: string; step?: number; min?: number; max?: number; hint?: string };
const FIELDS: Field[] = [
  { key: 'current_age', label: 'Your age', min: 15, max: 100 },
  { key: 'retire_age', label: 'Retire at', min: 15, max: 100 },
  { key: 'life_expectancy', label: 'Plan until age', min: 50, max: 110 },
  { key: 'monthly_expenses', label: 'Monthly expenses today (₹)', step: 1000, min: 0 },
  { key: 'other_income_monthly', label: 'Other income in retirement (₹/month, today)', step: 1000, min: 0, hint: 'pension, rent' },
  { key: 'monthly_sip', label: 'Monthly investing (₹)', step: 1000, min: 0, hint: 'blank = your SIP plans' },
  { key: 'step_up_pct', label: 'Step-up each year (%)', step: 1, min: 0, max: 50 },
  { key: 'inflation_pct', label: 'Inflation (%)', step: 0.5, min: 0, max: 15 },
  { key: 'return_pct', label: 'Return while saving (%)', step: 0.5, min: -10, max: 30, hint: 'blank = model' },
  { key: 'post_return_pct', label: 'Return after retiring (%)', step: 0.5, min: 0, max: 20 },
];
const STATUS = {
  on_track: { label: 'On track', cls: 'good', icon: 'checkCircle' },
  at_risk: { label: 'At risk', cls: 'warn', icon: 'alert' },
  off_track: { label: 'Off track', cls: 'bad', icon: 'alert' },
};

/** Retirement planner: corpus needed, projected corpus, required SIP, FIRE number and the drawdown path. */
@Component({
  selector: 'app-retirement',
  standalone: true,
  imports: [FormsModule, IconComponent, LineChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="main-aside">
      <div class="col">
        @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
        @if (r(); as r) {
          <section class="kpis" [class.loading-fade]="loading()">
            <div class="kpi hero"><span class="label">Corpus needed at {{ r.inputs.retire_age }}</span><span class="value">{{ r.corpus_needed | inrc }}</span>
              <span class="meta">funds {{ r.monthly_expenses_at_retirement | inrc }} a month for {{ r.retirement_years }} years, rising with inflation</span></div>
            <div class="kpi"><span class="chip blue sm"><app-icon name="trend" [size]="15" /></span><span class="label">On your current path</span><span class="value">{{ r.projected | inrc }}</span>
              <span class="meta" [class]="(-r.gap) | sign">{{ r.gap > 0 ? (r.gap | inrc) + ' short' : (-r.gap | inrc) + ' to spare' }}</span></div>
            <div class="kpi"><span class="chip violet sm"><app-icon name="refresh" [size]="15" /></span><span class="label">Monthly investing needed</span><span class="value">{{ r.required_sip | inr }}</span>
              <span class="meta">now {{ r.inputs.monthly_sip | inr }}{{ r.inputs.step_up_pct ? ', stepping up ' + r.inputs.step_up_pct + '% a year' : '' }}</span></div>
            <div class="kpi"><span class="chip green sm"><app-icon name="target" [size]="15" /></span><span class="label">Chance of getting there</span><span class="value">{{ r.probability ?? '—' }}%</span>
              <span class="meta">at {{ r.inputs.return_pct }}% ± {{ r.inputs.volatility_pct }}% · {{ r.inputs.return_basis }}</span></div>
          </section>

          <div class="card" [class.loading-fade]="loading()">
            <div class="card-head">
              <div><h2>Your money through life</h2><span class="hint">Saving until {{ r.inputs.retire_age }}, then drawing {{ r.monthly_expenses_at_retirement | inrc }} a month (growing {{ r.inputs.inflation_pct }}% a year)</span></div>
              <span class="badge" [class]="status[r.status].cls"><app-icon [name]="status[r.status].icon" [size]="13" /> {{ status[r.status].label }}</span>
            </div>
            <app-line-chart [labels]="labels()" [series]="series()" [height]="300" [yFormat]="inrc" [tipFormat]="inrFull" [zeroBased]="true" ariaLabel="Corpus by age" />
            @if (r.runs_out_at) {
              <div class="notice warn" style="margin-top:14px"><app-icon name="alert" [size]="16" /><span>At this pace the money runs out around age <b>{{ r.runs_out_at }}</b>, {{ r.inputs.life_expectancy - r.runs_out_at }} years early. Raising the monthly amount to {{ r.required_sip | inr }} closes the gap.</span></div>
            } @else {
              <div class="notice" style="margin-top:14px"><app-icon name="checkCircle" [size]="16" /><span>The corpus lasts past {{ r.inputs.life_expectancy }}, leaving about {{ r.path[r.path.length - 1].corpus | inrc }}.</span></div>
            }
          </div>

          <div class="grid grid-2" [class.loading-fade]="loading()">
            <div class="card">
              <div class="card-head"><div><h2>Financial independence</h2><span class="hint">The corpus that funds today's expenses for good at a 3.5% real withdrawal</span></div></div>
              <div class="fire"><span class="big">{{ r.fire.number | inrc }}</span><span class="small muted">FIRE number · you have {{ r.current | inrc }} ({{ r.fire.progress_pct | pct: 0 : false }})</span></div>
              <div class="progress" style="margin:10px 0 14px"><span [style.width.%]="r.fire.progress_pct"></span></div>
              <dl class="kv">
                <dt>Independent by</dt><dd>@if (r.fire.fi_age !== null) { age <b>{{ r.fire.fi_age }}</b> ({{ r.fire.years_to_fi }} years) } @else { beyond 40 years at this pace }</dd>
                <dt>Coast FIRE</dt><dd>@if (r.fire.coasting) { <span class="pos">Already coasting</span> } @else { needs {{ r.fire.coast_amount_now | inrc }} today }</dd>
              </dl>
              <p class="small muted" style="margin-top:12px">Coast FIRE: with {{ r.fire.coast_amount_now | inrc }} invested today and no further saving, growth alone would reach the retirement corpus by {{ r.inputs.retire_age }}.</p>
            </div>
            <div class="card">
              <div class="card-head"><h2>The numbers</h2></div>
              <dl class="kv">
                <dt>Years until retirement</dt><dd>{{ r.years_to_retire }}</dd>
                <dt>Years in retirement</dt><dd>{{ r.retirement_years }}</dd>
                <dt>Expenses then (per month)</dt><dd>{{ r.monthly_expenses_at_retirement | inr }}</dd>
                <dt>Corpus at retirement</dt><dd>{{ r.projected | inr }}</dd>
                <dt>Target corpus</dt><dd>{{ r.corpus_needed | inr }}</dd>
                <dt>Gap</dt><dd [class]="(-r.gap) | sign">{{ r.gap | inr: 0 : true }}</dd>
              </dl>
              <p class="small muted" style="margin-top:12px">{{ r.note }}</p>
            </div>
          </div>
        } @else if (!error()) { <div class="card"><div class="skeleton" style="height:320px"></div></div> }
      </div>

      <aside>
        <div class="card">
          <div class="card-head"><h2>Your plan</h2>@if (auth.canWrite()) { <button class="btn sm" (click)="save()" [disabled]="saving()">Save</button> }</div>
          <div class="form">
            @for (f of fields; track f.key) {
              <div class="field"><label [for]="'rt-' + f.key">{{ f.label }}</label>
                <input [id]="'rt-' + f.key" class="input num" type="number" [step]="f.step ?? 1" [min]="f.min ?? null" [max]="f.max ?? null"
                       [ngModel]="form()[f.key]" (ngModelChange)="set(f.key, $event)" [placeholder]="f.hint ?? ''" />
                @if (f.hint) { <span class="hint">{{ f.hint }}</span> }</div>
            }
          </div>
        </div>
      </aside>
    </div>`,
  styles: [`
    .col { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .fire { display: flex; flex-direction: column; gap: 2px; }
    .fire .big { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; }
    @media (max-width: 1000px) { .main-aside { grid-template-columns: minmax(0, 1fr); } .main-aside > aside { position: static; } }
  `],
})
export class RetirementComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  auth = inject(AuthService);
  fields = FIELDS;
  status = STATUS;
  form = signal<Record<string, number | null>>({});
  r = signal<RetirementPlan | null>(null);
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);

  labels = computed(() => this.r()?.path.map(p => `${p.year}-01-01`) ?? []);
  series = computed<LineSeries[]>(() => {
    const path = this.r()?.path ?? [];
    return [
      { key: 'save', label: 'While saving', color: 'var(--s1)', values: path.map(p => p.phase === 'saving' ? p.corpus : null), area: true },
      { key: 'ret', label: 'In retirement', color: 'var(--s4)', values: path.map((p, i) => p.phase === 'retired' || path[i + 1]?.phase === 'retired' ? p.corpus : null), area: true },
      { key: 'need', label: 'Corpus needed', color: 'var(--s2)', values: path.map(() => this.r()!.corpus_needed), dashed: true, muted: true },
    ];
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seeded = false;
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
  }
  set(key: string, v: unknown) {
    this.form.update(f => ({ ...f, [key]: v === '' || v === null || v === undefined ? null : +(v as number) }));
  }
  async load(f: Record<string, number | null>) {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.api.retirement(f));
      this.r.set(r);
      if (!Object.keys(this.form()).length) {  // first load: show the defaults the model used
        const i = r.inputs;
        this.form.set({ current_age: i.current_age, retire_age: i.retire_age, life_expectancy: i.life_expectancy, monthly_expenses: i.monthly_expenses,
          other_income_monthly: i.other_income_monthly || null, monthly_sip: null, step_up_pct: i.step_up_pct || null, inflation_pct: i.inflation_pct,
          return_pct: null, post_return_pct: i.post_return_pct });
      }
      this.error.set(null);
    } catch (e) { this.error.set(errorMessage(e)); }
    finally { this.loading.set(false); }
  }
  async save() {
    this.saving.set(true);
    try {
      const clean = Object.fromEntries(Object.entries(this.form()).filter(([, v]) => v !== null && v !== undefined));
      await this.store.saveSetting('retirementPlan', clean);
      this.toast.ok('Retirement plan saved');
    } catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.saving.set(false); }
  }
}
