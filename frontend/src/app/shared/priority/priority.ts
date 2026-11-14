/**
 * The priority grammar as table lookups (SPEC Part 1 §1.8, Part 2 §9.3; AMENDMENTS A16, A23).
 * The rules that matter live in the backend engines with pytest; these mirror them for display.
 */
import { Action, ActionConfidence, ActionTier, AssumptionsCheck, Status, Vital, VitalKey } from '../../core/models';

export type { Status } from '../../core/models';

/** Word and icon per status. Colour is never the only cue: every badge shows both. */
export const STATUS_META: Record<Status, { word: string; icon: string }> = {
  good: { word: 'On track', icon: 'checkCircle' },
  watch: { word: 'Watch', icon: 'alert' },
  act: { word: 'Act now', icon: 'alertOctagon' },
  unset: { word: 'Not set', icon: 'circleDashed' },
  info: { word: 'For info', icon: 'info' },
};

/** Probability bands shared by goals, retirement and the plan card: ≥75 good, ≥40 watch, else act. */
export const STATUS_THRESHOLDS = { good: 75, watch: 40 } as const;

/** Worst first: act > watch > unset > good > info. */
const STATUS_RANK: Record<Status, number> = { act: 0, watch: 1, unset: 2, good: 3, info: 4 };

export function statusFromProbability(p: number | null | undefined): Status {
  if (p === null || p === undefined || isNaN(p)) return 'unset';
  return p >= STATUS_THRESHOLDS.good ? 'good' : p >= STATUS_THRESHOLDS.watch ? 'watch' : 'act';
}

/** Goal / retirement engine status: achieved and on_track → good, at_risk → watch, off_track → act. */
export function statusFromGoal(s: string | null | undefined): Status {
  switch (s) {
    case 'achieved': case 'on_track': return 'good';
    case 'at_risk': return 'watch';
    case 'off_track': return 'act';
    default: return 'unset';
  }
}

/** Insight severities (critical/warning/info/positive) and action severities (crit/warn/info/pos). */
export function statusFromSeverity(s: string | null | undefined): Status {
  switch (s) {
    case 'critical': case 'crit': return 'act';
    case 'warning': case 'warn': return 'watch';
    case 'positive': case 'pos': return 'good';
    case 'info': return 'info';
    default: return 'info';
  }
}

/**
 * The "Against the market" rule, mirroring brief.py (A16): under 180 days of history → unset;
 * excess ≥ 0 → good; > −3 pts → watch; otherwise act.
 */
export function statusFromExcess(excess: number | null | undefined, days: number | null | undefined): Status {
  if (days === null || days === undefined || days < 180) return 'unset';
  if (excess === null || excess === undefined || isNaN(excess)) return 'unset';
  return excess >= 0 ? 'good' : excess > -3 ? 'watch' : 'act';
}

/** The most urgent status in a list (act > watch > unset > good > info); an empty list is unset. */
export function worstStatus(list: (Status | null | undefined)[]): Status {
  let worst: Status | null = null;
  for (const s of list) if (s && (worst === null || STATUS_RANK[s] < STATUS_RANK[worst])) worst = s;
  return worst ?? 'unset';
}

/** Sort worst first (the phone order for vitals: act → watch → unset → good). Stable. */
export function byStatus<T>(items: T[], status: (t: T) => Status): T[] {
  return items.map((t, i) => ({ t, i })).sort((a, b) => STATUS_RANK[status(a.t)] - STATUS_RANK[status(b.t)] || a.i - b.i).map(x => x.t);
}

export const TIER_ORDER: Record<ActionTier, number> = { now: 0, month: 1, consider: 2, good: 3 };
export const TIER_LABEL: Record<ActionTier, string> = { now: 'Now', month: 'This month', consider: 'Worth considering', good: 'Good news' };

export const CONFIDENCE_LABEL: Record<ActionConfidence, string> = { fact: 'Fact', estimate: 'Estimate', model: 'Model', signal: 'Signal' };

/** Fixed desktop order of the five checks (A23). */
export const VITAL_ORDER: VitalKey[] = ['data', 'cushion', 'risk', 'mix', 'money_at_risk'];

/** `brief.vitals` is an array: read one check by key (A23). */
export function vitalOf(vitals: Vital[] | null | undefined, key: VitalKey): Vital | undefined {
  return vitals?.find(v => v.key === key);
}

/** The stripe colour of an action card. */
export function actionStatus(a: Pick<Action, 'severity'>): Status {
  return statusFromSeverity(a.severity);
}

/** Does `link` sit under `prefix`? '/plan' matches '/plan', '/plan?tab=goals' and '/plan#x', never '/planner'. */
export function linkUnder(link: string | null | undefined, prefix: string): boolean {
  if (!link) return false;
  if (prefix === '/') return link === '/';
  if (!link.startsWith(prefix)) return false;
  const next = link.charAt(prefix.length);
  return next === '' || next === '/' || next === '?' || next === '#' || prefix.endsWith('/');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Due chip text: "today", "in 4 days", "by 31 Mar", "3 days overdue". */
export function dueText(days: number | null | undefined, due: string | null | undefined): string {
  if (days === null || days === undefined) {
    if (!due) return '';
    const [, m, d] = due.split('-').map(Number);
    return m && d ? `by ${d} ${MONTHS[m - 1]}` : '';
  }
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 14 || !due) return `in ${days} days`;
  const [, m, d] = due.split('-').map(Number);
  return m && d ? `by ${d} ${MONTHS[m - 1]}` : `in ${days} days`;
}

/** SIP instalment ids that "Skip this month" applies to (A11). */
export function isInstalment(id: string): boolean {
  return id.startsWith('sip:due:') || id.startsWith('sip:missed:');
}

/**
 * The Assumptions check verdicts (AMENDMENTS J18): within → good, above → info, below → watch, too_short → unset,
 * each with its badge word. Performance's card and Home's sub-line both read it, so one check never carries two
 * statuses (W5 review fix).
 */
export const ASSUMPTIONS_CHECK_META: Record<AssumptionsCheck['verdict'], { status: Status; word: string; tail: string; note: string }> = {
  within: { status: 'good', word: 'Within range', tail: 'within the typical range',
    note: 'What you have earned fits what the plan expects, so its projections rest on a fair footing.' },
  above: { status: 'info', word: 'Above range', tail: 'above the typical range',
    note: 'You have done better than the plan expects. Good years do not repeat on cue, so the plan keeps its long-run figure.' },
  below: { status: 'watch', word: 'Below range', tail: 'below the typical range',
    note: 'You have earned less than the plan expects. If that continues, the plan is too hopeful.' },
  too_short: { status: 'unset', word: 'Too early to judge', tail: 'Too early to judge',
    note: 'Under a year of history swings too much to compare with a long-run figure.' },
};
