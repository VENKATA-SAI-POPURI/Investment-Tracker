import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { SEGMENT_COLOR, StressTest } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../../shared/icon.component';

/** Historical-style shocks applied to today's portfolio, segment by segment. */
@Component({
  selector: 'app-stress',
  standalone: true,
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
    @if (st(); as st) {
      @let worst = worstOf(st);
      <section class="kpis">
        <div class="kpi hero"><span class="label">Worst case here: {{ worst?.label }}</span><span class="value">{{ worst?.impact | inrc: true }}</span>
          <span class="meta">{{ worst?.impact_pct | pct }} of {{ st.total | inrc }} · back to today's value in about {{ worst?.recovery_months ?? '—' }} months</span></div>
        <div class="kpi"><span class="chip blue sm"><app-icon name="pie" [size]="15" /></span><span class="label">Exposed to markets</span><span class="value">{{ st.market_exposed_pct | pct: 0 : false }}</span>
          <span class="meta">the rest (FDs, EPF, loans) does not move with prices</span></div>
        <div class="kpi"><span class="chip amber sm"><app-icon name="shield" [size]="15" /></span><span class="label">A routine correction</span><span class="value">{{ scenario(st, 'correction')?.impact | inrc: true }}</span>
          <span class="meta">{{ scenario(st, 'correction')?.impact_pct | pct }} · most years bring one</span></div>
        <div class="kpi"><span class="chip violet sm"><app-icon name="globe" [size]="15" /></span><span class="label">If the rupee falls 10%</span><span class="value" [class]="scenario(st, 'rupee')?.impact | sign">{{ scenario(st, 'rupee')?.impact | inrc: true }}</span>
          <span class="meta">dollar assets cushion the portfolio</span></div>
      </section>
      <div class="grid grid-2">
        @for (s of st.scenarios; track s.key) {
          <div class="card">
            <div class="card-head">
              <div><h2>{{ s.label }}</h2><span class="hint">{{ s.note }}</span></div>
              <div class="impact" [class]="s.impact | sign"><b>{{ s.impact | inrc: true }}</b><small>{{ s.impact_pct | pct }}</small></div>
            </div>
            @if (s.rows.length) {
              <div class="rows">
                @for (r of s.rows; track r.segment) {
                  <div class="r"><span class="ellipsis"><i class="swatch" [style.background]="color(r.segment)"></i>{{ r.segment }}</span>
                    <div class="track"><span [style.width.%]="scale(r, s)" [style.background]="r.impact < 0 ? 'var(--s8)' : 'var(--s1)'"></span></div>
                    <span class="num small" [class]="r.impact | sign">{{ r.shock_pct | pct: 0 }}</span><span class="num small" [class]="r.impact | sign">{{ r.impact | inrc: true }}</span></div>
                }
              </div>
              <div class="foot small muted">Portfolio after: <b>{{ s.after | inrc }}</b>@if (s.recovery_months) { · recovers in about <b>{{ s.recovery_months }} months</b> at long-run returns with your SIPs }</div>
            } @else { <p class="small muted">Nothing in this portfolio is affected.</p> }
          </div>
        }
      </div>
      <p class="small muted">{{ st.note }}</p>
    } @else if (!error()) { <div class="card"><div class="skeleton" style="height:300px"></div></div> }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; }
    .impact { display: flex; flex-direction: column; align-items: flex-end; } .impact b { font-size: 18px; } .impact small { font-size: 12px; color: var(--muted); }
    .rows { display: grid; gap: 8px; }
    .r { display: grid; grid-template-columns: minmax(90px, 150px) 1fr 48px 80px; gap: 10px; align-items: center; font-size: 13px; }
    .r .swatch { margin-right: 6px; vertical-align: middle; }
    .track { height: 6px; background: var(--surface-hover); border-radius: 3px; overflow: hidden; }
    .track > span { display: block; height: 100%; border-radius: 3px; }
    .foot { margin-top: 12px; }
  `],
})
export class StressComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  st = signal<StressTest | null>(null);
  error = signal<string | null>(null);
  color = (s: string) => SEGMENT_COLOR[s] ?? 'var(--muted)';
  scenario = (st: StressTest, key: string) => st.scenarios.find(s => s.key === key);
  worstOf = (st: StressTest) => st.scenarios.find(s => s.key === st.worst);
  scale = (r: { impact: number }, s: { rows: { impact: number }[] }) => Math.abs(r.impact) / Math.max(...s.rows.map(x => Math.abs(x.impact)), 1) * 100;

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }
  async load() {
    try { this.st.set(await firstValueFrom(this.api.stress())); this.error.set(null); }
    catch (e) { this.error.set(errorMessage(e)); }
  }
}
