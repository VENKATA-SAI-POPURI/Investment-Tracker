import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr as fmtInr } from '../../core/format';
import { errorMessage } from '../../core/http';
import { AllocationRow, AssumptionsView, ChipBlock, OptimizerResult, OptimizerRow, PlanCompare, PlanCompareRequest, RiskProfileKey, SEGMENTS, SEGMENT_COLOR,
  Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';

/* ── Target-mix arithmetic (pure; the backend rule is |Σ − 100| ≤ 0.5, analytics_api.put_setting) ── */

/** How far a target mix may be from 100% and still save (the backend's rule) or preview (H7). */
export const MIX_TOLERANCE = 0.5;

/** Σ of a mix's percentages, ignoring blanks. */
export function mixSum(mix: Record<string, number | null | undefined>): number {
  return Object.values(mix).reduce<number>((a, v) => a + (typeof v === 'number' && isFinite(v) ? v : 0), 0);
}

/** A mix the backend accepts: every value 0–100 and the sum within 100 ± 0.5. */
export function mixValid(mix: Record<string, number | null | undefined>): boolean {
  const vals = Object.values(mix).filter((v): v is number => typeof v === 'number' && isFinite(v));
  return vals.every(v => v >= 0 && v <= 100) && Math.abs(mixSum(mix) - 100) <= MIX_TOLERANCE;
}

/**
 * Scale `weights` to 100, round each to 0.5 and put the remainder on the largest row, so the sum is exactly 100
 * ("Use current mix", "Use suggested"). Zero and negative rows are dropped; an all-zero input gives {}.
 * Multiples of 0.5 are exact in binary floating point, so the sum is exactly 100.
 */
export function roundMix(weights: Record<string, number | null | undefined>): Record<string, number> {
  const rows = Object.entries(weights).filter((e): e is [string, number] => typeof e[1] === 'number' && isFinite(e[1]) && e[1] > 0);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  if (total <= 0) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of rows) out[k] = Math.round((v / total) * 200) / 2;
  const largest = rows.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  out[largest] += Math.round((100 - mixSum(out)) * 2) / 2;
  for (const k of Object.keys(out)) if (out[k] <= 0) delete out[k];
  return out;
}

/** Only the classes with a positive target, as the setting and `?mix=` take them. */
function positive(mix: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(mix).filter(([, v]) => v > 0));
}

/** Every segment, with 0 for those without a target, so the table has one input per segment. */
function filled(t: Record<string, number> | null | undefined): Record<string, number> {
  return Object.fromEntries(SEGMENTS.map(s => [s, +(t?.[s] ?? 0) || 0]));
}

/** The profile key a button stands for, by label for display. */
const PROFILE_WORD: Record<string, string> = { conservative: 'Conservative', balanced: 'Balanced', growth: 'Growth', aggressive: 'Aggressive' };

/** Debounce for "Preview impact" while the user types percentages. */
const PREVIEW_MS = 400;

/** The one inline scenario "Preview impact" compares with today's plan (R6, R16): only the mix differs. */
export function mixScenario(mix: Record<string, number>): PlanCompareRequest {
  return { scenarios: [{ name: 'Proposed mix', mix: positive(mix) }] };
}

/** One "Preview impact" plan line: a chance before (today's plan) and with the proposed mix, and the change in points. */
export type PlanDelta = { key: string; label: string; before: number | null; after: number | null; delta: number | null };

/**
 * The retirement and goal rows of a `/plan/compare` answer, read from column 1 (the proposed mix) against column 0
 * (today's plan). `deltas[1]` is the change in points on the same simulated paths (CRN), so it is read as is.
 */
export function mixPlanDeltas(c: PlanCompare | null | undefined): PlanDelta[] {
  if (!c) return [];
  return c.rows.filter(r => r.key === 'retirement' || r.key.startsWith('goal:')).map(r => ({
    key: r.key,
    label: r.key === 'retirement' ? 'Retirement' : r.label,
    before: r.values[0] ?? null,
    after: r.values[1] ?? null,
    delta: r.deltas[1] ?? null,
  }));
}

/** "+3.0 pts" / "−1.5 pts" / "no change" (|Δ| under 0.05); the sign is spelled out, never colour alone. */
export function ptsWords(d: number | null): string {
  if (d === null || !isFinite(d)) return '—';
  if (Math.abs(d) < 0.05) return 'no change';
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts`;
}

/** "tax ₹X", or "saves ₹X" when negative (K14 `tax_if_sold`). */
function taxWords(tax: number): string {
  return tax < 0 ? `saves ${fmtInr(-tax)}` : `tax ${fmtInr(tax)}`;
}

/** Risk/return scatter: the frontier as a line, your portfolio and the four profiles as dots (T3 on Risk & mix). */
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

/**
 * The first two anchors of Risk & mix's work surface (SPEC §5.6, AMENDMENTS A21, J8): `#profile` and `#mix`.
 * The page renders `#rebalance` after it inside the same `.card`.
 *
 * - **Profile:** four buttons from `GET /optimizer` `profiles`. The one nearest today's mix
 *   (`current.closest_profile`) is highlighted and says so in words; the saved `riskProfile` carries a tick and "Saved".
 *   Choosing a button only changes `profile` (the page's two-way model, which also drives the frontier and the
 *   Suggested % column); "Remember this profile" writes it (`store.saveSetting('riskProfile', key)`). Guests read only.
 * - **Target mix:** drift bars from `allocation` (the brief's rows), then the editor moved from Settings
 *   (Segment / Now % / Target % / Suggested %). "Use current mix" and "Use suggested" go through `roundMix`.
 *   Save is enabled while the sum is within 100 ± 0.5 (`mixValid`) → `store.saveSetting('targetAllocation', …)`.
 *   "Preview impact" calls `GET /assumptions?mix=` (H7), debounced and only while the sum is valid, and shows the
 *   portfolio against the proposed mix (return, typical, volatility) with est. tags and the chip; a 400 shows inline.
 *   Under the chip (R16) it adds the change in the retirement and goal chances from `POST /plan/compare` with one
 *   inline scenario {name: 'Proposed mix', mix}, on the same debounce and validity rule. Guests may use it.
 * - **Moves (K14, R16):** `moves` is `/optimizer` for the chosen profile. In the Suggested % column an FD or P2P row
 *   that would shrink reads "Let mature", and a trim shows its `tax_if_sold` ("tax ₹X" / "saves ₹X", est.).
 *
 * `wrote` fires after either setting is saved, so the page knows Home's brief snapshot is now out of date.
 */
@Component({
  selector: 'app-allocation-lab',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, StatusBadgeComponent, EstTagComponent, AssumptionChipComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section id="profile" class="al-sec" aria-labelledby="al-profile">
      <div class="al-head">
        <h2 id="al-profile"><app-icon name="pie" [size]="15" /> Risk profile</h2>
        <span class="hint">How much the portfolio may swing in a year. It sets the yardstick for the Risk check.</span>
      </div>
      @let o = opt();
      @if (error(); as e) {
        <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>Couldn't load the risk profiles · {{ e }}</span>
          <span class="spacer"></span><button type="button" class="btn sm" (click)="retry.emit()">Try again</button></div>
      } @else if (o) {
        @if (!o.current) {
          <p class="small muted">{{ o.note }}</p>
        }
        <div class="profiles" role="group" aria-label="Risk profiles">
          @for (p of o.profiles; track p.key) {
            <button type="button" class="prof" [class.on]="p.key === profile()" [class.closest]="p.key === closest()"
              [attr.aria-pressed]="p.key === profile()" (click)="profile.set(p.key)">
              <span class="prof-top"><b>{{ p.label }}</b>
                @if (p.key === saved()) { <span class="badge good"><app-icon name="check" [size]="12" />Saved</span> }
              </span>
              @if (p.key === closest()) { <span class="prof-here"><app-icon name="target" [size]="12" />Closest to your mix today</span> }
              <span class="small prof-note">{{ p.note }}</span>
              <span class="nums"><span>{{ p.return_pct }}% <small>avg return</small></span><span>±{{ p.vol_pct }}% <small>swings</small></span></span>
            </button>
          }
        </div>
        <div class="al-foot">
          <p class="small text-2">
            @if (o.current; as c) {
              Today your mix averages about {{ c.return_pct }}% a year with ±{{ c.vol_pct }}% swings, closest to <b>{{ word(c.closest_profile) }}</b>.
            }
            Long-run assumptions, not predictions.
          </p>
          @if (auth.canWrite()) {
            <button type="button" class="btn sm" (click)="saveProfile()" [disabled]="savingProfile() || profile() === saved()">
              <app-icon name="check" [size]="14" /> Remember this profile</button>
          } @else { <span class="small muted">Read-only: only the owner can change the profile.</span> }
        </div>
        @if (profileError(); as e) { <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>{{ e }}</span></div> }
      } @else {
        <div class="skeleton" style="height:132px" aria-label="Loading the risk profiles"></div>
      }
    </section>

    <section id="mix" class="al-sec" aria-labelledby="al-mix">
      <div class="al-head">
        <h2 id="al-mix"><app-icon name="target" [size]="15" /> Target mix</h2>
        <span class="hint">The mix you aim for. It drives drift alerts and the plan below.</span>
      </div>

      @if (driftRows().length) {
        <div class="drift" role="list" aria-label="Drift from your targets">
          @for (r of driftRows(); track r.segment) {
            <div class="dr" role="listitem">
              <span class="dr-name ellipsis"><i class="swatch" [style.background]="color(r.segment)"></i>{{ r.segment }}</span>
              <span class="dr-track" aria-hidden="true">
                <span class="dr-fill" [style.width.%]="r.share / driftScale() * 100" [style.background]="color(r.segment)"></span>
                @if (r.target !== null) { <span class="dr-tick" [style.left.%]="r.target / driftScale() * 100"></span> }
              </span>
              <span class="dr-num num small">{{ r.share | pct: 1 : false }}@if (r.target !== null) {<span class="muted"> / {{ r.target }}%</span>}</span>
              <span class="dr-pill"><app-status [status]="r.drift_status" [word]="driftWord(r)" /></span>
            </div>
          }
        </div>
        <p class="small muted dr-legend">
          @if (hasTargets()) { Bar: share of the classes you target (a class without a target: share of the whole portfolio) · line: your target. }
          @else { Bar: share of the portfolio now. }
        </p>
      }

      @if (!hasSaved()) {
        <div class="notice warn"><app-icon name="target" [size]="16" />
          <span>No target mix yet. Start from your current mix or the {{ chosen()?.label ?? 'suggested' }} mix, adjust, then save.</span></div>
      }

      <div class="table-wrap">
        <table class="table mix-table">
          <caption class="sr-only">Target mix by asset class: now, your target and the {{ chosen()?.label ?? '' }} suggestion</caption>
          <thead><tr>
            <th scope="col">Segment</th><th scope="col" class="num">Now %</th><th scope="col" class="num">Target %</th>
            <th scope="col" class="num"><span class="long">Suggested %</span><span class="short" aria-hidden="true">Sugg. %</span></th>
          </tr></thead>
          <tbody>
            @for (s of segments; track s) {
              <tr [class.dim]="!now()[s] && !draft()[s] && !suggested()[s]">
                <td><span class="row nowrap"><i class="swatch" [style.background]="color(s)"></i>{{ s }}</span></td>
                <td class="num">{{ now()[s] || 0 | pct: 1 : false }}</td>
                <td class="num">
                  <input class="input num mix-in" type="number" inputmode="decimal" min="0" max="100" step="0.5"
                    [ngModel]="draft()[s]" (ngModelChange)="setTarget(s, $event)" [disabled]="!auth.canWrite() || savingMix()"
                    [attr.aria-label]="s + ' target percent'" />
                </td>
                <td class="num">{{ suggested()[s] ? (suggested()[s] | pct: 1 : false) : '—' }}
                  @if (moveBy()[s]; as m) {
                    @if (m.action === 'let_mature') {
                      <span class="mv" title="Fixed deposits and P2P loans are never sold: let them mature and move the money">Let mature</span>
                    } @else if (m.action === 'trim' && isNum(m.tax_if_sold)) {
                      <span class="mv" [class.pos]="m.tax_if_sold! < 0">Trim · {{ tax(m.tax_if_sold!) }}<app-est [basis]="taxBasis" /></span>
                    }
                  }
                </td>
              </tr>
            }
          </tbody>
          <tfoot><tr>
            <td>Total</td><td class="num">{{ nowSum() | pct: 0 : false }}</td>
            <td class="num" [class.neg]="!valid()">{{ sum() | pct: 1 : false }}</td>
            <td class="num">{{ chosen() ? '100%' : '' }}</td>
          </tr></tfoot>
        </table>
      </div>

      @if (movesLine(); as ml) { <p class="small muted mv-line">{{ ml }}@if (movesTax() !== null) {<app-est [basis]="taxBasis" />}</p> }

      <p class="small mix-sum" [attr.data-status]="valid() ? 'good' : 'watch'" role="status">
        <app-icon [name]="valid() ? 'checkCircle' : 'alert'" [size]="14" />
        @if (valid()) { Adds up to 100%. } @else { Adds up to {{ sum() | pct: 1 : false }} · targets must total 100% (±0.5). }
      </p>

      <div class="mix-actions">
        @if (auth.canWrite()) {
          <button type="button" class="btn sm" (click)="useCurrent()" [disabled]="savingMix() || !nowSum()">Use current mix</button>
          <button type="button" class="btn sm" (click)="useSuggested()" [disabled]="savingMix() || !chosen()">Use suggested{{ chosen() ? ' (' + chosen()!.label + ')' : '' }}</button>
          @if (dirty()) { <button type="button" class="btn ghost sm" (click)="undo()"><app-icon name="refresh" [size]="14" /> Undo changes</button> }
        }
        <button type="button" class="btn sm" [class.on]="previewOn()" [attr.aria-expanded]="previewOn()" (click)="togglePreview()">
          <app-icon name="chart" [size]="14" /> {{ previewOn() ? 'Hide impact' : 'Preview impact' }}</button>
        <span class="spacer"></span>
        @if (auth.canWrite()) {
          <button type="button" class="btn primary sm" (click)="saveMix()" [disabled]="savingMix() || !dirty() || !valid()">Save targets</button>
        }
      </div>
      @if (mixError(); as e) { <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>{{ e }}</span></div> }

      @if (previewOn()) {
        <div class="preview" aria-live="polite">
          @let pe = previewError();
          @let v = preview();
          @if (!valid()) {
            <p class="small muted">The preview needs targets that add up to 100%.</p>
          } @else {
          @if (pe) {
            <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>Couldn't preview this mix · {{ pe }}</span></div>
          } @else if (v) {
            <div class="table-wrap" [class.loading-fade]="previewLoading()">
              <table class="table pv-table">
                <caption class="sr-only">Your portfolio now against this mix</caption>
                <thead><tr><th scope="col"></th><th scope="col" class="num">Your portfolio</th><th scope="col" class="num">This mix</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Average return a year</th><td class="num">{{ v.portfolio.return_pct | pct: 1 : false }}</td>
                    <td class="num"><b>{{ v.proposed?.return_pct | pct: 1 : false }}</b><app-est [basis]="basis(v.proposed)" /></td></tr>
                  <tr><th scope="row">Typical year</th><td class="num">{{ v.portfolio.typical_pct | pct: 1 : false }}</td>
                    <td class="num"><b>{{ v.proposed?.typical_pct | pct: 1 : false }}</b><app-est [basis]="basis(v.proposed)" /></td></tr>
                  <tr><th scope="row">Volatility (swings)</th><td class="num">±{{ v.portfolio.volatility_pct | pct: 1 : false }}</td>
                    <td class="num"><b>±{{ v.proposed?.volatility_pct | pct: 1 : false }}</b><app-est [basis]="basis(v.proposed)" /></td></tr>
                </tbody>
              </table>
            </div>
            <div class="pv-foot small muted">
              <app-assumption-chip [block]="v.proposed ?? v.portfolio" />
              <span>{{ v.note }}</span>
            </div>
          } @else {
            <div class="skeleton" style="height:120px" aria-label="Working out the impact"></div>
          }

          <div class="pv-plan" [class.loading-fade]="compareLoading() && !!compare()">
            <h3 class="pv-plan-head">Your plan with this mix</h3>
            @let ce = compareError();
            @let c = compare();
            @if (ce) {
              <p class="small neg pv-err"><app-icon name="alert" [size]="13" /> Couldn't work out the plan with this mix · {{ ce }}</p>
            } @else if (c) {
              @let ds = planDeltas();
              @if (ds.length) {
                <ul class="pv-deltas">
                  @for (d of ds; track d.key) {
                    <li>
                      <span class="pv-d-name">{{ d.label }}</span>
                      <span class="num">{{ d.before !== null ? (d.before | pct: 0 : false) : '—' }} → <b>{{ d.after !== null ? (d.after | pct: 0 : false) : '—' }}</b></span>
                      <span class="num pv-d" [class.pos]="(d.delta ?? 0) >= 0.05" [class.neg]="(d.delta ?? 0) <= -0.05">
                        @if ((d.delta ?? 0) >= 0.05) {<span aria-hidden="true">▲ </span>} @else if ((d.delta ?? 0) <= -0.05) {<span aria-hidden="true">▼ </span>}{{ pts(d.delta) }}<app-est [basis]="planBasis(c)" /></span>
                    </li>
                  }
                </ul>
                <p class="small muted pv-plan-note">Chance of reaching each target, today's plan → this mix, on the same {{ count(c.sims) }} simulated paths.</p>
              } @else {
                <p class="small muted">Save a retirement plan or add a goal on <a routerLink="/plan">Plan</a> to see how this mix moves them.</p>
              }
            } @else {
              <div class="skeleton" style="height:44px" aria-label="Working out your goals and retirement with this mix"></div>
            }
          </div>
          }
        </div>
      }
    </section>`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .al-sec { display: flex; flex-direction: column; gap: 14px; min-width: 0; scroll-margin-top: 80px; }
    .al-sec + .al-sec { border-top: 1px solid var(--border); padding-top: 22px; }
    .al-head { display: flex; flex-direction: column; gap: 2px; }
    .al-head h2 { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
    .al-head .hint { color: var(--muted); font-size: 12.5px; }
    .notice .spacer, .mix-actions .spacer { flex: 1 1 auto; }

    .profiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .prof { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; padding: 14px; border-radius: 12px; min-width: 0;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; font: inherit; transition: border-color .15s, box-shadow .15s; }
    .prof:hover { border-color: var(--border-strong); }
    .prof:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .prof.closest { background: var(--accent-soft); }
    .prof.on { border-color: var(--primary); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface); }
    .prof-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; }
    .prof-top b { font-size: 14px; }
    .prof-here { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600; color: var(--accent); }
    .prof-note { color: var(--muted); min-height: 32px; }
    .nums { display: flex; gap: 14px; margin-top: 6px; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .nums small { font-weight: 400; color: var(--muted); font-size: 11px; }
    .al-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
    .al-foot p { flex: 1 1 280px; margin: 0; }

    .drift { display: grid; gap: 10px; }
    .dr { display: grid; grid-template-columns: minmax(90px, 150px) minmax(60px, 1fr) 92px minmax(0, 150px); gap: 10px; align-items: center; font-size: 13px; }
    .dr-name .swatch { margin-right: 6px; vertical-align: middle; }
    .dr-track { position: relative; height: 8px; border-radius: 999px; background: var(--surface-hover); }
    .dr-fill { position: absolute; left: 0; top: 0; bottom: 0; max-width: 100%; border-radius: 999px; opacity: .85; }
    .dr-tick { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--text); border-radius: 1px; }
    .dr-num { text-align: right; white-space: nowrap; }
    .dr-pill { display: flex; justify-content: flex-start; min-width: 0; }
    .dr-legend { margin: -4px 0 0; }

    .mix-table .mix-in { width: 92px; height: 32px; margin-left: auto; text-align: right; }
    .mix-table th .short { display: none; }
    .mix-table tr.dim td { color: var(--muted); }
    .mix-table tfoot td { font-weight: 600; }
    .mix-sum { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--st); }
    .mix-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mix-actions .btn.on { border-color: var(--primary); }
    .preview { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 12px; background: var(--surface-2); }
    .pv-table th[scope=row] { font-weight: 500; color: var(--text-2); text-align: left; }
    .pv-foot { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
    .mix-table td .mv { display: block; margin-top: 2px; font-size: 11.5px; font-weight: 500; color: var(--text-2); white-space: normal; }
    .mix-table td .mv.pos { color: var(--pos); }
    .mv-line { margin: -4px 0 0; }
    .pv-plan { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border); }
    .pv-plan-head { font-size: 13px; font-weight: 600; margin: 0; }
    .pv-err { display: flex; align-items: center; gap: 6px; margin: 0; }
    .pv-deltas { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .pv-deltas li { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(96px, auto); gap: 4px 12px; align-items: baseline; font-size: 13px; }
    .pv-d-name { min-width: 0; overflow-wrap: anywhere; }
    .pv-d { text-align: right; white-space: nowrap; }
    .pv-plan-note { margin: 0; }

    @media (max-width: 760px) {
      .profiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .prof { padding: 12px; }
      .prof-note { display: none; }
      .nums { flex-direction: column; gap: 2px; }
      .dr { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'name num' 'track track' 'pill pill'; gap: 4px 10px; }
      .dr-name { grid-area: name; } .dr-num { grid-area: num; } .dr-track { grid-area: track; } .dr-pill { grid-area: pill; }
      .mix-table th, .mix-table td { padding: 8px 5px; font-size: 12.5px; }
      .mix-table th { letter-spacing: 0; }
      .mix-table th .long { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .mix-table th .short { display: inline; }
      .mix-table .swatch { display: none; }
      .mix-table th:first-child, .mix-table td:first-child { padding-left: 10px; }
      .mix-table th:last-child, .mix-table td:last-child { padding-right: 10px; }
      .mix-table td .row { gap: 6px; white-space: normal; }
      .mix-table .mix-in { width: 56px; height: 30px; padding: 0 6px; }
      .mix-actions .spacer { display: none; }
      .mix-table td .mv { font-size: 11px; }
      .pv-table th, .pv-table td { padding: 8px 6px; font-size: 12.5px; letter-spacing: 0; }
      .pv-table th[scope=row] { text-transform: none; white-space: normal; font-size: 12.5px; }
      .pv-table th:first-child, .pv-table td:first-child { padding-left: 4px; }
      .pv-table th:last-child, .pv-table td:last-child { padding-right: 4px; }
      .pv-deltas li { grid-template-columns: minmax(0, 1fr) auto; }
      .pv-d { grid-column: 1 / -1; text-align: left; }
    }
  `],
})
export class AllocationLabComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  readonly store = inject(StoreService);
  readonly auth = inject(AuthService);

  /** GET /optimizer, loaded by the page (it also feeds the frontier). */
  readonly opt = input<OptimizerResult | null>(null);
  readonly error = input<string | null>(null);
  /** Drift rows: `brief.allocation`, or the page's mirror of it from the portfolio's segments. */
  readonly allocation = input<AllocationRow[]>([]);
  /** The profile on screen: drives the Suggested % column and the frontier; saved only by "Remember this profile". */
  readonly profile = model<RiskProfileKey>('balanced');
  /** A setting was saved here. */
  readonly wrote = output<void>();
  /** "Try again" after the optimizer failed. */
  readonly retry = output<void>();
  /** `/optimizer` for the chosen profile (its rows are that profile's moves); null until the page has it. */
  readonly moves = input<OptimizerResult | null>(null);

  readonly segments = SEGMENTS;

  readonly saved = computed(() => (this.store.settings().riskProfile as RiskProfileKey | undefined) || null);
  readonly closest = computed(() => this.opt()?.current?.closest_profile ?? null);
  readonly chosen = computed(() => this.opt()?.profiles.find(p => p.key === this.profile()) ?? null);
  readonly savingProfile = signal(false);
  readonly profileError = signal<string | null>(null);

  // ── Target mix ──
  readonly draft = signal<Record<string, number>>(filled(null));
  readonly dirty = signal(false);
  readonly savingMix = signal(false);
  readonly mixError = signal<string | null>(null);
  readonly hasSaved = computed(() => Object.values(this.store.targets()).some(v => +v > 0));
  readonly sum = computed(() => Math.round(mixSum(this.draft()) * 100) / 100);
  readonly valid = computed(() => mixValid(this.draft()));
  /** Each segment's share of the portfolio now, from the store (fresh after every write). */
  readonly now = computed<Record<string, number>>(() =>
    Object.fromEntries((this.store.portfolio()?.segments ?? []).filter(s => s.value > 0).map(s => [s.segment, s.pct])));
  readonly nowSum = computed(() => SEGMENTS.reduce((a, s) => a + (this.now()[s] ?? 0), 0));
  readonly suggested = computed<Record<string, number>>(() => this.chosen()?.weights ?? {});

  /** Each row with the share its bar draws (`driftShare`), so bar, number, tick and pill all measure one mix. */
  readonly driftRows = computed(() => this.allocation().filter(r => (r.value ?? 0) > 0 || r.target !== null)
    .map(r => ({ ...r, share: driftShare(r) })));
  readonly hasTargets = computed(() => this.driftRows().some(r => r.target !== null));
  readonly driftScale = computed(() => Math.max(1, ...this.driftRows().map(r => Math.max(r.share, r.target ?? 0))));

  // ── Preview impact (H7) ──
  readonly previewOn = signal(false);
  readonly preview = signal<AssumptionsView | null>(null);
  readonly previewLoading = signal(false);
  readonly previewError = signal<string | null>(null);
  private previewSeq = 0;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Preview impact on the plan (R16: POST /plan/compare, one inline scenario) ──
  readonly compare = signal<PlanCompare | null>(null);
  readonly compareLoading = signal(false);
  readonly compareError = signal<string | null>(null);
  readonly planDeltas = computed(() => mixPlanDeltas(this.compare()));
  private compareSeq = 0;

  // ── The chosen profile's moves (K14) ──
  /** The moves only count when they belong to the profile on screen (the page fetches each profile once). */
  readonly moveBy = computed<Record<string, OptimizerRow>>(() => {
    const m = this.moves();
    return m && m.profile === this.profile() ? Object.fromEntries(m.rows.map(r => [r.segment, r])) : {};
  });
  /** Σ trims' tax: the payload's `tax_total` (all trims costed together), else null. */
  readonly movesTax = computed<number | null>(() => {
    const m = this.moves();
    return m && m.profile === this.profile() && this.isNum(m.tax_total) && Object.values(this.moveBy()).some(r => r.action === 'trim') ? m.tax_total! : null;
  });
  /** One line under the table naming what the moves to the suggested mix involve, or '' when nothing is trimmed or matures. */
  readonly movesLine = computed(() => {
    const rows = Object.values(this.moveBy());
    const trims = rows.filter(r => r.action === 'trim').length, mature = rows.some(r => r.action === 'let_mature');
    if (!trims && !mature) return '';
    const label = this.chosen()?.label ?? 'suggested';
    const parts: string[] = [];
    const t = this.movesTax();
    if (trims) parts.push(t !== null ? `the trims ${t < 0 ? 'save' : 'cost'} about ${fmtInr(Math.abs(t))} in tax together, lowest tax first` : 'trims may cost capital-gains tax');
    if (mature) parts.push('FD and P2P are left to mature, never sold');
    return `Moving to the ${label} mix: ${parts.join('; ')}.`;
  });

  readonly taxBasis = 'Capital-gains tax on the trims at today\'s prices, FIFO lots and your slab rate, all costed together so the yearly exemption is used once. Before exit loads. An estimate, not advice';

  constructor() {
    // the saved targets are the starting point, until the user edits them
    effect(() => {
      const t = this.store.targets();
      untracked(() => { if (!this.dirty()) this.draft.set(filled(t)); });
    });
    // preview the edited mix, debounced, only while it would be accepted
    effect(() => {
      const on = this.previewOn(), mix = this.draft(), ok = this.valid();
      this.store.version();
      untracked(() => {
        if (this.previewTimer) { clearTimeout(this.previewTimer); this.previewTimer = null; }
        if (!on || !ok) {
          this.previewSeq++; this.previewLoading.set(false);
          this.compareSeq++; this.compareLoading.set(false);
          return;
        }
        this.previewLoading.set(true);
        this.compareLoading.set(true);
        this.previewTimer = setTimeout(() => {
          this.previewTimer = null;
          void this.loadPreview(mix);
          void this.loadCompare(mix);
        }, this.preview() ? PREVIEW_MS : 0);
      });
    });
    inject(DestroyRef).onDestroy(() => { if (this.previewTimer) clearTimeout(this.previewTimer); this.previewSeq++; this.compareSeq++; });
  }

  color(s: string): string { return SEGMENT_COLOR[s] ?? 'var(--muted)'; }
  isNum(v: number | null | undefined): boolean { return typeof v === 'number' && isFinite(v); }
  tax(v: number): string { return taxWords(v); }
  pts(d: number | null): string { return ptsWords(d); }
  count(n: number | null | undefined): string { return (n ?? 0).toLocaleString('en-IN'); }
  planBasis(c: PlanCompare): string {
    return `Your plan re-run with this mix on the same ${this.count(c.sims)} simulated paths as today's plan, so only the mix differs. An estimate, not a promise`;
  }
  word(k: string | null | undefined): string { return (k && PROFILE_WORD[k]) || k || ''; }
  basis(b: ChipBlock | null | undefined): string {
    return b?.basis ? `${b.basis} · Long-run assumptions, not predictions` : 'Long-run assumptions for this mix, not predictions';
  }

  /** "+3.2 pts over" / "−2.0 pts under" / "on target" / "no target" (status icon + these words, never colour alone). */
  driftWord(r: AllocationRow): string {
    if (r.target === null || r.drift === null) return 'No target';
    const d = r.drift;
    if (Math.abs(d) < 0.05) return 'On target';
    return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts ${d > 0 ? 'over' : 'under'}`;
  }

  async saveProfile() {
    const p = this.profile();
    this.savingProfile.set(true);
    this.profileError.set(null);
    try {
      await this.store.saveSetting('riskProfile', p);
      this.toast.ok(`Risk profile set to ${this.word(p)}`);
      this.wrote.emit();
    } catch (e) {
      this.profileError.set(errorMessage(e));
    } finally {
      this.savingProfile.set(false);
    }
  }

  setTarget(segment: string, v: unknown) {
    const n = v === null || v === undefined || v === '' ? 0 : Number(v);
    this.draft.update(d => ({ ...d, [segment]: isFinite(n) ? n : 0 }));
    this.dirty.set(true);
    this.mixError.set(null);
  }

  useCurrent() { this.apply(roundMix(this.now())); }
  useSuggested() { this.apply(roundMix(this.suggested())); }
  private apply(mix: Record<string, number>) {
    if (!Object.keys(mix).length) return;
    this.draft.set(filled(mix));
    this.dirty.set(true);
    this.mixError.set(null);
  }

  undo() {
    this.draft.set(filled(this.store.targets()));
    this.dirty.set(false);
    this.mixError.set(null);
  }

  async saveMix() {
    if (!this.valid()) return;
    const mix = positive(this.draft());
    this.savingMix.set(true);
    this.mixError.set(null);
    try {
      await this.store.saveSetting('targetAllocation', mix);
      this.dirty.set(false);
      this.draft.set(filled(mix));
      this.toast.ok('Target mix saved');
      this.wrote.emit();
    } catch (e) {
      this.mixError.set(errorMessage(e));
    } finally {
      this.savingMix.set(false);
    }
  }

  togglePreview() { this.previewOn.update(v => !v); }

  private async loadPreview(mix: Record<string, number>) {
    const mine = ++this.previewSeq;
    try {
      const v = await firstValueFrom(this.api.assumptions(positive(mix)));
      if (mine !== this.previewSeq) return;
      this.preview.set(v);
      this.previewError.set(null);
    } catch (e) {
      if (mine !== this.previewSeq) return;
      this.previewError.set(errorMessage(e));
    } finally {
      if (mine === this.previewSeq) this.previewLoading.set(false);
    }
  }

  /** R16: today's plan against the same plan with this mix (one inline scenario; guests may run it too). */
  private async loadCompare(mix: Record<string, number>) {
    const mine = ++this.compareSeq;
    try {
      const c = await firstValueFrom(this.api.post<PlanCompare>('/plan/compare', mixScenario(mix)));
      if (mine !== this.compareSeq) return;
      this.compare.set(c);
      this.compareError.set(null);
    } catch (e) {
      if (mine !== this.compareSeq) return;
      this.compareError.set(errorMessage(e));
    } finally {
      if (mine === this.compareSeq) this.compareLoading.set(false);
    }
  }
}

/**
 * The share a drift bar draws, as Home's allocation card does: a targeted row's share of the targeted classes
 * (`target + drift`, i.e. the segment's `mix_pct`), which is what its target and drift are measured in; a row
 * without a target keeps `pct`, its share of the whole portfolio.
 */
export function driftShare(r: Pick<AllocationRow, 'pct' | 'target' | 'drift'>): number {
  return r.target !== null && r.drift !== null ? r.target + r.drift : (r.pct ?? 0);
}

/** For the page's T0 "Off target" tile and drift bars when the brief has no `allocation` (mirrors `brief._allocation`). */
export const DRIFT_WATCH = 2.5;
export const DRIFT_ACT = 5;
export function driftStatus(target: number | null, drift: number | null): Status {
  if (target === null || drift === null) return 'unset';
  return Math.abs(drift) >= DRIFT_ACT ? 'act' : Math.abs(drift) >= DRIFT_WATCH ? 'watch' : 'good';
}
