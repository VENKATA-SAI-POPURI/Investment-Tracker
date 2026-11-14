import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { Vital } from '../../core/models';
import { IconComponent } from '../icon.component';
import { STATUS_META } from './priority';

/**
 * `.vital` chip, one of the five checks. Good is compact (icon, label, value); watch, act and unset are wide
 * and add the note and "Fix →". Unset draws a dashed border.
 */
@Component({
  selector: 'app-vital',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let v = vital();
    <a class="vital" [class.wide]="wide()" [attr.data-status]="v.status" [attr.href]="v.link" (click)="go($event)"
      [attr.aria-label]="v.label + ': ' + meta().word + ', ' + v.value">
      <span class="v-ic"><app-icon [name]="meta().icon" [size]="15" /></span>
      <span class="v-main">
        <span class="v-top"><b class="v-label">{{ v.label }}</b><span class="v-word">{{ meta().word }}</span></span>
        <span class="v-value">{{ v.value }}</span>
        @if (wide() && v.note) { <span class="v-note">{{ v.note }}</span> }
      </span>
      @if (wide()) { <span class="v-fix">Fix <app-icon name="chevronRight" [size]="13" /></span> }
    </a>`,
  styles: [':host{display:contents}'],
})
export class VitalChipComponent {
  private router = inject(Router);
  vital = input.required<Vital>();
  meta = computed(() => STATUS_META[this.vital().status] ?? STATUS_META.info);
  wide = computed(() => this.vital().status !== 'good' && this.vital().status !== 'info');

  go(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const link = this.vital().link;
    if (link) void this.router.navigateByUrl(link);
  }
}
