import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Plan, PlanCompare, PlanCompareRow, PlanScenario, PlanSensitivity, Settings } from '../../core/models';
import { readSnapshot, snapshotKey } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { LineBand, LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

/* ── Limits (R5, R6) ── */

/** `planScenarios` holds at most this many (R5). */
export const MAX_SAVED = 5;
/** `POST /plan/compare` takes at most 4 scenarios, or 2 for guests (R6). */
export const MAX_COMPARE = 4;
export const MAX_COMPARE_GUEST = 2;
/** A scenario's lump sums (R5). */
export const MAX_LUMPS = 10;
export const NAME_MAX = 40;

/** A scenario that may leave fields null (or out) to keep the baseline's value: an inline `/plan/compare` body (R5). */
export type InlineScenario = Partial<PlanScenario> & { name: string };

/** `POST /plan/compare` plus the two keys W7-B1 adds (R6); read locally so this page never waits on `models.ts`. */
export type PlanCompareResult = PlanCompare;
/** `GET /plan?detail=1` (R7): `/plan` plus the sensitivities and the resolved baseline. */
export type PlanDetail = Plan;

/* ── Session-only scenarios (the W5-F3 Undo pattern) ── */

/** A scenario kept for this visit only: a guest's "Try it", or a writer's when 5 are already saved. */
export interface SessionScenario { id: string; scope: string; scenario: InlineScenario; }

const session = signal<SessionScenario[]>([]);
let sessionSeq = 0;
/** Every session scenario, for every scope; gone after a browser reload. */
export const sessionScenarios = session.asReadonly();

/** Keeps `scenario` for this visit under `scope` and returns its id. */
export function addSessionScenario(scope: string, scenario: InlineScenario): string {
  const id = `t${++sessionSeq}`;
  session.update(list => [...list, { id, scope, scenario }]);
  return id;
}
export function removeSessionScenario(id: string): void {
  session.update(list => list.filter(s => s.id !== id));
}

/**
 * The selection key the Scenarios tab preselects the next time it opens (`saved:<index>` or `session:<id>`), set by
 * "Try it" on Overview. The tab clears it once read.
 */
export const pendingFocus = signal<string | null>(null);

/** The last selection per scope, so leaving the tab and coming back keeps what was being compared. */
const lastSelection = new Map<string, string[]>();

/* ── Pure helpers ── */

/** A sensitivity's scenario named from its label ("SIP +₹5,000/month"), ready to save (R15). */
export function sensitivityScenario(s: Pick<PlanSensitivity, 'label' | 'scenario'>): PlanScenario {
  const name = (s.label || s.scenario?.name || 'Scenario').trim().slice(0, NAME_MAX);
  return { ...s.scenario, name, lump_sums: [...(s.scenario?.lump_sums ?? [])] };
}

const FIELDS = ['sip', 'step', 'return', 'retire_age', 'inflation_pct', 'lump_sums', 'mix'] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Two scenarios that would compute the same thing (the name is ignored). */
export function sameScenario(a: Partial<PlanScenario>, b: Partial<PlanScenario>): boolean {
  return FIELDS.every(k => same(a[k], b[k]));
}

/**
 * `s` with every field equal to the baseline's set to null (R5: null means "the baseline's value"), so a session
 * scenario follows later changes to today's plan in everything it does not change. Without a baseline, `s` as is.
 */
export function partialAgainst(s: PlanScenario, base: PlanScenario | null | undefined): InlineScenario {
  if (!base) return { ...s };
  const out: InlineScenario = { name: s.name };
  for (const k of FIELDS) {
    if (k === 'lump_sums') { out.lump_sums = s.lump_sums?.length ? s.lump_sums : []; continue; }
    (out as Record<string, unknown>)[k] = same(s[k], base[k]) ? null : s[k];
  }
  return out;
}

/** An inline scenario with the baseline's values filled in where it has none. */
export function resolveAgainst(s: InlineScenario, base: PlanScenario): PlanScenario {
  const pick = <K extends keyof PlanScenario>(k: K): PlanScenario[K] =>
    (s[k] === null || s[k] === undefined ? base[k] : s[k]) as PlanScenario[K];
  return {
    name: s.name, sip: pick('sip'), step: pick('step'), return: pick('return'), retire_age: pick('retire_age'),
    lump_sums: s.lump_sums?.length ? s.lump_sums : base.lump_sums ?? [], inflation_pct: pick('inflation_pct'), mix: pick('mix'),
  };
}

/** True when an inline scenario leaves any field to the baseline (it must go through `api.post`, R5). */
export function isPartial(s: Partial<PlanScenario>): boolean {
  return s.sip === null || s.sip === undefined || s.step === null || s.step === undefined || !Array.isArray(s.lump_sums);
}

/**
 * The server's baseline (R5), worked out locally until a compare answers: the saved `retirementPlan.monthly_sip`
 * when set, else the SIP plans' monthly total; the saved step-up or 0; the saved retirement age or null.
 */
export function localBaseline(settings: Pick<Settings, 'retirementPlan'>, plan: Pick<Plan, 'sip'> | null | undefined): PlanScenario {
  const rp = settings.retirementPlan ?? {};
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null);
  const sip = num(rp['monthly_sip']) ?? plan?.sip?.plans_monthly_total ?? 0;
  return {
    // to the paisa, as the server rounds it: a weekly plan's ₹4,333.33 must not read as a changed SIP
    name: "Today's plan", sip: Math.max(0, Math.round(sip * 100) / 100), step: num(rp['step_up_pct']) ?? 0, return: null,
    retire_age: num(rp['retire_age']), lump_sums: [], inflation_pct: null, mix: null,
  };
}

/** What a scenario changes against the baseline, in words ("SIP ₹65,000/month · retire at 57"). */
export function describeScenario(s: InlineScenario, base: PlanScenario | null): string {
  const out: string[] = [];
  const diff = (k: keyof PlanScenario) => s[k] !== null && s[k] !== undefined && (!base || !same(s[k], base[k]));
  if (diff('sip')) out.push(`SIP ${inr(s.sip!)}/month`);
  if (diff('step')) out.push(s.step ? `+${s.step}% a year` : 'no step-up');
  if (diff('return')) out.push(`${s.return}% a year return`);
  if (diff('retire_age')) out.push(`retire at ${s.retire_age}`);
  if (diff('inflation_pct')) out.push(`${s.inflation_pct}% inflation`);
  const lumps = s.lump_sums ?? [];
  if (lumps.length) {
    const total = lumps.reduce((a, l) => a + (+l.amount || 0), 0);
    out.push(`${lumps.length} lump sum${lumps.length === 1 ? '' : 's'} (${inrCompact(total)})`);
  }
  if (diff('mix')) out.push('its own mix');
  return out.length ? out.join(' · ') : "Same as today's plan";
}

/** A value formatted by its row's `format` (R6): ₹ compact, a whole %, points, or an age. Null reads "—". */
export function fmtValue(v: number | null | undefined, format: PlanCompareRow['format']): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  switch (format) {
    case 'inr': return inrCompact(v);
    case 'pct': return `${Math.round(v)}%`;
    case 'pts': return `${Math.round(v * 10) / 10} pts`;
    case 'age': return String(Math.round(v));
  }
}

export interface DeltaView { text: string; dir: 'up' | 'down' | 'flat'; tone: 'pos' | 'neg' | 'neutral'; }

/**
 * A delta under a compare value (R15). A `pct` row's delta is shown in points ("+6 pts"), ₹ rows compact and signed,
 * ages in years. ▲/▼ is coloured by sign: up is good, except "Monthly needed" (`needed`), where needing less is good,
 * and the retirement age, which is a choice rather than an outcome (neutral). Null when there is no delta to show.
 */
export function fmtDelta(d: number | null | undefined, format: PlanCompareRow['format'], key = ''): DeltaView | null {
  if (d === null || d === undefined || !isFinite(d)) return null;
  let mag: number, text: string;
  if (format === 'inr') { mag = Math.abs(d) < 1 ? 0 : d; text = inrCompact(Math.abs(mag)); }
  else if (format === 'pct' || format === 'pts') { mag = Math.round(d); text = `${Math.abs(mag)} pts`; }
  else { mag = Math.round(d); text = `${Math.abs(mag)} yr${Math.abs(mag) === 1 ? '' : 's'}`; }
  if (mag === 0) return { text: format === 'inr' ? 'no change' : `±${text}`, dir: 'flat', tone: 'neutral' };
  const dir = mag > 0 ? 'up' : 'down';
  const good = key === 'needed' ? mag < 0 : mag > 0;
  const tone = format === 'age' || key === 'retire_age' ? 'neutral' : good ? 'pos' : 'neg';
  return { text: `${mag > 0 ? '+' : '−'}${text}`, dir, tone };
}

/** Probability points with a sign, whole numbers (§1.9): "+6 pts", "−2 pts", "±0 pts"; null reads "—". */
export function fmtPts(d: number | null | undefined): string {
  if (d === null || d === undefined || !isFinite(d)) return '—';
  const r = Math.round(d);
  return r === 0 ? '±0 pts' : `${r > 0 ? '+' : '−'}${Math.abs(r)} pts`;
}

/** The editor's fields; blanks are null. */
export interface ScenarioForm {
  name: string; sip: number | null; step: number | null; return: number | null; retire_age: number | null;
  inflation_pct: number | null; lump_sums: { date: string; amount: number | null }[];
}

function blank(v: unknown): boolean { return v === null || v === undefined || v === ''; }
function inRange(v: unknown, lo: number, hi: number): boolean { const n = +(v as number); return isFinite(n) && n >= lo && n <= hi; }

/** The R5 rules for a saved scenario, client-side: field → message. Empty when it can be saved. */
export function scenarioErrors(f: ScenarioForm): Record<string, string> {
  const e: Record<string, string> = {};
  const name = (f.name ?? '').trim();
  if (!name) e['name'] = 'Give it a name';
  else if (name.length > NAME_MAX) e['name'] = `At most ${NAME_MAX} characters`;
  if (blank(f.sip) || !inRange(f.sip, 0, 1e8)) e['sip'] = 'A monthly amount from ₹0 to ₹10 crore';
  if (!blank(f.step) && !inRange(f.step, 0, 50)) e['step'] = 'From 0% to 50%';
  if (!blank(f.return) && !inRange(f.return, -10, 30)) e['return'] = 'From −10% to 30%, or blank';
  if (!blank(f.retire_age) && (!inRange(f.retire_age, 15, 110) || !Number.isInteger(+f.retire_age!))) e['retire_age'] = 'A whole age from 15 to 110, or blank';
  if (!blank(f.inflation_pct) && !inRange(f.inflation_pct, 0, 15)) e['inflation_pct'] = 'From 0% to 15%, or blank';
  if ((f.lump_sums ?? []).length > MAX_LUMPS) e['lump_sums'] = `At most ${MAX_LUMPS} lump sums`;
  (f.lump_sums ?? []).forEach((l, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date ?? '')) e[`lump${i}`] = 'Pick a date';
    else if (blank(l.amount) || !inRange(l.amount, 0, 1e9)) e[`lump${i}`] = 'An amount from ₹0 to ₹100 crore';
  });
  return e;
}

/** The editor's fields as a saved scenario (`mix` kept from the original: it is edited on Risk & mix only). */
export function formToScenario(f: ScenarioForm, mix: Record<string, number> | null): PlanScenario {
  const n = (v: unknown) => (blank(v) ? null : +(v as number));
  return {
    name: f.name.trim(), sip: n(f.sip) ?? 0, step: n(f.step) ?? 0, return: n(f.return), retire_age: n(f.retire_age),
    lump_sums: (f.lump_sums ?? []).map(l => ({ date: l.date, amount: +(l.amount ?? 0) })), inflation_pct: n(f.inflation_pct), mix,
  };
}

function scenarioToForm(s: PlanScenario): ScenarioForm {
  return {
    name: s.name, sip: s.sip, step: s.step, return: s.return, retire_age: s.retire_age, inflation_pct: s.inflation_pct,
    lump_sums: (s.lump_sums ?? []).map(l => ({ ...l })),
  };
}

/** Line colours per column; column 0 (today's plan) shares the band's colour. */
const PALETTE = ['var(--s1)', 'var(--s2)', 'var(--s7)', 'var(--s3)', 'var(--s5)'];

/** One entry in the list: a saved scenario or a session one. */
interface Item { key: string; kind: 'saved' | 'session'; index: number; id: string | null; scenario: InlineScenario; }

/** The editor's state: a new saved scenario, an edit of saved #index, or a session one being saved. */
interface Editing { mode: 'new' | 'edit' | 'promote'; index: number; sessionId: string | null; mix: Record<string, number> | null; }

/**
 * Plan › Scenarios (SPEC §5.2 Scenarios tab, §6.10; AMENDMENTS R5, R6, R15). The tab body only: Plan owns the page,
 * its one h1 and the navy T0.
 *
 * - Lists the saved `planScenarios` (≤ 5) and the session-only ones that "Try it" added for this visit.
 * - The selected ones (≤ 4, guests ≤ 2) are compared with today's plan through `POST /plan/compare`: saved ones by
 *   index, session ones inline, where null keeps the baseline's value (R5). Every column runs on the same random
 *   draws, so a delta is the change itself.
 * - The table: rows × columns, each value by its `format` with its delta under it (`pct` deltas in points, ▲/▼
 *   coloured by sign). The chart: the baseline's p10–p90 band and one typical (p50) line per column.
 * - Writers get an editor (name, SIP, step-up, return, retire at, inflation, lump sums; prefilled from the baseline),
 *   Save (≤ 5) and Delete. The mix is edited on Risk & mix only.
 */
@Component({
  selector: 'app-plan-scenarios',
  standalone: true,
  imports: [DecimalPipe, FormsModule, RouterLink, IconComponent, ModalComponent, LineChartComponent, EstTagComponent, AssumptionChipComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card flush" aria-labelledby="sc-title">
      <div class="card-head pad-head">
        <div><h2 id="sc-title">Scenarios</h2>
          <span class="hint">Change one thing and see what it does to today's plan. Pick up to {{ limit() }} to compare{{ canWrite() ? '' : ' (guests compare 2 at a time)' }}.</span></div>
        @if (canWrite()) {
          <button type="button" class="btn sm primary" (click)="startNew()" [disabled]="saved().length >= maxSaved"
            [attr.title]="saved().length >= maxSaved ? 'You have ' + maxSaved + ' saved scenarios: delete one to add another' : null">
            <app-icon name="plus" [size]="15" /> Add a scenario</button>
        }
      </div>

      @if (items().length) {
        <ul class="sc-list" role="list">
          @for (it of items(); track it.key) {
            @let on = isSelected(it.key);
            <li class="sc-item" [class.on]="on">
              <label class="check sc-pick">
                <input type="checkbox" [checked]="on" [disabled]="!on && selected().length >= limit()" (change)="toggle(it.key)"
                  [attr.aria-label]="'Compare ' + it.scenario.name" />
                <span class="sc-text">
                  <b class="sc-name">{{ it.scenario.name }}</b>
                  <span class="small muted">{{ describe(it.scenario) }}</span>
                </span>
              </label>
              <span class="sc-tags">
                @if (it.kind === 'session') { <span class="badge warn" title="Kept until you reload or leave the app">This visit only</span> }
                @else { <span class="badge">Saved</span> }
                @if (it.scenario.mix) { <a class="badge info" routerLink="/risk" fragment="mix" title="Set on Risk & mix">Own mix</a> }
              </span>
              <span class="sc-tools">
                @if (canWrite() && it.kind === 'saved') {
                  <button type="button" class="btn ghost icon sm" (click)="startEdit(it)" [attr.aria-label]="'Edit ' + it.scenario.name"><app-icon name="edit" [size]="15" /></button>
                  <button type="button" class="btn ghost icon sm danger" (click)="remove(it)" [attr.aria-label]="'Delete ' + it.scenario.name"><app-icon name="trash" [size]="15" /></button>
                }
                @if (it.kind === 'session') {
                  @if (canWrite()) {
                    <button type="button" class="btn sm" (click)="startPromote(it)" [disabled]="saved().length >= maxSaved"
                      [attr.title]="saved().length >= maxSaved ? 'You have ' + maxSaved + ' saved scenarios already' : null">Save</button>
                  }
                  <button type="button" class="btn ghost icon sm" (click)="dropSession(it)" [attr.aria-label]="'Remove ' + it.scenario.name"><app-icon name="close" [size]="15" /></button>
                }
              </span>
            </li>
          }
        </ul>
        @if (canWrite() && saved().length >= maxSaved) {
          <p class="small muted pad-x">{{ maxSaved }} saved, the most there can be. Delete one to save another; "Try it" keeps new ones for this visit.</p>
        }
      } @else {
        <div class="empty">
          <app-icon name="layers" [size]="26" /><h3>No scenarios yet</h3>
          <p>Try a change from What moves the needle, or add one.</p>
          <div class="row-gap">
            <a class="btn sm" routerLink="/plan">What moves the needle →</a>
            @if (canWrite()) { <button type="button" class="btn sm primary" (click)="startNew()"><app-icon name="plus" [size]="15" /> Add a scenario</button> }
          </div>
        </div>
      }
    </section>

    @if (items().length) {
      @if (!selected().length) {
        <div class="notice" role="status"><app-icon name="info" [size]="16" /><span>Tick up to {{ limit() }} scenarios to compare them with today's plan.</span></div>
      } @else {
      @if (result(); as res) {
        <section class="card flush" aria-labelledby="sc-table-title" [class.loading-fade]="loading()">
          <div class="card-head pad-head">
            <div><h2 id="sc-table-title">Side by side</h2>
              <span class="hint">{{ res.sims | number }} simulated futures per column, all on the same random draws, so each difference is the change itself · estimates, not promises</span></div>
            @if (res.assumptions) { <app-assumption-chip [block]="res.assumptions" /> }
          </div>
          @if (error(); as err) {
            <div class="notice warn pad-x" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't update the comparison: {{ err }}. Showing the last one.</span>
              <button type="button" class="btn sm" (click)="retry()">Try again</button></div>
          }
          <div class="table-wrap">
            <table class="table compare">
              <caption class="sr-only">Today's plan against each scenario; the change from today's plan is under each value</caption>
              <thead><tr><th scope="col">Outcome</th>
                @for (c of res.columns; track $index) { <th scope="col" class="num" [class.base]="$index === 0">{{ c }}</th> }</tr></thead>
              <tbody>
                @for (row of res.rows; track row.key) {
                  <tr>
                    <th scope="row">{{ row.label }}@if (row.format === 'inr') { <app-est [basis]="estBasis(res)" /> }</th>
                    @for (v of row.values; track $index) {
                      <td class="num" [class.base]="$index === 0">
                        <span class="val">{{ value(v, row) }}</span>
                        @if ($index > 0) {
                          @if (delta(row, $index); as d) {
                            <span class="delta" [class.pos]="d.tone === 'pos'" [class.neg]="d.tone === 'neg'" [class.muted]="d.tone === 'neutral'">
                              @if (d.dir === 'up') { <span aria-hidden="true">▲ </span> } @else if (d.dir === 'down') { <span aria-hidden="true">▼ </span> }{{ d.text }}</span>
                          } @else { <span class="delta muted">—</span> }
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (res.honesty && res.honesty['p50']) { <p class="small muted pad-x foot">{{ honestyLine(res.honesty['p50']) }}</p> }
        </section>

        <section class="card" aria-labelledby="sc-chart-title" [class.loading-fade]="loading()">
          <div class="card-head"><div><h2 id="sc-chart-title">How they could unfold</h2>
            <span class="hint">Shaded: where 8 in 10 of today's plan's futures land · lines: the typical future of each column (est.)</span></div></div>
          <app-line-chart [labels]="chartLabels()" [series]="chartSeries()" [bands]="chartBands()" [xLabel]="yearLabel"
            [height]="300" [yFormat]="inrc" [tipFormat]="inrFull" [zeroBased]="true"
            ariaLabel="Typical portfolio value by year for today's plan and each scenario, over today's plan's 8-in-10 range (estimates)" />
        </section>
      } @else if (error()) {
        <div class="card"><div class="empty">
          <app-icon name="alert" [size]="22" /><h3>Couldn't compare these scenarios</h3><p>{{ error() }}</p>
          <button type="button" class="btn" (click)="retry()"><app-icon name="refresh" [size]="15" /> Try again</button>
        </div></div>
      } @else {
        <div class="card" aria-busy="true"><p class="small muted">Simulating {{ selected().length + 1 }} plans on the same {{ canWrite() ? '1,000' : '500' }} futures…</p>
          <div class="skeleton" style="height:180px;margin-top:10px"></div></div>
        <div class="card" aria-busy="true"><div class="skeleton" style="height:300px"></div></div>
      }
      }
    }

    @if (editing(); as ed) {
      <app-modal [title]="ed.mode === 'edit' ? 'Edit scenario' : 'New scenario'" [width]="560" (close)="closeEditor()">
        <form class="form" (ngSubmit)="saveScenario()" novalidate>
          <p class="small muted">Blank fields keep today's plan. Today: SIP {{ baseline().sip | inr }}/month{{ baseline().step ? ', +' + baseline().step + '% a year' : '' }}{{ baseline().retire_age !== null ? ', retiring at ' + baseline().retire_age : '' }}.</p>
          <div class="field"><label for="sc-name">Name</label>
            <input id="sc-name" class="input" name="name" maxlength="40" [(ngModel)]="f.name" placeholder="e.g. Retire at 55" [attr.aria-invalid]="err('name') ? true : null" aria-describedby="sc-name-err" />
            @if (err('name'); as m) { <span class="err" id="sc-name-err">{{ m }}</span> }</div>
          <div class="cols">
            <div class="field"><label for="sc-sip">Monthly SIP (₹)</label>
              <input id="sc-sip" class="input num" type="number" min="0" step="500" name="sip" [(ngModel)]="f.sip" [attr.aria-invalid]="err('sip') ? true : null" />
              @if (err('sip'); as m) { <span class="err">{{ m }}</span> }</div>
            <div class="field"><label for="sc-step">Step-up each year (%)</label>
              <input id="sc-step" class="input num" type="number" min="0" max="50" step="1" name="step" [(ngModel)]="f.step" placeholder="0" [attr.aria-invalid]="err('step') ? true : null" />
              @if (err('step'); as m) { <span class="err">{{ m }}</span> }</div>
            <div class="field"><label for="sc-ret">Return (% a year)</label>
              <input id="sc-ret" class="input num" type="number" min="-10" max="30" step="0.5" name="ret" [(ngModel)]="f.return" placeholder="your mix" [attr.aria-invalid]="err('return') ? true : null" />
              @if (err('return'); as m) { <span class="err">{{ m }}</span> } @else { <span class="hint">Blank = the model's return for your mix</span> }</div>
            <div class="field"><label for="sc-age">Retire at</label>
              <input id="sc-age" class="input num" type="number" min="15" max="110" step="1" name="age" [(ngModel)]="f.retire_age" placeholder="your plan" [attr.aria-invalid]="err('retire_age') ? true : null" />
              @if (err('retire_age'); as m) { <span class="err">{{ m }}</span> }</div>
            <div class="field"><label for="sc-inf">Inflation (%)</label>
              <input id="sc-inf" class="input num" type="number" min="0" max="15" step="0.5" name="inf" [(ngModel)]="f.inflation_pct" placeholder="your plan" [attr.aria-invalid]="err('inflation_pct') ? true : null" />
              @if (err('inflation_pct'); as m) { <span class="err">{{ m }}</span> }</div>
          </div>
          <fieldset class="field lumps">
            <legend>One-off amounts</legend>
            @for (l of f.lump_sums; track $index; let i = $index) {
              <div class="lump-row">
                <input class="input" type="date" [name]="'ld' + i" [(ngModel)]="l.date" [attr.aria-label]="'Date of lump sum ' + (i + 1)" />
                <input class="input num" type="number" min="0" step="10000" [name]="'la' + i" [(ngModel)]="l.amount" placeholder="₹" [attr.aria-label]="'Amount of lump sum ' + (i + 1)" />
                <button type="button" class="btn ghost icon sm" (click)="removeLump(i)" [attr.aria-label]="'Remove lump sum ' + (i + 1)"><app-icon name="close" [size]="14" /></button>
                @if (err('lump' + i); as m) { <span class="err lump-err">{{ m }}</span> }
              </div>
            }
            @if (f.lump_sums.length < maxLumps) { <button type="button" class="btn sm ghost add-lump" (click)="addLump()"><app-icon name="plus" [size]="14" /> Add a lump sum</button> }
            <span class="hint">Money added once, for example a bonus or a matured FD.</span>
          </fieldset>
          @if (ed.mix) { <p class="small muted">This scenario carries its own mix, which is changed on <a routerLink="/risk" fragment="mix" (click)="closeEditor()">Risk &amp; mix →</a></p> }
          @if (formError(); as m) { <div class="notice bad" role="alert">{{ m }}</div> }
          <div class="form-actions"><button type="button" class="btn" (click)="closeEditor()">Cancel</button>
            <button class="btn primary" type="submit" [disabled]="saving()">Save scenario</button></div>
        </form>
      </app-modal>
    }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .pad-head { padding: 18px 22px 0; }
    .pad-x { margin: 0 22px 16px; }
    .sc-list { list-style: none; margin: 0; padding: 0; }
    .sc-item { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px 14px; padding: 12px 22px;
      border-top: 1px solid var(--border); }
    .sc-item.on { background: color-mix(in srgb, var(--primary) 5%, transparent); }
    .sc-pick { align-items: flex-start; min-width: 0; }
    .sc-pick input { margin-top: 3px; flex: none; }
    .sc-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .sc-name { overflow-wrap: anywhere; }
    .sc-tags { display: flex; gap: 6px; flex-wrap: wrap; }
    .sc-tags a.badge { text-decoration: none; }
    .sc-tools { display: flex; gap: 4px; align-items: center; justify-content: flex-end; }
    .row-gap { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    .compare th[scope=row] { font-weight: 500; white-space: normal; min-width: 150px; text-transform: none; letter-spacing: normal;
      font-size: 13px; color: var(--text); position: sticky; left: 0; z-index: 1; background: var(--surface); }
    .compare td { vertical-align: top; }
    .compare .base { background: var(--surface-2); }
    .compare .val { display: block; font-weight: 600; }
    .compare .delta { display: block; font-size: 12px; margin-top: 2px; }
    .foot { margin-top: 12px; }
    .lumps { border: 0; padding: 0; margin: 0; gap: 8px; }
    .lumps legend { font-size: 12.5px; font-weight: 500; color: var(--text-2); margin-bottom: 6px; }
    .lump-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .lump-err { grid-column: 1 / -1; }
    .add-lump { align-self: flex-start; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @media (max-width: 760px) {
      :host { gap: 16px; }
      .pad-head { padding: 16px 16px 0; }
      .pad-x { margin: 0 16px 14px; }
      .sc-item { grid-template-columns: minmax(0, 1fr) auto; padding: 12px 16px; }
      .sc-tags { grid-column: 1; grid-row: 2; padding-left: 26px; }
      .sc-tools { grid-column: 2; grid-row: 1 / span 2; }
      .compare th[scope=row] { min-width: 112px; max-width: 132px; }
    }
  `],
})
export class ScenariosComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly maxSaved = MAX_SAVED;
  readonly maxLumps = MAX_LUMPS;
  readonly inrc = (v: number) => inrCompact(v);
  readonly inrFull = (v: number) => inr(v);
  readonly yearLabel = (label: string) => String(label ?? '').slice(0, 4);

  readonly canWrite = this.auth.canWrite;
  readonly limit = computed(() => (this.canWrite() ? MAX_COMPARE : MAX_COMPARE_GUEST));
  private readonly scope = this.store.scopeKey;

  readonly saved = computed<PlanScenario[]>(() => (Array.isArray(this.store.settings().planScenarios) ? this.store.settings().planScenarios! : []));
  readonly items = computed<Item[]>(() => [
    ...this.saved().map((s, i): Item => ({ key: `saved:${i}`, kind: 'saved', index: i, id: null, scenario: s })),
    ...sessionScenarios().filter(s => s.scope === this.scope())
      .map((s, i): Item => ({ key: `session:${s.id}`, kind: 'session', index: i, id: s.id, scenario: s.scenario })),
  ]);

  /** The user's picks; null until they pick, which means "the first ones listed". */
  private readonly picked = signal<string[] | null>(null);
  readonly selected = computed(() => {
    const keys = new Set(this.items().map(i => i.key));
    const p = this.picked();
    const base = p ?? this.items().map(i => i.key);
    return base.filter(k => keys.has(k)).slice(0, this.limit());
  });

  readonly result = signal<PlanCompareResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** The plan snapshot Plan writes (read only), for the baseline before the first compare answers. */
  private readonly planSnap = computed(() => readSnapshot<Plan>(snapshotKey('plan', this.scope())));
  readonly baseline = computed<PlanScenario>(() => this.result()?.baseline ?? localBaseline(this.store.settings(), this.planSnap()));

  readonly chartLabels = computed(() => (this.result()?.labels ?? []).map(l => String(l)));
  readonly chartBands = computed<LineBand[]>(() => {
    const r = this.result();
    if (!r?.band) return [];
    return [{ key: 'band', label: `${r.columns[0] ?? "Today's plan"}: 8 in 10 futures`, color: 'var(--s1)', lo: r.band.p10, hi: r.band.p90, opacity: 0.12 }];
  });
  readonly chartSeries = computed<LineSeries[]>(() => (this.result()?.paths ?? []).map((p, i) => ({
    key: `p${i}`, label: `${p.name} (typical)`, color: PALETTE[i % PALETTE.length], values: p.p50,
  })));

  // the editor
  readonly editing = signal<Editing | null>(null);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  private readonly showErrors = signal(false);
  f: ScenarioForm = scenarioToForm(localBaseline({}, null));

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private lastSig: string | null = null;

  constructor() {
    // "Try it" on Overview names the scenario to compare first
    const focus = pendingFocus();
    if (focus) { pendingFocus.set(null); this.picked.set([focus]); }
    else { const last = lastSelection.get(this.scope()); if (last) this.picked.set(last); }

    effect(() => {
      const keys = this.selected();
      const items = this.items();
      const version = this.store.version();
      untracked(() => {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const chosen = keys.map(k => items.find(i => i.key === k)).filter((i): i is Item => !!i);
        if (!chosen.length) { this.seq++; this.loading.set(false); this.error.set(null); this.lastSig = null; return; }
        const body = chosen.map(i => (i.kind === 'saved' ? i.index : i.scenario));
        const sig = JSON.stringify([body, version, this.scope()]);
        if (sig === this.lastSig && this.result()) return;
        this.timer = setTimeout(() => void this.compare(body, sig), this.result() ? 300 : 0);
      });
    });
    inject(DestroyRef).onDestroy(() => { if (this.timer) clearTimeout(this.timer); this.seq++; });
  }

  /** `POST /plan/compare`: `api.planCompare` when every inline scenario is complete, else `api.post` (R5 partial bodies). */
  private async compare(body: (number | InlineScenario)[], sig: string) {
    const n = ++this.seq;
    this.loading.set(true);
    try {
      const partial = body.some(b => typeof b !== 'number' && isPartial(b));
      const res = partial
        ? await firstValueFrom(this.api.post<PlanCompareResult>('/plan/compare', { scenarios: body }))
        : await firstValueFrom(this.api.planCompare({ scenarios: body as (number | PlanScenario)[] })) as PlanCompareResult;
      if (n !== this.seq) return;
      this.result.set(res);
      this.error.set(null);
      this.lastSig = sig;
    } catch (e) {
      if (n !== this.seq) return;
      this.error.set(errorMessage(e));
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }

  retry() { this.lastSig = null; this.picked.update(p => (p ? [...p] : [...this.selected()])); }

  isSelected(key: string) { return this.selected().includes(key); }
  toggle(key: string) {
    const cur = this.selected();
    const next = cur.includes(key) ? cur.filter(k => k !== key) : cur.length < this.limit() ? [...cur, key] : cur;
    this.setPicked(next);
  }
  private setPicked(keys: string[]) {
    this.picked.set(keys);
    lastSelection.set(this.scope(), keys);
  }

  describe(s: InlineScenario) { return describeScenario(s, this.baseline()); }
  /** The server's p50 honesty line ("Typical: half of the simulated futures end higher"), prefixed only when it is not already. */
  honestyLine(p50: string) {
    const t = p50.trim().replace(/\.$/, '');
    return /^typical/i.test(t) ? `${t}.` : `Typical: ${t}.`;
  }
  value(v: number | null, row: PlanCompareRow) { return fmtValue(v, row.format); }
  delta(row: PlanCompareRow, i: number) { return fmtDelta(row.deltas?.[i], row.format, row.key); }
  estBasis(res: PlanCompareResult) {
    const a = res.assumptions;
    return a ? `Today's plan at ${a.return_pct}% a year ± ${a.volatility_pct}% (${a.basis}); each column on the same simulated futures. Not a promise.`
      : 'Simulated futures on the same random draws; not a promise';
  }

  /* ── the editor (writers) ── */

  err(field: string): string | null {
    return this.showErrors() ? scenarioErrors(this.f)[field] ?? null : null;
  }

  startNew() {
    if (!this.canWrite() || this.saved().length >= MAX_SAVED) return;
    const b = this.baseline();
    this.f = scenarioToForm({ ...b, name: `Scenario ${this.saved().length + 1}` });
    this.open({ mode: 'new', index: -1, sessionId: null, mix: null });
  }
  startEdit(it: Item) {
    if (!this.canWrite() || it.kind !== 'saved') return;
    const s = resolveAgainst(it.scenario, this.baseline());
    this.f = scenarioToForm(s);
    this.open({ mode: 'edit', index: it.index, sessionId: null, mix: s.mix ?? null });
  }
  /** A session scenario, saved for good (with the baseline's values where it kept them). */
  startPromote(it: Item) {
    if (!this.canWrite() || it.kind !== 'session' || this.saved().length >= MAX_SAVED) return;
    const s = resolveAgainst(it.scenario, this.baseline());
    this.f = scenarioToForm(s);
    this.open({ mode: 'promote', index: -1, sessionId: it.id, mix: s.mix ?? null });
  }
  private open(e: Editing) {
    this.formError.set(null);
    this.showErrors.set(false);
    this.editing.set(e);
  }
  closeEditor() { this.editing.set(null); }
  addLump() {
    if (this.f.lump_sums.length >= MAX_LUMPS) return;
    const y = new Date().getFullYear() + 1;
    this.f.lump_sums = [...this.f.lump_sums, { date: `${y}-04-01`, amount: null }];
  }
  removeLump(i: number) { this.f.lump_sums = this.f.lump_sums.filter((_, j) => j !== i); }

  async saveScenario() {
    const ed = this.editing();
    if (!ed || this.saving() || !this.canWrite()) return;
    this.showErrors.set(true);
    if (Object.keys(scenarioErrors(this.f)).length) return;
    const list = [...this.saved()];
    const scen = formToScenario(this.f, ed.mix);
    if (ed.mode === 'edit') list[ed.index] = scen;
    else {
      if (list.length >= MAX_SAVED) { this.formError.set(`You have ${MAX_SAVED} saved scenarios: delete one first.`); return; }
      list.push(scen);
    }
    this.saving.set(true);
    try {
      await this.store.saveSetting('planScenarios', list);
      if (ed.mode !== 'edit') {
        const key = `saved:${list.length - 1}`;
        let keys = this.selected();
        if (ed.mode === 'promote' && ed.sessionId) {
          keys = keys.map(k => (k === `session:${ed.sessionId}` ? key : k));
          removeSessionScenario(ed.sessionId);
        }
        if (!keys.includes(key) && keys.length < this.limit()) keys = [...keys, key];
        this.setPicked(keys);
      }
      this.editing.set(null);
      this.toast.ok('Scenario saved');
    } catch (e) {
      this.formError.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  async remove(it: Item) {
    if (!this.canWrite() || it.kind !== 'saved') return;
    if (!(await this.confirm.ask(`Delete "${it.scenario.name}"?`, 'Only this scenario goes; your plan is not changed.', 'Delete'))) return;
    const before = this.selected();
    // saved indexes after this one move down by one
    const remap = (keys: string[]) => keys.flatMap(k => {
      const m = /^saved:(\d+)$/.exec(k);
      if (!m) return [k];
      const i = +m[1];
      return i === it.index ? [] : [i > it.index ? `saved:${i - 1}` : k];
    });
    this.setPicked(remap(before));
    try {
      await this.store.saveSetting('planScenarios', this.saved().filter((_, i) => i !== it.index));
      this.toast.ok('Scenario deleted');
    } catch (e) {
      this.setPicked(before);
      this.toast.error(errorMessage(e));
    }
  }

  dropSession(it: Item) {
    if (it.kind !== 'session' || !it.id) return;
    this.setPicked(this.selected().filter(k => k !== it.key));
    removeSessionScenario(it.id);
  }
}
