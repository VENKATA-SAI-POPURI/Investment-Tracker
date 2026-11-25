import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal } from '@angular/core';

/** Points scaled into a w × h box with `pad` inside each edge. */
function scale(vals: number[], w: number, h: number, pad: number, min: number, max: number): [number, number][] {
  const n = vals.length;
  const sx = n > 1 ? (w - 2 * pad) / (n - 1) : 0;
  const span = max - min || 1;
  return vals.map((v, i) => [pad + i * sx, h - pad - ((v - min) / span) * (h - 2 * pad)]);
}

/** A smooth path through the points (horizontal-tangent cubic segments: never overshoots between points). */
function smooth(p: [number, number][]): string {
  if (!p.length) return '';
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 1; i < p.length; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], mx = (x0 + x1) / 2;
    d += ` C${mx.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

let uid = 0;

/** Value (filled, solid) against a second line (e.g. money invested), with a few x labels under it. */
@Component({
  selector: 'v-area',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (paths(); as p) {
      <svg [attr.viewBox]="'0 0 ' + cw() + ' ' + ch()" [attr.width]="cw()" [attr.height]="ch()" style="display:block;overflow:visible" role="img" [attr.aria-label]="label()">
        <defs><linearGradient [attr.id]="gid" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" [attr.stop-color]="color()" stop-opacity=".26" /><stop offset="1" [attr.stop-color]="color()" stop-opacity="0" />
        </linearGradient></defs>
        @for (f of [0.33, 0.66]; track f) { <line x1="0" [attr.x2]="cw()" [attr.y1]="ch() * f" [attr.y2]="ch() * f" stroke="rgba(106,70,245,.12)" stroke-dasharray="3 4" /> }
        <path [attr.d]="p.area" [attr.fill]="'url(#' + gid + ')'" />
        @if (p.b) { <path [attr.d]="p.b" fill="none" [attr.stroke]="colorB()" stroke-width="2.2" [attr.stroke-dasharray]="dashB() ? '6 5' : null" /> }
        <path [attr.d]="p.a" fill="none" [attr.stroke]="color()" stroke-width="3" stroke-linecap="round" />
        <circle [attr.cx]="p.last[0]" [attr.cy]="p.last[1]" r="5.5" fill="#fff" [attr.stroke]="color()" stroke-width="3" />
      </svg>
      @if (labels().length) {
        <div class="xl">@for (l of labels(); track $index) { <span>{{ l }}</span> }</div>
      }
    } @else {
      <div class="v-skel" [style.height.px]="ch()"></div>
    }
  `,
  styles: [':host{display:block;width:100%;min-width:0}:host(.fill){flex:1 1 auto;display:flex;flex-direction:column;justify-content:flex-end}.xl{display:flex;justify-content:space-between;font-size:11px;color:#a9a5bf;font-weight:600;margin-top:4px}'],
})
export class AreaChartComponent {
  private host = inject(ElementRef<HTMLElement>);
  /** The width the chart is drawn at: the element's own width, so lines keep their thickness at any screen size. */
  cw = signal(360);
  /** The height: `h`, or (with class "fill") the room the element is given, never less than `h`. */
  ch = signal(130);
  private fills = false;
  a = input<number[]>([]);
  b = input<number[] | null>(null);
  labels = input<string[]>([]);
  color = input('#6a46f5');
  colorB = input('#c9c5d8');
  dashB = input(false);
  w = input(360);
  h = input(130);
  label = input('Chart');
  gid = `va${++uid}`;

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement as HTMLElement;
      this.fills = el.classList.contains('fill');
      const measure = () => {
        const r = el.getBoundingClientRect();
        if (r.width > 0) this.cw.set(Math.round(r.width));
        const room = this.fills ? Math.round(r.height - (this.labels().length ? 20 : 0)) : 0;
        this.ch.set(Math.max(this.h(), room));
      };
      measure();
      const ro = new ResizeObserver(() => measure());
      ro.observe(el);
      destroy.onDestroy(() => ro.disconnect());
    });
  }

  paths = computed(() => {
    const a = this.a(), b = this.b();
    const W = this.cw(), H = this.ch();
    if (a.length < 2) return null;
    const all = [...a, ...(b ?? [])].filter(v => Number.isFinite(v));
    const lo = Math.min(...all), hi = Math.max(...all);
    const min = lo - (hi - lo) * 0.06, max = hi + (hi - lo) * 0.04;
    const pa = scale(a, W, H, 6, min, max);
    const pb = b && b.length > 1 ? scale(b, W, H, 6, min, max) : null;
    const line = smooth(pa);
    return { a: line, b: pb ? smooth(pb) : null, area: `${line} L${pa[pa.length - 1][0]},${H} L${pa[0][0]},${H} Z`, last: pa[pa.length - 1] };
  });
}

/** A thin trend line. */
@Component({
  selector: 'v-spark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (d()) { <svg [attr.width]="w()" [attr.height]="h()" [attr.viewBox]="'0 0 ' + w() + ' ' + h()" aria-hidden="true">
    <path [attr.d]="d()" fill="none" [attr.stroke]="color()" [attr.stroke-width]="stroke()" stroke-linecap="round" stroke-linejoin="round" /></svg> }`,
  styles: [':host{display:inline-flex;line-height:0}'],
})
export class SparkComponent {
  values = input<number[]>([]);
  color = input('currentColor');
  w = input(60);
  h = input(24);
  stroke = input(2.2);
  d = computed(() => {
    const v = this.values().filter(x => Number.isFinite(x));
    if (v.length < 2) return '';
    const p = scale(v, this.w(), this.h(), 3, Math.min(...v), Math.max(...v));
    return p.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
  });
}

export interface DonutPart { value: number; color: string; label?: string; }

/** A ring with a small gap between parts and two lines of text in the middle. */
@Component({
  selector: 'v-donut',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" [attr.viewBox]="'0 0 ' + size() + ' ' + size()" role="img" [attr.aria-label]="label()">
      <g [attr.transform]="'rotate(-90 ' + size() / 2 + ' ' + size() / 2 + ')'">
        @if (!arcs().length) { <circle [attr.cx]="size() / 2" [attr.cy]="size() / 2" [attr.r]="r()" fill="none" stroke="#efedf5" [attr.stroke-width]="thickness()" /> }
        @for (a of arcs(); track $index) {
          <circle [attr.cx]="size() / 2" [attr.cy]="size() / 2" [attr.r]="r()" fill="none" [attr.stroke]="a.color" [attr.stroke-width]="thickness()"
            [attr.stroke-dasharray]="a.len + ' ' + circ()" [attr.stroke-dashoffset]="-a.off" />
        }
      </g>
      @if (top()) { <text [attr.x]="size() / 2" [attr.y]="size() / 2 - 4" text-anchor="middle" font-size="11" fill="#8a86a3" font-weight="600">{{ top() }}</text> }
      @if (bottom()) { <text [attr.x]="size() / 2" [attr.y]="size() / 2 + 14" text-anchor="middle" [attr.font-size]="bottomSize()" font-weight="800" fill="#1a1534">{{ bottom() }}</text> }
    </svg>`,
  styles: [':host{display:inline-flex;line-height:0}'],
})
export class DonutComponent {
  parts = input<DonutPart[]>([]);
  size = input(132);
  thickness = input(20);
  top = input('');
  bottom = input('');
  bottomSize = input(16);
  label = input('Share of the portfolio');
  r = computed(() => (this.size() - this.thickness()) / 2);
  circ = computed(() => 2 * Math.PI * this.r());
  arcs = computed(() => {
    const parts = this.parts().filter(p => p.value > 0);
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) return [];
    const c = this.circ(), gap = parts.length > 1 ? 2.2 : 0;
    let off = 0;
    return parts.map(p => {
      const len = (p.value / total) * c;
      const a = { color: p.color, len: Math.max(len - gap, 0.5), off };
      off += len;
      return a;
    });
  });
}
