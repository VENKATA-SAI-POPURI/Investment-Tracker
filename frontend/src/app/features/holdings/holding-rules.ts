/**
 * Holding detail rules (SPEC Part 1 §5.5, AMENDMENTS J14), kept as pure functions so the page only renders them.
 * The engines own the real rules; these mirror them for one position:
 * - the T0 verdict (valued-at-cost act, then the `concentration:` watch from `insights.py`);
 * - when XIRR is honest enough to show (a year of history);
 * - the FIFO open lots joined to the tax view's `opportunities.open_lots`, with the cumulative "sell up to here" quantity.
 */
import { OpenLot, OpenLotTax, Position, Status } from '../../core/models';

/** Classes priced from a market quote, where a missing ticker means "valued at cost" and a sale has a what-if. */
export const TRADABLE_CLASSES: readonly string[] = ['equity', 'mutual_fund', 'commodity'];

/** XIRR annualises, so a few months' gain reads like +1500%; until a year has passed the page shows the plain return. */
export const XIRR_MIN_DAYS = 365;

/** `insights.py` CONCENTRATION_LIMIT / _MF: one holding above this share of the portfolio is a watch. */
export const CONCENTRATION_LIMIT = 15;
export const CONCENTRATION_LIMIT_MF = 25;

/** `HONESTY.cone` (H16): the fallback when an Outlook payload predates `assumptions.cone_label`. */
export const CONE_LABEL_FALLBACK = "statistical range at the asset class's long-run return; not a forecast";

export interface HoldingVerdict {
  status: Status;
  text: string;
  /** Where the evidence or the fix lives, with its link text. */
  link: string | null;
  fragment?: string;
  linkLabel: string | null;
}

export function isTradable(p: Pick<Position, 'asset_class'> | null | undefined): boolean {
  return !!p && TRADABLE_CLASSES.includes(p.asset_class);
}

/** The share of the portfolio at which this holding is a concentration watch, or null for classes the rule skips. */
export function concentrationLimit(p: Pick<Position, 'asset_class' | 'is_open'>): number | null {
  if (!p.is_open || ['cash', 'p2p', 'fixed_deposit'].includes(p.asset_class)) return null;
  return p.asset_class === 'mutual_fund' ? CONCENTRATION_LIMIT_MF : CONCENTRATION_LIMIT;
}

/**
 * T0 verdict, first rule that fires (J14):
 * 1. act "Valued at cost — set a ticker" for an open equity, mutual-fund or commodity holding without a price;
 * 2. watch "Large position: {weight}% of portfolio" at weight ≥ 15 (≥ 25 for a mutual fund);
 * 3. good.
 */
export function holdingVerdict(p: Position): HoldingVerdict {
  if (isTradable(p) && p.is_open && !p.has_price) {
    return { status: 'act', text: 'Valued at cost — set a ticker', link: '/settings', fragment: 'prices', linkLabel: 'Set a ticker' };
  }
  const limit = concentrationLimit(p);
  const w = p.weight ?? 0;
  if (limit !== null && w >= limit) {
    return { status: 'watch', text: `Large position: ${w.toFixed(1)}% of portfolio`, link: '/risk', fragment: 'concentration', linkLabel: 'See concentration' };
  }
  if (!p.is_open) return { status: 'good', text: 'Closed — fully sold, so these returns are final', link: null, linkLabel: null };
  if (p.status === 'defaulted') return { status: 'good', text: 'Marked defaulted — the class page tracks what is at risk', link: null, linkLabel: null };
  if (limit === null) return { status: 'good', text: `${w.toFixed(1)}% of your portfolio`, link: null, linkLabel: null };
  return { status: 'good', text: `Priced, and ${w.toFixed(1)}% of your portfolio — under the ${limit}% guide`, link: null, linkLabel: null };
}

/** Whole days from an ISO date (YYYY-MM-DD) to `today`, or null without a date. */
export function daysSince(iso: string | null | undefined, today: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
  if (isNaN(t)) return null;
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((now - t) / 86400000);
}

export function addDays(iso: string, days: number): string {
  const t = Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** total_return ÷ invested, as a percentage; null when nothing went in. */
export function returnOnMoneyIn(p: Pick<Position, 'total_return' | 'invested'>): number | null {
  return p.invested ? p.total_return / p.invested * 100 : null;
}

/** "Strip" link prefixes for this holding (J14, G14): its own page and its what-if on the Tax page. */
export function attentionPrefixes(id: number): string[] {
  return [`/holding/${id}`, `/tax?tab=whatif&whatif=${id}`];
}

/**
 * `tax.rule_for` holding periods by tax class, for when the tax view is not loaded (or skipped this lot because the
 * holding has no price). null = slab-rate class with no long-term rate (debt funds, interest).
 */
export function longTermDays(taxClass: string | null | undefined): number | null {
  switch (taxClass ?? 'equity') {
    case 'equity': case 'listed_other': return 365;
    case 'foreign_equity': return 730;
    default: return null;
  }
}

export interface LotRow {
  date: string;
  qty: number;
  cost: number;
  ageDays: number;
  value: number | null;
  gain: number | null;
  /** 'long' / 'short', or 'slab' when the class has no long-term rate. */
  term: 'long' | 'short' | 'slab';
  /** The day the lot turns long-term (null for slab classes). */
  ltOn: string | null;
  daysToLt: number;
  /** ELSS: the lock-in end, when still in the future. */
  lockedUntil: string | null;
  /** Units a FIFO sale must sell to include this lot: every older lot plus this one. */
  cumQty: number;
  /** true when the term and date came from `/tax`; false when they follow the holding-period rule locally. */
  fromTax: boolean;
}

function sameLot(a: Pick<OpenLot, 'date' | 'qty'>, b: Pick<OpenLotTax, 'date' | 'qty'>): boolean {
  return a.date === b.date && Math.abs(a.qty - b.qty) < 1e-6;
}

/**
 * Position `open_lots` (oldest first, FIFO) joined to the tax view's lots for this instrument by date and units.
 * `unitValue` is the ₹ value of one unit now (price × FX), or null without a price.
 */
export function joinLots(lots: OpenLot[] | null | undefined, taxLots: OpenLotTax[] | null | undefined, taxClass: string | null | undefined,
                         unitValue: number | null, today: Date = new Date()): LotRow[] {
  const tax = taxLots ?? [];
  const used = new Set<number>();
  const ltDays = longTermDays(taxClass);
  const todayIso = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())).toISOString().slice(0, 10);
  let cum = 0;
  return (lots ?? []).map((l, i) => {
    cum += l.qty;
    let k = i < tax.length && !used.has(i) && sameLot(l, tax[i]) ? i : tax.findIndex((t, j) => !used.has(j) && sameLot(l, t));
    const t = k >= 0 ? tax[k] : null;
    if (k >= 0) used.add(k);
    const age = daysSince(l.date, today) ?? l.age_days;
    if (t) {
      const term = t.term === 'LTCG' ? 'long' : t.lt_on ? 'short' : 'slab';
      return { date: l.date, qty: l.qty, cost: l.cost, ageDays: age, value: t.value, gain: t.gain, term, ltOn: t.lt_on,
        daysToLt: t.days_to_lt, lockedUntil: t.locked_until && t.locked_until > todayIso ? t.locked_until : null,
        cumQty: round6(cum), fromTax: true };
    }
    const ltOn = ltDays === null ? null : addDays(l.date, ltDays + 1);
    const long = ltOn !== null && ltOn <= todayIso;
    const value = unitValue === null ? null : l.qty * unitValue;
    return { date: l.date, qty: l.qty, cost: l.cost, ageDays: age, value, gain: value === null ? null : value - l.cost,
      term: ltOn === null ? 'slab' : long ? 'long' : 'short', ltOn,
      daysToLt: ltOn && !long ? Math.max(0, -(daysSince(ltOn, today) ?? 0)) : 0, lockedUntil: null, cumQty: round6(cum), fromTax: false };
  });
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
