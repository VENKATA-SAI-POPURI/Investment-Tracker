import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ActionService } from '../../core/action.service';
import { Action } from '../../core/models';
import { ActionCardComponent, LocalRun } from './action-card.component';

/**
 * T1 "Needs attention here" strip under a page's hero: up to two compact action cards whose evidence page
 * (`link`) sits under one of `prefixes` (A7, A27). Renders nothing when there are none.
 */
@Component({
  selector: 'app-needs-attention',
  standalone: true,
  imports: [ActionCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items().length) {
      <section class="needs-attention" aria-label="Needs attention here">
        @for (a of items(); track a.id; let first = $first) {
          <app-action-card [action]="a" [compact]="true" [primary]="first" [localRun]="localRun()" />
        }
      </section>
    }`,
  styles: [':host{display:block}:host:empty{display:none}'],
})
export class NeedsAttentionComponent {
  private actions = inject(ActionService);
  /** Link prefixes, e.g. ['/p2p'] or ['/cash-flows', '/fixed-deposits']. */
  prefixes = input.required<string[]>();
  /** Optional id prefixes to narrow further, e.g. ['fd:', 'cash:']. */
  ids = input<string[] | null>(null);
  max = input(2);
  tiers = input<Action['tier'][]>(['now', 'month']);
  /** The page's in-place handler for actions it can carry out itself (passed to each card). */
  localRun = input<LocalRun | null>(null);

  items = computed(() => {
    const ids = this.ids();
    return this.actions.forLinks(this.prefixes(), this.tiers())
      .filter(a => !ids || ids.some(p => a.id.startsWith(p)))
      .slice(0, Math.max(0, this.max()));
  });
}
