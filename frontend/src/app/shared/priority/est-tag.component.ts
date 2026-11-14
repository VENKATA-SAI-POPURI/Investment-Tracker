import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** `.est` tag on any forward-looking ₹: the tooltip names its basis (Part 1 §1.9). */
@Component({
  selector: 'app-est',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="est" tabindex="0" [attr.title]="tip()" [attr.aria-label]="'estimate: ' + tip()">est.</span>`,
  styles: [':host{display:inline}'],
})
export class EstTagComponent {
  basis = input<string | null>(null);
  tip = computed(() => this.basis() || 'An estimate from the assumptions in your plan, not a promise');
}
