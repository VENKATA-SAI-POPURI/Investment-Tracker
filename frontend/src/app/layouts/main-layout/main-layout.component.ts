import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription, forkJoin, switchMap } from 'rxjs';
import { DashboardComponent } from '../../components/dashboard/dashboard.component';
import { EquityComponent } from '../../components/equity/equity.component';
import { CommodityComponent } from '../../components/commodity/commodity.component';
import { MutualFundsComponent } from '../../components/mutual-funds/mutual-funds.component';
import { P2PComponent } from '../../components/p2p/p2p.component';
import { FixedDepositsComponent } from '../../components/fixed-deposits/fixed-deposits.component';
import { ForexComponent } from '../../components/forex/forex.component';
import { UserManagementComponent } from '../../components/user-management/user-management.component';
import { UiActionService } from '../../services/ui-action.service';
import { AuthService } from '../../services/auth.service';
import { InvestmentService } from '../../services/investment.service';

type Page = 'home' | 'equity' | 'mutual-funds' | 'commodity' | 'p2p' | 'fixed-deposits' | 'forex' | 'investment-analysis' | 'chatbot' | 'user-management';

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
    ForexComponent,
    UserManagementComponent
  ],
  templateUrl: './main-layout.component.html',
  styleUrl: './main-layout.component.scss'
})
export class MainLayoutComponent implements OnInit, OnDestroy {
  currentPage: Page = 'home';
  darkMode = false;
  sidebarCollapsed = false;
  showMoreSheet = false;
  isRefreshing = false;
  isFetchingAllPrices = false;
  lastPriceFetchTime: Date | null = null;
  readonly visitedPages = new Set<Page>(['home']);
  private refreshDoneSub?: Subscription;

  constructor(
    private uiActionService: UiActionService,
    private authService: AuthService,
    private investmentService: InvestmentService,
    private router: Router
  ) {}

  private readonly PRICE_FETCH_KEY = 'last_price_fetch';
  private readonly PRICE_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  ngOnInit(): void {
    this.darkMode = localStorage.getItem('darkMode') === 'true';
    this.sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    document.body.classList.toggle('dark', this.darkMode);
    document.body.classList.toggle('light', !this.darkMode);
    this.refreshDoneSub = this.uiActionService.refreshDone.subscribe(() => { this.isRefreshing = false; });
    this.autoFetchPricesIfDue();
  }

  private autoFetchPricesIfDue(): void {
    this.investmentService.getSetting(this.PRICE_FETCH_KEY).subscribe({
      next: ({ value }) => {
        const now = Date.now();
        if (value) {
          this.lastPriceFetchTime = new Date(parseInt(value, 10));
        }
        if (!value || (now - parseInt(value, 10)) >= this.PRICE_FETCH_INTERVAL_MS) {
          this.fetchAllLivePrices();
        }
      },
      error: () => {
        // If the DB check fails, fall back to fetching anyway
        this.fetchAllLivePrices();
      }
    });
  }

  ngOnDestroy(): void { this.refreshDoneSub?.unsubscribe(); }

  toggleDarkMode(): void {
    this.darkMode = !this.darkMode;
    localStorage.setItem('darkMode', String(this.darkMode));
    document.body.classList.toggle('dark', this.darkMode);
    document.body.classList.toggle('light', !this.darkMode);
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem('sidebarCollapsed', String(this.sidebarCollapsed));
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
      'user-management': '👥',
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
      'user-management': 'User Management',
    };
    return labels[this.currentPage] ?? '';
  }

  private readonly DASHBOARD_PAGES = new Set<Page>(['home', 'investment-analysis', 'chatbot']);

  navigateTo(page: Page): void {
    if (page === this.currentPage) { this.showMoreSheet = false; return; }
    const isDashboardTarget = this.DASHBOARD_PAGES.has(page);
    const content = document.querySelector('.content-area') as HTMLElement | null;
    if (content) {
      content.classList.add('page-exiting');
      setTimeout(() => {
        content.classList.remove('page-exiting');
        this.visitedPages.add(page);
        this.currentPage = page;
        this.showMoreSheet = false;
        content.scrollTop = 0;
        content.classList.add('page-entering');
        setTimeout(() => content.classList.remove('page-entering'), 300);
        if (isDashboardTarget) { this.uiActionService.triggerSilentRefresh(); }
      }, 180);
    } else {
      this.visitedPages.add(page);
      this.currentPage = page;
      this.showMoreSheet = false;
      if (isDashboardTarget) { this.uiActionService.triggerSilentRefresh(); }
    }
  }

  refreshData(): void {
    this.isRefreshing = true;
    this.investmentService.clearAllCache();
    this.uiActionService.triggerRefresh();
  }

  fetchAllLivePrices(): void {
    this.isFetchingAllPrices = true;
    forkJoin({
      equityTickers: this.investmentService.getEquityTickers(),
      mfTickers: this.investmentService.getMFTickers(),
      commodityTickers: this.investmentService.getCommodityTickers(),
    }).pipe(
      switchMap(({ equityTickers, mfTickers, commodityTickers }) => {
        const equitySymbols = [...new Set(Object.values(equityTickers).map(v => v.ticker).filter((t): t is string => !!t))];
        const mfSymbols = [...new Set(Object.values(mfTickers).map(v => v.ticker).filter((t): t is string => !!t))];
        const commoditySymbols = [...new Set(Object.values(commodityTickers).map(v => v.ticker).filter((t): t is string => !!t))];
        return this.investmentService.fetchAllPrices(equitySymbols, mfSymbols, commoditySymbols);
      })
    ).subscribe({
      next: (prices) => {
        this.uiActionService.equityPrices$.next(prices.equity || {});
        this.uiActionService.mfPrices$.next(prices.mf || {});
        this.uiActionService.commodityPrices$.next(prices.commodity || {});
        this.investmentService.saveSetting(this.PRICE_FETCH_KEY, String(Date.now())).subscribe();
        this.lastPriceFetchTime = new Date();
        this.isFetchingAllPrices = false;
      },
      error: () => {
        this.isFetchingAllPrices = false;
      }
    });
  }

  get livePriceTooltip(): string {
    if (this.isFetchingAllPrices) return 'Fetching live prices...';
    if (!this.lastPriceFetchTime) return 'Fetch Live Prices';
    const d = this.lastPriceFetchTime;
    const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `Prices as of ${date}, ${time}`;
  }

  isActive(page: Page): boolean {
    return this.currentPage === page;
  }

  get showAddEntry(): boolean {
    return PAGES_WITH_ADD.includes(this.currentPage) && this.authService.canWrite();
  }

  get canWrite(): boolean {
    return this.authService.canWrite();
  }

  get isAdmin(): boolean {
    return this.authService.isAdmin();
  }

  get isImpersonating(): boolean {
    return this.authService.isImpersonating();
  }

  get impersonatingEmail(): string {
    return this.authService.getUser()?.email ?? '';
  }

  exitImpersonation(): void {
    this.authService.stopImpersonation();
    this.investmentService.clearAllCache();
    this.uiActionService.triggerRefresh();
    this.navigateTo('user-management');
  }

  onViewAs(email: string): void {
    this.investmentService.clearAllCache();
    this.navigateTo('home');
    this.uiActionService.triggerRefresh();
  }

  get userRole(): string {
    return this.authService.getRole();
  }

  triggerAddEntry(): void {
    this.uiActionService.triggerAddEntry(this.currentPage);
  }

  get isMorePage(): boolean {
    return ['fixed-deposits', 'forex', 'investment-analysis', 'chatbot', 'user-management'].includes(this.currentPage);
  }

  toggleMoreSheet(): void {
    this.showMoreSheet = !this.showMoreSheet;
  }

  closeMoreSheet(): void {
    this.showMoreSheet = false;
  }
}
