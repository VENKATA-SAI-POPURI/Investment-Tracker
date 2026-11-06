import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CalendarEvent, Health } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

const KIND = {
  festival: { icon: 'diya', bg: 'var(--gold-soft)', fg: 'var(--gold)', label: 'Festival' },
  national: { icon: 'flag', bg: 'var(--surface-2)', fg: '#15803d', label: 'National' },
  tax: { icon: 'receipt', bg: 'var(--surface-2)', fg: 'var(--primary)', label: 'Tax' },
  fy: { icon: 'calendar', bg: 'var(--surface-2)', fg: 'var(--primary)', label: 'Financial year' },
  personal: { icon: 'target', bg: 'var(--surface-2)', fg: '#2563c9', label: 'Your portfolio' },
};

function split(link: string | null) {
  const [path, frag] = (link ?? '/').split('#');
  return { path, frag: frag || undefined };
}

/** Semicircle gauge + component bars for the portfolio health score. */
@Component({
  selector: 'app-health-card',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card health fill">
      <div class="card-head"><div class="row" style="gap:10px"><span class="chip violet sm"><app-icon name="heart" [size]="15" /></span><h2>Portfolio health</h2></div></div>
      <div class="gauge">
        <svg viewBox="-100 -100 200 112" width="220" height="124" role="img" [attr.aria-label]="'Health score ' + health().score + ' out of 100'">
          
          <path d="M -80 0 A 80 80 0 0 1 80 0" stroke="var(--grid)" stroke-width="14" fill="none" stroke-linecap="round" />
          <path d="M -80 0 A 80 80 0 0 1 80 0" stroke="var(--primary)" stroke-width="14" fill="none" stroke-linecap="round"
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
      <div class="focus push"><b>Improve next:</b> {{ health().focus.label }} — {{ health().focus.note }}</div>
    </section>`,
  styles: [`
    :host { display: block; }
    .gauge { display: flex; flex-direction: column; align-items: center; margin-top: -6px; }
    .score { font-size: 38px; font-weight: 700; fill: var(--text); letter-spacing: -1px; }
    .of { font-size: 11px; fill: var(--muted); }
    .grade { margin-top: 2px; padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--accent-soft); color: var(--primary); }
    .grade.great { background: var(--pos-soft); color: var(--pos); }
    .grade.fair { background: var(--warn-soft); color: var(--warn); }
    .parts { display: grid; gap: 9px; margin-top: 18px; }
    .part { display: grid; grid-template-columns: 110px 1fr 28px; gap: 10px; align-items: center; font-size: 12.5px; }
    .pl { color: var(--text-2); }
    .pb { height: 6px; background: var(--grid); border-radius: 999px; overflow: hidden; }
    .pb > span { display: block; height: 100%; border-radius: 999px; background: var(--primary); }
    .pb > span.low { background: var(--gold-2); }
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
    <section class="card fill">
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
    :host { display: block; }
    .ev { display: flex; gap: 14px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); color: var(--text); text-decoration: none; }
    .ev:last-child { border-bottom: 0; }
    .ev:hover { text-decoration: none; }
    .ev:hover .t { color: var(--primary); }
    .date { flex: none; width: 46px; height: 50px; border-radius: 10px; border: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.1; }
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
