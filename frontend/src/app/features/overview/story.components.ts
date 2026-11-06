import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Takeaway } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

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
    .tile { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 16px 16px 15px; border-radius: 12px; overflow: hidden;
      background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); color: var(--text); text-decoration: none;
      transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; }
    .tile:hover { text-decoration: none; border-color: var(--border-strong); box-shadow: var(--shadow-md); }
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
