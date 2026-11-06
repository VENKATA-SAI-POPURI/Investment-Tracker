import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CalendarEvent } from '../../core/models';
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
    :host { display: flex; flex-direction: column; }
    :host > .card { flex: 1; }
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
