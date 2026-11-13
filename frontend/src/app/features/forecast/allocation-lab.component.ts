import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { KeyValuePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { OptimizerResult, RiskProfileKey, SEGMENT_COLOR } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { ConfirmService } from '../../shared/ui';

/** Risk/return scatter: the frontier as a line, your portfolio and the four profiles as dots. */
@Component({
  selector: 'app-frontier-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 420 220" width="100%" role="img" aria-label="Risk and return of possible mixes" style="display:block;max-height:240px">
      @for (t of yTicks(); track t) { <line [attr.x1]="padL" x2="412" [attr.y1]="y(t)" [attr.y2]="y(t)" stroke="var(--grid)" />
        <text [attr.x]="padL - 6" [attr.y]="y(t) + 4" text-anchor="end" class="tick">{{ t }}%</text> }
      @for (t of xTicks(); track t) { <text [attr.x]="x(t)" y="214" text-anchor="middle" class="tick">{{ t }}%</text> }
      <text x="4" y="12" class="tick">return</text><text x="412" y="200" text-anchor="end" class="tick">risk (volatility)</text>
      <path [attr.d]="path()" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" />
      @for (p of profiles(); track p.key) {
        <circle [attr.cx]="x(p.vol_pct)" [attr.cy]="y(p.return_pct)" [attr.r]="p.key === selected() ? 7 : 5" [attr.fill]="p.key === selected() ? 'var(--s2)' : 'var(--surface)'" stroke="var(--s2)" stroke-width="2"><title>{{ p.label }}: {{ p.return_pct }}% at {{ p.vol_pct }}% risk</title></circle>
        <text [attr.x]="x(p.vol_pct) + 9" [attr.y]="y(p.return_pct) + 4" class="tick">{{ p.label }}</text>
      }
      @if (current(); as c) {
        <circle [attr.cx]="x(c.vol_pct)" [attr.cy]="y(c.return_pct)" r="6" fill="var(--s4)" stroke="var(--surface)" stroke-width="2"><title>You today: {{ c.return_pct }}% at {{ c.vol_pct }}% risk</title></circle>
        <text [attr.x]="x(c.vol_pct) + 9" [attr.y]="y(c.return_pct) - 6" class="tick" style="fill:var(--s4);font-weight:600">You</text>
      }
    </svg>`,
  styles: [`.tick { font-size: 10.5px; fill: var(--muted); }`],
})
export class FrontierChartComponent {
  frontier = input.required<{ vol_pct: number; ret_pct: number }[]>();
  profiles = input.required<{ key: string; label: string; vol_pct: number; return_pct: number }[]>();
  current = input<{ vol_pct: number; return_pct: number } | null>(null);
  selected = input<string>('');
  readonly padL = 40;
  private ext = computed(() => {
    const xs = [...this.frontier().map(f => f.vol_pct), ...this.profiles().map(p => p.vol_pct), this.current()?.vol_pct ?? 0];
    const ys = [...this.frontier().map(f => f.ret_pct), ...this.profiles().map(p => p.return_pct), this.current()?.return_pct ?? 0];
    return { x0: 0, x1: Math.max(...xs, 1) * 1.1, y0: Math.min(...ys, 6) - 1, y1: Math.max(...ys, 8) + 1 };
  });
  x = (v: number) => this.padL + (v - this.ext().x0) / (this.ext().x1 - this.ext().x0 || 1) * (412 - this.padL);
  y = (v: number) => 14 + (1 - (v - this.ext().y0) / (this.ext().y1 - this.ext().y0 || 1)) * 184;
  xTicks = computed(() => { const n = Math.ceil(this.ext().x1 / 4); return Array.from({ length: n + 1 }, (_, i) => i * 4).filter(t => t <= this.ext().x1); });
  yTicks = computed(() => { const out = []; for (let t = Math.ceil(this.ext().y0); t <= this.ext().y1; t += 1) out.push(t); return out; });
  path = computed(() => this.frontier().map((f, i) => `${i ? 'L' : 'M'}${this.x(f.vol_pct).toFixed(1)},${this.y(f.ret_pct).toFixed(1)}`).join(''));
}

/** Suggested asset mix per risk profile, with the trades to get there and the option to adopt it as target allocation. */
@Component({
  selector: 'app-allocation-lab',
  standalone: true,
  imports: [KeyValuePipe, IconComponent, FrontierChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
    @if (o(); as o) {
      <div class="card">
        <div class="card-head"><div><h2>Pick a risk profile</h2><span class="hint">Today your mix sits closest to <b>{{ o.current?.closest_profile }}</b>: {{ o.current?.return_pct }}% expected a year with {{ o.current?.vol_pct }}% swings</span></div>
          @if (auth.canWrite()) { <button class="btn sm" (click)="saveProfile()" [disabled]="saving() || profile() === store.settings().riskProfile">Remember this profile</button> }</div>
        <div class="profiles">
          @for (p of o.profiles; track p.key) {
            <button class="prof" [class.on]="p.key === profile()" (click)="profile.set(p.key)">
              <b>{{ p.label }}</b><span class="small">{{ p.note }}</span>
              <span class="nums"><span>{{ p.return_pct }}% <small>return</small></span><span>{{ p.vol_pct }}% <small>risk</small></span></span>
            </button>
          }
        </div>
      </div>
      <div class="grid duo" [class.loading-fade]="loading()">
        <div class="card flush">
          <div class="card-head"><div><h2>From here to {{ chosen()?.label }}</h2><span class="hint">expected {{ o.suggested?.return_pct }}% at {{ o.suggested?.vol_pct }}% risk (now {{ o.current?.return_pct }}% at {{ o.current?.vol_pct }}%) · moves about {{ o.turnover | inrc }}</span></div>
            @if (auth.canWrite()) { <button class="btn primary sm" (click)="adopt()" [disabled]="saving()"><app-icon name="target" [size]="14" /> Use as target allocation</button> }</div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Asset class</th><th class="num">Now</th><th class="num">Suggested</th><th class="num">Change</th><th></th></tr></thead>
              <tbody>
                @for (r of o.rows; track r.segment) {
                  <tr><td><i class="swatch" [style.background]="color(r.segment)" style="margin-right:8px;vertical-align:middle"></i>{{ r.segment }}@if (r.locked) { <span class="badge" style="margin-left:6px">held</span> }</td>
                    <td class="num">{{ r.current_pct | pct: 0 : false }}</td><td class="num"><b>{{ r.suggested_pct | pct: 0 : false }}</b></td>
                    <td class="num" [class]="r.delta_amount | sign">{{ r.locked ? '' : (r.delta_amount | inrc: true) }}</td>
                    <td><span class="badge" [class.good]="r.action === 'add'" [class.warn]="r.action === 'trim'">{{ r.locked ? 'stays' : r.action }}</span></td></tr>
                }
              </tbody>
            </table>
          </div>
          <p class="small muted" style="padding:14px 22px 18px;margin:0">{{ o.note }}@if (o.caps) { Caps: @for (c of o.caps | keyvalue; track c.key) { {{ c.key }} ≤ {{ c.value }}%; } }</p>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Risk against return</h2><span class="hint">the line is the best return available at each level of risk</span></div></div>
          <app-frontier-chart [frontier]="o.frontier" [profiles]="o.profiles" [current]="o.current" [selected]="profile()" />
          <div class="legend" style="margin-top:10px"><span><i class="swatch" style="background:var(--s4);border-radius:50%"></i>You today</span><span><i class="swatch" style="background:var(--s2);border-radius:50%"></i>Profiles</span><span><i class="line-key" style="background:var(--s1)"></i>Frontier</span></div>
        </div>
      </div>
    } @else if (!error()) { <div class="card"><div class="skeleton" style="height:300px"></div></div> }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; }
    .profiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .prof { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; padding: 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; transition: border-color .15s, box-shadow .15s; }
    .prof:hover { border-color: var(--border-strong); } .prof.on { border-color: var(--primary); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface); }
    .prof b { font-size: 14px; } .prof .small { color: var(--muted); min-height: 32px; }
    .prof .nums { display: flex; gap: 14px; margin-top: 6px; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; } .prof .nums small { font-weight: 400; color: var(--muted); font-size: 11px; }
    @media (max-width: 900px) { .duo { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class AllocationLabComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  store = inject(StoreService);
  auth = inject(AuthService);
  profile = signal<RiskProfileKey>((this.store.settings().riskProfile as RiskProfileKey) || 'balanced');
  o = signal<OptimizerResult | null>(null);
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  color = (s: string) => SEGMENT_COLOR[s] ?? 'var(--muted)';
  chosen = computed(() => this.o()?.profiles.find(p => p.key === this.profile()));

  constructor() {
    effect(() => { const p = this.profile(); this.store.version(); queueMicrotask(() => this.load(p)); });
  }
  async load(p: RiskProfileKey) {
    this.loading.set(true);
    try { this.o.set(await firstValueFrom(this.api.optimizer(p))); this.error.set(null); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.loading.set(false); }
  }
  async saveProfile() {
    this.saving.set(true);
    try { await this.store.saveSetting('riskProfile', this.profile()); this.toast.ok(`Risk profile set to ${this.profile()}`); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.saving.set(false); }
  }
  async adopt() {
    const c = this.chosen();
    if (!c) return;
    const w = Object.fromEntries(Object.entries(c.weights).map(([k, v]) => [k, Math.round(v)]).filter(([, v]) => (v as number) > 0)) as Record<string, number>;
    const diff = 100 - Object.values(w).reduce((a, v) => a + v, 0);
    const biggest = Object.keys(w).reduce((a, b) => (w[a] >= w[b] ? a : b));
    w[biggest] += diff;
    if (!(await this.confirm.ask('Replace your target allocation?', `Targets become the ${c.label} mix: ${Object.entries(w).map(([k, v]) => `${k} ${v}%`).join(', ')}. Drift alerts and the rebalancing planner follow these targets.`, 'Use this mix', false))) return;
    this.saving.set(true);
    try { await this.store.saveSetting('targetAllocation', w); this.toast.ok('Target allocation updated'); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.saving.set(false); }
  }
}
