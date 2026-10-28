import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FORMAT_PIPES, inrCompact } from '../../core/format';
import { Attribution, MarketCompare, Milestones, Rhythm, SEGMENT_COLOR, SEGMENT_META, Takeaway } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

/** Shared look for the diverging (gain / loss) bars used by several cards. */
const DIVERGING = `
  .dv { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; height: 18px; }
  .dv > span { display: flex; height: 100%; align-items: center; }
  .dv > span:first-child { justify-content: flex-end; border-right: 1.5px solid var(--axis); }
  .dv i { display: block; height: 12px; }
  .dv .g { background: var(--pos); border-radius: 0 4px 4px 0; }
  .dv .l { background: var(--neg); border-radius: 4px 0 0 4px; opacity: .85; }
`;

const TONE = {
  pos: { chip: 'green', bar: 'var(--pos)' },
  neg: { chip: 'red', bar: 'var(--neg)' },
  neutral: { chip: 'indigo', bar: 'var(--primary)' },
};

function route(link: string | null) {
  const [path, frag] = (link ?? '/').split('#');
  return { path, frag: frag || undefined };
}

/** The handful of things worth knowing today, each a door into the detail. */
@Component({
  selector: 'app-takeaways',
  standalone: true,
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="tk">
      @for (t of items(); track t.key) {
        <a class="tile" [routerLink]="r(t).path" [fragment]="r(t).frag" [style.--c]="tone(t).bar">
          <span class="top"><span class="chip sm" [class]="tone(t).chip"><app-icon [name]="t.icon" [size]="15" /></span><span class="lbl">{{ t.label }}</span></span>
          <span class="val" [title]="t.value">{{ t.value }}</span>
          <span class="note">{{ t.note }}</span>
        </a>
      }
    </section>`,
  styles: [`
    .tk { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
    .tile { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 16px 16px 15px; border-radius: 16px; overflow: hidden;
      background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); color: var(--text); text-decoration: none;
      transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; }
    .tile::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--c); }
    .tile:hover { text-decoration: none; transform: translateY(-2px); box-shadow: 0 10px 24px rgba(15, 23, 42, .08);
      border-color: color-mix(in srgb, var(--c) 30%, var(--border)); }
    .top { display: flex; align-items: center; gap: 8px; }
    .lbl { font-size: 12.5px; color: var(--muted); font-weight: 500; }
    .val { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note { font-size: 12.5px; color: var(--text-2); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    @media (max-width: 640px) {
      .tk { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; margin: 0 -16px; padding: 2px 16px 8px; gap: 10px; }
      .tk::-webkit-scrollbar { display: none; }
      .tile { flex: 0 0 236px; scroll-snap-align: start; }
    }
  `],
})
export class TakeawaysComponent {
  items = input.required<Takeaway[]>();
  tone = (t: Takeaway) => TONE[t.tone] ?? TONE.neutral;
  r = (t: Takeaway) => route(t.link);
}

/** Which holdings and asset classes made — and cost — money. */
@Component({
  selector: 'app-drivers',
  standalone: true,
  imports: [RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let a = data();
    <section class="card">
      <div class="card-head">
        <div class="row" style="gap:10px"><span class="chip green sm"><app-icon name="sparkle" [size]="15" /></span>
          <div><h2>What drove your returns</h2><span class="hint">All-time gain {{ a.total | inr: 0 : true }}, including booked profits and income</span></div></div>
        <div class="seg"><button [class.on]="mode() === 'h'" (click)="mode.set('h')">Holdings</button><button [class.on]="mode() === 's'" (click)="mode.set('s')">Asset classes</button></div>
      </div>

      <div class="split" role="img" [attr.aria-label]="'Gains ' + inrc(a.gross_gains) + ', losses ' + inrc(a.gross_losses)">
        <span class="sg" [style.flex-grow]="a.gross_gains"></span><span class="sl" [style.flex-grow]="-a.gross_losses"></span>
      </div>
      <div class="split-legend">
        <span><i class="swatch" style="background:var(--pos)"></i>{{ a.gross_gains | inrc: true }} from {{ a.winners }} winners</span>
        <span><i class="swatch" style="background:var(--neg)"></i>{{ a.gross_losses | inrc: true }} from {{ a.losers_count }} losers</span>
      </div>

      <div class="rows">
        @for (r of rows(); track r.key) {
          <a class="dr" [routerLink]="r.link">
            <span class="nm"><i class="swatch" [style.background]="r.color"></i><span>{{ r.name }}</span></span>
            <span class="dv">
              <span>@if (r.gain < 0) { <i class="l" [style.width.%]="r.w"></i> }</span>
              <span>@if (r.gain > 0) { <i class="g" [style.width.%]="r.w"></i> }</span>
            </span>
            <span class="amt" [class]="r.gain | sign">{{ r.gain | inrc: true }}</span>
          </a>
        }
      </div>
      <div class="mix">
        <span><small>Unrealised</small><b [class]="a.unrealized | sign">{{ a.unrealized | inrc: true }}</b></span>
        <span><small>Booked</small><b [class]="a.realized | sign">{{ a.realized | inrc: true }}</b></span>
        <span><small>Dividends &amp; interest</small><b [class]="a.income | sign">{{ a.income | inrc: true }}</b></span>
      </div>
    </section>`,
  styles: [DIVERGING + `
    .split { display: flex; gap: 2px; height: 10px; border-radius: 999px; overflow: hidden; background: var(--grid); }
    .sg { background: var(--pos); } .sl { background: var(--neg); opacity: .85; }
    .split-legend { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--text-2); margin: 8px 0 14px; flex-wrap: wrap; }
    .split-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .rows { display: flex; flex-direction: column; }
    .dr { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) 64px; gap: 12px; align-items: center; padding: 6px 4px; border-radius: 8px;
      color: var(--text); text-decoration: none; font-size: 13px; }
    .dr:hover { background: var(--surface-hover); text-decoration: none; }
    .nm { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .nm span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .amt { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12.5px; }
    .mix { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
    .mix span { display: flex; flex-direction: column; gap: 2px; }
    .mix small { font-size: 11.5px; color: var(--muted); }
    .mix b { font-size: 14.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
  `],
})
export class DriversComponent {
  data = input.required<Attribution>();
  mode = signal<'h' | 's'>('h');
  inrc = (v: number) => inrCompact(v);
  rows = computed(() => {
    const a = this.data();
    const raw = this.mode() === 'h'
      ? [...a.gainers, ...a.losers].sort((x, y) => y.gain - x.gain).map(c => ({
          key: 'h' + c.id, name: c.name, gain: c.gain, color: SEGMENT_COLOR[c.segment] ?? 'var(--s7)', link: `/holding/${c.id}` }))
      : a.segments.map(s => ({ key: s.segment, name: SEGMENT_META[s.segment]?.label ?? s.segment, gain: s.gain,
          color: SEGMENT_COLOR[s.segment] ?? 'var(--s7)', link: SEGMENT_META[s.segment]?.route ?? '/' }));
    const max = Math.max(...raw.map(r => Math.abs(r.gain)), 1);
    return raw.map(r => ({ ...r, w: Math.max(Math.abs(r.gain) / max * 100, 2) }));
  });
}

/** The same cash flows, had they gone into an index instead. */
@Component({
  selector: 'app-market',
  standalone: true,
  imports: [RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let m = data();
    <section class="card">
      <div class="card-head">
        <div class="row" style="gap:10px"><span class="chip indigo sm"><app-icon name="scale" [size]="15" /></span>
          <div><h2>You vs the market</h2><span class="hint">Same money, same dates{{ m.since ? ', since ' + (m.since | dt) : '' }}</span></div></div>
        <a routerLink="/analytics" class="small">Compare →</a>
      </div>
      <div class="you">
        <span class="lotus"><app-icon name="lotus" [size]="18" /></span>
        <span><small>Your portfolio today</small><b>{{ m.value | inr }}</b></span>
        <span class="x"><small>Annual return</small><b [class]="m.you | sign">{{ m.you | pct }}</b></span>
      </div>
      <p class="verdict">You're ahead of <b>{{ beaten() }} of {{ m.rows.length }}</b> alternatives.</p>
      @for (r of rows(); track r.key) {
        <div class="mr">
          <span class="lb"><b>{{ r.label }}</b><small>would be {{ r.end_value | inrc }} · {{ r.xirr | pct }} a year</small></span>
          <span class="dv">
            <span>@if (r.diff_value < 0) { <i class="l" [style.width.%]="r.w"></i> }</span>
            <span>@if (r.diff_value > 0) { <i class="g" [style.width.%]="r.w"></i> }</span>
          </span>
          <span class="amt" [class]="r.diff_value | sign">{{ r.diff_value | inrc: true }}</span>
        </div>
      }
      <p class="foot">Right of the line: you have more than that index would have given you. Left: the index would have done better.</p>
    </section>`,
  styles: [DIVERGING + `
    .you { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 12px; background: linear-gradient(120deg, #eef0ff, #f6efff); }
    .you span { display: flex; flex-direction: column; gap: 1px; }
    .you small { font-size: 11.5px; color: var(--muted); }
    .you b { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .you .x { margin-left: auto; text-align: right; }
    .lotus { width: 36px; height: 36px; border-radius: 11px; align-items: center; justify-content: center; color: #fff;
      background: linear-gradient(135deg, #f59e0b, #ec4899 55%, #8b5cf6); }
    .verdict { font-size: 13px; color: var(--text-2); margin: 14px 0 4px; }
    .mr { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.2fr) 64px; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .mr:last-of-type { border-bottom: 0; }
    .lb { display: flex; flex-direction: column; min-width: 0; }
    .lb b { font-size: 13px; font-weight: 600; }
    .lb small { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .amt { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12.5px; }
    .foot { font-size: 11.5px; color: var(--muted); margin-top: 10px; }
  `],
})
export class MarketComponent {
  data = input.required<MarketCompare>();
  beaten = computed(() => this.data().rows.filter(r => r.diff_value >= 0).length);
  rows = computed(() => {
    const rows = this.data().rows;
    const max = Math.max(...rows.map(r => Math.abs(r.diff_value)), 1);
    return rows.map(r => ({ ...r, w: Math.max(Math.abs(r.diff_value) / max * 100, 2) }));
  });
}

/** A diya for every month money went in, and the net new money per month. */
@Component({
  selector: 'app-rhythm',
  standalone: true,
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let r = data();
    <section class="card">
      <div class="card-head">
        <div class="row" style="gap:10px"><span class="chip amber sm"><app-icon name="diya" [size]="15" /></span>
          <div><h2>Investing rhythm</h2><span class="hint">One diya lit for every month you invested · last 12 months</span></div></div>
      </div>
      <div class="lamps">
        @for (m of months(); track m.month) {
          <span class="lamp" [class.lit]="m.invested > 0" [title]="m.label + ': ' + (m.invested > 0 ? 'invested ' + inrc(m.invested) : 'no purchases')">
            <app-icon name="diya" [size]="20" /><small>{{ m.short }}</small>
          </span>
        }
      </div>
      <div class="bars" role="img" aria-label="Net new money per month">
        @for (m of months(); track m.month) {
          <span class="col" [title]="m.label + ': net ' + inrc(m.net) + ' (in ' + inrc(m.invested) + ', out ' + inrc(m.withdrawn) + ')'">
            <span class="up">@if (m.net > 0) { <i class="p" [style.height.%]="m.h"></i> }</span>
            <span class="dn">@if (m.net < 0) { <i class="n" [style.height.%]="m.h"></i> }</span>
          </span>
        }
      </div>
      <div class="legend" style="margin-top:8px"><span><i class="swatch" style="background:var(--primary)"></i>Net money added</span><span><i class="swatch" style="background:var(--neg)"></i>Net money taken out</span></div>
      <div class="stats">
        <span><small>Months invested</small><b>{{ r.active_months }} / 12</b></span>
        <span><small>Fresh money, net</small><b>{{ r.net | inrc }}</b></span>
        <span><small>Typical month lately</small><b>{{ r.pace | inrc }}</b></span>
      </div>
    </section>`,
  styles: [`
    .lamps { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 4px; margin-bottom: 14px; }
    .lamp { display: flex; flex-direction: column; align-items: center; gap: 3px; color: #cbd2e1; }
    .lamp small { font-size: 10.5px; color: var(--muted); }
    .lamp.lit { color: #ea8a0c; filter: drop-shadow(0 0 6px rgba(251, 191, 36, .75)); }
    .lamp.lit small { color: #b45309; font-weight: 600; }
    .bars { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 6px; height: 110px; }
    .col { display: grid; grid-template-rows: 3fr 1fr; }
    .up { display: flex; align-items: flex-end; justify-content: center; border-bottom: 1.5px solid var(--axis); }
    .dn { display: flex; align-items: flex-start; justify-content: center; }
    .col i { display: block; width: 70%; max-width: 22px; min-height: 2px; }
    .p { background: var(--primary); border-radius: 4px 4px 0 0; }
    .n { background: var(--neg); border-radius: 0 0 4px 4px; opacity: .8; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
    .stats span { display: flex; flex-direction: column; gap: 2px; }
    .stats small { font-size: 11.5px; color: var(--muted); }
    .stats b { font-size: 14.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
  `],
})
export class RhythmComponent {
  data = input.required<Rhythm>();
  inrc = (v: number) => inrCompact(v);
  months = computed(() => {
    const ms = this.data().months;
    const up = Math.max(...ms.map(m => m.net), 1);
    const dn = Math.max(...ms.map(m => -m.net), 1);
    return ms.map(m => {
      const d = new Date(m.month + '-01T00:00:00');
      return { ...m, short: d.toLocaleDateString('en-IN', { month: 'narrow' }),
        label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
        // positives use the tall upper band; negatives the short lower band, each scaled to its own extreme
        h: m.net > 0 ? Math.max(m.net / up * 100, 3) : Math.max(-m.net / dn * 100, 6) };
    });
  });
}

const LADDER_ICON = (amount: number) => amount >= 1e7 ? 'lotus' : 'target';

/** Lakh and crore milestones, with a what-if for the monthly amount. */
@Component({
  selector: 'app-milestones',
  standalone: true,
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let m = data();
    <section class="card">
      <div class="card-head">
        <div class="row" style="gap:10px"><span class="chip violet sm"><app-icon name="lotus" [size]="15" /></span>
          <div><h2>Road to ₹1 crore</h2><span class="hint">Your next lakh and crore milestones</span></div></div>
      </div>
      @if (next(); as n) {
        <div class="prog">
          <div class="pl"><span>{{ m.last_reached?.label ?? '₹0' }}</span><b>{{ m.progress | pct: 0 : false }} of the way to {{ n.label }}</b><span>{{ n.label }}</span></div>
          <div class="track"><span [style.width.%]="m.progress"></span></div>
        </div>
      }
      <label class="sip">
        <span>Add every month <b>{{ monthly() | inr }}</b></span>
        <input type="range" min="0" max="100000" step="1000" [value]="monthly()" (input)="monthly.set(+$any($event.target).value)" aria-label="Monthly investment" />
      </label>
      <ol class="ladder">
        @for (r of ladder(); track r.amount) {
          <li [class.crore]="r.amount >= 10000000">
            <span class="dot"><app-icon [name]="icon(r.amount)" [size]="13" /></span>
            <span class="lab">{{ r.label }} @if (r.amount >= 10000000) { <em>Crorepati</em> }</span>
            <span class="when">@if (r.months !== null) { {{ r.when }} <small>in {{ r.in }}</small> } @else { <small>beyond 50 years</small> }</span>
          </li>
        }
      </ol>
      <p class="foot">Assumes {{ m.assumed_return }}% a year — the planning return for your current mix. Markets don't move in straight lines; treat dates as a guide.</p>
    </section>`,
  styles: [`
    .prog { margin-bottom: 16px; }
    .pl { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }
    .pl b { font-size: 12.5px; color: var(--text); font-weight: 600; }
    .track { height: 10px; border-radius: 999px; background: var(--grid); overflow: hidden; }
    .track span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #f59e0b, #ec4899 60%, #8b5cf6); }
    .sip { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 12px; background: var(--surface-2); font-size: 12.5px; color: var(--text-2); }
    .sip b { color: var(--text); font-size: 14px; }
    .sip input { width: 100%; accent-color: var(--primary); }
    .ladder { list-style: none; margin: 14px 0 0; padding: 0; position: relative; }
    .ladder::before { content: ''; position: absolute; left: 13px; top: 14px; bottom: 14px; width: 2px; background: linear-gradient(#c7cbff, #f5c2e0); }
    .ladder li { position: relative; display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: center; padding: 7px 0; }
    .dot { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: #eef0ff; color: #4f46e5; border: 2px solid var(--surface); }
    .lab { font-weight: 600; font-size: 13.5px; }
    .lab em { font-style: normal; font-size: 11px; font-weight: 600; margin-left: 6px; padding: 2px 8px; border-radius: 999px; background: #fff1e0; color: #c2410c; }
    .when { text-align: right; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; display: flex; flex-direction: column; }
    .when small { font-size: 11.5px; color: var(--muted); font-weight: 500; }
    .crore .dot { background: linear-gradient(135deg, #f59e0b, #ec4899 55%, #8b5cf6); color: #fff; }
    .foot { font-size: 11.5px; color: var(--muted); margin-top: 10px; }
  `],
})
export class MilestonesComponent {
  data = input.required<Milestones>();
  monthly = linkedSignal(() => Math.round(this.data().monthly / 1000) * 1000);
  icon = LADDER_ICON;
  next = computed(() => this.data().ahead[0] ?? null);
  ladder = computed(() => {
    const m = this.data(), pmt = this.monthly();
    const rm = Math.pow(1 + m.assumed_return / 100, 1 / 12) - 1;
    const now = new Date();
    return m.ahead.map(a => {
      let v = m.value, n = 0;
      while (v < a.amount && n < 600) { v = v * (1 + rm) + pmt; n++; }
      if (v < a.amount) return { amount: a.amount, label: a.label, months: null, when: null, in: null };
      const d = new Date(now.getFullYear(), now.getMonth() + n, 1);
      const y = Math.floor(n / 12), mo = n % 12;
      const span = [y ? `${y} yr${y > 1 ? 's' : ''}` : '', mo ? `${mo} mo` : ''].filter(Boolean).join(' ') || 'this month';
      return { amount: a.amount, label: a.label, months: n, when: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }), in: span };
    });
  });
}
