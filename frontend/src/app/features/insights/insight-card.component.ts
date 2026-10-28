import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Insight } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

const SEV = {
  critical: { icon: 'alert', label: 'Critical', color: 'var(--status-critical)' },
  warning: { icon: 'alert', label: 'Attention', color: 'var(--status-warning)' },
  info: { icon: 'info', label: 'Suggestion', color: 'var(--accent)' },
  positive: { icon: 'checkCircle', label: 'Going well', color: 'var(--status-good)' },
};

@Component({
  selector: 'app-insight-card',
  standalone: true,
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="ins" [style.--sev]="sev().color">
      <div class="top">
        <span class="sev"><app-icon [name]="sev().icon" [size]="15" /> {{ sev().label }}</span>
        <span class="cat">{{ insight().category }}</span>
        @if (dismissable()) {
          <button class="btn ghost icon sm" (click)="dismiss.emit(insight().id)" title="Hide for 30 days" aria-label="Hide for 30 days"><app-icon name="close" [size]="14" /></button>
        }
      </div>
      <h3>{{ insight().title }}</h3>
      <p class="text-2 small">{{ insight().detail }}</p>
      @if (!compact() && insight().action) { <p class="small act"><b>Suggested:</b> {{ insight().action }}</p> }
      @if (insight().link) { <a [routerLink]="path()" [fragment]="fragment()" class="small">Open →</a> }
    </article>`,
  styles: [`
    .ins { border: 1px solid var(--border); border-left: 3px solid var(--sev); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; background: var(--surface); height: 100%; }
    .top { display: flex; align-items: center; gap: 8px; }
    .sev { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; color: var(--text-2); }
    .sev app-icon { color: var(--sev); }
    .cat { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); flex: 1; }
    .act { color: var(--text); }
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
