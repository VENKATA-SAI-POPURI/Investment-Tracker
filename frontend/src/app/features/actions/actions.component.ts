import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ActionRunnerService } from '../../core/action-runner.service';
import { ActionService } from '../../core/action.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fmtDate, inrCompact, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Action, ActionCta, Brief, DeploySource, HarvestPlan, Status, TaxReport } from '../../core/models';
import { readSnapshot, snapshotKey } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { exemptionUsedUp, lossSaleQty, unitsUpTo } from '../../core/tax-lots';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { MarkdownPipe } from '../../shared/markdown.pipe';
import { ActionCardComponent, readCta } from '../../shared/priority/action-card.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { STATUS_META } from '../../shared/priority/priority';
import { RebalancePlannerComponent } from '../../shared/rebalance-planner.component';
import { ReviewComponent } from './review.component';

/** The filter chips and the categories each one shows (E20). `performance` and `review` appear only under All. */
export type ActionFilter = 'all' | 'money' | 'tax' | 'mix' | 'plans' | 'data' | 'markets';
export const ACTION_FILTERS: { key: ActionFilter; label: string; categories: string[] | null }[] = [
  { key: 'all', label: 'All', categories: null },
  { key: 'money', label: 'Money at risk', categories: ['p2p', 'fd', 'cash'] },
  { key: 'tax', label: 'Tax', categories: ['tax'] },
  { key: 'mix', label: 'Mix', categories: ['allocation', 'risk'] },
  { key: 'plans', label: 'Plans & SIPs', categories: ['goals', 'habit'] },
  { key: 'data', label: 'Data', categories: ['data'] },
  { key: 'markets', label: 'Markets', categories: ['market'] },
];
const FILTER_KEYS = new Set<string>(ACTION_FILTERS.map(f => f.key));

/** Does the action belong under the chip? */
export function inFilter(a: Pick<Action, 'category'>, f: ActionFilter): boolean {
  const cats = ACTION_FILTERS.find(x => x.key === f)?.categories;
  return !cats || cats.includes(a.category);
}

/** A tax action whose impact is tax saved (est.): the `tax:*` ids, as `actions.is_tax_move` on the server. */
export function isTaxMove(a: Pick<Action, 'id' | 'category'>): boolean {
  return a.category === 'tax' && a.id.startsWith('tax:');
}

/**
 * "Tax you can still save" (est.): Σ lump `impact.amount` of the open and planned tax moves (`isTaxMove`). Actions'
 * tile and the Tax page's T0 verdict both call this one function, so the two figures always agree (J11, J20.4).
 */
export function taxStillToSave(actions: readonly Action[], planned: readonly Action[]): number {
  return [...actions, ...planned]
    .filter(isTaxMove)
    .filter(a => a.impact && a.impact.kind === 'lump')
    .reduce((t, a) => t + (a.impact?.amount || 0), 0);
}

/**
 * Tax a loss harvest of `offsettable` saves (est.), as `actions.loss_harvest_saving`: the losses cancel this year's
 * taxable lines highest rate first, Σ min(remaining, line.taxable) × rate. It never exceeds the year's CG tax.
 */
export function lossHarvestSaving(lines: { rate: number; taxable: number }[], offsettable: number): number {
  let left = Math.max(offsettable || 0, 0), saved = 0;
  for (const l of [...lines].filter(x => (x.rate || 0) > 0 && (x.taxable || 0) > 0).sort((a, b) => b.rate - a.rate)) {
    if (left <= 0) break;
    const used = Math.min(left, l.taxable);
    saved += used * l.rate / 100;
    left -= used;
  }
  return saved;
}

/** Whole days from `from` to `to` (ISO dates); positive when `to` is later. */
function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86400000);
}

/** One of the three "Tax moves this FY" cards. */
export interface TaxMove {
  key: 'book' | 'offset' | 'wait';
  title: string;
  /** The ₹ this move is worth (a tax saving, est.), or null when there is nothing to do. */
  amount: number | null;
  amountLabel: string;
  sentence: string;
  /** What the est. tag's tooltip names as the basis (§1.9). */
  basis: string;
  /** The holding "Plan the sale" opens in the what-if, when there is one. */
  whatif: { instrument_id: number; qty: number | null } | null;
  /** A link that ends the sentence ("see the harvest plan →"), when the move has a fuller plan elsewhere. */
  more?: { label: string; route: string; query: Record<string, string> } | null;
}

/** Where a deploy source's money is looked after (H9 `link` by kind). */
export const DEPLOY_SOURCE_LINK: Record<DeploySource['kind'], string> = {
  usd: '/forex', fd: '/fixed-deposits', p2p_principal: '/p2p', escrow: '/cash-flows',
};

/** Auto-done evidence: ledger rows that did it ({txn_ids, amount, date}) or a cleared state ({condition, date}). */
interface DoneEvidence { txn_ids?: unknown; amount?: unknown; date?: unknown; condition?: unknown; }

/**
 * The transaction kind an auto-done action's evidence ids name (J16, after `actions.auto_done`'s rules): a MATURITY
 * row for a matured FD, a "trade" for mix moves (drift, concentration, sector, risk), otherwise the BUYs that did it.
 */
export function evidenceType(id: string): string {
  if (id.startsWith('fd:matured-unrecorded:')) return 'MATURITY';
  if (/^(drift|concentration|sector|risk):/.test(id)) return 'trade';
  return 'BUY';
}

/**
 * The Done table's "How" (§5.1, J16): "Marked done"; "Auto: BUY #812 (+2 more) on 12 Nov" with ledger evidence;
 * "Auto: every holding is priced" for a cleared state.
 */
export function howDone(a: Pick<Action, 'id' | 'done_via' | 'evidence' | 'done_at'>): string {
  if (a.done_via !== 'auto') return 'Marked done';
  const ev = (a.evidence ?? {}) as DoneEvidence;
  const ids = (Array.isArray(ev.txn_ids) ? ev.txn_ids : []).filter(x => typeof x === 'number' || typeof x === 'string');
  if (ids.length) {
    const when = a.done_at || (typeof ev.date === 'string' ? ev.date : null);
    const on = when ? ` on ${fmtDate(when.slice(0, 10), false)}` : '';
    const more = ids.length > 1 ? ` (+${ids.length - 1} more)` : '';
    return `Auto: ${evidenceType(a.id)} #${ids[0]}${more}${on}`;
  }
  const cond = typeof ev.condition === 'string' && ev.condition.trim() ? ev.condition.replace(/_/g, ' ') : 'condition cleared';
  return `Auto: ${cond}`;
}

/** A placeholder Action so a tax card's "Plan the sale" goes through ActionRunner like any other CTA. */
function planSaleAction(key: string, link: string, cta: ActionCta): Action {
  return {
    id: `tax:plan:${key}`, kind: 'state', tier: 'consider', severity: 'info', status: 'open', category: 'tax', title: cta.label,
    detail: null, why: null, assumptions: null, impact: null, due: null, days: null, confidence: 'estimate', score: 0, owner: null,
    instrument_id: cta.whatif?.instrument_id ?? null, cta, link, first_seen: null, is_new: false, done_via: null, evidence: null,
    planned_for: null, snooze_until: null,
  };
}

/**
 * Actions (`/actions`, SPEC Part 1 §5.1, Q3 "What should I do now?"): every action ranked by real ₹ and urgency,
 * and the planners that turn advice into money moves. It replaces Insights (A2; W3-F1 deletes the old page).
 *
 * T0 hero `.kpis` → sticky filter chips (`?filter=`, E20) → T1 Now (expanded cards) · This month (compact) · Planned
 * → T2 Deploy money (`#deploy`, the shared planner, A13/A15/A33) · Tax moves this FY · Worth considering / Good news
 * → T3 Done · Snoozed & hidden · Ask the analyst. `?id=<actionId>` scrolls to and highlights that action.
 *
 * Every list comes from ActionService (E4); status changes go through ActionCard → ActionService.setStatus, and the
 * tables' Undo / Restore / Unplan post `{status: 'open'}`.
 *
 * P1 (W5-F8, AMENDMENTS J16): the Follow-through tile (acted on in 90 days, ₹ realised this FY est., on time, SIPs
 * kept), the Done "How" from auto-done evidence, "Book gains tax-free" from `harvest_plan`, every deploy source
 * listed above the planner, and the planner's "Open Risk & mix →" link back on now that /risk is a page.
 *
 * P2 (W7-F4, AMENDMENTS R17): `?tab=review` shows the quarterly review (`review.component.ts`) in place of the filter
 * chips and the lists, under the same head and T0. "Start the quarterly review" in the Last review tile and the
 * brief's context link open it; closing (or completing) it drops `?tab` with replaceUrl.
 */
@Component({
  selector: 'app-actions',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, RouterLink, IconComponent, ActionCardComponent, EstTagComponent, RebalancePlannerComponent,
    ReviewComponent, MarkdownPipe, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './actions.component.html',
  styleUrl: './actions.component.scss',
})
export class ActionsComponent {
  readonly svc = inject(ActionService);
  readonly auth = inject(AuthService);
  readonly store = inject(StoreService);
  private runner = inject(ActionRunnerService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly filters = ACTION_FILTERS;
  readonly todayIso = today();

  // ── URL state ────────────────────────────────────────────────
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  private readonly fragment = toSignal(this.route.fragment, { initialValue: this.route.snapshot.fragment });

  readonly filter = computed<ActionFilter>(() => {
    const f = this.query().get('filter') ?? 'all';
    return (FILTER_KEYS.has(f) ? f : 'all') as ActionFilter;
  });
  /** `?new_money=` from a deploy CTA (A13). */
  readonly newMoneyParam = computed<number | null>(() => {
    const raw = this.query().get('new_money');
    const n = raw === null ? NaN : Number(raw);
    return isFinite(n) && n >= 0 ? n : null;
  });
  readonly focusId = computed(() => this.query().get('id'));
  /** `?tab=review` (R17): the quarterly review replaces the chips and lists. Any other value reads as the lists. */
  readonly reviewOpen = computed(() => this.query().get('tab') === 'review');

  // ── Lists ────────────────────────────────────────────────────
  private readonly open = computed(() => this.svc.actions().filter(a => inFilter(a, this.filter())));
  readonly now = computed(() => this.open().filter(a => a.tier === 'now'));
  readonly month = computed(() => this.open().filter(a => a.tier === 'month'));
  readonly consider = computed(() => this.open().filter(a => a.tier === 'consider'));
  readonly good = computed(() => this.open().filter(a => a.tier === 'good'));
  readonly planned = computed(() => this.svc.planned().filter(a => inFilter(a, this.filter())));
  readonly done = computed(() => this.svc.done().filter(a => inFilter(a, this.filter())));
  readonly snoozed = computed(() => this.svc.snoozed().filter(a => inFilter(a, this.filter())));

  /** Open and planned actions per chip (now + this month + planned: the ones that need you). */
  readonly counts = computed(() => {
    const live = [...this.svc.actions().filter(a => a.tier === 'now' || a.tier === 'month'), ...this.svc.planned()];
    const out: Record<string, number> = {};
    for (const f of ACTION_FILTERS) out[f.key] = live.filter(a => inFilter(a, f.key)).length;
    return out;
  });
  readonly filterLabel = computed(() => ACTION_FILTERS.find(f => f.key === this.filter())?.label ?? 'All');
  readonly showDeploy = computed(() => ['all', 'money', 'mix'].includes(this.filter()));
  readonly showTax = computed(() => ['all', 'tax'].includes(this.filter()));

  /** This-month cards the user opened (they start as one-line rows). */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly considerOpen = signal(false);
  readonly goodOpen = signal(false);
  readonly doneOpen = signal(false);
  readonly snoozedOpen = signal(false);
  /** The `?id=` action, highlighted once it is on screen. */
  readonly highlight = signal<string | null>(null);

  // ── Loading states ───────────────────────────────────────────
  private readonly triedOnce = signal(false);
  /** Nothing painted yet and /actions has not answered. */
  readonly firstLoad = computed(() => !this.svc.loaded() && !this.hasAny() && !(this.triedOnce() && !this.svc.loading()));
  /** /actions failed and there is nothing from an earlier visit to show. */
  readonly failed = computed(() => !this.svc.loaded() && !this.hasAny() && this.triedOnce() && !this.svc.loading());
  /** The last /actions load failed while lists from earlier (this device's snapshot or this session) are shown. */
  readonly stale = computed(() => !!this.svc.error() && !this.svc.loading() && this.hasAny());
  private readonly hasAny = computed(() =>
    this.svc.actions().length + this.svc.planned().length + this.svc.done().length + this.svc.snoozed().length > 0);

  // ── T0 ───────────────────────────────────────────────────────
  readonly summary = this.svc.summary;
  readonly followThrough = this.svc.followThrough;
  /** The tile's extra measures (§8.5), shown when the server has them: on time, and SIP instalments kept over 12 months. */
  readonly ftExtras = computed(() => {
    const ft = this.followThrough();
    if (!ft) return '';
    const parts: string[] = [];
    if (typeof ft.on_time_pct === 'number') parts.push(`${Math.round(ft.on_time_pct)}% on time`);
    if (typeof ft.sip_adherence_12m === 'number') parts.push(`SIPs ${Math.round(ft.sip_adherence_12m)}% kept (12 mo)`);
    return parts.join(' · ');
  });
  /** The whole Follow-through sentence, for the tile's title and screen readers (§5.1 T0, J16). */
  readonly ftTitle = computed(() => {
    const ft = this.followThrough();
    if (!ft) return '';
    const a = ft.acted_90d;
    const parts = [a.total ? `Acted on ${a.done} of ${a.total} in 90 days` : 'Nothing was due in the last 90 days'];
    if (typeof ft.impact_realised_fy === 'number') parts.push(`${inrCompact(ft.impact_realised_fy)} realised this FY (est.)`);
    if (typeof ft.on_time_pct === 'number') parts.push(`${Math.round(ft.on_time_pct)}% of what you did was on time`);
    if (typeof ft.sip_adherence_12m === 'number') parts.push(`${Math.round(ft.sip_adherence_12m)}% of SIP instalments kept over 12 months`);
    return parts.join(' · ');
  });
  readonly ftBasis = 'Tax saved (est., before cess) by the tax moves you completed, plus the money you reinvested '
    + 'from maturing FDs, P2P principal and cash, within this financial year';
  readonly heroStatus = computed<Status>(() => {
    const s = this.summary();
    return s.now > 0 ? 'act' : s.month > 0 ? 'watch' : 'good';
  });
  readonly heroIcon = computed(() => STATUS_META[this.heroStatus()].icon);
  readonly heroVerdict = computed(() => {
    const s = this.summary();
    if (s.now > 0) {
      const top = this.svc.actions().find(a => a.tier === 'now');
      return top ? `Start with: ${top.title}` : `${s.now} to do this week`;
    }
    if (s.month > 0) return `Nothing urgent · ${s.month} to do this month`;
    return 'All clear';
  });
  /** Open and planned tax moves (`tax:*`): an unlocked ELSS is in the tax category but saves no tax. */
  private readonly taxMovesOpen = computed(() => [...this.svc.actions(), ...this.svc.planned()].filter(isTaxMove));
  /** Σ lump impact of open and planned tax moves: the tax you can still save this FY (est.). */
  readonly taxToSave = computed(() => taxStillToSave(this.svc.actions(), this.svc.planned()));
  readonly taxCount = computed(() => this.taxMovesOpen().length);
  readonly lastReview = computed(() => this.store.settings().lastReviewDate ?? null);
  readonly lastReviewText = computed(() => {
    const d = this.lastReview();
    if (!d) return 'Never';
    const n = daysBetween(d.slice(0, 10), this.todayIso);
    return n <= 0 ? 'Today' : n === 1 ? 'Yesterday' : n < 60 ? `${n} days ago` : fmtDate(d);
  });
  readonly reviewing = signal(false);
  /** Phones show the hero and two stats; the rest sit behind "More" (§1.5). */
  readonly moreStats = signal(false);

  // ── Deploy money (#deploy) ───────────────────────────────────
  readonly deploy = signal<Brief['deploy'] | null>(null);
  /** Brief default known (or given up on): the planner can run. */
  readonly deployReady = signal(false);
  readonly deployFailed = signal(false);
  readonly suggested = computed(() => this.deploy()?.suggested ?? null);
  readonly plannerMoney = computed(() => this.newMoneyParam() ?? this.suggested() ?? 0);
  /** net=deploy only while the amount is the brief default (A15): a CTA's own amount or a typed one is not netted. */
  readonly plannerNet = computed(() => {
    const d = this.suggested(), p = this.newMoneyParam();
    if (d === null) return false;
    return p === null || Math.abs(p - d) <= 1;
  });
  /** Every `deploy.sources` row (J16), each with where its money is looked after (H9). Listed above the planner. */
  readonly deploySources = computed<(DeploySource & { link: string | null })[]>(() =>
    (this.deploy()?.sources ?? []).map(s => ({ ...s, link: DEPLOY_SOURCE_LINK[s.kind] ?? null })));

  // ── Tax moves ────────────────────────────────────────────────
  readonly tax = signal<TaxReport | null>(null);
  readonly taxLoading = signal(true);
  readonly taxError = signal<string | null>(null);
  readonly taxMoves = computed<TaxMove[]>(() => {
    const t = this.tax();
    if (!t?.opportunities) return [];
    const o = t.opportunities;
    const lt = o.ltcg_harvest ?? { suggested_booking: 0, future_tax_saved: 0, remaining_exemption: 0, lots: [], unrealized_lt_equity_gain: 0 };
    const rates = (t.tax_lines ?? []).map(l => l.rate || 0);
    const top = rates.length ? Math.max(...rates) / 100 : 0;
    const off = o.loss_harvest_offsettable || 0;
    const offSaving = lossHarvestSaving(t.tax_lines ?? [], off);
    const upcoming = (o.upcoming_long_term ?? []).filter(l => (l.tax_saving ?? 0) > 0);
    const waitSaving = upcoming.reduce((s, l) => s + (l.tax_saving ?? 0), 0);
    const next = [...upcoming].filter(l => l.lt_on).sort((a, b) => (a.lt_on ?? '').localeCompare(b.lt_on ?? ''))[0];
    // losses are positive amounts, biggest first (tax.py)
    const loser = [...(o.loss_harvest ?? [])].sort((a, b) => (b.st_loss + b.lt_loss) - (a.st_loss + a.lt_loss))[0];
    const open = o.open_lots ?? [];
    return [
      this.bookMove(o.harvest_plan ?? null, lt),
      {
        key: 'offset', title: 'Offset gains with losses',
        basis: offSaving > 0
          ? "This year's taxable gains the losses can cancel, highest rate first, before the 4% cess; never more than the capital-gains tax due"
          : 'Booked gains this year that the losses can cancel',
        amount: off > 0 ? (offSaving > 0 ? offSaving : off) : null, amountLabel: off > 0 && offSaving > 0 ? 'tax saved' : 'of gains offset',
        sentence: off > 0
          ? `Holdings below cost can cancel ${inrCompact(off)} of gains booked this year${top ? ` at up to ${Math.round(top * 1000) / 10}%` : ''}.`
          : 'No booked gains to offset, or no holding is below cost.',
        // FIFO: the units that reach the holding's newest loss lot, not just the loss lots' own units (W5 review)
        whatif: off > 0 && loser ? { instrument_id: loser.instrument_id, qty: lossSaleQty(loser, open, this.todayIso) } : null,
      },
      {
        key: 'wait', title: 'Wait before selling',
        basis: "Short-term minus long-term tax on these lots at today's prices; surcharge not modelled",
        amount: waitSaving > 0 ? waitSaving : null, amountLabel: 'saved by waiting',
        sentence: next
          ? `${upcoming.length} lot${upcoming.length === 1 ? '' : 's'} turn long-term soon; the next is ${next.name} on ${fmtDate(next.lt_on)}.`
          : 'No lot with a gain turns long-term soon.',
        // FIFO: this lot and every older one, as the Tax page's row (W5 review)
        whatif: next ? { instrument_id: next.instrument_id, qty: unitsUpTo(next, open) } : null,
      },
    ];
  });

  /**
   * "Book gains tax-free" (J16): from `opportunities.harvest_plan` — the lots to sell and rebuy, FIFO-safe and kept
   * ₹1,000 under the exemption (A12). "Plan the sale" opens the what-if on its first holding. A payload without a
   * plan (before W3) falls back to `ltcg_harvest`.
   */
  private bookMove(hp: HarvestPlan | null, lt: TaxReport['opportunities']['ltcg_harvest']): TaxMove {
    const base = { key: 'book' as const, title: 'Book gains tax-free', amountLabel: 'saved later' };
    const basis = "Tax saved later on gains booked now, at 12.5% LTCG before the 4% cess, at today's prices";
    const usedUp = exemptionUsedUp(lt.remaining_exemption) ? "This year's long-term exemption is used up." : 'No long-term equity gains to book yet.';
    if (hp) {
      const rows = (hp.rows ?? []).filter(r => r.qty > 0);
      if (!rows.length) return { ...base, basis, amount: null, sentence: usedUp, whatif: null };
      const n = rows.length;
      return {
        ...base,
        basis: hp.note ? `${basis}. ${hp.note}` : basis,
        amount: hp.future_tax_saved > 0 ? hp.future_tax_saved : null,
        sentence: `Books ${inrCompact(hp.total_gain)} across ${n} holding${n === 1 ? '' : 's'}`,
        more: { label: 'see the harvest plan →', route: '/tax', query: { tab: 'save' } },
        whatif: { instrument_id: rows[0].instrument_id, qty: rows[0].qty },
      };
    }
    const lot = lt.lots?.[0];
    return {
      ...base, basis,
      amount: lt.suggested_booking > 0 ? lt.future_tax_saved : null,
      sentence: lt.suggested_booking > 0
        ? `Sell and rebuy up to ${inrCompact(lt.suggested_booking)} of long-term gains before 31 March: ${inrCompact(lt.remaining_exemption)} of this year's exemption is unused.`
        : usedUp,
      whatif: lt.suggested_booking > 0 && lot ? { instrument_id: lot.instrument_id, qty: lot.qty ?? null } : null,
    };
  }

  // ── Ask the analyst (copied from Insights; W3-F1 deletes that page) ──
  readonly ai = signal<{ enabled: boolean; disclaimer: string } | null>(null);
  readonly analysis = signal<string | null>(null);
  readonly analyzing = signal(false);
  readonly chat = signal<{ role: 'user' | 'assistant'; content: string }[]>([]);
  draft = '';
  readonly sending = signal(false);
  readonly suggestions = ['Where am I most concentrated?', 'How much should I invest where next month?',
    'Which holdings should I review and why?', 'Am I on track for my goals?'];

  private scrolledFor: string | null = null;
  private deployScrollUntil = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    effect(() => { if (this.svc.loading()) untracked(() => this.triedOnce.set(true)); });

    // the brief default and the tax opportunities follow the portfolio on screen
    effect(() => {
      const key = this.store.scopeKey();
      this.store.version();
      untracked(() => { void this.loadDeploy(key); void this.loadTax(); });
    });

    // #deploy: scroll there on arrival and again once the lists above it have painted (they move it down)
    effect(() => {
      const frag = this.fragment();
      untracked(() => {
        if (frag !== 'deploy') return;
        if (!this.showDeploy()) this.setFilter('all');
        this.deployScrollUntil = Date.now() + 3000;
        this.later(() => this.scrollTo('deploy', 'start'), 60);
      });
    });
    effect(() => {
      if (!this.svc.loaded()) return;
      untracked(() => {
        if (this.fragment() === 'deploy' && Date.now() < this.deployScrollUntil) this.later(() => this.scrollTo('deploy', 'start'), 60);
      });
    });

    // ?id=: open whatever hides the action, scroll to it and highlight it once
    effect(() => {
      const id = this.focusId();
      this.svc.actions(); this.svc.planned(); this.svc.done(); this.svc.snoozed();
      untracked(() => this.reveal(id));
    });

    inject(DestroyRef).onDestroy(() => this.timers.forEach(t => clearTimeout(t)));
  }

  // ── Filter chips ─────────────────────────────────────────────
  setFilter(key: ActionFilter) {
    void this.router.navigate([], {
      relativeTo: this.route, queryParams: { filter: key === 'all' ? null : key }, queryParamsHandling: 'merge',
      preserveFragment: true, replaceUrl: true,
    });
  }

  // ── Cards ────────────────────────────────────────────────────
  isExpanded(id: string): boolean { return this.expanded().has(id); }

  toggle(id: string) {
    this.expanded.update(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** A click on a one-line row opens it, unless it landed on the row's own CTA or menu. */
  rowClick(id: string, e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.closest('button, a, input, form, [role="menu"]')) return;
    this.toggle(id);
  }

  run(a: Action) { void this.runner.run(a); }

  /** Undo (Done), Restore (Snoozed & hidden) and Unplan (Planned) all reopen the action. */
  reopen(a: Action) { void this.svc.setStatus(a.id, { status: 'open' }); }

  daysLate(a: Action): number {
    if (a.days_late !== null && a.days_late !== undefined) return a.days_late;
    return a.planned_for ? Math.max(0, daysBetween(a.planned_for, this.todayIso)) : 0;
  }

  impactText(a: Action): string {
    const i = a.impact;
    if (!i) return '—';
    if (i.label) return i.label;
    return i.amount ? `${inrCompact(i.amount)}${i.kind === 'monthly' ? '/mo' : ''}` : '—';
  }

  /** "Auto: BUY #812 (+2 more) on 12 Nov", "Auto: {condition}" or "Marked done" (§5.1 Done, J16). */
  howDone(a: Action): string { return howDone(a); }
  /** Auto-done rows get the auto icon so the "How" is never told by text colour alone. */
  isAuto(a: Action): boolean { return a.done_via === 'auto'; }

  /** A guest may run a read CTA (route, what-if) from the Planned table; one that writes reads "View" (J17). */
  plannedCta(a: Action): string | null {
    if (this.auth.canWrite()) return a.cta || a.link ? 'Do it now' : null;
    if (a.cta && readCta(a.cta)) return a.cta.label;
    return a.link ? 'View' : null;
  }

  amountMoved(a: Action): number | null {
    const amt = (a.evidence as { amount?: unknown } | null)?.amount;
    return typeof amt === 'number' && amt > 0 ? amt : null;
  }

  snoozedUntil(a: Action): string {
    if (a.status === 'dismissed') return 'Hidden';
    return a.snooze_until ? fmtDate(a.snooze_until) : '—';
  }

  snoozeReason(a: Action): string {
    if (a.reason === 'skipped') return 'Skipped this instalment';
    if (a.reason) return a.reason;
    return a.status === 'dismissed' ? 'Not relevant' : 'Snoozed';
  }

  // ── Review ───────────────────────────────────────────────────
  /** Opens the quarterly review (a history entry, so the browser's Back closes it again). */
  openReview() {
    void this.router.navigate([], {
      relativeTo: this.route, queryParams: { tab: 'review', id: null }, queryParamsHandling: 'merge',
    }).then(() => this.later(() => this.scrollTo('rv-h', 'start'), 60));
  }

  /** Closing (or completing) the review drops `?tab` without a history entry (R17). */
  closeReview() {
    void this.router.navigate([], {
      relativeTo: this.route, queryParams: { tab: null }, queryParamsHandling: 'merge', replaceUrl: true,
    });
  }

  async markReviewed() {
    if (this.reviewing()) return;
    this.reviewing.set(true);
    try {
      await firstValueFrom(this.api.completeReview());
      this.toast.ok('Review recorded · next reminder in 90 days');
      await this.store.changed();
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.reviewing.set(false);
    }
  }

  // ── Tax moves ────────────────────────────────────────────────
  planSale(m: TaxMove) {
    const link = m.whatif ? `/tax?tab=whatif&whatif=${m.whatif.instrument_id}` : '/tax?tab=save';
    void this.runner.run(planSaleAction(m.key, link, { label: 'Plan the sale', type: 'whatif', whatif: m.whatif }));
  }

  private taxSeq = 0;
  private async loadTax() {
    const mine = ++this.taxSeq;
    this.taxLoading.set(true);
    try {
      const t = await firstValueFrom(this.api.tax());
      if (mine !== this.taxSeq) return;
      this.tax.set(t);
      this.taxError.set(null);
    } catch (e) {
      if (mine === this.taxSeq) this.taxError.set(errorMessage(e));
    } finally {
      if (mine === this.taxSeq) this.taxLoading.set(false);
    }
  }

  retryTax() { void this.loadTax(); }

  // ── Deploy default (E20: read Home's brief snapshot; else GET /brief without since, never written back) ──
  private deploySeq = 0;
  private async loadDeploy(scopeKey: string) {
    const mine = ++this.deploySeq;
    const snap = readSnapshot<Partial<Brief>>(snapshotKey('brief', scopeKey));
    if (snap?.deploy && typeof snap.deploy.suggested === 'number') {
      this.deploy.set(snap.deploy);
      this.deployFailed.set(false);
      this.deployReady.set(true);
      return;
    }
    try {
      const b = await firstValueFrom(this.api.brief());
      if (mine !== this.deploySeq) return;
      this.deploy.set(b?.deploy ?? null);
      this.deployFailed.set(!b?.deploy);
    } catch {
      if (mine !== this.deploySeq) return;
      this.deployFailed.set(true);
    } finally {
      if (mine === this.deploySeq) this.deployReady.set(true);
    }
  }

  // ── Ask the analyst ─────────────────────────────────────────
  /** T3: /ai/status is asked only when the card is opened. */
  onAiToggle(e: Event) {
    if (!(e.target as HTMLDetailsElement).open || this.ai()) return;
    firstValueFrom(this.api.aiStatus()).then(s => this.ai.set(s)).catch(() => this.ai.set({ enabled: false, disclaimer: '' }));
  }

  async analyze() {
    this.analyzing.set(true);
    try { this.analysis.set((await firstValueFrom(this.api.aiAnalyze())).analysis); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.analyzing.set(false); }
  }

  async send(text?: string) {
    const msg = (text ?? this.draft).trim();
    if (!msg || this.sending()) return;
    const history = this.chat();
    this.chat.set([...history, { role: 'user', content: msg }]);
    this.draft = '';
    this.sending.set(true);
    try {
      const r = await firstValueFrom(this.api.aiChat(msg, history));
      this.chat.update(c => [...c, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      this.chat.update(c => [...c, { role: 'assistant', content: `⚠ ${errorMessage(e)}` }]);
    } finally {
      this.sending.set(false);
    }
  }

  // ── ?id= and #deploy scrolling ──────────────────────────────
  private reveal(id: string | null) {
    if (!id) { this.scrolledFor = null; return; }
    if (id === this.scrolledFor) return;
    const a = this.svc.find(id);
    if (!a) return;  // not loaded yet (or gone): try again when the lists change
    this.scrolledFor = id;
    if (!inFilter(a, this.filter())) this.setFilter('all');
    const inList = (xs: Action[]) => xs.some(x => x.id === id);
    let el = `action-${id}`;
    if (inList(this.svc.done())) { this.doneOpen.set(true); el = `row-${id}`; }
    else if (inList(this.svc.snoozed())) { this.snoozedOpen.set(true); el = `row-${id}`; }
    else if (inList(this.svc.planned())) { el = `row-${id}`; }
    else if (a.tier === 'month') this.expanded.update(s => new Set(s).add(id));
    else if (a.tier === 'consider') this.considerOpen.set(true);
    else if (a.tier === 'good') this.goodOpen.set(true);
    this.highlight.set(id);
    this.later(() => this.scrollTo(el, 'center'), 80);
    this.later(() => { if (this.highlight() === id) this.highlight.set(null); }, 4000);
  }

  private scrollTo(id: string, block: ScrollLogicalPosition) {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block });
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }
}
