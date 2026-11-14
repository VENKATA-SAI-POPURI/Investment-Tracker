import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { Status } from '../../core/models';
import { IconComponent } from '../icon.component';
import { StatusBadgeComponent } from './status-badge.component';

export interface VerdictCta { label: string; link?: string | null; primary?: boolean; }

/**
 * `.verdict` T1 card: status stripe, badge top-right, a big number, one sentence and a CTA row.
 * Extra body (a sparkline, rows) goes in as content.
 */
@Component({
  selector: 'app-verdict',
  standalone: true,
  imports: [IconComponent, StatusBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card verdict" [attr.data-status]="status()" [attr.aria-label]="title()">
      <header class="v-head">
        <h2>{{ title() }}</h2>
        <app-status [status]="status()" [word]="word()" />
      </header>
      @if (big()) { <div class="v-big">{{ big() }}</div> }
      @if (sentence()) { <p class="v-sentence">{{ sentence() }}</p> }
      <ng-content />
      @if (cta(); as c) {
        <div class="v-cta">
          @if (c.link) {
            <a class="btn sm" [class.primary]="c.primary" [attr.href]="c.link" (click)="go($event, c)">{{ c.label }} <app-icon name="chevronRight" [size]="14" /></a>
          } @else {
            <button type="button" class="btn sm" [class.primary]="c.primary" (click)="act.emit()">{{ c.label }}</button>
          }
        </div>
      }
    </section>`,
  styles: [':host{display:block;min-width:0}'],
})
export class VerdictCardComponent {
  private router = inject(Router);
  status = input.required<Status>();
  title = input.required<string>();
  big = input<string | null>(null);
  sentence = input<string | null>(null);
  cta = input<VerdictCta | null>(null);
  /** Overrides the badge word. */
  word = input<string | null>(null);
  /** Fired by a CTA without a link. */
  act = output<void>();

  go(e: MouseEvent, c: VerdictCta) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;  // let the browser open a new tab
    e.preventDefault();
    this.act.emit();
    if (c.link) void this.router.navigateByUrl(c.link);
  }
}
