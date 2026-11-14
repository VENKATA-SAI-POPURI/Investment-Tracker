import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { niceTicks, observeWidth, Tip, tipPosition } from './chart-utils';
import { fmtDate, inr } from '../../core/format';

export interface LineSeries { key: string; label: string; color: string; values: (number | null)[]; area?: boolean; muted?: boolean; dashed?: boolean; }
/** A shaded band between two series (fan charts): drawn behind the lines. */
export interface LineBand { key: string; label: string; color: string; lo: (number | null)[]; hi: (number | null)[]; opacity?: number; }
/**
 * A point marker at label index `i`.
 * - `buy` / `sell`: a dot on the first series, titled `title` (trades on a price chart).
 * - `goal` (P1, §9.3): a 7 px diamond at `amount` (or `value`) with `label` above it and the tooltip
 *   "{name} · needs ₹X" (`title` overrides it). It widens the y-axis so the target is always in view.
 */
export interface LineMarker {
  i: number; kind: 'buy' | 'sell' | 'goal'; title?: string;
  label?: string; name?: string; amount?: number | null; value?: number | null;
}

@Component({
  selector: 'app-line-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (series().length > 1 || bands().length) {
      <div class="legend" style="margin-bottom:10px">
        @for (b of bands(); track b.key) { <span><i class="swatch" [style.background]="b.color" [style.opacity]="(b.opacity ?? 0.18) + 0.25"></i>{{ b.label }}</span> }
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
          <text [attr.x]="x(i)" [attr.y]="height() - 6" [attr.text-anchor]="i === 0 ? 'start' : i === labels().length - 1 ? 'end' : 'middle'" class="tick">{{ xTick(i) }}</text>
        }
        @for (b of bands(); track b.key) {
          <path [attr.d]="bandPath(b)" [attr.fill]="b.color" [attr.opacity]="b.opacity ?? 0.18" style="pointer-events:none" />
        }
        @for (s of series(); track s.key) {
          @if (s.area) {
            <defs><linearGradient [attr.id]="uid + s.key" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" [style.stop-color]="s.color" stop-opacity="0.24" /><stop offset="1" [style.stop-color]="s.color" stop-opacity="0" />
            </linearGradient></defs>
            <path [attr.d]="areaPath(s)" [attr.fill]="'url(#' + uid + s.key + ')'" />
          }
          <path [attr.d]="linePath(s)" fill="none" [attr.stroke]="s.color" [attr.stroke-width]="s.muted ? 1.5 : 2.25"
                [attr.stroke-dasharray]="s.dashed ? '5 4' : null" stroke-linejoin="round" stroke-linecap="round" [attr.opacity]="s.muted ? 0.8 : 1" />
        }
        @for (m of markerPts(); track $index) {
          <circle [attr.cx]="m.x" [attr.cy]="m.y" r="5.5" [attr.fill]="m.kind === 'buy' ? '#059669' : '#dc2626'" stroke="var(--surface)" stroke-width="2"><title>{{ m.title }}</title></circle>
        }
        @for (g of goalPts(); track $index) {
          <g class="goal-mk" [attr.transform]="'translate(' + g.x + ',' + g.y + ')'" role="img" [attr.aria-label]="g.tip">
            <rect x="-3.5" y="-3.5" width="7" height="7" transform="rotate(45)" fill="var(--accent-strong)" stroke="var(--surface)" stroke-width="1.5"><title>{{ g.tip }}</title></rect>
            @if (g.label) { <text [attr.x]="0" [attr.y]="g.ly" [attr.text-anchor]="g.anchor" class="goal-label">{{ g.label }}</text> }
          </g>
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
              <tr><td>{{ rowLabel(i) }}</td>@for (s of series(); track s.key) { <td class="num">{{ s.values[i] === null ? '—' : yFormat()(s.values[i]!) }}</td> }</tr>
            }
          </tbody>
        </table>
      </div>
    }`,
  styles: [`:host{display:block;position:relative} .tick{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}
    .goal-label{font-size:11px;font-weight:600;fill:var(--text-2);paint-order:stroke;stroke:var(--surface);stroke-width:3px;stroke-linejoin:round}`],
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
  markers = input<LineMarker[]>([]);
  bands = input<LineBand[]>([]);
  /**
   * Formats an x label (axis ticks, the tooltip title and the table's first column), e.g. "2041 · 45" or an age.
   * Without it, ISO dates are shown as dates and anything else as given.
   */
  xLabel = input<((label: string, i: number) => string) | null>(null);

  readonly padL = 64; readonly padR = 12; readonly padT = 10; readonly padB = 26;
  w = observeWidth(inject(ElementRef));
  hover = signal<number | null>(null);
  tip = signal<Tip | null>(null);
  table = signal(false);

  private extent = computed(() => {
    const vals = [...this.series().flatMap(s => s.values), ...this.bands().flatMap(b => [...b.lo, ...b.hi]),
      ...this.markers().filter(m => m.kind === 'goal').map(m => this.goalValue(m))]
      .filter((v): v is number => v !== null && v !== undefined && isFinite(v));
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
  /** An axis tick: the `xLabel` formatter when given, else a short date. */
  xTick(i: number) {
    const f = this.xLabel();
    if (f) return f(this.labels()[i], i);
    const d = new Date(this.labels()[i] + 'T00:00:00');
    if (isNaN(d.getTime())) return this.labels()[i];
    return this.span() > 300 ? d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
      : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  /** The tooltip title and the table's first column: the `xLabel` formatter when given, else the full date. */
  rowLabel(i: number) {
    const f = this.xLabel();
    return f ? f(this.labels()[i], i) : fmtDate(this.labels()[i]);
  }
  fmt(d: string) { return fmtDate(d); }

  /** Where a goal marker sits: its amount (the target), else `value`, else the first series at `i`. */
  private goalValue(m: LineMarker): number | null {
    const v = m.amount ?? m.value ?? this.series()[0]?.values[m.i];
    return v === undefined || v === null || !isFinite(v) ? null : v;
  }
  private goalTip(m: LineMarker): string {
    if (m.title) return m.title;
    const name = m.name ?? m.label ?? 'Goal';
    return m.amount !== null && m.amount !== undefined ? `${name} · needs ${inr(m.amount)}` : name;
  }

  linePath(s: LineSeries) {
    let d = '', pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined || !isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }
  bandPath(b: LineBand) {
    const pts = b.hi.map((v, i) => [i, v, b.lo[i]] as const).filter(([, h, l]) => h !== null && h !== undefined && l !== null && l !== undefined);
    if (pts.length < 2) return '';
    const top = pts.map(([i, h]) => `${this.x(i).toFixed(1)},${this.y(h!).toFixed(1)}`).join('L');
    const bottom = [...pts].reverse().map(([i, , l]) => `${this.x(i).toFixed(1)},${this.y(l!).toFixed(1)}`).join('L');
    return `M${top}L${bottom}Z`;
  }
  areaPath(s: LineSeries) {
    const pts = s.values.map((v, i) => [i, v] as const).filter(([, v]) => v !== null && v !== undefined);
    if (!pts.length) return '';
    const base = this.y(Math.max(this.yMin(), Math.min(0, this.yMax())));
    return `M${this.x(pts[0][0])},${base}` + pts.map(([i, v]) => `L${this.x(i)},${this.y(v!)}`).join('') + `L${this.x(pts[pts.length - 1][0])},${base}Z`;
  }
  markerPts = computed(() => {
    const s = this.series()[0];
    if (!s) return [];
    return this.markers().filter(m => m.kind !== 'goal' && s.values[m.i] !== null && s.values[m.i] !== undefined)
      .map(m => ({ ...m, x: this.x(m.i), y: this.y(s.values[m.i]!) }));
  });
  /** Goal diamonds; a label near either edge is anchored inward so it is never clipped. */
  goalPts = computed(() => {
    const n = this.labels().length;
    return this.markers().filter(m => m.kind === 'goal' && m.i >= 0 && m.i < n).flatMap(m => {
      const v = this.goalValue(m);
      if (v === null) return [];
      const x = this.x(m.i);
      const anchor = x < this.padL + 40 ? 'start' : x > this.w() - this.padR - 40 ? 'end' : 'middle';
      const y = this.y(v);
      // the label sits above the diamond, or below it when the target is at the top of the plot
      return [{ x, y, label: m.label ?? null, tip: this.goalTip(m), anchor, ly: y < 22 ? 17 : -9 }];
    });
  });
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
    const fmt = (v: number | null | undefined) => v === null || v === undefined ? '—' : f(v);
    const rows = [
      ...this.series().map(s => ({ label: s.label, color: s.color, value: fmt(s.values[idx]) })),
      ...this.bands().map(b => ({ label: b.label, color: b.color, value: `${fmt(b.lo[idx])} – ${fmt(b.hi[idx])}` })),
      ...this.markers().filter(m => m.kind === 'goal' && m.i === idx)
        .map(m => ({ label: m.name ?? m.label ?? 'Goal', color: 'var(--accent-strong)',
          value: m.amount !== null && m.amount !== undefined ? `needs ${inr(m.amount)}` : '' })),
    ];
    this.tip.set({ ...tipPosition(ev, 220, 40 + rows.length * 20), title: this.rowLabel(idx), rows });
  }
}
