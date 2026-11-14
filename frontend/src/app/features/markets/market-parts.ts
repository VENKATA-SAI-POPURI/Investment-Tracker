import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MarketState, PriceMetrics, Signal, SignalKey } from '../../core/models';
import { FORMAT_PIPES, fmtDate } from '../../core/format';

export const SIGNAL_TONE: Record<SignalKey, string> = { momentum_buy: 'good', momentum_sell: 'bad', dip_buy: 'info', profit_book: 'warn' };
export const SIGNAL_SHORT: Record<SignalKey, string> = {
  momentum_buy: 'Momentum ↑', momentum_sell: 'Momentum ↓', dip_buy: 'Dip bounce', profit_book: 'Cooling off',
};

/** One month of closes as a small line, green when up over the window and red when down. */
@Component({
  selector: 'app-spark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (path(); as p) {
    <svg [attr.width]="w()" [attr.height]="h()" [attr.viewBox]="'0 0 ' + w() + ' ' + h()" aria-hidden="true">
      <path [attr.d]="p" fill="none" [attr.stroke]="up() ? 'var(--pos)' : 'var(--neg)'" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  }`,
  styles: [':host { display: inline-flex; vertical-align: middle; }'],
})
export class SparkComponent {
  values = input<number[]>([]);
  w = input(72);
  h = input(22);
  up = computed(() => { const v = this.values(); return v.length < 2 || v[v.length - 1] >= v[0]; });
  path = computed(() => {
    const v = this.values();
    if (v.length < 2) return null;
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1, w = this.w(), h = this.h();
    return v.map((y, i) => `${i ? 'L' : 'M'}${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (y - lo) / span * (h - 4)).toFixed(1)}`).join('');
  });
}

/** Where today's price sits between the month's low and high. */
@Component({
  selector: 'app-range-bar',
  standalone: true,
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (m(); as x) {
    <span class="rb" [title]="'1-month range ' + (x.low_1m | inr: 2) + ' – ' + (x.high_1m | inr: 2)"><i [style.left.%]="pos()"></i></span>
  }`,
  styles: [`
    :host { display: inline-flex; vertical-align: middle; }
    .rb { position: relative; width: 64px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, var(--neg-soft), var(--surface-2), var(--pos-soft)); }
    .rb i { position: absolute; top: -3px; width: 4px; height: 12px; margin-left: -2px; border-radius: 2px; background: var(--ink); }
  `],
})
export class RangeBarComponent {
  m = input<PriceMetrics | null>(null);
  pos = computed(() => {
    const x = this.m();
    if (!x || x.high_1m === x.low_1m) return 50;
    return Math.min(100, Math.max(0, (x.price - x.low_1m) / (x.high_1m - x.low_1m) * 100));
  });
}

/**
 * Honesty label every market signal carries (Part 1 §1.9). The backend's `signals.SIGNAL_LABEL` says the same and
 * arrives on each described signal as `label` (K16); this is the fallback for payloads that predate it.
 */
export const SIGNAL_HONESTY = 'price pattern, not a forecast';

/**
 * A signal from the one vocabulary (`analytics/signals.py`, K16). `label` is its honesty label.
 * Typed locally until W6-F2's `Signal.label?` lands in models.ts; the two are compatible.
 */
export type LabelledSignal = Signal & { label?: string };

/**
 * Short signal badges, keyed by the four `SignalKey`s (K18). The tooltip gives the rule that fired and ends with the
 * signal's own honesty label, or `SIGNAL_HONESTY` when the payload has none: a price pattern, never a forecast.
 */
@Component({
  selector: 'app-signal-chips',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (s of signals(); track s.signal) { <span class="badge" [class]="tone[s.signal]" [title]="s.note + ' · ' + (s.label ?? honesty)">{{ short[s.signal] }}</span> }
    @empty { <span class="muted small">{{ empty() }}</span> }`,
  styles: [':host { display: inline-flex; gap: 4px; flex-wrap: wrap; }'],
})
export class SignalChipsComponent {
  signals = input<LabelledSignal[]>([]);
  empty = input('No signal');
  tone = SIGNAL_TONE;
  short = SIGNAL_SHORT;
  honesty = SIGNAL_HONESTY;
}

// ── P1.12: the crash/correction banner (K18) ──

/** `markets.CRASH_W1`: a one-week fall this big (percent) sets off crash mode and earns its own clause. */
export const MARKET_CRASH_W1 = -8;
/** `markets.FALLBACK_SCENARIO`: the stress key the sentence calls "the routine-correction scenario". */
const ROUTINE_SCENARIO = 'correction';
/** `markets.FALLBACK_LABEL`. The backend always fills `label`; this only guards a hand-made payload. */
const ROUTINE_LABEL = 'Market correction';

/** The banner's mode: `correction` or `crash` show it; `normal`, `volatile`, a missing state or null do not. */
export function marketBannerMode(state: MarketState | null | undefined): 'correction' | 'crash' | null {
  const m = state?.mode;
  return m === 'correction' || m === 'crash' ? m : null;
}

/**
 * Python's `f"{x:.{d}f}"` for a finite x ≥ 0. JavaScript's `toFixed` and Python agree except on an exact binary
 * tie (12.5 → "13" in JS, "12" in Python, which rounds half to even), so a tie is detected on the exact decimal
 * expansion and sent to the even neighbour. The banner must read the same as the backend's sentence.
 */
function pyFixed(x: number, d: number): string {
  const exact = x.toFixed(d + 25);
  const tail = exact.slice(-25);
  if (tail !== '5' + '0'.repeat(24)) return x.toFixed(d);
  const head = exact.slice(0, -25).replace(/\.$/, '');
  const last = Number(head[head.length - 1]);
  return last % 2 === 0 ? head : (Number(head) + 10 ** -d).toFixed(d);
}

/** `markets._inr_compact`: ₹1.23 Cr, ₹3.4 L, else the full Indian grouping (₹45,000). */
export function marketInr(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${pyFixed(a / 1e7, 2)} Cr`;
  if (a >= 1e5) return `${sign}₹${pyFixed(a / 1e5, 1)} L`;
  let s = pyFixed(a, 0);
  if (s.length > 3) {
    let head = s.slice(0, -3);
    const tail = s.slice(-3), groups: string[] = [];
    while (head.length > 2) { groups.unshift(head.slice(-2)); head = head.slice(0, -2); }
    s = [...(head ? [head] : []), ...groups].join(',') + ',' + tail;
  }
  return `${sign}₹${s}`;
}

/**
 * Line 1 of the Markets crash/correction banner: `markets.context_line(state).text`, word for word (K18, K22.7),
 * so Home's context line and this banner never say different things. Null outside correction and crash.
 * "Nifty is 12% below its high. You're down ₹3.4 L from your peak — smaller than the routine-correction scenario.
 *  Your SIPs are the plan; nothing needs selling." Facts and a calm plan only; no call on where the market goes.
 */
export function marketBannerText(state: MarketState | null | undefined): string | null {
  const mode = marketBannerMode(state);
  if (!state || !mode) return null;
  const nifty = state.nifty ?? ({} as Partial<MarketState['nifty']>);
  const fromHigh = Math.abs(Number(nifty.from_high_pct || 0));
  const w1 = nifty.w1;
  let first = `Nifty is ${pyFixed(fromHigh, 0)}% below its high`;
  if (mode === 'crash' && w1 !== null && w1 !== undefined && w1 <= MARKET_CRASH_W1) first += `, after a ${pyFixed(Math.abs(w1), 0)}% fall this week`;
  const parts = [first + '.'];
  const dd = state.you?.from_peak_pct ?? null, inr = state.you?.from_peak_inr ?? null, comp = state.comparable ?? null;
  if (dd !== null && dd >= 0) {
    parts.push('Your portfolio is at its peak.');
  } else if (inr !== null && comp) {
    const how = comp.smaller ? 'smaller than'
      : comp.impact_pct !== null && comp.impact_pct !== undefined && dd !== null && Math.abs(dd - comp.impact_pct) < 1 ? 'about the size of'
      : 'deeper than';
    const scenario = comp.key === ROUTINE_SCENARIO ? 'the routine-correction scenario' : `the ${comp.label || ROUTINE_LABEL} scenario`;
    parts.push(`You're down ${marketInr(Math.abs(inr))} from your peak — ${how} ${scenario}.`);
  } else if (dd !== null) {
    parts.push(`You're ${pyFixed(Math.abs(dd), 0)}% below your peak.`);
  }
  parts.push('Your SIPs are the plan; nothing needs selling.');
  return parts.join(' ');
}

/** The banner's source line: "From stored Nifty closes as of 6 Nov 2026 · since the high on 2 Jan 2026"; missing dates drop out. */
export function marketBannerSource(state: MarketState | null | undefined): string {
  const asOf = state?.as_of, since = state?.since;
  return 'From stored Nifty closes' + (asOf ? ` as of ${fmtDate(asOf)}` : '') + (since ? ` · since the high on ${fmtDate(since)}` : '');
}

/** A coloured +x.x% pill, or a dash. */
@Component({
  selector: 'app-chg',
  standalone: true,
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (v() !== null && v() !== undefined) { <span class="chg" [class]="v() | sign">{{ v() | pct }}</span> } @else { <span class="muted">—</span> }`,
})
export class ChgComponent {
  v = input<number | null | undefined>(null);
}
