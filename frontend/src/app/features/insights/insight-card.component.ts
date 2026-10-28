import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Insight } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

const SEV = {
  critical: { icon: 'alert', label: 'Needs attention', tone: 'warn' },
  warning: { icon: 'alert', label: 'Needs attention', tone: 'warn' },
  info: { icon: 'info', label: 'Suggestion', tone: 'info' },
  positive: { icon: 'checkCircle', label: 'Going well', tone: 'good' },
};

/** One insight as a list row: icon · title, detail, suggestion · open / hide. */
@Component({
  selector: 'app-insight-card',
  standalone: true,
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="ins">
      <span class="ic" [class]="sev().tone" [title]="sev().label"><app-icon [name]="sev().icon" [size]="17" /></span>
      <div class="body">
        <div class="t">{{ insight().title }}</div>
        <div class="d">{{ insight().detail }}</div>
        @if (!compact() && insight().action) { <div class="a">{{ insight().action }}</div> }
      </div>
      <div class="acts">
        @if (insight().link) { <a [routerLink]="path()" [fragment]="fragment()" class="btn ghost sm">Open</a> }
        @if (dismissable()) {
          <button class="btn ghost icon sm" (click)="dismiss.emit(insight().id)" title="Hide for 30 days" aria-label="Hide for 30 days"><app-icon name="close" [size]="14" /></button>
        }
      </div>
    </article>`,
  styles: [`
    .ins { display: flex; gap: 14px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid var(--border); }
    :host(:last-child) .ins { border-bottom: 0; }
    .ic { flex: none; margin-top: 1px; }
    .ic.warn { color: var(--warn); }
    .ic.info { color: var(--accent); }
    .ic.good { color: var(--pos); }
    .body { flex: 1; min-width: 0; }
    .t { font-weight: 500; font-size: 13.5px; }
    .d { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
    .a { color: var(--text-2); font-size: 12.5px; margin-top: 4px; }
    .acts { display: flex; gap: 2px; flex: none; }
  `],
})
export class InsightCardComponent {
  insight = input.required<Insight>();
  compact = input(false);
  dismissable = input(false);
  dismiss = output<string>();
  sev = computed(() => SEV[this.insight().severity]);
  path = computed(() => (this.insight().link ?? '/').split('#')[0].replace(/^\/holdings\/(\d+)$/, '/holding/$1'));
  fragment = computed(() => (this.insight().link ?? '').split('#')[1] || undefined);
}
