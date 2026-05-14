import { Routes } from '@angular/router';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { EquityComponent } from './components/equity/equity.component';
import { CommodityComponent } from './components/commodity/commodity.component';
import { MutualFundsComponent } from './components/mutual-funds/mutual-funds.component';
import { P2PComponent } from './components/p2p/p2p.component';
import { FixedDepositsComponent } from './components/fixed-deposits/fixed-deposits.component';
import { ForexComponent } from './components/forex/forex.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'equity', component: EquityComponent },
  { path: 'commodity', component: CommodityComponent },
  { path: 'mutual-funds', component: MutualFundsComponent },
  { path: 'p2p', component: P2PComponent },
  { path: 'fixed-deposits', component: FixedDepositsComponent },
  { path: 'forex', component: ForexComponent },
  { path: '**', redirectTo: '' }
];
