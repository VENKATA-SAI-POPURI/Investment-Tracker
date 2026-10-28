import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CalendarEvent, Health } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';
import { MandalaComponent, ToranComponent } from '../../shared/motifs';

const KIND = {
  festival: { icon: 'diya', bg: '#fff1e0', fg: '#c2410c', label: 'Festival' },
  national: { icon: 'flag', bg: '#e7f8f1', fg: '#15803d', label: 'National' },
  tax: { icon: 'receipt', bg: '#eef0ff', fg: '#4338ca', label: 'Tax' },
  fy: { icon: 'calendar', bg: '#f3ecff', fg: '#7c3aed', label: 'Financial year' },
  personal: { icon: 'target', bg: '#e8f1fc', fg: '#2563c9', label: 'Your portfolio' },
};

function split(link: string | null) {
  const [path, frag] = (link ?? '/').split('#');
  return { path, frag: frag || undefined };
}

/** Warm festive banner for the next festival with an investing angle. */
@Component({
  selector: 'app-festival-strip',
  standalone: true,
  imports: [RouterLink, IconComponent, MandalaComponent, ToranComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="fest" [class.lit]="festive()">
      @if (festive()) { <app-toran class="toran" /> }
      <app-mandala class="mandala" [size]="220" />
      <span class="diya"><app-icon name="diya" [size]="22" /></span>
      <div class="body">
        <div class="kicker">{{ festive() ? greeting() : 'Coming up' }}</div>
        <div class="title">{{ event().title }} <span class="when">· {{ when() }}</span></div>
        <p class="note">{{ event().note }}</p>
      </div>
      @if (event().link) { <a class="cta" [routerLink]="link().path" [fragment]="link().frag">Plan it <app-icon name="chevronRight" [size]="14" /></a> }
    </section>`,
  styles: [`
    .fest { position: relative; overflow: hidden; display: flex; align-items: center; gap: 16px; padding: 18px 22px; border-radius: 18px; color: #fff;
      background: linear-gradient(110deg, #9a3412 0%, #c2410c 30%, #be185d 70%, #6d28d9 100%); box-shadow: 0 14px 34px rgba(194, 65, 12, .25); }
    .fest.lit { padding-top: 34px; }
    .toran { position: absolute; top: 0; left: 0; right: 0; }
    .mandala { position: absolute; right: -40px; top: 50%; transform: translateY(-50%); color: rgba(255, 255, 255, .16); }
    .diya { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 46px; height: 46px; border-radius: 14px;
      background: rgba(255, 255, 255, .16); color: #fde68a; box-shadow: 0 0 24px rgba(253, 230, 138, .45); position: relative; }
    .body { flex: 1; min-width: 0; position: relative; }
    .kicker { font-size: 11.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #fde68a; }
    .title { font-size: 17px; font-weight: 650; margin-top: 2px; }
    .when { font-weight: 500; color: rgba(255, 255, 255, .8); font-size: 14px; }
    .note { font-size: 13px; color: rgba(255, 255, 255, .88); margin-top: 3px; max-width: 760px; }
    .cta { position: relative; flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 8px 14px; border-radius: 10px;
      background: #fff; color: #9a3412; font-weight: 600; font-size: 13px; text-decoration: none; }
    .cta:hover { text-decoration: none; background: #fff7ed; }
    @media (max-width: 640px) { .fest { flex-wrap: wrap; align-items: flex-start; } .body { flex: 1 1 calc(100% - 62px); } .cta { margin-left: 62px; } }
  `],
})
export class FestivalStripComponent {
  event = input.required<CalendarEvent>();
  theme = input<string | null>(null);
  festive = computed(() => this.theme() === 'diwali' || this.theme() === 'akshaya_tritiya');
  greeting = computed(() => this.theme() === 'diwali' ? 'Shubh Deepavali' : 'Shubh Akshaya Tritiya');
  link = computed(() => split(this.event().link));
  when = computed(() => {
    const d = new Date(this.event().date + 'T00:00:00');
    const day = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    const n = this.event().days;
    return n === 0 ? `today, ${day}` : n === 1 ? `tomorrow, ${day}` : `${day}, in ${n} days`;
  });
}

/** Semicircle gauge + component bars for the portfolio health score. */
@Component({
  selector: 'app-health-card',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card health">
      <div class="card-head"><div class="row" style="gap:10px"><span class="chip violet sm"><app-icon name="heart" [size]="15" /></span><h2>Portfolio health</h2></div></div>
      <div class="gauge">
        <svg viewBox="-100 -100 200 112" width="220" height="124" role="img" [attr.aria-label]="'Health score ' + health().score + ' out of 100'">
          <defs><linearGradient id="hg" x1="0" x2="1"><stop offset="0" stop-color="#6366f1" /><stop offset="1" stop-color="#a855f7" /></linearGradient></defs>
          <path d="M -80 0 A 80 80 0 0 1 80 0" stroke="#eef1f8" stroke-width="14" fill="none" stroke-linecap="round" />
          <path d="M -80 0 A 80 80 0 0 1 80 0" stroke="url(#hg)" stroke-width="14" fill="none" stroke-linecap="round"
                pathLength="100" [attr.stroke-dasharray]="health().score + ' 100'" />
          <text x="0" y="-12" text-anchor="middle" class="score">{{ health().score }}</text>
          <text x="0" y="8" text-anchor="middle" class="of">out of 100</text>
        </svg>
        <span class="grade" [class]="gradeClass()">{{ health().grade }}</span>
      </div>
      <div class="parts">
        @for (c of health().components; track c.key) {
          <div class="part" [title]="c.note">
            <span class="pl">{{ c.label }}</span>
            <span class="pb"><span [style.width.%]="c.score" [class.low]="c.score < 55"></span></span>
            <span class="ps">{{ c.score }}</span>
          </div>
        }
      </div>
      <div class="focus"><b>Improve next:</b> {{ health().focus.label }} — {{ health().focus.note }}</div>
    </section>`,
  styles: [`
    .gauge { display: flex; flex-direction: column; align-items: center; margin-top: -6px; }
    .score { font-size: 38px; font-weight: 700; fill: var(--text); letter-spacing: -1px; }
    .of { font-size: 11px; fill: var(--muted); }
    .grade { margin-top: 2px; padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #eef0ff; color: #4338ca; }
    .grade.great { background: #e7f8f1; color: #047857; }
    .grade.fair { background: #fff4e0; color: #b45309; }
    .parts { display: grid; gap: 9px; margin-top: 18px; }
    .part { display: grid; grid-template-columns: 110px 1fr 28px; gap: 10px; align-items: center; font-size: 12.5px; }
    .pl { color: var(--text-2); }
    .pb { height: 6px; background: #eef1f8; border-radius: 999px; overflow: hidden; }
    .pb > span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #6366f1, #a855f7); }
    .pb > span.low { background: linear-gradient(90deg, #f59e0b, #f97316); }
    .ps { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
    .focus { margin-top: 16px; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font-size: 12.5px; color: var(--text-2); }
  `],
})
export class HealthCardComponent {
  health = input.required<Health>();
  gradeClass = computed(() => this.health().score >= 85 ? 'great' : this.health().score >= 70 ? '' : 'fair');
}

/** Upcoming festivals, tax dates and personal milestones. */
@Component({
  selector: 'app-money-calendar',
  standalone: true,
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <div class="card-head"><div class="row" style="gap:10px"><span class="chip amber sm"><app-icon name="calendar" [size]="15" /></span><h2>Money calendar</h2></div>
        <span class="hint">Next {{ events().length ? '75 days' : '' }}</span></div>
      @for (e of events().slice(0, 6); track e.key) {
        <a class="ev" [routerLink]="split(e.link).path" [fragment]="split(e.link).frag">
          <span class="date" [style.background]="kind(e).bg" [style.color]="kind(e).fg">
            <b>{{ day(e) }}</b><small>{{ month(e) }}</small>
          </span>
          <span class="txt">
            <span class="t"><app-icon [name]="kind(e).icon" [size]="13" /> {{ e.title }}</span>
            <span class="n">{{ e.note }}</span>
          </span>
          <span class="in">{{ e.days === 0 ? 'Today' : e.days + 'd' }}</span>
        </a>
      } @empty { <p class="muted small">Nothing in the next few weeks.</p> }
    </section>`,
  styles: [`
    .ev { display: flex; gap: 14px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); color: var(--text); text-decoration: none; }
    .ev:last-child { border-bottom: 0; }
    .ev:hover { text-decoration: none; }
    .ev:hover .t { color: var(--primary); }
    .date { flex: none; width: 46px; height: 50px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.1; }
    .date b { font-size: 18px; font-weight: 700; }
    .date small { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .t { font-weight: 600; font-size: 13.5px; display: inline-flex; align-items: center; gap: 6px; }
    .n { font-size: 12.5px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .in { flex: none; font-size: 11.5px; font-weight: 600; color: var(--muted); background: var(--surface-2); padding: 2px 8px; border-radius: 999px; }
  `],
})
export class MoneyCalendarComponent {
  events = input.required<CalendarEvent[]>();
  kind = (e: CalendarEvent) => KIND[e.kind] ?? KIND.personal;
  day = (e: CalendarEvent) => +e.date.slice(8, 10);
  month = (e: CalendarEvent) => new Date(e.date + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short' });
  split = split;
}
