import { fmtDate, money, pctV, qty, usd } from './format';

const monthYear = (d: string) => new Date(d + 'T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' });
import { Position } from './models';

/** How one holding reads in a list: a second line, the change shown under its value and that change's tone. */
export interface HoldingLine { sub: string; change: string; tone: 'gain' | 'loss' | 'mut' | 'warn'; }

const LOGO_COLORS = ['#3d7bfa', '#10b9a0', '#f2a516', '#8b5cf6', '#f0609e', '#ff7a45', '#2f80ed', '#12a16b'];

/** Two letters for a holding's badge: "HDFC Bank" → "HB", "Infosys" → "IN". */
export function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + (words[1][0] === '&' ? words[2]?.[0] ?? '' : words[1][0])).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

/** A stable colour per name, so a holding keeps its badge colour everywhere. */
export function logoColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LOGO_COLORS[h % LOGO_COLORS.length];
}

const tone = (v: number | null | undefined): HoldingLine['tone'] => !v ? 'mut' : v > 0 ? 'gain' : 'loss';

export function holdingLine(p: Position): HoldingLine {
  switch (p.asset_class) {
    case 'p2p': {
      const left = p.outstanding ?? 0;
      const status = (p.status || '').toLowerCase();
      const ends = p.maturity_date ? ` · ends ${monthYear(p.maturity_date)}` : '';
      let sub: string, t: HoldingLine['tone'] = tone(p.interest);
      if (status === 'closed') sub = `Closed · ${money(p.invested)} lent`;
      else if (status === 'defaulted') { sub = `Defaulted · ${money(left)} unpaid, counted at ${money(p.value)}`; t = 'loss'; }
      else if ((p.emis_behind ?? 0) > 0) { sub = `${money(left)} left · ${p.emis_behind} EMI${p.emis_behind === 1 ? '' : 's'} behind (due ${fmtDate(p.next_due, false)})`; t = 'warn'; }
      else if (p.next_due) sub = `${money(left)} left · next EMI ${fmtDate(p.next_due, false)}${ends}`;
      else sub = `${money(left)} left${ends}`;
      return { sub, change: `${money(p.interest ?? 0, true)} interest`, tone: t };
    }
    case 'fixed_deposit':
      return { sub: `${p.rate ?? '—'}% · ${p.days_to_maturity !== null && p.days_to_maturity !== undefined ? 'matures ' + fmtDate(p.maturity_date, true) : 'matured'}`,
        change: `${money(p.accrued_interest ?? 0, true)} interest`, tone: tone(p.accrued_interest) };
    case 'epf':
      // EPF grows by interest: show the interest in rupees and the yearly rate, not a % of contributions
      return { sub: `${p.rate ?? 8.25}% · ${money(p.invested)} contributed${p.proceeds ? ` · ${money(p.proceeds)} withdrawn` : ''}`,
        change: `${money(p.unrealized, true)} interest`, tone: tone(p.unrealized) };
    case 'cash':
      return { sub: `${usd(p.balance_usd ?? 0)} cash · bought at ₹${(p.avg_rate ?? 0).toFixed(2)}`, change: money(p.unrealized, true), tone: tone(p.unrealized) };
    default: {
      const unit = p.asset_class === 'equity' ? 'shares' : 'units';
      const avg = p.currency === 'USD' && p.avg_cost_fc ? usd(p.avg_cost_fc) : p.avg_cost !== null && p.avg_cost !== undefined ? '₹' + (p.avg_cost).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
      if (!p.is_open) return { sub: `Sold · booked ${money(p.realized, true)}`, change: pctV(p.xirr, 1, true) + ' / yr', tone: tone(p.realized) };
      return { sub: `${qty(p.quantity)} ${unit} · avg ${avg}${p.has_price ? '' : ' · no price yet'}`,
        change: p.has_price ? pctV(p.unrealized_pct, 1, true) : 'at cost', tone: p.has_price ? tone(p.unrealized) : 'warn' };
    }
  }
}
