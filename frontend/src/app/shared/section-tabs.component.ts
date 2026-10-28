import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { inrCompact } from '../core/format';
import { CLASS_COLOR, AssetClass } from '../core/models';
import { StoreService } from '../core/store.service';

const GROUPS: Record<string, { path: string; label: string; classes?: string[] }[]> = {
  holdings: [
    { path: '/holdings/equity', label: 'Stocks', classes: ['equity'] },
    { path: '/holdings/mutual_fund', label: 'Mutual funds', classes: ['mutual_fund'] },
    { path: '/holdings/commodity', label: 'Gold & silver', classes: ['commodity'] },
    { path: '/p2p', label: 'P2P', classes: ['p2p'] },
    { path: '/fixed-deposits', label: 'FDs', classes: ['fixed_deposit'] },
    { path: '/forex', label: 'USD wallet', classes: ['cash'] },
  ],
  activity: [
    { path: '/transactions', label: 'Transactions' },
    { path: '/cash-flows', label: 'Cash flows' },
  ],
};

/** Second-level navigation shared by the Holdings and Activity pages. */
@Component({
  selector: 'app-section-tabs',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="tabs" aria-label="Section">
      @for (t of tabs(); track t.path) {
        <a [routerLink]="t.path" [class.on]="t.path === current()" [style.--tab-c]="t.color">@if (t.color) { <i class="dot" [style.background]="t.color"></i> }{{ t.label }}@if (t.value) { <span class="v">{{ t.value }}</span> }</a>
      }
    </nav>`,
  styles: [`.v { margin-left: 6px; color: var(--muted); font-weight: 400; font-size: 12.5px; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }`],
})
export class SectionTabsComponent {
  group = input.required<'holdings' | 'activity'>();
  current = input.required<string>();
  private store = inject(StoreService);

  tabs = computed(() => {
    const pos = this.store.positions();
    return GROUPS[this.group()].map(t => {
      const color = t.classes ? CLASS_COLOR[t.classes[0] as AssetClass] : '';
      if (!t.classes) return { ...t, value: '', color };
      const v = pos.filter(p => t.classes!.includes(p.asset_class) && p.is_open).reduce((a, p) => a + p.value, 0);
      return { ...t, value: v > 0 ? inrCompact(v) : '', color };
    });
  });
}
