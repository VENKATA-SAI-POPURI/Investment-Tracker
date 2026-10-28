import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { niceTicks, observeWidth, Tip, tipPosition } from './chart-utils';
import { fmtDate } from '../../core/format';

export interface LineSeries { key: string; label: string; color: string; values: (number | null)[]; area?: boolean; muted?: boolean; }

@Component({
  selector: 'app-line-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (series().length > 1) {
      <div class="legend" style="margin-bottom:10px">
        @for (s of series(); track s.key) { <span><i class="line-key" [style.background]="s.color"></i>{{ s.label }}</span> }
        <span class="spacer"></span>
        <button class="btn ghost sm muted" (click)="table.set(!table())">{{ table() ? 'Show chart' : 'View as table' }}</button>
      </div>
    }
    @if (!table()) {
      <svg [attr.width]="w()" [attr.height]="height()" role="img" [attr.aria-label]="ariaLabel()"
           (pointermove)="move($event)" (pointerleave)="tip.set(null)" style="display:block;touch-action:pan-y">
        @for (t of yTicks(); track t) {
          <line [attr.x1]="padL" [attr.x2]="w() - padR" [attr.y1]="y(t)" [attr.y2]="y(t)" stroke="var(--grid)" stroke-width="1" />
          <text [attr.x]="padL - 8" [attr.y]="y(t) + 4" text-anchor="end" class="tick">{{ yFormat()(t) }}</text>
        }
        @for (i of xTickIdx(); track i) {
          <text [attr.x]="x(i)" [attr.y]="height() - 6" [attr.text-anchor]="i === 0 ? 'start' : i === labels().length - 1 ? 'end' : 'middle'" class="tick">{{ xLabel(i) }}</text>
        }
        @for (s of series(); track s.key) {
          @if (s.area) {
            <defs><linearGradient [attr.id]="uid + s.key" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" [style.stop-color]="s.color" stop-opacity="0.24" /><stop offset="1" [style.stop-color]="s.color" stop-opacity="0" />
            </linearGradient></defs>
            <path [attr.d]="areaPath(s)" [attr.fill]="'url(#' + uid + s.key + ')'" />
          }
          <path [attr.d]="linePath(s)" fill="none" [attr.stroke]="s.color" [attr.stroke-width]="s.muted ? 1.5 : 2.25"
                stroke-linejoin="round" stroke-linecap="round" [attr.opacity]="s.muted ? 0.8 : 1" />
        }
        @if (endLabel(); as e) {
          <circle [attr.cx]="e.x" [attr.cy]="e.y" r="4" [attr.fill]="e.color" stroke="var(--surface)" stroke-width="2" />
        }
        @if (hover() !== null) {
          <line [attr.x1]="x(hover()!)" [attr.x2]="x(hover()!)" [attr.y1]="padT" [attr.y2]="height() - padB" stroke="var(--axis)" stroke-width="1" />
          @for (s of series(); track s.key) {
            @if (s.values[hover()!] !== null && s.values[hover()!] !== undefined) {
              <circle [attr.cx]="x(hover()!)" [attr.cy]="y(s.values[hover()!]!)" r="4" [attr.fill]="s.color" stroke="var(--surface)" stroke-width="2" />
            }
          }
        }
      </svg>
      @if (tip(); as t) {
        <div class="viz-tip" [style.left.px]="t.x" [style.top.px]="t.y">
          <div class="t-title">{{ t.title }}</div>
          @for (r of t.rows; track r.label) {
            <div class="t-row"><span class="t-key"><i class="line-key" [style.background]="r.color"></i>{{ r.label }}</span><b>{{ r.value }}</b></div>
          }
        </div>
      }
    } @else {
      <div class="table-wrap" [style.max-height.px]="height() + 40">
        <table class="table">
          <thead><tr><th>Date</th>@for (s of series(); track s.key) { <th class="num">{{ s.label }}</th> }</tr></thead>
          <tbody>
            @for (i of tableIdx(); track i) {
              <tr><td>{{ fmt(labels()[i]) }}</td>@for (s of series(); track s.key) { <td class="num">{{ s.values[i] === null ? '—' : yFormat()(s.values[i]!) }}</td> }</tr>
            }
          </tbody>
        </table>
      </div>
    }`,
  styles: [`:host{display:block;position:relative} .tick{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}`],
})
export class LineChartComponent {
  readonly uid = 'lc' + Math.random().toString(36).slice(2, 8);
  labels = input.required<string[]>();
  series = input.required<LineSeries[]>();
  height = input(260);
  yFormat = input<(v: number) => string>(v => String(Math.round(v)));
  tipFormat = input<((v: number) => string) | null>(null);
  ariaLabel = input('Line chart');
  zeroBased = input(false);

  readonly padL = 64; readonly padR = 12; readonly padT = 10; readonly padB = 26;
  w = observeWidth(inject(ElementRef));
  hover = signal<number | null>(null);
  tip = signal<Tip | null>(null);
  table = signal(false);

  private extent = computed(() => {
    const vals = this.series().flatMap(s => s.values.filter((v): v is number => v !== null && v !== undefined && isFinite(v)));
    if (!vals.length) return [0, 1];
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (this.zeroBased()) lo = Math.min(lo, 0);
    return [lo, hi];
  });
  yTicks = computed(() => niceTicks(this.extent()[0], this.extent()[1], this.height() > 200 ? 5 : 4));
  private yMin = computed(() => this.yTicks()[0]);
  private yMax = computed(() => this.yTicks()[this.yTicks().length - 1]);

  x = (i: number) => {
    const n = Math.max(this.labels().length - 1, 1);
    return this.padL + (i / n) * (this.w() - this.padL - this.padR);
  };
  y = (v: number) => {
    const span = this.yMax() - this.yMin() || 1;
    return this.padT + (1 - (v - this.yMin()) / span) * (this.height() - this.padT - this.padB);
  };

  xTickIdx = computed(() => {
    const n = this.labels().length;
    const count = Math.max(2, Math.min(6, Math.floor(this.w() / 110)));
    if (n <= count) return [...Array(n).keys()];
    return [...Array(count).keys()].map(k => Math.round((k / (count - 1)) * (n - 1)));
  });
  tableIdx = computed(() => {
    const n = this.labels().length, step = Math.max(1, Math.floor(n / 60));
    const idx = [];
    for (let i = n - 1; i >= 0; i -= step) idx.push(i);
    return idx;
  });

  private span = computed(() => {
    const l = this.labels();
    return l.length > 1 ? (new Date(l[l.length - 1]).getTime() - new Date(l[0]).getTime()) / 86400000 : 0;
  });
  xLabel(i: number) {
    const d = new Date(this.labels()[i] + 'T00:00:00');
    if (isNaN(d.getTime())) return this.labels()[i];
    return this.span() > 300 ? d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
      : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  fmt(d: string) { return fmtDate(d); }

  linePath(s: LineSeries) {
    let d = '', pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined || !isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }
  areaPath(s: LineSeries) {
    const pts = s.values.map((v, i) => [i, v] as const).filter(([, v]) => v !== null && v !== undefined);
    if (!pts.length) return '';
    const base = this.y(Math.max(this.yMin(), Math.min(0, this.yMax())));
    return `M${this.x(pts[0][0])},${base}` + pts.map(([i, v]) => `L${this.x(i)},${this.y(v!)}`).join('') + `L${this.x(pts[pts.length - 1][0])},${base}Z`;
  }
  endLabel = computed(() => {
    const s = this.series().find(x => !x.muted) ?? this.series()[0];
    if (!s) return null;
    for (let i = s.values.length - 1; i >= 0; i--) {
      const v = s.values[i];
      if (v !== null && v !== undefined) return { x: this.x(i), y: this.y(v), color: s.color };
    }
    return null;
  });

  move(ev: PointerEvent) {
    const rect = (ev.currentTarget as SVGElement).getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const n = this.labels().length;
    if (!n) return;
    const i = Math.round(((px - this.padL) / (this.w() - this.padL - this.padR)) * (n - 1));
    const idx = Math.max(0, Math.min(n - 1, i));
    this.hover.set(idx);
    const f = this.tipFormat() ?? this.yFormat();
    const rows = this.series().map(s => ({ label: s.label, color: s.color, value: s.values[idx] === null || s.values[idx] === undefined ? '—' : f(s.values[idx]!) }));
    this.tip.set({ ...tipPosition(ev, 220, 40 + rows.length * 20), title: fmtDate(this.labels()[idx]), rows });
  }
}
