import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { niceTicks, observeWidth, Tip, tipPosition } from './chart-utils';

export interface Bar { label: string; value: number; color?: string; title?: string; }

/** Vertical columns from one baseline; negative values hang below it (diverging colours). */
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
      @for (b of bars(); track b.label; let i = $index) {
        <rect [attr.x]="slotX(i)" [attr.y]="padT" [attr.width]="slotW()" [attr.height]="height() - padT - padB" fill="transparent"
              (pointermove)="move($event, i)" />
        <path [attr.d]="barPath(i)" [attr.fill]="b.color ?? (b.value >= 0 ? posColor() : negColor())"
              [attr.opacity]="hover() === -1 || hover() === i ? 1 : 0.55" style="pointer-events:none" />
        @if (showLabel(i)) {
          <text [attr.x]="slotX(i) + slotW() / 2" [attr.y]="height() - 8" text-anchor="middle" class="tick">{{ b.label }}</text>
        }
      }
    </svg>
    @if (tip(); as t) {
      <div class="viz-tip" [style.left.px]="t.x" [style.top.px]="t.y">
        <div class="t-row"><b>{{ t.rows[0].value }}</b></div>
        <div class="t-title" style="margin:2px 0 0">{{ t.title }}</div>
      </div>
    }`,
  styles: [`:host{display:block} .tick{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}`],
})
export class BarChartComponent {
  bars = input.required<Bar[]>();
  height = input(220);
  yFormat = input<(v: number) => string>(v => String(v));
  tipFormat = input<((v: number) => string) | null>(null);
  posColor = input('var(--s1)');
  negColor = input('var(--s8)');
  ariaLabel = input('Bar chart');

  readonly padL = 56; readonly padT = 10; readonly padB = 26;
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
    const every = Math.ceil(n / Math.max(1, Math.floor(this.w() / 48)));
    return i % every === 0 || i === n - 1 && (n - 1) % every > every / 2;
  }

  move(ev: PointerEvent, i: number) {
    this.hover.set(i);
    const b = this.bars()[i];
    const f = this.tipFormat() ?? this.yFormat();
    this.tip.set({ ...tipPosition(ev, 160, 50), title: b.title ?? b.label, rows: [{ label: b.label, value: f(b.value) }] });
  }
}
