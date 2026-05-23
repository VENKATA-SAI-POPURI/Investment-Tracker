import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { DashboardComponent } from '../../components/dashboard/dashboard.component';
import { EquityComponent } from '../../components/equity/equity.component';
import { CommodityComponent } from '../../components/commodity/commodity.component';
import { MutualFundsComponent } from '../../components/mutual-funds/mutual-funds.component';
import { P2PComponent } from '../../components/p2p/p2p.component';
import { FixedDepositsComponent } from '../../components/fixed-deposits/fixed-deposits.component';
import { ForexComponent } from '../../components/forex/forex.component';
import { UiActionService } from '../../services/ui-action.service';
import { AuthService } from '../../services/auth.service';

type Page = 'home' | 'equity' | 'mutual-funds' | 'commodity' | 'p2p' | 'fixed-deposits' | 'forex' | 'investment-analysis' | 'chatbot';

const PAGES_WITH_ADD: Page[] = ['equity', 'mutual-funds', 'commodity', 'p2p', 'fixed-deposits', 'forex'];

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [
    CommonModule,
    DashboardComponent,
    EquityComponent,
    CommodityComponent,
    MutualFundsComponent,
    P2PComponent,
    FixedDepositsComponent,
    ForexComponent
  ],
  templateUrl: './main-layout.component.html',
  styleUrl: './main-layout.component.scss'
})
export class MainLayoutComponent implements OnInit {
  currentPage: Page = 'home';
  darkMode = false;
  readonly visitedPages = new Set<Page>(['home']);

  constructor(
    private uiActionService: UiActionService,
    private authService: AuthService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.darkMode = localStorage.getItem('darkMode') === 'true';
    document.body.classList.toggle('dark', this.darkMode);
    document.body.classList.toggle('light', !this.darkMode);
  }

  toggleDarkMode(): void {
    this.darkMode = !this.darkMode;
    localStorage.setItem('darkMode', String(this.darkMode));
    document.body.classList.toggle('dark', this.darkMode);
    document.body.classList.toggle('light', !this.darkMode);
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  get dashboardView(): 'home' | 'analysis' | 'chatbot' {
    if (this.currentPage === 'investment-analysis') return 'analysis';
    if (this.currentPage === 'chatbot') return 'chatbot';
    return 'home';
  }

  get showDashboard(): boolean {
    return this.currentPage === 'home' || this.currentPage === 'investment-analysis' || this.currentPage === 'chatbot';
  }

  get currentUser() {
    return this.authService.getUser();
  }

  get pageIcon(): string {
    const icons: Record<string, string> = {
      'equity': '📈',
      'mutual-funds': '🧾',
      'commodity': '⛏️',
      'p2p': '🤝',
      'fixed-deposits': '🏦',
      'forex': '💱',
      'investment-analysis': '📊',
      'chatbot': '💬',
    };
    return icons[this.currentPage] ?? '';
  }

  get pageLabel(): string {
    const labels: Record<string, string> = {
      'equity': 'Equity Investments',
      'mutual-funds': 'Mutual Fund Investments',
      'commodity': 'Commodity Investments',
      'p2p': 'P2P Investments',
      'fixed-deposits': 'Fixed Deposits',
      'forex': 'Forex (INR ↔ USD)',
      'investment-analysis': 'Investment Analysis',
      'chatbot': 'Chatbot',
    };
    return labels[this.currentPage] ?? '';
  }

  navigateTo(page: Page): void {
    this.visitedPages.add(page);
    this.currentPage = page;
  }

  refreshData(): void {
    window.location.reload();
  }

  isActive(page: Page): boolean {
    return this.currentPage === page;
  }

  get showAddEntry(): boolean {
    return PAGES_WITH_ADD.includes(this.currentPage);
  }

  triggerAddEntry(): void {
    this.uiActionService.triggerAddEntry();
  }
}
