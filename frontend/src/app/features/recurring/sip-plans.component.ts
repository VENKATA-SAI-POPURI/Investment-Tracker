import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fmtDate, inr, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { SEGMENTS, SipAdherence, SipFrequency, SipInstalment, SipPlan, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

const FREQ: { key: SipFrequency; label: string }[] = [
  { key: 'monthly', label: 'Monthly' }, { key: 'quarterly', label: 'Quarterly' }, { key: 'weekly', label: 'Weekly' }, { key: 'yearly', label: 'Yearly' }];

/** How an instalment reads on screen (AMENDMENTS J10): a word, an icon and a status colour, never colour alone. */
export type InstalmentBadge = 'done' | 'partial' | 'skipped' | 'missed' | 'due' | 'upcoming';
export const INSTALMENT_BADGE: Record<InstalmentBadge, { word: string; icon: string; status: Status }> = {
  done: { word: 'Recorded', icon: 'checkCircle', status: 'good' },
  partial: { word: 'Partly recorded', icon: 'alert', status: 'watch' },
  skipped: { word: 'Skipped', icon: 'chevronRight', status: 'info' },
  missed: { word: 'Missed', icon: 'alertOctagon', status: 'act' },
  due: { word: 'Due', icon: 'bell', status: 'watch' },
  upcoming: { word: 'Upcoming', icon: 'calendar', status: 'info' },
};

/**
 * The badge for one instalment (J10). `upcoming` splits on the due date: on or before today it is "Due" (still inside
 * the plans engine's four-day grace, E18), after today "Upcoming". Dates are ISO strings, so they compare as text.
 */
export function instalmentBadge(i: Pick<SipInstalment, 'status' | 'due'>, todayIso: string = today()): InstalmentBadge {
  if (i.status === 'upcoming') return i.due <= todayIso ? 'due' : 'upcoming';
  return i.status;
}

/** One adherence dot: the badge plus a sentence for its `title` and screen readers. */
export interface AdherenceDot { key: string; badge: InstalmentBadge; title: string; }

/** The plan's last six instalments (by due date, all frequencies) as dots for the plans table (J10). */
export function adherenceDots(months: SipInstalment[] | null | undefined, todayIso: string = today()): AdherenceDot[] {
  return [...(months ?? [])].sort((a, b) => a.due.localeCompare(b.due)).slice(-6).map(m => {
    const badge = instalmentBadge(m, todayIso);
    const word = INSTALMENT_BADGE[badge].word;
    const money = badge === 'done' ? inr(m.invested)
      : badge === 'partial' ? `${inr(m.invested)} of ${inr(m.planned)}`
      : badge === 'skipped' ? '' : inr(m.planned);
    return { key: m.due, badge, title: `${fmtDate(m.due)}: ${word}${money ? ' ' + money : ''}` };
  });
}

/**
 * A goal as the plans table and the modal need it (R18). `owner` is on the `/goals` rows (`SELECT *`) though `Goal`
 * does not type it; K3 only accepts a goal of the plan's own owner, so the edit modal offers just those when known.
 */
export interface GoalRef { id: number; name: string; owner?: string | null; }

/** What the "Funds goal" cell shows (R18): the goal's name and link, a placeholder while names are unknown, or "—". */
export function goalCell(goalId: number | null | undefined, goals: GoalRef[] | null): { name: string; id: number | null } {
  if (goalId === null || goalId === undefined) return { name: '—', id: null };
  if (goals === null) return { name: 'A goal', id: goalId };           // names not loaded (or the load failed): keep the link
  const g = goals.find(x => x.id === goalId);
  return g ? { name: g.name, id: g.id } : { name: '—', id: null };    // a goal this scope doesn't list reads as unlinked
}

/** True for K3's refusal ("That goal isn't one of this portfolio's goals"), which the modal shows under the select. */
export function isGoalRefusal(e: unknown): boolean {
  return e instanceof HttpErrorResponse && e.status === 400 && /goal/i.test(String(e.error?.error ?? ''));
}

/**
 * Activity › Recurring plans, T2 (SPEC §5.9, AMENDMENTS J10): the plans table with a six-dot adherence strip per plan,
 * and the add/edit modal (T3). The page (`RecurringComponent`) owns the single `GET /sips` and hands the plans and
 * adherence in; a save here calls `store.changed()`, which makes the page reload. Guests see no New, Pause, Edit or
 * Delete. Plans feed the projections, the cash-flow forecast and the instalment reminders.
 *
 * P2 (R18, K3, K15): a "Funds goal" column (the goal's name linking `/plan?tab=goals#goal-<id>`, or "—"; on phones a
 * line under the plan name) and a "Funds goal" select in the modal. The page loads the goals once and hands them in
 * as `goals`; the modal sends `goal_id` (null for none) on create and update, and K3's 400 shows under the select.
 */
@Component({
  selector: 'app-sip-plans',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flush">
      <div class="card-head">
        <div><h2>Your plans</h2><span class="hint">Used as the default SIP in the Plan's projections and retirement, and in the cash-flow forecast</span></div>
        @if (auth.canWrite()) { <button type="button" class="btn primary sm" (click)="startAdd()"><app-icon name="plus" [size]="14" /> New plan</button> }
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Plan</th><th class="num">Amount</th><th class="hide-sm">Every</th><th class="num hide-sm">Day</th><th class="num hide-sm">Step-up</th><th class="hide-sm">From → to</th>
            <th class="hide-sm">Funds goal</th><th>Last 6</th><th>Status</th>@if (auth.canWrite()) { <th><span class="sr-only">Manage</span></th> }</tr></thead>
          <tbody>
            @if (loading() && !plans().length) {
              <tr><td colspan="10" class="muted">Loading…</td></tr>
            } @else {
              @for (s of plans(); track s.id) {
                @let gc = goalOf(s);
                <tr [class.off]="!s.active">
                  <td class="name-cell">@if (s.instrument_id) { <a [routerLink]="['/holding', s.instrument_id]">{{ s.name }}</a> } @else { {{ s.name }} }<div class="sub">{{ s.segment || 'no asset class' }}{{ s.notes ? ' · ' + s.notes : '' }}</div>
                    @if (gc.id !== null) { <div class="sub show-sm-only goal-sub">Funds <a [routerLink]="['/plan']" [queryParams]="{ tab: 'goals' }" [fragment]="'goal-' + gc.id">{{ gc.name }}</a></div> }</td>
                  <td class="num">{{ s.amount | inr }}<div class="sub show-sm-only">{{ s.frequency }}</div></td><td class="hide-sm">{{ s.frequency }}</td><td class="num hide-sm">{{ s.day_of_month }}</td>
                  <td class="num hide-sm">{{ s.step_up_pct ? s.step_up_pct + '%' : '—' }}</td>
                  <td class="hide-sm small">{{ s.start_date | dt }}{{ s.end_date ? ' → ' + (s.end_date | dt) : '' }}</td>
                  <td class="hide-sm goal-cell">
                    @if (gc.id !== null) { <a [routerLink]="['/plan']" [queryParams]="{ tab: 'goals' }" [fragment]="'goal-' + gc.id"
                      [attr.aria-label]="'Goal funded by ' + s.name + ': ' + gc.name">{{ gc.name }}</a> }
                    @else { <span class="muted" [attr.aria-label]="s.name + ' funds no goal'">—</span> }
                  </td>
                  <td>
                    @let ds = dots().get(s.id);
                    @if (excluded().has(s.id)) {
                      <span class="small muted" title="EPF passbook imports record this money, so the plan is not scored">From passbook</span>
                    } @else if (ds) {
                      <span class="dots" role="list" [attr.aria-label]="'Last ' + ds.length + ' instalments of ' + s.name">
                        @for (d of ds; track d.key) {
                          <span class="dot" role="listitem" [attr.data-status]="badge[d.badge].status" [attr.data-badge]="d.badge" [attr.title]="d.title" [attr.aria-label]="d.title">
                            <app-icon [name]="badge[d.badge].icon" [size]="11" /></span>
                        }
                      </span>
                    } @else { <span class="small muted">{{ s.active ? 'None yet' : 'Paused' }}</span> }
                  </td>
                  <td><span class="badge" [class.good]="s.active">{{ s.active ? 'Active' : 'Paused' }}</span></td>
                  @if (auth.canWrite()) {
                    <td class="num"><div class="row" style="justify-content:flex-end;gap:2px">
                      <button type="button" class="btn ghost sm" (click)="toggle(s)">{{ s.active ? 'Pause' : 'Resume' }}</button>
                      <button type="button" class="btn ghost icon sm" (click)="startEdit(s)" [attr.aria-label]="'Edit ' + s.name"><app-icon name="edit" [size]="15" /></button>
                      <button type="button" class="btn ghost icon sm danger" (click)="remove(s)" [attr.aria-label]="'Delete ' + s.name"><app-icon name="trash" [size]="15" /></button></div></td>
                  }
                </tr>
              } @empty {
                <tr><td colspan="10"><div class="empty"><app-icon name="refresh" [size]="26" /><h3>No SIP plans yet</h3>
                  <p>Add what you invest each month and the projections, the cash-flow forecast and the instalment reminders pick it up.</p>
                  @if (auth.canWrite()) { <button type="button" class="btn" (click)="startAdd()"><app-icon name="plus" [size]="15" /> Add a plan</button> }</div></td></tr>
              }
            }
          </tbody>
        </table>
      </div>
    </div>
    <p class="small muted">An instalment counts as recorded when purchases in that holding (or, for a plan without a holding, in that
      asset class) from 3 days before its due date to 20 days after add up to at least 95% of it. With nothing recorded it is
      missed four days after the due date. Skipped and upcoming instalments don't count toward adherence.</p>

    @if (editing() !== null) {
      <app-modal [title]="f.id ? 'Edit SIP plan' : 'New SIP plan'" [width]="540" (close)="editing.set(null)">
        <form class="form" (ngSubmit)="save()">
          <div class="field"><label for="sp-inst">Holding</label>
            <select id="sp-inst" class="input" name="inst" [(ngModel)]="f.instrument_id">
              <option [ngValue]="null">— none, just an asset class —</option>
              @for (p of holdings(); track p.id) { <option [ngValue]="p.id">{{ p.name }}</option> }
            </select></div>
          <div class="cols">
            <div class="field"><label for="sp-name">Name</label><input id="sp-name" class="input" name="name" [(ngModel)]="f.name" [placeholder]="holdingName() || 'e.g. Index fund SIP'" /></div>
            <div class="field"><label for="sp-seg">Asset class</label>
              <select id="sp-seg" class="input" name="seg" [(ngModel)]="f.segment" [disabled]="!!f.instrument_id">
                <option [ngValue]="null">—</option>@for (s of segments; track s) { <option [value]="s">{{ s }}</option> }
              </select></div>
            <div class="field"><label for="sp-amt">Amount (₹)</label><input id="sp-amt" class="input num" type="number" min="1" name="amount" [(ngModel)]="f.amount" required /></div>
            <div class="field"><label for="sp-freq">Frequency</label>
              <select id="sp-freq" class="input" name="freq" [(ngModel)]="f.frequency">@for (q of freq; track q.key) { <option [value]="q.key">{{ q.label }}</option> }</select></div>
            <div class="field"><label for="sp-day">Day of month</label><input id="sp-day" class="input num" type="number" min="1" max="28" name="day" [(ngModel)]="f.day_of_month" /></div>
            <div class="field"><label for="sp-step">Step-up each year (%)</label><input id="sp-step" class="input num" type="number" min="0" max="50" name="step" [(ngModel)]="f.step_up_pct" /></div>
            <div class="field"><label for="sp-start">Starts</label><input id="sp-start" class="input" type="date" name="start" [(ngModel)]="f.start_date" /></div>
            <div class="field"><label for="sp-end">Ends (optional)</label><input id="sp-end" class="input" type="date" name="end" [(ngModel)]="f.end_date" /></div>
          </div>
          <div class="field"><label for="sp-goal">Funds goal</label>
            <select id="sp-goal" class="input" name="goal" [(ngModel)]="f.goal_id" (ngModelChange)="goalError.set(null)"
              [attr.aria-invalid]="goalError() ? 'true' : null" aria-describedby="sp-goal-hint">
              <option [ngValue]="null">No goal</option>
              @for (g of goalOptions(); track g.id) { <option [ngValue]="g.id">{{ g.name }}</option> }
            </select>
            @if (goalError()) {
              <span id="sp-goal-hint" class="field-error" role="alert"><app-icon name="alert" [size]="13" /> {{ goalError() }}</span>
            } @else if (goals() === null) {
              <span id="sp-goal-hint" class="hint">Couldn't load your goals, so only the plan's current link is offered.</span>
            } @else if (!goals()!.length) {
              <span id="sp-goal-hint" class="hint">No goals yet. <a routerLink="/plan" [queryParams]="{ tab: 'goals' }" (click)="editing.set(null)">Add one on Plan → Goals</a></span>
            } @else {
              <span id="sp-goal-hint" class="hint">A goal funded by plans uses their monthly total instead of its own contribution.</span>
            }
          </div>
          <div class="field"><label for="sp-notes">Notes</label><input id="sp-notes" class="input" name="notes" [(ngModel)]="f.notes" /></div>
          @if (error()) { <div class="notice bad">{{ error() }}</div> }
          <div class="form-actions"><button type="button" class="btn" (click)="editing.set(null)">Cancel</button><button class="btn primary" type="submit" [disabled]="saving()">Save plan</button></div>
        </form>
      </app-modal>
    }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 14px; }
    tr.off td { opacity: .6; }
    .show-sm-only { display: none; font-size: 12px; color: var(--muted); }
    @media (max-width: 760px) { .show-sm-only { display: block; } }
    .dots { display: inline-flex; gap: 4px; vertical-align: middle; }
    .dot { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%;
      color: var(--st); background: color-mix(in srgb, var(--st) 14%, transparent); border: 1px solid color-mix(in srgb, var(--st) 45%, transparent); }
    .dot[data-badge="upcoming"] { border-style: dashed; background: transparent; }
    .goal-cell { max-width: 180px; overflow-wrap: anywhere; }
    .field-error { display: flex; align-items: flex-start; gap: 4px; margin-top: 4px; font-size: 12.5px; color: var(--neg); }
    .field-error app-icon { flex: none; margin-top: 2px; }
  `],
})
export class SipPlansComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  store = inject(StoreService);
  auth = inject(AuthService);

  /** The plans from the page's `GET /sips`. */
  plans = input<SipPlan[]>([]);
  /** `GET /sips` `adherence` (H9), or null when the server could not build it. */
  adherence = input<SipAdherence | null>(null);
  /** The page's first load is still running. */
  loading = input(false);
  /** The scope's goals (R18), loaded once by the page; null while loading or when `/goals` failed. */
  goals = input<GoalRef[] | null>(null);

  readonly badge = INSTALMENT_BADGE;
  editing = signal<Partial<SipPlan> | null>(null);
  saving = signal(false);
  error = signal<string | null>(null);
  /** K3's refusal of the chosen goal, shown under the select. */
  goalError = signal<string | null>(null);
  f: any = {};
  segments = SEGMENTS;
  freq = FREQ;

  /** Plan id → its last six instalments as dots. Plans with no instalments (paused, not started) are absent. */
  dots = computed(() => {
    const t = today();
    const m = new Map<number, AdherenceDot[]>();
    for (const p of this.adherence()?.plans ?? []) {
      const ds = adherenceDots(p.months, t);
      if (ds.length) m.set(p.id, ds);
    }
    return m;
  });
  /** EPF plans left out of adherence because passbook imports record that money (E18). */
  excluded = computed(() => new Set(this.adherence()?.excluded_epf ?? []));

  holdings = computed(() => this.store.openPositions().filter(p => ['equity', 'mutual_fund', 'commodity', 'nps', 'epf'].includes(p.asset_class))
    .sort((a, b) => a.name.localeCompare(b.name)));
  holdingName = () => this.holdings().find(p => p.id === this.f.instrument_id)?.name ?? '';

  /** The "Funds goal" cell for one plan (R18). */
  goalOf(s: SipPlan) { return goalCell(s.goal_id, this.goals()); }

  /**
   * The modal's goal choices. Editing a plan whose goals carry `owner` lists only the plan owner's goals (K3 refuses
   * the rest). A linked goal the list doesn't hold (names not loaded) stays selectable, so saving never drops it.
   */
  goalOptions = computed<GoalRef[]>(() => {
    const plan = this.editing();
    const owner = plan && 'owner' in plan ? plan.owner : null;
    const all = this.goals() ?? [];
    const list = owner ? all.filter(g => !g.owner || g.owner === owner) : all;
    const cur = plan?.goal_id;
    if (cur !== null && cur !== undefined && !list.some(g => g.id === cur)) {
      const known = all.find(g => g.id === cur);
      return [...list, known ?? { id: cur, name: this.goals() === null ? 'Current goal' : 'Current goal (not in this view)' }];
    }
    return list;
  });

  startAdd() {
    this.f = { instrument_id: null, name: '', segment: null, amount: null, frequency: 'monthly', day_of_month: 5, step_up_pct: null, start_date: today(), end_date: null, notes: '', goal_id: null };
    this.error.set(null);
    this.goalError.set(null);
    this.editing.set({});
  }
  startEdit(s: SipPlan) {
    this.f = { ...s, end_date: s.end_date || null, step_up_pct: s.step_up_pct || null, goal_id: s.goal_id ?? null };
    this.error.set(null);
    this.goalError.set(null);
    this.editing.set(s);
  }
  async save() {
    this.saving.set(true);
    this.error.set(null);
    this.goalError.set(null);
    try {
      const body = { ...this.f, name: this.f.name || this.holdingName(), active: this.f.active ?? 1, goal_id: this.f.goal_id ?? null };
      if (body.instrument_id) delete body.segment;
      await firstValueFrom(this.f.id ? this.api.updateSip(this.f.id, body) : this.api.addSip(body));
      this.toast.ok(this.f.id ? 'Plan updated' : 'Plan added');
      this.editing.set(null);
      await this.store.changed();
    } catch (e) {
      if (isGoalRefusal(e)) this.goalError.set(errorMessage(e));
      else this.error.set(errorMessage(e));
    }
    finally { this.saving.set(false); }
  }
  async toggle(s: SipPlan) {
    try { await firstValueFrom(this.api.updateSip(s.id, { active: !s.active })); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  async remove(s: SipPlan) {
    if (!(await this.confirm.ask('Delete SIP plan?', `${s.name} (${s.amount.toLocaleString('en-IN')} ${s.frequency}) will be removed. Recorded transactions are not affected.`, 'Delete'))) return;
    try { await firstValueFrom(this.api.deleteSip(s.id)); this.toast.ok('Plan deleted'); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
