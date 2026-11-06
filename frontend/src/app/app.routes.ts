import { Routes } from '@angular/router';
import { authGuard } from './core/http';
import { ShellComponent } from './layout/shell.component';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent) },
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      { path: '', data: { title: 'Dashboard' }, loadComponent: () => import('./features/overview/overview.component').then(m => m.OverviewComponent) },
      { path: 'holdings/:assetClass', data: { title: 'Holdings' }, loadComponent: () => import('./features/holdings/holdings.component').then(m => m.HoldingsComponent) },
      { path: 'holding/:id', data: { title: 'Holding' }, loadComponent: () => import('./features/holdings/holding-detail.component').then(m => m.HoldingDetailComponent) },
      { path: 'p2p', data: { title: 'P2P lending' }, loadComponent: () => import('./features/p2p/p2p.component').then(m => m.P2pComponent) },
      { path: 'fixed-deposits', data: { title: 'Fixed deposits' }, loadComponent: () => import('./features/fixed-deposits/fixed-deposits.component').then(m => m.FixedDepositsComponent) },
      { path: 'forex', data: { title: 'USD wallet' }, loadComponent: () => import('./features/forex/forex.component').then(m => m.ForexComponent) },
      { path: 'epf', data: { title: 'EPF', kind: 'epf' }, loadComponent: () => import('./features/retirement/retirement.component').then(m => m.RetirementComponent) },
      { path: 'nps', data: { title: 'NPS', kind: 'nps' }, loadComponent: () => import('./features/retirement/retirement.component').then(m => m.RetirementComponent) },
      { path: 'reports', data: { title: 'Reports' }, loadComponent: () => import('./features/reports/reports.component').then(m => m.ReportsComponent) },
      { path: 'import', data: { title: 'Import statements' }, loadComponent: () => import('./features/import/import.component').then(m => m.ImportComponent) },
      { path: 'transactions', data: { title: 'Transactions' }, loadComponent: () => import('./features/transactions/transactions.component').then(m => m.TransactionsComponent) },
      { path: 'cash-flows', data: { title: 'Cash flows' }, loadComponent: () => import('./features/cash-flows/cash-flows.component').then(m => m.CashFlowsComponent) },
      { path: 'markets', data: { title: 'Markets' }, loadComponent: () => import('./features/markets/markets.component').then(m => m.MarketsComponent) },
      { path: 'analytics', data: { title: 'Performance' }, loadComponent: () => import('./features/analytics/analytics.component').then(m => m.AnalyticsComponent) },
      { path: 'tax', data: { title: 'Tax' }, loadComponent: () => import('./features/tax/tax.component').then(m => m.TaxComponent) },
      { path: 'goals', data: { title: 'Goals' }, loadComponent: () => import('./features/goals/goals.component').then(m => m.GoalsComponent) },
      { path: 'insights', data: { title: 'Insights' }, loadComponent: () => import('./features/insights/insights.component').then(m => m.InsightsComponent) },
      { path: 'settings', data: { title: 'Settings' }, loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent) },
      { path: 'admin', redirectTo: 'settings' },
    ],
  },
  { path: '**', redirectTo: '' },
];
