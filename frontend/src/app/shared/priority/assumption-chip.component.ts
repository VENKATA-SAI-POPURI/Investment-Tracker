import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChipBlock } from '../../core/models';
import { IconComponent } from '../icon.component';
import { AssumptionsDrawerComponent } from './assumptions-drawer.component';

/** "11.0% avg · 9.6% typical · ±12.4% · 6% inflation" from the numbers, when a payload sends no `text`. */
export function chipText(b: ChipBlock): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
  const parts = [`${f(b.return_pct)}% avg`];
  if (b.typical_pct !== undefined && b.typical_pct !== null) parts.push(`${f(b.typical_pct)}% typical`);
  parts.push(`±${f(b.volatility_pct)}%`, `${+b.inflation_pct.toFixed(2)}% inflation`);
  return parts.join(' · ');
}

/**
 * The assumption chip (Part 1 §1.9, Part 2 §9.2/§9.3, AMENDMENTS H17): `<app-assumption-chip [block]>`.
 *
 * Every forward-looking card carries one. It shows `block.text` (or `chip`, or a text composed from the numbers);
 * its title names the basis and the Book `#hash`. It is a button with an info icon and words, never colour alone.
 * Clicking it opens the Assumptions drawer, which this chip renders and which fetches GET /assumptions.
 * Renders nothing when the block is missing.
 */
@Component({
  selector: 'app-assumption-chip',
  standalone: true,
  imports: [IconComponent, AssumptionsDrawerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:contents' },
  template: `
    @if (block(); as b) {
      <button type="button" class="assumption-chip" [attr.title]="title()" aria-haspopup="dialog" [attr.aria-expanded]="open()"
        [attr.aria-label]="'Assumptions: ' + text() + '. Open the assumptions'" (click)="open.set(true)">
        <app-icon name="info" [size]="13" /><span class="ac-text">{{ text() }}</span>
      </button>
      @if (open()) { <app-assumptions-drawer [block]="b" (closed)="open.set(false)" /> }
    }`,
  styles: [`.ac-text { overflow: hidden; text-overflow: ellipsis; min-width: 0; }`],
})
export class AssumptionChipComponent {
  readonly block = input<ChipBlock | null | undefined>(null);
  readonly open = signal(false);

  readonly text = computed(() => {
    const b = this.block();
    if (!b) return '';
    return b.text || b.chip || chipText(b);
  });
  readonly title = computed(() => {
    const b = this.block();
    if (!b) return '';
    const basis = b.basis ? `${b.basis} · ` : '';
    return `${basis}Long-run assumptions, not predictions · Book #${b.hash} · click for details`;
  });
}
