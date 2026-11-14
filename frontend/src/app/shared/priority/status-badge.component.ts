import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Status } from '../../core/models';
import { IconComponent } from '../icon.component';
import { STATUS_META } from './priority';

/** `.status` pill: always an icon and a word, never colour alone (Part 1 §1.8). */
@Component({
  selector: 'app-status',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="status" [attr.data-status]="status()"><app-icon [name]="meta().icon" [size]="13" />{{ label() }}</span>`,
  styles: [':host{display:inline-flex}'],
})
export class StatusBadgeComponent {
  status = input.required<Status>();
  /** Overrides the default word ("Healthy" instead of "On track"); the icon stays. */
  word = input<string | null>(null);
  meta = computed(() => STATUS_META[this.status()] ?? STATUS_META.info);
  label = computed(() => this.word() || this.meta().word);
}
