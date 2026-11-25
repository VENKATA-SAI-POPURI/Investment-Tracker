import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Params, RedirectFunction, Router, Routes, UrlTree } from '@angular/router';
import { authGuard, writeGuard } from './core/http';
import { ShellComponent } from './layout/shell.component';
import { PORTFOLIO_HOLDINGS_HOME } from './shared/portfolio-tabs.component';

/* ── Old URLs (SPEC §3.6, AMENDMENTS H18) ─────────────────────────────────────────────────────
 * The wave-2 interim redirects (E19) are retired: /plan, /risk and /recurring are pages now.
 * Every redirect builds a UrlTree, so query parameters and fragments are exactly as written here
 * (a string `redirectTo` would drop or rewrite them).
 */

type RedirectInput = Pick<ActivatedRouteSnapshot, 'queryParams' | 'fragment'>;

const tree = (path: string, queryParams?: Params, fragment?: string): UrlTree =>
  inject(Router).createUrlTree([path], { queryParams, fragment });

/** `/forecast?tab=<old tab>` → its new home (§3.6). Any other value, or none, opens Plan. */
export const FORECAST_TABS: Record<string, { path: string; query?: Params; fragment?: string }> = {
  retirement: { path: '/plan', query: { tab: 'retirement' } },
  cashflow: { path: '/cash-flows', query: { view: 'future' } },
  stress: { path: '/risk', fragment: 'stress' },
  risk: { path: '/risk', fragment: 'risk' },
  allocation: { path: '/risk', fragment: 'profile' },
  sips: { path: '/recurring' },
};

/** SPEC's `ForecastRedirect`: the seven-tab Forecast container is gone; each tab has a page. */
export const forecastRedirect: RedirectFunction = ({ queryParams }: RedirectInput) => {
  const tab = queryParams['tab'];
  const to = (typeof tab === 'string' && Object.hasOwn(FORECAST_TABS, tab) && FORECAST_TABS[tab]) || { path: '/plan' };
  return tree(to.path, to.query, to.fragment);
};

/** `/goals` → `/plan?tab=goals`, keeping `preset`, any other parameter and `#goal-<id>`. */
const goalsRedirect: RedirectFunction = ({ queryParams, fragment }: RedirectInput) =>
  tree('/plan', { ...queryParams, tab: 'goals' }, fragment ?? undefined);

const insightsRedirect: RedirectFunction = ({ fragment }: RedirectInput) =>
  fragment === 'rebalance' ? tree('/risk', undefined, 'rebalance') : tree('/actions');

const analyticsRedirect: RedirectFunction = ({ queryParams }: RedirectInput) =>
  tree('/performance', queryParams['range'] ? { range: queryParams['range'] } : undefined);

/*
 * `/risk` needs no guard any more: Concentration lives on Risk & mix (W5-F2, AMENDMENTS J8), so
 * `/risk#concentration` lands on that page's own `#concentration` block, which opens and scrolls into view.
 */

/** Markets' old "Your performance" tab is its own page now. */
export const marketsGuard: CanActivateFn = route =>
  route.queryParamMap.get('tab') === 'performance' ? tree('/performance') : true;

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent) },
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      // `data.title` names the page in the browser tab (the shell sets document.title; pages own their h1, A22)
      { path: '', data: { title: 'Home' }, loadComponent: () => import('./features/home/home.component').then(m => m.HomeComponent) },
      // redesign: the four main pages (Portfolio, Analysis and Activity arrive in later phases)
      { path: 'portfolio', data: { title: 'Portfolio', shellTitle: true }, loadComponent: () => import('./features/portfolio/portfolio.component').then(m => m.PortfolioComponent) },
      { path: 'analysis', data: { title: 'Analysis', shellTitle: true }, loadComponent: () => import('./features/analysis/analysis.component').then(m => m.AnalysisComponent) },
      { path: 'flow/invest', data: { title: 'Put new money to work' }, canActivate: [writeGuard], loadComponent: () => import('./features/flow/invest-flow.component').then(m => m.InvestFlowComponent) },
      { path: 'activity', data: { title: 'Activity', shellTitle: true }, loadComponent: () => import('./features/activity/activity.component').then(m => m.ActivityComponent) },
      { path: 'classic', data: { title: 'Classic home' }, loadComponent: () => import('./features/overview/overview.component').then(m => m.OverviewComponent) },
      { path: 'actions', data: { title: 'Actions' }, loadComponent: () => import('./features/actions/actions.component').then(m => m.ActionsComponent) },
      // Plan follows `?tab=` itself (the router reuses it on a query-only navigation)
      { path: 'plan', data: { title: 'Plan' }, loadComponent: () => import('./features/plan/plan.component').then(m => m.PlanComponent) },
      { path: 'performance', data: { title: 'Performance' }, loadComponent: () => import('./features/performance/performance.component').then(m => m.PerformanceComponent) },
      { path: 'risk', data: { title: 'Risk & mix' }, loadComponent: () => import('./features/risk/risk-mix.component').then(m => m.RiskMixComponent) },
      { path: 'holdings', pathMatch: 'full', redirectTo: () => tree(PORTFOLIO_HOLDINGS_HOME) },
      { path: 'holdings/:assetClass', data: { title: 'Holdings' }, loadComponent: () => import('./features/holdings/holdings.component').then(m => m.HoldingsComponent) },
      { path: 'holding/:id', data: { title: 'Holding' }, loadComponent: () => import('./features/holdings/holding-detail.component').then(m => m.HoldingDetailComponent) },
      { path: 'p2p', data: { title: 'P2P lending' }, loadComponent: () => import('./features/p2p/p2p.component').then(m => m.P2pComponent) },
      { path: 'fixed-deposits', data: { title: 'Fixed deposits' }, loadComponent: () => import('./features/fixed-deposits/fixed-deposits.component').then(m => m.FixedDepositsComponent) },
      { path: 'forex', data: { title: 'USD wallet' }, loadComponent: () => import('./features/forex/forex.component').then(m => m.ForexComponent) },
      { path: 'epf', data: { title: 'EPF', kind: 'epf' }, loadComponent: () => import('./features/retirement/retirement.component').then(m => m.RetirementComponent) },
      { path: 'nps', data: { title: 'NPS', kind: 'nps' }, loadComponent: () => import('./features/retirement/retirement.component').then(m => m.RetirementComponent) },
      { path: 'reports', data: { title: 'Reports' }, loadComponent: () => import('./features/reports/reports.component').then(m => m.ReportsComponent) },
      { path: 'import', data: { title: 'Import statements' }, canActivate: [writeGuard], loadComponent: () => import('./features/import/import.component').then(m => m.ImportComponent) },
      { path: 'transactions', data: { title: 'Transactions' }, loadComponent: () => import('./features/transactions/transactions.component').then(m => m.TransactionsComponent) },
      { path: 'cash-flows', data: { title: 'Cash flows' }, loadComponent: () => import('./features/cash-flows/cash-flows.component').then(m => m.CashFlowsComponent) },
      { path: 'recurring', data: { title: 'Recurring plans' }, loadComponent: () => import('./features/recurring/recurring.component').then(m => m.RecurringComponent) },
      { path: 'markets', data: { title: 'Markets' }, canActivate: [marketsGuard], runGuardsAndResolvers: 'pathParamsOrQueryParamsChange', loadComponent: () => import('./features/markets/markets.component').then(m => m.MarketsComponent) },
      { path: 'tax', data: { title: 'Tax' }, loadComponent: () => import('./features/tax/tax.component').then(m => m.TaxComponent) },
      { path: 'settings', data: { title: 'Settings' }, loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent) },

      // old URLs (§3.6)
      { path: 'forecast', pathMatch: 'full', redirectTo: forecastRedirect },
      { path: 'goals', pathMatch: 'full', redirectTo: goalsRedirect },
      { path: 'insights', pathMatch: 'full', redirectTo: insightsRedirect },
      { path: 'analytics', pathMatch: 'full', redirectTo: analyticsRedirect },
      { path: 'admin', pathMatch: 'full', redirectTo: () => tree('/settings', undefined, 'people') },
    ],
  },
  { path: '**', redirectTo: '' },
];
