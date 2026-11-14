import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { inrCompact } from '../core/format';
import { AuthService } from '../core/auth.service';
import { CLASS_COLOR, AssetClass } from '../core/models';
import { StoreService } from '../core/store.service';

type SectionTab = { path: string; label: string; classes?: string[]; write?: boolean };

const GROUPS: Record<string, SectionTab[]> = {
  holdings: [
    { path: '/holdings/equity', label: 'Stocks', classes: ['equity'] },
    { path: '/holdings/mutual_fund', label: 'Mutual funds', classes: ['mutual_fund'] },
    { path: '/holdings/commodity', label: 'Gold & silver', classes: ['commodity'] },
    { path: '/p2p', label: 'P2P', classes: ['p2p'] },
    { path: '/fixed-deposits', label: 'FDs', classes: ['fixed_deposit'] },
    { path: '/forex', label: 'USD wallet', classes: ['cash'] },
    { path: '/epf', label: 'EPF', classes: ['epf'] },
    { path: '/nps', label: 'NPS', classes: ['nps'] },
  ],
  // SPEC §3.3: Transactions | Cash flows | Recurring plans | Import (Import needs write access, so guests don't see it)
  activity: [
    { path: '/transactions', label: 'Transactions' },
    { path: '/cash-flows', label: 'Cash flows' },
    { path: '/recurring', label: 'Recurring plans' },
    { path: '/import', label: 'Import', write: true },
  ],
};

/**
 * Second-level navigation for the Activity pages (and, until the wave-4 class pages move to
 * `<app-portfolio-tabs />`, the Holdings class pages). Holdings tabs show only classes you hold.
 */
@Component({
  selector: 'app-section-tabs',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="tabs" aria-label="Section">
      @for (t of tabs(); track t.path) {
        <a [routerLink]="t.path" [class.on]="t.path === current()" [attr.aria-current]="t.path === current() ? 'page' : null" [style.--tab-c]="t.color">@if (t.color) { <i class="dot" [style.background]="t.color"></i> }{{ t.label }}@if (t.value) { <span class="v">{{ t.value }}</span> }</a>
      }
    </nav>`,
  styles: [`.v { margin-left: 6px; color: var(--muted); font-weight: 400; font-size: 12.5px; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }`],
})
export class SectionTabsComponent {
  group = input.required<'holdings' | 'activity'>();
  current = input.required<string>();
  private store = inject(StoreService);
  private auth = inject(AuthService);

  tabs = computed(() => {
    const pos = this.store.positions();
    const canWrite = this.auth.canWrite();
    // Only asset classes you hold (and the page you're on); new ones appear once something is added
    return GROUPS[this.group()].filter(t => !t.write || canWrite).map(t => {
      const color = t.classes ? CLASS_COLOR[t.classes[0] as AssetClass] : '';
      if (!t.classes) return { ...t, value: '', color, show: true };
      const v = pos.filter(p => t.classes!.includes(p.asset_class) && p.is_open).reduce((a, p) => a + p.value, 0);
      return { ...t, value: v > 0 ? inrCompact(v) : '', color, show: v > 0 || t.path === this.current() };
    }).filter(t => t.show);
  });
}
