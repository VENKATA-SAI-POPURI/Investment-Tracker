import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PriceMetrics, Signal, SignalKey } from '../../core/models';
import { FORMAT_PIPES } from '../../core/format';

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

@Component({
  selector: 'app-signal-chips',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (s of signals(); track s.signal) { <span class="badge" [class]="tone[s.signal]" [title]="s.note">{{ short[s.signal] }}</span> }
    @empty { <span class="muted small">{{ empty() }}</span> }`,
  styles: [':host { display: inline-flex; gap: 4px; flex-wrap: wrap; }'],
})
export class SignalChipsComponent {
  signals = input<Signal[]>([]);
  empty = input('No signal');
  tone = SIGNAL_TONE;
  short = SIGNAL_SHORT;
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
