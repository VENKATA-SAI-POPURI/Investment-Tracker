import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { AllocationLabComponent } from './allocation-lab.component';
import { CashflowComponent } from './cashflow.component';
import { ProjectionComponent } from './projection.component';
import { RetirementComponent } from './retirement.component';
import { RiskComponent } from './risk.component';
import { SipPlansComponent } from './sip-plans.component';
import { StressComponent } from './stress.component';

type Tab = 'outlook' | 'retirement' | 'cashflow' | 'stress' | 'allocation' | 'risk' | 'sips';
const TABS: { key: Tab; label: string; icon: string; hint: string }[] = [
  { key: 'outlook', label: 'Outlook', icon: 'trend', hint: 'Where the portfolio could be in 5–30 years' },
  { key: 'retirement', label: 'Retirement', icon: 'lotus', hint: 'Corpus needed, FIRE number, year-by-year path' },
  { key: 'cashflow', label: 'Cash flow', icon: 'calendar', hint: 'Dividends, interest, maturities and SIPs due' },
  { key: 'stress', label: 'Stress test', icon: 'shield', hint: 'What a crash would do, and how long to recover' },
  { key: 'risk', label: 'Risk', icon: 'scale', hint: 'Value at risk, beta, correlations' },
  { key: 'allocation', label: 'Allocation lab', icon: 'pie', hint: 'A mix for your risk profile' },
  { key: 'sips', label: 'SIP plans', icon: 'refresh', hint: 'What you intend to invest each month' },
];

@Component({
  selector: 'app-forecast',
  standalone: true,
  imports: [IconComponent, ProjectionComponent, RetirementComponent, CashflowComponent, StressComponent, AllocationLabComponent, RiskComponent, SipPlansComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Forecast</h1><p class="sub">{{ current().hint }}. Estimates under stated assumptions, not promises.</p></div>
      </div>
      <div class="tabs" role="tablist">
        @for (t of tabs; track t.key) {
          <button role="tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="setTab(t.key)">
            <app-icon [name]="t.icon" [size]="14" /> {{ t.label }}</button>
        }
      </div>
      @switch (tab()) {
        @case ('outlook') { <app-projection /> }
        @case ('retirement') { <app-retirement /> }
        @case ('cashflow') { <app-cashflow /> }
        @case ('stress') { <app-stress /> }
        @case ('risk') { <app-risk /> }
        @case ('allocation') { <app-allocation-lab /> }
        @case ('sips') { <app-sip-plans /> }
      }
    </div>`,
  styles: [`.tabs button { display: inline-flex; align-items: center; gap: 6px; }`],
})
export class ForecastComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  tabs = TABS;
  tab = signal<Tab>((TABS.find(t => t.key === this.route.snapshot.queryParamMap.get('tab'))?.key) ?? 'outlook');
  current = () => TABS.find(t => t.key === this.tab())!;

  setTab(t: Tab) {
    this.tab.set(t);
    this.router.navigate([], { queryParams: { tab: t === 'outlook' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
