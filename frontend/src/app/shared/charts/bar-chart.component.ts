import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { niceTicks, observeWidth, Tip, tipPosition } from './chart-utils';

/** One extra line in a bar's tooltip, under its value ("Going in · ₹8,000"). */
export interface BarTipRow { label: string; value: string; }

/**
 * One column. `muted` draws it faded with a dashed outline (an estimate beside facts); `key` is a unique track key
 * when two bars share a label; `tip` adds rows to its tooltip.
 */
export interface Bar { label: string; value: number; color?: string; title?: string; muted?: boolean; key?: string; tip?: BarTipRow[]; }

/**
 * A vertical rule before the bar at `index` (`index` = bars.length puts it after the last bar), with `label` on it
 * ("today"). `before` and `after` caption the two sides ("past 24 months", "estimate") when there is room for them.
 */
export interface BarDivider { index: number; label: string; before?: string; after?: string; }

/** Rough width of 11px tick text, for deciding whether a caption fits its side. */
const textW = (s: string) => s.length * 6.2;

/**
 * Vertical columns from one baseline; negative values hang below it (diverging colours).
 * Optional extras (W5-F9, additive): per-bar `muted`, `key` and tooltip rows (`tip`), a `divider` with captions,
 * and `labelGap` for the x-label spacing.
 * Without them the chart renders exactly as before.
 */
@Component({
  selector: 'app-bar-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="w()" [attr.height]="height()" role="img" [attr.aria-label]="ariaLabel()" (pointerleave)="tip.set(null); hover.set(-1)" style="display:block">
      @for (t of ticks(); track t) {
        <line [attr.x1]="padL" [attr.x2]="w() - 8" [attr.y1]="y(t)" [attr.y2]="y(t)" [attr.stroke]="t === 0 ? 'var(--axis)' : 'var(--grid)'" stroke-width="1" />
        <text [attr.x]="padL - 8" [attr.y]="y(t) + 4" text-anchor="end" class="tick">{{ yFormat()(t) }}</text>
      }
      @for (b of bars(); track b.key ?? b.label; let i = $index) {
        <rect [attr.x]="slotX(i)" [attr.y]="padT" [attr.width]="slotW()" [attr.height]="height() - padT - padB" fill="transparent"
              (pointermove)="move($event, i)" />
        <path [attr.d]="barPath(i)" [attr.fill]="b.color ?? (b.value >= 0 ? posColor() : negColor())"
              [attr.opacity]="opacity(b, i)" style="pointer-events:none"
              [attr.stroke]="b.muted ? (b.color ?? (b.value >= 0 ? posColor() : negColor())) : null"
              [attr.stroke-dasharray]="b.muted ? '3 2' : null" [attr.stroke-width]="b.muted ? 1 : null" [attr.stroke-opacity]="b.muted ? 1 : null"
              [attr.fill-opacity]="b.muted ? 0.45 : null" />
        @if (showLabel(i)) {
          <text [attr.x]="slotX(i) + slotW() / 2" [attr.y]="height() - 8" text-anchor="middle" class="tick">{{ b.label }}</text>
        }
      }
      @if (divider(); as d) {
        <line class="divider" [attr.x1]="divX()" [attr.x2]="divX()" [attr.y1]="padT - 6" [attr.y2]="height() - padB" />
        <text class="tick div-label" [attr.x]="divX()" y="12" text-anchor="middle">{{ d.label }}</text>
        @if (d.before && fits(d.before, divX() - padL)) {
          <text class="tick cap" [attr.x]="divX() - gap()" y="12" text-anchor="end">{{ d.before }}</text>
        }
        @if (d.after && fits(d.after, w() - 8 - divX())) {
          <text class="tick cap" [attr.x]="divX() + gap()" y="12" text-anchor="start">{{ d.after }}</text>
        }
      }
    </svg>
    @if (tip(); as t) {
      <div class="viz-tip" [style.left.px]="t.x" [style.top.px]="t.y">
        <div class="t-row"><b>{{ t.rows[0].value }}</b></div>
        <div class="t-title" style="margin:2px 0 0">{{ t.title }}</div>
        @for (r of t.rows.slice(1); track $index) {
          <div class="t-row" style="margin-top:2px"><span class="t-key">{{ r.label }}</span><b>{{ r.value }}</b></div>
        }
      </div>
    }`,
  styles: [`:host{display:block} .tick{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}
    .divider{stroke:var(--text-2);stroke-width:1;stroke-dasharray:4 3} .div-label{font-weight:600;fill:var(--text-2)} .cap{font-style:italic}`],
})
export class BarChartComponent {
  bars = input.required<Bar[]>();
  height = input(220);
  yFormat = input<(v: number) => string>(v => String(v));
  tipFormat = input<((v: number) => string) | null>(null);
  posColor = input('var(--s1)');
  negColor = input('var(--s8)');
  ariaLabel = input('Bar chart');
  /** Optional rule between two bars (W5-F9); null draws none and keeps the old top padding. */
  divider = input<BarDivider | null>(null);
  /** Minimum px per x-axis label (W5-F9); 48 is the spacing every chart had before. Wider labels ("Nov 26") want ~60. */
  labelGap = input(48);

  readonly padL = 56; readonly padB = 26;
  /** Top padding: 10 as always, or room for the divider's label row. */
  get padT() { return this.divider() ? 26 : 10; }
  w = observeWidth(inject(ElementRef));
  tip = signal<Tip | null>(null);
  hover = signal(-1);

  ticks = computed(() => {
    const vals = this.bars().map(b => b.value);
    return niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 5);
  });
  private lo = computed(() => this.ticks()[0]);
  private hi = computed(() => this.ticks()[this.ticks().length - 1]);
  y = (v: number) => this.padT + (1 - (v - this.lo()) / ((this.hi() - this.lo()) || 1)) * (this.height() - this.padT - this.padB);
  slotW = computed(() => (this.w() - this.padL - 8) / Math.max(this.bars().length, 1));
  slotX = (i: number) => this.padL + i * this.slotW();
  barW = computed(() => Math.max(2, Math.min(24, this.slotW() - 2)));

  /** The divider's x: the left edge of slot `index`, clamped to the plot. */
  divX = computed(() => {
    const d = this.divider();
    if (!d) return 0;
    return this.slotX(Math.max(0, Math.min(this.bars().length, d.index)));
  });
  /** Space between the rule and a side caption: clear of the centred label. */
  gap = computed(() => textW(this.divider()?.label ?? '') / 2 + 8);
  fits = (caption: string, room: number) => textW(caption) + this.gap() <= room;

  opacity(b: Bar, i: number) {
    const on = this.hover() === -1 || this.hover() === i;
    return on ? 1 : 0.55;
  }

  barPath(i: number) {
    const b = this.bars()[i];
    const x = this.slotX(i) + (this.slotW() - this.barW()) / 2, w = this.barW();
    const y0 = this.y(0), y1 = this.y(b.value);
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    const r = Math.min(4, h, w / 2);
    if (b.value >= 0) { // rounded top, square at baseline
      return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
    }
    return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
  }

  showLabel(i: number) {
    const n = this.bars().length;
    const every = Math.ceil(n / Math.max(1, Math.floor(this.w() / Math.max(1, this.labelGap()))));
    return i % every === 0 || i === n - 1 && (n - 1) % every > every / 2;
  }

  move(ev: PointerEvent, i: number) {
    this.hover.set(i);
    const b = this.bars()[i];
    const f = this.tipFormat() ?? this.yFormat();
    const extra = b.tip ?? [];
    this.tip.set({
      ...tipPosition(ev, extra.length ? 220 : 160, 50 + extra.length * 20), title: b.title ?? b.label,
      rows: [{ label: b.label, value: f(b.value) }, ...extra.map(r => ({ label: r.label, value: r.value }))],
    });
  }
}
