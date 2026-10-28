import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { Tip, tipPosition } from './chart-utils';

export interface Slice { label: string; value: number; color: string; meta?: string; }

/** Part-to-whole at a glance (≤ 6 slices). Values always also listed in the legend table. */
@Component({
  selector: 'app-donut-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="-1 -1 2 2" role="img" [attr.aria-label]="ariaLabel()" (pointerleave)="tip.set(null); active.set(null)">
      @for (a of arcs(); track a.label) {
        <path [attr.d]="a.d" [attr.fill]="a.color" [attr.opacity]="active() === null || active() === a.label ? 1 : 0.45"
              (pointermove)="hover($event, a)" (click)="pick.emit(a.label)" style="cursor:pointer" />
      }
      <text x="0" y="-0.04" text-anchor="middle" class="c1">{{ centerTop() }}</text>
      <text x="0" y="0.2" text-anchor="middle" class="c2">{{ centerBottom() }}</text>
    </svg>
    @if (tip(); as t) {
      <div class="viz-tip" [style.left.px]="t.x" [style.top.px]="t.y">
        <div class="t-row"><b>{{ t.rows[0].value }}</b></div>
        <div class="t-title" style="margin:2px 0 0">{{ t.title }}</div>
      </div>
    }`,
  styles: [`:host{display:inline-block;line-height:0} .c1{font-size:.2px;font-weight:600;fill:var(--text)} .c2{font-size:.13px;fill:var(--muted)}`],
})
export class DonutChartComponent {
  slices = input.required<Slice[]>();
  size = input(180);
  centerTop = input('');
  centerBottom = input('');
  ariaLabel = input('Allocation');
  valueFormat = input<(v: number) => string>(v => String(v));
  pick = output<string>();
  tip = signal<Tip | null>(null);
  active = signal<string | null>(null);

  arcs = computed(() => {
    const items = this.slices().filter(s => s.value > 0);
    const total = items.reduce((a, s) => a + s.value, 0) || 1;
    const gap = items.length > 1 ? 0.025 : 0; // radians of surface gap between slices
    const R = 1, r = 0.68;
    let a0 = -Math.PI / 2;
    return items.map(s => {
      const sweep = (s.value / total) * Math.PI * 2;
      const start = a0 + gap / 2, end = a0 + sweep - gap / 2;
      a0 += sweep;
      const large = end - start > Math.PI ? 1 : 0;
      const p = (rad: number, ang: number) => `${(rad * Math.cos(ang)).toFixed(4)},${(rad * Math.sin(ang)).toFixed(4)}`;
      const d = sweep >= Math.PI * 2 - 1e-6
        ? `M0,-1A1,1 0 1 1 0,1A1,1 0 1 1 0,-1ZM0,-${r}A${r},${r} 0 1 0 0,${r}A${r},${r} 0 1 0 0,-${r}Z`
        : `M${p(R, start)}A${R},${R} 0 ${large} 1 ${p(R, end)}L${p(r, end)}A${r},${r} 0 ${large} 0 ${p(r, start)}Z`;
      return { ...s, d, pct: (s.value / total) * 100 };
    });
  });

  hover(ev: PointerEvent, a: Slice & { pct: number }) {
    this.active.set(a.label);
    this.tip.set({ ...tipPosition(ev, 180, 60), title: `${a.label} · ${a.pct.toFixed(1)}%`, rows: [{ label: a.label, value: this.valueFormat()(a.value) }] });
  }
}
