import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Goal, Plan, SEGMENTS, Status } from '../../core/models';
import { readSnapshot, snapshotKey } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { AssumptionChipComponent } from '../../shared/priority/assumption-chip.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { statusFromGoal } from '../../shared/priority/priority';
import { ProbBarComponent } from '../../shared/priority/prob-bar.component';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

/** The goal presets `?preset=` names. The keys are copied from Home's `PLAN_PRESETS` (AMENDMENTS J2), not imported. */
export type GoalPresetKey = 'emergency' | 'education' | 'home';
export interface GoalPreset { key: GoalPresetKey; name: string; icon: string; amount: number; years: number; note: string; }

/** ₹3 L when monthly expenses are not known (J3). */
export const EMERGENCY_DEFAULT = 300000;

/** The three goal presets. Retirement is planned on its own tab, never as a goal (J3). */
export function goalPresets(monthlyExpenses: number | null | undefined): GoalPreset[] {
  const known = !!monthlyExpenses && monthlyExpenses > 0;
  return [
    { key: 'emergency', name: 'Emergency fund', icon: 'shield', years: 1,
      amount: known ? Math.round(monthlyExpenses! * 6) : EMERGENCY_DEFAULT,
      note: known ? `6 months of your ${inr(monthlyExpenses)} monthly expenses` : '6 months of expenses' },
    { key: 'education', name: "Child's education", icon: 'sparkle', amount: 2500000, years: 15, note: "College, at today's fees" },
    { key: 'home', name: 'Home down payment', icon: 'home', amount: 2000000, years: 7, note: '20% of a ₹1 crore home' },
  ];
}

/** Card order (J7): act → watch → not known → good → achieved, then the nearest `target_date`. */
const ORDER: Record<Status | 'achieved', number> = { act: 0, watch: 1, unset: 2, info: 2, good: 3, achieved: 4 };
export function goalRank(g: Goal): number {
  return g.projection.status === 'achieved' ? ORDER.achieved : ORDER[statusFromGoal(g.projection.status)];
}
export function sortGoals(goals: Goal[]): Goal[] {
  return [...goals].sort((a, b) => goalRank(a) - goalRank(b) || a.target_date.localeCompare(b.target_date) || a.id - b.id);
}

/** `required_sip` rounded up to ₹100: the contribution "Fix" prefills (J3). */
export function fixedSip(required: number | null | undefined): number | null {
  return required === null || required === undefined || !isFinite(required) ? null : Math.ceil(required / 100) * 100;
}

/** "A", "A and B", "A, B and C". */
function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** A segment this save would take above 100% (J7). */
export interface OverClaim { segment: string; total: number; goals: string[]; }

/**
 * Plan › Goals (SPEC §5.2 Goals tab; AMENDMENTS J3, J7). The tab body only: Plan owns the page, its h1 and its T0.
 *
 * - Data: `GET /plan` (goals with their projections, `funding`, `sip`, `deltas`) plus the goals CRUD. It paints first
 *   from Plan's `snapshotKey('plan', scopeKey)` when there is one, and never writes it (W5-F1 is its only writer).
 *   A write bumps `store.version`, so this tab and the Plan shell refetch.
 * - URL: `?preset=emergency|education|home` opens the add modal prefilled, `?preset=retirement` moves to
 *   `?tab=retirement`, `?fix=<id>` opens that goal with the SIP it needs, and `#goal-<id>` scrolls to its card.
 *   `preset` and `fix` are removed with `replaceUrl` once applied, so a reload does not reopen the modal.
 * - P2 (K15, R15): a goal funded by linked SIP plans reads "Funded by n SIPs · ₹X/mo", and its SIP line uses that
 *   total; otherwise a writer sees "Link a SIP on Recurring →" when SIP plans exist.
 */
@Component({
  selector: 'app-goals',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, ModalComponent, LineChartComponent, ProbBarComponent, StatusBadgeComponent, EstTagComponent,
    AssumptionChipComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './goals.component.html',
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .g-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .strip { flex: 1 1 320px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; min-width: 0;
      font-size: var(--t-body); color: var(--text-2); }
    .strip b { color: var(--text); font-weight: 650; font-variant-numeric: tabular-nums; }
    .strip .sep { color: var(--border-strong); }
    .strip .need b { color: var(--st-watch, var(--warn)); }
    .goal { scroll-margin-top: 80px; display: flex; flex-direction: column; gap: 14px; border-left: var(--stripe) solid var(--st); }
    .goal .g-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .goal .g-head > div:first-child { min-width: 0; }
    .goal h2 { font-size: var(--t-h2); font-weight: 600; overflow-wrap: anywhere; }
    .goal .g-tools { display: flex; align-items: center; gap: 4px; flex: none; }
    .goal .g-body { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 14px 28px; }
    .goal .g-k { font-size: var(--t-label); color: var(--muted); display: block; margin-bottom: 4px; }
    .goal .g-v { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .goal .g-sip { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: var(--t-meta); color: var(--text-2); }
    .goal .g-sip b { color: var(--text); font-variant-numeric: tabular-nums; }
    .goal .g-sip b.neg { color: var(--neg); }
    .goal .g-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: var(--t-label); color: var(--muted); }
    .goal details.more { width: 100%; }
    .goal details .t3 { display: flex; flex-direction: column; gap: 10px; padding-top: 8px; font-size: var(--t-meta); color: var(--text-2); }
    .funded .badge { margin: 2px 4px 2px 0; }
    .goal .linked { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin: 0; font-size: var(--t-meta); color: var(--text-2); }
    .goal .linked app-icon { flex: none; }
    .skeleton-card { height: 180px; }
    .alloc-row { display: grid; grid-template-columns: minmax(0, 1fr) 110px; gap: 10px; align-items: center; }
    .alloc-row .over { color: var(--neg); font-weight: 600; }
    .start { padding: 32px; text-align: center; }
    .start h2 { font-size: 18px; margin-top: 12px; }
    .start p { color: var(--muted); max-width: 520px; margin: 6px auto 0; }
    .lotus { display: inline-flex; width: 52px; height: 52px; border-radius: 14px; align-items: center; justify-content: center; color: #fff;
      background: linear-gradient(145deg, #e3b350, #b7862c); }
    .presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-top: 26px; text-align: left; }
    .preset { display: flex; flex-direction: column; align-items: flex-start; text-align: left; gap: 4px; padding: 16px; border-radius: 12px;
      border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; font: inherit; color: inherit;
      transition: border-color .15s, box-shadow .15s, background .15s; }
    .preset:hover:not(:disabled) { border-color: var(--border-strong); background: var(--surface); box-shadow: var(--shadow-md); }
    .preset:disabled { cursor: default; opacity: .75; }
    .preset b { font-size: 14px; margin-top: 8px; }
    .preset .amt { font-size: 13px; color: var(--text-2); }
    .preset small { font-size: 12px; color: var(--muted); }
    .preset.ret { border-style: dashed; }
    @media (max-width: 760px) {
      :host { gap: 16px; }
      .goal .g-body { grid-template-columns: minmax(0, 1fr); }
      .start { padding: 22px 16px; }
      .g-bar > .btn { width: 100%; justify-content: center; }
    }
  `],
})
export class GoalsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private fragment = toSignal(this.route.fragment, { initialValue: this.route.snapshot.fragment });
  private query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  private scrolledTo: string | null = null;
  private scope: string | null = null;

  /** GET /plan, or Plan's snapshot until it arrives. */
  plan = signal<Plan | null>(null);
  /** True once a GET /plan has answered (or failed) for the current data version. */
  loaded = signal(false);
  loadError = signal<string | null>(null);

  editing = signal<Partial<Goal> | null>(null);
  error = signal<string | null>(null);
  saving = signal(false);
  /** Set while the over-100% question is open, so its Escape does not also close the goal modal. */
  private asking = false;
  f: any = {};
  readonly segments = SEGMENTS;
  readonly statusOf = statusFromGoal;
  readonly fixedSip = fixedSip;
  readonly round = Math.round;
  readonly inrc = (v: number) => inrCompact(v);
  readonly inrFull = (v: number) => inr(v);

  goals = computed(() => sortGoals(this.plan()?.goals ?? []));
  funding = computed(() => this.plan()?.funding ?? null);
  earmarkedTotal = computed(() => (this.funding()?.earmarked ?? []).reduce((a, e) => a + (e.amount || 0), 0));
  sipGap = computed(() => Math.max(0, this.plan()?.sip?.gap_monthly ?? 0));
  showStrip = computed(() => !!this.funding() || this.sipGap() > 0);
  segValue = computed(() => Object.fromEntries((this.store.portfolio()?.segments ?? []).map(s => [s.segment, s.value])) as Record<string, number>);
  monthlyExpenses = computed(() => {
    const s = this.store.settings();
    return s.emergencyFund?.monthly_expenses || s.retirementPlan?.['monthly_expenses'] || null;
  });
  presets = computed(() => goalPresets(this.monthlyExpenses()));

  constructor() {
    // paint from Plan's snapshot (read only), then fetch /plan for every data version and scope
    effect(() => {
      this.store.version();
      const scope = this.store.scopeKey();
      untracked(() => {
        if (scope !== this.scope) {  // first paint, or another person or family member: start from that scope's snapshot
          this.scope = scope;
          this.plan.set(planFromSnapshot(readSnapshot<unknown>(snapshotKey('plan', scope))));
          this.loaded.set(false);
        }
        queueMicrotask(() => this.load());
      });
    });

    // ?preset= and ?fix= apply once the goals and settings are in, then leave the URL
    effect(() => {
      const q = this.query();
      if (!this.loaded()) return;
      const preset = q.get('preset'), fix = q.get('fix');
      if (!preset && !fix) return;
      untracked(() => this.applyQuery(preset, fix));
    });

    // `#goal-<id>` (Fix on Overview, actions, the bell, the old /goals URL): the router's anchor scroll runs before the
    // goals arrive, so scroll once the named goal's card is on the page (W3 integrator, W4-F8).
    const timers: ReturnType<typeof setTimeout>[] = [];
    let destroyed = false;
    effect(() => {
      const f = this.fragment();
      const m = f ? /^goal-(\d+)$/.exec(f) : null;
      if (!m) { this.scrolledTo = null; return; }
      if (this.scrolledTo === f || !this.goals().some(g => g.id === +m[1])) return;
      this.scrolledTo = f;
      // two macrotasks later: after the cards render and after the router's own anchor scroll (queued behind the first)
      timers.push(setTimeout(() => timers.push(setTimeout(() => {
        if (destroyed) return;
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById(f!)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      }))));
    });
    inject(DestroyRef).onDestroy(() => { destroyed = true; timers.forEach(clearTimeout); });
  }

  private seq = 0;
  async load() {
    const n = ++this.seq;
    try {
      const p = await firstValueFrom(this.api.plan());
      if (n !== this.seq) return;
      this.plan.set(p);
      this.loadError.set(null);
    } catch (e) {
      if (n !== this.seq) return;
      this.loadError.set(errorMessage(e));
    } finally {
      if (n === this.seq) this.loaded.set(true);
    }
  }

  /** Probability change since the 30-day snapshot (`plan.deltas`, keyed by the goal id as a string). */
  delta(g: Goal): number | null {
    return this.plan()?.deltas?.[String(g.id)] ?? null;
  }
  /** Below the SIP it needs (and not yet achieved), against the money that actually funds it. */
  short(g: Goal): boolean {
    const r = g.projection.required_sip;
    return g.projection.status !== 'achieved' && r !== null && r !== undefined && r > this.contribution(g) + 0.5;
  }

  /** K15: the linked SIP plans fund the projection (`contribution_source` 'linked'). */
  linked(g: Goal): boolean {
    return g.projection.contribution_source === 'linked';
  }
  /** The monthly money behind the projection: the linked plans' total when they fund it, else the goal's own figure. */
  contribution(g: Goal): number {
    return this.linked(g) ? g.projection.linked_monthly ?? 0 : g.monthly_contribution || 0;
  }
  /** Linked plans that are running (a paused or ended plan has `monthly_equiv` 0). */
  linkedCount(g: Goal): number {
    const list = g.projection.linked_sips ?? [];
    const running = list.filter(s => (s.monthly_equiv ?? 0) > 0).length;
    return running || list.length;
  }
  linkedNames(g: Goal): string | null {
    const names = (g.projection.linked_sips ?? []).filter(s => (s.monthly_equiv ?? 0) > 0).map(s => s.name).filter((n): n is string => !!n);
    return names.length && names.length <= 3 ? names.join(', ') : null;
  }
  /** R15: a writer's hint to link a plan, when the goal runs on its own figure and SIP plans exist. */
  linkHint(g: Goal): boolean {
    return this.auth.canWrite() && g.projection.contribution_source === 'goal' && g.projection.status !== 'achieved'
      && (this.plan()?.sip?.plans_monthly_total ?? 0) > 0;
  }

  hasAllocation(g: Goal): boolean {
    return Object.values(g.allocation ?? {}).some(v => +v > 0);
  }

  series(g: Goal): LineSeries[] {
    const path = g.projection.path;
    return [
      { key: 'p', label: `At ${g.projection.expected_return}% a year (est.)`, color: 'var(--s1)', values: path.map(x => x.projected), area: true },
      { key: 'c', label: 'Money put in', color: 'var(--muted)', values: path.map(x => x.contributed), muted: true },
      { key: 't', label: 'Target', color: 'var(--s2)', values: path.map(() => g.target_amount), dashed: true },
    ];
  }
  labels(g: Goal) { return g.projection.path.map(x => x.date); }

  /* ── URL ── */

  private applyQuery(preset: string | null, fix: string | null) {
    if (preset === 'retirement') {
      // planned on its own tab, so the money is not counted twice in the funding stack (J3)
      void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: 'retirement', preset: null, fix: null },
        queryParamsHandling: 'merge', replaceUrl: true });
      return;
    }
    if (fix) {
      const g = this.goals().find(x => String(x.id) === fix);
      if (g && this.auth.canWrite()) this.startEdit(g, fixedSip(g.projection.required_sip));
    } else if (preset) {
      const p = this.presets().find(x => x.key === preset);
      if (p && this.auth.canWrite()) this.startAdd(p);
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams: { preset: null, fix: null },
      queryParamsHandling: 'merge', replaceUrl: true, preserveFragment: true });
  }

  openRetirement() {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: 'retirement', preset: null, fix: null },
      queryParamsHandling: 'merge', replaceUrl: true });
  }

  /* ── the modal ── */

  startAdd(preset?: GoalPreset) {
    const year = new Date().getFullYear();
    this.f = { name: preset?.name ?? '', target_amount: preset?.amount ?? null, target_date: `${year + (preset?.years ?? 10)}-03-31`,
      monthly_contribution: 0, expected_return: null, notes: '',
      allocation: Object.fromEntries(SEGMENTS.map(s => [s, 0])) };
    this.error.set(null);
    this.editing.set({});
  }
  /** `sip` prefills the monthly contribution (Fix: `required_sip` rounded up to ₹100). */
  startEdit(g: Goal, sip: number | null = null) {
    this.f = { ...g, projection: undefined, monthly_contribution: sip ?? g.monthly_contribution,
      allocation: Object.fromEntries(SEGMENTS.map(s => [s, g.allocation[s] ?? 0])) };
    this.error.set(null);
    this.editing.set(g);
  }
  closeModal() {
    if (this.asking) return;
    this.editing.set(null);
  }
  /** The goal being edited, for its "needs" hint in the modal. */
  editedGoal(): Goal | null {
    const id = this.editing()?.id;
    return id ? this.goals().find(g => g.id === id) ?? null : null;
  }
  /** The other goals' share of `segment` ("already earmarked p%"). */
  others(segment: string): number {
    const id = this.editing()?.id;
    return this.goals().filter(g => g.id !== id).reduce((a, g) => a + (+g.allocation[segment] || 0), 0);
  }
  claimed(segment: string): number {
    return Math.round((this.others(segment) + (+this.f.allocation?.[segment] || 0)) * 10) / 10;
  }
  /** Segments this save would take above 100%, with every goal that claims them. */
  overClaims(): OverClaim[] {
    const id = this.editing()?.id;
    const out: OverClaim[] = [];
    for (const s of SEGMENTS) {
      const mine = +this.f.allocation?.[s] || 0;
      const total = this.claimed(s);
      if (mine <= 0 || total <= 100) continue;
      const list = this.goals().filter(g => g.id !== id && (+g.allocation[s] || 0) > 0).map(g => g.name);
      out.push({ segment: s, total, goals: [this.f.name?.trim() || 'this goal', ...list] });
    }
    return out;
  }
  linkedValue() {
    return Object.entries(this.f.allocation ?? {}).reduce((a, [s, p]) => a + (this.segValue()[s] ?? 0) * (+(p as number) || 0) / 100, 0);
  }

  async save() {
    if (this.saving()) return;
    const over = this.overClaims();
    if (over.length) {
      const lines = over.map(o => `${o.segment} would be claimed ${o.total}% by ${names(o.goals)}.`).join(' ');
      this.asking = true;
      let ok = false;
      try {
        ok = await this.confirm.ask('Earmark more than 100%?',
          `${lines} No rupee is counted twice: each goal's share is scaled down to fit, so these goals look less funded. Save anyway?`,
          'Save anyway', false);
      } finally {
        // the confirm's Escape reaches the goal modal's listener in the same event; let it pass first
        setTimeout(() => { this.asking = false; });
      }
      if (!ok) return;  // Cancel keeps the goal modal open
    }
    this.saving.set(true);
    try {
      const body = { ...this.f, projection: undefined, id: undefined };
      const e = this.editing()!;
      const res = e.id ? await firstValueFrom(this.api.updateGoal(e.id, body)) : await firstValueFrom(this.api.addGoal(body));
      this.plan.update(p => p ? { ...p, goals: res } : p);
      this.toast.ok('Goal saved');
      this.editing.set(null);
      this.store.version.update(v => v + 1);  // /plan (funding, SIP gap, status) and the Plan T0 refetch
    } catch (err) { this.error.set(errorMessage(err)); }
    finally { this.saving.set(false); }
  }

  async remove(g: Goal) {
    if (!(await this.confirm.ask(`Delete goal "${g.name}"?`, 'Your investments are not affected.', 'Delete'))) return;
    try {
      await firstValueFrom(this.api.deleteGoal(g.id));
      this.plan.update(p => p ? { ...p, goals: p.goals.filter(x => x.id !== g.id) } : p);
      this.store.version.update(v => v + 1);
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
}

/** Plan's snapshot is the GET /plan payload; tolerate a wrapper `{ plan }` and anything malformed. */
function planFromSnapshot(snap: unknown): Plan | null {
  const s = snap as { goals?: unknown; plan?: { goals?: unknown } } | null;
  if (s && Array.isArray(s.goals)) return s as unknown as Plan;
  if (s?.plan && Array.isArray(s.plan.goals)) return s.plan as unknown as Plan;
  return null;
}
